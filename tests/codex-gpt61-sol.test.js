import { Readable } from 'node:stream';
import fs from 'node:fs';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import axios from 'axios';
import { CodexApiService } from '../src/providers/openai/codex-core.js';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';
import { getProviderModels } from '../src/providers/provider-models.js';
import { getCodexModelIds, normalizeCodexReasoningEffort } from '../src/providers/openai/codex-model-capabilities.js';
import { estimateUsageCost, getModelPricing } from '../src/plugins/api-potluck/cost-estimator.js';

jest.mock('axios', () => ({ request: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.mock('../src/auth/oauth-handlers.js', () => ({ refreshCodexTokensWithRetry: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: jest.fn(() => null) }));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(config => config),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
    getProxyConfigForProvider: jest.fn(() => null)
}));

const variants = ['gpt-6.1-sol', 'gpt-6.1-sol-fast', 'gpt-6.1-sol-ultrafast'];
const tiers = ['default', 'priority', 'ultrafast'];
// 出站请求不发送 default 档位（对齐原生 Codex），上游响应仍可回报 default。
const outboundTiers = [undefined, 'priority', 'ultrafast'];
const services = [];
function createService(config = {}) {
    const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth', ...config });
    services.push(service);
    return service;
}
afterEach(() => {
    services.splice(0).forEach(service => service.stopCacheCleanup());
    axios.request.mockReset();
});

describe('GPT-6.1 Sol Codex support', () => {
    test('lists all three variants, preserves older models, and offers the credential override', async () => {
        expect(getCodexModelIds(getProviderModels('openai-codex-oauth'))).toEqual(
            expect.arrayContaining([...variants, 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna'])
        );
        const ui = fs.readFileSync(new URL('../static/app/utils.js', import.meta.url), 'utf8');
        expect(ui).toContain("{ value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }");
        const listed = await createService().listModels();
        expect(listed.data.map(model => model.id)).toEqual(expect.arrayContaining(variants));
    });

    test.each(variants)('%s keeps reasoning independent of speed', async model => {
        const service = createService();
        for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'minimal', 'none', 'invalid', undefined]) {
            const expected = effort === 'minimal' ? 'low'
                : ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : 'medium';
            const body = await service.prepareRequestBody(model, {
                input: 'test', reasoning: { effort }, temperature: 0.2, top_p: 0.8,
                top_logprobs: 1, include: ['reasoning.encrypted_content', 'message.output_text.logprobs']
            }, true);
            expect(body.model).toBe('gpt-6.1-sol');
            expect(body.service_tier).toBe(outboundTiers[variants.indexOf(model)]);
            expect(body.reasoning.effort).toBe(expected);
            expect(body).not.toHaveProperty('temperature');
            expect(body).not.toHaveProperty('top_p');
            expect(body).not.toHaveProperty('top_logprobs');
            expect(body.include).toEqual(['reasoning.encrypted_content']);
            expect(normalizeCodexReasoningEffort(model, effort)).toBe(expected);
        }
    });

    test.each(variants)('%s preserves an explicit non-default tier', async model => {
        const service = createService();
        for (const tier of ['priority', 'fast', 'ultrafast']) {
            const body = await service.prepareRequestBody(model, {
                input: 'test', service_tier: tier, reasoning_effort: 'high'
            }, false);
            expect(body.service_tier).toBe(tier);
            expect(body.reasoning.effort).toBe('high');
            expect(body).not.toHaveProperty('reasoning_effort');
            expect(body.stream).toBe(false);
        }
    });

    test('normalizes against the overridden upstream model, including legacy speed requests', async () => {
        const service = createService({ codexGpt6OverrideEnabled: true, codexGpt6OverrideModel: 'gpt-6.1-sol' });
        const body = await service.prepareRequestBody('gpt-5.6-sol-fast', {
            input: 'test', reasoning: { effort: 'low' }, temperature: 0.5
        }, true);
        expect(body.model).toBe('gpt-6.1-sol');
        expect(body.service_tier).toBe('priority');
        expect(body.reasoning.effort).toBe('low');
        expect(body).not.toHaveProperty('temperature');
        const defaultBody = await service.prepareRequestBody('gpt-6.1-sol-fast', {
            input: 'test', reasoning: { effort: 'medium' }, reasoning_effort: 'high'
        }, true);
        expect(defaultBody.reasoning.effort).toBe('medium');
        expect(normalizeCodexReasoningEffort('gpt-6-astra-fast', 'low')).toBe('xhigh');
        expect(normalizeCodexReasoningEffort('gpt-5.6-sol-fast', 'low')).toBe('xhigh');
        expect(normalizeCodexReasoningEffort('gpt-6-sol', 'none')).toBe('none');
    });

    test.each(variants)('%s passes Chat and Responses image/tool requests through a mocked upstream', async model => {
        const converter = new CodexConverter();
        const service = createService();
        service.isInitialized = true;
        service.accessToken = 'mock-token';
        const completed = {
            type: 'response.completed',
            response: { id: 'resp_mock', model: 'gpt-6.1-sol', status: 'completed',
                service_tier: tiers[variants.indexOf(model)],
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '2' }] }],
                usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } }
        };
        const imageUrl = 'https://example.com/mock-image.png';
        const tools = [{ type: 'function', function: { name: 'probe', parameters: { type: 'object', properties: {} } } }];
        const chat = converter.toOpenAIRequestToCodexRequest({ model, reasoning_effort: 'low', tools,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'test' },
                { type: 'image_url', image_url: { url: imageUrl } }] }]
        }, `chat-${model}`);
        axios.request.mockResolvedValueOnce({ data: JSON.stringify(completed) });
        const response = await service.generateContent(model, chat);
        expect(response.type).toBe('response.completed');
        const output = converter.toOpenAIResponse(response, model, `chat-${model}`);
        expect(output.choices[0].message.content).toBe('2');
        const chatBody = axios.request.mock.calls[0][0].data;
        expect(chatBody.model).toBe('gpt-6.1-sol');
        expect(chatBody.service_tier).toBe(outboundTiers[variants.indexOf(model)]);
        expect(chatBody.reasoning.effort).toBe('low');
        expect(chatBody.input[0].content).toContainEqual({ type: 'input_image', image_url: imageUrl });
        expect(chatBody.tools[0]).toMatchObject({ type: 'function', name: 'probe' });

        const responses = converter.toOpenAIResponsesToCodexRequest({ model, reasoning: { effort: 'high' },
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'test' },
                { type: 'input_image', image_url: imageUrl }] }],
            tools: [{ type: 'function', name: 'probe', parameters: { type: 'object', properties: {} } }]
        }, `responses-${model}`);
        axios.request.mockResolvedValueOnce({ data: Readable.from([
            `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '2' })}\n\n`,
            `data: ${JSON.stringify(completed)}\n\n`
        ]) });
        const events = [];
        for await (const event of service.generateContentStream(model, responses)) events.push(event);
        expect(events.at(-1).type).toBe('response.completed');
        const streamBody = axios.request.mock.calls[1][0].data;
        expect(streamBody.model).toBe('gpt-6.1-sol');
        expect(streamBody.reasoning.effort).toBe('high');
        expect(streamBody.service_tier).toBe(outboundTiers[variants.indexOf(model)]);
        expect(streamBody.input[0].content[1]).toEqual({ type: 'input_image', image_url: imageUrl });
        expect(streamBody.tools[0]).toMatchObject({ type: 'function', name: 'probe' });
        expect(axios.request).toHaveBeenCalledTimes(2);
    });

    test.each(variants)('%s uses project pricing without cache writes or long-context premiums', model => {
        expect(getModelPricing(model)).toMatchObject({ input: 2, cachedInput: 0.1, output: 10 });
        const usage = { promptTokens: 1_000_000, cachedTokens: 250_000, completionTokens: 100_000,
            totalTokens: 1_100_000, cacheWriteTokens: 50_000 };
        const cost = estimateUsageCost(usage, model);
        expect(cost.usd).toBeCloseTo(2.525 * [1, 2, 6][variants.indexOf(model)], 10);
        expect(cost.missingPriceTokens).toBe(0);
        expect(cost.estimatedPriceTokens).toBe(0);
    });

    test('surfaces a mocked upstream terminal failure for GPT-6.1 Sol', async () => {
        const service = createService();
        service.isInitialized = true;
        service.accessToken = 'mock-token';
        axios.request.mockResolvedValueOnce({ data: Readable.from([
            `data: ${JSON.stringify({ type: 'response.failed', response: { error: {
                type: 'invalid_request_error', code: 'invalid_request_error', message: 'Mock invalid request'
            } } })}\n\n`
        ]) });
        const events = [];
        await expect((async () => {
            for await (const event of service.generateContentStream('gpt-6.1-sol', { input: 'test' })) events.push(event);
        })()).rejects.toMatchObject({ response: { status: 400 } });
        expect(events.some(event => event.type === 'response.completed')).toBe(false);
        expect(axios.request).toHaveBeenCalledTimes(1);
    });
});
