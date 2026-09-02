import { jest } from '@jest/globals';
import { EdgeAdmissionCoordinator, EDGE_ADMISSION_NAMESPACE } from '../src/edge-auth/edge-admission.js';

describe('Edge Admission coordinator contract', () => {
    test('acquires, renews and releases a lease with namespaced keys', async () => {
        const coordinator = new EdgeAdmissionCoordinator({ redis: {}, leaseTtlMs: 120000 });
        coordinator._eval = jest.fn()
            .mockResolvedValueOnce(JSON.stringify({ acquired: true, leaseId: 'lease-a' }))
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(1);
        const lease = await coordinator.acquire('abc123', {
            edgeAdmissionConcurrencyLimit: 2,
            edgeAdmissionQueueLimit: 3,
            edgeAdmissionQueueTimeoutMs: 1000
        }, 'request-a');
        expect(lease).toMatchObject({ acquired: true, leaseId: expect.any(String), keyHash: 'abc123' });
        await expect(lease.renew()).resolves.toBe(true);
        await expect(lease.release()).resolves.toBe(true);
        expect(coordinator._eval.mock.calls[0][0]).toBe('edge-admission-acquire-v1');
        expect(coordinator._eval.mock.calls[1][0]).toBe('edge-admission-renew-v1');
        expect(coordinator._eval.mock.calls[2][0]).toBe('edge-admission-release-v1');
    });

    test('queued request is promoted FIFO and times out with a stable error code', async () => {
        const coordinator = new EdgeAdmissionCoordinator({ redis: {}, leaseTtlMs: 120000, pollMs: 1 });
        coordinator._eval = jest.fn()
            .mockResolvedValueOnce(JSON.stringify({ acquired: false, queued: true, leaseId: 'lease-q' }))
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce('active');
        const lease = await coordinator.acquire('key-q', {
            edgeAdmissionConcurrencyLimit: 1,
            edgeAdmissionQueueLimit: 1,
            edgeAdmissionQueueTimeoutMs: 100
        }, 'request-q');
        expect(lease).toMatchObject({ acquired: true, queued: true, leaseId: expect.any(String) });
        expect(coordinator._eval.mock.calls.map(call => call[0])).toEqual([
            'edge-admission-acquire-v1', 'edge-admission-promote-v1', 'edge-admission-status-v1'
        ]);
    });

    test('exposes the documented namespace and rejects a full queue', async () => {
        expect(EDGE_ADMISSION_NAMESPACE).toBe('aiclient2api:edge-admission:v1');
        const coordinator = new EdgeAdmissionCoordinator({ redis: {} });
        coordinator._eval = jest.fn().mockResolvedValue(JSON.stringify({ acquired: false, queued: false, reason: 'queue_full' }));
        await expect(coordinator.acquire('key-full', { edgeAdmissionConcurrencyLimit: 1, edgeAdmissionQueueLimit: 0 }))
            .rejects.toMatchObject({ code: 'EDGE_ADMISSION_CAPACITY_EXHAUSTED', status: 429 });
    });

    test('cancels a waiting reservation immediately when the client aborts', async () => {
        const coordinator = new EdgeAdmissionCoordinator({ redis: {}, pollMs: 20 });
        const controller = new AbortController();
        coordinator._eval = jest.fn()
            .mockResolvedValueOnce(JSON.stringify({ acquired: false, queued: true, leaseId: 'lease-cancel' }))
            .mockResolvedValueOnce(1);
        const pending = coordinator.acquire('key-cancel', {
            edgeAdmissionConcurrencyLimit: 1,
            edgeAdmissionQueueLimit: 1,
            edgeAdmissionQueueTimeoutMs: 1000
        }, 'request-cancel', { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: 'EDGE_ADMISSION_CANCELLED', status: 499 });
        expect(coordinator._eval.mock.calls.map(call => call[0])).toContain('edge-admission-cancel-v1');
    });

    test('uses one shared promotion poller per key', () => {
        const coordinator = new EdgeAdmissionCoordinator({ redis: { command: jest.fn().mockResolvedValue(0) }, pollMs: 1000 });
        coordinator._startPoller('key-one', 2);
        coordinator._startPoller('key-one', 2);
        expect(coordinator.pollers.size).toBe(1);
        for (const entry of coordinator.pollers.values()) clearInterval(entry.timer);
    });
});
