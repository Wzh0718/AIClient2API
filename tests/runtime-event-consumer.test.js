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

test('durable hook apply flushes every persistence sink before commit can run', async () => {
    const order = [];
    const apply = createDurableRuntimeHookApply({
        executeHook: async () => order.push('hook'),
        flushers: [
            async () => { order.push('potluck'); return true; },
            async () => { order.push('model'); return true; },
            async () => { order.push('audit'); }
        ]
    });
    const durableState = { hasApplied: jest.fn().mockReturnValue(false), commit: jest.fn(() => order.push('commit')) };
    const consumer = new RuntimeEventConsumer({ apply, ack: jest.fn(), durableState });

    await consumer.consume({ eventId: 'evt-flush', hookName: 'onContentGenerated', args: [{}] });

    expect(order).toEqual(['hook', 'potluck', 'model', 'audit', 'commit']);
});

test('durable hook apply rejects when a persistence sink cannot flush', async () => {
    const apply = createDurableRuntimeHookApply({
        executeHook: jest.fn().mockResolvedValue(undefined),
        flushers: [async () => false]
    });

    await expect(apply({ hookName: 'onContentGenerated', args: [{}] }))
        .rejects.toThrow(/persistence flush failed/i);
});
