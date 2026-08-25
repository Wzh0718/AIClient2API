import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(config => ({ providerUuid: config.uuid })),
    getRegisteredProviders: jest.fn(() => ['openai-codex-oauth']),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

import {
    getApiServiceWithFallback,
    getProviderPoolManager,
    initApiService
} from '../src/services/service-manager.js';
import { codexOverloadFailoverStore } from '../src/providers/openai/codex-overload-failover.js';

const providerType = 'openai-codex-oauth';
const failoverKey = 'session:service-routing-test';

function createConfig(providerUuids) {
    return {
        MODEL_PROVIDER: providerType,
        PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json',
        _codexOverloadFailoverKey: failoverKey,
        providerPools: {
            [providerType]: providerUuids.map(uuid => ({
                uuid,
                customName: uuid,
                codexAccountKey: `account-${uuid}`,
                lastKnownCodexPlan: 'pro',
                supportedModels: ['gpt-5.4-mini']
            }))
        }
    };
}

beforeEach(() => {
    codexOverloadFailoverStore.clear(failoverKey);
});

afterEach(() => {
    codexOverloadFailoverStore.clear(failoverKey);
    const manager = getProviderPoolManager();
    if (manager?.saveTimer) {
        clearTimeout(manager.saveTimer);
        manager.saveTimer = null;
    }
    manager?.pendingSaves?.clear();
});

describe('Codex overload service routing', () => {
    test('selects another healthy credential on the next request and pins it', async () => {
        const config = createConfig(['codex-a', 'codex-b']);
        await initApiService(config);
        codexOverloadFailoverStore.recordFailure(failoverKey, 'codex-a');

        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini', { acquireSlot: true });

        expect(result.uuid).toBe('codex-b');
        expect(codexOverloadFailoverStore.getPendingExclusion(failoverKey)).toBeNull();
        expect(codexOverloadFailoverStore.getPinnedProvider(failoverKey)).toBe('codex-b');
        getProviderPoolManager().releaseSlot(providerType, result.uuid);

        const pinnedResult = await getApiServiceWithFallback(config, 'gpt-5.4-mini', { acquireSlot: true });
        expect(pinnedResult.uuid).toBe('codex-b');
        getProviderPoolManager().releaseSlot(providerType, pinnedResult.uuid);
    });

    test('allows the original credential when it is the only available credential', async () => {
        const config = createConfig(['codex-a']);
        await initApiService(config);
        codexOverloadFailoverStore.recordFailure(failoverKey, 'codex-a');

        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini', { acquireSlot: true });

        expect(result.uuid).toBe('codex-a');
        expect(codexOverloadFailoverStore.getPendingExclusion(failoverKey)).toBeNull();
        expect(codexOverloadFailoverStore.getPinnedProvider(failoverKey)).toBeNull();
        getProviderPoolManager().releaseSlot(providerType, result.uuid);
    });

    test('falls back to the original credential when alternatives are temporarily unavailable', async () => {
        const config = createConfig(['codex-a', 'codex-b']);
        await initApiService(config);
        const manager = getProviderPoolManager();
        manager.providerStatus[providerType].find(provider => provider.uuid === 'codex-b').config.isHealthy = false;
        codexOverloadFailoverStore.recordFailure(failoverKey, 'codex-a');

        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini', { acquireSlot: true });

        expect(result.uuid).toBe('codex-a');
        expect(codexOverloadFailoverStore.getPendingExclusion(failoverKey)).toBeNull();
        manager.releaseSlot(providerType, result.uuid);
    });

    test('cycles through normally schedulable credentials after every credential was tried once', async () => {
        const config = createConfig(['codex-a', 'codex-b']);
        await initApiService(config);
        const manager = getProviderPoolManager();

        const firstRetry = await getApiServiceWithFallback(config, 'gpt-5.4-mini', {
            acquireSlot: true,
            excludeProviderUuids: ['codex-a'],
            allowExcludedProviderFallback: true
        });
        expect(firstRetry.uuid).toBe('codex-b');
        manager.releaseSlot(providerType, firstRetry.uuid);

        const secondRetry = await getApiServiceWithFallback(config, 'gpt-5.4-mini', {
            acquireSlot: true,
            excludeProviderUuids: ['codex-a', 'codex-b'],
            allowExcludedProviderFallback: true
        });
        expect(secondRetry.uuid).toBe('codex-a');
        manager.releaseSlot(providerType, secondRetry.uuid);

        const thirdRetry = await getApiServiceWithFallback(config, 'gpt-5.4-mini', {
            acquireSlot: true,
            excludeProviderUuids: ['codex-a', 'codex-b'],
            allowExcludedProviderFallback: true
        });
        expect(thirdRetry.uuid).toBe('codex-b');
        manager.releaseSlot(providerType, thirdRetry.uuid);
    });

    test('returns a rate-limit error when every healthy credential is at concurrency capacity', async () => {
        const config = createConfig(['codex-a', 'codex-b']);
        config.providerPools[providerType][0].concurrencyLimit = 1;
        config.providerPools[providerType][1].concurrencyLimit = 1;
        await initApiService(config);
        const manager = getProviderPoolManager();
        const providerA = manager.providerStatus[providerType].find(provider => provider.uuid === 'codex-a');
        const providerB = manager.providerStatus[providerType].find(provider => provider.uuid === 'codex-b');
        providerA.config.isHealthy = false;
        providerB.state.activeCount = 1;

        const request = getApiServiceWithFallback(config, 'gpt-5.4-mini', {
            acquireSlot: true,
            excludeProviderUuids: ['codex-a', 'codex-b'],
            allowExcludedProviderFallback: true
        });

        await expect(request).rejects.toMatchObject({
            status: 429,
            code: 'PROVIDER_CONCURRENCY_EXHAUSTED'
        });
        await expect(request).rejects.toThrow('concurrency capacity');
    });

    test('does not reuse stale concurrency diagnostics when every credential is unhealthy', async () => {
        const config = createConfig(['codex-a']);
        await initApiService(config);
        const manager = getProviderPoolManager();
        manager.providerStatus[providerType][0].config.isHealthy = false;
        const selectionDiagnostics = {
            eligibleCandidateCount: 0,
            concurrencyLimitSkipped: 1,
            capacityExhausted: true
        };

        const request = getApiServiceWithFallback(config, 'gpt-5.4-mini', {
            acquireSlot: true,
            selectionDiagnostics
        });

        await expect(request).rejects.not.toMatchObject({ status: 429 });
        await expect(request).rejects.toMatchObject({
            status: 503,
            code: 'PROVIDER_CREDENTIALS_UNAVAILABLE'
        });
        expect(selectionDiagnostics).toMatchObject({
            eligibleCandidateCount: 0,
            concurrencyLimitSkipped: 0,
            capacityExhausted: false,
            temporaryCooldownSkipped: 0
        });
    });

    test('returns 429 when every credential is temporarily unavailable during a rate-limit cooldown', async () => {
        const config = createConfig(['codex-a', 'codex-b']);
        await initApiService(config);
        const manager = getProviderPoolManager();
        const recoveryTime = new Date(Date.now() + 60_000).toISOString();

        for (const provider of manager.providerStatus[providerType]) {
            provider.config.isHealthy = false;
            provider.config.scheduledRecoveryTime = recoveryTime;
            provider.config.lastErrorMessage = '429 Too Many Requests - short cooldown';
        }

        const selectionDiagnostics = {};
        const request = getApiServiceWithFallback(config, 'gpt-5.4-mini', {
            acquireSlot: true,
            selectionDiagnostics
        });

        await expect(request).rejects.toMatchObject({
            status: 429,
            code: 'PROVIDER_TEMPORARILY_UNAVAILABLE'
        });
        await expect(request).rejects.toThrow('temporarily unavailable');
        expect(selectionDiagnostics).toMatchObject({
            eligibleCandidateCount: 0,
            temporaryCooldownSkipped: 2,
            nextTemporaryRecoveryTime: recoveryTime
        });
    });

    test('atomically selects and occupies the only available concurrency slot', async () => {
        const config = createConfig(['codex-a']);
        config.providerPools[providerType][0].concurrencyLimit = 1;
        config.providerPools[providerType][0].queueLimit = 0;
        await initApiService(config);
        const manager = getProviderPoolManager();
        const selectedConfig = manager.providerStatus[providerType][0].config;
        const originalSelectProvider = manager.selectProvider.bind(manager);
        let waiting = 0;
        let releaseBoth;
        const bothSelected = new Promise(resolve => {
            releaseBoth = resolve;
        });
        manager.selectProvider = jest.fn(async () => {
            waiting++;
            if (waiting === 2) releaseBoth();
            await bothSelected;
            return selectedConfig;
        });

        try {
            const results = await Promise.allSettled([
                manager.acquireSlot(providerType, 'gpt-5.4-mini'),
                manager.acquireSlot(providerType, 'gpt-5.4-mini')
            ]);
            const fulfilled = results.filter(result => result.status === 'fulfilled');
            const rejected = results.filter(result => result.status === 'rejected');

            expect(fulfilled).toHaveLength(1);
            expect(rejected).toHaveLength(1);
            expect(rejected[0].reason).toMatchObject({ status: 429, code: 429 });
            expect(manager.providerStatus[providerType][0].state.activeCount).toBe(1);
        } finally {
            manager.selectProvider = originalSelectProvider;
            manager.releaseSlot(providerType, selectedConfig.uuid);
        }
    });
});
