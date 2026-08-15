import { createHash, randomUUID } from 'crypto';

export class CoordinationUnavailableError extends Error {
    constructor(message = 'Runtime coordination is unavailable', cause = null) {
        super(message);
        this.name = 'CoordinationUnavailableError';
        this.code = 'COORDINATION_UNAVAILABLE';
        this.status = 503;
        this.statusCode = 503;
        if (cause) this.cause = cause;
    }
}

const ACQUIRE_SCRIPT = `
local epoch = ARGV[1]
local lease_id = ARGV[2]
local ttl_ms = tonumber(ARGV[3])
local worker_id = ARGV[4]
local candidates = cjson.decode(ARGV[5])
local affinity_token = ARGV[8] or ''
local affinity_key = affinity_token ~= '' and (KEYS[1] .. ':affinity:' .. affinity_token) or nil
local affinity_provider_key = affinity_key and redis.call('GET', affinity_key) or nil
local routed_provider_key = ARGV[10] or ''
local boot_id = redis.call('GET', KEYS[1] .. ':recovery:boot')
if not boot_id or boot_id ~= ARGV[7] then
  return cjson.encode({ coordinationRestarted = true, bootId = boot_id })
end
local best = nil
local best_active = nil
local best_priority = nil
local best_preferred = false
local affinity_candidate = nil
local affinity_active = nil
for _, candidate in ipairs(candidates) do
  local active_key = KEYS[1] .. ':active:' .. candidate.key
  local now_ms = tonumber(ARGV[6])
  redis.call('ZREMRANGEBYSCORE', active_key, '-inf', now_ms)
  local active = tonumber(redis.call('ZCARD', active_key) or '0')
  local limit = tonumber(candidate.concurrencyLimit or 0)
  if affinity_provider_key and candidate.key == affinity_provider_key then
    affinity_candidate = candidate
    affinity_active = active
  end
  if limit <= 0 or active < limit then
    local priority = tonumber(candidate.priority or 0)
    local preferred = candidate.preferred == true
    if best == nil
      or (preferred and not best_preferred)
      or (preferred == best_preferred and (active < best_active or (active == best_active and priority < best_priority))) then
      best = candidate
      best_active = active
      best_priority = priority
      best_preferred = preferred
    end
  end
end
if affinity_candidate then
  local affinity_limit = tonumber(affinity_candidate.concurrencyLimit or 0)
  if affinity_limit <= 0 or affinity_active < affinity_limit then
    best = affinity_candidate
  end
elseif affinity_key and affinity_provider_key then
  redis.call('DEL', affinity_key)
end
local affinity_binding_key = best and best.key or nil
if routed_provider_key ~= '' then
  for _, candidate in ipairs(candidates) do
    if candidate.key == routed_provider_key then
      local routed_active_key = KEYS[1] .. ':active:' .. candidate.key
      local routed_now_ms = tonumber(ARGV[6])
      redis.call('ZREMRANGEBYSCORE', routed_active_key, '-inf', routed_now_ms)
      local routed_active = tonumber(redis.call('ZCARD', routed_active_key) or '0')
      local routed_limit = tonumber(candidate.concurrencyLimit or 0)
      if routed_limit <= 0 or routed_active < routed_limit then
        best = candidate
      end
      break
    end
  end
end
if best == nil then return nil end
local active_key = KEYS[1] .. ':active:' .. best.key
redis.call('ZADD', active_key, tonumber(ARGV[6]) + ttl_ms, lease_id)
redis.call('PEXPIRE', active_key, ttl_ms * 2)
local lease_key = KEYS[1] .. ':lease:' .. lease_id
redis.call('HSET', lease_key, 'epoch', epoch, 'providerKey', best.key, 'workerId', worker_id)
redis.call('PEXPIRE', lease_key, ttl_ms)
if affinity_key then
  if not affinity_provider_key or not affinity_candidate then
    redis.call('SET', affinity_key, affinity_binding_key or best.key, 'PX', tonumber(ARGV[9]))
  else
    redis.call('PEXPIRE', affinity_key, tonumber(ARGV[9]))
  end
end
return cjson.encode({ leaseId = lease_id, providerType = best.providerType, uuid = best.uuid })
`;

const RELEASE_SCRIPT = `
local lease_key = KEYS[1] .. ':lease:' .. ARGV[1]
local provider_key = redis.call('HGET', lease_key, 'providerKey')
if not provider_key then return 0 end
if redis.call('DEL', lease_key) == 0 then return 0 end
local active_key = KEYS[1] .. ':active:' .. provider_key
redis.call('ZREM', active_key, ARGV[1])
return 1
`;

const RENEW_SCRIPT = `
local lease_key = KEYS[1] .. ':lease:' .. ARGV[1]
if redis.call('EXISTS', lease_key) == 0 then return 0 end
redis.call('PEXPIRE', lease_key, tonumber(ARGV[2]))
local provider_key = redis.call('HGET', lease_key, 'providerKey')
if provider_key then
  local active_key = KEYS[1] .. ':active:' .. provider_key
  redis.call('ZADD', active_key, tonumber(ARGV[3]) + tonumber(ARGV[2]), ARGV[1])
  redis.call('PEXPIRE', active_key, tonumber(ARGV[2]) * 2)
end
return 1
`;

const ACQUIRE_REFRESH_FENCE_SCRIPT = `
local provider_key = ARGV[1]
local owner = ARGV[2]
local ttl_ms = tonumber(ARGV[3])
local lock_key = KEYS[1] .. ':refresh-lock:' .. provider_key
if redis.call('EXISTS', lock_key) == 1 then return nil end
local fence_key = KEYS[1] .. ':refresh-fence:' .. provider_key
local fence = redis.call('INCR', fence_key)
redis.call('HSET', lock_key, 'owner', owner, 'fence', fence)
redis.call('PEXPIRE', lock_key, ttl_ms)
return fence
`;

const RELEASE_REFRESH_FENCE_SCRIPT = `
local lock_key = KEYS[1] .. ':refresh-lock:' .. ARGV[1]
if redis.call('HGET', lock_key, 'owner') ~= ARGV[2] then return 0 end
if redis.call('HGET', lock_key, 'fence') ~= ARGV[3] then return 0 end
return redis.call('DEL', lock_key)
`;

const RENEW_REFRESH_FENCE_SCRIPT = `
local lock_key = KEYS[1] .. ':refresh-lock:' .. ARGV[1]
if redis.call('HGET', lock_key, 'owner') ~= ARGV[2] then return 0 end
if redis.call('HGET', lock_key, 'fence') ~= ARGV[3] then return 0 end
redis.call('PEXPIRE', lock_key, tonumber(ARGV[4]))
return 1
`;

const RECOVER_WORKER_LEASES_SCRIPT = `
local worker_key = KEYS[1] .. ':recovery:workers'
local boot_key = KEYS[1] .. ':recovery:boot'
local boot_id = redis.call('GET', boot_key)
if not boot_id then
  boot_id = ARGV[5]
  redis.call('SET', boot_key, boot_id)
end
redis.call('SADD', worker_key, ARGV[1])
local leases = cjson.decode(ARGV[6])
for _, lease in ipairs(leases) do
  local lease_key = KEYS[1] .. ':lease:' .. lease.leaseId
  redis.call('HSET', lease_key, 'epoch', lease.epoch or '', 'providerKey', lease.providerKey or '', 'workerId', ARGV[1])
  redis.call('PEXPIRE', lease_key, tonumber(ARGV[4]))
  local active_key = KEYS[1] .. ':active:' .. lease.providerKey
  redis.call('ZADD', active_key, tonumber(ARGV[4]) + tonumber(redis.call('TIME')[1]) * 1000, lease.leaseId)
  redis.call('PEXPIRE', active_key, tonumber(ARGV[4]) * 2)
end
local count = redis.call('SCARD', worker_key)
return cjson.encode({ bootId = boot_id, ready = count >= tonumber(ARGV[2]), readyWorkers = count })
`;

const VALIDATE_REFRESH_FENCE_SCRIPT = `
local fence_key = KEYS[1] .. ':refresh-fence:' .. ARGV[1]
return tonumber(redis.call('GET', fence_key) or '0') == tonumber(ARGV[2]) and 1 or 0
`;

const RECORD_HOT_REQUEST_SCRIPT = `
local namespace = KEYS[1]
local affinity_hash = ARGV[1]
local observation_hash = ARGV[2]
local now_ms = tonumber(ARGV[3])
local window_ms = tonumber(ARGV[4])
local ttl_ms = tonumber(ARGV[5])
local hot_key = namespace .. ':hot:' .. affinity_hash
local cutoff = now_ms - window_ms
redis.call('ZREMRANGEBYSCORE', hot_key, '-inf', cutoff)
redis.call('ZADD', hot_key, 'NX', now_ms, observation_hash)
redis.call('PEXPIRE', hot_key, ttl_ms)
return cjson.encode({ count = redis.call('ZCARD', hot_key), ttlMs = ttl_ms })
`;

const RESOLVE_PROMPT_CACHE_KEY_SCRIPT = `
local cache_key = KEYS[1] .. ':prompt-cache:' .. ARGV[1]
local proposed_value = ARGV[2]
local ttl_ms = tonumber(ARGV[3])
local existing = redis.call('GET', cache_key)
if existing then
  redis.call('PEXPIRE', cache_key, ttl_ms)
  return existing
end
redis.call('SET', cache_key, proposed_value, 'PX', ttl_ms, 'NX')
local resolved = redis.call('GET', cache_key)
if resolved then redis.call('PEXPIRE', cache_key, ttl_ms) end
return resolved
`;

function normalizeCandidate(candidate, priority) {
    const providerType = String(candidate.providerType || '');
    const uuid = String(candidate.uuid || '');
    const concurrencyLimit = Number.parseInt(candidate.concurrencyLimit, 10);
    return {
        providerType,
        uuid,
        key: `${providerType}:${uuid}`,
        concurrencyLimit: Number.isFinite(concurrencyLimit) && concurrencyLimit > 0 ? concurrencyLimit : 0,
        preferred: candidate.preferred === true,
        priority
    };
}

function hashAffinityKey(value) {
    if (!value) return '';
    return createHash('sha256').update(String(value)).digest('hex');
}

export class RedisLeaseCoordinator {
    constructor({ redis, epoch = 'default', workerId = `worker-${process.pid}`, leaseTtlMs = 120000, affinityTtlMs = 24 * 60 * 60 * 1000, expectedWorkers = 1 } = {}) {
        if (!redis?.evalScript) throw new TypeError('Redis executor with evalScript() is required');
        this.redis = redis;
        this.epoch = epoch;
        this.workerId = workerId;
        this.expectedWorkers = Math.max(1, Number(expectedWorkers) || 1);
        this.recovering = false;
        this.ready = this.expectedWorkers === 1;
        this.bootId = null;
        this.leaseTtlMs = leaseTtlMs;
        this.affinityTtlMs = affinityTtlMs;
        this.namespace = `aiclient2api:${epoch}`;
        this.renewIntervalMs = Math.min(20000, Math.max(1000, Math.floor(this.leaseTtlMs / 3)));
        this.renewTimers = new Map();
        this.activeLeases = new Map();
    }

    async _eval(name, script, args) {
        try {
            return await this.redis.evalScript(name, script, [this.namespace], args);
        } catch (error) {
            throw new CoordinationUnavailableError('Redis runtime coordination is unavailable', error);
        }
    }

    async acquire(candidates, { affinityKey = '', routedProviderKey = '' } = {}) {
        if (!this.bootId || !this.ready || this.recovering) await this.synchronize();
        if (!this.ready || this.recovering) throw new CoordinationUnavailableError('Runtime coordination is recovering');
        const normalized = (candidates || []).map(normalizeCandidate).filter(item => item.providerType && item.uuid);
        if (normalized.length === 0) return null;
        const leaseId = randomUUID();
        const result = await this._eval('acquire-provider-lease', ACQUIRE_SCRIPT, [
            this.epoch,
            leaseId,
            String(this.leaseTtlMs),
            this.workerId,
            JSON.stringify(normalized),
            String(Date.now()),
            this.bootId || '',
            hashAffinityKey(affinityKey),
            String(this.affinityTtlMs),
            String(routedProviderKey || '')
        ]);
        if (!result) return null;
        const lease = typeof result === 'string' ? JSON.parse(result) : result;
        if (lease.coordinationRestarted) {
            this.ready = false;
            this.recovering = true;
            throw new CoordinationUnavailableError('Runtime coordination restarted and is recovering');
        }
        const timer = setInterval(() => {
            this.renew(lease.leaseId).catch(() => {});
        }, this.renewIntervalMs);
        timer.unref?.();
        this.renewTimers.set(lease.leaseId, timer);
        this.activeLeases.set(lease.leaseId, {
            leaseId: lease.leaseId,
            epoch: this.epoch,
            providerKey: `${lease.providerType}:${lease.uuid}`
        });
        return lease;
    }

    async recordHotRequest(affinityKey, { observationId = '', now = Date.now(), windowMs = 60 * 60 * 1000, bucketMs = 10000 } = {}) {
        const normalizedAffinityKey = String(affinityKey || '');
        const normalizedObservationId = String(observationId || randomUUID());
        if (!normalizedAffinityKey) return { count: 0 };
        const safeWindowMs = Math.max(1000, Number(windowMs) || 60 * 60 * 1000);
        const safeBucketMs = Math.max(1000, Math.min(safeWindowMs, Number(bucketMs) || 10000));
        const ttlMs = safeWindowMs + (safeBucketMs * 2);
        const result = await this._eval('record-hot-request', RECORD_HOT_REQUEST_SCRIPT, [
            hashAffinityKey(normalizedAffinityKey),
            hashAffinityKey(normalizedObservationId),
            String(Number(now) || Date.now()),
            String(safeWindowMs),
            String(ttlMs)
        ]);
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        return { count: Number(parsed?.count || 0), ttlMs };
    }

    async resolvePromptCacheKey(scope, { ttlMs = 60 * 60 * 1000 } = {}) {
        const normalizedScope = String(scope || '').trim();
        if (!normalizedScope) throw new TypeError('Prompt cache scope is required');
        const safeTtlMs = Math.max(60_000, Number(ttlMs) || 60 * 60 * 1000);
        const result = await this._eval('resolve-prompt-cache-key', RESOLVE_PROMPT_CACHE_KEY_SCRIPT, [
            hashAffinityKey(normalizedScope),
            randomUUID(),
            String(safeTtlMs)
        ]);
        if (!result) throw new CoordinationUnavailableError('Redis prompt cache key resolution returned no value');
        return String(result);
    }

    async release(leaseId) {
        if (!leaseId) return false;
        const timer = this.renewTimers.get(leaseId);
        if (timer) clearInterval(timer);
        this.renewTimers.delete(leaseId);
        this.activeLeases.delete(leaseId);
        return Number(await this._eval('release-provider-lease', RELEASE_SCRIPT, [leaseId])) === 1;
    }

    async renew(leaseId) {
        if (!leaseId) return false;
        return Number(await this._eval('renew-provider-lease', RENEW_SCRIPT, [leaseId, String(this.leaseTtlMs), String(Date.now())])) === 1;
    }

    async synchronize(activeLeases = [...this.activeLeases.values()]) {
        const proposedBootId = randomUUID();
        const result = await this._eval('recover-worker-leases', RECOVER_WORKER_LEASES_SCRIPT, [
            this.workerId,
            String(this.expectedWorkers),
            this.bootId || '',
            String(this.leaseTtlMs),
            proposedBootId,
            JSON.stringify(activeLeases)
        ]);
        const state = typeof result === 'string' ? JSON.parse(result) : result;
        if (this.bootId && this.bootId !== state.bootId) this.recovering = true;
        this.bootId = state.bootId;
        this.ready = state.ready === true;
        if (this.ready) this.recovering = false;
        return { ...state, recovering: this.recovering };
    }

    async acquireRefreshFence(providerType, uuid, ttlMs = 60000) {
        const providerKey = `${providerType}:${uuid}`;
        const result = await this._eval('acquire-refresh-fence', ACQUIRE_REFRESH_FENCE_SCRIPT, [
            providerKey,
            this.workerId,
            String(ttlMs)
        ]);
        return result === null ? null : Number(result);
    }

    async releaseRefreshFence(providerType, uuid, fence) {
        const providerKey = `${providerType}:${uuid}`;
        return Number(await this._eval('release-refresh-fence', RELEASE_REFRESH_FENCE_SCRIPT, [
            providerKey,
            this.workerId,
            String(fence)
        ])) === 1;
    }

    async renewRefreshFence(providerType, uuid, fence, ttlMs = 60000) {
        const providerKey = `${providerType}:${uuid}`;
        return Number(await this._eval('renew-refresh-fence', RENEW_REFRESH_FENCE_SCRIPT, [
            providerKey,
            this.workerId,
            String(fence),
            String(ttlMs)
        ])) === 1;
    }

    async validateRefreshFence(providerType, uuid, fence) {
        const providerKey = `${providerType}:${uuid}`;
        return Number(await this._eval('validate-refresh-fence', VALIDATE_REFRESH_FENCE_SCRIPT, [
            providerKey,
            String(fence)
        ])) === 1;
    }

    getStatus() {
        return {
            ready: this.ready,
            recovering: this.recovering,
            bootId: this.bootId,
            activeLeases: this.activeLeases.size
        };
    }
}
