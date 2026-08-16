import { RuntimeEventConsumer, createDurableRuntimeHookApply } from '../src/runtime/runtime-event-consumer.js';

test('acknowledges only after successful application and deduplicates event ids', async () => {
    const apply = jest.fn().mockResolvedValue(undefined);
    const ack = jest.fn();
    const consumer = new RuntimeEventConsumer({ apply, ack });
    const event = { eventId: 'evt-1', sourceWorkerId: 'execution-1' };
    await consumer.consume(event);
    await consumer.consume(event);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(2);
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]);
});

test('does not acknowledge a failed persistence event', async () => {
    const ack = jest.fn();
    const consumer = new RuntimeEventConsumer({ apply: () => Promise.reject(new Error('write failed')), ack });
    await expect(consumer.consume({ eventId: 'evt-2' })).rejects.toThrow('write failed');
    expect(ack).not.toHaveBeenCalled();
});

test('serializes hook application in receive order', async () => {
    const releaseFirst = {};
    releaseFirst.promise = new Promise(resolve => { releaseFirst.resolve = resolve; });
    const applied = [];
    const consumer = new RuntimeEventConsumer({
        apply: async event => {
            applied.push(`start:${event.eventId}`);
            if (event.eventId === 'evt-first') await releaseFirst.promise;
            applied.push(`end:${event.eventId}`);
        },
        ack: jest.fn()
    });

    const first = consumer.consume({ eventId: 'evt-first', sourceWorkerId: 'execution-1' });
    const second = consumer.consume({ eventId: 'evt-second', sourceWorkerId: 'execution-1' });
    await Promise.resolve();

    expect(applied).toEqual(['start:evt-first']);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(applied).toEqual([
        'start:evt-first',
        'end:evt-first',
        'start:evt-second',
        'end:evt-second'
    ]);
});

test('uses durable applied state across consumer restarts', async () => {
    const applied = new Set();
    const durableState = {
        hasApplied: jest.fn(event => applied.has(event.eventId)),
        commit: jest.fn(event => applied.add(event.eventId))
    };
    const apply = jest.fn().mockResolvedValue(undefined);
    const event = { eventId: 'evt-durable', streamId: '1-0' };
    await new RuntimeEventConsumer({ apply, ack: jest.fn(), durableState }).consume(event);
    await new RuntimeEventConsumer({ apply, ack: jest.fn(), durableState }).consume(event);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(durableState.commit).toHaveBeenCalledTimes(2);
});

test('acks a durably applied stream replay through the durable state', async () => {
    const durableState = {
        hasApplied: jest.fn().mockResolvedValue(true),
        commit: jest.fn().mockResolvedValue(undefined)
    };
    const apply = jest.fn().mockResolvedValue(undefined);
    const ack = jest.fn().mockResolvedValue(undefined);
    const event = { eventId: 'evt-durable-replay', streamId: '2-0' };

    await new RuntimeEventConsumer({ apply, ack, durableState }).consume(event);

    expect(apply).not.toHaveBeenCalled();
    expect(durableState.commit).toHaveBeenCalledWith(event);
    expect(ack).toHaveBeenCalledWith(event);
});

test('durable hook apply does not force persistence sink snapshots per event', async () => {
    const order = [];
    const flusher = jest.fn();
    const apply = createDurableRuntimeHookApply({
        executeHook: async () => order.push('hook'),
        flushers: [flusher]
    });
    const durableState = { hasApplied: jest.fn().mockReturnValue(false), commit: jest.fn(() => order.push('commit')) };
    const consumer = new RuntimeEventConsumer({ apply, ack: jest.fn(), durableState });

    await consumer.consume({ eventId: 'evt-flush', hookName: 'onContentGenerated', args: [{}] });

    expect(order).toEqual(['hook', 'commit']);
    expect(flusher).not.toHaveBeenCalled();
});

test('durable hook apply is not failed by a legacy flusher', async () => {
    const apply = createDurableRuntimeHookApply({
        executeHook: jest.fn().mockResolvedValue(undefined),
        flushers: [async () => false]
    });

    await expect(apply({ hookName: 'onContentGenerated', args: [{}] })).resolves.toBeUndefined();
});

test('commits a durable batch before applying and acknowledging Redis entries', async () => {
    const order = [];
    const consumer = new RuntimeEventConsumer({
        appendBatch: async events => {
            order.push(`commit:${events.length}`);
            return { inserted: events.length, duplicates: 0 };
        },
        apply: async event => order.push(`apply:${event.eventId}`),
        ackBatch: async events => order.push(`ack:${events.length}`)
    });

    await consumer.consumeBatch([
        { eventId: 'batch-a', hookName: 'onContentGenerated', args: [] },
        { eventId: 'batch-b', hookName: 'onContentGenerated', args: [] }
    ]);

    expect(order).toEqual(['commit:2', 'apply:batch-a', 'apply:batch-b', 'ack:2']);
});

test('replays a committed but unprojected duplicate and marks projection before ACK', async () => {
    const order = [];
    const consumer = new RuntimeEventConsumer({
        appendBatch: async () => ({
            inserted: 0,
            duplicates: 1,
            pendingEventIds: ['replay-unprojected']
        }),
        apply: async event => order.push(`apply:${event.eventId}`),
        markProjectedBatch: async events => order.push(`projected:${events.length}`),
        ackBatch: async events => order.push(`ack:${events.length}`)
    });

    await consumer.consumeBatch([
        { eventId: 'replay-unprojected', hookName: 'onContentGenerated', args: [{}] }
    ]);

    expect(order).toEqual(['apply:replay-unprojected', 'projected:1', 'ack:1']);
});

test('injects the durable event id into the hook context', async () => {
    const executeHook = jest.fn().mockResolvedValue(undefined);
    const apply = createDurableRuntimeHookApply({ executeHook });

    await apply({
        eventId: 'runtime-event-id',
        hookName: 'onContentGenerated',
        args: [{ requestId: 'request-id' }]
    });

    expect(executeHook).toHaveBeenCalledWith('onContentGenerated', {
        requestId: 'request-id',
        _runtimeEventId: 'runtime-event-id'
    });
});

test('does not acknowledge a batch when the durable ledger commit fails', async () => {
    const ackBatch = jest.fn();
    const consumer = new RuntimeEventConsumer({
        appendBatch: async () => { throw new Error('sqlite unavailable'); },
        apply: jest.fn(),
        ackBatch
    });

    await expect(consumer.consumeBatch([
        { eventId: 'not-acked', hookName: 'onContentGenerated', args: [] }
    ])).rejects.toThrow('sqlite unavailable');
    expect(ackBatch).not.toHaveBeenCalled();
});

test('acknowledges after the ledger commit without waiting for usage projections', async () => {
    const order = [];
    let releaseProjection;
    const projection = new Promise(resolve => { releaseProjection = resolve; });
    const consumer = new RuntimeEventConsumer({
        appendBatch: async () => {
            order.push('ledger');
            return { inserted: 1, duplicates: 0 };
        },
        ackBatch: async () => order.push('ack'),
        scheduleProjections: () => {
            order.push('schedule');
            return projection;
        }
    });

    await consumer.consumeBatch([{ eventId: 'deferred-projection', hookName: 'onContentGenerated', args: [{}] }]);
    expect(order).toEqual(['ledger', 'ack', 'schedule']);
    releaseProjection();
});

test('reports bounded ACK latency metrics for durable batches', async () => {
    const consumer = new RuntimeEventConsumer({
        appendBatch: jest.fn().mockResolvedValue({ inserted: 2 }),
        ackBatch: jest.fn(),
        scheduleProjections: jest.fn()
    });
    await consumer.consumeBatch([
        { eventId: 'ack-metric-1' },
        { eventId: 'ack-metric-2' }
    ]);
    expect(consumer.snapshot()).toMatchObject({ ackCount: 2, inMemoryPending: 0 });
    expect(consumer.snapshot().lastAckLatencyMs).toBeGreaterThanOrEqual(0);
});
