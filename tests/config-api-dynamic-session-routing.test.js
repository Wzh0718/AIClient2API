import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { handleGetConfig, handleUpdateConfig } from '../src/ui-modules/config-api.js';
import { CODEX_RUNTIME_CONFIG_SYNC_TYPE, resetCodexRuntimeConfigSyncForTests } from '../src/runtime/codex-runtime-config-sync.js';

jest.mock('../src/providers/adapter.js', () => ({ serviceInstances: {}, getServiceAdapter: jest.fn(), getRegisteredProviders: jest.fn(() => []), invalidateServiceAdapter: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ initApiService: jest.fn(), getProviderPoolManager: jest.fn(() => null) }));
jest.mock('../src/utils/common.js', () => ({
  getRequestBody: req => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  })
}));
jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));
jest.mock('../src/ui-modules/auth.js', () => ({ validateCredentials: jest.fn() }));

function makeRequest(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = {};
  return req;
}

function makeResponse() {
  return { statusCode: null, body: '', writeHead(code) { this.statusCode = code; }, end(chunk) { this.body += chunk || ''; } };
}

describe('config api dynamic session routing switch', () => {
  let originalCwd;
  let tmpDir;
  let originalRole;
  let originalSend;

  beforeEach(() => {
    resetCodexRuntimeConfigSyncForTests();
    originalCwd = process.cwd();
    originalRole = process.env.RUNTIME_WORKER_ROLE;
    originalSend = process.send;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-api-dynamic-'));
    fs.mkdirSync(path.join(tmpDir, 'configs'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.send = originalSend;
    if (originalRole === undefined) delete process.env.RUNTIME_WORKER_ROLE;
    else process.env.RUNTIME_WORKER_ROLE = originalRole;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function save(currentConfig, body) {
    const res = makeResponse();
    await handleUpdateConfig(makeRequest(body), res, currentConfig);
    expect(res.statusCode).toBe(200);
    return JSON.parse(fs.readFileSync(path.join(tmpDir, 'configs', 'config.json'), 'utf8'));
  }

  test('persists the switch and allow-list so a UI save no longer drops them', async () => {
    const config = { CODEX_DYNAMIC_SESSION_ROUTING_ENABLED: true, CODEX_DYNAMIC_SESSION_ROUTING_KEY_IDS: ['key-a'] };
    const saved = await save(config, { REQUEST_MAX_RETRIES: 2 });
    expect(saved.CODEX_DYNAMIC_SESSION_ROUTING_ENABLED).toBe(true);
    expect(saved.CODEX_DYNAMIC_SESSION_ROUTING_KEY_IDS).toEqual(['key-a']);
  });

  test('accepts a comma separated allow-list and string booleans from the page', async () => {
    const config = {};
    const saved = await save(config, { CODEX_DYNAMIC_SESSION_ROUTING_ENABLED: 'true', CODEX_DYNAMIC_SESSION_ROUTING_KEY_IDS: ' key-a, key-b ,' });
    expect(saved.CODEX_DYNAMIC_SESSION_ROUTING_ENABLED).toBe(true);
    expect(saved.CODEX_DYNAMIC_SESSION_ROUTING_KEY_IDS).toEqual(['key-a', 'key-b']);
  });

  test('exposes the switch through GET config', async () => {
    const res = makeResponse();
    await handleGetConfig({}, res, { CODEX_DYNAMIC_SESSION_ROUTING_ENABLED: true, CODEX_DYNAMIC_SESSION_ROUTING_KEY_IDS: ['key-a'] });
    const body = JSON.parse(res.body);
    expect(body.CODEX_DYNAMIC_SESSION_ROUTING_ENABLED).toBe(true);
    expect(body.CODEX_DYNAMIC_SESSION_ROUTING_KEY_IDS).toEqual(['key-a']);
  });

  test('control worker broadcasts the new switch value to execution workers only when it changed', async () => {
    process.env.RUNTIME_WORKER_ROLE = 'control';
    const sent = [];
    process.send = message => sent.push(message);
    const config = { CODEX_DYNAMIC_SESSION_ROUTING_ENABLED: false, CODEX_DYNAMIC_SESSION_ROUTING_KEY_IDS: [] };

    await save(config, { CODEX_DYNAMIC_SESSION_ROUTING_ENABLED: true, CODEX_DYNAMIC_SESSION_ROUTING_KEY_IDS: 'key-a' });
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe(CODEX_RUNTIME_CONFIG_SYNC_TYPE);
    expect(sent[0].config).toMatchObject({ CODEX_DYNAMIC_SESSION_ROUTING_ENABLED: true, CODEX_DYNAMIC_SESSION_ROUTING_KEY_IDS: ['key-a'] });

    await save(config, { REQUEST_MAX_RETRIES: 3 });
    expect(sent).toHaveLength(1);
  });

  test('execution workers never broadcast', async () => {
    process.env.RUNTIME_WORKER_ROLE = 'execution';
    const sent = [];
    process.send = message => sent.push(message);
    await save({}, { CODEX_DYNAMIC_SESSION_ROUTING_ENABLED: true });
    expect(sent).toHaveLength(0);
  });
});
