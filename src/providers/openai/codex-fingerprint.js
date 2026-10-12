import crypto from 'crypto';

export const CODEX_FINGERPRINT_MODES = Object.freeze(['off', 'device', 'session', 'full']);
export const DEFAULT_CODEX_FINGERPRINT_MODE = 'session';
export const CODEX_FINGERPRINT_VERSION = 1;
export const CODEX_FINGERPRINT_CONTEXT_KEY = '_codexFingerprintContext';

function isCodexOAuthProvider(providerConfig = {}) {
    const providerType = providerConfig.MODEL_PROVIDER || providerConfig.type || providerConfig.providerType;
    return providerType === 'openai-codex-oauth' || String(providerType || '').startsWith('openai-codex-oauth-');
}

function isExplicitlyEnabled(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
}

function stableUuid(seed) {
    const bytes = Buffer.from(crypto.createHash('sha256').update(String(seed)).digest().subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function accountSeed(providerConfig = {}) {
    return String(
        providerConfig.codexAccountKey ||
        providerConfig.codexAccountId ||
        providerConfig.uuid ||
        ''
    ).trim();
}

function rewriteJsonString(value, fields) {
    if (typeof value !== 'string' || !value.trim()) return value;
    try {
        return JSON.stringify({ ...JSON.parse(value), ...fields });
    } catch {
        return value;
    }
}

function deleteHeaderCaseInsensitive(headers, name) {
    const normalized = String(name).toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === normalized) delete headers[key];
    }
}

export function resolveCodexFingerprintMode(providerConfig = {}, globalConfig = providerConfig) {
    if (!isCodexOAuthProvider(providerConfig)) return 'off';
    if (!isExplicitlyEnabled(globalConfig?.CODEX_FINGERPRINT_ENABLED)) return 'off';
    const configured = String(providerConfig.codexFingerprintMode || '').trim().toLowerCase();
    return CODEX_FINGERPRINT_MODES.includes(configured) ? configured : DEFAULT_CODEX_FINGERPRINT_MODE;
}

export function extractOriginalCodexSessionId(headers = {}, requestBody = {}) {
    const getHeader = (name) => headers?.[name] ?? headers?.[name.toLowerCase()] ?? headers?.[name.toUpperCase()];
    const clientMetadata = requestBody?.client_metadata || {};
    const requestMetadata = requestBody?.metadata || {};
    return [
        getHeader('session-id'),
        getHeader('session_id'),
        requestBody?.session_id,
        clientMetadata.session_id,
        requestMetadata.session_id
    ].find(value => value !== undefined && value !== null && String(value).trim())?.toString().trim() || '';
}

export function resolveCodexFingerprintIds({
    providerConfig = {},
    globalConfig = providerConfig,
    originalClientSessionId = '',
    originalTurnId = ''
} = {}) {
    const mode = resolveCodexFingerprintMode(providerConfig, globalConfig);
    if (mode === 'off') return null;
    const seed = accountSeed(providerConfig);
    if (!seed) return null;

    const installationId = stableUuid(`aiclient2api:codex-installation:v${CODEX_FINGERPRINT_VERSION}:${seed}`);
    if (mode === 'device') {
        return { mode, version: CODEX_FINGERPRINT_VERSION, installationId, sessionId: null, threadId: null, turnId: null, windowId: null };
    }

    const sessionId = stableUuid(`aiclient2api:codex-session:v${CODEX_FINGERPRINT_VERSION}:${seed}`);
    const clientSessionSeed = String(originalClientSessionId || '').trim();
    const threadId = mode === 'full' || !clientSessionSeed
        ? sessionId
        : stableUuid(`aiclient2api:codex-thread:v${CODEX_FINGERPRINT_VERSION}:${seed}:${clientSessionSeed}`);
    const sourceTurnId = String(originalTurnId || '').trim();
    const turnId = sourceTurnId
        ? stableUuid(`aiclient2api:codex-turn:v${CODEX_FINGERPRINT_VERSION}:${seed}:${sourceTurnId}`)
        : crypto.randomUUID();
    return {
        mode,
        version: CODEX_FINGERPRINT_VERSION,
        installationId,
        sessionId,
        threadId,
        turnId,
        windowId: `${threadId}:0`,
        turnStartedAtUnixMs: Date.now()
    };
}

export function applyCodexFingerprintHeaders(headers = {}, ids) {
    if (!ids) return false;
    const rewrittenHeaderNames = ids.mode === 'device'
        ? ['x-codex-installation-id']
        : [
            'x-codex-installation-id', 'x-codex-window-id', 'x-client-request-id',
            'session-id', 'session_id', 'thread-id'
        ];
    for (const name of rewrittenHeaderNames) {
        deleteHeaderCaseInsensitive(headers, name);
    }
    // 原生 Codex 不以请求头发送 installation id，只放在 client_metadata 与 turn-metadata 中。

    const metadataFields = { installation_id: ids.installationId };
    if (ids.mode !== 'device') {
        headers['x-codex-window-id'] = ids.windowId;
        headers['x-client-request-id'] = ids.threadId;
        headers['session-id'] = ids.sessionId;
        headers['thread-id'] = ids.threadId;
        Object.assign(metadataFields, {
            session_id: ids.sessionId,
            thread_id: ids.threadId,
            turn_id: ids.turnId,
            window_id: ids.windowId,
            turn_started_at_unix_ms: ids.turnStartedAtUnixMs
        });
    }
    if (Object.prototype.hasOwnProperty.call(headers, 'x-codex-turn-metadata')) {
        headers['x-codex-turn-metadata'] = rewriteJsonString(headers['x-codex-turn-metadata'], metadataFields);
    }
    return true;
}

export function applyCodexFingerprintClientMetadata(requestBody = {}, ids) {
    if (!ids) return false;
    const originalClientMetadata = requestBody.client_metadata;
    const clientMetadata = originalClientMetadata && typeof originalClientMetadata === 'object'
        ? { ...originalClientMetadata }
        : {};
    clientMetadata['x-codex-installation-id'] = ids.installationId;

    const metadataFields = { installation_id: ids.installationId };
    if (ids.mode !== 'device') {
        Object.assign(clientMetadata, {
            session_id: ids.sessionId,
            thread_id: ids.threadId,
            turn_id: ids.turnId,
            'x-codex-window-id': ids.windowId
        });
        Object.assign(metadataFields, {
            session_id: ids.sessionId,
            thread_id: ids.threadId,
            turn_id: ids.turnId,
            window_id: ids.windowId,
            turn_started_at_unix_ms: ids.turnStartedAtUnixMs
        });
    }
    if (Object.prototype.hasOwnProperty.call(clientMetadata, 'x-codex-turn-metadata')) {
        clientMetadata['x-codex-turn-metadata'] = rewriteJsonString(clientMetadata['x-codex-turn-metadata'], metadataFields);
    }
    requestBody.client_metadata = clientMetadata;
    return true;
}
