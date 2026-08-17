import logger from '../../utils/logger.js';
import { buildRequestAuditEvent, hashSecret, maskPotluckKey, normalizeUsage } from './audit-event.js';
import { extractUsage as extractNormalizedUsage, mergeUsage as mergeNormalizedUsage } from '../../utils/usage-normalizer.js';
import { getAnalysisStore, getAuditStore, handleRequestAuditRoutes, persistRawCaptureConfig, setAnalysisStore, setAuditStore, setRawCaptureController } from './api-routes.js';
import { createRequestAuditAnalyzerRunner } from './analyzer-runner.js';
import { buildBoundedRawCaptureEvent, RequestAuditRawCaptureStore, shouldCaptureRawRequest } from './raw-capture-store.js';

const pendingUsage = new Map();
const pendingAuditContexts = new Map();
const finalizedRequestIds = new Map();
const auditQueue = [];
const executionRawCaptureQueue = [];
let auditQueueBytes = 0;
let enabled = true;
let store = null;
let flushPromise = null;
let lastCleanupAt = 0;
let cleanupTimer = null;
let cleanupInFlight = false;
let cleanupPromise = null;
let analyzerRunner = null;
let analyzerRunOnInitHandle = null;
let rawCaptureStore = null;
let rawCaptureOptions = { enabled: false, keyHashes: [] };
let rawCaptureEventSink = null;
let rawCaptureRevision = 0;
let rawCaptureConfigTarget = null;
let rawCaptureStopReason = null;
let executionRawCaptureFlushPromise = null;
let acceptingAuditContext = false;
let destroyPromise = null;
let auditLossCounts = new Map();
let backgroundFailureCounts = new Map();
let runtimeProjectionBatch = null;

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_AUDIT_QUEUE_EVENTS = 1000;
const AUDIT_FLUSH_BATCH_SIZE = 5;
const MAX_PENDING_USAGE_ENTRIES = 10000;
const MAX_AUDIT_QUEUE_BYTES = 8 * 1024 * 1024;
const MAX_EXECUTION_RAW_CAPTURE_QUEUE = 20;

function recordAuditLoss(reason, count = 1) {
    const nextCount = (auditLossCounts.get(reason) || 0) + Math.max(1, Number(count) || 1);
    auditLossCounts.set(reason, nextCount);
    return nextCount;
}

function buildAuditLossError() {
    const losses = [...auditLossCounts.entries()];
    const total = losses.reduce((sum, [, count]) => sum + count, 0);
    if (total === 0) return null;

    const message = `Request audit lost ${total} audit event${total === 1 ? '' : 's'} (${losses.map(([reason, count]) => `${reason}: ${count}`).join(', ')})`;
    if (losses.length === 1) {
        return new Error(message);
    }

    return new AggregateError(
        losses.map(([reason, count]) => new Error(`${reason}: ${count}`)),
        message
    );
}

function recordBackgroundFailure(reason) {
    backgroundFailureCounts.set(reason, (backgroundFailureCounts.get(reason) || 0) + 1);
}

function buildShutdownError() {
    const errors = [];
    const auditLossError = buildAuditLossError();
    if (auditLossError) errors.push(auditLossError);
    for (const [reason, count] of backgroundFailureCounts.entries()) {
        errors.push(new Error(`Request audit background failure (${reason}: ${count})`));
    }
    if (errors.length === 0) return null;
    if (errors.length === 1) return errors[0];
    return new AggregateError(errors, `Request audit shutdown failed (${errors.map(error => error.message).join('; ')})`);
}

function nextTick() {
    return new Promise(resolve => setImmediate(resolve));
}

function mergeUsage(base, next) {
    return mergeNormalizedUsage(base, next);
}

function extractUsage(...candidates) {
    return extractNormalizedUsage(...candidates);
}

function getRequestId(context = {}) {
    return context.requestId || context._monitorRequestId || null;
}

function setPendingUsage(requestId, usage) {
    if (!requestId) return;
    if (!pendingUsage.has(requestId) && pendingUsage.size >= MAX_PENDING_USAGE_ENTRIES) {
        const oldestRequestId = pendingUsage.keys().next().value;
        if (oldestRequestId !== undefined) {
            pendingUsage.delete(oldestRequestId);
            recordAuditLoss('pending usage overflow');
        }
    }
    const previous = pendingUsage.get(requestId) || {};
    pendingUsage.set(requestId, {
        usage: mergeUsage(pendingUsage.get(requestId)?.usage, usage),
        hasImageResult: previous.hasImageResult === true,
        updatedAt: Date.now()
    });
}

function containsImageResult(value, seen = new Set()) {
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(item => containsImageResult(item, seen));
    if (typeof value.b64_json === 'string' && value.b64_json.length > 0) return true;
    if (Array.isArray(value.data) && value.data.some(item =>
        typeof item?.b64_json === 'string' && item.b64_json.length > 0 ||
        typeof item?.url === 'string' && item.url.length > 0
    )) return true;
    if (typeof value.url === 'string' && value.url.startsWith('data:image/')) return true;
    if (value.type === 'image_generation_call' && typeof value.result === 'string' && value.result.length > 0) return true;
    const inlineData = value.inlineData || value.inline_data;
    if (inlineData && typeof inlineData.data === 'string' && inlineData.data.length > 0 && /^image\//i.test(inlineData.mimeType || inlineData.mime_type || '')) return true;
    return Object.values(value).some(item => containsImageResult(item, seen));
}

function observeImageResult(requestId, ...candidates) {
    if (!requestId || !candidates.some(candidate => containsImageResult(candidate))) return;
    const entry = pendingUsage.get(requestId) || { usage: normalizeUsage({}), updatedAt: Date.now() };
    entry.hasImageResult = true;
    entry.updatedAt = Date.now();
    pendingUsage.set(requestId, entry);
}

function isImageRequest(context = {}) {
    const path = String(context.normalizedPath || context.path || '');
    if (/\/v1\/images\/(?:generations|edits)$/i.test(path)) return true;
    const model = String(context.model || context.processedRequestBody?.model || context.originalRequestBody?.model || '');
    return /gpt-image|flash-image|image-preview|banana/i.test(model);
}

function rememberFinalizedRequest(requestId) {
    if (!requestId) return;
    finalizedRequestIds.set(requestId, Date.now());
    while (finalizedRequestIds.size > MAX_PENDING_USAGE_ENTRIES) {
        finalizedRequestIds.delete(finalizedRequestIds.keys().next().value);
    }
}

async function enqueueFinalAudit(context = {}) {
    const requestId = getRequestId(context);
    if (!requestId || finalizedRequestIds.has(requestId)) return;
    cleanupPendingUsage();
    const pending = pendingUsage.get(requestId) || {};
    const response = {
        ...(context.response || {}),
        hasImageResult: isImageRequest(context) ? pending.hasImageResult === true : null
    };
    const event = buildRequestAuditEvent({
        ...context,
        requestId,
        response,
        usage: pending.usage || {},
        timestamp: new Date().toISOString()
    });
    let rawCaptureEvent = null;
    const alreadyCapturedByExecutionWorker = Boolean(context.cache);
    if (!alreadyCapturedByExecutionWorker && shouldCaptureRawRequest(rawCaptureOptions, event) && rawCaptureStore) {
        try {
            rawCaptureEvent = buildBoundedRawCaptureEvent(event, context, rawCaptureStore.maxBytes);
        } catch {
            recordAuditLoss('raw snapshot failure');
            logger.warn('[Request Audit] raw snapshot failure');
        }
    }
    if (context._runtimeEventId) {
        if (runtimeProjectionBatch) {
            runtimeProjectionBatch.push({ event, rawCaptureEvent, requestId });
            return;
        }
        await store.append(event);
        if (rawCaptureEvent && rawCaptureStore) {
            const result = await rawCaptureStore.capture(rawCaptureEvent);
            if (result?.stopReason) await disableRawCapture(result.stopReason);
        }
    } else {
        enqueueAuditContext({ event, rawCaptureEvent });
    }
    rememberFinalizedRequest(requestId);
    pendingUsage.delete(requestId);
    pendingAuditContexts.delete(requestId);
}

function cleanupPendingUsage() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [requestId, entry] of pendingUsage.entries()) {
        if ((entry.updatedAt || 0) < cutoff) {
            pendingUsage.delete(requestId);
            pendingAuditContexts.delete(requestId);
        }
    }
    for (const [requestId, finalizedAt] of finalizedRequestIds.entries()) {
        if (finalizedAt < cutoff) finalizedRequestIds.delete(requestId);
    }
}

function enqueueAuditContext(work) {
    if (!store || !acceptingAuditContext) return;
    if (auditQueue.length >= MAX_AUDIT_QUEUE_EVENTS) {
        const droppedCount = recordAuditLoss('queue overflow');
        if (droppedCount === 1 || droppedCount % 100 === 0) {
            logger.warn(`[Request Audit] Dropping audit event because queue is full (dropped=${droppedCount})`);
        }
        return;
    }
    const workBytes = Buffer.byteLength(JSON.stringify(work), 'utf8');
    if (workBytes > MAX_AUDIT_QUEUE_BYTES || auditQueueBytes + workBytes > MAX_AUDIT_QUEUE_BYTES) {
        const droppedCount = recordAuditLoss('queue byte overflow');
        if (droppedCount === 1 || droppedCount % 100 === 0) {
            logger.warn(`[Request Audit] Dropping audit event because queue byte budget is full (dropped=${droppedCount})`);
        }
        return;
    }
    Object.defineProperty(work, '_queueBytes', { value: workBytes, enumerable: false });
    auditQueue.push(work);
    auditQueueBytes += workBytes;
    scheduleAuditFlush();
}

function scheduleAuditFlush() {
    if (!flushPromise) {
        flushPromise = flushAuditQueue().finally(() => {
            flushPromise = null;
            if (auditQueue.length > 0) {
                scheduleAuditFlush();
            }
        });
    }
}

async function flushAuditQueue() {
    while (auditQueue.length > 0) {
        const batchSize = Math.min(auditQueue.length, AUDIT_FLUSH_BATCH_SIZE);
        for (let i = 0; i < batchSize; i += 1) {
            const work = auditQueue.shift();
            if (!work) continue;
            auditQueueBytes = Math.max(0, auditQueueBytes - (work._queueBytes || 0));

            try {
                const { event, rawCaptureEvent } = work;
                await store.append(event);
            } catch (error) {
                recordAuditLoss('persistence failure');
                logger.warn(`[Request Audit] Failed to write audit event (${error?.code || error?.name || 'Error'})`);
                continue;
            }
            const { rawCaptureEvent } = work;
            if (rawCaptureEvent && rawCaptureStore) {
                try {
                    const result = await rawCaptureStore.capture(rawCaptureEvent);
                    if (result?.stopReason) await disableRawCapture(result.stopReason);
                } catch (error) {
                    recordAuditLoss('raw capture failure');
                    logger.warn(`[Request Audit] Failed to capture raw request (${error?.code || error?.name || 'Error'})`);
                }
            }
        }
        if (auditQueue.length > 0) await nextTick();
    }
}

async function disableRawCapture(reason) {
    if (!rawCaptureOptions.enabled) return;
    rawCaptureStopReason = reason || 'stopped';
    const controller = createRawCaptureController();
    controller.updateOptions({
        enabled: false,
        keyHashes: rawCaptureOptions.keyHashes,
        ttlMinutes: rawCaptureStore?.ttlMinutes,
        expiresAt: null,
        maxBytes: rawCaptureStore?.maxBytes,
        maxFiles: rawCaptureStore?.maxFiles,
        maxTotalBytes: rawCaptureStore?.maxTotalBytes
    }, { publish: Boolean(rawCaptureEventSink) });
    if (rawCaptureConfigTarget && rawCaptureEventSink) {
        await persistRawCaptureConfig(rawCaptureConfigTarget, {
            enabled: false,
            keyHashes: rawCaptureOptions.keyHashes,
            ttlMinutes: rawCaptureStore?.ttlMinutes,
            expiresAt: null,
            maxBytes: rawCaptureStore?.maxBytes,
            maxFiles: rawCaptureStore?.maxFiles,
            maxTotalBytes: rawCaptureStore?.maxTotalBytes
        }).catch(() => logger.warn('[Request Audit] Failed to persist automatic raw capture shutdown'));
    }
}

function scheduleExecutionRawCapture() {
    if (executionRawCaptureFlushPromise) return;
    executionRawCaptureFlushPromise = new Promise(resolve => setImmediate(resolve))
        .then(async () => {
            while (executionRawCaptureQueue.length > 0) {
                const work = executionRawCaptureQueue.shift();
                if (!work || !rawCaptureStore) continue;
                try {
                    const snapshot = buildBoundedRawCaptureEvent(work.event, work.context, rawCaptureStore.maxBytes);
                    const result = await rawCaptureStore.capture(snapshot);
                    if (result?.stopReason) await disableRawCapture(result.stopReason);
                } catch (error) {
                    recordAuditLoss('raw capture failure');
                    logger.warn(`[Request Audit] Failed to capture execution-local raw request (${error?.code || error?.name || 'Error'})`);
                }
            }
        })
        .finally(() => {
            executionRawCaptureFlushPromise = null;
            if (executionRawCaptureQueue.length > 0) scheduleExecutionRawCapture();
        });
}

async function drainExecutionRawCaptureQueue() {
    if (!executionRawCaptureFlushPromise && executionRawCaptureQueue.length > 0) scheduleExecutionRawCapture();
    while (executionRawCaptureFlushPromise) await executionRawCaptureFlushPromise;
}

export async function drainAuditQueue() {
    while (flushPromise || auditQueue.length > 0) {
        if (!flushPromise && auditQueue.length > 0) {
            scheduleAuditFlush();
        }
        const activeFlush = flushPromise;
        if (activeFlush) {
            await activeFlush;
        }
    }
}

function runCleanupTasks(tasks) {
    cleanupInFlight = true;
    cleanupPromise = Promise.allSettled(
        tasks.map(task => Promise.resolve().then(task))
    )
        .then(results => {
            const failures = results.filter(result => result.status === 'rejected');
            for (const _failure of failures) {
                recordBackgroundFailure('cleanup failure');
            }
            if (failures.length > 0) {
                logger.warn('[Request Audit] cleanup failure');
            }
        })
        .finally(() => {
            cleanupInFlight = false;
            cleanupPromise = null;
        });
    return cleanupPromise;
}

function scheduleAuditCleanup() {
    cleanupPendingUsage();
    if (!store || cleanupInFlight) return;
    const now = Date.now();
    if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;

    lastCleanupAt = now;
    return runCleanupTasks([
        () => store.cleanup(),
        async () => {
            await rawCaptureStore?.cleanup?.();
            await createRawCaptureController().getStatus();
        }
    ]);
}

function createRawCaptureController() {
    return {
        async getStatus() {
            const stats = await rawCaptureStore?.getStats?.() || {
                fileCount: await rawCaptureStore?.countFiles?.() || 0,
                totalBytes: 0
            };
            const expired = Boolean(rawCaptureOptions.expiresAt && Date.now() >= new Date(rawCaptureOptions.expiresAt).getTime());
            const capacityReached = stats.fileCount >= (rawCaptureStore?.maxFiles || 100) ||
                stats.totalBytes >= (rawCaptureStore?.maxTotalBytes || 100 * 1024 * 1024);
            if (rawCaptureOptions.enabled && (expired || capacityReached)) {
                await disableRawCapture(expired ? 'expired' : 'capacity');
            }
            return {
                enabled: (rawCaptureOptions.enabled === true || rawCaptureOptions.enabled === 'true') && !expired && !capacityReached,
                configuredEnabled: rawCaptureOptions.enabled === true || rawCaptureOptions.enabled === 'true',
                keyHashes: Array.isArray(rawCaptureOptions.keyHashes) ? rawCaptureOptions.keyHashes : [],
                ttlMinutes: rawCaptureStore?.ttlMinutes || 60,
                expiresAt: rawCaptureOptions.expiresAt || rawCaptureStore?.expiresAt || null,
                maxBytes: rawCaptureStore?.maxBytes || 1024 * 1024,
                maxFiles: rawCaptureStore?.maxFiles || 100,
                maxTotalBytes: rawCaptureStore?.maxTotalBytes || 100 * 1024 * 1024,
                dir: rawCaptureStore?.dir || null,
                fileCount: stats.fileCount,
                totalBytes: stats.totalBytes,
                stopReason: rawCaptureStopReason || (expired ? 'expired' : capacityReached ? 'capacity' : null),
                revision: rawCaptureRevision,
                workerSync: globalThis.rawCaptureConfigSyncStatus || null
            };
        },
        updateOptions(options = {}, { publish = false } = {}) {
            rawCaptureRevision = Math.max(rawCaptureRevision + 1, Number(options.revision) || 0);
            rawCaptureOptions = {
                enabled: options.enabled === true || options.enabled === 'true',
                keyHashes: Array.isArray(options.keyHashes) ? options.keyHashes : [],
                expiresAt: options.expiresAt || null
            };
            if (rawCaptureOptions.enabled) rawCaptureStopReason = null;
            rawCaptureStore?.updateOptions?.({
                ttlMinutes: options.ttlMinutes,
                maxBytes: options.maxBytes,
                expiresAt: options.expiresAt,
                maxFiles: options.maxFiles,
                maxTotalBytes: options.maxTotalBytes
            });
            if (publish && rawCaptureEventSink) {
                rawCaptureEventSink({
                    type: 'request_audit_raw_capture_sync',
                    revision: rawCaptureRevision,
                    options: {
                        enabled: rawCaptureOptions.enabled,
                        keyHashes: rawCaptureOptions.keyHashes,
                        ttlMinutes: rawCaptureStore?.ttlMinutes,
                        expiresAt: rawCaptureOptions.expiresAt,
                        maxBytes: rawCaptureStore?.maxBytes,
                        maxFiles: rawCaptureStore?.maxFiles,
                        maxTotalBytes: rawCaptureStore?.maxTotalBytes
                    }
                });
            }
        }
    };
}

export function applyRawCaptureRuntimeConfig(event = {}) {
    if (event.type !== 'request_audit_raw_capture_sync') return { applied: false, revision: rawCaptureRevision };
    if (Number(event.revision) <= rawCaptureRevision) return { applied: false, revision: rawCaptureRevision };
    createRawCaptureController().updateOptions({ ...(event.options || {}), revision: event.revision });
    return { applied: true, revision: rawCaptureRevision };
}

function startCleanupTimer() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = setInterval(scheduleAuditCleanup, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();
}

function cleanupRawCaptureOnInit() {
    return runCleanupTasks([
        async () => {
            await rawCaptureStore?.cleanup?.();
            await createRawCaptureController().getStatus();
        }
    ]);
}

const requestAuditPlugin = {
    name: 'request-audit',
    version: '1.0.0',
    description: '请求审计：安全记录每次请求的审计明细、OpenAI usage 和近似上下文 token 分类；默认不保存原始 prompt、图片原文、完整 key、token 或 cookie。<br>API: <code>/api/request-audit</code><br>页面：<a href="request-audit.html" target="_blank">request-audit.html</a>',
    type: 'middleware',
    _builtin: true,
    _priority: 8990,

    beginUsageProjectionBatch() {
        if (runtimeProjectionBatch) throw new Error('Request audit projection batch is already active');
        runtimeProjectionBatch = [];
    },

    async commitUsageProjectionBatch() {
        const batch = runtimeProjectionBatch || [];
        runtimeProjectionBatch = null;
        if (batch.length === 0) return;
        await store.appendBatch(batch.map(item => item.event));
        for (const item of batch) {
            if (item.rawCaptureEvent && rawCaptureStore) {
                const result = await rawCaptureStore.capture(item.rawCaptureEvent);
                if (result?.stopReason) await disableRawCapture(result.stopReason);
            }
            rememberFinalizedRequest(item.requestId);
            pendingUsage.delete(item.requestId);
            pendingAuditContexts.delete(item.requestId);
        }
    },

    rollbackUsageProjectionBatch() {
        const batch = runtimeProjectionBatch || [];
        runtimeProjectionBatch = null;
        for (const item of batch) {
            pendingUsage.delete(item.requestId);
            pendingAuditContexts.delete(item.requestId);
        }
    },
    staticPaths: ['request-audit.html'],
    routes: [
        {
            method: '*',
            path: '/api/request-audit',
            handler: handleRequestAuditRoutes
        }
    ],

    async init(config = {}) {
        enabled = config.REQUEST_AUDIT_ENABLED !== false && config.REQUEST_AUDIT_ENABLED !== 'false';
        acceptingAuditContext = enabled;
        destroyPromise = null;
        auditLossCounts = new Map();
        backgroundFailureCounts = new Map();
        auditQueueBytes = 0;
        store = config._requestAuditStore || getAuditStore(config);
        setAuditStore(store);
        const materializedStore = config._requestAuditAnalysisStore || getAnalysisStore(config);
        setAnalysisStore(materializedStore);
        rawCaptureStore = config._requestAuditRawCaptureStore || new RequestAuditRawCaptureStore({
            dir: config.REQUEST_AUDIT_RAW_CAPTURE_DIR,
            ttlMinutes: config.REQUEST_AUDIT_RAW_CAPTURE_TTL_MINUTES || 60,
            maxBytes: config.REQUEST_AUDIT_RAW_CAPTURE_MAX_BYTES || 1024 * 1024,
            expiresAt: config.REQUEST_AUDIT_RAW_CAPTURE_EXPIRES_AT || null,
            maxFiles: config.REQUEST_AUDIT_RAW_CAPTURE_MAX_FILES || 100,
            maxTotalBytes: config.REQUEST_AUDIT_RAW_CAPTURE_MAX_TOTAL_BYTES || 100 * 1024 * 1024
        });
        rawCaptureOptions = {
            enabled: config.REQUEST_AUDIT_RAW_CAPTURE_ENABLED === true || config.REQUEST_AUDIT_RAW_CAPTURE_ENABLED === 'true',
            keyHashes: config.REQUEST_AUDIT_RAW_CAPTURE_KEY_HASHES || [],
            expiresAt: config.REQUEST_AUDIT_RAW_CAPTURE_EXPIRES_AT || null
        };
        rawCaptureEventSink = config._requestAuditRawCaptureEventSink || null;
        rawCaptureConfigTarget = config;
        setRawCaptureController(createRawCaptureController());
        lastCleanupAt = 0;
        startCleanupTimer();
        cleanupRawCaptureOnInit();
        if (config.REQUEST_AUDIT_ANALYZER_ENABLED !== false && config.REQUEST_AUDIT_ANALYZER_ENABLED !== 'false') {
            const runAnalyzerOnInit = config.REQUEST_AUDIT_ANALYZER_RUN_ON_INIT === true || config.REQUEST_AUDIT_ANALYZER_RUN_ON_INIT === 'true';
            analyzerRunner = createRequestAuditAnalyzerRunner({
                auditStore: store,
                analysisStore: materializedStore,
                intervalMs: config.REQUEST_AUDIT_ANALYZER_INTERVAL_MS || 60000,
                lookbackMinutes: config.REQUEST_AUDIT_ANALYZER_LOOKBACK_MINUTES || 180,
                maxEvents: config.REQUEST_AUDIT_ANALYZER_MAX_EVENTS || 5000,
                runOnInit: false
            });
            analyzerRunner.start();
            if (runAnalyzerOnInit) {
                const scheduledRunner = analyzerRunner;
                analyzerRunOnInitHandle = setImmediate(() => {
                    analyzerRunOnInitHandle = null;
                    if (acceptingAuditContext && analyzerRunner === scheduledRunner) {
                        void scheduledRunner.run();
                    }
                });
                analyzerRunOnInitHandle.unref?.();
            }
        }
        logger.info(`[Request Audit] Initialized enabled=${enabled}`);
    },

    destroy() {
        if (destroyPromise) return destroyPromise;

        acceptingAuditContext = false;
        enabled = false;
        pendingUsage.clear();
        pendingAuditContexts.clear();
        finalizedRequestIds.clear();
        if (cleanupTimer) {
            clearInterval(cleanupTimer);
            cleanupTimer = null;
        }
        if (analyzerRunOnInitHandle) {
            clearImmediate(analyzerRunOnInitHandle);
            analyzerRunOnInitHandle = null;
        }
        setRawCaptureController(null);

        const analyzerDrain = analyzerRunner?.stop?.() || Promise.resolve({ failureCount: 0 });
        analyzerRunner = null;
        const cleanupDrain = cleanupPromise || Promise.resolve();

        destroyPromise = (async () => {
            const [analyzerResult] = await Promise.all([analyzerDrain, cleanupDrain, drainAuditQueue(), drainExecutionRawCaptureQueue()]);
            if (analyzerResult?.failureCount > 0) {
                recordAuditLoss('analyzer failure', analyzerResult.failureCount);
            }
            rawCaptureStore = null;
            rawCaptureOptions = { enabled: false, keyHashes: [] };
            rawCaptureEventSink = null;
            rawCaptureConfigTarget = null;
            rawCaptureStopReason = null;
            executionRawCaptureQueue.length = 0;
            executionRawCaptureFlushPromise = null;
            store = null;

            const shutdownError = buildShutdownError();
            logger.info('[Request Audit] Destroyed');
            if (shutdownError) throw shutdownError;
        })();

        return destroyPromise;
    },

    hooks: {
        async onUpstreamRequestPrepared(context = {}) {
            if (!enabled || !acceptingAuditContext || !rawCaptureStore) return;
            const event = {
                schemaVersion: 1,
                requestId: getRequestId(context),
                timestamp: new Date().toISOString(),
                potluckKey: maskPotluckKey(context.potluckApiKey),
                request: {
                    model: context.model || null,
                    providerUuidHash: hashSecret(context.providerUuid),
                    workerId: context.workerId || process.env.RUNTIME_WORKER_ID || null,
                    finalPromptCacheKeyHash: hashSecret(context.finalPromptCacheKey, 32),
                    keySource: context.cacheKeySource || null,
                    coordinationStatus: context.cacheCoordinationStatus || null,
                    templateFingerprint: context.templateFingerprint || null
                }
            };
            if (!event.requestId || !shouldCaptureRawRequest(rawCaptureOptions, event)) return;
            if (executionRawCaptureQueue.length >= MAX_EXECUTION_RAW_CAPTURE_QUEUE) {
                recordAuditLoss('execution raw capture queue overflow');
                return;
            }
            executionRawCaptureQueue.push({
                event,
                context: {
                    originalRequestBody: context.originalRequestBody,
                    processedRequestBody: context.upstreamRequestBody
                }
            });
            scheduleExecutionRawCapture();
        },

        async onUnaryResponse({ requestId, nativeResponse, clientResponse }) {
            if (!enabled || !acceptingAuditContext || !requestId) return;
            setPendingUsage(requestId, extractUsage(nativeResponse, clientResponse));
            observeImageResult(requestId, nativeResponse, clientResponse);
        },

        async onStreamChunk({ requestId, nativeChunk, chunkToSend }) {
            if (!enabled || !acceptingAuditContext || !requestId) return;
            setPendingUsage(requestId, extractUsage(nativeChunk, chunkToSend));
            observeImageResult(requestId, nativeChunk, chunkToSend);
        },

        async onContentGenerated(context = {}) {
            if (!enabled || !acceptingAuditContext) return;
            const requestId = getRequestId(context);
            if (!requestId) return;

            try {
                if (context._runtimeUsage) setPendingUsage(requestId, extractUsage(context._runtimeUsage));
                if (context._runtimeHasImage === true) {
                    const entry = pendingUsage.get(requestId) || { usage: normalizeUsage({}), updatedAt: Date.now() };
                    entry.hasImageResult = true;
                    entry.updatedAt = Date.now();
                    pendingUsage.set(requestId, entry);
                }
                if (context._requestAuditLifecycle === true) {
                    setPendingUsage(requestId, {});
                    pendingAuditContexts.set(requestId, { ...context, requestId });
                    return;
                }
                await enqueueFinalAudit(context);
            } catch (error) {
                logger.warn('[Request Audit] Failed to enqueue audit event:', error.message);
                if (context._runtimeEventId) throw error;
            }
        },

        async onRequestCompleted(context = {}) {
            if (!enabled || !acceptingAuditContext) return;
            const requestId = getRequestId(context);
            if (!requestId || finalizedRequestIds.has(requestId)) return;
            try {
                const generatedContext = pendingAuditContexts.get(requestId) || {};
                await enqueueFinalAudit({ ...generatedContext, ...context, requestId });
            } catch (error) {
                logger.warn('[Request Audit] Failed to finalize audit event:', error.message);
                pendingUsage.delete(requestId);
                pendingAuditContexts.delete(requestId);
                if (context._runtimeEventId) throw error;
            }
        }
    }
};

export default requestAuditPlugin;
