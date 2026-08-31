import { describe, expect, test } from '@jest/globals';
import { RedisLeaseCoordinator } from '../src/runtime/redis-lease-coordinator.js';

function createFakeRedis() {
    const values = new Map();
    return {
        async evalScript(_name, _script, _keys, args) {
            const key = args[0];
            if (_name === 'get-runtime-snapshot') return values.get(key) || null;
            if (_name === 'set-runtime-snapshot') {
                values.set(key, args[1]);
                return 1;
            }
            return null;
        }
    };
}

describe('shared runtime snapshots', () => {
    test('stores and reads a Codex pool snapshot through coordination', async () => {
        const coordinator = new RedisLeaseCoordinator({ redis: createFakeRedis(), epoch: 'test' });
        const snapshot = { exhausted: true, stateFingerprint: 'stable', filterReasons: { codex53_quota_exceeded: 2 } };
        await coordinator.setRuntimeSnapshot('codex:openai-codex-oauth:codex53:1', snapshot, { ttlMs: 3000 });
        await expect(coordinator.getRuntimeSnapshot('codex:openai-codex-oauth:codex53:1')).resolves.toEqual(snapshot);
    });
});
