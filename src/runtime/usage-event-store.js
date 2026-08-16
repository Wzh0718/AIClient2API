import path from 'node:path';
import { Worker } from 'node:worker_threads';

export class UsageEventStore {
    constructor({
        dbPath = path.join(process.cwd(), 'configs', 'usage-events', 'usage-events.sqlite')
    } = {}) {
        this.dbPath = dbPath;
        this.nextMessageId = 1;
        this.pending = new Map();
        this.closed = false;
        this.worker = new Worker(new URL('./usage-event-store-worker.js', import.meta.url), {
            workerData: { dbPath }
        });
        this.worker.on('message', message => this._handleMessage(message));
        this.worker.on('error', error => this._rejectPending(error));
        this.worker.on('exit', code => {
            if (!this.closed && code !== 0) this._rejectPending(new Error(`Usage event store worker exited with code ${code}`));
        });
    }

    _handleMessage({ id, result, error } = {}) {
        const operation = this.pending.get(id);
        if (!operation) return;
        this.pending.delete(id);
        if (error) {
            const failure = new Error(error.message);
            failure.stack = error.stack || failure.stack;
            operation.reject(failure);
        } else {
            operation.resolve(result);
        }
    }

    _rejectPending(error) {
        for (const operation of this.pending.values()) operation.reject(error);
        this.pending.clear();
    }

    _call(action, payload = {}) {
        if (this.closed && action !== 'close') return Promise.reject(new Error('Usage event store is closed'));
        const id = this.nextMessageId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ id, action, payload });
        });
    }

    appendBatch(events) {
        return this._call('appendBatch', { events });
    }

    countEvents() {
        return this._call('countEvents');
    }

    markProjected(eventIds) {
        return this._call('markProjected', { eventIds });
    }

    listPendingProjections({ limit = 100 } = {}) {
        return this._call('listPendingProjections', { limit });
    }

    completeProjection({ eventId, projectionName }) {
        return this._call('completeProjection', { eventId, projectionName });
    }

    failProjection({ eventId, projectionName, error, retryDelayMs = 1000 }) {
        return this._call('failProjection', { eventId, projectionName, error, retryDelayMs });
    }

    snapshot() {
        return this._call('snapshot');
    }

    checkpoint() {
        return this._call('checkpoint');
    }

    prune({ before }) {
        return this._call('prune', { before });
    }

    async close() {
        if (this.closed) return;
        const closing = this._call('close');
        this.closed = true;
        await closing;
        await this.worker.terminate();
    }
}

export function createUsageEventStore(options) {
    return new UsageEventStore(options);
}
