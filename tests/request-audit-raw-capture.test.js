import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { buildBoundedRawCaptureEvent, RequestAuditRawCaptureStore, shouldCaptureRawRequest } from '../src/plugins/request-audit/raw-capture-store.js';

describe('request audit raw capture', () => {
  test('is disabled by default and only allows configured key hashes', () => {
    expect(shouldCaptureRawRequest({ enabled: false }, { potluckKey: { hash: 'sha256:a' } })).toBe(false);
    expect(shouldCaptureRawRequest({ enabled: true, keyHashes: ['sha256:a'] }, { potluckKey: { hash: 'sha256:b' } })).toBe(false);
    expect(shouldCaptureRawRequest({ enabled: true, keyHashes: ['sha256:a'] }, { potluckKey: { hash: 'sha256:a' } })).toBe(true);
  });

  test('writes gzipped raw request under safe directory with byte cap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-raw-'));
    const store = new RequestAuditRawCaptureStore({ dir, maxBytes: 80 });

    const result = await store.capture({
      requestId: 'req-raw',
      timestamp: '2026-06-24T06:00:00.000Z',
      potluckKey: { hash: 'sha256:key' },
      originalRequestBody: { input: `secret-${'x'.repeat(200)}` }
    });

    expect(result.captured).toBe(true);
    expect(result.path.startsWith(dir)).toBe(true);
    expect(result.path).toMatch(/req-raw\.json\.gz$/);
    const raw = zlib.gunzipSync(fs.readFileSync(result.path)).toString('utf8');
    expect(raw).toContain('truncated');
    expect(raw).not.toContain('x'.repeat(120));
  });

  test('cleanup removes expired raw capture files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-raw-cleanup-'));
    const store = new RequestAuditRawCaptureStore({ dir, ttlMinutes: 60 });

    await store.capture({
      requestId: 'old',
      timestamp: '2026-06-24T06:00:00.000Z',
      originalRequestBody: { input: 'old' }
    });
    await store.capture({
      requestId: 'new',
      timestamp: '2026-06-24T07:30:00.000Z',
      originalRequestBody: { input: 'new' }
    });
    await store.cleanup(new Date('2026-06-24T08:00:00.000Z'));

    const files = listFiles(dir);
    expect(files.some(file => file.endsWith('old.json.gz'))).toBe(false);
    expect(files.some(file => file.endsWith('new.json.gz'))).toBe(true);
  });

  test('refuses captures after expiry or shared capacity limits are reached', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-raw-limits-'));
    const store = new RequestAuditRawCaptureStore({
      dir,
      expiresAt: '2026-08-14T12:15:00.000Z',
      maxFiles: 1,
      maxTotalBytes: 1024 * 1024
    });

    const first = await store.capture({
      requestId: 'first',
      timestamp: '2026-08-14T12:00:00.000Z',
      originalRequestBody: { input: 'first prompt' }
    }, { now: new Date('2026-08-14T12:01:00.000Z') });
    const capped = await store.capture({
      requestId: 'second',
      timestamp: '2026-08-14T12:02:00.000Z',
      originalRequestBody: { input: 'second prompt' }
    }, { now: new Date('2026-08-14T12:02:00.000Z') });
    const expired = await store.capture({
      requestId: 'third',
      timestamp: '2026-08-14T12:16:00.000Z',
      originalRequestBody: { input: 'third prompt' }
    }, { now: new Date('2026-08-14T12:16:00.000Z') });

    expect(first.captured).toBe(true);
    expect(capped).toMatchObject({ captured: false, stopReason: 'max_files' });
    expect(expired).toMatchObject({ captured: false, stopReason: 'expired' });
  });

  test('serializes concurrent writers so the shared file cap is not exceeded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-raw-concurrent-'));
    const firstStore = new RequestAuditRawCaptureStore({ dir, maxFiles: 1 });
    const secondStore = new RequestAuditRawCaptureStore({ dir, maxFiles: 1 });

    const results = await Promise.all([
      firstStore.capture({ requestId: 'first', originalRequestBody: { input: 'first' } }),
      secondStore.capture({ requestId: 'second', originalRequestBody: { input: 'second' } })
    ]);

    expect(results.filter(result => result.captured)).toHaveLength(1);
    expect(listFiles(dir).filter(file => file.endsWith('.json.gz'))).toHaveLength(1);
  });

  test('preserves prompt text while redacting credentials and replacing binary payloads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-audit-raw-redaction-'));
    const store = new RequestAuditRawCaptureStore({ dir, maxBytes: 1024 * 1024 });

    const result = await store.capture({
      requestId: 'redacted',
      timestamp: '2026-08-14T12:00:00.000Z',
      originalRequestBody: {
        input: 'keep this diagnostic prompt',
        authorization: 'Bearer private-token',
        api_key: 'private-api-key',
        x_api_key: 'private-x-api-key',
        client_secret: 'private-client-secret',
        id_token: 'private-id-token',
        session_token: 'private-session-token',
        headers: { 'x-custom-secret': 'private-header-value' },
        image_url: `data:image/png;base64,${'A'.repeat(20000)}`
      }
    });

    const raw = zlib.gunzipSync(fs.readFileSync(result.path)).toString('utf8');
    expect(raw).toContain('keep this diagnostic prompt');
    expect(raw).not.toContain('private-token');
    expect(raw).not.toContain('private-api-key');
    expect(raw).not.toContain('private-x-api-key');
    expect(raw).not.toContain('private-client-secret');
    expect(raw).not.toContain('private-id-token');
    expect(raw).not.toContain('private-session-token');
    expect(raw).not.toContain('private-header-value');
    expect(raw).not.toContain('AAAAAA');
    expect(raw).toContain('[binary-redacted');
  });

  test('bounded snapshot stops reading object properties after its entry limit', () => {
    let propertyReads = 0;
    const originalRequestBody = {};
    for (let index = 0; index < 100; index += 1) {
      Object.defineProperty(originalRequestBody, `field-${index}`, {
        enumerable: true,
        get() {
          propertyReads += 1;
          return 'x'.repeat(100);
        }
      });
    }

    const snapshot = buildBoundedRawCaptureEvent({
      requestId: 'bounded-properties',
      timestamp: '2026-07-23T00:00:00.000Z',
      request: { model: 'gpt-5.5' }
    }, { originalRequestBody }, 4096);

    expect(propertyReads).toBeLessThanOrEqual(50);
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThanOrEqual(4096);
  });

  test('bounded snapshot uses one global traversal budget across deeply branching getters', () => {
    let propertyReads = 0;
    const branchingObject = depth => {
      const value = {};
      for (let index = 0; index < 20; index += 1) {
        Object.defineProperty(value, `branch-${depth}-${index}`, {
          enumerable: true,
          get() {
            propertyReads += 1;
            return depth === 1 ? 'x'.repeat(64) : branchingObject(depth - 1);
          }
        });
      }
      return value;
    };

    const snapshot = buildBoundedRawCaptureEvent({
      requestId: 'global-budget',
      timestamp: '2026-07-23T00:00:00.000Z',
      request: { model: 'gpt-5.5' }
    }, { originalRequestBody: branchingObject(4) }, 1024);

    expect(propertyReads).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThanOrEqual(1024);
  });
});

function listFiles(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...listFiles(fullPath));
    else result.push(fullPath);
  }
  return result;
}
