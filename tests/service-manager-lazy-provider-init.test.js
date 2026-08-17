import { afterEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(config => ({ provider: config.MODEL_PROVIDER, uuid: config.uuid })),
    getRegisteredProviders: jest.fn(() => ['openai-codex-oauth', 'gemini-antigravity']),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

import {
    getApiServiceWithFallback,
    getProviderPoolManager,
    initApiService
} from '../src/services/service-manager.js';
import { getServiceAdapter } from '../src/providers/adapter.js';

afterEach(() => {
    getServiceAdapter.mockClear();
    const manager = getProviderPoolManager();
    if (manager?.saveTimer) clearTimeout(manager.saveTimer);
    manager?.pendingSaves?.clear();
});

describe('lazy provider adapter initialization', () => {
    test('does not instantiate unused Antigravity credentials and creates only the selected adapter', async () => {
        const antigravityProviders = Array.from({ length: 12 }, (_, index) => ({
            uuid: `gemini-${index + 1}`,
            customName: `Gemini ${index + 1}`,
            isHealthy: true,
            supportedModels: ['gemini-2.5-flash'],
            lastKnownAntigravityPlan: 'Google AI Pro'
        }));
        const config = {
            MODEL_PROVIDER: 'openai-codex-oauth',
            DEFAULT_MODEL_PROVIDERS: ['openai-codex-oauth'],
            PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json',
            providerPools: {
                'openai-codex-oauth': [{
                    uuid: 'codex-1',
                    isHealthy: true,
                    supportedModels: ['gpt-5.6-luna'],
                    lastKnownCodexPlan: 'pro'
                }],
                'gemini-antigravity': antigravityProviders
            }
        };

        await initApiService(config, false, { persistenceEnabled: false });

        expect(getServiceAdapter).toHaveBeenCalledTimes(1);
        expect(getServiceAdapter.mock.calls[0][0]).toMatchObject({
            MODEL_PROVIDER: 'openai-codex-oauth',
            uuid: 'codex-1'
        });

        config.MODEL_PROVIDER = 'gemini-antigravity';
        const result = await getApiServiceWithFallback(config, 'gemini-2.5-flash', {
            disableProviderFallback: true
        });

        expect(result.actualProviderType).toBe('gemini-antigravity');
        expect(result.uuid).toMatch(/^gemini-/);
        expect(getServiceAdapter).toHaveBeenCalledTimes(2);
        expect(getServiceAdapter.mock.calls[1][0]).toMatchObject({
            MODEL_PROVIDER: 'gemini-antigravity',
            uuid: result.uuid
        });
    });
});
