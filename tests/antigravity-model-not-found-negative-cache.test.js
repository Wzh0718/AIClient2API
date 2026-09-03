import { jest } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { createErrorResponse, isAntigravityModelNotFoundError } from '../src/utils/common.js';

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

function provider(uuid) {
    return {
        uuid,
        customName: uuid,
        isHealthy: true,
        lastKnownAntigravityPlan: 'pro',
        supportedModels: [sourceModel, firstFallback, secondFallback],
        antigravityQuotaHealth: { families: {}, models: {} }
    };
}

function createSharedCoordination() {
    const store = new Map();
    return {
        store,
        getModelNegativeCache: jest.fn(async scope => store.get(scope) || null),
        setModelNegativeCache: jest.fn(async (scope, value) => {
            store.set(scope, JSON.parse(JSON.stringify(value)));
            return true;
        })
    };
}

function createManager(coordination = null, overrides = {}) {
    const manager = new ProviderPoolManager({ [providerType]: [provider('gemini-a')] }, {
        persistenceEnabled: false,
        globalConfig: {
            antigravityElasticRouting: {
                enabled: true,
                maxQueueWaitMs: 40,
                preferOriginalWaitMs: 0,
                fallbackModels: [firstFallback, secondFallback],
                recoveryJitterMinMs: 0,
                recoveryJitterMaxMs: 0,
                ...overrides
            }
        }
    });
    if (coordination) manager.coordination = coordination;
    return manager;
}

describe('Antigravity model-not-found negative cache', () => {
    describe('error classification', () => {
        test('classifies upstream 404 and NOT_FOUND payloads as model level', () => {
            expect(isAntigravityModelNotFoundError({ status: 404 }, providerType)).toBe(true);
            expect(isAntigravityModelNotFoundError({
                response: { status: 404, data: { error: { status: 'NOT_FOUND', message: 'Requested entity was not found.' } } }
            }, providerType)).toBe(true);
            expect(isAntigravityModelNotFoundError({ code: 'MODEL_NOT_FOUND' }, providerType)).toBe(true);
        });

        test('does not classify other statuses or other providers', () => {
            expect(isAntigravityModelNotFoundError({ status: 429 }, providerType)).toBe(false);
            expect(isAntigravityModelNotFoundError({ status: 503 }, providerType)).toBe(false);
            expect(isAntigravityModelNotFoundError({ status: 404 }, 'openai-codex-oauth')).toBe(false);
        });

        test('keeps a locally rejected unsupported model as a 400 request error', () => {
            const error = { status: 400, code: 'MODEL_NOT_SUPPORTED', message: '[Antigravity] 模型不存在: gpt-5.4-mini' };
            expect(isAntigravityModelNotFoundError(error, providerType)).toBe(false);
            expect(createErrorResponse(error, 'openai-custom')).toEqual({
                error: {
                    message: '[Antigravity] 模型不存在: gpt-5.4-mini',
                    type: 'invalid_request_error',
                    code: 'invalid_request_error'
                }
            });
        });
    });

    test('skips a model that upstream reported as nonexistent', () => {
        const manager = createManager();
        expect(manager.markAntigravityModelNotFound(providerType, firstFallback, 'Requested entity was not found.')).toBe(true);

        expect(manager.isAntigravityModelNotFound(providerType, firstFallback)).toBe(true);
        expect(manager._excludeAntigravityModelsNotFound(providerType, [sourceModel, firstFallback, secondFallback]))
            .toEqual([sourceModel, secondFallback]);
        expect(manager.getAntigravityRoutingMetrics()).toMatchObject({
            modelNotFoundMarked: 1,
            skippedByNegativeCache: 1
        });
    });

    test('routes past a nonexistent fallback instead of calling it again', async () => {
        const manager = createManager();
        manager.markAntigravityModelNotFound(providerType, firstFallback);
        const attempts = jest.spyOn(manager, '_tryAntigravityElasticModel');

        const result = await manager.acquireSlotWithFallback(providerType, sourceModel, { queueKey: 'key-a' });

        expect(result.actualModel).toBe(sourceModel);
        expect(attempts.mock.calls.map(([, model]) => model)).not.toContain(firstFallback);
    });

    test('fails fast with a 404 when every chain model is known to be missing', async () => {
        const manager = createManager();
        for (const model of [sourceModel, firstFallback, secondFallback]) {
            manager.markAntigravityModelNotFound(providerType, model);
        }

        await expect(manager.acquireSlotWithFallback(providerType, sourceModel, { queueKey: 'key-a' }))
            .rejects.toMatchObject({ code: 'MODEL_NOT_FOUND', status: 404 });
        expect(manager.getAntigravityRoutingMetrics().modelNotFoundFastFails).toBe(1);
    });

    test('still serves a fallback when only the requested model is missing', async () => {
        const manager = createManager();
        manager.markAntigravityModelNotFound(providerType, sourceModel);
        const attempts = jest.spyOn(manager, '_tryAntigravityElasticModel');

        const result = await manager.acquireSlotWithFallback(providerType, sourceModel, { queueKey: 'key-a' });

        expect(result).toMatchObject({ actualModel: firstFallback, isFallback: true });
        expect(attempts.mock.calls.map(([, model]) => model)).not.toContain(sourceModel);
    });

    test('shares the negative cache across workers', async () => {
        const coordination = createSharedCoordination();
        const writer = createManager(coordination);
        writer.markAntigravityModelNotFound(providerType, firstFallback);
        await Promise.resolve();

        const reader = createManager(coordination);
        expect(reader.isAntigravityModelNotFound(providerType, firstFallback)).toBe(false);

        await reader._hydrateAntigravityModelNotFound(providerType);

        expect(coordination.getModelNegativeCache).toHaveBeenCalledWith(
            expect.stringContaining(`antigravity-model-not-found:${providerType}:`)
        );
        expect(reader.isAntigravityModelNotFound(providerType, firstFallback)).toBe(true);
    });

    test('reads the shared cache at most once per sync interval', async () => {
        const coordination = createSharedCoordination();
        const manager = createManager(coordination);

        await manager._hydrateAntigravityModelNotFound(providerType);
        await manager._hydrateAntigravityModelNotFound(providerType);
        await manager._hydrateAntigravityModelNotFound(providerType);

        expect(coordination.getModelNegativeCache).toHaveBeenCalledTimes(1);
    });

    test('drops the negative cache when the provider configuration revision changes', () => {
        const manager = createManager();
        manager.markAntigravityModelNotFound(providerType, firstFallback);
        expect(manager.isAntigravityModelNotFound(providerType, firstFallback)).toBe(true);

        manager.providerConfigRevision += 1;

        expect(manager.isAntigravityModelNotFound(providerType, firstFallback)).toBe(false);
    });

    describe('probed model list write-back', () => {
        test('records the probed list so the chain can intersect with it', () => {
            const manager = createManager();
            expect(manager._getAntigravityVerifiedModels(providerType))
                .toEqual([sourceModel, firstFallback, secondFallback]);

            expect(manager.recordAntigravityAvailableModels(providerType, 'gemini-a', [sourceModel, firstFallback]))
                .toBe(true);

            expect(manager._getAntigravityVerifiedModels(providerType)).toEqual([sourceModel, firstFallback]);
            expect(manager.recordAntigravityAvailableModels(providerType, 'gemini-a', [sourceModel, firstFallback]))
                .toBe(false);
        });

        test('ignores empty lists, unknown credentials, and other provider types', () => {
            const manager = createManager();
            expect(manager.recordAntigravityAvailableModels(providerType, 'gemini-a', [])).toBe(false);
            expect(manager.recordAntigravityAvailableModels(providerType, 'missing', [sourceModel])).toBe(false);
            expect(manager.recordAntigravityAvailableModels('gemini-cli-oauth', 'gemini-a', [sourceModel])).toBe(false);
        });

        test('counts an unknown model list instead of degrading silently', () => {
            const manager = createManager();
            manager.providerStatus[providerType][0].config.supportedModels = [];

            expect(manager._getAntigravityVerifiedModels(providerType)).toEqual([]);
            expect(manager.getAntigravityRoutingMetrics().availableModelsUnknown).toBe(1);
        });

        test('drops fallbacks that the probed list does not contain', async () => {
            const manager = createManager();
            manager.recordAntigravityAvailableModels(providerType, 'gemini-a', [sourceModel, secondFallback]);
            const attempts = jest.spyOn(manager, '_tryAntigravityElasticModel');

            await manager.acquireSlotWithFallback(providerType, sourceModel, { queueKey: 'key-a' });

            expect(attempts.mock.calls.map(([, model]) => model)).not.toContain(firstFallback);
        });

        test('probes models through the adapter and writes them back to the pool', async () => {
            const manager = createManager();
            const fetchAvailableModels = jest.fn(async () => {});
            manager.serviceAdapterFactory = jest.fn(() => ({
                antigravityApiService: {
                    _ensureInitialized: jest.fn(async () => {}),
                    fetchAvailableModels
                }
            }));

            await expect(manager._probeAntigravityAvailableModels(providerType, manager.providerStatus[providerType][0]))
                .resolves.toBe(true);
            expect(fetchAvailableModels).toHaveBeenCalledTimes(1);
        });

        test('schedules antigravity probes even when warmupTarget is zero', async () => {
            const manager = createManager();
            manager.warmupTarget = 0;
            const probe = jest.spyOn(manager, '_probeAntigravityAvailableModels').mockResolvedValue(true);

            await manager.warmupNodes();

            expect(probe).toHaveBeenCalledTimes(1);
        });
    });

    test('exposes every routing counter through the multi-worker aggregate', async () => {
        const { aggregateWorkerMetrics } = await import('../src/runtime/multi-worker-runtime.js');
        const manager = createManager();
        const counters = Object.keys(manager.getAntigravityRoutingMetrics());
        const routing = Object.fromEntries(counters.map(field => [field, 1]));

        const aggregated = aggregateWorkerMetrics(new Map([['execution-1', { antigravityRouting: routing }]]));

        for (const field of counters) {
            expect(aggregated.antigravityRouting[field]).toBe(1);
        }
    });

    test('ignores non-Antigravity provider types', () => {
        const manager = createManager();
        expect(manager.markAntigravityModelNotFound('gemini-cli-oauth', firstFallback)).toBe(false);
        expect(manager._excludeAntigravityModelsNotFound('gemini-cli-oauth', [firstFallback])).toEqual([firstFallback]);
    });
});
