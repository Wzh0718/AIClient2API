import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import axios from 'axios';
import { CodexApiService } from '../src/providers/openai/codex-core.js';
import { CODEX_FINGERPRINT_CONTEXT_KEY } from '../src/providers/openai/codex-fingerprint.js';

jest.mock('axios', () => ({
    request: jest.fn()
}));

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

function completedResponse() {
    return {
        data: 'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}\n\n'
    };
}

function createService(overrides = {}) {
    const service = new CodexApiService({
        MODEL_PROVIDER: 'openai-codex-oauth',
        uuid: 'account-a',
        codexAccountKey: 'stable-account-a',
        codexFingerprintMode: 'session',
        CODEX_FINGERPRINT_ENABLED: true,
        CODEX_OVERLOAD_RETRY_DELAY_MS: 0,
        ...overrides
    });
    service.isInitialized = true;
    service.accessToken = 'test-access-token';
    service.accountId = 'test-account-id';
    service.expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    return service;
}

function requestBody(sessionId = 'client-session-a') {
    return {
        model: 'gpt-5.4-mini',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
        client_metadata: {
            session_id: sessionId,
            'x-codex-turn-metadata': JSON.stringify({ session_id: sessionId, sandbox: 'workspace-write' })
        },
        [CODEX_FINGERPRINT_CONTEXT_KEY]: {
            originalClientSessionId: sessionId,
            inboundCodexHeaders: {
                'session-id': sessionId,
                'thread-id': 'client-thread',
                'x-codex-installation-id': 'client-installation',
                'x-codex-turn-metadata': JSON.stringify({ session_id: sessionId, sandbox: 'workspace-write' })
            }
        }
    };
}

beforeEach(() => {
    axios.request.mockReset();
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('Codex OAuth fingerprint request integration', () => {
    test('strips replay-unsafe reasoning item IDs and backfills an empty summary', async () => {
        axios.request.mockResolvedValueOnce(completedResponse());
        const service = createService();
        const body = requestBody();
        body.input = [{
            type: 'reasoning',
            id: 'rs_upstream_only',
            encrypted_content: 'opaque-test-value'
        }];

        try {
            await service.generateContent('gpt-5.4-mini', body);
            expect(axios.request.mock.calls[0][0].data.input[0]).toEqual({
                type: 'reasoning',
                encrypted_content: 'opaque-test-value',
                summary: []
            });
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('retries once after an explicit indexed namespace field rejection', async () => {
        axios.request
            .mockRejectedValueOnce({
                response: {
                    status: 400,
                    data: {
                        error: {
                            code: 'unknown_parameter',
                            param: 'input[0].namespace',
                            message: "Unknown parameter: 'input[0].namespace'."
                        }
                    }
                }
            })
            .mockResolvedValueOnce(completedResponse());
        const service = createService();
        const body = requestBody();
        body.input = [{
            type: 'function_call',
            call_id: 'call_namespace',
            name: 'example_tool',
            namespace: 'example',
            arguments: '{}'
        }];

        try {
            await service.generateContent('gpt-5.4-mini', body);
            expect(axios.request).toHaveBeenCalledTimes(2);
            expect(axios.request.mock.calls[0][0].data.input[0].namespace).toBeUndefined();
            expect(axios.request.mock.calls[1][0].data.input[0].namespace).toBeUndefined();
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('does not retry deterministic 400 errors outside the rejected-field allowlist', async () => {
        axios.request.mockRejectedValueOnce({
            response: {
                status: 400,
                data: {
                    error: {
                        code: 'invalid_request_error',
                        param: 'model',
                        message: 'Invalid model.'
                    }
                }
            }
        });
        const service = createService();

        try {
            await expect(service.generateContent('gpt-5.4-mini', requestBody())).rejects.toBeTruthy();
            expect(axios.request).toHaveBeenCalledTimes(1);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('uses one precomputed ID set for final headers, body, and embedded metadata', async () => {
        axios.request.mockResolvedValueOnce(completedResponse());
        const service = createService();

        try {
            await service.generateContent('gpt-5.4-mini', requestBody());
            const request = axios.request.mock.calls[0][0];
            const embeddedHeader = JSON.parse(request.headers['x-codex-turn-metadata']);
            const embeddedBody = JSON.parse(request.data.client_metadata['x-codex-turn-metadata']);

            expect(request.headers['x-codex-installation-id']).toBe(request.data.client_metadata['x-codex-installation-id']);
            expect(request.headers['Session-Id']).toBe(request.data.client_metadata.session_id);
            expect(request.headers['session-id']).toBeUndefined();
            expect(request.headers.session_id).toBeUndefined();
            expect(request.headers['thread-id']).toBe(request.data.client_metadata.thread_id);
            expect(embeddedHeader.turn_id).toBe(request.data.client_metadata.turn_id);
            expect(embeddedBody.turn_id).toBe(request.data.client_metadata.turn_id);
            expect(embeddedHeader.thread_id).toBe(request.headers['thread-id']);
            expect(embeddedBody.window_id).toBe(request.headers['x-codex-window-id']);
            expect(request.data[CODEX_FINGERPRINT_CONTEXT_KEY]).toBeUndefined();
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('reuses the same turn ID for a same-credential overload retry', async () => {
        axios.request
            .mockResolvedValueOnce({
                data: 'data: {"type":"error","error":{"code":"server_is_overloaded","message":"busy"}}\n\n'
            })
            .mockResolvedValueOnce(completedResponse());
        const service = createService();

        try {
            await service.generateContent('gpt-5.4-mini', requestBody());
            expect(axios.request).toHaveBeenCalledTimes(2);
            expect(axios.request.mock.calls[0][0].data.client_metadata.turn_id)
                .toBe(axios.request.mock.calls[1][0].data.client_metadata.turn_id);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('global emergency off preserves inbound identity fields', async () => {
        axios.request.mockResolvedValueOnce(completedResponse());
        const service = createService({ CODEX_FINGERPRINT_ENABLED: false });
        const body = requestBody('original-session');

        try {
            await service.generateContent('gpt-5.4-mini', body);
            const request = axios.request.mock.calls[0][0];
            expect(request.headers['Session-Id']).toBe('original-session');
            expect(request.headers['session-id']).toBeUndefined();
            expect(request.headers['thread-id']).toBe('client-thread');
            expect(request.headers['x-codex-installation-id']).toBe('client-installation');
            expect(request.data.client_metadata.session_id).toBe('original-session');
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('global emergency off preserves the underscore session header over the prompt cache header', async () => {
        axios.request.mockResolvedValueOnce(completedResponse());
        const service = createService({ CODEX_FINGERPRINT_ENABLED: false });
        const body = requestBody('original-session');
        body[CODEX_FINGERPRINT_CONTEXT_KEY].inboundCodexHeaders = {
            session_id: 'underscore-session'
        };

        try {
            await service.generateContent('gpt-5.4-mini', body);
            const headers = axios.request.mock.calls[0][0].headers;
            expect(headers['Session-Id']).toBe('underscore-session');
            expect(headers.session_id).toBeUndefined();
            expect(headers.Session_id).toBeUndefined();
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('switching provider changes account IDs while retaining the original client session input', async () => {
        axios.request.mockResolvedValue(completedResponse());
        const sharedBody = requestBody('shared-client-session');
        const first = createService({ uuid: 'account-a', codexAccountKey: 'stable-account-a' });
        const second = createService({ uuid: 'account-b', codexAccountKey: 'stable-account-b' });

        try {
            await first.generateContent('gpt-5.4-mini', sharedBody);
            await second.generateContent('gpt-5.4-mini', sharedBody);
            const firstRequest = axios.request.mock.calls[0][0];
            const secondRequest = axios.request.mock.calls[1][0];
            expect(firstRequest.headers['x-codex-installation-id']).not.toBe(secondRequest.headers['x-codex-installation-id']);
            expect(firstRequest.headers['thread-id']).not.toBe(secondRequest.headers['thread-id']);
        } finally {
            first.stopCacheCleanup();
            second.stopCacheCleanup();
        }
    });
});
