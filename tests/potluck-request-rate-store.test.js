import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    closeUsageHistoryStore,
    loadRequestRateSnapshot,
    recordRequestRateEvent
} from '../src/plugins/api-potluck/usage-history-store.js';

describe('potluck request rate SQLite buckets', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potluck-rate-'));
        process.env.USAGE_EVENT_DB_PATH = path.join(dir, 'usage.sqlite');
    });

    afterEach(() => {
        closeUsageHistoryStore();
        delete process.env.USAGE_EVENT_DB_PATH;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('aggregates a shared window and keeps peak at least current', () => {
        const now = Date.parse('2026-09-05T10:00:09.000Z');
        recordRequestRateEvent('key-a', { timestamp: '2026-09-05T10:00:09.000Z', successful: true }, 'e1');
        recordRequestRateEvent('key-a', { timestamp: '2026-09-05T10:00:09.000Z', successful: false }, 'e2');
        const snapshot = loadRequestRateSnapshot('key-a', { now, windowSeconds: 10 });
        expect(snapshot.currentQps).toBe(0.2);
        expect(snapshot.currentRpm).toBe(1.2);
        expect(snapshot.peakQps).toBeGreaterThanOrEqual(snapshot.currentQps);
        expect(snapshot.peakRpm).toBeGreaterThanOrEqual(snapshot.currentRpm);
    });

    test('deduplicates the same runtime event', () => {
        recordRequestRateEvent('key-a', { timestamp: '2026-09-05T10:00:09.000Z' }, 'same');
        recordRequestRateEvent('key-a', { timestamp: '2026-09-05T10:00:09.000Z' }, 'same');
        const snapshot = loadRequestRateSnapshot('key-a', {
            now: Date.parse('2026-09-05T10:00:09.000Z'),
            windowSeconds: 10
        });
        expect(snapshot.currentQps).toBe(0.1);
    });
});
