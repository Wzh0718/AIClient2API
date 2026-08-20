import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createLedgerRangeAggregator,
  getBeijingDateKey,
  listLedgerDates,
  readLedgerRangeStats,
  resolveRangeDates,
} from '../../src/plugins/api-potluck/ledger-range-stats.js';

function row({ date = '2026-07-05', provider = 'openai-codex-oauth', accountKey, accountEmail = 'user@example.com', model = 'gpt-5.5', requestCount = 1, totalTokens = 100, promptTokens = 80, completionTokens = 20, cachedTokens = 10, actualUsd = 0.01, missingPriceTokens = 0, keyHash = 'sha256:deadbeef' }) {
  return {
    date,
    provider,
    accountKey: accountKey || `${provider}:${accountEmail}`,
    accountEmail,
    accountIdentity: accountEmail,
    providerName: 'User',
    providerUuids: ['uuid-1'],
    key: 'maki_secret_should_not_leak',
    keyHash,
    keyPrefix: 'maki_secret...',
    model,
    usage: { requestCount, promptTokens, cachedTokens, completionTokens, reasoningTokens: 0, totalTokens },
    cost: { actualUsd, missingPriceTokens, pricingModel: model },
  };
}

test('aggregator groups rows by provider, model, and account with cost totals', () => {
  const aggregator = createLedgerRangeAggregator({ conversionModel: 'gemini-2.5-flash' });
  aggregator.addRow(row({ model: 'gpt-5.5', totalTokens: 100, requestCount: 2, actualUsd: 0.02 }));
  aggregator.addRow(row({ model: 'gpt-5.4-mini', totalTokens: 50, requestCount: 1, actualUsd: 0.01 }));
  aggregator.addRow(row({ accountEmail: 'other@example.com', model: 'gpt-5.5', totalTokens: 30, requestCount: 1, actualUsd: 0.003 }));

  const result = aggregator.result();

  assert.equal(result.summary.requestCount, 4);
  assert.equal(result.summary.totalTokens, 180);
  assert.ok(Math.abs(result.summary.cost.actualUsd - 0.00205325) < 1e-12);
  assert.ok(result.summary.cost.convertedUsd > 0);
  assert.equal(result.summary.cost.conversionModel, 'gemini-2.5-flash');

  assert.deepEqual(Object.keys(result.providers), ['openai-codex-oauth']);
  assert.equal(result.providers['openai-codex-oauth'].totalTokens, 180);

  assert.deepEqual(Object.keys(result.models).sort(), ['gpt-5.4-mini', 'gpt-5.5']);
  assert.equal(result.models['gpt-5.5'].totalTokens, 130);

  const accountNames = Object.keys(result.accounts).sort();
  assert.deepEqual(accountNames, [
    'openai-codex-oauth:other@example.com',
    'openai-codex-oauth:user@example.com',
  ]);
  assert.equal(result.accounts['openai-codex-oauth:user@example.com'].summary.totalTokens, 150);
  assert.equal(result.accounts['openai-codex-oauth:user@example.com'].models['gpt-5.5'].totalTokens, 100);
});

test('aggregator keeps same-named models separated by provider', () => {
  const aggregator = createLedgerRangeAggregator({ conversionModel: 'gemini-2.5-flash' });
  aggregator.addRow(row({
    provider: 'openai-codex-oauth',
    model: 'shared-model',
    totalTokens: 120,
    requestCount: 2,
  }));
  aggregator.addRow(row({
    provider: 'gemini-antigravity',
    accountEmail: 'gemini@example.com',
    model: 'shared-model',
    totalTokens: 80,
    requestCount: 1,
  }));

  const result = aggregator.result();

  assert.equal(result.models['shared-model'].totalTokens, 200);
  assert.equal(result.providerModels['openai-codex-oauth']['shared-model'].totalTokens, 120);
  assert.equal(result.providerModels['openai-codex-oauth']['shared-model'].requestCount, 2);
  assert.equal(result.providerModels['gemini-antigravity']['shared-model'].totalTokens, 80);
  assert.equal(result.providerModels['gemini-antigravity']['shared-model'].requestCount, 1);
});

test('aggregator reprices stale GPT-5.6 ledger rows with current prices', () => {
  const aggregator = createLedgerRangeAggregator({ conversionModel: 'gemini-2.5-flash' });
  const usage = {
    promptTokens: 1_000_000,
    cachedTokens: 250_000,
    completionTokens: 100_000,
    totalTokens: 1_100_000,
  };
  aggregator.addRow(row({
    model: 'gpt-5.6-sol',
    ...usage,
    actualUsd: 0,
    missingPriceTokens: usage.totalTokens,
  }));
  aggregator.addRow(row({
    model: 'gpt-5.6-sol-fast',
    ...usage,
    actualUsd: 0,
    missingPriceTokens: usage.totalTokens,
  }));

  const result = aggregator.result();
  const normalCost = ((750_000 * 5) + (250_000 * 0.5) + (100_000 * 30)) / 1_000_000;

  assert.equal(result.models['gpt-5.6-sol'].cost.missingPriceTokens, 0);
  assert.equal(result.models['gpt-5.6-sol-fast'].cost.missingPriceTokens, 0);
  assert.ok(Math.abs(result.models['gpt-5.6-sol'].cost.actualUsd - normalCost) < 1e-12);
  assert.ok(Math.abs(result.models['gpt-5.6-sol-fast'].cost.actualUsd - normalCost * 2.5) < 1e-12);
});

test('aggregator estimates unknown models from the same provider and date', () => {
  const aggregator = createLedgerRangeAggregator({ conversionModel: 'gemini-2.5-flash' });
  aggregator.addRow(row({
    date: '2026-08-14',
    provider: 'openai-codex-oauth',
    model: 'gpt-5.4-mini',
    promptTokens: 1_000_000,
    cachedTokens: 200_000,
    completionTokens: 100_000,
    totalTokens: 1_100_000,
  }));
  aggregator.addRow(row({
    date: '2026-08-14',
    provider: 'openai-codex-oauth',
    model: 'unknown',
    promptTokens: 1000,
    cachedTokens: 200,
    completionTokens: 100,
    totalTokens: 1100,
  }));

  const result = aggregator.result();
  const unknownCost = result.models.unknown.cost;
  assert.equal(unknownCost.actualUsd, 0);
  assert.ok(unknownCost.estimatedUsd > 0);
  assert.equal(unknownCost.usd, unknownCost.estimatedUsd);
  assert.equal(unknownCost.estimatedPriceTokens, 1100);
  assert.equal(unknownCost.missingPriceTokens, 0);
  assert.equal(unknownCost.pricingSource, 'estimated-average');
  assert.equal(unknownCost.estimationScope, 'provider-day');
  assert.ok(result.summary.cost.usd > result.summary.cost.actualUsd);
});

test('aggregator leaves unknown prices missing when only image samples exist', () => {
  const aggregator = createLedgerRangeAggregator({ conversionModel: 'gemini-2.5-flash' });
  aggregator.addRow(row({ date: '2026-08-14', model: 'gpt-image-2', totalTokens: 1500 }));
  aggregator.addRow(row({ date: '2026-08-14', model: 'unknown', totalTokens: 1000, promptTokens: 0, completionTokens: 0 }));

  const result = aggregator.result();
  assert.equal(result.models.unknown.cost.estimatedUsd, 0);
  assert.equal(result.models.unknown.cost.missingPriceTokens, 1000);
});

test('aggregated output never contains key material', () => {
  const aggregator = createLedgerRangeAggregator({});
  aggregator.addRow(row({}));
  const serialized = JSON.stringify(aggregator.result());
  assert.equal(serialized.includes('maki_secret'), false);
  assert.equal(serialized.includes('keyHash'), false);
  assert.equal(serialized.includes('deadbeef'), false);
});

test('readLedgerRangeStats reads existing files and reports missing dates', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-range-'));
  try {
    const dailyDir = path.join(tmpDir, 'daily');
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.writeFileSync(
      path.join(dailyDir, 'usage-2026-07-04.jsonl'),
      JSON.stringify(row({ date: '2026-07-04', totalTokens: 100, requestCount: 1 })) + '\n'
    );

    const result = await readLedgerRangeStats({
      ledgerDailyDir: dailyDir,
      dates: ['2026-07-04', '2026-07-05'],
      conversionModel: 'gemini-2.5-flash',
    });

    assert.deepEqual(result.availableDates, ['2026-07-04']);
    assert.deepEqual(result.missingDates, ['2026-07-05']);
    assert.equal(result.summary.totalTokens, 100);
    assert.equal(listLedgerDates(dailyDir).length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readLedgerRangeStats skips today ledger file so UI can use live stats', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-range-'));
  try {
    const dailyDir = path.join(tmpDir, 'daily');
    fs.mkdirSync(dailyDir, { recursive: true });
    const now = new Date('2026-07-05T20:00:00.000Z'); // 北京时间 2026-07-06
    fs.writeFileSync(
      path.join(dailyDir, 'usage-2026-07-06.jsonl'),
      JSON.stringify(row({ date: '2026-07-06', totalTokens: 50, requestCount: 1 })) + '\n'
    );

    const result = await readLedgerRangeStats({
      ledgerDailyDir: dailyDir,
      dates: ['2026-07-06'],
      now,
    });

    assert.deepEqual(result.availableDates, []);
    assert.deepEqual(result.missingDates, ['2026-07-06']);
    assert.equal(result.summary.totalTokens, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveRangeDates maps ranges to beijing date lists', () => {
  const now = new Date('2026-07-05T20:00:00.000Z'); // 2026-07-06 04:00 北京时间
  assert.equal(getBeijingDateKey(now), '2026-07-06');
  assert.deepEqual(resolveRangeDates('today', { now }), ['2026-07-06']);

  const week = resolveRangeDates('7d', { now });
  assert.equal(week.length, 7);
  assert.equal(week[0], '2026-06-30');
  assert.equal(week[6], '2026-07-06');

  const month = resolveRangeDates('30d', { now });
  assert.equal(month.length, 30);
  assert.equal(month[0], '2026-06-07');
});

test('resolveRangeDates includes both endpoints for a custom Beijing date range', () => {
  const now = new Date('2026-07-24T08:00:00.000Z');
  const dates = resolveRangeDates('custom', {
    from: '2026-01-01',
    to: '2026-01-15',
    now,
  });

  assert.equal(dates.length, 15);
  assert.equal(dates[0], '2026-01-01');
  assert.equal(dates[14], '2026-01-15');
});

test('resolveRangeDates rejects a custom start before the earliest ledger date', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-range-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'usage-2026-01-10.jsonl'), '');
    assert.throws(() => resolveRangeDates('custom', {
      ledgerDailyDir: tmpDir,
      from: '2026-01-01',
      to: '2026-01-15',
      now: new Date('2026-07-24T08:00:00.000Z'),
    }), error => error?.code === 'INVALID_DATE_RANGE' && /2026-01-10/.test(error.message));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('aggregator returns lightweight current-key summaries through hash aliases', () => {
  const aggregator = createLedgerRangeAggregator({
    conversionModel: 'gemini-2.5-flash',
    keyHashToId: new Map([
      ['sha256:current', 'maki_current'],
      ['sha256:previous', 'maki_current'],
    ]),
    includeKeySummaries: true,
  });

  aggregator.addRow(row({ date: '2026-01-01', keyHash: 'sha256:previous', totalTokens: 100, requestCount: 2 }));
  aggregator.addRow(row({ date: '2026-01-15', keyHash: 'sha256:current', totalTokens: 50, requestCount: 1 }));
  aggregator.addRow(row({ date: '2026-01-15', keyHash: 'sha256:deleted', totalTokens: 25, requestCount: 1 }));

  const result = aggregator.result();

  assert.equal(result.summary.totalTokens, 175);
  assert.equal(result.daily['2026-01-01'].totalTokens, 100);
  assert.equal(result.daily['2026-01-15'].totalTokens, 75);
  assert.deepEqual(Object.keys(result.keySummaries), ['maki_current']);
  assert.equal(result.keySummaries.maki_current.summary.totalTokens, 150);
  assert.deepEqual(Object.keys(result.keySummaries.maki_current.daily), ['2026-01-01', '2026-01-15']);
  assert.equal(JSON.stringify(result.keySummaries).includes('sha256:'), false);
});

test('resolveRangeDates total uses ledger directory contents plus today', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-range-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'usage-2026-05-01.jsonl'), '');
    fs.writeFileSync(path.join(tmpDir, 'usage-2026-05-02.jsonl'), '');
    const now = new Date('2026-07-05T20:00:00.000Z');
    const dates = resolveRangeDates('total', { ledgerDailyDir: tmpDir, now });
    assert.deepEqual(dates, ['2026-05-01', '2026-05-02', '2026-07-06']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
