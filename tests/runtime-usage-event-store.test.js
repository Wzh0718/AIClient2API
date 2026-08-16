import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageEventStore } from '../src/runtime/usage-event-store.js';

function event(eventId, totalTokens = 10) {
    return {
        eventId,
        streamId: `${eventId}-0`,
        hookName: 'onContentGenerated',
        sourceWorkerId: 'execution-1',
        createdAt: '2026-08-16T14:00:00.000Z',
        args: [{
            requestId: `request-${eventId}`,
            potluckKeyHash: 'sha256:test-key',
            toProvider: 'openai-codex-oauth',
            model: 'gpt-5.5',
            accountEmail: 'account@example.com',
            _runtimeUsage: { requestCount: 1, totalTokens }
        }]
    };
}

describe('runtime usage event store', () => {
    let dir;
    let store;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-usage-ledger-'));
    });

    afterEach(async () => {
        await store?.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('durably inserts a batch and ignores a duplicate eventId', async () => {
        store = createUsageEventStore({ dbPath: path.join(dir, 'usage.sqlite') });
        const first = await store.appendBatch([event('event-a'), event('event-b')]);
        const replay = await store.appendBatch([event('event-a')]);
        expect(first).toMatchObject({ inserted: 2, duplicates: 0 });
        expect(replay).toMatchObject({ inserted: 0, duplicates: 1 });
        expect(await store.countEvents()).toBe(2);
    });

    test('reopens after commit and still deduplicates an event replayed before ACK', async () => {
        const dbPath = path.join(dir, 'usage.sqlite');
        store = createUsageEventStore({ dbPath });
        await store.appendBatch([event('commit-before-ack', 42)]);
        await store.close();
        store = createUsageEventStore({ dbPath });
        const replay = await store.appendBatch([event('commit-before-ack', 42)]);
        expect(replay).toMatchObject({ inserted: 0, duplicates: 1 });
        expect(await store.countEvents()).toBe(1);
    });

    test('keeps a duplicate event pending until its hook projection is durably marked', async () => {
        const dbPath = path.join(dir, 'usage.sqlite');
        store = createUsageEventStore({ dbPath });
        const first = await store.appendBatch([event('projection-crash-window', 42)]);
        expect(first.pendingEventIds).toEqual(['projection-crash-window']);

        await store.close();
        store = createUsageEventStore({ dbPath });
        const replayBeforeProjection = await store.appendBatch([event('projection-crash-window', 42)]);
        expect(replayBeforeProjection).toMatchObject({ inserted: 0, duplicates: 1 });
        expect(replayBeforeProjection.pendingEventIds).toEqual(['projection-crash-window']);

        await store.markProjected(['projection-crash-window']);
        const replayAfterProjection = await store.appendBatch([event('projection-crash-window', 42)]);
        expect(replayAfterProjection.pendingEventIds).toEqual([]);
    });

    test('records bounded batch and persistence metrics without serializing a key store', async () => {
        store = createUsageEventStore({ dbPath: path.join(dir, 'usage.sqlite') });
        const events = Array.from({ length: 1000 }, (_, index) => event(`event-${index}`));
        await store.appendBatch(events);
        const snapshot = await store.snapshot();
        expect(snapshot.events).toBe(1000);
        expect(snapshot.commits).toBe(1);
        expect(snapshot.lastBatchSize).toBe(1000);
        expect(snapshot.bytesWritten).toBeGreaterThan(0);
        expect(snapshot.lastCommitMs).toBeGreaterThanOrEqual(0);
    });

    test('prunes only events older than the configured retention window', async () => {
        store = createUsageEventStore({ dbPath: path.join(dir, 'usage.sqlite') });
        await store.appendBatch([
            { ...event('old'), createdAt: '2026-06-01T00:00:00.000Z' },
            { ...event('recent'), createdAt: '2026-08-16T00:00:00.000Z' }
        ]);
        const result = await store.prune({ before: '2026-07-01T00:00:00.000Z' });
        expect(result.deleted).toBe(1);
        expect(await store.countEvents()).toBe(1);
    });
});
