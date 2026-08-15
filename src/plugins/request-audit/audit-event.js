import crypto from 'crypto';
import { normalizeUsageCandidate } from '../../utils/usage-normalizer.js';

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

function normalizeResponse(context = {}) {
    const source = context.response || {};
    const rawStatus = source.httpStatus ?? context.httpStatus;
    const httpStatus = Number.isInteger(Number(rawStatus)) ? Number(rawStatus) : null;
    const rawImageResult = source.hasImageResult ?? context.hasImageResult;
    return {
        httpStatus,
        bytes: Math.max(0, toNumber(source.bytes ?? context.responseBytes)),
        completed: source.completed === true,
        clientAborted: source.clientAborted === true,
        hasImageResult: typeof rawImageResult === 'boolean' ? rawImageResult : null
    };
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

export function buildRequestAuditEvent(context = {}) {
    const timestamp = context.timestamp || new Date().toISOString();
    const date = new Date(timestamp);
    const beijing = getBeijingParts(date);
    const usage = normalizeUsage(context.usage);
    const actualModel = context.model || context.processedRequestBody?.model || context.originalRequestBody?.model || 'unknown';
    const requestedModel = context.originalRequestBody?.model || actualModel;
    const cacheAffinityScope = context._codexCacheAffinityScope || {};
    const response = normalizeResponse(context);
    const derivedStatus = deriveStatus(context, response);
    const selectedProviderUuid = context._codexRouting?.selectedProviderUuid || null;
    const actualProviderUuid = context.providerUuid || null;
    const consistencyStatus = selectedProviderUuid && actualProviderUuid
        ? selectedProviderUuid === actualProviderUuid ? 'consistent' : 'mismatch'
        : 'unverifiable';

    return {
        schemaVersion: 4,
        timestamp,
        beijingDate: beijing.date,
        beijingHour: beijing.hour,
        requestId: context.requestId || context._monitorRequestId || null,
        prompt_cache_key_hash: hashSecret(cacheAffinityScope.promptCacheKey, 32),
        thread_id_hash: hashSecret(cacheAffinityScope.threadId, 32),
        session_id_hash: hashSecret(cacheAffinityScope.sessionId, 32),
        request: {
            method: context.method || 'POST',
            path: sanitizePath(context.path || context.requestPath),
            normalizedPath: sanitizePath(context.normalizedPath),
            fromProvider: context.fromProvider || null,
            toProvider: context.toProvider || context.provider || null,
            model: actualModel,
            requestedModel,
            actualModel,
            stream: Boolean(context.isStream)
        },
        network: {
            clientIp: context.clientIp || null,
            peerIp: context.peerIp || null,
            clientIpSource: context.clientIpSource || null
        },
        potluckKey: {
            ...maskPotluckKey(context.potluckApiKey),
            name: context.potluckKeyData?.name || null
        },
        account: {
            providerUuidHash: hashSecret(context.providerUuid),
            accountEmail: extractAccountEmail(context.accountEmail, context.accountIdentity, context.providerName),
            providerNameHash: hashSecret(context.providerName),
            providerNameDisplay: sanitizeProviderName(context.providerName)
        },
        routing: {
            routingMode: ['pool', 'auto', 'fixed'].includes(context._codexRouting?.routingMode)
                ? context._codexRouting.routingMode
                : null,
            requestedPrimaryGroupId: context._codexRouting?.requestedPrimaryGroupId || null,
            selectedGroupId: context._codexRouting?.selectedGroupId || null,
            selectedProviderUuidHash: hashSecret(selectedProviderUuid),
            consistencyStatus,
            actualProviderGroupId: context._codexRouting?.actualProviderGroupId || null,
            providerSwitchCount: toNumber(context._codexRouting?.providerSwitchCount),
            modelFallbackFrom: context._codexRouting?.modelFallbackFrom || null,
            modelFallbackTo: context._codexRouting?.modelFallbackTo || null,
            modelFallbackReason: context._codexRouting?.modelFallbackReason || null,
            spillover: context._codexRouting?.spillover === true,
            spilloverReason: context._codexRouting?.spilloverReason || null,
            assignmentMissing: context._codexRouting?.assignmentMissing === true,
            affinitySource: context._codexRouting?.affinitySource || null,
            hotShardApplied: context._codexRouting?.hotShardApplied === true
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
        status: {
            ...derivedStatus,
            retryCount: toNumber(context.retryCount),
            cooldownApplied: Boolean(context.cooldownApplied)
        },
        response,
        usage
    };
}
