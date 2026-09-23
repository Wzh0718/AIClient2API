import crypto from 'node:crypto';
import requestContext from './context.js';

const ATTEMPTS_KEY = '_requestAuditAttempts';

export function beginRequestAttempt(requestBody = {}, fields = {}) {
    if (!requestBody || typeof requestBody !== 'object') return null;
    if (!Array.isArray(requestBody[ATTEMPTS_KEY])) {
        Object.defineProperty(requestBody, ATTEMPTS_KEY, { value: [], writable: true, enumerable: false });
    }
    const attempt = {
        attemptId: crypto.randomUUID(),
        startedAt: new Date().toISOString(),
        status: 'started',
        ...fields
    };
    requestBody[ATTEMPTS_KEY].push(attempt);
    const auditLifecycle = requestContext.get('requestAudit');
    if (auditLifecycle && typeof auditLifecycle === 'object') {
        auditLifecycle.attempts ||= [];
        auditLifecycle.attempts.push(attempt);
    }
    return attempt;
}

export function finishRequestAttempt(attempt, fields = {}) {
    if (!attempt) return null;
    const completedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(attempt.startedAt));
    Object.assign(attempt, { completedAt, durationMs, ...fields });
    return attempt;
}

export function getRequestAttempts(requestBody = {}) {
    return Array.isArray(requestBody?.[ATTEMPTS_KEY]) ? requestBody[ATTEMPTS_KEY] : [];
}

export function getSuccessfulOutboundModel(requestBody = {}, { requireOverride = false } = {}) {
    const attempt = [...getRequestAttempts(requestBody)]
        .reverse()
        .find(item => item.status === 'success' && (!requireOverride || item.modelOverrideApplied === true));
    return attempt?.upstreamResponseModel || attempt?.outboundModel || null;
}
