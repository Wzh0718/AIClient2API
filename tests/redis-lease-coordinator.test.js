import { RedisLeaseCoordinator, CoordinationUnavailableError } from '../src/runtime/redis-lease-coordinator.js';

class InMemoryRedisExecutor {
    constructor() {
        this.active = new Map();
        this.leases = new Map();
        this.available = true;
        this.refreshLocks = new Map();
        this.fences = new Map();
        this.bootId = 'boot-1';
        this.readyWorkers = new Set();
        this.affinity = new Map();
        this.hotRequests = new Map();
        this.promptCacheKeys = new Map();
        this.modelCooldowns = new Map();
        this.modelProbeLeases = new Map();
        this.imageCapacityLeases = new Map();
        this.scriptCalls = [];
        this.now = 0;
    }

    async evalScript(name, _script, keys, args) {
        if (!this.available) throw new Error('redis unavailable');
        this.scriptCalls.push({ name, keys, args });
        if (name === 'resolve-prompt-cache-key') {
            const [scopeHash, proposedValue] = args;
            const key = `${keys[0]}:prompt-cache:${scopeHash}`;
            if (!this.promptCacheKeys.has(key)) this.promptCacheKeys.set(key, proposedValue);
            return this.promptCacheKeys.get(key);
        }
        if (name === 'record-hot-request') {
            const [affinityHash, observationHash, nowMs, windowMs, ttlMs] = args;
            const key = `${keys[0]}:hot:${affinityHash}`;
            const cutoff = Number(nowMs) - Number(windowMs);
            const observations = this.hotRequests.get(key) || new Map();
            for (const [member, timestamp] of observations.entries()) {
                if (timestamp <= cutoff) observations.delete(member);
            }
            if (!observations.has(observationHash)) {
                observations.set(observationHash, Number(nowMs));
            }
            this.hotRequests.set(key, observations);
            return JSON.stringify({ count: observations.size, ttlMs: Number(ttlMs) });
        }
        if (name === 'set-provider-model-cooldown') {
            const [cooldownHash, value, ttlMs] = args;
            this.modelCooldowns.set(cooldownHash, { value, expiresAt: Date.now() + Number(ttlMs) });
            return 1;
        }
        if (name === 'acquire-provider-model-probe') {
            const [probeHash, owner] = args;
            if (this.modelProbeLeases.has(probeHash)) return null;
            this.modelProbeLeases.set(probeHash, owner);
            return owner;
        }
        if (name === 'release-provider-model-probe') {
            const [probeHash, owner] = args;
            if (this.modelProbeLeases.get(probeHash) !== owner) return 0;
            this.modelProbeLeases.delete(probeHash);
            return 1;
        }
        if (name === 'acquire-provider-lease') {
            const [epoch, leaseId, ttlMs, workerId, candidatesJson, _nowMs, observedBootId, affinityKey = '', _affinityTtlMs, routedProviderKey = '', probeOwner = '', probeTtlMs = '30000'] = args;
            if (observedBootId !== this.bootId) return JSON.stringify({ coordinationRestarted: true, bootId: this.bootId });
            const candidates = JSON.parse(candidatesJson).filter(candidate => {
                if (!candidate.cooldownHash) return true;
                const state = this.modelCooldowns.get(candidate.cooldownHash);
                if (!state) return true;
                if (state.expiresAt <= Date.now()) {
                    this.modelCooldowns.delete(candidate.cooldownHash);
                    return true;
                }
                return false;
            });
            for (const [probeHash, lease] of this.modelProbeLeases.entries()) {
                if (lease.expiresAt <= this.now) this.modelProbeLeases.delete(probeHash);
            }
            const probeBlocked = candidates.some(candidate => candidate.probeHash && this.modelProbeLeases.has(candidate.probeHash));
            const probeEligibleCandidates = candidates.filter(candidate => !candidate.probeHash || !this.modelProbeLeases.has(candidate.probeHash));
            const mappedKey = affinityKey ? this.affinity.get(affinityKey) : null;
            const mapped = mappedKey && probeEligibleCandidates.find(candidate => candidate.key === mappedKey);
            const baseSelected = (mapped && (mapped.concurrencyLimit <= 0 || (this.active.get(mapped.key) || 0) < mapped.concurrencyLimit))
                ? mapped
                : probeEligibleCandidates
                .filter(candidate => candidate.concurrencyLimit <= 0 || (this.active.get(candidate.key) || 0) < candidate.concurrencyLimit)
                .sort((a, b) => {
                    const preferredDiff = Number(b.preferred === true) - Number(a.preferred === true);
                    if (preferredDiff !== 0) return preferredDiff;
                    const activeDiff = (this.active.get(a.key) || 0) - (this.active.get(b.key) || 0);
                    if (activeDiff !== 0) return activeDiff;
                    return Number(a.priority || 0) - Number(b.priority || 0);
                })[0];
            const routed = routedProviderKey
                ? probeEligibleCandidates.find(candidate => candidate.key === routedProviderKey)
                : null;
            const selected = routed && (routed.concurrencyLimit <= 0 || (this.active.get(routed.key) || 0) < routed.concurrencyLimit)
                ? routed
                : baseSelected;
            if (!selected) return probeBlocked ? JSON.stringify({ probeRejected: true }) : null;
            if (selected.probeHash) {
                this.modelProbeLeases.set(selected.probeHash, {
                    owner: probeOwner,
                    expiresAt: this.now + Number(probeTtlMs)
                });
            }
            this.active.set(selected.key, (this.active.get(selected.key) || 0) + 1);
            if (affinityKey && !mapped && baseSelected) this.affinity.set(affinityKey, baseSelected.key);
            this.leases.set(leaseId, { epoch, providerKey: selected.key, workerId, ttlMs: Number(ttlMs), probeHash: selected.probeHash, probeOwner });
            return JSON.stringify({ leaseId, providerType: selected.providerType, uuid: selected.uuid, probe: Boolean(selected.probeHash) });
        }
        if (name === 'acquire-image-capacity') {
            const [leaseId, workerId, bytes, budgetBytes, ttlMs] = args;
            const usedBytes = [...this.imageCapacityLeases.values()].reduce((sum, lease) => sum + lease.bytes, 0);
            if (usedBytes + Number(bytes) > Number(budgetBytes)) {
                return JSON.stringify({ acquired: false, usedBytes });
            }
            this.imageCapacityLeases.set(leaseId, { workerId, bytes: Number(bytes), ttlMs: Number(ttlMs) });
            return JSON.stringify({ acquired: true, leaseId, usedBytes: usedBytes + Number(bytes) });
        }
        if (name === 'resize-image-capacity') {
            const [leaseId, bytes, budgetBytes] = args;
            const current = this.imageCapacityLeases.get(leaseId);
            if (!current) return JSON.stringify({ resized: false, missing: true });
            const usedWithoutCurrent = [...this.imageCapacityLeases.entries()]
                .filter(([id]) => id !== leaseId)
                .reduce((sum, [, lease]) => sum + lease.bytes, 0);
            if (usedWithoutCurrent + Number(bytes) > Number(budgetBytes)) {
                current.bytes = Number(bytes);
                return JSON.stringify({ resized: true, overcommitted: true, usedBytes: usedWithoutCurrent + current.bytes });
            }
            current.bytes = Number(bytes);
            return JSON.stringify({ resized: true, usedBytes: usedWithoutCurrent + current.bytes });
        }
        if (name === 'release-image-capacity') {
            return this.imageCapacityLeases.delete(args[0]) ? 1 : 0;
        }
        if (name === 'renew-image-capacity') {
            return this.imageCapacityLeases.has(args[0]) ? 1 : 0;
        }
        if (name === 'snapshot-image-capacity') {
            return JSON.stringify({
                activeLeases: this.imageCapacityLeases.size,
                usedBytes: [...this.imageCapacityLeases.values()].reduce((sum, lease) => sum + lease.bytes, 0)
            });
        }
        if (name === 'recover-worker-leases') {
            const [workerId, expectedWorkers, observedBootId, _leaseTtlMs, proposedBootId, leasesJson] = args;
            if (!this.bootId) this.bootId = proposedBootId;
            for (const lease of JSON.parse(leasesJson)) {
                this.leases.set(lease.leaseId, lease);
                if (lease.probeHash && lease.probeOwner) {
                    this.modelProbeLeases.set(lease.probeHash, {
                        owner: lease.probeOwner,
                        expiresAt: this.now + Number(_leaseTtlMs)
                    });
                }
            }
            this.readyWorkers.add(workerId);
            return JSON.stringify({ bootId: this.bootId, ready: this.readyWorkers.size >= Number(expectedWorkers), readyWorkers: this.readyWorkers.size });
        }
        if (name === 'release-provider-lease') {
            const leaseId = args[0];
            const lease = this.leases.get(leaseId);
            if (!lease) return 0;
            this.leases.delete(leaseId);
            this.active.set(lease.providerKey, Math.max(0, (this.active.get(lease.providerKey) || 0) - 1));
            if (lease.probeHash && this.modelProbeLeases.get(lease.probeHash)?.owner === lease.probeOwner) this.modelProbeLeases.delete(lease.probeHash);
            return 1;
        }
        if (name === 'renew-provider-lease') {
            const [leaseId, ttlMs, _nowMs, probeHash, probeOwner] = args;
            if (!this.leases.has(leaseId)) return 0;
            const probe = probeHash ? this.modelProbeLeases.get(probeHash) : null;
            if (probe && probe.owner === probeOwner) probe.expiresAt = this.now + Number(ttlMs);
            return 1;
        }
        if (name === 'renew-refresh-fence') {
            const lock = this.refreshLocks.get(args[0]);
            return lock && lock.owner === args[1] && String(lock.fence) === String(args[2]) ? 1 : 0;
        }
        if (name === 'acquire-refresh-fence') {
            const providerKey = args[0];
            if (this.refreshLocks.has(providerKey)) return null;
            const fence = (this.fences.get(providerKey) || 0) + 1;
            this.fences.set(providerKey, fence);
            this.refreshLocks.set(providerKey, { owner: args[1], fence });
            return fence;
        }
        if (name === 'release-refresh-fence') {
            const lock = this.refreshLocks.get(args[0]);
            if (!lock || lock.owner !== args[1] || String(lock.fence) !== String(args[2])) return 0;
            this.refreshLocks.delete(args[0]);
            return 1;
        }
        if (name === 'validate-refresh-fence') return Number(this.fences.get(args[0]) || 0) === Number(args[1]) ? 1 : 0;
        throw new Error(`unknown script ${name}`);
    }
}

describe('RedisLeaseCoordinator', () => {
    test('reports Gemini scheduling gauges and rate-limit, retry, and fallback counters', () => {
        const coordinator = new RedisLeaseCoordinator({
            redis: new InMemoryRedisExecutor(),
            epoch: 'test',
            workerId: 'w1'
        });

        coordinator.updateGeminiSchedulingGauge('gemini-2.5-flash', {
            schedulable: 2,
            cooling: 1,
            quotaUnknown: 1
        });
        coordinator.recordGeminiSchedulingEvent('rateLimited');
        coordinator.recordGeminiSchedulingEvent('retryAttempts');
        coordinator.recordGeminiSchedulingEvent('fallbacks');

        expect(coordinator.getStatus().geminiScheduling).toMatchObject({
            rateLimited: 1,
            retryAttempts: 1,
            fallbacks: 1,
            byModel: {
                'gemini-2.5-flash': {
                    schedulable: 2,
                    cooling: 1,
                    quotaUnknown: 1
                }
            }
        });
    });

    test('shares Antigravity model cooldown and a single unknown-quota probe across workers', async () => {
        const redis = new InMemoryRedisExecutor();
        const first = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const second = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w2' });
        const candidates = [{ providerType: 'gemini-antigravity', uuid: 'gemini-1', concurrencyLimit: 0 }];

        await first.setProviderModelCooldown('gemini-antigravity', 'gemini-1', 'gemini-2.5-flash', {
            retryAfterMs: 60_000,
            reason: 'upstream_429'
        });
        await expect(second.acquire(candidates, { requestedModel: 'gemini-2.5-flash' })).resolves.toBeNull();

        const firstProbe = await first.acquireProviderModelProbe('gemini-antigravity', 'gemini-2', 'gemini-2.5-flash');
        const secondProbe = await second.acquireProviderModelProbe('gemini-antigravity', 'gemini-2', 'gemini-2.5-flash');
        expect(firstProbe).toBeTruthy();
        expect(secondProbe).toBeNull();
        await first.releaseProviderModelProbe('gemini-antigravity', 'gemini-2', 'gemini-2.5-flash', firstProbe);
        await expect(second.acquireProviderModelProbe('gemini-antigravity', 'gemini-2', 'gemini-2.5-flash')).resolves.toBeTruthy();

        expect(JSON.stringify(redis.scriptCalls)).not.toContain('gemini-2.5-flash');
    });

    test('allows only one in-flight request for an unknown Antigravity quota candidate', async () => {
        const redis = new InMemoryRedisExecutor();
        const first = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const second = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w2' });
        const candidates = [{
            providerType: 'gemini-antigravity',
            uuid: 'gemini-unknown',
            concurrencyLimit: 10,
            probeRequired: true
        }];

        const probe = await first.acquire(candidates, { requestedModel: 'gemini-2.5-flash' });
        await expect(second.acquire(candidates, { requestedModel: 'gemini-2.5-flash' })).resolves.toBeNull();
        expect(first.getStatus().geminiScheduling.probeAcquired).toBe(1);
        expect(second.getStatus().geminiScheduling.probeRejected).toBe(1);
        await first.release(probe.leaseId);
        await expect(second.acquire(candidates, { requestedModel: 'gemini-2.5-flash' })).resolves.toMatchObject({ uuid: 'gemini-unknown' });
    });

    test('renews the unknown-quota probe lease together with a long-running provider lease', async () => {
        const redis = new InMemoryRedisExecutor();
        const first = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1', leaseTtlMs: 60_000 });
        const second = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w2', leaseTtlMs: 60_000 });
        const candidates = [{
            providerType: 'gemini-antigravity',
            uuid: 'gemini-slow',
            concurrencyLimit: 10,
            probeRequired: true
        }];

        const lease = await first.acquire(candidates, { requestedModel: 'gemini-2.5-flash' });
        redis.now = 25_000;
        await first.renew(lease.leaseId);
        redis.now = 35_000;

        await expect(second.acquire(candidates, { requestedModel: 'gemini-2.5-flash' })).resolves.toBeNull();
        await first.release(lease.leaseId);
    });

    test('restores an in-flight unknown-quota probe after Redis restarts', async () => {
        const redis = new InMemoryRedisExecutor();
        const first = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1', expectedWorkers: 2 });
        const second = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w2', expectedWorkers: 2 });
        await first.synchronize();
        await second.synchronize();
        await first.synchronize();
        const candidates = [{
            providerType: 'gemini-antigravity',
            uuid: 'gemini-restart',
            concurrencyLimit: 10,
            probeRequired: true
        }];

        await first.acquire(candidates, { requestedModel: 'gemini-2.5-flash' });
        redis.bootId = 'boot-2';
        redis.readyWorkers.clear();
        redis.leases.clear();
        redis.modelProbeLeases.clear();

        await expect(first.synchronize()).resolves.toMatchObject({ ready: false, recovering: true });
        await expect(second.synchronize()).resolves.toMatchObject({ ready: true });
        await expect(first.synchronize()).resolves.toMatchObject({ ready: true });
        await expect(second.acquire(candidates, { requestedModel: 'gemini-2.5-flash' })).resolves.toBeNull();
    });

    test('shares prompt cache keys across workers without exposing the raw scope', async () => {
        const redis = new InMemoryRedisExecutor();
        const first = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const second = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w2' });

        const firstKey = await first.resolvePromptCacheKey('provider-a:session:private-session');
        const secondKey = await second.resolvePromptCacheKey('provider-a:session:private-session');
        const otherProviderKey = await second.resolvePromptCacheKey('provider-b:session:private-session');

        expect(secondKey).toBe(firstKey);
        expect(otherProviderKey).not.toBe(firstKey);
        const calls = redis.scriptCalls.filter(call => call.name === 'resolve-prompt-cache-key');
        expect(JSON.stringify(calls)).not.toContain('private-session');
    });

    test('reports coordination failure while resolving prompt cache keys', async () => {
        const redis = new InMemoryRedisExecutor();
        redis.available = false;
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });

        await expect(coordinator.resolvePromptCacheKey('provider-a:session:one'))
            .rejects.toBeInstanceOf(CoordinationUnavailableError);
    });

    test('enforces explicit limits globally while keeping zero as unlimited', async () => {
        const redis = new InMemoryRedisExecutor();
        const first = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const second = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w2' });
        const limited = [{ providerType: 'p', uuid: 'limited', concurrencyLimit: 1 }];

        const lease = await first.acquire(limited);
        await expect(second.acquire(limited)).resolves.toBeNull();
        await first.release(lease.leaseId);
        await expect(second.acquire(limited)).resolves.toMatchObject({ uuid: 'limited' });

        const unlimited = [{ providerType: 'p', uuid: 'unlimited', concurrencyLimit: 0 }];
        const leases = await Promise.all(Array.from({ length: 20 }, () => first.acquire(unlimited)));
        expect(leases.every(Boolean)).toBe(true);
    });

    test('orders coordinated candidates by active load before local priority', async () => {
        const redis = new InMemoryRedisExecutor();
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const candidates = [
            { providerType: 'p', uuid: 'first', concurrencyLimit: 0 },
            { providerType: 'p', uuid: 'second', concurrencyLimit: 0 }
        ];

        const firstLease = await coordinator.acquire(candidates);
        expect(firstLease.uuid).toBe('first');

        const secondLease = await coordinator.acquire(candidates);
        expect(secondLease.uuid).toBe('second');
    });

    test('keeps the preferred affinity provider until its explicit concurrency limit is reached', async () => {
        const redis = new InMemoryRedisExecutor();
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const candidates = [
            { providerType: 'p', uuid: 'affinity', concurrencyLimit: 2, preferred: true },
            { providerType: 'p', uuid: 'fallback', concurrencyLimit: 0 }
        ];

        const first = await coordinator.acquire(candidates);
        const second = await coordinator.acquire(candidates);
        const overflow = await coordinator.acquire(candidates);

        expect(first.uuid).toBe('affinity');
        expect(second.uuid).toBe('affinity');
        expect(overflow.uuid).toBe('fallback');

        await coordinator.release(first.leaseId);
        const recovered = await coordinator.acquire(candidates);
        expect(recovered.uuid).toBe('affinity');
    });

    test('persists affinity across workers, temporarily diverts on saturation, then returns after release', async () => {
        const redis = new InMemoryRedisExecutor();
        const first = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const second = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w2' });
        const candidates = [
            { providerType: 'p', uuid: 'affinity', concurrencyLimit: 1, preferred: true },
            { providerType: 'p', uuid: 'fallback', concurrencyLimit: 0 }
        ];

        const firstLease = await first.acquire(candidates, { affinityKey: 'session:one' });
        const diverted = await second.acquire(candidates, { affinityKey: 'session:one' });
        expect(firstLease.uuid).toBe('affinity');
        expect(diverted.uuid).toBe('fallback');
        expect([...redis.affinity.values()]).toEqual(['p:affinity']);
        expect([...redis.affinity.keys()][0]).not.toContain('session:one');

        await first.release(firstLease.leaseId);
        const recovered = await second.acquire(candidates, { affinityKey: 'session:one' });
        expect(recovered.uuid).toBe('affinity');
    });

    test('keeps the base affinity binding when a hot request is temporarily routed to a shard', async () => {
        const redis = new InMemoryRedisExecutor();
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const candidates = [
            { providerType: 'p', uuid: 'base', concurrencyLimit: 2, preferred: true },
            { providerType: 'p', uuid: 'shard', concurrencyLimit: 2 }
        ];

        const routed = await coordinator.acquire(candidates, {
            affinityKey: 'session:hot',
            routedProviderKey: 'p:shard'
        });

        expect(routed.uuid).toBe('shard');
        expect([...redis.affinity.values()]).toEqual(['p:base']);
        await coordinator.release(routed.leaseId);
        const base = await coordinator.acquire(candidates, { affinityKey: 'session:hot' });
        expect(base.uuid).toBe('base');
    });

    test('counts one hot affinity request globally across workers and deduplicates retries', async () => {
        const redis = new InMemoryRedisExecutor();
        const first = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const second = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w2' });

        await expect(first.recordHotRequest('session:secret', {
            observationId: 'request-1',
            now: 1000,
            windowMs: 60000
        })).resolves.toMatchObject({ count: 1 });
        await expect(second.recordHotRequest('session:secret', {
            observationId: 'request-1',
            now: 1001,
            windowMs: 60000
        })).resolves.toMatchObject({ count: 1 });
        await expect(second.recordHotRequest('session:secret', {
            observationId: 'request-2',
            now: 1002,
            windowMs: 60000
        })).resolves.toMatchObject({ count: 2 });

        const calls = redis.scriptCalls.filter(call => call.name === 'record-hot-request');
        expect(calls).toHaveLength(3);
        expect(JSON.stringify(calls)).not.toContain('session:secret');
        expect(JSON.stringify(calls)).not.toContain('request-1');
    });

    test('expires hot request observations outside the configured window', async () => {
        const redis = new InMemoryRedisExecutor();
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });

        await coordinator.recordHotRequest('session:one', {
            observationId: 'old-request',
            now: 1000,
            windowMs: 10000
        });
        const result = await coordinator.recordHotRequest('session:one', {
            observationId: 'new-request',
            now: 11001,
            windowMs: 10000
        });

        expect(result.count).toBe(1);
    });

    test('fails closed when global hot request counting cannot reach Redis', async () => {
        const redis = new InMemoryRedisExecutor();
        redis.available = false;
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });

        await expect(coordinator.recordHotRequest('session:one', {
            observationId: 'request-1'
        })).rejects.toBeInstanceOf(CoordinationUnavailableError);
    });


    test('release is idempotent and never makes active counts negative', async () => {
        const redis = new InMemoryRedisExecutor();
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const lease = await coordinator.acquire([{ providerType: 'p', uuid: 'one', concurrencyLimit: 1 }]);

        await expect(coordinator.release(lease.leaseId)).resolves.toBe(true);
        await expect(coordinator.release(lease.leaseId)).resolves.toBe(false);
        expect(redis.active.get('p:one')).toBe(0);
    });

    test('fails closed when Redis is unavailable', async () => {
        const redis = new InMemoryRedisExecutor();
        redis.available = false;
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });

        await expect(coordinator.acquire([{ providerType: 'p', uuid: 'one', concurrencyLimit: 0 }]))
            .rejects.toBeInstanceOf(CoordinationUnavailableError);
    });

    test('issues monotonic refresh fences and rejects stale writers', async () => {
        const redis = new InMemoryRedisExecutor();
        const first = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const second = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w2' });

        const fence1 = await first.acquireRefreshFence('provider', 'uuid');
        await expect(second.acquireRefreshFence('provider', 'uuid')).resolves.toBeNull();
        await first.releaseRefreshFence('provider', 'uuid', fence1);
        const fence2 = await second.acquireRefreshFence('provider', 'uuid');

        expect(fence2).toBeGreaterThan(fence1);
        await expect(first.validateRefreshFence('provider', 'uuid', fence1)).resolves.toBe(false);
        await expect(second.validateRefreshFence('provider', 'uuid', fence2)).resolves.toBe(true);
    });

    test('keeps a refresh lock alive during a slow OAuth refresh', async () => {
        const redis = new InMemoryRedisExecutor();
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const fence = await coordinator.acquireRefreshFence('provider', 'uuid', 30);
        await expect(coordinator.renewRefreshFence('provider', 'uuid', fence, 30)).resolves.toBe(true);
    });

    test('fails closed after Redis restart until every execution worker restores its leases', async () => {
        const redis = new InMemoryRedisExecutor();
        const first = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1', expectedWorkers: 2 });
        const second = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w2', expectedWorkers: 2 });
        await expect(first.synchronize()).resolves.toMatchObject({ ready: false });
        await expect(second.synchronize()).resolves.toMatchObject({ ready: true });
        await expect(first.synchronize()).resolves.toMatchObject({ ready: true });
        const lease = await first.acquire([{ providerType: 'p', uuid: 'one', concurrencyLimit: 1 }]);

        redis.bootId = 'boot-2';
        redis.readyWorkers.clear();
        redis.leases.clear();
        await expect(first.synchronize()).resolves.toMatchObject({ ready: false, recovering: true });
        await expect(first.acquire([{ providerType: 'p', uuid: 'two', concurrencyLimit: 1 }]))
            .rejects.toMatchObject({ code: 'COORDINATION_UNAVAILABLE' });
        await expect(second.synchronize()).resolves.toMatchObject({ ready: true });
        expect(redis.leases.has(lease.leaseId)).toBe(true);
    });

    test('shares one weighted image-memory budget across workers', async () => {
        const redis = new InMemoryRedisExecutor();
        const first = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const second = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w2' });

        const firstLease = await first.acquireImageCapacity({ bytes: 70, budgetBytes: 100, requestId: 'req-1' });
        await expect(second.acquireImageCapacity({ bytes: 40, budgetBytes: 100, requestId: 'req-2' })).resolves.toBeNull();
        await expect(second.acquireImageCapacity({ bytes: 30, budgetBytes: 100, requestId: 'req-2' })).resolves.toMatchObject({ bytes: 30 });
        await expect(first.releaseImageCapacity(firstLease.leaseId)).resolves.toBe(true);

        await expect(second.snapshotImageCapacity()).resolves.toMatchObject({ activeLeases: 1, usedBytes: 30 });
    });

    test('keeps an existing image result even when an actual-size lease increase would exceed the budget', async () => {
        const redis = new InMemoryRedisExecutor();
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const lease = await coordinator.acquireImageCapacity({ bytes: 80, budgetBytes: 100, requestId: 'req-1' });

        await expect(coordinator.resizeImageCapacity(lease.leaseId, 120, { budgetBytes: 100 }))
            .resolves.toMatchObject({ resized: true, overcommitted: true, usedBytes: 120 });
        await expect(coordinator.snapshotImageCapacity()).resolves.toMatchObject({ usedBytes: 120 });
        await expect(coordinator.releaseImageCapacity(lease.leaseId)).resolves.toBe(true);
    });

    test('restores active image leases before admitting new work after Redis loses lease state', async () => {
        const redis = new InMemoryRedisExecutor();
        const coordinator = new RedisLeaseCoordinator({ redis, epoch: 'test', workerId: 'w1' });
        const existing = await coordinator.acquireImageCapacity({ bytes: 70, budgetBytes: 100, requestId: 'req-existing' });

        redis.imageCapacityLeases.clear();
        await expect(coordinator.renewImageCapacity(existing.leaseId)).resolves.toBe(false);
        expect(coordinator.getStatus().imageCapacity.recoveryRequired).toBe(true);

        await expect(coordinator.acquireImageCapacity({ bytes: 20, budgetBytes: 100, requestId: 'req-new' }))
            .resolves.toMatchObject({ bytes: 20, usedBytes: 90 });
        expect(redis.imageCapacityLeases.size).toBe(2);
    });
});
