import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

test('hydrates legacy SQLite history with provider-model buckets before recording new usage', async () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'potluck-legacy-shape-'));
  fs.mkdirSync(path.join(tempDir, 'configs', 'usage-events'), { recursive: true });
  process.chdir(tempDir);

  const key = 'maki_legacy_shape_key';
  const keyRef = `sha256:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
  const usage = { requestCount: 1, promptTokens: 100, completionTokens: 20, totalTokens: 120 };
  const account = {
    provider: 'openai-codex-oauth',
    providerUuid: 'legacy-account',
    accountEmail: 'legacy@example.com',
    summary: { ...usage },
    models: { 'gpt-5.5': { ...usage } }
  };
  const day = {
    summary: { ...usage },
    providers: { 'openai-codex-oauth': { ...usage } },
    models: { 'gpt-5.5': { ...usage } },
    accounts: { 'openai-codex-oauth:legacy-account': account },
    hours: {
      '10': {
        summary: { ...usage },
        providers: { 'openai-codex-oauth': { ...usage } },
        models: { 'gpt-5.5': { ...usage } },
        accounts: { 'openai-codex-oauth:legacy-account': account }
      }
    }
  };

  fs.writeFileSync(path.join(tempDir, 'configs', 'api-potluck-keys.json'), JSON.stringify({
    keys: { [key]: { id: key, name: 'Legacy Shape', enabled: true, dailyLimit: 1000, usageHistory: {} } }
  }));
  const database = new Database(path.join(tempDir, 'configs', 'usage-events', 'usage-events.sqlite'));
  database.exec(`
    CREATE TABLE potluck_usage_history (key_ref TEXT NOT NULL, usage_date TEXT NOT NULL, day_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (key_ref, usage_date));
    CREATE TABLE potluck_usage_migrations (source_sha256 TEXT PRIMARY KEY, source_path TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, key_count INTEGER NOT NULL, day_count INTEGER NOT NULL);
    CREATE TABLE potluck_applied_events (event_id TEXT PRIMARY KEY, key_ref TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE potluck_usage_totals (key_ref TEXT PRIMARY KEY, total_models_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE potluck_usage_model_totals (key_ref TEXT NOT NULL, model_name TEXT NOT NULL, usage_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (key_ref, model_name));
    CREATE TABLE potluck_usage_write_metrics (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), event_day_writes INTEGER NOT NULL DEFAULT 0, event_model_writes INTEGER NOT NULL DEFAULT 0, full_history_day_writes INTEGER NOT NULL DEFAULT 0);
    INSERT INTO potluck_usage_write_metrics (singleton) VALUES (1);
  `);
  database.prepare('INSERT INTO potluck_usage_history (key_ref, usage_date, day_json) VALUES (?, ?, ?)').run(keyRef, '2026-08-21', JSON.stringify(day));
  database.close();

  let plugin;
  try {
    plugin = (await import('../src/plugins/api-potluck/index.js')).default;
    await plugin.init({ API_POTLUCK_PERSIST_INTERVAL: 60_000, API_POTLUCK_MAX_DIRTY_AGE: 60_000 });
    const recorded = await plugin.exports.incrementUsage(key, 'openai-codex-oauth', 'gpt-5.5', {
      requestCount: 1,
      promptTokens: 50,
      completionTokens: 10,
      totalTokens: 60
    }, 'legacy-shape-followup', {
      providerUuid: 'legacy-account',
      accountEmail: 'legacy@example.com',
      timestamp: '2026-08-21T02:05:00.000Z'
    });

    assert.equal(recorded.usageHistory['2026-08-21'].providerModels['openai-codex-oauth']['gpt-5.5'].totalTokens, 180);
    assert.equal(recorded.usageHistory['2026-08-21'].hours['10'].providerModels['openai-codex-oauth']['gpt-5.5'].totalTokens, 180);
  } finally {
    if (plugin) await plugin.destroy();
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
