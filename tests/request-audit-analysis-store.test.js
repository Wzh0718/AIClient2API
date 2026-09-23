import fs from 'fs';
import os from 'os';
import path from 'path';
import { RequestAuditAnalysisStore } from '../src/plugins/request-audit/analysis-store.js';

describe('request audit analysis store', () => {
  test('cache reuses unchanged files, notices rewrites/deletions and respects LRU bounds', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cache-test-'));
    const store = new RequestAuditAnalysisStore({ dir, cacheMaxFiles: 2, cacheMaxBytes: 10000 });
    const first = store.getFilePath('2026-09-21');
    const second = store.getFilePath('2026-09-22');
    try {
      fs.writeFileSync(first, JSON.stringify({ requestId: 'a', primaryReason: 'old' }) + '\nmalformed\n');
      fs.writeFileSync(second, JSON.stringify({ requestId: 'a', primaryReason: 'new' }));
      const read = jest.spyOn(fs.promises, 'readFile');
      try {
        expect(await store.readDiagnostics({ requestIds: [] })).toEqual({});
        expect(read).not.toHaveBeenCalled();
        expect((await store.readDiagnostics({ requestIds: ['a'] })).a.primaryReason).toBe('new');
        expect(read).toHaveBeenCalledTimes(2);
        await store.readDiagnostics({ requestIds: ['a'] });
        expect(read).toHaveBeenCalledTimes(2);
        fs.writeFileSync(second, JSON.stringify({ requestId: 'a', primaryReason: 'changed-longer' }));
        expect((await store.readDiagnostics({ requestIds: ['a'] })).a.primaryReason).toBe('changed-longer');
        expect(read).toHaveBeenCalledTimes(3);
        fs.unlinkSync(second);
        expect((await store.readDiagnostics({ all: true })).a.primaryReason).toBe('old');
        expect(store.fileCache.has(second)).toBe(false);
        store.cacheMaxFiles = 1;
        fs.writeFileSync(second, JSON.stringify({ requestId: 'b' }));
        await store.readDiagnostics({ all: true });
        expect(store.fileCache.size).toBe(1);
        expect(store.cacheBytes).toBeLessThanOrEqual(10000);
      } finally { read.mockRestore(); }
    } finally { fs.rmSync(dir, { recursive: true }); }
  });

  test('writes and reads diagnostics with freshness metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-analysis-'));
    const store = new RequestAuditAnalysisStore({ dir });
    const generatedAt = '2026-06-24T06:10:00.000Z';

    await store.writeDiagnostics([
      {
        requestId: 'req-1',
        primaryReason: 'prefix_changed',
        reasons: [{ code: 'prefix_changed', severity: 'high' }],
        confidence: 0.85
      }
    ], { generatedAt });

    const diagnostics = await store.readDiagnostics({ requestIds: ['req-1'] });
    const freshness = await store.readFreshness(new Date('2026-06-24T06:11:00.000Z'));

    expect(diagnostics['req-1']).toMatchObject({
      requestId: 'req-1',
      primaryReason: 'prefix_changed'
    });
    expect(freshness).toMatchObject({
      generatedAt,
      status: 'fresh'
    });
    expect(freshness.staleSeconds).toBe(60);
  });

  test('missing analysis returns empty diagnostics and missing freshness', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-analysis-empty-'));
    const store = new RequestAuditAnalysisStore({ dir });

    await expect(store.readDiagnostics({ requestIds: ['missing'] })).resolves.toEqual({});
    await expect(store.readFreshness()).resolves.toMatchObject({ status: 'missing' });
  });
});
