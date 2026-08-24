import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalCwd = process.cwd();
let tempDir;
let consoleSpies = [];

async function loadUsageCacheModule() {
    jest.resetModules();
    return await import('../src/ui-modules/usage-cache.js');
}

function writeCache(data) {
    const configsDir = path.join(tempDir, 'configs');
    fs.mkdirSync(configsDir, { recursive: true });
    fs.writeFileSync(path.join(configsDir, 'usage-cache.json'), JSON.stringify(data, null, 2), 'utf8');
}

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-usage-cache-'));
    process.chdir(tempDir);
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('usage cache TTL', () => {
    test('returns fresh cached usage within the default 1 hour TTL', async () => {
        const now = new Date('2026-06-16T12:00:00.000Z');
        writeCache({
            timestamp: '2026-06-16T11:00:00.000Z',
            providers: {
                'openai-codex-oauth': { totalCount: 1 }
            }
        });

        const { readUsageCache } = await loadUsageCacheModule();

        await expect(readUsageCache({ now })).resolves.toMatchObject({
            providers: {
                'openai-codex-oauth': { totalCount: 1 }
            }
        });
    });

    test('treats cached usage older than 1 hour as stale by default', async () => {
        const now = new Date('2026-06-16T12:00:00.000Z');
        writeCache({
            timestamp: '2026-06-16T10:59:59.999Z',
            providers: {
                'openai-codex-oauth': { totalCount: 1 }
            }
        });

        const { readUsageCache } = await loadUsageCacheModule();

        await expect(readUsageCache({ now })).resolves.toBeNull();
    });

    test('can read cache without TTL for internal mutation paths', async () => {
        const now = new Date('2026-06-16T12:00:00.000Z');
        writeCache({
            timestamp: '2026-06-16T00:00:00.000Z',
            providers: {
                'openai-codex-oauth': { totalCount: 1 }
            }
        });

        const { readUsageCache } = await loadUsageCacheModule();

        await expect(readUsageCache({ now, maxAgeMs: null })).resolves.toMatchObject({
            providers: {
                'openai-codex-oauth': { totalCount: 1 }
            }
        });
    });

    test('can read stale cache explicitly as last-known usage fallback', async () => {
        const now = new Date('2026-06-16T12:00:00.000Z');
        writeCache({
            timestamp: '2026-06-16T00:00:00.000Z',
            providers: {
                'openai-codex-oauth': {
                    totalCount: 1,
                    instances: [{ uuid: 'codex-a', success: true, usage: { summary: { usedPercent: 99 } } }]
                }
            }
        });

        const { readUsageCache } = await loadUsageCacheModule();

        await expect(readUsageCache({ now, allowStale: true })).resolves.toMatchObject({
            stale: true,
            providers: {
                'openai-codex-oauth': {
                    instances: [{ uuid: 'codex-a', success: true }]
                }
            }
        });
    });

    test('write keeps last successful instance usage when a refresh returns an error', async () => {
        writeCache({
            timestamp: '2026-06-16T11:50:00.000Z',
            providers: {
                'openai-codex-oauth': {
                    providerType: 'openai-codex-oauth',
                    totalCount: 1,
                    successCount: 1,
                    errorCount: 0,
                    instances: [{
                        uuid: 'codex-a',
                        name: '蜂智pro1',
                        success: true,
                        error: null,
                        usage: {
                            user: { email: 'account@example.com' },
                            summary: { usedPercent: 42.5, status: 'normal' }
                        }
                    }]
                }
            }
        });

        const { writeUsageCache, readUsageCache } = await loadUsageCacheModule();

        await writeUsageCache({
            timestamp: '2026-06-16T12:00:00.000Z',
            providers: {
                'openai-codex-oauth': {
                    providerType: 'openai-codex-oauth',
                    totalCount: 1,
                    successCount: 0,
                    errorCount: 1,
                    instances: [{
                        uuid: 'codex-a',
                        name: '蜂智pro1',
                        success: false,
                        error: '401 Unauthorized',
                        usage: null
                    }]
                }
            }
        });

        const cache = await readUsageCache({ maxAgeMs: null });
        const instance = cache.providers['openai-codex-oauth'].instances[0];
        expect(instance.success).toBe(true);
        expect(instance.error).toBeNull();
        expect(instance.staleUsage).toBe(true);
        expect(instance.lastRefreshError).toBe('401 Unauthorized');
        expect(instance.usage.summary.usedPercent).toBe(42.5);
        expect(cache.providers['openai-codex-oauth'].successCount).toBe(1);
        expect(cache.providers['openai-codex-oauth'].errorCount).toBe(0);
    });

    test('provider refresh stores an independent last successful refresh time', async () => {
        writeCache({
            timestamp: '2026-06-16T11:50:00.000Z',
            providers: {
                'gemini-antigravity': {
                    providerType: 'gemini-antigravity',
                    lastSuccessfulRefreshAt: '2026-06-16T10:00:00.000Z',
                    instances: []
                },
                'openai-codex-oauth': {
                    providerType: 'openai-codex-oauth',
                    lastSuccessfulRefreshAt: '2026-06-16T11:00:00.000Z',
                    instances: []
                }
            }
        });

        const { updateProviderUsageCache, readUsageCache } = await loadUsageCacheModule();
        await updateProviderUsageCache('gemini-antigravity', {
            providerType: 'gemini-antigravity',
            instances: []
        }, '2026-06-16T12:00:00.000Z');

        const cache = await readUsageCache({ maxAgeMs: null });
        expect(cache.providers['gemini-antigravity'].lastSuccessfulRefreshAt).toBe('2026-06-16T12:00:00.000Z');
        expect(cache.providers['openai-codex-oauth'].lastSuccessfulRefreshAt).toBe('2026-06-16T11:00:00.000Z');
    });
});
