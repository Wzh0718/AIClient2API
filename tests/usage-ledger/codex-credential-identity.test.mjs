import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCanonicalIdentityCatalog,
  canonicalizeAccountMap,
  canonicalizeLedgerRows,
  createCodexAuditEventCanonicalizer,
} from '../../scripts/usage-ledger/codex-credential-identity.mjs';

const UUID = '420a8594-bad3-448d-9569-3321df100d95';
const OLD_EMAIL = 'gaulinrosiles6731@outlook.com';
const NEW_EMAIL = 'tobiaswileyqjw@mail.com';

function usage(requestCount, totalTokens) {
  return {
    requestCount,
    promptTokens: totalTokens - 3,
    cachedTokens: 2,
    completionTokens: 3,
    reasoningTokens: 1,
    totalTokens,
    maxQps: requestCount,
    maxRpm: requestCount * 2,
    maxTps: totalTokens,
    lastUsedAt: `2026-08-1${requestCount}T00:00:00.000Z`,
  };
}

test('explicit UUID override is canonical and replaces provider-pool email', () => {
  const catalog = buildCanonicalIdentityCatalog({
    providerPools: {
      'openai-codex-oauth': [{ uuid: UUID, codexEmail: 'stale@example.com' }],
    },
    overrides: { [UUID]: NEW_EMAIL },
    aliases: { [OLD_EMAIL]: NEW_EMAIL },
  });

  assert.equal(catalog.resolve({ providerUuids: [UUID], accountEmail: OLD_EMAIL }), NEW_EMAIL);
  assert.equal(catalog.resolve({ accountEmail: OLD_EMAIL }), NEW_EMAIL);
});

test('account map merges old and new email buckets without changing six-field totals', () => {
  const catalog = buildCanonicalIdentityCatalog({
    providerPools: { 'openai-codex-oauth': [{ uuid: UUID, codexEmail: NEW_EMAIL }] },
    aliases: { [OLD_EMAIL]: NEW_EMAIL },
  });
  const accounts = {
    [`openai-codex-oauth:${OLD_EMAIL}`]: {
      provider: 'openai-codex-oauth', accountEmail: OLD_EMAIL, accountIdentity: OLD_EMAIL,
      providerUuid: OLD_EMAIL, providerUuids: [UUID], summary: usage(1, 10), models: { 'gpt-5.6-sol': usage(1, 10) },
    },
    [`openai-codex-oauth:${NEW_EMAIL}`]: {
      provider: 'openai-codex-oauth', accountEmail: NEW_EMAIL, accountIdentity: NEW_EMAIL,
      providerUuid: NEW_EMAIL, providerUuids: [UUID], summary: usage(2, 20), models: { 'gpt-5.6-sol': usage(2, 20) },
    },
  };

  const result = canonicalizeAccountMap(accounts, catalog);
  const key = `openai-codex-oauth:${NEW_EMAIL}`;
  assert.deepEqual(Object.keys(result), [key]);
  assert.equal(result[key].summary.requestCount, 3);
  assert.equal(result[key].summary.totalTokens, 30);
  assert.equal(result[key].models['gpt-5.6-sol'].totalTokens, 30);
  assert.deepEqual(result[key].providerUuids, [UUID]);
});

test('ledger rows whose identity converges are merged by dimensions', () => {
  const catalog = buildCanonicalIdentityCatalog({
    providerPools: { 'openai-codex-oauth': [{ uuid: UUID, codexEmail: NEW_EMAIL }] },
    aliases: { [OLD_EMAIL]: NEW_EMAIL },
  });
  const common = {
    schemaVersion: 1,
    ledgerType: 'daily-key-account-model',
    date: '2026-08-19',
    source: 'api-potluck-keys',
    provider: 'openai-codex-oauth',
    providerUuids: [UUID],
    key: 'maki_example',
    keyHash: 'sha256:key',
    keyPrefix: 'maki_exam...',
    keyName: '示例',
    model: 'gpt-5.6-sol',
    cost: { actualUsd: 1, missingPriceTokens: 0, pricingModel: 'gpt-5.6-sol' },
    pricingVersion: 'test',
  };
  const rows = [
    { ...common, accountKey: `openai-codex-oauth:${OLD_EMAIL}`, accountEmail: OLD_EMAIL, accountIdentity: OLD_EMAIL, providerName: OLD_EMAIL, usage: usage(1, 10) },
    { ...common, accountKey: `openai-codex-oauth:${NEW_EMAIL}`, accountEmail: NEW_EMAIL, accountIdentity: NEW_EMAIL, providerName: NEW_EMAIL, usage: usage(2, 20), cost: { ...common.cost, actualUsd: 2 } },
  ];

  const result = canonicalizeLedgerRows(rows, catalog);
  assert.equal(result.length, 1);
  assert.equal(result[0].accountEmail, NEW_EMAIL);
  assert.equal(result[0].usage.requestCount, 3);
  assert.equal(result[0].usage.totalTokens, 30);
  assert.equal(result[0].cost.actualUsd, 3);
});

test('historical unknown ledger rows without a credential reference remain unchanged', () => {
  const catalog = buildCanonicalIdentityCatalog({
    providerPools: { 'openai-codex-oauth': [{ uuid: UUID, codexEmail: NEW_EMAIL }] },
  });
  const row = {
    schemaVersion: 1, ledgerType: 'daily-key-account-model', date: '2026-05-23',
    source: 'api-potluck-keys-summary', provider: 'openai-codex-oauth',
    accountKey: 'openai-codex-oauth:unknown', accountEmail: null,
    accountIdentity: 'unknown', providerName: null, providerUuids: [],
    key: 'maki_example', keyHash: 'sha256:key', model: 'gpt-5.5',
    usage: usage(1, 10), cost: { actualUsd: 1, missingPriceTokens: 0, pricingModel: 'gpt-5.5' },
    pricingVersion: 'test',
  };

  assert.deepEqual(canonicalizeLedgerRows([row], catalog), [row]);
});

test('audit canonicalizer includes the exact lower boundary and excludes the upper boundary', () => {
  const catalog = buildCanonicalIdentityCatalog({
    providerPools: { 'openai-codex-oauth': [{ uuid: UUID, codexEmail: NEW_EMAIL }] },
  });
  const filter = createCodexAuditEventCanonicalizer({
    catalog,
    from: '2026-08-19T04:00:00.000Z',
    to: '2026-08-20T09:00:00.000Z',
  });
  const event = timestamp => ({
    timestamp,
    request: { toProvider: 'openai-codex-oauth' },
    account: { providerUuid: UUID, accountEmail: OLD_EMAIL },
  });
  const before = event('2026-08-19T03:59:59.999Z');
  const lower = event('2026-08-19T04:00:00.000Z');
  const upper = event('2026-08-20T09:00:00.000Z');

  assert.equal(filter(before), false);
  assert.equal(filter(lower), true);
  assert.equal(lower.account.accountEmail, NEW_EMAIL);
  assert.equal(filter(upper), false);
});
