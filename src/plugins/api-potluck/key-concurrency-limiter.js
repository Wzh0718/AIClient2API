import crypto from 'node:crypto';

const DISTRIBUTED_QUEUE_POLL_INITIAL_MS = 100;
const DISTRIBUTED_QUEUE_POLL_MAX_MS = 500;

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
        if (!this.states.has(id)) this.states.set(id, { active: 0, waiting: 0, queue: [], distributedPoller: null });
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
        const signal = options.signal;
        if (signal?.aborted) throw createKeyConcurrencyError(id, 'key_queue_cancelled');
        if (maxConcurrency <= 0) return this._lease(id, false);

        if (mode === 'enforce' && typeof options.coordination?.acquirePotluckKeyLease === 'function') {
            return this._acquireDistributed(id, { maxConcurrency, queueLimit, queueTimeoutMs, signal, coordination: options.coordination });
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
            const waiter = { settled: false, timer: null, resolve, reject, signal, onAbort: null };
            waiter.onAbort = () => {
                if (waiter.settled) return;
                waiter.settled = true;
                state.waiting = Math.max(0, state.waiting - 1);
                const index = state.queue.indexOf(waiter);
                if (index >= 0) state.queue.splice(index, 1);
                clearTimeout(waiter.timer);
                this._emit('key_429', id, { reason: 'key_queue_cancelled', waiting: state.waiting });
                reject(createKeyConcurrencyError(id, 'key_queue_cancelled'));
            };
            signal?.addEventListener?.('abort', waiter.onAbort, { once: true });
            waiter.timer = setTimeout(() => {
                if (waiter.settled) return;
                waiter.settled = true;
                state.waiting--;
                const index = state.queue.indexOf(waiter);
                if (index >= 0) state.queue.splice(index, 1);
                signal?.removeEventListener?.('abort', waiter.onAbort);
                this._emit('key_429', id, { reason: 'key_queue_timeout', waiting: state.waiting });
                reject(createKeyConcurrencyError(id, 'key_queue_timeout', { queueTimeoutMs }));
            }, queueTimeoutMs);
            state.queue.push(waiter);
        });
    }

    async _acquireDistributed(keyId, { maxConcurrency, queueLimit, queueTimeoutMs, signal, coordination }) {
        const state = this._state(keyId);
        let reservation = null;
        const attempt = async () => {
            const leaseOptions = { maxConcurrency, ttlMs: Math.max(queueTimeoutMs, 120_000) };
            if (reservation && typeof coordination.acquirePotluckKeyLeaseFromQueue === 'function') {
                return coordination.acquirePotluckKeyLeaseFromQueue(keyId, reservation, leaseOptions);
            }
            return coordination.acquirePotluckKeyLease(keyId, leaseOptions);
        };
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

        if (typeof coordination.reservePotluckKeyQueue === 'function') {
            reservation = await coordination.reservePotluckKeyQueue(keyId, {
                queueLimit,
                ttlMs: Math.max(queueTimeoutMs, 120_000)
            });
            if (reservation?.reserved !== true) {
                this._emit('key_429', keyId, {
                    reason: 'key_capacity_exhausted',
                    active: immediate?.active || 0,
                    waiting: reservation?.waiting || 0
                });
                throw createKeyConcurrencyError(keyId, 'key_capacity_exhausted', {
                    active: immediate?.active || 0,
                    maxConcurrency,
                    waiting: reservation?.waiting || 0
                });
            }
        }

        state.waiting++;
        return new Promise((resolve, reject) => {
            const waiter = { settled: false, timer: null, resolve, reject, signal, onAbort: null, reservation };
            waiter.finish = (error, lease) => {
                if (waiter.settled) return;
                waiter.settled = true;
                state.waiting = Math.max(0, state.waiting - 1);
                const index = state.queue.indexOf(waiter);
                if (index >= 0) state.queue.splice(index, 1);
                clearTimeout(waiter.timer);
                signal?.removeEventListener?.('abort', waiter.onAbort);
                if (reservation && typeof coordination.releasePotluckKeyQueueReservation === 'function') {
                    coordination.releasePotluckKeyQueueReservation(reservation).catch(() => {});
                }
                if (error) reject(error); else resolve({ keyId, shadow: false, release: lease.release });
            };
            waiter.onAbort = () => waiter.finish(createKeyConcurrencyError(keyId, 'key_queue_cancelled'));
            signal?.addEventListener?.('abort', waiter.onAbort, { once: true });
            if (signal?.aborted) waiter.onAbort();
            waiter.timer = setTimeout(() => {
                if (waiter.settled) return;
                this._emit('key_429', keyId, { reason: 'key_queue_timeout', waiting: state.waiting });
                waiter.finish(createKeyConcurrencyError(keyId, 'key_queue_timeout', { queueTimeoutMs }));
            }, queueTimeoutMs);
            if (!waiter.settled) {
                state.queue.push(waiter);
                this._ensureDistributedPoller(keyId, state, coordination, maxConcurrency, queueTimeoutMs);
            }
        });
    }

    _ensureDistributedPoller(keyId, state, coordination, maxConcurrency, queueTimeoutMs) {
        if (state.distributedPoller) return;
        const poller = { timer: null, delayMs: DISTRIBUTED_QUEUE_POLL_INITIAL_MS, running: false };
        state.distributedPoller = poller;
        const schedule = delayMs => {
            if (state.distributedPoller !== poller || state.queue.length === 0) {
                if (state.distributedPoller === poller) state.distributedPoller = null;
                return;
            }
            poller.timer = setTimeout(poll, delayMs);
        };
        const poll = async () => {
            if (poller.running || state.distributedPoller !== poller) return;
            poller.running = true;
            const waiter = state.queue.find(entry => !entry.settled);
            if (!waiter) {
                state.distributedPoller = null;
                poller.running = false;
                return;
            }
            let nextDelayMs = poller.delayMs;
            try {
                const lease = typeof coordination.acquirePotluckKeyLeaseFromQueue === 'function'
                    ? await coordination.acquirePotluckKeyLeaseFromQueue(
                        keyId,
                        waiter.reservation,
                        { maxConcurrency, ttlMs: Math.max(queueTimeoutMs, 120_000) }
                    )
                    : await coordination.acquirePotluckKeyLease(
                        keyId,
                        { maxConcurrency, ttlMs: Math.max(queueTimeoutMs, 120_000) }
                    );
                if (lease?.acquired) {
                    waiter.finish(null, lease);
                    poller.delayMs = DISTRIBUTED_QUEUE_POLL_INITIAL_MS;
                } else {
                    poller.delayMs = Math.min(DISTRIBUTED_QUEUE_POLL_MAX_MS, poller.delayMs * 2);
                }
            } catch (error) {
                waiter.finish(error);
            } finally {
                poller.running = false;
                schedule(nextDelayMs);
            }
        };
        poll();
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
                    waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
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
