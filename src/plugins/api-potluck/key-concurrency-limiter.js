import crypto from 'node:crypto';

export function createKeyConcurrencyError(keyId, reason, extra = {}) {
    const error = new Error(reason === 'key_queue_timeout'
        ? 'Potluck key concurrency queue timeout'
        : 'Potluck key concurrency limit reached');
    error.status = 429;
    error.statusCode = 429;
    error.code = 'POTLUCK_KEY_CONCURRENCY_LIMIT';
    error.details = { keyId: String(keyId), reason, ...extra };
    return error;
}

export class PotluckKeyConcurrencyLimiter {
    constructor({ onEvent = null, now = () => Date.now() } = {}) {
        this.states = new Map();
        this.onEvent = typeof onEvent === 'function' ? onEvent : null;
        this.now = now;
    }

    _state(keyId) {
        const id = String(keyId);
        if (!this.states.has(id)) this.states.set(id, { active: 0, waiting: 0, queue: [] });
        return this.states.get(id);
    }

    _emit(event, keyId, details = {}) {
        this.onEvent?.({ event, keyId: String(keyId), ...details });
    }

    async acquire(keyId, options = {}) {
        const id = String(keyId);
        const maxConcurrency = Math.max(0, Number(options.maxConcurrency) || 0);
        const queueLimit = Math.max(0, Number(options.queueLimit) || 0);
        const queueTimeoutMs = Math.max(1, Number(options.queueTimeoutMs) || 300_000);
        const mode = options.mode === 'shadow' ? 'shadow' : 'enforce';
        if (maxConcurrency <= 0) return this._lease(id, false);

        if (mode === 'enforce' && typeof options.coordination?.acquirePotluckKeyLease === 'function') {
            return this._acquireDistributed(id, { maxConcurrency, queueLimit, queueTimeoutMs, coordination: options.coordination });
        }

        const state = this._state(id);
        if (state.active < maxConcurrency) {
            state.active++;
            return this._lease(id, true);
        }

        this._emit('key_capacity_exhausted', id, { active: state.active, maxConcurrency, waiting: state.waiting });
        if (mode === 'shadow') return { keyId: id, shadow: true, capacityExhausted: true, release: async () => {} };
        if (state.waiting >= queueLimit) {
            this._emit('key_429', id, { reason: 'key_capacity_exhausted', active: state.active, waiting: state.waiting });
            throw createKeyConcurrencyError(id, 'key_capacity_exhausted', { active: state.active, maxConcurrency, waiting: state.waiting });
        }

        state.waiting++;
        return new Promise((resolve, reject) => {
            const waiter = { settled: false, timer: null, resolve, reject };
            waiter.timer = setTimeout(() => {
                if (waiter.settled) return;
                waiter.settled = true;
                state.waiting--;
                const index = state.queue.indexOf(waiter);
                if (index >= 0) state.queue.splice(index, 1);
                this._emit('key_429', id, { reason: 'key_queue_timeout', waiting: state.waiting });
                reject(createKeyConcurrencyError(id, 'key_queue_timeout', { queueTimeoutMs }));
            }, queueTimeoutMs);
            state.queue.push(waiter);
        });
    }

    async _acquireDistributed(keyId, { maxConcurrency, queueLimit, queueTimeoutMs, coordination }) {
        const state = this._state(keyId);
        const attempt = async () => coordination.acquirePotluckKeyLease(keyId, {
            maxConcurrency,
            ttlMs: Math.max(queueTimeoutMs, 120_000)
        });
        const immediate = await attempt();
        if (immediate?.acquired) return { keyId, shadow: false, release: immediate.release };

        this._emit('key_capacity_exhausted', keyId, {
            active: Number(immediate?.active || 0),
            maxConcurrency,
            waiting: state.waiting
        });
        if (state.waiting >= queueLimit) {
            this._emit('key_429', keyId, { reason: 'key_capacity_exhausted', active: immediate?.active || 0, waiting: state.waiting });
            throw createKeyConcurrencyError(keyId, 'key_capacity_exhausted', { active: immediate?.active || 0, maxConcurrency, waiting: state.waiting });
        }

        state.waiting++;
        return new Promise((resolve, reject) => {
            const waiter = { settled: false, timer: null, poller: null, resolve, reject };
            const finish = (error, lease) => {
                if (waiter.settled) return;
                waiter.settled = true;
                state.waiting = Math.max(0, state.waiting - 1);
                clearTimeout(waiter.timer);
                clearTimeout(waiter.poller);
                if (error) reject(error); else resolve({ keyId, shadow: false, release: lease.release });
            };
            const startedAt = this.now();
            const poll = async () => {
                if (waiter.settled) return;
                if (this.now() - startedAt >= queueTimeoutMs) {
                    this._emit('key_429', keyId, { reason: 'key_queue_timeout', waiting: state.waiting });
                    finish(createKeyConcurrencyError(keyId, 'key_queue_timeout', { queueTimeoutMs }));
                    return;
                }
                try {
                    const lease = await attempt();
                    if (lease?.acquired) {
                        finish(null, lease);
                        return;
                    }
                } catch (error) {
                    finish(error);
                    return;
                }
                waiter.poller = setTimeout(poll, 50);
            };
            waiter.timer = setTimeout(() => poll(), queueTimeoutMs);
            poll();
        });
    }

    _lease(keyId, counted) {
        let released = false;
        return {
            keyId,
            shadow: false,
            release: async () => {
                if (released || !counted) return false;
                released = true;
                const state = this._state(keyId);
                state.active = Math.max(0, state.active - 1);
                const waiter = state.queue.shift();
                if (waiter && !waiter.settled) {
                    waiter.settled = true;
                    clearTimeout(waiter.timer);
                    state.waiting = Math.max(0, state.waiting - 1);
                    state.active++;
                    waiter.resolve(this._lease(keyId, true));
                }
                return true;
            }
        };
    }

    snapshot(keyId = null) {
        const entries = keyId === null ? [...this.states.entries()] : [[String(keyId), this._state(keyId)]];
        return Object.fromEntries(entries.map(([id, state]) => [id, { active: state.active, waiting: state.waiting }]));
    }
}

export function createKeyConcurrencyLeaseId() {
    return crypto.randomUUID();
}
