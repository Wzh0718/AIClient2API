function createDeferred() {
    let resolve;
    let reject;
    let settled = false;
    const promise = new Promise((res, rej) => {
        resolve = value => {
            if (settled) return;
            settled = true;
            res(value);
        };
        reject = error => {
            if (settled) return;
            settled = true;
            rej(error);
        };
    });
    return { promise, resolve, reject };
}

function defaultNow() {
    return Date.now();
}

function defaultPerformanceNow() {
    return globalThis.performance?.now?.() ?? Date.now();
}

function boundedPositive(value, fallback, minimum = 1) {
    const number = Number(value);
    return Number.isFinite(number) && number >= minimum ? number : fallback;
}

export class RuntimeEventBatcher {
    constructor({
        flush,
        maxSize = 100,
        flushMs = 1000,
        maxPending = null,
        retryDelayMs = null,
        maxRetryDelayMs = 5000,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
        now = defaultNow,
        performanceNow = defaultPerformanceNow,
        onError = null
    } = {}) {
        if (typeof flush !== 'function') throw new TypeError('flush callback is required');
        this.flush = flush;
        this.maxSize = Math.max(1, Number(maxSize) || 1);
        this.flushMs = Math.max(0, Number(flushMs) || 0);
        const defaultMaxPending = Math.min(10_000, Math.max(1_000, this.maxSize * 10));
        this.maxPending = Math.max(this.maxSize, boundedPositive(maxPending, defaultMaxPending));
        this.retryDelayMs = Math.max(25, boundedPositive(
            retryDelayMs,
            Math.max(100, Math.min(this.flushMs || 1000, 1000))
        ));
        this.maxRetryDelayMs = Math.max(this.retryDelayMs, boundedPositive(maxRetryDelayMs, 5000));
        this.setTimeoutFn = setTimeoutFn;
        this.clearTimeoutFn = clearTimeoutFn;
        this.now = now;
        this.performanceNow = performanceNow;
        this.onError = typeof onError === 'function' ? onError : null;
        this.entries = [];
        this.timer = null;
        this.retryTimer = null;
        this.immediateScheduled = false;
        this.running = null;
        this.inFlightEntries = 0;
        this.activeEntries = [];
        this.retryAttempt = 0;
        this.capacityWaiters = [];
        this.closed = false;
        this.closing = false;
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
            retryCount: 0,
            acceptedEvents: 0,
            rejectedEvents: 0,
            queueAgeMs: 0
        };
    }

    get size() {
        return this.entries.length;
    }

    get pending() {
        return this.entries.length + this.inFlightEntries;
    }

    availableCapacity() {
        return Math.max(0, this.maxPending - this.pending);
    }

    waitForCapacity(count = 1) {
        const required = Math.max(1, Number(count) || 1);
        if (this.availableCapacity() >= required) return Promise.resolve(true);
        if (this.closed || this.closing) return Promise.resolve(false);
        return new Promise(resolve => {
            this.capacityWaiters.push({ required, resolve });
        });
    }

    push(event) {
        return this.pushBatch([event]);
    }

    pushBatch(events = [], { awaitFlush = true } = {}) {
        const batch = events.filter(Boolean);
        if (batch.length === 0) {
            const emptyResult = Promise.resolve({ inserted: 0, duplicates: 0 });
            return awaitFlush ? emptyResult : { accepted: 0, completion: emptyResult };
        }
        if (this.closed || this.closing) {
            const error = new Error('Runtime event batcher is closed');
            error.code = 'RUNTIME_EVENT_BATCHER_CLOSED';
            return this._rejectedPush(batch.length, error, awaitFlush);
        }
        if (this.availableCapacity() < batch.length) {
            const error = new Error(`Runtime event queue is full (${this.maxPending} pending events)`);
            error.code = 'RUNTIME_EVENT_QUEUE_FULL';
            return this._rejectedPush(batch.length, error, awaitFlush);
        }

        const deferredEntries = batch.map(event => {
            const deferred = createDeferred();
            return { event, ...deferred, queuedAt: this.now() };
        });
        this.entries.push(...deferredEntries);
        this.metrics.acceptedEvents += batch.length;
        this._triggerFlush();

        const completion = Promise.all(deferredEntries.map(entry => entry.promise))
            .then(results => results[results.length - 1]);
        if (!awaitFlush) {
            // Attach a handler to the original promise so background pollers cannot
            // produce unhandled-rejection noise. Callers can still await completion.
            completion.catch(error => this.onError?.(error));
            return { accepted: batch.length, completion };
        }
        return completion;
    }

    _rejectedPush(count, error, awaitFlush) {
        this.metrics.rejectedEvents += count;
        const completion = Promise.reject(error);
        completion.catch(() => {});
        if (awaitFlush) return completion;
        return { accepted: 0, rejected: count, completion };
    }

    _triggerFlush() {
        if (this.entries.length >= this.maxSize) {
            this._startFlush('size');
            return;
        }
        this._scheduleTimer();
    }

    _startFlush(reason) {
        void this.flushNow(reason).catch(error => this.onError?.(error));
    }

    _scheduleTimer(delay = this.flushMs, reason = 'timer') {
        if (this.closed || this.closing || this.timer || this.retryTimer || this.entries.length === 0) return;
        if (delay <= 0) {
            if (this.immediateScheduled) return;
            this.immediateScheduled = true;
            Promise.resolve().then(() => {
                this.immediateScheduled = false;
                if (!this.closed && !this.closing && this.entries.length > 0) this._startFlush(reason);
            });
            return;
        }
        this.timer = this.setTimeoutFn(() => {
            this.timer = null;
            this._startFlush(reason);
        }, delay);
        this.timer?.unref?.();
    }

    _scheduleRetry() {
        if (this.closed || this.closing || this.retryTimer || this.entries.length === 0) return;
        const delay = Math.min(
            this.maxRetryDelayMs,
            this.retryDelayMs * (2 ** Math.max(0, this.retryAttempt - 1))
        );
        this.retryTimer = this.setTimeoutFn(() => {
            this.retryTimer = null;
            this._startFlush('retry');
        }, delay);
        this.retryTimer?.unref?.();
    }

    _clearTimer(timerName) {
        const timer = this[timerName];
        if (!timer) return;
        this.clearTimeoutFn(timer);
        this[timerName] = null;
    }

    async flushNow(reason = 'manual') {
        if (this.running) return this.running;
        if (this.entries.length === 0) return null;
        this._clearTimer('timer');
        this._clearTimer('retryTimer');
        const entries = this.entries.splice(0, this.entries.length);
        const events = entries.map(entry => entry.event);
        this.activeEntries = entries;
        this.inFlightEntries = entries.length;
        const startedAt = this.performanceNow();
        this.running = (async () => {
            try {
                const result = await this.flush(events);
                const batchSize = events.length;
                const elapsed = Math.max(0, this.performanceNow() - startedAt);
                this.metrics.flushCount += 1;
                if (reason === 'size') this.metrics.flushBySize += 1;
                if (reason === 'timer') this.metrics.flushByTimer += 1;
                if (reason === 'shutdown') this.metrics.flushByShutdown += 1;
                this.metrics.eventsAppended += batchSize;
                this.metrics.totalBatchSize += batchSize;
                this.metrics.averageBatchSize = this.metrics.totalBatchSize / this.metrics.flushCount;
                this.metrics.lastBatchSize = batchSize;
                this.metrics.lastFlushMs = elapsed;
                this.metrics.lastCommitMs = elapsed;
                this.metrics.queueAgeMs = Math.max(
                    0,
                    this.now() - Math.min(...entries.map(entry => entry.queuedAt))
                );
                this.retryAttempt = 0;
                for (const entry of entries) entry.resolve(result);
                return result;
            } catch (error) {
                this.entries.unshift(...entries);
                this.metrics.failedBatches += 1;
                this.metrics.retryCount += 1;
                this.retryAttempt += 1;
                this._scheduleRetry();
                throw error;
            } finally {
                this.activeEntries = [];
                this.inFlightEntries = 0;
                this.running = null;
                this._notifyCapacity();
                if (!this.closed && !this.closing && this.entries.length > 0 && !this.retryTimer) {
                    if (this.entries.length >= this.maxSize) this._startFlush('size');
                    else this._scheduleTimer();
                }
            }
        })();
        return this.running;
    }

    _notifyCapacity() {
        if (this.capacityWaiters.length === 0) return;
        const remaining = [];
        for (const waiter of this.capacityWaiters) {
            if (this.availableCapacity() >= waiter.required) waiter.resolve(true);
            else if (this.closed || this.closing) waiter.resolve(false);
            else remaining.push(waiter);
        }
        this.capacityWaiters = remaining;
    }

    async close({ timeoutMs = 30000 } = {}) {
        if (this.closed) return null;
        this.closing = true;
        this._clearTimer('timer');
        this._clearTimer('retryTimer');
        const deadline = this.now() + Math.max(1, Number(timeoutMs) || 1);
        let lastResult = null;
        let lastError = null;
        while (this.pending > 0) {
            if (this.running) {
                try {
                    lastResult = await this._awaitUntil(this.running, deadline);
                } catch (error) {
                    lastError = error;
                    if (error?.code === 'RUNTIME_EVENT_DRAIN_TIMEOUT') break;
                }
            }
            if (this.entries.length === 0) continue;
            if (this.now() >= deadline) break;
            try {
                lastResult = await this._awaitUntil(this.flushNow('shutdown'), deadline);
                lastError = null;
            } catch (error) {
                lastError = error;
                if (error?.code === 'RUNTIME_EVENT_DRAIN_TIMEOUT') break;
                const remainingMs = Math.max(1, deadline - this.now());
                await new Promise(resolve => this.setTimeoutFn(resolve, Math.min(this.retryDelayMs, remainingMs)));
            }
        }
        this.closed = true;
        this._notifyCapacity();
        if (this.pending > 0) {
            const error = new Error(`Runtime event batcher drain timed out with ${this.pending} pending events`);
            error.code = 'RUNTIME_EVENT_DRAIN_TIMEOUT';
            error.cause = lastError || undefined;
            for (const entry of this.entries.splice(0, this.entries.length)) entry.reject(error);
            for (const entry of this.activeEntries) entry.reject(error);
            throw error;
        }
        return lastResult;
    }

    async _awaitUntil(promise, deadline) {
        const remainingMs = deadline - this.now();
        if (remainingMs <= 0) {
            const error = new Error('Runtime event batcher drain timed out');
            error.code = 'RUNTIME_EVENT_DRAIN_TIMEOUT';
            throw error;
        }
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = this.setTimeoutFn(() => {
                const error = new Error('Runtime event batcher drain timed out');
                error.code = 'RUNTIME_EVENT_DRAIN_TIMEOUT';
                reject(error);
            }, remainingMs);
        });
        try {
            return await Promise.race([promise, timeout]);
        } finally {
            if (timer) this.clearTimeoutFn(timer);
        }
    }

    snapshot() {
        const queueAgeMs = this.entries.length > 0
            ? Math.max(0, this.now() - Math.min(...this.entries.map(entry => entry.queuedAt)))
            : 0;
        return {
            ...this.metrics,
            pending: this.entries.length,
            queuePending: this.entries.length,
            inFlight: this.inFlightEntries,
            totalPending: this.pending,
            queueCapacity: this.maxPending,
            availableCapacity: this.availableCapacity(),
            pollPaused: this.availableCapacity() === 0,
            queueAgeMs
        };
    }
}
