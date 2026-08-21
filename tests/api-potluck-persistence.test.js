import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';

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

function getUsageDatabasePath() {
    return path.join(tempDir, 'configs', 'usage-events', 'usage-events.sqlite');
}

function readUsageHistoryRows() {
    const database = new Database(getUsageDatabasePath(), { readonly: true });
    try {
        return database.prepare(`
            SELECT key_ref, usage_date, day_json
            FROM potluck_usage_history
            ORDER BY key_ref, usage_date
        `).all().map((row) => ({
            ...row,
            day: JSON.parse(row.day_json)
        }));
    } finally {
        database.close();
    }
}

function readUsageModelRows() {
    const database = new Database(getUsageDatabasePath(), { readonly: true });
    try {
        return database.prepare(`
            SELECT model_name, usage_json
            FROM potluck_usage_model_totals
            ORDER BY model_name
        `).all().map(row => ({ ...row, usage: JSON.parse(row.usage_json) }));
    } finally {
        database.close();
    }
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
    test('normalizes legacy SQLite day and hour history before provider-model writes', async () => {
        let plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });
        const key = await plugin.exports.createKey('Legacy SQLite Shape', 1000);
        await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120
        }, 'legacy-shape-seed', {
            providerUuid: 'legacy-account',
            accountEmail: 'legacy@example.com',
            timestamp: '2026-07-22T02:00:00.000Z'
        });
        await plugin.destroy();

        const database = new Database(getUsageDatabasePath());
        const keyRef = `sha256:${crypto.createHash('sha256').update(String(key.id)).digest('hex').slice(0, 16)}`;
        try {
            const row = database.prepare(`
                SELECT usage_date, day_json
                FROM potluck_usage_history
                WHERE key_ref = ?
                ORDER BY usage_date DESC
                LIMIT 1
            `).get(keyRef);
            const day = JSON.parse(row.day_json);
            delete day.providerModels;
            for (const hour of Object.values(day.hours || {})) delete hour.providerModels;
            database.prepare(`
                UPDATE potluck_usage_history
                SET day_json = ?
                WHERE key_ref = ? AND usage_date = ?
            `).run(JSON.stringify(day), keyRef, row.usage_date);
        } finally {
            database.close();
        }

        jest.resetModules();
        plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });

        await expect(plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 50,
            completionTokens: 10,
            totalTokens: 60
        }, 'legacy-shape-followup', {
            providerUuid: 'legacy-account',
            accountEmail: 'legacy@example.com',
            timestamp: '2026-07-22T02:05:00.000Z'
        })).resolves.toEqual(expect.objectContaining({ id: key.id }));

        await plugin.destroy();
        const row = readUsageHistoryRows().find(item => item.key_ref === keyRef);
        expect(row.day.providerModels['openai-codex-oauth']['gpt-5.5']).toMatchObject({
            requestCount: 2,
            totalTokens: 180
        });
        const hour = Object.values(row.day.hours)[0];
        expect(hour.providerModels['openai-codex-oauth']['gpt-5.5']).toMatchObject({
            requestCount: 2,
            totalTokens: 180
        });
    });

    test('migrates a production-scale 43-50MB legacy key file and shrinks metadata by at least 90%', async () => {
        jest.setTimeout(120_000);
        const accounts = {};
        for (let index = 0; index < 220; index += 1) {
            accounts[`openai-codex-oauth:account-${index}`] = {
                provider: 'openai-codex-oauth',
                providerUuid: `account-${index}`,
                accountEmail: `user-${index}@example.com`,
                summary: { requestCount: 1, promptTokens: 100, completionTokens: 20, totalTokens: 120 },
                models: { 'gpt-5.5': { requestCount: 1, promptTokens: 100, completionTokens: 20, totalTokens: 120 } }
            };
        }
        const day = {
            summary: { requestCount: 220, promptTokens: 22_000, completionTokens: 4_400, totalTokens: 26_400 },
            providers: {},
            models: {},
            accounts,
            hours: {}
        };
        const legacyStore = { keys: {} };
        for (let keyIndex = 0; keyIndex < 20; keyIndex += 1) {
            const usageHistory = {};
            for (let dayIndex = 1; dayIndex <= 35; dayIndex += 1) {
                usageHistory[`2026-07-${String(dayIndex).padStart(2, '0')}`] = day;
            }
            legacyStore.keys[`maki_large_${keyIndex}`] = {
                id: `maki_large_${keyIndex}`,
                name: `Large ${keyIndex}`,
                enabled: true,
                dailyLimit: 1000,
                usageHistory,
                totalModels: { 'gpt-5.5': { requestCount: 7700, totalTokens: 924000 } }
            };
        }
        const source = JSON.stringify(legacyStore);
        const sourceBytes = Buffer.byteLength(source);
        expect(sourceBytes).toBeGreaterThanOrEqual(43 * 1024 * 1024);
        expect(sourceBytes).toBeLessThanOrEqual(50 * 1024 * 1024);
        fs.writeFileSync(getStorePath(), source);

        const plugin = await loadPotluckPlugin();
        await plugin.init({ API_POTLUCK_PERSIST_INTERVAL: 60_000, API_POTLUCK_MAX_DIRTY_AGE: 60_000 });
        await plugin.exports.getKey('maki_large_0');
        await plugin.destroy();

        const compactBytes = fs.statSync(getStorePath()).size;
        expect(compactBytes).toBeLessThan(sourceBytes * 0.1);
        expect(readUsageHistoryRows()).toHaveLength(20 * 35);
        const backups = fs.readdirSync(path.dirname(getStorePath())).filter(name => name.includes('.pre-usage-split-'));
        expect(backups).toHaveLength(1);
    });

    test('migrates legacy usage history into SQLite before writing a metadata-only key snapshot', async () => {
        const legacyStore = {
            keys: {
                maki_legacy: {
                    id: 'maki_legacy',
                    name: 'Legacy Usage',
                    enabled: true,
                    dailyLimit: 1000,
                    usageHistory: {
                        '2026-07-21': {
                            summary: {
                                requestCount: 2,
                                promptTokens: 100,
                                completionTokens: 20,
                                totalTokens: 120
                            }
                        }
                    },
                    totalModels: {
                        'gpt-5.5': { requestCount: 2, totalTokens: 120 }
                    }
                }
            }
        };
        fs.writeFileSync(getStorePath(), JSON.stringify(legacyStore));

        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });
        await plugin.exports.getKey('maki_legacy');
        await plugin.destroy();

        const rows = readUsageHistoryRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            usage_date: '2026-07-21',
            day: { summary: { requestCount: 2, totalTokens: 120 } }
        });
        expect(readStore().keys.maki_legacy).not.toHaveProperty('usageHistory');
        expect(readStore().keys.maki_legacy).not.toHaveProperty('totalModels');
        const backups = fs.readdirSync(path.dirname(getStorePath()))
            .filter((name) => /^api-potluck-keys\.json\.pre-usage-split-[a-f0-9]{12}\.bak$/.test(name));
        expect(backups).toHaveLength(1);
        expect(JSON.parse(fs.readFileSync(path.join(path.dirname(getStorePath()), backups[0]), 'utf8')))
            .toEqual(legacyStore);
    });

    test('persists reset and delete operations to the SQLite usage history', async () => {
        const { plugin, keyManager } = await loadPotluckModules();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });
        const key = await plugin.exports.createKey('SQLite Reset Delete', 1000);
        await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120
        }, 'req-sqlite-reset-delete');
        await keyManager.flushPendingChanges();
        expect(readUsageHistoryRows()[0].day.summary.totalTokens).toBe(120);

        await plugin.exports.resetKeyTokenStats(key.id);
        expect(readUsageHistoryRows()[0].day.summary.totalTokens).toBe(0);

        await plugin.exports.deleteKey(key.id);
        expect(readUsageHistoryRows()).toHaveLength(0);
    });

    test('deduplicates a replayed durable runtime event without relying on in-memory request ids', async () => {
        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });
        const key = await plugin.exports.createKey('Durable Event Dedup', 1000);
        const usage = {
            requestCount: 1,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120
        };

        await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', usage, null, {
            runtimeEventId: 'runtime-event-replay'
        });
        await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', usage, null, {
            runtimeEventId: 'runtime-event-replay'
        });

        const stored = await plugin.exports.getKey(key.id);
        expect(stored.totalUsage).toBe(1);
        expect(stored.totalTokens).toBe(120);
        expect(readUsageHistoryRows()[0].day.summary.totalTokens).toBe(120);
    });

    test('durable runtime events update only the current day and changed model rows', async () => {
        const plugin = await loadPotluckPlugin();
        await plugin.init({
            API_POTLUCK_PERSIST_INTERVAL: 60_000,
            API_POTLUCK_MAX_DIRTY_AGE: 60_000
        });
        const key = await plugin.exports.createKey('Incremental SQLite Event', 1000);

        for (let index = 0; index < 1000; index += 1) {
            await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
                requestCount: 1,
                promptTokens: 1,
                completionTokens: 0,
                totalTokens: 1
            }, null, { runtimeEventId: `runtime-incremental-${index}` });
        }

        expect(readUsageHistoryRows()).toHaveLength(1);
        expect(readUsageHistoryRows()[0].day.summary).toMatchObject({ requestCount: 1000, totalTokens: 1000 });
        expect(readUsageModelRows()).toEqual([
            expect.objectContaining({
                model_name: 'gpt-5.5',
                usage: expect.objectContaining({ requestCount: 1000, totalTokens: 1000 })
            })
        ]);

        const database = new Database(getUsageDatabasePath(), { readonly: true });
        try {
            const metrics = database.prepare(`
                SELECT event_day_writes, event_model_writes, full_history_day_writes
                FROM potluck_usage_write_metrics WHERE singleton = 1
            `).get();
            expect(metrics).toEqual({
                event_day_writes: 1000,
                event_model_writes: 1000,
                full_history_day_writes: 0
            });
        } finally {
            database.close();
        }
    });

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

    test('records daily model usage separately for each provider', async () => {
        const plugin = await loadPotluckPlugin();
        const key = await plugin.exports.createKey('Provider Models', 1000);

        await plugin.exports.incrementUsage(key.id, 'openai-codex-oauth', 'shared-model', {
            requestCount: 2,
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120
        }, 'req-provider-model-codex', {
            providerUuid: 'codex-account',
            accountEmail: 'codex@example.com'
        });
        const recorded = await plugin.exports.incrementUsage(key.id, 'gemini-antigravity', 'shared-model', {
            requestCount: 1,
            promptTokens: 60,
            completionTokens: 20,
            totalTokens: 80
        }, 'req-provider-model-gemini', {
            providerUuid: 'gemini-account',
            accountEmail: 'gemini@example.com'
        });

        const today = Object.keys(recorded.usageHistory).sort().at(-1);
        expect(recorded.usageHistory[today].models['shared-model'].totalTokens).toBe(200);
        expect(recorded.usageHistory[today].providerModels['openai-codex-oauth']['shared-model']).toMatchObject({
            requestCount: 2,
            totalTokens: 120
        });
        expect(recorded.usageHistory[today].providerModels['gemini-antigravity']['shared-model']).toMatchObject({
            requestCount: 1,
            totalTokens: 80
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

        const { plugin, keyManager } = await loadPotluckModules();
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
        await keyManager.flushPendingChanges();
        expect(readUsageHistoryRows()[0].day.summary.totalTokens).toBe(240);
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
