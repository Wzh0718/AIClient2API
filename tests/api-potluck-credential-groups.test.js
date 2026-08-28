import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';

const mockGetCredentialRoutingKeyCatalog = jest.fn();
const mockApplyKeyRoutingAssignments = jest.fn();
const mockGetLedgerKeyIdentities = jest.fn();
const mockGetProviderPoolManager = jest.fn();
const mockAtomicWriteFile = jest.fn();

jest.mock('../src/plugins/api-potluck/key-manager.js', () => ({
    createKey: jest.fn(),
    listKeys: jest.fn(),
    getKey: jest.fn(),
    deleteKey: jest.fn(),
    updateKeyLimit: jest.fn(),
    resetKeyUsage: jest.fn(),
    resetKeyTokenStats: jest.fn(),
    toggleKey: jest.fn(),
    updateKeyName: jest.fn(),
    updateKeyRouting: jest.fn(),
    regenerateKey: jest.fn(),
    getStats: jest.fn(),
    getAccountUsageSummary: jest.fn(),
    validateKey: jest.fn(),
    KEY_PREFIX: 'maki_',
    applyDailyLimitToAllKeys: jest.fn(),
    getAllKeyIds: jest.fn(),
    getLedgerKeyIdentities: mockGetLedgerKeyIdentities,
    resetAllTokenStats: jest.fn(),
    getCredentialRoutingKeyCatalog: mockGetCredentialRoutingKeyCatalog,
    applyKeyRoutingAssignments: mockApplyKeyRoutingAssignments
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: mockGetProviderPoolManager
}));

jest.mock('../src/utils/file-lock.js', () => ({
    atomicWriteFile: mockAtomicWriteFile
}));

const originalCwd = process.cwd();
let tempDir;
let consoleSpies = [];

const RAW_KEY = 'maki_secret_key_0123456789abcdef';
const RAW_UUID_PREFIX = 'uuid-secret-';

function writeAdminToken(token = 'admin-token') {
    fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'configs', 'token-store.json'), JSON.stringify({
        tokens: {
            [token]: { expiryTime: Date.now() + 60 * 60_000 }
        }
    }));
    return token;
}

function makeCredential(index, overrides = {}) {
    const uuid = `${RAW_UUID_PREFIX}${index}`;
    return {
        providerType: 'openai-codex-oauth',
        uuid,
        customName: `Account ${index}`,
        providerWeight: 1,
        isHealthy: true,
        isDisabled: false,
        needsRefresh: false,
        ...overrides
    };
}

function setCredentialPool(credentials) {
    mockGetProviderPoolManager.mockReturnValue({
        providerStatus: {
            'openai-codex-oauth': credentials.map(config => ({
                uuid: config.uuid,
                type: 'openai-codex-oauth',
                config,
                state: { activeCount: 0 }
            }))
        }
    });
}

function setKeyCatalog(keys = [{
    id: RAW_KEY,
    keyId: RAW_KEY,
    name: 'Automation Key',
    enabled: true,
    routingMode: 'auto',
    primaryGroupId: null,
    fixedCredential: null,
    manualLock: false,
    usageHistory: {}
}]) {
    mockGetCredentialRoutingKeyCatalog.mockReturnValue(keys);
}

function makeRequest(method, routePath, body = null, token = 'admin-token', requestUrl = routePath) {
    const serialized = body === null ? '' : JSON.stringify(body);
    const req = Readable.from(serialized ? [serialized] : []);
    req.url = requestUrl;
    req.headers = {
        authorization: token ? `Bearer ${token}` : undefined,
        host: 'localhost',
        ...(serialized ? { 'content-length': String(Buffer.byteLength(serialized)) } : {})
    };
    const res = {
        statusCode: null,
        body: null,
        writeHead(statusCode) {
            this.statusCode = statusCode;
        },
        end(value) {
            this.body = JSON.parse(value);
        }
    };
    return { req, res, method, routePath };
}

async function callRoute(method, routePath, body = null, token = 'admin-token', requestUrl = routePath) {
    const { req, res } = makeRequest(method, routePath, body, token, requestUrl);
    const { handlePotluckApiRoutes } = await import('../src/plugins/api-potluck/api-routes.js');
    const handled = await handlePotluckApiRoutes(method, routePath, req, res);
    expect(handled).toBe(true);
    return res;
}

function readCredentialGroupStore() {
    const filePath = path.join(tempDir, 'configs', 'codex-credential-groups.json');
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

async function createPreview({ credentialCount = 3, keys = undefined } = {}) {
    setCredentialPool(Array.from({ length: credentialCount }, (_, index) => makeCredential(index + 1)));
    setKeyCatalog(keys);
    return callRoute('POST', '/api/potluck/credential-groups/preview', {});
}

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-14T04:00:00.000Z'));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-potluck-credential-groups-'));
    fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
    process.chdir(tempDir);
    consoleSpies = ['log', 'warn', 'error'].map(method => jest.spyOn(console, method).mockImplementation(() => {}));
    mockAtomicWriteFile.mockImplementation(async (filePath, data, options) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, data, options);
    });
    mockApplyKeyRoutingAssignments.mockResolvedValue({
        total: 1,
        updated: 1,
        unchanged: 0,
        skippedLocked: 0,
        persistencePending: false
    });
    mockGetLedgerKeyIdentities.mockReturnValue([]);
    writeAdminToken();
    setKeyCatalog();
    setCredentialPool([makeCredential(1), makeCredential(2), makeCredential(3)]);
});

afterEach(() => {
    consoleSpies.forEach(spy => spy.mockRestore());
    consoleSpies = [];
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.useRealTimers();
});

describe('Potluck Codex credential group management API', () => {
    test('returns only routing options for the route editor', async () => {
        setCredentialPool([makeCredential(1, { customName: 'Primary' })]);
        setKeyCatalog([{
            id: RAW_KEY,
            keyId: RAW_KEY,
            name: 'Automation Key',
            usageHistory: { '2026-08-14': { summary: { totalTokens: 999 } } }
        }]);
        const response = await callRoute('GET', '/api/potluck/credential-groups/options');

        expect(response.statusCode).toBe(200);
        expect(response.body.data.revision).toEqual(expect.any(Number));
        expect(response.body.data.groups).toEqual(expect.any(Array));
        expect(response.body.data.credentials).toEqual([{
            credentialRef: expect.any(String),
            accountEmail: '',
            customName: 'Primary'
        }]);
        expect(response.body.data).not.toHaveProperty('keys');
        expect(response.body.data).not.toHaveProperty('usageHistory');
    });

    test('requires administrator authentication', async () => {
        const response = await callRoute('GET', '/api/potluck/credential-groups', null, null);

        expect(response.statusCode).toBe(401);
        expect(response.body).toMatchObject({
            success: false,
            error: { code: 'UNAUTHORIZED', message: '未授权：请先登录' }
        });
    });

    test('returns the current relation view with only masked Key and credential references', async () => {
        const response = await callRoute('GET', '/api/potluck/credential-groups');
        const serialized = JSON.stringify(response.body);

        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            data: {
                revision: 0,
                groups: [],
                credentials: expect.arrayContaining([
                    expect.objectContaining({ providerType: 'openai-codex-oauth' })
                ]),
                keys: [expect.objectContaining({ keyRef: expect.any(String) })]
            }
        });
        expect(serialized).not.toContain(RAW_KEY);
        expect(serialized).not.toContain(RAW_UUID_PREFIX);
        expect(serialized).not.toContain('token-store.json');
    });

    test('returns the account email for an authenticated credential selector without exposing the UUID', async () => {
        fs.writeFileSync(path.join(tempDir, 'configs', 'provider_pools.json'), JSON.stringify({
            'openai-codex-oauth': [{
                uuid: `${RAW_UUID_PREFIX}1`,
                codexEmail: 'fixed.account@example.com'
            }]
        }));

        const response = await callRoute('GET', '/api/potluck/credential-groups');
        const serialized = JSON.stringify(response.body);

        expect(response.statusCode).toBe(200);
        expect(response.body.data.credentials).toContainEqual(expect.objectContaining({
            providerType: 'openai-codex-oauth',
            accountEmail: 'fixed.account@example.com'
        }));
        expect(serialized).not.toContain(RAW_UUID_PREFIX);
    });

    test('creates a five-minute preview without writing the revision store', async () => {
        const response = await createPreview({ credentialCount: 3 });

        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            data: {
                previewId: expect.any(String),
                baseRevision: 0,
                expiresAt: expect.any(String),
                suggestion: {
                    applicable: true,
                    groupCount: 2,
                    groups: expect.any(Array)
                }
            }
        });
        expect(readCredentialGroupStore()).toBeNull();
        const serialized = JSON.stringify(response.body);
        expect(serialized).not.toContain(RAW_KEY);
        expect(serialized).not.toContain(RAW_UUID_PREFIX);
    });

    test('returns canonical routing diagnostics with masked credential references', async () => {
        setKeyCatalog([{
            id: RAW_KEY,
            keyId: RAW_KEY,
            name: 'Fixed key',
            routingMode: 'fixed',
            fixedCredential: { providerType: 'openai-codex-oauth', uuid: `${RAW_UUID_PREFIX}2` }
        }]);
        fs.writeFileSync(path.join(tempDir, 'configs', 'codex-credential-groups.json'), JSON.stringify({
            version: 1,
            currentRevision: 12,
            revisions: [{
                revision: 12,
                action: 'apply',
                config: {
                    groups: [{ id: 'group-1', name: '固定组', credentialUuids: [`${RAW_UUID_PREFIX}1`] }],
                    keyAssignments: [{
                        keyId: RAW_KEY,
                        routingMode: 'fixed',
                        fixedCredential: { providerType: 'openai-codex-oauth', uuid: `${RAW_UUID_PREFIX}1` }
                    }]
                }
            }]
        }));

        const response = await callRoute('GET', '/api/potluck/credential-groups/diagnostics');
        const serialized = JSON.stringify(response.body);

        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            data: {
                revision: 12,
                diagnostics: [expect.objectContaining({
                    routingMode: 'fixed',
                    routingConfigSource: 'credential-groups',
                    selectedGroupId: 'group-1',
                    status: 'OK',
                    fixedCredential: expect.objectContaining({
                        providerType: 'openai-codex-oauth',
                        credentialRef: expect.any(String)
                    })
                })]
            }
        });
        expect(serialized).not.toContain(RAW_KEY);
        expect(serialized).not.toContain(RAW_UUID_PREFIX);
    });

    test('reports fixed credential mismatch and cooldown distinctly', async () => {
        setKeyCatalog([
            {
                id: `${RAW_KEY}-mismatch`,
                keyId: `${RAW_KEY}-mismatch`,
                name: 'Mismatch key',
                routingMode: 'fixed',
                fixedCredential: { providerType: 'openai-codex-oauth', uuid: `${RAW_UUID_PREFIX}2` }
            },
            {
                id: `${RAW_KEY}-cooldown`,
                keyId: `${RAW_KEY}-cooldown`,
                name: 'Cooldown key',
                routingMode: 'fixed',
                fixedCredential: { providerType: 'openai-codex-oauth', uuid: `${RAW_UUID_PREFIX}3` }
            }
        ]);
        setCredentialPool([
            makeCredential(2),
            makeCredential(3, {
                isHealthy: false,
                scheduledRecoveryTime: '2026-08-14T05:00:00.000Z'
            })
        ]);
        fs.writeFileSync(path.join(tempDir, 'configs', 'codex-credential-groups.json'), JSON.stringify({
            version: 1,
            currentRevision: 7,
            revisions: [{
                revision: 7,
                action: 'apply',
                config: {
                    groups: [{ id: 'group-1', credentialUuids: [`${RAW_UUID_PREFIX}1`] }, { id: 'group-2', credentialUuids: [`${RAW_UUID_PREFIX}3`] }],
                    keyAssignments: [
                        { keyId: `${RAW_KEY}-mismatch`, routingMode: 'fixed', fixedCredential: { providerType: 'openai-codex-oauth', uuid: `${RAW_UUID_PREFIX}2` } },
                        { keyId: `${RAW_KEY}-cooldown`, routingMode: 'fixed', fixedCredential: { providerType: 'openai-codex-oauth', uuid: `${RAW_UUID_PREFIX}3` } }
                    ]
                }
            }]
        }));

        const response = await callRoute('GET', '/api/potluck/credential-groups/diagnostics');
        const byName = Object.fromEntries(response.body.data.diagnostics.map(item => [item.name, item]));

        expect(byName['Mismatch key']).toMatchObject({ status: 'ROUTE_MISMATCH' });
        expect(byName['Cooldown key']).toMatchObject({
            status: 'PROVIDER_COOLDOWN',
            nextRecoveryTime: '2026-08-14T05:00:00.000Z'
        });
    });

    test('returns normalized demand shares and capacity load indexes in a preview', async () => {
        const response = await createPreview({
            credentialCount: 3,
            keys: [
                {
                    id: 'maki_expensive',
                    name: 'Expensive',
                    usageHistory: {
                        '2026-08-14': {
                            summary: { totalTokens: 100, requestCount: 1, cost: { actualUsd: 90 } },
                            models: { 'gpt-5': { totalTokens: 100, requestCount: 1, cost: { actualUsd: 90 } } }
                        }
                    }
                },
                {
                    id: 'maki_small',
                    name: 'Small',
                    usageHistory: {
                        '2026-08-14': {
                            summary: { totalTokens: 1000, requestCount: 10, cost: { actualUsd: 10 } },
                            models: { 'gpt-5-mini': { totalTokens: 1000, requestCount: 10, cost: { actualUsd: 10 } } }
                        }
                    }
                }
            ]
        });

        const groups = response.body.data.suggestion.groups;
        expect(response.body.data.suggestion).toMatchObject({
            demandMetric: 'usd',
            demandModelFilter: 'gpt-*',
            demandModelFilterCaseSensitive: false,
            historyDays: 7,
            timeZone: 'Asia/Shanghai'
        });
        expect(groups.reduce((sum, group) => sum + group.demandShare, 0)).toBeCloseTo(1, 10);
        expect(groups.reduce((sum, group) => sum + group.capacityShare, 0)).toBeCloseTo(1, 10);
        expect(groups.every(group => Number.isFinite(group.loadIndex))).toBe(true);
        expect(response.body.data.suggestion.keyAssignments.find(item => item.name === 'Expensive').demand).toMatchObject({
            metric: 'usd',
            usd: 90
        });
    });

    test('does not create an applicable preview when no credential is available', async () => {
        setCredentialPool([
            makeCredential(1, { fiveHourRemainingRatio: 0 }),
            makeCredential(2, { quotaAvailable: false }),
            makeCredential(3, { isHealthy: false })
        ]);

        const response = await callRoute('POST', '/api/potluck/credential-groups/preview', {});

        expect(response.statusCode).toBe(400);
        expect(response.body).toMatchObject({
            success: false,
            error: { code: 'CREDENTIAL_GROUP_SUGGESTION_NOT_APPLICABLE' }
        });
        expect(readCredentialGroupStore()).toBeNull();
    });

    test('suggests groups with at most two credentials for ten available credentials', async () => {
        const response = await createPreview({ credentialCount: 10 });

        expect(response.statusCode).toBe(200);
        expect(response.body.data.suggestion.groups.map(group => group.credentialCount)).toEqual([2, 2, 2, 2, 2]);
    });

    test('keeps USD demand in preview when compact key history omits model details', async () => {
        const response = await createPreview({
            keys: [{
                id: RAW_KEY,
                keyId: RAW_KEY,
                name: 'Compact history key',
                enabled: true,
                routingMode: 'auto',
                usageHistory: {
                    '2026-08-14': {
                        summary: { requestCount: 2, totalTokens: 100 },
                        demand: {
                            requestCount: 2,
                            totalTokens: 100,
                            actualUsd: 2.5,
                            estimatedUsd: 0.75,
                            usd: 3.25
                        }
                    }
                }
            }]
        });

        expect(response.statusCode).toBe(200);
        expect(response.body.data.suggestion.demandMetric).toBe('usd');
        expect(response.body.data.suggestion.groups.reduce((sum, group) => sum + Number(group.predictedDemandUsd || 0), 0)).toBeCloseTo(3.25, 10);
        expect(response.body.data.suggestion.groups.every(group => group.predictedDemandUsdAvailable === true)).toBe(true);
    });

    test('applies a preview as a revision and synchronizes Key routing in one batch', async () => {
        const preview = await createPreview({ credentialCount: 3 });
        const previewId = preview.body.data.previewId;

        const response = await callRoute('POST', '/api/potluck/credential-groups/apply', { previewId });
        const serialized = JSON.stringify(response.body);

        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            persistencePending: false,
            data: {
                revision: 1,
                action: 'apply',
                sync: { updated: 1 }
            }
        });
        expect(mockApplyKeyRoutingAssignments).toHaveBeenCalledWith([
            expect.objectContaining({ keyId: RAW_KEY, routingMode: 'auto' })
        ]);
        expect(readCredentialGroupStore()).toMatchObject({ currentRevision: 1 });
        expect(serialized).not.toContain(RAW_KEY);
        expect(serialized).not.toContain(RAW_UUID_PREFIX);
    });

    test('returns 202 when Key persistence is pending after revision apply', async () => {
        mockApplyKeyRoutingAssignments.mockResolvedValueOnce({
            total: 1,
            updated: 1,
            unchanged: 0,
            skippedLocked: 0,
            persistencePending: true
        });
        const preview = await createPreview({ credentialCount: 3 });

        const response = await callRoute('POST', '/api/potluck/credential-groups/apply', {
            previewId: preview.body.data.previewId
        });

        expect(response.statusCode).toBe(202);
        expect(response.body.persistencePending).toBe(true);
        expect(response.body.message).toContain('后台重试');
    });

    test('creates a rollback revision and synchronizes the rollback assignments', async () => {
        const firstPreview = await createPreview({ credentialCount: 3 });
        await callRoute('POST', '/api/potluck/credential-groups/apply', {
            previewId: firstPreview.body.data.previewId
        });

        const secondPreview = await createPreview({ credentialCount: 10 });
        await callRoute('POST', '/api/potluck/credential-groups/apply', {
            previewId: secondPreview.body.data.previewId
        });

        const response = await callRoute('POST', '/api/potluck/credential-groups/rollback', {
            baseRevision: 2
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            data: {
                revision: 3,
                action: 'rollback',
                sourceRevision: 1
            }
        });
        expect(mockApplyKeyRoutingAssignments).toHaveBeenCalledTimes(3);
        expect(readCredentialGroupStore()).toMatchObject({ currentRevision: 3 });
    });

    test('rejects an expired preview with 410', async () => {
        const preview = await createPreview({ credentialCount: 3 });
        jest.advanceTimersByTime(5 * 60 * 1000 + 1);

        const response = await callRoute('POST', '/api/potluck/credential-groups/apply', {
            previewId: preview.body.data.previewId
        });

        expect(response.statusCode).toBe(410);
        expect(response.body).toMatchObject({
            success: false,
            error: { code: 'PREVIEW_EXPIRED' }
        });
    });

    test('rejects applying a preview after the current revision changed', async () => {
        const firstPreview = await createPreview({ credentialCount: 3 });
        const secondPreview = await createPreview({ credentialCount: 3 });
        await callRoute('POST', '/api/potluck/credential-groups/apply', {
            previewId: secondPreview.body.data.previewId
        });

        const response = await callRoute('POST', '/api/potluck/credential-groups/apply', {
            previewId: firstPreview.body.data.previewId
        });

        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({
            success: false,
            error: { code: 'CREDENTIAL_GROUP_REVISION_CONFLICT' }
        });
        expect(mockApplyKeyRoutingAssignments).toHaveBeenCalledTimes(1);
    });

    test('lists revisions newest first with a default limit and no configuration contents', async () => {
        const revisions = Array.from({ length: 120 }, (_, index) => ({
            revision: index + 1,
            action: 'apply',
            createdAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
            previousRevision: index || null,
            config: {
                groups: [{ id: `group-${index + 1}`, credentialUuids: [`${RAW_UUID_PREFIX}${index + 1}`] }],
                keyAssignments: [{ keyId: RAW_KEY, routingMode: 'auto', primaryGroupId: `group-${index + 1}` }]
            }
        }));
        fs.writeFileSync(path.join(tempDir, 'configs', 'codex-credential-groups.json'), JSON.stringify({
            version: 1,
            currentRevision: 120,
            revisions
        }));

        const defaultResponse = await callRoute('GET', '/api/potluck/credential-groups/revisions');
        const cappedResponse = await callRoute('GET', '/api/potluck/credential-groups/revisions', null, 'admin-token', '/api/potluck/credential-groups/revisions?limit=500');

        expect(defaultResponse.statusCode).toBe(200);
        expect(defaultResponse.body.data.revisions).toHaveLength(50);
        expect(defaultResponse.body.data.revisions[0]).toMatchObject({ revision: 120, isCurrent: true });
        expect(cappedResponse.body.data.revisions).toHaveLength(100);
        expect(JSON.stringify(defaultResponse.body)).not.toContain(RAW_KEY);
        expect(JSON.stringify(defaultResponse.body)).not.toContain(RAW_UUID_PREFIX);
        expect(JSON.stringify(defaultResponse.body)).not.toContain('config');
    });
});
