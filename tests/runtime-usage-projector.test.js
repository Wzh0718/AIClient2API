import { RuntimeUsageProjector } from '../src/runtime/runtime-usage-projector.js';

test('advances successful projections while retrying only the failed projection', async () => {
    const pending = [
        { eventId: 'evt-1', projectionName: 'api-potluck', hookName: 'onContentGenerated', args: [{}] },
        { eventId: 'evt-1', projectionName: 'model-usage-stats', hookName: 'onContentGenerated', args: [{}] },
        { eventId: 'evt-1', projectionName: 'request-audit', hookName: 'onContentGenerated', args: [{}] }
    ];
    const completed = [];
    const failed = [];
    const store = {
        listPendingProjections: jest.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce([]),
        completeProjection: jest.fn(item => completed.push(item.projectionName)),
        failProjection: jest.fn(item => failed.push(item.projectionName))
    };
    const executeProjection = jest.fn(async (projectionName) => {
        if (projectionName === 'model-usage-stats') throw new Error('model projection unavailable');
    });
    const projector = new RuntimeUsageProjector({ store, executeProjection, retryDelayMs: 0 });

    await projector.drainOnce();

    expect(completed.sort()).toEqual(['api-potluck', 'request-audit']);
    expect(failed).toEqual(['model-usage-stats']);
    expect(store.failProjection).toHaveBeenCalledWith(expect.objectContaining({
        eventId: 'evt-1',
        projectionName: 'model-usage-stats',
        error: 'model projection unavailable'
    }));
});

test('bounds each scheduled drain and leaves delayed failures for a later retry', async () => {
    const item = { eventId: 'evt-loop', projectionName: 'api-potluck', hookName: 'onContentGenerated', args: [{}] };
    const store = {
        listPendingProjections: jest.fn().mockResolvedValue([item]),
        completeProjection: jest.fn(),
        failProjection: jest.fn()
    };
    const projector = new RuntimeUsageProjector({
        store,
        executeProjection: jest.fn().mockRejectedValue(new Error('permanent failure')),
        retryDelayMs: 1000,
        maxBatchesPerRun: 3
    });

    await projector.schedule();

    expect(store.listPendingProjections).toHaveBeenCalledTimes(3);
    expect(store.failProjection).toHaveBeenCalledTimes(3);
});

test('shutdown drain stops at its timeout instead of waiting forever', async () => {
    const store = {
        listPendingProjections: jest.fn(async () => new Promise(() => {})),
        completeProjection: jest.fn(),
        failProjection: jest.fn()
    };
    const projector = new RuntimeUsageProjector({ store, executeProjection: jest.fn(), drainTimeoutMs: 25 });

    await expect(projector.drain({ timeoutMs: 25 })).rejects.toThrow('timed out');
});
