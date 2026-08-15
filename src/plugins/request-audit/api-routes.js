import { RequestAuditStore } from './audit-store.js';
import { RequestAuditAnalysisStore } from './analysis-store.js';
import { existsSync, readFileSync } from 'fs';
import { getRequestBody } from '../../utils/common.js';
import { atomicWriteFile, withFileLock } from '../../utils/file-lock.js';

let auditStore = null;
let analysisStore = null;
let rawCaptureController = null;

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function addUsage(target, usage = {}) {
    target.requestCount += 1;
    target.promptTokens += toNumber(usage.promptTokens);
    target.cachedTokens += toNumber(usage.cachedTokens);
    target.completionTokens += toNumber(usage.completionTokens);
    target.reasoningTokens += toNumber(usage.reasoningTokens);
    target.totalTokens += toNumber(usage.totalTokens);
    target.cacheHitRatio = target.promptTokens > 0 ? target.cachedTokens / target.promptTokens : 0;
}

function ensureBucket(map, key) {
    const bucketKey = key || 'unknown';
    if (!map[bucketKey]) {
        map[bucketKey] = {
            requestCount: 0,
            promptTokens: 0,
            cachedTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            cacheHitRatio: 0
        };
    }
    return map[bucketKey];
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

export function setAuditStore(store) {
    auditStore = store;
}

export function setAnalysisStore(store) {
    analysisStore = store;
}

export function setRawCaptureController(controller) {
    rawCaptureController = controller;
}

export function getAuditStore(config = {}) {
    if (config._requestAuditStore) return config._requestAuditStore;
    if (!auditStore) {
        auditStore = new RequestAuditStore({
            dir: config.REQUEST_AUDIT_DIR,
            retentionHours: config.REQUEST_AUDIT_RETENTION_HOURS,
            maxFileBytes: config.REQUEST_AUDIT_MAX_FILE_BYTES
        });
    }
    return auditStore;
}

export function getAnalysisStore(config = {}) {
    if (config._requestAuditAnalysisStore) return config._requestAuditAnalysisStore;
    if (!analysisStore) {
        analysisStore = new RequestAuditAnalysisStore({
            dir: config.REQUEST_AUDIT_ANALYSIS_DIR,
            freshSeconds: config.REQUEST_AUDIT_ANALYSIS_FRESH_SECONDS
        });
    }
    return analysisStore;
}

export function buildAuditSummary(events = []) {
    const result = {
        summary: {
            requestCount: 0,
            promptTokens: 0,
            cachedTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            cacheHitRatio: 0
        },
        models: {},
        accounts: {},
        contextSections: {}
    };

    for (const event of events) {
        const usage = event.usage || {};
        addUsage(result.summary, usage);
        addUsage(ensureBucket(result.models, event.request?.model), usage);
        addUsage(ensureBucket(result.accounts, event.account?.accountEmail || event.account?.providerNameDisplay || event.account?.providerUuidHash || event.account?.providerUuid), usage);

        for (const section of event.contextBreakdown?.sections || []) {
            const id = section.id || 'unknown';
            if (!result.contextSections[id]) {
                result.contextSections[id] = { tokens: 0, percentOfPrompt: 0 };
            }
            result.contextSections[id].tokens += toNumber(section.calibratedTokens ?? section.tokens);
        }
    }

    for (const section of Object.values(result.contextSections)) {
        section.percentOfPrompt = result.summary.promptTokens > 0 ? section.tokens / result.summary.promptTokens : 0;
    }

    return result;
}

function summarizeDiagnostics(diagnosticsByRequestId = {}) {
    const summary = {};
    for (const diagnosis of Object.values(diagnosticsByRequestId)) {
        const reason = diagnosis?.primaryReason || 'unknown';
        summary[reason] = (summary[reason] || 0) + 1;
    }
    return summary;
}

function requestIds(events = []) {
    return events.map(event => event.requestId).filter(Boolean);
}

function normalizeKeyHashes(value) {
    if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
    if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
    return [];
}

function normalizeRawCaptureUpdate(body = {}) {
    const keyHashes = normalizeKeyHashes(body.keyHashes);
    if (keyHashes.length > 2) {
        const error = new Error('Raw capture supports at most two scoped key hashes.');
        error.statusCode = 400;
        throw error;
    }
    for (const keyHash of keyHashes) {
        if (!/^sha256:[a-f0-9]{16}$/i.test(keyHash)) {
            const error = new Error('Invalid raw capture key hash. Expected sha256:xxxxxxxxxxxxxxxx key hash.');
            error.statusCode = 400;
            throw error;
        }
    }
    const durationMinutes = Math.min(Math.max(Number(body.durationMinutes ?? body.ttlMinutes) || 15, 1), 60);
    const maxBytes = Math.min(Math.max(Number(body.maxBytes) || 2 * 1024 * 1024, 1024), 10 * 1024 * 1024);
    const maxFiles = Math.min(Math.max(Number(body.maxFiles) || 100, 1), 100);
    const maxTotalBytes = Math.min(Math.max(Number(body.maxTotalBytes) || 100 * 1024 * 1024, 1024 * 1024), 100 * 1024 * 1024);
    return {
        enabled: body.enabled === true || body.enabled === 'true',
        keyHashes: keyHashes.map(keyHash => `sha256:${keyHash.slice(7).toLowerCase()}`),
        ttlMinutes: durationMinutes,
        durationMinutes,
        expiresAt: body.enabled === true || body.enabled === 'true'
            ? new Date(Date.now() + durationMinutes * 60 * 1000).toISOString()
            : null,
        maxBytes,
        maxFiles,
        maxTotalBytes
    };
}

export async function persistRawCaptureConfig(config = {}, options = {}) {
    config.REQUEST_AUDIT_RAW_CAPTURE_ENABLED = options.enabled;
    config.REQUEST_AUDIT_RAW_CAPTURE_KEY_HASHES = options.keyHashes;
    config.REQUEST_AUDIT_RAW_CAPTURE_TTL_MINUTES = options.ttlMinutes;
    config.REQUEST_AUDIT_RAW_CAPTURE_EXPIRES_AT = options.expiresAt;
    config.REQUEST_AUDIT_RAW_CAPTURE_MAX_BYTES = options.maxBytes;
    config.REQUEST_AUDIT_RAW_CAPTURE_MAX_FILES = options.maxFiles;
    config.REQUEST_AUDIT_RAW_CAPTURE_MAX_TOTAL_BYTES = options.maxTotalBytes;

    if (config._requestAuditSkipConfigPersist) return;

    const configPath = config._requestAuditConfigPath || 'configs/config.json';
    await withFileLock(configPath, async () => {
        let fileConfig = {};
        if (existsSync(configPath)) {
            fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
        }
        Object.assign(fileConfig, {
            REQUEST_AUDIT_RAW_CAPTURE_ENABLED: options.enabled,
            REQUEST_AUDIT_RAW_CAPTURE_KEY_HASHES: options.keyHashes,
            REQUEST_AUDIT_RAW_CAPTURE_TTL_MINUTES: options.ttlMinutes,
            REQUEST_AUDIT_RAW_CAPTURE_EXPIRES_AT: options.expiresAt,
            REQUEST_AUDIT_RAW_CAPTURE_MAX_BYTES: options.maxBytes,
            REQUEST_AUDIT_RAW_CAPTURE_MAX_FILES: options.maxFiles,
            REQUEST_AUDIT_RAW_CAPTURE_MAX_TOTAL_BYTES: options.maxTotalBytes
        });
        await atomicWriteFile(configPath, JSON.stringify(fileConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
    });
}

async function ensureRequestAuditAuth(req, res, config = {}) {
    if (config._requestAuditSkipAuth) return true;
    const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : new URL(req.url || '/', 'http://localhost').searchParams.get('token');
    let isAuth = false;
    if (token) {
        try {
            const tokenStorePath = config._requestAuditTokenStorePath || 'configs/token-store.json';
            const tokenStore = existsSync(tokenStorePath) ? JSON.parse(readFileSync(tokenStorePath, 'utf8')) : { tokens: {} };
            const tokenInfo = tokenStore.tokens?.[token];
            isAuth = Boolean(tokenInfo && (!tokenInfo.expiryTime || Date.now() <= tokenInfo.expiryTime));
        } catch {
            isAuth = false;
        }
    }
    if (isAuth) return true;
    sendJson(res, 401, {
        success: false,
        error: {
            message: 'Unauthorized access, please login first',
            code: 'UNAUTHORIZED'
        }
    });
    return false;
}

function parseQuery(requestUrl) {
    return {
        keyHash: requestUrl.searchParams.get('keyHash') || undefined,
        keyPrefix: requestUrl.searchParams.get('keyPrefix') || undefined,
        requestId: requestUrl.searchParams.get('requestId') || undefined,
        clientIp: requestUrl.searchParams.get('clientIp') || undefined,
        path: requestUrl.searchParams.get('path') || undefined,
        since: requestUrl.searchParams.get('since') || undefined,
        until: requestUrl.searchParams.get('until') || undefined,
        model: requestUrl.searchParams.get('model') || undefined,
        provider: requestUrl.searchParams.get('provider') || undefined,
        outcome: requestUrl.searchParams.get('outcome') || undefined,
        limit: requestUrl.searchParams.get('limit') || undefined
    };
}

export async function handleRequestAuditRoutes(method, path, req, res, config = {}) {
    if (!path.startsWith('/api/request-audit')) return false;
    if (!await ensureRequestAuditAuth(req, res, config)) return true;
    if (path === '/api/request-audit/raw-capture') {
        if (!rawCaptureController) {
            sendJson(res, 503, { success: false, error: { message: 'Raw capture controller is not ready' } });
            return true;
        }
        if (method === 'GET') {
            const status = await rawCaptureController.getStatus();
            sendJson(res, 200, { success: true, data: status });
            return true;
        }
        if (method === 'POST') {
            try {
                const body = await getRequestBody(req, { maxBytes: 16 * 1024 });
                const options = normalizeRawCaptureUpdate(body);
                await persistRawCaptureConfig(config, options);
                rawCaptureController.updateOptions(options, { publish: true });
                sendJson(res, 200, { success: true, data: await rawCaptureController.getStatus() });
            } catch (error) {
                sendJson(res, error.statusCode || 500, { success: false, error: { message: error.message } });
            }
            return true;
        }
        sendJson(res, 405, { success: false, error: { message: 'Method not allowed' } });
        return true;
    }

    if (method !== 'GET') {
        sendJson(res, 405, { success: false, error: { message: 'Method not allowed' } });
        return true;
    }

    const requestUrl = new URL(req.url || path, 'http://localhost');
    const store = getAuditStore(config);
    const materialized = getAnalysisStore(config);
    const filters = parseQuery(requestUrl);

    if (path === '/api/request-audit/summary') {
        const events = await store.query(filters);
        const diagnostics = await materialized.readDiagnostics({ requestIds: requestIds(events) });
        const freshness = await materialized.readFreshness();
        sendJson(res, 200, {
            success: true,
            data: {
                window: { since: filters.since || null, until: filters.until || null },
                ...buildAuditSummary(events),
                analysisFreshness: freshness,
                diagnosticsSummary: summarizeDiagnostics(diagnostics)
            }
        });
        return true;
    }

    if (path === '/api/request-audit/requests') {
        const events = await store.query(filters);
        const diagnostics = await materialized.readDiagnostics({ requestIds: requestIds(events) });
        sendJson(res, 200, {
            success: true,
            data: {
                requests: events.map(event => ({
                    ...event,
                    diagnosis: diagnostics[event.requestId] || null
                }))
            }
        });
        return true;
    }

    sendJson(res, 404, { success: false, error: { message: 'Request audit endpoint not found' } });
    return true;
}
