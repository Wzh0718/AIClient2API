import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(config => ({ providerUuid: config.uuid })),
    getRegisteredProviders: jest.fn(() => ['openai-codex-oauth', 'openai-custom']),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

import {
    getApiService,
    getApiServiceWithFallback,
    getProviderPoolManager,
    initApiService
} from '../src/services/service-manager.js';
import { codexCredentialGroupAffinityStore } from '../src/providers/openai/codex-credential-group-affinity.js';
import { assertCodexRoutingIntegrity } from '../src/services/codex-routing-integrity.js';

const providerType = 'openai-codex-oauth';
let tempDir;
let groupFilePath;

function provider(uuid, overrides = {}) {
    return {
        uuid,
        customName: uuid,
        codexAccountKey: `account-${uuid}`,
        lastKnownCodexPlan: 'pro',
        supportedModels: ['gpt-5.4-mini', 'gpt-5.6-luna'],
        ...overrides
    };
}

function writeGroupConfig({ groups, keyAssignments }) {
    fs.writeFileSync(groupFilePath, JSON.stringify({
        version: 1,
        currentRevision: 1,
        revisions: [{
            revision: 1,
            action: 'apply',
            previousRevision: null,
            config: { groups, keyAssignments }
        }]
    }), 'utf8');
}

function createConfig({
    providers = [provider('codex-a'), provider('codex-b')],
    keyData = {},
    sessionId = 'session-a',
    extra = {}
} = {}) {
    return {
        MODEL_PROVIDER: providerType,
        PROVIDER_POOLS_FILE_PATH: path.join(tempDir, 'provider-pools.json'),
        CODEX_CREDENTIAL_GROUPS_FILE_PATH: groupFilePath,
        CODEX_POTLUCK_STICKY_PROVIDER_ENABLED: true,
        potluckApiKey: 'maki_test_secret_not_persisted',
        potluckKeyData: {
            id: 'key-1',
            name: 'Key 1',
            routingMode: 'auto',
            primaryGroupId: null,
            fixedCredential: null,
            manualLock: false,
            ...keyData
        },
        _codexCacheAffinityScope: sessionId ? { sessionId } : {},
        _codexOverloadFailoverKey: sessionId ? `session:${sessionId}` : null,
        providerPools: {
            [providerType]: providers
        },
        ...extra
    };
}

async function initialize(config) {
    await initApiService(config, false, { persistenceEnabled: false });
    return getProviderPoolManager();
}

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-credential-groups-'));
    groupFilePath = path.join(tempDir, 'codex-credential-groups.json');
    codexCredentialGroupAffinityStore.clearAll();
});

afterEach(() => {
    jest.restoreAllMocks();
    codexCredentialGroupAffinityStore.clearAll();
    const manager = getProviderPoolManager();
    if (manager?.saveTimer) {
        clearTimeout(manager.saveTimer);
        manager.saveTimer = null;
    }
    manager?.pendingSaves?.clear();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Service Manager Codex credential-group routing', () => {
    test('waits inside the primary group before spilling over after an upstream rate limit', async () => {
        writeGroupConfig({
            groups: [
                { id: 'group-a', credentialUuids: ['codex-a'] },
                { id: 'group-b', credentialUuids: ['codex-b'] }
            ],
            keyAssignments: []
        });
        const config = createConfig({
            providers: [provider('codex-a'), provider('codex-b')],
            keyData: { routingMode: 'auto', primaryGroupId: 'group-a' },
            extra: { CODEX_GROUP_RATE_LIMIT_WAIT_MS: 30 }
        });
        const manager = await initialize(config);
        const rateLimit = new Error('upstream rate limited');
        rateLimit.status = 429;
        rateLimit.code = 429;
        rateLimit.origin = 'upstream_codex';
        rateLimit.details = { reason: 'UPSTREAM_RATE_LIMIT' };
        rateLimit.nextRecoveryTime = new Date(Date.now() + 20).toISOString();
        const selectSpy = jest.spyOn(manager, 'acquireSlotWithFallback')
            .mockRejectedValueOnce(rateLimit)
            .mockResolvedValueOnce({
                config: provider('codex-a'),
                actualProviderType: providerType,
                isFallback: false
            });

        const startedAt = Date.now();
        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini', { acquireSlot: true });

        expect(result.uuid).toBe('codex-a');
        expect(selectSpy).toHaveBeenCalledTimes(2);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
        expect(config._codexRouting).toMatchObject({
            selectedGroupId: 'group-a',
            spillover: false
        });
    });

    test('spills over only after the primary group rate-limit wait expires', async () => {
        writeGroupConfig({
            groups: [
                { id: 'group-a', credentialUuids: ['codex-a'] },
                { id: 'group-b', credentialUuids: ['codex-b'] }
            ],
            keyAssignments: []
        });
        const config = createConfig({
            providers: [provider('codex-a'), provider('codex-b')],
            keyData: { routingMode: 'auto', primaryGroupId: 'group-a' },
            extra: { CODEX_GROUP_RATE_LIMIT_WAIT_MS: 20 }
        });
        const manager = await initialize(config);
        const rateLimit = new Error('upstream rate limited');
        rateLimit.status = 429;
        rateLimit.code = 429;
        rateLimit.origin = 'upstream_codex';
        rateLimit.details = { reason: 'UPSTREAM_RATE_LIMIT' };
        rateLimit.nextRecoveryTime = new Date(Date.now() + 15).toISOString();
        const selectSpy = jest.spyOn(manager, 'acquireSlotWithFallback')
            .mockRejectedValueOnce(rateLimit)
            .mockRejectedValueOnce(rateLimit)
            .mockResolvedValueOnce({
                config: provider('codex-b'),
                actualProviderType: providerType,
                isFallback: false
            });

        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini', { acquireSlot: true });

        expect(result.uuid).toBe('codex-b');
        expect(selectSpy).toHaveBeenCalledTimes(3);
        expect(config._codexRouting).toMatchObject({
            selectedGroupId: 'group-b',
            spillover: true,
            spilloverReason: 'PRIMARY_GROUP_UNAVAILABLE',
            spilloverCause: 'RATE_LIMIT_WAIT_EXPIRED'
        });
    });

    test('fixed routing constrains both service entry points to the specified credential', async () => {
        writeGroupConfig({
            groups: [
                { id: 'group-a', credentialUuids: ['codex-a'] },
                { id: 'group-b', credentialUuids: ['codex-b'] }
            ],
            keyAssignments: []
        });
        const config = createConfig({
            keyData: {
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-b' },
                manualLock: true
            }
        });
        const manager = await initialize(config);
        const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');

        const basicService = await getApiService(config, 'gpt-5.3-codex-spark');
        const detailed = await getApiServiceWithFallback(config, 'gpt-5.3-codex-spark');

        expect(basicService.providerUuid).toBe('codex-b');
        expect(detailed.uuid).toBe('codex-b');
        expect(detailed.actualModel).toBe('gpt-5.6-luna');
        expect(detailed.modelFallbackReason).toBe('SPARK_ALIAS');
        expect(selectSpy).toHaveBeenCalledTimes(2);
        for (const call of selectSpy.mock.calls) {
            expect(call[1]).toBe('gpt-5.6-luna');
            expect(call[2]).toMatchObject({
                allowedProviderUuids: ['codex-b'],
                disableProviderFallback: true
            });
        }
        expect(config._codexRouting).toMatchObject({
            routingMode: 'fixed',
            selectedGroupId: 'group-b',
            selectedProviderUuid: 'codex-b',
            spillover: false
        });
    });

    test('fixed Codex routing maps Spark requests to Luna before provider selection', async () => {
        writeGroupConfig({
            groups: [
                { id: 'group-a', credentialUuids: ['codex-a'] },
                { id: 'group-b', credentialUuids: ['codex-b'] }
            ],
            keyAssignments: [{
                keyId: 'key-1',
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-a' }
            }]
        });
        const config = createConfig({
            providers: [provider('codex-a'), provider('codex-b')],
            keyData: {
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-a' },
                manualLock: true
            }
        });
        const manager = await initialize(config);
        const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback').mockResolvedValue({
            config: provider('codex-a'),
            actualProviderType: providerType,
            isFallback: false
        });

        const result = await getApiServiceWithFallback(config, 'gpt-5.3-codex-spark');

        expect(selectSpy.mock.calls[0][1]).toBe('gpt-5.6-luna');
        expect(result).toMatchObject({
            uuid: 'codex-a',
            actualModel: 'gpt-5.6-luna',
            modelFallbackFrom: 'gpt-5.3-codex-spark',
            modelFallbackTo: 'gpt-5.6-luna',
            modelFallbackReason: 'SPARK_ALIAS'
        });
    });

    test('uses the credential-group assignment as the routing source when key data is stale', async () => {
        writeGroupConfig({
            groups: [
                { id: 'group-a', credentialUuids: ['codex-a'] },
                { id: 'group-b', credentialUuids: ['codex-b'] }
            ],
            keyAssignments: [{
                keyId: 'key-1',
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-b' }
            }]
        });
        const config = createConfig({
            keyData: {
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-a' }
            }
        });
        await initialize(config);

        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini');

        expect(result.uuid).toBe('codex-b');
        expect(config._codexRouting).toMatchObject({
            routingMode: 'fixed',
            selectedGroupId: 'group-b',
            selectedProviderUuid: 'codex-b'
        });
    });

    test('fixed routing reports a route mismatch when its credential is not in a group', async () => {
        writeGroupConfig({
            groups: [{ id: 'group-a', credentialUuids: ['codex-a'] }],
            keyAssignments: [{
                keyId: 'key-1',
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-b' }
            }]
        });
        const config = createConfig({
            providers: [provider('codex-a'), provider('codex-b')],
            keyData: { routingMode: 'pool' }
        });
        await initialize(config);

        await expect(getApiServiceWithFallback(config, 'gpt-5.4-mini')).rejects.toMatchObject({
            code: 'ROUTE_MISMATCH',
            status: 503,
            details: expect.objectContaining({ reason: 'FIXED_CREDENTIAL_NOT_IN_GROUP' })
        });
    });

    test.each([
        ['unhealthy', provider('codex-a', { isHealthy: false })],
        ['concurrency exhausted', provider('codex-a', { concurrencyLimit: 1, queueLimit: 0 })]
    ])('fixed routing fails closed when the credential is %s', async (caseName, fixedProvider) => {
        writeGroupConfig({
            groups: [{ id: 'group-a', credentialUuids: ['codex-a', 'codex-b'] }],
            keyAssignments: []
        });
        const config = createConfig({
            providers: [fixedProvider, provider('codex-b')],
            keyData: {
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-a' },
                manualLock: true
            }
        });
        const manager = await initialize(config);
        if (caseName === 'concurrency exhausted') {
            manager.providerStatus[providerType][0].state.activeCount = 1;
        }

        const options = caseName === 'concurrency exhausted' ? { acquireSlot: true } : {};
        await expect(getApiServiceWithFallback(config, 'gpt-5.4-mini', options)).rejects.toMatchObject({
            code: 'FIXED_CREDENTIAL_UNAVAILABLE'
        });
        expect(config._codexRouting).toMatchObject({
            routingMode: 'fixed',
            selectedProviderUuid: null,
            spillover: false
        });
    });

    test('fixed routing reports MODEL_NOT_SUPPORTED for a healthy credential without the requested model', async () => {
        writeGroupConfig({
            groups: [{ id: 'group-a', credentialUuids: ['codex-a'] }],
            keyAssignments: [{
                keyId: 'key-1',
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-a' }
            }]
        });
        const config = createConfig({
            providers: [provider('codex-a', { supportedModels: ['gpt-5.3-codex'] })],
            keyData: { routingMode: 'pool' }
        });
        await initialize(config);

        await expect(getApiServiceWithFallback(config, 'gpt-5.4-mini')).rejects.toMatchObject({
            code: 'MODEL_NOT_SUPPORTED',
            status: 404
        });
    });

    test('fixed routing reports PROVIDER_COOLDOWN while the fixed credential is cooling down', async () => {
        const recoveryTime = new Date(Date.now() + 60_000).toISOString();
        writeGroupConfig({
            groups: [{ id: 'group-a', credentialUuids: ['codex-a'] }],
            keyAssignments: [{
                keyId: 'key-1',
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-a' }
            }]
        });
        const config = createConfig({
            providers: [provider('codex-a', {
                isHealthy: false,
                scheduledRecoveryTime: recoveryTime
            })],
            keyData: { routingMode: 'pool' }
        });
        const manager = await initialize(config);
        Object.assign(manager.providerStatus[providerType][0].config, {
            isHealthy: false,
            scheduledRecoveryTime: recoveryTime
        });

        await expect(getApiServiceWithFallback(config, 'gpt-5.4-mini')).rejects.toMatchObject({
            code: 'PROVIDER_COOLDOWN',
            status: 429,
            retryAfter: recoveryTime
        });
    });

    test('fixed routing lazily recovers an expired provider cooldown before candidate validation', async () => {
        writeGroupConfig({
            groups: [{ id: 'group-a', credentialUuids: ['codex-a'] }],
            keyAssignments: [{
                keyId: 'key-1',
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-a' }
            }]
        });
        const config = createConfig({
            providers: [provider('codex-a', {
                isHealthy: false,
                scheduledRecoveryTime: '2026-08-25T00:00:00.000Z',
                lastErrorMessage: 'expired cooldown'
            })],
            keyData: { routingMode: 'pool' }
        });
        const manager = await initialize(config);
        Object.assign(manager.providerStatus[providerType][0].config, {
            isHealthy: false,
            scheduledRecoveryTime: '2026-08-25T00:00:00.000Z',
            lastErrorMessage: 'expired cooldown'
        });

        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini');

        expect(result.uuid).toBe('codex-a');
        expect(config._codexRouting).toMatchObject({
            routingMode: 'fixed',
            selectedGroupId: 'group-a',
            selectedProviderUuid: 'codex-a'
        });
    });

    test('auto routing tries the primary group first and constrains each group attempt separately', async () => {
        writeGroupConfig({
            groups: [
                { id: 'group-a', credentialUuids: ['codex-a'] },
                { id: 'group-b', credentialUuids: ['codex-b'] }
            ],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]
        });
        const config = createConfig({
            providers: [provider('codex-a', { isHealthy: false }), provider('codex-b')]
        });
        const manager = await initialize(config);
        const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');

        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini');

        expect(result.uuid).toBe('codex-b');
        expect(selectSpy.mock.calls.map(call => call[2].allowedProviderUuids)).toEqual([
            ['codex-a'],
            ['codex-b']
        ]);
        expect(selectSpy.mock.calls.every(call => call[2].disableProviderFallback === true)).toBe(true);
        expect(config._codexRouting).toMatchObject({
            routingMode: 'auto',
            requestedPrimaryGroupId: 'group-a',
            selectedGroupId: 'group-b',
            selectedProviderUuid: 'codex-b',
            spillover: true,
            spilloverReason: 'PRIMARY_GROUP_UNAVAILABLE'
        });
    });

    test('auto routing spills over after the primary group hits Codex weekly quota', async () => {
        const usageCachePath = path.join(process.cwd(), 'configs', 'usage-cache.json');
        const originalUsageCacheExisted = fs.existsSync(usageCachePath);
        const originalUsageCacheContent = originalUsageCacheExisted ? fs.readFileSync(usageCachePath, 'utf8') : null;
        fs.mkdirSync(path.dirname(usageCachePath), { recursive: true });
        fs.writeFileSync(usageCachePath, JSON.stringify({
            timestamp: new Date().toISOString(),
            providers: {
                [providerType]: {
                    providerType,
                    instances: [
                        {
                            uuid: 'codex-a',
                            success: true,
                            usage: {
                                summary: { plan: 'pro' },
                                items: [
                                    { id: 'primary_window', percent: 10, unit: 'percent' },
                                    { id: 'secondary_window', percent: 100, unit: 'percent' }
                                ]
                            }
                        },
                        {
                            uuid: 'codex-b',
                            success: true,
                            usage: {
                                summary: { plan: 'pro' },
                                items: [
                                    { id: 'primary_window', percent: 10, unit: 'percent' },
                                    { id: 'secondary_window', percent: 20, unit: 'percent' }
                                ]
                            }
                        }
                    ]
                }
            }
        }), 'utf8');

        try {
            writeGroupConfig({
                groups: [
                    { id: 'group-a', credentialUuids: ['codex-a'] },
                    { id: 'group-b', credentialUuids: ['codex-b'] }
                ],
                keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]
            });
            const config = createConfig({
                providers: [
                    provider('codex-a', { lastKnownCodexPlan: 'pro', codexGeneralMaxWeeklyPercent: 90 }),
                    provider('codex-b', { lastKnownCodexPlan: 'pro', codexGeneralMaxWeeklyPercent: 90 })
                ],
                keyData: { routingMode: 'auto', primaryGroupId: 'group-a' },
                extra: { CODEX_POOL_SNAPSHOT_TTL_MS: 30_000 }
            });
            await initialize(config);

            const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini');

            expect(result.uuid).toBe('codex-b');
            expect(config._codexRouting).toMatchObject({
                routingMode: 'auto',
                requestedPrimaryGroupId: 'group-a',
                selectedGroupId: 'group-b',
                selectedProviderUuid: 'codex-b',
                spillover: true,
                spilloverReason: 'PRIMARY_GROUP_UNAVAILABLE'
            });
        } finally {
            if (originalUsageCacheExisted) {
                fs.writeFileSync(usageCachePath, originalUsageCacheContent, 'utf8');
            } else if (fs.existsSync(usageCachePath)) {
                fs.rmSync(usageCachePath, { force: true });
            }
        }
    });

    test('auto routing maps Spark requests to Luna before group selection', async () => {
        writeGroupConfig({
            groups: [
                { id: 'group-a', credentialUuids: ['codex-a'] },
                { id: 'group-b', credentialUuids: ['codex-b'] }
            ],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]
        });
        const config = createConfig({
            providers: [provider('codex-a'), provider('codex-b')]
        });
        const manager = await initialize(config);
        const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback').mockResolvedValue({
            config: provider('codex-a'),
            actualProviderType: providerType,
            isFallback: false
        });

        const result = await getApiServiceWithFallback(config, 'gpt-5.3-codex-spark');

        expect(selectSpy.mock.calls[0][1]).toBe('gpt-5.6-luna');
        expect(result.actualModel).toBe('gpt-5.6-luna');
        expect(result.modelFallbackFrom).toBe('gpt-5.3-codex-spark');
        expect(result.modelFallbackTo).toBe('gpt-5.6-luna');
        expect(result.modelFallbackReason).toBe('SPARK_ALIAS');
    });

    test('maps Spark-fast requests to Luna-fast at entry', async () => {
        writeGroupConfig({
            groups: [{ id: 'group-a', credentialUuids: ['codex-a'] }],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]
        });
        const config = createConfig({ providers: [provider('codex-a')] });
        const manager = await initialize(config);
        const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback').mockResolvedValue({
            config: provider('codex-a'),
            actualProviderType: providerType,
            isFallback: false
        });

        const result = await getApiServiceWithFallback(config, 'gpt-5.3-codex-spark-fast');

        expect(selectSpy.mock.calls[0][1]).toBe('gpt-5.6-luna-fast');
        expect(result).toMatchObject({
            actualModel: 'gpt-5.6-luna-fast',
            modelFallbackFrom: 'gpt-5.3-codex-spark-fast',
            modelFallbackTo: 'gpt-5.6-luna-fast',
            modelFallbackReason: 'SPARK_ALIAS'
        });
    });

    test('auto spillover stays on the selected group for the same session while a new session retries primary', async () => {
        writeGroupConfig({
            groups: [
                { id: 'group-a', credentialUuids: ['codex-a'] },
                { id: 'group-b', credentialUuids: ['codex-b'] }
            ],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]
        });
        const firstConfig = createConfig({
            providers: [provider('codex-a', { isHealthy: false }), provider('codex-b')],
            sessionId: 'same-session'
        });
        const manager = await initialize(firstConfig);

        const first = await getApiServiceWithFallback(firstConfig, 'gpt-5.4-mini');
        expect(first.uuid).toBe('codex-b');

        manager.providerStatus[providerType].find(item => item.uuid === 'codex-a').config.isHealthy = true;
        const sameSessionConfig = createConfig({ sessionId: 'same-session' });
        sameSessionConfig.providerPools = firstConfig.providerPools;
        const sameSession = await getApiServiceWithFallback(sameSessionConfig, 'gpt-5.4-mini');
        expect(sameSession.uuid).toBe('codex-b');
        expect(sameSessionConfig._codexRouting).toMatchObject({
            selectedGroupId: 'group-b',
            spillover: true
        });

        const newSessionConfig = createConfig({ sessionId: 'new-session' });
        newSessionConfig.providerPools = firstConfig.providerPools;
        const newSession = await getApiServiceWithFallback(newSessionConfig, 'gpt-5.4-mini');
        expect(newSession.uuid).toBe('codex-a');
        expect(newSessionConfig._codexRouting).toMatchObject({
            selectedGroupId: 'group-a',
            spillover: false
        });

        const persisted = JSON.parse(fs.readFileSync(groupFilePath, 'utf8'));
        expect(persisted.revisions[0].config.keyAssignments[0].primaryGroupId).toBe('group-a');
    });

    test('an unassigned auto key preserves the legacy whole-pool routing behavior', async () => {
        writeGroupConfig({
            groups: [
                { id: 'group-a', credentialUuids: ['codex-a'] },
                { id: 'group-b', credentialUuids: ['codex-b'] }
            ],
            keyAssignments: []
        });
        const config = createConfig();
        const manager = await initialize(config);
        const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');

        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini');

        expect(['codex-a', 'codex-b']).toContain(result.uuid);
        expect(selectSpy).toHaveBeenCalledTimes(1);
        expect(selectSpy.mock.calls[0][2].allowedProviderUuids).toBeUndefined();
        expect(config._codexRouting).toMatchObject({
            routingMode: 'pool',
            selectedGroupId: null,
            assignmentMissing: false
        });
    });

    test('an explicit pool assignment uses the weighted whole pool without provider constraints', async () => {
        writeGroupConfig({
            groups: [
                { id: 'group-a', credentialUuids: ['codex-a'] },
                { id: 'group-b', credentialUuids: ['codex-b'] }
            ],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'pool', primaryGroupId: null }]
        });
        const config = createConfig({ keyData: { routingMode: 'pool' } });
        const manager = await initialize(config);
        const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');

        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini');

        expect(['codex-a', 'codex-b']).toContain(result.uuid);
        expect(selectSpy).toHaveBeenCalledTimes(1);
        expect(selectSpy.mock.calls[0][2].allowedProviderUuids).toBeUndefined();
        expect(config._codexRouting).toMatchObject({
            routingMode: 'pool',
            selectedGroupId: null,
            selectedProviderUuid: result.uuid,
            assignmentMissing: false
        });
        expect(config._codexRouteResult).toMatchObject({
            routingMode: 'pool',
            selectedGroupId: null,
            selectedProviderUuid: result.uuid,
            actualProviderGroupId: null,
            providerSwitchCount: 0,
            consistencyStatus: 'consistent'
        });
    });

    test('fails closed before sending when final provider routing is inconsistent', () => {
        const config = createConfig({ keyData: { routingMode: 'auto', primaryGroupId: 'group-a' } });
        config._codexRouteResult = {
            routingMode: 'auto',
            selectedGroupId: 'group-a',
            actualProviderGroupId: 'group-b',
            selectedProviderUuid: 'codex-a'
        };

        expect(() => assertCodexRoutingIntegrity(config, 'codex-b')).toThrow(expect.objectContaining({
            code: 'ROUTING_INTEGRITY_VIOLATION'
        }));
    });

    test('updates the final route result after a provider switch', async () => {
        writeGroupConfig({
            groups: [
                { id: 'group-a', credentialUuids: ['codex-a'] },
                { id: 'group-b', credentialUuids: ['codex-b'] }
            ],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]
        });
        const config = createConfig({
            providers: [
                provider('codex-a', {
                    customName: 'Codex A',
                    codexAccountKey: 'account-a',
                    codexEmail: 'a@example.com'
                }),
                provider('codex-b', {
                    customName: 'Codex B',
                    codexAccountKey: 'account-b',
                    codexEmail: 'b@example.com'
                })
            ]
        });
        await initialize(config);

        const first = await getApiServiceWithFallback(config, 'gpt-5.4-mini');
        const second = await getApiServiceWithFallback(config, 'gpt-5.4-mini', {
            excludeProviderUuids: [first.uuid]
        });

        expect(first.uuid).toBe('codex-a');
        expect(second.uuid).toBe('codex-b');
        expect(config._codexRouteResult).toMatchObject({
            routingMode: 'auto',
            selectedGroupId: 'group-b',
            selectedProviderUuid: 'codex-b',
            actualProviderGroupId: 'group-b',
            providerSwitchCount: 1,
            consistencyStatus: 'consistent',
            providerName: 'Codex B',
            accountIdentity: 'account-b',
            accountEmail: 'b@example.com'
        });
        expect(config._codexRouting).toMatchObject({
            selectedGroupId: 'group-b',
            selectedProviderUuid: 'codex-b',
            providerSwitchCount: 1
        });
    });

    test('pool routing does not process GPT-5.4 exhaustion as a model fallback', async () => {
        writeGroupConfig({ groups: [], keyAssignments: [{ keyId: 'key-1', routingMode: 'pool' }] });
        const config = createConfig({
            providers: [
                provider('codex-a', { notSupportedModels: ['gpt-5.4-mini'] }),
                provider('codex-b', { notSupportedModels: ['gpt-5.4-mini'] })
            ],
            keyData: { routingMode: 'pool' }
        });
        await initialize(config);

        await expect(getApiServiceWithFallback(config, 'gpt-5.4-mini')).rejects.toMatchObject({
            code: 'MODEL_NOT_SUPPORTED'
        });
    });

    test('fixed routing sends 5.4 requests to GPT-5.4 Mini when the credential supports it', async () => {
        writeGroupConfig({
            groups: [{ id: 'group-a', credentialUuids: ['codex-a'] }],
            keyAssignments: [{
                keyId: 'key-1',
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-a' }
            }]
        });
        const config = createConfig({
            providers: [provider('codex-a', { supportedModels: ['gpt-5.4-mini'] })],
            keyData: {
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-a' }
            }
        });
        await initialize(config);

        const result = await getApiServiceWithFallback(config, 'gpt-5.4-mini');

        expect(result).toMatchObject({ uuid: 'codex-a', actualModel: 'gpt-5.4-mini', isFallback: false });
    });

    test('fixed routing fails closed when the credential does not support GPT-5.4 Mini', async () => {
        writeGroupConfig({
            groups: [{ id: 'group-a', credentialUuids: ['codex-a'] }],
            keyAssignments: [{
                keyId: 'key-1',
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-a' }
            }]
        });
        const config = createConfig({
            providers: [provider('codex-a', { supportedModels: ['gpt-5.6-luna'] })],
            keyData: {
                routingMode: 'fixed',
                fixedCredential: { providerType, uuid: 'codex-a' }
            }
        });
        await initialize(config);

        await expect(getApiServiceWithFallback(config, 'gpt-5.4-mini')).rejects.toMatchObject({
            code: 'MODEL_NOT_SUPPORTED',
            status: 404
        });
    });

    test('group routing never crosses into a configured provider fallback type', async () => {
        writeGroupConfig({
            groups: [{ id: 'group-a', credentialUuids: ['codex-a'] }],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]
        });
        const config = createConfig({
            extra: {
                providerPools: {
                    [providerType]: [provider('codex-a', { isHealthy: false })],
                    'openai-custom': [{
                        uuid: 'openai-fallback',
                        customName: 'fallback',
                        supportedModels: ['gpt-5.4-mini']
                    }]
                },
                providerFallbackChain: {
                    [providerType]: ['openai-custom']
                }
            }
        });
        const manager = await initialize(config);
        const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');

        await expect(getApiServiceWithFallback(config, 'gpt-5.4-mini')).rejects.toMatchObject({
            status: 503,
            code: 'PROVIDER_CREDENTIALS_UNAVAILABLE'
        });
        expect(selectSpy).toHaveBeenCalledTimes(1);
        expect(selectSpy.mock.calls[0]).toEqual(expect.arrayContaining([providerType, 'gpt-5.4-mini']));
        expect(selectSpy.mock.calls[0][2]).toMatchObject({ disableProviderFallback: true });
    });

    test('enforces Key concurrency for auto routing when the Key declares a limit', async () => {
        writeGroupConfig({
            groups: [{ id: 'group-a', credentialUuids: ['codex-a'] }],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]
        });
        const config = createConfig({
            providers: [provider('codex-a')],
            keyData: {
                routingMode: 'auto',
                concurrencyLimit: 1,
                queueLimit: 0,
                concurrencyMode: 'enforce'
            }
        });
        await initialize(config);

        const first = await getApiServiceWithFallback(config, 'gpt-5.4-mini', { acquireSlot: true });
        expect(first).toBeTruthy();

        await expect(
            getApiServiceWithFallback(config, 'gpt-5.4-mini', { acquireSlot: true })
        ).rejects.toMatchObject({ details: expect.objectContaining({ reason: 'key_capacity_exhausted' }) });
    });

    test('leaves auto routing unlimited when the Key declares no concurrency limit', async () => {
        writeGroupConfig({
            groups: [{ id: 'group-a', credentialUuids: ['codex-a'] }],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]
        });
        const config = createConfig({
            providers: [provider('codex-a')],
            keyData: { routingMode: 'auto', concurrencyMode: 'enforce' }
        });
        await initialize(config);

        await expect(getApiServiceWithFallback(config, 'gpt-5.4-mini', { acquireSlot: true })).resolves.toBeTruthy();
        await expect(getApiServiceWithFallback(config, 'gpt-5.4-mini', { acquireSlot: true })).resolves.toBeTruthy();
    });
});
