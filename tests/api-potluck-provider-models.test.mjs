import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('potluck usage history persists provider-scoped model buckets', async () => {
  const originalCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'potluck-provider-models-'));
  fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
  process.chdir(tempDir);

  let plugin;
  try {
    plugin = (await import('../src/plugins/api-potluck/index.js')).default;
    await plugin.init({
      API_POTLUCK_PERSIST_INTERVAL: 60_000,
      API_POTLUCK_MAX_DIRTY_AGE: 60_000
    });
    const key = await plugin.exports.createKey('Provider Models', 1000);

    await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'shared-model', {
      requestCount: 2,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120
    }, 'provider-model-codex', {
      providerUuid: 'codex-account',
      accountEmail: 'codex@example.com'
    });
    const recorded = await plugin.exports.incrementUsage(key.id, 'gemini-antigravity', 'shared-model', {
      requestCount: 1,
      promptTokens: 60,
      completionTokens: 20,
      totalTokens: 80
    }, 'provider-model-gemini', {
      providerUuid: 'gemini-account',
      accountEmail: 'gemini@example.com'
    });

    const today = Object.keys(recorded.usageHistory).sort().at(-1);
    const day = recorded.usageHistory[today];
    assert.equal(day.models['shared-model'].totalTokens, 200);
    assert.equal(day.providerModels['openai-codex-oauth']['shared-model'].totalTokens, 120);
    assert.equal(day.providerModels['openai-codex-oauth']['shared-model'].requestCount, 2);
    assert.equal(day.providerModels['gemini-antigravity']['shared-model'].totalTokens, 80);
    assert.equal(day.providerModels['gemini-antigravity']['shared-model'].requestCount, 1);
  } finally {
    if (plugin) await plugin.destroy();
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
