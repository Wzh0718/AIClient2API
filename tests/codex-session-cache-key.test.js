import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { CodexApiService } from '../src/providers/openai/codex-core.js';
import { getPluginManager } from '../src/core/plugin-manager.js';
import { getProviderPoolManager } from '../src/services/service-manager.js';

jest.mock('../src/auth/oauth-handlers.js', () => ({
    refreshCodexTokensWithRetry: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(config => config),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
    getProxyConfigForProvider: jest.fn(() => null)
}));

jest.mock('../src/core/plugin-manager.js', () => ({
    getPluginManager: jest.fn(() => ({ executeHook: jest.fn() }))
}));

let consoleSpies = [];

beforeEach(() => {
    jest.clearAllMocks();
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
    getProviderPoolManager.mockReturnValue(null);
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
});

describe('Codex session cache key handling', () => {
    test.each(['会话标识', 'control\r\nvalue', 'x'.repeat(257), 'space key'])('encodes unsafe headers without changing the explicit body cache key: %s', async key => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });
        try {
            const body = await service.prepareRequestBody('gpt-6-sol', { prompt_cache_key: key, input: [] }, false);
            const headers = service.buildHeaders(body.prompt_cache_key, false, { inboundHeaders: { 'session-id': key, 'thread-id': key } });
            expect(body.prompt_cache_key).toBe(key);
            expect(headers.Conversation_id).toMatch(/^aic2a-[a-f0-9]{32}$/);
            expect(headers['Session-Id']).toBe(headers.Conversation_id);
            expect(headers['thread-id']).toBe(headers.Conversation_id);
            expect(service.buildHeaders(key).Conversation_id).toBe(headers.Conversation_id);
        } finally { service.stopCacheCleanup(); }
    });

    test('retains safe ASCII values at the length boundary', () => {
        const service = new CodexApiService({});
        try {
            for (const key of ['a', 'x'.repeat(256)]) {
                const headers = service.buildHeaders(key, true, { inboundHeaders: { session_id: key, 'thread-id': key } });
                expect(headers.Conversation_id).toBe(key);
                expect(headers['Session-Id']).toBe(key);
                expect(headers['thread-id']).toBe(key);
                expect(headers.session_id).toBeUndefined();
            }
        } finally { service.stopCacheCleanup(); }
    });

    test.each(['device', 'full'])('preserves the final fingerprint override order in %s mode', mode => {
        const service = new CodexApiService({});
        const ids = { mode, installationId: 'installation', sessionId: 'account-session', threadId: 'account-thread', windowId: 'window' };
        try {
            const headers = service.buildHeaders('缓存', true, { ids, inboundHeaders: { session_id: '会话', 'thread-id': '线程' } });
            expect(headers.Conversation_id).toBe(service.toSafeCacheHeaderValue('缓存'));
            expect(headers['Session-Id']).toBe(mode === 'device' ? service.toSafeCacheHeaderValue('会话') : ids.sessionId);
            expect(headers['thread-id']).toBe(mode === 'device' ? service.toSafeCacheHeaderValue('线程') : ids.threadId);
            expect(headers['x-codex-installation-id']).toBe(ids.installationId);
        } finally { service.stopCacheCleanup(); }
    });

    test('retains configured and inbound client versions and user agents', () => {
        const configured = new CodexApiService({ CODEX_VERSION: '0.163.0', CODEX_USER_AGENT: 'configured-agent' });
        const inbound = new CodexApiService({});
        const state = { inboundHeaders: { version: '0.164.0', 'user-agent': 'inbound-agent' } };
        try {
            expect(configured.buildHeaders(null, false, state)).toMatchObject({ version: '0.163.0', 'user-agent': 'configured-agent' });
            expect(inbound.buildHeaders(null, false, state)).toMatchObject({ version: '0.164.0', 'user-agent': 'inbound-agent' });
            expect(inbound.buildHeaders(null, false, { inboundHeaders: { version: '0.154.0' } }, 'gpt-6-luna').version).toBe('0.162.0');
        } finally { configured.stopCacheCleanup(); inbound.stopCacheCleanup(); }
    });

    test('uses the upstream Codex client version required for GPT-6 Sol and Luna', () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const headers = service.buildHeaders(null, false);

            expect(headers.version).toBe('0.162.0');
            expect(headers['user-agent']).toContain('codex-tui/0.162.0');
            expect(service.buildUsageHeaders()['user-agent']).toContain('codex-tui/0.162.0');
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('uses Codex CLI client metadata session id when metadata is absent', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const first = await service.prepareRequestBody('gpt-5.5', {
                input: [{ role: 'user', content: 'first' }],
                client_metadata: {
                    session_id: 'codex-cli-session-a'
                }
            }, true);

            const second = await service.prepareRequestBody('gpt-5.5', {
                input: [{ role: 'user', content: 'second' }],
                client_metadata: {
                    session_id: 'codex-cli-session-b'
                }
            }, true);

            expect(first.prompt_cache_key).toBeTruthy();
            expect(second.prompt_cache_key).toBeTruthy();
            expect(first.prompt_cache_key).not.toBe(second.prompt_cache_key);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('uses top-level and inbound Session-Id fingerprint context before template routing', async () => {
        const scopes = [];
        getProviderPoolManager.mockReturnValue({
            coordination: { resolvePromptCacheKey: jest.fn(async scope => { scopes.push(scope); return `shared-${scopes.length}`; }) }
        });
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth', uuid: 'provider-a' });
        try {
            await service.prepareRequestBody('gpt-5.5', {
                session_id: 'top-level-session', input: [{ role: 'user', content: 'one' }]
            }, true);
            await service.prepareRequestBody('gpt-5.5', {
                _codexFingerprintContext: { originalClientSessionId: 'header-session' },
                input: [{ role: 'user', content: 'two' }]
            }, true);

            expect(scopes).toHaveLength(2);
            expect(scopes.every(scope => scope.includes(':session:'))).toBe(true);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('preserves explicit prompt_cache_key from the client request', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-5.5', {
                input: [{ role: 'user', content: 'reuse cache' }],
                prompt_cache_key: 'client-provided-cache-key'
            }, true);

            expect(body.prompt_cache_key).toBe('client-provided-cache-key');
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('shares a session cache key across service instances through runtime coordination', async () => {
        const shared = new Map();
        const coordination = {
            resolvePromptCacheKey: jest.fn(async scope => {
                if (!shared.has(scope)) shared.set(scope, `shared-${shared.size + 1}`);
                return shared.get(scope);
            })
        };
        getProviderPoolManager.mockReturnValue({ coordination });
        const firstService = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth', uuid: 'provider-a' });
        const secondService = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth', uuid: 'provider-a' });
        const thirdService = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth', uuid: 'provider-a' });

        try {
            const request = {
                input: [{ role: 'user', content: 'same conversation' }],
                client_metadata: { session_id: 'session-shared' }
            };
            const first = await firstService.prepareRequestBody('gpt-5.5', request, true);
            const second = await secondService.prepareRequestBody('gpt-5.5', request, true);
            const third = await thirdService.prepareRequestBody('gpt-5.5', request, true);

            expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
            expect(third.prompt_cache_key).toBe(first.prompt_cache_key);
            expect(coordination.resolvePromptCacheKey).toHaveBeenCalledTimes(3);
        } finally {
            firstService.stopCacheCleanup();
            secondService.stopCacheCleanup();
            thirdService.stopCacheCleanup();
        }
    });

    test('shares identical sessionless templates and separates changed instructions, tools, or prefixes', async () => {
        const shared = new Map();
        getProviderPoolManager.mockReturnValue({
            coordination: {
                resolvePromptCacheKey: jest.fn(async scope => {
                    if (!shared.has(scope)) shared.set(scope, `shared-${shared.size + 1}`);
                    return shared.get(scope);
                })
            }
        });
        const firstService = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth', uuid: 'provider-a', potluckApiKey: 'maki-a' });
        const secondService = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth', uuid: 'provider-a', potluckApiKey: 'maki-a' });
        const base = {
            instructions: 'stable instructions',
            tools: [{ type: 'function', name: 'lookup' }],
            input: [{ role: 'user', content: 'stable request prefix' }]
        };

        try {
            const first = await firstService.prepareRequestBody('gpt-5.5', base, true);
            const second = await secondService.prepareRequestBody('gpt-5.5', base, true);
            const changedInstructions = await secondService.prepareRequestBody('gpt-5.5', { ...base, instructions: 'changed' }, true);
            const changedTools = await secondService.prepareRequestBody('gpt-5.5', { ...base, tools: [{ type: 'function', name: 'other' }] }, true);
            const changedPrefix = await secondService.prepareRequestBody('gpt-5.5', { ...base, input: [{ role: 'user', content: 'different prefix' }] }, true);

            expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
            expect(changedInstructions.prompt_cache_key).not.toBe(first.prompt_cache_key);
            expect(changedTools.prompt_cache_key).not.toBe(first.prompt_cache_key);
            expect(changedPrefix.prompt_cache_key).not.toBe(first.prompt_cache_key);
        } finally {
            firstService.stopCacheCleanup();
            secondService.stopCacheCleanup();
        }
    });

    test('falls back locally when shared cache coordination is unavailable', async () => {
        getProviderPoolManager.mockReturnValue({
            coordination: { resolvePromptCacheKey: jest.fn(async () => { throw new Error('redis unavailable'); }) }
        });
        const service = new CodexApiService({
            MODEL_PROVIDER: 'openai-codex-oauth',
            uuid: 'provider-a',
            _monitorRequestId: 'request-degraded'
        });

        try {
            const body = await service.prepareRequestBody('gpt-5.5', {
                input: [{ role: 'user', content: 'fallback request' }],
                client_metadata: { session_id: 'session-fallback' }
            }, true);
            const executeHook = getPluginManager.mock.results.at(-1).value.executeHook;

            expect(body.prompt_cache_key).toBeTruthy();
            expect(executeHook).toHaveBeenCalledWith('onUpstreamRequestPrepared', expect.objectContaining({
                cacheKeySource: 'local_fallback',
                cacheCoordinationStatus: 'degraded'
            }));
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('emits the exact prepared upstream request for execution-local auditing', async () => {
        const service = new CodexApiService({
            MODEL_PROVIDER: 'openai-codex-oauth',
            uuid: 'provider-a',
            potluckApiKey: 'maki_scope',
            _monitorRequestId: 'request-audit-1'
        });

        try {
            const original = {
                input: [{ role: 'user', content: 'audit this prompt' }],
                prompt_cache_key: 'client-key'
            };
            const prepared = await service.prepareRequestBody('gpt-5.5', original, true);
            const executeHook = getPluginManager.mock.results.at(-1).value.executeHook;

            expect(executeHook).toHaveBeenCalledWith('onUpstreamRequestPrepared', expect.objectContaining({
                requestId: 'request-audit-1',
                potluckApiKey: 'maki_scope',
                providerUuid: 'provider-a',
                model: 'gpt-5.5',
                clientPromptCacheKey: 'client-key',
                finalPromptCacheKey: prepared.prompt_cache_key,
                originalRequestBody: original,
                upstreamRequestBody: prepared
            }));
        } finally {
            service.stopCacheCleanup();
        }
    });
});
