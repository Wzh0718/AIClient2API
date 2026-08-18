export class ImageCapacityExceededError extends Error {
    constructor(message = 'Image capacity exceeded', details = null) {
        super(message);
        this.name = 'ImageCapacityExceededError';
        this.code = 'image_capacity_exceeded';
        this.type = 'server_overloaded';
        this.status = 503;
        this.statusCode = 503;
        this.retryAfterSeconds = 5;
        if (details) this.details = details;
    }
}

export function resolveBigObjectBudget({ containerLimitBytes } = {}) {
    const limit = Number(containerLimitBytes);
    return Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit * 0.5)) : 4 * 1024 ** 3;
}

export function resolveImageQueueLimit(healthyCredentials = 0) {
    return Math.min(100, Math.max(20, Math.max(0, Number(healthyCredentials) || 0) * 2));
}

function createAbortError() {
    const error = new Error('Image capacity wait aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

export class BigObjectCapacity {
    constructor({
        budgetBytes = 4 * 1024 ** 3,
        queueLimit = 20,
        waitMs = 3_000,
        metrics = {},
        eventLoopBlockMs = 1000,
        eventLoopResumeMs = 400,
        pressureSamples = 3,
        rssSoftRatio = 0.75,
        rssHardRatio = 0.85
    } = {}) {
        this.budgetBytes = Math.max(1, Number(budgetBytes) || 1);
        this.queueLimit = Math.max(0, Number(queueLimit) || 0);
        this.waitMs = Math.max(0, Number(waitMs) || 0);
        this.metrics = metrics;
        this.eventLoopBlockMs = Math.max(1, Number(eventLoopBlockMs) || 1000);
        this.eventLoopResumeMs = Math.max(0, Number(eventLoopResumeMs) || 400);
        this.pressureSamples = Math.max(1, Number(pressureSamples) || 3);
        this.rssSoftRatio = Math.max(0, Math.min(1, Number(rssSoftRatio) || 0.75));
        this.rssHardRatio = Math.max(this.rssSoftRatio, Math.min(1, Number(rssHardRatio) || 0.85));
        this.activeBytes = 0;
        this.queue = [];
        this.highEventLoopSamples = 0;
        this.recoveryEventLoopSamples = 0;
        this.eventLoopBlocked = false;
        this.rejections = 0;
        this.cancelled = 0;
    }

    samplePressure() {
        const delay = Number(this.metrics.eventLoopP95Ms) || 0;
        if (delay >= this.eventLoopBlockMs) {
            this.highEventLoopSamples += 1;
            this.recoveryEventLoopSamples = 0;
            if (this.highEventLoopSamples >= this.pressureSamples) this.eventLoopBlocked = true;
        } else if (delay <= this.eventLoopResumeMs) {
            this.recoveryEventLoopSamples += 1;
            this.highEventLoopSamples = 0;
            if (this.recoveryEventLoopSamples >= this.pressureSamples) this.eventLoopBlocked = false;
        } else {
            this.highEventLoopSamples = 0;
            this.recoveryEventLoopSamples = 0;
        }
        if (!this.eventLoopBlocked) this._drain();
        return this.snapshot();
    }

    setBudgetBytes(bytes) {
        this.budgetBytes = Math.max(1, Number(bytes) || 1);
        this._drain();
    }

    _blockedReasons(bytes) {
        const rssLimit = Number(this.metrics.rssLimitBytes);
        const rss = Number(this.metrics.rssBytes);
        const reasons = [];
        if (this.activeBytes + bytes > this.budgetBytes) reasons.push('budget');
        if (rssLimit > 0 && rss >= rssLimit * this.rssHardRatio) reasons.push('rss');
        else if (rssLimit > 0 && rss >= rssLimit * this.rssSoftRatio && this.activeBytes > 0) reasons.push('rss');
        if (this.eventLoopBlocked) reasons.push('event_loop');
        return reasons;
    }

    _blocked(bytes) {
        return this._blockedReasons(bytes).length > 0;
    }

    _capacityDetails(bytes, blockedReasons = null) {
        return {
            blockedReasons: blockedReasons || this._blockedReasons(bytes),
            activeBytes: this.activeBytes,
            budgetBytes: this.budgetBytes,
            estimatedBytes: bytes,
            rssBytes: Number(this.metrics.rssBytes) || 0,
            rssLimitBytes: Number(this.metrics.rssLimitBytes) || 0,
            eventLoopP95Ms: Number(this.metrics.eventLoopP95Ms) || 0,
            queued: this.queue.length
        };
    }

    _capacityError(bytes, blockedReasons = null) {
        this.rejections += 1;
        return new ImageCapacityExceededError('Image service is temporarily at capacity', this._capacityDetails(bytes, blockedReasons));
    }

    acquire({ bytes, kind = 'image', signal } = {}) {
        const estimatedBytes = Math.max(1, Number(bytes) || 1);
        if (signal?.aborted) return Promise.reject(createAbortError());
        if (!this._blocked(estimatedBytes)) {
            this.activeBytes += estimatedBytes;
            return Promise.resolve({ bytes: estimatedBytes, kind });
        }
        if (this.queue.length >= this.queueLimit) return Promise.reject(this._capacityError(estimatedBytes));
        return new Promise((resolve, reject) => {
            const item = {
                bytes: estimatedBytes,
                kind,
                resolve,
                reject,
                signal,
                blockedReasons: this._blockedReasons(estimatedBytes)
            };
            const cleanup = () => {
                clearTimeout(item.timer);
                signal?.removeEventListener?.('abort', item.onAbort);
            };
            item.cleanup = cleanup;
            item.onAbort = () => {
                const index = this.queue.indexOf(item);
                if (index >= 0) this.queue.splice(index, 1);
                cleanup();
                this.cancelled += 1;
                reject(createAbortError());
            };
            item.timer = setTimeout(() => {
                const index = this.queue.indexOf(item);
                if (index >= 0) this.queue.splice(index, 1);
                cleanup();
                reject(this._capacityError(estimatedBytes, item.blockedReasons));
            }, this.waitMs);
            item.timer.unref?.();
            signal?.addEventListener?.('abort', item.onAbort, { once: true });
            this.queue.push(item);
        });
    }

    release(ticket) {
        if (!ticket) return false;
        this.activeBytes = Math.max(0, this.activeBytes - Math.max(1, Number(ticket.bytes) || 1));
        this._drain();
        return true;
    }

    _drain() {
        for (let index = 0; index < this.queue.length; index++) {
            const item = this.queue[index];
            if (this._blocked(item.bytes)) continue;
            this.queue.splice(index--, 1);
            item.cleanup?.();
            this.activeBytes += item.bytes;
            item.resolve({ bytes: item.bytes, kind: item.kind });
        }
    }

    resize(ticket, bytes) {
        if (!ticket) return false;
        const nextBytes = Math.max(1, Number(bytes) || 1);
        const previousBytes = Math.max(1, Number(ticket.bytes) || 1);
        this.activeBytes = Math.max(0, this.activeBytes - previousBytes + nextBytes);
        ticket.bytes = nextBytes;
        return this.activeBytes <= this.budgetBytes;
    }

    snapshot() {
        return {
            activeBytes: this.activeBytes,
            queued: this.queue.length,
            budgetBytes: this.budgetBytes,
            eventLoopBlocked: this.eventLoopBlocked,
            highEventLoopSamples: this.highEventLoopSamples,
            recoveryEventLoopSamples: this.recoveryEventLoopSamples,
            rejections: this.rejections,
            cancelled: this.cancelled
        };
    }
}
