function parseRetryAfterMs(error, now = Date.now()) {
    const value = error?.response?.headers?.['retry-after'] ?? error?.response?.headers?.['Retry-After'];
    if (value !== undefined && value !== null && value !== '') {
        const seconds = Number(value);
        if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
        const date = Date.parse(String(value));
        if (Number.isFinite(date)) return Math.max(0, date - now);
    }
    const body = error?.response?.data?.error || error?.response?.data;
    const resetSeconds = Number(body?.resets_in_seconds ?? body?.retry_after ?? body?.retryAfter);
    if (Number.isFinite(resetSeconds) && resetSeconds >= 0) return Math.round(resetSeconds * 1000);
    return null;
}

export function shouldRetryCodex429(error, { attempts = 0, maxAttempts = 1 } = {}) {
    return Number(error?.response?.status || error?.status || 0) === 429
        && Number(attempts) < Math.max(0, Number(maxAttempts) || 0);
}

export function getCodexRetryDelayMs(error, { fallbackMs = 800, maxDelayMs = 30000, now = Date.now() } = {}) {
    const explicit = parseRetryAfterMs(error, now);
    if (explicit !== null) return Math.min(Math.max(0, explicit), Math.max(0, Number(maxDelayMs) || 0));
    return Math.min(Math.max(0, Number(fallbackMs) || 0), Math.max(0, Number(maxDelayMs) || 0));
}

export function hasCodexRetryBudget({ startedAt = Date.now(), maxDurationMs = 120000, now = Date.now() } = {}) {
    const duration = Math.max(0, Number(maxDurationMs) || 0);
    return duration === 0 || now - Number(startedAt) < duration;
}

const DEFAULT_OVERLOAD_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_OVERLOAD_RETRY_DELAY_MS = 800;
const HARD_OVERLOAD_RETRY_MAX_DELAY_MS = 5000;

export function getCodexOverloadRetryMaxAttempts(config = {}) {
    const configured = Number(config?.CODEX_OVERLOAD_RETRY_MAX_ATTEMPTS);
    return Number.isInteger(configured) && configured >= 0
        ? configured
        : DEFAULT_OVERLOAD_RETRY_MAX_ATTEMPTS;
}

export function getCodexOverloadRetryDelayMs(config = {}) {
    const configured = Number(config?.CODEX_OVERLOAD_RETRY_DELAY_MS);
    const delay = Number.isFinite(configured) ? configured : DEFAULT_OVERLOAD_RETRY_DELAY_MS;
    const maxConfigured = Number(config?.CODEX_OVERLOAD_RETRY_MAX_DELAY_MS);
    const maxDelay = Number.isFinite(maxConfigured) && maxConfigured >= 0
        ? Math.min(maxConfigured, HARD_OVERLOAD_RETRY_MAX_DELAY_MS)
        : HARD_OVERLOAD_RETRY_MAX_DELAY_MS;
    return Math.min(Math.max(0, delay), maxDelay);
}
