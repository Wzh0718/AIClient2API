import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const mockAtomicWriteFile = jest.fn();
const mockAtomicWriteFileSync = jest.fn();

jest.mock('../src/utils/file-lock.js', () => ({
    atomicWriteFile: mockAtomicWriteFile,
    atomicWriteFileSync: mockAtomicWriteFileSync
}));

const originalCwd = process.cwd();
const signalNames = ['SIGINT', 'SIGTERM'];
let originalSignalListeners;
let tempDir;
let consoleSpies = [];

function getStorePath() {
    return path.join(tempDir, 'configs', 'model-usage-stats.json');
}

async function writeFile(filePath, data, options) {
    fs.writeFileSync(filePath, data, options);
}

async function loadPluginAndManager(config = {}) {
    const [{ default: plugin }, statsManager] = await Promise.all([
        import('../src/plugins/model-usage-stats/index.js'),
        import('../src/plugins/model-usage-stats/stats-manager.js')
    ]);
    await plugin.init(config);
    return { plugin, statsManager };
}

function recordUsage(statsManager, requestId, totalTokens = 120, runtimeEventId = null) {
    statsManager.recordUnaryUsage({
        requestId,
        model: 'gpt-5.5',
        provider: 'openai-codex-oauth',
        providerUuid: 'codex-account-a',
        providerName: 'user@example.com',
        accountEmail: 'user@example.com',
        nativeResponse: {
            usage: {
                prompt_tokens: totalTokens,
                completion_tokens: 0,
                total_tokens: totalTokens
            }
        }
    });

    return statsManager.finalizeRequest({
        requestId,
        model: 'gpt-5.5',
        provider: 'openai-codex-oauth',
        providerUuid: 'codex-account-a',
        providerName: 'user@example.com',
        accountEmail: 'user@example.com',
        isStream: false,
        runtimeEventId
    });
}

function createJsonResponse() {
    return {
        statusCode: null,
        body: null,
        writeHead(code) {
            this.statusCode = code;
        },
        end(value) {
            this.body = JSON.parse(value);
        }
    };
}

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-22T02:00:00.000Z'));
    originalSignalListeners = Object.fromEntries(signalNames.map(signal => [signal, process.listeners(signal)]));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-model-usage-persist-'));
    fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
    process.chdir(tempDir);
    consoleSpies = ['log', 'warn', 'error'].map(method => jest.spyOn(console, method).mockImplementation(() => {}));
    mockAtomicWriteFile.mockImplementation(writeFile);
    mockAtomicWriteFileSync.mockImplementation((filePath, data, options) => fs.writeFileSync(filePath, data, options));
});

afterEach(() => {
    for (const signal of signalNames) {
        for (const listener of process.listeners(signal)) {
            if (!originalSignalListeners[signal].includes(listener)) {
                process.removeListener(signal, listener);
            }
        }
    }
    jest.clearAllTimers();
    consoleSpies.forEach(spy => spy.mockRestore());
    consoleSpies = [];
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.useRealTimers();
});

describe('model usage stats persistence', () => {
    test('deduplicates a durable runtime event in SQLite', async () => {
        const { statsManager } = await loadPluginAndManager();
        await recordUsage(statsManager, 'req-runtime-model-1', 120, 'event-runtime-model');
        await recordUsage(statsManager, 'req-runtime-model-2', 120, 'event-runtime-model');

        const stats = await statsManager.getStats();
        expect(stats.summary).toMatchObject({ requestCount: 1, totalTokens: 120 });
        expect(fs.existsSync(path.join(tempDir, 'configs', 'usage-events', 'usage-events.sqlite'))).toBe(true);
    });

    test('writes 1000 durable events as bounded shard updates instead of full-state blobs', async () => {
        const { statsManager } = await loadPluginAndManager();
        for (let index = 0; index < 1000; index += 1) {
            await recordUsage(statsManager, `req-sharded-${index}`, 1, `event-sharded-${index}`);
        }

        const database = new Database(path.join(tempDir, 'configs', 'usage-events', 'usage-events.sqlite'), { readonly: true });
        try {
            const metrics = database.prepare(`
                SELECT event_writes, event_bytes, full_state_writes
                FROM model_usage_write_metrics WHERE singleton = 1
            `).get();
            const eventRows = database.prepare('SELECT COUNT(*) AS count FROM model_usage_account_event_rows').get();
            expect(metrics.event_writes).toBe(1000);
            expect(metrics.full_state_writes).toBe(0);
            expect(metrics.event_bytes).toBeLessThan(10 * 1024 * 1024);
            expect(eventRows.count).toBe(1000);
        } finally {
            database.close();
        }
    });

    test('resetStats replaces the durable SQLite state used after restart', async () => {
        let loaded = await loadPluginAndManager();
        await recordUsage(loaded.statsManager, 'req-before-reset', 120, 'event-before-reset');
        await loaded.statsManager.resetStats();
        await loaded.plugin.destroy();

        jest.resetModules();
        loaded = await loadPluginAndManager();
        const stats = await loaded.statsManager.getStats();
        expect(stats.summary).toMatchObject({ requestCount: 0, totalTokens: 0 });
    });

    test('resetTokenStats replaces durable SQLite token totals while preserving request counts', async () => {
        let loaded = await loadPluginAndManager();
        await recordUsage(loaded.statsManager, 'req-before-token-reset', 120, 'event-before-token-reset');
        await loaded.statsManager.resetTokenStats();
        await loaded.plugin.destroy();

        jest.resetModules();
        loaded = await loadPluginAndManager();
        const stats = await loaded.statsManager.getStats();
        expect(stats.summary).toMatchObject({ requestCount: 1, totalTokens: 0, promptTokens: 0 });
    });
    test('finalizeRequest returns without waiting for or starting persistence', async () => {
        const { statsManager } = await loadPluginAndManager({
            MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS: 30_000,
            MODEL_USAGE_STATS_MAX_DIRTY_AGE_MS: 60_000
        });
        let releaseWrite;
        mockAtomicWriteFile.mockImplementation(async (...args) => {
            await new Promise(resolve => { releaseWrite = resolve; });
            await writeFile(...args);
        });

        const finalizePromise = recordUsage(statsManager, 'req-non-blocking');
        let finalized = false;
        finalizePromise.then(() => { finalized = true; });
        await Promise.resolve();
        await Promise.resolve();

        try {
            expect(finalized).toBe(true);
            expect(mockAtomicWriteFile).not.toHaveBeenCalled();
        } finally {
            releaseWrite?.();
            await finalizePromise;
        }
    });

    test('persists after the default 30 second quiet period', async () => {
        const { statsManager } = await loadPluginAndManager();
        await recordUsage(statsManager, 'req-default-debounce');

        expect(mockAtomicWriteFile).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(29_999);
        expect(mockAtomicWriteFile).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        expect(mockAtomicWriteFile).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fs.readFileSync(getStorePath(), 'utf8')).summary.totalTokens).toBe(120);
    });

    test('flushes by the default 60 second maximum dirty age under continuous mutations', async () => {
        const { statsManager } = await loadPluginAndManager();
        await recordUsage(statsManager, 'req-max-age-1');

        await jest.advanceTimersByTimeAsync(20_000);
        await recordUsage(statsManager, 'req-max-age-2');
        await jest.advanceTimersByTimeAsync(20_000);
        await recordUsage(statsManager, 'req-max-age-3');
        await jest.advanceTimersByTimeAsync(19_000);
        await recordUsage(statsManager, 'req-max-age-4');
        await jest.advanceTimersByTimeAsync(999);

        expect(mockAtomicWriteFile).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);

        expect(mockAtomicWriteFile).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fs.readFileSync(getStorePath(), 'utf8')).summary.requestCount).toBe(4);
    });

    test('keeps the legacy persistence interval as the debounce fallback', async () => {
        const { statsManager } = await loadPluginAndManager({
            MODEL_USAGE_STATS_PERSIST_INTERVAL: 5_000,
            MODEL_USAGE_STATS_MAX_DIRTY_AGE_MS: 60_000
        });
        await recordUsage(statsManager, 'req-legacy-interval');

        await jest.advanceTimersByTimeAsync(4_999);
        expect(mockAtomicWriteFile).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        expect(mockAtomicWriteFile).toHaveBeenCalledTimes(1);
    });

    test('persists compact JSON snapshots and logs persistence memory metrics', async () => {
        const { statsManager } = await loadPluginAndManager({
            MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS: 1_000,
            MODEL_USAGE_STATS_MAX_DIRTY_AGE_MS: 5_000
        });
        await recordUsage(statsManager, 'req-compact-metrics');
        await jest.advanceTimersByTimeAsync(1_000);

        const snapshot = mockAtomicWriteFile.mock.calls[0][1];
        expect(snapshot).toBe(JSON.stringify(JSON.parse(snapshot)));

        const logged = consoleSpies.flatMap(spy => spy.mock.calls.map(args => args.map(String).join(' '))).join('\n');
        expect(logged).toMatch(/snapshotBytes=\d+/);
        expect(logged).toMatch(/durationMs=\d+(?:\.\d+)?/);
        expect(logged).toMatch(/heapUsedBefore=\d+/);
        expect(logged).toMatch(/heapUsedAfter=\d+/);
    });

    test('destroy waits for the final asynchronous flush', async () => {
        const { plugin, statsManager } = await loadPluginAndManager({
            MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS: 60_000,
            MODEL_USAGE_STATS_MAX_DIRTY_AGE_MS: 60_000
        });
        await recordUsage(statsManager, 'req-before-destroy');
        mockAtomicWriteFile.mockClear();

        let releaseWrite;
        mockAtomicWriteFile.mockImplementation(async (...args) => {
            await new Promise(resolve => { releaseWrite = resolve; });
            await writeFile(...args);
        });

        const destroyPromise = plugin.destroy();
        let destroyed = false;
        destroyPromise.then(() => { destroyed = true; });
        await Promise.resolve();
        await Promise.resolve();

        try {
            expect(mockAtomicWriteFile).toHaveBeenCalledTimes(1);
            expect(destroyed).toBe(false);
        } finally {
            releaseWrite?.();
            await destroyPromise;
        }

        expect(destroyed).toBe(true);
        expect(JSON.parse(fs.readFileSync(getStorePath(), 'utf8')).summary.totalTokens).toBe(120);
    });

    test('does not install SIGINT or SIGTERM handlers', async () => {
        const { statsManager } = await loadPluginAndManager();
        await statsManager.getStats();

        for (const signal of signalNames) {
            expect(process.listeners(signal)).toEqual(originalSignalListeners[signal]);
        }
    });

    test('does not immediately loop full snapshots when mutations arrive during a write', async () => {
        const { statsManager } = await loadPluginAndManager({
            MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS: 1_000,
            MODEL_USAGE_STATS_MAX_DIRTY_AGE_MS: 5_000
        });
        let releaseWrite;
        let signalWriteStarted;
        const writeStarted = new Promise(resolve => { signalWriteStarted = resolve; });
        mockAtomicWriteFile.mockImplementationOnce(async (...args) => {
            signalWriteStarted();
            await new Promise(resolve => { releaseWrite = resolve; });
            await writeFile(...args);
        });

        await recordUsage(statsManager, 'req-before-bounded-write');
        jest.advanceTimersByTime(1_000);
        await writeStarted;
        await recordUsage(statsManager, 'req-during-bounded-write');
        releaseWrite();
        await jest.advanceTimersByTimeAsync(0);

        expect(mockAtomicWriteFile).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1_000);
        expect(mockAtomicWriteFile).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fs.readFileSync(getStorePath(), 'utf8')).summary.requestCount).toBe(2);
    });

    test('writes a trailing snapshot when a mutation arrives during persistence', async () => {
        const { plugin, statsManager } = await loadPluginAndManager({
            MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS: 1_000,
            MODEL_USAGE_STATS_MAX_DIRTY_AGE_MS: 5_000
        });
        let releaseWrite;
        let signalWriteStarted;
        const writeStarted = new Promise(resolve => { signalWriteStarted = resolve; });
        mockAtomicWriteFile.mockImplementationOnce(async (...args) => {
            signalWriteStarted();
            await new Promise(resolve => { releaseWrite = resolve; });
            await writeFile(...args);
        });

        const firstFinalize = recordUsage(statsManager, 'req-before-write');
        await Promise.resolve();
        jest.advanceTimersByTime(1_000);
        await Promise.resolve();
        await writeStarted;

        const secondFinalize = recordUsage(statsManager, 'req-during-write');
        await Promise.resolve();
        releaseWrite();
        await Promise.all([firstFinalize, secondFinalize]);
        await plugin.destroy();

        expect(mockAtomicWriteFile).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fs.readFileSync(getStorePath(), 'utf8')).summary).toMatchObject({
            requestCount: 2,
            totalTokens: 240
        });
    });

    test.each([100, 1_000])('waits at least five seconds before retrying a failed write with a %i ms debounce', async persistDebounceMs => {
        const { statsManager } = await loadPluginAndManager({
            MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS: persistDebounceMs,
            MODEL_USAGE_STATS_MAX_DIRTY_AGE_MS: 60_000
        });
        mockAtomicWriteFile.mockRejectedValueOnce(new Error('simulated write failure'));
        await recordUsage(statsManager, 'req-write-failure');

        await jest.advanceTimersByTimeAsync(persistDebounceMs);
        expect(fs.existsSync(getStorePath())).toBe(false);
        expect(mockAtomicWriteFile).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(4_999);
        expect(mockAtomicWriteFile).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1);
        expect(mockAtomicWriteFile).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fs.readFileSync(getStorePath(), 'utf8')).summary.totalTokens).toBe(120);
    });

    test.each(['resetStats', 'resetTokenStats'])('%s returns a non-enumerable persistencePending flag after a failed flush', async resetMethod => {
        const { statsManager } = await loadPluginAndManager({
            MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS: 1_000,
            MODEL_USAGE_STATS_MAX_DIRTY_AGE_MS: 60_000
        });
        mockAtomicWriteFile.mockRejectedValueOnce(new Error('simulated reset write failure'));

        const stats = await statsManager[resetMethod]();

        expect(stats.persistencePending).toBe(true);
        expect(Object.prototype.propertyIsEnumerable.call(stats, 'persistencePending')).toBe(false);
        expect(JSON.parse(JSON.stringify(stats))).not.toHaveProperty('persistencePending');
    });

    test.each(['resetStats', 'resetTokenStats'])('%s returns a non-enumerable false persistencePending flag after a successful flush', async resetMethod => {
        const { statsManager } = await loadPluginAndManager({
            MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS: 1_000,
            MODEL_USAGE_STATS_MAX_DIRTY_AGE_MS: 60_000
        });

        const stats = await statsManager[resetMethod]();

        expect(stats.persistencePending).toBe(false);
        expect(Object.prototype.propertyIsEnumerable.call(stats, 'persistencePending')).toBe(false);
        expect(JSON.parse(JSON.stringify(stats))).not.toHaveProperty('persistencePending');
    });

    test.each([
        ['/api/model-usage-stats/reset', '模型统计'],
        ['/api/model-usage-stats/reset-tokens', '模型 Token 统计']
    ])('reports failed persistence for %s as pending with HTTP 202', async (routePath, messageSubject) => {
        const { statsManager } = await loadPluginAndManager({
            MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS: 1_000,
            MODEL_USAGE_STATS_MAX_DIRTY_AGE_MS: 60_000
        });
        fs.writeFileSync(path.join(tempDir, 'configs', 'token-store.json'), JSON.stringify({ tokens: {} }), 'utf8');
        const { handleModelUsageStatsRoutes } = await import('../src/plugins/model-usage-stats/api-routes.js');
        await recordUsage(statsManager, `req-${messageSubject}`);
        mockAtomicWriteFile.mockRejectedValueOnce(new Error('simulated reset write failure'));
        const req = {
            url: routePath,
            headers: { authorization: 'Bearer admin-key', host: 'localhost' }
        };
        const res = createJsonResponse();

        await handleModelUsageStatsRoutes(
            'POST',
            routePath,
            req,
            res,
            { REQUIRED_API_KEY: 'admin-key' }
        );

        expect(res.statusCode).toBe(202);
        expect(res.body).toMatchObject({
            success: true,
            persistencePending: true
        });
        expect(res.body.message).toContain('变更已在内存生效');
        expect(res.body.message).toContain('后台');
        expect(res.body.message).toContain('重启');
        expect(res.body.data).not.toHaveProperty('persistencePending');

        await jest.advanceTimersByTimeAsync(5_000);
        expect(JSON.parse(fs.readFileSync(getStorePath(), 'utf8')).summary.totalTokens).toBe(0);
        expect((await statsManager.getStats()).summary.totalTokens).toBe(0);
    });

    test.each([
        '/api/model-usage-stats/reset',
        '/api/model-usage-stats/reset-tokens'
    ])('reports successful persistence for %s with HTTP 200', async routePath => {
        await loadPluginAndManager({
            MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS: 1_000,
            MODEL_USAGE_STATS_MAX_DIRTY_AGE_MS: 60_000
        });
        const { handleModelUsageStatsRoutes } = await import('../src/plugins/model-usage-stats/api-routes.js');
        const req = {
            url: routePath,
            headers: { authorization: 'Bearer admin-key', host: 'localhost' }
        };
        const res = createJsonResponse();

        await handleModelUsageStatsRoutes(
            'POST',
            routePath,
            req,
            res,
            { REQUIRED_API_KEY: 'admin-key' }
        );

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ success: true, persistencePending: false });
        expect(res.body.data).not.toHaveProperty('persistencePending');
    });

    test('destroy immediately retries one failed final flush and succeeds on the second attempt', async () => {
        const { plugin, statsManager } = await loadPluginAndManager({
            MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS: 60_000,
            MODEL_USAGE_STATS_MAX_DIRTY_AGE_MS: 60_000
        });
        await recordUsage(statsManager, 'req-destroy-failure');
        mockAtomicWriteFile.mockRejectedValueOnce(new Error('simulated destroy failure'));

        await expect(plugin.destroy()).resolves.toBeUndefined();
        expect(mockAtomicWriteFile).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fs.readFileSync(getStorePath(), 'utf8')).summary.totalTokens).toBe(120);
    });

    test('destroy rejects after two consecutive final flush failures', async () => {
        const { plugin, statsManager } = await loadPluginAndManager({
            MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS: 60_000,
            MODEL_USAGE_STATS_MAX_DIRTY_AGE_MS: 60_000
        });
        await recordUsage(statsManager, 'req-destroy-consecutive-failure');
        mockAtomicWriteFile.mockRejectedValue(new Error('simulated destroy failure'));

        await expect(plugin.destroy()).rejects.toThrow('Failed to flush model usage stats');
        expect(mockAtomicWriteFile).toHaveBeenCalledTimes(2);
    });
});
