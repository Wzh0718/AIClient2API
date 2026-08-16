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
    constructor({ apply, ack, appendBatch = null, markProjectedBatch = null, ackBatch = null, durableState = null, maxRemembered = 10000 } = {}) {
        this.apply = apply;
        this.ack = ack;
        this.appendBatch = appendBatch;
        this.markProjectedBatch = markProjectedBatch;
        this.ackBatch = ackBatch;
        this.durableState = durableState;
        this.maxRemembered = maxRemembered;
        this.applied = new Set();
        this.pending = new Map();
        this.tail = Promise.resolve();
    }

    async consumeBatch(events = []) {
        const batch = events.filter(Boolean);
        if (batch.length === 0) return { inserted: 0, duplicates: 0 };
        if (!this.appendBatch) {
            for (const event of batch) await this.consume(event);
            return { inserted: batch.length, duplicates: 0 };
        }

        return this._enqueue(async () => {
            const persisted = await this.appendBatch(batch);
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
}
