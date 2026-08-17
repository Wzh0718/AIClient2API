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
        completeProjections: jest.fn(items => completed.push(...items.map(item => item.projectionName))),
        failProjections: jest.fn(items => failed.push(...items.map(item => item.projectionName)))
    };
    const executeProjection = jest.fn(async (projectionName) => {
        if (projectionName === 'model-usage-stats') throw new Error('model projection unavailable');
    });
    const projector = new RuntimeUsageProjector({ store, executeProjection, retryDelayMs: 0 });

    await projector.drainOnce();

    expect(completed.sort()).toEqual(['api-potluck', 'request-audit']);
    expect(failed).toEqual(['model-usage-stats']);
    expect(store.failProjections).toHaveBeenCalledWith([
        expect.objectContaining({
            eventId: 'evt-1',
            projectionName: 'model-usage-stats',
            error: 'model projection unavailable'
        })
    ]);
});

test('stops the current scheduled drain after a failed projection', async () => {
    const item = { eventId: 'evt-loop', projectionName: 'api-potluck', hookName: 'onContentGenerated', args: [{}] };
    const store = {
        listPendingProjections: jest.fn().mockResolvedValue([item]),
        completeProjections: jest.fn(),
        failProjections: jest.fn()
    };
    const projector = new RuntimeUsageProjector({
        store,
        executeProjection: jest.fn().mockRejectedValue(new Error('permanent failure')),
        retryDelayMs: 1000,
        maxBatchesPerRun: 3
    });

    await projector.schedule();

    expect(store.listPendingProjections).toHaveBeenCalledTimes(1);
    expect(store.failProjections).toHaveBeenCalledTimes(1);
});

test('keeps draining successful full batches after yielding between segments', async () => {
    const pending = Array.from({ length: 25 }, (_, index) => ({
        eventId: `evt-${index}`,
        projectionName: 'api-potluck',
        hookName: 'onContentGenerated',
        args: [{}]
    }));
    const store = {
        listPendingProjections: jest.fn(async ({ limit }) => pending.slice(0, limit)),
        completeProjections: jest.fn(async items => {
            for (const item of items) {
                const index = pending.findIndex(candidate => candidate.eventId === item.eventId);
                if (index >= 0) pending.splice(index, 1);
            }
        }),
        failProjections: jest.fn()
    };
    const projector = new RuntimeUsageProjector({
        store,
        executeProjection: jest.fn(),
        batchSize: 5,
        maxBatchesPerRun: 2
    });

    await projector.schedule();

    expect(pending).toHaveLength(0);
    expect(store.completeProjections).toHaveBeenCalledTimes(5);
    expect(store.completeProjections.mock.calls.flatMap(([items]) => items)).toHaveLength(25);
    expect(store.listPendingProjections).toHaveBeenLastCalledWith({ limit: 5 });
});

test('groups a ledger batch by projection before committing checkpoints', async () => {
    const pending = [
        { eventId: 'evt-1', projectionName: 'api-potluck', hookName: 'onContentGenerated', args: [{}] },
        { eventId: 'evt-1', projectionName: 'model-usage-stats', hookName: 'onContentGenerated', args: [{}] },
        { eventId: 'evt-2', projectionName: 'api-potluck', hookName: 'onContentGenerated', args: [{}] },
        { eventId: 'evt-2', projectionName: 'request-audit', hookName: 'onContentGenerated', args: [{}] }
    ];
    const store = {
        listPendingProjections: jest.fn().mockResolvedValue(pending),
        completeProjections: jest.fn(),
        failProjections: jest.fn()
    };
    const executeProjectionBatch = jest.fn(async (_projectionName, items) => ({
        completed: items,
        failed: []
    }));
    const projector = new RuntimeUsageProjector({
        store,
        executeProjection: jest.fn(),
        executeProjectionBatch
    });

    const result = await projector.drainOnce();

    expect(result).toEqual({ count: 4, failures: 0 });
    expect(executeProjectionBatch).toHaveBeenCalledTimes(3);
    expect(executeProjectionBatch).toHaveBeenCalledWith('api-potluck', [pending[0], pending[2]]);
    expect(store.completeProjections).toHaveBeenCalledWith(expect.arrayContaining(pending));
    expect(store.completeProjections.mock.calls[0][0]).toHaveLength(pending.length);
    expect(store.failProjections).not.toHaveBeenCalled();
});

test('durably marks a failed projection batch before requesting a worker restart', async () => {
    const pending = [
        { eventId: 'evt-fatal', projectionName: 'api-potluck', hookName: 'onContentGenerated', args: [{}] }
    ];
    const order = [];
    const store = {
        listPendingProjections: jest.fn().mockResolvedValue(pending),
        completeProjections: jest.fn(),
        failProjections: jest.fn(async () => { order.push('failed'); })
    };
    const onFatalProjectionError = jest.fn(() => { order.push('restart'); });
    const projector = new RuntimeUsageProjector({
        store,
        executeProjection: jest.fn(),
        executeProjectionBatch: jest.fn().mockResolvedValue({
            completed: [],
            failed: [{ ...pending[0], error: 'disk full' }],
            requiresRestart: true
        }),
        onFatalProjectionError
    });

    await projector.drainOnce();

    expect(order).toEqual(['failed', 'restart']);
    expect(onFatalProjectionError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }));
});

test('refreshes projection health during a long-running drain without snapshot storms', async () => {
    const pending = Array.from({ length: 3 }, (_, index) => ({
        eventId: `evt-progress-${index}`,
        projectionName: 'api-potluck',
        hookName: 'onContentGenerated',
        args: [{}]
    }));
    const onProgress = jest.fn();
    const store = {
        listPendingProjections: jest.fn().mockResolvedValue(pending),
        completeProjections: jest.fn(),
        failProjections: jest.fn()
    };
    const projector = new RuntimeUsageProjector({
        store,
        executeProjection: jest.fn(),
        onProgress,
        progressIntervalMs: 1000
    });

    jest.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_500).mockReturnValueOnce(2_100);
    try {
        await projector.drainOnce();
        await projector.drainOnce();
        await projector.drainOnce();
    } finally {
        Date.now.mockRestore();
    }

    expect(onProgress).toHaveBeenCalledTimes(2);
});

test('shutdown drain stops at its timeout instead of waiting forever', async () => {
    const store = {
        listPendingProjections: jest.fn(async () => new Promise(() => {})),
        completeProjections: jest.fn(),
        failProjections: jest.fn()
    };
    const projector = new RuntimeUsageProjector({ store, executeProjection: jest.fn(), drainTimeoutMs: 25 });

    await expect(projector.drain({ timeoutMs: 25 })).rejects.toThrow('timed out');
});
