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

    test('flushes by timer and keeps failures retryable', async () => {
        jest.useFakeTimers();
        const failure = new Error('append failed');
        const flush = jest.fn()
            .mockRejectedValueOnce(failure)
            .mockResolvedValueOnce({ inserted: 1 });
        const batcher = new RuntimeEventBatcher({ flush, maxSize: 100, flushMs: 1000 });

        const pending = batcher.push({ eventId: 'timer-event' });
        const failureAssertion = expect(pending).rejects.toThrow('append failed');
        await jest.advanceTimersByTimeAsync(1000);
        await failureAssertion;
        expect(batcher.size).toBe(1);

        const retry = batcher.flushNow();
        await expect(retry).resolves.toEqual({ inserted: 1 });
        expect(batcher.size).toBe(0);
        expect(batcher.snapshot().failedBatches).toBe(1);
    });

    test('flushes pending events on shutdown', async () => {
        const flush = jest.fn().mockResolvedValue({ inserted: 1 });
        const batcher = new RuntimeEventBatcher({ flush, maxSize: 100, flushMs: 1000 });
        const pending = batcher.push({ eventId: 'shutdown-event' });

        await expect(batcher.close()).resolves.toEqual({ inserted: 1 });
        await expect(pending).resolves.toEqual({ inserted: 1 });
        expect(flush).toHaveBeenCalledWith([{ eventId: 'shutdown-event' }]);
    });
});
