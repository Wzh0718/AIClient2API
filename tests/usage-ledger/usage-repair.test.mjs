import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyRepairBundle,
  createRepairBundle,
  discoverRepairAuditFiles,
  hashSecret,
  scanRepairAuditFiles,
} from '../../scripts/usage-ledger/daily-usage-ledger.mjs';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-repair-'));
}

function usageBucket(requestCount, totalTokens, overrides = {}) {
  return {
    requestCount,
    promptTokens: totalTokens,
    cachedTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens,
    maxQps: 7,
    maxRpm: 8,
    maxTps: 9,
    lastUsedAt: '2026-07-21T01:00:00.000Z',
    ...overrides,
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function makeEligibleRepairFixture({ missingModelDay = false } = {}) {
  const base = makeTempDir();
  const auditDir = path.join(base, 'request-audit');
  const outDir = path.join(base, 'repair-output');
  fs.mkdirSync(auditDir, { recursive: true });
  const rawKey = 'sk-potluck-apply-secret';
  const keyHash = hashSecret(rawKey);
  const oldDay = {
    summary: usageBucket(1, 5),
    providers: { 'openai-codex-oauth': usageBucket(1, 5) },
    models: { 'gpt-5.6': usageBucket(1, 5) },
    accounts: {},
    hours: {},
  };
  writeJson(path.join(base, 'api-potluck-keys.json'), {
    config: {},
    keys: {
      [rawKey]: {
        name: 'Apply Key', enabled: true, dailyLimit: 500,
        todayUsage: 9, totalUsage: 10,
        totalPromptTokens: 50, totalCompletionTokens: 0,
        totalReasoningTokens: 0, totalTokens: 50, totalCachedTokens: 0,
        totalModels: { 'gpt-5.6': usageBucket(10, 50) },
        maxQps: 30, maxRpm: 40, maxTps: 50,
        usageHistory: {
          '2026-07-20': { ...oldDay, summary: usageBucket(3, 30) },
          '2026-07-21': oldDay,
        },
      },
    },
  });
  writeJson(path.join(base, 'model-usage-stats.json'), {
    updatedAt: '2026-07-22T00:00:00.000Z',
    summary: usageBucket(10, 50),
    providers: {
      'openai-codex-oauth': { summary: usageBucket(10, 50), models: { 'gpt-5.6': usageBucket(10, 50) } },
    },
    accounts: {}, accountUsageEvents: {},
    daily: {
      '2026-07-20': { ...usageBucket(3, 30), models: { 'gpt-5.6': usageBucket(3, 30) }, accounts: {} },
      ...(!missingModelDay ? {
        '2026-07-21': { ...usageBucket(1, 5), models: { 'gpt-5.6': usageBucket(1, 5) }, accounts: {} },
      } : {}),
    },
  });
  const events = [
    {
      timestamp: '2026-07-20T16:10:00.000Z', beijingDate: '2026-07-21', beijingHour: '00', requestId: 'apply-1',
      request: { toProvider: 'openai-codex-oauth', actualModel: 'gpt-5.6' },
      potluckKey: { present: true, hash: keyHash, name: 'Apply Key' },
      account: { providerUuid: 'provider-1', accountEmail: 'apply@example.com' },
      status: { outcome: 'success' }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    },
    {
      timestamp: '2026-07-20T16:20:00.000Z', beijingDate: '2026-07-21', beijingHour: '00', requestId: 'apply-2',
      request: { toProvider: 'openai-codex-oauth', actualModel: 'gpt-5.6' },
      potluckKey: { present: true, hash: keyHash, name: 'Apply Key' },
      account: { providerUuid: 'provider-1', accountEmail: 'apply@example.com' },
      status: { outcome: 'success' }, usage: {},
    },
  ];
  fs.writeFileSync(path.join(auditDir, 'audit-2026-07-20.jsonl'), `${events.map(JSON.stringify).join('\n')}\n`);
  fs.writeFileSync(path.join(auditDir, 'audit-2026-07-21.jsonl'), '');
  const bundle = await createRepairBundle({
    base, from: '2026-07-21', to: '2026-07-21', outDir,
    now: new Date('2026-07-23T00:00:00.000Z'),
  });
  return { base, outDir, rawKey, bundle };
}

test('discoverRepairAuditFiles includes active and archived UTC boundary files but excludes tmp files', async () => {
  const root = makeTempDir();
  const auditDir = path.join(root, 'request-audit');
  const archiveDir = path.join(auditDir, 'archived-large');
  fs.mkdirSync(archiveDir, { recursive: true });

  const names = [
    'audit-2026-07-19.jsonl',
    'audit-2026-07-20.jsonl',
    'audit-2026-07-21.jsonl',
    'audit-2026-07-22.jsonl',
    'audit-2026-07-23.jsonl',
    'audit-2026-07-24.jsonl',
    'audit-2026-07-21.jsonl.123.tmp',
  ];
  for (const name of names) fs.writeFileSync(path.join(auditDir, name), '');
  fs.writeFileSync(path.join(archiveDir, 'audit-2026-07-21.jsonl.20260721T120000000Z'), '');
  fs.writeFileSync(path.join(archiveDir, 'audit-2026-07-22.jsonl.20260722T120000000Z.tmp'), '');

  const files = await discoverRepairAuditFiles({
    auditDir,
    from: '2026-07-20',
    to: '2026-07-22',
  });

  assert.deepEqual(files.map(file => path.relative(auditDir, file).replaceAll('\\', '/')), [
    'audit-2026-07-19.jsonl',
    'audit-2026-07-20.jsonl',
    'audit-2026-07-21.jsonl',
    'archived-large/audit-2026-07-21.jsonl.20260721T120000000Z',
    'audit-2026-07-22.jsonl',
    'audit-2026-07-23.jsonl',
  ]);
});

test('scanRepairAuditFiles streams, deduplicates by quality, counts zero-token successes, and reports corrupt lines', async () => {
  const root = makeTempDir();
  const first = path.join(root, 'audit-2026-07-20.jsonl');
  const second = path.join(root, 'audit-2026-07-21.jsonl');
  const baseEvent = {
    timestamp: '2026-07-20T16:10:00.000Z',
    beijingDate: '2026-07-21',
    beijingHour: '00',
    request: { toProvider: 'openai-codex-oauth', actualModel: 'gpt-5.6' },
    potluckKey: { present: true, hash: 'sha256:known' },
    account: { providerUuid: 'provider-1' },
    status: { outcome: 'success' },
  };
  fs.writeFileSync(first, [
    JSON.stringify({ ...baseEvent, requestId: 'request-1', usage: { promptTokens: 10, totalTokens: 10 } }),
    JSON.stringify({ ...baseEvent, requestId: 'request-2', usage: {} }),
    JSON.stringify({ ...baseEvent, requestId: 'request-failed', status: { outcome: 'error' }, usage: { totalTokens: 50 } }),
    '{broken-json',
    '',
  ].join('\n'));
  fs.writeFileSync(second, `${JSON.stringify({
    ...baseEvent,
    requestId: 'request-1',
    account: { providerUuid: 'provider-1', accountEmail: 'person@example.com' },
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  })}\n`);

  const result = await scanRepairAuditFiles({
    files: [first, second],
    from: '2026-07-21',
    to: '2026-07-21',
  });

  assert.equal(result.events.length, 2);
  assert.equal(result.events.find(event => event.requestId === 'request-1').usage.totalTokens, 15);
  assert.equal(result.events.find(event => event.requestId === 'request-2').usage.totalTokens, 0);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.nonSuccessCount, 1);
  assert.equal(result.zeroTokenSuccessCount, 1);
  assert.equal(result.parseErrors.length, 1);
  assert.equal(result.sourceFiles.length, 2);
  assert.match(result.sourceFiles[0].sha256, /^[a-f0-9]{64}$/);
});

test('scanRepairAuditFiles emits deduplicated events without retaining them when collectEvents is disabled', async () => {
  const root = makeTempDir();
  const first = path.join(root, 'audit-2026-07-20.jsonl');
  const second = path.join(root, 'audit-2026-07-21.jsonl');
  const baseEvent = {
    timestamp: '2026-07-20T16:10:00.000Z',
    beijingDate: '2026-07-21',
    request: { toProvider: 'openai-codex-oauth', actualModel: 'gpt-5.6' },
    potluckKey: { present: false },
    account: { providerUuid: 'provider-1' },
    status: { outcome: 'success' },
  };
  fs.writeFileSync(first, `${JSON.stringify({
    ...baseEvent,
    requestId: 'request-1',
    usage: { promptTokens: 10, totalTokens: 10 },
  })}\n`);
  fs.writeFileSync(second, [
    JSON.stringify({
      ...baseEvent,
      requestId: 'request-1',
      account: { providerUuid: 'provider-1', accountEmail: 'best@example.com' },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }),
    JSON.stringify({ ...baseEvent, requestId: 'request-2', usage: {} }),
    '',
  ].join('\n'));

  const emitted = [];
  const result = await scanRepairAuditFiles({
    files: [first, second],
    from: '2026-07-21',
    to: '2026-07-21',
    collectEvents: false,
    onEvent: event => emitted.push(event),
  });

  assert.equal(result.events, undefined);
  assert.equal(result.includedEventCount, 2);
  assert.deepEqual(emitted.map(event => [event.requestId, event.usage.totalTokens]), [
    ['request-1', 15],
    ['request-2', 0],
  ]);
  assert.match(result.sourceEventDigest, /^[a-f0-9]{64}$/);
});

test('createRepairBundle builds an eligible synchronized repair without exposing raw key or email in report', async () => {
  const base = makeTempDir();
  const auditDir = path.join(base, 'request-audit');
  const outDir = path.join(base, 'repair-output');
  fs.mkdirSync(auditDir, { recursive: true });
  const rawKey = 'sk-potluck-production-secret';
  const keyHash = hashSecret(rawKey);
  const currentDay = {
    summary: usageBucket(1, 5),
    providers: { 'openai-codex-oauth': usageBucket(1, 5) },
    models: { 'gpt-5.6': usageBucket(1, 5) },
    accounts: {},
    hours: {},
  };
  writeJson(path.join(base, 'api-potluck-keys.json'), {
    config: {},
    keys: {
      [rawKey]: {
        name: 'Production Key',
        enabled: true,
        dailyLimit: 500,
        todayUsage: 9,
        totalUsage: 10,
        totalPromptTokens: 50,
        totalCompletionTokens: 0,
        totalReasoningTokens: 0,
        totalTokens: 50,
        totalCachedTokens: 0,
        totalModels: { 'gpt-5.6': usageBucket(10, 50) },
        maxQps: 30,
        maxRpm: 40,
        maxTps: 50,
        usageHistory: { '2026-07-21': currentDay },
      },
    },
  });
  writeJson(path.join(base, 'model-usage-stats.json'), {
    updatedAt: '2026-07-22T00:00:00.000Z',
    summary: usageBucket(10, 50),
    providers: {
      'openai-codex-oauth': { summary: usageBucket(10, 50), models: { 'gpt-5.6': usageBucket(10, 50) } },
    },
    accounts: {},
    accountUsageEvents: {},
    daily: {
      '2026-07-21': { ...usageBucket(1, 5), models: { 'gpt-5.6': usageBucket(1, 5) }, accounts: {} },
    },
  });

  const events = [
    {
      timestamp: '2026-07-20T16:10:00.000Z',
      beijingDate: '2026-07-21',
      beijingHour: '00',
      requestId: 'request-1',
      request: { toProvider: 'openai-codex-oauth', actualModel: 'gpt-5.6' },
      potluckKey: { present: true, hash: keyHash, name: 'Production Key' },
      account: { providerUuid: 'provider-1', accountEmail: 'person@example.com' },
      status: { outcome: 'success' },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    },
    {
      timestamp: '2026-07-20T16:20:00.000Z',
      beijingDate: '2026-07-21',
      beijingHour: '00',
      requestId: 'request-2',
      request: { toProvider: 'openai-codex-oauth', actualModel: 'gpt-5.6' },
      potluckKey: { present: true, hash: keyHash, name: 'Production Key' },
      account: { providerUuid: 'provider-1', accountEmail: 'person@example.com' },
      status: { outcome: 'success' },
      usage: {},
    },
  ];
  fs.writeFileSync(path.join(auditDir, 'audit-2026-07-20.jsonl'), `${events.map(JSON.stringify).join('\n')}\n`);
  fs.writeFileSync(path.join(auditDir, 'audit-2026-07-21.jsonl'), '');

  const result = await createRepairBundle({
    base,
    from: '2026-07-21',
    to: '2026-07-21',
    outDir,
    now: new Date('2026-07-23T00:00:00.000Z'),
  });

  assert.equal(result.report.days[0].eligible, true);
  assert.equal(result.report.days[0].candidate.potluck.requestCount, 2);
  assert.equal(result.report.days[0].candidate.potluck.totalTokens, 15);
  assert.equal(result.report.days[0].candidate.modelStats.requestCount, 2);
  assert.equal(result.report.days[0].candidate.modelStats.totalTokens, 15);
  assert.equal(result.report.days[0].unknownPotluckKeys, 0);
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
  assert.match(result.reportSha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(outDir, 'patch.json')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'ledger', 'daily', 'usage-2026-07-21.jsonl')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'ledger', 'hourly', 'usage-2026-07-21.jsonl')), true);
  const reportText = fs.readFileSync(path.join(outDir, 'report.json'), 'utf8');
  assert.equal(reportText.includes(rawKey), false);
  assert.equal(reportText.includes('person@example.com'), false);
});

test('applyRepairBundle rejects unapproved hashes without changing production files', async () => {
  const fixture = await makeEligibleRepairFixture();
  const potluckPath = path.join(fixture.base, 'api-potluck-keys.json');
  const before = fs.readFileSync(potluckPath, 'utf8');

  await assert.rejects(() => applyRepairBundle({
    base: fixture.base,
    bundle: fixture.outDir,
    approvedManifestSha256: '0'.repeat(64),
    approvedReportSha256: fixture.bundle.reportSha256,
    backupDir: path.join(fixture.base, 'backup-rejected'),
  }), /manifest approval hash mismatch/);

  assert.equal(fs.readFileSync(potluckPath, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(fixture.base, 'backup-rejected')), false);
});

test('applyRepairBundle updates approved dates by delta, preserves live fields and peaks, and is idempotent', async () => {
  const fixture = await makeEligibleRepairFixture();
  const options = {
    base: fixture.base,
    bundle: fixture.outDir,
    approvedManifestSha256: fixture.bundle.manifestSha256,
    approvedReportSha256: fixture.bundle.reportSha256,
    backupDir: path.join(fixture.base, 'repair-backup'),
    now: new Date('2026-07-23T01:00:00.000Z'),
  };

  const applied = await applyRepairBundle(options);
  assert.equal(applied.status, 'applied');
  const potluck = JSON.parse(fs.readFileSync(path.join(fixture.base, 'api-potluck-keys.json'), 'utf8'));
  const key = potluck.keys[fixture.rawKey];
  assert.equal(key.todayUsage, 9);
  assert.equal(key.totalUsage, 11);
  assert.equal(key.totalTokens, 60);
  assert.equal(key.maxQps, 30);
  assert.equal(key.usageHistory['2026-07-20'].summary.totalTokens, 30);
  assert.equal(key.usageHistory['2026-07-21'].summary.requestCount, 2);
  assert.equal(key.usageHistory['2026-07-21'].summary.totalTokens, 15);
  assert.equal(key.usageHistory['2026-07-21'].summary.maxQps, 7);

  const modelStats = JSON.parse(fs.readFileSync(path.join(fixture.base, 'model-usage-stats.json'), 'utf8'));
  assert.equal(modelStats.summary.requestCount, 11);
  assert.equal(modelStats.summary.totalTokens, 60);
  assert.equal(modelStats.daily['2026-07-20'].totalTokens, 30);
  assert.equal(modelStats.daily['2026-07-21'].requestCount, 2);
  assert.equal(modelStats.daily['2026-07-21'].maxQps, 7);
  assert.equal(fs.existsSync(path.join(fixture.base, 'permanent-usage-ledger', 'daily', 'usage-2026-07-21.jsonl')), true);
  assert.equal(fs.existsSync(path.join(fixture.base, 'permanent-usage-ledger', 'hourly', 'usage-2026-07-21.jsonl')), true);

  const repeated = await applyRepairBundle(options);
  assert.equal(repeated.status, 'already-applied');
});

test('applyRepairBundle treats a missing previous model day as an empty usage bucket', async () => {
  const fixture = await makeEligibleRepairFixture({ missingModelDay: true });

  const applied = await applyRepairBundle({
    base: fixture.base,
    bundle: fixture.outDir,
    approvedManifestSha256: fixture.bundle.manifestSha256,
    approvedReportSha256: fixture.bundle.reportSha256,
    backupDir: path.join(fixture.base, 'repair-backup-missing-model-day'),
    now: new Date('2026-07-23T01:00:00.000Z'),
  });

  assert.equal(applied.status, 'applied');
  const modelStats = JSON.parse(fs.readFileSync(path.join(fixture.base, 'model-usage-stats.json'), 'utf8'));
  assert.equal(modelStats.daily['2026-07-21'].requestCount, 2);
  assert.equal(modelStats.daily['2026-07-21'].totalTokens, 15);
});

test('createRepairBundle blocks dates with unknown potluck keys or corrupt required source lines', async () => {
  const fixture = await makeEligibleRepairFixture();
  const auditFile = path.join(fixture.base, 'request-audit', 'audit-2026-07-20.jsonl');
  const events = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  events[0].potluckKey.hash = 'sha256:unknown';
  fs.writeFileSync(auditFile, `${events.map(JSON.stringify).join('\n')}\n{broken-json\n`);
  const outDir = path.join(fixture.base, 'blocked-output');

  const result = await createRepairBundle({
    base: fixture.base,
    from: '2026-07-21',
    to: '2026-07-21',
    outDir,
    now: new Date('2026-07-23T00:00:00.000Z'),
  });

  assert.equal(result.report.days[0].eligible, false);
  assert.equal(result.report.days[0].unknownPotluckKeys, 1);
  assert.deepEqual(result.report.days[0].corruptSourceDates, ['2026-07-20']);
  assert.equal(fs.existsSync(path.join(outDir, 'ledger', 'daily', 'usage-2026-07-21.jsonl')), false);
});

test('applyRepairBundle aborts when source events or approved historical slices change', async () => {
  const sourceFixture = await makeEligibleRepairFixture();
  const auditFile = path.join(sourceFixture.base, 'request-audit', 'audit-2026-07-20.jsonl');
  fs.appendFileSync(auditFile, `${JSON.stringify({
    timestamp: '2026-07-20T16:30:00.000Z', beijingDate: '2026-07-21', requestId: 'late-event',
    request: { toProvider: 'openai-codex-oauth', actualModel: 'gpt-5.6' },
    potluckKey: { present: false }, account: {}, status: { outcome: 'success' }, usage: {},
  })}\n`);
  await assert.rejects(() => applyRepairBundle({
    base: sourceFixture.base,
    bundle: sourceFixture.outDir,
    approvedManifestSha256: sourceFixture.bundle.manifestSha256,
    approvedReportSha256: sourceFixture.bundle.reportSha256,
    backupDir: path.join(sourceFixture.base, 'source-change-backup'),
  }), /source event digest changed/);

  const baselineFixture = await makeEligibleRepairFixture();
  const potluckPath = path.join(baselineFixture.base, 'api-potluck-keys.json');
  const potluck = JSON.parse(fs.readFileSync(potluckPath, 'utf8'));
  potluck.keys[baselineFixture.rawKey].usageHistory['2026-07-21'].summary.totalTokens = 6;
  writeJson(potluckPath, potluck);
  await assert.rejects(() => applyRepairBundle({
    base: baselineFixture.base,
    bundle: baselineFixture.outDir,
    approvedManifestSha256: baselineFixture.bundle.manifestSha256,
    approvedReportSha256: baselineFixture.bundle.reportSha256,
    backupDir: path.join(baselineFixture.base, 'baseline-change-backup'),
  }), /repair baseline changed/);
});

test('applyRepairBundle restores all targets when commit fails after a partial write', async () => {
  const fixture = await makeEligibleRepairFixture();
  const potluckPath = path.join(fixture.base, 'api-potluck-keys.json');
  const before = fs.readFileSync(potluckPath, 'utf8');

  await assert.rejects(() => applyRepairBundle({
    base: fixture.base,
    bundle: fixture.outDir,
    approvedManifestSha256: fixture.bundle.manifestSha256,
    approvedReportSha256: fixture.bundle.reportSha256,
    backupDir: path.join(fixture.base, 'rollback-backup'),
    replaceTargets: async targets => {
      fs.writeFileSync(targets[0].path, '{}\n');
      throw new Error('injected commit failure');
    },
  }), /injected commit failure/);

  assert.equal(fs.readFileSync(potluckPath, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(fixture.base, 'permanent-usage-ledger', 'repairs')), false);
});

test('daily-usage-ledger CLI exposes repair-report and prints approval hashes', async () => {
  const fixture = await makeEligibleRepairFixture();
  const cliOut = path.join(fixture.base, 'cli-output');
  const script = path.resolve('scripts/usage-ledger/daily-usage-ledger.mjs');
  const run = spawnSync(process.execPath, [
    script,
    'repair-report',
    '--base', fixture.base,
    '--from', '2026-07-21',
    '--to', '2026-07-21',
    '--out-dir', cliOut,
    '--now', '2026-07-23T00:00:00.000Z',
  ], { encoding: 'utf8' });

  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.match(output.manifestSha256, /^[a-f0-9]{64}$/);
  assert.match(output.reportSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(output.eligibleDates, ['2026-07-21']);
});

test('createRepairBundle refuses to delete a pre-existing output directory', async () => {
  const fixture = await makeEligibleRepairFixture();
  const outDir = path.join(fixture.base, 'existing-output');
  fs.mkdirSync(outDir);
  const sentinel = path.join(outDir, 'keep.txt');
  fs.writeFileSync(sentinel, 'keep');

  await assert.rejects(() => createRepairBundle({
    base: fixture.base,
    from: '2026-07-21',
    to: '2026-07-21',
    outDir,
    now: new Date('2026-07-23T00:00:00.000Z'),
  }), /out-dir already exists/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});

test('createRepairBundle does not allow higher totals to hide a model-dimension decrease', async () => {
  const fixture = await makeEligibleRepairFixture();
  const auditFile = path.join(fixture.base, 'request-audit', 'audit-2026-07-20.jsonl');
  const events = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const event of events) event.request.actualModel = 'gpt-5.6-other';
  fs.writeFileSync(auditFile, `${events.map(JSON.stringify).join('\n')}\n`);

  const result = await createRepairBundle({
    base: fixture.base,
    from: '2026-07-21',
    to: '2026-07-21',
    outDir: path.join(fixture.base, 'dimension-output'),
    now: new Date('2026-07-23T00:00:00.000Z'),
  });

  assert.equal(result.report.days[0].candidate.modelStats.totalTokens, 15);
  assert.equal(result.report.days[0].eligible, false);
  assert.equal(result.report.days[0].nonDecreasing.modelStatsDimensions, false);
});

test('applyRepairBundle aborts when an approved hourly ledger slice changes', async () => {
  const fixture = await makeEligibleRepairFixture();
  const hourlyPath = path.join(fixture.base, 'permanent-usage-ledger', 'hourly', 'usage-2026-07-21.jsonl');
  fs.mkdirSync(path.dirname(hourlyPath), { recursive: true });
  fs.writeFileSync(hourlyPath, `${JSON.stringify({ date: '2026-07-21', hour: '00', usage: { requestCount: 99, totalTokens: 99 } })}\n`);

  await assert.rejects(() => applyRepairBundle({
    base: fixture.base,
    bundle: fixture.outDir,
    approvedManifestSha256: fixture.bundle.manifestSha256,
    approvedReportSha256: fixture.bundle.reportSha256,
    backupDir: path.join(fixture.base, 'hourly-change-backup'),
  }), /repair baseline changed/);
});

test('applyRepairBundle idempotency marker rejects changed approved statistics slices', async () => {
  const fixture = await makeEligibleRepairFixture();
  const options = {
    base: fixture.base,
    bundle: fixture.outDir,
    approvedManifestSha256: fixture.bundle.manifestSha256,
    approvedReportSha256: fixture.bundle.reportSha256,
    backupDir: path.join(fixture.base, 'marker-backup'),
  };
  await applyRepairBundle(options);
  const potluckPath = path.join(fixture.base, 'api-potluck-keys.json');
  const potluck = JSON.parse(fs.readFileSync(potluckPath, 'utf8'));
  potluck.keys[fixture.rawKey].usageHistory['2026-07-21'].summary.totalTokens += 1;
  writeJson(potluckPath, potluck);

  await assert.rejects(() => applyRepairBundle(options), /repair marker exists but approved slices changed/);
});

test('createRepairBundle blocks unsafe old-provider attribution when candidate day spans multiple providers', async () => {
  const fixture = await makeEligibleRepairFixture();
  const auditFile = path.join(fixture.base, 'request-audit', 'audit-2026-07-20.jsonl');
  const events = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  events[1].request.toProvider = 'openaiResponses-custom';
  fs.writeFileSync(auditFile, `${events.map(JSON.stringify).join('\n')}\n`);

  const result = await createRepairBundle({
    base: fixture.base,
    from: '2026-07-21',
    to: '2026-07-21',
    outDir: path.join(fixture.base, 'provider-output'),
    now: new Date('2026-07-23T00:00:00.000Z'),
  });

  assert.equal(result.report.days[0].eligible, false);
  assert.equal(result.report.days[0].nonDecreasing.modelProviderAttribution, false);
});

test('current Beijing date repair requires an explicit stopped-service override', async () => {
  const fixture = await makeEligibleRepairFixture();
  const blocked = await createRepairBundle({
    base: fixture.base,
    from: '2026-07-21',
    to: '2026-07-21',
    outDir: path.join(fixture.base, 'current-date-blocked'),
    now: new Date('2026-07-21T12:00:00.000Z'),
  });
  assert.equal(blocked.report.days[0].eligible, false);

  const allowed = await createRepairBundle({
    base: fixture.base,
    from: '2026-07-21',
    to: '2026-07-21',
    outDir: path.join(fixture.base, 'current-date-allowed'),
    now: new Date('2026-07-21T12:00:00.000Z'),
    allowCurrentDate: true,
  });
  assert.equal(allowed.report.days[0].eligible, true);
  assert.equal(allowed.report.currentDateOverride, true);
});

test('allowDecreasing removes a fully filtered historical day and applies the negative delta idempotently', async () => {
  const fixture = await makeEligibleRepairFixture();
  const auditPath = path.join(fixture.base, 'request-audit', 'audit-2026-07-20.jsonl');
  const auditBefore = fs.readFileSync(auditPath, 'utf8');
  const outDir = path.join(fixture.base, 'decreasing-output');
  const modelStatsPath = path.join(fixture.base, 'model-usage-stats.json');
  const initialModelStats = JSON.parse(fs.readFileSync(modelStatsPath, 'utf8'));
  const accountKey = 'openai-codex-oauth:apply@example.com';
  const accountDay = {
    provider: 'openai-codex-oauth',
    providerUuid: 'apply@example.com',
    accountIdentity: 'apply@example.com',
    accountEmail: 'apply@example.com',
    providerUuids: ['provider-1'],
    providerName: null,
    summary: usageBucket(1, 5),
    models: { 'gpt-5.6': usageBucket(1, 5) },
  };
  initialModelStats.daily['2026-07-21'].accounts[accountKey] = accountDay;
  initialModelStats.accounts[accountKey] = {
    ...accountDay,
    summary: usageBucket(10, 50),
    models: { 'gpt-5.6': usageBucket(10, 50) },
  };
  writeJson(modelStatsPath, initialModelStats);

  const bundle = await createRepairBundle({
    base: fixture.base,
    from: '2026-07-21',
    to: '2026-07-21',
    outDir,
    now: new Date('2026-07-23T00:00:00.000Z'),
    allowDecreasing: true,
    eventFilter: () => false,
    cleanupMetadata: { operation: 'test-drop-all' },
  });

  assert.equal(bundle.report.days[0].eligible, true);
  assert.equal(bundle.report.days[0].candidate.potluck.requestCount, 0);
  assert.equal(bundle.report.days[0].candidate.modelStats.totalTokens, 0);
  assert.equal(bundle.report.allowDecreasing, true);
  assert.deepEqual(bundle.report.cleanupMetadata, { operation: 'test-drop-all' });

  const options = {
    base: fixture.base,
    bundle: outDir,
    approvedManifestSha256: bundle.manifestSha256,
    approvedReportSha256: bundle.reportSha256,
    backupDir: path.join(fixture.base, 'decreasing-backup'),
    now: new Date('2026-07-23T01:00:00.000Z'),
  };
  const applied = await applyRepairBundle(options);
  assert.equal(applied.status, 'applied');

  const potluck = JSON.parse(fs.readFileSync(path.join(fixture.base, 'api-potluck-keys.json'), 'utf8'));
  const key = potluck.keys[fixture.rawKey];
  assert.equal(key.usageHistory['2026-07-21'].summary.requestCount, 0);
  assert.equal(key.usageHistory['2026-07-21'].summary.totalTokens, 0);
  assert.equal(key.totalUsage, 9);
  assert.equal(key.totalTokens, 45);

  const modelStats = JSON.parse(fs.readFileSync(modelStatsPath, 'utf8'));
  assert.equal(modelStats.daily['2026-07-21'].requestCount, 0);
  assert.equal(modelStats.daily['2026-07-21'].totalTokens, 0);
  assert.equal(modelStats.summary.requestCount, 9);
  assert.equal(modelStats.summary.totalTokens, 45);
  assert.equal(fs.readFileSync(auditPath, 'utf8'), auditBefore);

  const repeated = await applyRepairBundle(options);
  assert.equal(repeated.status, 'already-applied');
});
