import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyCleanupEvent,
  createUnknownUsageCleanupBundle,
  discoverEstimatedAverageDates,
} from '../../scripts/ops/cleanup-unknown-usage-2026-08-14-15.mjs';
import { applyRepairBundle, hashSecret } from '../../scripts/usage-ledger/daily-usage-ledger.mjs';

function makeEvent(overrides = {}) {
  const event = {
    timestamp: '2026-08-13T16:10:00.000Z',
    beijingDate: '2026-08-14',
    beijingHour: '00',
    requestId: 'cleanup-1',
    request: { toProvider: 'openai-codex-oauth', actualModel: 'gpt-5' },
    potluckKey: { present: false },
    account: { providerUuid: 'provider-1', accountEmail: 'known@example.com' },
    status: { outcome: 'success' },
    usage: { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 },
  };
  return {
    ...event,
    ...overrides,
    request: { ...event.request, ...(overrides.request || {}) },
    potluckKey: { ...event.potluckKey, ...(overrides.potluckKey || {}) },
    account: { ...event.account, ...(overrides.account || {}) },
    usage: { ...event.usage, ...(overrides.usage || {}) },
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeCleanupBase(events) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'unknown-cleanup-'));
  const auditDir = path.join(base, 'request-audit');
  fs.mkdirSync(auditDir, { recursive: true });
  for (const utcDate of ['2026-08-13', '2026-08-14', '2026-08-15']) {
    const rows = events.filter(event => event.timestamp.startsWith(utcDate));
    fs.writeFileSync(path.join(auditDir, `audit-${utcDate}.jsonl`), rows.length > 0
      ? `${rows.map(JSON.stringify).join('\n')}\n`
      : '');
  }
  writeJson(path.join(base, 'api-potluck-keys.json'), { config: {}, keys: {} });
  writeJson(path.join(base, 'model-usage-stats.json'), {
    summary: {}, providers: {}, accounts: {}, accountUsageEvents: {}, daily: {},
  });
  return base;
}

test('classifyCleanupEvent keeps only fully attributable priced events', () => {
  const knownKeyHash = hashSecret('sk-known');
  const options = {
    providerByEmail: new Map([['known@example.com', 'openai-codex-oauth']]),
    knownPotluckKeyHashes: new Set([knownKeyHash]),
  };

  assert.deepEqual(classifyCleanupEvent(makeEvent({
    request: { toProvider: 'unknown' },
    potluckKey: { present: true, hash: knownKeyHash },
  }), options).reasons, []);

  assert.ok(classifyCleanupEvent(makeEvent({
    request: { toProvider: 'unknown' },
    account: { providerUuid: null, accountEmail: 'unmapped@example.com' },
  }), options).reasons.includes('unknown-provider'));
  assert.ok(classifyCleanupEvent(makeEvent({
    request: { actualModel: 'unknown' },
  }), options).reasons.includes('unknown-model'));
  assert.ok(classifyCleanupEvent(makeEvent({
    account: { providerUuid: null, accountEmail: null },
  }), options).reasons.includes('unknown-account'));
  assert.ok(classifyCleanupEvent(makeEvent({
    request: { actualModel: 'unpriced-test-model' },
  }), options).reasons.includes('missing-price'));
  assert.ok(classifyCleanupEvent(makeEvent({
    potluckKey: { present: true, hash: 'sha256:not-configured' },
  }), options).reasons.includes('unknown-key'));
});

test('classifyCleanupEvent recovers a real requested model when actualModel is unknown', () => {
  const result = classifyCleanupEvent(makeEvent({
    request: { actualModel: 'unknown', model: 'gpt-5.4-mini' },
  }), {
    providerByEmail: new Map([['known@example.com', 'openai-codex-oauth']]),
  });

  assert.equal(result.keep, true);
  assert.equal(result.model, 'gpt-5.4-mini');
  assert.ok(result.cost.actualUsd > 0);
});

test('discovers every date containing estimated-average derived usage', async () => {
  const base = makeCleanupBase([]);
  const dailyDir = path.join(base, 'permanent-usage-ledger', 'daily');
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.writeFileSync(path.join(dailyDir, 'usage-2026-08-12.jsonl'), `${JSON.stringify({
    date: '2026-08-12',
    cost: { pricingSource: 'official', estimatedPriceTokens: 0 },
  })}\n`);
  fs.writeFileSync(path.join(dailyDir, 'usage-2026-08-14.jsonl'), `${JSON.stringify({
    date: '2026-08-14',
    cost: { pricingSource: 'estimated-average', estimatedPriceTokens: 1100 },
  })}\n`);
  fs.writeFileSync(path.join(dailyDir, 'usage-2026-08-15.jsonl'), `${JSON.stringify({
    date: '2026-08-15',
    cost: { pricingSource: 'mixed', estimatedPriceTokens: 500 },
  })}\n`);

  assert.deepEqual(await discoverEstimatedAverageDates(base), ['2026-08-14', '2026-08-15']);
});

test('cleanup bundle blocks when estimated removed usage reaches $1,000', async () => {
  const known = makeEvent({
    requestId: 'known-priced',
    usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 },
  });
  const unknown = makeEvent({
    requestId: 'unknown-large',
    request: { actualModel: 'unknown' },
    usage: { promptTokens: 2_000_000_000, completionTokens: 0, totalTokens: 2_000_000_000 },
  });
  const base = makeCleanupBase([known, unknown]);

  await assert.rejects(() => createUnknownUsageCleanupBundle({
    base,
    outDir: path.join(base, 'cleanup-output'),
    now: new Date('2026-08-16T08:00:00.000Z'),
  }), /reaches approval threshold \$1000/);
});

test('cleanup bundle removes unresolved derived usage below the threshold without changing audit', async () => {
  const known = makeEvent({
    requestId: 'known-priced',
    usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 },
  });
  const unknown = makeEvent({
    requestId: 'unknown-small',
    request: { actualModel: 'unknown' },
    usage: { promptTokens: 100_000_000, completionTokens: 0, totalTokens: 100_000_000 },
  });
  const base = makeCleanupBase([known, unknown]);
  const modelStatsPath = path.join(base, 'model-usage-stats.json');
  const knownUsage = { requestCount: 1, promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 1_000_000 };
  const unknownUsage = { requestCount: 1, promptTokens: 100_000_000, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 100_000_000 };
  const combinedUsage = { requestCount: 2, promptTokens: 101_000_000, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 101_000_000 };
  writeJson(modelStatsPath, {
    summary: combinedUsage,
    providers: {
      'openai-codex-oauth': {
        summary: combinedUsage,
        models: { 'gpt-5': knownUsage, unknown: unknownUsage },
      },
    },
    accounts: {},
    accountUsageEvents: {},
    daily: {
      '2026-08-14': {
        ...combinedUsage,
        models: { 'gpt-5': knownUsage, unknown: unknownUsage },
        accounts: {},
      },
    },
  });
  const auditPath = path.join(base, 'request-audit', 'audit-2026-08-13.jsonl');
  const auditBefore = fs.readFileSync(auditPath, 'utf8');
  const outDir = path.join(base, 'cleanup-output');
  const bundle = await createUnknownUsageCleanupBundle({
    base,
    outDir,
    now: new Date('2026-08-16T08:00:00.000Z'),
  });

  assert.deepEqual(bundle.manifest.eligibleDates, ['2026-08-14', '2026-08-15']);
  assert.equal(bundle.report.cleanupMetadata.droppedEvents, 1);
  assert.equal(bundle.report.cleanupMetadata.droppedTokens, 100_000_000);
  assert.ok(bundle.report.cleanupMetadata.estimatedRemovalUsd > 0);
  assert.ok(bundle.report.cleanupMetadata.estimatedRemovalUsd < 1_000);
  assert.match(bundle.report.cleanupMetadata.batchId, /^estimated-average:/);
  assert.ok(fs.existsSync(path.join(outDir, 'quarantine-events.jsonl')));
  const quarantine = fs.readFileSync(path.join(outDir, 'quarantine-events.jsonl'), 'utf8');
  assert.ok(quarantine.includes('unknown-small'));
  assert.ok(!quarantine.includes('known@example.com'));

  const result = await applyRepairBundle({
    base,
    bundle: outDir,
    approvedManifestSha256: bundle.manifestSha256,
    approvedReportSha256: bundle.reportSha256,
    backupDir: path.join(base, 'cleanup-backup'),
    now: new Date('2026-08-16T08:10:00.000Z'),
  });
  assert.equal(result.status, 'applied');

  const repaired = JSON.parse(fs.readFileSync(modelStatsPath, 'utf8'));
  assert.equal(repaired.summary.requestCount, 1);
  assert.equal(repaired.summary.totalTokens, 1_000_000);
  assert.equal(repaired.daily['2026-08-14'].requestCount, 1);
  assert.equal(repaired.daily['2026-08-14'].totalTokens, 1_000_000);
  assert.equal(repaired.daily['2026-08-14'].models.unknown, undefined);
  assert.equal(fs.readFileSync(auditPath, 'utf8'), auditBefore);
});
