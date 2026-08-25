import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import requestContext from '../src/utils/context.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['test']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

describe('provider pool Redis coordination', () => {
    test('execution worker state events capture the state at debounce time, not flush time', async () => {
        jest.useFakeTimers();
        const events = [];
        const manager = new ProviderPoolManager({
            test: [{ uuid: 'one', lastRefreshAttemptTime: Date.now() }]
        }, {
            persistenceEnabled: false,
            stateEventSink: event => events.push(event),
            saveDebounceTime: 1000
        });
        const config = manager.providerStatus.test[0].config;
        config.needsRefresh = true;

        manager._debouncedSave('test');
        config.needsRefresh = false;
        await jest.advanceTimersByTimeAsync(1000);

        expect(events).toHaveLength(1);
        expect(events[0].state.needsRefresh).toBe(true);
        jest.useRealTimers();
    });

    test('publishes Antigravity schedulable and cooling gauges without periodic-quota gating', async () => {
        const coordinator = {
            updateGeminiSchedulingGauge: jest.fn(),
            acquire: jest.fn(async candidates => ({
                leaseId: 'gemini-lease',
                providerType: candidates[0].providerType,
                uuid: candidates[0].uuid
            })),
            release: jest.fn(async () => true)
        };
        const manager = new ProviderPoolManager({
            'gemini-antigravity': [{
                uuid: 'gemini-unknown-quota',
                isHealthy: true,
                concurrencyLimit: 1,
                lastKnownAntigravityPlan: 'pro',
                supportedModels: ['gemini-2.5-flash']
            }]
        }, { coordination: coordinator, persistenceEnabled: false });

        await requestContext.run({}, async () => {
            const selected = await manager.acquireSlot('gemini-antigravity', 'gemini-2.5-flash');
            expect(selected.uuid).toBe('gemini-unknown-quota');
            await manager.releaseSlot('gemini-antigravity', selected.uuid);
        });

        expect(coordinator.updateGeminiSchedulingGauge).toHaveBeenCalledWith('gemini-2.5-flash', {
            schedulable: 1,
            cooling: 0,
            quotaUnknown: 0
        });
    });

    test('acquires from eligible local candidates and releases the request-bound lease', async () => {
        const coordinator = {
            acquire: jest.fn(async candidates => ({
                leaseId: 'lease-1',
                providerType: candidates[0].providerType,
                uuid: candidates[0].uuid
            })),
            release: jest.fn(async () => true)
        };
        const manager = new ProviderPoolManager({
            test: [
                { uuid: 'disabled', isDisabled: true },
                { uuid: 'healthy', isHealthy: true, concurrencyLimit: 0 }
            ]
        }, { coordination: coordinator, persistenceEnabled: false });

        await requestContext.run({}, async () => {
            const selected = await manager.acquireSlot('test', 'model');
            expect(selected.uuid).toBe('healthy');
            expect(coordinator.acquire).toHaveBeenCalledWith([
                expect.objectContaining({ providerType: 'test', uuid: 'healthy', concurrencyLimit: 0 })
            ], { requestedModel: 'model' });
            await manager.releaseSlot('test', 'healthy');
        });

        expect(coordinator.release).toHaveBeenCalledWith('lease-1');
    });

    test('execution workers do not persist provider files', () => {
        const manager = new ProviderPoolManager({ test: [{ uuid: 'one' }] }, { persistenceEnabled: false });
        manager._debouncedSave('test');
        expect(manager.pendingSaves.size).toBe(0);
        expect(manager.saveTimer).toBeNull();
    });

    test('marks only the first locally selected sticky candidate as preferred for Redis', async () => {
        const coordinator = {
            acquire: jest.fn(async candidates => ({
                leaseId: 'sticky-lease',
                providerType: candidates[0].providerType,
                uuid: candidates[0].uuid
            })),
            release: jest.fn(async () => true)
        };
        const manager = new ProviderPoolManager({
            'openai-codex-oauth': [
                { uuid: 'codex-a', isHealthy: true, concurrencyLimit: 2, lastKnownCodexPlan: 'pro' },
                { uuid: 'codex-b', isHealthy: true, concurrencyLimit: 2, lastKnownCodexPlan: 'pro' }
            ]
        }, { coordination: coordinator, persistenceEnabled: false });

        await requestContext.run({}, async () => {
            await manager.acquireSlot('openai-codex-oauth', 'gpt-5.4', {
                stickyProviderKey: 'prompt-cache:test'
            });
        });

        const [candidates, coordinationOptions] = coordinator.acquire.mock.calls[0];
        expect(candidates).toHaveLength(2);
        expect(candidates.filter(candidate => candidate.preferred)).toHaveLength(1);
        expect(candidates[0].preferred).toBe(true);
        expect(candidates[1].preferred).toBe(false);
        expect(coordinationOptions.affinityKey).toContain('prompt-cache:test');
    });

    test('routes a globally hot Codex affinity request to the selected shard without replacing its base affinity', async () => {
        const coordinator = {
            recordHotRequest: jest.fn(async () => ({ count: 3 })),
            acquire: jest.fn(async candidates => ({
                leaseId: 'hot-lease',
                providerType: candidates[0].providerType,
                uuid: candidates[0].uuid
            })),
            release: jest.fn(async () => true)
        };
        const manager = new ProviderPoolManager({
            'openai-codex-oauth': [
                { uuid: 'codex-hot', isHealthy: true, usageCount: 500, concurrencyLimit: 2, lastKnownCodexPlan: 'pro' },
                { uuid: 'codex-cold-a', isHealthy: true, usageCount: 1, concurrencyLimit: 2, lastKnownCodexPlan: 'pro' },
                { uuid: 'codex-cold-b', isHealthy: true, usageCount: 2, concurrencyLimit: 2, lastKnownCodexPlan: 'pro' }
            ]
        }, {
            coordination: coordinator,
            persistenceEnabled: false,
            globalConfig: {
                CODEX_STICKY_HOT_SHARD_ENABLED: true,
                CODEX_STICKY_HOT_SHARD_MIN_REQUESTS: 3,
                CODEX_STICKY_HOT_SHARD_WINDOW_MS: 60000,
                CODEX_STICKY_HOT_SHARD_MAX_SHARDS: 3
            }
        });

        await requestContext.run({ requestId: 'request-hot-1' }, async () => {
            await manager.acquireSlot('openai-codex-oauth', 'gpt-5.4', {
                stickyProviderKey: 'session:hot',
                shardDiscriminator: 'turn-1'
            });
        });

        expect(coordinator.recordHotRequest).toHaveBeenCalledWith(
            expect.stringContaining('session:hot'),
            expect.objectContaining({ observationId: 'request-hot-1', windowMs: 60000 })
        );
        const [, coordinationOptions] = coordinator.acquire.mock.calls[0];
        expect(coordinationOptions.affinityKey).toContain('session:hot');
        expect(coordinationOptions.routedProviderKey).toMatch(/^openai-codex-oauth:codex-cold-/);
    });

    test('mixed pools acquire one global lease without using local active counters', async () => {
        const coordinator = {
            acquire: jest.fn(async candidates => ({
                leaseId: 'mixed-lease',
                providerType: candidates[0].providerType,
                uuid: candidates[0].uuid
            })),
            release: jest.fn(async () => true)
        };
        const manager = new ProviderPoolManager({
            first: [{ uuid: 'first-1', supportedModels: ['model'] }],
            second: [{ uuid: 'second-1', supportedModels: ['model'] }]
        }, {
            coordination: coordinator,
            persistenceEnabled: false,
            globalConfig: {
                mixedProviderPools: {
                    mixed: {
                        enabled: true,
                        entryProviders: ['first'],
                        candidateProviders: ['first', 'second'],
                        matchModels: ['model']
                    }
                }
            }
        });

        await requestContext.run({}, async () => {
            const result = await manager.acquireSlotWithFallback('first', 'model');
            expect(result.config.uuid).toBeTruthy();
            await manager.releaseSlot(result.actualProviderType, result.config.uuid);
        });

        expect(coordinator.acquire).toHaveBeenCalledTimes(1);
        expect(coordinator.acquire.mock.calls[0][0]).toHaveLength(2);
        expect(manager.providerStatus.first[0].state.activeCount).toBe(0);
        expect(manager.providerStatus.second[0].state.activeCount).toBe(0);
    });

    test('preserves the sticky preferred candidate when a mixed pool acquires a Redis lease', async () => {
        const coordinator = {
            acquire: jest.fn(async candidates => ({
                leaseId: 'mixed-sticky-lease',
                providerType: candidates[0].providerType,
                uuid: candidates[0].uuid
            })),
            release: jest.fn(async () => true)
        };
        const manager = new ProviderPoolManager({
            first: [{ uuid: 'first-1', supportedModels: ['model'] }],
            second: [{ uuid: 'second-1', supportedModels: ['model'] }]
        }, {
            coordination: coordinator,
            persistenceEnabled: false,
            globalConfig: {
                mixedProviderPools: {
                    mixed: {
                        enabled: true,
                        entryProviders: ['first'],
                        candidateProviders: ['first', 'second'],
                        matchModels: ['model']
                    }
                }
            }
        });

        await requestContext.run({}, async () => {
            await manager.acquireSlotFromMixedPool('first', 'model', {
                stickyProviderKey: 'session:test'
            });
        });

        const [candidates, coordinationOptions] = coordinator.acquire.mock.calls[0];
        expect(candidates.filter(candidate => candidate.preferred)).toHaveLength(1);
        expect(candidates[0].preferred).toBe(true);
        expect(coordinationOptions.affinityKey).toContain('session:test');
    });
});
