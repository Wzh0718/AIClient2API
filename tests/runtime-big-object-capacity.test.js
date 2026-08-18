import { BigObjectCapacity, resolveBigObjectBudget, resolveImageQueueLimit } from '../src/runtime/big-object-capacity.js';

describe('BigObjectCapacity', () => {
    test('queues image work and releases estimated bytes without imposing a fixed request cap', async () => {
        const capacity = new BigObjectCapacity({ budgetBytes: 100, queueLimit: 2, waitMs: 20, metrics: { rssBytes: 0, eventLoopP95Ms: 0, backpressureMs: 0 } });
        const first = await capacity.acquire({ bytes: 80, kind: 'image' });
        const pending = capacity.acquire({ bytes: 30, kind: 'image' });
        expect(capacity.snapshot().activeBytes).toBe(80);
        capacity.release(first);
        await expect(pending).resolves.toMatchObject({ bytes: 30 });
    });

    test('rejects after the bounded wait with the stable capacity error', async () => {
        const capacity = new BigObjectCapacity({ budgetBytes: 10, queueLimit: 0, waitMs: 5, metrics: {} });
        await capacity.acquire({ bytes: 10, kind: 'image' });
        await expect(capacity.acquire({ bytes: 1, kind: 'image' })).rejects.toMatchObject({
            code: 'image_capacity_exceeded',
            type: 'server_overloaded',
            statusCode: 503
        });
    });

    test('does not treat cumulative output backpressure as a permanent image admission block', async () => {
        const capacity = new BigObjectCapacity({
            budgetBytes: 100,
            queueLimit: 0,
            waitMs: 5,
            metrics: {
                rssBytes: 10,
                rssLimitBytes: 1000,
                eventLoopP95Ms: 20,
                backpressureMs: 10_000
            }
        });

        await expect(capacity.acquire({ bytes: 20, kind: 'image' })).resolves.toMatchObject({
            bytes: 20,
            kind: 'image'
        });
    });

    test('reports safe capacity diagnostics when a current pressure gate rejects work', async () => {
        const capacity = new BigObjectCapacity({
            budgetBytes: 100,
            queueLimit: 0,
            waitMs: 5,
            metrics: {
                rssBytes: 850,
                rssLimitBytes: 1000,
                eventLoopP95Ms: 1200,
                backpressureMs: 99_999
            }
        });

        capacity.samplePressure();
        capacity.samplePressure();
        capacity.samplePressure();

        await expect(capacity.acquire({ bytes: 20, kind: 'image-edit' })).rejects.toMatchObject({
            code: 'image_capacity_exceeded',
            details: {
                blockedReasons: ['rss', 'event_loop'],
                activeBytes: 0,
                budgetBytes: 100,
                estimatedBytes: 20,
                rssBytes: 850,
                rssLimitBytes: 1000,
                eventLoopP95Ms: 1200,
                queued: 0
            }
        });
    });

    test('uses 50% of a container limit and scales queue size with healthy credentials', () => {
        expect(resolveBigObjectBudget({ containerLimitBytes: 8 * 1024 ** 3 })).toBe(4 * 1024 ** 3);
        expect(resolveBigObjectBudget({ containerLimitBytes: null })).toBe(4 * 1024 ** 3);
        expect(resolveImageQueueLimit(30)).toBe(60);
        expect(resolveImageQueueLimit(80)).toBe(100);
    });

    test('accepts a production-sized 50-request image burst when byte budget allows it', async () => {
        const capacity = new BigObjectCapacity({ budgetBytes: 400 * 1024 * 1024, queueLimit: 100, waitMs: 10, metrics: {} });
        const tickets = await Promise.all(Array.from({ length: 50 }, () => capacity.acquire({ bytes: 4 * 1024 * 1024, kind: 'image' })));
        expect(tickets).toHaveLength(50);
        expect(capacity.snapshot().activeBytes).toBe(200 * 1024 * 1024);
        tickets.forEach(ticket => capacity.release(ticket));
        expect(capacity.snapshot()).toMatchObject({ activeBytes: 0, queued: 0 });
    });

    test('does not block on a transient event-loop spike and uses hysteresis for sustained pressure', async () => {
        const metrics = { rssBytes: 100, rssLimitBytes: 1000, eventLoopP95Ms: 250 };
        const capacity = new BigObjectCapacity({ budgetBytes: 100, queueLimit: 0, waitMs: 5, metrics });

        capacity.samplePressure();
        const transient = await capacity.acquire({ bytes: 10 });
        capacity.release(transient);

        metrics.eventLoopP95Ms = 1200;
        capacity.samplePressure();
        capacity.samplePressure();
        expect(capacity.snapshot().eventLoopBlocked).toBe(false);
        capacity.samplePressure();
        await expect(capacity.acquire({ bytes: 10 })).rejects.toMatchObject({
            details: { blockedReasons: ['event_loop'] }
        });

        metrics.eventLoopP95Ms = 300;
        capacity.samplePressure();
        capacity.samplePressure();
        expect(capacity.snapshot().eventLoopBlocked).toBe(true);
        capacity.samplePressure();
        await expect(capacity.acquire({ bytes: 10 })).resolves.toMatchObject({ bytes: 10 });
    });

    test('removes an aborted queued request immediately', async () => {
        const capacity = new BigObjectCapacity({ budgetBytes: 10, queueLimit: 2, waitMs: 1000, metrics: {} });
        const active = await capacity.acquire({ bytes: 10 });
        const controller = new AbortController();
        const pending = capacity.acquire({ bytes: 1, signal: controller.signal });

        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(capacity.snapshot().queued).toBe(0);
        capacity.release(active);
    });
});
