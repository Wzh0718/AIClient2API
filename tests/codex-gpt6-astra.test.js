import { describe, expect, test } from '@jest/globals';

import {
    normalizeCodexReasoningEffort,
    sanitizeCodexModelParameters,
    getCodexModelIds
} from '../src/providers/openai/codex-model-capabilities.js';
import { getProviderModels } from '../src/providers/provider-models.js';
import { getModelPricing, estimateUsageCost } from '../src/plugins/api-potluck/cost-estimator.js';

describe('GPT-6 Astra Codex support', () => {
    test('registers GPT-6 Astra and its Codex fast variant', () => {
        const models = getProviderModels('openai-codex-oauth');
        expect(models).toContain('gpt-6-astra');

        expect(getCodexModelIds(models)).toEqual(expect.arrayContaining([
            'gpt-6-astra',
            'gpt-6-astra-fast'
        ]));
    });

    test.each(['low', 'medium', 'high', 'xhigh', 'max'])('preserves supported reasoning effort %s', (effort) => {
        expect(normalizeCodexReasoningEffort('gpt-6-astra', effort)).toBe(effort);
    });

    test('maps GPT-6 Astra minimal reasoning to low instead of unsupported none', () => {
        expect(normalizeCodexReasoningEffort('gpt-6-astra', 'minimal')).toBe('low');
        expect(normalizeCodexReasoningEffort('gpt-6-astra-fast', 'minimal', true)).toBe('xhigh');
    });

    test('removes unsupported sampling parameters only for GPT-6 Astra', () => {
        const gpt6Body = sanitizeCodexModelParameters('gpt-6-astra', {
            temperature: 0.2,
            top_p: 0.8,
            top_logprobs: 3,
            include: ['reasoning.encrypted_content', 'message.output_text.logprobs'],
            input: 'hello'
        });
        expect(gpt6Body).toEqual({
            include: ['reasoning.encrypted_content'],
            input: 'hello'
        });

        const legacyBody = sanitizeCodexModelParameters('gpt-5.6-sol', {
            temperature: 0.2,
            top_p: 0.8,
            input: 'hello'
        });
        expect(legacyBody).toEqual({
            temperature: 0.2,
            top_p: 0.8,
            input: 'hello'
        });
    });

    test('uses official GPT-6 Astra standard token pricing and official fast multiplier', () => {
        expect(getModelPricing('gpt-6-astra')).toMatchObject({
            input: 10,
            cachedInput: 1,
            output: 50,
            source: 'official'
        });

        const standard = estimateUsageCost({
            promptTokens: 1000000,
            cachedTokens: 100000,
            completionTokens: 100000,
            totalTokens: 1100000
        }, 'gpt-6-astra');
        const fast = estimateUsageCost({
            promptTokens: 1000000,
            cachedTokens: 100000,
            completionTokens: 100000,
            totalTokens: 1100000
        }, 'gpt-6-astra-fast');

        expect(standard.missingPriceTokens).toBe(0);
        expect(fast.missingPriceTokens).toBe(0);
        expect(fast.priceMultiplier).toBe(2);
        expect(fast.usd).toBeCloseTo(standard.usd * 2, 8);
    });
});
