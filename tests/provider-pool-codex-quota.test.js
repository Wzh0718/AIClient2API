import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { getCodexModelFallbackTarget, ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

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
                supportedModels: ['gpt-5.5', 'gpt-5.3-codex-spark'],
                codexGeneralMax5hPercent: 80,
                codexGeneralMaxWeeklyPercent: 90,
                codex53Max5hPercent: 80,
                codex53MaxWeeklyPercent: 90,
                ...overrides.over
            },
            {
                uuid: 'zzz-codex-ok',
                customName: 'OK',
                supportedModels: ['gpt-5.5', 'gpt-5.3-codex-spark'],
                codexGeneralMax5hPercent: 80,
                codexGeneralMaxWeeklyPercent: 90,
                codex53Max5hPercent: 80,
                codex53MaxWeeklyPercent: 90,
                ...overrides.ok
            }
        ]
    }, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json'
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
        expect(provider.codexQuotaHealth.codex53?.isHealthy).not.toBe(false);
    });

    test('keeps a general-limited Codex account eligible for Codex 5.3 requests when its 5.3 quota is healthy', async () => {
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
                        { id: 'primary_window', percent: 20, unit: 'percent' },
                        { id: 'secondary_window', percent: 70, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_primary_window', label: 'GPT-5.3-Codex-Spark (5h)', percent: 90, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_secondary_window', label: 'GPT-5.3-Codex-Spark (Weekly)', percent: 20, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager();

        const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.3-codex-spark');

        expect(selected.uuid).toBe('aaa-codex-over');
    });

    test('skips Codex accounts whose Codex 5.3 official quota exceeds the Codex 5.3 percent limit without blocking general requests', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Pro' },
                    items: [
                        { id: 'primary_window', percent: 20, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_primary_window', label: 'GPT-5.3-Codex-Spark (5h)', percent: 91, unit: 'percent' },
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
                        { id: 'primary_window', percent: 85, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_primary_window', label: 'GPT-5.3-Codex-Spark (5h)', percent: 40, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_secondary_window', label: 'GPT-5.3-Codex-Spark (Weekly)', percent: 20, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager();

        const sparkSelected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.3-codex-spark');
        const generalSelected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5');

        expect(sparkSelected.uuid).toBe('zzz-codex-ok');
        expect(generalSelected.uuid).toBe('aaa-codex-over');
        const provider = manager.providerStatus['openai-codex-oauth'][0].config;
        expect(provider.isHealthy).toBe(true);
        expect(provider.codexQuotaHealth.codex53.isHealthy).toBe(false);
        expect(provider.codexQuotaHealth.general?.isHealthy).not.toBe(false);
    });

    test('falls back Codex 5.3 Spark requests to GPT-5.4 Mini when every 5.3 quota bucket is exhausted', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Pro' },
                    items: [
                        { id: 'primary_window', percent: 20, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_primary_window', label: 'GPT-5.3-Codex-Spark (5h)', percent: 91, unit: 'percent' },
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
                        { id: 'primary_window', percent: 20, unit: 'percent' },
                        { id: 'secondary_window', percent: 20, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_primary_window', label: 'GPT-5.3-Codex-Spark (5h)', percent: 93, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_secondary_window', label: 'GPT-5.3-Codex-Spark (Weekly)', percent: 30, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager({
            over: { supportedModels: ['gpt-5.4-mini', 'gpt-5.3-codex-spark'] },
            ok: { supportedModels: ['gpt-5.4-mini', 'gpt-5.3-codex-spark'] }
        });

        const selected = await manager.selectProviderWithFallback('openai-codex-oauth', 'gpt-5.3-codex-spark');

        expect(selected).toMatchObject({
            actualProviderType: 'openai-codex-oauth',
            isFallback: true,
            actualModel: 'gpt-5.4-mini'
        });
        expect(['aaa-codex-over', 'zzz-codex-ok']).toContain(selected.config.uuid);
    });

    test('uses 100 percent as the default Codex 5.3 bucket limit when no override is configured', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Pro' },
                    items: [
                        { id: 'primary_window', percent: 0, unit: 'percent' },
                        { id: 'secondary_window', percent: 0, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_primary_window', label: 'GPT-5.3-Codex-Spark (5h)', percent: 0, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_secondary_window', label: 'GPT-5.3-Codex-Spark (Weekly)', percent: 100, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'zzz-codex-ok',
                success: true,
                usage: {
                    summary: { plan: 'Plus' },
                    items: [
                        { id: 'primary_window', percent: 0, unit: 'percent' },
                        { id: 'secondary_window', percent: 0, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_primary_window', label: 'GPT-5.3-Codex-Spark (5h)', percent: 0, unit: 'percent' },
                        { id: 'additional_gpt_5_3_codex_spark_secondary_window', label: 'GPT-5.3-Codex-Spark (Weekly)', percent: 100, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createQuotaPoolManager({
            over: {
                supportedModels: ['gpt-5.4-mini', 'gpt-5.3-codex-spark'],
                codex53Max5hPercent: undefined,
                codex53MaxWeeklyPercent: undefined
            },
            ok: {
                supportedModels: ['gpt-5.4-mini', 'gpt-5.3-codex-spark'],
                codex53Max5hPercent: undefined,
                codex53MaxWeeklyPercent: undefined
            }
        });

        const selected = await manager.selectProviderWithFallback('openai-codex-oauth', 'gpt-5.3-codex-spark');

        expect(selected).toMatchObject({
            actualProviderType: 'openai-codex-oauth',
            isFallback: true,
            actualModel: 'gpt-5.4-mini'
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

    test('falls back to GPT-5.4 Mini when Codex 5.3 Spark has no selectable provider', async () => {
        writeCodexUsageCache([
            { uuid: 'aaa-codex-over', success: true, usage: { summary: { plan: 'Pro' }, items: [] } },
            { uuid: 'zzz-codex-ok', success: true, usage: { summary: { plan: 'Plus' }, items: [] } }
        ]);
        const manager = createQuotaPoolManager({
            over: {
                supportedModels: ['gpt-5.4-mini'],
                notSupportedModels: ['gpt-5.3-codex-spark']
            },
            ok: {
                supportedModels: ['gpt-5.4-mini'],
                notSupportedModels: ['gpt-5.3-codex-spark']
            }
        });

        const selected = await manager.selectProviderWithFallback('openai-codex-oauth', 'gpt-5.3-codex-spark');

        expect(selected).toMatchObject({
            actualProviderType: 'openai-codex-oauth',
            isFallback: true,
            actualModel: 'gpt-5.4-mini'
        });
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

    test('applies a Spark weekly-only primary window to the Spark weekly threshold', async () => {
        writeCodexUsageCache([
            {
                uuid: 'aaa-codex-over',
                success: true,
                usage: {
                    summary: { plan: 'Pro' },
                    items: [
                        {
                            id: 'primary_window',
                            windowKind: 'weekly',
                            durationSeconds: 604800,
                            percent: 10,
                            unit: 'percent'
                        },
                        {
                            id: 'additional_gpt_5_3_codex_spark_primary_window',
                            label: 'GPT-5.3-Codex-Spark (Weekly)',
                            scope: 'model',
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
        const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.3-codex-spark');

        expect(selected.uuid).toBe('aaa-codex-over');
    });
});
