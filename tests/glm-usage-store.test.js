import { GptRequestStore } from '../src/plugins/request-audit/gpt-request-store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const now = new Date('2026-09-29T06:00:00.000Z');
const event = (id, date, hash, tokens, outcome = 'success') => ({
    eventId: `glm-${id}`, requestId: `glm-${id}`, timestamp: `${date}T08:00:00.000Z`,
    request: { toProvider: 'glm-coding-plan', requestedModel: 'gpt-6-sol' },
    account: { providerUuidHash: hash, providerNameDisplay: 'same name' },
    status: { outcome },
    usage: tokens == null ? { totalTokens: 0 } : { totalTokens: tokens, promptTokens: tokens - 1, completionTokens: 1 }
});

describe('GLM per-node daily usage', () => {
    let store;
    beforeEach(async () => { store = await new GptRequestStore({ dbPath: ':memory:' }).init(); });
    afterEach(() => store.close());

    test('keeps same-name keys separate across Beijing today, 7 and 30 calendar days', () => {
        store.appendBatch([
            event('a', '2026-09-29', 'hash-a', 10),
            event('b', '2026-09-23', 'hash-b', 20, 'http_error'),
            event('c', '2026-09-05', 'hash-a', 30),
            event('d', '2026-08-30', 'hash-b', 40)
        ]);
        const usage = store.queryGlmUsage(now);
        expect(usage.credentials['hash-a'].today.requestCount).toBe(1);
        expect(usage.credentials['hash-a'].week.requestCount).toBe(1);
        expect(usage.credentials['hash-a'].month.totalTokens).toBe(40);
        expect(usage.credentials['hash-b'].week.failureCount).toBe(1);
        expect(usage.credentials['hash-b'].month.totalTokens).toBe(20);
        expect(usage.total.month.requestCount).toBe(3);
    });

    test('does not turn unknown token usage into zero or double-count a replaced event', () => {
        store.append(event('a', '2026-09-29', 'hash-a', null));
        expect(store.queryGlmUsage(now).credentials['hash-a'].today.unknownTokenRequests).toBe(1);
        store.append(event('a', '2026-09-29', 'hash-a', 12));
        const period = store.queryGlmUsage(now).credentials['hash-a'].today;
        expect(period).toMatchObject({ requestCount: 1, unknownTokenRequests: 0, totalTokens: 12 });
        store.append(event('a', '2026-09-28', 'hash-b', 9));
        const moved = store.queryGlmUsage(now);
        expect(moved.credentials['hash-a']?.today.requestCount || 0).toBe(0);
        expect(moved.credentials['hash-b'].week.totalTokens).toBe(9);
        expect(moved.total.month.requestCount).toBe(1);
    });

    test('marks the monthly window incomplete until 30 days of retained history exist', () => {
        expect(store.queryGlmUsage(now).coverage.month).toBe(true);
        store.db.prepare("UPDATE glm_usage_meta SET value = ? WHERE key = 'coverage_start'")
            .run('2026-08-30T00:00:00.000Z');
        expect(store.queryGlmUsage(now).coverage.month).toBe(false);
    });

    test('backfills retained request records when the daily projection is introduced', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-usage-backfill-'));
        const dbPath = path.join(dir, 'audit.sqlite');
        let persisted;
        try {
            persisted = new GptRequestStore({ dbPath });
            await persisted.init();
            persisted.append(event('old', '2026-09-28', 'hash-a', 25));
            persisted.db.exec('DELETE FROM glm_usage_events; DELETE FROM glm_usage_daily;');
            persisted.close();
            persisted = new GptRequestStore({ dbPath });
            await persisted.init();
            expect(persisted.queryGlmUsage(now).credentials['hash-a'].week.totalTokens).toBe(25);
        } finally {
            persisted?.close();
            fs.rmSync(dir, { recursive: true });
        }
    });

    test('uses Beijing midnight for the today boundary', () => {
        const boundary = event('boundary', '2026-09-28', 'hash-a', 8);
        boundary.timestamp = '2026-09-28T16:30:00.000Z';
        delete boundary.beijingDate;
        store.append(boundary);
        expect(store.queryGlmUsage(now).credentials['hash-a'].today.requestCount).toBe(1);
    });
});
