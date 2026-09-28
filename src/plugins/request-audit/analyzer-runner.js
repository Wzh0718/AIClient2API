import logger from '../../utils/logger.js';
import { buildDiagnostics, diagnoseCacheMiss } from './cache-diagnostics.js';
import { captureStatus, isCodexTextAudit } from './capture-status.js';

const MAX_SCAN_BYTES = 32 * 1024 * 1024;

function compactDiagnosticEvent(event) {
    return {
        requestId: event.requestId,
        timestamp: event.timestamp,
        potluckKey: { hash: event.potluckKey?.hash || null },
        request: { model: event.request?.model || null },
        account: { providerUuidHash: event.account?.providerUuidHash || null },
        usage: {
            promptTokens: Number(event.usage?.promptTokens || 0),
            cachedTokens: Number(event.usage?.cachedTokens || 0)
        },
        cache: {
            templateFingerprint: event.cache?.templateFingerprint || null,
            finalPromptCacheKeyHash: event.cache?.finalPromptCacheKeyHash || null,
            ...(event.cache?.theoreticalCacheRatio != null
                ? { theoreticalCacheRatio: event.cache.theoreticalCacheRatio } : {}),
            instructionsHash: event.cache?.instructionsHash || null,
            toolsHash: event.cache?.toolsHash || null,
            upstreamPrefixHashes: event.cache?.upstreamPrefixHashes || []
        },
        fingerprint: event.fingerprint ? {
            instructionsHash: event.fingerprint.instructionsHash || null,
            toolsHash: event.fingerprint.toolsHash || null,
            prefixHashes: event.fingerprint.prefixHashes || []
        } : undefined
    };
}

async function runIncrementalAnalyzer({ auditStore, analysisStore, since, until, maxEvents, generatedAt }) {
    maxEvents = Math.min(2000, Math.max(1, Number(maxEvents) || 2000));
    const state = await analysisStore.readCheckpoint();
    if (!state) {
        const initial = await auditStore.readIncremental({ since: since.toISOString(), offsets: null });
        await analysisStore.writeCheckpoint({ version: 1, offsets: initial.offsets, recent: [], initializedAt: generatedAt });
        return { diagnosticsCount: 0, eventCount: 0, queryStats: { scannedFiles: 0, scannedBytes: 0 }, warmup: true };
    }
    const recent = (state.recent || []).filter(event => Date.parse(event.timestamp) >= since.getTime());
    const seen = new Set(recent.map(event => event.requestId));
    const incoming = [];
    const scan = await auditStore.readIncremental({
        since: since.toISOString(), offsets: state.offsets, maxBytes: MAX_SCAN_BYTES,
        onEvent: event => {
            if (!event?.requestId || seen.has(event.requestId)
                || !isCodexTextAudit(event)
                || Date.parse(event.timestamp) < since.getTime()
                || Date.parse(event.timestamp) >= until.getTime()
                || captureStatus(event).status === 'failed'
                || Number(event.usage?.promptTokens || 0) <= 0) return;
            seen.add(event.requestId);
            incoming.push(compactDiagnosticEvent(event));
        }
    });
    incoming.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    const diagnostics = [];
    for (const event of incoming) {
        const candidates = recent.filter(candidate => candidate.timestamp < event.timestamp);
        if (event.usage.cachedTokens / event.usage.promptTokens < 0.2) {
            diagnostics.push(diagnoseCacheMiss(event, candidates));
        }
        recent.push(event);
        if (recent.length > maxEvents) recent.splice(0, recent.length - maxEvents);
    }
    await analysisStore.appendDiagnostics(diagnostics, {
        generatedAt, complete: scan.remainingBytes === 0, backlogBytes: scan.remainingBytes
    });
    await analysisStore.writeCheckpoint({
        version: 1, offsets: scan.offsets, recent, initializedAt: state.initializedAt || generatedAt
    });
    return {
        diagnosticsCount: diagnostics.length,
        eventCount: incoming.length,
        queryStats: { scannedFiles: Object.keys(scan.offsets).length, scannedBytes: scan.scannedBytes },
        backlogBytes: scan.remainingBytes
    };
}

export async function runRequestAuditAnalyzer({
    auditStore,
    analysisStore,
    lookbackMinutes = 180,
    maxEvents = 5000,
    generatedAt = new Date().toISOString()
} = {}) {
    if (!auditStore || !analysisStore) return { diagnosticsCount: 0 };
    const until = new Date(generatedAt);
    const since = new Date(until.getTime() - Number(lookbackMinutes || 180) * 60 * 1000);
    if (auditStore.readIncremental && analysisStore.readCheckpoint && analysisStore.appendDiagnostics) {
        return runIncrementalAnalyzer({ auditStore, analysisStore, since, until, maxEvents, generatedAt });
    }
    const events = await auditStore.query({
        since: since.toISOString(),
        until: until.toISOString(),
        limit: Number(maxEvents || 5000)
    });
    const diagnostics = buildDiagnostics(events);
    await analysisStore.writeDiagnostics(diagnostics, { generatedAt });
    return {
        diagnosticsCount: diagnostics.length,
        eventCount: events.length,
        queryStats: auditStore.getLastQueryStats?.() || { scannedFiles: 0, scannedBytes: 0 }
    };
}

export function createRequestAuditAnalyzerRunner({
    auditStore,
    analysisStore,
    intervalMs = 60000,
    lookbackMinutes = 180,
    maxEvents = 5000,
    runOnInit = false,
    shouldRun = () => true
} = {}) {
    let timer = null;
    let activeRun = null;
    let failureCount = 0;
    const metrics = {
        runs: 0,
        failures: 0,
        skippedRuns: 0,
        lastGateBacklog: null,
        lastRunMs: 0,
        lastScannedFiles: 0,
        lastScannedBytes: 0,
        lastBacklogBytes: 0,
        lastEventCount: 0,
        lastCompletedAt: null
    };

    const run = () => {
        if (activeRun) {
            metrics.skippedRuns += 1;
            return activeRun;
        }
        const startedAt = performance.now();
        activeRun = Promise.resolve().then(shouldRun)
            .then(gate => {
                metrics.lastGateBacklog = typeof gate === 'number' ? gate : null;
                const allowed = typeof gate === 'boolean' ? gate : Number(gate) <= 500;
                return allowed
                    ? runRequestAuditAnalyzer({ auditStore, analysisStore, lookbackMinutes, maxEvents })
                    : { skipped: true };
            })
            .then(result => {
                if (result?.skipped) {
                    metrics.skippedRuns += 1;
                    return result;
                }
                metrics.runs += 1;
                metrics.lastScannedFiles = Number(result?.queryStats?.scannedFiles || 0);
                metrics.lastScannedBytes = Number(result?.queryStats?.scannedBytes || 0);
                metrics.lastBacklogBytes = Number(result?.backlogBytes || 0);
                metrics.lastEventCount = Number(result?.eventCount || 0);
                metrics.lastCompletedAt = new Date().toISOString();
                return result;
            })
            .catch(() => {
                failureCount += 1;
                metrics.runs += 1;
                metrics.failures = failureCount;
                logger.warn('[Request Audit] analyzer failure');
            })
            .finally(() => {
                metrics.lastRunMs = performance.now() - startedAt;
                activeRun = null;
            });
        return activeRun;
    };

    const start = () => {
        if (timer) clearInterval(timer);
        timer = setInterval(run, Number(intervalMs || 60000));
        timer.unref?.();
        if (runOnInit) setImmediate(run);
    };

    const stop = async () => {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        const drain = activeRun;
        if (drain) await drain;
        return { failureCount };
    };

    const snapshot = () => ({ ...metrics, failures: failureCount, active: Boolean(activeRun) });

    return { start, stop, run, snapshot };
}
