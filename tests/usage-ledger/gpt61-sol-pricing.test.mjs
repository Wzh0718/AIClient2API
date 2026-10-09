import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyRowsFromPotluck, PRICING_VERSION } from '../../scripts/usage-ledger/daily-usage-ledger.mjs';
import { estimateUsageCost } from '../../src/plugins/api-potluck/cost-estimator.js';

for (const [model, multiplier] of [['gpt-6.1-sol', 1], ['gpt-6.1-sol-fast', 2], ['gpt-6.1-sol-ultrafast', 6]]) {
  test(`${model} ledger and online cost use identical project rates`, () => {
    const usage = { requestCount: 1, promptTokens: 1_000_000, cachedTokens: 250_000,
      completionTokens: 100_000, totalTokens: 1_100_000, cacheWriteTokens: 50_000 };
    const date = '2026-10-09';
    const store = { keys: { example_key: { usageHistory: { [date]: { accounts: {
      'openai-codex-oauth:user@example.com': { provider: 'openai-codex-oauth',
        accountEmail: 'user@example.com', models: { [model]: usage } }
    } } } } } };
    const [row] = buildDailyRowsFromPotluck(store, { from: date, to: date });
    const online = estimateUsageCost(usage, model);
    assert.ok(Math.abs(row.cost.actualUsd - 2.525 * multiplier) < 1e-12);
    assert.equal(row.cost.actualUsd, online.usd);
    assert.equal(row.cost.missingPriceTokens, 0);
    assert.equal(row.cost.estimatedPriceTokens, 0);
    assert.equal(row.pricingVersion, PRICING_VERSION);
    assert.equal(row.pricingVersion, online.pricingVersion);
  });
}
