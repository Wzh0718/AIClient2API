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

jest.mock('../src/plugins/api-potluck/usage-history-store.js', () => ({
    importLegacyUsageHistories: jest.fn(() => ({ imported: true })),
    hasAppliedUsageEvent: jest.fn(() => false),
    loadUsageHistory: jest.fn(() => ({})),
    loadUsageTotals: jest.fn(() => ({})),
    persistUsageHistory: jest.fn(),
    persistUsageHistoryEvent: jest.fn(() => ({ duplicate: false })),
    deleteUsageHistory: jest.fn()
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

function writeCredentialGroupStore(keyId, routing) {
    fs.writeFileSync(
        path.join(tempDir, 'configs', 'codex-credential-groups.json'),
        JSON.stringify({
            version: 1,
            currentRevision: 1,
            revisions: [{
                revision: 1,
                action: 'apply',
                createdAt: '2026-08-13T03:00:00.000Z',
                previousRevision: null,
                sourceRevision: null,
                config: {
                    groups: [],
                    keyAssignments: [{ keyId, ...routing }],
                    generatedAt: '2026-08-13T03:00:00.000Z',
                    timeZone: 'Asia/Shanghai',
                    historyDays: 7
                }
            }]
        }),
        'utf8'
    );
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

    test('updates the authoritative credential-group assignment with Key routing', async () => {
        const { keyManager, apiRoutes } = await loadPotluckModules();
        const token = writeAdminToken();
        const created = await keyManager.createKey('Synchronized Routing', 1000);
        writeCredentialGroupStore(created.id, {
            routingMode: 'fixed',
            primaryGroupId: null,
            fixedCredential: {
                providerType: 'openai-codex-oauth',
                uuid: 'cred-fixed'
            },
            manualLock: false
        });

        const response = await callPotluckRoute(
            apiRoutes.handlePotluckApiRoutes,
            'PUT',
            `/api/potluck/keys/${encodeURIComponent(created.id)}/routing`,
            {
                routingMode: 'pool',
                primaryGroupId: null,
                fixedCredential: null,
                manualLock: false
            },
            token
        );

        expect(response.statusCode).toBe(200);
        expect(readStore().keys[created.id]).toMatchObject({
            routingMode: 'pool',
            primaryGroupId: null,
            fixedCredential: null
        });
        const groupStore = JSON.parse(fs.readFileSync(
            path.join(tempDir, 'configs', 'codex-credential-groups.json'),
            'utf8'
        ));
        const current = groupStore.revisions.find(entry => entry.revision === groupStore.currentRevision);
        expect(current.config.keyAssignments).toContainEqual(expect.objectContaining({
            keyId: created.id,
            routingMode: 'pool',
            primaryGroupId: null,
            fixedCredential: null
        }));
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

    test('publishes a versioned full key config snapshot after every auth configuration mutation', async () => {
        const keyManager = await import('../src/plugins/api-potluck/key-manager.js');
        const publish = jest.fn();
        keyManager.setKeyStoreSyncPublisher(publish, { epoch: 'control-epoch-a' });
        const created = await keyManager.createKey('Sync Routing', 1000);

        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
            type: 'potluck_key_config_sync',
            epoch: 'control-epoch-a',
            revision: 1,
            reason: 'key-created',
            records: [expect.objectContaining({
                keyId: created.id,
                name: 'Sync Routing',
                enabled: true,
                dailyLimit: 1000,
                routingMode: 'pool'
            })]
        }));

        await keyManager.updateKeyLimit(created.id, 2000);
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
            revision: 2,
            reason: 'key-limit-updated',
            records: [expect.objectContaining({ keyId: created.id, dailyLimit: 2000 })]
        }));

        await keyManager.updateKeyName(created.id, 'Renamed');
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
            revision: 3,
            reason: 'key-name-updated',
            records: [expect.objectContaining({ keyId: created.id, name: 'Renamed' })]
        }));

        await keyManager.toggleKey(created.id);
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
            revision: 4,
            reason: 'key-enabled-updated',
            records: [expect.objectContaining({ keyId: created.id, enabled: false })]
        }));

        await keyManager.updateKeyRouting(created.id, {
            routingMode: 'pool',
            primaryGroupId: 'stale-group'
        });
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
            revision: 5,
            reason: 'key-routing-updated',
            records: [expect.objectContaining({ keyId: created.id, routingMode: 'pool' })]
        }));

        await keyManager.deleteKey(created.id);
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
            revision: 6,
            reason: 'key-deleted',
            records: []
        }));

        const recreated = await keyManager.createKey('Batch Config', 1000);
        await keyManager.applyDailyLimitToAllKeys(3000);
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
            revision: 8,
            reason: 'all-key-limits-updated',
            records: [expect.objectContaining({ keyId: recreated.id, dailyLimit: 3000 })]
        }));

        await keyManager.applyKeyRoutingAssignments([{
            keyId: recreated.id,
            routingMode: 'auto',
            primaryGroupId: 'group-a'
        }]);
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
            revision: 9,
            reason: 'key-routing-assignments-updated',
            records: [expect.objectContaining({ keyId: recreated.id, routingMode: 'auto', primaryGroupId: 'group-a' })]
        }));

        const regenerated = await keyManager.regenerateKey(recreated.id);
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
            revision: 10,
            reason: 'key-regenerated',
            records: [expect.objectContaining({ keyId: regenerated.newKey })]
        }));
        expect(publish.mock.calls.at(-1)[0].records).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ keyId: recreated.id })])
        );
    });

    test('applies a full config snapshot atomically while preserving usage state', async () => {
        const keyManager = await import('../src/plugins/api-potluck/key-manager.js');
        const retained = await keyManager.createKey('Retained', 1000);
        const removed = await keyManager.createKey('Removed', 1000);
        await keyManager.incrementUsage(retained.id, 'gemini-antigravity', 'gemini-2.5-flash', {
            requestCount: 2,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120
        }, 'usage-before-sync');

        expect(keyManager.applyKeyStoreSyncEvent({
            type: 'potluck_key_config_sync',
            epoch: 'control-epoch-a',
            revision: 1,
            records: [{
                keyId: retained.id,
                name: 'Retained Updated',
                enabled: true,
                dailyLimit: 2500,
                routingMode: 'fixed',
                primaryGroupId: null,
                fixedCredential: { providerType: 'gemini-antigravity', uuid: 'credential-a' },
                manualLock: true
            }, {
                keyId: 'maki_new_from_control',
                name: 'New From Control',
                enabled: true,
                dailyLimit: 0,
                routingMode: 'pool',
                primaryGroupId: null,
                fixedCredential: null,
                manualLock: false
            }]
        })).toMatchObject({ applied: true, epoch: 'control-epoch-a', revision: 1, records: 2, removed: 1 });

        expect(await keyManager.validateKey(retained.id)).toMatchObject({
            valid: true,
            keyData: {
                name: 'Retained Updated',
                dailyLimit: 2500,
                todayUsage: 2,
                routingMode: 'fixed',
                fixedCredential: { providerType: 'gemini-antigravity', uuid: 'credential-a' },
                manualLock: true,
                configSyncEpoch: 'control-epoch-a',
                configSyncRevision: 1
            }
        });
        expect(await keyManager.getKey(retained.id)).toMatchObject({ todayUsage: 2, totalTokens: 120 });
        expect(await keyManager.validateKey('maki_new_from_control')).toMatchObject({ valid: true });
        expect(await keyManager.validateKey(removed.id)).toMatchObject({ valid: false, reason: 'not_found' });
    });

    test('rejects stale and malformed snapshots but accepts revision one from a new control epoch', async () => {
        const keyManager = await import('../src/plugins/api-potluck/key-manager.js');
        const created = await keyManager.createKey('Sync Epoch', 1000);
        const record = {
            keyId: created.id,
            name: 'Epoch A',
            enabled: true,
            dailyLimit: 1000,
            routingMode: 'pool',
            primaryGroupId: null,
            fixedCredential: null,
            manualLock: false
        };

        expect(keyManager.applyKeyStoreSyncEvent({
            type: 'potluck_key_config_sync', epoch: 'epoch-a', revision: 4, records: [record]
        })).toMatchObject({ applied: true, epoch: 'epoch-a', revision: 4 });
        expect(keyManager.applyKeyStoreSyncEvent({
            type: 'potluck_key_config_sync', epoch: 'epoch-a', revision: 3, records: [{ ...record, name: 'Stale' }]
        })).toMatchObject({ applied: false, stale: true, epoch: 'epoch-a', revision: 4 });
        expect(keyManager.applyKeyStoreSyncEvent({
            type: 'potluck_key_config_sync', epoch: 'epoch-b', revision: 1,
            records: [{ ...record, name: 'Epoch B' }, { keyId: 'invalid-record' }]
        })).toMatchObject({ applied: false, malformed: true, epoch: 'epoch-a', revision: 4 });
        expect((await keyManager.getKey(created.id)).name).toBe('Epoch A');
        expect(keyManager.applyKeyStoreSyncEvent({
            type: 'potluck_key_config_sync', epoch: 'epoch-b', revision: 1,
            records: [{ ...record, name: 'Epoch B' }]
        })).toMatchObject({ applied: true, epoch: 'epoch-b', revision: 1 });
        expect((await keyManager.validateKey(created.id)).keyData).toMatchObject({
            name: 'Epoch B', configSyncEpoch: 'epoch-b', configSyncRevision: 1
        });
    });

    test('makes a key created by a running control worker available in an already-loaded execution worker', async () => {
        const executionDir = path.join(tempDir, 'execution');
        fs.mkdirSync(path.join(executionDir, 'configs'), { recursive: true });
        fs.writeFileSync(path.join(executionDir, 'configs', 'api-potluck-keys.json'), JSON.stringify({ keys: {} }));

        const control = await import('../src/plugins/api-potluck/key-manager.js');
        const publish = jest.fn();
        control.setKeyStoreSyncPublisher(publish, { epoch: 'live-control' });
        const created = await control.createKey('Live Key', 0);
        const event = publish.mock.calls.at(-1)[0];

        jest.resetModules();
        process.chdir(executionDir);
        const execution = await import('../src/plugins/api-potluck/key-manager.js');
        expect(await execution.validateKey(created.id)).toMatchObject({ valid: false, reason: 'not_found' });

        expect(execution.applyKeyStoreSyncEvent(event)).toMatchObject({ applied: true, records: 1 });
        expect(await execution.validateKey(created.id)).toMatchObject({
            valid: true,
            keyData: { name: 'Live Key', configSyncEpoch: 'live-control', configSyncRevision: 1 }
        });
        process.chdir(tempDir);
    });

    test('publishes the latest full snapshot after a failed persistence attempt later succeeds', async () => {
        const keyManager = await import('../src/plugins/api-potluck/key-manager.js');
        const publish = jest.fn();
        keyManager.setKeyStoreSyncPublisher(publish, { epoch: 'retry-control' });
        mockAtomicWriteFile
            .mockRejectedValueOnce(new Error('temporary disk failure'))
            .mockImplementation(async (filePath, data, options) => fs.writeFileSync(filePath, data, options));

        const created = await keyManager.createKey('Retry Sync', 1000);
        expect(created.persistencePending).toBe(true);
        expect(publish).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(5000);

        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
            type: 'potluck_key_config_sync',
            epoch: 'retry-control',
            reason: 'key-created',
            records: [expect.objectContaining({ keyId: created.id })]
        }));
    });

    test('never publishes a newer in-memory config before that exact config is persisted', async () => {
        const keyManager = await import('../src/plugins/api-potluck/key-manager.js');
        const publish = jest.fn();
        keyManager.setKeyStoreSyncPublisher(publish, { epoch: 'concurrent-control' });

        let releaseFirstWrite;
        let releaseSecondWrite;
        let firstWriteStarted;
        let secondWriteStarted;
        const firstStarted = new Promise(resolve => { firstWriteStarted = resolve; });
        const secondStarted = new Promise(resolve => { secondWriteStarted = resolve; });
        const firstGate = new Promise(resolve => { releaseFirstWrite = resolve; });
        const secondGate = new Promise(resolve => { releaseSecondWrite = resolve; });
        mockAtomicWriteFile
            .mockImplementationOnce(async (filePath, data, options) => {
                firstWriteStarted();
                await firstGate;
                fs.writeFileSync(filePath, data, options);
            })
            .mockImplementationOnce(async (filePath, data, options) => {
                secondWriteStarted();
                await secondGate;
                fs.writeFileSync(filePath, data, options);
            });

        const createPromise = keyManager.createKey('Persisted A', 1000);
        await firstStarted;
        const [keyId] = keyManager.getAllKeyIds();
        const renamePromise = keyManager.updateKeyName(keyId, 'In Memory B');

        releaseFirstWrite();
        const created = await createPromise;
        expect(created.id).toBe(keyId);
        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish.mock.calls[0][0].records).toEqual([
            expect.objectContaining({ keyId, name: 'Persisted A' })
        ]);

        await secondStarted;
        releaseSecondWrite();
        await renamePromise;
        expect(publish).toHaveBeenCalledTimes(2);
        expect(publish.mock.calls[1][0].records).toEqual([
            expect.objectContaining({ keyId, name: 'In Memory B' })
        ]);
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
