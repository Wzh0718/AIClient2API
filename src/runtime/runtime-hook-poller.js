function sleep(delayMs) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, delayMs)));
}

function invokeSafely(callback, value) {
    try {
        return callback?.(value);
    } catch {
        return undefined;
    }
}

export class RuntimeHookPoller {
    constructor({
        stream,
        ingress,
        readBatchSize = 100,
        blockMs = 20,
        statusPollMs = 1000,
        claimIntervalMs = 5000,
        errorRetryMs = 1000,
        now = () => Date.now(),
        sleepFn = sleep,
        onStatus = null,
        onError = null,
        onBatchError = null
    } = {}) {
        if (!stream?.readBatch) throw new TypeError('runtime hook stream is required');
        if (!ingress?.pushBatch || !ingress?.availableCapacity || !ingress?.waitForCapacity) {
            throw new TypeError('runtime hook ingress is required');
        }
        this.stream = stream;
        this.ingress = ingress;
        this.readBatchSize = Math.max(1, Number(readBatchSize) || 1);
        this.blockMs = Math.max(0, Number(blockMs) || 0);
        this.statusPollMs = Math.max(0, Number(statusPollMs) || 0);
        this.claimIntervalMs = Math.max(0, Number(claimIntervalMs) || 0);
        this.errorRetryMs = Math.max(1, Number(errorRetryMs) || 1);
        this.now = now;
        this.sleep = sleepFn;
        this.onStatus = typeof onStatus === 'function' ? onStatus : null;
        this.onError = typeof onError === 'function' ? onError : null;
        this.onBatchError = typeof onBatchError === 'function' ? onBatchError : null;
        this.running = null;
        this.statusPromise = null;
        this.stopped = true;
        this.stopWaiters = [];
        this.lastClaimAt = 0;
        this.nextStatusAt = 0;
        this.metrics = {
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
            lastStatusAt: null
        };
    }

    start() {
        if (this.running) return this.running;
        this.stopped = false;
        this.nextStatusAt = 0;
        this.running = this._run().finally(() => {
            this.running = null;
        });
        return this.running;
    }

    async _run() {
        while (!this.stopped) {
            try {
                const availableCapacity = Math.max(0, Number(this.ingress.availableCapacity()) || 0);
                if (availableCapacity <= 0) {
                    this.metrics.pollPaused = true;
                    const capacityPromise = this.ingress.waitForCapacity(1);
                    await this._awaitWithStop(capacityPromise);
                    this.metrics.pollPaused = false;
                    continue;
                }

                const count = Math.max(1, Math.min(this.readBatchSize, availableCapacity));
                const claim = this.claimIntervalMs === 0 || this.now() >= this.lastClaimAt + this.claimIntervalMs;
                if (claim) {
                    this.lastClaimAt = this.now();
                    this.metrics.claimCount += 1;
                }
                const events = await this.stream.readBatch({ count, blockMs: this.blockMs, claim });
                if (this.stopped) break;
                this.metrics.streamReadBatches += 1;
                this.metrics.streamReadEvents += events.length;
                if (events.length > 0) {
                    this.stream.markInFlight?.(events);
                    try {
                        const result = this.ingress.pushBatch(events, { awaitFlush: false });
                        this.metrics.enqueuedEvents += Number(result?.accepted || 0);
                        this.metrics.rejectedEvents += Number(result?.rejected || 0);
                        result?.completion
                            ?.then(() => this.stream.unmarkInFlight?.(events))
                            .catch(error => {
                                this.stream.unmarkInFlight?.(events);
                                this._reportBatchError(error);
                            });
                    } catch (error) {
                        try { this.stream.unmarkInFlight?.(events); } catch {}
                        throw error;
                    }
                } else {
                    // A mocked/non-blocking Redis client can resolve immediately;
                    // yield between empty reads so shutdown and capacity signals
                    // are not starved by a microtask-only loop.
                    await this._awaitWithStop(this.sleep(Math.max(1, Math.min(this.blockMs || 1, 25))));
                }
                void this._sampleStatusIfDue();
            } catch (error) {
                if (this.stopped) break;
                this._reportError(error);
                await this._awaitWithStop(this.sleep(this.errorRetryMs));
            }
        }
    }

    _reportError(error) {
        this.metrics.errors += 1;
        this.metrics.lastError = error?.message || String(error);
        invokeSafely(this.onError, error);
    }

    _reportBatchError(error) {
        this.metrics.batchErrors += 1;
        invokeSafely(this.onBatchError, error);
    }

    _waitForStop() {
        if (this.stopped) return { promise: Promise.resolve(true), cancel: () => {} };
        let waiter;
        const promise = new Promise(resolve => {
            waiter = { resolve };
            this.stopWaiters.push(waiter);
        });
        return {
            promise,
            cancel: () => {
                const index = this.stopWaiters.indexOf(waiter);
                if (index >= 0) this.stopWaiters.splice(index, 1);
            }
        };
    }

    async _awaitWithStop(operation) {
        const stopWaiter = this._waitForStop();
        try {
            return await Promise.race([operation, stopWaiter.promise]);
        } finally {
            stopWaiter.cancel();
        }
    }

    async _sampleStatusIfDue(force = false) {
        if (!this.stream.pendingSnapshot) return null;
        if (this.statusPromise) return this.statusPromise;
        const now = this.now();
        if (!force && now < this.nextStatusAt) return null;
        this.nextStatusAt = now + this.statusPollMs;
        this.statusPromise = (async () => {
            try {
                const snapshot = await this.stream.pendingSnapshot();
                this.metrics.statusPollCount += 1;
                this.metrics.lastStatusAt = new Date().toISOString();
                invokeSafely(this.onStatus, snapshot);
                return snapshot;
            } catch (error) {
                this._reportError(error);
                return null;
            }
        })().finally(() => { this.statusPromise = null; });
        return this.statusPromise;
    }

    async stop({ drain = true, timeoutMs = 30000 } = {}) {
        this.stopped = true;
        for (const waiter of this.stopWaiters.splice(0)) waiter.resolve(true);
        if (this.running) await this.running.catch(() => {});
        this.running = null;
        if (this.statusPromise) await this.statusPromise.catch(() => {});
        await this._sampleStatusIfDue(true);
        if (drain && this.ingress.close) return this.ingress.close({ timeoutMs });
        return null;
    }

    snapshot() {
        return {
            ...this.metrics,
            running: Boolean(this.running),
            availableCapacity: Number(this.ingress.availableCapacity?.() || 0),
            queuePending: Number(this.ingress.snapshot?.().pending || 0)
        };
    }
}
