import crypto from 'node:crypto';

export function hashDiagnosticIdentifier(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

export function classifyProviderInitializationError(error = {}) {
    const status = Number(error?.response?.status || error?.status || error?.code);
    if (status === 401 || status === 403) return 'auth_error';
    if (status === 429 || /quota|capacity|rate.?limit|resource.?exhausted/i.test(String(error?.message || ''))) {
        return 'quota_exhausted';
    }
    if (/ECONN|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|network|socket|timeout/i.test(String(error?.code || error?.message || ''))) {
        return 'network_error';
    }
    if (status >= 500) return 'upstream_error';
    return 'unknown';
}

function sanitizeFilterReasons(reasons = {}) {
    return Object.fromEntries(Object.entries(reasons || {})
        .filter(([key, value]) => /^[a-z0-9_]+$/.test(key) && Number.isFinite(Number(value)))
        .map(([key, value]) => [key, Math.max(0, Number(value))]));
}

export function buildGeminiSelectionDiagnostic({
    workerId = 'standalone',
    providerType = 'gemini-antigravity',
    requestedModel = null,
    selectionDiagnostics = {},
    selectedProvider = null,
    durationMs = 0
} = {}) {
    const providerConfig = selectedProvider?.config || selectedProvider || {};
    const uuid = providerConfig.uuid || selectedProvider?.uuid || null;
    const proxyPool = providerConfig.proxyPool || providerConfig.proxyPoolName || providerConfig.proxy_pool || null;
    return {
        event: 'provider_selection',
        workerId,
        providerType,
        requestedModel: requestedModel || null,
        initialCandidateCount: Number(selectionDiagnostics.totalCandidateCount || 0),
        eligibleCandidateCount: Number(selectionDiagnostics.eligibleCandidateCount || 0),
        selectedProviderUuidHash: uuid ? hashDiagnosticIdentifier(uuid) : null,
        selectedProxyPool: proxyPool ? hashDiagnosticIdentifier(proxyPool) : null,
        selectedProviderWeight: Number(providerConfig.providerWeight || providerConfig.weight || 1),
        selectedActiveCount: Number(selectedProvider?.state?.activeCount || providerConfig.activeRequests || 0),
        selectedWaitingCount: Number(selectedProvider?.state?.waitingCount || providerConfig.waitingRequests || 0),
        queueWaitMs: Number(selectionDiagnostics.keyQueueWaitMs || selectionDiagnostics.queueWaitMs || 0),
        queueOutcome: selectionDiagnostics.keyQueueOutcome || selectionDiagnostics.queueOutcome || null,
        selectionDurationMs: Math.max(0, Number(durationMs) || 0),
        filterReasons: sanitizeFilterReasons(selectionDiagnostics.filterReasons),
        fallbackCount: Number(selectionDiagnostics.fallbackCount || 0),
        attempts: Array.isArray(selectionDiagnostics.attempts)
            ? selectionDiagnostics.attempts.map(attempt => ({
                eligibleCandidateCount: Number(attempt?.eligibleCandidateCount || 0),
                filterReasons: sanitizeFilterReasons(attempt?.filterReasons)
            }))
            : []
    };
}

export function buildGeminiRetryDiagnostic({
    workerId = 'standalone',
    mode = 'unary',
    requestedModel = null,
    providerType = 'gemini-antigravity',
    providerUuid = null,
    attempt = 0,
    maxRetries = 0,
    reason = null,
    status = null,
    backoffMs = 0,
    switchedProvider = false,
    nextEligibleCount = null,
    fallbackCount = 0,
    outcome = null
} = {}) {
    return {
        event: 'retry',
        workerId,
        mode,
        providerType,
        requestedModel: requestedModel || null,
        providerUuidHash: providerUuid ? hashDiagnosticIdentifier(providerUuid) : null,
        attempt: Number(attempt || 0),
        maxRetries: Number(maxRetries || 0),
        reason: reason || null,
        status: Number.isFinite(Number(status)) ? Number(status) : null,
        backoffMs: Math.max(0, Number(backoffMs) || 0),
        switchedProvider: Boolean(switchedProvider),
        nextEligibleCount: nextEligibleCount === null ? null : Math.max(0, Number(nextEligibleCount) || 0),
        fallbackCount: Math.max(0, Number(fallbackCount) || 0),
        outcome: outcome || null
    };
}

export function buildGeminiCleanupDiagnostic({
    workerId = 'standalone',
    requestedModel = null,
    providerType = 'gemini-antigravity',
    providerUuid = null,
    clientAborted = false,
    queueCancelled = false,
    leaseReleased = false,
    upstreamAborted = false,
    retryTimerCancelled = false,
    cleanupMs = 0
} = {}) {
    return {
        event: 'cleanup',
        workerId,
        providerType,
        requestedModel: requestedModel || null,
        providerUuidHash: providerUuid ? hashDiagnosticIdentifier(providerUuid) : null,
        clientAborted: Boolean(clientAborted),
        queueCancelled: Boolean(queueCancelled),
        leaseReleased: Boolean(leaseReleased),
        upstreamAborted: Boolean(upstreamAborted),
        retryTimerCancelled: Boolean(retryTimerCancelled),
        cleanupMs: Math.max(0, Number(cleanupMs) || 0)
    };
}
