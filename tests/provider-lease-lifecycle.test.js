import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import requestContext from '../src/utils/context.js';
import { getProviderLeaseScope, closeProviderLeaseScope, rollbackProviderLeases } from '../src/runtime/provider-lease-scope.js';

jest.mock('../src/providers/adapter.js', () => ({ getServiceAdapter: jest.fn(), getRegisteredProviders: () => ['test'], invalidateServiceAdapter: jest.fn() }));
jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));

function fixture() {
    let sequence = 0;
    const active = new Set();
    const coordination = {
        workerId: 'offline-worker',
        acquire: jest.fn(async candidates => {
            if (!candidates.length) return null;
            const leaseId = `lease-${++sequence}`;
            active.add(leaseId);
            return { leaseId, providerType: candidates[0].providerType, uuid: candidates[0].uuid };
        }),
        release: jest.fn(async id => { active.delete(id); return true; })
    };
    const manager = new ProviderPoolManager({ test: [
        { uuid: 'one', isHealthy: true, concurrencyLimit: 5 },
        { uuid: 'two', isHealthy: true, concurrencyLimit: 5 }
    ] }, { coordination, persistenceEnabled: false });
    return { active, coordination, manager };
}

describe('request-owned provider leases', () => {
    test('retains repeated acquisitions and releases the current attempt before the outer attempt', async () => {
        const { active, manager, coordination } = fixture();
        await requestContext.run({}, async () => {
            await manager.acquireSlot('test', 'model', { allowedProviderUuids: ['one'] });
            await manager.acquireSlot('test', 'model', { allowedProviderUuids: ['one'] });
            expect(getProviderLeaseScope().leases.size).toBe(2);
            await manager.releaseSlot('test', 'one');
            expect([...active]).toEqual(['lease-1']);
            await manager.releaseSlot('test', 'one');
            expect(active.size).toBe(0);
        });
        expect(coordination.release.mock.calls).toEqual([['lease-2'], ['lease-1']]);
    });

    test('selection rollback preserves outer and unrelated request leases', async () => {
        const { active, manager } = fixture();
        const first = {}, other = {};
        await requestContext.run(other, () => manager.acquireSlot('test', 'model', { allowedProviderUuids: ['two'] }));
        await requestContext.run(first, async () => {
            await manager.acquireSlot('test', 'model', { allowedProviderUuids: ['one'] });
            const checkpoint = new Set(getProviderLeaseScope().leases.keys());
            await manager.acquireSlot('test', 'model', { allowedProviderUuids: ['one'] });
            await rollbackProviderLeases(checkpoint);
            expect([...active]).toEqual(['lease-1', 'lease-2']);
        });
        await closeProviderLeaseScope(first, 'preparation_error');
        expect([...active]).toEqual(['lease-1']);
        await closeProviderLeaseScope(other);
        expect(active.size).toBe(0);
    });

    test.each(['response_finish', 'response_close', 'handler_return'])('cleans all remaining accounts on %s outside AsyncLocalStorage', async reason => {
        const { active, manager, coordination } = fixture();
        const store = {};
        await requestContext.run(store, async () => {
            await manager.acquireSlot('test', 'model', { allowedProviderUuids: ['one'] });
            await manager.acquireSlot('test', 'model', { allowedProviderUuids: ['two'] });
        });
        await Promise.all([closeProviderLeaseScope(store, reason), closeProviderLeaseScope(store, 'duplicate')]);
        expect(active.size).toBe(0);
        expect(coordination.release).toHaveBeenCalledTimes(2);
        expect(getProviderLeaseScope(store).pending.size).toBe(0);
    });

    test('releases an acquisition that returns after the connection closes', async () => {
        const { active, manager, coordination } = fixture();
        const original = coordination.acquire;
        let finishAcquire;
        let signalAcquire;
        const acquiring = new Promise(resolve => { signalAcquire = resolve; });
        coordination.acquire = async candidates => {
            signalAcquire();
            await new Promise(resolve => { finishAcquire = resolve; });
            return original(candidates);
        };
        const store = {};
        const pending = requestContext.run(store, () => manager.acquireSlot('test', 'model'));
        await acquiring;
        await closeProviderLeaseScope(store, 'response_close');
        finishAcquire();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(active.size).toBe(0);
        expect(getProviderLeaseScope(store).leases.size).toBe(0);
    });
});
