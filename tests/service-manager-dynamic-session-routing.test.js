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
    getApiServiceWithFallback,
    getProviderPoolManager,
    initApiService
} from '../src/services/service-manager.js';
import { codexCredentialGroupAffinityStore } from '../src/providers/openai/codex-credential-group-affinity.js';

const providerType = 'openai-codex-oauth';
const MODEL = 'gpt-6-sol';
const FLAG_KEYS = ['CODEX_DYNAMIC_SESSION_ROUTING_ENABLED', 'CODEX_DYNAMIC_SESSION_ROUTING_KEY_IDS'];
let tempDir;
let groupFilePath;

function provider(uuid, overrides = {}) {
    return {
        uuid,
        customName: uuid,
        codexAccountKey: `account-${uuid}`,
        lastKnownCodexPlan: 'pro',
        supportedModels: ['gpt-6-sol', 'gpt-6-luna'],
        ...overrides
    };
}

function writeAssignments(keyAssignments) {
    fs.writeFileSync(groupFilePath, JSON.stringify({
        version: 1,
        currentRevision: 1,
        revisions: [{
            revision: 1,
            action: 'apply',
            previousRevision: null,
            config: {
                groups: [
                    { id: 'group-a', credentialUuids: ['codex-a'] },
                    { id: 'group-b', credentialUuids: ['codex-b', 'codex-c', 'codex-d'] }
                ],
                keyAssignments
            }
        }]
    }), 'utf8');
}

function allProviders() {
    return ['codex-a', 'codex-b', 'codex-c', 'codex-d'].map(uuid => provider(uuid));
}

function createConfig({
    providers = allProviders(),
    keyId = 'key-1',
    routingMode = 'auto',
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
            id: keyId,
            name: keyId,
            routingMode,
            primaryGroupId: routingMode === 'auto' ? 'group-a' : null,
            fixedCredential: null,
            manualLock: false
        },
        _codexCacheAffinityScope: sessionId ? { sessionId } : {},
        _codexOverloadFailoverKey: sessionId ? `session:${sessionId}` : null,
        providerPools: { [providerType]: providers },
        ...extra
    };
}

async function initialize(config) {
    await initApiService(config, false, { persistenceEnabled: false });
    return getProviderPoolManager();
}

// A follow-up request that shares the provider pool (and so health/load state) with `base`.
function nextRequest(base, sessionId) {
    const extra = {};
    for (const key of FLAG_KEYS) if (key in base) extra[key] = base[key];
    return createConfig({
        providers: base.providerPools[providerType],
        keyId: base.potluckKeyData.id,
        routingMode: base.potluckKeyData.routingMode,
        sessionId,
        extra
    });
}

function setHealthy(manager, uuid, isHealthy) {
    manager.providerStatus[providerType].find(p => p.uuid === uuid).config.isHealthy = isHealthy;
}

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-dynamic-routing-'));
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

describe('Codex dynamic session routing (gray switch)', () => {
    const on = { CODEX_DYNAMIC_SESSION_ROUTING_ENABLED: true };

    describe('switch gating', () => {
        test('is off by default: an auto key still walks its groups in order', async () => {
            writeAssignments([{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]);
            const config = createConfig();
            const manager = await initialize(config);
            const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');

            const result = await getApiServiceWithFallback(config, MODEL);

            expect(result.uuid).toBe('codex-a');
            expect(selectSpy.mock.calls[0][2].allowedProviderUuids).toEqual(['codex-a']);
            expect(config._codexRouting.selectedGroupId).toBe('group-a');
        });

        test('enabled with an empty allow-list applies to every auto key', async () => {
            writeAssignments([{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]);
            const config = createConfig({ extra: on });
            const manager = await initialize(config);
            const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');

            await getApiServiceWithFallback(config, MODEL);

            expect(selectSpy).toHaveBeenCalledTimes(1);
            expect(selectSpy.mock.calls[0][2].allowedProviderUuids).toBeUndefined();
            expect(config._codexRouting.selectedGroupId).toBeNull();
        });

        test.each([
            ['array', ['key-1', 'key-9']],
            ['comma string', 'key-9, key-1']
        ])('enabled with an allow-list (%s) applies only to listed keys', async (_label, ids) => {
            writeAssignments([
                { keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' },
                { keyId: 'key-2', routingMode: 'auto', primaryGroupId: 'group-a' }
            ]);
            const flags = { ...on, CODEX_DYNAMIC_SESSION_ROUTING_KEY_IDS: ids };
            const listed = createConfig({ keyId: 'key-1', extra: flags });
            const manager = await initialize(listed);
            const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');

            await getApiServiceWithFallback(listed, MODEL);
            expect(selectSpy.mock.calls[0][2].allowedProviderUuids).toBeUndefined();
            expect(listed._codexRouting.selectedGroupId).toBeNull();

            selectSpy.mockClear();
            const unlisted = createConfig({
                providers: listed.providerPools[providerType],
                keyId: 'key-2',
                sessionId: 'session-z',
                extra: flags
            });
            await getApiServiceWithFallback(unlisted, MODEL);
            expect(selectSpy.mock.calls[0][2].allowedProviderUuids).toEqual(['codex-a']);
            expect(unlisted._codexRouting.selectedGroupId).toBe('group-a');
        });

        test('the allow-list alone does nothing while the master switch is off', async () => {
            writeAssignments([{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]);
            const config = createConfig({ extra: { CODEX_DYNAMIC_SESSION_ROUTING_KEY_IDS: ['key-1'] } });
            const manager = await initialize(config);
            const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');

            await getApiServiceWithFallback(config, MODEL);

            expect(selectSpy.mock.calls[0][2].allowedProviderUuids).toEqual(['codex-a']);
        });

        test('never changes fixed keys even when enabled', async () => {
            const fixedCredential = { providerType, uuid: 'codex-c' };
            writeAssignments([{ keyId: 'key-1', routingMode: 'fixed', fixedCredential }]);
            const config = createConfig({ routingMode: 'fixed', extra: on });
            config.potluckKeyData.fixedCredential = fixedCredential;
            await initialize(config);

            const result = await getApiServiceWithFallback(config, MODEL);

            expect(result.uuid).toBe('codex-c');
            expect(config._codexRouting.routingMode).toBe('fixed');
        });

        test('never changes restricted keys even when enabled', async () => {
            const restrictedCredentialUuids = ['codex-c', 'codex-d'];
            writeAssignments([{ keyId: 'key-1', routingMode: 'restricted', restrictedCredentialUuids }]);
            const config = createConfig({ routingMode: 'restricted', extra: on });
            config.potluckKeyData.restrictedCredentialUuids = restrictedCredentialUuids;
            await initialize(config);

            for (let i = 0; i < 8; i += 1) {
                const result = await getApiServiceWithFallback(nextRequest(config, `r-${i}`), MODEL);
                expect(restrictedCredentialUuids).toContain(result.uuid);
            }
        });
    });

    describe('candidate set and diagnostics', () => {
        test('ignores group membership and can pick a credential outside the primary group', async () => {
            writeAssignments([{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]);
            const config = createConfig({ extra: on });
            const manager = await initialize(config);
            setHealthy(manager, 'codex-a', false);

            const result = await getApiServiceWithFallback(config, MODEL);

            expect(['codex-b', 'codex-c', 'codex-d']).toContain(result.uuid);
            expect(config._codexRouting).toMatchObject({
                selectedGroupId: null,
                selectedProviderUuid: result.uuid,
                spillover: false
            });
            expect(config._codexRouteResult).toMatchObject({
                selectedProviderUuid: result.uuid,
                providerSwitchCount: 0,
                consistencyStatus: 'consistent'
            });
        });

        test('does not touch the in-process group affinity store', async () => {
            writeAssignments([{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]);
            const config = createConfig({ extra: on });
            await initialize(config);
            const pinSpy = jest.spyOn(codexCredentialGroupAffinityStore, 'pinGroup');

            await getApiServiceWithFallback(config, MODEL);

            expect(pinSpy).not.toHaveBeenCalled();
        });

        test('honours the credential-level notSupportedModels exclusion', async () => {
            writeAssignments([{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]);
            const providers = allProviders().map(p =>
                p.uuid === 'codex-b' ? { ...p, notSupportedModels: [MODEL] } : p);
            const config = createConfig({ providers, extra: on });
            await initialize(config);

            const seen = new Set();
            for (let i = 0; i < 12; i += 1) {
                seen.add((await getApiServiceWithFallback(nextRequest(config, `s-${i}`), MODEL)).uuid);
            }

            expect(seen.has('codex-b')).toBe(false);
        });
    });

    describe('session stickiness and spreading', () => {
        test('passes a session sticky key to the pool selector for auto keys', async () => {
            writeAssignments([{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]);
            const config = createConfig({ extra: on });
            const manager = await initialize(config);
            const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');

            await getApiServiceWithFallback(config, MODEL);

            expect(selectSpy.mock.calls[0][2].stickyProviderKey).toEqual(expect.any(String));
            expect(config._codexRouting.affinitySource).toBe('session_id');
        });

        test('pool keys get the same sticky key only when the switch is on', async () => {
            writeAssignments([{ keyId: 'key-1', routingMode: 'pool', primaryGroupId: null }]);

            const off = createConfig({ routingMode: 'pool' });
            const manager = await initialize(off);
            const selectSpy = jest.spyOn(manager, 'selectProviderWithFallback');
            await getApiServiceWithFallback(off, MODEL);
            expect(selectSpy.mock.calls[0][2].stickyProviderKey).toBeUndefined();

            selectSpy.mockClear();
            const enabled = createConfig({
                providers: off.providerPools[providerType],
                routingMode: 'pool',
                sessionId: 'session-on',
                extra: on
            });
            await getApiServiceWithFallback(enabled, MODEL);
            expect(selectSpy.mock.calls[0][2].stickyProviderKey).toEqual(expect.any(String));
        });

        test('keeps one session on one credential across requests', async () => {
            writeAssignments([{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]);
            const base = createConfig({ sessionId: 'long-session', extra: on });
            await initialize(base);

            const picked = [];
            for (let i = 0; i < 6; i += 1) {
                picked.push((await getApiServiceWithFallback(nextRequest(base, 'long-session'), MODEL)).uuid);
            }

            expect(new Set(picked).size).toBe(1);
        });

        test('spreads distinct new sessions over every healthy credential', async () => {
            writeAssignments([{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]);
            const base = createConfig({ extra: on });
            await initialize(base);

            const counts = {};
            for (let i = 0; i < 24; i += 1) {
                const res = await getApiServiceWithFallback(nextRequest(base, `new-session-${i}`), MODEL);
                counts[res.uuid] = (counts[res.uuid] || 0) + 1;
            }

            expect(Object.keys(counts).sort()).toEqual(['codex-a', 'codex-b', 'codex-c', 'codex-d']);
            expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(12);
        });

        test('moves a session to another credential once its bound credential is unhealthy', async () => {
            writeAssignments([{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]);
            const base = createConfig({ sessionId: 'sticky-failover', extra: on });
            const manager = await initialize(base);

            const first = await getApiServiceWithFallback(nextRequest(base, 'sticky-failover'), MODEL);
            setHealthy(manager, first.uuid, false);
            const second = await getApiServiceWithFallback(nextRequest(base, 'sticky-failover'), MODEL);

            expect(second.uuid).not.toBe(first.uuid);
        });

        test('never routes to unhealthy credentials', async () => {
            writeAssignments([{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-a' }]);
            const base = createConfig({ extra: on });
            const manager = await initialize(base);
            setHealthy(manager, 'codex-a', false);
            setHealthy(manager, 'codex-b', false);

            const seen = new Set();
            for (let i = 0; i < 10; i += 1) {
                seen.add((await getApiServiceWithFallback(nextRequest(base, `h-${i}`), MODEL)).uuid);
            }

            expect([...seen].sort()).toEqual(['codex-c', 'codex-d']);
        });
    });
});
