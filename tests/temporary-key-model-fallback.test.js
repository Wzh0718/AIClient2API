import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockGetApiServiceWithFallback = jest.fn();

jest.mock('../src/services/service-manager.js', () => ({
    getApiServiceWithFallback: mockGetApiServiceWithFallback
}));

import { handleStreamRequest, handleUnaryRequest } from '../src/utils/common.js';

class FakeResponse extends EventEmitter {
    constructor() {
        super();
        this.body = '';
        this.headers = {};
        this.statusCode = null;
        this.writableEnded = false;
        this.writeHeadCalls = 0;
    }

    setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value;
    }

    writeHead(statusCode) {
        this.writeHeadCalls += 1;
        if (this.writeHeadCalls > 1) {
            throw new Error('response headers already sent');
        }
        this.statusCode = statusCode;
    }

    write(chunk) {
        this.body += String(chunk);
        return true;
    }

    end(chunk = '') {
        this.body += String(chunk);
        this.writableEnded = true;
    }
}

function createPoolManager() {
    return {
        markProviderHealthy: jest.fn(),
        markProviderUnhealthy: jest.fn(),
        markProviderUnhealthyImmediately: jest.fn(),
        markProviderUnhealthyWithRecoveryTime: jest.fn(),
        markAntigravityModelQuotaUnhealthy: jest.fn(),
        releaseSlot: jest.fn()
    };
}

function createTemporaryRouteRetryContext(overrides = {}) {
    return {
        CONFIG: {},
        currentRetry: 0,
        maxRetries: 0,
        temporaryRoute: {
            id: 'temporary-antigravity-flash',
            requestedModel: 'gpt-5.4-mini',
            originalProviderType: 'openai-codex-oauth',
            targetProviderType: 'gemini-antigravity',
            targetModel: 'gemini-2.5-flash',
            fallbackToOriginal: true,
            preserveResponseModel: true
        },
        ...overrides
    };
}

describe('temporary model route fallback', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('falls back to the original route after a unary target failure before a response is sent', async () => {
        const targetError = Object.assign(new Error('target rejected request'), {
            response: { status: 400 }
        });
        const targetService = { generateContent: jest.fn().mockRejectedValue(targetError) };
        const fallbackService = {
            generateContent: jest.fn().mockResolvedValue({
                id: 'fallback-response',
                model: 'gpt-5.4-mini'
            })
        };
        const fallback = jest.fn().mockResolvedValue({
            service: fallbackService,
            model: 'gpt-5.4-mini',
            requestBody: { model: 'gpt-5.4-mini', input: [] },
            toProvider: 'openai-codex-oauth',
            uuid: 'codex-fallback',
            customName: 'Codex fallback'
        });
        const config = {};
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            targetService,
            'gemini-2.5-flash',
            { model: 'gemini-2.5-flash', contents: [] },
            'openai-codex-oauth',
            'gemini-antigravity',
            'none',
            null,
            createPoolManager(),
            'antigravity-1',
            'Antigravity 1',
            createTemporaryRouteRetryContext({ CONFIG: config, temporaryRouteFallback: fallback })
        );

        expect(fallback).toHaveBeenCalledTimes(1);
        expect(fallbackService.generateContent).toHaveBeenCalledTimes(1);
        expect(JSON.parse(res.body)).toMatchObject({
            id: 'fallback-response',
            model: 'gpt-5.4-mini'
        });
        expect(config._temporaryKeyModelRouteResult).toMatchObject({
            actualProviderType: 'openai-codex-oauth',
            actualModel: 'gpt-5.4-mini',
            fallbackUsed: true
        });
    });

    test('falls back when a stream fails before its first chunk', async () => {
        const targetService = {
            async *generateContentStream() {
                throw Object.assign(new Error('target unavailable'), { response: { status: 503 } });
            }
        };
        const fallbackService = {
            async *generateContentStream() {
                yield { type: 'response.completed', response: { model: 'gpt-5.4-mini' } };
            }
        };
        const fallback = jest.fn().mockResolvedValue({
            service: fallbackService,
            model: 'gpt-5.4-mini',
            requestBody: { model: 'gpt-5.4-mini', input: [] },
            toProvider: 'openai-codex-oauth',
            uuid: 'codex-fallback'
        });
        const res = new FakeResponse();

        await handleStreamRequest(
            res,
            targetService,
            'gemini-2.5-flash',
            { model: 'gemini-2.5-flash', contents: [] },
            'openai-codex-oauth',
            'gemini-antigravity',
            'none',
            null,
            createPoolManager(),
            'antigravity-1',
            'Antigravity 1',
            createTemporaryRouteRetryContext({ temporaryRouteFallback: fallback })
        );

        expect(fallback).toHaveBeenCalledTimes(1);
        expect(res.body).toContain('gpt-5.4-mini');
        expect(res.writeHeadCalls).toBe(1);
    });

    test('does not cross providers after a stream chunk has already been sent', async () => {
        const targetService = {
            async *generateContentStream() {
                yield {
                    type: 'response.created',
                    response: { model: 'gemini-2.5-flash' }
                };
                throw Object.assign(new Error('late target failure'), { response: { status: 503 } });
            }
        };
        const fallback = jest.fn();
        const res = new FakeResponse();
        const config = {};

        await handleStreamRequest(
            res,
            targetService,
            'gemini-2.5-flash',
            { model: 'gemini-2.5-flash', contents: [] },
            'gemini-antigravity',
            'gemini-antigravity',
            'none',
            null,
            createPoolManager(),
            'antigravity-1',
            'Antigravity 1',
            createTemporaryRouteRetryContext({ CONFIG: config, temporaryRouteFallback: fallback })
        );

        expect(fallback).not.toHaveBeenCalled();
        expect(res.body).toContain('gpt-5.4-mini');
        expect(res.body).not.toContain('gemini-2.5-flash');
        expect(res.body).toContain('"error"');
        expect(config._temporaryKeyModelRouteResult).toMatchObject({
            actualProviderType: 'gemini-antigravity',
            actualModel: 'gemini-2.5-flash',
            fallbackUsed: false
        });
    });

    test('keeps unary credential retries inside the temporary target provider', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
        const targetError = Object.assign(new Error('No capacity available'), {
            response: { status: 503 }
        });
        const firstService = {
            generateContent: jest.fn().mockRejectedValue(targetError)
        };
        const retryService = {
            generateContent: jest.fn().mockResolvedValue({ model: 'gemini-2.5-flash' })
        };
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: retryService,
            actualProviderType: 'gemini-antigravity',
            actualModel: 'gemini-2.5-flash',
            uuid: 'antigravity-2',
            serviceConfig: {}
        });
        const config = {};

        await handleUnaryRequest(
            new FakeResponse(),
            firstService,
            'gemini-2.5-flash',
            { model: 'gemini-2.5-flash' },
            'gemini-antigravity',
            'gemini-antigravity',
            'none',
            null,
            createPoolManager(),
            'antigravity-1',
            'Antigravity 1',
            createTemporaryRouteRetryContext({ CONFIG: config, maxRetries: 1 })
        );

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(
            config,
            'gemini-2.5-flash',
            expect.objectContaining({ disableProviderFallback: true })
        );
        expect(config._temporaryKeyModelRouteResult).toMatchObject({
            actualProviderType: 'gemini-antigravity',
            actualModel: 'gemini-2.5-flash',
            fallbackUsed: false
        });
    });

    test('keeps stream credential retries inside the temporary target provider', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
        const targetError = Object.assign(new Error('No capacity available'), {
            response: { status: 503 }
        });
        const firstService = {
            async *generateContentStream() {
                throw targetError;
            }
        };
        const retryService = {
            async *generateContentStream() {
                yield { type: 'response.completed', response: { model: 'gemini-2.5-flash' } };
            }
        };
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: retryService,
            actualProviderType: 'gemini-antigravity',
            actualModel: 'gemini-2.5-flash',
            uuid: 'antigravity-2',
            serviceConfig: {}
        });
        const config = {};

        await handleStreamRequest(
            new FakeResponse(),
            firstService,
            'gemini-2.5-flash',
            { model: 'gemini-2.5-flash' },
            'gemini-antigravity',
            'gemini-antigravity',
            'none',
            null,
            createPoolManager(),
            'antigravity-1',
            'Antigravity 1',
            createTemporaryRouteRetryContext({ CONFIG: config, maxRetries: 1 })
        );

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(
            config,
            'gemini-2.5-flash',
            expect.objectContaining({ disableProviderFallback: true })
        );
        expect(config._temporaryKeyModelRouteResult).toMatchObject({
            actualProviderType: 'gemini-antigravity',
            actualModel: 'gemini-2.5-flash',
            fallbackUsed: false
        });
    });
});
