import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateAuditEvents,
  buildKeyLookup,
  buildDailyRowsFromPotluck,
  buildDailyRowsFromSqlite,
  buildDailyRowsFromSqliteRows,
  buildHourlyRowsFromPotluck,
  hashSecret,
  makeKeyRef,
  summarizeAggregationResult,
  buildUniqueEmailProviderMap,
  resolveAuditProvider,
} from '../../scripts/usage-ledger/daily-usage-ledger.mjs';

test('SQLite usage history remains ledger-readable after metadata JSON is stripped', () => {
  const rawKey = 'example_sqlite_key';
  const rows = buildDailyRowsFromSqliteRows([{
    key_ref: hashSecret(rawKey),
    usage_date: '2026-08-27',
    day_json: JSON.stringify({
      summary: { requestCount: 2, promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      models: {
        'gpt-5.5': { requestCount: 2, promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      },
      accounts: {
        'openai-codex-oauth:user@example.com': {
          provider: 'openai-codex-oauth',
          accountEmail: 'user@example.com',
          models: {
            'gpt-5.5': { requestCount: 2, promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          },
        },
      },
    })
  }], {
    keys: { [rawKey]: { name: 'SQLite Key' } },
  }, { from: '2026-08-27', to: '2026-08-27' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, rawKey);
  assert.equal(rows[0].keyName, 'SQLite Key');
  assert.equal(rows[0].keyHash, hashSecret(rawKey));
  assert.equal(rows[0].usage.requestCount, 2);
  assert.equal(rows[0].usage.totalTokens, 120);
});

test('potluck daily rows canonicalize account email and preserve original key', () => {
  const store = {
    keys: {
      example_secret_original_value: {
        name: 'Team Key',
        usageHistory: {
          '2026-07-05': {
            accounts: {
              'openai-codex-oauth:provider-uuid-1': {
                provider: 'openai-codex-oauth',
                providerUuid: 'provider-uuid-1',
                accountEmail: 'User@Example.COM',
                providerName: 'User',
                providerUuids: ['provider-uuid-1'],
                summary: {
                  requestCount: 2,
                  promptTokens: 1000,
                  cachedTokens: 200,
                  completionTokens: 50,
                  reasoningTokens: 10,
                  totalTokens: 1050,
                },
                models: {
                  'gpt-5.5': {
                    requestCount: 2,
                    promptTokens: 1000,
                    cachedTokens: 200,
                    completionTokens: 50,
                    reasoningTokens: 10,
                    totalTokens: 1050,
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  const rows = buildDailyRowsFromPotluck(store, { from: '2026-07-05', to: '2026-07-05' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].accountEmail, 'user@example.com');
  assert.equal(rows[0].accountKey, 'openai-codex-oauth:user@example.com');
  assert.equal(rows[0].key, 'example_secret_original_value');
  assert.equal(rows[0].keyName, 'Team Key');
  assert.equal(rows[0].keyPrefix, 'example_sec...');
  assert.equal(rows[0].keyHash, hashSecret('example_secret_original_value'));
  assert.equal(rows[0].usage.requestCount, 2);
  assert.equal(rows[0].usage.totalTokens, 1050);
  assert.ok(rows[0].cost.actualUsd > 0);
  assert.equal(rows[0].pricingVersion, 'official-2026-09-05-codex-rules-r1');
});

test('potluck daily rows price GPT-5.6 fast models with the configured multiplier', () => {
  const usage = {
    requestCount: 1,
    promptTokens: 1_000_000,
    cachedTokens: 250_000,
    completionTokens: 100_000,
    reasoningTokens: 0,
    totalTokens: 1_100_000,
  };
  const store = {
    keys: {
      example_fast_value: {
        usageHistory: {
          '2026-07-12': {
            accounts: {
              'openai-codex-oauth:user@example.com': {
                provider: 'openai-codex-oauth',
                accountEmail: 'user@example.com',
                models: { 'gpt-5.6-sol-fast': usage },
              },
            },
          },
        },
      },
    },
  };

  const [row] = buildDailyRowsFromPotluck(store, { from: '2026-07-12', to: '2026-07-12' });
  const normalCost = ((750_000 * 5) + (250_000 * 0.5) + (100_000 * 30)) / 1_000_000;

  assert.equal(row.cost.missingPriceTokens, 0);
  assert.ok(Math.abs(row.cost.actualUsd - normalCost * 2.5) < 1e-12);
  assert.equal(row.pricingVersion, 'official-2026-09-05-codex-rules-r1');
});

test('potluck daily rows estimate unknown models from same-provider daily text usage', () => {
  const knownUsage = {
    requestCount: 1,
    promptTokens: 1_000_000,
    cachedTokens: 200_000,
    completionTokens: 100_000,
    totalTokens: 1_100_000,
  };
  const unknownUsage = {
    requestCount: 1,
    promptTokens: 1000,
    cachedTokens: 200,
    completionTokens: 100,
    totalTokens: 1100,
  };
  const store = {
    keys: {
      average_price_key: {
        usageHistory: {
          '2026-08-14': {
            accounts: {
              'openai-codex-oauth:user@example.com': {
                provider: 'openai-codex-oauth',
                accountEmail: 'user@example.com',
                models: { 'gpt-5.4-mini': knownUsage, unknown: unknownUsage },
              },
            },
          },
        },
      },
    },
  };

  const rows = buildDailyRowsFromPotluck(store, { from: '2026-08-14', to: '2026-08-14' });
  const unknown = rows.find(row => row.model === 'unknown');
  assert.equal(unknown.cost.actualUsd, 0);
  assert.ok(unknown.cost.estimatedUsd > 0);
  assert.equal(unknown.cost.usd, unknown.cost.estimatedUsd);
  assert.equal(unknown.cost.estimatedPriceTokens, 1100);
  assert.equal(unknown.cost.missingPriceTokens, 0);
  assert.equal(unknown.cost.pricingSource, 'estimated-average');
  assert.equal(unknown.cost.estimationScope, 'provider-day');
});

test('potluck hourly rows preserve hour while using the same key reference', () => {
  const store = {
    keys: {
      example_secret_original_value: {
        name: 'Team Key',
        usageHistory: {
          '2026-07-05': {
            hours: {
              '08': {
                accounts: {
                  'openai-codex-oauth:user@example.com': {
                    provider: 'openai-codex-oauth',
                    providerUuid: 'user@example.com',
                    accountEmail: 'user@example.com',
                    providerUuids: ['provider-uuid-1'],
                    summary: { requestCount: 1, promptTokens: 100, cachedTokens: 0, completionTokens: 20, totalTokens: 120 },
                    models: {
                      'gpt-5.4-mini': { requestCount: 1, promptTokens: 100, cachedTokens: 0, completionTokens: 20, totalTokens: 120 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  const rows = buildHourlyRowsFromPotluck(store, { from: '2026-07-05', to: '2026-07-05' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-07-05');
  assert.equal(rows[0].hour, '08');
  assert.equal(rows[0].key, 'example_secret_original_value');
  assert.equal(rows[0].keyPrefix, 'example_sec...');
});

test('potluck daily rows preserve legacy model summaries when account details are absent', () => {
  const store = {
    keys: {
      example_legacy_value: {
        name: 'Legacy Key',
        usageHistory: {
          '2026-05-19': {
            providers: {
              'openai-codex-oauth': { requestCount: 2, totalTokens: 300 },
            },
            summary: { requestCount: 2, promptTokens: 250, completionTokens: 50, totalTokens: 300 },
            models: {
              'gpt-5.4-mini': { requestCount: 1, promptTokens: 100, completionTokens: 20, totalTokens: 120 },
              'gpt-5.5': { requestCount: 1, promptTokens: 150, completionTokens: 30, totalTokens: 180 },
            },
          },
        },
      },
    },
  };

  const rows = buildDailyRowsFromPotluck(store, { from: '2026-05-19', to: '2026-05-19' });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, 'api-potluck-keys-summary');
  assert.equal(rows[0].provider, 'openai-codex-oauth');
  assert.equal(rows[0].accountKey, 'openai-codex-oauth:unknown');
  assert.equal(rows[0].key, 'example_legacy_value');
  assert.deepEqual(rows.map(row => row.model), ['gpt-5.4-mini', 'gpt-5.5']);
  assert.equal(rows.reduce((sum, row) => sum + row.usage.requestCount, 0), 2);
  assert.equal(rows.reduce((sum, row) => sum + row.usage.totalTokens, 0), 300);
});

test('potluck daily rows add summary deltas when account details are partial', () => {
  const store = {
    keys: {
      example_partial_value: {
        name: 'Partial Key',
        usageHistory: {
          '2026-06-28': {
            providers: {
              'openai-codex-oauth': { requestCount: 3, totalTokens: 330 },
            },
            models: {
              'gpt-5.5': { requestCount: 3, promptTokens: 300, completionTokens: 30, totalTokens: 330 },
            },
            accounts: {
              'openai-codex-oauth:user@example.com': {
                provider: 'openai-codex-oauth',
                accountEmail: 'user@example.com',
                models: {
                  'gpt-5.5': { requestCount: 1, promptTokens: 100, completionTokens: 10, totalTokens: 110 },
                },
              },
            },
          },
        },
      },
    },
  };

  const rows = buildDailyRowsFromPotluck(store, { from: '2026-06-28', to: '2026-06-28' });

  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.source === 'api-potluck-keys')?.usage.totalTokens, 110);
  const delta = rows.find(row => row.source === 'api-potluck-keys-summary-delta');
  assert.equal(delta.accountKey, 'openai-codex-oauth:unknown');
  assert.equal(delta.usage.requestCount, 2);
  assert.equal(delta.usage.promptTokens, 200);
  assert.equal(delta.usage.completionTokens, 20);
  assert.equal(delta.usage.totalTokens, 220);
  assert.equal(rows.reduce((sum, row) => sum + row.usage.requestCount, 0), 3);
  assert.equal(rows.reduce((sum, row) => sum + row.usage.totalTokens, 0), 330);
});

test('summary deltas aggregate model aliases before subtracting account coverage', () => {
  const store = {
    keys: {
      example_alias_value: {
        usageHistory: {
          '2026-06-22': {
            providers: {
              'openai-codex-oauth': { requestCount: 3, totalTokens: 300 },
            },
            models: {
              'gpt-5.5': { requestCount: 2, promptTokens: 180, completionTokens: 20, totalTokens: 200 },
              'codex-auto-review': { requestCount: 1, promptTokens: 90, completionTokens: 10, totalTokens: 100 },
            },
            accounts: {
              'openai-codex-oauth:user@example.com': {
                provider: 'openai-codex-oauth',
                accountEmail: 'user@example.com',
                models: {
                  'gpt-5.5': { requestCount: 2, promptTokens: 180, completionTokens: 20, totalTokens: 200 },
                },
              },
            },
          },
        },
      },
    },
  };

  const rows = buildDailyRowsFromPotluck(store, { from: '2026-06-22', to: '2026-06-22' });
  const delta = rows.find(row => row.source === 'api-potluck-keys-summary-delta');

  assert.equal(rows.length, 2);
  assert.equal(delta.model, 'gpt-5.5');
  assert.equal(delta.usage.requestCount, 1);
  assert.equal(delta.usage.totalTokens, 100);
  assert.equal(rows.reduce((sum, row) => sum + row.usage.requestCount, 0), 3);
  assert.equal(rows.reduce((sum, row) => sum + row.usage.totalTokens, 0), 300);
});

test('audit aggregation deduplicates requestId and can recompute daily and hourly rows', () => {
  const events = [
    {
      schemaVersion: 1,
      timestamp: '2026-07-05T01:10:00.000Z',
      beijingDate: '2026-07-05',
      beijingHour: '09',
      requestId: 'req-1',
      request: { toProvider: 'openai-codex-oauth', actualModel: 'gpt-5.5', model: 'gpt-5.5' },
      potluckKey: { key: 'example_secret_original_value', hash: hashSecret('example_secret_original_value'), prefix: 'example_sec...', name: 'Team Key' },
      account: { providerUuid: 'provider-uuid-1', accountEmail: 'user@example.com', providerNameDisplay: 'User' },
      status: { outcome: 'success' },
      usage: { promptTokens: 100, cachedTokens: 20, completionTokens: 5, reasoningTokens: 1, totalTokens: 105 },
    },
    {
      schemaVersion: 1,
      timestamp: '2026-07-05T01:10:01.000Z',
      beijingDate: '2026-07-05',
      beijingHour: '09',
      requestId: 'req-1',
      request: { toProvider: 'openai-codex-oauth', actualModel: 'gpt-5.5', model: 'gpt-5.5' },
      potluckKey: { key: 'example_secret_original_value', hash: hashSecret('example_secret_original_value'), prefix: 'example_sec...', name: 'Team Key' },
      account: { providerUuid: 'provider-uuid-1', accountEmail: 'user@example.com', providerNameDisplay: 'User' },
      status: { outcome: 'success' },
      usage: { promptTokens: 100, cachedTokens: 20, completionTokens: 5, reasoningTokens: 1, totalTokens: 105 },
    },
  ];

  const result = aggregateAuditEvents(events, { from: '2026-07-05', to: '2026-07-05' });

  assert.equal(result.skipped.duplicateRequestIds, 1);
  assert.equal(result.dailyRows.length, 1);
  assert.equal(result.hourlyRows.length, 1);
  assert.equal(result.dailyRows[0].key, 'example_secret_original_value');
  assert.equal(result.dailyRows[0].usage.requestCount, 1);
  assert.equal(result.dailyRows[0].usage.totalTokens, 105);
  assert.equal(result.hourlyRows[0].hour, '09');
});

test('audit aggregation can enrich original key from current key lookup', () => {
  const store = {
    keys: {
      example_secret_original_value: { name: 'Team Key' },
    },
  };
  const events = [
    {
      timestamp: '2026-07-05T01:10:00.000Z',
      beijingDate: '2026-07-05',
      beijingHour: '09',
      requestId: 'req-1',
      request: { toProvider: 'openai-codex-oauth', actualModel: 'gpt-5.5' },
      potluckKey: { hash: hashSecret('example_secret_original_value'), prefix: 'example_sec...' },
      account: { accountEmail: 'user@example.com' },
      status: { outcome: 'success' },
      usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 },
    },
  ];

  const result = aggregateAuditEvents(events, {
    from: '2026-07-05',
    to: '2026-07-05',
    keyLookup: buildKeyLookup(store),
  });

  assert.equal(result.dailyRows[0].key, 'example_secret_original_value');
  assert.equal(result.dailyRows[0].keyName, 'Team Key');
});

test('makeKeyRef keeps original key with truncated hash and prefix', () => {
  const keyRef = makeKeyRef('example_abcdefghijklmnopqrstuvwxyz', 'Visible Name');

  assert.deepEqual(keyRef, {
    key: 'example_abcdefghijklmnopqrstuvwxyz',
    keyHash: hashSecret('example_abcdefghijklmnopqrstuvwxyz'),
    keyPrefix: 'example_abc...',
    keyName: 'Visible Name',
  });
});

test('summarizeAggregationResult omits raw rows from CLI output', () => {
  const summary = summarizeAggregationResult({
    eventCount: 1,
    includedRequestCount: 1,
    skipped: { duplicateRequestIds: 0, outsideRange: 0, nonSuccess: 0, missingUsage: 0 },
    dailyRows: [{ key: 'example_secret_original_value', usage: { totalTokens: 10 } }],
    hourlyRows: [{ key: 'example_secret_original_value', usage: { totalTokens: 10 } }],
  });

  assert.deepEqual(summary, {
    eventCount: 1,
    includedRequestCount: 1,
    skipped: { duplicateRequestIds: 0, outsideRange: 0, nonSuccess: 0, missingUsage: 0 },
    dailyRows: 1,
    hourlyRows: 1,
  });
  assert.equal(JSON.stringify(summary).includes('example_secret_original_value'), false);
});

test('audit provider fallback uses only an unambiguous email mapping', () => {
  const store = {
    keys: {
      key_a: { usageHistory: { '2026-08-14': { accounts: {
        'openai-codex-oauth:user@example.com': { provider: 'openai-codex-oauth', accountEmail: 'user@example.com' },
        'gemini-antigravity:other@example.com': { provider: 'gemini-antigravity', accountEmail: 'other@example.com' },
      } } } },
      key_b: { usageHistory: { '2026-08-14': { accounts: {
        'gemini-antigravity:user@example.com': { provider: 'gemini-antigravity', accountEmail: 'user@example.com' },
      } } } },
    },
  };
  const mapping = buildUniqueEmailProviderMap(store);
  assert.equal(resolveAuditProvider({ request: { toProvider: 'unknown' }, account: { accountEmail: 'other@example.com' } }, mapping), 'gemini-antigravity');
  assert.equal(resolveAuditProvider({ request: { toProvider: 'unknown' }, account: { accountEmail: 'user@example.com' } }, mapping), 'unknown');
});

