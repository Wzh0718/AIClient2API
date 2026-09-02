import { RuntimeHookPoller } from '../src/runtime/runtime-hook-poller.js';

function eventually(assertion, { timeoutMs = 1000, pollMs = 5 } = {}) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const check = () => {
            try {
                assertion();
                resolve();
            } catch (error) {
                if (Date.now() >= deadline) reject(error);
                else setTimeout(check, pollMs);
            }
        };
        check();
    });
}

describe('runtime hook poller', () => {
    test('continues reading while the durable flush is still pending', async () => {
        let releaseFlush;
        const flush = new Promise(resolve => { releaseFlush = resolve; });
        const stream = {
            readBatch: jest.fn()
                .mockResolvedValueOnce([{ eventId: 'evt-1' }])
                .mockImplementation(async () => {
                    await new Promise(resolve => setTimeout(resolve, 5));
                    return [];
                }),
            pendingSnapshot: jest.fn().mockResolvedValue({ pending: 1, consumerLag: 1 })
        };
        const ingress = {
            availableCapacity: jest.fn(() => 10),
            pushBatch: jest.fn(() => ({ accepted: 1, completion: flush })),
            waitForCapacity: jest.fn().mockResolvedValue(true),
            close: jest.fn().mockResolvedValue(undefined),
            snapshot: jest.fn(() => ({ pending: 1 }))
        };
        const poller = new RuntimeHookPoller({
            stream,
            ingress,
            readBatchSize: 100,
            blockMs: 1,
            statusPollMs: 10000,
            claimIntervalMs: 10000
        });

        poller.start();
        await eventually(() => expect(stream.readBatch.mock.calls.length).toBeGreaterThan(1));
        expect(stream.readBatch.mock.calls.length).toBeGreaterThan(1);
        expect(ingress.pushBatch).toHaveBeenCalledWith(
            [{ eventId: 'evt-1' }],
            { awaitFlush: false }
        );
        releaseFlush({ inserted: 1 });
        await poller.stop({ drain: false });
    });

    test('pauses reads when ingress capacity is exhausted', async () => {
        let available = 0;
        const stream = {
            readBatch: jest.fn().mockResolvedValue([]),
            pendingSnapshot: jest.fn().mockResolvedValue({ pending: 0 })
        };
        let releaseCapacity;
        const capacityPromise = new Promise(resolve => { releaseCapacity = resolve; });
        const ingress = {
            availableCapacity: jest.fn(() => available),
            waitForCapacity: jest.fn(() => capacityPromise),
            pushBatch: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
            snapshot: jest.fn(() => ({ pending: 0 }))
        };
        const poller = new RuntimeHookPoller({ stream, ingress, blockMs: 1 });
        poller.start();
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(stream.readBatch).not.toHaveBeenCalled();
        available = 1;
        releaseCapacity(true);
        await eventually(() => expect(stream.readBatch).toHaveBeenCalled());
        await poller.stop({ drain: false });
    });

    test('samples stream status on a timer instead of every read', async () => {
        const stream = {
            readBatch: jest.fn(async () => {
                await new Promise(resolve => setTimeout(resolve, 2));
                return [];
            }),
            pendingSnapshot: jest.fn().mockResolvedValue({ pending: 0 })
        };
        const ingress = {
            availableCapacity: jest.fn(() => 10),
            waitForCapacity: jest.fn().mockResolvedValue(true),
            pushBatch: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined),
            snapshot: jest.fn(() => ({ pending: 0 }))
        };
        const poller = new RuntimeHookPoller({ stream, ingress, blockMs: 1, statusPollMs: 20 });
        poller.start();
        await new Promise(resolve => setTimeout(resolve, 55));
        const readsBeforeStop = stream.readBatch.mock.calls.length;
        const statusBeforeStop = stream.pendingSnapshot.mock.calls.length;
        await poller.stop({ drain: false });

        expect(readsBeforeStop).toBeGreaterThan(1);
        expect(statusBeforeStop).toBeLessThan(readsBeforeStop);
    });
});
