import { RuntimeEventBatcher } from '../src/runtime/runtime-event-batcher.js';

describe('runtime event batcher', () => {
    afterEach(() => jest.useRealTimers());

    test('flushes by max batch size and resolves each push', async () => {
        const flush = jest.fn().mockResolvedValue({ inserted: 2 });
        const batcher = new RuntimeEventBatcher({ flush, maxSize: 2, flushMs: 1000 });

        const first = batcher.push({ eventId: 'a' });
        const second = batcher.push({ eventId: 'b' });

        await expect(Promise.all([first, second])).resolves.toEqual([
            { inserted: 2 },
            { inserted: 2 }
        ]);
        expect(flush).toHaveBeenCalledTimes(1);
        expect(flush).toHaveBeenCalledWith([{ eventId: 'a' }, { eventId: 'b' }]);
        expect(batcher.snapshot()).toMatchObject({
            flushCount: 1,
            flushBySize: 1,
            flushByTimer: 0,
            eventsAppended: 2,
            averageBatchSize: 2,
            lastBatchSize: 2,
            lastCommitMs: expect.any(Number),
            failedBatches: 0
        });
    });

    test('keeps a failed batch pending and retries it without rejecting the event', async () => {
        jest.useFakeTimers();
        const failure = new Error('append failed');
        const flush = jest.fn()
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce({ inserted: 1 });
        const batcher = new RuntimeEventBatcher({ flush, maxSize: 100, flushMs: 1000, retryDelayMs: 100 });

        const pending = batcher.push({ eventId: 'timer-event' });
        await jest.advanceTimersByTimeAsync(1000);
        expect(batcher.size).toBe(1);

        await jest.advanceTimersByTimeAsync(100);
        await expect(pending).resolves.toEqual({ inserted: 1 });
        expect(batcher.size).toBe(0);
        expect(batcher.snapshot().failedBatches).toBe(1);
        expect(batcher.snapshot().retryCount).toBe(1);
    });

    test('flushes pending events on shutdown', async () => {
        const flush = jest.fn().mockResolvedValue({ inserted: 1 });
        const batcher = new RuntimeEventBatcher({ flush, maxSize: 100, flushMs: 1000 });
        const pending = batcher.push({ eventId: 'shutdown-event' });

        await expect(batcher.close()).resolves.toEqual({ inserted: 1 });
        await expect(pending).resolves.toEqual({ inserted: 1 });
        expect(flush).toHaveBeenCalledWith([{ eventId: 'shutdown-event' }]);
    });

    test('accepts another batch while a flush is in flight and drains it afterwards', async () => {
        let releaseFirst;
        const firstFlush = new Promise(resolve => { releaseFirst = resolve; });
        const flush = jest.fn()
            .mockReturnValueOnce(firstFlush)
            .mockResolvedValueOnce({ inserted: 2 });
        const batcher = new RuntimeEventBatcher({ flush, maxSize: 2, maxPending: 4, flushMs: 1000 });

        const first = batcher.pushBatch([{ eventId: 'a' }, { eventId: 'b' }]);
        await Promise.resolve();
        const second = batcher.pushBatch(
            [{ eventId: 'c' }, { eventId: 'd' }],
            { awaitFlush: false }
        );

        expect(second).toMatchObject({ accepted: 2 });
        expect(flush).toHaveBeenCalledTimes(1);
        releaseFirst({ inserted: 2 });
        await expect(first).resolves.toEqual({ inserted: 2 });
        await expect(second.completion).resolves.toEqual({ inserted: 2 });
        expect(flush).toHaveBeenCalledTimes(2);
        expect(batcher.snapshot()).toMatchObject({
            flushCount: 2,
            eventsAppended: 4,
            pending: 0,
            inFlight: 0
        });
    });

    test('enforces a bounded queue and wakes capacity waiters after a flush', async () => {
        let release;
        const flushPromise = new Promise(resolve => { release = resolve; });
        const flush = jest.fn().mockReturnValueOnce(flushPromise).mockResolvedValue({ inserted: 1 });
        const batcher = new RuntimeEventBatcher({ flush, maxSize: 1, maxPending: 1, flushMs: 1000 });

        const first = batcher.push({ eventId: 'bounded-a' });
        await Promise.resolve();
        await expect(batcher.push({ eventId: 'bounded-b' })).rejects.toMatchObject({
            code: 'RUNTIME_EVENT_QUEUE_FULL'
        });
        const capacity = batcher.waitForCapacity();
        release({ inserted: 1 });
        await expect(first).resolves.toEqual({ inserted: 1 });
        await expect(capacity).resolves.toBe(true);
        expect(batcher.availableCapacity()).toBe(1);
        expect(batcher.snapshot().rejectedEvents).toBe(1);
    });
});
