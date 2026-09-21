import { EventEmitter } from 'events';
import { describe, expect, jest, test } from '@jest/globals';

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(options => options),
    getRequiredProxyConfigForProvider: jest.fn(() => null),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));
jest.mock('../src/auth/oauth-handlers.js', () => ({
    handleGeminiAntigravityOAuth: jest.fn()
}));
jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';
import { handleStreamRequest, handleUnaryRequest } from '../src/utils/common.js';
import '../src/converters/register-converters.js';

class FakeResponse extends EventEmitter {
    constructor() {
        super();
        this.body = '';
        this.headers = {};
        this.headersSent = false;
        this.statusCode = null;
        this.writableEnded = false;
    }

    setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value;
    }

    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headersSent = true;
        Object.entries(headers).forEach(([name, value]) => this.setHeader(name, value));
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

function geminiResponse({ text = 'hello', finishReason = 'STOP', modelVersion } = {}) {
    return {
        candidates: [{
            content: { role: 'model', parts: [{ text }] },
            ...(finishReason ? { finishReason } : {})
        }],
        ...(modelVersion ? { modelVersion } : {})
    };
}

function parseSseData(body) {
    return body
        .split('\n')
        .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
        .map(line => JSON.parse(line.slice('data: '.length)));
}

function isTerminalChunk(chunk) {
    return chunk?.type === 'message_stop'
        || chunk?.type === 'response.completed'
        || chunk?.type === 'response.incomplete'
        || chunk?.choices?.some(choice => choice?.finish_reason)
        || chunk?.candidates?.some(candidate => candidate?.finishReason);
}

describe('Antigravity response model metadata', () => {
    test('preserves Google modelVersion when normalizing the Antigravity response', async () => {
        const service = Object.create(AntigravityApiService.prototype);
        service.isInitialized = true;
        service.authClient = { credentials: { expiry_date: Date.now() + 60_000 } };
        service.prepareRequestMetadata = jest.fn();
        service.buildAntigravityPayload = jest.fn((_model, requestBody) => {
            requestBody.model = 'gemini-2.5-flash';
            return {
                payload: {},
                selectedModel: 'gemini-2.5-flash',
                actualModelName: 'gemini-2.5-flash'
            };
        });
        service.callApi = jest.fn().mockResolvedValue({
            response: {
                ...geminiResponse({ modelVersion: 'gemini-2.5-flash-001' }),
                internalOnly: 'discard-me'
            }
        });

        const response = await service.generateContent('gemini-2.5-flash', { contents: [] });
        expect(response).toEqual(expect.objectContaining({
            modelVersion: 'gemini-2.5-flash-001'
        }));
        expect(response).not.toHaveProperty('internalOnly');
    });

    test.each(['openai', 'openaiResponses', 'claude', 'gemini'])(
        'adds request and response models to a unary %s response',
        async (fromProvider) => {
            const service = {
                generateContent: jest.fn(async (_model, requestBody) => {
                    requestBody.model = 'gemini-3.1-pro';
                    return geminiResponse({ modelVersion: 'gemini-3.1-pro-001' });
                })
            };
            const res = new FakeResponse();

            await handleUnaryRequest(
                res,
                service,
                'gemini-3.1-pro(high)',
                { contents: [] },
                fromProvider,
                'gemini-antigravity',
                'none',
                null,
                null,
                null,
                null,
                { CONFIG: {}, maxRetries: 0 }
            );

            expect(JSON.parse(res.body)).toEqual(expect.objectContaining({
                request_model: 'gemini-3.1-pro',
                response_model: 'gemini-3.1-pro-001'
            }));
        }
    );

    test('omits response_model when Google does not return modelVersion', async () => {
        const service = {
            generateContent: jest.fn(async (_model, requestBody) => {
                requestBody.model = 'gemini-3.1-pro';
                return geminiResponse();
            })
        };
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            service,
            'gemini-3.1-pro(high)',
            { contents: [] },
            'openai',
            'gemini-antigravity',
            'none',
            null,
            null,
            null,
            null,
            { CONFIG: {}, maxRetries: 0 }
        );

        const payload = JSON.parse(res.body);
        expect(payload.request_model).toBe('gemini-3.1-pro');
        expect(payload).not.toHaveProperty('response_model');
    });

    test.each(['openai', 'openaiResponses', 'claude', 'gemini'])(
        'adds pending metadata to the first %s stream event and the observed modelVersion to its terminal event only',
        async (fromProvider) => {
        const service = {
            generateContentStream: jest.fn(async function* (_model, requestBody) {
                requestBody.model = 'gemini-3.1-pro';
                yield geminiResponse({ text: 'first', finishReason: null });
                yield geminiResponse({
                    text: 'middle',
                    finishReason: null,
                    modelVersion: 'gemini-3.1-pro-001'
                });
                yield geminiResponse({ text: '' });
            })
        };
        const res = new FakeResponse();

        await handleStreamRequest(
            res,
            service,
            'gemini-3.1-pro(high)',
            { contents: [] },
            fromProvider,
            'gemini-antigravity',
            'none',
            null,
            null,
            null,
            null,
            { CONFIG: {}, maxRetries: 0 }
        );

        const chunks = parseSseData(res.body);
        const metadataChunks = chunks.filter(chunk => Object.hasOwn(chunk, 'request_model'));
        const terminalChunk = chunks.findLast(isTerminalChunk);
        expect(metadataChunks).toHaveLength(2);
        expect(metadataChunks[0]).toEqual(expect.objectContaining({
            request_model: 'gemini-3.1-pro',
            response_model: null
        }));
        expect(terminalChunk).toEqual(expect.objectContaining({
            request_model: 'gemini-3.1-pro',
            response_model: 'gemini-3.1-pro-001'
        }));
        }
    );

    test('omits response_model from the terminal stream chunk when Google never returns modelVersion', async () => {
        const service = {
            generateContentStream: jest.fn(async function* (_model, requestBody) {
                requestBody.model = 'gemini-3.1-pro';
                yield geminiResponse({ text: 'first', finishReason: null });
                yield geminiResponse({ text: '' });
            })
        };
        const res = new FakeResponse();

        await handleStreamRequest(
            res,
            service,
            'gemini-3.1-pro(high)',
            { contents: [] },
            'openai',
            'gemini-antigravity',
            'none',
            null,
            null,
            null,
            null,
            { CONFIG: {}, maxRetries: 0 }
        );

        const chunks = parseSseData(res.body);
        expect(chunks[0].response_model).toBeNull();
        expect(chunks.at(-1).request_model).toBe('gemini-3.1-pro');
        expect(chunks.at(-1)).not.toHaveProperty('response_model');
    });

    test('does not add model metadata for non-Antigravity providers', async () => {
        const service = {
            generateContent: jest.fn().mockResolvedValue(geminiResponse({ modelVersion: 'gemini-3.1-pro-001' }))
        };
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            service,
            'gemini-3.1-pro',
            { contents: [] },
            'gemini',
            'gemini-cli-oauth',
            'none',
            null,
            null,
            null,
            null,
            { CONFIG: {}, maxRetries: 0 }
        );

        const payload = JSON.parse(res.body);
        expect(payload).not.toHaveProperty('request_model');
        expect(payload).not.toHaveProperty('response_model');
    });
});
