import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileDay,
  summarizeLedgerRows,
  summarizePotluckDay,
} from '../../scripts/usage-ledger/daily-usage-ledger.mjs';

function ledgerRow(requestCount, totalTokens) {
  return {
    date: '2026-07-05',
    usage: { requestCount, promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens },
    cost: { actualUsd: 0.5, missingPriceTokens: 0 },
  };
}

test('summarizeLedgerRows sums request and token totals', () => {
  const summary = summarizeLedgerRows([ledgerRow(2, 100), ledgerRow(3, 250)]);
  assert.equal(summary.requestCount, 5);
  assert.equal(summary.totalTokens, 350);
  assert.ok(Math.abs(summary.actualUsd - 1.0) < 1e-9);
});

test('summarizePotluckDay sums day summaries across keys', () => {
  const store = {
    keys: {
      key_a: { usageHistory: { '2026-07-05': { summary: { requestCount: 2, totalTokens: 100 } } } },
      key_b: { usageHistory: { '2026-07-05': { summary: { requestCount: 1, totalTokens: 50 } } } },
      key_c: { usageHistory: { '2026-07-04': { summary: { requestCount: 9, totalTokens: 900 } } } },
    },
  };
  const summary = summarizePotluckDay(store, '2026-07-05');
  assert.equal(summary.requestCount, 3);
  assert.equal(summary.totalTokens, 150);
});

test('reconcileDay reports ok when all sources agree within threshold', () => {
  const result = reconcileDay({
    date: '2026-07-05',
    ledgerSummary: { requestCount: 1000, totalTokens: 100000 },
    auditSummary: { requestCount: 1000, totalTokens: 100000 },
    potluckSummary: { requestCount: 1002, totalTokens: 100100 },
    thresholdRatio: 0.005,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.date, '2026-07-05');
  assert.equal(result.thresholdRatio, 0.005);
  for (const comparison of result.comparisons) {
    assert.equal(comparison.exceeded, false);
  }
});

test('reconcileDay flags deviation beyond threshold', () => {
  const result = reconcileDay({
    date: '2026-07-05',
    ledgerSummary: { requestCount: 1000, totalTokens: 100000 },
    auditSummary: { requestCount: 1000, totalTokens: 100000 },
    potluckSummary: { requestCount: 1200, totalTokens: 130000 },
    thresholdRatio: 0.005,
  });

  assert.equal(result.status, 'deviation');
  const potluckComparison = result.comparisons.find(c => c.pair === 'ledger-vs-potluck');
  assert.equal(potluckComparison.exceeded, true);
  assert.ok(potluckComparison.metrics.totalTokens.deviationRatio > 0.005);
});

test('reconcileDay reports partial when audit data is unavailable', () => {
  const result = reconcileDay({
    date: '2026-07-05',
    ledgerSummary: { requestCount: 1000, totalTokens: 100000 },
    auditSummary: null,
    potluckSummary: { requestCount: 1000, totalTokens: 100000 },
    thresholdRatio: 0.005,
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.sources.audit.available, false);
  assert.equal(result.comparisons.some(c => c.pair === 'ledger-vs-audit'), false);
});

test('reconcileDay output contains no raw key material fields', () => {
  const result = reconcileDay({
    date: '2026-07-05',
    ledgerSummary: { requestCount: 10, totalTokens: 1000 },
    auditSummary: { requestCount: 10, totalTokens: 1000 },
    potluckSummary: { requestCount: 10, totalTokens: 1000 },
  });

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('"key"'), false);
  assert.equal(serialized.includes('keyHash'), false);
  assert.equal(serialized.includes('keyPrefix'), false);
});

test('reconcileDay treats zero-vs-zero as agreement and zero-vs-nonzero as deviation', () => {
  const zeroOk = reconcileDay({
    date: '2026-07-05',
    ledgerSummary: { requestCount: 0, totalTokens: 0 },
    auditSummary: { requestCount: 0, totalTokens: 0 },
    potluckSummary: { requestCount: 0, totalTokens: 0 },
  });
  assert.equal(zeroOk.status, 'ok');

  const zeroBad = reconcileDay({
    date: '2026-07-05',
    ledgerSummary: { requestCount: 0, totalTokens: 0 },
    auditSummary: { requestCount: 5, totalTokens: 500 },
    potluckSummary: { requestCount: 0, totalTokens: 0 },
  });
  assert.equal(zeroBad.status, 'deviation');
});

test('reconcileDay reports hourly detail coverage without inventing missing distribution', () => {
  const result = reconcileDay({
    date: '2026-08-15',
    ledgerSummary: { requestCount: 266335, totalTokens: 3710988992 },
    hourlySummary: { requestCount: 264607, totalTokens: 3711004906 },
    auditSummary: { requestCount: 266335, totalTokens: 3710988992 },
    potluckSummary: { requestCount: 266335, totalTokens: 3710988992 },
  });

  assert.equal(result.hourlyCoverage.status, 'partial');
  assert.equal(result.hourlyCoverage.requestCount.unattributed, 1728);
  assert.equal(result.hourlyCoverage.totalTokens.delta, 15914);
  assert.equal(result.hourlyCoverage.syntheticAllocation, false);
});
