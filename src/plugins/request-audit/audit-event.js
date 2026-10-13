import crypto from 'crypto';
import { normalizeUsageCandidate } from '../../utils/usage-normalizer.js';
import { compactAntigravitySourceAvailability } from '../../utils/gemini-diagnostics.js';
import { getRequestAttempts } from '../../utils/request-attempts.js';
import { CODEX_FINGERPRINT_CONTEXT_KEY } from '../../providers/openai/codex-fingerprint.js';
import { estimateUsageCost } from '../api-potluck/cost-estimator.js';
import { captureStatus } from './capture-status.js';

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

export function hashSecret(value, length = 16) {
    if (!value) return null;
    return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length)}`;
}

export function maskPotluckKey(key) {
    if (!key) {
        return { present: false, hash: null, prefix: null };
    }
    const text = String(key);
    return {
        present: true,
        hash: hashSecret(text),
        prefix: `${text.slice(0, 11)}...`
    };
}

export function sanitizeProviderName(name) {
    if (!name) return null;
    const text = String(name);
    const email = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    if (email) {
        return `redacted-email:${crypto.createHash('sha256').update(email[0].toLowerCase()).digest('hex').slice(0, 8)}`;
    }
    if (text.length <= 24 && !/[A-Za-z0-9._~+/=-]{32,}/.test(text)) {
        return text;
    }
    return `redacted-name:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 8)}`;
}

export function extractAccountEmail(...candidates) {
    for (const candidate of candidates) {
        if (!candidate) continue;
        const email = String(candidate).match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
        if (email) return email[0].toLowerCase();
    }
    return null;
}

export function normalizeUsage(usage = {}) {
    const normalized = normalizeUsageCandidate(usage) || {};
    const promptTokens = toNumber(normalized.promptTokens);
    const cachedTokens = toNumber(normalized.cachedTokens);
    const reasoningTokens = toNumber(normalized.reasoningTokens);
    const completionTokens = toNumber(normalized.completionTokens);
    const totalTokens = toNumber(normalized.totalTokens) || promptTokens + completionTokens;
    return {
        promptTokens,
        cachedTokens,
        completionTokens,
        reasoningTokens,
        totalTokens,
        cacheHitRatio: promptTokens > 0 ? cachedTokens / promptTokens : 0
    };
}

function getBeijingParts(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false
    }).formatToParts(date);
    const value = type => parts.find(part => part.type === type)?.value;
    return {
        date: `${value('year')}-${value('month')}-${value('day')}`,
        hour: value('hour') || '00'
    };
}

function sanitizePath(value) {
    if (!value) return null;
    return String(value).split('?')[0] || null;
}

function sanitizeDiagnosticCode(value) {
    if (value === undefined || value === null || value === '') return null;
    const text = String(value);
    return text.length <= 128 ? text : text.slice(0, 128);
}

function sanitizeDiagnosticMessage(value) {
    if (value === undefined || value === null || value === '') return { value: null, truncated: false };
    const sanitized = String(value);
    const encoded = Buffer.from(sanitized, 'utf8');
    if (encoded.length <= 2048) return { value: sanitized, truncated: false };
    return {
        value: encoded.subarray(0, 2048).toString('utf8').replace(/\uFFFD$/u, ''),
        truncated: true
    };
}

function normalizeFailure(context = {}) {
    const source = context.failure;
    if (!source || typeof source !== 'object') return null;
    const message = sanitizeDiagnosticMessage(source.message);
    return {
        source: source.source === 'internal' ? 'internal' : 'upstream',
        upstreamHttpStatus: Number.isFinite(Number(source.upstreamHttpStatus)) ? Number(source.upstreamHttpStatus) : null,
        code: sanitizeDiagnosticCode(source.code),
        type: sanitizeDiagnosticCode(source.type),
        message: message.value,
        requestId: sanitizeDiagnosticCode(source.requestId),
        truncated: source.truncated === true || message.truncated
    };
}

function normalizeResponse(context = {}) {
    const source = context.response || {};
    const rawStatus = source.httpStatus ?? context.httpStatus;
    const httpStatus = Number.isInteger(Number(rawStatus)) ? Number(rawStatus) : null;
    const rawImageResult = source.hasImageResult ?? context.hasImageResult;
    const durationMs = normalizeDurationMs(source.durationMs, context.durationMs, context.runtime?.durationMs);
    const errorCode = sanitizeDiagnosticCode(source.errorCode ?? context.errorCode);
    return {
        httpStatus,
        bytes: Math.max(0, toNumber(source.bytes ?? context.responseBytes)),
        completed: source.completed === true,
        clientAborted: source.clientAborted === true,
        hasImageResult: typeof rawImageResult === 'boolean' ? rawImageResult : null,
        durationMs,
        errorCode
    };
}

function normalizeDurationMs(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate !== 'number' && typeof candidate !== 'string') continue;
        if (typeof candidate === 'string' && candidate.trim() === '') continue;
        const durationMs = Number(candidate);
        if (Number.isFinite(durationMs) && durationMs >= 0) return durationMs;
    }
    return null;
}

function normalizeRuntime(runtime = {}) {
    if (!runtime || typeof runtime !== 'object') return undefined;
    const stages = runtime.stages && typeof runtime.stages === 'object'
        ? Object.fromEntries(Object.entries(runtime.stages)
            .map(([name, value]) => [name, Number(value)])
            .filter(([, value]) => Number.isFinite(value) && value >= 0))
        : {};
    const workerId = typeof runtime.workerId === 'string' && runtime.workerId.length <= 128 ? runtime.workerId : null;
    const requestKind = runtime.kind === 'image' || runtime.kind === 'model' ? runtime.kind : null;
    const outputBytes = Number.isFinite(Number(runtime.outputBytes)) && Number(runtime.outputBytes) >= 0 ? Number(runtime.outputBytes) : null;
    const backpressureMs = Number.isFinite(Number(runtime.backpressureMs)) && Number(runtime.backpressureMs) >= 0 ? Number(runtime.backpressureMs) : null;
    if (!workerId && !requestKind && outputBytes === null && backpressureMs === null && !Object.keys(stages).length) return undefined;
    return { workerId, requestKind, outputBytes, backpressureMs, stages };
}

function normalizeAttempts(context = {}) {
    const source = Array.isArray(context.requestAttempts)
        ? context.requestAttempts
        : getRequestAttempts(context.processedRequestBody);
    return source.slice(0, 50).map((attempt, index) => {
        const errorMessage = sanitizeDiagnosticMessage(attempt.errorMessage);
        return {
            attemptId: String(attempt.attemptId || `${context.requestId || 'request'}:${index + 1}`),
            sequence: index + 1,
            startedAt: attempt.startedAt || null,
            completedAt: attempt.completedAt || null,
            durationMs: Number.isFinite(Number(attempt.durationMs)) ? Number(attempt.durationMs) : null,
            providerType: attempt.providerType || null,
            providerUuidHash: hashSecret(attempt.providerUuid),
            plannedModel: attempt.plannedModel || null,
            outboundModel: attempt.outboundModel || null,
            modelOverrideApplied: attempt.modelOverrideApplied === true,
            upstreamResponseModel: attempt.upstreamResponseModel || null,
            reasoningEffort: attempt.reasoningEffort || null,
            serviceTier: attempt.serviceTier || null,
            // [turn-state-disabled 2026-09-23] turnStateEnabled: attempt.turnStateEnabled === true,
            // turnStateSource: attempt.turnStateSource || null,
            // turnStateRequestLength: toNumber(attempt.turnStateRequestLength),
            // turnStateSkipReason: attempt.turnStateSkipReason || null,
            stream: attempt.stream === true,
            status: attempt.status || 'unknown',
            httpStatus: Number.isFinite(Number(attempt.httpStatus)) ? Number(attempt.httpStatus) : null,
            errorCode: sanitizeDiagnosticCode(attempt.errorCode),
            errorType: sanitizeDiagnosticCode(attempt.errorType),
            errorMessage: errorMessage.value,
            upstreamRequestId: sanitizeDiagnosticCode(attempt.upstreamRequestId),
            errorTruncated: attempt.errorTruncated === true || errorMessage.truncated
        };
    });
}

function deriveStatus(context, response) {
    if (context.outcome) {
        return {
            outcome: context.outcome,
            httpStatus: response.httpStatus,
            errorClass: context.errorClass || null
        };
    }
    if (response.clientAborted) {
        return { outcome: 'client_aborted', httpStatus: response.httpStatus, errorClass: context.errorClass || 'client_aborted' };
    }
    if (response.httpStatus !== null && (response.httpStatus < 200 || response.httpStatus >= 300)) {
        return { outcome: 'http_error', httpStatus: response.httpStatus, errorClass: context.errorClass || `http_${response.httpStatus}` };
    }
    if (response.hasImageResult === false) {
        return { outcome: 'semantic_failure', httpStatus: response.httpStatus, errorClass: context.errorClass || 'missing_image_generation_result' };
    }
    if (response.completed && response.httpStatus !== null) {
        return { outcome: 'success', httpStatus: response.httpStatus, errorClass: context.errorClass || null };
    }
    return { outcome: 'http_error', httpStatus: response.httpStatus, errorClass: context.errorClass || 'incomplete_response' };
}

/**
 * 失败请求也要保留凭据归属：已使用 > 最后一次尝试 > 仅路由选中（未发出）> 选凭据前失败。
 */
export function resolveAuditAccountCandidate(context = {}) {
    if (context.providerUuid) return { uuid: context.providerUuid, attribution: 'used' };
    const attempts = Array.isArray(context.requestAttempts) ? context.requestAttempts : getRequestAttempts(context.processedRequestBody);
    const attemptUuid = [...attempts].reverse().find(attempt => attempt?.providerUuid)?.providerUuid;
    if (attemptUuid) return { uuid: attemptUuid, attribution: 'used' };
    const selectedUuid = context._codexRouting?.selectedProviderUuid;
    if (selectedUuid) return { uuid: selectedUuid, attribution: 'selected-not-sent' };
    return { uuid: null, attribution: 'none-before-selection' };
}

export function buildRequestAuditEvent(context = {}) {
    const timestamp = context.timestamp || new Date().toISOString();
    const date = new Date(timestamp);
    const beijing = getBeijingParts(date);
    const usage = normalizeUsage(context.usage);
    const actualModel = context.model || context.processedRequestBody?.model || context.originalRequestBody?.model || 'unknown';
    const requestedModel = context.originalRequestBody?.model || actualModel;
    const cacheAffinityScope = context._codexCacheAffinityScope || {};
    const cacheAffinityHashes = context._codexCacheAffinityHashes || {};
    const response = normalizeResponse(context);
    const failure = normalizeFailure(context);
    const runtime = normalizeRuntime(context.runtime);
    const derivedStatus = deriveStatus(context, response);
    const selectedProviderUuid = context._codexRouting?.selectedProviderUuid || null;
    const modelRouting = context._modelRouting || context._codexRouting || {};
    const sourceAvailability = compactAntigravitySourceAvailability(modelRouting.sourceAvailability);
    const actualProviderUuid = context.providerUuid || null;
    const consistencyStatus = selectedProviderUuid && actualProviderUuid
        ? selectedProviderUuid === actualProviderUuid ? 'consistent' : 'mismatch'
        : 'unverifiable';
    const routing = context._codexRouting || {};
    const accountCandidate = resolveAuditAccountCandidate(context);
    // selectedAccount 由调用方按 accountCandidate.uuid 解析；uuid 不一致时不采用，避免串号。
    const resolvedAccount = context.selectedAccount?.providerUuid === accountCandidate.uuid ? context.selectedAccount : {};
    const attempts = normalizeAttempts(context);
    const lastAttempt = attempts.at(-1) || null;
    const codexContext = context.processedRequestBody?.[CODEX_FINGERPRINT_CONTEXT_KEY] || {};
    const upstreamResponseModel = context.codexEvidence?.upstreamResponseModel
        || codexContext.upstreamResponseModel
        || lastAttempt?.upstreamResponseModel
        || null;
    const plannedModel = context._modelRouting?.actualModel
        || context._temporaryKeyModelRouteResult?.targetModel
        || requestedModel;
    const outboundModel = lastAttempt?.outboundModel || actualModel;
    const billingModel = lastAttempt?.modelOverrideApplied
        ? upstreamResponseModel || outboundModel
        : actualModel;
    const estimatedCost = estimateUsageCost(usage, billingModel, { trackDiagnostics: false });
    const hasExtendedRouting = [
        'spilloverCause', 'groupWaitMs', 'groupRetryCount', 'fallbackAttemptCount',
        'availabilityReason', 'candidateGroupId', 'candidateProviderCount', 'unavailableProviderCount'
    ].some(field => Object.prototype.hasOwnProperty.call(routing, field));

    const event = {
        schemaVersion: 7,
        eventId: context._runtimeEventId || context.eventId || null,
        timestamp,
        beijingDate: beijing.date,
        beijingHour: beijing.hour,
        requestId: context.requestId || context._monitorRequestId || null,
        prompt_cache_key_hash: cacheAffinityHashes.promptCacheKeyHash || hashSecret(cacheAffinityScope.promptCacheKey, 32),
        thread_id_hash: cacheAffinityHashes.threadIdHash || hashSecret(cacheAffinityScope.threadId, 32),
        session_id_hash: cacheAffinityHashes.sessionIdHash || hashSecret(cacheAffinityScope.sessionId, 32),
        request: {
            method: context.method || 'POST',
            path: sanitizePath(context.path || context.requestPath),
            normalizedPath: sanitizePath(context.normalizedPath),
            fromProvider: context.fromProvider || null,
            toProvider: context.toProvider || context.provider || null,
            model: actualModel,
            requestedModel,
            actualModel,
            plannedModel,
            outboundModel,
            upstreamResponseModel,
            modelMismatch: Boolean(upstreamResponseModel && outboundModel && upstreamResponseModel !== outboundModel),
            billingModel,
            stream: Boolean(context.isStream)
        },
        network: {
            clientIp: context.clientIp || null,
            peerIp: context.peerIp || null,
            clientIpSource: context.clientIpSource || null
        },
        potluckKey: {
            ...(context.potluckApiKey
                ? maskPotluckKey(context.potluckApiKey)
                : {
                    present: Boolean(context.potluckKeyHash),
                    hash: context.potluckKeyHash || null,
                    prefix: null
                }),
            name: context.potluckKeyData?.name || null
        },
        account: {
            providerUuidHash: hashSecret(accountCandidate.attribution === 'used' ? accountCandidate.uuid : null),
            accountEmail: extractAccountEmail(context.accountEmail, context.accountIdentity, context.providerName, resolvedAccount.accountEmail, resolvedAccount.providerName),
            providerNameHash: hashSecret(context.providerName || resolvedAccount.providerName),
            providerNameDisplay: sanitizeProviderName(context.providerName || resolvedAccount.providerName),
            attribution: accountCandidate.attribution
        },
        routing: {
            routingMode: ['pool', 'auto', 'fixed', 'restricted'].includes(context._codexRouting?.routingMode)
                ? context._codexRouting.routingMode
                : null,
            requestedPrimaryGroupId: context._codexRouting?.requestedPrimaryGroupId || null,
            selectedGroupId: context._codexRouting?.selectedGroupId || null,
            selectedProviderUuidHash: hashSecret(selectedProviderUuid),
            consistencyStatus,
            actualProviderGroupId: context._codexRouting?.actualProviderGroupId || null,
            providerSwitchCount: toNumber(context._codexRouting?.providerSwitchCount),
            modelFallbackFrom: modelRouting.modelFallbackFrom || null,
            modelFallbackTo: modelRouting.modelFallbackTo || null,
            modelFallbackReason: modelRouting.modelFallbackReason || null,
            ...(context._modelRouting ? {
                queueWaitMs: toNumber(modelRouting.queueWaitMs),
                fallbackAttemptCount: toNumber(modelRouting.fallbackAttemptCount),
                queueOutcome: modelRouting.queueOutcome || null,
                ...(sourceAvailability ? { sourceAvailability } : {})
            } : {}),
            spillover: context._codexRouting?.spillover === true,
            spilloverReason: context._codexRouting?.spilloverReason || null,
            assignmentMissing: context._codexRouting?.assignmentMissing === true,
            affinitySource: context._codexRouting?.affinitySource || null,
            hotShardApplied: context._codexRouting?.hotShardApplied === true,
            keyQueueWaitMs: toNumber(context._codexRouting?.keyQueueWaitMs),
            keyQueueOutcome: context._codexRouting?.keyQueueOutcome || null,
            keyCapacityExhausted: context._codexRouting?.keyCapacityExhausted === true,
            ...(hasExtendedRouting ? {
                spilloverCause: context._codexRouting?.spilloverCause || null,
                groupWaitMs: toNumber(context._codexRouting?.groupWaitMs),
                groupRetryCount: toNumber(context._codexRouting?.groupRetryCount),
                fallbackAttemptCount: toNumber(context._codexRouting?.fallbackAttemptCount),
                availabilityReason: context._codexRouting?.availabilityReason || null,
                candidateGroupId: context._codexRouting?.candidateGroupId || null,
                candidateProviderCount: toNumber(context._codexRouting?.candidateProviderCount),
                unavailableProviderCount: toNumber(context._codexRouting?.unavailableProviderCount)
            } : {}),
            ...(context._temporaryKeyModelRouteResult ? {
                temporaryModelRoute: {
                    id: context._temporaryKeyModelRouteResult.id || null,
                    targetProviderType: context._temporaryKeyModelRouteResult.targetProviderType || null,
                    targetModel: context._temporaryKeyModelRouteResult.targetModel || null,
                    actualProviderType: context._temporaryKeyModelRouteResult.actualProviderType || null,
                    actualModel: context._temporaryKeyModelRouteResult.actualModel || null,
                    credentialRetryUsed: context._temporaryKeyModelRouteResult.credentialRetryUsed === true,
                    fallbackUsed: context._temporaryKeyModelRouteResult.fallbackUsed === true,
                    fallbackReason: context._temporaryKeyModelRouteResult.fallbackReason || null,
                    targetAttempted: context._temporaryKeyModelRouteResult.targetAttempted !== false
                }
            } : {})
        },
        cache: {
            clientPromptCacheKeyHash: context.cache?.clientPromptCacheKeyHash || null,
            finalPromptCacheKeyHash: context.cache?.finalPromptCacheKeyHash || null,
            keySource: ['client_explicit', 'shared_session', 'shared_template', 'local_fallback'].includes(context.cache?.keySource)
                ? context.cache.keySource
                : null,
            coordinationStatus: ['shared', 'degraded'].includes(context.cache?.coordinationStatus)
                ? context.cache.coordinationStatus
                : null,
            templateFingerprint: context.cache?.templateFingerprint || null,
            originalPrefixHashes: Array.isArray(context.cache?.originalPrefixHashes) ? context.cache.originalPrefixHashes : [],
            upstreamPrefixHashes: Array.isArray(context.cache?.upstreamPrefixHashes) ? context.cache.upstreamPrefixHashes : [],
            instructionsHash: context.cache?.instructionsHash || null,
            toolsHash: context.cache?.toolsHash || null,
            metadataHash: context.cache?.metadataHash || null,
            workerId: context.cache?.workerId || null
        },
        // [turn-state-disabled 2026-09-23] 审计事件中的 turnState 投影停用（缓存复用已下线）：
        // turnState: {
        //     enabled: lastAttempt?.turnStateEnabled === true,
        //     source: lastAttempt?.turnStateSource || null,
        //     requestLength: toNumber(lastAttempt?.turnStateRequestLength),
        //     responseLength: toNumber(
        //         context.codexEvidence?.turnStateResponseLength
        //         || (codexContext.downstreamCodexTurnState ? Buffer.byteLength(codexContext.downstreamCodexTurnState, 'utf8') : 0)
        //         || context.runtime?.metadata?.codexTurnStateResponseLength
        //     ),
        //     skipReason: lastAttempt?.turnStateSkipReason || null,
        //     cacheOutcome: context.codexEvidence?.turnStateCacheOutcome || codexContext.turnStateCacheOutcome || null,
        //     captured: context.codexEvidence?.turnStateCacheCaptured === true || codexContext.turnStateCacheCaptured === true
        // },
        parameters: {
            requestedReasoningEffort: context.originalRequestBody?.reasoning?.effort || context.originalRequestBody?.reasoning_effort || null,
            effectiveReasoningEffort: lastAttempt?.reasoningEffort || null,
            requestedServiceTier: context.originalRequestBody?.service_tier || null,
            effectiveServiceTier: lastAttempt?.serviceTier || null
        },
        cost: {
            usd: toNumber(estimatedCost.usd),
            actualUsd: toNumber(estimatedCost.actualUsd),
            estimatedUsd: toNumber(estimatedCost.estimatedUsd),
            estimatedPriceTokens: toNumber(estimatedCost.estimatedPriceTokens),
            missingPriceTokens: toNumber(estimatedCost.missingPriceTokens),
            pricingVersion: estimatedCost.pricingVersion || null,
            pricingSource: estimatedCost.pricingSource || null,
            priceMultiplier: Number.isFinite(Number(estimatedCost.priceMultiplier)) ? Number(estimatedCost.priceMultiplier) : 1
        },
        attempts,
        status: {
            ...derivedStatus,
            retryCount: toNumber(context.retryCount),
            cooldownApplied: Boolean(context.cooldownApplied)
        },
        ...(failure ? { failure } : {}),
        response,
        ...(runtime ? { runtime } : {}),
        usage
    };
    event.capture = captureStatus(event);
    return event;
}
