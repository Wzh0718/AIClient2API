export class RuntimeUsageProjector {
    constructor({
        store,
        executeProjection,
        batchSize = 100,
        retryDelayMs = 1000,
        maxBatchesPerRun = 10,
        drainTimeoutMs = 30000
    } = {}) {
        this.store = store;
        this.executeProjection = executeProjection;
        this.batchSize = Math.max(1, Number(batchSize) || 100);
        this.retryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
        this.maxBatchesPerRun = Math.max(1, Number(maxBatchesPerRun) || 10);
        this.drainTimeoutMs = Math.max(1, Number(drainTimeoutMs) || 30000);
        this.running = null;
    }

    async drainOnce() {
        const pending = await this.store.listPendingProjections({ limit: this.batchSize });
        for (const item of pending) {
            try {
                await this.executeProjection(item.projectionName, item.hookName, ...(item.args || []), item.eventId);
                await this.store.completeProjection(item);
            } catch (error) {
                await this.store.failProjection({
                    ...item,
                    error: error?.message || String(error),
                    retryDelayMs: this.retryDelayMs
                });
            }
        }
        return pending.length;
    }

    schedule() {
        if (this.running) return this.running;
        this.running = (async () => {
            for (let batch = 0; batch < this.maxBatchesPerRun; batch += 1) {
                if (await this.drainOnce() === 0) break;
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
