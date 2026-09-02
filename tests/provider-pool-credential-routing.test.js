import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => [
        'openai-codex-oauth',
        'openaiResponses-custom',
        'openai-custom',
        'atlascloud'
    ]),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

const usageCachePath = path.join(process.cwd(), 'configs', 'usage-cache.json');
let originalUsageCacheExisted = false;
let originalUsageCacheContent = null;
let managers = [];
let consoleSpies = [];

function codexProvider(uuid, overrides = {}) {
    return {
        uuid,
        customName: uuid,
        lastKnownCodexPlan: 'pro',
        supportedModels: ['gpt-5.3-codex-spark', 'gpt-5.4-mini', 'gpt-5.5'],
        ...overrides
    };
}

function createManager({
    codex = [codexProvider('codex-a'), codexProvider('codex-b')],
    responses = [],
    openai = [],
    atlas = [],
    globalConfig = {}
} = {}) {
    const manager = new ProviderPoolManager({
        'openai-codex-oauth': codex,
        'openaiResponses-custom': responses,
        'openai-custom': openai,
        atlascloud: atlas
    }, {
        logLevel: 'error',
        persistenceEnabled: false,
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json',
            ...globalConfig
        }
    });
    managers.push(manager);
    return manager;
}

function writeCodexUsageCache(instances) {
    fs.mkdirSync(path.dirname(usageCachePath), { recursive: true });
    fs.writeFileSync(usageCachePath, JSON.stringify({
        timestamp: new Date().toISOString(),
        providers: {
            'openai-codex-oauth': {
                providerType: 'openai-codex-oauth',
                instances
            }
        }
    }), 'utf8');
}

beforeEach(() => {
    originalUsageCacheExisted = fs.existsSync(usageCachePath);
    originalUsageCacheContent = originalUsageCacheExisted
        ? fs.readFileSync(usageCachePath, 'utf8')
        : null;
    consoleSpies = ['log', 'warn', 'error'].map(method =>
        jest.spyOn(console, method).mockImplementation(() => {})
    );
});

afterEach(() => {
    for (const manager of managers) {
        if (manager.saveTimer) clearTimeout(manager.saveTimer);
    }
    managers = [];
    consoleSpies.forEach(spy => spy.mockRestore());
    consoleSpies = [];

    if (originalUsageCacheExisted) {
        fs.writeFileSync(usageCachePath, originalUsageCacheContent, 'utf8');
    } else if (fs.existsSync(usageCachePath)) {
        fs.rmSync(usageCachePath, { force: true });
    }
    originalUsageCacheExisted = false;
    originalUsageCacheContent = null;
});

describe('provider pool credential routing constraints', () => {
    test('selectProvider only considers allowed credential UUIDs', async () => {
        const manager = createManager({
            codex: [
                codexProvider('codex-a'),
                codexProvider('codex-b'),
                codexProvider('codex-c')
            ]
        });

        const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
            allowedProviderUuids: ['codex-b'],
            skipUsageCount: true
        });

        expect(selected?.uuid).toBe('codex-b');
    });

    test('a healthier or less loaded provider outside the whitelist cannot be selected', async () => {
        const manager = createManager({
            codex: [
                codexProvider('codex-outside'),
                codexProvider('codex-inside')
            ]
        });
        manager.providerStatus['openai-codex-oauth'][0].state.activeCount = 0;
        manager.providerStatus['openai-codex-oauth'][1].state.activeCount = 10;

        const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
            allowedProviderUuids: ['codex-inside'],
            skipUsageCount: true
        });

        expect(selected?.uuid).toBe('codex-inside');
    });

    test('an unhealthy whitelisted credential does not bypass health filtering', async () => {
        const manager = createManager({
            codex: [
                codexProvider('codex-outside'),
                codexProvider('codex-inside', { isHealthy: false })
            ]
        });

        await expect(manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
            allowedProviderUuids: ['codex-inside'],
            skipUsageCount: true
        })).resolves.toBeNull();
    });

    test('a quota-exhausted whitelisted credential remains subject to Codex quota filtering', async () => {
        writeCodexUsageCache([
            {
                uuid: 'codex-outside',
                success: true,
                usage: {
                    summary: { plan: 'Pro' },
                    items: [
                        { id: 'primary_window', percent: 0, unit: 'percent' },
                        { id: 'secondary_window', percent: 0, unit: 'percent' }
                    ]
                }
            },
            {
                uuid: 'codex-inside',
                success: true,
                usage: {
                    summary: { plan: 'Pro' },
                    items: [
                        { id: 'primary_window', percent: 100, unit: 'percent' },
                        { id: 'secondary_window', percent: 0, unit: 'percent' }
                    ]
                }
            }
        ]);

        const manager = createManager({
            codex: [
                codexProvider('codex-outside'),
                codexProvider('codex-inside', { codexGeneralMax5hPercent: 50 })
            ]
        });

        await expect(manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
            allowedProviderUuids: ['codex-inside'],
            skipUsageCount: true
        })).rejects.toMatchObject({
            status: 429,
            filterReasons: { general_quota_exceeded: 1 }
        });
    });

    test('acquireSlot obeys the credential whitelist and concurrency limits', async () => {
        const manager = createManager({
            codex: [
                codexProvider('codex-outside'),
                codexProvider('codex-inside', { concurrencyLimit: 1, queueLimit: 0 })
            ]
        });
        const inside = manager.providerStatus['openai-codex-oauth'].find(p => p.uuid === 'codex-inside');
        inside.state.activeCount = 1;

        await expect(manager.acquireSlot('openai-codex-oauth', 'gpt-5.5', {
            allowedProviderUuids: ['codex-inside']
        })).rejects.toMatchObject({ status: 429 });
    });
});

describe('provider pool fallback disabling', () => {
    test('disableProviderFallback prevents mixed-pool selection', async () => {
        const manager = createManager({
            codex: [codexProvider('codex-primary', { isHealthy: false })],
            responses: [{ uuid: 'responses-mixed', customName: 'mixed', supportedModels: ['gpt-5.5'], providerWeight: 10 }],
            globalConfig: {
                mixedProviderPools: {
                    gpt: {
                        enabled: true,
                        matchModels: ['gpt-*'],
                        entryProviders: ['openai-codex-oauth'],
                        candidateProviders: ['openai-codex-oauth', 'openaiResponses-custom']
                    }
                }
            }
        });

        const selected = await manager.selectProviderWithFallback('openai-codex-oauth', 'gpt-5.5', {
            disableProviderFallback: true,
            skipUsageCount: true
        });

        expect(selected).toBeNull();
    });

    test('disableProviderFallback prevents provider fallback chains', async () => {
        const manager = createManager({
            codex: [],
            openai: [{ uuid: 'openai-primary', isHealthy: false, supportedModels: ['gpt-5.5'] }],
            atlas: [{ uuid: 'atlas-fallback', supportedModels: ['gpt-5.5'] }],
            globalConfig: {
                providerFallbackChain: {
                    'openai-custom': ['atlascloud']
                }
            }
        });

        await expect(manager.selectProviderWithFallback('openai-custom', 'gpt-5.5', {
            disableProviderFallback: true,
            skipUsageCount: true
        })).resolves.toBeNull();

        await expect(manager.selectProviderWithFallback('openai-custom', 'gpt-5.5', {
            skipUsageCount: true
        })).resolves.toMatchObject({
            actualProviderType: 'atlascloud',
            isFallback: true,
            config: { uuid: 'atlas-fallback' }
        });
    });

    test('disableProviderFallback prevents Codex model quota fallback', async () => {
        const manager = createManager({
            codex: [codexProvider('codex-primary')],
            globalConfig: {
                CODEX_53_QUOTA_FALLBACK_MODEL: 'gpt-5.6-luna'
            }
        });
        const primary = { uuid: 'codex-primary' };
        const selectSpy = jest.spyOn(manager, 'selectProvider')
            .mockImplementation(async (_providerType, model) => {
                if (model === 'gpt-5.3-codex-spark') {
                    const error = new Error('Codex Spark quota exhausted');
                    error.status = 429;
                    error.code = 429;
                    error.filterReasons = { codex53_quota_exceeded: 1 };
                    throw error;
                }
                return primary;
            });

        await expect(manager.selectProviderWithFallback('openai-codex-oauth', 'gpt-5.3-codex-spark', {
            disableProviderFallback: true,
            skipUsageCount: true
        })).rejects.toMatchObject({ status: 429 });
        expect(selectSpy).toHaveBeenCalledTimes(1);
        expect(selectSpy.mock.calls[0][1]).toBe('gpt-5.3-codex-spark');
    });

    test('disableProviderFallback prevents model fallback mapping', async () => {
        const manager = createManager({
            responses: [{ uuid: 'responses-primary', isHealthy: false, supportedModels: ['gpt-5.5'] }],
            openai: [{ uuid: 'openai-mapped', supportedModels: ['gpt-4o-mini'] }],
            globalConfig: {
                modelFallbackMapping: {
                    'gpt-5.5': {
                        targetProviderType: 'openai-custom',
                        targetModel: 'gpt-4o-mini'
                    }
                }
            }
        });

        await expect(manager.selectProviderWithFallback('openaiResponses-custom', 'gpt-5.5', {
            disableProviderFallback: true,
            skipUsageCount: true
        })).resolves.toBeNull();

        await expect(manager.selectProviderWithFallback('openaiResponses-custom', 'gpt-5.5', {
            skipUsageCount: true
        })).resolves.toMatchObject({
            actualProviderType: 'openai-custom',
            actualModel: 'gpt-4o-mini',
            config: { uuid: 'openai-mapped' }
        });
    });

    test('acquireSlotWithFallback short-circuits to the primary type when disabled', async () => {
        const manager = createManager({
            codex: [],
            openai: [{ uuid: 'openai-primary', isHealthy: false, supportedModels: ['gpt-5.5'] }],
            atlas: [{ uuid: 'atlas-fallback', supportedModels: ['gpt-5.5'] }],
            globalConfig: {
                providerFallbackChain: {
                    'openai-custom': ['atlascloud']
                }
            }
        });

        const result = await manager.acquireSlotWithFallback('openai-custom', 'gpt-5.5', {
            disableProviderFallback: true,
            allowedProviderUuids: ['openai-primary']
        });

        expect(result).toBeNull();
    });
});
