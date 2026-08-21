import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalCwd = process.cwd();
let tempDir;
let consoleSpies = [];

async function loadKeyManager() {
    jest.resetModules();
    return await import('../src/plugins/api-potluck/key-manager.js');
}

async function loadPotluckPlugin() {
    jest.resetModules();
    return await import('../src/plugins/api-potluck/index.js');
}

beforeEach(() => {
    jest.useFakeTimers();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-potluck-'));
    fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
    process.chdir(tempDir);
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.useRealTimers();
});

describe('api potluck key usage summary', () => {
    test('does not double count duplicate request ids and only applies usage deltas', async () => {
        jest.setSystemTime(new Date('2026-06-22T02:15:30.000Z'));
        const { createKey, incrementUsage, listKeys, getStats } = await loadKeyManager();

        const key = await createKey('Dedup Client', 1000);
        const context = {
            providerUuid: 'codex-account-a',
            providerName: 'user@example.com',
            accountIdentity: 'acct-chatgpt-123',
            accountEmail: 'user@example.com',
            timestamp: '2026-06-22T02:15:30.000Z'
        };

        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 1000,
            cachedTokens: 400,
            completionTokens: 120,
            reasoningTokens: 80,
            totalTokens: 1120
        }, 'req-duplicate', context);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 1000,
            cachedTokens: 400,
            completionTokens: 120,
            reasoningTokens: 80,
            totalTokens: 1120
        }, 'req-duplicate', context);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 1300,
            cachedTokens: 500,
            completionTokens: 150,
            reasoningTokens: 90,
            totalTokens: 1450
        }, 'req-duplicate', context);

        const [listedKey] = await listKeys();
        const stats = await getStats();
        const accountKey = 'openai-codex-oauth:user@example.com';

        expect(listedKey.usageHistory['2026-06-22'].summary).toMatchObject({
            requestCount: 1,
            promptTokens: 1300,
            cachedTokens: 500,
            completionTokens: 150,
            reasoningTokens: 90,
            totalTokens: 1450
        });
        expect(listedKey.usageHistory['2026-06-22'].accounts[accountKey].summary).toMatchObject({
            requestCount: 1,
            totalTokens: 1450
        });
        expect(stats).toMatchObject({
            todayTotalUsage: 1,
            todayTotalTokens: 1450,
            totalUsage: 1,
            totalTokens: 1450
        });
    });

    test('aggregates Codex account buckets by email across provider UUIDs', async () => {
        jest.setSystemTime(new Date('2026-06-22T02:15:30.000Z'));
        const { createKey, incrementUsage, listKeys, getStats } = await loadKeyManager();

        const key = await createKey('Codex Client', 1000);
        for (const [providerUuid, totalTokens] of [['old-provider-uuid', 1100], ['new-provider-uuid', 2200]]) {
            await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
                requestCount: 1,
                promptTokens: totalTokens - 100,
                completionTokens: 100,
                totalTokens
            }, `req-${providerUuid}`, {
                providerUuid,
                providerName: 'user@example.com',
                accountIdentity: 'acct-chatgpt-123',
                accountEmail: 'user@example.com',
                timestamp: '2026-06-22T02:15:30.000Z'
            });
        }

        const [listedKey] = await listKeys();
        const stats = await getStats();
        const accountKey = 'openai-codex-oauth:user@example.com';
        const dayAccounts = listedKey.usageHistory['2026-06-22'].accounts;

        expect(Object.keys(dayAccounts)).toEqual([accountKey]);
        expect(dayAccounts[accountKey]).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'user@example.com',
            accountIdentity: 'user@example.com',
            accountEmail: 'user@example.com',
            providerName: 'user@example.com',
            providerUuids: ['old-provider-uuid', 'new-provider-uuid']
        });
        expect(dayAccounts[accountKey].summary).toMatchObject({
            requestCount: 2,
            totalTokens: 3300
        });
        expect(stats.usageHistory['2026-06-22'].accounts[accountKey].summary).toMatchObject({
            requestCount: 2,
            totalTokens: 3300
        });
    });

    test('listKeys weekly usage only includes the latest seven calendar days', async () => {
        jest.setSystemTime(new Date('2026-06-16T11:04:05.689Z'));
        const { createKey, incrementUsage, listKeys } = await loadKeyManager();

        const key = await createKey('Stale Client', 100);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 2,
            promptTokens: 1000,
            completionTokens: 100,
            totalTokens: 1100,
            cachedTokens: 200
        });

        jest.setSystemTime(new Date('2026-06-26T05:00:00.000Z'));

        const [listedKey] = await listKeys();

        expect(listedKey.lastUsedAt).toBeTruthy();
        expect(listedKey.weeklyUsage).toBe(0);
        expect(listedKey.weeklyTotalTokens).toBe(0);
        expect(listedKey.totalTokens).toBe(1100);
    });

    test('listKeys exposes token-first daily weekly and cumulative usage fields', async () => {
        const { createKey, incrementUsage, listKeys } = await loadKeyManager();

        const key = await createKey('Alpha', 100);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 1000,
            completionTokens: 120,
            totalTokens: 1120,
            cachedTokens: 400
        });

        const [listedKey] = await listKeys();
        const [dateKey] = Object.keys(listedKey.usageHistory);

        expect(listedKey).toMatchObject({
            todayTotalTokens: 1120,
            todayReasoningTokens: 0,
            totalTokens: 1120,
            totalReasoningTokens: 0,
            weeklyTotalTokens: 1120,
            weeklyReasoningTokens: 0,
            todayCacheHitRatio: 0.4,
            weeklyCacheHitRatio: 0.4,
            totalCacheHitRatio: 0.4
        });
        expect(listedKey.usageHistory[dateKey].summary).toMatchObject({
            requestCount: 1,
            totalTokens: 1120,
            cachedTokens: 400,
            cacheHitRatio: 0.4
        });
    });

    test('records provider account and hour buckets for a distributed key request', async () => {
        jest.setSystemTime(new Date('2026-06-22T02:15:30.000Z'));
        const { createKey, incrementUsage, listKeys } = await loadKeyManager();

        const key = await createKey('Image Client', 1000);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-image-2', {
            requestCount: 1,
            promptTokens: 2000,
            completionTokens: 300,
            totalTokens: 2300,
            cachedTokens: 800,
            reasoningTokens: 516
        }, 'req-image-1', {
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A',
            accountEmail: 'codex-a@example.com',
            timestamp: '2026-06-22T02:15:30.000Z'
        });

        const [listedKey] = await listKeys();
        const dayHistory = listedKey.usageHistory['2026-06-22'];
        const accountKey = 'openai-codex-oauth:codex-a@example.com';

        expect(listedKey).toMatchObject({
            todayReasoningTokens: 516,
            totalReasoningTokens: 516,
            weeklyReasoningTokens: 516
        });
        expect(dayHistory.accounts[accountKey]).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-a@example.com',
            accountIdentity: 'codex-a@example.com',
            accountEmail: 'codex-a@example.com',
            providerName: 'Codex Account A'
        });
        expect(dayHistory.accounts[accountKey].summary).toMatchObject({
            requestCount: 1,
            totalTokens: 2300,
            cachedTokens: 800,
            reasoningTokens: 516,
            cacheHitRatio: 0.4
        });
        expect(dayHistory.accounts[accountKey].models['gpt-image-2']).toMatchObject({
            requestCount: 1,
            totalTokens: 2300,
            reasoningTokens: 516
        });
        expect(dayHistory.hours['10'].accounts[accountKey].models['gpt-image-2']).toMatchObject({
            requestCount: 1,
            totalTokens: 2300,
            reasoningTokens: 516
        });
    });

    test('getStats aggregates provider account buckets for admin token-share UI', async () => {
        jest.setSystemTime(new Date('2026-06-22T02:15:30.000Z'));
        const { createKey, incrementUsage, getStats } = await loadKeyManager();

        const keyA = await createKey('Image Client A', 1000);
        const keyB = await createKey('Image Client B', 1000);

        await incrementUsage(keyA.id, 'openai-codex-oauth', 'gpt-image-2', {
            requestCount: 1,
            promptTokens: 2000,
            completionTokens: 300,
            totalTokens: 2300,
            cachedTokens: 800
        }, 'req-admin-account-1', {
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A',
            accountEmail: 'codex-a@example.com',
            timestamp: '2026-06-22T02:15:30.000Z'
        });
        await incrementUsage(keyB.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 2,
            promptTokens: 3000,
            completionTokens: 500,
            totalTokens: 3500,
            cachedTokens: 600
        }, 'req-admin-account-2', {
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A',
            accountEmail: 'codex-a@example.com',
            timestamp: '2026-06-22T02:20:30.000Z'
        });

        const stats = await getStats();
        const accountKey = 'openai-codex-oauth:codex-a@example.com';

        expect(stats.usageHistory['2026-06-22'].accounts[accountKey]).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-a@example.com',
            accountIdentity: 'codex-a@example.com',
            accountEmail: 'codex-a@example.com',
            providerName: 'Codex Account A'
        });
        expect(stats.usageHistory['2026-06-22'].accounts[accountKey].summary).toMatchObject({
            requestCount: 3,
            totalTokens: 5800,
            cachedTokens: 1400
        });
        expect(stats.usageHistory['2026-06-22'].accounts[accountKey].models['gpt-image-2']).toMatchObject({
            requestCount: 1,
            totalTokens: 2300
        });
        expect(stats.usageHistory['2026-06-22'].accounts[accountKey].models['gpt-5.5']).toMatchObject({
            requestCount: 2,
            totalTokens: 3500
        });
    });

    test('getAccountUsageSummary returns account ranges for usage page data source', async () => {
        const { createKey, incrementUsage, getAccountUsageSummary } = await loadKeyManager();

        jest.setSystemTime(new Date('2026-06-20T02:00:00.000Z'));
        const key = await createKey('Codex Client', 1000);

        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 1000,
            completionTokens: 100,
            totalTokens: 1100
        }, 'req-month-only', {
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A',
            accountEmail: 'codex-a@example.com'
        });

        jest.setSystemTime(new Date('2026-06-23T02:00:00.000Z'));
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 2,
            promptTokens: 2000,
            completionTokens: 200,
            totalTokens: 2200
        }, 'req-week', {
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A',
            accountEmail: 'codex-a@example.com'
        });

        jest.setSystemTime(new Date('2026-06-26T02:00:00.000Z'));
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 3,
            promptTokens: 3000,
            completionTokens: 300,
            totalTokens: 3300
        }, 'req-today', {
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A',
            accountEmail: 'codex-a@example.com'
        });

        const summary = await getAccountUsageSummary(new Date('2026-06-26T03:00:00.000Z'));
        const account = summary.accounts.find(item => item.accountKey === 'openai-codex-oauth:codex-a@example.com');

        expect(summary).toMatchObject({
            source: 'potluck/model-usage-stats',
            timezone: 'Asia/Shanghai',
            periods: {
                today: '2026-06-26',
                week: '2026-06-20',
                month: '2026-05-28'
            }
        });
        expect(account).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'codex-a@example.com',
            accountIdentity: 'codex-a@example.com',
            accountEmail: 'codex-a@example.com',
            providerName: 'Codex Account A'
        });
        expect(account.today).toMatchObject({ requestCount: 3, totalTokens: 3300 });
        expect(account.week).toMatchObject({ requestCount: 6, totalTokens: 6600 });
        expect(account.month).toMatchObject({ requestCount: 6, totalTokens: 6600 });
        expect(account.today.cost).toMatchObject({
            actualUsd: 0.024,
            missingPriceTokens: 0
        });
        expect(account.week.cost).toMatchObject({
            actualUsd: 0.048,
            missingPriceTokens: 0
        });
        expect(account.month.cost).toMatchObject({
            actualUsd: 0.048,
            missingPriceTokens: 0
        });
        expect(account.latestDay).toMatchObject({
            date: expect.any(String),
            cost: expect.objectContaining({ usd: expect.any(Number) })
        });
        expect(account.lastUsedAt).toBe('2026-06-26T02:00:00.000Z');
        expect(account.today.lastUsedAt).toBe('2026-06-26T02:00:00.000Z');
    });

    test('getAccountUsageSummary reports missing price tokens only for unknown models', async () => {
        const { createKey, incrementUsage, getAccountUsageSummary } = await loadKeyManager();

        jest.setSystemTime(new Date('2026-06-26T02:00:00.000Z'));
        const key = await createKey('Mixed Client', 1000);

        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 1000,
            completionTokens: 100,
            totalTokens: 1100
        }, 'req-known-model', {
            providerUuid: 'known-account',
            providerName: 'known@example.com',
            accountEmail: 'known@example.com'
        });
        await incrementUsage(key.id, 'openai-codex-oauth', 'unknown-future-model', {
            requestCount: 1,
            promptTokens: 2000,
            completionTokens: 300,
            totalTokens: 2300
        }, 'req-unknown-model', {
            providerUuid: 'unknown-account',
            providerName: 'unknown@example.com',
            accountEmail: 'unknown@example.com'
        });

        const summary = await getAccountUsageSummary(new Date('2026-06-26T03:00:00.000Z'));
        const knownAccount = summary.accounts.find(item => item.accountKey === 'openai-codex-oauth:known@example.com');
        const unknownAccount = summary.accounts.find(item => item.accountKey === 'openai-codex-oauth:unknown@example.com');

        expect(knownAccount.today.cost).toMatchObject({
            actualUsd: 0.0012,
            missingPriceTokens: 0
        });
        expect(unknownAccount.today.cost).toMatchObject({
            actualUsd: 0,
            missingPriceTokens: 2300
        });
    });

    test('getAccountUsageSummary prices historical Codex fast model names', async () => {
        const { createKey, incrementUsage, getAccountUsageSummary } = await loadKeyManager();

        jest.setSystemTime(new Date('2026-07-12T02:00:00.000Z'));
        const key = await createKey('Historical Fast Client', 1000);
        for (const [index, model] of ['gpt-5.4-mini-fast', 'gpt-5.3-codex-spark-fast'].entries()) {
            await incrementUsage(key.id, 'openai-codex-oauth', model, {
                requestCount: 1,
                promptTokens: 1000,
                completionTokens: 100,
                totalTokens: 1100
            }, `req-historical-fast-${index}`, {
                providerUuid: 'historical-fast-account',
                providerName: 'historical-fast@example.com',
                accountEmail: 'historical-fast@example.com'
            });
        }

        const summary = await getAccountUsageSummary(new Date('2026-07-12T03:00:00.000Z'));
        const account = summary.accounts.find(item => item.accountKey === 'openai-codex-oauth:historical-fast@example.com');

        expect(account.month.cost.actualUsd).toBeGreaterThan(0);
        expect(account.month.cost.missingPriceTokens).toBe(0);
    });

    test('getAccountUsageSummary prefers live potluck history over stale model usage daily history', async () => {
        fs.writeFileSync(path.join(tempDir, 'configs', 'model-usage-stats.json'), JSON.stringify({
            updatedAt: '2026-07-01T13:43:00.000Z',
            daily: {
                '2026-07-01': {
                    accounts: {
                        'openai-codex-oauth:stale@example.com': {
                            provider: 'openai-codex-oauth',
                            providerUuid: 'stale@example.com',
                            accountIdentity: 'stale@example.com',
                            accountEmail: 'stale@example.com',
                            providerName: 'Stale Account',
                            summary: {
                                requestCount: 9,
                                promptTokens: 9000,
                                completionTokens: 900,
                                totalTokens: 9900,
                                lastUsedAt: '2026-07-01T13:43:00.000Z'
                            },
                            models: {
                                'gpt-5.4-mini': {
                                    requestCount: 9,
                                    promptTokens: 9000,
                                    completionTokens: 900,
                                    totalTokens: 9900
                                }
                            }
                        }
                    }
                }
            }
        }), 'utf8');

        const { createKey, incrementUsage, getAccountUsageSummary } = await loadKeyManager();

        jest.setSystemTime(new Date('2026-07-02T02:00:00.000Z'));
        const key = await createKey('Live Potluck Client', 1000);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 2,
            promptTokens: 2000,
            completionTokens: 200,
            totalTokens: 2200
        }, 'req-live-potluck', {
            providerUuid: 'live-account',
            providerName: 'Live Account',
            accountEmail: 'live@example.com'
        });

        const summary = await getAccountUsageSummary(new Date('2026-07-02T03:00:00.000Z'));
        const liveAccount = summary.accounts.find(item => item.accountKey === 'openai-codex-oauth:live@example.com');

        expect(summary.source).toBe('potluck/model-usage-stats');
        expect(liveAccount.today).toMatchObject({ requestCount: 2, totalTokens: 2200 });
        expect(summary.accounts.some(item => item.accountKey === 'openai-codex-oauth:stale@example.com')).toBe(false);
    });

    test('getAccountUsageSummary does not read model usage last-used index when potluck history is live', async () => {
        fs.writeFileSync(path.join(tempDir, 'configs', 'model-usage-stats.json'), '{not-json', 'utf8');

        const { createKey, incrementUsage, getAccountUsageSummary } = await loadKeyManager();

        jest.setSystemTime(new Date('2026-07-02T02:00:00.000Z'));
        const key = await createKey('Live Potluck Client', 1000);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 1000,
            completionTokens: 100,
            totalTokens: 1100
        }, 'req-live-potluck-no-model-index', {
            providerUuid: 'live-account',
            providerName: 'Live Account',
            accountEmail: 'live@example.com'
        });

        const summary = await getAccountUsageSummary(new Date('2026-07-02T03:00:00.000Z'));

        expect(summary.source).toBe('potluck/model-usage-stats');
        expect(summary.accounts[0].lastUsedAt).toBe('2026-07-02T02:00:00.000Z');
        expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('Failed to read model usage account timestamps'));
    });

    test('getAccountUsageSummary reports partial account history coverage for mixed legacy potluck days', async () => {
        const { createKey, incrementUsage, getAccountUsageSummary } = await loadKeyManager();

        jest.setSystemTime(new Date('2026-07-01T02:00:00.000Z'));
        const key = await createKey('Legacy Mixed Client', 1000);
        const legacyDate = '2026-06-30';
        key.usageHistory[legacyDate] = {
            summary: {
                requestCount: 10,
                promptTokens: 10000,
                completionTokens: 1000,
                totalTokens: 11000
            },
            providers: {},
            models: {},
            accounts: {},
            hours: {}
        };

        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 1000,
            completionTokens: 100,
            totalTokens: 1100
        }, 'req-live-account-coverage', {
            providerUuid: 'live-account',
            providerName: 'live@example.com',
            accountEmail: 'live@example.com'
        });

        const summary = await getAccountUsageSummary(new Date('2026-07-01T03:00:00.000Z'));

        expect(summary.coverage).toMatchObject({
            today: {
                status: 'complete',
                accountTokens: 1100,
                totalTokens: 1100,
                coverageRatio: 1
            },
            week: {
                status: 'partial',
                accountTokens: 1100,
                totalTokens: 12100,
                missingTokens: 11000,
                coverageRatio: expect.closeTo(1100 / 12100, 6)
            },
            month: {
                status: 'partial',
                accountTokens: 1100,
                totalTokens: 12100,
                missingTokens: 11000,
                coverageRatio: expect.closeTo(1100 / 12100, 6)
            }
        });
    });

    test('getAccountUsageSummary uses a rolling 30 day month window from model usage daily history', async () => {
        fs.writeFileSync(path.join(tempDir, 'configs', 'model-usage-stats.json'), JSON.stringify({
            updatedAt: '2026-07-02T09:00:00.000Z',
            daily: {
                '2026-06-02': {
                    accounts: {
                        'openai-codex-oauth:daily@example.com': {
                            provider: 'openai-codex-oauth',
                            providerUuid: 'daily@example.com',
                            accountIdentity: 'daily@example.com',
                            accountEmail: 'daily@example.com',
                            providerName: 'Daily Account',
                            summary: {
                                requestCount: 7,
                                promptTokens: 7000,
                                completionTokens: 700,
                                totalTokens: 7700,
                                lastUsedAt: '2026-06-02T02:00:00.000Z'
                            },
                            models: {
                                'gpt-5.4-mini': {
                                    requestCount: 7,
                                    promptTokens: 7000,
                                    completionTokens: 700,
                                    totalTokens: 7700,
                                    lastUsedAt: '2026-06-02T02:00:00.000Z'
                                }
                            }
                        }
                    }
                },
                '2026-06-03': {
                    accounts: {
                        'openai-codex-oauth:daily@example.com': {
                            provider: 'openai-codex-oauth',
                            providerUuid: 'daily@example.com',
                            accountIdentity: 'daily@example.com',
                            accountEmail: 'daily@example.com',
                            providerName: 'Daily Account',
                            summary: {
                                requestCount: 5,
                                promptTokens: 5000,
                                completionTokens: 500,
                                totalTokens: 5500,
                                lastUsedAt: '2026-06-03T02:00:00.000Z'
                            },
                            models: {
                                'gpt-5.4-mini': {
                                    requestCount: 5,
                                    promptTokens: 5000,
                                    completionTokens: 500,
                                    totalTokens: 5500,
                                    lastUsedAt: '2026-06-03T02:00:00.000Z'
                                }
                            }
                        }
                    }
                },
                '2026-07-01': {
                    accounts: {
                        'openai-codex-oauth:daily@example.com': {
                            provider: 'openai-codex-oauth',
                            providerUuid: 'daily@example.com',
                            accountIdentity: 'daily@example.com',
                            accountEmail: 'daily@example.com',
                            providerName: 'Daily Account',
                            summary: {
                                requestCount: 2,
                                promptTokens: 2000,
                                completionTokens: 200,
                                totalTokens: 2200,
                                lastUsedAt: '2026-07-01T02:00:00.000Z'
                            },
                            models: {
                                'gpt-5.4-mini': {
                                    requestCount: 2,
                                    promptTokens: 2000,
                                    completionTokens: 200,
                                    totalTokens: 2200,
                                    lastUsedAt: '2026-07-01T02:00:00.000Z'
                                }
                            }
                        }
                    }
                },
                '2026-07-02': {
                    accounts: {
                        'openai-codex-oauth:daily@example.com': {
                            provider: 'openai-codex-oauth',
                            providerUuid: 'daily@example.com',
                            accountIdentity: 'daily@example.com',
                            accountEmail: 'daily@example.com',
                            providerName: 'Daily Account',
                            summary: {
                                requestCount: 3,
                                promptTokens: 3000,
                                completionTokens: 300,
                                totalTokens: 3300,
                                lastUsedAt: '2026-07-02T02:00:00.000Z'
                            },
                            models: {
                                'gpt-image-2': {
                                    requestCount: 3,
                                    promptTokens: 3000,
                                    completionTokens: 300,
                                    totalTokens: 3300,
                                    lastUsedAt: '2026-07-02T02:00:00.000Z'
                                }
                            }
                        }
                    }
                }
            }
        }), 'utf8');

        const { getAccountUsageSummary } = await loadKeyManager();
        const summary = await getAccountUsageSummary(new Date('2026-07-02T03:00:00.000Z'));
        const account = summary.accounts.find(item => item.accountKey === 'openai-codex-oauth:daily@example.com');

        expect(account.today).toMatchObject({
            requestCount: 3,
            totalTokens: 3300
        });
        expect(account.month).toMatchObject({
            requestCount: 10,
            totalTokens: 11000
        });
        expect(summary.periods.month).toBe('2026-06-03');
        expect(account.today.cost.missingPriceTokens).toBe(0);
    });

    test('getAccountUsageSummary merges Codex buckets by email across provider UUID and identity changes', async () => {
        const { createKey, incrementUsage, getAccountUsageSummary } = await loadKeyManager();

        jest.setSystemTime(new Date('2026-06-24T02:00:00.000Z'));
        const key = await createKey('Codex Client', 1000);

        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 4,
            promptTokens: 3900,
            completionTokens: 100,
            totalTokens: 4000
        }, 'req-legacy-provider-uuid', {
            providerUuid: 'old-provider-uuid',
            providerName: 'user@example.com'
        });

        jest.setSystemTime(new Date('2026-06-26T02:00:00.000Z'));
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 2,
            promptTokens: 1900,
            completionTokens: 100,
            totalTokens: 2000
        }, 'req-account-identity', {
            providerUuid: 'old-provider-uuid',
            providerName: 'user@example.com',
            accountIdentity: 'acct-chatgpt-123',
            accountEmail: 'user@example.com'
        });

        const summary = await getAccountUsageSummary(new Date('2026-06-26T03:00:00.000Z'));
        const matchingAccounts = summary.accounts.filter(account =>
            account.provider === 'openai-codex-oauth'
            && (
                account.accountEmail === 'user@example.com'
                || account.providerName === 'user@example.com'
                || account.providerUuids.includes('old-provider-uuid')
            )
        );

        expect(matchingAccounts).toHaveLength(1);
        expect(matchingAccounts[0]).toMatchObject({
            accountKey: 'openai-codex-oauth:user@example.com',
            provider: 'openai-codex-oauth',
            providerUuid: 'user@example.com',
            accountIdentity: 'user@example.com',
            accountEmail: 'user@example.com',
            providerName: 'user@example.com',
            providerUuids: ['old-provider-uuid']
        });
        expect(matchingAccounts[0].today).toMatchObject({ requestCount: 2, totalTokens: 2000 });
        expect(matchingAccounts[0].week).toMatchObject({ requestCount: 6, totalTokens: 6000 });
        expect(matchingAccounts[0].month).toMatchObject({ requestCount: 6, totalTokens: 6000 });
    });

    test('does not expose one provider UUID as an alias for conflicting Codex emails', async () => {
        const { createKey, incrementUsage, getAccountUsageSummary } = await loadKeyManager();
        const key = await createKey('Conflicting UUID Client', 1000);

        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            totalTokens: 100
        }, 'req-conflict-a', {
            providerUuid: 'shared-provider-uuid',
            providerName: 'Account A',
            accountIdentity: 'account-a',
            accountEmail: 'a@example.com'
        });
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 2,
            totalTokens: 200
        }, 'req-conflict-b', {
            providerUuid: 'shared-provider-uuid',
            providerName: 'Account B',
            accountIdentity: 'account-b',
            accountEmail: 'b@example.com'
        });

        const summary = await getAccountUsageSummary();
        const accounts = summary.accounts.filter(account =>
            account.accountEmail === 'a@example.com' || account.accountEmail === 'b@example.com'
        );

        expect(accounts).toHaveLength(2);
        expect(accounts.map(account => account.accountEmail).sort()).toEqual([
            'a@example.com',
            'b@example.com'
        ]);
        expect(accounts.every(account => !account.providerUuids.includes('shared-provider-uuid'))).toBe(true);
        expect(accounts.find(account => account.accountEmail === 'a@example.com').today.totalTokens).toBe(100);
        expect(accounts.find(account => account.accountEmail === 'b@example.com').today.totalTokens).toBe(200);
    });

    test('listKeys exposes sanitized related account names for audit key selectors', async () => {
        const { createKey, incrementUsage, listKeys } = await loadKeyManager();

        const key = await createKey('Audit Client', 1000);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 1,
            promptTokens: 2000,
            completionTokens: 300,
            totalTokens: 2300,
            cachedTokens: 800
        }, 'req-audit-related-1', {
            providerUuid: 'codex-account-email',
            providerName: 'user@example.com',
            timestamp: '2026-06-22T02:15:30.000Z'
        });
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.5', {
            requestCount: 3,
            promptTokens: 6000,
            completionTokens: 300,
            totalTokens: 6300,
            cachedTokens: 1200
        }, 'req-audit-related-2', {
            providerUuid: 'codex-account-name',
            providerName: 'Codex Account A',
            timestamp: '2026-06-22T02:20:30.000Z'
        });

        const [listedKey] = await listKeys();

        expect(listedKey.audit.relatedNames).toEqual([
            expect.stringMatching(/^redacted-email:/)
        ]);
        expect(JSON.stringify(listedKey.audit.relatedNames)).not.toContain('user@example.com');
    });

    test('records reasoning tokens through Potluck response hooks', async () => {
        const potluck = await loadPotluckPlugin();
        const key = await potluck.createKey('Codex Client', 1000);
        const requestId = 'req-codex-reasoning';

        await potluck.default.hooks.onUnaryResponse({
            requestId,
            nativeResponse: {
                usage: {
                    prompt_tokens: 1000,
                    completion_tokens: 120,
                    total_tokens: 1120,
                    completion_tokens_details: {
                        reasoning_tokens: 516
                    }
                }
            }
        });
        await potluck.default.hooks.onContentGenerated({
            _monitorRequestId: requestId,
            potluckApiKey: key.id,
            toProvider: 'openai-codex-oauth',
            model: 'gpt-5.5',
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A',
            accountEmail: 'codex-a@example.com'
        });

        const [listedKey] = await potluck.listKeys();
        const [dateKey] = Object.keys(listedKey.usageHistory);
        const accountKey = 'openai-codex-oauth:codex-a@example.com';

        expect(listedKey.todayReasoningTokens).toBe(516);
        expect(listedKey.todayCompletionTokens).toBe(120);
        expect(listedKey.todayTotalTokens).toBe(1120);
        expect(listedKey.usageHistory[dateKey].accounts[accountKey].models['gpt-5.5']).toMatchObject({
            completionTokens: 120,
            reasoningTokens: 516
        });
    });

    test('listKeys and getStats expose actual and gemini converted cost estimates', async () => {
        jest.setSystemTime(new Date('2026-06-22T02:15:30.000Z'));
        const { createKey, incrementUsage, listKeys, getStats } = await loadKeyManager();

        const key = await createKey('Cost Client', 1000);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 1000000,
            cachedTokens: 200000,
            completionTokens: 100000,
            totalTokens: 1100000
        }, 'req-cost-1', {
            providerUuid: 'codex-account-a',
            timestamp: '2026-06-22T02:15:30.000Z'
        });

        const [listedKey] = await listKeys({ conversionModel: 'gemini-2.5-flash' });
        const stats = await getStats({ conversionModel: 'gemini-2.5-flash' });

        expect(listedKey.cost).toMatchObject({
            actualUsd: expect.closeTo(1.065, 6),
            convertedUsd: expect.closeTo(0.496, 6),
            conversionModel: 'gemini-2.5-flash',
            pricingVersion: 'official-2026-08-01-r1',
            missingPriceTokens: 0
        });
        expect(listedKey.usageHistory['2026-06-22'].summary.cost).toMatchObject({
            actualUsd: expect.closeTo(1.065, 6),
            convertedUsd: expect.closeTo(0.496, 6)
        });
        expect(stats.cost).toMatchObject({
            actualUsd: expect.closeTo(1.065, 6),
            convertedUsd: expect.closeTo(0.496, 6)
        });
    });

    test('retains 35 days of per-key usage history', async () => {
        const { createKey, incrementUsage, listKeys } = await loadKeyManager();

        const key = await createKey('History Client', 1000);
        for (let offset = 0; offset < 36; offset++) {
            const date = new Date(Date.UTC(2026, 5, 1 + offset, 1, 0, 0));
            jest.setSystemTime(date);
            await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
                requestCount: 1,
                promptTokens: 1000,
                completionTokens: 100,
                totalTokens: 1100
            }, `req-history-${offset}`, {
                providerUuid: 'codex-account-a',
                timestamp: date.toISOString()
            });
        }

        const [listedKey] = await listKeys();
        const dates = Object.keys(listedKey.usageHistory).sort();

        expect(dates).toHaveLength(35);
        expect(dates[0]).toBe('2026-06-02');
        expect(dates.at(-1)).toBe('2026-07-06');
    });

    test('keeps cumulative actual cost by model after old daily history is trimmed', async () => {
        const { createKey, incrementUsage, listKeys, getStats } = await loadKeyManager();

        const key = await createKey('Cumulative Cost Client', 1000);
        for (let offset = 0; offset < 36; offset++) {
            const date = new Date(Date.UTC(2026, 5, 1 + offset, 1, 0, 0));
            jest.setSystemTime(date);
            await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
                requestCount: 1,
                promptTokens: 1000000,
                completionTokens: 100000,
                totalTokens: 1100000
            }, `req-cumulative-cost-${offset}`, {
                providerUuid: 'codex-account-a',
                timestamp: date.toISOString()
            });
        }

        const [listedKey] = await listKeys({ conversionModel: 'gemini-2.5-flash' });
        const stats = await getStats({ conversionModel: 'gemini-2.5-flash' });

        expect(Object.keys(listedKey.usageHistory)).toHaveLength(35);
        expect(listedKey.cost.actualUsd).toBeCloseTo(36 * 1.2, 6);
        expect(listedKey.cost.convertedUsd).toBeCloseTo(36 * 0.55, 6);
        expect(stats.cost.actualUsd).toBeCloseTo(36 * 1.2, 6);
    });

    test('summary-only key list keeps daily summaries without heavy per-day details', async () => {
        jest.setSystemTime(new Date('2026-06-22T02:15:30.000Z'));
        const { createKey, incrementUsage, listKeys } = await loadKeyManager();

        const key = await createKey('Compact List Client', 1000);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 1000000,
            cachedTokens: 250000,
            completionTokens: 100000,
            totalTokens: 1100000
        }, 'req-compact-list', {
            providerUuid: 'codex-account-a',
            providerName: 'user@example.com',
            accountEmail: 'user@example.com',
            timestamp: '2026-06-22T02:15:30.000Z'
        });

        const [fullKey] = await listKeys({ conversionModel: 'gemini-2.5-flash' });
        const [summaryKey] = await listKeys({ conversionModel: 'gemini-2.5-flash', summaryOnly: true, compactCosts: true });
        const fullDay = fullKey.usageHistory['2026-06-22'];
        const compactDay = summaryKey.usageHistory['2026-06-22'];

        expect(fullDay.accounts['openai-codex-oauth:user@example.com'].summary.totalTokens).toBe(1100000);
        expect(compactDay.summary).toMatchObject({
            requestCount: 1,
            promptTokens: 1000000,
            cachedTokens: 250000,
            completionTokens: 100000,
            totalTokens: 1100000,
            cacheHitRatio: 0.25
        });
        expect(fullDay.summary.cost.actualUsd).toBeGreaterThan(0);
        expect(compactDay.summary.cost.actualUsd).toBeGreaterThan(0);
        expect(compactDay.summary.cost.convertedUsd).toBeGreaterThan(0);
        expect(compactDay.summary.cost).not.toHaveProperty('byModel');
        expect(compactDay).not.toHaveProperty('providers');
        expect(compactDay).not.toHaveProperty('models');
        expect(compactDay).not.toHaveProperty('accounts');
        expect(compactDay).not.toHaveProperty('hours');
    });

    test('compact user history keeps distribution data without account and hourly details', async () => {
        jest.setSystemTime(new Date('2026-06-22T02:15:30.000Z'));
        const { createKey, incrementUsage, getKey } = await loadKeyManager();

        const key = await createKey('Compact User Client', 1000);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 1000,
            cachedTokens: 250,
            completionTokens: 100,
            totalTokens: 1100
        }, 'req-compact-user', {
            providerUuid: 'codex-account-a',
            providerName: 'user@example.com',
            accountEmail: 'user@example.com',
            timestamp: '2026-06-22T02:15:30.000Z'
        });

        const compactKey = await getKey(key.id, { compactUserHistory: true, compactCosts: true });
        const compactDay = compactKey.usageHistory['2026-06-22'];

        expect(compactDay.summary.totalTokens).toBe(1100);
        expect(compactDay.providers['openai-codex-oauth'].totalTokens).toBe(1100);
        expect(compactDay.models['gpt-5.4-mini'].requestCount).toBe(1);
        expect(compactDay).not.toHaveProperty('accounts');
        expect(compactDay).not.toHaveProperty('hours');
    });

    test('compact stats keeps summary provider and model totals without account details', async () => {
        jest.setSystemTime(new Date('2026-06-22T02:15:30.000Z'));
        const { createKey, incrementUsage, getStats } = await loadKeyManager();

        const key = await createKey('Compact Stats Client', 1000);
        await incrementUsage(key.id, 'openai-codex-oauth', 'gpt-5.4-mini', {
            requestCount: 1,
            promptTokens: 1000,
            completionTokens: 100,
            totalTokens: 1100
        }, 'req-compact-stats', {
            providerUuid: 'codex-account-a',
            providerName: 'user@example.com',
            accountEmail: 'user@example.com',
            timestamp: '2026-06-22T02:15:30.000Z'
        });

        const fullStats = await getStats();
        const compactStats = await getStats({ compactHistory: true, compactAccounts: true });
        const fullDay = fullStats.usageHistory['2026-06-22'];
        const compactDay = compactStats.usageHistory['2026-06-22'];

        expect(fullDay.accounts['openai-codex-oauth:user@example.com'].summary.totalTokens).toBe(1100);
        expect(compactDay.summary.totalTokens).toBe(1100);
        expect(compactDay.providers).toEqual({});
        expect(compactDay.models).toEqual({});
        expect(compactDay.accounts).toEqual({});
    });

    test('trims over-retained persisted history on load while preserving cumulative model cost', async () => {
        const usageHistory = {};
        for (let offset = 0; offset < 36; offset++) {
            const date = new Date(Date.UTC(2026, 5, 1 + offset)).toISOString().slice(0, 10);
            usageHistory[date] = {
                summary: {
                    requestCount: 1,
                    promptTokens: 1000000,
                    completionTokens: 100000,
                    totalTokens: 1100000
                },
                models: {
                    'gpt-5.4-mini': {
                        requestCount: 1,
                        promptTokens: 1000000,
                        completionTokens: 100000,
                        totalTokens: 1100000
                    }
                }
            };
        }
        fs.writeFileSync(path.join(tempDir, 'configs', 'api-potluck-keys.json'), JSON.stringify({
            keys: {
                maki_persisted_history: {
                    id: 'maki_persisted_history',
                    name: 'Persisted History',
                    createdAt: '2026-06-01T00:00:00.000Z',
                    dailyLimit: 1000,
                    todayUsage: 0,
                    totalUsage: 36,
                    totalPromptTokens: 36000000,
                    totalCompletionTokens: 3600000,
                    totalTokens: 39600000,
                    usageHistory,
                    lastResetDate: '2026-07-06',
                    enabled: true
                }
            }
        }), 'utf8');

        const { listKeys, getStats } = await loadKeyManager();
        const [listedKey] = await listKeys({ conversionModel: 'gemini-2.5-flash' });
        const stats = await getStats({ conversionModel: 'gemini-2.5-flash' });
        const dates = Object.keys(listedKey.usageHistory).sort();

        expect(dates).toHaveLength(35);
        expect(dates[0]).toBe('2026-06-02');
        expect(listedKey.cost.actualUsd).toBeCloseTo(36 * 1.2, 6);
        expect(Object.keys(stats.usageHistory)).toHaveLength(35);
        expect(stats.cost.actualUsd).toBeCloseTo(36 * 1.2, 6);
    });
});
