import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RequestAuditStore } from '../src/plugins/request-audit/audit-store.js';
import { RequestAuditAnalysisStore } from '../src/plugins/request-audit/analysis-store.js';
import { createRequestAuditAnalyzerRunner, runRequestAuditAnalyzer } from '../src/plugins/request-audit/analyzer-runner.js';

const event = (requestId, timestamp) => ({
    eventId: `audit:${requestId}`, requestId, timestamp,
    potluckKey: { hash: 'sha256:key' },
    request: { model: 'gpt-6-luna', requestedModel: 'gpt-6-luna', path: '/openai-codex-oauth/v1/responses', toProvider: 'openai-codex-oauth' },
    account: { providerUuidHash: 'sha256:credential', accountEmail: 'owner@example.com' },
    usage: { promptTokens: 100, cachedTokens: 0, totalTokens: 105 },
    status: { outcome: 'success' }
});

describe('incremental request audit analyzer', () => {
    let root;
    let auditStore;
    let analysisStore;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-incremental-'));
        auditStore = new RequestAuditStore({ dir: path.join(root, 'audit') });
        analysisStore = new RequestAuditAnalysisStore({ dir: path.join(root, 'analysis') });
    });
    afterEach(() => fs.rmSync(root, { recursive: true }));

    test('reads appended events once and resumes after a new analyzer instance', async () => {
        const base = '2026-09-28T06:00:00.000Z';
        await auditStore.append(event('before-start', base));
        const options = { auditStore, analysisStore, lookbackMinutes: 180, generatedAt: '2026-09-28T06:10:00.000Z' };
        expect((await runRequestAuditAnalyzer(options)).warmup).toBe(true);
        await auditStore.append(event('after-start', '2026-09-28T06:11:00.000Z'));
        const first = await runRequestAuditAnalyzer({ ...options, generatedAt: '2026-09-28T06:12:00.000Z' });
        expect(first).toMatchObject({ eventCount: 1, diagnosticsCount: 1, backlogBytes: 0 });
        expect(first.queryStats.scannedBytes).toBeGreaterThan(0);
        expect((await runRequestAuditAnalyzer({ ...options, generatedAt: '2026-09-28T06:13:00.000Z' })).eventCount).toBe(0);

        const resumed = new RequestAuditAnalysisStore({ dir: path.join(root, 'analysis') });
        await auditStore.append(event('after-restart', '2026-09-28T06:14:00.000Z'));
        expect((await runRequestAuditAnalyzer({ ...options, analysisStore: resumed, generatedAt: '2026-09-28T06:15:00.000Z' })).eventCount).toBe(1);
        expect((await resumed.readCheckpoint()).recent.map(item => item.requestId)).toEqual(['after-start', 'after-restart']);
    });

    test('resumes at a complete line after a byte-limited read', async () => {
        const time = '2026-09-28T06:00:00.000Z';
        await auditStore.appendBatch([event('one', time), event('two', time)]);
        const seen = [];
        const first = await auditStore.readIncremental({ since: time, offsets: {}, maxBytes: 80, onEvent: item => seen.push(item.requestId) });
        expect(first.scannedBytes).toBeLessThanOrEqual(80);
        expect(first.remainingBytes).toBeGreaterThan(0);
        const second = await auditStore.readIncremental({ since: time, offsets: first.offsets, onEvent: item => seen.push(item.requestId) });
        expect(second.remainingBytes).toBe(0);
        expect(seen).toEqual(['one', 'two']);
    });

    test('uses file identity to avoid replaying a rotated audit file', async () => {
        auditStore = new RequestAuditStore({ dir: path.join(root, 'audit'), maxFileBytes: 500 });
        const options = { auditStore, analysisStore, generatedAt: '2026-09-28T06:10:00.000Z' };
        await auditStore.append(event('before-rotation', '2026-09-28T06:00:00.000Z'));
        await runRequestAuditAnalyzer(options);
        await auditStore.append(event('after-rotation', '2026-09-28T06:11:00.000Z'));
        const result = await runRequestAuditAnalyzer({ ...options, generatedAt: '2026-09-28T06:12:00.000Z' });
        expect(result.eventCount).toBe(1);
        expect((await analysisStore.readCheckpoint()).recent.map(item => item.requestId)).toEqual(['after-rotation']);
    });

    test('skips optional analysis while hook backlog is high', async () => {
        const runner = createRequestAuditAnalyzerRunner({ auditStore, analysisStore, shouldRun: () => 501 });
        expect(await runner.run()).toEqual({ skipped: true });
        expect(runner.snapshot()).toMatchObject({ skippedRuns: 1, runs: 0, lastGateBacklog: 501 });
    });
});
