import http from 'http';
import path from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { createRuntimeProxyHandler } from './runtime-proxy.js';
import { resolveWorkerTopology } from './worker-topology.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerScript = path.join(__dirname, '../services/api-server.js');

function addMapValues(target, source = {}) {
    for (const [key, value] of Object.entries(source)) target[key] = (target[key] || 0) + Number(value || 0);
}

function nonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeUsageLedgerSnapshot(snapshot = {}) {
    const projections = {};
    let projectionLag = 0;
    for (const [projectionName, projection] of Object.entries(snapshot.projections || {})) {
        const lag = nonNegativeNumber(projection?.lag);
        projections[projectionName] = {
            lag,
            attempts: nonNegativeNumber(projection?.attempts),
            oldestPendingAgeMs: nonNegativeNumber(projection?.oldestPendingAgeMs),
            lastError: typeof projection?.lastError === 'string' ? projection.lastError : null,
            lastSuccessAt: projection?.lastSuccessAt || null
        };
        projectionLag += lag;
    }
    return {
        events: nonNegativeNumber(snapshot.events),
        rawEvents: nonNegativeNumber(snapshot.rawEvents),
        pending: nonNegativeNumber(snapshot.pending),
        projectionLag,
        oldestPendingAgeMs: nonNegativeNumber(snapshot.oldestPendingAgeMs),
        databaseBytes: nonNegativeNumber(snapshot.databaseBytes),
        projections
    };
}

function mergeSharedUsageLedgerSnapshot(target, source) {
    target.events = Math.max(target.events, source.events);
    target.rawEvents = Math.max(target.rawEvents, source.rawEvents);
    target.pending = Math.max(target.pending, source.pending);
    target.oldestPendingAgeMs = Math.max(target.oldestPendingAgeMs, source.oldestPendingAgeMs);
    target.databaseBytes = Math.max(target.databaseBytes, source.databaseBytes);
    for (const [projectionName, projection] of Object.entries(source.projections)) {
        const current = target.projections[projectionName] || {
            lag: 0,
            attempts: 0,
            oldestPendingAgeMs: 0,
            lastError: null,
            lastSuccessAt: null
        };
        current.lag = Math.max(current.lag, projection.lag);
        current.attempts = Math.max(current.attempts, projection.attempts);
        current.oldestPendingAgeMs = Math.max(current.oldestPendingAgeMs, projection.oldestPendingAgeMs);
        if (projection.lastSuccessAt && (!current.lastSuccessAt || projection.lastSuccessAt > current.lastSuccessAt)) {
            current.lastSuccessAt = projection.lastSuccessAt;
        }
        if (projection.lastError) current.lastError = projection.lastError;
        target.projections[projectionName] = current;
    }
    target.projectionLag = Object.values(target.projections)
        .reduce((total, projection) => total + nonNegativeNumber(projection.lag), 0);
}

function addDistinctUsageLedgerSnapshot(target, source) {
    target.events += source.events;
    target.rawEvents += source.rawEvents;
    target.pending += source.pending;
    target.projectionLag += source.projectionLag;
    target.oldestPendingAgeMs = Math.max(target.oldestPendingAgeMs, source.oldestPendingAgeMs);
    target.databaseBytes += source.databaseBytes;
    for (const [projectionName, projection] of Object.entries(source.projections)) {
        const current = target.projections[projectionName] || {
            lag: 0,
            attempts: 0,
            oldestPendingAgeMs: 0,
            lastError: null,
            lastSuccessAt: null
        };
        current.lag += projection.lag;
        current.attempts = Math.max(current.attempts, projection.attempts);
        current.oldestPendingAgeMs = Math.max(current.oldestPendingAgeMs, projection.oldestPendingAgeMs);
        if (projection.lastSuccessAt && (!current.lastSuccessAt || projection.lastSuccessAt > current.lastSuccessAt)) {
            current.lastSuccessAt = projection.lastSuccessAt;
        }
        if (projection.lastError) current.lastError = projection.lastError;
        target.projections[projectionName] = current;
    }
}

/**
 * Return a logical persistence backlog without counting the same event once
 * in the ingress stream and again in the usage ledger/projection rows.
 */
export function getPersistenceBacklog(metrics = {}) {
    const hooks = metrics.hooks || {};
    const hookBacklog = nonNegativeNumber(hooks.pending)
        + nonNegativeNumber(hooks.spooled)
        + nonNegativeNumber(hooks.consumerLag);
    const ledger = metrics.usageLedger || {};
    const usageLedgerBacklog = Math.max(
        nonNegativeNumber(ledger.pending),
        nonNegativeNumber(ledger.projectionLag)
    );
    return {
        total: Math.max(hookBacklog, usageLedgerBacklog),
        hooks: hookBacklog,
        usageLedger: usageLedgerBacklog
    };
}

const CODEX_QUOTA_METRIC_FIELDS = [
    'codexQuotaFilterCalls',
    'codexQuotaFilterCacheHits',
    'codexQuotaFilterCacheMisses',
    'codexQuotaProvidersScanned',
    'codexQuotaUnavailableProviders',
    'codexQuotaCrossWorkerReuse',
    'codexQuotaSnapshotAgeMs',
    'activeSnapshots',
    'fastPathHits',
    'fastPathMisses',
    'fastPathFallbackFailures',
    'snapshotAgeMs',
    'cacheHitRatio'
];

function sanitizeCodexQuotaMetrics(snapshot = {}) {
    const sanitized = {};
    for (const field of CODEX_QUOTA_METRIC_FIELDS) {
        if (snapshot[field] !== undefined) sanitized[field] = Number(snapshot[field]) || 0;
    }
    return sanitized;
}

export function aggregateWorkerMetrics(workerSnapshots = new Map()) {
    const result = {
        requests: { total: 0, success: 0, failed: 0, byWorker: {}, byKind: {} },
        stages: { byWorker: {} },
        output: { bytes: 0, backpressureMs: 0 },
        hooks: { pending: 0, spooled: 0, spoolBytes: 0, dropped: 0, backpressured: 0, consumerLag: 0, oldestPendingAgeMs: 0, available: true, unavailableWorkers: [], byWorker: {} },
        usageLedger: {
            events: 0,
            rawEvents: 0,
            pending: 0,
            projectionLag: 0,
            oldestPendingAgeMs: 0,
            databaseBytes: 0,
            projections: {},
            byWorker: {}
        },
        usageEventBatch: {
            flushCount: 0,
            flushBySize: 0,
            flushByTimer: 0,
            flushByShutdown: 0,
            eventsAppended: 0,
            totalBatchSize: 0,
            averageBatchSize: 0,
            lastBatchSize: 0,
            lastFlushMs: 0,
            lastCommitMs: 0,
            failedBatches: 0,
            pending: 0,
            acceptedEvents: 0,
            rejectedEvents: 0,
            retryCount: 0,
            queuePending: 0,
            queueCapacity: 0,
            availableCapacity: 0,
            inFlight: 0,
            pollPaused: false,
            queueAgeMs: 0,
            byWorker: {}
        },
        runtimeHookPoller: {
            streamReadBatches: 0,
            streamReadEvents: 0,
            claimCount: 0,
            statusPollCount: 0,
            errors: 0,
            batchErrors: 0,
            enqueuedEvents: 0,
            rejectedEvents: 0,
            pollPaused: false,
            lastError: null,
            byWorker: {}
        },
        imageCapacity: {
            activeBytes: 0,
            queued: 0,
            globalUsedBytes: 0,
            globalBudgetBytes: 0,
            overcommitted: 0,
            coordinationFailures: 0,
            redisDegraded: false,
            byWorker: {}
        },
        pricingDiagnostics: {
            estimatedAverageCount: 0,
            estimatedAverageTokens: 0,
            estimatedAverageUsd: 0,
            missingPriceCount: 0,
            missingPriceTokens: 0,
            lastEstimatedAt: null,
            lastMissingAt: null,
            byWorker: {}
        },
        temporaryRouting: {
            scheduledBypasses: 0,
            calendarDegraded: false,
            missingCalendarYears: [],
            byWorker: {}
        },
        inFlight: 0,
        process: { rss: 0, heapUsed: 0, maxEventLoopUtilization: 0, eventLoopDelay: { p95: 0, p99: 0, max: 0 } },
        providerCoordination: {
            byWorker: {},
            geminiScheduling: {
                cooldownWrites: 0,
                probeAcquired: 0,
                probeRejected: 0,
                rateLimited: 0,
                retryAttempts: 0,
                fallbacks: 0,
                byModel: {}
            }
        },
        codexQuotaFilter: {
            codexQuotaFilterCalls: 0,
            codexQuotaFilterCacheHits: 0,
            codexQuotaFilterCacheMisses: 0,
            codexQuotaProvidersScanned: 0,
            codexQuotaUnavailableProviders: 0,
            codexQuotaCrossWorkerReuse: 0,
            codexQuotaSnapshotAgeMs: 0,
            activeSnapshots: 0,
            fastPathHits: 0,
            fastPathMisses: 0,
            fastPathFallbackFailures: 0,
            cacheHitRatio: 0,
            byWorker: {}
        },
        potluckQuota: {
            localDegradedRequests: 0,
            localRejected: 0,
            coordinationErrors: 0,
            finalizeErrors: 0,
            reservations: 0,
            rejected: 0,
            settled: 0,
            released: 0,
            idempotent: 0,
            errors: 0,
            localReservations: 0,
            pendingUsage: 0,
            byWorker: {}
        },
        requestAudit: {
            runs: 0,
            failures: 0,
            skippedRuns: 0,
            lastRunMs: 0,
            lastScannedFiles: 0,
            lastScannedBytes: 0,
            lastEventCount: 0,
            lastCompletedAt: null,
            activeWorkers: [],
            byWorker: {}
        }
    };
    let usageBatchWorkersWithCapacity = 0;
    let explicitHookLayers = false;
    let outboundPendingTotal = 0;
    let streamPendingTotal = 0;
    const usageLedgerSources = new Map();
    for (const [workerId, snapshot] of workerSnapshots.entries()) {
        result.requests.total += Number(snapshot?.requests?.total || 0);
        result.requests.success += Number(snapshot?.requests?.success || 0);
        result.requests.failed += Number(snapshot?.requests?.failed || 0);
        addMapValues(result.requests.byWorker, snapshot?.requests?.byWorker);
        addMapValues(result.requests.byKind, snapshot?.requests?.byKind);
        if (snapshot?.stages) {
            result.stages.byWorker[workerId] = snapshot.stages;
            for (const [stageName, stage] of Object.entries(snapshot.stages)) {
                const aggregate = result.stages[stageName] || {
                    count: 0,
                    p50: 0,
                    p95: 0,
                    p99: 0,
                    max: 0
                };
                aggregate.count += Number(stage?.count || 0);
                for (const field of ['p50', 'p95', 'p99', 'max']) {
                    aggregate[field] = Math.max(aggregate[field], Number(stage?.[field] || 0));
                }
                result.stages[stageName] = aggregate;
            }
        }
        result.output.bytes += Number(snapshot?.output?.bytes || 0);
        result.output.backpressureMs += Number(snapshot?.output?.backpressureMs || 0);
        result.inFlight += Number(snapshot?.inFlight || 0);
        if (snapshot?.hooks) {
            result.hooks.byWorker[workerId] = snapshot.hooks;
            if (snapshot.hooks.outboundPending !== undefined || snapshot.hooks.streamPending !== undefined) {
                explicitHookLayers = true;
                outboundPendingTotal += Number(snapshot.hooks.outboundPending || 0);
                streamPendingTotal += Number(snapshot.hooks.streamPending || 0);
            }
            if (snapshot.hooks.available === false) {
                result.hooks.available = false;
                result.hooks.unavailableWorkers.push(workerId);
            }
            for (const field of ['pending', 'spooled', 'spoolBytes', 'dropped', 'backpressured', 'consumerLag']) {
                result.hooks[field] += Number(snapshot.hooks[field] || 0);
            }
            result.hooks.oldestPendingAgeMs = Math.max(result.hooks.oldestPendingAgeMs, Number(snapshot.hooks.oldestPendingAgeMs || 0));
        }
        const usageLedgerSnapshot = snapshot?.usageLedger || snapshot?.hooks?.usageLedger;
        if (usageLedgerSnapshot && typeof usageLedgerSnapshot === 'object') {
            const normalizedLedger = normalizeUsageLedgerSnapshot(usageLedgerSnapshot);
            result.usageLedger.byWorker[workerId] = normalizedLedger;
            const sourceKey = typeof usageLedgerSnapshot.dbPath === 'string' && usageLedgerSnapshot.dbPath
                ? `db:${usageLedgerSnapshot.dbPath}`
                : `worker:${workerId}`;
            const sharedLedger = usageLedgerSources.get(sourceKey);
            if (sharedLedger) mergeSharedUsageLedgerSnapshot(sharedLedger, normalizedLedger);
            else usageLedgerSources.set(sourceKey, normalizedLedger);
        }
        if (snapshot?.usageEventBatch) {
            const batch = snapshot.usageEventBatch;
            result.usageEventBatch.byWorker[workerId] = batch;
            for (const field of [
                'flushCount', 'flushBySize', 'flushByTimer', 'flushByShutdown',
                'eventsAppended', 'totalBatchSize', 'failedBatches', 'pending',
                'acceptedEvents', 'rejectedEvents', 'retryCount', 'queuePending', 'inFlight'
            ]) {
                result.usageEventBatch[field] += Number(batch[field] || 0);
            }
            result.usageEventBatch.queueCapacity = Math.max(
                result.usageEventBatch.queueCapacity,
                Number(batch.queueCapacity || 0)
            );
            if (Number(batch.queueCapacity || 0) > 0) {
                const available = Number(batch.availableCapacity || 0);
                result.usageEventBatch.availableCapacity = usageBatchWorkersWithCapacity === 0
                    ? available
                    : Math.min(result.usageEventBatch.availableCapacity, available);
                usageBatchWorkersWithCapacity += 1;
            }
            result.usageEventBatch.pollPaused ||= batch.pollPaused === true;
            result.usageEventBatch.lastBatchSize = Math.max(result.usageEventBatch.lastBatchSize, Number(batch.lastBatchSize || 0));
            result.usageEventBatch.lastFlushMs = Math.max(result.usageEventBatch.lastFlushMs, Number(batch.lastFlushMs || 0));
            result.usageEventBatch.lastCommitMs = Math.max(result.usageEventBatch.lastCommitMs, Number(batch.lastCommitMs || batch.lastFlushMs || 0));
            result.usageEventBatch.queueAgeMs = Math.max(result.usageEventBatch.queueAgeMs, Number(batch.queueAgeMs || 0));
        }
        if (snapshot?.runtimeHookPoller) {
            const poller = snapshot.runtimeHookPoller;
            result.runtimeHookPoller.byWorker[workerId] = poller;
            for (const field of [
                'streamReadBatches', 'streamReadEvents', 'claimCount', 'statusPollCount',
                'errors', 'batchErrors', 'enqueuedEvents', 'rejectedEvents'
            ]) {
                result.runtimeHookPoller[field] += Number(poller[field] || 0);
            }
            result.runtimeHookPoller.pollPaused ||= poller.pollPaused === true;
            if (poller.lastError) result.runtimeHookPoller.lastError = poller.lastError;
        }
        result.process.rss += Number(snapshot?.process?.rss || 0);
        result.process.heapUsed += Number(snapshot?.process?.heapUsed || 0);
        result.process.maxEventLoopUtilization = Math.max(result.process.maxEventLoopUtilization, Number(snapshot?.process?.eventLoopUtilization || 0));
        result.process.eventLoopDelay.p95 = Math.max(result.process.eventLoopDelay.p95, Number(snapshot?.process?.eventLoopDelay?.p95 || 0));
        result.process.eventLoopDelay.p99 = Math.max(result.process.eventLoopDelay.p99, Number(snapshot?.process?.eventLoopDelay?.p99 || 0));
        result.process.eventLoopDelay.max = Math.max(result.process.eventLoopDelay.max, Number(snapshot?.process?.eventLoopDelay?.max || 0));
        if (snapshot?.imageCapacity) {
            result.imageCapacity.byWorker[workerId] = snapshot.imageCapacity;
            result.imageCapacity.activeBytes += Number(snapshot.imageCapacity.activeBytes || 0);
            result.imageCapacity.queued += Number(snapshot.imageCapacity.queued || 0);
            result.imageCapacity.globalUsedBytes = Math.max(result.imageCapacity.globalUsedBytes, Number(snapshot.imageCapacity.globalUsedBytes || 0));
            result.imageCapacity.globalBudgetBytes = Math.max(result.imageCapacity.globalBudgetBytes, Number(snapshot.imageCapacity.globalBudgetBytes || 0));
            result.imageCapacity.overcommitted += Number(snapshot.imageCapacity.overcommitted || 0);
            result.imageCapacity.coordinationFailures += Number(snapshot.imageCapacity.coordinationFailures || 0);
            result.imageCapacity.redisDegraded ||= snapshot.imageCapacity.redisDegraded === true;
        }
        if (snapshot?.pricingDiagnostics) {
            result.pricingDiagnostics.byWorker[workerId] = snapshot.pricingDiagnostics;
            for (const field of ['estimatedAverageCount', 'estimatedAverageTokens', 'estimatedAverageUsd', 'missingPriceCount', 'missingPriceTokens']) {
                result.pricingDiagnostics[field] += Number(snapshot.pricingDiagnostics[field] || 0);
            }
            for (const field of ['lastEstimatedAt', 'lastMissingAt']) {
                const current = result.pricingDiagnostics[field];
                const candidate = snapshot.pricingDiagnostics[field];
                if (candidate && (!current || candidate > current)) result.pricingDiagnostics[field] = candidate;
            }
        }
        if (snapshot?.temporaryRouting) {
            result.temporaryRouting.byWorker[workerId] = snapshot.temporaryRouting;
            result.temporaryRouting.scheduledBypasses += Number(snapshot.temporaryRouting.scheduledBypasses || 0);
            result.temporaryRouting.calendarDegraded ||= snapshot.temporaryRouting.calendarDegraded === true;
            result.temporaryRouting.missingCalendarYears.push(
                ...(Array.isArray(snapshot.temporaryRouting.missingCalendarYears)
                    ? snapshot.temporaryRouting.missingCalendarYears.map(Number).filter(Number.isInteger)
                    : [])
            );
        }
        if (snapshot?.providerCoordination) {
            result.providerCoordination.byWorker[workerId] = snapshot.providerCoordination;
            for (const field of ['cooldownWrites', 'probeAcquired', 'probeRejected', 'rateLimited', 'retryAttempts', 'fallbacks']) {
                result.providerCoordination.geminiScheduling[field] += Number(snapshot.providerCoordination?.geminiScheduling?.[field] || 0);
            }
            for (const [model, modelSnapshot] of Object.entries(snapshot.providerCoordination?.geminiScheduling?.byModel || {})) {
                const aggregate = result.providerCoordination.geminiScheduling.byModel[model] || {
                    schedulable: 0,
                    cooling: 0,
                    quotaUnknown: 0
                };
                for (const field of ['schedulable', 'cooling', 'quotaUnknown']) {
                    aggregate[field] = Math.max(aggregate[field], Number(modelSnapshot?.[field] || 0));
                }
                result.providerCoordination.geminiScheduling.byModel[model] = aggregate;
            }
        }
        if (snapshot?.codexQuotaFilter) {
            const quota = snapshot.codexQuotaFilter;
            const sanitizedQuota = sanitizeCodexQuotaMetrics(quota);
            result.codexQuotaFilter.byWorker[workerId] = sanitizedQuota;
            for (const field of [
                'codexQuotaFilterCalls',
                'codexQuotaFilterCacheHits',
                'codexQuotaFilterCacheMisses',
                'codexQuotaProvidersScanned',
                'codexQuotaUnavailableProviders',
                'codexQuotaCrossWorkerReuse',
                'activeSnapshots',
                'fastPathHits',
                'fastPathMisses',
                'fastPathFallbackFailures'
            ]) {
                result.codexQuotaFilter[field] += Number(sanitizedQuota[field] || 0);
            }
            result.codexQuotaFilter.codexQuotaSnapshotAgeMs = Math.max(
                result.codexQuotaFilter.codexQuotaSnapshotAgeMs,
                Number(sanitizedQuota.codexQuotaSnapshotAgeMs ?? sanitizedQuota.snapshotAgeMs ?? 0)
            );
        }
        if (snapshot?.potluckQuota) {
            result.potluckQuota.byWorker[workerId] = snapshot.potluckQuota;
            for (const field of ['localDegradedRequests', 'localRejected', 'coordinationErrors', 'finalizeErrors', 'localReservations', 'pendingUsage']) {
                result.potluckQuota[field] += Number(snapshot.potluckQuota[field] || 0);
            }
            for (const field of ['reservations', 'rejected', 'settled', 'released', 'idempotent', 'errors']) {
                result.potluckQuota[field] += Number(snapshot.providerCoordination?.potluckQuota?.[field] || 0);
            }
        }
        if (snapshot?.requestAudit) {
            result.requestAudit.byWorker[workerId] = snapshot.requestAudit;
            for (const field of ['runs', 'failures', 'skippedRuns', 'lastScannedFiles', 'lastScannedBytes', 'lastEventCount']) {
                result.requestAudit[field] += Number(snapshot.requestAudit[field] || 0);
            }
            result.requestAudit.lastRunMs = Math.max(
                result.requestAudit.lastRunMs,
                Number(snapshot.requestAudit.lastRunMs || 0)
            );
            if (snapshot.requestAudit.active === true) result.requestAudit.activeWorkers.push(workerId);
            const completedAt = snapshot.requestAudit.lastCompletedAt;
            if (completedAt && (!result.requestAudit.lastCompletedAt || completedAt > result.requestAudit.lastCompletedAt)) {
                result.requestAudit.lastCompletedAt = completedAt;
            }
        }
    }
    result.temporaryRouting.missingCalendarYears = [...new Set(result.temporaryRouting.missingCalendarYears)]
        .sort((a, b) => a - b);
    const quotaCalls = result.codexQuotaFilter.codexQuotaFilterCalls;
    result.codexQuotaFilter.cacheHitRatio = quotaCalls > 0
        ? result.codexQuotaFilter.codexQuotaFilterCacheHits / quotaCalls
        : 0;
    if (result.usageEventBatch.flushCount > 0) {
        result.usageEventBatch.averageBatchSize = result.usageEventBatch.totalBatchSize / result.usageEventBatch.flushCount;
    }
    for (const ledger of usageLedgerSources.values()) addDistinctUsageLedgerSnapshot(result.usageLedger, ledger);
    if (explicitHookLayers) result.hooks.pending = Math.max(outboundPendingTotal, streamPendingTotal);
    return result;
}

export function resolveRuntimeHealthStatus({ topologyReady, metrics } = {}) {
    if (!topologyReady) return 'starting';
    if (metrics?.hooks?.available === false || metrics?.temporaryRouting?.calendarDegraded === true) {
        return 'degraded';
    }
    return 'healthy';
}

export async function shutdownWorkerStages({
    closeProxy,
    stopRole,
    getBacklog,
    wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
    drainTimeoutMs = 30000
} = {}) {
    await closeProxy();
    await stopRole('execution');
    const deadline = Date.now() + drainTimeoutMs;
    while (Number(getBacklog?.() || 0) > 0 && Date.now() < deadline) await wait(50);
    const remainingBacklog = Number(getBacklog?.() || 0);
    await stopRole('control');
    return { drained: remainingBacklog === 0, remainingBacklog };
}

export function createProviderConfigAckTracker() {
    let currentRevision = 0;
    const appliedRevisions = new Map();
    return {
        notePublished(revision, workerIds = []) {
            currentRevision = Math.max(currentRevision, Number(revision || 0));
            for (const workerId of workerIds) {
                if (!appliedRevisions.has(workerId)) appliedRevisions.set(workerId, 0);
            }
        },
        acknowledge(workerId, revision) {
            if (!workerId) return;
            appliedRevisions.set(workerId, Math.max(Number(revision || 0), appliedRevisions.get(workerId) || 0));
        },
        remove(workerId) {
            appliedRevisions.delete(workerId);
        },
        snapshot(workerIds = []) {
            const revisions = Object.fromEntries(workerIds.map(workerId => [workerId, appliedRevisions.get(workerId) || 0]));
            const pendingWorkers = workerIds.filter(workerId => (revisions[workerId] || 0) < currentRevision);
            return {
                currentRevision,
                pendingWorkerCount: pendingWorkers.length,
                workerRevisions: revisions
            };
        }
    };
}

export function buildKeyConfigSyncAck(result) {
    return {
        epoch: typeof result?.epoch === 'string' && result.epoch ? result.epoch : null,
        revision: Number.isInteger(Number(result?.revision)) ? Number(result.revision) : 0,
        applied: result?.applied === true
    };
}

export function isCurrentWorkerInstance(workers, id, child) {
    return workers?.get(id)?.child === child;
}

export function createKeyConfigAckTracker() {
    let currentEpoch = null;
    let currentRevision = 0;
    const workerStates = new Map();
    return {
        notePublished(epoch, revision, workerIds = []) {
            const normalizedEpoch = typeof epoch === 'string' && epoch ? epoch : null;
            const normalizedRevision = Number(revision || 0);
            if (!normalizedEpoch || !Number.isInteger(normalizedRevision) || normalizedRevision <= 0) return;
            if (normalizedEpoch !== currentEpoch || normalizedRevision >= currentRevision) {
                currentEpoch = normalizedEpoch;
                currentRevision = normalizedRevision;
            }
            for (const workerId of workerIds) {
                if (!workerStates.has(workerId)) workerStates.set(workerId, { epoch: null, revision: 0 });
            }
        },
        acknowledge(workerId, epoch, revision) {
            if (!workerId) return;
            const normalizedEpoch = typeof epoch === 'string' && epoch ? epoch : null;
            const normalizedRevision = Number(revision || 0);
            if (!normalizedEpoch || !Number.isInteger(normalizedRevision) || normalizedRevision < 0) return;
            workerStates.set(workerId, { epoch: normalizedEpoch, revision: normalizedRevision });
        },
        remove(workerId) {
            workerStates.delete(workerId);
        },
        snapshot(workerIds = []) {
            const states = {};
            const pendingWorkers = [];
            for (const workerId of workerIds) {
                const state = workerStates.get(workerId) || { epoch: null, revision: 0 };
                states[workerId] = { ...state };
                if (state.epoch !== currentEpoch || state.revision < currentRevision) pendingWorkers.push(workerId);
            }
            return {
                currentEpoch,
                currentRevision,
                pendingWorkerCount: pendingWorkers.length,
                pendingWorkers,
                workerStates: states
            };
        }
    };
}

export function startMultiWorkerRuntime({ env = process.env, args = process.argv.slice(2), logger = console } = {}) {
    const topology = resolveWorkerTopology(env);
    const publicPort = Number(env.RUNTIME_PUBLIC_PORT || 3000);
    const internalBasePort = Number(env.RUNTIME_INTERNAL_BASE_PORT || 3200);
    const epoch = env.RUNTIME_DEPLOYMENT_EPOCH || `local-${Date.now()}`;
    const workers = new Map();
    const workerMetrics = new Map();
    const providerConfigAcks = createProviderConfigAckTracker();
    const rawCaptureConfigAcks = createProviderConfigAckTracker();
    const potluckKeyConfigAcks = createKeyConfigAckTracker();
    const latestProviderConfigEvents = new Map();
    let latestRawCaptureConfigEvent = null;
    let latestPotluckKeyConfigEvent = null;
    const ready = new Set();
    let shuttingDown = false;

    const spawnWorker = (role, index, port) => {
        const id = role === 'control' ? 'control-1' : `execution-${index + 1}`;
        const child = fork(workerScript, [...args, '--host', '127.0.0.1', '--port', String(port)], {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            env: {
                ...env,
                IS_WORKER_PROCESS: 'true',
                RUNTIME_WORKER_ROLE: role,
                RUNTIME_WORKER_ID: id,
                RUNTIME_DEPLOYMENT_EPOCH: epoch
            }
        });
        workers.set(id, { id, role, port, child });
        child.on('message', message => {
            if (!isCurrentWorkerInstance(workers, id, child)) return;
            if (message?.type === 'ready') {
                ready.add(id);
                if (role === 'execution') {
                    providerConfigAcks.acknowledge(id, Number(message.providerConfigRevision || 0));
                    potluckKeyConfigAcks.acknowledge(
                        id,
                        message.potluckKeyConfigEpoch || null,
                        Number(message.potluckKeyConfigRevision || message.potluckKeyRoutingRevision || 0)
                    );
                    const replayEvents = [...latestProviderConfigEvents.values()].sort((left, right) => left.revision - right.revision);
                    for (const event of replayEvents) {
                        if (child.connected) child.send({ ...event, targetWorkerId: id });
                    }
                    if (latestRawCaptureConfigEvent && child.connected) {
                        rawCaptureConfigAcks.notePublished(latestRawCaptureConfigEvent.revision, [id]);
                        child.send({ ...latestRawCaptureConfigEvent, targetWorkerId: id });
                    }
                    if (latestPotluckKeyConfigEvent && child.connected) {
                        potluckKeyConfigAcks.notePublished(latestPotluckKeyConfigEvent.epoch, latestPotluckKeyConfigEvent.revision, [id]);
                        child.send({ ...latestPotluckKeyConfigEvent, targetWorkerId: id });
                    }
                }
                if (role === 'control') {
                    for (const worker of workers.values()) {
                        if (worker.role === 'execution' && worker.child.connected) worker.child.send({ type: 'runtime_hook_retry' });
                    }
                }
            }
            if (message?.type === 'runtime_hook') {
                workers.get('control-1')?.child.send({ ...message, sourceWorkerId: id });
            }
            if (message?.type === 'runtime_hook_ack') {
                const target = workers.get(message.sourceWorkerId);
                if (target?.child.connected) target.child.send(message);
            }
            if (message?.type === 'provider_state') {
                for (const worker of workers.values()) {
                    if (worker.child !== child && worker.child.connected) worker.child.send(message);
                }
            }
            if (message?.type === 'provider_identity_discovered' && role === 'execution') {
                const control = workers.get('control-1');
                if (control?.child.connected) control.child.send(message);
            }
            if (message?.type === 'provider_config_sync' && role === 'control') {
                latestProviderConfigEvents.set(message.providerType, { ...message });
                const executionIds = [...workers.values()]
                    .filter(worker => worker.role === 'execution' && (!message.targetWorkerId || message.targetWorkerId === worker.id))
                    .map(worker => worker.id);
                providerConfigAcks.notePublished(message.revision, executionIds);
                for (const worker of workers.values()) {
                    if (worker.role === 'execution' && worker.child.connected && (!message.targetWorkerId || message.targetWorkerId === worker.id)) worker.child.send(message);
                }
            }
            if (message?.type === 'provider_config_sync_ack' && role === 'execution') {
                providerConfigAcks.acknowledge(id, message.revision);
                const control = workers.get('control-1');
                if (control?.child.connected) control.child.send({
                    type: 'provider_config_sync_status',
                    ...providerConfigAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id))
                });
            }
            if (message?.type === 'request_audit_raw_capture_sync' && role === 'control') {
                latestRawCaptureConfigEvent = { ...message };
                const executionIds = [...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id);
                rawCaptureConfigAcks.notePublished(message.revision, executionIds);
                for (const worker of workers.values()) {
                    if (worker.role === 'execution' && worker.child.connected) worker.child.send(message);
                }
            }
            if (message?.type === 'request_audit_raw_capture_sync_ack' && role === 'execution') {
                rawCaptureConfigAcks.acknowledge(id, message.revision);
                const control = workers.get('control-1');
                if (control?.child.connected) control.child.send({
                    type: 'request_audit_raw_capture_sync_status',
                    ...rawCaptureConfigAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id))
                });
            }
            if (message?.type === 'potluck_key_config_sync' && role === 'control') {
                latestPotluckKeyConfigEvent = { ...message };
                const executionIds = [...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id);
                potluckKeyConfigAcks.notePublished(message.epoch, message.revision, executionIds);
                for (const worker of workers.values()) {
                    if (worker.role === 'execution' && worker.child.connected) worker.child.send(message);
                }
            }
            if (message?.type === 'potluck_key_config_sync_ack' && role === 'execution') {
                potluckKeyConfigAcks.acknowledge(id, message.epoch, message.revision);
                const control = workers.get('control-1');
                if (control?.child.connected) control.child.send({
                    type: 'potluck_key_config_sync_status',
                    ...potluckKeyConfigAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id))
                });
            }
            if (message?.type === 'runtime_metrics' && message.snapshot) {
                workerMetrics.set(id, message.snapshot);
                // A metrics snapshot is emitted immediately before the explicit ready message.
                // Treat it as equivalent readiness evidence so a lost IPC ready frame cannot
                // leave a successfully restarted worker stuck in "starting" forever.
                ready.add(id);
            }
        });
        child.on('exit', (code, signal) => {
            if (!isCurrentWorkerInstance(workers, id, child)) return;
            ready.delete(id);
            workers.delete(id);
            workerMetrics.delete(id);
            providerConfigAcks.remove(id);
            rawCaptureConfigAcks.remove(id);
            potluckKeyConfigAcks.remove(id);
            if (!shuttingDown) {
                logger.error?.(`[Runtime] ${id} exited code=${code} signal=${signal}; restarting`);
                setTimeout(() => spawnWorker(role, index, port), 1000).unref?.();
            }
        });
        return child;
    };

    const controlPort = internalBasePort + 1;
    spawnWorker('control', 0, controlPort);
    const executionTargets = [];
    for (let index = 0; index < topology.executionWorkers; index++) {
        const port = internalBasePort + 11 + index;
        executionTargets.push({ host: '127.0.0.1', port });
        spawnWorker('execution', index, port);
    }

    const buildRuntimeStatus = () => {
        const metrics = aggregateWorkerMetrics(workerMetrics);
        const topologyReady = ready.size === topology.executionWorkers + 1;
        return {
            status: resolveRuntimeHealthStatus({ topologyReady, metrics }),
            epoch,
            controlWorkers: [...workers.values()].filter(worker => worker.role === 'control').length,
            executionWorkers: [...workers.values()].filter(worker => worker.role === 'execution').length,
            readyWorkers: ready.size,
            coordination: 'redis',
            leaseRecovery: 'ready',
            persistenceBacklog: getPersistenceBacklog(metrics).total,
            persistenceBacklogByLayer: getPersistenceBacklog(metrics),
            providerConfig: providerConfigAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id)),
            rawCapture: rawCaptureConfigAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id)),
            potluckKeyConfig: potluckKeyConfigAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id)),
            potluckRouting: potluckKeyConfigAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id)),
            runtimeHooks: metrics.hooks,
            metrics
        };
    };

    const proxy = http.createServer(createRuntimeProxyHandler({
        controlTarget: { host: '127.0.0.1', port: controlPort },
        executionTargets,
        isTargetReady: (role, index) => role === 'control'
            ? ready.has('control-1')
            : ready.has(`execution-${Number(index) + 1}`),
        onProxyError: (error, detail) => logger.error?.(`[Runtime Proxy] ${detail.role} ${detail.target.port}: ${error.message}`),
        getRuntimeStatus: buildRuntimeStatus
    }));
    proxy.requestTimeout = 0;
    proxy.headersTimeout = 60000;
    proxy.keepAliveTimeout = 65000;
    proxy.listen(publicPort, env.RUNTIME_PUBLIC_HOST || '0.0.0.0', () => {
        logger.info?.(`[Runtime] Public proxy listening on ${publicPort}; control=1 execution=${topology.executionWorkers} epoch=${epoch}`);
    });

    const shutdown = async exitCode => {
        if (shuttingDown) return;
        shuttingDown = true;
        const stopRole = async role => {
            const exits = [...workers.values()].filter(worker => worker.role === role).map(worker => new Promise(resolve => {
                const timeout = setTimeout(() => { worker.child.kill('SIGKILL'); resolve(); }, 30000);
                worker.child.once('exit', () => { clearTimeout(timeout); resolve(); });
                if (worker.child.connected) worker.child.send({ type: 'shutdown', phase: role === 'execution' ? 'drain' : 'persist' });
                else worker.child.kill('SIGTERM');
            }));
            await Promise.allSettled(exits);
        };
        const result = await shutdownWorkerStages({
            closeProxy: () => new Promise(resolve => proxy.close(resolve)),
            stopRole,
            getBacklog: () => {
                return getPersistenceBacklog(aggregateWorkerMetrics(workerMetrics)).total;
            }
        });
        if (!result.drained) logger.error?.(`[Runtime] Hook drain timed out with backlog=${result.remainingBacklog}`);
        process.exit(exitCode);
    };
    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));

    return {
        proxy,
        workers,
        ready,
        topology,
        getStatus: buildRuntimeStatus,
        shutdown
    };
}
