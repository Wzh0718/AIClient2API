import { jest } from '@jest/globals';
import { ProviderPoolManager, getAntigravityElasticFallbackModels } from '../src/providers/provider-pool-manager.js';
import requestContext, { readRoutingWaits } from '../src/utils/context.js';

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
const firstFallback = 'gemini-3.1-flash-lite';
const secondFallback = 'gemini-2.5-flash';
const liteFallback = 'gemini-3.5-flash-lite';
const thirdFallback = 'gemini-3-flash';
const fourthFallback = 'gemini-3.8-flash-low';
const fifthFallback = 'gemini-3.8-flash-medium';

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
    test('uses one total fallback chain instead of same-series chains', () => {
        expect(getAntigravityElasticFallbackModels(
            'gemini-2.5-flash-lite',
            [
                'gemini-2.5-flash-lite',
                'gemini-3.1-flash-lite',
                'gemini-2.5-flash',
                'gemini-3.5-flash-lite',
                'gemini-3-flash',
                'gemini-3.6-flash-low',
                'gemini-3.6-flash-medium',
                'gemini-3.6-flash-high',
                'gemini-3.7-flash-low',
                'gemini-3.7-flash-medium',
                'gemini-3.7-flash-high',
                'gemini-3.8-flash-low',
                'gemini-3.8-flash-medium',
                'gemini-3.8-flash-high'
            ]
        )).toEqual([
            'gemini-3.1-flash-lite',
            'gemini-2.5-flash',
            'gemini-3.5-flash-lite',
            'gemini-3-flash'
        ]);
    });

    test('only selects fallback models present in the probed model list', () => {
        const configured = [firstFallback, secondFallback, liteFallback, thirdFallback];
        expect(getAntigravityElasticFallbackModels(sourceModel, configured, [
            firstFallback, liteFallback, thirdFallback
        ])).toEqual([firstFallback, liteFallback, thirdFallback]);
    });

    test('stops the chain at gemini-3-flash and never falls into 3.8 effort tiers', () => {
        const configured = [
            'gemini-2.5-flash-lite',
            'gemini-3.1-flash-lite',
            'gemini-2.5-flash',
            'gemini-3.5-flash-lite',
            'gemini-3-flash',
            'gemini-3.6-flash-low',
            'gemini-3.6-flash-medium',
            'gemini-3.6-flash-high',
            'gemini-3.7-flash-low',
            'gemini-3.7-flash-medium',
            'gemini-3.7-flash-high',
            'gemini-3.8-flash-low',
            'gemini-3.8-flash-medium',
            'gemini-3.8-flash-high'
        ];
        expect(getAntigravityElasticFallbackModels('gemini-3-flash', configured)).toEqual([]);
        expect(getAntigravityElasticFallbackModels('gemini-3.8-flash-low', configured)).toEqual([]);
        expect(getAntigravityElasticFallbackModels('gemini-3.8-flash-medium', configured)).toEqual([]);
        expect(getAntigravityElasticFallbackModels('gemini-3.8-flash-high', configured)).toEqual([]);
    });

    test('does not generate a series-specific fallback chain', () => {
        expect(getAntigravityElasticFallbackModels(
            'gemini-3.7-flash',
            [
                'gemini-2.5-flash-lite',
                'gemini-2.5-flash',
                'gemini-3.1-flash-lite',
                'gemini-3-flash',
                'gemini-3.6-flash-low',
                'gemini-3.6-flash-medium',
                'gemini-3.6-flash-high',
                'gemini-3.7-flash-low',
                'gemini-3.7-flash-medium',
                'gemini-3.7-flash-high',
                'gemini-3.8-flash-low',
                'gemini-3.8-flash-medium',
                'gemini-3.8-flash-high'
            ]
        )).toEqual([]);
    });

    test('only falls forward to later priced models when the requested model is in the middle', () => {
        const configured = [firstFallback, secondFallback, liteFallback, thirdFallback, fourthFallback, fifthFallback];
        expect(getAntigravityElasticFallbackModels(sourceModel, configured)).toEqual([
            firstFallback, secondFallback, liteFallback, thirdFallback
        ]);
        expect(getAntigravityElasticFallbackModels(firstFallback, configured)).toEqual([
            secondFallback, liteFallback, thirdFallback
        ]);
        expect(getAntigravityElasticFallbackModels(secondFallback, configured)).toEqual([liteFallback, thirdFallback]);
        expect(getAntigravityElasticFallbackModels(liteFallback, configured)).toEqual([thirdFallback]);
        expect(getAntigravityElasticFallbackModels(thirdFallback, configured)).toEqual([]);
        expect(getAntigravityElasticFallbackModels(fourthFallback, configured)).toEqual([]);
        expect(getAntigravityElasticFallbackModels(fifthFallback, configured)).toEqual([]);
    });

    test('waits for a short source-model cooldown and keeps the requested model', async () => {
        const manager = createManager([
            provider('gemini-a', { [sourceModel]: coolingUntil(120) })
        ], { maxQueueWaitMs: 250, preferOriginalWaitMs: 200 });

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

    test('waits preferOriginalWaitMs for a busy source credential then falls forward', async () => {
        const busy = provider('gemini-b');
        busy.concurrencyLimit = 1;
        busy.queueLimit = 0;
        const manager = createManager([
            provider('gemini-a', { [sourceModel]: coolingUntil(60_000) }),
            busy
        ], { maxQueueWaitMs: 200, preferOriginalWaitMs: 40 });
        manager.providerStatus[providerType].find(item => item.config.uuid === 'gemini-b').state.activeCount = 1;

        const startedAt = Date.now();
        const result = await manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        });

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
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
            sourceModelCooldownMs: expect.any(Number),
            sourceAvailability: {
                model: sourceModel,
                schedulableCount: 1,
                coolingCount: 1,
                eligibleCount: 0,
                exhausted: true,
                fallbackReason: 'ALL_CREDENTIALS_COOLING'
            }
        });
    });

    test('does not overwrite the source availability snapshot after falling forward', async () => {
        const manager = createManager([
            provider('gemini-a', {
                [sourceModel]: coolingUntil(500),
                [firstFallback]: coolingUntil(500)
            })
        ]);
        const store = { requestId: 'source-availability-stable' };

        const result = await requestContext.run(store, () => manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        }));

        expect(result.actualModel).toBe(secondFallback);
        expect(store.antigravityRouting.sourceAvailability).toMatchObject({
            model: sourceModel,
            schedulableCount: 1,
            coolingCount: 1,
            eligibleCount: 0,
            exhausted: true,
            fallbackReason: 'ALL_CREDENTIALS_COOLING'
        });
    });

    test('records remaining source credentials as not exhausted when they are only busy', async () => {
        const busy = provider('gemini-b');
        busy.concurrencyLimit = 1;
        busy.queueLimit = 0;
        const manager = createManager([
            provider('gemini-a', { [sourceModel]: coolingUntil(60_000) }),
            busy
        ], { maxQueueWaitMs: 200, preferOriginalWaitMs: 40 });
        manager.providerStatus[providerType].find(item => item.config.uuid === 'gemini-b').state.activeCount = 1;
        const store = { requestId: 'busy-source-availability' };

        const result = await requestContext.run(store, () => manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        }));

        expect(result.actualModel).toBe(firstFallback);
        expect(store.antigravityRouting.sourceAvailability).toMatchObject({
            model: sourceModel,
            schedulableCount: 2,
            coolingCount: 1,
            eligibleCount: 1,
            exhausted: false,
            fallbackReason: 'PREFER_ORIGINAL_WAIT_EXPIRED'
        });
    });

    test('does not retry the same fallback model within one pass', async () => {
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

        const firstPass = [];
        for (const [, model] of attempts.mock.calls) {
            if (firstPass.includes(model)) break;
            firstPass.push(model);
        }
        expect(new Set(firstPass).size).toBe(firstPass.length);
        expect(firstPass).toEqual([sourceModel, firstFallback, secondFallback]);
    });

    test('skips models no credential supports and fast-fails a fully cooling chain', async () => {
        const longCool = coolingUntil(60_000);
        const manager = createManager([
            provider('gemini-a', {
                [sourceModel]: longCool,
                [firstFallback]: longCool,
                [secondFallback]: longCool
            })
        ], {
            maxQueueWaitMs: 4000,
            preferOriginalWaitMs: 0,
            fallbackModels: [firstFallback, secondFallback, 'gemini-3.8-flash-high']
        });
        const attempts = jest.spyOn(manager, '_tryAntigravityElasticModel');

        await expect(manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        })).rejects.toMatchObject({
            status: 429,
            code: 'ALL_MODELS_UNAVAILABLE'
        });

        const modelsTried = attempts.mock.calls.map(([, model]) => model);
        expect(modelsTried).toEqual([sourceModel, firstFallback, secondFallback]);
        expect(modelsTried).not.toContain('gemini-3.8-flash-high');
    });

    test('does not re-lease models whose cooldown has not expired', async () => {
        const manager = createManager([
            provider('gemini-a', {
                [sourceModel]: coolingUntil(60_000),
                [firstFallback]: coolingUntil(80),
                [secondFallback]: coolingUntil(60_000)
            })
        ], { maxQueueWaitMs: 220, preferOriginalWaitMs: 0 });
        const attempts = jest.spyOn(manager, '_tryAntigravityElasticModel');

        const result = await manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        });

        expect(result.actualModel).toBe(firstFallback);
        expect(attempts.mock.calls.filter(([, model]) => model === sourceModel)).toHaveLength(1);
        expect(attempts.mock.calls.filter(([, model]) => model === secondFallback)).toHaveLength(1);
        expect(attempts.mock.calls.filter(([, model]) => model === firstFallback).length).toBeGreaterThanOrEqual(2);
    });

    test('waits for short model recovery instead of re-leasing on a one-second cadence', async () => {
        const coordination = {
            acquire: jest.fn(async candidates => ({
                leaseId: `lease-${candidates[0].uuid}`,
                providerType: candidates[0].providerType,
                uuid: candidates[0].uuid
            })),
            acquireGeminiQueueSlot: jest.fn(async () => ({ leaseId: 'queue-1' })),
            releaseGeminiQueueSlot: jest.fn(async () => true),
            release: jest.fn(async () => true)
        };
        const manager = createCoordinatedManager([
            provider('gemini-a', {
                [sourceModel]: coolingUntil(1500),
                [firstFallback]: coolingUntil(1500),
                [secondFallback]: coolingUntil(1500)
            })
        ], coordination, { maxQueueWaitMs: 1400, preferOriginalWaitMs: 0 });
        const attempts = jest.spyOn(manager, '_tryAntigravityElasticModel');

        await expect(manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        })).rejects.toMatchObject({ status: 429 });

        expect(attempts.mock.calls.length).toBeLessThanOrEqual(6);
    });

    test('retries quota-cooled models after a wake and succeeds when they recover', async () => {
        const manager = createManager([
            provider('gemini-a', {
                [sourceModel]: coolingUntil(40),
                [firstFallback]: coolingUntil(40),
                [secondFallback]: coolingUntil(40)
            })
        ], { maxQueueWaitMs: 160, preferOriginalWaitMs: 0 });

        const result = await manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        });

        expect(result).toMatchObject({
            actualModel: expect.stringMatching(/gemini-/),
            queueOutcome: expect.stringMatching(/fallback_after_wait|recovered_original/)
        });
        expect(result.config?.uuid).toBe('gemini-a');
    });

    test('does not retry a model-not-found entry after a wake', async () => {
        const manager = createManager([provider('gemini-a')]);
        manager.markAntigravityModelNotFound(providerType, sourceModel);
        const attempts = jest.spyOn(manager, '_tryAntigravityElasticModel');

        const result = await manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        });

        expect(result.actualModel).toBe(firstFallback);
        expect(attempts.mock.calls.map(([, model]) => model)).not.toContain(sourceModel);
    });

    test('records elastic queue wait on the request instead of treating it as compute', async () => {
        const manager = createManager([
            provider('gemini-a', { [sourceModel]: coolingUntil(60) })
        ], { maxQueueWaitMs: 150, preferOriginalWaitMs: 100 });

        await requestContext.run({ requestId: 'elastic-wait-split' }, async () => {
            await manager.acquireSlotWithFallback(providerType, sourceModel, {
                queueKey: 'key-a',
                queueRequestBytes: 128
            });
            expect(readRoutingWaits().elasticQueueWaitMs).toBeGreaterThanOrEqual(25);
            expect(readRoutingWaits().elasticAttemptCount).toBeGreaterThanOrEqual(1);
        });
    });

    test('does not bump global availability revision when invalidating one model', () => {
        const manager = createManager([provider('gemini-a')]);
        const providers = manager.providerStatus[providerType];
        const otherModel = firstFallback;
        const beforeOther = manager._getAntigravityAvailabilityScope(providerType, otherModel, providers);
        const beforeSource = manager._getAntigravityAvailabilityScope(providerType, sourceModel, providers);
        const globalBefore = manager._antigravityAvailabilityRevision;

        manager.invalidateAntigravityAvailability(sourceModel);

        expect(manager._antigravityAvailabilityRevision).toBe(globalBefore);
        expect(manager._getAntigravityAvailabilityScope(providerType, sourceModel, providers)).not.toBe(beforeSource);
        expect(manager._getAntigravityAvailabilityScope(providerType, otherModel, providers)).toBe(beforeOther);
    });

    test('coalesces wait-loop invalidations for the same model', async () => {
        const manager = createManager([
            provider('gemini-a', {
                [sourceModel]: coolingUntil(1500),
                [firstFallback]: coolingUntil(1500),
                [secondFallback]: coolingUntil(1500)
            })
        ], { maxQueueWaitMs: 80, preferOriginalWaitMs: 0 });
        const invalidate = jest.spyOn(manager, 'invalidateAntigravityAvailability');

        await expect(manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        })).rejects.toMatchObject({ code: 'QUEUE_WAIT_TIMEOUT' });

        const waitLoopCalls = invalidate.mock.calls.filter(([, options]) => options?.minIntervalMs > 0);
        expect(waitLoopCalls.length).toBeGreaterThan(0);
        expect(waitLoopCalls.length).toBeLessThan(4);
    });

    test('reuses model-independent candidates across one elastic pass', async () => {
        const manager = createManager([
            provider('gemini-a', { [sourceModel]: coolingUntil(500) })
        ], { preferOriginalWaitMs: 0 });
        const planFilter = jest.spyOn(manager, '_filterAntigravityProvidersByPlan');

        await manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: 'key-a'
        });

        expect(planFilter.mock.calls.length).toBe(1);
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

    test.each([
        'Quota',
        'Quota (Free)',
        'Starter Quota',
        'Antigravity Starter Quota',
        '  antigravity   starter   quota  '
    ])('treats %j as a free plan and excludes it from scheduling', async plan => {
        const freeProvider = provider(`gemini-free-${plan}`);
        freeProvider.lastKnownAntigravityPlan = plan;
        const manager = createManager([freeProvider]);

        await expect(manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: `key-${plan}`
        })).rejects.toMatchObject({
            status: 503,
            code: 'PROVIDER_CREDENTIALS_UNAVAILABLE',
            filterReasons: { plan_free: 1 }
        });
    });

    test.each(['Pro', 'Ultra'])('keeps %s plans eligible for scheduling', async plan => {
        const paidProvider = provider(`gemini-${plan.toLowerCase()}`);
        paidProvider.lastKnownAntigravityPlan = plan;
        const manager = createManager([paidProvider]);

        const result = await manager.acquireSlotWithFallback(providerType, sourceModel, {
            queueKey: `key-${plan}`
        });

        expect(result.config.uuid).toBe(paidProvider.uuid);
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

    test('does not silently fall back to another model when elastic routing is not configured (default off)', async () => {
        // globalConfig 不含 antigravityElasticRouting：默认必须关闭弹性路由。
        // 原模型冷却时只允许返回空/抛 429，绝不静默执行链上其他模型。
        const manager = new ProviderPoolManager({
            [providerType]: [provider('gemini-a', { [sourceModel]: coolingUntil(60_000) })]
        }, {
            persistenceEnabled: false,
            globalConfig: {}
        });

        const acquireSpy = jest.spyOn(manager, 'acquireSlot');
        let result = null;
        let thrown = null;
        try {
            result = await manager.acquireSlotWithFallback(providerType, sourceModel);
        } catch (error) {
            thrown = error;
        } finally {
            const attemptedModels = acquireSpy.mock.calls.map(call => call[1]);
            expect(attemptedModels).toEqual([sourceModel]);
            acquireSpy.mockRestore();
        }
        expect(result).toBeNull();
        if (thrown) {
            expect([thrown.status, thrown.code]).toContain(429);
        }
    });

    test('does not silently fall back when elastic routing is explicitly disabled', async () => {
        const manager = new ProviderPoolManager({
            [providerType]: [provider('gemini-a', { [sourceModel]: coolingUntil(60_000) })]
        }, {
            persistenceEnabled: false,
            globalConfig: { antigravityElasticRouting: { enabled: false } }
        });

        const selectSpy = jest.spyOn(manager, 'selectProvider');
        let result = null;
        let thrown = null;
        try {
            result = await manager.selectProviderWithFallback(providerType, sourceModel);
        } catch (error) {
            thrown = error;
        } finally {
            const attemptedModels = selectSpy.mock.calls.map(call => call[1]);
            expect(attemptedModels.every(model => model === sourceModel)).toBe(true);
            expect(attemptedModels).not.toContain(firstFallback);
            selectSpy.mockRestore();
        }
        expect(result).toBeNull();
        if (thrown) {
            expect([thrown.status, thrown.code]).toContain(429);
        }
    });

    test('still selects the requested model directly when elastic routing is disabled and the model is healthy', async () => {
        const manager = new ProviderPoolManager({
            [providerType]: [provider('gemini-a')]
        }, {
            persistenceEnabled: false,
            globalConfig: { antigravityElasticRouting: { enabled: false } }
        });

        const result = await manager.acquireSlotWithFallback(providerType, sourceModel);
        expect(result).toMatchObject({
            actualModel: sourceModel,
            isFallback: false
        });
    });

    test('only wakes queued waiters of the provider whose slot was released', async () => {
        const manager = createManager([provider('gemini-a')]);
        let woken = false;
        const wait = manager._waitForGeminiElasticWake({ timeoutMs: 5000, providerType }).then(() => { woken = true; });

        manager.releaseSlot('openai-codex-oauth', 'codex-1');
        await new Promise(resolve => setImmediate(resolve));
        expect(woken).toBe(false);

        manager.releaseSlot(providerType, 'gemini-a');
        await wait;
        expect(woken).toBe(true);
    });
});
