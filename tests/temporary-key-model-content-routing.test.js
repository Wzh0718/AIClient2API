import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { hashTemporaryRouteKey } from '../src/utils/temporary-key-model-routing.js';

const mockGetApiServiceWithFallback = jest.fn();
const mockExecuteHook = jest.fn();

jest.mock('../src/services/service-manager.js', () => ({
    getApiServiceWithFallback: mockGetApiServiceWithFallback
}));

jest.mock('../src/core/plugin-manager.js', () => ({
    getPluginManager: () => ({
        executeHook: mockExecuteHook
    })
}));

import '../src/converters/register-converters.js';
import { ENDPOINT_TYPE, handleContentGenerationRequest } from '../src/utils/common.js';

class FakeRequest extends EventEmitter {
    constructor(body) {
        super();
        this.headers = {};
        this.body = JSON.stringify(body);
    }

    start() {
        queueMicrotask(() => {
            this.emit('data', Buffer.from(this.body));
            this.emit('end');
        });
    }

    resume() {}
    destroy() {}
}

class FakeResponse extends EventEmitter {
    constructor() {
        super();
        this.body = '';
        this.writableEnded = false;
        this.statusCode = null;
    }

    writeHead(statusCode) {
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

describe('temporary key model content routing', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetApiServiceWithFallback.mockReset();
        mockExecuteHook.mockReset();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test.each(['gpt-5.4-mini-fast', 'gpt-5.3-codex-spark-fast'])('keeps requested %s while executing on ordinary GPT-6 Luna', async requestedModel => {
        const generateContent = jest.fn().mockResolvedValue({
            type: 'response.completed',
            response: {
                id: 'luna-response',
                object: 'response',
                model: 'gpt-6-luna',
                status: 'completed',
                output: []
            }
        });
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: { generateContent },
            actualProviderType: 'openai-codex-oauth',
            actualModel: 'gpt-6-luna',
            uuid: 'codex-luna',
            serviceConfig: {
                customName: 'Codex Luna',
                codexAccountKey: 'luna-account',
                codexEmail: 'luna@example.com'
            },
            isFallback: false
        });
        const config = {
            MODEL_PROVIDER: 'openai-codex-oauth',
            potluckApiKey: 'ordinary-key',
            REQUEST_BODY_MAX_BYTES: 1024 * 1024,
            CREDENTIAL_SWITCH_MAX_RETRIES: 0,
            PROMPT_LOG_MODE: 'none',
            providerPools: { 'openai-codex-oauth': [{ uuid: 'codex-luna' }] }
        };
        const request = new FakeRequest({ model: requestedModel, stream: false, input: 'hello' });
        const response = new FakeResponse();
        request.start();

        await handleContentGenerationRequest(
            request,
            response,
            null,
            ENDPOINT_TYPE.OPENAI_RESPONSES,
            config,
            null,
            { releaseSlot: jest.fn(), markProviderHealthy: jest.fn() },
            null,
            '/openai-codex-oauth/v1/responses'
        );

        expect(generateContent).toHaveBeenCalledWith('gpt-6-luna', expect.any(Object));
        expect(JSON.parse(response.body).model).toBe(requestedModel);
        expect(mockExecuteHook).toHaveBeenCalledWith('onContentGenerated', expect.objectContaining({
            toProvider: 'openai-codex-oauth',
            model: 'gpt-6-luna',
            providerUuid: 'codex-luna',
            accountEmail: 'luna@example.com'
        }));
        const hookContext = mockExecuteHook.mock.calls.find(([name]) => name === 'onContentGenerated')[1];
        expect(hookContext.processedRequestBody.service_tier).toBe('default');
        expect(hookContext.usagePricingModel).toBe('gpt-6-luna');
    });

    test('converts a matching Responses request to Antigravity while preserving the client model', async () => {
        const apiKey = 'maki_content_route_test';
        const generateContent = jest.fn().mockResolvedValue({
            candidates: [{
                content: { role: 'model', parts: [{ text: 'routed through flash' }] },
                finishReason: 'STOP'
            }],
            usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 5,
                totalTokenCount: 15
            }
        });
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: { generateContent },
            actualProviderType: 'gemini-antigravity',
            actualModel: 'gemini-2.5-flash',
            uuid: 'antigravity-test',
            serviceConfig: { customName: 'Antigravity test' },
            isFallback: false
        });
        const config = {
            MODEL_PROVIDER: 'openai-codex-oauth',
            _originalRequestPath: '/openai-codex-oauth/v1/responses',
            potluckApiKey: apiKey,
            REQUEST_BODY_MAX_BYTES: 1024 * 1024,
            CREDENTIAL_SWITCH_MAX_RETRIES: 0,
            PROMPT_LOG_MODE: 'none',
            temporaryKeyModelRoutes: [{
                id: 'temporary-antigravity-flash',
                enabled: true,
                keyHash: hashTemporaryRouteKey(apiKey),
                paths: ['/openai-codex-oauth/v1/responses'],
                models: ['gpt-5.4-mini', 'gpt-5.3-codex-spark'],
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                fallbackModel: 'gpt-6-luna',
                fallbackToOriginal: true,
                preserveResponseModel: true
            }]
        };
        const request = new FakeRequest({
            model: 'gpt-5.4-mini',
            stream: false,
            input: 'hello'
        });
        const response = new FakeResponse();
        request.start();

        await handleContentGenerationRequest(
            request,
            response,
            null,
            ENDPOINT_TYPE.OPENAI_RESPONSES,
            config,
            null,
            null,
            null,
            '/v1/responses'
        );

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(
            expect.objectContaining({ MODEL_PROVIDER: 'gemini-antigravity' }),
            'gemini-2.5-flash',
            expect.objectContaining({ disableProviderFallback: true })
        );
        expect(generateContent).toHaveBeenCalledWith(
            'gemini-2.5-flash',
            expect.objectContaining({
                model: 'gemini-2.5-flash',
                contents: expect.any(Array)
            })
        );
        expect(JSON.parse(response.body)).toMatchObject({
            object: 'response',
            model: 'gpt-5.4-mini',
            status: 'completed'
        });
        expect(config._temporaryKeyModelRouteResult).toMatchObject({
            requestedModel: 'gpt-5.4-mini',
            actualProviderType: 'gemini-antigravity',
            actualModel: 'gemini-2.5-flash',
            providerUuid: 'antigravity-test',
            providerName: 'Antigravity test',
            fallbackUsed: false
        });
        expect(mockExecuteHook).toHaveBeenCalledWith(
            'onContentGenerated',
            expect.objectContaining({
                toProvider: 'gemini-antigravity',
                model: 'gemini-2.5-flash',
                providerUuid: 'antigravity-test',
                providerName: 'Antigravity test'
            })
        );
    });

    test('streams a matching Responses request through Antigravity while preserving the client model', async () => {
        const apiKey = 'maki_stream_route_test';
        const generateContentStream = jest.fn(async function* () {
            yield {
                candidates: [{
                    content: { role: 'model', parts: [{ text: 'streamed through flash' }] }
                }]
            };
            yield {
                candidates: [{
                    content: { role: 'model', parts: [] },
                    finishReason: 'STOP'
                }],
                usageMetadata: {
                    promptTokenCount: 8,
                    candidatesTokenCount: 4,
                    totalTokenCount: 12
                }
            };
        });
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: { generateContentStream },
            actualProviderType: 'gemini-antigravity',
            actualModel: 'gemini-2.5-flash',
            uuid: 'antigravity-stream-test',
            serviceConfig: { customName: 'Antigravity stream test' },
            isFallback: false
        });
        const config = {
            MODEL_PROVIDER: 'openai-codex-oauth',
            potluckApiKey: apiKey,
            REQUEST_BODY_MAX_BYTES: 1024 * 1024,
            CREDENTIAL_SWITCH_MAX_RETRIES: 0,
            PROMPT_LOG_MODE: 'none',
            temporaryKeyModelRoutes: [{
                id: 'temporary-antigravity-flash-stream',
                enabled: true,
                keyHash: hashTemporaryRouteKey(apiKey),
                paths: ['/v1/responses'],
                models: ['gpt-5.4-mini', 'gpt-5.3-codex-spark'],
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                fallbackModel: 'gpt-6-luna',
                fallbackToOriginal: true,
                preserveResponseModel: true
            }]
        };
        const request = new FakeRequest({
            model: 'gpt-5.3-codex-spark',
            stream: true,
            input: 'hello stream'
        });
        const response = new FakeResponse();
        request.start();

        await handleContentGenerationRequest(
            request,
            response,
            null,
            ENDPOINT_TYPE.OPENAI_RESPONSES,
            config,
            null,
            null,
            null,
            '/v1/responses'
        );

        expect(generateContentStream).toHaveBeenCalledWith(
            'gemini-2.5-flash',
            expect.objectContaining({
                model: 'gemini-2.5-flash',
                contents: expect.any(Array)
            })
        );
        expect(response.body).toContain('event: response.created');
        expect(response.body).toContain('event: response.completed');
        expect(response.body).toContain('streamed through flash');
        expect(response.body).toContain('gpt-5.3-codex-spark');
        expect(response.body).toContain('"model":"gpt-5.3-codex-spark"');
        expect(response.body).toContain('"request_model":"gemini-2.5-flash"');
        expect(config._temporaryKeyModelRouteResult).toMatchObject({
            requestedModel: 'gpt-5.3-codex-spark',
            actualProviderType: 'gemini-antigravity',
            actualModel: 'gemini-2.5-flash',
            fallbackUsed: false
        });
    });

    test('converts Responses function tools and returns a preserved-model function call', async () => {
        const apiKey = 'maki_tool_route_test';
        const generateContent = jest.fn().mockResolvedValue({
            candidates: [{
                content: {
                    role: 'model',
                    parts: [{
                        functionCall: {
                            id: 'call_weather_1',
                            name: 'get_weather',
                            args: { city: 'Shanghai' }
                        }
                    }]
                },
                finishReason: 'STOP'
            }]
        });
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: { generateContent },
            actualProviderType: 'gemini-antigravity',
            actualModel: 'gemini-2.5-flash',
            uuid: 'antigravity-tool-test',
            serviceConfig: { customName: 'Antigravity tool test' },
            isFallback: false
        });
        const config = {
            MODEL_PROVIDER: 'openai-codex-oauth',
            potluckApiKey: apiKey,
            REQUEST_BODY_MAX_BYTES: 1024 * 1024,
            CREDENTIAL_SWITCH_MAX_RETRIES: 0,
            PROMPT_LOG_MODE: 'none',
            temporaryKeyModelRoutes: [{
                id: 'temporary-antigravity-flash-tool',
                enabled: true,
                keyHash: hashTemporaryRouteKey(apiKey),
                paths: ['/v1/responses'],
                models: ['gpt-5.4-mini'],
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                fallbackModel: 'gpt-6-luna',
                fallbackToOriginal: true,
                preserveResponseModel: true
            }]
        };
        const request = new FakeRequest({
            model: 'gpt-5.4-mini',
            stream: false,
            input: 'What is the weather?',
            tools: [{
                type: 'function',
                name: 'get_weather',
                description: 'Get weather by city',
                parameters: {
                    type: 'object',
                    properties: { city: { type: 'string' } },
                    required: ['city']
                }
            }]
        });
        const response = new FakeResponse();
        request.start();

        await handleContentGenerationRequest(
            request,
            response,
            null,
            ENDPOINT_TYPE.OPENAI_RESPONSES,
            config,
            null,
            null,
            null,
            '/v1/responses'
        );

        expect(generateContent).toHaveBeenCalledWith(
            'gemini-2.5-flash',
            expect.objectContaining({
                tools: [{
                    functionDeclarations: [expect.objectContaining({
                        name: 'get_weather',
                        parameters: expect.objectContaining({ type: 'object' })
                    })]
                }]
            })
        );
        const payload = JSON.parse(response.body);
        expect(payload.model).toBe('gpt-5.4-mini');
        expect(payload.output).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'function_call',
                call_id: 'call_weather_1',
                name: 'get_weather',
                arguments: JSON.stringify({ city: 'Shanghai' }),
                status: 'completed'
            })
        ]));
    });

    test('marks target selection fallback once and keeps the original Codex provider chain isolated', async () => {
        const apiKey = 'maki_selection_fallback_test';
        const selectionSnapshots = [];
        const providerPoolManager = {
            recordGeminiSchedulingEvent: jest.fn(),
            releaseSlot: jest.fn(),
            markProviderHealthy: jest.fn(),
            markProviderUnhealthy: jest.fn()
        };
        const fallbackGenerateContent = jest.fn().mockResolvedValue({
            id: 'fallback-response',
            object: 'response',
            model: 'gpt-5.4-mini',
            status: 'completed',
            output: []
        });
        mockGetApiServiceWithFallback
            .mockImplementationOnce(async (candidateConfig, candidateModel, options) => {
                selectionSnapshots.push({
                    provider: candidateConfig.MODEL_PROVIDER,
                    model: candidateModel,
                    disableProviderFallback: options.disableProviderFallback
                });
                throw new Error('no Antigravity provider available');
            })
            .mockImplementationOnce(async (candidateConfig, candidateModel, options) => {
                selectionSnapshots.push({
                    provider: candidateConfig.MODEL_PROVIDER,
                    model: candidateModel,
                    disableProviderFallback: options.disableProviderFallback
                });
                return {
                service: { generateContent: fallbackGenerateContent },
                actualProviderType: 'openai-codex-oauth',
                actualModel: 'gpt-6-luna',
                uuid: 'codex-selection-fallback',
                serviceConfig: {
                    customName: 'Codex selection fallback',
                    codexAccountKey: 'codex-account-final',
                    codexEmail: 'final.account@example.com'
                },
                isFallback: false
                };
            });
        const config = {
            MODEL_PROVIDER: 'openai-codex-oauth',
            potluckApiKey: apiKey,
            REQUEST_BODY_MAX_BYTES: 1024 * 1024,
            CREDENTIAL_SWITCH_MAX_RETRIES: 0,
            PROMPT_LOG_MODE: 'none',
            temporaryKeyModelRoutes: [{
                id: 'temporary-antigravity-selection-fallback',
                enabled: true,
                keyHash: hashTemporaryRouteKey(apiKey),
                paths: ['/v1/responses'],
                models: ['gpt-5.4-mini'],
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                fallbackModel: 'gpt-6-luna',
                fallbackToOriginal: true,
                preserveResponseModel: true
            }]
        };
        const request = new FakeRequest({
            model: 'gpt-5.4-mini',
            stream: false,
            input: 'hello fallback'
        });
        const response = new FakeResponse();
        request.start();

        await handleContentGenerationRequest(
            request,
            response,
            null,
            ENDPOINT_TYPE.OPENAI_RESPONSES,
            config,
            null,
            providerPoolManager,
            null,
            '/v1/responses'
        );

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledTimes(2);
        expect(selectionSnapshots).toEqual([
            {
                provider: 'gemini-antigravity',
                model: 'gemini-2.5-flash',
                disableProviderFallback: true
            },
            {
                provider: 'openai-codex-oauth',
                model: 'gpt-6-luna',
                disableProviderFallback: true
            }
        ]);
        expect(fallbackGenerateContent).toHaveBeenCalledTimes(1);
        expect(providerPoolManager.recordGeminiSchedulingEvent).toHaveBeenCalledWith('fallbacks');
        expect(config._temporaryKeyModelRouteResult).toMatchObject({
            actualProviderType: 'openai-codex-oauth',
            actualModel: 'gpt-6-luna',
            providerUuid: 'codex-selection-fallback',
            providerName: 'Codex selection fallback',
            accountIdentity: 'codex-account-final',
            accountEmail: 'final.account@example.com',
            fallbackUsed: true
        });
        expect(mockExecuteHook).toHaveBeenCalledWith(
            'onContentGenerated',
            expect.objectContaining({
                toProvider: 'openai-codex-oauth',
                model: 'gpt-6-luna',
                providerUuid: 'codex-selection-fallback',
                providerName: 'Codex selection fallback',
                accountIdentity: 'codex-account-final',
                accountEmail: 'final.account@example.com'
            })
        );
    });

    test('bypasses Gemini selection and executes Luna once during a statutory workday blackout', async () => {
        jest.useFakeTimers({
            now: new Date('2026-08-18T04:00:00.000Z'),
            doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate']
        });
        const apiKey = 'maki_scheduled_blackout_unary';
        const lunaService = {
            generateContent: jest.fn().mockResolvedValue({
                type: 'response.completed',
                response: {
                    id: 'scheduled-luna-response',
                    object: 'response',
                    model: 'gpt-6-luna',
                    status: 'completed',
                    output: []
                }
            })
        };
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: lunaService,
            actualProviderType: 'openai-codex-oauth',
            actualModel: 'gpt-6-luna',
            uuid: 'scheduled-luna-unary',
            serviceConfig: {
                customName: 'Scheduled Luna unary',
                codexAccountKey: 'scheduled-luna-account',
                codexEmail: 'scheduled-luna@example.com'
            },
            isFallback: false
        });
        const config = {
            MODEL_PROVIDER: 'openai-codex-oauth',
            _originalRequestPath: '/openai-codex-oauth/v1/responses',
            _monitorRequestId: 'scheduled-blackout-unary',
            potluckApiKey: apiKey,
            REQUEST_BODY_MAX_BYTES: 1024 * 1024,
            CREDENTIAL_SWITCH_MAX_RETRIES: 0,
            PROMPT_LOG_MODE: 'none',
            workdayCalendars: {
                'cn-statutory-workday': {
                    timezone: 'Asia/Shanghai',
                    years: { 2026: { holidays: [], makeupWorkdays: [] } }
                }
            },
            temporaryKeyModelRoutes: [{
                id: 'scheduled-blackout-route',
                enabled: true,
                keyHash: hashTemporaryRouteKey(apiKey),
                paths: ['/openai-codex-oauth/v1/responses'],
                modelFamilies: ['gpt-5.3', 'gpt-5.4'],
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                fallbackModel: 'gpt-6-luna',
                fallbackToOriginal: true,
                preserveResponseModel: true,
                targetBlackout: {
                    timezone: 'Asia/Shanghai',
                    calendar: 'cn-statutory-workday',
                    start: '00:00',
                    end: '23:59',
                    modelFamilies: ['gpt-5.4', 'gpt-5.3-codex-spark'],
                    fallbackProviderType: 'openai-codex-oauth',
                    fallbackModel: 'gpt-6-luna'
                }
            }]
        };
        const request = new FakeRequest({ model: 'gpt-5.4-mini', stream: false, input: 'scheduled unary' });
        const response = new FakeResponse();
        const providerPoolManager = {
            recordGeminiSchedulingEvent: jest.fn(),
            releaseSlot: jest.fn(),
            markProviderHealthy: jest.fn()
        };
        request.start();

        await handleContentGenerationRequest(
            request,
            response,
            null,
            ENDPOINT_TYPE.OPENAI_RESPONSES,
            config,
            null,
            providerPoolManager,
            null,
            '/openai-codex-oauth/v1/responses'
        );

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledTimes(1);
        expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(
            expect.objectContaining({ MODEL_PROVIDER: 'openai-codex-oauth' }),
            'gpt-6-luna',
            expect.objectContaining({ disableProviderFallback: true })
        );
        expect(mockGetApiServiceWithFallback.mock.calls.some(([, model]) => model === 'gemini-2.5-flash')).toBe(false);
        expect(providerPoolManager.recordGeminiSchedulingEvent).not.toHaveBeenCalled();
        expect(lunaService.generateContent).toHaveBeenCalledWith('gpt-6-luna', expect.any(Object));
        expect(JSON.parse(response.body).model).toBe('gpt-5.4-mini');
        expect(config._temporaryKeyModelRouteResult).toMatchObject({
            actualProviderType: 'openai-codex-oauth',
            actualModel: 'gpt-6-luna',
            fallbackUsed: true,
            fallbackReason: 'scheduled_blackout',
            targetAttempted: false
        });
        expect(mockExecuteHook.mock.calls.filter(([hookName]) => hookName === 'onContentGenerated')).toHaveLength(1);
    });

    test('bypasses Gemini selection for a scheduled Chat Completions stream without duplicate usage', async () => {
        jest.useFakeTimers({
            now: new Date('2026-08-18T04:00:00.000Z'),
            doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate']
        });
        const apiKey = 'maki_scheduled_blackout_stream';
        const lunaService = {
            generateContentStream: jest.fn(async function* () {
                yield {
                    type: 'response.completed',
                    response: {
                        id: 'scheduled-luna-stream',
                        object: 'response',
                        model: 'gpt-6-luna',
                        status: 'completed',
                        output: []
                    }
                };
            })
        };
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: lunaService,
            actualProviderType: 'openai-codex-oauth',
            actualModel: 'gpt-6-luna',
            uuid: 'scheduled-luna-stream',
            serviceConfig: {
                customName: 'Scheduled Luna stream',
                codexAccountKey: 'scheduled-luna-stream-account',
                codexEmail: 'scheduled-luna-stream@example.com'
            },
            isFallback: false
        });
        const config = {
            MODEL_PROVIDER: 'openai-codex-oauth',
            _originalRequestPath: '/openai-codex-oauth/v1/chat/completions',
            _monitorRequestId: 'scheduled-blackout-stream',
            potluckApiKey: apiKey,
            REQUEST_BODY_MAX_BYTES: 1024 * 1024,
            CREDENTIAL_SWITCH_MAX_RETRIES: 0,
            PROMPT_LOG_MODE: 'none',
            workdayCalendars: {
                'cn-statutory-workday': {
                    timezone: 'Asia/Shanghai',
                    years: { 2026: { holidays: [], makeupWorkdays: [] } }
                }
            },
            temporaryKeyModelRoutes: [{
                id: 'scheduled-blackout-stream-route',
                enabled: true,
                keyHash: hashTemporaryRouteKey(apiKey),
                paths: ['/openai-codex-oauth/v1/chat/completions'],
                modelFamilies: ['gpt-5.3', 'gpt-5.4'],
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                fallbackModel: 'gpt-6-luna',
                fallbackToOriginal: true,
                preserveResponseModel: true,
                targetBlackout: {
                    timezone: 'Asia/Shanghai',
                    calendar: 'cn-statutory-workday',
                    start: '00:00',
                    end: '23:59',
                    modelFamilies: ['gpt-5.4', 'gpt-5.3-codex-spark'],
                    fallbackProviderType: 'openai-codex-oauth',
                    fallbackModel: 'gpt-6-luna'
                }
            }]
        };
        const request = new FakeRequest({
            model: 'gpt-5.3-codex-spark-fast',
            stream: true,
            messages: [{ role: 'user', content: 'scheduled stream' }]
        });
        const response = new FakeResponse();
        request.start();

        await handleContentGenerationRequest(
            request,
            response,
            null,
            ENDPOINT_TYPE.OPENAI_CHAT,
            config,
            null,
            { releaseSlot: jest.fn(), markProviderHealthy: jest.fn() },
            null,
            '/openai-codex-oauth/v1/chat/completions'
        );

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledTimes(1);
        expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(
            expect.objectContaining({ MODEL_PROVIDER: 'openai-codex-oauth' }),
            'gpt-6-luna',
            expect.objectContaining({ disableProviderFallback: true })
        );
        expect(lunaService.generateContentStream).toHaveBeenCalledWith('gpt-6-luna', expect.any(Object));
        expect(response.body).toContain('gpt-5.3-codex-spark-fast');
        expect(response.body).not.toContain('gemini-2.5-flash');
        expect(config._temporaryKeyModelRouteResult).toMatchObject({
            fallbackUsed: true,
            fallbackReason: 'scheduled_blackout',
            targetAttempted: false
        });
        expect(mockExecuteHook.mock.calls.filter(([hookName]) => hookName === 'onContentGenerated')).toHaveLength(1);
    });

    test.each([
        'gpt-5.3',
        'gpt-5.3-fast',
        'gpt-5.4',
        'gpt-5.4-fast',
        'gpt-5.4-mini',
        'gpt-5.4-mini-fast'
    ])('uses Luna directly when Gemini fails for batch model %s', async requestedModel => {
        const apiKey = 'maki_runtime_fallback_to_luna';
        const targetService = {
            generateContent: jest.fn().mockRejectedValue(Object.assign(new Error('Gemini quota exhausted'), {
                response: { status: 429 }
            }))
        };
        const lunaService = {
            generateContent: jest.fn().mockResolvedValue({
                type: 'response.completed',
                response: {
                    id: 'luna-fallback-response',
                    object: 'response',
                    model: 'gpt-6-luna',
                    status: 'completed',
                    output: []
                }
            })
        };
        mockGetApiServiceWithFallback
            .mockResolvedValueOnce({
                service: targetService,
                actualProviderType: 'gemini-antigravity',
                actualModel: 'gemini-2.5-flash',
                uuid: 'antigravity-quota',
                serviceConfig: { customName: 'Antigravity quota' },
                isFallback: false
            })
            .mockResolvedValueOnce({
                service: lunaService,
                actualProviderType: 'openai-codex-oauth',
                actualModel: 'gpt-6-luna',
                uuid: 'codex-luna-fallback',
                serviceConfig: {
                    customName: 'Codex Luna fallback',
                    codexAccountKey: 'luna-account',
                    codexEmail: 'luna@example.com'
                },
                isFallback: true
            });
        const config = {
            MODEL_PROVIDER: 'openai-codex-oauth',
            _originalRequestPath: '/openai-codex-oauth/v1/responses',
            _monitorRequestId: `batch-fallback-${requestedModel}`,
            potluckApiKey: apiKey,
            REQUEST_BODY_MAX_BYTES: 1024 * 1024,
            CREDENTIAL_SWITCH_MAX_RETRIES: 0,
            PROMPT_LOG_MODE: 'none',
            temporaryKeyModelRoutes: [{
                id: 'temporary-antigravity-runtime-fallback',
                enabled: true,
                keyHash: hashTemporaryRouteKey(apiKey),
                paths: ['/openai-codex-oauth/v1/responses'],
                modelFamilies: ['gpt-5.3', 'gpt-5.4'],
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                fallbackModel: 'gpt-6-luna',
                fallbackToOriginal: true,
                preserveResponseModel: true
            }]
        };
        const request = new FakeRequest({
            model: requestedModel,
            stream: false,
            input: 'hello fallback'
        });
        const response = new FakeResponse();
        const providerPoolManager = {
            recordGeminiSchedulingEvent: jest.fn(),
            releaseSlot: jest.fn(),
            markProviderHealthy: jest.fn(),
            markProviderUnhealthy: jest.fn()
        };
        request.start();

        await handleContentGenerationRequest(
            request,
            response,
            null,
            ENDPOINT_TYPE.OPENAI_RESPONSES,
            config,
            null,
            providerPoolManager,
            null,
            '/v1/responses'
        );

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(
            expect.objectContaining({ MODEL_PROVIDER: 'openai-codex-oauth' }),
            'gpt-6-luna',
            expect.objectContaining({ disableProviderFallback: true })
        );
        expect(mockGetApiServiceWithFallback.mock.calls.some(
            ([, selectedModel, options]) => selectedModel === requestedModel
                && options?.preserveRequestedCodexModel === true
        )).toBe(false);
        expect(lunaService.generateContent).toHaveBeenCalledWith('gpt-6-luna', expect.any(Object));
        expect(JSON.parse(response.body)).toMatchObject({
            model: requestedModel,
            status: 'completed'
        });
        expect(config._temporaryKeyModelRouteResult).toMatchObject({
            actualProviderType: 'openai-codex-oauth',
            actualModel: 'gpt-6-luna',
            providerUuid: 'codex-luna-fallback',
            fallbackUsed: true
        });
        expect(providerPoolManager.recordGeminiSchedulingEvent).toHaveBeenCalledWith('fallbacks');
        expect(mockExecuteHook).toHaveBeenCalledWith('onContentGenerated', expect.objectContaining({
            toProvider: 'openai-codex-oauth',
            model: 'gpt-6-luna',
            providerUuid: 'codex-luna-fallback',
            accountEmail: 'luna@example.com',
            _monitorRequestId: `batch-fallback-${requestedModel}`
        }));
        expect(mockExecuteHook.mock.calls.filter(([hookName]) => hookName === 'onContentGenerated')).toHaveLength(1);
    });

    test('routes a Chat Completions stream to Luna after a pre-first-chunk Gemini 429 and emits one final usage hook', async () => {
        const apiKey = 'maki_stream_fallback_to_luna';
        const requestedModel = 'gpt-5.4-mini-fast';
        const targetService = {
            async *generateContentStream() {
                throw Object.assign(new Error('Gemini quota exhausted before first chunk'), {
                    response: { status: 429 }
                });
            }
        };
        const lunaService = {
            generateContentStream: jest.fn(async function* () {
                yield {
                    type: 'response.completed',
                    response: {
                        id: 'luna-stream-fallback',
                        object: 'response',
                        model: 'gpt-6-luna',
                        status: 'completed',
                        output: []
                    }
                };
            })
        };
        mockGetApiServiceWithFallback
            .mockResolvedValueOnce({
                service: targetService,
                actualProviderType: 'gemini-antigravity',
                actualModel: 'gemini-2.5-flash',
                uuid: 'antigravity-stream-quota',
                serviceConfig: { customName: 'Antigravity stream quota' },
                isFallback: false
            })
            .mockResolvedValueOnce({
                service: lunaService,
                actualProviderType: 'openai-codex-oauth',
                actualModel: 'gpt-6-luna',
                uuid: 'codex-luna-stream-fallback',
                serviceConfig: {
                    customName: 'Codex Luna stream fallback',
                    codexAccountKey: 'luna-stream-account',
                    codexEmail: 'luna-stream@example.com'
                },
                isFallback: true
            });
        const requestPath = '/openai-codex-oauth/v1/chat/completions';
        const config = {
            MODEL_PROVIDER: 'openai-codex-oauth',
            _originalRequestPath: requestPath,
            _monitorRequestId: 'batch-stream-fallback',
            potluckApiKey: apiKey,
            REQUEST_BODY_MAX_BYTES: 1024 * 1024,
            CREDENTIAL_SWITCH_MAX_RETRIES: 0,
            PROMPT_LOG_MODE: 'none',
            temporaryKeyModelRoutes: [{
                id: 'temporary-antigravity-stream-runtime-fallback',
                enabled: true,
                keyHash: hashTemporaryRouteKey(apiKey),
                paths: [
                    '/openai-codex-oauth/v1/responses',
                    '/openai-codex-oauth/v1/chat/completions',
                    '/v1/responses',
                    '/v1/chat/completions'
                ],
                modelFamilies: ['gpt-5.3', 'gpt-5.4'],
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                fallbackModel: 'gpt-6-luna',
                fallbackToOriginal: true,
                preserveResponseModel: true
            }]
        };
        const request = new FakeRequest({
            model: requestedModel,
            stream: true,
            messages: [{ role: 'user', content: 'hello fallback stream' }]
        });
        const response = new FakeResponse();
        const providerPoolManager = {
            recordGeminiSchedulingEvent: jest.fn(),
            releaseSlot: jest.fn(),
            markProviderHealthy: jest.fn(),
            markProviderUnhealthy: jest.fn()
        };
        request.start();

        await handleContentGenerationRequest(
            request,
            response,
            null,
            ENDPOINT_TYPE.OPENAI_CHAT,
            config,
            null,
            providerPoolManager,
            null,
            requestPath
        );

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(
            expect.objectContaining({ MODEL_PROVIDER: 'openai-codex-oauth' }),
            'gpt-6-luna',
            expect.objectContaining({ disableProviderFallback: true })
        );
        expect(mockGetApiServiceWithFallback.mock.calls.some(
            ([, selectedModel, options]) => selectedModel === requestedModel
                && options?.preserveRequestedCodexModel === true
        )).toBe(false);
        expect(lunaService.generateContentStream).toHaveBeenCalledWith('gpt-6-luna', expect.any(Object));
        expect(response.body).toContain(requestedModel);
        expect(response.body).not.toContain('gemini-2.5-flash');
        expect(config._temporaryKeyModelRouteResult).toMatchObject({
            actualProviderType: 'openai-codex-oauth',
            actualModel: 'gpt-6-luna',
            providerUuid: 'codex-luna-stream-fallback',
            fallbackUsed: true
        });
        const contentHooks = mockExecuteHook.mock.calls.filter(([hookName]) => hookName === 'onContentGenerated');
        expect(contentHooks).toHaveLength(1);
        expect(contentHooks[0][1]).toMatchObject({
            toProvider: 'openai-codex-oauth',
            model: 'gpt-6-luna',
            providerUuid: 'codex-luna-stream-fallback',
            accountEmail: 'luna-stream@example.com',
            _monitorRequestId: 'batch-stream-fallback',
            isStream: true
        });
    });
});
