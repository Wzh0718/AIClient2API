import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockAtomicWriteFile = jest.fn();
const mockAtomicWriteFileSync = jest.fn();

jest.mock('sharp', () => ({ default: () => ({}) }));

jest.mock('../src/utils/file-lock.js', () => ({
    atomicWriteFile: mockAtomicWriteFile,
    atomicWriteFileSync: mockAtomicWriteFileSync
}));

const originalCwd = process.cwd();
let tempDir;
let consoleSpies = [];

function getStorePath() {
    return path.join(tempDir, 'configs', 'api-potluck-keys.json');
}

function writeStore(store) {
    fs.writeFileSync(getStorePath(), JSON.stringify(store), 'utf8');
}

function readStore() {
    return JSON.parse(fs.readFileSync(getStorePath(), 'utf8'));
}

function writeAdminToken(token = 'admin-token') {
    fs.writeFileSync(path.join(tempDir, 'configs', 'token-store.json'), JSON.stringify({
        tokens: {
            [token]: { expiryTime: Date.now() + 60_000 }
        }
    }));
    return token;
}

async function loadPotluckModules() {
    const [{ default: plugin }, keyManager, apiRoutes] = await Promise.all([
        import('../src/plugins/api-potluck/index.js'),
        import('../src/plugins/api-potluck/key-manager.js'),
        import('../src/plugins/api-potluck/api-routes.js')
    ]);
    return { plugin, keyManager, apiRoutes };
}

async function callPotluckRoute(handler, method, routePath, body, token = 'admin-token') {
    let statusCode = null;
    let responseBody = '';
    const req = {
        url: routePath,
        headers: { authorization: `Bearer ${token}`, host: 'localhost' },
        on(event, callback) {
            if (event === 'data' && body !== undefined) {
                callback(Buffer.from(JSON.stringify(body)));
            }
            if (event === 'end') callback();
            return this;
        },
        resume() {},
        destroy() {}
    };
    const res = {
        writeHead(code) {
            statusCode = code;
        },
        end(value) {
            responseBody = value;
        }
    };

    await handler(method, routePath, req, res);
    return { statusCode, body: JSON.parse(responseBody) };
}

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-13T04:00:00.000Z'));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-potluck-routing-'));
    fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
    process.chdir(tempDir);
    consoleSpies = ['log', 'warn', 'error'].map(method => jest.spyOn(console, method).mockImplementation(() => {}));
    mockAtomicWriteFile.mockImplementation(async (filePath, data, options) => {
        fs.writeFileSync(filePath, data, options);
    });
    mockAtomicWriteFileSync.mockImplementation((filePath, data, options) => {
        fs.writeFileSync(filePath, data, options);
    });
});

afterEach(() => {
    consoleSpies.forEach(spy => spy.mockRestore());
    consoleSpies = [];
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.useRealTimers();
});

describe('API Potluck key credential routing', () => {
    test('creates new keys with explicit whole-pool routing defaults', async () => {
        const { plugin } = await loadPotluckModules();
        const created = await plugin.exports.createKey('Default Routing', 1000);

        expect(created).toMatchObject({
            routingMode: 'pool',
            primaryGroupId: null,
            fixedCredential: null,
            manualLock: false
        });
        expect(readStore().keys[created.id]).toMatchObject({
            routingMode: 'pool',
            primaryGroupId: null,
            fixedCredential: null,
            manualLock: false
        });
    });

    test('normalizes legacy keys without routing fields on load as whole-pool routing', async () => {
        writeStore({
            keys: {
                maki_legacy: {
                    id: 'maki_legacy',
                    name: 'Legacy Key',
                    dailyLimit: 1000,
                    enabled: true,
                    lastResetDate: '2026-08-13'
                }
            }
        });

        const { keyManager } = await loadPotluckModules();
        expect(await keyManager.getKey('maki_legacy')).toMatchObject({
            routingMode: 'pool',
            primaryGroupId: null,
            fixedCredential: null,
            manualLock: false
        });
        expect(await keyManager.validateKey('maki_legacy')).toMatchObject({
            valid: true,
            keyData: {
                routingMode: 'pool',
                primaryGroupId: null,
                fixedCredential: null,
                manualLock: false
            }
        });
    });

    test('updates fixed and auto routing while rejecting fixed mode without a credential UUID', async () => {
        const { keyManager } = await loadPotluckModules();
        const created = await keyManager.createKey('Mutable Routing', 1000);

        await expect(keyManager.updateKeyRouting(created.id, {
            routingMode: 'fixed',
            fixedCredential: { providerType: 'openai-codex-oauth' }
        })).rejects.toMatchObject({ code: 'INVALID_KEY_ROUTING' });

        const fixed = await keyManager.updateKeyRouting(created.id, {
            routingMode: 'fixed',
            fixedCredential: {
                providerType: 'openai-codex-oauth',
                uuid: 'cred-fixed'
            },
            manualLock: true
        });
        expect(fixed).toMatchObject({
            routingMode: 'fixed',
            primaryGroupId: null,
            fixedCredential: {
                providerType: 'openai-codex-oauth',
                uuid: 'cred-fixed'
            },
            manualLock: true
        });

        const automatic = await keyManager.updateKeyRouting(created.id, {
            routingMode: 'auto',
            primaryGroupId: 'group-2',
            manualLock: false
        });
        expect(automatic).toMatchObject({
            routingMode: 'auto',
            primaryGroupId: 'group-2',
            fixedCredential: null,
            manualLock: false
        });

        const pooled = await keyManager.updateKeyRouting(created.id, {
            routingMode: 'pool',
            primaryGroupId: 'ignored-group',
            fixedCredential: { providerType: 'openai-codex-oauth', uuid: 'ignored-credential' },
            manualLock: false
        });
        expect(pooled).toMatchObject({
            routingMode: 'pool',
            primaryGroupId: null,
            fixedCredential: null,
            manualLock: false
        });
    });

    test('returns a detached routing snapshot from key validation', async () => {
        const { keyManager } = await loadPotluckModules();
        const created = await keyManager.createKey('Validation Routing', 1000);
        await keyManager.updateKeyRouting(created.id, {
            routingMode: 'fixed',
            fixedCredential: {
                providerType: 'openai-codex-oauth',
                uuid: 'cred-validation'
            },
            manualLock: true
        });

        const validation = await keyManager.validateKey(created.id);
        expect(validation.keyData).toMatchObject({
            routingMode: 'fixed',
            primaryGroupId: null,
            fixedCredential: {
                providerType: 'openai-codex-oauth',
                uuid: 'cred-validation'
            },
            manualLock: true
        });
        expect(validation.keyData).not.toHaveProperty('usageHistory');

        validation.keyData.fixedCredential.uuid = 'mutated';
        expect((await keyManager.getKey(created.id)).fixedCredential.uuid).toBe('cred-validation');
    });

    test('keeps routing fields after persistence and module reload', async () => {
        const { keyManager } = await loadPotluckModules();
        const created = await keyManager.createKey('Reload Routing', 1000);
        await keyManager.updateKeyRouting(created.id, {
            routingMode: 'auto',
            primaryGroupId: 'group-reload',
            manualLock: true
        });

        jest.resetModules();
        const reloaded = await import('../src/plugins/api-potluck/key-manager.js');
        expect(await reloaded.getKey(created.id)).toMatchObject({
            routingMode: 'auto',
            primaryGroupId: 'group-reload',
            fixedCredential: null,
            manualLock: true
        });
    });

    test('updates routing through the authenticated management API', async () => {
        const { keyManager, apiRoutes } = await loadPotluckModules();
        const token = writeAdminToken();
        const created = await keyManager.createKey('API Routing', 1000);

        const response = await callPotluckRoute(
            apiRoutes.handlePotluckApiRoutes,
            'PUT',
            `/api/potluck/keys/${encodeURIComponent(created.id)}/routing`,
            {
                routingMode: 'fixed',
                fixedCredential: {
                    providerType: 'openai-codex-oauth',
                    uuid: 'cred-api'
                },
                manualLock: true
            },
            token
        );

        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            persistencePending: false,
            data: {
                routingMode: 'fixed',
                primaryGroupId: null,
                fixedCredential: {
                    providerType: 'openai-codex-oauth',
                    uuid: 'cred-api'
                },
                manualLock: true
            }
        });
    });

    test('returns a public fixed credential reference in the Key list for editor preselection', async () => {
        const { keyManager, apiRoutes } = await loadPotluckModules();
        const token = writeAdminToken();
        const created = await keyManager.createKey('Fixed Editor', 1000);
        await keyManager.updateKeyRouting(created.id, {
            routingMode: 'fixed',
            fixedCredential: {
                providerType: 'openai-codex-oauth',
                uuid: 'cred-editor-selection'
            },
            manualLock: true
        });

        const response = await callPotluckRoute(
            apiRoutes.handlePotluckApiRoutes,
            'GET',
            '/api/potluck/keys',
            undefined,
            token
        );
        const serialized = JSON.stringify(response.body);

        expect(response.statusCode).toBe(200);
        expect(response.body.data.keys).toContainEqual(expect.objectContaining({
            id: created.id,
            routingMode: 'fixed',
            fixedCredential: {
                providerType: 'openai-codex-oauth',
                credentialRef: expect.any(String)
            }
        }));
        expect(serialized).not.toContain('cred-editor-selection');
    });

    test('exposes a detached internal catalog with usage history for group planning', async () => {
        const { keyManager } = await loadPotluckModules();
        const created = await keyManager.createKey('Catalog Key', 1000);

        const catalog = keyManager.getCredentialRoutingKeyCatalog();
        expect(catalog).toHaveLength(1);
        expect(catalog[0]).toMatchObject({
            id: created.id,
            keyId: created.id,
            name: 'Catalog Key',
            routingMode: 'pool',
            primaryGroupId: null,
            fixedCredential: null,
            manualLock: false,
            usageHistory: {}
        });

        catalog[0].name = 'mutated';
        catalog[0].usageHistory['2026-08-13'] = { summary: { totalTokens: 99 } };
        expect((await keyManager.getKey(created.id)).name).toBe('Catalog Key');
        expect((await keyManager.getKey(created.id)).usageHistory).toEqual({});
    });

    test('publishes a versioned key-store sync event after routing mutations', async () => {
        const keyManager = await import('../src/plugins/api-potluck/key-manager.js');
        const publish = jest.fn();
        keyManager.setKeyStoreSyncPublisher(publish);
        const created = await keyManager.createKey('Sync Routing', 1000);

        publish.mockClear();
        await keyManager.updateKeyRouting(created.id, {
            routingMode: 'pool',
            primaryGroupId: 'stale-group'
        });

        expect(publish).toHaveBeenCalledWith(expect.objectContaining({
            revision: expect.any(Number),
            reason: 'key-routing-updated'
        }));
    });

    test('rejects stale routing sync and clears legacy assignment fields for pool', async () => {
        const keyManager = await import('../src/plugins/api-potluck/key-manager.js');
        const created = await keyManager.createKey('Sync Pool', 1000);

        expect(keyManager.applyKeyStoreSyncEvent({
            type: 'potluck_key_routing_sync',
            revision: 4,
            records: [{
                keyId: created.id,
                routingMode: 'pool',
                primaryGroupId: 'group-2',
                fixedCredential: { uuid: 'stale' }
            }]
        })).toMatchObject({ applied: true, revision: 4 });
        expect(await keyManager.validateKey(created.id)).toMatchObject({
            valid: true,
            keyData: { routingMode: 'pool', primaryGroupId: null, fixedCredential: null, routingConfigRevision: 4 }
        });
        expect(keyManager.applyKeyStoreSyncEvent({
            revision: 3,
            records: [{ keyId: created.id, routingMode: 'auto', primaryGroupId: 'group-2' }]
        })).toMatchObject({ applied: false, stale: true, revision: 4 });
        expect((await keyManager.validateKey(created.id)).keyData).toMatchObject({
            routingMode: 'pool', primaryGroupId: null, fixedCredential: null
        });
    });

    test('limits the credential routing catalog to the rolling seven-day summary window', async () => {
        const usageHistory = {};
        for (let day = 1; day <= 13; day += 1) {
            const date = `2026-08-${String(day).padStart(2, '0')}`;
            usageHistory[date] = {
                summary: {
                    requestCount: day,
                    totalTokens: day * 100,
                    cost: { actualUsd: day, estimatedUsd: 0, missingPriceTokens: 0 }
                },
                accounts: { [`account-${day}`]: { summary: { totalTokens: day * 100 } } }
            };
        }
        writeStore({
            keys: {
                maki_catalog: {
                    id: 'maki_catalog',
                    name: 'Catalog',
                    enabled: true,
                    lastResetDate: '2026-08-13',
                    usageHistory
                }
            }
        });
        const { keyManager } = await loadPotluckModules();

        const [catalog] = keyManager.getCredentialRoutingKeyCatalog();

        expect(Object.keys(catalog.usageHistory)).toEqual([
            '2026-08-07', '2026-08-08', '2026-08-09', '2026-08-10',
            '2026-08-11', '2026-08-12', '2026-08-13'
        ]);
        expect(catalog.usageHistory['2026-08-13']).toEqual({
            summary: expect.objectContaining({
                requestCount: 13,
                totalTokens: 1300,
                cost: expect.objectContaining({ actualUsd: 13 })
            })
        });
        expect(catalog.usageHistory['2026-08-13']).not.toHaveProperty('accounts');
    });

    test('applies routing assignments atomically, skips locked keys, and persists once', async () => {
        const { keyManager } = await loadPotluckModules();
        const first = await keyManager.createKey('Batch One', 1000);
        const locked = await keyManager.createKey('Batch Locked', 1000);
        const unchanged = await keyManager.createKey('Batch Unchanged', 1000);
        await keyManager.updateKeyRouting(locked.id, {
            routingMode: 'auto',
            primaryGroupId: 'group-locked',
            manualLock: true
        });
        mockAtomicWriteFile.mockClear();

        const result = await keyManager.applyKeyRoutingAssignments([
            {
                keyId: first.id,
                routingMode: 'auto',
                primaryGroupId: 'group-first',
                manualLock: false
            },
            {
                keyId: locked.id,
                routingMode: 'auto',
                primaryGroupId: 'group-generated',
                manualLock: false
            },
            {
                keyId: unchanged.id,
                routingMode: 'auto',
                primaryGroupId: null,
                manualLock: false
            }
        ]);

        expect(result).toMatchObject({
            total: 3,
            updated: 1,
            unchanged: 1,
            skippedLocked: 1,
            persistencePending: false
        });
        expect(mockAtomicWriteFile).toHaveBeenCalledTimes(1);
        expect(await keyManager.getKey(first.id)).toMatchObject({
            primaryGroupId: 'group-first',
            manualLock: false
        });
        expect(await keyManager.getKey(locked.id)).toMatchObject({
            primaryGroupId: 'group-locked',
            manualLock: true
        });
    });

    test('validates the complete batch before changing any Key', async () => {
        const { keyManager } = await loadPotluckModules();
        const created = await keyManager.createKey('Atomic Validation', 1000);
        mockAtomicWriteFile.mockClear();

        await expect(keyManager.applyKeyRoutingAssignments([
            {
                keyId: created.id,
                routingMode: 'auto',
                primaryGroupId: 'group-valid'
            },
            {
                keyId: 'maki_missing',
                routingMode: 'auto',
                primaryGroupId: 'group-invalid'
            }
        ])).rejects.toMatchObject({
            code: 'INVALID_KEY_ROUTING_ASSIGNMENTS',
            details: { reason: 'KEY_NOT_FOUND' }
        });

        expect(await keyManager.getKey(created.id)).toMatchObject({
            routingMode: 'pool',
            primaryGroupId: null,
            manualLock: false
        });
        expect(mockAtomicWriteFile).not.toHaveBeenCalled();
    });
});
