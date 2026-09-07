import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { getCodexModelFallbackTarget, getCodexTokenQuotaStatus, ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['openai-codex-oauth']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

let consoleSpies = [];
let managers = [];
const usageCachePath = path.join(process.cwd(), 'configs', 'usage-cache.json');
let originalUsageCacheExisted = false;
let originalUsageCacheContent = null;

function writeCodexUsageCache(instances, timestamp = new Date().toISOString()) {
    fs.mkdirSync(path.dirname(usageCachePath), { recursive: true });
    fs.writeFileSync(usageCachePath, JSON.stringify({
        timestamp,
        providers: {
            'openai-codex-oauth': {
                providerType: 'openai-codex-oauth',
                instances
            }
        }
    }, null, 2), 'utf8');
}

function createQuotaPoolManager(overrides = {}) {
    const manager = new ProviderPoolManager({
        'openai-codex-oauth': [
            {
                uuid: 'aaa-codex-over',
                customName: 'Over',
                supportedModels: ['gpt-5.5', 'gpt-5.6-luna'],
                codexGeneralMax5hPercent: 80,
                codexGeneralMaxWeeklyPercent: 90,
                ...overrides.over
            },
            {
                uuid: 'zzz-codex-ok',
                customName: 'OK',
                supportedModels: ['gpt-5.5', 'gpt-5.6-luna'],
                codexGeneralMax5hPercent: 80,
                codexGeneralMaxWeeklyPercent: 90,
                ...overrides.ok
            }
        ]
    }, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json',
            CODEX_POOL_SNAPSHOT_TTL_MS: 30_000
        }
    });
    managers.push(manager);
    return manager;
}

beforeEach(() => {
    originalUsageCacheExisted = fs.existsSync(usageCachePath);
    originalUsageCacheContent = originalUsageCacheExisted ? fs.readFileSync(usageCachePath, 'utf8') : null;
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    for (const manager of managers) {
        if (manager.saveTimer) {
            clearTimeout(manager.saveTimer);
        }
    }
    managers = [];
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
    if (originalUsageCacheExisted) {
        fs.mkdirSync(path.dirname(usageCachePath), { recursive: true });
        fs.writeFileSync(usageCachePath, originalUsageCacheContent, 'utf8');
    } else if (fs.existsSync(usageCachePath)) {
        fs.rmSync(usageCachePath, { force: true });
    }
    originalUsageCacheExisted = false;
    originalUsageCacheContent = null;
});

describe('provider pool Codex token quota', () => {
    test('honors an explicit unavailable-model fallback map without a built-in 5.4 default', () => {
        expect(getCodexModelFallbackTarget('gpt-5.4-mini')).toBeNull();
        expect(getCodexModelFallbackTarget('gpt-5.4-mini', {
            CODEX_UNAVAILABLE_MODEL_FALLBACKS: {
                'gpt-5.4-mini': 'gpt-5.6-luna'
            }
        })).toBe('gpt-5.6-luna');
    });
    test('reuses a quota filter snapshot for repeated selection state', () => {
        const usageTimestamp = new Date().toISOString();
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 15, unit: 'percent' },
                        { id: 'secondary_window', percent: 25, unit: 'percent' }
                    ]
                }
            }
        ], usageTimestamp);

        const manager = createQuotaPoolManager();
        const providers = manager.providerStatus['openai-codex-oauth'];

        const first = manager._filterCodexProvidersByTokenQuota('openai-codex-oauth', providers, 'gpt-5.5');
        const firstScanned = manager._codexQuotaFilterMetrics.providersScanned;
        const second = manager._filterCodexProvidersByTokenQuota('openai-codex-oauth', providers, 'gpt-5.5');

        expect(second.map(provider => provider.uuid)).toEqual(first.map(provider => provider.uuid));
        expect(manager._codexQuotaFilterMetrics.cacheHits).toBe(1);
        expect(manager._codexQuotaFilterMetrics.providersScanned).toBe(firstScanned);
        expect(manager.getCodexQuotaFilterMetrics()).toMatchObject({
            codexQuotaFilterCalls: 2,
            codexQuotaFilterCacheHits: 1,
            codexQuotaFilterCacheMisses: 1,
            codexQuotaProvidersScanned: 2
        });
    });

    test('recomputes a quota filter snapshot after provider state changes', () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 15, unit: 'percent' },
                        { id: 'secondary_window', percent: 25, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager();
        const providers = manager.providerStatus['openai-codex-oauth'];
        manager._filterCodexProvidersByTokenQuota('openai-codex-oauth', providers, 'gpt-5.5');
        const firstMisses = manager._codexQuotaFilterMetrics.cacheMisses;
        providers[0].config.codexRateLimitCooldown = {
            general: {
                isCoolingDown: true,
                scheduledRecoveryTime: '2099-01-01T00:00:00.000Z'
            }
        };

        const allowed = manager._filterCodexProvidersByTokenQuota('openai-codex-oauth', providers, 'gpt-5.5');

        expect(allowed.map(provider => provider.uuid)).toEqual(['zzz-codex-ok']);
        expect(manager._codexQuotaFilterMetrics.cacheMisses).toBe(firstMisses + 1);
    });

    test('uses the longer unavailable TTL when usage windows are missing', () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: { summary: { plan: 'Plus' }, items: [] }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: { summary: { plan: 'Plus' }, items: [] }
            }
        ]);

        const manager = createQuotaPoolManager();
        const providers = manager.providerStatus['openai-codex-oauth'];
        manager._filterCodexProvidersByTokenQuota('openai-codex-oauth', providers, 'gpt-5.5');
        const snapshot = [...manager._codexQuotaFilterSnapshots.values()][0];

        expect(snapshot.unavailableCount).toBe(2);
        expect(snapshot.expiresAt - snapshot.computedAt).toBe(60_000);
    });

    test('hydrates a regular quota snapshot from shared runtime coordination', async () => {
        const usageTimestamp = new Date().toISOString();
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 15, unit: 'percent' },
                        { id: 'secondary_window', percent: 25, unit: 'percent' }
                    ]
                }
            }
        ], usageTimestamp);

        const manager = createQuotaPoolManager();
        const providers = manager.providerStatus['openai-codex-oauth'];
        const bucket = 'general';
        const snapshot = {
            providerConfigRevision: manager.providerConfigRevision,
            stateFingerprint: manager._getCodexPoolStateFingerprint(providers, bucket),
            allowedProviderUuids: ['aaa-codex-over', 'zzz-codex-ok'],
            filterReasons: {},
            unavailableCount: 0,
            exhausted: false,
            ttlMs: 30_000,
            usageCacheVersion: usageTimestamp
        };

        manager._applySharedCodexPoolSnapshot('openai-codex-oauth', bucket, providers, snapshot);
        const allowed = manager._filterCodexProvidersByTokenQuota('openai-codex-oauth', providers, 'gpt-5.5');

        expect(allowed.map(provider => provider.uuid)).toEqual(['aaa-codex-over', 'zzz-codex-ok']);
        expect(manager._codexQuotaFilterMetrics.crossWorkerReuse).toBe(1);
    });

    test('skips Redis snapshot fetch when the local Codex pool snapshot is still fresh', async () => {
        const usageTimestamp = new Date().toISOString();
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 15, unit: 'percent' },
                        { id: 'secondary_window', percent: 25, unit: 'percent' }
                    ]
                }
            }
        ], usageTimestamp);

        const manager = createQuotaPoolManager();
        const providers = manager.providerStatus['openai-codex-oauth'];
        const snapshot = {
            providerConfigRevision: manager.providerConfigRevision,
            stateFingerprint: manager._getCodexPoolStateFingerprint(providers, 'general'),
            allowedProviderUuids: ['aaa-codex-over', 'zzz-codex-ok'],
            filterReasons: {},
            unavailableCount: 0,
            exhausted: false,
            ttlMs: 30_000,
            usageCacheVersion: usageTimestamp
        };
        manager._applySharedCodexPoolSnapshot('openai-codex-oauth', 'general', providers, snapshot);
        const coordination = {
            getRuntimeSnapshot: jest.fn(async () => snapshot),
            acquireRuntimeSnapshotLock: jest.fn(async () => null),
            acquire: jest.fn(async candidates => ({
                leaseId: 'lease-1',
                providerType: candidates[0].providerType,
                uuid: candidates[0].uuid
            })),
            release: jest.fn(async () => true)
        };
        manager.coordination = coordination;

        const selected = await manager.acquireSlot('openai-codex-oauth', 'gpt-5.5');
        expect(selected?.uuid).toBeTruthy();
        expect(coordination.getRuntimeSnapshot).not.toHaveBeenCalled();
        expect(coordination.acquireRuntimeSnapshotLock).not.toHaveBeenCalled();
    });

    test('fresh usage cache recovery re-enables a provider stuck in a future quota cooldown', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 15, unit: 'percent' },
                        { id: 'secondary_window', percent: 25, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager({
            over: {
                codexQuotaHealth: {
                    general: {
                        isHealthy: false,
                        scheduledRecoveryTime: '2099-01-01T00:00:00.000Z'
                    }
                }
            }
        });

        const allowed = manager._filterCodexProvidersByTokenQuota(
            'openai-codex-oauth',
            manager.providerStatus['openai-codex-oauth'],
            'gpt-5.5'
        );

        expect(allowed.map(provider => provider.uuid)).toContain('aaa-codex-over');
        expect(manager.providerStatus['openai-codex-oauth'][0].config.codexQuotaHealth.general).toMatchObject({
            isHealthy: true,
            scheduledRecoveryTime: null
        });
    });

    test('fresh usage cache recovery preserves an independent upstream rate-limit cooldown', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 15, unit: 'percent' },
                        { id: 'secondary_window', percent: 25, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager({
            over: {
                codexQuotaHealth: {
                    general: {
                        isHealthy: false,
                        scheduledRecoveryTime: '2099-01-01T00:00:00.000Z'
                    }
                },
                codexRateLimitCooldown: {
                    general: {
                        isCoolingDown: true,
                        scheduledRecoveryTime: '2099-01-01T00:00:00.000Z',
                        source: 'upstream_429'
                    }
                }
            }
        });

        const allowed = manager._filterCodexProvidersByTokenQuota(
            'openai-codex-oauth',
            manager.providerStatus['openai-codex-oauth'],
            'gpt-5.5'
        );

        expect(allowed.map(provider => provider.uuid)).not.toContain('aaa-codex-over');
        expect(manager.providerStatus['openai-codex-oauth'][0].config.codexQuotaHealth.general).toMatchObject({
            isHealthy: true,
            scheduledRecoveryTime: null
        });
        expect(manager.providerStatus['openai-codex-oauth'][0].config.codexRateLimitCooldown.general).toMatchObject({
            isCoolingDown: true,
            source: 'upstream_429'
        });
    });

    test.each(['gpt-5.3', 'gpt-5.3-fast', 'gpt-5.4', 'gpt-5.4-fast', 'gpt-5.4-mini-fast'])(
        'does not apply an ordinary unavailable-model fallback to %s',
        (model) => {
            expect(getCodexModelFallbackTarget(model)).toBeNull();
        }
    );

    test('only selects Codex providers with Pro or Plus plan from usage cache', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'FREE' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 10, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    summary: { plan: 'ChatGPT Plus' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 10, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager();

        const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5');

        expect(selected.uuid).toBe('zzz-codex-ok');
    });

    test('does not select Codex providers without a trusted Pro or Plus usage plan', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'FREE' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 10, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager({ ok: { uuid: 'zzz-codex-unknown' } });

        await expect(manager.selectProvider('openai-codex-oauth', 'gpt-5.5'))
            .rejects.toMatchObject({ status: 429 });
    });

    test('allows Codex Pro plan accounts', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Pro' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 10, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager({ ok: { isDisabled: true } });

        const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5');

        expect(selected.uuid).toBe('aaa-codex-over');
    });

    test('uses the last known Codex plan when fresh usage cache temporarily lacks plan fields', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 10, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 10, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager({
            over: { lastKnownCodexPlan: 'pro' },
            ok: { isDisabled: true }
        });

        const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5');

        expect(selected.uuid).toBe('aaa-codex-over');
    });

    test('reports filter reasons when every Codex provider is filtered before routing', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 10, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 10, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager();

        await expect(manager.selectProvider('openai-codex-oauth', 'gpt-5.5'))
            .rejects.toMatchObject({
                status: 429,
                message: expect.stringContaining('plan_unknown=2'),
                filterReasons: expect.objectContaining({ plan_unknown: 2 })
            });
    });

    test('skips Codex accounts whose general official 5h quota exceeds the general percent limit without marking provider globally unhealthy', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Pro' },
                    items: [
                        { id: 'primary_window', percent: 81, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_primary_window', label: 'GPT-5.3-Codex-Spark (5h)', percent: 40, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_secondary_window', label: 'GPT-5.3-Codex-Spark (Weekly)', percent: 30, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 40, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager();

        const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5');

        expect(selected.uuid).toBe('zzz-codex-ok');
        const provider = manager.providerStatus['openai-codex-oauth'][0].config;
        expect(provider.isHealthy).toBe(true);
        expect(provider.scheduledRecoveryTime).toBeUndefined();
        expect(provider.codexQuotaHealth.general.isHealthy).toBe(false);
    });

    test('does not treat a Pro weekly-only general quota as unavailable 5h usage', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: {
                        plan: 'Pro',
                        quotaApplicability: {
                            general: {
                                short: { status: 'not_applicable' },
                                weekly: { status: 'healthy' }
                            }
                        }
                    },
                    items: [
                        { id: 'primary_window', scope: 'general', windowKind: 'weekly', percent: 40, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    summary: { plan: 'Pro', quotaApplicability: { general: { short: { status: 'not_applicable' } } } },
                    items: [
                        { id: 'primary_window', scope: 'general', windowKind: 'weekly', percent: 20, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager();
        const providers = manager.providerStatus['openai-codex-oauth'];
        const allowed = manager._filterCodexProvidersByTokenQuota('openai-codex-oauth', providers, 'gpt-5.5');

        expect(allowed.map(provider => provider.uuid)).toEqual(['aaa-codex-over', 'zzz-codex-ok']);
        const snapshot = [...manager._codexQuotaFilterSnapshots.values()][0];
        expect(snapshot.filterReasons).not.toHaveProperty('general_quota_unavailable');
    });

    test('does not warn for a Pro general 5h window that is explicitly not applicable', () => {
        const status = getCodexTokenQuotaStatus('openai-codex-oauth', {
            config: {
                uuid: 'pro-weekly-only',
                codexGeneralMax5hPercent: 80,
                codexGeneralMaxWeeklyPercent: 90
            }
        }, {
            providers: {
                'openai-codex-oauth': {
                    instances: [{
                        uuid: 'pro-weekly-only',
                        success: true,
                        usage: {
                            summary: {
                                plan: 'Pro',
                                quotaApplicability: {
                                    general: {
                                        short: { status: 'not_applicable' },
                                        weekly: { status: 'healthy' }
                                    }
                                }
                            },
                            items: [{ id: 'primary_window', scope: 'general', windowKind: 'weekly', percent: 40 }]
                        }
                    }]
                }
            }
        }, 'general');

        expect(status).toMatchObject({ limited: true, exceeded: false, reason: null });
    });

    test('does not mark the Codex provider unhealthy when a health check reports quota exhaustion', () => {
        const manager = createQuotaPoolManager();
        const provider = manager.providerStatus['openai-codex-oauth'][0].config;

        manager.markProviderHealthCheckFailed(
            'openai-codex-oauth',
            provider,
            '429 Too Many Requests: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}'
        );

        expect(provider.isHealthy).toBe(true);
        expect(provider.errorCount).toBe(0);
        expect(provider.lastErrorMessage).toBeNull();
    });

    test('does not let direct Codex quota error marking mutate base health state', () => {
        const manager = createQuotaPoolManager();
        const provider = manager.providerStatus['openai-codex-oauth'][0].config;
        const errorMessage = '429 Too Many Requests: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}';

        manager.markProviderUnhealthy('openai-codex-oauth', provider, errorMessage);
        manager.markProviderUnhealthyWithRecoveryTime(
            'openai-codex-oauth',
            provider,
            errorMessage,
            '2099-01-08T00:00:00.000Z'
        );

        expect(provider.isHealthy).toBe(true);
        expect(provider.errorCount).toBe(0);
        expect(provider.lastErrorMessage).toBeNull();
        expect(provider.scheduledRecoveryTime).toBeUndefined();
    });

    test('records a machine-readable reason on Codex quota bucket exhaustion', () => {
        const manager = createQuotaPoolManager();
        const provider = manager.providerStatus['openai-codex-oauth'][0].config;

        manager.markCodexQuotaBucketUnhealthy(
            'openai-codex-oauth',
            provider,
            'general',
            '通用额度已用 100.0%',
            '2099-01-08T00:00:00.000Z'
        );

        expect(provider.codexQuotaHealth.general).toMatchObject({
            isHealthy: false,
            reasonCode: 'CODEX_QUOTA_EXHAUSTED'
        });
    });

    test('repairs persisted Codex quota-only unhealthy state during initialization', () => {
        const manager = createQuotaPoolManager({
            over: {
                isHealthy: false,
                errorCount: 10,
                lastErrorTime: '2026-09-03T09:00:00.000Z',
                lastErrorMessage: '429 Too Many Requests: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}',
                scheduledRecoveryTime: '2099-01-08T00:00:00.000Z',
                codexQuotaHealth: {
                    general: {
                        isHealthy: false,
                        scheduledRecoveryTime: '2099-01-08T00:00:00.000Z'
                    }
                }
            }
        });

        const provider = manager.providerStatus['openai-codex-oauth'][0].config;
        expect(provider).toMatchObject({
            isHealthy: true,
            errorCount: 0,
            lastErrorTime: null,
            lastErrorMessage: null,
            scheduledRecoveryTime: null
        });
        expect(provider.codexQuotaHealth.general).toMatchObject({
            isHealthy: false,
            scheduledRecoveryTime: '2099-01-08T00:00:00.000Z'
        });
    });

    test('does not use a compromise model when 5.4 mini is unavailable', async () => {
        writeCodexUsageCache([
            { uuid: 'aaa-codex-over', success: true, usage: { summary: { plan: 'Pro' }, items: [] } },
            { uuid: 'zzz-codex-ok', success: true, usage: { summary: { plan: 'Plus' }, items: [] } }
        ]);
        const manager = createQuotaPoolManager({
            over: { notSupportedModels: ['gpt-5.4-mini'] },
            ok: { notSupportedModels: ['gpt-5.4-mini'] }
        });

        const selected = await manager.selectProviderWithFallback('openai-codex-oauth', 'gpt-5.4-mini');

        expect(selected).toBeNull();
    });

    test('does not persist unchanged quota or cooldown state repeatedly', () => {
        const manager = createQuotaPoolManager();
        const provider = manager.providerStatus['openai-codex-oauth'][0].config;
        jest.spyOn(manager, '_debouncedSave').mockImplementation(() => {});

        manager.markCodexQuotaBucketUnhealthy('openai-codex-oauth', provider, 'general', 'exhausted', '2026-09-01T00:00:00.000Z');
        manager.markCodexQuotaBucketUnhealthy('openai-codex-oauth', provider, 'general', 'exhausted', '2026-09-01T00:00:00.000Z');
        manager.markCodexRateLimitCooldown('openai-codex-oauth', provider, 'general', '429', '2026-09-01T00:00:00.000Z');
        manager.markCodexRateLimitCooldown('openai-codex-oauth', provider, 'general', '429', '2026-09-01T00:00:00.000Z');

        expect(manager._debouncedSave).toHaveBeenCalledTimes(2);
    });

    test('does not apply the Luna mapping to unrelated models', async () => {
        writeCodexUsageCache([
            { uuid: 'aaa-codex-over', success: true, usage: { summary: { plan: 'Pro' }, items: [] } },
            { uuid: 'zzz-codex-ok', success: true, usage: { summary: { plan: 'Plus' }, items: [] } }
        ]);
        const manager = createQuotaPoolManager({
            over: { notSupportedModels: ['gpt-5.5'] },
            ok: { notSupportedModels: ['gpt-5.5'] }
        });

        await expect(manager.selectProviderWithFallback('openai-codex-oauth', 'gpt-5.5')).resolves.toBeNull();
    });

    test('uses 100 percent as the default Codex general bucket limit when no override is configured', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Pro' },
                    items: [
                        { id: 'primary_window', percent: 100, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_primary_window', label: 'GPT-5.3-Codex-Spark (5h)', percent: 0, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_secondary_window', label: 'GPT-5.3-Codex-Spark (Weekly)', percent: 0, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 100, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_primary_window', label: 'GPT-5.3-Codex-Spark (5h)', percent: 0, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_secondary_window', label: 'GPT-5.3-Codex-Spark (Weekly)', percent: 0, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager({
            over: {
                codexGeneralMax5hPercent: undefined,
                codexGeneralMaxWeeklyPercent: undefined
            },
            ok: {
                codexGeneralMax5hPercent: undefined,
                codexGeneralMaxWeeklyPercent: undefined
            }
        });

        await expect(manager.selectProvider('openai-codex-oauth', 'gpt-5.5')).rejects.toMatchObject({
            status: 429,
            filterReasons: {
                general_quota_exceeded: 2
            }
        });
    });

    test('applies a weekly-only primary window to the weekly threshold instead of the 5h threshold', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Pro' },
                    items: [
                        {
                            id: 'primary_window',
                            sourceWindow: 'primary_window',
                            windowKind: 'weekly',
                            durationSeconds: 604800,
                            percent: 85,
                            unit: 'percent'
                        }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager({ ok: { isDisabled: true } });
        const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5');

        expect(selected.uuid).toBe('aaa-codex-over');
    });

    test('does not reuse a subset exhausted snapshot for a different candidate set', () => {
        const usageTimestamp = new Date().toISOString();
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 100, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' }
                    ]
                }
            }
        ], usageTimestamp);

        const manager = createQuotaPoolManager();
        const providers = manager.providerStatus['openai-codex-oauth'];
        const over = providers.find(provider => provider.uuid === 'aaa-codex-over');
        const ok = providers.find(provider => provider.uuid === 'zzz-codex-ok');

        expect(() => manager._filterCodexProvidersByTokenQuota(
            'openai-codex-oauth',
            [over],
            'gpt-5.5',
            { candidateGroupId: 'group-a' }
        )).toThrow(/group-a exceeded configured usage quotas \(general_quota_exceeded=1\)/);

        const allowed = manager._filterCodexProvidersByTokenQuota(
            'openai-codex-oauth',
            [ok],
            'gpt-5.5',
            { candidateGroupId: 'group-b' }
        );
        expect(allowed.map(provider => provider.uuid)).toEqual(['zzz-codex-ok']);
    });

    test('still returns 429 when every candidate in the filtered set is exhausted', () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 100, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 100, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager();
        const providers = manager.providerStatus['openai-codex-oauth'];

        expect(() => manager._filterCodexProvidersByTokenQuota('openai-codex-oauth', providers, 'gpt-5.5'))
            .toThrow(/general_quota_exceeded=2/);
    });

    test('does not apply a shared exhausted snapshot to a different candidate set', () => {
        const usageTimestamp = new Date().toISOString();
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 100, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 10, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' }
                    ]
                }
            }
        ], usageTimestamp);

        const manager = createQuotaPoolManager();
        const providers = manager.providerStatus['openai-codex-oauth'];
        const over = providers.find(provider => provider.uuid === 'aaa-codex-over');
        const ok = providers.find(provider => provider.uuid === 'zzz-codex-ok');
        const bucket = 'general';

        manager._applySharedCodexPoolSnapshot('openai-codex-oauth', bucket, [over], {
            providerConfigRevision: manager.providerConfigRevision,
            stateFingerprint: manager._getCodexPoolStateFingerprint([over], bucket),
            exhausted: true,
            message: 'All Codex providers in credential group group-a exceeded configured usage quotas (general_quota_exceeded=1)',
            filterReasons: { general_quota_exceeded: 1 },
            ttlMs: 30_000,
            usageCacheVersion: usageTimestamp
        });

        const allowed = manager._filterCodexProvidersByTokenQuota('openai-codex-oauth', [ok], 'gpt-5.5');
        expect(allowed.map(provider => provider.uuid)).toEqual(['zzz-codex-ok']);
        expect(() => manager._filterCodexProvidersByTokenQuota(
            'openai-codex-oauth',
            [over],
            'gpt-5.5',
            { candidateGroupId: 'group-a' }
        )).toThrow(/group-a exceeded configured usage quotas/);
    });

});
