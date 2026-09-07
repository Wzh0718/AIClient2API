import { EventEmitter } from 'events';
import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        getCurrentRequestId: jest.fn(() => null)
    }
}));

import { handleStreamRequest, handleUnaryRequest } from '../src/utils/common.js';
import { codexOverloadFailoverStore } from '../src/providers/openai/codex-overload-failover.js';

class FakeResponse extends EventEmitter {
    constructor() {
        super();
        this.headers = null;
        this.statusCode = null;
        this.body = '';
        this.writableEnded = false;
    }

    writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
    }

    write(chunk) {
        this.body += String(chunk);
    }

    end(chunk = '') {
        this.body += String(chunk);
        this.writableEnded = true;
    }
}

function createInvalidatedCodexTokenError() {
    const error = new Error('401 Unauthorized (non-stream): Your authentication token has been invalidated. Please try signing in again.');
    error.origin = 'upstream_codex';
    error.response = {
        status: 401,
        data: {
            error: {
                code: 'token_invalidated',
                message: 'Your authentication token has been invalidated. Please try signing in again.'
            }
        }
    };
    error.credentialMarkedUnhealthy = true;
    error.shouldSwitchCredential = true;
    error.skipErrorCount = true;
    return error;
}

function createCodexUsageLimitError() {
    const error = new Error('429 Too Many Requests (non-stream): {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"pro","resets_at":1782824810,"resets_in_seconds":4481}}');
    error.response = {
        status: 429,
        data: {
            error: {
                type: 'usage_limit_reached',
                message: 'The usage limit has been reached',
                plan_type: 'pro',
                resets_at: 1782824810,
                resets_in_seconds: 4481
            }
        }
    };
    error.shouldSwitchCredential = true;
    error.skipErrorCount = true;
    return error;
}

function createCodexOverloadError() {
    const error = new Error('Our servers are currently overloaded. Please try again later.');
    error.response = {
        status: 503,
        data: {
            error: {
                type: 'service_unavailable_error',
                code: 'server_is_overloaded',
                message: 'Our servers are currently overloaded. Please try again later.'
            }
        }
    };
    error.isCodexOverload = true;
    error.recordProviderForNextRequest = true;
    error.skipErrorCount = true;
    return error;
}

function createProviderPoolManager() {
    return {
        markProviderHealthy: jest.fn(),
        markProviderUnhealthy: jest.fn(),
        markProviderUnhealthyImmediately: jest.fn(),
        markProviderUnhealthyWithRecoveryTime: jest.fn(),
        markCodexQuotaBucketUnhealthy: jest.fn(),
        releaseSlot: jest.fn()
    };
}

describe('provider auth failure health marking', () => {
    test('always terminates a normal OpenAI stream with one DONE marker', async () => {
        const service = {
            async *generateContentStream() {
                yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
            }
        };
        const res = new FakeResponse();

        await handleStreamRequest(
            res,
            service,
            'gpt-5.4-mini',
            { messages: [{ role: 'user', content: 'ping' }] },
            'openai',
            'openai',
            'none',
            null,
            createProviderPoolManager(),
            'openai-provider-1',
            'OpenAI Provider'
        );

        expect((res.body.match(/data: \[DONE\]/g) || [])).toHaveLength(1);
    });

    test('records Codex overload for the next request without marking the provider unhealthy', async () => {
        const failoverKey = 'session:stream-overload-test';
        codexOverloadFailoverStore.clear(failoverKey);
        const error = createCodexOverloadError();
        const service = {
            async *generateContentStream() {
                throw error;
            }
        };
        const providerPoolManager = createProviderPoolManager();
        const res = new FakeResponse();

        await handleStreamRequest(
            res,
            service,
            'gpt-5.4-mini',
            { input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }] },
            'openaiResponses',
            'openai-codex-oauth',
            'none',
            null,
            providerPoolManager,
            'codex-provider-overloaded',
            'Codex Provider',
            {
                CONFIG: {
                    _codexOverloadFailoverKey: failoverKey
                }
            }
        );

        expect(res.body).toContain('event: response.failed');
        expect(res.body).not.toContain('server_is_overloaded');
        expect(res.body).toContain('"code":"server_error"');
        expect(res.body).toContain('[上游 Codex] 服务当前繁忙，已自动重试可用凭证后仍不可用，请稍后重试');
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthyImmediately).not.toHaveBeenCalled();
        expect(codexOverloadFailoverStore.getPendingExclusion(failoverKey)).toBe('codex-provider-overloaded');
        expect(providerPoolManager.releaseSlot).toHaveBeenCalledWith('openai-codex-oauth', 'codex-provider-overloaded');

        codexOverloadFailoverStore.clear(failoverKey);
    });

    test('records unary Codex overload for the next request without marking the provider unhealthy', async () => {
        const failoverKey = 'session:unary-overload-test';
        codexOverloadFailoverStore.clear(failoverKey);
        const error = createCodexOverloadError();
        const service = {
            generateContent: jest.fn().mockRejectedValue(error)
        };
        const providerPoolManager = createProviderPoolManager();
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            service,
            'gpt-5.4-mini',
            { input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }] },
            'openaiResponses',
            'openai-codex-oauth',
            'none',
            null,
            providerPoolManager,
            'codex-provider-overloaded',
            'Codex Provider',
            {
                CONFIG: {
                    _codexOverloadFailoverKey: failoverKey
                }
            }
        );

        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthyImmediately).not.toHaveBeenCalled();
        expect(codexOverloadFailoverStore.getPendingExclusion(failoverKey)).toBe('codex-provider-overloaded');
        expect(providerPoolManager.releaseSlot).toHaveBeenCalledWith('openai-codex-oauth', 'codex-provider-overloaded');

        codexOverloadFailoverStore.clear(failoverKey);
    });

    test('emits a terminal Responses API error event for an upstream 400 before the first stream chunk', async () => {
        const error = new Error("400 Bad Request (stream): Invalid Value: 'tools'. Function 'image_gen.imagegen' conflicts with a hosted tool in the same request.");
        error.origin = 'upstream_codex';
        error.response = {
            status: 400,
            data: {
                error: {
                    type: 'invalid_request_error',
                    message: "Invalid Value: 'tools'. Function 'image_gen.imagegen' conflicts with a hosted tool in the same request."
                }
            }
        };
        const service = {
            async *generateContentStream() {
                throw error;
            }
        };
        const providerPoolManager = createProviderPoolManager();
        const res = new FakeResponse();

        await handleStreamRequest(
            res,
            service,
            'gpt-5.4',
            { input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }] },
            'openaiResponses',
            'openai-codex-oauth',
            'none',
            null,
            providerPoolManager,
            'codex-provider-1',
            'Codex Provider'
        );

        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('event: response.failed');
        expect(res.body).not.toContain('event: error\n');
        const dataLine = res.body.split('\n').find(line => line.startsWith('data: '));
        const event = JSON.parse(dataLine.slice(6));
        expect(event.type).toBe('response.failed');
        expect(event.response.status).toBe('failed');
        expect(event.response.error).toEqual(expect.objectContaining({
            code: 'invalid_request_error',
            message: expect.stringContaining("Function 'image_gen.imagegen' conflicts with a hosted tool")
        }));
        expect(res.body).not.toContain('response.completed');
        expect(res.body).not.toContain('[DONE]');
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthyImmediately).not.toHaveBeenCalled();
        expect(providerPoolManager.releaseSlot).toHaveBeenCalledWith('openai-codex-oauth', 'codex-provider-1');
    });

    test('marks a unary Codex token_invalidated error immediately unhealthy in the provider pool', async () => {
        const error = createInvalidatedCodexTokenError();
        const service = {
            generateContent: jest.fn().mockRejectedValue(error)
        };
        const providerPoolManager = createProviderPoolManager();
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            service,
            'gpt-5.4-mini',
            { messages: [{ role: 'user', content: 'ping' }] },
            'openai',
            'openai-codex-oauth',
            'none',
            null,
            providerPoolManager,
            'codex-provider-1',
            'Codex Provider'
        );

        expect(providerPoolManager.markProviderUnhealthyImmediately).toHaveBeenCalledWith(
            'openai-codex-oauth',
            { uuid: 'codex-provider-1' },
            expect.stringContaining('token has been invalidated')
        );
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.releaseSlot).toHaveBeenCalledWith('openai-codex-oauth', 'codex-provider-1');
        expect(res.statusCode).toBe(401);
    });

    test('marks a stream Codex token_invalidated error immediately unhealthy in the provider pool', async () => {
        const error = createInvalidatedCodexTokenError();
        const service = {
            async *generateContentStream() {
                throw error;
            }
        };
        const providerPoolManager = createProviderPoolManager();
        const res = new FakeResponse();

        await handleStreamRequest(
            res,
            service,
            'gpt-5.4-mini',
            { messages: [{ role: 'user', content: 'ping' }] },
            'openai',
            'openai-codex-oauth',
            'none',
            null,
            providerPoolManager,
            'codex-provider-1',
            'Codex Provider'
        );

        expect(providerPoolManager.markProviderUnhealthyImmediately).toHaveBeenCalledWith(
            'openai-codex-oauth',
            { uuid: 'codex-provider-1' },
            expect.stringContaining('token has been invalidated')
        );
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.releaseSlot).toHaveBeenCalledWith('openai-codex-oauth', 'codex-provider-1');
        expect(res.body).toContain('token has been invalidated');
    });

    test('marks a unary Codex Spark usage_limit_reached error as the general quota bucket without globally unhealthy provider', async () => {
        const error = createCodexUsageLimitError();
        const service = {
            generateContent: jest.fn().mockRejectedValue(error)
        };
        const providerPoolManager = createProviderPoolManager();
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            service,
            'gpt-5.3-codex-spark',
            { messages: [{ role: 'user', content: 'ping' }] },
            'openai',
            'openai-codex-oauth',
            'none',
            null,
            providerPoolManager,
            'codex-provider-1',
            'Codex Provider',
            {
                CONFIG: {
                    RATE_LIMIT_COOLDOWN_ENABLED: true,
                    RATE_LIMIT_COOLDOWN_MS: 30000,
                    RATE_LIMIT_COOLDOWN_JITTER_MS: 0
                }
            }
        );

        expect(providerPoolManager.markCodexQuotaBucketUnhealthy).toHaveBeenCalledWith(
            'openai-codex-oauth',
            { uuid: 'codex-provider-1' },
            'general',
            '429 Too Many Requests - short cooldown',
            expect.any(Date)
        );
        expect(providerPoolManager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.releaseSlot).toHaveBeenCalledWith('openai-codex-oauth', 'codex-provider-1');
    });

    test('marks a unary Codex general usage_limit_reached error without globally unhealthy provider', async () => {
        const error = createCodexUsageLimitError();
        const service = {
            generateContent: jest.fn().mockRejectedValue(error)
        };
        const providerPoolManager = createProviderPoolManager();
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            service,
            'gpt-5.5',
            { messages: [{ role: 'user', content: 'ping' }] },
            'openai',
            'openai-codex-oauth',
            'none',
            null,
            providerPoolManager,
            'codex-provider-1',
            'Codex Provider',
            {
                CONFIG: {
                    RATE_LIMIT_COOLDOWN_ENABLED: true,
                    RATE_LIMIT_COOLDOWN_MS: 30000,
                    RATE_LIMIT_COOLDOWN_JITTER_MS: 0
                }
            }
        );

        expect(providerPoolManager.markCodexQuotaBucketUnhealthy).toHaveBeenCalledWith(
            'openai-codex-oauth',
            { uuid: 'codex-provider-1' },
            'general',
            '429 Too Many Requests - short cooldown',
            expect.any(Date)
        );
        expect(providerPoolManager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.releaseSlot).toHaveBeenCalledWith('openai-codex-oauth', 'codex-provider-1');
    });

    test('marks a stream Codex Spark usage_limit_reached error as the general quota bucket without globally unhealthy provider', async () => {
        const error = createCodexUsageLimitError();
        const service = {
            async *generateContentStream() {
                throw error;
            }
        };
        const providerPoolManager = createProviderPoolManager();
        const res = new FakeResponse();

        await handleStreamRequest(
            res,
            service,
            'gpt-5.3-codex-spark',
            { messages: [{ role: 'user', content: 'ping' }] },
            'openai',
            'openai-codex-oauth',
            'none',
            null,
            providerPoolManager,
            'codex-provider-1',
            'Codex Provider',
            {
                CONFIG: {
                    RATE_LIMIT_COOLDOWN_ENABLED: true,
                    RATE_LIMIT_COOLDOWN_MS: 30000,
                    RATE_LIMIT_COOLDOWN_JITTER_MS: 0
                }
            }
        );

        expect(providerPoolManager.markCodexQuotaBucketUnhealthy).toHaveBeenCalledWith(
            'openai-codex-oauth',
            { uuid: 'codex-provider-1' },
            'general',
            '429 Too Many Requests - short cooldown',
            expect.any(Date)
        );
        expect(providerPoolManager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.releaseSlot).toHaveBeenCalledWith('openai-codex-oauth', 'codex-provider-1');
    });
});
