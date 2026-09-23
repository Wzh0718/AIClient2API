import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { CodexApiService } from '../src/providers/openai/codex-core.js';
import { getProviderModels } from '../src/providers/provider-models.js';
import { getCodexModelIds, normalizeCodexReasoningEffort, resolveCodexOutboundModel } from '../src/providers/openai/codex-model-capabilities.js';
import { getModelPricing } from '../src/plugins/api-potluck/cost-estimator.js';
import { beginRequestAttempt, finishRequestAttempt, getSuccessfulOutboundModel } from '../src/utils/request-attempts.js';

jest.mock('../src/auth/oauth-handlers.js', () => ({ refreshCodexTokensWithRetry: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: jest.fn(() => null) }));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(config => config),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
    getProxyConfigForProvider: jest.fn(() => null)
}));

const services = [];
afterEach(() => services.splice(0).forEach(service => service.stopCacheCleanup()));

async function prepare(model, config = {}, body = {}, stream = true) {
    const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth', ...config });
    services.push(service);
    return service.prepareRequestBody(model, { model, input: 'hello', ...body }, stream);
}

describe('Codex GPT-6 catalog and credential override', () => {
    test('advertises only base Sol and Luna IDs and retires GPT-5.5', () => {
        const models = getCodexModelIds(getProviderModels('openai-codex-oauth'));
        expect(models).toEqual(expect.arrayContaining(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']));
        expect(models).not.toEqual(expect.arrayContaining(['gpt-5.5']));
        expect(models).not.toContain('gpt-5.5-fast');
        expect(models).not.toContain('gpt-6-sol-fast');
        expect(models).not.toContain('gpt-6-luna-fast');
        expect(getModelPricing('gpt-5.5')).toBeTruthy();
        expect(getModelPricing('gpt-6-sol')).toMatchObject({ input: 2, cachedInput: 0.2, output: 10 });
        expect(getModelPricing('gpt-6-luna')).toMatchObject({ input: 0.1, cachedInput: 0.01, output: 0.5 });
    });

    test.each(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])('pins GPT text requests to %s when enabled', async target => {
        const config = { codexGpt6OverrideEnabled: true, codexGpt6OverrideModel: target };
        expect((await prepare('gpt-5.6-sol', config, { temperature: 0.2, reasoning: { effort: 'minimal' } })).model).toBe(target);
        const unary = await prepare('gpt-5.6-terra', config, {}, false);
        expect(unary.model).toBe(target);
        expect(unary.stream).toBe(false);
    });

    test('defaults off, defaults target to Luna when enabled, and excludes images', async () => {
        expect((await prepare('gpt-5.6-sol')).model).toBe('gpt-5.6-sol');
        expect((await prepare('gpt-5.6-sol', { codexGpt6OverrideEnabled: true })).model).toBe('gpt-6-luna');
        const image = await prepare('gpt-image-2', { codexGpt6OverrideEnabled: true, codexGpt6OverrideModel: 'gpt-6-astra' });
        expect(image.model).toBe('gpt-5.6-luna');
        expect(image.tools).toEqual([{ type: 'image_generation', model: 'gpt-image-2' }]);
        expect(resolveCodexOutboundModel('gpt-image-2.5', { codexGpt6OverrideEnabled: true })).toBe('gpt-image-2.5');
        expect(() => resolveCodexOutboundModel('gpt-5.6-sol', {
            codexGpt6OverrideEnabled: true,
            codexGpt6OverrideModel: 'gpt-6'
        })).toThrow('无效的 GPT-6 上游目标模型');
    });

    test('rejects retired GPT-5.5 before any upstream request', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });
        service.isInitialized = true;
        services.push(service);
        await expect(service.generateContent('gpt-5.5', { input: 'hello' }))
            .rejects.toThrow('不支持的模型: gpt-5.5');
    });

    test('sanitizes parameters and reasoning for the final outbound model', async () => {
        const body = await prepare('gpt-5.6-terra', {
            codexGpt6OverrideEnabled: true,
            codexGpt6OverrideModel: 'gpt-6-astra'
        }, { temperature: 0.2, top_p: 0.8, top_logprobs: 1, reasoning: { effort: 'minimal' } });
        expect(body).not.toHaveProperty('temperature');
        expect(body).not.toHaveProperty('top_p');
        expect(body).not.toHaveProperty('top_logprobs');
        expect(body.reasoning.effort).toBe('low');
        expect(normalizeCodexReasoningEffort('gpt-6-sol', 'none')).toBe('none');
        expect(normalizeCodexReasoningEffort('gpt-6-luna', 'minimal')).toBe('low');
        const noneBody = await prepare('gpt-6-sol', {}, { reasoning: { effort: 'none' }, temperature: 0.2 });
        expect(noneBody.temperature).toBe(0.2);
    });

    test('uses a successful reported model for pricing, then the outbound model', () => {
        const request = {};
        finishRequestAttempt(beginRequestAttempt(request, { outboundModel: 'gpt-6-astra' }), {
            status: 'error', upstreamResponseModel: 'gpt-6-luna'
        });
        expect(getSuccessfulOutboundModel(request, { requireOverride: true })).toBeNull();
        const success = beginRequestAttempt(request, { outboundModel: 'gpt-6-sol', modelOverrideApplied: true });
        finishRequestAttempt(success, { status: 'success' });
        expect(getSuccessfulOutboundModel(request)).toBe('gpt-6-sol');
        finishRequestAttempt(success, { status: 'success', upstreamResponseModel: 'gpt-6-luna' });
        expect(getSuccessfulOutboundModel(request)).toBe('gpt-6-luna');
        expect(getSuccessfulOutboundModel(request, { requireOverride: true })).toBe('gpt-6-luna');
    });
});
