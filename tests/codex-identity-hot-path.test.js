import { afterEach, jest } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    invalidateServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => [])
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));

const TYPE = 'openai-codex-oauth';
const UUID = 'test-provider-uuid';

function createManager(config = {}, options = {}) {
    return new ProviderPoolManager({
        [TYPE]: [{
            uuid: UUID,
            customName: 'Codex test',
            isHealthy: true,
            ...config
        }]
    }, {
        persistenceEnabled: true,
        saveDebounceTime: 60_000,
        ...options
    });
}

describe('Codex identity request hot path', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });
    test('1,000 matching observations do not schedule persistence or revisions', async () => {
        const manager = createManager({
            codexAccountKey: 'account-key',
            codexAccountId: 'account-id',
            codexEmail: 'masked@example.invalid'
        });
        const saveSpy = jest.spyOn(manager, '_debouncedSave');
        const revision = manager.providerConfigRevision;

        for (let i = 0; i < 1000; i++) {
            await manager.reconcileProviderIdentity(TYPE, UUID, {
                codexAccountKey: 'account-key',
                codexAccountId: 'account-id',
                codexEmail: 'masked@example.invalid'
            });
        }

        expect(saveSpy).not.toHaveBeenCalled();
        expect(manager.providerConfigRevision).toBe(revision);
    });

    test('concurrent first discovery applies one complete identity update', async () => {
        const configEvents = [];
        const manager = createManager({}, { configEventSink: event => configEvents.push(event) });
        const saveSpy = jest.spyOn(manager, '_debouncedSave');
        const identity = {
            codexAccountKey: 'new-account-key',
            codexAccountId: 'new-account-id',
            codexEmail: 'new@example.invalid'
        };

        const results = await Promise.all(Array.from({ length: 12 }, () =>
            manager.reconcileProviderIdentity(TYPE, UUID, identity)
        ));

        expect(results.filter(result => result.status === 'updated')).toHaveLength(1);
        expect(results.filter(result => result.status === 'unchanged')).toHaveLength(11);
        expect(saveSpy).toHaveBeenCalledTimes(1);
        expect(configEvents).toHaveLength(1);
        expect(manager.getProviderIdentity(TYPE, UUID)).toEqual(identity);
    });

    test('conflicting request observation never partially overwrites identity', async () => {
        const manager = createManager({
            codexAccountKey: 'stable-key',
            codexAccountId: 'stable-id',
            codexEmail: 'stable@example.invalid'
        });

        const result = await manager.reconcileProviderIdentity(TYPE, UUID, {
            codexAccountKey: 'other-key',
            codexAccountId: 'other-id',
            codexEmail: 'other@example.invalid'
        });

        expect(result.status).toBe('conflict');
        expect(manager.getProviderIdentity(TYPE, UUID)).toEqual({
            codexAccountKey: 'stable-key',
            codexAccountId: 'stable-id',
            codexEmail: 'stable@example.invalid'
        });
    });
});
