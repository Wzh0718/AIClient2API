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
        this.scriptCalls = [];
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
        if (name === 'acquire-provider-lease') {
            const [epoch, leaseId, ttlMs, workerId, candidatesJson, _nowMs, observedBootId, affinityKey = '', _affinityTtlMs, routedProviderKey = ''] = args;
            if (observedBootId !== this.bootId) return JSON.stringify({ coordinationRestarted: true, bootId: this.bootId });
            const candidates = JSON.parse(candidatesJson);
            const mappedKey = affinityKey ? this.affinity.get(affinityKey) : null;
            const mapped = mappedKey && candidates.find(candidate => candidate.key === mappedKey);
            const baseSelected = (mapped && (mapped.concurrencyLimit <= 0 || (this.active.get(mapped.key) || 0) < mapped.concurrencyLimit))
                ? mapped
                : candidates
                .filter(candidate => candidate.concurrencyLimit <= 0 || (this.active.get(candidate.key) || 0) < candidate.concurrencyLimit)
                .sort((a, b) => {
                    const preferredDiff = Number(b.preferred === true) - Number(a.preferred === true);
                    if (preferredDiff !== 0) return preferredDiff;
                    const activeDiff = (this.active.get(a.key) || 0) - (this.active.get(b.key) || 0);
                    if (activeDiff !== 0) return activeDiff;
                    return Number(a.priority || 0) - Number(b.priority || 0);
                })[0];
            const routed = routedProviderKey
                ? candidates.find(candidate => candidate.key === routedProviderKey)
                : null;
            const selected = routed && (routed.concurrencyLimit <= 0 || (this.active.get(routed.key) || 0) < routed.concurrencyLimit)
                ? routed
                : baseSelected;
            if (!selected) return null;
            this.active.set(selected.key, (this.active.get(selected.key) || 0) + 1);
            if (affinityKey && !mapped && baseSelected) this.affinity.set(affinityKey, baseSelected.key);
            this.leases.set(leaseId, { epoch, providerKey: selected.key, workerId, ttlMs: Number(ttlMs) });
            return JSON.stringify({ leaseId, providerType: selected.providerType, uuid: selected.uuid });
        }
        if (name === 'recover-worker-leases') {
            const [workerId, expectedWorkers, observedBootId, _leaseTtlMs, proposedBootId, leasesJson] = args;
            if (!this.bootId) this.bootId = proposedBootId;
            for (const lease of JSON.parse(leasesJson)) {
                this.leases.set(lease.leaseId, lease);
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
            return 1;
        }
        if (name === 'renew-provider-lease') return this.leases.has(args[0]) ? 1 : 0;
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
});
