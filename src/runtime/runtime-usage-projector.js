export class RuntimeUsageProjector {
    constructor({
        store,
        executeProjection,
        executeProjectionBatch = null,
        onFatalProjectionError = null,
        onProgress = null,
        progressIntervalMs = 1000,
        batchSize = 100,
        retryDelayMs = 1000,
        maxBatchesPerRun = 10,
        drainTimeoutMs = 30000
    } = {}) {
        this.store = store;
        this.executeProjection = executeProjection;
        this.executeProjectionBatch = executeProjectionBatch;
        this.onFatalProjectionError = onFatalProjectionError;
        this.onProgress = onProgress;
        this.progressIntervalMs = Math.max(0, Number(progressIntervalMs) || 0);
        this.lastProgressAt = 0;
        this.batchSize = Math.max(1, Number(batchSize) || 100);
        this.retryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
        this.maxBatchesPerRun = Math.max(1, Number(maxBatchesPerRun) || 10);
        this.drainTimeoutMs = Math.max(1, Number(drainTimeoutMs) || 30000);
        this.running = null;
    }

    async drainOnce() {
        const pending = await this.store.listPendingProjections({ limit: this.batchSize });
        const completed = [];
        const failed = [];
        let fatalError = null;
        if (this.executeProjectionBatch) {
            const groups = new Map();
            for (const item of pending) {
                if (!groups.has(item.projectionName)) groups.set(item.projectionName, []);
                groups.get(item.projectionName).push(item);
            }
            for (const [projectionName, items] of groups.entries()) {
                try {
                    const result = await this.executeProjectionBatch(projectionName, items);
                    completed.push(...(result?.completed || []));
                    failed.push(...(result?.failed || []).map(item => ({
                        ...item,
                        retryDelayMs: this.retryDelayMs
                    })));
                    if (result?.requiresRestart) {
                        fatalError = new Error(
                            result.failed?.[0]?.error || `Fatal ${projectionName} projection batch failure`
                        );
                    }
                } catch (error) {
                    failed.push(...items.map(item => ({
                        ...item,
                        error: error?.message || String(error),
                        retryDelayMs: this.retryDelayMs
                    })));
                }
            }
        } else {
            for (const item of pending) {
                try {
                    await this.executeProjection(item.projectionName, item.hookName, ...(item.args || []), item.eventId);
                    completed.push(item);
                } catch (error) {
                    failed.push({
                        ...item,
                        error: error?.message || String(error),
                        retryDelayMs: this.retryDelayMs
                    });
                }
            }
        }
        if (completed.length > 0) await this.store.completeProjections(completed);
        if (failed.length > 0) await this.store.failProjections(failed);
        if (fatalError) this.onFatalProjectionError?.(fatalError);
        const now = Date.now();
        if (
            this.onProgress
            && (this.progressIntervalMs === 0 || now - this.lastProgressAt >= this.progressIntervalMs)
        ) {
            this.lastProgressAt = now;
            await this.onProgress({ count: pending.length, failures: failed.length });
        }
        return { count: pending.length, failures: failed.length };
    }

    schedule() {
        if (this.running) return this.running;
        this.running = (async () => {
            while (true) {
                for (let batch = 0; batch < this.maxBatchesPerRun; batch += 1) {
                    const result = await this.drainOnce();
                    if (result.count === 0 || result.failures > 0) return;
                }
                await new Promise(resolve => setImmediate(resolve));
            }
        })().finally(() => { this.running = null; });
        return this.running;
    }

    async drain({ timeoutMs = this.drainTimeoutMs } = {}) {
        const timeout = new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`Usage projection drain timed out after ${timeoutMs}ms`)), timeoutMs);
            timer.unref?.();
        });
        await Promise.race([this.schedule(), timeout]);
    }
}
