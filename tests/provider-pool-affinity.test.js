import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['openai-codex-oauth']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

let consoleSpies = [];

function createCodexPoolManager() {
    return new ProviderPoolManager({
        'openai-codex-oauth': [
            { uuid: 'codex-a', customName: 'Codex A', lastKnownCodexPlan: 'pro', supportedModels: ['gpt-5.5'] },
            { uuid: 'codex-b', customName: 'Codex B', lastKnownCodexPlan: 'pro', supportedModels: ['gpt-5.5'] },
            { uuid: 'codex-c', customName: 'Codex C', lastKnownCodexPlan: 'pro', supportedModels: ['gpt-5.5'] }
        ]
    }, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json'
        }
    });
}

function createWeightedCodexPoolManager() {
    return new ProviderPoolManager({
        'openai-codex-oauth': [
            { uuid: 'codex-low', customName: 'Codex Low', providerWeight: 1, quotaAvailable: true, lastKnownCodexPlan: 'pro', supportedModels: ['gpt-5.5'] },
            { uuid: 'codex-high', customName: 'Codex High', providerWeight: 3, quotaAvailable: true, lastKnownCodexPlan: 'pro', supportedModels: ['gpt-5.5'] }
        ]
    }, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json'
        }
    });
}

function createHotShardCodexPoolManager() {
    const manager = new ProviderPoolManager({
        'openai-codex-oauth': [
            { uuid: 'codex-hot', customName: 'Codex Hot', usageCount: 500, lastKnownCodexPlan: 'pro', supportedModels: ['gpt-5.5'] },
            { uuid: 'codex-cold-a', customName: 'Codex Cold A', usageCount: 5, lastKnownCodexPlan: 'pro', supportedModels: ['gpt-5.5'] },
            { uuid: 'codex-cold-b', customName: 'Codex Cold B', usageCount: 8, lastKnownCodexPlan: 'pro', supportedModels: ['gpt-5.5'] },
            { uuid: 'codex-cold-c', customName: 'Codex Cold C', usageCount: 12, lastKnownCodexPlan: 'pro', supportedModels: ['gpt-5.5'] }
        ]
    }, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json',
            CODEX_STICKY_HOT_SHARD_ENABLED: true,
            CODEX_STICKY_HOT_SHARD_MIN_REQUESTS: 3,
            CODEX_STICKY_HOT_SHARD_WINDOW_MS: 60 * 1000,
            CODEX_STICKY_HOT_SHARD_MAX_SHARDS: 3
        }
    });
    const usageCounts = {
        'codex-hot': 500,
        'codex-cold-a': 5,
        'codex-cold-b': 8,
        'codex-cold-c': 12
    };
    manager.providerStatus['openai-codex-oauth'].forEach(provider => {
        provider.config.usageCount = usageCounts[provider.uuid];
    });
    return manager;
}

function createNineAccountHotShardManager() {
    return new ProviderPoolManager({
        'openai-codex-oauth': Array.from({ length: 9 }, (_, index) => ({
            uuid: `codex-${index + 1}`,
            customName: `Codex ${index + 1}`,
            lastKnownCodexPlan: 'pro',
            supportedModels: ['gpt-5.5']
        }))
    }, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json',
            CODEX_STICKY_HOT_SHARD_ENABLED: true,
            CODEX_STICKY_HOT_SHARD_MIN_REQUESTS: 30,
            CODEX_STICKY_HOT_SHARD_WINDOW_MS: 60 * 1000,
            CODEX_STICKY_HOT_SHARD_MAX_SHARDS: 5
        }
    });
}

beforeEach(() => {
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
});

describe('provider pool sticky affinity', () => {
    test('uses a 60-minute, 100-request default threshold for hot Codex affinity keys', () => {
        const manager = createCodexPoolManager();
        const config = manager._getCodexStickyHotShardConfig();

        clearTimeout(manager.saveTimer);
        expect(config).toMatchObject({
            windowMs: 60 * 60 * 1000,
            minRequests: 100
        });
    });

    test('selects the same healthy Codex provider for the same affinity key', async () => {
        const manager = createCodexPoolManager();

        const first = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
            stickyProviderKey: 'potluck-key-alpha',
            skipUsageCount: true
        });

        const selectedUuids = [];
        for (let i = 0; i < 5; i++) {
            const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
                stickyProviderKey: 'potluck-key-alpha',
                skipUsageCount: true
            });
            selectedUuids.push(selected.uuid);
        }

        clearTimeout(manager.saveTimer);
        expect(new Set(selectedUuids)).toEqual(new Set([first.uuid]));
    });

    test('falls back to another healthy Codex provider when the affined provider is unavailable', async () => {
        const manager = createCodexPoolManager();
        const first = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
            stickyProviderKey: 'potluck-key-alpha',
            skipUsageCount: true
        });

        first.isHealthy = false;

        const next = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
            stickyProviderKey: 'potluck-key-alpha',
            skipUsageCount: true
        });

        clearTimeout(manager.saveTimer);
        expect(next.uuid).not.toBe(first.uuid);
        expect(next.isHealthy).toBe(true);
    });

    test('excludes a failed provider during sticky retry selection', async () => {
        const manager = createCodexPoolManager();
        const first = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
            stickyProviderKey: 'potluck-key-alpha',
            skipUsageCount: true
        });

        const retrySelection = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
            stickyProviderKey: 'potluck-key-alpha',
            excludeProviderUuids: [first.uuid],
            skipUsageCount: true
        });

        clearTimeout(manager.saveTimer);
        expect(retrySelection.uuid).not.toBe(first.uuid);
        expect(retrySelection.isHealthy).toBe(true);
    });

    test('pool-key routing uses smooth weighted scheduling before sticky hot-shard affinity', async () => {
        const manager = createWeightedCodexPoolManager();
        const selected = [];
        for (let i = 0; i < 6; i++) {
            const result = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
                routingMode: 'pool',
                poolKeyId: 'batch-key',
                stickyProviderKey: 'legacy-affinity',
                skipUsageCount: true
            });
            selected.push(result.uuid);
        }
        clearTimeout(manager.saveTimer);
        expect(selected.filter(uuid => uuid === 'codex-high')).toHaveLength(4);
        expect(selected.filter(uuid => uuid === 'codex-low')).toHaveLength(2);
    });

    test('honors an explicit preferred provider for a sticky session', async () => {
        const manager = createCodexPoolManager();

        const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
            stickyProviderKey: 'potluck-key-alpha',
            preferredProviderUuid: 'codex-c',
            skipUsageCount: true
        });

        clearTimeout(manager.saveTimer);
        expect(selected.uuid).toBe('codex-c');
    });

    test('distributes different affinity keys by Codex provider weight while keeping each key sticky', async () => {
        const manager = createWeightedCodexPoolManager();
        const firstSelections = new Map();
        const counts = { 'codex-low': 0, 'codex-high': 0 };

        for (let i = 0; i < 200; i++) {
            const stickyProviderKey = `cache-key-${i}`;
            const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
                stickyProviderKey,
                skipUsageCount: true
            });
            firstSelections.set(stickyProviderKey, selected.uuid);
            counts[selected.uuid] += 1;
        }

        for (const [stickyProviderKey, uuid] of firstSelections.entries()) {
            const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
                stickyProviderKey,
                skipUsageCount: true
            });
            expect(selected.uuid).toBe(uuid);
        }

        clearTimeout(manager.saveTimer);
        expect(counts['codex-high']).toBeGreaterThanOrEqual(counts['codex-low'] * 2);
    });

    test('splits hot Codex affinity keys across low-usage shard providers', async () => {
        const manager = createHotShardCodexPoolManager();
        const stickyProviderKey = 'hot-cache-key-alpha';

        const selections = [];
        for (let i = 0; i < 12; i++) {
            const selected = await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
                stickyProviderKey,
                shardDiscriminator: `turn-${i}`,
                skipUsageCount: true
            });
            selections.push(selected.uuid);
        }

        const hotSelections = selections.slice(3);
        clearTimeout(manager.saveTimer);
        expect(new Set(hotSelections).size).toBeGreaterThanOrEqual(2);
        expect(new Set(hotSelections)).not.toContain('codex-hot');
    });

    test('reports when a hot sticky shard was applied', async () => {
        const manager = createHotShardCodexPoolManager();
        const stickyProviderKey = 'hot-cache-key-diagnostics';
        const diagnostics = {};

        for (let i = 0; i < 4; i++) {
            await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', {
                stickyProviderKey,
                shardDiscriminator: `turn-${i}`,
                selectionDiagnostics: diagnostics,
                skipUsageCount: true
            });
        }

        clearTimeout(manager.saveTimer);
        expect(diagnostics.hotShardApplied).toBe(true);
    });

    test('raises very hot Codex affinity keys up to five shards when enough accounts exist', async () => {
        const manager = createNineAccountHotShardManager();
        const config = manager._getCodexStickyHotShardConfig();

        expect(manager._getCodexHotShardCount(30, 9, config)).toBe(2);
        expect(manager._getCodexHotShardCount(90, 9, config)).toBe(3);
        expect(manager._getCodexHotShardCount(180, 9, config)).toBe(4);
        expect(manager._getCodexHotShardCount(360, 9, config)).toBe(5);

        clearTimeout(manager.saveTimer);
    });

    test('penalizes recently selected Codex shard providers when ranking hot shard candidates', async () => {
        const manager = createNineAccountHotShardManager();
        const providers = manager.providerStatus['openai-codex-oauth'];
        const hotProvider = providers.find(provider => provider.uuid === 'codex-1');

        for (let i = 0; i < 80; i++) {
            manager._recordProviderSelectionLoad('openai-codex-oauth', hotProvider, 1000 + i);
        }

        const ranked = manager._rankCodexShardProviders(providers, 'openai-codex-oauth', 'gpt-5.5', null, 60 * 1000 + 1000);

        clearTimeout(manager.saveTimer);
        expect(ranked.slice(0, 5).map(provider => provider.uuid)).not.toContain('codex-1');
    });

    test('logs slow provider selection when selection exceeds the configured threshold', async () => {
        const manager = createCodexPoolManager();
        manager.globalConfig.CODEX_PROVIDER_SELECTION_SLOW_WARN_MS = 50;
        const selected = manager.providerStatus['openai-codex-oauth'][0].config;
        const originalDoSelectProvider = manager._doSelectProvider.bind(manager);
        const logSpy = jest.spyOn(manager, '_log');
        const nowSpy = jest.spyOn(Date, 'now')
            .mockReturnValueOnce(1000)
            .mockReturnValueOnce(1075);
        manager._doSelectProvider = jest.fn(() => selected);

        await manager.selectProvider('openai-codex-oauth', 'gpt-5.5', { skipUsageCount: true });

        manager._doSelectProvider = originalDoSelectProvider;
        nowSpy.mockRestore();
        clearTimeout(manager.saveTimer);
        expect(logSpy).toHaveBeenCalledWith('warn', expect.stringContaining('Slow provider selection'));
    });
});
