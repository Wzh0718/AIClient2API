import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockAtomicWriteFile = jest.fn();
const mockAtomicWriteFileSync = jest.fn();

jest.mock('../src/utils/file-lock.js', () => ({
    atomicWriteFile: mockAtomicWriteFile,
    atomicWriteFileSync: mockAtomicWriteFileSync
}));

const originalCwd = process.cwd();
let tempDir;
let consoleSpies = [];

async function loadPotluckPlugin() {
    return (await import('../src/plugins/api-potluck/index.js')).default;
}

async function loadPotluckModules() {
    const [{ default: plugin }, keyManager, apiRoutes] = await Promise.all([
        import('../src/plugins/api-potluck/index.js'),
        import('../src/plugins/api-potluck/key-manager.js'),
        import('../src/plugins/api-potluck/api-routes.js')
    ]);
    return { plugin, keyManager, apiRoutes };
}

function getStorePath() {
    return path.join(tempDir, 'configs', 'api-potluck-keys.json');
}

function readStore() {
    return JSON.parse(fs.readFileSync(getStorePath(), 'utf8'));
}

function expectPersistenceStatus(result, expected) {
    expect(result.persistencePending).toBe(expected);
    expect(Object.prototype.propertyIsEnumerable.call(result, 'persistencePending')).toBe(false);
}

function writeAdminToken(token = 'admin-token') {
    fs.writeFileSync(path.join(tempDir, 'configs', 'token-store.json'), JSON.stringify({
        tokens: {
            [token]: { expiryTime: Date.now() + 60_000 }
        }
    }));
    return token;
}

async function callPotluckRoute(handler, method, routePath, body = null, token = 'admin-token', requestUrl = routePath) {
    let statusCode = null;
    let responseBody = '';
    const req = {
        url: requestUrl,
        headers: { authorization: `Bearer ${token}`, host: 'localhost' },
        on(event, callback) {
            if (event === 'data' && body !== null) {
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
    jest.setSystemTime(new Date('2026-07-22T02:00:00.000Z'));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-potluck-persist-'));
    fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
    process.chdir(tempDir);
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
    mockAtomicWriteFile.mockImplementation(async (filePath, data, options) => {
        const tempPath = `${filePath}.${mockAtomicWriteFile.mock.calls.length}.test.tmp`;
        fs.writeFileSync(tempPath, data, options);
        fs.renameSync(tempPath, filePath);
    });
    mockAtomicWriteFileSync.mockImplementation((filePath, data, options) => fs.writeFileSync(filePath, data, options));
});

afterEach(() => {
    jest.clearAllMocks();
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.useRealTimers();
});

describe('api potluck persistence', () => {
    test('resets stale daily counters before a control-worker usage hook records the new day', async () => {
        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });
        const key = await plugin.exports.createKey('Cross-day Control Worker', 1000);

        jest.setSystemTime(new Date('2026-07-22T15:59:59.000Z'));
        await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 3,
            promptTokens: 300,
            completionTokens: 30,
            totalTokens: 330
        }, 'req-before-midnight');

        jest.setSystemTime(new Date('2026-07-22T16:00:01.000Z'));
        const recorded = await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 100,
            completionTokens: 10,
            totalTokens: 110
        }, 'req-after-midnight');

        expect(recorded).toMatchObject({
            lastResetDate: '2026-07-23',
            todayUsage: 1,
            todayPromptTokens: 100,
            todayCompletionTokens: 10,
            todayTotalTokens: 110
        });
        expect(recorded.usageHistory['2026-07-22'].summary.totalTokens).toBe(330);
        expect(recorded.usageHistory['2026-07-23'].summary.totalTokens).toBe(110);

        const stats = await plugin.exports.getStats();
        expect(stats).toMatchObject({
            todayTotalUsage: 1,
            todayPromptTokens: 100,
            todayCompletionTokens: 10,
            todayTotalTokens: 110
        });
    });

    test('reports recorded, delta update, and deduplicated outcomes for one request snapshot', async () => {
        const plugin = await loadPotluckPlugin();
        const key = await plugin.exports.createKey('Usage Outcome', 1000);

        const first = await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 3007,
            completionTokens: 16,
            totalTokens: 3023,
            cachedTokens: 0
        }, 'req-usage-outcome');
        const updated = await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 3007,
            completionTokens: 16,
            totalTokens: 3023,
            cachedTokens: 2688
        }, 'req-usage-outcome');
        const duplicate = await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 3007,
            completionTokens: 16,
            totalTokens: 3023,
            cachedTokens: 2688
        }, 'req-usage-outcome');

        expect(first.usageRecordingStatus).toBe('recorded');
        expect(updated.usageRecordingStatus).toBe('updated-by-delta');
        expect(duplicate.usageRecordingStatus).toBe('deduplicated');
        expect((await plugin.exports.getKey(key.id))).toMatchObject({
            todayUsage: 1,
            todayPromptTokens: 3007,
            todayCachedTokens: 2688,
            todayTotalTokens: 3023
        });
    });

    test('reports missing-key without mutating storage', async () => {
        const plugin = await loadPotluckPlugin();
        const result = await plugin.exports.incrementUsage('maki_missing', 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            totalTokens: 1
        }, 'req-missing-key');

        expect(result).toMatchObject({ usageRecordingStatus: 'missing-key' });
    });

    test('uses the configured persistence interval instead of the 5 second default', async () => {
        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });

        const key = await plugin.exports.createKey('Configured Interval', 1000);
        await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120
        }, 'req-configured-interval');

        await jest.advanceTimersByTimeAsync(5_000);
        expect(readStore().keys[key.id].totalTokens).toBe(0);

        await jest.advanceTimersByTimeAsync(55_000);
        expect(readStore().keys[key.id].totalTokens).toBe(120);
    });

    test('persists compact JSON snapshots', async () => {
        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 5_000,
            API_POTLUCK_MAX_DIRTY_AGE: 5_000
        });

        await plugin.exports.createKey('Compact Snapshot', 1000);
        await jest.advanceTimersByTimeAsync(5_000);

        const content = fs.readFileSync(getStorePath(), 'utf8');
        expect(content).toBe(JSON.stringify(JSON.parse(content)));
    });

    test('keeps mutations dirty when they arrive while a snapshot is being written', async () => {
        let releaseWrite;
        let signalWriteStarted;
        let signalWriteFinished;
        const writeStarted = new Promise((resolve) => { signalWriteStarted = resolve; });
        const writeFinished = new Promise((resolve) => { signalWriteFinished = resolve; });
        const writeRelease = new Promise((resolve) => { releaseWrite = resolve; });

        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 5_000,
            API_POTLUCK_MAX_DIRTY_AGE: 10_000
        });
        const key = await plugin.exports.createKey('Concurrent Mutation', 1000);
        mockAtomicWriteFile.mockClear();
        await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120
        }, 'req-before-write', {
            providerUuid: 'account-a',
            accountEmail: 'account-a@example.com',
            timestamp: '2026-07-22T02:00:00.000Z'
        });
        mockAtomicWriteFile.mockImplementationOnce(async (filePath, data, options) => {
            signalWriteStarted();
            await writeRelease;
            const tempPath = `${filePath}.${mockAtomicWriteFile.mock.calls.length}.test.tmp`;
            fs.writeFileSync(tempPath, data, options);
            fs.renameSync(tempPath, filePath);
            signalWriteFinished();
        });

        jest.advanceTimersByTime(5_000);
        await Promise.resolve();
        expect(mockAtomicWriteFile).toHaveBeenCalledTimes(1);
        await writeStarted;
        await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120
        }, 'req-during-write', {
            providerUuid: 'account-a',
            accountEmail: 'account-a@example.com',
            timestamp: '2026-07-22T02:00:00.000Z'
        });
        releaseWrite();
        await writeFinished;

        await jest.advanceTimersByTimeAsync(5_000);

        expect(readStore().keys[key.id]).toMatchObject({
            totalUsage: 2,
            totalTokens: 240
        });
    });

    test('caps a continuously debounced dirty snapshot at the configured max age', async () => {
        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 10_000,
            API_POTLUCK_MAX_DIRTY_AGE: 15_000
        });
        const key = await plugin.exports.createKey('Bounded Debounce', 1000);

        for (const [elapsed, requestId] of [[0, 'req-1'], [8_000, 'req-2'], [14_000, 'req-3']]) {
            const now = Date.now();
            const target = new Date('2026-07-22T02:00:00.000Z').getTime() + elapsed;
            if (target > now) {
                await jest.advanceTimersByTimeAsync(target - now);
            }
            await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
                requestCount: 1,
                promptTokens: 100,
                completionTokens: 20,
                totalTokens: 120
            }, requestId);
        }

        expect(readStore().keys[key.id].totalTokens).toBe(0);
        await jest.advanceTimersByTimeAsync(1_000);
        expect(readStore().keys[key.id]).toMatchObject({
            totalUsage: 3,
            totalTokens: 360
        });
    });

    test('retains dirty state after a failed write and retries later', async () => {
        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 5_000,
            API_POTLUCK_MAX_DIRTY_AGE: 10_000
        });
        const key = await plugin.exports.createKey('Retry Failed Write', 1000);
        mockAtomicWriteFile.mockClear();
        mockAtomicWriteFile.mockRejectedValueOnce(new Error('simulated write failure'));

        await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120
        }, 'req-write-failure');

        await jest.advanceTimersByTimeAsync(5_000);
        expect(readStore().keys[key.id].totalTokens).toBe(0);

        await jest.advanceTimersByTimeAsync(5_000);
        expect(readStore().keys[key.id].totalTokens).toBe(120);
    });

    test('reports a serialization failure as pending while retaining the in-memory mutation for retry', async () => {
        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 5_000,
            API_POTLUCK_MAX_DIRTY_AGE: 5_000
        });
        const key = await plugin.exports.createKey('Serialization Failure', 1000);
        mockAtomicWriteFile.mockClear();
        const stringifySpy = jest.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
            throw new Error('simulated serialization failure');
        });
        let result;
        try {
            result = await plugin.exports.updateKeyName(key.id, 'Pending Retry');
        } finally {
            stringifySpy.mockRestore();
        }

        expect(result).toMatchObject({
            id: key.id,
            name: 'Pending Retry',
            persistencePending: true
        });
        expect((await plugin.exports.getKey(key.id)).name).toBe('Pending Retry');
        expect(readStore().keys[key.id].name).toBe('Serialization Failure');
        expect(mockAtomicWriteFile).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(0);
        expect(mockAtomicWriteFile).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBeGreaterThan(0);

        await jest.advanceTimersByTimeAsync(5_000);
        expect(readStore().keys[key.id].name).toBe('Pending Retry');
    });

    test('returns a validation snapshot that cannot mutate the active key store', async () => {
        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });
        const key = await plugin.exports.createKey('Validation Snapshot', 1000);

        const validation = await plugin.exports.validateKey(key.id);
        expect(validation).toMatchObject({
            valid: true,
            keyData: {
                id: key.id,
                name: 'Validation Snapshot',
                dailyLimit: 1000,
                todayUsage: 0,
                enabled: true
            }
        });
        expect(validation.keyData).not.toHaveProperty('usageHistory');

        validation.keyData.name = 'Leaked Mutation';
        validation.keyData.dailyLimit = 1;
        validation.keyData.enabled = false;

        expect(await plugin.exports.getKey(key.id)).toMatchObject({
            name: 'Validation Snapshot',
            dailyLimit: 1000,
            enabled: true
        });
        expect(readStore().keys[key.id]).toMatchObject({
            name: 'Validation Snapshot',
            dailyLimit: 1000,
            enabled: true
        });
    });

    test('returns persistencePending for every key administration mutation without persisting the flag', async () => {
        const { plugin, keyManager } = await loadPotluckModules();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });

        const created = await keyManager.createKey('Admin Mutations', 1000);
        expectPersistenceStatus(created, false);
        expectPersistenceStatus(await keyManager.updateKeyLimit(created.id, 2000), false);
        expectPersistenceStatus(await keyManager.resetKeyUsage(created.id), false);
        expectPersistenceStatus(await keyManager.resetKeyTokenStats(created.id), false);
        expectPersistenceStatus(await keyManager.toggleKey(created.id), false);
        expectPersistenceStatus(await keyManager.updateKeyName(created.id, 'Renamed'), false);
        expectPersistenceStatus(await keyManager.applyDailyLimitToAllKeys(2500), false);
        expectPersistenceStatus(await keyManager.resetAllTokenStats(), false);

        const regenerated = await keyManager.regenerateKey(created.id);
        expectPersistenceStatus(regenerated, false);
        const deleted = await keyManager.deleteKey(regenerated.newKey);
        expect(deleted).toMatchObject({ deleted: true, keyId: regenerated.newKey, persistencePending: false });
        expectPersistenceStatus(deleted, false);

        const persisted = readStore();
        expect(JSON.stringify(persisted)).not.toContain('persistencePending');
    });

    test('regenerated keys retain the previous ledger hash as a long-term usage alias', async () => {
        const { plugin, keyManager } = await loadPotluckModules();
        const { hashSecret } = await import('../src/plugins/request-audit/audit-event.js');
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });

        const created = await keyManager.createKey('Ledger Alias', 1000);
        const regenerated = await keyManager.regenerateKey(created.id);
        const identity = keyManager.getLedgerKeyIdentities().find(item => item.keyId === regenerated.newKey);

        expect(identity.hashes).toContain(hashSecret(created.id));
        expect(identity.hashes).toContain(hashSecret(regenerated.newKey));
        expect(readStore().keys[regenerated.newKey].ledgerKeyHashes).toEqual([hashSecret(created.id)]);
    });

    test('serves inclusive custom ledger ranges and rejects invalid dates through the admin route', async () => {
        const { plugin, apiRoutes } = await loadPotluckModules();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });
        const token = writeAdminToken();
        const dailyDir = path.join(tempDir, 'configs', 'permanent-usage-ledger', 'daily');
        fs.mkdirSync(dailyDir, { recursive: true });
        const ledgerRow = (date, totalTokens) => JSON.stringify({
            date,
            provider: 'openai-codex-oauth',
            accountKey: 'openai-codex-oauth:test@example.com',
            accountEmail: 'test@example.com',
            model: 'gpt-5.5',
            usage: {
                requestCount: 1,
                promptTokens: totalTokens - 20,
                cachedTokens: 10,
                completionTokens: 20,
                totalTokens
            },
            cost: { actualUsd: 0.01, missingPriceTokens: 0 }
        });
        fs.writeFileSync(path.join(dailyDir, 'usage-2026-01-01.jsonl'), `${ledgerRow('2026-01-01', 100)}\n`);
        fs.writeFileSync(path.join(dailyDir, 'usage-2026-01-15.jsonl'), `${ledgerRow('2026-01-15', 50)}\n`);

        const valid = await callPotluckRoute(
            apiRoutes.handlePotluckApiRoutes,
            'GET',
            '/api/potluck/range-stats',
            null,
            token,
            '/api/potluck/range-stats?range=custom&from=2026-01-01&to=2026-01-15'
        );

        expect(valid.statusCode).toBe(200);
        expect(valid.body.data).toMatchObject({
            range: 'custom',
            from: '2026-01-01',
            to: '2026-01-15',
            summary: { requestCount: 2, totalTokens: 150 },
            availableDates: ['2026-01-01', '2026-01-15']
        });
        expect(valid.body.data.dates).toHaveLength(15);

        const invalid = await callPotluckRoute(
            apiRoutes.handlePotluckApiRoutes,
            'GET',
            '/api/potluck/range-stats',
            null,
            token,
            '/api/potluck/range-stats?range=custom&from=2025-12-31&to=2026-01-15'
        );

        expect(invalid.statusCode).toBe(400);
        expect(invalid.body).toMatchObject({
            success: false,
            error: { code: 'INVALID_DATE_RANGE' }
        });
    });

    test('returns HTTP 202 when an accepted key mutation is waiting for persistence and retries later', async () => {
        const { plugin, apiRoutes } = await loadPotluckModules();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 5_000,
            API_POTLUCK_MAX_DIRTY_AGE: 5_000
        });
        const token = writeAdminToken();
        mockAtomicWriteFile.mockRejectedValueOnce(new Error('simulated route write failure'));

        const response = await callPotluckRoute(
            apiRoutes.handlePotluckApiRoutes,
            'POST',
            '/api/potluck/keys',
            { name: 'Pending Route Key', dailyLimit: 1000 },
            token
        );

        expect(response.statusCode).toBe(202);
        expect(response.body).toMatchObject({
            success: true,
            persistencePending: true,
            data: { name: 'Pending Route Key' }
        });
        expect(response.body.data).not.toHaveProperty('persistencePending');
        expect(response.body.message).toContain('变更已在内存生效');
        expect(response.body.message).toContain('服务重启前请稍后确认');
        expect((await plugin.exports.getKey(response.body.data.id)).name).toBe('Pending Route Key');

        await jest.advanceTimersByTimeAsync(5_000);
        expect(readStore().keys[response.body.data.id].name).toBe('Pending Route Key');
    });

    test('persists key administration changes immediately', async () => {
        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });
        const key = await plugin.exports.createKey('Immediate Admin Change', 1000);

        await plugin.exports.updateKeyLimit(key.id, 2500);

        expect(readStore().keys[key.id].dailyLimit).toBe(2500);
    });

    test('waits for a trailing snapshot when an admin change arrives during a write', async () => {
        let releaseFirstWrite;
        let releaseTrailingWrite;
        let signalFirstWriteStarted;
        let signalTrailingWriteStarted;
        const firstWriteStarted = new Promise((resolve) => { signalFirstWriteStarted = resolve; });
        const trailingWriteStarted = new Promise((resolve) => { signalTrailingWriteStarted = resolve; });
        const firstWriteRelease = new Promise((resolve) => { releaseFirstWrite = resolve; });
        const trailingWriteRelease = new Promise((resolve) => { releaseTrailingWrite = resolve; });

        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 5_000,
            API_POTLUCK_MAX_DIRTY_AGE: 10_000
        });
        const key = await plugin.exports.createKey('Concurrent Admin Change', 1000);
        mockAtomicWriteFile.mockImplementationOnce(async (filePath, data, options) => {
            signalFirstWriteStarted();
            await firstWriteRelease;
            const tempPath = `${filePath}.${mockAtomicWriteFile.mock.calls.length}.test.tmp`;
            fs.writeFileSync(tempPath, data, options);
            fs.renameSync(tempPath, filePath);
        });
        mockAtomicWriteFile.mockImplementationOnce(async (filePath, data, options) => {
            signalTrailingWriteStarted();
            await trailingWriteRelease;
            const tempPath = `${filePath}.${mockAtomicWriteFile.mock.calls.length}.test.tmp`;
            fs.writeFileSync(tempPath, data, options);
            fs.renameSync(tempPath, filePath);
        });
        await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120
        }, 'req-before-admin-change');

        jest.advanceTimersByTime(5_000);
        await firstWriteStarted;
        const updatePromise = plugin.exports.updateKeyLimit(key.id, 2500);
        releaseFirstWrite();
        await trailingWriteStarted;
        await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120
        }, 'req-after-admin-change');
        releaseTrailingWrite();
        await updatePromise;

        expect(readStore().keys[key.id]).toMatchObject({
            dailyLimit: 2500,
            totalTokens: 120
        });
        expect((await plugin.exports.getKey(key.id)).totalTokens).toBe(240);
    });

    test('flushes pending changes when the plugin is destroyed', async () => {
        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });
        const key = await plugin.exports.createKey('Graceful Shutdown', 1000);
        await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120
        }, 'req-before-destroy');

        await plugin.destroy();

        expect(readStore().keys[key.id].totalTokens).toBe(120);
    });

    test('retries one failed shutdown write immediately and resolves after the retry persists', async () => {
        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });
        const key = await plugin.exports.createKey('Shutdown Retry', 1000);
        mockAtomicWriteFile.mockClear();
        mockAtomicWriteFile.mockRejectedValueOnce(new Error('transient shutdown write failure'));
        await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120
        }, 'req-shutdown-retry');

        await plugin.destroy();

        expect(mockAtomicWriteFile).toHaveBeenCalledTimes(2);
        expect(readStore().keys[key.id].totalTokens).toBe(120);
    });

    test('rejects shutdown with a clear error after the bounded persistence retry also fails', async () => {
        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });
        const key = await plugin.exports.createKey('Shutdown Failure', 1000);
        mockAtomicWriteFile.mockClear();
        mockAtomicWriteFile.mockRejectedValue(new Error('persistent shutdown write failure'));
        await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120
        }, 'req-shutdown-failure');

        await expect(plugin.destroy()).rejects.toThrow(
            'API Potluck shutdown failed: pending changes could not be persisted after 2 attempts'
        );
        expect(mockAtomicWriteFile).toHaveBeenCalledTimes(2);
        expect(readStore().keys[key.id].totalTokens).toBe(0);
    });
});
