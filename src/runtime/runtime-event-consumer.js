export function createDurableRuntimeHookApply({ executeHook } = {}) {
    return async message => {
        const args = [...(message.args || [])];
        if (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
            args[0] = { ...args[0], _runtimeEventId: message.eventId };
        }
        await executeHook?.(message.hookName, ...args);
    };
}

export class RuntimeEventConsumer {
    constructor({ apply, ack, appendBatch = null, markProjectedBatch = null, ackBatch = null, scheduleProjections = null, durableState = null, maxRemembered = 10000 } = {}) {
        this.apply = apply;
        this.ack = ack;
        this.appendBatch = appendBatch;
        this.markProjectedBatch = markProjectedBatch;
        this.ackBatch = ackBatch;
        this.scheduleProjections = scheduleProjections;
        this.durableState = durableState;
        this.maxRemembered = maxRemembered;
        this.applied = new Set();
        this.pending = new Map();
        this.tail = Promise.resolve();
        this.metrics = { ackCount: 0, lastAckLatencyMs: 0, maxAckLatencyMs: 0 };
    }

    async consumeBatch(events = []) {
        const batch = events.filter(Boolean);
        if (batch.length === 0) return { inserted: 0, duplicates: 0 };
        if (!this.appendBatch) {
            for (const event of batch) await this.consume(event);
            return { inserted: batch.length, duplicates: 0 };
        }

        return this._enqueue(async () => {
            const startedAt = Date.now();
            const persisted = await this.appendBatch(batch);
            if (this.scheduleProjections) {
                if (this.ackBatch) await this.ackBatch(batch);
                else for (const event of batch) await this.ack?.(event);
                this._recordAck(Date.now() - startedAt, batch.length);
                Promise.resolve(this.scheduleProjections()).catch(() => {});
                return persisted;
            }
            const inserted = new Set(
                persisted?.pendingEventIds
                || persisted?.insertedEventIds
                || batch.map(event => event.eventId)
            );
            const projected = [];
            for (const event of batch) {
                if (inserted.has(event.eventId)) {
                    await this.apply?.(event);
                    projected.push(event);
                }
            }
            if (projected.length > 0) await this.markProjectedBatch?.(projected);
            if (this.ackBatch) await this.ackBatch(batch);
            else for (const event of batch) await this.ack?.(event);
            this._recordAck(Date.now() - startedAt, batch.length);
            return persisted;
        });
    }

    async consume(event) {
        if (!event?.eventId) return this._enqueue(() => this.apply(event));
        const durablyApplied = this.durableState?.hasApplied
            ? await this.durableState.hasApplied(event)
            : false;
        if (this.applied.has(event.eventId) || durablyApplied) {
            if (durablyApplied) await this.durableState?.commit?.(event);
            await this.ack(event);
            return;
        }

        let operation = this.pending.get(event.eventId);
        if (!operation) {
            operation = this._enqueue(async () => {
                await this.apply(event);
                await this.durableState?.commit?.(event);
                this.applied.add(event.eventId);
                if (this.applied.size > this.maxRemembered) {
                    this.applied.delete(this.applied.values().next().value);
                }
            });
            this.pending.set(event.eventId, operation);
        }

        try {
            await operation;
        } finally {
            if (this.pending.get(event.eventId) === operation) this.pending.delete(event.eventId);
        }
        await this.ack(event);
    }

    _enqueue(operation) {
        const result = this.tail.then(operation);
        this.tail = result.catch(() => {});
        return result;
    }

    _recordAck(latencyMs, count = 1) {
        this.metrics.ackCount += Math.max(0, Number(count) || 0);
        this.metrics.lastAckLatencyMs = Math.max(0, Number(latencyMs) || 0);
        this.metrics.maxAckLatencyMs = Math.max(this.metrics.maxAckLatencyMs, this.metrics.lastAckLatencyMs);
    }

    snapshot() {
        return { ...this.metrics, inMemoryPending: this.pending.size };
    }
}
