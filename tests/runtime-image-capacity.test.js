import { jest } from '@jest/globals';
import {
    RuntimeImageCapacity,
    estimateImageResponseBytes
} from '../src/runtime/runtime-image-capacity.js';

describe('RuntimeImageCapacity', () => {
    test('estimates peak memory rather than only encoded output bytes', () => {
        expect(estimateImageResponseBytes({ n: 1 })).toBe(32 * 1024 * 1024);
        expect(estimateImageResponseBytes({ n: 2, inputBytes: 10 * 1024 * 1024 }))
            .toBe((64 + 30) * 1024 * 1024);
    });

    test('uses a Redis weighted lease in multi-worker mode', async () => {
        const coordination = {
            acquireImageCapacity: jest.fn().mockResolvedValue({ leaseId: 'global-1', bytes: 40, usedBytes: 40 }),
            releaseImageCapacity: jest.fn().mockResolvedValue(true)
        };
        const capacity = new RuntimeImageCapacity({
            budgetBytes: 100,
            executionWorkers: 3,
            multiWorker: true,
            waitMs: 5,
            metrics: {}
        });

        const ticket = await capacity.acquire({ bytes: 40, coordination, requestId: 'request-1' });
        expect(coordination.acquireImageCapacity).toHaveBeenCalledWith(expect.objectContaining({
            bytes: 40,
            budgetBytes: 100,
            requestId: 'request-1'
        }));
        await capacity.release(ticket);
        expect(coordination.releaseImageCapacity).toHaveBeenCalledWith('global-1');
    });

    test('falls back to one worker share when Redis is unavailable', async () => {
        const coordination = {
            acquireImageCapacity: jest.fn().mockRejectedValue(new Error('redis unavailable'))
        };
        const capacity = new RuntimeImageCapacity({
            budgetBytes: 99,
            executionWorkers: 3,
            multiWorker: true,
            waitMs: 5,
            metrics: {}
        });

        const ticket = await capacity.acquire({ bytes: 33, coordination });
        expect(ticket.coordinationMode).toBe('local-fallback');
        expect(capacity.snapshot()).toMatchObject({ localBudgetBytes: 33, redisDegraded: true });
        await capacity.release(ticket);
    });

    test('records overcommit after a paid result without rejecting it', async () => {
        const coordination = {
            acquireImageCapacity: jest.fn().mockResolvedValue({ leaseId: 'global-1', bytes: 40 }),
            resizeImageCapacity: jest.fn().mockResolvedValue({ resized: true, overcommitted: true }),
            releaseImageCapacity: jest.fn().mockResolvedValue(true)
        };
        const capacity = new RuntimeImageCapacity({ budgetBytes: 100, multiWorker: true, waitMs: 5, metrics: {} });
        const ticket = await capacity.acquire({ bytes: 40, coordination });

        await expect(capacity.resize(ticket, 120)).resolves.toMatchObject({ overcommitted: true });
        expect(capacity.snapshot().overcommitted).toBe(1);
        await capacity.release(ticket);
    });
});
