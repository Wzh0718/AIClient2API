import { randomUUID } from 'node:crypto';

const NS = 'aiclient2api:edge-admission:v1';

const ACQUIRE_SCRIPT = `
local active = KEYS[1]
local waiting = KEYS[2]
local lease = KEYS[3]
local request = KEYS[4]
local globalWaiting = KEYS[5]
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local queueLimit = tonumber(ARGV[4])
local globalLimit = tonumber(ARGV[9])
local leaseId = ARGV[5]
local requestId = ARGV[6]
local timeoutAt = tonumber(ARGV[7])
local existing = redis.call('GET', request)
if existing then
  local existingLease = redis.call('HGET', 'aiclient2api:edge-admission:v1:lease:' .. existing, 'status')
  if existingLease == 'active' then return cjson.encode({ acquired=true, leaseId=existing, idempotent=true }) end
  if existingLease == 'waiting' then return cjson.encode({ acquired=false, queued=true, leaseId=existing, idempotent=true }) end
  redis.call('DEL', request)
end
redis.call('ZREMRANGEBYSCORE', active, '-inf', now)
redis.call('ZREMRANGEBYSCORE', waiting, '-inf', now)
redis.call('ZREMRANGEBYSCORE', globalWaiting, '-inf', now)
local activeCount = redis.call('ZCARD', active)
if limit <= 0 or activeCount < limit then
  redis.call('ZADD', active, now + ttl, leaseId)
  redis.call('HSET', lease, 'keyHash', ARGV[8], 'requestId', requestId, 'status', 'active', 'createdAt', now)
  redis.call('PEXPIRE', lease, ttl)
  redis.call('SET', request, leaseId, 'PX', ttl)
  return cjson.encode({ acquired=true, leaseId=leaseId, active=activeCount + 1 })
end
local waitingCount = redis.call('ZCARD', waiting)
local globalCount = redis.call('ZCARD', globalWaiting)
if queueLimit <= 0 or waitingCount >= queueLimit or (globalLimit > 0 and globalCount >= globalLimit) then
  return cjson.encode({ acquired=false, queued=false, reason='queue_full', active=activeCount, waiting=waitingCount })
end
redis.call('ZADD', waiting, timeoutAt, leaseId)
redis.call('ZADD', globalWaiting, timeoutAt, leaseId)
redis.call('HSET', lease, 'keyHash', ARGV[8], 'requestId', requestId, 'status', 'waiting', 'createdAt', now, 'timeoutAt', timeoutAt)
redis.call('PEXPIRE', lease, math.max(ttl, timeoutAt - now))
redis.call('SET', request, leaseId, 'PX', math.max(ttl, timeoutAt - now))
return cjson.encode({ acquired=false, queued=true, leaseId=leaseId, active=activeCount, waiting=waitingCount + 1 })
`;

const PROMOTE_SCRIPT = `
local active = KEYS[1]
local waiting = KEYS[2]
local leasePrefix = KEYS[3]
local globalWaiting = KEYS[4]
local requestPrefix = KEYS[5]
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', active, '-inf', now)
redis.call('ZREMRANGEBYSCORE', waiting, '-inf', now)
redis.call('ZREMRANGEBYSCORE', globalWaiting, '-inf', now)
local activeCount = redis.call('ZCARD', active)
if limit > 0 and activeCount >= limit then return 0 end
local first = redis.call('ZRANGE', waiting, 0, 0)
if #first == 0 then return 0 end
local leaseId = first[1]
redis.call('ZREM', waiting, leaseId)
redis.call('ZREM', globalWaiting, leaseId)
redis.call('ZADD', active, now + ttl, leaseId)
local lease = leasePrefix .. leaseId
redis.call('HSET', lease, 'status', 'active', 'promotedAt', now)
redis.call('PEXPIRE', lease, ttl)
local requestId = redis.call('HGET', lease, 'requestId')
  if requestId then redis.call('SET', requestPrefix .. requestId, leaseId, 'PX', ttl) end
return 1
`;

const RELEASE_SCRIPT = `
local lease = KEYS[1]
local active = KEYS[2]
local waiting = KEYS[3]
local request = KEYS[4]
local globalWaiting = KEYS[5]
local leaseId = ARGV[1]
local status = redis.call('HGET', lease, 'status')
if not status then return 0 end
redis.call('ZREM', active, leaseId)
redis.call('ZREM', waiting, leaseId)
redis.call('ZREM', globalWaiting, leaseId)
redis.call('DEL', lease)
redis.call('DEL', request)
return 1
`;

const CANCEL_SCRIPT = `
local lease = KEYS[1]
local active = KEYS[2]
local waiting = KEYS[3]
local request = KEYS[4]
local globalWaiting = KEYS[5]
local leaseId = ARGV[1]
if redis.call('HGET', lease, 'status') ~= 'waiting' then return 0 end
redis.call('ZREM', waiting, leaseId)
redis.call('ZREM', globalWaiting, leaseId)
redis.call('DEL', lease)
redis.call('DEL', request)
return 1
`;

const RENEW_SCRIPT = `
local lease = KEYS[1]
local active = KEYS[2]
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
if redis.call('HGET', lease, 'status') ~= 'active' then return 0 end
redis.call('ZADD', active, now + ttl, ARGV[3])
redis.call('PEXPIRE', lease, ttl)
return 1
`;

const parse = value => {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
};

export class EdgeAdmissionCoordinator {
    constructor(options = {}) {
        this.redis = options.redis || null;
        this.namespace = options.namespace || NS;
        this.leaseTtlMs = Math.max(1000, Number(options.leaseTtlMs || 120000));
        this.pollMs = Math.max(10, Number(options.pollMs || 50));
        this.redisTimeoutMs = Math.max(25, Number(options.redisTimeoutMs || 250));
        this.pollers = new Map();
    }

    _keys(keyHash, leaseId, requestId) {
        const prefix = `${this.namespace}:${keyHash}`;
        return {
            active: `${prefix}:active`, waiting: `${prefix}:waiting`,
            globalWaiting: `${this.namespace}:waiting`,
            lease: `${this.namespace}:lease:${leaseId}`, request: `${this.namespace}:request:${requestId}`
        };
    }

    async _eval(name, script, keys, args) {
        return this.redis.evalScript(name, script, keys, args);
    }

    _startPoller(keyHash, limit) {
        if (!this.redis?.command) return;
        const current = this.pollers.get(keyHash);
        if (current) { current.limit = limit; return; }
        const prefix = `${this.namespace}:${keyHash}`;
        const poller = { limit, timer: null, running: false };
        const tick = async () => {
            if (poller.running) return;
            poller.running = true;
            try {
                await this._eval('edge-admission-promote-v1', PROMOTE_SCRIPT,
                    [`${prefix}:active`, `${prefix}:waiting`, `${this.namespace}:lease:`, `${this.namespace}:waiting`, `${this.namespace}:request:`],
                    [Date.now(), this.leaseTtlMs, poller.limit]);
                const waiting = Number(await this.redis.command(['ZCARD', `${prefix}:waiting`], { timeoutMs: this.redisTimeoutMs }) || 0);
                if (waiting <= 0) {
                    clearInterval(poller.timer);
                    this.pollers.delete(keyHash);
                }
            } catch {
                // A later tick retries; callers handle Redis failure policy.
            } finally { poller.running = false; }
        };
        poller.timer = setInterval(tick, this.pollMs);
        poller.timer.unref?.();
        this.pollers.set(keyHash, poller);
    }

    async acquire(keyHash, policy = {}, requestId = randomUUID(), options = {}) {
        if (!this.redis) throw new Error('Redis is not configured');
        const leaseId = randomUUID();
        const limit = Math.max(0, Number(policy.edgeAdmissionConcurrencyLimit ?? policy.concurrencyLimit ?? 0));
        const queueLimit = Math.max(0, Number(policy.edgeAdmissionQueueLimit ?? policy.queueLimit ?? 0));
        const timeoutMs = Math.max(1, Number(policy.edgeAdmissionQueueTimeoutMs ?? policy.queueTimeoutMs ?? 300000));
        const globalLimit = Math.max(0, Number(policy.edgeAdmissionQueueGlobalLimit ?? process.env.EDGE_AUTH_QUEUE_GLOBAL_LIMIT ?? 512));
        const started = Date.now();
        const keys = this._keys(keyHash, leaseId, requestId);
        const attempt = async () => parse(await this._eval('edge-admission-acquire-v1', ACQUIRE_SCRIPT,
            [keys.active, keys.waiting, keys.lease, keys.request, keys.globalWaiting],
            [Date.now(), this.leaseTtlMs, limit, queueLimit, leaseId, requestId, Date.now() + timeoutMs, keyHash, globalLimit]));
        let result = await attempt();
        if (result?.acquired) {
            const resolvedLeaseId = result.leaseId || leaseId;
            return { ...result, leaseId: resolvedLeaseId, keyHash, release: () => this.release(keyHash, resolvedLeaseId, requestId), renew: () => this.renew(keyHash, resolvedLeaseId) };
        }
        if (!result?.queued) {
            const error = new Error('Edge admission capacity exhausted');
            error.code = 'EDGE_ADMISSION_CAPACITY_EXHAUSTED'; error.status = 429; error.details = result;
            throw error;
        }
        this._startPoller(keyHash, limit);
        const queuedLeaseId = result.leaseId || leaseId;
        const queuedKeys = queuedLeaseId === leaseId ? keys : this._keys(keyHash, queuedLeaseId, requestId);
        const abortSignal = options.signal;
        while (Date.now() - started < timeoutMs) {
            if (abortSignal?.aborted) {
                await this.cancel(keyHash, queuedLeaseId, requestId);
                await this.release(keyHash, queuedLeaseId, requestId);
                const error = new Error('Edge admission request cancelled');
                error.code = 'EDGE_ADMISSION_CANCELLED'; error.status = 499;
                throw error;
            }
            await new Promise(resolve => {
                const timer = setTimeout(resolve, this.pollMs);
                if (abortSignal) {
                    const onAbort = () => { clearTimeout(timer); resolve(); };
                    abortSignal.addEventListener('abort', onAbort, { once: true });
                }
            });
            if (abortSignal?.aborted) {
                await this.cancel(keyHash, queuedLeaseId, requestId);
                await this.release(keyHash, queuedLeaseId, requestId);
                const error = new Error('Edge admission request cancelled');
                error.code = 'EDGE_ADMISSION_CANCELLED'; error.status = 499;
                throw error;
            }
            if (!this.redis?.command) {
                await this._eval('edge-admission-promote-v1', PROMOTE_SCRIPT,
                    [queuedKeys.active, queuedKeys.waiting, `${this.namespace}:lease:`, queuedKeys.globalWaiting, `${this.namespace}:request:`], [Date.now(), this.leaseTtlMs, limit]);
            }
            const status = parse(await this._eval('edge-admission-status-v1',
                `return redis.call('HGET', KEYS[1], 'status')`, [queuedKeys.lease], []));
            if (status === 'active') return { acquired: true, queued: true, leaseId: queuedLeaseId, keyHash, waitMs: Date.now() - started, release: () => this.release(keyHash, queuedLeaseId, requestId), renew: () => this.renew(keyHash, queuedLeaseId) };
        }
        await this.release(keyHash, queuedLeaseId, requestId);
        const error = new Error('Edge admission queue timeout');
        error.code = 'EDGE_ADMISSION_QUEUE_TIMEOUT'; error.status = 429;
        throw error;
    }

    async cancel(keyHash, leaseId, requestId = '') {
        if (!this.redis || !leaseId) return false;
        const keys = this._keys(keyHash, leaseId, requestId || leaseId);
        return Number(await this._eval('edge-admission-cancel-v1', CANCEL_SCRIPT,
            [keys.lease, keys.active, keys.waiting, keys.request, keys.globalWaiting], [leaseId])) > 0;
    }

    async release(keyHash, leaseId, requestId = '') {
        if (!this.redis || !leaseId) return false;
        const keys = this._keys(keyHash, leaseId, requestId || leaseId);
        return Number(await this._eval('edge-admission-release-v1', RELEASE_SCRIPT,
            [keys.lease, keys.active, keys.waiting, keys.request, keys.globalWaiting], [leaseId])) > 0;
    }

    async renew(keyHash, leaseId) {
        if (!this.redis || !leaseId) return false;
        const keys = this._keys(keyHash, leaseId, leaseId);
        return Number(await this._eval('edge-admission-renew-v1', RENEW_SCRIPT,
            [keys.lease, keys.active], [Date.now(), this.leaseTtlMs, leaseId])) > 0;
    }

    async status(keyHash, leaseId = null) {
        if (!this.redis) return { redis: false };
        if (leaseId) {
            const keys = this._keys(keyHash, leaseId, leaseId);
            const [status, storedKeyHash, requestId] = await Promise.all([
                this.redis.command(['HGET', keys.lease, 'status'], { timeoutMs: this.redisTimeoutMs }),
                this.redis.command(['HGET', keys.lease, 'keyHash'], { timeoutMs: this.redisTimeoutMs }),
                this.redis.command(['HGET', keys.lease, 'requestId'], { timeoutMs: this.redisTimeoutMs })
            ]);
            return { redis: true, leaseId, status, keyHash: storedKeyHash, requestId };
        }
        const prefix = `${this.namespace}:${keyHash}`;
        const [active, waiting] = await Promise.all([
            this.redis.command(['ZCARD', `${prefix}:active`], { timeoutMs: this.redisTimeoutMs }),
            this.redis.command(['ZCARD', `${prefix}:waiting`], { timeoutMs: this.redisTimeoutMs })
        ]);
        return { redis: true, active: Number(active || 0), waiting: Number(waiting || 0) };
    }
}

export { NS as EDGE_ADMISSION_NAMESPACE };
