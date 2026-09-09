import { Readable } from 'node:stream';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { CodexApiService } from '../src/providers/openai/codex-core.js';
import axios from 'axios';

jest.mock('axios', () => ({
    request: jest.fn()
}));

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
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

const services = [];

function createService() {
    const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth', CODEX_OVERLOAD_RETRY_DELAY_MS: 0 });
    services.push(service);
    return service;
}

function failedEvent(error) {
    return {
        type: 'response.failed',
        response: { error }
    };
}

async function consumeStream(generator) {
    const events = [];
    for await (const event of generator) {
        events.push(event);
    }
    return events;
}

afterEach(() => {
    axios.request.mockReset();
    while (services.length > 0) {
        services.pop().stopCacheCleanup();
    }
});

describe('Codex terminal Responses errors', () => {
    test('preserves response.failed invalid request details as a 400 error', () => {
        const service = createService();
        const payload = failedEvent({
            type: 'invalid_request_error',
            code: 'invalid_request_error',
            message: 'A hosted tool conflicts with a function tool.'
        });

        let thrown;
        try {
            service.parseNonStreamResponse(JSON.stringify(payload));
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.message).toContain('A hosted tool conflicts with a function tool.');
        expect(thrown.response).toEqual(expect.objectContaining({ status: 400 }));
        expect(thrown.shouldSwitchCredential).not.toBe(true);
        expect(thrown.skipErrorCount).not.toBe(true);
    });

    test('maps usage_limit_reached to retryable credential-switch metadata', () => {
        const service = createService();
        const payload = failedEvent({
            type: 'usage_limit_reached',
            message: 'The usage limit has been reached.',
            resets_in_seconds: 37
        });

        let thrown;
        try {
            service.parseNonStreamResponse(`data:${JSON.stringify(payload)}`);
        } catch (error) {
            thrown = error;
        }

        expect(thrown.response.status).toBe(429);
        expect(thrown.shouldSwitchCredential).toBe(true);
        expect(thrown.skipErrorCount).toBe(true);
        expect(thrown.retryAfterMs).toBe(37000);
    });

    test('maps insufficient_quota to a retryable Codex quota error', () => {
        const service = createService();
        const payload = failedEvent({
            type: 'insufficient_quota',
            code: 'insufficient_quota',
            message: 'The 7 day usage limit has been reached.',
            resets_in_seconds: 91
        });

        let thrown;
        try {
            service.parseNonStreamResponse(JSON.stringify(payload));
        } catch (error) {
            thrown = error;
        }

        expect(thrown.response.status).toBe(429);
        expect(thrown.shouldSwitchCredential).toBe(true);
        expect(thrown.skipErrorCount).toBe(true);
        expect(thrown.retryAfterMs).toBe(91000);
    });

    test.each([
        'The selected model is at capacity.',
        'Model is at capacity. Please try a different model.'
    ])('maps model capacity to credential-switch metadata: %s', (message) => {
        const service = createService();

        let thrown;
        try {
            service.parseNonStreamResponse(JSON.stringify(failedEvent({ message })));
        } catch (error) {
            thrown = error;
        }

        expect(thrown.response.status).toBe(429);
        expect(thrown.shouldSwitchCredential).toBe(true);
        expect(thrown.skipErrorCount).toBe(true);
        expect(thrown.isCodexModelCapacity).toBe(true);
        expect(thrown.origin).toBe('upstream_codex');
    });

    test('treats empty response.incomplete as an upstream failure', () => {
        const service = createService();
        const payload = {
            type: 'response.incomplete',
            response: {
                id: 'resp_empty_incomplete',
                status: 'incomplete',
                output: [],
                usage: { output_tokens: 0 }
            }
        };

        let thrown;
        try {
            service.parseNonStreamResponse(JSON.stringify(payload));
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.message).toContain('Codex API error');
        expect(thrown.isCodexOverload).toBe(true);
        expect(thrown.retrySameCredential).toBe(true);
        expect(thrown.responseId).toBe('resp_empty_incomplete');
    });

    test('does not treat a completed empty response as an incomplete failure', () => {
        const service = createService();
        const payload = {
            type: 'response.completed',
            response: { id: 'resp_completed_empty', output: [] }
        };

        expect(service.parseNonStreamResponse(JSON.stringify(payload))).toEqual(payload);
    });

    test('maps retryable server_error messages to same-credential overload retry', () => {
        const service = createService();

        let thrown;
        try {
            service.parseNonStreamResponse(JSON.stringify({
                type: 'error',
                error: {
                    type: 'server_error',
                    message: 'The server had an error while processing your request. You can retry your request.'
                }
            }));
        } catch (error) {
            thrown = error;
        }

        expect(thrown.response.status).toBe(503);
        expect(thrown.isCodexOverload).toBe(true);
        expect(thrown.retrySameCredential).toBe(true);
        expect(thrown.origin).toBe('upstream_codex');
    });

    test('keeps non-retryable server_error as a terminal 400', () => {
        const service = createService();

        let thrown;
        try {
            service.parseNonStreamResponse(JSON.stringify({
                type: 'error',
                error: {
                    type: 'server_error',
                    message: 'Internal error without retry advice'
                }
            }));
        } catch (error) {
            thrown = error;
        }

        expect(thrown.response.status).toBe(400);
        expect(thrown.isCodexOverload).not.toBe(true);
    });

    test('maps server overload to transient same-credential retry metadata', () => {
        const service = createService();

        let thrown;
        try {
            service.parseNonStreamResponse(JSON.stringify(failedEvent({
                type: 'service_unavailable_error',
                code: 'server_is_overloaded',
                message: 'Our servers are currently overloaded. Please try again later.'
            })));
        } catch (error) {
            thrown = error;
        }

        expect(thrown.response.status).toBe(503);
        expect(thrown.isCodexOverload).toBe(true);
        expect(thrown.retrySameCredential).toBe(true);
        expect(thrown.recordProviderForNextRequest).toBe(true);
        expect(thrown.shouldSwitchCredential).toBe(true);
        expect(thrown.skipErrorCount).toBe(true);
        expect(thrown.origin).toBe('upstream_codex');
    });

    test('parses data without a space and throws the final response.failed buffer', async () => {
        const service = createService();
        const payload = failedEvent({
            type: 'invalid_request_error',
            message: 'Final buffer failure'
        });
        const stream = Readable.from([
            'event: response.failed\n',
            'id: evt_1\n',
            'retry: 1000\n',
            `data:${JSON.stringify(payload)}`
        ]);

        await expect(consumeStream(service.parseSSEStream(stream))).rejects.toMatchObject({
            message: expect.stringContaining('Final buffer failure'),
            response: expect.objectContaining({ status: 400 })
        });
    });

    test('accepts a bare JSON completed event in the streaming parser', async () => {
        const service = createService();
        const completed = {
            type: 'response.completed',
            response: { id: 'resp_1', output: [] }
        };
        const stream = Readable.from([`${JSON.stringify(completed)}\n`]);

        await expect(consumeStream(service.parseSSEStream(stream))).resolves.toEqual([completed]);
    });

    test('retries three times on the same credential before surfacing overload', async () => {
        const service = createService();
        service.isInitialized = true;
        service.accessToken = 'token';
        service.accountId = 'account';

        const overload = failedEvent({
            type: 'service_unavailable_error',
            code: 'server_is_overloaded',
            message: 'Our servers are currently overloaded. Please try again later.'
        });
        const completed = { type: 'response.completed', response: { id: 'resp_2', output: [] } };

        axios.request
            .mockResolvedValueOnce({
                data: Readable.from([
                    `data:${JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } })}\n`,
                    `data:${JSON.stringify(overload)}\n`
                ])
            })
            .mockResolvedValueOnce({
                data: Readable.from([
                    `data:${JSON.stringify({ type: 'response.created', response: { id: 'resp_1b' } })}\n`,
                    `data:${JSON.stringify(overload)}\n`
                ])
            })
            .mockResolvedValueOnce({
                data: Readable.from([
                    `data:${JSON.stringify({ type: 'response.created', response: { id: 'resp_1c' } })}\n`,
                    `data:${JSON.stringify(overload)}\n`
                ])
            })
            .mockResolvedValueOnce({
                data: Readable.from([
                    `data:${JSON.stringify({ type: 'response.created', response: { id: 'resp_2' } })}\n`,
                    `data:${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n`,
                    `data:${JSON.stringify(completed)}\n`
                ])
            });

        await expect(consumeStream(service.generateContentStream('gpt-5.5', { input: 'hello' })))
            .resolves.toEqual(expect.arrayContaining([
                expect.objectContaining({ type: 'response.output_text.delta', delta: 'ok' }),
                completed
            ]));
        expect(axios.request).toHaveBeenCalledTimes(4);
    });

    test('surfaces overload after three same-credential retries and preserves response metadata', async () => {
        const service = createService();
        service.isInitialized = true;
        service.accessToken = 'token';
        service.accountId = 'account';

        const overload = failedEvent({
            type: 'service_unavailable_error',
            code: 'server_is_overloaded',
            message: 'Our servers are currently overloaded. Please try again later.'
        });
        axios.request
            .mockResolvedValueOnce({
                data: Readable.from([
                    `data:${JSON.stringify({ type: 'response.created', response: { id: 'resp_first', created_at: 100, model: 'gpt-5.4-mini' } })}\n`,
                    `data:${JSON.stringify(overload)}\n`
                ])
            })
            .mockResolvedValueOnce({
                data: Readable.from([
                    `data:${JSON.stringify({ type: 'response.created', response: { id: 'resp_second', created_at: 150, model: 'gpt-5.4-mini' } })}\n`,
                    `data:${JSON.stringify(overload)}\n`
                ])
            })
            .mockResolvedValueOnce({
                data: Readable.from([
                    `data:${JSON.stringify({ type: 'response.created', response: { id: 'resp_third', created_at: 175, model: 'gpt-5.4-mini' } })}\n`,
                    `data:${JSON.stringify(overload)}\n`
                ])
            })
            .mockResolvedValueOnce({
                data: Readable.from([
                    `data:${JSON.stringify({ type: 'response.created', response: { id: 'resp_fourth', created_at: 200, model: 'gpt-5.4-mini' } })}\n`,
                    `data:${JSON.stringify(overload)}\n`
                ])
            });

        await expect(consumeStream(service.generateContentStream('gpt-5.5', { input: 'hello' })))
            .rejects.toMatchObject({
                isCodexOverload: true,
                responseId: 'resp_fourth',
                responseSnapshot: expect.objectContaining({
                    id: 'resp_fourth',
                    created_at: 200,
                    model: 'gpt-5.4-mini'
                })
            });
        expect(axios.request).toHaveBeenCalledTimes(4);
    });

    test('retries a non-stream request three times on the same credential after overload', async () => {
        const service = createService();
        service.isInitialized = true;
        service.accessToken = 'token';
        service.accountId = 'account';

        const overload = failedEvent({
            type: 'service_unavailable_error',
            code: 'server_is_overloaded',
            message: 'Our servers are currently overloaded. Please try again later.'
        });
        const completed = { type: 'response.completed', response: { id: 'resp_non_stream', output: [] } };

        axios.request
            .mockResolvedValueOnce({ data: `data:${JSON.stringify(overload)}` })
            .mockResolvedValueOnce({ data: `data:${JSON.stringify(overload)}` })
            .mockResolvedValueOnce({ data: `data:${JSON.stringify(overload)}` })
            .mockResolvedValueOnce({ data: `data:${JSON.stringify(completed)}` });

        await expect(service.generateContent('gpt-5.5', { input: 'hello' })).resolves.toEqual(completed);
        expect(axios.request).toHaveBeenCalledTimes(4);
    });

    test('does not retry the same credential after visible output was emitted', async () => {
        const service = createService();
        service.isInitialized = true;
        service.accessToken = 'token';
        service.accountId = 'account';

        const overload = failedEvent({
            type: 'service_unavailable_error',
            code: 'server_is_overloaded',
            message: 'Our servers are currently overloaded. Please try again later.'
        });
        axios.request.mockResolvedValueOnce({
            data: Readable.from([
                `data:${JSON.stringify({ type: 'response.created', response: { id: 'resp_partial' } })}\n`,
                `data:${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n`,
                `data:${JSON.stringify(overload)}\n`
            ])
        });

        const events = [];
        let thrown;
        try {
            for await (const event of service.generateContentStream('gpt-5.5', { input: 'hello' })) {
                events.push(event);
            }
        } catch (error) {
            thrown = error;
        }

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'response.output_text.delta', delta: 'partial' })
        ]));
        expect(thrown).toMatchObject({ isCodexOverload: true, responseId: 'resp_partial' });
        expect(axios.request).toHaveBeenCalledTimes(1);
    });
});
