import logger from '../../utils/logger.js';
import { buildDiagnostics } from './cache-diagnostics.js';

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
    runOnInit = false
} = {}) {
    let timer = null;
    let activeRun = null;
    let failureCount = 0;
    const metrics = {
        runs: 0,
        failures: 0,
        skippedRuns: 0,
        lastRunMs: 0,
        lastScannedFiles: 0,
        lastScannedBytes: 0,
        lastEventCount: 0,
        lastCompletedAt: null
    };

    const run = () => {
        if (activeRun) {
            metrics.skippedRuns += 1;
            return activeRun;
        }
        const startedAt = performance.now();
        activeRun = runRequestAuditAnalyzer({ auditStore, analysisStore, lookbackMinutes, maxEvents })
            .then(result => {
                metrics.runs += 1;
                metrics.lastScannedFiles = Number(result?.queryStats?.scannedFiles || 0);
                metrics.lastScannedBytes = Number(result?.queryStats?.scannedBytes || 0);
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
