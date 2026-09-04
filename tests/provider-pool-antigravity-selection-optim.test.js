import { jest } from '@jest/globals';
import crypto from 'crypto';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import requestContext, { readRoutingWaits } from '../src/utils/context.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['gemini-antigravity']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

const providerType = 'gemini-antigravity';

function provider(uuid, extra = {}) {
    return {
        uuid,
        customName: uuid,
        isHealthy: true,
        lastKnownAntigravityPlan: 'pro',
        usageCount: 0,
        lastUsed: extra.lastUsed || new Date(Date.now() - 60_000).toISOString(),
        supportedModels: ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
        antigravityQuotaHealth: { families: {}, models: {} },
        ...extra
    };
}

function createManager(providers) {
    return new ProviderPoolManager({ [providerType]: providers }, {
        persistenceEnabled: false,
        globalConfig: { antigravityElasticRouting: { enabled: true } }
    });
}

describe('Antigravity selection hot-path optimizations', () => {
    test('orders coordinated candidates in one sort without mutating every node', () => {
        const manager = createManager([
            provider('agy-b', { lastUsed: new Date(Date.now() - 10_000).toISOString(), usageCount: 4 }),
            provider('agy-a', { lastUsed: new Date(Date.now() - 90_000).toISOString(), usageCount: 1 }),
            provider('agy-c', { lastUsed: new Date(Date.now() - 30_000).toISOString(), usageCount: 2 })
        ]);
        const candidates = manager.providerStatus[providerType];
        const usageBefore = candidates.map(item => item.config.usageCount);

        const ordered = manager._orderCoordinatedCandidates(candidates, providerType, 'gemini-2.5-flash-lite');

        expect(ordered.map(item => item.uuid || item.config.uuid)).toEqual(
            [...candidates]
                .sort((a, b) => manager._compareProviderCandidates(a, b, 'gemini-2.5-flash-lite', {}))
                .map(item => item.uuid || item.config.uuid)
        );
        expect(candidates.map(item => item.config.usageCount)).toEqual(usageBefore);
        expect(ordered).toHaveLength(3);
    });

    test('memoizes Antigravity credential hashes', () => {
        const manager = createManager([provider('agy-hash')]);
        const spy = jest.spyOn(crypto, 'createHash');
        const before = spy.mock.calls.length;
        const first = manager._getAntigravityCredentialHash('agy-hash');
        const second = manager._getAntigravityCredentialHash('agy-hash');
        const created = spy.mock.calls.length - before;
        spy.mockRestore();
        expect(first).toBe(second);
        expect(created).toBe(1);
    });

    test('does not hydrate Codex pool snapshots for Antigravity acquireSlot', async () => {
        const coordination = {
            getRuntimeSnapshot: jest.fn(async () => null),
            acquireRuntimeSnapshotLock: jest.fn(async () => 'lock-owner'),
            releaseRuntimeSnapshotLock: jest.fn(async () => true),
            setRuntimeSnapshot: jest.fn(async () => true),
            acquire: jest.fn(async candidates => ({
                leaseId: 'lease-1',
                providerType: candidates[0].providerType,
                uuid: candidates[0].uuid
            })),
            release: jest.fn(async () => true)
        };
        const manager = createManager([
            provider('agy-a'),
            provider('agy-b', { lastUsed: new Date(Date.now() - 30_000).toISOString() })
        ]);
        manager.coordination = coordination;

        await requestContext.run({ requestId: 'no-codex-hydrate' }, async () => {
            const selected = await manager.acquireSlot(providerType, 'gemini-2.5-flash-lite');
            expect(selected?.uuid).toBeTruthy();
            const waits = readRoutingWaits();
            expect(waits.selectionHydrateMs).toBe(0);
            expect(coordination.getRuntimeSnapshot.mock.calls
                .map(([scope]) => String(scope || ''))
                .filter(scope => scope.startsWith('codex-pool:'))).toEqual([]);
            expect(coordination.acquireRuntimeSnapshotLock.mock.calls
                .map(([scope]) => String(scope || ''))
                .filter(scope => scope.startsWith('codex-pool:'))).toEqual([]);
            expect(Object.keys(waits)).toEqual(expect.arrayContaining([
                'selectionPlanFilterMs',
                'selectionRankMs',
                'selectionHydrateMs',
                'availabilityRefreshMs',
                'credentialLeaseWaitMs'
            ]));
        });
    });
});
