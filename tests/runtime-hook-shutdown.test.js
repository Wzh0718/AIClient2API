import fs from 'node:fs';
import { drainRuntimeHookTransport } from '../src/runtime/runtime-hook-shutdown.js';

describe('runtime hook shutdown lifecycle', () => {
    test('does not close the usage store until all durable layers have drained', async () => {
        const calls = [];
        const usageEventStore = {
            checkpoint: jest.fn(async () => {
                calls.push('checkpoint');
                return { pending: 0 };
            }),
            close: jest.fn(async () => { calls.push('store.close'); })
        };
        const result = await drainRuntimeHookTransport({
            batcher: { close: jest.fn(async () => { calls.push('batcher.close'); }) },
            bridge: { drain: jest.fn(async () => { calls.push('bridge.drain'); return { drained: true }; }) },
            stream: {
                flushSpool: jest.fn(async () => { calls.push('stream.flush'); }),
                close: jest.fn(async () => { calls.push('stream.close'); })
            },
            projector: { drain: jest.fn(async () => { calls.push('projector.drain'); }) },
            usageEventStore
        });

        expect(calls).toEqual([
            'batcher.close',
            'bridge.drain',
            'stream.flush',
            'projector.drain',
            'checkpoint',
            'store.close',
            'stream.close'
        ]);
        expect(result).toMatchObject({ usageEventStoreSnapshot: { pending: 0 } });
    });

    test('keeps the usage store open when the batcher cannot drain before shutdown timeout', async () => {
        const timeout = Object.assign(new Error('batch drain timed out'), {
            code: 'RUNTIME_EVENT_DRAIN_TIMEOUT'
        });
        const usageEventStore = {
            checkpoint: jest.fn(),
            close: jest.fn()
        };
        const bridge = { drain: jest.fn() };
        const projector = { drain: jest.fn() };
        const stream = { flushSpool: jest.fn(), close: jest.fn() };

        await expect(drainRuntimeHookTransport({
            batcher: { close: jest.fn().mockRejectedValue(timeout) },
            bridge,
            stream,
            projector,
            usageEventStore
        })).rejects.toMatchObject({ code: 'RUNTIME_EVENT_DRAIN_TIMEOUT' });

        expect(usageEventStore.checkpoint).not.toHaveBeenCalled();
        expect(usageEventStore.close).not.toHaveBeenCalled();
        expect(bridge.drain).not.toHaveBeenCalled();
        expect(projector.drain).not.toHaveBeenCalled();
        expect(stream.close).not.toHaveBeenCalled();
    });

    test('waits for the projection refresh coordinator before closing the usage store', async () => {
        let releaseRefresh;
        const refresh = new Promise(resolve => { releaseRefresh = resolve; });
        const usageEventStore = {
            checkpoint: jest.fn(async () => ({ pending: 0 })),
            close: jest.fn(async () => {})
        };
        const shutdown = drainRuntimeHookTransport({
            batcher: { close: jest.fn(async () => {}) },
            bridge: { drain: jest.fn(async () => ({ drained: true })) },
            stream: {
                flushSpool: jest.fn(async () => {}),
                close: jest.fn(async () => {})
            },
            projector: { drain: jest.fn(async () => {}) },
            usageEventStore,
            waitForProjectionRefresh: () => refresh
        });

        await new Promise(resolve => setImmediate(resolve));
        expect(usageEventStore.checkpoint).not.toHaveBeenCalled();
        releaseRefresh();
        await expect(shutdown).resolves.toMatchObject({ usageEventStoreSnapshot: { pending: 0 } });
        expect(usageEventStore.checkpoint).toHaveBeenCalledTimes(1);
        expect(usageEventStore.close).toHaveBeenCalledTimes(1);
    });

    test('API server delegates shutdown ordering to the durability helper', () => {
        const source = fs.readFileSync('src/services/api-server.js', 'utf8').replace(/\r\n/g, '\n');
        expect(source).toContain("import { drainRuntimeHookTransport } from '../runtime/runtime-hook-shutdown.js';");
        expect(source).toContain('const result = await drainRuntimeHookTransport({');
        expect(source).toContain('batcher: runtimeEventBatcher');
        expect(source).toContain('usageEventStore,');
        expect(source).toContain('runtimeEventBatcher = null;');
        expect(source).toContain('runtimeHookStream = null;');
    });
});
