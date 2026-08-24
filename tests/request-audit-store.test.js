import fs from 'fs';
import os from 'os';
import path from 'path';
import { RequestAuditStore } from '../src/plugins/request-audit/audit-store.js';

describe('request audit store', () => {
  test('does not append a duplicate durable runtime event id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-event-id-'));
    const store = new RequestAuditStore({ dir });
    const event = {
      eventId: 'runtime-audit-event',
      timestamp: '2026-08-16T12:00:00.000Z',
      requestId: 'request-audit-event'
    };

    await store.append(event);
    await store.append(event);

    expect(await store.query({ requestId: 'request-audit-event' })).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('appends a same-day runtime batch with one filesystem append', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-batch-'));
    const store = new RequestAuditStore({ dir });
    const appendSpy = jest.spyOn(fs.promises, 'appendFile');
    try {
      const result = await store.appendBatch(Array.from({ length: 100 }, (_, index) => ({
        eventId: `runtime-batch-${index}`,
        timestamp: '2026-08-17T01:00:00.000Z',
        requestId: `request-batch-${index}`
      })));

      expect(result).toMatchObject({ appended: 100, duplicates: 0 });
      expect(appendSpy).toHaveBeenCalledTimes(1);
      expect(await store.query({})).toHaveLength(100);
    } finally {
      appendSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('restores recent durable event ids from the file tail without scanning the full jsonl', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-tail-dedupe-'));
    const filePath = path.join(dir, 'audit-2026-08-17.jsonl');
    fs.writeFileSync(filePath, Array.from({ length: 200 }, (_, index) => JSON.stringify({
      eventId: `tail-event-${index}`,
      timestamp: '2026-08-17T01:00:00.000Z',
      requestId: `tail-request-${index}`
    })).join('\n') + '\n');
    const store = new RequestAuditStore({ dir, recentEventIdLimit: 50, eventIdTailBytes: 4096 });
    const readEventsSpy = jest.spyOn(store, 'readEvents');
    try {
      const result = await store.append({
        eventId: 'tail-event-199',
        timestamp: '2026-08-17T01:00:00.000Z',
        requestId: 'tail-request-199'
      });
      expect(result).toEqual({ appended: false, duplicate: true });
      expect(readEventsSpy).not.toHaveBeenCalled();
    } finally {
      readEventsSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  test('persists and queries request audit jsonl by key hash and Beijing time window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-'));
    const store = new RequestAuditStore({ dir, retentionHours: 24 });

    await store.append({
      schemaVersion: 1,
      timestamp: '2026-06-23T09:10:00.000Z',
      beijingDate: '2026-06-23',
      beijingHour: '17',
      requestId: 'req-1',
      potluckKey: { hash: 'sha256:abc123' },
      request: { model: 'gpt-5.5', toProvider: 'openai-codex-oauth' },
      status: { outcome: 'success' },
      usage: { promptTokens: 1000, cachedTokens: 100 }
    });

    const rows = await store.query({
      keyHash: 'sha256:abc123',
      since: '2026-06-23T17:05:00+08:00',
      until: '2026-06-23T17:25:00+08:00'
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].requestId).toBe('req-1');
  });

  test('filters v2 audit rows by exact client ip and original path while keeping v1 readable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-network-'));
    const store = new RequestAuditStore({ dir, retentionHours: 24 });

    await store.append({
      schemaVersion: 2,
      timestamp: '2026-08-05T15:15:00.000Z',
      requestId: 'req-v2',
      request: { path: '/openai-codex-oauth/v1/chat/completions', normalizedPath: '/v1/chat/completions' },
      network: { clientIp: '119.123.77.234' }
    });
    await store.append({
      schemaVersion: 1,
      timestamp: '2026-08-05T15:16:00.000Z',
      requestId: 'req-v1',
      request: { path: null }
    });

    const rows = await store.query({
      clientIp: '119.123.77.234',
      path: '/openai-codex-oauth/v1/chat/completions'
    });

    expect(rows.map(row => row.requestId)).toEqual(['req-v2']);
    await expect(store.query({ requestId: 'req-v1' })).resolves.toHaveLength(1);
  });

  test('cleanup removes only expired audit jsonl files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-cleanup-'));
    const oldPath = path.join(dir, 'audit-2026-06-20.jsonl');
    const keepPath = path.join(dir, 'audit-2026-06-23.jsonl');
    const otherPath = path.join(dir, 'notes.txt');
    fs.writeFileSync(oldPath, '{}\n');
    fs.writeFileSync(keepPath, '{}\n');
    fs.writeFileSync(otherPath, 'keep');

    const store = new RequestAuditStore({ dir, retentionHours: 24 });
    await store.cleanup(new Date('2026-06-24T00:00:00.000Z'));

    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(keepPath)).toBe(true);
    expect(fs.existsSync(otherPath)).toBe(true);
  });

  test('rotates oversized active audit file before appending new events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-rotate-'));
    const store = new RequestAuditStore({ dir, retentionHours: 24, maxFileBytes: 32 });
    const activePath = path.join(dir, 'audit-2026-07-02.jsonl');
    fs.writeFileSync(activePath, `${JSON.stringify({ requestId: 'old-event' })}\n`);

    await store.append({
      schemaVersion: 1,
      timestamp: '2026-07-02T09:10:00.000Z',
      requestId: 'new-event'
    });

    const activeContent = fs.readFileSync(activePath, 'utf8');
    expect(activeContent).toContain('new-event');
    expect(activeContent).not.toContain('old-event');

    const archiveDir = path.join(dir, 'archived-large');
    const archives = fs.readdirSync(archiveDir);
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatch(/^audit-2026-07-02\.jsonl\.\d{8}T\d{6}\d{3}Z$/);
    expect(fs.readFileSync(path.join(archiveDir, archives[0]), 'utf8')).toContain('old-event');
  });

  test('queries audit jsonl without loading the whole file into memory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-stream-'));
    const store = new RequestAuditStore({ dir, retentionHours: 24 });
    const activePath = path.join(dir, 'audit-2026-07-02.jsonl');
    fs.writeFileSync(activePath, [
      JSON.stringify({ timestamp: '2026-07-02T09:00:00.000Z', requestId: 'old' }),
      JSON.stringify({ timestamp: '2026-07-02T09:10:00.000Z', requestId: 'match', potluckKey: { hash: 'sha256:abc123' } }),
      ''
    ].join('\n'));

    const originalReadFile = fs.promises.readFile;
    fs.promises.readFile = jest.fn(async () => {
      throw new Error('whole-file read is not allowed for request-audit query');
    });

    try {
      const rows = await store.query({
        keyHash: 'sha256:abc123',
        since: '2026-07-02T17:05:00+08:00',
        until: '2026-07-02T17:20:00+08:00'
      });

      expect(rows.map(row => row.requestId)).toEqual(['match']);
      expect(fs.promises.readFile).not.toHaveBeenCalled();
    } finally {
      fs.promises.readFile = originalReadFile;
    }
  });

  test('opens only audit files whose UTC day overlaps the requested time window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-window-files-'));
    const store = new RequestAuditStore({ dir, retentionHours: 24 });
    const files = [
      ['audit-2026-08-22.jsonl', '2026-08-22T09:00:00.000Z', 'old'],
      ['audit-2026-08-23.jsonl', '2026-08-23T23:50:00.000Z', 'first'],
      ['audit-2026-08-24.jsonl', '2026-08-24T00:10:00.000Z', 'second'],
      ['audit-2026-08-25.jsonl', '2026-08-25T09:00:00.000Z', 'future']
    ];
    for (const [name, timestamp, requestId] of files) {
      fs.writeFileSync(path.join(dir, name), `${JSON.stringify({ timestamp, requestId })}\n`);
    }

    const openedFiles = [];
    const readEvents = store.readEvents.bind(store);
    store.readEvents = async function* trackedReadEvents(filePath) {
      openedFiles.push(path.basename(filePath));
      yield* readEvents(filePath);
    };

    const rows = await store.query({
      since: '2026-08-23T23:00:00.000Z',
      until: '2026-08-24T01:00:00.000Z'
    });

    expect(openedFiles).toEqual([
      'audit-2026-08-23.jsonl',
      'audit-2026-08-24.jsonl'
    ]);
    expect(rows.map(row => row.requestId)).toEqual(['first', 'second']);
  });
});
