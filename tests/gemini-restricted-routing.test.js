import { expect, test, describe, jest } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['gemini-antigravity', 'openai-codex-oauth']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));

const GEMINI = 'gemini-antigravity';

function coolingUntil(delayMs = 500) {
    return {
        isHealthy: false,
        reason: 'upstream_429',
        scheduledRecoveryTime: new Date(Date.now() + delayMs).toISOString()
    };
}

function geminiProvider(uuid, cooldowns = {}) {
    return {
        uuid,
        customName: uuid,
        isHealthy: true,
        lastKnownAntigravityPlan: 'pro',
        supportedModels: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite'],
        antigravityQuotaHealth: { families: {}, models: cooldowns }
    };
}

function createManager(providers, globalConfig = {}) {
    return new ProviderPoolManager({ [GEMINI]: providers }, {
        persistenceEnabled: false,
        globalConfig: {
            antigravityElasticRouting: {
                enabled: true,
                maxQueueWaitMs: 20,
                preferOriginalWaitMs: 0,
                recoveryJitterMinMs: 0,
                recoveryJitterMaxMs: 0
            },
            ...globalConfig
        }
    });
}

describe('restricted Gemini same-provider routing', () => {
    test('keeps a healthy 2.5 Flash request on the original model', async () => {
        const result = await createManager([geminiProvider('a')]).acquireSlotWithFallback(GEMINI, 'gemini-2.5-flash');
        expect(result).toMatchObject({ actualModel: 'gemini-2.5-flash', isFallback: false });
    });

    test('falls back from unavailable 2.5 Flash only to 3.1 Flash Lite', async () => {
        const result = await createManager([geminiProvider('a', { 'gemini-2.5-flash': coolingUntil() })])
            .acquireSlotWithFallback(GEMINI, 'gemini-2.5-flash');
        expect(result).toMatchObject({ actualModel: 'gemini-3.1-flash-lite', isFallback: true });
    });

    test('falls back from unavailable 2.5 Flash Lite in the configured order', async () => {
        const result = await createManager([geminiProvider('a', { 'gemini-2.5-flash-lite': coolingUntil() })])
            .acquireSlotWithFallback(GEMINI, 'gemini-2.5-flash-lite');
        expect(result).toMatchObject({ actualModel: 'gemini-2.5-flash', isFallback: true });
    });

    test('continues from unavailable 2.5 Flash to 3.1 Flash Lite', async () => {
        const result = await createManager([geminiProvider('a', {
            'gemini-2.5-flash-lite': coolingUntil(),
            'gemini-2.5-flash': coolingUntil()
        })]).acquireSlotWithFallback(GEMINI, 'gemini-2.5-flash-lite');
        expect(result.actualModel).toBe('gemini-3.1-flash-lite');
    });

    test('does not fallback from unavailable 3.1 Flash Lite', async () => {
        await expect(createManager([geminiProvider('a', { 'gemini-3.1-flash-lite': coolingUntil() })])
            .acquireSlotWithFallback(GEMINI, 'gemini-3.1-flash-lite'))
            .rejects.toMatchObject({ status: 429 });
    });

    test('never crosses from Gemini into a GPT provider', async () => {
        const manager = createManager([], {
            providerFallbackChain: { [GEMINI]: ['openai-codex-oauth'] }
        });
        manager.providerStatus['openai-codex-oauth'] = [{ uuid: 'codex-a', isHealthy: true }];
        await expect(manager.acquireSlotWithFallback(GEMINI, 'gemini-2.5-flash'))
            .rejects.toMatchObject({ status: 429 });
    });
});
