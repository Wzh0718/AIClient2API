const CODEX_TEXT_PATH = /(?:^|\/)v1\/(?:responses|chat\/completions)$/;

export function isCodexTextAudit(event = {}) {
    const request = event.request || {};
    if (!CODEX_TEXT_PATH.test(String(request.path || request.normalizedPath || ''))) return false;
    return request.toProvider === 'openai-codex-oauth'
        || String(request.path || '').startsWith('/openai-codex-oauth/')
        || (event.attempts || []).some(attempt => attempt.providerType === 'openai-codex-oauth');
}

export function captureStatus(event = {}) {
    if (event.capture?.status === 'failed') return event.capture;
    if (event.status?.outcome !== 'success' || !isCodexTextAudit(event)) {
        return { status: 'complete', missingFields: [] };
    }
    const missingFields = [];
    if (!event.account?.accountEmail) missingFields.push('accountEmail');
    const requested = event.request?.requestedModel;
    if (!requested || requested === 'unknown') missingFields.push('requestedModel');
    if (Number(event.usage?.totalTokens || 0) <= 0) missingFields.push('usage');
    return { status: missingFields.length ? 'failed' : 'complete', missingFields };
}
