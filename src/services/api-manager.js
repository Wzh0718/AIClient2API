import {
    handleModelListRequest,
    handleContentGenerationRequest,
    API_ACTIONS,
    ENDPOINT_TYPE,
    getRequestBody,
    applyProviderRateLimitCooldown,
    getProtocolPrefix,
    MODEL_PROTOCOL_PREFIX,
    extractCodexCacheAffinityScope,
    resolveImageProviderRoutingStrategy,
    createErrorResponse
} from '../utils/common.js';
import { getProviderPoolManager, getApiServiceWithFallback } from './service-manager.js';
import logger from '../utils/logger.js';
import busboy from 'busboy';
import { SUPPORTED_IMAGE_MODELS } from '../utils/constants.js';
import { convertData } from '../convert/convert.js';
import { summarizePayloadForLog } from '../utils/log-sanitizer.js';
import { writeImageJsonResponse } from '../runtime/image-json-response.js';
import { estimateImageResponseBytes, runtimeImageCapacity, updateImageCapacitySignals } from '../runtime/runtime-image-capacity.js';
import {
    ImageAspectRatioMismatchError,
    ImagePostprocessError,
    ImageSizeValidationError,
    appendAspectRatioConstraint,
    normalizeAspectMismatchThreshold,
    normalizeImageBuffer
} from '../utils/image-size-normalizer.js';

const IMAGE_GEN_MAX_N = 4;
const VALID_RESPONSE_FORMATS = new Set(['b64_json', 'url']);
const IMAGE_PAYLOAD_SUMMARY_MODELS = new Set(['gpt-image-2', 'gmt-image-2']);
const IMAGE_TOOL_STRING_FIELDS = ['size', 'quality', 'background', 'output_format', 'moderation'];
const IMAGE_TOOL_EDIT_STRING_FIELDS = [...IMAGE_TOOL_STRING_FIELDS, 'input_fidelity'];
const IMAGE_TOOL_NUMERIC_FIELDS = ['output_compression', 'partial_images'];
const FAST_IMAGE_OVERLOAD_RETRY_WINDOW_MS = 10_000;
const FAST_IMAGE_OVERLOAD_RETRY_DELAY_MIN_MS = 500;
const FAST_IMAGE_OVERLOAD_RETRY_DELAY_JITTER_MS = 1_001;

function isEnabledByDefault(value) {
    return ![false, 0, '0', 'false'].includes(value);
}

function parseOptionalBoolean(value) {
    return [true, 1, '1', 'true'].includes(value);
}

function isCodexImagePostprocessingEnabled(config, providerProtocol, size) {
    return providerProtocol === MODEL_PROTOCOL_PREFIX.CODEX
        && Boolean(size)
        && String(size).trim().toLowerCase() !== 'auto'
        && isEnabledByDefault(config?.IMAGE_SIZE_NORMALIZATION_ENABLED);
}

function enhanceCodexImagePrompt(virtualRequest, prompt, size, config, providerProtocol, isEdit = false) {
    if (
        providerProtocol !== MODEL_PROTOCOL_PREFIX.CODEX
        || !isEnabledByDefault(config?.IMAGE_PROMPT_ASPECT_CONSTRAINT_ENABLED)
    ) {
        return false;
    }

    const enhanced = appendAspectRatioConstraint(prompt, size, {
        maxPixels: config?.IMAGE_SIZE_MAX_PIXELS
    });
    if (!enhanced.promptConstraintApplied) return false;

    if (isEdit) {
        const textPart = virtualRequest?.messages?.[0]?.content?.find(part => part?.type === 'text');
        if (textPart) textPart.text = enhanced.prompt;
    } else if (virtualRequest?.messages?.[0]) {
        virtualRequest.messages[0].content = enhanced.prompt;
    }
    return true;
}

function decodeImageDataItem(item) {
    if (typeof item?.b64_json === 'string' && item.b64_json) {
        return { buffer: Buffer.from(item.b64_json, 'base64'), responseKind: 'b64_json' };
    }
    if (typeof item?.url === 'string') {
        const match = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(item.url);
        if (match) {
            return {
                buffer: Buffer.from(match[2], 'base64'),
                responseKind: 'url',
                dataUrlFormat: match[1].toLowerCase()
            };
        }
    }
    throw new ImagePostprocessError('生成图片不是可处理的 Base64 图片数据。');
}

function encodeImageDataItem(item, buffer, responseKind, outputFormat) {
    const encoded = buffer.toString('base64');
    if (responseKind === 'url') {
        return { ...item, url: `data:image/${outputFormat || 'png'};base64,${encoded}` };
    }
    return { ...item, b64_json: encoded };
}

async function normalizeCodexImageData(data, {
    size,
    config,
    outputFormat,
    promptConstraintApplied
}) {
    const images = [];
    const normalizedData = [];
    for (let index = 0; index < data.length; index++) {
        const decoded = decodeImageDataItem(data[index]);
        const normalized = await normalizeImageBuffer(decoded.buffer, {
            requestedSize: size,
            aspectMismatchThreshold: config?.IMAGE_ASPECT_MISMATCH_THRESHOLD,
            maxPixels: config?.IMAGE_SIZE_MAX_PIXELS,
            outputFormat: outputFormat || decoded.dataUrlFormat,
            imageIndex: index
        });
        normalizedData.push(encodeImageDataItem(
            data[index],
            normalized.buffer,
            decoded.responseKind,
            normalized.outputFormat || decoded.dataUrlFormat || outputFormat || 'png'
        ));
        images.push(normalized.metadata);
    }

    return {
        data: normalizedData,
        metadata: {
            requested_size: String(size).trim().toLowerCase(),
            allowed_aspect_deviation: normalizeAspectMismatchThreshold(
                config?.IMAGE_ASPECT_MISMATCH_THRESHOLD
            ),
            prompt_constraint_applied: Boolean(promptConstraintApplied),
            images
        }
    };
}

function buildImageProcessingHeaders(metadata) {
    const images = metadata?.images || [];
    return {
        'Content-Type': 'application/json',
        'X-AIClient-Image-Adjusted': String(images.some(item => item.size_adjusted)),
        'X-AIClient-Image-Upscaled': String(images.some(item => item.upscaled)),
        'X-AIClient-Image-Requested-Size': metadata.requested_size,
        'X-AIClient-Image-Source-Size': images.map(item => item.source_size).join(','),
        'X-AIClient-Image-Final-Size': images.map(item => item.final_size).join(',')
    };
}

function writeImageProcessingError(res, error) {
    if (!(error instanceof ImageSizeValidationError)
        && !(error instanceof ImageAspectRatioMismatchError)
        && !(error instanceof ImagePostprocessError)) {
        return false;
    }

    res.writeHead(error.statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        error: {
            type: error.type,
            message: error.message,
            ...error.details
        }
    }));
    return true;
}

function isImageConnectionResetError(error) {
    if (error?.code === 'ECONNRESET') return true;

    const errorBody = error?.response?.data?.error || error?.response?.data || {};
    const message = [error?.message, errorBody?.message, errorBody?.type, errorBody?.code]
        .filter(Boolean)
        .join(' ');
    return /socket hang up/i.test(message);
}

function writeImageRequestError(res, error) {
    if (res.writableEnded) return;
    const rawStatus = isImageConnectionResetError(error)
        ? 502
        : error?.response?.status || error?.status || error?.statusCode || error?.code || 500;
    const parsedStatus = Number(rawStatus);
    const status = Number.isInteger(parsedStatus) && parsedStatus >= 100 && parsedStatus <= 599
        ? parsedStatus
        : 500;
    const headers = { 'Content-Type': 'application/json' };
    if (error?.retryAfterSeconds) headers['Retry-After'] = String(error.retryAfterSeconds);
    res.writeHead(status, headers);
    res.end(JSON.stringify(createErrorResponse(error, MODEL_PROTOCOL_PREFIX.OPENAI)));
}

function resolveFinalImageRequestError(error, retryContext, slotUuid) {
    if (!slotUuid && retryContext?.lastRateLimitError) {
        return retryContext.lastRateLimitError;
    }
    return error;
}

export function shouldRetryFastImageOverload(error, elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= FAST_IMAGE_OVERLOAD_RETRY_WINDOW_MS) return false;
    if (error?.code === 'ETIMEDOUT' || error?.code === 'ECONNABORTED') return false;

    const status = Number(error?.response?.status || error?.status || error?.statusCode || 0);
    if (status > 0 && status < 500) return false;

    const errorBody = error?.response?.data?.error || error?.response?.data || {};
    const message = [error?.message, errorBody?.message, errorBody?.type, errorBody?.code]
        .filter(Boolean)
        .join(' ');
    return /\b(?:our servers are )?currently overloaded\b|server[_ -]?overloaded/i.test(message);
}

function shouldRetryTransientImageError(error) {
    if (isImageConnectionResetError(error)) return true;

    const errorBody = error?.response?.data?.error || error?.response?.data || {};
    const message = [error?.message, errorBody?.message, errorBody?.type, errorBody?.code]
        .filter(Boolean)
        .join(' ');

    return /stream has been aborted|upstream connect error or disconnect\/reset before headers|reset reason:\s*connection termination/i.test(message);
}

function markImageProviderRetry(error, kind) {
    error.shouldSwitchCredential = true;
    error.skipErrorCount = true;
    error.imageProviderRetryable = true;
    error.imageProviderRetryKind = kind;
    return error;
}

function createImageRejectionRetryError(scope, rejection) {
    const error = new Error(`${scope} rejected: ${rejection}`);
    error.response = {
        status: 400,
        data: { error: { message: rejection, type: 'invalid_request_error' } }
    };
    return markImageProviderRetry(error, 'rejection');
}

function getImageRequestMaxRetries(config, fallback = 3) {
    const configured = Number.parseInt(config?.REQUEST_MAX_RETRIES, 10);
    return Number.isFinite(configured) ? Math.max(0, configured) : fallback;
}

async function generateImageWithInternalRetry(service, model, requestBody, scope) {
    let internalRetryCount = 0;

    while (true) {
        const startedAt = Date.now();
        try {
            return await service.generateContent(model, { ...requestBody });
        } catch (error) {
            const elapsedMs = Date.now() - startedAt;
            if (internalRetryCount === 0 && shouldRetryFastImageOverload(error, elapsedMs)) {
                internalRetryCount = 1;
                const delayMs = FAST_IMAGE_OVERLOAD_RETRY_DELAY_MIN_MS + Math.floor(Math.random() * FAST_IMAGE_OVERLOAD_RETRY_DELAY_JITTER_MS);
                logger.warn(`[${scope}] internal overload retry 1/1 after ${elapsedMs}ms; waiting ${delayMs}ms`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                continue;
            }
            if (shouldRetryTransientImageError(error)) {
                logger.warn(`[${scope}] requesting provider reroute after transient upstream failure (${elapsedMs}ms)`);
                throw markImageProviderRetry(error, 'transient');
            }
            throw error;
        }
    }
}

function shouldLogImagePayloadSummary(model) {
    return IMAGE_PAYLOAD_SUMMARY_MODELS.has(String(model || '').trim());
}

function logImagePayloadSummary(scope, model, payload) {
    if (!shouldLogImagePayloadSummary(model)) return;

    try {
        logger.info(`[${scope}] Payload summary for model=${model}: ${JSON.stringify(summarizePayloadForLog(payload))}`);
    } catch (error) {
        logger.warn(`[${scope}] Failed to summarize payload for model=${model}: ${error.message}`);
    }
}

export function buildImageCapacityErrorLog(error) {
    if (error?.code !== 'IMAGE_CAPACITY_EXCEEDED' || !error?.details) return null;
    const details = error.details;
    return {
        blockedReasons: Array.isArray(details.blockedReasons) ? details.blockedReasons : [],
        activeBytes: Number(details.activeBytes) || 0,
        budgetBytes: Number(details.budgetBytes) || 0,
        estimatedBytes: Number(details.estimatedBytes) || 0,
        rssBytes: Number(details.rssBytes) || 0,
        rssLimitBytes: Number(details.rssLimitBytes) || 0,
        eventLoopP95Ms: Number(details.eventLoopP95Ms) || 0,
        queued: Number(details.queued) || 0
    };
}

function logImageRequestError(scope, error) {
    logger.error(`[${scope}] Error:`, error.message);
    const capacity = buildImageCapacityErrorLog(error);
    if (capacity) logger.error(`[${scope}] Capacity diagnostics: ${JSON.stringify(capacity)}`);
}

function getHeaderValue(headers = {}, name) {
    const lowerName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
        if (key.toLowerCase() === lowerName) return Array.isArray(value) ? value[0] : value;
    }
    return undefined;
}

function parseRetryAfterMs(value) {
    if (value === undefined || value === null || value === '') return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
    const dateMs = Date.parse(String(value));
    return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function classifyImageGenerationError(error) {
    const status = error?.response?.status || error?.status || error?.statusCode || null;
    if (isImageConnectionResetError(error)) return 'network_reset';
    if (Number(status) === 429) return 'upstream_429';
    if (Number(status) === 401 || Number(status) === 403) return 'auth_failed';
    if (Number(status) >= 500) return 'upstream_5xx';
    if (error?.code === 'ETIMEDOUT' || error?.code === 'ECONNABORTED') return 'network_timeout';
    return 'image_generation_failed';
}

export function buildImageGenerationErrorAudit({
    requestId,
    model,
    providerType,
    providerUuid,
    providerName,
    currentRetry = 0,
    maxRetries = 0,
    error,
    cooldownApplied = false,
    willRetry = false
} = {}) {
    const headers = error?.response?.headers || {};
    const errorBody = error?.response?.data?.error || error?.response?.data || {};
    const retryAfter = getHeaderValue(headers, 'retry-after') ?? errorBody.retryAfter ?? errorBody.retry_after ?? error?.retryAfter;
    const upstreamRequestId =
        getHeaderValue(headers, 'x-request-id') ||
        getHeaderValue(headers, 'request-id') ||
        errorBody.request_id ||
        errorBody.requestId ||
        null;

    return {
        event: 'image_generation_error',
        ts: new Date().toISOString(),
        reqId: requestId || null,
        providerType: providerType || 'unknown',
        accountUuid: providerUuid || null,
        accountLabel: providerName || null,
        model: model || 'unknown',
        status: 'failed',
        errorClass: classifyImageGenerationError(error),
        httpStatus: error?.response?.status || error?.status || error?.statusCode || null,
        errorCode: errorBody.code || error?.code || null,
        errorType: errorBody.type || null,
        message: errorBody.message || error?.message || 'unknown error',
        retryAfterMs: parseRetryAfterMs(retryAfter),
        upstreamRequestId,
        currentRetry,
        maxRetries,
        imageProviderRetryKind: error?.imageProviderRetryKind || null,
        cooldownApplied: Boolean(cooldownApplied),
        willRetry: Boolean(willRetry)
    };
}

function assignStringImageToolOption(options, source, field) {
    const value = source?.[field];
    if (value === undefined || value === null) return;

    const text = String(value).trim();
    if (text) {
        options[field] = text;
    }
}

function assignNumericImageToolOption(options, source, field) {
    const value = source?.[field];
    if (value === undefined || value === null || value === '') return;

    const number = Number.parseInt(value, 10);
    if (Number.isFinite(number)) {
        options[field] = number;
    }
}

function collectImageToolOptions(source, { includeInputFidelity = false } = {}) {
    const options = {};
    const stringFields = includeInputFidelity ? IMAGE_TOOL_EDIT_STRING_FIELDS : IMAGE_TOOL_STRING_FIELDS;

    for (const field of stringFields) {
        assignStringImageToolOption(options, source, field);
    }
    for (const field of IMAGE_TOOL_NUMERIC_FIELDS) {
        assignNumericImageToolOption(options, source, field);
    }

    return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * Handle API authentication and routing
 * @param {string} method - The HTTP method
 * @param {string} path - The request path
 * @param {http.IncomingMessage} req - The HTTP request object
 * @param {http.ServerResponse} res - The HTTP response object
 * @param {Object} currentConfig - The current configuration object
 * @param {Object} apiService - The API service instance
 * @param {Object} providerPoolManager - The provider pool manager instance
 * @param {string} promptLogFilename - The prompt log filename
 * @returns {Promise<boolean>} - True if the request was handled by API
 */
export async function handleAPIRequests(method, path, req, res, currentConfig, apiService, providerPoolManager, promptLogFilename) {


    // Route model list requests
    if (method === 'GET') {
        if (path === '/v1/models') {
            await handleModelListRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_MODEL_LIST, currentConfig, providerPoolManager, currentConfig.uuid);
            return true;
        }
        if (path === '/v1beta/models') {
            await handleModelListRequest(req, res, apiService, ENDPOINT_TYPE.GEMINI_MODEL_LIST, currentConfig, providerPoolManager, currentConfig.uuid);
            return true;
        }
    }

    // Route image generation/editing requests
    if (method === 'POST' && path === '/v1/images/generations') {
        await handleImageGenerationRequest(req, res, currentConfig, providerPoolManager);
        return true;
    }
    if (method === 'POST' && path === '/v1/images/edits') {
        await handleImageEditsRequest(req, res, currentConfig, providerPoolManager);
        return true;
    }

    // Route content generation requests
    if (method === 'POST') {
        if (path === '/v1/chat/completions') {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_CHAT, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid, path);
            return true;
        }
        if (path === '/v1/responses') {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_RESPONSES, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid, path);
            return true;
        }
        const geminiUrlPattern = new RegExp(`/v1beta/models/(.+?):(${API_ACTIONS.GENERATE_CONTENT}|${API_ACTIONS.STREAM_GENERATE_CONTENT})`);
        if (geminiUrlPattern.test(path)) {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.GEMINI_CONTENT, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid, path);
            return true;
        }
        if (path === '/v1/messages') {
            await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.CLAUDE_MESSAGE, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid, path);
            return true;
        }
    }

    return false;
}

/**
 * Initialize API management features
 * @param {Object} services - The initialized services
 * @returns {Function} - The heartbeat and token refresh function
 */
export function initializeAPIManagement(services) {
    const providerPoolManager = getProviderPoolManager();
    return async function heartbeatAndRefreshToken() {
        logger.info(`[Heartbeat] Server is running. Current time: ${new Date().toLocaleString()}`, Object.keys(services));
        // 循环遍历所有已初始化的服务适配器，并尝试刷新令牌
        // if (getProviderPoolManager()) {
        //     await getProviderPoolManager().performInitialHealthChecks(); // 定期执行健康检查
        // }
        for (const providerKey in services) {
            const serviceAdapter = services[providerKey];
            try {
                // For pooled providers, refreshToken should be handled by individual instances
                // For single instances, this remains relevant
                if (serviceAdapter.config?.uuid && providerPoolManager) {
                    providerPoolManager._enqueueRefresh(serviceAdapter.config.MODEL_PROVIDER, {
                        config: serviceAdapter.config,
                        uuid: serviceAdapter.config.uuid
                    });
                } else {
                    await serviceAdapter.refreshToken();
                }
                // logger.info(`[Token Refresh] Refreshed token for ${providerKey}`);
            } catch (error) {
                logger.error(`[Token Refresh Error] Failed to refresh token for ${providerKey}: ${error.message}`);
                // 如果是号池中的某个实例刷新失败，这里需要捕获并更新其状态
                // 现有的 serviceInstances 存储的是每个配置对应的单例，而非池中的成员
                // 这意味着如果一个池成员的 token 刷新失败，需要找到它并更新其在 poolManager 中的状态
                // 暂时通过捕获错误日志来发现问题，更精细的控制需要在 refreshToken 中抛出更多信息
            }
        }
    };
}

/**
 * Handle POST /v1/images/generations - OpenAI 标准生图接口
 */
async function handleImageGenerationRequest(req, res, currentConfig, providerPoolManager, retryContext = null) {
    const IMAGE_GEN_MAX_N = 4;
    const VALID_RESPONSE_FORMATS = new Set(['b64_json', 'url']);

    const maxRetries = retryContext?.maxRetries ?? getImageRequestMaxRetries(currentConfig);
    const currentRetry = retryContext?.currentRetry ?? 0;
    const CONFIG = retryContext?.CONFIG ?? currentConfig;
    let slotProviderType = null;
    let slotUuid = null;
    let slotCustomName = null;
    let slotAccountIdentity = null;
    let slotAccountEmail = null;
    let model, n, response_format, size, quality, prompt, imageToolOptions, codexRequestBody, virtualOpenAIRequest;
    let includeProcessingMetadata = false;
    let promptConstraintApplied = false;
    let capacityTicket = retryContext?.capacityTicket || null;
    const ownsCapacityTicket = !capacityTicket;

    try {
        if (retryContext?.parsedBody) {
            ({model, n, response_format, size, quality, prompt, imageToolOptions, virtualOpenAIRequest, includeProcessingMetadata} = retryContext.parsedBody);
            codexRequestBody = virtualOpenAIRequest;
        } else {
            const body = await getRequestBody(req, { maxBytes: CONFIG.REQUEST_BODY_MAX_BYTES });
            CONFIG._codexCacheAffinityScope = extractCodexCacheAffinityScope(body);
            model = body.model || 'gpt-image-2';
            response_format = body.response_format || 'b64_json';
            size = body.size;
            quality = body.quality;
            includeProcessingMetadata = parseOptionalBoolean(body.include_processing_metadata);
            imageToolOptions = collectImageToolOptions(body);
            // cap n：至少 1，最多 IMAGE_GEN_MAX_N，非数字降级为 1
            n = Math.min(Math.max(1, parseInt(body.n) || 1), IMAGE_GEN_MAX_N);
            prompt = body.prompt;

            if (!SUPPORTED_IMAGE_MODELS.has(model)) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({error: {message: `model '${model}' is not supported; supported image models: ${[...SUPPORTED_IMAGE_MODELS].join(', ')}`, type: 'invalid_request_error'}}));
                return;
            }

            if (!prompt) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({error: {message: 'prompt is required', type: 'invalid_request_error'}}));
                return;
            }

            if (!VALID_RESPONSE_FORMATS.has(response_format)) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({
                    error: {
                        message: `response_format must be 'b64_json' or 'url'`,
                        type: 'invalid_request_error'
                    }
                }));
                return;
            }

            // 构造虚拟 OpenAI 对话请求，参考对话接口实现自动转换
            virtualOpenAIRequest = {
                model,
                messages: [{ role: 'user', content: prompt }],
                n,
                size,
                quality,
                response_format,
                _imageSize: size, // 兼容 Codex 内部使用的字段
                _imageQuality: quality,
                _imageToolOptions: imageToolOptions,
                _monitorRequestId: currentConfig._monitorRequestId // 注入监控 ID
            };

            // 预留变量，在获取到 service 确认协议后再转换
            codexRequestBody = virtualOpenAIRequest;
        }

        // 从号池获取服务实例
        const shouldUsePool = !!(providerPoolManager && CONFIG.providerPools);
        const routingStrategy = resolveImageProviderRoutingStrategy(CONFIG, {
            requestPath: '/v1/images/generations',
            model,
            body: virtualOpenAIRequest
        });
        const result = await getApiServiceWithFallback(CONFIG, model, {
            acquireSlot: shouldUsePool,
            ...(routingStrategy ? { routingStrategy } : {}),
            excludeProviderUuids: retryContext?.failedCredentialUuids || [],
            deprioritizeProviderTypes: retryContext?.failedProviderTypes || [],
            allowExcludedProviderFallback: retryContext?.allowExcludedProviderFallback === true
        });
        const service = result.service;

        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No service available for image generation', type: 'server_error' } }));
            return;
        }

        // 记录 slot 信息
        if (shouldUsePool && result.uuid) {
            slotProviderType = result.actualProviderType || CONFIG.MODEL_PROVIDER;
            slotUuid = result.uuid;
            slotCustomName = result.serviceConfig?.customName || null;
            slotAccountIdentity = result.serviceConfig?.codexAccountKey || result.serviceConfig?.codexAccountId || null;
            slotAccountEmail = result.serviceConfig?.codexEmail || null;
        }
        
        const finalProviderProtocol = getProtocolPrefix(slotProviderType || CONFIG.MODEL_PROVIDER);
        const fromProvider = MODEL_PROTOCOL_PREFIX.OPENAI;
        const toProvider = slotProviderType || CONFIG.MODEL_PROVIDER;

        const attemptOpenAIRequest = structuredClone(virtualOpenAIRequest);
        promptConstraintApplied = enhanceCodexImagePrompt(
            attemptOpenAIRequest,
            prompt,
            size,
            CONFIG,
            finalProviderProtocol,
            false
        );
        codexRequestBody = attemptOpenAIRequest;

        // 执行自动转换：OpenAI -> 目标协议
        const fromProtocol = MODEL_PROTOCOL_PREFIX.OPENAI;
        if (fromProtocol !== finalProviderProtocol) {
            logger.info(`[Image Generation] Converting request from ${fromProtocol} to ${finalProviderProtocol}`);
            codexRequestBody = convertData(codexRequestBody, 'request', fromProvider, toProvider, model, currentConfig._monitorRequestId);
            
            // 保持以 _ 开头的内部属性
            Object.keys(attemptOpenAIRequest).forEach(key => {
                if (key.startsWith('_') && codexRequestBody[key] === undefined) {
                    codexRequestBody[key] = attemptOpenAIRequest[key];
                }
            });
        }

        logger.info(`[Image Generation] model=${model}, protocol=${finalProviderProtocol}, n=${n}, response_format=${response_format}${size ? `, size=${size}` : ''}${quality ? `, quality=${quality}` : ''}`);
        logImagePayloadSummary('Image Generation', model, codexRequestBody);

        // 串行发起 n 张图请求，每张独立占用一次上游调用，与号池 slot 计数对应
        const data = [];
        const responses = [];
        for (let i = 0; i < n; i++) {
            const response = await generateImageWithInternalRetry(service, model, codexRequestBody, 'Image Generation');
            responses.push(response);
            const extracted = extractImagesFromServiceResponse(response, finalProviderProtocol, response_format);
            if (extracted.length === 0) {
                const rejection = extractRejectionMessage([response], finalProviderProtocol);
                if (rejection && providerPoolManager && slotUuid && currentRetry < maxRetries) {
                    throw createImageRejectionRetryError('Image generation', rejection);
                }
            }
            data.push(...extracted);
        }

        if (data.length === 0) {
            // 检查是否有拒绝消息
            const rejection = extractRejectionMessage(responses, finalProviderProtocol);
            if (rejection) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Image generation rejected: ${rejection}`, type: 'invalid_request_error' } }));
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Image generation failed: no image in response', type: 'server_error' } }));
            }
            return;
        }

        let responseData = data;
        let processingMetadata = null;
        if (isCodexImagePostprocessingEnabled(CONFIG, finalProviderProtocol, size)) {
            const normalized = await normalizeCodexImageData(data, {
                size,
                config: CONFIG,
                outputFormat: imageToolOptions?.output_format,
                promptConstraintApplied
            });
            responseData = normalized.data;
            processingMetadata = normalized.metadata;
        }

        if (!capacityTicket) {
            updateImageCapacitySignals(providerPoolManager);
            capacityTicket = await runtimeImageCapacity.acquire({ bytes: estimateImageResponseBytes({ n }), kind: 'image-generation' });
        }

        const clientResponse = { created: Math.floor(Date.now() / 1000), data: responseData };
        if (includeProcessingMetadata && processingMetadata) {
            clientResponse.x_aiclient2api = { image_processing: processingMetadata };
        }

        // 监控钩子：内容生成后与一元响应
        if (currentConfig._monitorRequestId) {
            try {
                const { getPluginManager } = await import('../core/plugin-manager.js');
                const pluginManager = getPluginManager();
                if (pluginManager) {
                    await pluginManager.executeHook('onUnaryResponse', {
                        nativeResponse: responses.length === 1 ? responses[0] : responses,
                        clientResponse,
                        fromProvider,
                        toProvider,
                        providerUuid: slotUuid || currentConfig.uuid,
                        providerName: slotCustomName || currentConfig.customName,
                        accountIdentity: slotAccountIdentity || currentConfig.codexAccountKey || currentConfig.codexAccountId || null,
                        accountEmail: slotAccountEmail || currentConfig.codexEmail || null,
                        model,
                        requestId: currentConfig._monitorRequestId
                    });

                    await pluginManager.executeHook('onContentGenerated', {
                        ...currentConfig,
                        originalRequestBody: { model, prompt, n, size, quality, response_format },
                        processedRequestBody: codexRequestBody,
                        fromProvider,
                        toProvider,
                        providerUuid: slotUuid || currentConfig.uuid,
                        providerName: slotCustomName || currentConfig.customName,
                        accountIdentity: slotAccountIdentity || currentConfig.codexAccountKey || currentConfig.codexAccountId || null,
                        accountEmail: slotAccountEmail || currentConfig.codexEmail || null,
                        model,
                        isStream: false
                    });
                }
            } catch (e) {
                logger.error('[Image Generation] Hook error:', e.message);
            }
        }

        await writeImageJsonResponse(res, clientResponse, {
            headers: processingMetadata ? buildImageProcessingHeaders(processingMetadata) : {}
        });
    } catch (error) {
        logImageRequestError('Image Generation', error);

        if (!res.writableEnded && writeImageProcessingError(res, error)) {
            return;
        }

        const shouldSwitchCredential = error.shouldSwitchCredential === true;
        let credentialMarkedUnhealthy = error.credentialMarkedUnhealthy === true;
        let cooldownApplied = false;

        if (providerPoolManager && slotUuid) {
            if (applyProviderRateLimitCooldown({
                error,
                config: CONFIG,
                providerPoolManager,
                providerType: slotProviderType,
                providerUuid: slotUuid,
                requestedModel: model
            })) {
                credentialMarkedUnhealthy = true;
                cooldownApplied = true;
            } else if (!credentialMarkedUnhealthy && !error.skipErrorCount) {
                if (error.response?.status !== 400) {
                    logger.info(`[Provider Pool] Marking ${slotProviderType} as unhealthy due to image generation error (status: ${error.response?.status || 'unknown'})`);
                    providerPoolManager.markProviderUnhealthy(slotProviderType, {uuid: slotUuid}, error.message);
                    credentialMarkedUnhealthy = true;
                }
            }
        }

        if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
            credentialMarkedUnhealthy = true;
        }

        const willRetry = credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG;
        logger.warn(`[Image Generation Audit] ${JSON.stringify(buildImageGenerationErrorAudit({
            requestId: CONFIG._monitorRequestId,
            model,
            providerType: slotProviderType || CONFIG.MODEL_PROVIDER,
            providerUuid: slotUuid || CONFIG.uuid,
            providerName: slotCustomName || CONFIG.customName,
            currentRetry,
            maxRetries,
            error,
            cooldownApplied,
            willRetry
        }))}`);

        if (willRetry) {
            const failedCredentialUuids = [
                ...(retryContext?.failedCredentialUuids || []),
                slotUuid
            ].filter(Boolean);
            const failedProviderTypes = [
                ...(retryContext?.failedProviderTypes || []),
                slotProviderType || CONFIG.MODEL_PROVIDER
            ].filter(Boolean);
            const randomDelay = error.imageProviderRetryable ? 0 : Math.floor(Math.random() * 10000);
            logger.info(`[Image Generation Retry] Switching credential without changing provider health. Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries}...`);
            await new Promise(resolve => setTimeout(resolve, randomDelay));

            try {
                return await handleImageGenerationRequest(req, res, CONFIG, providerPoolManager, {
                    ...retryContext,
                    CONFIG,
                    currentRetry: currentRetry + 1,
                    maxRetries,
                    failedCredentialUuids,
                    failedProviderTypes,
                    lastRateLimitError: cooldownApplied ? error : retryContext?.lastRateLimitError,
                    allowExcludedProviderFallback: error.imageProviderRetryable === true,
                    parsedBody: {model, n, response_format, size, quality, prompt, imageToolOptions, virtualOpenAIRequest, includeProcessingMetadata}
                    ,capacityTicket
                });
            } catch (retryError) {
                logger.error('[Image Generation Retry] Failed to get alternative service:', retryError.message);
            }
        }

        writeImageRequestError(res, resolveFinalImageRequestError(error, retryContext, slotUuid));
    } finally {
        if (ownsCapacityTicket && capacityTicket) runtimeImageCapacity.release(capacityTicket);
        // 确保并发槽在请求结束后归还（与 handleStreamRequest/handleUnaryRequest 保持一致）
        if (providerPoolManager && slotProviderType && slotUuid) {
            providerPoolManager.releaseSlot(slotProviderType, slotUuid);
        }
    }
}

/**
 * Extract assistant rejection text from different provider responses.
 * Returns the text if a policy/safety rejection message is found, otherwise null.
 */
function extractRejectionMessage(responses, providerProtocol) {
    for (const response of responses) {
        // Codex/OpenAI Responses style
        if (providerProtocol === MODEL_PROTOCOL_PREFIX.CODEX || providerProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
            const output = response?.response?.output || response?.output || [];
            for (const item of output) {
                if (item.type === 'message' && item.role === 'assistant') {
                    const textPart = (item.content || []).find(c => c.type === 'output_text' && c.text);
                    if (textPart?.text) return textPart.text;
                }
            }
        }
        
        // Grok style
        if (providerProtocol === MODEL_PROTOCOL_PREFIX.GROK) {
            if (response.message) return response.message;
            if (response.modelResponse?.message) return response.modelResponse.message;
        }
        
        // Gemini style
        if (providerProtocol === MODEL_PROTOCOL_PREFIX.GEMINI) {
            const candidates = response?.response?.candidates || response?.candidates || [];
            for (const cand of candidates) {
                const parts = cand.content?.parts || [];
                for (const part of parts) {
                    if (part.text) return part.text;
                }
            }
        }
    }
    return null;
}

/**
 * Parse multipart/form-data from a raw http.IncomingMessage via busboy.
 * Returns { fields: {key: string}, files: {key: file|file[]}, fileEntries: [{name, file}] }
 * File buffers are collected in memory; mask field is accepted but ignored.
 */
function parseMultipartForm(req) {
    return new Promise((resolve, reject) => {
        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
            return reject(new Error('Content-Type must be multipart/form-data'));
        }

        const bb = busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB cap
        const fields = {};
        const files = {};
        const fileEntries = [];

        let settled = false;
        const rejectOnce = (err) => {
            if (!settled) {
                settled = true;
                reject(err);
            }
        };
        const resolveOnce = (val) => {
            if (!settled) {
                settled = true;
                resolve(val);
            }
        };

        bb.on('field', (name, value) => { fields[name] = value; });

        bb.on('file', (name, stream, info) => {
            const chunks = [];
            const fileEntry = { name, file: null };
            fileEntries.push(fileEntry);
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => {
                const file = { buffer: Buffer.concat(chunks), mimetype: info.mimeType };
                fileEntry.file = file;
                if (!files[name]) {
                    files[name] = file;
                } else if (Array.isArray(files[name])) {
                    files[name].push(file);
                } else {
                    files[name] = [files[name], file];
                }
            });
            stream.on('error', rejectOnce);
        });

        bb.on('close', () => resolveOnce({fields, files, fileEntries}));
        bb.on('error', rejectOnce);

        // 客户端提前断连时 req 不会触发 'end'，需要主动拒绝，否则 Promise 永远挂起
        req.on('aborted', () => rejectOnce(new Error('Request aborted by client')));
        req.on('close', () => {
            if (!req.complete) {
                rejectOnce(new Error('Request connection closed before body was fully received'));
            }
        });

        req.pipe(bb);
    });
}

function getMultipartFiles(form, fieldNames) {
    const acceptedNames = new Set(fieldNames);

    if (Array.isArray(form.fileEntries)) {
        return form.fileEntries
            .filter(entry => acceptedNames.has(entry.name) && entry.file)
            .map(entry => entry.file);
    }

    const collected = [];
    for (const name of fieldNames) {
        const value = form.files?.[name];
        if (Array.isArray(value)) {
            collected.push(...value);
        } else if (value) {
            collected.push(value);
        }
    }
    return collected;
}

/**
 * Handle POST /v1/images/edits - OpenAI 标准改图接口
 * Accepts multipart/form-data: image (required), prompt (required),
 * mask (ignored), model, n, size, response_format
 */
async function handleImageEditsRequest(req, res, currentConfig, providerPoolManager, retryContext = null) {
    const CONFIG = retryContext?.CONFIG ?? currentConfig;
    const maxRetries = retryContext?.maxRetries ?? getImageRequestMaxRetries(CONFIG);
    const currentRetry = retryContext?.currentRetry ?? 0;
    let slotProviderType = null;
    let slotUuid = null;
    let slotCustomName = null;
    let slotAccountIdentity = null;
    let slotAccountEmail = null;
    let form = null;
    let model = null;
    let capacityTicket = retryContext?.capacityTicket || null;
    const ownsCapacityTicket = !capacityTicket;

    try {
        form = retryContext?.parsedForm ?? await parseMultipartForm(req);
        const { fields, files } = form;
        CONFIG._codexCacheAffinityScope = extractCodexCacheAffinityScope(fields);

        model = fields.model || 'gpt-image-2';
        const prompt = fields.prompt;
        const response_format = fields.response_format || 'b64_json';
        const size = fields.size;
        const quality = fields.quality;
        const includeProcessingMetadata = parseOptionalBoolean(fields.include_processing_metadata);
        const imageToolOptions = collectImageToolOptions(fields, { includeInputFidelity: true });
        const n = Math.min(Math.max(1, parseInt(fields.n) || 1), IMAGE_GEN_MAX_N);

        // Support both image and image[] field names, preserving repeated file inputs.
        const imageFiles = getMultipartFiles(form, ['image', 'image[]']);

        logger.info(`[Image Edits] Received request: model=${model}, n=${n}, response_format=${response_format}, hasPrompt=${!!prompt}, imageCount=${imageFiles.length}${size ? `, size=${size}` : ''}, fields=${JSON.stringify(Object.keys(fields))}, fileKeys=${JSON.stringify(Object.keys(files))}`);

        if (!SUPPORTED_IMAGE_MODELS.has(model)) {
            logger.warn(`[Image Edits] Unsupported model: ${model}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `model '${model}' is not supported; supported image models: ${[...SUPPORTED_IMAGE_MODELS].join(', ')}`, type: 'invalid_request_error' } }));
            return;
        }

        if (!prompt) {
            logger.warn(`[Image Edits] Missing required field: prompt`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'prompt is required', type: 'invalid_request_error' } }));
            return;
        }

        if (imageFiles.length === 0) {
            logger.warn(`[Image Edits] Missing required field: image (received file keys: ${JSON.stringify(Object.keys(files))})`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'image is required', type: 'invalid_request_error' } }));
            return;
        }

        if (!VALID_RESPONSE_FORMATS.has(response_format)) {
            logger.warn(`[Image Edits] Invalid response_format: ${response_format}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `response_format must be 'b64_json' or 'url'`, type: 'invalid_request_error' } }));
            return;
        }

        const imageParts = imageFiles.map(({buffer, mimetype}) => ({
            type: 'image_url',
            image_url: {
                url: `data:${mimetype || 'image/png'};base64,${buffer.toString('base64')}`
            }
        }));
        const totalImageBytes = imageFiles.reduce((total, file) => total + file.buffer.length, 0);
        if (!capacityTicket) {
            updateImageCapacitySignals(providerPoolManager);
            capacityTicket = await runtimeImageCapacity.acquire({
                bytes: estimateImageResponseBytes({ n, inputBytes: totalImageBytes }),
                kind: 'image-edit'
            });
        }

        // 构造虚拟 OpenAI 对话请求，参考对话接口实现自动转换
        const virtualOpenAIRequest = {
            model,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    ...imageParts
                ]
            }],
            n,
            size,
            quality,
            response_format,
            _imageSize: size,
            _imageQuality: quality,
            _imageToolOptions: imageToolOptions,
            _monitorRequestId: currentConfig._monitorRequestId // 注入监控 ID
        };

        const shouldUsePool = !!(providerPoolManager && currentConfig.providerPools);
        const routingStrategy = resolveImageProviderRoutingStrategy(currentConfig, {
            requestPath: '/v1/images/edits',
            model,
            body: fields
        });
        const result = await getApiServiceWithFallback(currentConfig, model, {
            acquireSlot: shouldUsePool,
            ...(routingStrategy ? { routingStrategy } : {}),
            excludeProviderUuids: retryContext?.failedCredentialUuids || [],
            deprioritizeProviderTypes: retryContext?.failedProviderTypes || [],
            allowExcludedProviderFallback: retryContext?.allowExcludedProviderFallback === true
        });
        const service = result.service;

        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No service available for image editing', type: 'server_error' } }));
            return;
        }

        if (shouldUsePool && result.uuid) {
            slotProviderType = result.actualProviderType || currentConfig.MODEL_PROVIDER;
            slotUuid = result.uuid;
            slotCustomName = result.serviceConfig?.customName || null;
            slotAccountIdentity = result.serviceConfig?.codexAccountKey || result.serviceConfig?.codexAccountId || null;
            slotAccountEmail = result.serviceConfig?.codexEmail || null;
        }

        const finalProviderProtocol = getProtocolPrefix(slotProviderType || currentConfig.MODEL_PROVIDER);
        const fromProvider = MODEL_PROTOCOL_PREFIX.OPENAI;
        const toProvider = slotProviderType || currentConfig.MODEL_PROVIDER;

        const attemptOpenAIRequest = structuredClone(virtualOpenAIRequest);
        const promptConstraintApplied = enhanceCodexImagePrompt(
            attemptOpenAIRequest,
            prompt,
            size,
            currentConfig,
            finalProviderProtocol,
            true
        );

        // 执行自动转换：OpenAI -> 目标协议
        let codexRequestBody = attemptOpenAIRequest;
        const fromProtocol = MODEL_PROTOCOL_PREFIX.OPENAI;
        if (fromProtocol !== finalProviderProtocol) {
            logger.info(`[Image Edits] Converting request from ${fromProtocol} to ${finalProviderProtocol}`);
            codexRequestBody = convertData(codexRequestBody, 'request', fromProtocol, toProvider, model, currentConfig._monitorRequestId);
            
            // 保持以 _ 开头的内部属性
            Object.keys(attemptOpenAIRequest).forEach(key => {
                if (key.startsWith('_') && codexRequestBody[key] === undefined) {
                    codexRequestBody[key] = attemptOpenAIRequest[key];
                }
            });
        }

        logger.info(`[Image Edits] model=${model}, protocol=${finalProviderProtocol}, n=${n}, response_format=${response_format}, imageCount=${imageFiles.length}, totalImageSize=${Math.round(totalImageBytes / 1024)}KB${size ? `, size=${size}` : ''}${quality ? `, quality=${quality}` : ''}`);
        logImagePayloadSummary('Image Edits', model, codexRequestBody);

        const imageRequests = Array.from({ length: n }, () =>
            generateImageWithInternalRetry(service, model, codexRequestBody, 'Image Edits')
        );
        const responses = await Promise.all(imageRequests);
        const data = [];

        for (let i = 0; i < responses.length; i++) {
            const extracted = extractImagesFromServiceResponse(responses[i], finalProviderProtocol, response_format);
            data.push(...extracted);
        }

        if (data.length === 0) {
            // 检查是否有拒绝消息
            const rejection = extractRejectionMessage(responses, finalProviderProtocol);
            if (rejection) {
                if (providerPoolManager && slotUuid && currentRetry < maxRetries) {
                    throw createImageRejectionRetryError('Image editing', rejection);
                }
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Image editing rejected: ${rejection}`, type: 'invalid_request_error' } }));
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Image editing failed: no image in response', type: 'server_error' } }));
            }
            return;
        }

        let responseData = data;
        let processingMetadata = null;
        if (isCodexImagePostprocessingEnabled(currentConfig, finalProviderProtocol, size)) {
            const normalized = await normalizeCodexImageData(data, {
                size,
                config: currentConfig,
                outputFormat: imageToolOptions?.output_format,
                promptConstraintApplied
            });
            responseData = normalized.data;
            processingMetadata = normalized.metadata;
        }

        const clientResponse = { created: Math.floor(Date.now() / 1000), data: responseData };
        if (includeProcessingMetadata && processingMetadata) {
            clientResponse.x_aiclient2api = { image_processing: processingMetadata };
        }

        // 监控钩子
        if (currentConfig._monitorRequestId) {
            try {
                const { getPluginManager } = await import('../core/plugin-manager.js');
                const pluginManager = getPluginManager();
                if (pluginManager) {
                    await pluginManager.executeHook('onUnaryResponse', {
                        nativeResponse: responses.length === 1 ? responses[0] : responses,
                        clientResponse,
                        fromProvider,
                        toProvider,
                        providerUuid: slotUuid || currentConfig.uuid,
                        providerName: slotCustomName || currentConfig.customName,
                        accountIdentity: slotAccountIdentity || currentConfig.codexAccountKey || currentConfig.codexAccountId || null,
                        accountEmail: slotAccountEmail || currentConfig.codexEmail || null,
                        model,
                        requestId: currentConfig._monitorRequestId
                    });

                    await pluginManager.executeHook('onContentGenerated', {
                        ...currentConfig,
                        originalRequestBody: { model, prompt, n, size, quality, response_format },
                        processedRequestBody: codexRequestBody,
                        fromProvider,
                        toProvider,
                        providerUuid: slotUuid || currentConfig.uuid,
                        providerName: slotCustomName || currentConfig.customName,
                        accountIdentity: slotAccountIdentity || currentConfig.codexAccountKey || currentConfig.codexAccountId || null,
                        accountEmail: slotAccountEmail || currentConfig.codexEmail || null,
                        model,
                        isStream: false
                    });
                }
            } catch (e) {
                logger.error('[Image Edits] Hook error:', e.message);
            }
        }

        await writeImageJsonResponse(res, clientResponse, {
            headers: processingMetadata ? buildImageProcessingHeaders(processingMetadata) : {}
        });
    } catch (error) {
        logImageRequestError('Image Edits', error);
        if (!res.writableEnded && writeImageProcessingError(res, error)) {
            return;
        }

        let credentialMarkedUnhealthy = error.credentialMarkedUnhealthy === true;
        let cooldownApplied = false;
        if (providerPoolManager && slotUuid && applyProviderRateLimitCooldown({
            error,
            config: CONFIG,
            providerPoolManager,
            providerType: slotProviderType,
            providerUuid: slotUuid,
            requestedModel: model
        })) {
            credentialMarkedUnhealthy = true;
            cooldownApplied = true;
        }
        if (error.shouldSwitchCredential === true) credentialMarkedUnhealthy = true;

        if (credentialMarkedUnhealthy && providerPoolManager && slotUuid && currentRetry < maxRetries) {
            const failedCredentialUuids = [
                ...(retryContext?.failedCredentialUuids || []),
                slotUuid
            ].filter(Boolean);
            const failedProviderTypes = [
                ...(retryContext?.failedProviderTypes || []),
                slotProviderType || CONFIG.MODEL_PROVIDER
            ].filter(Boolean);
            const randomDelay = error.imageProviderRetryable ? 0 : Math.floor(Math.random() * 10000);
            logger.info(`[Image Edits Retry] Switching credential without changing provider health. Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries}...`);
            await new Promise(resolve => setTimeout(resolve, randomDelay));

            return await handleImageEditsRequest(req, res, CONFIG, providerPoolManager, {
                ...retryContext,
                CONFIG,
                currentRetry: currentRetry + 1,
                maxRetries,
                failedCredentialUuids,
                failedProviderTypes,
                lastRateLimitError: cooldownApplied ? error : retryContext?.lastRateLimitError,
                allowExcludedProviderFallback: error.imageProviderRetryable === true,
                parsedForm: form
                ,capacityTicket
            });
        }

        writeImageRequestError(res, resolveFinalImageRequestError(error, retryContext, slotUuid));
    } finally {
        if (ownsCapacityTicket && capacityTicket) runtimeImageCapacity.release(capacityTicket);
        if (providerPoolManager && slotProviderType && slotUuid) {
            providerPoolManager.releaseSlot(slotProviderType, slotUuid);
        }
    }
}

/**
 * Extract image data from a service's generateContent response.
 * Handles different provider output formats.
 */
function extractImagesFromServiceResponse(response, providerProtocol, responseFormat) {
    const data = [];
    
    if (providerProtocol === MODEL_PROTOCOL_PREFIX.CODEX || providerProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
        const output = response?.response?.output || response?.output || [];
        for (const item of output) {
            if (item.type === 'image_generation_call' && item.result) {
                const dataItem = responseFormat === 'url'
                    ? { url: `data:image/${item.output_format || 'png'};base64,${item.result}` }
                    : { b64_json: item.result };
                if (item.revised_prompt) dataItem.revised_prompt = item.revised_prompt;
                data.push(dataItem);
            }
        }
    } else if (providerProtocol === MODEL_PROTOCOL_PREFIX.GROK) {
        // Grok returns collected object with generatedImageUrls or cardAttachments
        const imageUrls = response.generatedImageUrls || [];
        for (const url of imageUrls) {
            if (responseFormat === 'url') {
                data.push({ url });
            } else if (url.startsWith('data:image/')) {
                const b64 = url.split(',')[1];
                data.push({ b64_json: b64 });
            } else {
                data.push({ url });
            }
        }
        // Also check cardAttachments for images
        const cards = response.cardAttachments || [];
        for (const card of cards) {
            try {
                const jsonData = typeof card.jsonData === 'string' ? JSON.parse(card.jsonData) : card.jsonData;
                const imgUrl = jsonData?.image?.original;
                if (imgUrl) {
                    if (responseFormat === 'url') {
                        data.push({ url: imgUrl });
                    } else if (imgUrl.startsWith('data:image/')) {
                        const b64 = imgUrl.split(',')[1];
                        data.push({ b64_json: b64 });
                    } else {
                        data.push({ url: imgUrl });
                    }
                }
            } catch (e) {}
        }
    } else if (providerProtocol === MODEL_PROTOCOL_PREFIX.GEMINI) {
        // Gemini/Antigravity returns candidates with parts containing inlineData (images)
        const candidates = response?.response?.candidates || response?.candidates || [];
        for (const cand of candidates) {
            const parts = cand.content?.parts || [];
            for (const part of parts) {
                if (part.inlineData) {
                    const dataItem = responseFormat === 'url'
                        ? { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` }
                        : { b64_json: part.inlineData.data };
                    data.push(dataItem);
                }
            }
        }
    }
    
    return data;
}

