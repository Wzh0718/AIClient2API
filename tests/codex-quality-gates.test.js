import { afterEach, describe, expect, jest, test } from '@jest/globals';
import axios from 'axios';
import { Readable } from 'stream';
import { CodexApiService } from '../src/providers/openai/codex-core.js';
import { CODEX_FINGERPRINT_CONTEXT_KEY } from '../src/providers/openai/codex-fingerprint.js';
import { extractInboundCodexFingerprintContext } from '../src/utils/common.js';
// [turn-state-disabled 2026-09-23] 缓存复用停用；恢复功能时取消本导入与下方注释用例的注释
// import {
//     CodexTurnStateCache,
//     codexTurnStateCache,
//     handleCodexTurnStateIpcMessage,
//     normalizeCodexTurnState,
//     resolveCodexTurnStateForRequest
// } from '../src/providers/openai/codex-turn-state.js';
import {
    CodexPromptCacheObservability,
    codexPromptCacheObservability
} from '../src/providers/openai/codex-prompt-cache-observability.js';
import { postCodexOAuthRefreshRequest } from '../src/auth/codex-oauth.js';
import { getRequestAttempts } from '../src/utils/request-attempts.js';

jest.mock('axios', () => ({
    request: jest.fn(),
    create: jest.fn()
}));

jest.mock('open', () => ({
    __esModule: true,
    default: jest.fn()
}));

jest.mock('../src/services/ui-manager.js', () => ({
    broadcastEvent: jest.fn()
}));

jest.mock('../src/core/config-manager.js', () => ({
    CONFIG: {}
}));

jest.mock('../src/auth/oauth-handlers.js', () => ({
    refreshCodexTokensWithRetry: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
    autoLinkProviderConfigs: jest.fn(),
    replaceProviderCredentialPath: jest.fn()
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(config => config),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
    getProxyConfigForProvider: jest.fn(() => null),
    configureAxiosProxy: jest.fn(config => config),
    parseProxyUrl: jest.fn(() => null)
}));

function createService(overrides = {}) {
    const service = new CodexApiService({
        MODEL_PROVIDER: 'openai-codex-oauth',
        uuid: 'provider-secret-uuid',
        codexAccountKey: 'stable-account-key',
        CODEX_FINGERPRINT_ENABLED: false,
        ...overrides
    });
    service.isInitialized = true;
    service.accessToken = 'access-token-secret';
    service.accountId = 'account-id';
    service.expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    return service;
}

function getHeader(headers, expectedName) {
    const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === expectedName.toLowerCase());
    return entry?.[1];
}

afterEach(() => {
    jest.restoreAllMocks();
    axios.request.mockReset();
});

describe('Codex proxy quality gates', () => {
    test.each([
        ['session-id', 'dash-session'],
        ['session_id', 'underscore-session'],
        ['Session_id', 'legacy-session'],
        ['Session-Id', 'canonical-session']
    ])('accepts inbound %s but emits only canonical Session-Id', (inputName, inputValue) => {
        const service = createService();

        try {
            const headers = service.buildHeaders('cache-session', false, {
                inboundHeaders: { [inputName]: inputValue },
                ids: null
            });
            const sessionHeaders = Object.entries(headers)
                .filter(([name]) => ['session-id', 'session_id'].includes(name.toLowerCase()));

            expect(sessionHeaders).toEqual([['Session-Id', inputValue]]);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('does not forward the client Responses Lite marker to upstream', () => {
        const service = createService();

        try {
            const present = service.buildHeaders(null, false, {
                inboundHeaders: { 'x-openai-internal-codex-responses-lite': 'true' },
                ids: null
            });

            expect(getHeader(present, 'X-Openai-Internal-Codex-Responses-Lite')).toBeUndefined();
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('treats Responses Lite requests as ordinary Responses calls', async () => {
        const service = createService();
        const completedEvent = 'data: {"type":"response.completed","response":{"id":"r1","status":"completed","model":"gpt-5.6-luna","output":[]}}\n\n';
        const makeStream = () => (async function* () {
            yield Buffer.from(completedEvent);
        })();
        const makeRequest = (overrides = {}) => ({
            model: 'gpt-5.6-luna',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
            ...overrides,
            [CODEX_FINGERPRINT_CONTEXT_KEY]: {
                inboundCodexHeaders: { 'x-openai-internal-codex-responses-lite': 'true' }
            }
        });
        axios.request
            .mockResolvedValueOnce({ status: 200, headers: {}, data: completedEvent })
            .mockResolvedValueOnce({ status: 200, headers: {}, data: makeStream() });

        try {
            await service.generateContent('gpt-5.6-luna', makeRequest());
            for await (const _event of service.generateContentStream('gpt-5.6-luna', makeRequest({
                parallel_tool_calls: true,
                reasoning: {
                    effort: 'high',
                    summary: 'detailed',
                    context: 'current_turn',
                    custom: 'preserve-me'
                }
            }))) {
                // Consume the stream to exercise the request path.
            }

            const [nonStreamingConfig, streamingConfig] = axios.request.mock.calls.map(([config]) => config);
            expect(getHeader(nonStreamingConfig.headers, 'x-openai-internal-codex-responses-lite')).toBeUndefined();
            expect(getHeader(streamingConfig.headers, 'x-openai-internal-codex-responses-lite')).toBeUndefined();
            expect(nonStreamingConfig.data.reasoning.context).toBeUndefined();
            expect(nonStreamingConfig.data.parallel_tool_calls).toBe(true);
            expect(streamingConfig.data.reasoning).toMatchObject({
                effort: 'high',
                summary: 'detailed',
                context: 'current_turn',
                custom: 'preserve-me'
            });
            expect(streamingConfig.data.parallel_tool_calls).toBe(true);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('leaves ordinary Responses request context and parallel tool setting unchanged', async () => {
        const service = createService();

        try {
            const prepared = await service.prepareRequestBody('gpt-5.6-luna', {
                input: [{ role: 'user', content: 'hello' }],
                parallel_tool_calls: true,
                reasoning: { effort: 'high', summary: 'detailed', context: 'current_turn' }
            }, true);

            expect(prepared.parallel_tool_calls).toBe(true);
            expect(prepared.reasoning).toMatchObject({
                effort: 'high',
                summary: 'detailed',
                context: 'current_turn'
            });
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('captures the allowlisted Codex routing headers before provider selection', () => {
        const context = extractInboundCodexFingerprintContext({
            headers: {
                'x-codex-window-id': 'window-private',
                'thread-id': 'thread-private',
                'x-openai-internal-codex-responses-lite': 'true',
                'x-codex-turn-state': 'opaque-state',
                'x-unrelated-private-header': 'must-not-pass'
            }
        }, {});

        expect(context.inboundCodexHeaders).toEqual({
            'x-codex-window-id': 'window-private',
            'thread-id': 'thread-private',
            'x-codex-turn-state': 'opaque-state'
        });
        expect(context.inboundCodexHeaders['x-unrelated-private-header']).toBeUndefined();
    });

    test('relays client x-codex-turn-state upstream and upstream values downstream without reuse', () => {
        const service = createService();
        const ticket = `g${'A'.repeat(291)}`;
        const context = {
            inboundCodexHeaders: { 'x-codex-turn-state': 'client-state' },
            callerKeyHash: 'key-a', originalClientSessionId: 'session-a', originalTurnId: 'turn-a'
        };

        try {
            // 客户端自带的 x-codex-turn-state 原样透传上游
            const forwarded = service.buildHeaders(null, false, { inboundHeaders: {}, context, ids: null }, 'gpt-5.5');
            expect(getHeader(forwarded, 'x-codex-turn-state')).toBe('client-state');

            // 客户端未带头时不注入任何缓存值（复用已停用）
            const noClient = service.buildHeaders(null, false, {
                inboundHeaders: {}, context: { ...context, inboundCodexHeaders: {} }, ids: null
            }, 'gpt-5.5');
            expect(getHeader(noClient, 'x-codex-turn-state')).toBeUndefined();

            // 上游响应头照常观察并进入 downstreamCodexTurnState 供下游回写
            const state = { inboundHeaders: {}, context: { ...context, inboundCodexHeaders: {} }, ids: null };
            const observed = service.observeTurnStateFromResponse({ 'x-codex-turn-state': ticket }, state);
            expect(observed).toMatchObject({ observed: true, reusable: true, length: 292 });
            expect(state.context.downstreamCodexTurnState).toBe(ticket);
        } finally {
            service.stopCacheCleanup();
        }
    });

    // [turn-state-disabled 2026-09-23] 以下缓存复用用例停用，整体注释保留：

    // test('reuses turn state only inside the same credential model session and turn scope', () => {
    //     let now = 1_000;
    //     const cache = new CodexTurnStateCache({ now: () => now, idleTtlMs: 5_000, maxEntries: 2 });
    //     const config = { codexTurnStateReuseEnabled: true, uuid: 'credential-a', providerConfigRevision: 7 };
    //     const context = {
    //         callerKeyHash: 'key-a', originalClientSessionId: 'session-a', originalTurnId: 'turn-a', inboundCodexHeaders: {}
    //     };
    //     const first = resolveCodexTurnStateForRequest({ config, context, model: 'gpt-5.5', cache });
    //     expect(first).toMatchObject({ source: 'none', skipReason: 'cache_miss' });
    //     const reusableState = 'x'.repeat(292);
    //     expect(cache.capture(first.scope, reusableState)).toBe(true);
    //     expect(resolveCodexTurnStateForRequest({ config, context, model: 'gpt-5.5', cache })).toMatchObject({
    //         value: reusableState, source: 'cache'
    //     });
    //     expect(resolveCodexTurnStateForRequest({
    //         config,
    //         context: { ...context, originalTurnId: 'turn-b' },
    //         model: 'gpt-5.5',
    //         cache
    //     }).value).toBeNull();
    //     expect(resolveCodexTurnStateForRequest({ config, context, model: 'gpt-5.6-sol', cache }).value).toBeNull();
    //     now += 5_001;
    //     expect(resolveCodexTurnStateForRequest({ config, context, model: 'gpt-5.5', cache }).value).toBeNull();
    // });

    // test('client turn state wins while invalid or oversized values are rejected', () => {
    //     const cache = new CodexTurnStateCache();
    //     const config = { codexTurnStateReuseEnabled: true, uuid: 'credential-a' };
    //     const context = {
    //         callerKeyHash: 'key-a', originalClientSessionId: 'session-a', originalTurnId: 'turn-a',
    //         inboundCodexHeaders: { 'x-codex-turn-state': 'client-state' }
    //     };
    //     const result = resolveCodexTurnStateForRequest({ config, context, model: 'gpt-5.5', cache });
    //     cache.capture(result.scope, 'x'.repeat(292));
    //     expect(result).toMatchObject({ value: 'client-state', source: 'client' });
    //     expect(normalizeCodexTurnState('bad\r\nheader')).toBeNull();
    //     expect(normalizeCodexTurnState('x'.repeat(8193))).toBeNull();
    // });

    // test('returns any upstream turn state downstream but caches only successful 292-byte tickets', () => {
    //     const service = createService({ codexTurnStateReuseEnabled: true });
    //     const context = {
    //         inboundCodexHeaders: {}, callerKeyHash: 'key-a', originalClientSessionId: 'session-a', originalTurnId: 'turn-a'
    //     };
    //     const state = { inboundHeaders: {}, context, ids: null };
    //     try {
    //         service.buildHeaders(null, false, state, 'gpt-5.5');
    //         const observed = service.observeTurnStateFromResponse({ 'x-codex-turn-state': 'short-opaque-state' }, state);
    //         expect(observed).toMatchObject({ observed: true, reusable: false, length: 18 });
    //         expect(context.downstreamCodexTurnState).toBe('short-opaque-state');
    //         expect(service.captureObservedTurnState(state, 'gpt-5.5')).toMatchObject({ captured: false, reason: 'length_mismatch' });
    //         expect(getHeader(service.buildHeaders(null, false, { inboundHeaders: {}, context: { ...context, downstreamCodexTurnState: null }, ids: null }, 'gpt-5.5'), 'x-codex-turn-state')).toBeUndefined();

    //         const ticket = `g${'A'.repeat(291)}`;
    //         expect(service.observeTurnStateFromResponse({ 'x-codex-turn-state': ticket }, state)).toMatchObject({ reusable: true, length: 292 });
    //         expect(service.captureObservedTurnState(state, 'gpt-5.5')).toMatchObject({ captured: true, length: 292 });
    //         const next = service.buildHeaders(null, false, { inboundHeaders: {}, context, ids: null }, 'gpt-5.5');
    //         expect(getHeader(next, 'x-codex-turn-state')).toBe(ticket);
    //     } finally {
    //         service.stopCacheCleanup();
    //     }
    // });

    // test('adds a 292-byte ticket to the next request only after a completed upstream response', async () => {
    //     codexTurnStateCache.clear();
    //     const ticket = `g${'A'.repeat(291)}`;
    //     const service = createService({ codexTurnStateReuseEnabled: true, uuid: 'success-ticket-provider', codexAccountKey: 'success-ticket-account' });
    //     const makeRequest = () => ({
    //         model: 'gpt-5.4-mini',
    //         input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    //         [CODEX_FINGERPRINT_CONTEXT_KEY]: {
    //             inboundCodexHeaders: {}, callerKeyHash: 'key-success',
    //             originalClientSessionId: 'session-success', originalTurnId: 'turn-success'
    //         }
    //     });
    //     axios.request
    //         .mockResolvedValueOnce({ status: 200, headers: { 'x-codex-turn-state': ticket }, data: 'data: {"type":"response.completed","response":{"id":"r1","status":"completed","model":"gpt-5.4-mini","output":[]}}\n\n' })
    //         .mockResolvedValueOnce({ status: 200, headers: {}, data: 'data: {"type":"response.completed","response":{"id":"r2","status":"completed","model":"gpt-5.4-mini","output":[]}}\n\n' });
    //     try {
    //         await service.generateContent('gpt-5.4-mini', makeRequest());
    //         await service.generateContent('gpt-5.4-mini', makeRequest());
    //         expect(getHeader(axios.request.mock.calls[0][0].headers, 'x-codex-turn-state')).toBeUndefined();
    //         expect(getHeader(axios.request.mock.calls[1][0].headers, 'x-codex-turn-state')).toBe(ticket);
    //     } finally {
    //         service.stopCacheCleanup();
    //         codexTurnStateCache.clear();
    //     }
    // });

    // test('does not cache a 292-byte header when the upstream body ends in an error', async () => {
    //     codexTurnStateCache.clear();
    //     const ticket = `g${'B'.repeat(291)}`;
    //     const service = createService({
    //         codexTurnStateReuseEnabled: true,
    //         uuid: 'failed-ticket-provider',
    //         codexAccountKey: 'failed-ticket-account',
    //         CODEX_OVERLOAD_RETRY_MAX_ATTEMPTS: 0
    //     });
    //     const context = {
    //         inboundCodexHeaders: {}, callerKeyHash: 'key-failed',
    //         originalClientSessionId: 'session-failed', originalTurnId: 'turn-failed'
    //     };
    //     axios.request.mockResolvedValueOnce({
    //         status: 200,
    //         headers: { 'x-codex-turn-state': ticket },
    //         data: 'data: {"type":"error","error":{"code":"server_error","message":"failed"}}\n\n'
    //     });
    //     try {
    //         await expect(service.generateContent('gpt-5.4-mini', {
    //             model: 'gpt-5.4-mini', input: [], [CODEX_FINGERPRINT_CONTEXT_KEY]: context
    //         })).rejects.toBeTruthy();
    //         const headers = service.buildHeaders(null, false, { inboundHeaders: {}, context, ids: null }, 'gpt-5.4-mini');
    //         expect(getHeader(headers, 'x-codex-turn-state')).toBeUndefined();
    //     } finally {
    //         service.stopCacheCleanup();
    //         codexTurnStateCache.clear();
    //     }
    // });

    test('uses configured Codex identity headers before client values and defaults', () => {
        const service = createService({
            CODEX_VERSION: '9.9.9', CODEX_USER_AGENT: 'configured-agent', CODEX_ORIGINATOR: 'configured-origin', CODEX_BETA_FEATURES: 'configured-beta'
        });
        try {
            const headers = service.buildHeaders(null, false, {
                inboundHeaders: { version: '1.2.3', 'user-agent': 'client-agent', originator: 'client-origin', 'x-codex-beta-features': 'client-beta' },
                context: {}, ids: null
            }, 'gpt-5.5');
            expect(getHeader(headers, 'version')).toBe('9.9.9');
            expect(getHeader(headers, 'user-agent')).toBe('configured-agent');
            expect(getHeader(headers, 'originator')).toBe('configured-origin');
            expect(getHeader(headers, 'x-codex-beta-features')).toBe('configured-beta');
        } finally {
            service.stopCacheCleanup();
        }
    });

    // [turn-state-disabled 2026-09-23] test('shares opaque turn state through the bounded master IPC cache without logging it', () => {
    //     codexTurnStateCache.clear();
    //     try {
    //         const ticket = `g${'A'.repeat(291)}`;
    //         expect(handleCodexTurnStateIpcMessage({
    //             type: 'codex_turn_state_request', action: 'capture', payload: { scope: 'scope-a', value: ticket }
    //         })).toEqual({ captured: true });
    //         expect(handleCodexTurnStateIpcMessage({
    //             type: 'codex_turn_state_request', action: 'get', payload: { scope: 'scope-a' }
    //         })).toEqual({ value: ticket });
    //     } finally {
    //         codexTurnStateCache.clear();
    //     }
    // });

    test('preserves prompt_cache_options byte-for-byte through Codex body preparation', async () => {
        const service = createService();
        const promptCacheOptions = { retention: '24h', nested: { mode: 'private-value' } };

        try {
            const prepared = await service.prepareRequestBody('gpt-5.6-luna', {
                input: [{ role: 'user', content: 'secret prompt' }],
                prompt_cache_options: promptCacheOptions
            }, true);

            expect(prepared.prompt_cache_options).toBe(promptCacheOptions);
            expect(prepared.prompt_cache_options).toEqual(promptCacheOptions);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('records only sanitized prompt_cache_options presence and upstream 400 statistics', () => {
        const logger = { info: jest.fn(), warn: jest.fn() };
        const metrics = new CodexPromptCacheObservability({ logger });
        const options = {
            retention: 'private-retention-value',
            nested: { prompt: 'private-prompt', email: 'user@example.com', token: 'token-secret' }
        };

        metrics.recordPresence({
            providerType: 'openai-codex-oauth',
            providerUuid: 'provider-secret-uuid',
            promptCacheOptions: options
        });
        metrics.recordUpstreamError({
            providerType: 'openai-codex-oauth',
            providerUuid: 'provider-secret-uuid',
            promptCacheOptions: options,
            httpStatus: 400,
            errorClass: 'invalid_request_error'
        });

        const snapshot = metrics.snapshot();
        const output = JSON.stringify(logger.info.mock.calls) + JSON.stringify(logger.warn.mock.calls) + JSON.stringify(snapshot);
        expect(snapshot).toMatchObject({
            present: 1,
            upstream400: 1,
            byProviderType: { 'openai-codex-oauth': { present: 1, upstream400: 1 } }
        });
        expect(output).toContain('shapeHash');
        expect(output).not.toContain('private-retention-value');
        expect(output).not.toContain('private-prompt');
        expect(output).not.toContain('user@example.com');
        expect(output).not.toContain('token-secret');
        expect(output).not.toContain('provider-secret-uuid');
    });

    test('does not observe prompt_cache_options for non-Codex OAuth providers', () => {
        const logger = { info: jest.fn(), warn: jest.fn() };
        const metrics = new CodexPromptCacheObservability({ logger });

        expect(metrics.recordPresence({
            providerType: 'openai-api-key',
            promptCacheOptions: { retention: 'private-value' }
        })).toBeNull();
        expect(metrics.snapshot()).toEqual({ present: 0, upstream400: 0, byProviderType: {} });
        expect(logger.info).not.toHaveBeenCalled();
    });

    test('associates an upstream 400 with prompt_cache_options without modifying the request', async () => {
        axios.request.mockRejectedValueOnce({
            response: { status: 400, data: { error: { type: 'invalid_request_error', message: 'bad request' } } },
            message: 'bad request'
        });
        const presenceSpy = jest.spyOn(codexPromptCacheObservability, 'recordPresence');
        const errorSpy = jest.spyOn(codexPromptCacheObservability, 'recordUpstreamError');
        const service = createService();
        const options = { retention: 'private-retention-value' };
        const request = {
            model: 'gpt-5.6-luna',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'secret prompt' }] }],
            prompt_cache_options: options,
            [CODEX_FINGERPRINT_CONTEXT_KEY]: { inboundCodexHeaders: {}, originalClientSessionId: '' }
        };

        try {
            await expect(service.generateContent('gpt-5.6-luna', request)).rejects.toBeTruthy();
            expect(axios.request.mock.calls[0][0].data.prompt_cache_options).toBe(options);
            expect(presenceSpy).toHaveBeenCalledTimes(1);
            expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({
                providerType: 'openai-codex-oauth',
                httpStatus: 400,
                promptCacheOptions: options
            }));
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('captures streamed upstream error details before recording the failed attempt', async () => {
        const upstreamBody = JSON.stringify({
            error: {
                type: 'invalid_request_error',
                code: 'unsupported_parameter',
                param: 'tools[0].type',
                message: 'Responses Lite rejects this hosted tool for private@example.com'
            }
        });
        const upstreamError = Object.assign(new Error('Request failed with status code 400'), {
            code: 'ERR_BAD_REQUEST',
            response: {
                status: 400,
                headers: { 'x-request-id': 'upstream-400' },
                data: Readable.from([upstreamBody])
            }
        });
        axios.request.mockRejectedValueOnce(upstreamError);
        const service = createService();
        const request = {
            model: 'gpt-5.6-luna',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
        };

        try {
            let thrown;
            try {
                for await (const _event of service.generateContentStream('gpt-5.6-luna', request)) {}
            } catch (error) {
                thrown = error;
            }

            expect(thrown).toBe(upstreamError);
            expect(thrown.message).toContain('Responses Lite rejects this hosted tool');
            expect(thrown.message).toContain('private@example.com');
            expect(getRequestAttempts(request)[0]).toMatchObject({
                status: 'error',
                httpStatus: 400,
                errorCode: 'unsupported_parameter',
                errorType: 'invalid_request_error',
                errorMessage: expect.stringContaining('Responses Lite rejects this hosted tool'),
                upstreamRequestId: 'upstream-400'
            });
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('OAuth token requests abort the underlying call after 30 seconds', async () => {
        jest.useFakeTimers();
        try {
            let capturedConfig;
            const httpClient = {
                post: jest.fn((_url, _data, config) => {
                    capturedConfig = config;
                    return new Promise((_resolve, reject) => {
                        config.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {
                            code: 'ERR_CANCELED'
                        })), { once: true });
                    });
                })
            };
            const request = postCodexOAuthRefreshRequest(httpClient, 'https://auth.openai.com/oauth/token', 'body', {
                Accept: 'application/json'
            });

            expect(capturedConfig.timeout).toBe(30000);
            expect(capturedConfig.signal.aborted).toBe(false);
            jest.advanceTimersByTime(30000);
            await expect(request).rejects.toMatchObject({ code: 'ERR_CANCELED' });
            expect(capturedConfig.signal.aborted).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });
});
