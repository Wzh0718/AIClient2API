import { atomicWriteFile } from '../../utils/file-lock.js';
import axios from 'axios';
import logger from '../../utils/logger.js';
import crypto from 'crypto';
import {promises as fs} from 'fs';
import path from 'path';
import os from 'os';
import {refreshCodexTokensWithRetry} from '../../auth/oauth-handlers.js';
import {getProviderPoolManager} from '../../services/service-manager.js';
import {configureTLSSidecar, isTLSSidecarEnabledForProvider} from '../../utils/proxy-utils.js';
import {MODEL_PROVIDER, formatExpiryLog, normalizeProviderErrorMessage} from '../../utils/common.js';
import {getProxyConfigForProvider} from '../../utils/proxy-utils.js';
import {getProviderModels} from '../provider-models.js';
import {
    buildCodexTemplateFingerprint,
    getProvidedPromptCacheKey,
    resolveCodexSessionId,
    resolveCodexSessionScope
} from './codex-session-utils.js';
import {
    CODEX_FINGERPRINT_CONTEXT_KEY,
    applyCodexFingerprintClientMetadata,
    applyCodexFingerprintHeaders,
    extractOriginalCodexSessionId,
    resolveCodexFingerprintIds
} from './codex-fingerprint.js';
import { recordCodexFingerprintAudit } from './codex-fingerprint-audit.js';
import { codexPromptCacheObservability } from './codex-prompt-cache-observability.js';
import requestContext from '../../utils/context.js';
import { performance } from 'node:perf_hooks';
import { getCodexRetryDelayMs, shouldRetryCodex429 } from './codex-retry-policy.js';
import { getCodexModelIds, sanitizeCodexModelParameters, normalizeCodexReasoningEffort } from './codex-model-capabilities.js';

const baseModels = getProviderModels(MODEL_PROVIDER.CODEX_API);
const CODEX_MODELS = getCodexModelIds(baseModels);
const CODEX_VERSION = '0.153.3';
export const IMAGE_MODELS = new Set(['gpt-image-2']);
const IMAGE_GENERATION_FUNCTION_NAMES = new Set(['image_gen.imagegen', 'image_gen__imagegen']);
const IMAGE_TOOL_STRING_FIELDS = ['size', 'quality', 'background', 'output_format', 'input_fidelity', 'moderation'];
const IMAGE_TOOL_NUMERIC_FIELDS = ['output_compression', 'partial_images'];

function normalizeCodexTerminalError(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;

    let errorBody = null;
    if (parsed.type === 'error') {
        errorBody = parsed.error && typeof parsed.error === 'object'
            ? parsed.error
            : { message: parsed.message || parsed.error || 'Codex API error' };
    } else if (parsed.type === 'response.failed') {
        errorBody = parsed.response?.error || parsed.error;
        if (!errorBody) {
            errorBody = { message: parsed.message || 'Codex response failed' };
        }
    }

    if (!errorBody) return null;
    if (typeof errorBody !== 'object') {
        errorBody = { message: String(errorBody) };
    }
    if (!errorBody.message) {
        errorBody.message = errorBody.code || errorBody.type || 'Codex API error';
    }
    return errorBody;
}

function isCodexUsageLimitError(errorBody) {
    const code = String(errorBody?.code || '').trim().toLowerCase();
    const type = String(errorBody?.type || '').trim().toLowerCase();
    return type === 'usage_limit_reached' ||
        type === 'insufficient_quota' ||
        code === 'insufficient_quota';
}

function isCodexModelCapacityError(errorBody) {
    const message = String(errorBody?.message || '').trim().toLowerCase();
    return message.includes('selected model is at capacity') ||
        message.includes('model is at capacity. please try a different model');
}

function shouldSwitchCodexCredential(errorBody) {
    const code = String(errorBody?.code || '').toLowerCase();
    const type = String(errorBody?.type || '').toLowerCase();
    return code === 'insufficient_quota' ||
        type === 'insufficient_quota' ||
        isCodexUsageLimitError(errorBody) ||
        isCodexModelCapacityError(errorBody);
}

function isCodexOverloadErrorBody(errorBody) {
    return String(errorBody?.code || '').trim().toLowerCase() === 'server_is_overloaded' ||
        String(errorBody?.type || '').trim().toLowerCase() === 'service_unavailable_error';
}

function parseCodexRetryAfterMs(errorBody) {
    const resetsAt = Number(errorBody?.resets_at);
    if (Number.isFinite(resetsAt) && resetsAt > 0) {
        const delay = resetsAt * 1000 - Date.now();
        return delay > 0 ? delay : null;
    }

    const resetsInSeconds = Number(errorBody?.resets_in_seconds);
    if (Number.isFinite(resetsInSeconds) && resetsInSeconds > 0) {
        return resetsInSeconds * 1000;
    }
    return null;
}

function createCodexTerminalError(parsed) {
    const errorBody = normalizeCodexTerminalError(parsed);
    if (!errorBody) return null;

    const isRetryableLimit = isCodexUsageLimitError(errorBody) || isCodexModelCapacityError(errorBody);
    const isOverload = isCodexOverloadErrorBody(errorBody);
    const error = new Error(`Codex API error: ${errorBody.message}`);
    error.origin = 'upstream_codex';
    error.response = {
        status: isOverload ? 503 : (isRetryableLimit ? 429 : 400),
        data: { error: errorBody }
    };
    if (parsed.response && typeof parsed.response === 'object') {
        error.responseSnapshot = { ...parsed.response };
        if (parsed.response.id) {
            error.responseId = parsed.response.id;
        }
    }

    if (isOverload) {
        error.isCodexOverload = true;
        error.retrySameCredential = true;
        error.recordProviderForNextRequest = true;
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
    }

    if (isCodexModelCapacityError(errorBody)) {
        error.isCodexModelCapacity = true;
    }

    if (shouldSwitchCodexCredential(errorBody)) {
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
    }

    if (isCodexUsageLimitError(errorBody)) {
        const retryAfterMs = parseCodexRetryAfterMs(errorBody);
        if (retryAfterMs !== null) {
            error.retryAfterMs = retryAfterMs;
        }
    }
    return error;
}

function extractSSEData(line) {
    const trimmedLine = String(line || '').trim();
    if (!trimmedLine || trimmedLine.startsWith(':') || trimmedLine.startsWith('event:') || trimmedLine.startsWith('id:') || trimmedLine.startsWith('retry:')) {
        return null;
    }
    if (trimmedLine.startsWith('data:')) {
        return trimmedLine.slice(5).trim();
    }
    return trimmedLine;
}

function isCodexPreludeEvent(event) {
    return event?.type === 'response.created' || event?.type === 'response.in_progress';
}

function applyImageToolOptions(imageToolConfig, options) {
    if (!options || typeof options !== 'object') return;

    for (const field of IMAGE_TOOL_STRING_FIELDS) {
        const value = options[field];
        if (value === undefined || value === null) continue;

        const text = String(value).trim();
        if (text) {
            imageToolConfig[field] = text;
        }
    }

    for (const field of IMAGE_TOOL_NUMERIC_FIELDS) {
        const value = options[field];
        if (value === undefined || value === null || value === '') continue;

        const number = Number.parseInt(value, 10);
        if (Number.isFinite(number)) {
            imageToolConfig[field] = number;
        }
    }
}

function sanitizeCodexReasoningInput(input) {
    if (!Array.isArray(input)) return input;
    return input.map(item => {
        if (!item || typeof item !== 'object' || item.type !== 'reasoning') return item;
        const sanitized = { ...item };
        delete sanitized.id;
        if (!Array.isArray(sanitized.summary)) sanitized.summary = [];
        return sanitized;
    });
}

function parseRejectedFieldError(error) {
    if (error?.response?.status !== 400) return null;
    let payload = error.response.data;
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { return null; }
    }
    const upstreamError = payload?.error || payload;
    const code = String(upstreamError?.code || '').trim().toLowerCase();
    const message = String(upstreamError?.message || '').trim();
    if (!['unknown_parameter', 'unsupported_parameter'].includes(code) &&
        !/unknown\s+parameter|unsupported\s+parameter/i.test(message)) {
        return null;
    }
    const explicitParam = String(upstreamError?.param || '').trim();
    if (explicitParam) return explicitParam;
    return message.match(/(?:unknown|unsupported)[ _-]+parameter\s*(?::|=|is)?\s*["']?([^"'\s.]+(?:\[\d+\]\.[a-z_]+)?)/i)?.[1] || null;
}

function removeRejectedResponsesField(body, error) {
    const param = String(parseRejectedFieldError(error) || '').trim().toLowerCase();
    if (!param) return false;
    if (param === 'max_output_tokens' && Object.prototype.hasOwnProperty.call(body, 'max_output_tokens')) {
        delete body.max_output_tokens;
        return true;
    }
    const namespaceMatch = param.match(/^input\[(\d+)\]\.namespace$/);
    if (!namespaceMatch || !Array.isArray(body.input)) return false;
    const item = body.input[Number(namespaceMatch[1])];
    if (!item || typeof item !== 'object' || !['function_call', 'tool_call', 'custom_tool_call', 'mcp_tool_call'].includes(item.type)) {
        return false;
    }
    if (!Object.prototype.hasOwnProperty.call(item, 'namespace')) return false;
    delete item.namespace;
    return true;
}

/**
 * Codex API 服务类
 */
export class CodexApiService {
    constructor(config) {
        this.config = config;
        this.baseUrl = config.CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex';
        this.accessToken = null;
        this.refreshToken = null;
        this.accountId = null;
        this.email = null;
        this.expiresAt = null;
        this.idToken = null;
        this.last_refresh = null;
        this.credsPath = null; // 记录本次加载/使用的凭据文件路径，确保刷新后写回同一文件
        this.accessTokenOnlyRefreshLogged = false;
        this.uuid = config.uuid; // 保存 uuid 用于号池管理
        this.isInitialized = false;

        // 会话缓存管理
        this.conversationCache = new Map(); // key: model-userId, value: {id, expire}
        this.startCacheCleanup();

        this.imageGenTool = {type: 'image_generation', output_format: 'png'};
        this.fingerprintRequestState = new WeakMap();
    }

    _applySidecar(axiosConfig) {
        return configureTLSSidecar(axiosConfig, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API, this.baseUrl);
    }

    resolveFingerprintState(requestBody) {
        if (!requestBody || typeof requestBody !== 'object') {
            return { inboundHeaders: {}, ids: null };
        }
        const cached = this.fingerprintRequestState.get(requestBody);
        if (cached) return cached;

        const context = requestBody[CODEX_FINGERPRINT_CONTEXT_KEY];
        const inboundHeaders = context?.inboundCodexHeaders && typeof context.inboundCodexHeaders === 'object'
            ? { ...context.inboundCodexHeaders }
            : {};
        const originalClientSessionId = String(
            context?.originalClientSessionId || extractOriginalCodexSessionId(inboundHeaders, requestBody) || ''
        ).trim();
        const state = {
            inboundHeaders,
            ids: resolveCodexFingerprintIds({
                providerConfig: this.config,
                globalConfig: this.config,
                originalClientSessionId
            })
        };
        recordCodexFingerprintAudit(this.config, state.ids, state.ids?.mode || 'off');
        this.fingerprintRequestState.set(requestBody, state);
        return state;
    }

    /**
     * 初始化服务（加载凭据）
     */
    async initialize() {
        if (this.isInitialized) return;
        logger.info('[Codex] Initializing Codex API Service...');
        // 注意：V2 读写分离架构下，初始化不再执行同步认证/刷新逻辑
        // 仅执行基础的凭证加载
        await this.loadCredentials();

        this.isInitialized = true;
        logger.info(`[Codex] Initialization complete. Account: ${this.email || 'unknown'}`);
    }

    /**
     * 加载凭证信息（不执行刷新）
     */
    async loadCredentials() {
        const email = this.config.CODEX_EMAIL || 'default';

        try {
            let creds;
            let credsPath;

            // 如果指定了具体路径，直接读取
            if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
                credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
                const exists = await this.fileExists(credsPath);
                if (!exists) {
                    throw new Error('Codex credentials not found. Please authenticate first using OAuth.');
                }
                creds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
            } else {
                // 从 configs/codex 目录扫描加载
                const projectDir = process.cwd();
                const targetDir = path.join(projectDir, 'configs', 'codex');
                const files = await fs.readdir(targetDir);
                const matchingFile = files
                    .filter(f => f.includes(`codex-${email}`) && f.endsWith('.json'))
                    .sort()
                    .pop(); // 获取最新的文件

                if (!matchingFile) {
                    throw new Error('Codex credentials not found. Please authenticate first using OAuth.');
                }

                credsPath = path.join(targetDir, matchingFile);
                creds = JSON.parse(await fs.readFile(credsPath, 'utf8'));
            }

            // 记录凭据路径，确保 refresh 时写回同一文件。
            this.credsPath = credsPath;

            this.idToken = creds.id_token || this.idToken;
            this.accessToken = creds.access_token;
            this.refreshToken = creds.refresh_token;
            this.accountId = creds.account_id;
            this.email = creds.email;
            this.last_refresh = creds.last_refresh || this.last_refresh;
            this.expiresAt = new Date(creds.expired); // 注意：字段名是 expired

            // 检查 token 是否需要刷新（异步触发，不阻塞加载）
            if (this.isExpiryDateNear()) {
                this.triggerBackgroundRefresh();
            }

            this.isInitialized = true;
            logger.info(`[Codex] Initialized with account: ${this.email}`);
        } catch (error) {
            logger.warn(`[Codex Auth] Failed to load credentials: ${error.message}`);
        }
    }

    /**
     * 初始化认证并执行必要刷新
     */
    async initializeAuth(forceRefresh = false) {
        // 检查 token 是否需要刷新
        const needsRefresh = forceRefresh;

        if (this.accessToken && !needsRefresh) {
            return;
        }

        // 首先执行基础凭证加载
        await this.loadCredentials();

        // 只有在明确要求刷新，或者 AccessToken 缺失时，才执行刷新
        // 注意：在 V2 架构下，此方法主要由 PoolManager 的后台队列调用
        if (needsRefresh || !this.accessToken) {
            if (!this.refreshToken) {
                if (this.accessToken) {
                    this.logAccessTokenOnlyRefreshSkipped();
                    return;
                }
                throw new Error('Codex credentials not found. Please authenticate first using OAuth.');
            }
            logger.info('[Codex] Token expiring soon or refresh requested, refreshing...');
            await this.refreshAccessToken();
        }
    }

    /**
     * 后台异步刷新 token（不阻塞当前请求）
     */
    triggerBackgroundRefresh() {
        if (!this.refreshToken) {
            this.logAccessTokenOnlyRefreshSkipped();
            return;
        }

        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
            logger.info(`[Codex] Token is near expiry, marking credential ${this.uuid} for background refresh`);
            poolManager.markProviderNeedRefresh(this.config.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API, {
                uuid: this.uuid
            });
        }
    }

    logAccessTokenOnlyRefreshSkipped() {
        if (this.accessTokenOnlyRefreshLogged) return;
        this.accessTokenOnlyRefreshLogged = true;
        logger.warn('[Codex] Access-token-only credential cannot be refreshed because refresh_token is empty. Re-import or re-authenticate when it expires.');
    }

    /**
     * 生成内容（非流式）
     */
    async generateContent(model, requestBody) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        let selectedModel = model;
        if (!CODEX_MODELS.includes(model)) {
            throw new Error(`[Codex] 不支持的模型: ${model}`);
        }

        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        // 检查 token 是否即将过期，如果是则触发后台异步刷新
        if (this.isExpiryDateNear()) {
            this.triggerBackgroundRefresh();
        }

        const url = `${this.baseUrl}/responses`;
        const fingerprintState = this.resolveFingerprintState(requestBody);
        const body = await this.prepareRequestBody(selectedModel, requestBody, true, fingerprintState.ids);
        codexPromptCacheObservability.recordPresence({
            providerType: this.config.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API,
            promptCacheOptions: body.prompt_cache_options
        });
        const headers = this.buildHeaders(body.prompt_cache_key, true, fingerprintState);

        let overloadRetryCount = 0;
        let rateLimitRetryCount = 0;
        let rejectedFieldRetryCount = 0;
        while (true) {
            try {
                const config = {
                    headers,
                    responseType: 'text', // 确保以文本形式接收 SSE 流
                    timeout: 300000 // 5 分钟超时，适应慢速模型
                };

                const axiosRequestConfig = {
                    method: 'post',
                    url,
                    data: body,
                    ...config
                };
                this._applySidecar(axiosRequestConfig);

                const upstreamStartedAt = performance.now();
                const response = await axios.request(axiosRequestConfig);
                const upstreamReceivedAt = performance.now();
                const runtimeRequest = requestContext.get('runtimeRequest');
                runtimeRequest?.recordStage?.('upstreamFirstByteMs', upstreamReceivedAt - upstreamStartedAt);
                const parsed = this.parseNonStreamResponse(response.data);
                runtimeRequest?.recordStage?.('upstreamCompleteMs', performance.now() - upstreamStartedAt);
                return parsed;
            } catch (error) {
                error.origin = error.origin || 'upstream_codex';
                codexPromptCacheObservability.recordUpstreamError({
                    providerType: this.config.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API,
                    promptCacheOptions: body.prompt_cache_options,
                    httpStatus: error.response?.status,
                    errorClass: error.response?.data?.error?.type || error.response?.data?.error?.code
                });
                if (rejectedFieldRetryCount < 1 && removeRejectedResponsesField(body, error)) {
                    rejectedFieldRetryCount += 1;
                    logger.warn('[Codex] Upstream rejected an allowlisted Responses field; retrying once with that field removed');
                    continue;
                }
                if (error.isCodexOverload && !error.responseModel) {
                    error.responseModel = selectedModel;
                }
                if (error.isCodexOverload && overloadRetryCount < 1) {
                    overloadRetryCount += 1;
                    const delayMs = Number(this.config.CODEX_OVERLOAD_RETRY_DELAY_MS ?? 800);
                    logger.warn(`[Codex] Upstream overloaded; retrying same credential once after ${delayMs}ms`);
                    if (delayMs > 0) {
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                    }
                    continue;
                }

                if (shouldRetryCodex429(error, { attempts: rateLimitRetryCount, maxAttempts: 1 })) {
                    rateLimitRetryCount += 1;
                    const delayMs = getCodexRetryDelayMs(error, {
                        fallbackMs: Number(this.config.CODEX_RATE_LIMIT_RETRY_DELAY_MS ?? 800),
                        maxDelayMs: Number(this.config.CODEX_RATE_LIMIT_RETRY_MAX_DELAY_MS ?? 30000)
                    });
                    logger.warn(`[Codex] Upstream rate limited; retrying same credential once after ${delayMs}ms`);
                    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
                    continue;
                }

                if (error.response?.status === 429) {
                    error.isCodexRateLimit = true;
                    error.details = { ...(error.details || {}), reason: 'UPSTREAM_RATE_LIMIT' };
                }

                if (error.response?.status === 401) {
                    logger.info('[Codex] Received 401. Triggering background refresh...');
                    await normalizeProviderErrorMessage(error, { status: 401, context: 'non-stream' });

                    // 触发后台异步刷新
                    this.triggerBackgroundRefresh();
                    error.credentialMarkedUnhealthy = true;

                    // Mark error for credential switch without recording error count
                    error.shouldSwitchCredential = true;
                    error.skipErrorCount = true;
                    throw error;
                }

                if (error.response?.status) {
                    await normalizeProviderErrorMessage(error, { status: error.response.status, context: 'non-stream' });
                }
                logger.error(`[Codex] Error calling non-stream API (Status: ${error.response?.status}, Code: ${error.code || 'N/A'}): ${error.message}`);
                throw error;
            }
        }
    }

    /**
     * 流式生成内容
     */
    async* generateContentStream(model, requestBody) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        let selectedModel = model;
        if (!CODEX_MODELS.includes(model)) {
            throw new Error(`[Codex] 不支持的模型: ${model}`);
        }

        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        // 检查 token 是否即将过期，如果是则触发后台异步刷新
        if (this.isExpiryDateNear()) {
            this.triggerBackgroundRefresh();
        }

        const url = `${this.baseUrl}/responses`;
        const fingerprintState = this.resolveFingerprintState(requestBody);
        const body = await this.prepareRequestBody(selectedModel, requestBody, true, fingerprintState.ids);
        codexPromptCacheObservability.recordPresence({
            providerType: this.config.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API,
            promptCacheOptions: body.prompt_cache_options
        });
        const headers = this.buildHeaders(body.prompt_cache_key, true, fingerprintState);

        let overloadRetryCount = 0;
        let rateLimitRetryCount = 0;
        let rejectedFieldRetryCount = 0;
        while (true) {
            const bufferedPrelude = [];
            let responseId = null;
            let responseSnapshot = null;
            let hasVisibleOutput = false;
            try {
                const config = {
                    headers,
                    responseType: 'stream',
                    timeout: 300000 // 5 分钟超时
                };

                const axiosRequestConfig = {
                    method: 'post',
                    url,
                    data: body,
                    ...config
                };
                this._applySidecar(axiosRequestConfig);

                const upstreamStartedAt = performance.now();
                const response = await axios.request(axiosRequestConfig);
                const runtimeRequest = requestContext.get('runtimeRequest');
                runtimeRequest?.recordStage?.('upstreamFirstByteMs', performance.now() - upstreamStartedAt);

                for await (const event of this.parseSSEStream(response.data)) {
                    if (event?.response?.id) {
                        responseId = event.response.id;
                    }
                    if (event?.response && typeof event.response === 'object') {
                        responseSnapshot = { ...event.response };
                    }
                    if (isCodexPreludeEvent(event)) {
                        bufferedPrelude.push(event);
                        continue;
                    }

                    while (bufferedPrelude.length > 0) {
                        yield bufferedPrelude.shift();
                    }
                    hasVisibleOutput = true;
                    yield event;
                }

                while (bufferedPrelude.length > 0) {
                    yield bufferedPrelude.shift();
                }
                runtimeRequest?.recordStage?.('upstreamCompleteMs', performance.now() - upstreamStartedAt);
                return;
            } catch (error) {
                error.origin = error.origin || 'upstream_codex';
                codexPromptCacheObservability.recordUpstreamError({
                    providerType: this.config.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API,
                    promptCacheOptions: body.prompt_cache_options,
                    httpStatus: error.response?.status,
                    errorClass: error.response?.data?.error?.type || error.response?.data?.error?.code
                });
                if (!hasVisibleOutput && rejectedFieldRetryCount < 1 && removeRejectedResponsesField(body, error)) {
                    rejectedFieldRetryCount += 1;
                    logger.warn('[Codex] Upstream rejected an allowlisted Responses field; retrying stream once with that field removed');
                    continue;
                }
                if (responseSnapshot) {
                    error.responseSnapshot = {
                        ...responseSnapshot,
                        ...(error.responseSnapshot || {})
                    };
                }
                if (responseId && !error.responseId) {
                    error.responseId = responseId;
                }
                if (error.isCodexOverload && !error.responseModel) {
                    error.responseModel = selectedModel;
                }
                if (error.isCodexOverload && !hasVisibleOutput && overloadRetryCount < 1) {
                    overloadRetryCount += 1;
                    const delayMs = Number(this.config.CODEX_OVERLOAD_RETRY_DELAY_MS ?? 800);
                    logger.warn(`[Codex] Upstream overloaded; retrying same credential once after ${delayMs}ms`);
                    if (delayMs > 0) {
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                    }
                    continue;
                }

                if (!hasVisibleOutput && shouldRetryCodex429(error, { attempts: rateLimitRetryCount, maxAttempts: 1 })) {
                    rateLimitRetryCount += 1;
                    const delayMs = getCodexRetryDelayMs(error, {
                        fallbackMs: Number(this.config.CODEX_RATE_LIMIT_RETRY_DELAY_MS ?? 800),
                        maxDelayMs: Number(this.config.CODEX_RATE_LIMIT_RETRY_MAX_DELAY_MS ?? 30000)
                    });
                    logger.warn(`[Codex] Upstream rate limited stream; retrying same credential once after ${delayMs}ms`);
                    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
                    continue;
                }

                if (error.response?.status === 429) {
                    error.isCodexRateLimit = true;
                    error.details = { ...(error.details || {}), reason: 'UPSTREAM_RATE_LIMIT' };
                }

                if (error.response?.status === 401) {
                    logger.info('[Codex] Received 401 during stream. Triggering background refresh...');
                    await normalizeProviderErrorMessage(error, { status: 401, context: 'stream' });

                    // 触发后台异步刷新
                    this.triggerBackgroundRefresh();
                    error.credentialMarkedUnhealthy = true;

                    // Mark error for credential switch without recording error count
                    error.shouldSwitchCredential = true;
                    error.skipErrorCount = true;
                    throw error;
                }

                if (error.response?.status) {
                    await normalizeProviderErrorMessage(error, { status: error.response.status, context: 'stream' });
                }
                logger.error(`[Codex] Error calling streaming API (Status: ${error.response?.status}, Code: ${error.code || 'N/A'}):`, error.message);
                throw error;
            }
        }
    }

    /**
     * 构建请求头
     */
    buildHeaders(cacheId, stream = true, fingerprintState = null) {
        const headers = {
            'version': CODEX_VERSION,
            'x-codex-beta-features': 'powershell_utf8',
            'x-oai-web-search-eligible': 'true',
            'authorization': `Bearer ${this.accessToken}`,
            'chatgpt-account-id': this.accountId,
            'content-type': 'application/json',
            'user-agent': `codex-tui/${CODEX_VERSION} (Windows 10.0.26100; x86_64) WindowsTerminal (codex-tui; ${CODEX_VERSION})`,
            'originator': 'codex-tui',
            'host': 'chatgpt.com',
            'Connection': 'Keep-Alive'
        };

        const inboundHeaders = fingerprintState?.inboundHeaders || {};
        const getInboundHeader = (name) => Object.entries(inboundHeaders)
            .find(([key, value]) => key.toLowerCase() === name.toLowerCase() && value !== undefined && value !== null && String(value).trim())?.[1];
        for (const name of [
            'x-codex-turn-metadata', 'x-codex-window-id', 'x-codex-installation-id',
            'x-client-request-id', 'thread-id'
        ]) {
            const value = getInboundHeader(name);
            if (value !== undefined && value !== null && String(value).trim()) {
                headers[name] = String(value);
            }
        }
        // 入站兼容多种 session header，出站只保留 canonical Session-Id。
        const inboundSession = ['session-id', 'session_id']
            .map(name => getInboundHeader(name))
            .find(value => value !== undefined && value !== null && String(value).trim());
        const sessionHeader = inboundSession || cacheId;
        if (sessionHeader) {
            headers['Session-Id'] = String(sessionHeader);
        }

        // 设置 Conversation_id；prompt_cache_key 继续保留并参与现有 sticky/cache 逻辑。
        if (cacheId) {
            headers['Conversation_id'] = cacheId;
        }

        // 必须最后改写，让账号级指纹覆盖入站身份，同时维持唯一 canonical Session-Id。
        if (fingerprintState?.ids) {
            applyCodexFingerprintHeaders(headers, fingerprintState.ids);
        }

        // 根据是否流式设置 Accept 头
        if (stream) {
            headers['accept'] = 'text/event-stream';
        } else {
            headers['accept'] = 'application/json';
        }

        return headers;
    }

    /**
     * 构建 Codex 管理类接口请求头
     */
    buildManagementHeaders() {
        return {
            'authorization': `Bearer ${this.accessToken}`,
            'chatgpt-account-id': this.accountId,
            'oai-language': 'zh-CN',
            'originator': 'Codex Desktop',
            'accept': 'application/json',
            'sec-fetch-site': 'none',
            'sec-fetch-mode': 'no-cors',
            'sec-fetch-dest': 'empty',
            'priority': 'u=4, i'
        };
    }

    /**
     * 准备请求体
     */
    async prepareRequestBody(model, requestBody, stream, fingerprintIds = null) {
        // 明确会话维度：优先 OpenAI metadata，其次 Codex CLI client_metadata
        const sessionId = resolveCodexSessionId(requestBody);

        // 判断速度档位并确定默认值
        const normalizedModel = String(model || '').trim();
        const isUltraFastModel = /-ultrafast$/i.test(normalizedModel);
        const isFastModel = /-fast$/i.test(normalizedModel);
        const isSpeedModel = isUltraFastModel || isFastModel;
        const upstreamModel = isSpeedModel
            ? normalizedModel.replace(/-(?:fast|ultrafast)$/i, '')
            : normalizedModel;
        const defaultServiceTier = isUltraFastModel ? 'ultrafast' : isFastModel ? 'priority' : 'default';
        const defaultReasoningEffort = isSpeedModel ? 'xhigh' : 'medium';

        // 图像生成模型：gpt-image-2 通过 image_generation 工具 + gpt-5.6-luna 实现
        const isImageModel = IMAGE_MODELS.has(upstreamModel);
        const effectiveUpstreamModel = isImageModel ? 'gpt-5.6-luna' : upstreamModel;

        const cleanedBody = sanitizeCodexModelParameters(upstreamModel, {...requestBody});
        if (fingerprintIds) {
            applyCodexFingerprintClientMetadata(cleanedBody, fingerprintIds);
        }
        delete cleanedBody[CODEX_FINGERPRINT_CONTEXT_KEY];
        delete cleanedBody.metadata;
        delete cleanedBody.previous_response_id;
        delete cleanedBody.prompt_cache_retention;
        delete cleanedBody.safety_identifier;
        delete cleanedBody.stream_options;
        cleanedBody.input = sanitizeCodexReasoningInput(cleanedBody.input);

        // 【关键修复】确保传给上游的模型名称不带速度后缀
        // 即使 originalRequestBody 中已经带了 model，这里也必须覆盖
        cleanedBody.model = effectiveUpstreamModel;

        if (isImageModel) {
            // 图像模型：强制使用 image_generation 工具，不加 web_search
            const imageToolConfig = {type: 'image_generation'};
            applyImageToolOptions(imageToolConfig, cleanedBody._imageToolOptions);
            if (cleanedBody._imageSize && !imageToolConfig.size) {
                imageToolConfig.size = cleanedBody._imageSize;
            }
            if (cleanedBody._imageQuality && !imageToolConfig.quality) {
                imageToolConfig.quality = cleanedBody._imageQuality;
            }
            delete cleanedBody._imageSize;
            delete cleanedBody._imageQuality;
            delete cleanedBody._imageToolOptions;
            delete cleanedBody._imagePromptConstraintApplied;
            cleanedBody.tools = [imageToolConfig];
            // 服务器要求 instructions 非空
            if (!cleanedBody.instructions?.trim()) {
                cleanedBody.instructions = 'You are a helpful assistant.';
            }
            const imageToolLogDetails = Object.entries(imageToolConfig)
                .filter(([key]) => key !== 'type')
                .map(([key, value]) => `${key}=${value}`)
                .join(', ');
            logger.info(`[Codex] Image model detected: ${upstreamModel} -> ${effectiveUpstreamModel} with image_generation tool${imageToolLogDetails ? `, ${imageToolLogDetails}` : ''}`);
        } else {
            // 为普通 Codex 模型增加默认工具
            if (!cleanedBody.tools) {
                cleanedBody.tools = [];
            }
            if (Array.isArray(cleanedBody.tools)) {
                const hasWebSearch = cleanedBody.tools.some(t => t.type === 'web_search');
                if (!hasWebSearch) {
                    cleanedBody.tools.push({type: 'web_search'});
                }
                const hasHostedImageGeneration = cleanedBody.tools.some(tool => tool?.type === 'image_generation');
                const hasImageGenerationFunction = cleanedBody.tools.some(tool => {
                    if (tool?.type !== 'function') return false;
                    const name = tool.name || tool.function?.name;
                    return IMAGE_GENERATION_FUNCTION_NAMES.has(name);
                });
                if (!hasHostedImageGeneration && !hasImageGenerationFunction) {
                    cleanedBody.tools.push(this.imageGenTool);
                }
            }
        }

        if (isSpeedModel) {
            logger.info(`[Codex] Detected speed model: ${normalizedModel} -> ${upstreamModel}, service_tier: ${cleanedBody.service_tier || defaultServiceTier}`);
        }

        const providedPromptCacheKey = getProvidedPromptCacheKey(requestBody);
        const explicitSessionScope = resolveCodexSessionScope(requestBody);
        const providerScope = String(this.config.uuid || this.uuid || this.config.MODEL_PROVIDER || 'unknown-provider');
        const templateFingerprint = explicitSessionScope ? null : buildCodexTemplateFingerprint({
            potluckApiKey: this.config.potluckApiKey || '',
            model: effectiveUpstreamModel,
            upstreamBody: cleanedBody
        });
        const sharedScope = explicitSessionScope
            ? `${providerScope}:session:${crypto.createHash('sha256').update(explicitSessionScope).digest('hex')}`
            : `${providerScope}:template:${templateFingerprint}`;
        let cacheKeySource = providedPromptCacheKey
            ? 'client_explicit'
            : explicitSessionScope ? 'shared_session' : 'shared_template';
        let cacheCoordinationStatus = providedPromptCacheKey ? 'shared' : 'degraded';
        let cache = providedPromptCacheKey ? { id: providedPromptCacheKey } : null;

        if (!providedPromptCacheKey) {
            try {
                const coordination = getProviderPoolManager()?.coordination;
                if (coordination?.resolvePromptCacheKey) {
                    cache = {
                        id: await coordination.resolvePromptCacheKey(sharedScope, { ttlMs: 3600000 }),
                        expire: Date.now() + 3600000
                    };
                    cacheCoordinationStatus = 'shared';
                }
            } catch (error) {
                logger.warn(`[Codex] Shared prompt cache coordination unavailable; using local fallback: ${error.message}`);
            }

            if (!cache?.id) {
                cacheKeySource = 'local_fallback';
                const localCacheKey = `${providerScope}:${explicitSessionScope ? `session:${sessionId}` : `template:${templateFingerprint}`}`;
                cache = this.conversationCache.get(localCacheKey);
                if (!cache || cache.expire < Date.now()) {
                    cache = { id: crypto.randomUUID(), expire: Date.now() + 3600000 };
                    this.conversationCache.set(localCacheKey, cache);
                }
            }
        }

        // 注意：requestBody 已经去除了 metadata
        const result = {
            ...cleanedBody,
            store: cleanedBody.store ?? false,
            parallel_tool_calls: cleanedBody.parallel_tool_calls ?? true,
            include: cleanedBody.include || ['reasoning.encrypted_content'],
            service_tier: (isSpeedModel && (!cleanedBody.service_tier || cleanedBody.service_tier === 'default'))
                ? defaultServiceTier
                : (cleanedBody.service_tier || defaultServiceTier),
            reasoning: {
                ...cleanedBody.reasoning,
                effort: normalizeCodexReasoningEffort(upstreamModel, cleanedBody.reasoning?.effort, isSpeedModel) || defaultReasoningEffort,
                summary: cleanedBody.reasoning?.summary || 'auto',
            },
            stream,
            prompt_cache_key: cache.id
        };

        if (!result.instructions) {
            result.instructions = '';
        }
        if (!Array.isArray(result.tools) || result.tools.length === 0) {
            delete result.parallel_tool_calls;
        }

        delete result.messages;

        if (!["default", "priority", "fast", "ultrafast"].includes(result.service_tier)) {
            delete result.service_tier;
        }

        // 监控钩子：内部请求转换
        if (this.config?._monitorRequestId) {
            try {
                const {getPluginManager} = await import('../../core/plugin-manager.js');
                const pluginManager = getPluginManager();
                if (pluginManager) {
                    await pluginManager.executeHook('onInternalRequestConverted', {
                        requestId: this.config._monitorRequestId,
                        internalRequest: result,
                        converterName: 'prepareRequestBody'
                    });
                    await pluginManager.executeHook('onUpstreamRequestPrepared', {
                        requestId: this.config._monitorRequestId,
                        potluckApiKey: this.config.potluckApiKey || null,
                        providerUuid: this.config.uuid || null,
                        workerId: process.env.RUNTIME_WORKER_ID || null,
                        model: effectiveUpstreamModel,
                        clientPromptCacheKey: providedPromptCacheKey || null,
                        finalPromptCacheKey: result.prompt_cache_key,
                        cacheKeySource,
                        cacheCoordinationStatus,
                        templateFingerprint,
                        originalRequestBody: requestBody,
                        upstreamRequestBody: result
                    });
                }
            } catch (e) {
                logger.error('[Codex] Error calling onInternalRequestConverted hook:', e.message);
            }
        }

        return result;
    }

    /**
     * 刷新访问令牌
     */
    async refreshAccessToken() {
        if (!this.refreshToken) {
            this.logAccessTokenOnlyRefreshSkipped();
            throw new Error('Cannot refresh Codex access-token-only credential without refresh_token.');
        }

        try {
            const newTokens = await refreshCodexTokensWithRetry(this.refreshToken, this.config);

            this.idToken = newTokens.id_token || this.idToken;
            this.accessToken = newTokens.access_token;
            this.refreshToken = newTokens.refresh_token;
            this.accountId = newTokens.account_id;
            this.email = newTokens.email;
            this.last_refresh = new Date().toISOString();

            // 关键修复：refreshCodexTokensWithRetry 返回字段名是 `expired`（ISO string），不是 `expire`
            const expiredValue = newTokens.expired || newTokens.expire || newTokens.expires_at || newTokens.expiresAt;
            const parsedExpiry = expiredValue ? new Date(expiredValue) : null;
            if (!parsedExpiry || Number.isNaN(parsedExpiry.getTime())) {
                // 如果上游没返回可解析的过期时间，保守处理：按 1h 有效期估算（避免 expiresAt 变成 NaN 导致永不刷新）
                this.expiresAt = new Date(Date.now() + 3600 * 1000);
                logger.warn('[Codex] Token refresh did not include a valid expiry time; falling back to 1h from now');
            } else {
                this.expiresAt = parsedExpiry;
            }

            // 保存更新的凭据
            await this.saveCredentials();

            // 刷新成功，重置 PoolManager 中的刷新状态并标记为健康
            const poolManager = getProviderPoolManager();
            if (poolManager && this.uuid) {
                poolManager.resetProviderRefreshStatus(this.config.MODEL_PROVIDER || MODEL_PROVIDER.CODEX_API, this.uuid);
            }
            logger.info('[Codex] Token refreshed successfully');
        } catch (error) {
            logger.error('[Codex] Failed to refresh token:', error.message);
            throw new Error('Failed to refresh Codex token. Please re-authenticate.');
        }
    }

    /**
     * 检查 token 是否即将过期
     */
    isExpiryDateNear() {
        if (!this.expiresAt) return true;
        const expiry = this.expiresAt.getTime();
        // 如果 expiresAt 是 Invalid Date（NaN），必须视为“接近过期/已过期”，否则刷新永远不会触发
        if (Number.isNaN(expiry)) {
            logger.warn('[Codex] expiresAt is invalid (NaN). Treating as near expiry to force refresh');
            return true;
        }
        const nearMinutes = 20;
        const {message, isNearExpiry} = formatExpiryLog('Codex', expiry, nearMinutes);
        logger.info(message);
        return isNearExpiry;
    }

    /**
     * 获取凭据文件路径
     */
    getCredentialsPath() {
        const email = this.config.CODEX_EMAIL || this.email || 'default';

        // 1) 优先使用配置中指定的路径（号池模式/显式配置）
        if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
            return this.config.CODEX_OAUTH_CREDS_FILE_PATH;
        }

        // 2) 如果本次是从 configs/codex 扫描加载的，务必写回同一文件
        if (this.credsPath) {
            return this.credsPath;
        }

        // 3) 兜底：写入 configs/codex（与 OAuth 保存默认目录保持一致，避免“读取 configs/codex、写入 .codex”导致永远读到旧 token）
        const projectDir = process.cwd();
        return path.join(projectDir, 'configs', 'codex', `${Date.now()}_codex-${email}_oauth_creds.json`);
    }

    /**
     * 保存凭据
     */
    async saveCredentials() {
        const credsPath = this.getCredentialsPath();
        const credsDir = path.dirname(credsPath);

        if (!this.expiresAt || Number.isNaN(this.expiresAt.getTime())) {
            throw new Error('Invalid expiresAt when saving Codex credentials');
        }

        await fs.mkdir(credsDir, {recursive: true});
        await atomicWriteFile(
            credsPath,
            JSON.stringify(
                {
                    id_token: this.idToken || '',
                    access_token: this.accessToken,
                    refresh_token: this.refreshToken,
                    account_id: this.accountId,
                    last_refresh: this.last_refresh || new Date().toISOString(),
                    email: this.email,
                    type: 'codex',
                    expired: this.expiresAt.toISOString()
                },
                null,
                2
            ),
            { encoding: 'utf8', mode: 0o600 }
        );

        // 更新缓存路径（例如首次无 credsPath 兜底生成了新文件）
        this.credsPath = credsPath;
    }

    /**
     * 检查文件是否存在
     */
    async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 收集 Codex 输出项
     */
    collectCodexOutputItemDone(eventData, outputItemsByIndex, outputItemsFallback) {
        if (!eventData.item) {
            return;
        }
        if (eventData.output_index !== undefined) {
            outputItemsByIndex.set(eventData.output_index, eventData.item);
        } else {
            outputItemsFallback.push(eventData.item);
        }
    }

    /**
     * 修正 Codex 完成输出
     */
    patchCodexCompletedOutput(eventData, outputItemsByIndex, outputItemsFallback) {
        const response = eventData.response || {};
        const output = response.output;

        const shouldPatch = (!output || !Array.isArray(output) || output.length === 0) &&
            (outputItemsByIndex.size > 0 || outputItemsFallback.length > 0);

        if (!shouldPatch) {
            return eventData;
        }

        const items = [];
        // 按索引排序
        const sortedIndexes = Array.from(outputItemsByIndex.keys()).sort((a, b) => a - b);
        for (const idx of sortedIndexes) {
            items.push(outputItemsByIndex.get(idx));
        }
        // 添加 fallback 项
        items.push(...outputItemsFallback);

        if (!eventData.response) {
            eventData.response = {};
        }
        eventData.response.output = items;

        return eventData;
    }

    /**
     * 解析 SSE 流
     */
    async* parseSSEStream(stream) {
        let buffer = '';
        const outputItemsByIndex = new Map();
        const outputItemsFallback = [];

        for await (const chunk of stream) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 保留不完整的行

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine) continue;
                const dataStr = extractSSEData(trimmedLine);

                if (dataStr && dataStr !== '[DONE]') {
                    try {
                        let parsed = JSON.parse(dataStr);

                        const terminalError = createCodexTerminalError(parsed);
                        if (terminalError) {
                            logger.error('[Codex] API returned terminal error in stream:', parsed.error || parsed.response?.error || parsed);
                            throw terminalError;
                        }

                        if (parsed.type === 'response.output_item.done') {
                            this.collectCodexOutputItemDone(parsed, outputItemsByIndex, outputItemsFallback);
                        } else if (parsed.type === 'response.completed') {
                            parsed = this.patchCodexCompletedOutput(parsed, outputItemsByIndex, outputItemsFallback);
                        }

                        yield parsed;
                    } catch (e) {
                        if (e.message.startsWith('Codex API error')) {
                            throw e;
                        }
                        logger.error('[Codex] Failed to parse SSE data:', e.message);
                    }
                }
            }
        }

        // 处理剩余的 buffer
        const finalTrimmed = buffer.trim();
        if (finalTrimmed) {
            const dataStr = extractSSEData(finalTrimmed);

            if (dataStr && dataStr !== '[DONE]') {
                try {
                    let parsed = JSON.parse(dataStr);

                    const terminalError = createCodexTerminalError(parsed);
                    if (terminalError) {
                        logger.error('[Codex] API returned terminal error in final stream buffer:', parsed.error || parsed.response?.error || parsed);
                        throw terminalError;
                    }

                    if (parsed.type === 'response.output_item.done') {
                        this.collectCodexOutputItemDone(parsed, outputItemsByIndex, outputItemsFallback);
                    } else if (parsed.type === 'response.completed') {
                        parsed = this.patchCodexCompletedOutput(parsed, outputItemsByIndex, outputItemsFallback);
                    }

                    yield parsed;
                } catch (e) {
                    if (e.message.startsWith('Codex API error')) {
                        throw e;
                    }
                    logger.error('[Codex] Failed to parse final SSE data:', e.message);
                }
            }
        }
    }

    /**
     * 解析非流式响应
     */
    parseNonStreamResponse(data) {
        // 确保 data 是字符串
        const responseText = typeof data === 'string' ? data : String(data);

        // 从 SSE 流中提取所有事件，累积 output
        const lines = responseText.split('\n');
        const outputItems = new Map(); // id -> output item
        const textDeltas = new Map(); // item_id -> accumulated text

        const outputItemsByIndex = new Map();
        const outputItemsFallback = [];

        let completedEvent = null;

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            const jsonData = extractSSEData(trimmedLine);

            if (!jsonData || jsonData === '[DONE]') {
                continue;
            }

            try {
                let parsed = JSON.parse(jsonData);
                switch (parsed.type) {
                    case 'error':
                    case 'response.failed': {
                        logger.error('[Codex] API returned terminal error:', parsed.error || parsed.response?.error || parsed);
                        const error = createCodexTerminalError(parsed);
                        if (error) throw error;
                        break;
                    }
                    case 'response.output_item.added':
                        if (parsed.item) {
                            outputItems.set(parsed.item.id, parsed.item);
                        }
                        break;
                    case 'response.output_item.done':
                        this.collectCodexOutputItemDone(parsed, outputItemsByIndex, outputItemsFallback);
                        break;
                    case 'response.output_text.delta':
                        if (parsed.item_id && parsed.delta) {
                            const existing = textDeltas.get(parsed.item_id) || '';
                            textDeltas.set(parsed.item_id, existing + parsed.delta);
                        }
                        break;
                    case 'response.output_text.done':
                        if (parsed.item_id && parsed.text) {
                            textDeltas.set(parsed.item_id, parsed.text);
                        }
                        break;
                    case 'response.completed':
                        completedEvent = this.patchCodexCompletedOutput(parsed, outputItemsByIndex, outputItemsFallback);
                        break;
                }
            } catch (e) {
                if (e.message.startsWith('Codex API error')) {
                    throw e;
                }
                // 继续解析下一行
                logger.debug('[Codex] Failed to parse SSE line:', e.message);
            }
        }

        if (!completedEvent) {
            // 如果我们已经收集到了一些输出项或文本，尝试合成一个完成事件
            if (outputItems.size > 0 || textDeltas.size > 0 || outputItemsByIndex.size > 0 || outputItemsFallback.length > 0) {
                logger.warn('[Codex] No completed response found, but some output items were received. Synthesizing response.');

                // 构造一个模拟的 completed 事件
                completedEvent = {
                    type: 'response.completed',
                    response: {
                        id: 'synth_' + Date.now(),
                        status: 'completed',
                        object: 'response',
                        model: 'unknown',
                        output: []
                    }
                };

                // 使用 patchCodexCompletedOutput 填充输出
                completedEvent = this.patchCodexCompletedOutput(completedEvent, outputItemsByIndex, outputItemsFallback);

                // 如果 patch 后还是没输出，尝试直接从 outputItems 填充
                if (completedEvent.response.output.length === 0 && outputItems.size > 0) {
                    completedEvent.response.output = Array.from(outputItems.values());
                }
            } else {
                logger.error('[Codex] No completed response found in Codex response');
                // 记录前 1000 个字符用于调试
                const debugInfo = responseText.length > 1000 ? responseText.slice(0, 1000) + '...' : responseText;
                logger.debug('[Codex] Raw response data:', debugInfo);

                throw new Error('stream error: stream disconnected before completion: stream closed before response.completed');
            }
        }

        // 用累积的 delta 文本 & output_item.done 数据填充 output items 中缺失的内容
        if (completedEvent.response) {
            const output = completedEvent.response.output || [];

            for (const item of output) {
                if (item.type === 'message' && item.role === 'assistant') {
                    const accumulatedText = textDeltas.get(item.id);
                    if (accumulatedText !== undefined) {
                        if (!item.content || item.content.length === 0) {
                            item.content = [{type: 'output_text', text: accumulatedText}];
                        } else {
                            item.content = item.content.map(c => {
                                if (c.type === 'output_text' && !c.text) {
                                    return {...c, text: accumulatedText};
                                }
                                return c;
                            });
                        }
                    }
                }
            }

            // 如果 output 完全为空，从累积事件重建
            if (output.length === 0 && outputItems.size > 0) {
                for (const [id, item] of outputItems) {
                    const accumulatedText = textDeltas.get(id);
                    if (accumulatedText !== undefined && item.type === 'message') {
                        item.content = [{type: 'output_text', text: accumulatedText}];
                    }
                    output.push(item);
                }
                completedEvent.response.output = output;
            }
        }

        return completedEvent;
    }

    /**
     * 列出可用模型
     */
    async listModels() {
        return {
            object: 'list',
            data: CODEX_MODELS.map(id => ({
                id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'openai'
            }))
        };
    }

    /**
     * 启动缓存清理
     */
    startCacheCleanup() {
        // 每 15 分钟清理过期缓存
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [key, cache] of this.conversationCache.entries()) {
                if (cache.expire < now) {
                    this.conversationCache.delete(key);
                }
            }
        }, 15 * 60 * 1000);
    }

    /**
     * 停止缓存清理
     */
    stopCacheCleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    buildUsageHeaders() {
        return {
            'user-agent': `codex-tui/${CODEX_VERSION} (Windows 10.0.26100; x86_64) WindowsTerminal (codex-tui; ${CODEX_VERSION})`,
            'authorization': `Bearer ${this.accessToken}`,
            'chatgpt-account-id': this.accountId,
            'accept': '*/*',
            'host': 'chatgpt.com',
            'Connection': 'close'
        };
    }

    async requestCodexUsageJson(url, headers) {
        const axiosRequestConfig = {
            method: 'get',
            url,
            headers,
            timeout: 30000
        };
        this._applySidecar(axiosRequestConfig);

        const response = await axios.request(axiosRequestConfig);
        return response.data;
    }

    async postCodexUsageJson(url, headers, data) {
        const axiosRequestConfig = {
            method: 'post',
            url,
            headers: {
                ...headers,
                'content-type': 'application/json'
            },
            data,
            timeout: 30000
        };
        this._applySidecar(axiosRequestConfig);

        const response = await axios.request(axiosRequestConfig);
        return response.data;
    }

    /**
     * 获取使用限制信息（返回 API 原始数据）
     * @returns {Promise<Object>} 原始响应数据
     */
    async getUsageLimits() {
        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            const url = 'https://chatgpt.com/backend-api/wham/usage';
            const profileUrl = 'https://chatgpt.com/backend-api/wham/profiles/me';
            const resetCreditsUrl = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
            const headers = this.buildUsageHeaders();
            const usageData = await this.requestCodexUsageJson(url, headers);

            let tokenUsageProfile = null;
            try {
                tokenUsageProfile = await this.requestCodexUsageJson(profileUrl, headers);
            } catch (profileError) {
                if (profileError.response?.status === 401) {
                    throw profileError;
                }
                logger.warn('[Codex] Failed to get token usage profile:', profileError.message);
            }

            let rateLimitResetCredits = usageData.rate_limit_reset_credits || usageData.rateLimitResetCredits || null;
            let rateLimitResetCreditsError = null;
            try {
                rateLimitResetCredits = await this.requestCodexUsageJson(resetCreditsUrl, headers);
            } catch (resetCreditsError) {
                if (resetCreditsError.response?.status === 401) {
                    throw resetCreditsError;
                }
                logger.warn('[Codex] Failed to get rate limit reset credit details:', resetCreditsError.message);
                rateLimitResetCreditsError = {
                    status: resetCreditsError.response?.status || null,
                    message: resetCreditsError.message
                };
            }

            return {
                ...usageData,
                token_usage_profile: tokenUsageProfile,
                rate_limit_reset_credits: rateLimitResetCredits,
                rate_limit_reset_credits_error: rateLimitResetCreditsError,
                account: this.email
            };
        } catch (error) {
            if (error.response?.status === 401) {
                logger.info('[Codex] Received 401 during getUsageLimits. Triggering background refresh...');
                this.triggerBackgroundRefresh();
                error.credentialMarkedUnhealthy = true;
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
            }

            logger.error('[Codex] Failed to get usage limits:', error.message);
            throw error;
        }
    }

    /**
     * 消耗一次 Codex 额度重置次数
     * @returns {Promise<Object>} 重置结果
     */
    async consumeRateLimitResetCredit(redeemRequestId = null) {
        if (!this.isInitialized) {
            await this.initialize();
        }

        const requestId = redeemRequestId || crypto.randomUUID();

        try {
            const url = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume';
            const headers = this.buildUsageHeaders();
            return await this.postCodexUsageJson(url, headers, {
                redeem_request_id: requestId
            });
        } catch (error) {
            if (error.response?.status === 401) {
                logger.info('[Codex] Received 401 during consumeRateLimitResetCredit. Triggering background refresh...');
                this.triggerBackgroundRefresh();
                error.credentialMarkedUnhealthy = true;
                error.shouldSwitchCredential = true;
                error.skipErrorCount = true;
            }

            logger.error('[Codex] Failed to consume rate limit reset credit:', error.message);
            throw error;
        }
    }

    /**
     * 兼容上游重置接口：消耗一次重置次数后返回最新用量。
     * @returns {Promise<Object>} 重置结果与最新用量
     */
    async resetUsageQuota() {
        const resetResult = await this.consumeRateLimitResetCredit();
        const latestUsage = await this.getUsageLimits();

        return {
            success: true,
            resetResult,
            usage: latestUsage,
            account: this.email
        };
    }
}

