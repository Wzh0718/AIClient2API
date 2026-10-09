import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { runRepair } from '../../scripts/usage-ledger/repair-codex-email-archive.mjs';

const OLD = 'old-account@example.com';
const NEW = 'new-account@example.com';
const ID = 'same-codex-account-id';
const OLD_UUID = 'old-codex-credential';
const NEW_UUID = 'new-codex-credential';
const OTHER_UUID = 'other-codex-credential';

function hash(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function account(provider, address, uuid, requests, tokens) {
  const usage = { requestCount: requests, promptTokens: tokens, cachedTokens: 0,
    completionTokens: 0, reasoningTokens: 0, totalTokens: tokens, lastUsedAt: '2026-09-29T00:00:00Z' };
  return { provider, providerUuid: address, accountIdentity: address, accountEmail: address,
    providerName: address, providerUuids: [uuid], summary: usage, models: { 'gpt-6-sol': usage } };
}

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-email-archive-'));
  const oldCachePath = path.join(base, 'old-cache.json');
  const backupArchive = path.join(os.tmpdir(), `codex-email-archive-backup-${path.basename(base)}.tar.gz`);
  const oldKey = `openai-codex-oauth:${OLD}`;
  const newKey = `openai-codex-oauth:${NEW}`;
  const unrelated = `unknown:${hash(OTHER_UUID)}`;
  const verifiedUnknown = `unknown:${hash(OLD_UUID)}`;
  const oldAccount = account('openai-codex-oauth', OLD, OLD_UUID, 2, 20);
  const newAccount = account('openai-codex-oauth', NEW, NEW_UUID, 3, 30);
  const unrelatedAccount = account('unknown', OLD, hash(OTHER_UUID), 7, 70);
  const verifiedUnknownAccount = account('unknown', OLD, hash(OLD_UUID), 5, 50);
  verifiedUnknownAccount.providerUuid = hash(OLD_UUID);
  verifiedUnknownAccount.accountIdentity = hash(OLD_UUID);
  const geminiKey = `gemini-antigravity:${NEW}`;
  const geminiAccount = account('gemini-antigravity', NEW, 'gemini-uuid', 11, 110);
  const accounts = { [oldKey]: oldAccount, [newKey]: newAccount, [unrelated]: unrelatedAccount,
    [verifiedUnknown]: verifiedUnknownAccount, [geminiKey]: geminiAccount };
  const day = { summary: { requestCount: 28, totalTokens: 280 }, accounts,
    hours: { '12': { accounts: { [oldKey]: oldAccount, [newKey]: newAccount } } } };

  writeJson(oldCachePath, { providers: { 'openai-codex-oauth': {
    instances: [{ name: OLD, uuid: OLD_UUID, codexAccountId: ID }],
  } } });
  writeJson(path.join(base, 'usage-display-cache.json'), { data: { providers: { 'openai-codex-oauth': {
    instances: [{ name: NEW, uuid: NEW_UUID, codexAccountId: ID }],
  } } } });
  writeJson(path.join(base, 'provider_pools.json'), { 'openai-codex-oauth': [
    { uuid: NEW_UUID, codexAccountId: ID, codexEmail: NEW },
  ] });
  writeJson(path.join(base, 'model-usage-stats.json'), {
    accounts, daily: { '2026-09-29': day },
    accountUsageEvents: { [oldKey]: [{ timestamp: '2026-09-29T00:00:00Z', totalTokens: 20 }],
      [geminiKey]: [{ timestamp: '2026-09-29T00:00:01Z', totalTokens: 110 }] },
  });
  writeJson(path.join(base, 'api-potluck-keys.json'), { keys: { key: { usageHistory: { '2026-09-29': day } } } });

  const sqlitePath = path.join(base, 'usage-events', 'usage-events.sqlite');
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new Database(sqlitePath);
  db.exec('CREATE TABLE potluck_usage_history (key_ref TEXT NOT NULL, usage_date TEXT NOT NULL, day_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(key_ref, usage_date))');
  db.prepare('INSERT INTO potluck_usage_history (key_ref, usage_date, day_json) VALUES (?, ?, ?)')
    .run('key', '2026-09-29', JSON.stringify(day));
  db.close();

  const ledgerRow = (accountKey, address, uuid, requests, tokens, usd) => ({
    schemaVersion: 1, ledgerType: 'daily-key-account-model', date: '2026-09-29',
    source: 'api-potluck-keys', provider: 'openai-codex-oauth', accountKey,
    accountEmail: address, accountIdentity: address, providerName: address, providerUuids: [uuid],
    keyHash: 'sha256:key', model: 'gpt-6-sol', pricingVersion: 'test',
    usage: { requestCount: requests, promptTokens: tokens, cachedTokens: 0,
      completionTokens: 0, reasoningTokens: 0, totalTokens: tokens },
    cost: { usd, actualUsd: usd, estimatedUsd: 0, missingPriceTokens: 0,
      estimatedPriceTokens: 0, pricingModel: 'gpt-6-sol', pricingSource: 'test' },
  });
  const ledgerPath = path.join(base, 'permanent-usage-ledger', 'daily', 'usage-2026-09-29.jsonl');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, [ledgerRow(oldKey, OLD, OLD_UUID, 2, 20, 1),
    ledgerRow(newKey, NEW, NEW_UUID, 3, 30, 2)].map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(backupArchive, 'fixture backup');
  return { base, oldCachePath, backupArchive, sqlitePath, ledgerPath, oldKey, newKey, unrelated, verifiedUnknown, geminiKey };
}

test('scoped archive repair merges one Codex account and preserves unrelated identities', async t => {
  const f = makeFixture();
  t.after(() => { fs.rmSync(f.base, { recursive: true }); fs.unlinkSync(f.backupArchive); });
  const args = { base: f.base, oldCachePath: f.oldCachePath, oldEmail: OLD, newEmail: NEW,
    backupArchive: f.backupArchive };
  const before = fs.readFileSync(path.join(f.base, 'model-usage-stats.json'));
  const dryRun = await runRepair(args);
  assert.equal(dryRun.status, 'dry-run');
  assert.deepEqual(fs.readFileSync(path.join(f.base, 'model-usage-stats.json')), before);
  assert.equal(dryRun.changedSqliteRows, 1);
  assert.equal(dryRun.rekeyedLedgerRows, 1);

  const applied = await runRepair({ ...args, apply: true });
  assert.equal(applied.status, 'applied');
  const model = JSON.parse(fs.readFileSync(path.join(f.base, 'model-usage-stats.json')));
  assert.equal(model.accounts[f.oldKey], undefined);
  assert.equal(model.accounts[f.newKey].summary.requestCount, 5);
  assert.equal(model.accounts[f.newKey].summary.totalTokens, 50);
  assert.equal(model.accounts[f.verifiedUnknown].accountEmail, NEW);
  assert.equal(model.accounts[f.unrelated].accountEmail, OLD);
  assert.equal(model.accounts[f.geminiKey].summary.requestCount, 11);
  assert.deepEqual(Object.keys(model.accountUsageEvents), [f.geminiKey, f.newKey]);

  const db = new Database(f.sqlitePath, { readonly: true });
  const sqliteDay = JSON.parse(db.prepare('SELECT day_json FROM potluck_usage_history').get().day_json);
  db.close();
  assert.equal(sqliteDay.accounts[f.oldKey], undefined);
  assert.equal(sqliteDay.accounts[f.newKey].summary.requestCount, 5);
  const ledger = fs.readFileSync(f.ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].accountKey, f.newKey);
  assert.equal(ledger[0].usage.requestCount, 5);
  assert.equal(ledger[0].cost.usd, 3);
  const repeated = await runRepair(args);
  assert.equal(repeated.changedSqliteRows, 0);
  assert.equal(repeated.changedFiles.length, 0);
});

test('repair refuses accounts with different Codex IDs', async t => {
  const f = makeFixture();
  t.after(() => { fs.rmSync(f.base, { recursive: true }); fs.unlinkSync(f.backupArchive); });
  writeJson(f.oldCachePath, { providers: { 'openai-codex-oauth': {
    instances: [{ name: OLD, uuid: OLD_UUID, codexAccountId: 'different-id' }],
  } } });
  await assert.rejects(runRepair({ base: f.base, oldCachePath: f.oldCachePath,
    oldEmail: OLD, newEmail: NEW }), /Codex account IDs differ/);
});

test('apply refuses missing or empty backups before changing files', async t => {
  const f = makeFixture();
  t.after(() => { fs.rmSync(f.base, { recursive: true }); fs.unlinkSync(f.backupArchive); });
  const args = { base: f.base, oldCachePath: f.oldCachePath, oldEmail: OLD, newEmail: NEW, apply: true };
  const paths = [path.join(f.base, 'model-usage-stats.json'),
    path.join(f.base, 'api-potluck-keys.json'), f.ledgerPath, f.sqlitePath];
  const before = paths.map(file => fs.readFileSync(file));
  await assert.rejects(runRepair(args), /apply requires an external backup archive/);
  fs.writeFileSync(f.backupArchive, '');
  await assert.rejects(runRepair({ ...args, backupArchive: f.backupArchive }), /backup archive is empty/);
  paths.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
});
