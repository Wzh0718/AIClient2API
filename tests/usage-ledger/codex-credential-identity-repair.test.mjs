import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { runCredentialIdentityRepair } from '../../scripts/usage-ledger/codex-credential-identity-repair.mjs';

const UUID = '420a8594-bad3-448d-9569-3321df100d95';
const OLD_EMAIL = 'gaulinrosiles6731@outlook.com';
const NEW_EMAIL = 'tobiaswileyqjw@mail.com';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function account(email, tokens) {
  return {
    provider: 'openai-codex-oauth', providerUuid: email, accountIdentity: email,
    accountEmail: email, providerName: email, providerUuids: [UUID],
    summary: { requestCount: 1, promptTokens: tokens, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: tokens },
    models: { 'gpt-5.6-sol': { requestCount: 1, promptTokens: tokens, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: tokens } },
  };
}

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-identity-repair-'));
  writeJson(path.join(base, 'provider_pools.json'), {
    'openai-codex-oauth': [{ uuid: UUID, codexEmail: NEW_EMAIL }],
  });
  writeJson(path.join(base, 'codex-email-identity-overrides.json'), { [UUID]: NEW_EMAIL });
  const oldKey = `openai-codex-oauth:${OLD_EMAIL}`;
  const day = {
    summary: { requestCount: 1, totalTokens: 10 },
    accounts: { [oldKey]: account(OLD_EMAIL, 10) },
    hours: { '12': { accounts: { [oldKey]: account(OLD_EMAIL, 10) } } },
  };
  writeJson(path.join(base, 'model-usage-stats.json'), {
    summary: { requestCount: 1, totalTokens: 10 }, providers: {},
    accounts: { [oldKey]: account(OLD_EMAIL, 10) },
    accountUsageEvents: { [oldKey]: [{ timestamp: '2026-08-19T04:00:00.000Z', totalTokens: 10 }] },
    daily: { '2026-08-19': day },
  });
  writeJson(path.join(base, 'api-potluck-keys.json'), {
    keys: { key: { usageHistory: { '2026-08-19': day } } },
  });
  const sqlitePath = path.join(base, 'usage-events', 'usage-events.sqlite');
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new Database(sqlitePath);
  db.exec('CREATE TABLE potluck_usage_history (key_ref TEXT NOT NULL, usage_date TEXT NOT NULL, day_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (key_ref, usage_date))');
  db.prepare('INSERT INTO potluck_usage_history (key_ref, usage_date, day_json) VALUES (?, ?, ?)').run('key', '2026-08-19', JSON.stringify(day));
  db.close();
  const ledgerPath = path.join(base, 'permanent-usage-ledger', 'daily', 'usage-2026-08-19.jsonl');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify({
    schemaVersion: 1, ledgerType: 'daily-key-account-model', date: '2026-08-19', source: 'api-potluck-keys',
    provider: 'openai-codex-oauth', accountKey: oldKey, accountEmail: OLD_EMAIL, accountIdentity: OLD_EMAIL,
    providerName: OLD_EMAIL, providerUuids: [UUID], key: 'key', keyHash: 'sha256:key', model: 'gpt-5.6-sol',
    usage: { requestCount: 1, promptTokens: 10, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 10 },
    cost: { actualUsd: 1, missingPriceTokens: 0, pricingModel: 'gpt-5.6-sol' }, pricingVersion: 'test',
  })}\n`);
  return { base, sqlitePath, ledgerPath };
}

test('credential identity repair dry-runs, applies atomically, preserves totals, and is idempotent', async () => {
  const fixture = makeFixture();
  const modelPath = path.join(fixture.base, 'model-usage-stats.json');
  const before = fs.readFileSync(modelPath, 'utf8');
  const aliases = { [OLD_EMAIL]: NEW_EMAIL };

  const dryRun = await runCredentialIdentityRepair({ base: fixture.base, aliases, dryRun: true });
  assert.equal(dryRun.status, 'dry-run');
  assert.equal(fs.readFileSync(modelPath, 'utf8'), before);
  assert.equal(dryRun.totalsBefore.totalTokens, dryRun.totalsAfter.totalTokens);

  const backupDir = path.join(fixture.base, 'backup');
  const applied = await runCredentialIdentityRepair({ base: fixture.base, aliases, dryRun: false, backupDir });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.totalsBefore.totalTokens, applied.totalsAfter.totalTokens);
  assert.equal(fs.existsSync(path.join(backupDir, 'model-usage-stats.json')), true);

  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  assert.equal(model.accounts[`openai-codex-oauth:${NEW_EMAIL}`].summary.totalTokens, 10);
  assert.equal(model.accounts[`openai-codex-oauth:${OLD_EMAIL}`], undefined);
  assert.deepEqual(Object.keys(model.accountUsageEvents), [`openai-codex-oauth:${NEW_EMAIL}`]);

  const db = new Database(fixture.sqlitePath, { readonly: true });
  const sqliteDay = JSON.parse(db.prepare('SELECT day_json FROM potluck_usage_history').get().day_json);
  db.close();
  assert.ok(sqliteDay.accounts[`openai-codex-oauth:${NEW_EMAIL}`]);
  assert.equal(fs.readFileSync(fixture.ledgerPath, 'utf8').includes(OLD_EMAIL), false);

  const repeated = await runCredentialIdentityRepair({ base: fixture.base, aliases, dryRun: false, backupDir });
  assert.equal(repeated.status, 'already-applied');
});
