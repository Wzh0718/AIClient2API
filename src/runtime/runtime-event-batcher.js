export class RuntimeEventBatcher {
    constructor({ flush, maxSize = 100, flushMs = 1000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
        if (typeof flush !== 'function') throw new TypeError('flush callback is required');
        this.flush = flush;
        this.maxSize = Math.max(1, Number(maxSize) || 1);
        this.flushMs = Math.max(0, Number(flushMs) || 0);
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.entries = [];
        this.timer = null;
        this.running = null;
        this.closed = false;
        this.metrics = {
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
            queueAgeMs: 0
        };
    }

    get size() {
        return this.entries.length;
    }

    push(event) {
        if (this.closed) return Promise.reject(new Error('Runtime event batcher is closed'));
        const promise = new Promise((resolve, reject) => {
            this.entries.push({ event, resolve, reject, queuedAt: Date.now() });
        });
        if (this.entries.length >= this.maxSize) {
            void this.flushNow('size').catch(() => {});
        } else {
            this._scheduleTimer();
        }
        return promise;
    }

    _scheduleTimer() {
        if (this.timer || this.flushMs <= 0) return;
        this.timer = this.setTimeoutFn(() => {
            this.timer = null;
            void this.flushNow('timer').catch(() => {});
        }, this.flushMs);
        this.timer?.unref?.();
    }

    async flushNow(reason = 'manual') {
        if (this.running) return this.running;
        if (this.entries.length === 0) return null;
        if (this.timer) {
            this.clearTimeoutFn(this.timer);
            this.timer = null;
        }
        const entries = this.entries.splice(0, this.entries.length);
        const events = entries.map(entry => entry.event);
        const startedAt = performance.now();
        this.running = (async () => {
            try {
                const result = await this.flush(events);
                const batchSize = events.length;
                this.metrics.flushCount += 1;
                if (reason === 'size') this.metrics.flushBySize += 1;
                if (reason === 'timer') this.metrics.flushByTimer += 1;
                if (reason === 'shutdown') this.metrics.flushByShutdown += 1;
                this.metrics.eventsAppended += batchSize;
                this.metrics.totalBatchSize += batchSize;
                this.metrics.averageBatchSize = this.metrics.totalBatchSize / this.metrics.flushCount;
                this.metrics.lastBatchSize = batchSize;
                this.metrics.lastFlushMs = performance.now() - startedAt;
                this.metrics.lastCommitMs = this.metrics.lastFlushMs;
                this.metrics.queueAgeMs = Math.max(0, Date.now() - Math.min(...entries.map(entry => entry.queuedAt)));
                for (const entry of entries) entry.resolve(result);
                return result;
            } catch (error) {
                this.metrics.failedBatches += 1;
                this.entries.unshift(...entries);
                for (const entry of entries) entry.reject(error);
                this._scheduleTimer();
                throw error;
            } finally {
                this.running = null;
            }
        })();
        return this.running;
    }

    async close() {
        if (this.closed && this.entries.length === 0) return null;
        const result = await this.flushNow('shutdown');
        this.closed = true;
        return result;
    }

    snapshot() {
        return {
            ...this.metrics,
            pending: this.entries.length,
            queueAgeMs: this.entries.length > 0
                ? Math.max(0, Date.now() - Math.min(...this.entries.map(entry => entry.queuedAt)))
                : 0
        };
    }
}
