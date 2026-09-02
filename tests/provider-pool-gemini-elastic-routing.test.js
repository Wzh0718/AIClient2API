import { jest } from '@jest/globals';
import { ProviderPoolManager, getAntigravityElasticFallbackModels } from '../src/providers/provider-pool-manager.js';
import requestContext from '../src/utils/context.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['gemini-antigravity', 'gemini-cli-oauth']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

const providerType = 'gemini-antigravity';
const sourceModel = 'gemini-2.5-flash-lite';
const firstFallback = 'gemini-2.5-flash';
const secondFallback = 'gemini-3.1-flash-lite';
const thirdFallback = 'gemini-3-flash';
const fourthFallback = 'gemini-3.5-flash-lite';
const fifthFallback = 'gemini-3.5-flash';
const sixthFallback = 'gemini-3.6-flash';

function coolingUntil(delayMs) {
    return {
        isHealthy: false,
        reason: 'upstream_429',
        scheduledRecoveryTime: new Date(Date.now() + delayMs).toISOString()
    };
}

function provider(uuid, cooldowns = {}) {
    return {
        uuid,
        customName: uuid,
        isHealthy: true,
        lastKnownAntigravityPlan: 'pro',
        supportedModels: [sourceModel, firstFallback, secondFallback],
        antigravityQuotaHealth: {
            families: {},
            models: cooldowns
        }
    };
}

function createManager(providers, overrides = {}) {
    return new ProviderPoolManager({ [providerType]: providers }, {
        persistenceEnabled: false,
        globalConfig: {
            antigravityElasticRouting: {
                enabled: true,
                maxQueueWaitMs: 80,
                preferOriginalWaitMs: 25,
                fallbackModels: [firstFallback, secondFallback],
                globalQueueLimit: 512,
                perKeyModelQueueLimit: 256,
                globalQueuedBytesLimit: 64 * 1024 * 1024,
                recoveryJitterMinMs: 0,
                recoveryJitterMaxMs: 0,
                ...overrides
            }
        }
    });
}

function createCoordinatedManager(providers, coordination, overrides = {}) {
    const manager = createManager(providers, overrides);
    manager.coordination = coordination;
    return manager;
}

describe('Antigravity elastic queue and model fallback', () => {
    test('only falls forward to stronger models when the requested model is in the middle', () => {
        const configured = [firstFallback, secondFallback, thirdFallback, fourthFallback, fifthFallback, sixthFallback];
        expect(getAntigravityElasticFallbackModels(sourceModel, configured)).toEqual(configured);
        expect(getAntigravityElasticFallbackModels(firstFallback, configured)).toEqual([
            secondFallback, thirdFallback, fourthFallback, fifthFallback, sixthFallback
        ]);
        expect(getAntigravityElasticFallbackModels(secondFallback, configured)).toEqual([
            thirdFallback, fourthFallback, fifthFallback, sixthFallback
        ]);
        expect(getAntigravityElasticFallbackModels(fifthFallback, configured)).toEqual([sixthFallback]);
        expect(getAntigravityElasticFallbackModels(sixthFallback, configured)).toEqual([]);
    });

    test('waits for a short source-model cooldown and keeps the requested model', async () => {
        const manager = createManager([
            provider('gemini-a', { [sourceModel]: coolingUntil(60) })
        ], { maxQueueWaitMs: 150, preferOriginalWaitMs: 100 });

        const startedAt = Date.now();
        const result = await manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a',
            queueRequestBytes: 128
        });

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
        expect(result).toMatchObject({
            actualModel: sourceModel,
            isFallback: false,
            queueOutcome: 'recovered_original'
        });
    });

    test('uses 2.5 Flash immediately when the source cooldown is not short', async () => {
        const manager = createManager([
            provider('gemini-a', { [sourceModel]: coolingUntil(500) })
        ]);

        const result = await manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        });

        expect(result).toMatchObject({
            actualModel: firstFallback,
            isFallback: true,
            modelFallbackReason: 'SOURCE_MODEL_UNAVAILABLE'
        });
    });

    test('records attempted models and source cooldown in the request context', async () => {
        const manager = createManager([
            provider('gemini-a', { [sourceModel]: coolingUntil(500) })
        ]);
        const store = { requestId: 'routing-context-test' };

        const result = await requestContext.run(store, () => manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        }));

        expect(result.actualModel).toBe(firstFallback);
        expect(store.antigravityRouting).toMatchObject({
            attemptedModels: [sourceModel, firstFallback],
            negativeCacheVersion: expect.any(Number),
            sourceModelCooldownMs: expect.any(Number)
        });
    });

    test('does not retry the same fallback model within one request lifecycle', async () => {
        const manager = createManager([
            provider('gemini-a', {
                [sourceModel]: coolingUntil(1500),
                [firstFallback]: coolingUntil(1500),
                [secondFallback]: coolingUntil(1500)
            })
        ], { maxQueueWaitMs: 25, preferOriginalWaitMs: 0 });
        const attempts = jest.spyOn(manager, '_tryAntigravityElasticModel');

        await expect(manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        })).rejects.toMatchObject({ code: 'QUEUE_WAIT_TIMEOUT' });

        const attemptedModels = attempts.mock.calls.map(([, model]) => model);
        expect(new Set(attemptedModels).size).toBe(attemptedModels.length);
    });

    test('continues to 3.1 Flash Lite when 2.5 Flash is also cooling down', async () => {
        const manager = createManager([
            provider('gemini-a', {
                [sourceModel]: coolingUntil(500),
                [secondFallback]: coolingUntil(500)
            })
        ]);

        const result = await manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        });

        expect(result.actualModel).toBe(firstFallback);
        expect([sourceModel, firstFallback, secondFallback]).toContain(result.actualModel);
    });

    test('applies the same model fallback chain to Gemini CLI OAuth', async () => {
        const manager = new ProviderPoolManager({
            'gemini-cli-oauth': [
                {
                    uuid: 'cli-source',
                    customName: 'CLI source',
                    isHealthy: false,
                    scheduledRecoveryTime: new Date(Date.now() + 60_000).toISOString(),
                    supportedModels: [sourceModel]
                },
                {
                    uuid: 'cli-fallback',
                    customName: 'CLI fallback',
                    isHealthy: true,
                    supportedModels: [firstFallback],
                    notSupportedModels: [sourceModel]
                }
            ]
        }, {
            persistenceEnabled: false,
            globalConfig: {
                antigravityElasticRouting: {
                    enabled: true,
                    fallbackModels: [firstFallback, secondFallback]
                }
            }
        });

        const result = await manager.selectProviderWithFallback('gemini-cli-oauth', sourceModel, {
            disableProviderFallback: true
        });

        expect(result).toMatchObject({
            actualProviderType: 'gemini-cli-oauth',
            actualModel: firstFallback,
            isFallback: true,
            config: { uuid: 'cli-fallback' }
        });
    });

    test('keeps the configured fallback order fixed even when configuration is reversed', async () => {
        const manager = createManager([
            provider('gemini-a', { [sourceModel]: coolingUntil(500) })
        ], { fallbackModels: [secondFallback, firstFallback] });

        const result = await manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        });

        expect(result.actualModel).toBe(firstFallback);
    });

    test('times out with a model-level 429 instead of returning null or 500', async () => {
        const manager = createManager([
            provider('gemini-a', {
                [sourceModel]: coolingUntil(500),
                [firstFallback]: coolingUntil(500),
                [secondFallback]: coolingUntil(500)
            })
        ], { maxQueueWaitMs: 25, preferOriginalWaitMs: 5 });

        await expect(manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        })).rejects.toMatchObject({
            status: 429,
            code: 'QUEUE_WAIT_TIMEOUT',
            quotaScope: 'model'
        });
    });

    test('enforces per-key queue capacity before retaining another request', async () => {
        const manager = createManager([
            provider('gemini-a', {
                [sourceModel]: coolingUntil(500),
                [firstFallback]: coolingUntil(500),
                [secondFallback]: coolingUntil(500)
            })
        ], { maxQueueWaitMs: 60, perKeyModelQueueLimit: 1 });

        const first = manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a',
            queueRequestBytes: 128
        });
        await new Promise(resolve => setTimeout(resolve, 5));

        await expect(manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a',
            queueRequestBytes: 128
        })).rejects.toMatchObject({ status: 429, code: 'QUEUE_CAPACITY_EXCEEDED' });
        await expect(first).rejects.toMatchObject({ code: 'QUEUE_WAIT_TIMEOUT' });
    });

    test('removes an aborted request from the queue', async () => {
        const manager = createManager([
            provider('gemini-a', {
                [sourceModel]: coolingUntil(500),
                [firstFallback]: coolingUntil(500),
                [secondFallback]: coolingUntil(500)
            })
        ], { maxQueueWaitMs: 500 });
        const controller = new AbortController();

        const pending = manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a',
            abortSignal: controller.signal
        });
        setTimeout(() => controller.abort(), 10);

        await expect(pending).rejects.toMatchObject({ code: 'CLIENT_ABORTED' });
        expect(manager.getGeminiElasticQueueSnapshot()).toMatchObject({ waiting: 0, queuedBytes: 0 });
    });

    test('allows immediate fallback without touching unavailable Redis coordination', async () => {
        const coordination = {
            acquire: jest.fn(async candidates => ({
                leaseId: 'provider-lease-1',
                providerType: candidates[0].providerType,
                uuid: candidates[0].uuid
            })),
            acquireGeminiQueueSlot: jest.fn(async () => { throw new Error('redis unavailable'); })
        };
        const manager = createCoordinatedManager([
            provider('gemini-a', { [sourceModel]: coolingUntil(500) })
        ], coordination);

        const result = await manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        });

        expect(result.actualModel).toBe(firstFallback);
        expect(coordination.acquireGeminiQueueSlot).not.toHaveBeenCalled();
    });

    test('returns 503 and does not create a local queue when Redis coordination is unavailable', async () => {
        const coordination = {
            acquire: jest.fn(async () => null),
            acquireGeminiQueueSlot: jest.fn(async () => { throw new Error('redis unavailable'); })
        };
        const manager = createCoordinatedManager([
            provider('gemini-a', {
                [sourceModel]: coolingUntil(500),
                [firstFallback]: coolingUntil(500),
                [secondFallback]: coolingUntil(500)
            })
        ], coordination, { maxQueueWaitMs: 30, preferOriginalWaitMs: 5 });

        await expect(manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        })).rejects.toMatchObject({
            status: 503,
            code: 'COORDINATION_UNAVAILABLE'
        });
        expect(manager.getGeminiElasticQueueSnapshot()).toMatchObject({ waiting: 0, queuedBytes: 0 });
    });

    test('treats an entirely free-plan credential pool as provider unavailable', async () => {
        const freeProvider = provider('gemini-free');
        freeProvider.lastKnownAntigravityPlan = 'Quota (Free)';
        const manager = createManager([freeProvider]);

        await expect(manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        })).rejects.toMatchObject({
            status: 503,
            code: 'PROVIDER_CREDENTIALS_UNAVAILABLE',
            filterReasons: { plan_free: 1 }
        });
    });

    test('absorbs 35 simultaneous short cooldown requests without any 500 result', async () => {
        const cooldowns = {
            [sourceModel]: coolingUntil(20),
            [firstFallback]: coolingUntil(20),
            [secondFallback]: coolingUntil(20)
        };
        const manager = createManager([
            provider('gemini-a', cooldowns),
            provider('gemini-b', cooldowns),
            provider('gemini-c', cooldowns),
            provider('gemini-d', cooldowns)
        ], { maxQueueWaitMs: 120, preferOriginalWaitMs: 80 });

        const results = await Promise.allSettled(Array.from({ length: 35 }, (_, index) => (
            manager.acquireSlotWithFallback(providerType, sourceModel, {
                queueKey: `key-${index % 4}`,
                queueRequestBytes: 256
            })
        )));

        expect(results.filter(result => result.status === 'rejected' && result.reason?.status === 500)).toHaveLength(0);
        expect(results.every(result => result.status === 'fulfilled')).toBe(true);
        expect(manager.getGeminiElasticQueueSnapshot()).toMatchObject({ waiting: 0, queuedBytes: 0 });
    });
});
