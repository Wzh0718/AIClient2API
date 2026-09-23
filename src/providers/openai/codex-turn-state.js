// [turn-state-disabled 2026-09-23] 同轮 Turn-State 缓存复用已停用（用户决定不再维护该字段）。
// 本文件仅保留两块活代码：
//   1. resolveInboundCodexTurnState —— 客户端 x-codex-turn-state 头的规范化读取（透明透传用）；
//   2. resolveOriginalCodexTurnId —— x-codex-turn-metadata / turn_id 解析（codex-fingerprint 指纹仍在用）。
// 缓存、捕获、注入、跨 worker IPC 均以注释原样保留，可随时恢复；
// 配置键 codexTurnStateReuseEnabled 不再生效。
// import crypto from 'node:crypto'; // [turn-state-disabled 2026-09-23] 仅供已停用的缓存哈希/IPC 使用

export const CODEX_TURN_STATE_HEADER = 'x-codex-turn-state';
export const MAX_CODEX_TURN_STATE_BYTES = 8 * 1024;
export const REUSABLE_CODEX_TURN_STATE_BYTES = 292;

function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

export function normalizeCodexTurnState(value) {
    if (Array.isArray(value) || typeof value !== 'string') return null;
    const normalized = value.trim();
    if (!normalized || /[\r\n]/.test(normalized)) return null;
    return Buffer.byteLength(normalized, 'utf8') <= MAX_CODEX_TURN_STATE_BYTES ? normalized : null;
}

function parseTurnMetadata(value) {
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

export function resolveOriginalCodexTurnId(headers = {}, requestBody = {}) {
    const headerEntry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-codex-turn-metadata');
    const turnMetadata = parseTurnMetadata(headerEntry?.[1]);
    return firstString(
        requestBody?.client_metadata?.turn_id,
        requestBody?.metadata?.turn_id,
        turnMetadata.turn_id,
        turnMetadata.turnId
    );
}

export function resolveInboundCodexTurnState(headers = {}) {
    const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === CODEX_TURN_STATE_HEADER);
    return normalizeCodexTurnState(entry?.[1]);
}

// [turn-state-disabled 2026-09-23] 以下为停用的缓存复用/捕获/IPC 实现，整体注释保留：

// function stableHash(value) {
//     return crypto.createHash('sha256').update(String(value || '')).digest('hex');
// }

// function isEnabled(config = {}) {
//     const value = config.codexTurnStateReuseEnabled;
//     return value === true || value === 1 || value === '1' || value === 'true';
// }

// export class CodexTurnStateCache {
//     constructor({ maxEntries = 10_000, idleTtlMs = 30 * 60 * 1000, now = () => Date.now() } = {}) {
//         this.maxEntries = Math.max(1, Number(maxEntries) || 10_000);
//         this.idleTtlMs = Math.max(1_000, Number(idleTtlMs) || 30 * 60 * 1000);
//         this.now = now;
//         this.entries = new Map();
//     }

//     buildScope({ callerKeyHash, credentialId, credentialVersion, model, sessionId, turnId } = {}) {
//         if (!turnId || !sessionId || !credentialId || !model) return null;
//         return stableHash(JSON.stringify({
//             callerKeyHash: callerKeyHash || 'anonymous',
//             credentialId,
//             credentialVersion: credentialVersion || '',
//             model,
//             sessionId,
//             turnId
//         }));
//     }

//     get(scope) {
//         if (!scope) return null;
//         const entry = this.entries.get(scope);
//         if (!entry) return null;
//         if (this.now() - entry.lastUsedAt > this.idleTtlMs) {
//             this.entries.delete(scope);
//             return null;
//         }
//         entry.lastUsedAt = this.now();
//         this.entries.delete(scope);
//         this.entries.set(scope, entry);
//         return entry.value;
//     }

//     capture(scope, value) {
//         const normalized = normalizeCodexTurnState(value);
//         if (!scope || !normalized || Buffer.byteLength(normalized, 'utf8') !== REUSABLE_CODEX_TURN_STATE_BYTES) return false;
//         if (this.entries.has(scope)) return false;
//         this.entries.set(scope, { value: normalized, lastUsedAt: this.now() });
//         while (this.entries.size > this.maxEntries) {
//             this.entries.delete(this.entries.keys().next().value);
//         }
//         return true;
//     }

//     clear() {
//         this.entries.clear();
//     }
// }

// export const codexTurnStateCache = new CodexTurnStateCache();
// const ipcPending = new Map();
// let ipcListening = false;

// function ensureIpcListener() {
//     if (ipcListening || typeof process.on !== 'function') return;
//     ipcListening = true;
//     process.on('message', message => {
//         if (message?.type !== 'codex_turn_state_response' || !message.requestId) return;
//         const pending = ipcPending.get(message.requestId);
//         if (!pending) return;
//         ipcPending.delete(message.requestId);
//         clearTimeout(pending.timer);
//         pending.resolve(message);
//     });
// }

// function ipcRequest(action, payload, timeoutMs = 150) {
//     if (typeof process.send !== 'function' || !process.connected) return Promise.resolve(null);
//     ensureIpcListener();
//     const requestId = crypto.randomUUID();
//     return new Promise(resolve => {
//         const timer = setTimeout(() => { ipcPending.delete(requestId); resolve(null); }, timeoutMs);
//         timer.unref?.();
//         ipcPending.set(requestId, { resolve, timer });
//         process.send({ type: 'codex_turn_state_request', requestId, action, payload }, error => {
//             if (!error) return;
//             clearTimeout(timer); ipcPending.delete(requestId); resolve(null);
//         });
//     });
// }

// export function resolveCodexTurnStateForRequest({ config = {}, context = {}, model, cache = codexTurnStateCache } = {}) {
//     const inbound = resolveInboundCodexTurnState(context.inboundCodexHeaders || {});
//     const enabled = isEnabled(config);
//     const scope = enabled ? cache.buildScope({
//         callerKeyHash: context.callerKeyHash,
//         credentialId: config.codexAccountKey || config.codexAccountId || config.uuid,
//         credentialVersion: config.providerConfigRevision || config.configRevision || '',
//         model,
//         sessionId: context.originalClientSessionId,
//         turnId: context.originalTurnId
//     }) : null;
//     if (inbound) return { value: inbound, source: 'client', scope, enabled, length: Buffer.byteLength(inbound, 'utf8') };
//     const cached = enabled ? cache.get(scope) : null;
//     return {
//         value: cached,
//         source: cached ? 'cache' : 'none',
//         scope,
//         enabled,
//         length: cached ? Buffer.byteLength(cached, 'utf8') : 0,
//         skipReason: enabled ? (scope ? 'cache_miss' : 'missing_turn_scope') : 'disabled'
//     };
// }

// export async function resolveCodexTurnStateForRequestAsync(options = {}) {
//     const local = resolveCodexTurnStateForRequest(options);
//     if (local.value || !local.enabled || !local.scope) return local;
//     const response = await ipcRequest('get', { scope: local.scope });
//     const value = normalizeCodexTurnState(response?.value);
//     return value
//         ? { ...local, value, source: 'cache', length: Buffer.byteLength(value, 'utf8'), skipReason: null }
//         : { ...local, skipReason: response ? 'cache_miss' : 'ipc_unavailable' };
// }

// export function captureCodexTurnState({ config = {}, context = {}, model, headers = {}, cache = codexTurnStateCache } = {}) {
//     if (!isEnabled(config)) return { captured: false, reason: 'disabled' };
//     const state = resolveInboundCodexTurnState(headers);
//     if (!state) return { captured: false, reason: 'missing_or_invalid' };
//     const length = Buffer.byteLength(state, 'utf8');
//     if (length !== REUSABLE_CODEX_TURN_STATE_BYTES) {
//         return { captured: false, reason: 'length_mismatch', length };
//     }
//     const scope = cache.buildScope({
//         callerKeyHash: context.callerKeyHash,
//         credentialId: config.codexAccountKey || config.codexAccountId || config.uuid,
//         credentialVersion: config.providerConfigRevision || config.configRevision || '',
//         model,
//         sessionId: context.originalClientSessionId,
//         turnId: context.originalTurnId
//     });
//     if (!scope) return { captured: false, reason: 'missing_turn_scope', length };
//     const captured = cache.capture(scope, state);
//     return { captured, reason: captured ? 'captured' : 'already_present', length };
// }

// export async function captureCodexTurnStateAsync(options = {}) {
//     if (!isEnabled(options.config || {})) return { captured: false, reason: 'disabled' };
//     const local = options.skipLocal ? { captured: false, reason: 'ipc_only' } : captureCodexTurnState(options);
//     if (local.reason === 'disabled') return local;
//     const state = resolveInboundCodexTurnState(options.headers || {});
//     const scope = codexTurnStateCache.buildScope({
//         callerKeyHash: options.context?.callerKeyHash,
//         credentialId: options.config?.codexAccountKey || options.config?.codexAccountId || options.config?.uuid,
//         credentialVersion: options.config?.providerConfigRevision || options.config?.configRevision || '',
//         model: options.model,
//         sessionId: options.context?.originalClientSessionId,
//         turnId: options.context?.originalTurnId
//     });
//     if (scope && state) await ipcRequest('capture', { scope, value: state });
//     return local;
// }

// export function handleCodexTurnStateIpcMessage(message = {}) {
//     if (message.type !== 'codex_turn_state_request') return null;
//     if (message.action === 'get') return { value: codexTurnStateCache.get(message.payload?.scope) };
//     if (message.action === 'capture') {
//         const value = normalizeCodexTurnState(message.payload?.value);
//         if (!value || Buffer.byteLength(value, 'utf8') !== REUSABLE_CODEX_TURN_STATE_BYTES) {
//             return { captured: false, reason: 'length_mismatch' };
//         }
//         return { captured: codexTurnStateCache.capture(message.payload?.scope, value) };
//     }
//     return {};
// }
