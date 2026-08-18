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
local probe_owner = ARGV[11] or ''
local probe_ttl_ms = tonumber(ARGV[12] or '30000')
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
local probe_blocked = false
for _, candidate in ipairs(candidates) do
  local cooling = candidate.cooldownHash and candidate.cooldownHash ~= ''
    and redis.call('EXISTS', KEYS[1] .. ':model-cooldown:' .. candidate.cooldownHash) == 1
  local probe_busy = candidate.probeHash and candidate.probeHash ~= ''
    and redis.call('EXISTS', KEYS[1] .. ':model-probe:' .. candidate.probeHash) == 1
  if probe_busy then probe_blocked = true end
  local active_key = KEYS[1] .. ':active:' .. candidate.key
  local now_ms = tonumber(ARGV[6])
  redis.call('ZREMRANGEBYSCORE', active_key, '-inf', now_ms)
  local active = tonumber(redis.call('ZCARD', active_key) or '0')
  local limit = tonumber(candidate.concurrencyLimit or 0)
  if not cooling and not probe_busy and affinity_provider_key and candidate.key == affinity_provider_key then
    affinity_candidate = candidate
    affinity_active = active
  end
  if not cooling and not probe_busy and (limit <= 0 or active < limit) then
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
    local routed_cooling = candidate.cooldownHash and candidate.cooldownHash ~= ''
      and redis.call('EXISTS', KEYS[1] .. ':model-cooldown:' .. candidate.cooldownHash) == 1
    local routed_probe_busy = candidate.probeHash and candidate.probeHash ~= ''
      and redis.call('EXISTS', KEYS[1] .. ':model-probe:' .. candidate.probeHash) == 1
    if candidate.key == routed_provider_key and not routed_cooling and not routed_probe_busy then
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
if best == nil then
  if probe_blocked then return cjson.encode({ probeRejected = true }) end
  return nil
end
if best.probeHash and best.probeHash ~= '' then
  local probe_key = KEYS[1] .. ':model-probe:' .. best.probeHash
  local acquired_probe = redis.call('SET', probe_key, probe_owner, 'PX', probe_ttl_ms, 'NX')
  if not acquired_probe then return cjson.encode({ probeRejected = true }) end
end
local active_key = KEYS[1] .. ':active:' .. best.key
redis.call('ZADD', active_key, tonumber(ARGV[6]) + ttl_ms, lease_id)
redis.call('PEXPIRE', active_key, ttl_ms * 2)
local lease_key = KEYS[1] .. ':lease:' .. lease_id
redis.call('HSET', lease_key, 'epoch', epoch, 'providerKey', best.key, 'workerId', worker_id)
if best.probeHash and best.probeHash ~= '' then
  redis.call('HSET', lease_key, 'probeHash', best.probeHash, 'probeOwner', probe_owner)
end
redis.call('PEXPIRE', lease_key, ttl_ms)
if affinity_key then
  if not affinity_provider_key or not affinity_candidate then
    redis.call('SET', affinity_key, affinity_binding_key or best.key, 'PX', tonumber(ARGV[9]))
  else
    redis.call('PEXPIRE', affinity_key, tonumber(ARGV[9]))
  end
end
return cjson.encode({ leaseId = lease_id, providerType = best.providerType, uuid = best.uuid, probe = best.probeHash and best.probeHash ~= '' })
`;

const RELEASE_SCRIPT = `
local lease_key = KEYS[1] .. ':lease:' .. ARGV[1]
local provider_key = redis.call('HGET', lease_key, 'providerKey')
if not provider_key then return 0 end
local probe_hash = redis.call('HGET', lease_key, 'probeHash')
local probe_owner = redis.call('HGET', lease_key, 'probeOwner')
if redis.call('DEL', lease_key) == 0 then return 0 end
local active_key = KEYS[1] .. ':active:' .. provider_key
redis.call('ZREM', active_key, ARGV[1])
if probe_hash and probe_owner then
  local probe_key = KEYS[1] .. ':model-probe:' .. probe_hash
  if redis.call('GET', probe_key) == probe_owner then redis.call('DEL', probe_key) end
end
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
local probe_hash = ARGV[4] or ''
local probe_owner = ARGV[5] or ''
if probe_hash ~= '' and probe_owner ~= '' then
  local probe_key = KEYS[1] .. ':model-probe:' .. probe_hash
  if redis.call('GET', probe_key) == probe_owner then
    redis.call('PEXPIRE', probe_key, tonumber(ARGV[2]))
  end
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
  if lease.probeHash and lease.probeHash ~= '' and lease.probeOwner and lease.probeOwner ~= '' then
    redis.call('HSET', lease_key, 'probeHash', lease.probeHash, 'probeOwner', lease.probeOwner)
    redis.call('SET', KEYS[1] .. ':model-probe:' .. lease.probeHash, lease.probeOwner, 'PX', tonumber(ARGV[4]))
  end
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

const SET_PROVIDER_MODEL_COOLDOWN_SCRIPT = `
local key = KEYS[1] .. ':model-cooldown:' .. ARGV[1]
redis.call('SET', key, ARGV[2], 'PX', tonumber(ARGV[3]))
return 1
`;

const ACQUIRE_PROVIDER_MODEL_PROBE_SCRIPT = `
local key = KEYS[1] .. ':model-probe:' .. ARGV[1]
local acquired = redis.call('SET', key, ARGV[2], 'PX', tonumber(ARGV[3]), 'NX')
if not acquired then return nil end
return ARGV[2]
`;

const RELEASE_PROVIDER_MODEL_PROBE_SCRIPT = `
local key = KEYS[1] .. ':model-probe:' .. ARGV[1]
if redis.call('GET', key) ~= ARGV[2] then return 0 end
return redis.call('DEL', key)
`;

const ACQUIRE_IMAGE_CAPACITY_SCRIPT = `
local leases_key = KEYS[1] .. ':image-capacity:leases'
local expiry_key = KEYS[1] .. ':image-capacity:expiry'
local now_ms = tonumber(ARGV[6])
local expired = redis.call('ZRANGEBYSCORE', expiry_key, '-inf', now_ms)
for _, lease_id in ipairs(expired) do
  redis.call('HDEL', leases_key, lease_id)
  redis.call('ZREM', expiry_key, lease_id)
end
local used = 0
local values = redis.call('HVALS', leases_key)
for _, value in ipairs(values) do
  local lease = cjson.decode(value)
  used = used + tonumber(lease.bytes or 0)
end
local bytes = tonumber(ARGV[3])
local budget = tonumber(ARGV[4])
if used + bytes > budget then
  return cjson.encode({ acquired = false, usedBytes = used })
end
local lease = cjson.encode({ workerId = ARGV[2], bytes = bytes, requestId = ARGV[7], createdAt = now_ms })
redis.call('HSET', leases_key, ARGV[1], lease)
redis.call('ZADD', expiry_key, now_ms + tonumber(ARGV[5]), ARGV[1])
redis.call('PEXPIRE', leases_key, tonumber(ARGV[5]) * 2)
redis.call('PEXPIRE', expiry_key, tonumber(ARGV[5]) * 2)
return cjson.encode({ acquired = true, leaseId = ARGV[1], usedBytes = used + bytes })
`;

const RESIZE_IMAGE_CAPACITY_SCRIPT = `
local leases_key = KEYS[1] .. ':image-capacity:leases'
local value = redis.call('HGET', leases_key, ARGV[1])
if not value then return cjson.encode({ resized = false, missing = true }) end
local current = cjson.decode(value)
local used = 0
local values = redis.call('HVALS', leases_key)
for _, item in ipairs(values) do
  local lease = cjson.decode(item)
  used = used + tonumber(lease.bytes or 0)
end
local next_bytes = tonumber(ARGV[2])
local next_used = used - tonumber(current.bytes or 0) + next_bytes
current.bytes = next_bytes
redis.call('HSET', leases_key, ARGV[1], cjson.encode(current))
return cjson.encode({ resized = true, overcommitted = next_used > tonumber(ARGV[3]), usedBytes = next_used })
`;

const RELEASE_IMAGE_CAPACITY_SCRIPT = `
local leases_key = KEYS[1] .. ':image-capacity:leases'
local expiry_key = KEYS[1] .. ':image-capacity:expiry'
local removed = redis.call('HDEL', leases_key, ARGV[1])
redis.call('ZREM', expiry_key, ARGV[1])
return removed
`;

const RENEW_IMAGE_CAPACITY_SCRIPT = `
local leases_key = KEYS[1] .. ':image-capacity:leases'
local expiry_key = KEYS[1] .. ':image-capacity:expiry'
if redis.call('HEXISTS', leases_key, ARGV[1]) == 0 then return 0 end
redis.call('ZADD', expiry_key, tonumber(ARGV[2]) + tonumber(ARGV[3]), ARGV[1])
redis.call('PEXPIRE', leases_key, tonumber(ARGV[3]) * 2)
redis.call('PEXPIRE', expiry_key, tonumber(ARGV[3]) * 2)
return 1
`;

const SNAPSHOT_IMAGE_CAPACITY_SCRIPT = `
local leases_key = KEYS[1] .. ':image-capacity:leases'
local expiry_key = KEYS[1] .. ':image-capacity:expiry'
local now_ms = tonumber(ARGV[1])
local expired = redis.call('ZRANGEBYSCORE', expiry_key, '-inf', now_ms)
for _, lease_id in ipairs(expired) do
  redis.call('HDEL', leases_key, lease_id)
  redis.call('ZREM', expiry_key, lease_id)
end
local values = redis.call('HVALS', leases_key)
local used = 0
for _, value in ipairs(values) do
  local lease = cjson.decode(value)
  used = used + tonumber(lease.bytes or 0)
end
return cjson.encode({ activeLeases = #values, usedBytes = used })
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
        probeRequired: candidate.probeRequired === true,
        priority
    };
}

function hashAffinityKey(value) {
    if (!value) return '';
    return createHash('sha256').update(String(value)).digest('hex');
}

function parseRedisInfo(value = '') {
    const result = {};
    for (const line of String(value || '').split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue;
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        result[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return result;
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
        this.activeImageLeases = new Map();
        this.imageCapacityRecoveryRequired = false;
        this.imageCapacityMetrics = {
            acquired: 0,
            rejected: 0,
            released: 0,
            overcommitted: 0,
            renewFailures: 0,
            lastUsedBytes: 0
        };
        this.modelSchedulingMetrics = {
            cooldownWrites: 0,
            probeAcquired: 0,
            probeRejected: 0,
            rateLimited: 0,
            retryAttempts: 0,
            fallbacks: 0,
            byModel: {}
        };
        this.redisMemory = { usedBytes: 0, maxBytes: 0, ratio: 0, degraded: false, critical: false };
        this.redisMemoryCheckedAt = 0;
    }

    async _eval(name, script, args) {
        try {
            return await this.redis.evalScript(name, script, [this.namespace], args);
        } catch (error) {
            throw new CoordinationUnavailableError('Redis runtime coordination is unavailable', error);
        }
    }

    async _checkRedisMemoryPressure() {
        if (!this.redis?.command) return this.redisMemory;
        const now = Date.now();
        if (now - this.redisMemoryCheckedAt < 1000) return this.redisMemory;
        let info;
        try {
            info = parseRedisInfo(await this.redis.command(['INFO', 'MEMORY']));
        } catch (error) {
            throw new CoordinationUnavailableError('Redis memory status is unavailable', error);
        }
        const usedBytes = Number(info.used_memory || 0);
        const maxBytes = Number(info.maxmemory || 0);
        const ratio = maxBytes > 0 ? usedBytes / maxBytes : 0;
        this.redisMemory = {
            usedBytes,
            maxBytes,
            ratio,
            degraded: ratio >= 0.8,
            critical: ratio >= 0.9
        };
        this.redisMemoryCheckedAt = now;
        if (this.redisMemory.critical) {
            throw new CoordinationUnavailableError(`Redis memory pressure is critical (${Math.round(ratio * 100)}%)`);
        }
        return this.redisMemory;
    }

    async acquire(candidates, { affinityKey = '', routedProviderKey = '', requestedModel = '' } = {}) {
        await this._checkRedisMemoryPressure();
        if (!this.bootId || !this.ready || this.recovering) await this.synchronize();
        if (!this.ready || this.recovering) throw new CoordinationUnavailableError('Runtime coordination is recovering');
        const normalized = (candidates || []).map(normalizeCandidate).filter(item => item.providerType && item.uuid);
        if (requestedModel) {
            for (const candidate of normalized) {
                candidate.cooldownHash = hashAffinityKey(`${candidate.providerType}:${candidate.uuid}:${requestedModel}`);
                if (candidate.probeRequired) {
                    candidate.probeHash = hashAffinityKey(`${candidate.providerType}:${candidate.uuid}:${requestedModel}`);
                }
            }
        }
        if (normalized.length === 0) return null;
        const leaseId = randomUUID();
        const probeOwner = `${this.workerId}:${leaseId}`;
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
            String(routedProviderKey || ''),
            probeOwner,
            '30000'
        ]);
        if (!result) return null;
        const lease = typeof result === 'string' ? JSON.parse(result) : result;
        if (lease.probeRejected) {
            this.modelSchedulingMetrics.probeRejected += 1;
            return null;
        }
        if (lease.coordinationRestarted) {
            this.ready = false;
            this.recovering = true;
            throw new CoordinationUnavailableError('Runtime coordination restarted and is recovering');
        }
        if (lease.probe) this.modelSchedulingMetrics.probeAcquired += 1;
        const timer = setInterval(() => {
            this.renew(lease.leaseId).catch(() => {});
        }, this.renewIntervalMs);
        timer.unref?.();
        this.renewTimers.set(lease.leaseId, timer);
        const selectedCandidate = normalized.find(candidate => (
            candidate.providerType === lease.providerType && candidate.uuid === lease.uuid
        ));
        this.activeLeases.set(lease.leaseId, {
            leaseId: lease.leaseId,
            epoch: this.epoch,
            providerKey: `${lease.providerType}:${lease.uuid}`,
            ...(lease.probe && selectedCandidate?.probeHash ? {
                probeHash: selectedCandidate.probeHash,
                probeOwner
            } : {})
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

    async acquireImageCapacity({ bytes, budgetBytes, requestId = '', ttlMs = this.leaseTtlMs } = {}) {
        const normalizedBytes = Math.max(1, Number(bytes) || 1);
        const normalizedBudget = Math.max(1, Number(budgetBytes) || 1);
        if (this.imageCapacityRecoveryRequired) {
            await this.restoreImageCapacityLeases({ budgetBytes: normalizedBudget });
        }
        const leaseId = randomUUID();
        const safeTtlMs = Math.max(1000, Number(ttlMs) || this.leaseTtlMs);
        const requestIdHash = hashAffinityKey(requestId);
        const result = await this._eval('acquire-image-capacity', ACQUIRE_IMAGE_CAPACITY_SCRIPT, [
            leaseId,
            this.workerId,
            String(normalizedBytes),
            String(normalizedBudget),
            String(safeTtlMs),
            String(Date.now()),
            requestIdHash
        ]);
        const state = typeof result === 'string' ? JSON.parse(result) : result;
        this.imageCapacityMetrics.lastUsedBytes = Number(state?.usedBytes || 0);
        if (state?.acquired !== true) {
            this.imageCapacityMetrics.rejected += 1;
            return null;
        }
        const lease = { leaseId, bytes: normalizedBytes, budgetBytes: normalizedBudget, ttlMs: safeTtlMs, requestIdHash };
        const timer = setInterval(() => {
            this.renewImageCapacity(leaseId).catch(() => {
                this.imageCapacityMetrics.renewFailures += 1;
            });
        }, Math.min(20000, Math.max(1000, Math.floor(safeTtlMs / 3))));
        timer.unref?.();
        lease.timer = timer;
        this.activeImageLeases.set(leaseId, lease);
        this.imageCapacityMetrics.acquired += 1;
        return { leaseId, bytes: normalizedBytes, usedBytes: this.imageCapacityMetrics.lastUsedBytes };
    }

    async resizeImageCapacity(leaseId, bytes, { budgetBytes } = {}) {
        const lease = this.activeImageLeases.get(leaseId);
        const normalizedBudget = Math.max(1, Number(budgetBytes || lease?.budgetBytes) || 1);
        const normalizedBytes = Math.max(1, Number(bytes) || 1);
        const result = await this._eval('resize-image-capacity', RESIZE_IMAGE_CAPACITY_SCRIPT, [
            String(leaseId || ''),
            String(normalizedBytes),
            String(normalizedBudget)
        ]);
        const state = typeof result === 'string' ? JSON.parse(result) : result;
        this.imageCapacityMetrics.lastUsedBytes = Number(state?.usedBytes || 0);
        if (state?.resized !== true) {
            this.imageCapacityMetrics.overcommitted += 1;
            return { ...state, resized: false, overcommitted: true };
        }
        if (lease) lease.bytes = normalizedBytes;
        if (state?.overcommitted === true) this.imageCapacityMetrics.overcommitted += 1;
        return { ...state, resized: true, overcommitted: state?.overcommitted === true };
    }

    async renewImageCapacity(leaseId) {
        const lease = this.activeImageLeases.get(leaseId);
        if (!lease) return false;
        const renewed = Number(await this._eval('renew-image-capacity', RENEW_IMAGE_CAPACITY_SCRIPT, [
            leaseId,
            String(Date.now()),
            String(lease.ttlMs)
        ])) === 1;
        if (!renewed) this.imageCapacityRecoveryRequired = true;
        return renewed;
    }

    async restoreImageCapacityLeases({ budgetBytes } = {}) {
        const active = [...this.activeImageLeases.values()];
        if (active.length === 0) {
            this.imageCapacityRecoveryRequired = false;
            return { restored: 0 };
        }
        let restored = 0;
        for (const lease of active) {
            const result = await this._eval('acquire-image-capacity', ACQUIRE_IMAGE_CAPACITY_SCRIPT, [
                lease.leaseId,
                this.workerId,
                String(lease.bytes),
                String(Math.max(1, Number(budgetBytes || lease.budgetBytes) || 1)),
                String(lease.ttlMs),
                String(Date.now()),
                lease.requestIdHash || ''
            ]);
            const state = typeof result === 'string' ? JSON.parse(result) : result;
            if (state?.acquired !== true) {
                this.imageCapacityRecoveryRequired = true;
                throw new CoordinationUnavailableError('Image capacity coordination is recovering');
            }
            restored += 1;
            this.imageCapacityMetrics.lastUsedBytes = Number(state.usedBytes || this.imageCapacityMetrics.lastUsedBytes);
        }
        this.imageCapacityRecoveryRequired = false;
        return { restored };
    }

    async releaseImageCapacity(leaseId) {
        const lease = this.activeImageLeases.get(leaseId);
        if (lease?.timer) clearInterval(lease.timer);
        this.activeImageLeases.delete(leaseId);
        const released = Number(await this._eval('release-image-capacity', RELEASE_IMAGE_CAPACITY_SCRIPT, [String(leaseId || '')])) === 1;
        if (released) this.imageCapacityMetrics.released += 1;
        return released;
    }

    async snapshotImageCapacity() {
        const result = await this._eval('snapshot-image-capacity', SNAPSHOT_IMAGE_CAPACITY_SCRIPT, [String(Date.now())]);
        const state = typeof result === 'string' ? JSON.parse(result) : result;
        this.imageCapacityMetrics.lastUsedBytes = Number(state?.usedBytes || 0);
        return { activeLeases: Number(state?.activeLeases || 0), usedBytes: this.imageCapacityMetrics.lastUsedBytes };
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

    async setProviderModelCooldown(providerType, uuid, model, { retryAfterMs = 30_000, reason = 'upstream_429' } = {}) {
        const scopeHash = hashAffinityKey(`${providerType}:${uuid}:${model}`);
        const ttlMs = Math.max(1000, Number(retryAfterMs) || 30_000);
        const updated = Number(await this._eval('set-provider-model-cooldown', SET_PROVIDER_MODEL_COOLDOWN_SCRIPT, [
            scopeHash,
            String(reason || 'upstream_429'),
            String(ttlMs)
        ])) === 1;
        if (updated) this.modelSchedulingMetrics.cooldownWrites += 1;
        return updated;
    }

    async acquireProviderModelProbe(providerType, uuid, model, { ttlMs = 30_000 } = {}) {
        const scopeHash = hashAffinityKey(`${providerType}:${uuid}:${model}`);
        const owner = `${this.workerId}:${randomUUID()}`;
        const result = await this._eval('acquire-provider-model-probe', ACQUIRE_PROVIDER_MODEL_PROBE_SCRIPT, [
            scopeHash,
            owner,
            String(Math.max(1000, Number(ttlMs) || 30_000))
        ]);
        if (result) this.modelSchedulingMetrics.probeAcquired += 1;
        else this.modelSchedulingMetrics.probeRejected += 1;
        return result ? owner : null;
    }

    async releaseProviderModelProbe(providerType, uuid, model, owner) {
        if (!owner) return false;
        const scopeHash = hashAffinityKey(`${providerType}:${uuid}:${model}`);
        return Number(await this._eval('release-provider-model-probe', RELEASE_PROVIDER_MODEL_PROBE_SCRIPT, [
            scopeHash,
            String(owner)
        ])) === 1;
    }

    updateGeminiSchedulingGauge(model, snapshot = {}) {
        const normalizedModel = String(model || '').trim();
        if (!normalizedModel) return;
        this.modelSchedulingMetrics.byModel[normalizedModel] = {
            schedulable: Math.max(0, Number(snapshot.schedulable) || 0),
            cooling: Math.max(0, Number(snapshot.cooling) || 0),
            quotaUnknown: Math.max(0, Number(snapshot.quotaUnknown) || 0)
        };
    }

    recordGeminiSchedulingEvent(field) {
        if (!['rateLimited', 'retryAttempts', 'fallbacks'].includes(field)) return false;
        this.modelSchedulingMetrics[field] += 1;
        return true;
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
        const lease = this.activeLeases.get(leaseId);
        return Number(await this._eval('renew-provider-lease', RENEW_SCRIPT, [
            leaseId,
            String(this.leaseTtlMs),
            String(Date.now()),
            lease?.probeHash || '',
            lease?.probeOwner || ''
        ])) === 1;
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
            redisMemory: { ...this.redisMemory },
            activeLeases: this.activeLeases.size,
            imageCapacity: {
                ...this.imageCapacityMetrics,
                localActiveLeases: this.activeImageLeases.size,
                recoveryRequired: this.imageCapacityRecoveryRequired
            },
            geminiScheduling: {
                ...this.modelSchedulingMetrics,
                byModel: { ...this.modelSchedulingMetrics.byModel }
            }
        };
    }
}
