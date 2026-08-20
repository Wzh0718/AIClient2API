import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tempDir;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-email-migration-'));
});

afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeJson(fileName, data) {
    fs.writeFileSync(path.join(tempDir, fileName), JSON.stringify(data, null, 2), 'utf8');
}

function readJson(fileName) {
    return JSON.parse(fs.readFileSync(path.join(tempDir, fileName), 'utf8'));
}

describe('Codex email identity migration', () => {
    test('backs up config data permanently and merges old provider UUID account keys into email identity keys', async () => {
        writeJson('provider_pools.json', {
            'openai-codex-oauth': [
                { uuid: 'old-uuid', codexEmail: 'User@Example.com', customName: 'old' },
                { uuid: 'new-uuid', CODEX_EMAIL: 'user@example.com', customName: 'new' }
            ],
            'openaiResponses-custom': [
                { uuid: 'old-uuid', codexEmail: 'user@example.com', customName: 'responses' }
            ]
        });
        writeJson('model-usage-stats.json', {
            updatedAt: '2026-06-28T10:00:00.000Z',
            summary: { requestCount: 3, totalTokens: 3300 },
            providers: {},
            accounts: {
                'openai-codex-oauth:old-uuid': {
                    provider: 'openai-codex-oauth',
                    providerUuid: 'old-uuid',
                    providerUuids: ['old-uuid'],
                    providerName: 'old',
                    summary: { requestCount: 1, totalTokens: 1100 },
                    models: { 'gpt-5.5': { requestCount: 1, totalTokens: 1100 } }
                },
                'openai-codex-oauth:new-uuid': {
                    provider: 'openai-codex-oauth',
                    providerUuid: 'new-uuid',
                    providerUuids: ['new-uuid'],
                    providerName: 'new',
                    summary: { requestCount: 1, totalTokens: 1100 },
                    models: { 'gpt-5.4': { requestCount: 1, totalTokens: 1100 } }
                },
                'openaiResponses-custom:old-uuid': {
                    provider: 'openaiResponses-custom',
                    providerUuid: 'old-uuid',
                    providerUuids: ['old-uuid'],
                    providerName: 'responses',
                    summary: { requestCount: 1, totalTokens: 1100 },
                    models: { 'gpt-5.5': { requestCount: 1, totalTokens: 1100 } }
                }
            },
            accountUsageEvents: {
                'openai-codex-oauth:old-uuid': [{ timestamp: '2026-06-24T10:00:00.000Z', totalTokens: 1100 }],
                'openai-codex-oauth:new-uuid': [{ timestamp: '2026-06-25T10:00:00.000Z', totalTokens: 1100 }],
                'openaiResponses-custom:old-uuid': [{ timestamp: '2026-06-26T10:00:00.000Z', totalTokens: 1100 }]
            },
            daily: {
                '2026-06-24': {
                    accounts: {
                        'openai-codex-oauth:old-uuid': {
                            provider: 'openai-codex-oauth',
                            providerUuid: 'old-uuid',
                            providerUuids: ['old-uuid'],
                            summary: { requestCount: 1, totalTokens: 1100 },
                            models: { 'gpt-5.5': { requestCount: 1, totalTokens: 1100 } }
                        },
                        'openaiResponses-custom:old-uuid': {
                            provider: 'openaiResponses-custom',
                            providerUuid: 'old-uuid',
                            providerUuids: ['old-uuid'],
                            summary: { requestCount: 1, totalTokens: 1100 },
                            models: { 'gpt-5.5': { requestCount: 1, totalTokens: 1100 } }
                        }
                    }
                }
            }
        });
        writeJson('api-potluck-keys.json', {
            keys: {
                maki_test: {
                    id: 'maki_test',
                    name: 'Test Key',
                    usageHistory: {
                        '2026-06-24': {
                            accounts: {
                                'openai-codex-oauth:old-uuid': {
                                    provider: 'openai-codex-oauth',
                                    providerUuid: 'old-uuid',
                                    providerUuids: ['old-uuid'],
                                    providerName: 'old',
                                    summary: { requestCount: 1, totalTokens: 1100 },
                                    models: { 'gpt-5.5': { requestCount: 1, totalTokens: 1100 } }
                                },
                                'openaiResponses-custom:old-uuid': {
                                    provider: 'openaiResponses-custom',
                                    providerUuid: 'old-uuid',
                                    providerUuids: ['old-uuid'],
                                    providerName: 'responses',
                                    summary: { requestCount: 1, totalTokens: 1100 },
                                    models: { 'gpt-5.5': { requestCount: 1, totalTokens: 1100 } }
                                }
                            },
                            hours: {
                                '18': {
                                    accounts: {
                                        'openai-codex-oauth:new-uuid': {
                                            provider: 'openai-codex-oauth',
                                            providerUuid: 'new-uuid',
                                            providerUuids: ['new-uuid'],
                                            providerName: 'new',
                                            summary: { requestCount: 1, totalTokens: 1100 },
                                            models: { 'gpt-5.4': { requestCount: 1, totalTokens: 1100 } }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });
        for (const file of ['usage-cache.json', 'api-potluck-data.json', 'config.json', 'plugins.json']) {
            writeJson(file, { file });
        }

        const { migrateCodexEmailIdentity } = await import('../src/scripts/migrate-codex-email-identity.js');
        const result = await migrateCodexEmailIdentity({
            configDir: tempDir,
            now: new Date('2026-06-28T10:30:00.000Z')
        });

        const stats = readJson('model-usage-stats.json');
        const potluckKeys = readJson('api-potluck-keys.json');
        const accountKey = 'openai-codex-oauth:user@example.com';

        expect(result.backupDir).toBe(path.join(
            tempDir,
            '.migration-backups',
            'ai_client_configs_backup_before_email_identity_migration_20260628-103000'
        ));
        expect(fs.existsSync(result.backupDir)).toBe(true);
        expect(fs.existsSync(path.join(result.backupDir, 'SHA256SUMS.txt'))).toBe(true);
        expect(fs.existsSync(path.join(result.backupDir, 'README.txt'))).toBe(true);
        expect(fs.existsSync(path.join(result.backupDir, 'model-usage-stats.json'))).toBe(true);
        expect(Object.keys(stats.accounts)).toEqual([accountKey]);
        expect(stats.accounts[accountKey]).toMatchObject({
            provider: 'openai-codex-oauth',
            providerUuid: 'user@example.com',
            accountIdentity: 'user@example.com',
            accountEmail: 'user@example.com',
            providerUuids: ['old-uuid', 'new-uuid']
        });
        expect(stats.accounts[accountKey].summary).toMatchObject({
            requestCount: 3,
            totalTokens: 3300
        });
        expect(Object.keys(stats.daily['2026-06-24'].accounts)).toEqual([accountKey]);
        expect(stats.daily['2026-06-24'].accounts[accountKey].summary).toMatchObject({
            requestCount: 2,
            totalTokens: 2200
        });
        expect(stats.accountUsageEvents[accountKey].map(event => event.timestamp)).toEqual([
            '2026-06-24T10:00:00.000Z',
            '2026-06-25T10:00:00.000Z',
            '2026-06-26T10:00:00.000Z'
        ]);
        expect(Object.keys(potluckKeys.keys.maki_test.usageHistory['2026-06-24'].accounts)).toEqual([accountKey]);
        expect(potluckKeys.keys.maki_test.usageHistory['2026-06-24'].accounts[accountKey].summary).toMatchObject({
            requestCount: 2,
            totalTokens: 2200
        });
        expect(Object.keys(potluckKeys.keys.maki_test.usageHistory['2026-06-24'].hours['18'].accounts)).toEqual([accountKey]);
        expect(potluckKeys.keys.maki_test.usageHistory['2026-06-24'].hours['18'].accounts[accountKey].summary).toMatchObject({
            requestCount: 1,
            totalTokens: 1100
        });
        expect(result.totalsBefore.totalAccountTokens).toBe(result.totalsAfter.totalAccountTokens);
        expect(result.totalsBefore.totalDailyAccountTokens).toBe(result.totalsAfter.totalDailyAccountTokens);
        expect(result.totalsBefore.eventCount).toBe(result.totalsAfter.eventCount);
        expect(result.potluckTotalsBefore.totalAccountTokens).toBe(result.potluckTotalsAfter.totalAccountTokens);
    });

    test('drops Codex account buckets that cannot be mapped to an email and reports them', async () => {
        writeJson('provider_pools.json', {
            'openai-codex-oauth': [
                { uuid: 'known-uuid', codexEmail: 'user@example.com' }
            ]
        });
        writeJson('model-usage-stats.json', {
            updatedAt: '2026-06-28T10:00:00.000Z',
            summary: { requestCount: 2, totalTokens: 300 },
            providers: {},
            accounts: {
                'openai-codex-oauth:known-uuid': {
                    provider: 'openai-codex-oauth',
                    providerUuid: 'known-uuid',
                    providerUuids: ['known-uuid'],
                    summary: { requestCount: 1, totalTokens: 100 },
                    models: { 'gpt-5.5': { requestCount: 1, totalTokens: 100 } }
                },
                'openai-codex-oauth:orphan-uuid': {
                    provider: 'openai-codex-oauth',
                    providerUuid: 'orphan-uuid',
                    providerUuids: ['orphan-uuid'],
                    summary: { requestCount: 1, totalTokens: 200 },
                    models: { 'gpt-5.5': { requestCount: 1, totalTokens: 200 } }
                }
            },
            accountUsageEvents: {
                'openai-codex-oauth:known-uuid': [{ timestamp: '2026-06-24T10:00:00.000Z', totalTokens: 100 }],
                'openai-codex-oauth:orphan-uuid': [{ timestamp: '2026-06-24T11:00:00.000Z', totalTokens: 200 }]
            },
            daily: {}
        });
        writeJson('api-potluck-keys.json', {
            keys: {
                maki_test: {
                    usageHistory: {
                        '2026-06-24': {
                            accounts: {
                                'openai-codex-oauth:orphan-uuid': {
                                    provider: 'openai-codex-oauth',
                                    providerUuid: 'orphan-uuid',
                                    providerUuids: ['orphan-uuid'],
                                    summary: { requestCount: 1, totalTokens: 200 },
                                    models: { 'gpt-5.5': { requestCount: 1, totalTokens: 200 } }
                                }
                            }
                        }
                    }
                }
            }
        });

        const { migrateCodexEmailIdentity } = await import('../src/scripts/migrate-codex-email-identity.js');
        const result = await migrateCodexEmailIdentity({
            configDir: tempDir,
            now: new Date('2026-06-28T10:30:00.000Z'),
            dryRun: true
        });

        expect(result.accountCountBefore).toBe(2);
        expect(result.accountCountAfter).toBe(1);
        expect(result.totalsAfter.totalAccountTokens).toBe(100);
        expect(result.totalsAfter.eventCount).toBe(1);
        expect(result.droppedUnmappedStats).toMatchObject({
            accountKeys: ['openai-codex-oauth:orphan-uuid'],
            totalTokens: 200,
            eventCount: 1
        });
        expect(result.droppedUnmappedPotluck).toMatchObject({
            accountKeys: ['openai-codex-oauth:orphan-uuid'],
            totalTokens: 200,
            eventCount: 0
        });
    });

    test('formal migration removes unmapped Codex account buckets from persisted stats', async () => {
        writeJson('provider_pools.json', {
            'openai-codex-oauth': [
                { uuid: 'known-uuid', codexEmail: 'user@example.com' }
            ]
        });
        writeJson('model-usage-stats.json', {
            updatedAt: '2026-06-28T10:00:00.000Z',
            summary: { requestCount: 2, totalTokens: 300 },
            providers: {},
            accounts: {
                'openai-codex-oauth:known-uuid': {
                    provider: 'openai-codex-oauth',
                    providerUuid: 'known-uuid',
                    providerUuids: ['known-uuid'],
                    summary: { requestCount: 1, totalTokens: 100 },
                    models: { 'gpt-5.5': { requestCount: 1, totalTokens: 100 } }
                },
                'openai-codex-oauth:orphan-uuid': {
                    provider: 'openai-codex-oauth',
                    providerUuid: 'orphan-uuid',
                    providerUuids: ['orphan-uuid'],
                    summary: { requestCount: 1, totalTokens: 200 },
                    models: { 'gpt-5.5': { requestCount: 1, totalTokens: 200 } }
                }
            },
            accountUsageEvents: {},
            daily: {
                '2026-06-24': {
                    accounts: {
                        'openai-codex-oauth:orphan-uuid': {
                            provider: 'openai-codex-oauth',
                            providerUuid: 'orphan-uuid',
                            providerUuids: ['orphan-uuid'],
                            summary: { requestCount: 1, totalTokens: 200 },
                            models: { 'gpt-5.5': { requestCount: 1, totalTokens: 200 } }
                        }
                    }
                }
            }
        });
        writeJson('api-potluck-keys.json', { keys: {} });

        const { migrateCodexEmailIdentity } = await import('../src/scripts/migrate-codex-email-identity.js');
        await migrateCodexEmailIdentity({
            configDir: tempDir,
            now: new Date('2026-06-28T10:30:00.000Z')
        });

        const stats = readJson('model-usage-stats.json');
        expect(stats.accounts['openai-codex-oauth:orphan-uuid']).toBeUndefined();
        expect(stats.daily['2026-06-24'].accounts['openai-codex-oauth:orphan-uuid']).toBeUndefined();
        expect(Object.keys(stats.accounts)).toEqual(['openai-codex-oauth:user@example.com']);
        expect(fs.existsSync(path.join(
            tempDir,
            '.migration-backups',
            'ai_client_configs_backup_before_email_identity_migration_20260628-103000',
            'model-usage-stats.json'
        ))).toBe(true);
    });

    test('uses explicit email identity overrides for historical orphan UUIDs', async () => {
        writeJson('provider_pools.json', {});
        writeJson('codex-email-identity-overrides.json', {
            'openai-codex-oauth:orphan-uuid': 'User@Example.com',
            'responses-uuid': 'user@example.com'
        });
        writeJson('model-usage-stats.json', {
            updatedAt: '2026-06-28T10:00:00.000Z',
            summary: { requestCount: 2, totalTokens: 300 },
            providers: {},
            accounts: {
                'openai-codex-oauth:orphan-uuid': {
                    provider: 'openai-codex-oauth',
                    providerUuid: 'orphan-uuid',
                    providerUuids: ['orphan-uuid'],
                    summary: { requestCount: 1, totalTokens: 100 },
                    models: { 'gpt-5.5': { requestCount: 1, totalTokens: 100 } }
                },
                'openaiResponses-custom:responses-uuid': {
                    provider: 'openaiResponses-custom',
                    providerUuid: 'responses-uuid',
                    providerUuids: ['responses-uuid'],
                    summary: { requestCount: 1, totalTokens: 200 },
                    models: { 'gpt-5.4': { requestCount: 1, totalTokens: 200 } }
                }
            },
            accountUsageEvents: {},
            daily: {}
        });

        const { migrateCodexEmailIdentity } = await import('../src/scripts/migrate-codex-email-identity.js');
        const result = await migrateCodexEmailIdentity({
            configDir: tempDir,
            now: new Date('2026-06-28T10:30:00.000Z')
        });

        const stats = readJson('model-usage-stats.json');
        const accountKey = 'openai-codex-oauth:user@example.com';

        expect(Object.keys(stats.accounts)).toEqual([accountKey]);
        expect(stats.accounts[accountKey]).toMatchObject({
            providerUuid: 'user@example.com',
            accountIdentity: 'user@example.com',
            accountEmail: 'user@example.com',
            providerUuids: ['orphan-uuid', 'responses-uuid']
        });
        expect(stats.accounts[accountKey].summary).toMatchObject({
            requestCount: 2,
            totalTokens: 300
        });
        expect(result.droppedUnmappedStats).toMatchObject({
            accountKeys: [],
            totalTokens: 0,
            eventCount: 0
        });
        expect(fs.existsSync(path.join(result.backupDir, 'codex-email-identity-overrides.json'))).toBe(true);
    });

    test('explicit UUID override replaces an embedded historical email identity', async () => {
        writeJson('provider_pools.json', {});
        writeJson('codex-email-identity-overrides.json', {
            'provider-uuid': 'new-address@mail.com'
        });
        writeJson('model-usage-stats.json', {
            updatedAt: '2026-08-19T03:59:57.000Z',
            summary: { requestCount: 2, totalTokens: 300 },
            providers: {},
            accounts: {
                'openai-codex-oauth:old-address@outlook.com': {
                    provider: 'openai-codex-oauth',
                    providerUuid: 'old-address@outlook.com',
                    accountIdentity: 'old-address@outlook.com',
                    accountEmail: 'old-address@outlook.com',
                    providerName: 'old-address@outlook.com',
                    providerUuids: ['provider-uuid'],
                    summary: { requestCount: 2, totalTokens: 300 },
                    models: { 'gpt-5.6-sol': { requestCount: 2, totalTokens: 300 } }
                }
            },
            accountUsageEvents: {
                'openai-codex-oauth:old-address@outlook.com': [
                    { timestamp: '2026-08-19T04:00:00.000Z', totalTokens: 300 }
                ]
            },
            daily: {
                '2026-08-19': {
                    accounts: {
                        'openai-codex-oauth:old-address@outlook.com': {
                            provider: 'openai-codex-oauth',
                            providerUuid: 'old-address@outlook.com',
                            accountIdentity: 'old-address@outlook.com',
                            accountEmail: 'old-address@outlook.com',
                            providerName: 'old-address@outlook.com',
                            providerUuids: ['provider-uuid'],
                            summary: { requestCount: 2, totalTokens: 300 },
                            models: { 'gpt-5.6-sol': { requestCount: 2, totalTokens: 300 } }
                        }
                    }
                }
            }
        });
        writeJson('api-potluck-keys.json', { keys: {} });

        const { migrateCodexEmailIdentity } = await import('../src/scripts/migrate-codex-email-identity.js');
        await migrateCodexEmailIdentity({ configDir: tempDir, dryRun: false });

        const stats = readJson('model-usage-stats.json');
        const newKey = 'openai-codex-oauth:new-address@mail.com';
        expect(stats.accounts[newKey]).toMatchObject({
            accountEmail: 'new-address@mail.com',
            accountIdentity: 'new-address@mail.com',
            providerUuids: ['provider-uuid'],
            summary: { requestCount: 2, totalTokens: 300 }
        });
        expect(stats.accounts['openai-codex-oauth:old-address@outlook.com']).toBeUndefined();
        expect(stats.daily['2026-08-19'].accounts[newKey].summary.totalTokens).toBe(300);
        expect(stats.accountUsageEvents[newKey]).toHaveLength(1);
    });
});
