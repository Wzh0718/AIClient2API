import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['gemini-antigravity']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

const usageCachePath = path.join(process.cwd(), 'configs', 'usage-cache.json');
let originalUsageCacheExisted = false;
let originalUsageCacheContent = null;
const managers = [];

function writeUsageCache(instances) {
    fs.mkdirSync(path.dirname(usageCachePath), { recursive: true });
    fs.writeFileSync(usageCachePath, JSON.stringify({
        timestamp: new Date().toISOString(),
        providers: {
            'gemini-antigravity': {
                providerType: 'gemini-antigravity',
                instances
            }
        }
    }), 'utf8');
}

function createManager(providers, coordination = null, globalConfig = {}) {
    const manager = new ProviderPoolManager({ 'gemini-antigravity': providers }, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: { PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json', ...globalConfig },
        coordination
    });
    managers.push(manager);
    return manager;
}

function paidUsage(uuid, items = []) {
    return {
        uuid,
        success: true,
        usage: {
            summary: { plan: 'Google AI Pro' },
            items
        }
    };
}

function provider(uuid, overrides = {}) {
    return {
        uuid,
        customName: uuid,
        isHealthy: true,
        lastKnownAntigravityPlan: 'Pro',
        supportedModels: [
            'gemini-2.5-flash',
            'gemini-3.1-flash-image',
            'gemini-claude-sonnet-4-6',
            'gpt-oss-120b-medium'
        ],
        ...overrides
    };
}

beforeEach(() => {
    originalUsageCacheExisted = fs.existsSync(usageCachePath);
    originalUsageCacheContent = originalUsageCacheExisted ? fs.readFileSync(usageCachePath, 'utf8') : null;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    managers.splice(0).forEach(manager => {
        if (manager.saveTimer) clearTimeout(manager.saveTimer);
    });
    jest.restoreAllMocks();
    if (originalUsageCacheExisted) {
        fs.writeFileSync(usageCachePath, originalUsageCacheContent, 'utf8');
    } else if (fs.existsSync(usageCachePath)) {
        fs.rmSync(usageCachePath, { force: true });
    }
});

describe('provider pool Antigravity quota health', () => {
    test('model cooldown keeps the provider base-healthy and only filters that model', async () => {
        const recoveryTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        writeUsageCache([
            paidUsage('aaa-model-cooled'),
            paidUsage('zzz-fallback')
        ]);
        const cooledProvider = provider('aaa-model-cooled', {
            lastUsed: '2026-08-01T00:00:00Z',
            antigravityQuotaHealth: {
                families: {},
                models: {
                    'gemini-3.1-flash-image': {
                        isHealthy: false,
                        scheduledRecoveryTime: recoveryTime
                    }
                }
            }
        });
        const fallbackProvider = provider('zzz-fallback', { lastUsed: '2026-08-09T00:00:00Z' });
        const manager = createManager([cooledProvider, fallbackProvider]);

        const imageSelection = await manager.selectProvider('gemini-antigravity', 'gemini-3.1-flash-image');

        expect(imageSelection.uuid).toBe('zzz-fallback');
        expect(cooledProvider.isHealthy).toBe(true);

        const textManager = createManager([
            provider('aaa-model-cooled', {
                lastUsed: '2026-08-01T00:00:00Z',
                antigravityQuotaHealth: cooledProvider.antigravityQuotaHealth
            }),
            provider('zzz-fallback', { lastUsed: '2026-08-09T00:00:00Z' })
        ]);
        const textSelection = await textManager.selectProvider('gemini-antigravity', 'gemini-2.5-flash');
        expect(textSelection.uuid).toBe('aaa-model-cooled');
    });

    test('marks an exact model unhealthy without changing provider health', () => {
        const target = provider('provider-one');
        const manager = createManager([target]);
        const recoveryTime = new Date(Date.now() + 60000);

        manager.markAntigravityModelQuotaUnhealthy(
            'gemini-antigravity',
            target,
            'gemini-claude-sonnet-4-6',
            'quota exhausted',
            recoveryTime
        );

        expect(target.isHealthy).toBe(true);
        expect(target.antigravityQuotaHealth.models['claude-sonnet-4-6']).toMatchObject({
            isHealthy: false,
            lastErrorMessage: 'quota exhausted',
            scheduledRecoveryTime: recoveryTime.toISOString(),
            source: 'upstream_429'
        });
    });

    test('marks an exact model unavailable for upstream capacity without changing provider health', () => {
        const target = provider('provider-capacity');
        const manager = createManager([target]);
        const recoveryTime = new Date(Date.now() + 30000);

        manager.markAntigravityModelCapacityUnavailable(
            'gemini-antigravity',
            target,
            'gemini-3.1-flash-lite',
            recoveryTime,
            'MODEL_CAPACITY_EXHAUSTED'
        );

        expect(target.isHealthy).toBe(true);
        expect(target.antigravityQuotaHealth.models['gemini-3.1-flash-lite']).toMatchObject({
            isHealthy: false,
            lastErrorMessage: 'MODEL_CAPACITY_EXHAUSTED',
            scheduledRecoveryTime: recoveryTime.toISOString(),
            source: 'upstream_capacity'
        });
    });

    test('keeps Gemini providers schedulable when official 5h or weekly usage reaches 100 percent', async () => {
        writeUsageCache([
            paidUsage('aaa-gemini-over', [
                { id: 'quota-group:gemini-5h', percent: 100, resetAt: '2026-08-11T00:00:00Z', source: 'retrieveUserQuotaSummary' },
                { id: 'quota-group:gemini-weekly', percent: 100, resetAt: '2026-08-12T00:00:00Z', source: 'retrieveUserQuotaSummary' },
                { id: 'quota-group:3p-5h', percent: 10, resetAt: '2026-08-11T00:00:00Z', source: 'retrieveUserQuotaSummary' }
            ]),
            paidUsage('zzz-gemini-ok', [
                { id: 'quota-group:gemini-5h', percent: 20, source: 'retrieveUserQuotaSummary' },
                { id: 'quota-group:gemini-weekly', percent: 20, source: 'retrieveUserQuotaSummary' }
            ])
        ]);
        const manager = createManager([
            provider('aaa-gemini-over', {
                antigravityGeminiMax5hPercent: 100,
                antigravityGeminiMaxWeeklyPercent: 100,
                lastUsed: '2026-08-01T00:00:00Z'
            }),
            provider('zzz-gemini-ok', {
                antigravityGeminiMax5hPercent: 100,
                antigravityGeminiMaxWeeklyPercent: 100,
                lastUsed: '2026-08-09T00:00:00Z'
            })
        ]);

        const geminiSelection = await manager.selectProvider('gemini-antigravity', 'gemini-2.5-flash');
        expect(geminiSelection.uuid).toBe('aaa-gemini-over');

        const thirdPartyManager = createManager([
            provider('aaa-gemini-over', { antigravityGeminiMax5hPercent: 100, lastUsed: '2026-08-01T00:00:00Z' }),
            provider('zzz-gemini-ok', { antigravityGeminiMax5hPercent: 100, lastUsed: '2026-08-09T00:00:00Z' })
        ]);
        const thirdPartySelection = await thirdPartyManager.selectProvider('gemini-antigravity', 'gemini-claude-sonnet-4-6');
        expect(thirdPartySelection.uuid).toBe('aaa-gemini-over');
    });

    test('ignores stale usage-cache family health when the requested model is not cooling down', async () => {
        writeUsageCache([paidUsage('provider-family-flagged', [
            { id: 'quota-group:gemini-weekly', percent: 100, resetAt: '2099-01-01T00:00:00.000Z' }
        ])]);
        const target = provider('provider-family-flagged', {
            antigravityGeminiMaxWeeklyPercent: 100,
            antigravityQuotaHealth: {
                families: {
                    gemini: {
                        isHealthy: false,
                        scheduledRecoveryTime: '2099-01-01T00:00:00.000Z',
                        source: 'usage_cache'
                    }
                },
                models: {}
            }
        });
        const manager = createManager([target]);

        const selection = await manager.selectProvider('gemini-antigravity', 'gemini-2.5-flash');

        expect(selection.uuid).toBe('provider-family-flagged');
        expect(target.antigravityQuotaHealth.families.gemini).toBeUndefined();
    });

    test('treats an explicit zero threshold as disabling proactive quota filtering', async () => {
        writeUsageCache([
            paidUsage('aaa-zero-disabled', [
                { id: 'quota-group:gemini-5h', percent: 100, resetAt: '2026-08-11T00:00:00Z' }
            ]),
            paidUsage('zzz-fallback', [
                { id: 'quota-group:gemini-5h', percent: 0 }
            ])
        ]);
        const manager = createManager([
            provider('aaa-zero-disabled', { antigravityGeminiMax5hPercent: 0, lastUsed: '2026-08-01T00:00:00Z' }),
            provider('zzz-fallback', { antigravityGeminiMax5hPercent: 100, lastUsed: '2026-08-09T00:00:00Z' })
        ]);

        const selection = await manager.selectProvider('gemini-antigravity', 'gemini-2.5-flash');

        expect(selection.uuid).toBe('aaa-zero-disabled');
    });

    test('does not create family cooldowns from refreshed official usage', async () => {
        const target = provider('provider-recovers', { antigravityGeminiMax5hPercent: 100 });
        writeUsageCache([paidUsage('provider-recovers', [
            { id: 'quota-group:gemini-5h', percent: 100, resetAt: '2026-08-11T00:00:00Z' }
        ])]);
        const manager = createManager([target]);

        const selection = await manager.selectProvider('gemini-antigravity', 'gemini-2.5-flash');

        expect(selection.uuid).toBe('provider-recovers');
        expect(target.antigravityQuotaHealth?.families?.gemini).toBeUndefined();
    });

    test('does not escalate separate model cooldowns into a family cooldown', () => {
        const target = provider('provider-no-escalation');
        const manager = createManager([target]);
        const recoveryTime = new Date(Date.now() + 60000);

        manager.markAntigravityModelQuotaUnhealthy('gemini-antigravity', target, 'gemini-3.1-flash-image', 'image quota', recoveryTime);
        manager.markAntigravityModelQuotaUnhealthy('gemini-antigravity', target, 'gemini-2.5-flash', 'text quota', recoveryTime);

        expect(target.antigravityQuotaHealth.families).toEqual({});
        expect(Object.keys(target.antigravityQuotaHealth.models)).toEqual([
            'gemini-3.1-flash-image',
            'gemini-2.5-flash'
        ]);
    });

    test('returns 429 with the nearest recovery time when every provider has that model cooling down', async () => {
        const firstRecovery = new Date(Date.now() + 60000).toISOString();
        const secondRecovery = new Date(Date.now() + 120000).toISOString();
        writeUsageCache([paidUsage('provider-a'), paidUsage('provider-b')]);
        const manager = createManager([
            provider('provider-a', {
                antigravityQuotaHealth: { families: {}, models: { 'gemini-3.1-flash-image': { isHealthy: false, scheduledRecoveryTime: firstRecovery } } }
            }),
            provider('provider-b', {
                antigravityQuotaHealth: { families: {}, models: { 'gemini-3.1-flash-image': { isHealthy: false, scheduledRecoveryTime: secondRecovery } } }
            })
        ]);

        await expect(manager.selectProvider('gemini-antigravity', 'gemini-3.1-flash-image')).rejects.toMatchObject({
            status: 429,
            quotaScope: 'model',
            quotaKey: 'gemini-3.1-flash-image',
            nextRecoveryTime: firstRecovery
        });

        await expect(manager.acquireSlotWithFallback('gemini-antigravity', 'gemini-3.1-flash-image')).rejects.toMatchObject({
            status: 429,
            quotaScope: 'model',
            quotaKey: 'gemini-3.1-flash-image',
            nextRecoveryTime: firstRecovery
        });
    });

    test('shares an Antigravity negative model snapshot across workers', async () => {
        const recoveryTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const snapshots = new Map();
        const coordination = {
            getRuntimeSnapshot: jest.fn(async scope => snapshots.get(scope) || null),
            setRuntimeSnapshot: jest.fn(async (scope, value) => { snapshots.set(scope, value); return true; }),
            acquireRuntimeSnapshotLock: jest.fn(async () => 'worker-lock'),
            releaseRuntimeSnapshotLock: jest.fn(async () => true),
            deleteRuntimeSnapshot: jest.fn(async scope => snapshots.delete(scope)),
            updateGeminiSchedulingGauge: jest.fn()
        };
        const cooled = provider('credential-a', {
            antigravityQuotaHealth: {
                families: {},
                models: {
                    'gemini-3.1-flash-lite': {
                        isHealthy: false,
                        scheduledRecoveryTime: recoveryTime,
                        source: 'upstream_429'
                    }
                }
            }
        });
        const first = createManager([cooled], coordination);
        await expect(first.selectProvider('gemini-antigravity', 'gemini-3.1-flash-lite')).rejects.toMatchObject({ status: 429 });
        expect(coordination.setRuntimeSnapshot).toHaveBeenCalled();

        const second = createManager([provider('credential-a')], coordination);
        await expect(second.selectProvider('gemini-antigravity', 'gemini-3.1-flash-lite')).rejects.toMatchObject({
            status: 429,
            quotaScope: 'model'
        });
        expect(coordination.getRuntimeSnapshot).toHaveBeenCalled();
    });

    test('stores only credential hashes in the shared Antigravity snapshot', async () => {
        const snapshots = [];
        const coordination = {
            getRuntimeSnapshot: jest.fn(async () => null),
            setRuntimeSnapshot: jest.fn(async (scope, value) => { snapshots.push({ scope, value }); return true; }),
            acquireRuntimeSnapshotLock: jest.fn(async () => 'worker-lock'),
            releaseRuntimeSnapshotLock: jest.fn(async () => true),
            deleteRuntimeSnapshot: jest.fn(async () => true),
            updateGeminiSchedulingGauge: jest.fn()
        };
        const credentialUuid = 'credential-with-sensitive-uuid';
        const manager = createManager([provider(credentialUuid)], coordination);
        await manager.selectProvider('gemini-antigravity', 'gemini-3.1-flash-lite');
        const serialized = JSON.stringify(snapshots);
        expect(serialized).not.toContain(credentialUuid);
        expect(snapshots[0].value.eligibleCredentialHashes).toEqual(expect.any(Array));
    });

    test('reuses a positive snapshot without rescanning credentials', async () => {
        const snapshots = new Map();
        const coordination = {
            getRuntimeSnapshot: jest.fn(async scope => snapshots.get(scope) || null),
            setRuntimeSnapshot: jest.fn(async (scope, value) => { snapshots.set(scope, value); return true; }),
            acquireRuntimeSnapshotLock: jest.fn(async () => 'worker-lock'),
            releaseRuntimeSnapshotLock: jest.fn(async () => true),
            deleteRuntimeSnapshot: jest.fn(async () => true),
            updateGeminiSchedulingGauge: jest.fn()
        };
        const manager = createManager([provider('credential-a')], coordination);
        await manager.selectProvider('gemini-antigravity', 'gemini-3.1-flash-lite');
        await manager.selectProvider('gemini-antigravity', 'gemini-3.1-flash-lite');
        const metrics = manager.getAntigravityAvailabilityMetrics();
        expect(metrics.cacheHits).toBeGreaterThan(0);
        expect(metrics.providersScanned).toBe(1);
    });

    test('keeps worker-local availability cache shorter than the shared snapshot TTL', async () => {
        const snapshots = new Map();
        const coordination = {
            getRuntimeSnapshot: jest.fn(async scope => snapshots.get(scope) || null),
            setRuntimeSnapshot: jest.fn(async (scope, value) => { snapshots.set(scope, value); return true; }),
            acquireRuntimeSnapshotLock: jest.fn(async () => 'worker-lock'),
            releaseRuntimeSnapshotLock: jest.fn(async () => true),
            updateGeminiSchedulingGauge: jest.fn()
        };
        const manager = createManager([provider('credential-a')], coordination);
        await manager.selectProvider('gemini-antigravity', 'gemini-3.1-flash-lite');
        const snapshot = [...manager._antigravityAvailabilityLocal.values()][0];

        expect(snapshot.localExpiresAt).toBeGreaterThan(snapshot.createdAt);
        expect(snapshot.localExpiresAt - snapshot.createdAt).toBeLessThanOrEqual(250);
        expect(snapshot.expiresAt - snapshot.createdAt).toBeGreaterThanOrEqual(1000);
    });

    test('deduplicates concurrent Antigravity snapshot refreshes', async () => {
        let lockCalls = 0;
        let snapshot = null;
        const coordination = {
            getRuntimeSnapshot: jest.fn(async () => snapshot),
            setRuntimeSnapshot: jest.fn(async (scope, value) => { snapshot = value; return true; }),
            acquireRuntimeSnapshotLock: jest.fn(async () => {
                lockCalls += 1;
                return lockCalls === 1 ? 'worker-lock' : null;
            }),
            releaseRuntimeSnapshotLock: jest.fn(async () => true),
            deleteRuntimeSnapshot: jest.fn(async () => true),
            updateGeminiSchedulingGauge: jest.fn()
        };
        const managerA = createManager([provider('credential-a')], coordination);
        const managerB = createManager([provider('credential-a')], coordination);
        const first = managerA.selectProvider('gemini-antigravity', 'gemini-3.1-flash-lite');
        const second = managerB.selectProvider('gemini-antigravity', 'gemini-3.1-flash-lite');
        await Promise.all([first, second]);
        expect(coordination.acquireRuntimeSnapshotLock).toHaveBeenCalledTimes(2);
        expect(coordination.setRuntimeSnapshot).toHaveBeenCalledTimes(1);
    });

    test('does not rescan credentials when another worker owns the refresh lock', async () => {
        const coordination = {
            getRuntimeSnapshot: jest.fn(async () => null),
            acquireRuntimeSnapshotLock: jest.fn(async () => null),
            releaseRuntimeSnapshotLock: jest.fn(async () => true)
        };
        const manager = createManager([provider('credential-a')], coordination);
        const refresh = jest.fn(async () => {
            throw new Error('unexpected duplicate scan');
        });

        const snapshot = await manager._getOrRefreshAntigravityAvailability('refresh-owned-elsewhere', refresh);

        expect(refresh).not.toHaveBeenCalled();
        expect(snapshot).toMatchObject({ refreshInProgress: true, exhausted: false });
    });

    test('fails fast without queueing when every Antigravity fallback model is unavailable', async () => {
        const recoveryTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        writeUsageCache([paidUsage('credential-a'), paidUsage('credential-b')]);
        const manager = createManager([
            provider('credential-a', {
                antigravityQuotaHealth: {
                    families: {},
                    models: {
                        'gemini-3.1-flash-lite': { isHealthy: false, scheduledRecoveryTime: recoveryTime, source: 'upstream_429' },
                        'gemini-3-flash': { isHealthy: false, scheduledRecoveryTime: recoveryTime, source: 'upstream_429' }
                    }
                }
            }),
            provider('credential-b', {
                antigravityQuotaHealth: {
                    families: {},
                    models: {
                        'gemini-3.1-flash-lite': { isHealthy: false, scheduledRecoveryTime: recoveryTime, source: 'upstream_429' },
                        'gemini-3-flash': { isHealthy: false, scheduledRecoveryTime: recoveryTime, source: 'upstream_429' }
                    }
                }
            })
        ], null, {
            antigravityElasticRouting: {
                enabled: true,
                fallbackModels: ['gemini-3-flash'],
                maxQueueWaitMs: 100
            }
        });
        const queueSpy = jest.spyOn(manager, '_acquireGeminiElasticQueueEntry');
        const acquireSpy = jest.spyOn(manager, 'acquireSlot');

        await expect(manager.acquireSlotWithFallback('gemini-antigravity', 'gemini-3.1-flash-lite')).rejects.toMatchObject({
            status: 429,
            code: 'ALL_MODELS_UNAVAILABLE'
        });
        expect(queueSpy).not.toHaveBeenCalled();
        expect(acquireSpy.mock.calls.filter(call => call[1] === 'gemini-3.1-flash-lite')).toHaveLength(1);
        expect(manager.getAntigravityAvailabilityMetrics().allModelsUnavailable).toBeGreaterThan(0);
    });

    test('falls back within Antigravity after a shared negative source snapshot', async () => {
        const recoveryTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const manager = createManager([
            provider('source-cooled', {
                supportedModels: ['gemini-3.1-flash-lite', 'gemini-3-flash'],
                antigravityQuotaHealth: {
                    families: {},
                    models: {
                        'gemini-3.1-flash-lite': { isHealthy: false, scheduledRecoveryTime: recoveryTime, source: 'upstream_429' }
                    }
                }
            }),
            provider('fallback-ready', {
                supportedModels: ['gemini-3-flash'],
                notSupportedModels: ['gemini-3.1-flash-lite']
            })
        ], null, {
            antigravityElasticRouting: {
                enabled: true,
                fallbackModels: ['gemini-3-flash'],
                maxQueueWaitMs: 100,
                preferOriginalWaitMs: 0
            }
        });

        const result = await manager.acquireSlotWithFallback('gemini-antigravity', 'gemini-3.1-flash-lite');

        expect(result).toMatchObject({
            actualProviderType: 'gemini-antigravity',
            actualModel: 'gemini-3-flash',
            isFallback: true,
            modelFallbackReason: 'SOURCE_MODEL_UNAVAILABLE',
            fallbackAttemptCount: 1
        });
        expect(manager.getAntigravityRoutingMetrics()).toMatchObject({
            sourceAttempts: 1,
            fallbackAttempts: 1,
            fallbackSuccesses: 1
        });
    });

    test('invalidates shared availability when a credential enters cooldown', async () => {
        let snapshot = null;
        const coordination = {
            getRuntimeSnapshot: jest.fn(async () => snapshot),
            setRuntimeSnapshot: jest.fn(async (scope, value) => { snapshot = value; return true; }),
            acquireRuntimeSnapshotLock: jest.fn(async () => 'worker-lock'),
            releaseRuntimeSnapshotLock: jest.fn(async () => true),
            deleteRuntimeSnapshot: jest.fn(async () => { snapshot = null; return true; }),
            setProviderModelCooldown: jest.fn(async () => true),
            updateGeminiSchedulingGauge: jest.fn(),
            recordGeminiSchedulingEvent: jest.fn()
        };
        const target = provider('credential-a');
        const manager = createManager([target], coordination);
        await manager.selectProvider('gemini-antigravity', 'gemini-3.1-flash-lite');
        expect(manager.getAntigravityAvailabilityMetrics().activeSnapshots).toBe(1);

        manager.markAntigravityModelQuotaUnhealthy(
            'gemini-antigravity',
            target,
            'gemini-3.1-flash-lite',
            'quota exhausted',
            new Date(Date.now() + 10_000)
        );

        expect(manager.getAntigravityAvailabilityMetrics().activeSnapshots).toBe(0);
        expect(manager.getAntigravityAvailabilityMetrics().invalidations).toBeGreaterThan(0);
    });

    test('releases the shared availability refresh lock when a refresh fails', async () => {
        const coordination = {
            getRuntimeSnapshot: jest.fn(async () => null),
            acquireRuntimeSnapshotLock: jest.fn(async () => 'worker-lock'),
            releaseRuntimeSnapshotLock: jest.fn(async () => true)
        };
        const manager = createManager([provider('credential-a')], coordination);

        await expect(manager._getOrRefreshAntigravityAvailability('scope-failing-refresh', async () => {
            throw new Error('refresh failed');
        })).rejects.toThrow('refresh failed');

        expect(coordination.releaseRuntimeSnapshotLock).toHaveBeenCalledWith('scope-failing-refresh', 'worker-lock');
    });
});
