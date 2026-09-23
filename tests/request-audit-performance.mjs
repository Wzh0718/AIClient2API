// Isolated synthetic benchmark: node --expose-gc tests/request-audit-performance.mjs [report.json]
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GptRequestStore } from '../src/plugins/request-audit/gpt-request-store.js';
import { buildAuditSummary } from '../src/plugins/request-audit/api-routes.js';
import { RequestAuditAnalysisStore } from '../src/plugins/request-audit/analysis-store.js';

const reports = [];
function measure(fn, runs = 3) {
  const times = [], heaps = [];
  let result;
  for (let i = 0; i < runs; i++) {
    result = null;
    global.gc?.();
    const before = process.memoryUsage().heapUsed, start = performance.now();
    result = fn();
    times.push(performance.now() - start);
    heaps.push(process.memoryUsage().heapUsed - before);
  }
  return { medianMs: +times.sort((a, b) => a - b)[Math.floor(runs / 2)].toFixed(2), heapDeltaMB: +(Math.max(...heaps) / 1048576).toFixed(2), result };
}
function fixture(i) {
  return { requestId: `r${String(i).padStart(7, '0')}`, timestamp: new Date(Date.UTC(2026, 8, 20) + i * 1000).toISOString(),
    request: { model: `gpt-${i % 3}`, requestedModel: `gpt-${i % 3}`, toProvider: 'openai-codex-oauth' },
    potluckKey: { hash: `key-${i % 10}` }, account: { providerNameDisplay: `account-${i % 5}`, providerUuidHash: `cred-${i % 5}` },
    status: { outcome: i % 7 ? 'success' : 'upstream_error' }, response: { durationMs: i % 100 === 0 ? null : i % 35000 },
    usage: { promptTokens: 1000, cachedTokens: 800, completionTokens: 50, totalTokens: 1050 },
    cost: { usd: 0.125, actualUsd: 0.125, estimatedUsd: 0, pricingSource: 'official' },
    contextBreakdown: { sections: [{ id: 'tools', tokens: 400 }, { id: 'conversation', calibratedTokens: 600 }] },
    // Safe synthetic metadata represents an event with request/response diagnostics, not a real prompt.
    syntheticMetadata: Array.from({ length: 20 }, (_, n) => ({ index: n, fingerprint: 'a'.repeat(64), count: n })) };
}
for (const count of [10000, 100000]) {
  const store = await new GptRequestStore({ dbPath: ':memory:' }).init();
  try {
    for (let i = 0; i < count; i += 500) store.appendBatch(Array.from({ length: 500 }, (_, j) => fixture(i + j)));
    const cursor = Buffer.from(JSON.stringify([fixture(Math.floor(count / 10)).timestamp, fixture(Math.floor(count / 10)).requestId])).toString('base64url');
    const first = measure(() => store.query({ limit: 50 }));
    const deep = measure(() => store.query({ limit: 50, cursor }));
    const filtered = measure(() => store.query({ limit: 50, cursor, keyHash: 'key-1' }));
    const legacy = measure(() => buildAuditSummary(store.queryAll({})));
    const sql = measure(() => store.querySummary({}));
    assert.deepEqual(sql.result, legacy.result);
    const { clauses, params } = store.buildFilter({ cursor, keyHash: 'key-1' });
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT payload_json FROM gpt_requests WHERE ${clauses.join(' AND ')} ORDER BY timestamp DESC, request_id DESC LIMIT 51`).all(params);
    const legacyCursor = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    const oldDeep = measure(() => store.db.prepare('SELECT payload_json FROM gpt_requests WHERE (timestamp < ? OR (timestamp = ? AND request_id < ?)) ORDER BY timestamp DESC, request_id DESC LIMIT 51')
      .all(legacyCursor[0], legacyCursor[0], legacyCursor[1]).map(row => JSON.parse(row.payload_json)));
    const compact = ({ result, ...stats }) => stats;
    reports.push({ count, eventBytes: Buffer.byteLength(JSON.stringify(fixture(1))), firstPage: compact(first), deepPage: compact(deep), filteredDeepPage: compact(filtered), legacyDeepPage: compact(oldDeep), legacySummary: compact(legacy), sqlSummary: compact(sql), queryPlan: plan.map(row => row.detail) });
    console.log(JSON.stringify(reports.at(-1)));
  } finally { store.close(); }
}
const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-perf-'));
try {
  const store = new RequestAuditAnalysisStore({ dir });
  await store.writeDiagnostics(Array.from({ length: 10000 }, (_, i) => ({ requestId: `r${i}`, primaryReason: 'fixture' })));
  const start = performance.now();
  await store.readDiagnostics({ requestIds: ['r1', 'r9999'] });
  const coldMs = performance.now() - start;
  const warmStart = performance.now();
  await store.readDiagnostics({ requestIds: ['r1', 'r9999'] });
  const warmMs = performance.now() - warmStart;
  reports.push({ diagnostics: { count: 10000, coldMs: +coldMs.toFixed(2), warmMs: +warmMs.toFixed(2), cachedFiles: store.fileCache.size, accountedCacheBytes: store.cacheBytes } });
  console.log(JSON.stringify(reports.at(-1)));
} finally { await rm(dir, { recursive: true }); }
if (process.argv[2]) {
  await mkdir(path.dirname(process.argv[2]), { recursive: true });
  await writeFile(process.argv[2], JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, note: 'Synthetic in-memory SQLite; median of 3 runs; JS heap delta is not peak RSS.', reports }, null, 2));
}
