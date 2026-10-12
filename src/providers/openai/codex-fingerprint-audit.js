import crypto from 'crypto';

export const CODEX_FINGERPRINT_AUDIT_SYNC_TYPE = 'codex_fingerprint_audit';
const AUDIT_FORWARD_INTERVAL_MS = 5000;

const auditByProviderUuid = new Map();
const lastForwardedAt = new Map();

function shortHash(value) {
    if (!value) return null;
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

// 多 worker 下改写发生在 execution worker，而管理后台读 control worker，需把摘要转发过去。
function forwardAuditToControl(uuid, summary) {
    if (process.env.RUNTIME_WORKER_ROLE !== 'execution' || typeof process.send !== 'function') return;
    const now = Date.now();
    if (now - (lastForwardedAt.get(uuid) || 0) < AUDIT_FORWARD_INTERVAL_MS) return;
    lastForwardedAt.set(uuid, now);
    try {
        process.send({ type: CODEX_FINGERPRINT_AUDIT_SYNC_TYPE, uuid, summary });
    } catch {
        // IPC 通道关闭时审计转发失败不影响请求。
    }
}

export function recordCodexFingerprintAudit(providerConfig = {}, ids = null, mode = 'off') {
    const uuid = String(providerConfig.uuid || '').trim();
    if (!uuid) return null;

    const summary = {
        mode,
        version: ids?.version || providerConfig.codexFingerprintVersion || 1,
        rewritten: Boolean(ids),
        rewrittenAt: new Date().toISOString(),
        installationHash: shortHash(ids?.installationId),
        sessionHash: shortHash(ids?.sessionId),
        threadHash: shortHash(ids?.threadId),
        turnHash: shortHash(ids?.turnId)
    };
    auditByProviderUuid.set(uuid, summary);
    forwardAuditToControl(uuid, summary);
    return summary;
}

/**
 * control worker 接收 execution worker 转发的审计摘要；只接受较新的记录。
 */
export function applyRemoteCodexFingerprintAudit(uuid, summary) {
    const key = String(uuid || '').trim();
    if (!key || !summary || typeof summary !== 'object') return false;
    const current = auditByProviderUuid.get(key);
    if (current && String(current.rewrittenAt) >= String(summary.rewrittenAt)) return false;
    auditByProviderUuid.set(key, summary);
    return true;
}

export function getCodexFingerprintAudit(providerUuid) {
    return auditByProviderUuid.get(String(providerUuid || '').trim()) || null;
}

export function clearCodexFingerprintAudit() {
    auditByProviderUuid.clear();
    lastForwardedAt.clear();
}
