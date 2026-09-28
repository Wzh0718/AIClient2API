import { RequestAuditStore } from './audit-store.js';
import { RequestAuditAnalysisStore } from './analysis-store.js';
import { existsSync, readFileSync } from 'fs';
import { getRequestBody } from '../../utils/common.js';
import { atomicWriteFile, withFileLock } from '../../utils/file-lock.js';
import { captureStatus } from './capture-status.js';
import { hashSecret } from './audit-event.js';

let auditStore = null;
let analysisStore = null;
let rawCaptureController = null;
let gptRequestStore = null;
let gptDiagnosticsRunner = null;

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

function summarizeDurations(events = []) {
    const values = events
        .filter(event => {
            const value = event?.response?.durationMs;
            return (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '';
        })
        .map(event => Number(event?.response?.durationMs))
        .filter(value => Number.isFinite(value) && value >= 0)
        .sort((a, b) => a - b);
    if (values.length === 0) {
        return { count: 0, p50: null, p95: null, p99: null, max: null, average: null };
    }
    const percentile = percentage => values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * percentage) - 1))];
    return {
        count: values.length,
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
        max: values[values.length - 1],
        average: values.reduce((sum, value) => sum + value, 0) / values.length
    };
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

export function setGptRequestStore(store) {
    gptRequestStore = store;
}

export function setGptDiagnosticsRunner(runner) {
    gptDiagnosticsRunner = runner;
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
    const completeEvents = events.filter(event => captureStatus(event).status !== 'failed');
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
        outcomeCounts: {},
        models: {},
        accounts: {},
        contextSections: {},
        timing: summarizeDurations(completeEvents),
        captureFailureCount: events.length - completeEvents.length,
        cost: {
            usd: 0,
            actualUsd: 0,
            estimatedUsd: 0,
            pricedRequestCount: 0,
            estimatedRequestCount: 0,
            missingPriceRequestCount: 0,
            estimatedPriceTokens: 0,
            missingPriceTokens: 0
        }
    };

    for (const event of completeEvents) {
        const usage = event.usage || {};
        const outcome = event.status?.outcome || 'unknown';
        result.outcomeCounts[outcome] = (result.outcomeCounts[outcome] || 0) + 1;
        addUsage(result.summary, usage);
        addUsage(ensureBucket(result.models, event.request?.model), usage);
        addUsage(ensureBucket(result.accounts, event.account?.accountEmail || event.account?.providerNameDisplay || event.account?.providerUuidHash || event.account?.providerUuid), usage);
        if (event.cost && typeof event.cost === 'object') {
            result.cost.usd += toNumber(event.cost.usd);
            result.cost.actualUsd += toNumber(event.cost.actualUsd);
            result.cost.estimatedUsd += toNumber(event.cost.estimatedUsd);
            result.cost.estimatedPriceTokens += toNumber(event.cost.estimatedPriceTokens);
            result.cost.missingPriceTokens += toNumber(event.cost.missingPriceTokens);
            if (event.cost.pricingSource === 'missing' || toNumber(event.cost.missingPriceTokens) > 0) {
                result.cost.missingPriceRequestCount += 1;
            } else if (toNumber(event.cost.estimatedUsd) > 0) {
                result.cost.estimatedRequestCount += 1;
            } else {
                result.cost.pricedRequestCount += 1;
            }
        }

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
        glmRouting: requestUrl.searchParams.get('glmRouting') || undefined,
        outcome: requestUrl.searchParams.get('outcome') || undefined,
        credential: requestUrl.searchParams.get('credential') || undefined,
        modelMismatch: requestUrl.searchParams.get('modelMismatch') || undefined,
        cursor: requestUrl.searchParams.get('cursor') || undefined,
        limit: requestUrl.searchParams.get('limit') || undefined
    };
}

export async function handleRequestAuditRoutes(method, path, req, res, config = {}) {
    if (!path.startsWith('/api/request-audit') && !path.startsWith('/api/gpt-diagnostics')) return false;
    if (!await ensureRequestAuditAuth(req, res, config)) return true;
    if (path.startsWith('/api/gpt-diagnostics')) {
        if (!gptDiagnosticsRunner) {
            sendJson(res, 503, { success: false, error: { message: 'GPT diagnostics runner is not ready' } });
            return true;
        }
        try {
            if (path === '/api/gpt-diagnostics/capabilities' && method === 'GET') {
                sendJson(res, 200, { success: true, data: gptDiagnosticsRunner.capabilities() });
                return true;
            }
            if (path === '/api/gpt-diagnostics/runs' && method === 'POST') {
                const body = await getRequestBody(req, { maxBytes: 64 * 1024 });
                const run = await gptDiagnosticsRunner.create(body);
                sendJson(res, 202, { success: true, data: { run } });
                return true;
            }
            if (path === '/api/gpt-diagnostics/runs' && method === 'GET') {
                sendJson(res, 200, { success: true, data: { runs: gptDiagnosticsRunner.list() } });
                return true;
            }
            const cancelMatch = path.match(/^\/api\/gpt-diagnostics\/runs\/([^/]+)\/cancel$/);
            if (cancelMatch && method === 'POST') {
                const run = await gptDiagnosticsRunner.cancel(decodeURIComponent(cancelMatch[1]));
                if (!run) sendJson(res, 404, { success: false, error: { message: 'Diagnostic run not found' } });
                else sendJson(res, 200, { success: true, data: { run } });
                return true;
            }
            const scoreMatch = path.match(/^\/api\/gpt-diagnostics\/runs\/([^/]+)\/score$/);
            if (scoreMatch && method === 'POST') {
                sendJson(res, 410, { success: false, error: { message: 'Manual scoring has been retired' } });
                return true;
            }
            const runMatch = path.match(/^\/api\/gpt-diagnostics\/runs\/([^/]+)$/);
            if (runMatch && method === 'GET') {
                const run = gptDiagnosticsRunner.get(decodeURIComponent(runMatch[1]));
                if (!run) sendJson(res, 404, { success: false, error: { message: 'Diagnostic run not found' } });
                else sendJson(res, 200, { success: true, data: { run } });
                return true;
            }
            sendJson(res, 405, { success: false, error: { message: 'Method not allowed' } });
        } catch (error) {
            sendJson(res, error.statusCode || 500, { success: false, error: { message: error.message } });
        }
        return true;
    }
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

    if (path === '/api/request-audit/glm-usage') {
        if (!gptRequestStore?.queryGlmUsage) {
            sendJson(res, 503, { success: false, error: { message: 'GLM usage projection unavailable' } });
            return true;
        }
        const usage = gptRequestStore.queryGlmUsage();
        const filePath = config.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let configured = [];
        try {
            configured = JSON.parse(readFileSync(filePath, 'utf8'))['glm-coding-plan'] || [];
        } catch (error) {
            if (existsSync(filePath)) throw error;
        }
        const hashes = new Set();
        const empty = { today: null, week: null, month: null };
        const nodes = configured.map(node => {
            const credentialHash = hashSecret(node.uuid);
            hashes.add(credentialHash);
            return {
                uuid: node.uuid,
                name: node.customName || node.uuid,
                disabled: node.isDisabled === true,
                verified: node.glmVerified === true,
                periods: usage.credentials[credentialHash] || empty
            };
        });
        const historical = Object.entries(usage.credentials)
            .filter(([hash]) => !hashes.has(hash))
            .map(([credentialHash, periods]) => ({ credentialHash, periods }));
        sendJson(res, 200, { success: true, data: { ...usage, credentials: undefined, nodes, historical } });
        return true;
    }

    if (path === '/api/request-audit/summary') {
        const summaryFilters = { ...filters };
        delete summaryFilters.cursor;
        delete summaryFilters.limit;
        const aggregated = gptRequestStore?.querySummary?.(summaryFilters);
        const sqliteAvailable = Boolean(aggregated || gptRequestStore?.queryAll);
        const events = aggregated ? [] : sqliteAvailable
            ? gptRequestStore.queryAll(summaryFilters)
            : await store.query({ ...summaryFilters, limit: 2000 });
        const ids = aggregated ? gptRequestStore.queryRequestIds(summaryFilters) : requestIds(events.filter(event => captureStatus(event).status !== 'failed'));
        const diagnostics = await materialized.readDiagnostics({ requestIds: ids });
        const freshness = await materialized.readFreshness();
        const captureFailures = gptRequestStore?.queryCaptureFailures?.(summaryFilters)
            || { count: events.filter(event => captureStatus(event).status === 'failed').length, requests: [] };
        sendJson(res, 200, {
            success: true,
            data: {
                window: { since: filters.since || null, until: filters.until || null },
                ...(aggregated || buildAuditSummary(events)),
                captureFailureCount: captureFailures.count,
                meta: {
                    source: sqliteAvailable ? 'gpt_requests_sqlite' : 'jsonl_fallback',
                    retentionDays: Number(config.GPT_REQUEST_AUDIT_RETENTION_DAYS || 7),
                    complete: sqliteAvailable
                },
                analysisFreshness: freshness,
                diagnosticsSummary: summarizeDiagnostics(diagnostics)
            }
        });
        return true;
    }

    if (path === '/api/request-audit/requests') {
        if (gptRequestStore) {
            const result = gptRequestStore.query(filters);
            const captureFailures = gptRequestStore.queryCaptureFailures?.(filters) || { count: 0, requests: [] };
            const diagnostics = await materialized.readDiagnostics({ requestIds: requestIds(result.requests) });
            sendJson(res, 200, {
                success: true,
                data: {
                    requests: result.requests.map(event => ({ ...event, diagnosis: diagnostics[event.requestId] || null })),
                    nextCursor: result.nextCursor,
                    captureFailures,
                    pagination: { supported: true }
                }
            });
            return true;
        }
        const events = await store.query(filters);
        const completeEvents = events.filter(event => captureStatus(event).status !== 'failed');
        const diagnostics = await materialized.readDiagnostics({ requestIds: requestIds(completeEvents) });
        sendJson(res, 200, {
            success: true,
            data: {
                pagination: { supported: false },
                captureFailures: {
                    count: events.length - completeEvents.length,
                    requests: events.filter(event => captureStatus(event).status === 'failed').slice(0, 25).map(event => ({
                        requestId: event.requestId,
                        timestamp: event.timestamp,
                        keyName: event.potluckKey?.name || null,
                        model: event.request?.outboundModel || event.request?.plannedModel || null,
                        missingFields: captureStatus(event).missingFields
                    }))
                },
                requests: completeEvents.map(event => ({
                    ...event,
                    diagnosis: diagnostics[event.requestId] || null
                }))
            }
        });
        return true;
    }

    const detailMatch = path.match(/^\/api\/request-audit\/requests\/([^/]+)$/);
    if (detailMatch) {
        const requestId = decodeURIComponent(detailMatch[1]);
        const request = gptRequestStore?.get(requestId)
            || (await store.query({ requestId, limit: 1 }))[0]
            || null;
        if (!request) {
            sendJson(res, 404, { success: false, error: { message: 'Request not found' } });
            return true;
        }
        const diagnostics = await materialized.readDiagnostics({ requestIds: [requestId] });
        sendJson(res, 200, { success: true, data: { request: { ...request, diagnosis: diagnostics[requestId] || null } } });
        return true;
    }

    sendJson(res, 404, { success: false, error: { message: 'Request audit endpoint not found' } });
    return true;
}
