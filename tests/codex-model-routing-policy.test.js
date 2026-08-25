import { describe, expect, test } from '@jest/globals';
import {
    DEFAULT_CODEX_FALLBACK_MODEL,
    matchesModelFamily,
    resolveCodexEntryModel
} from '../src/providers/openai/codex-model-routing.js';

describe('Codex entry model routing policy', () => {
    test.each(['gpt-5.4', 'gpt-5.4-fast', 'gpt-5.4-mini', 'gpt-5.4-mini-fast'])(
        'keeps GPT-5.4 family %s unchanged',
        model => {
            expect(resolveCodexEntryModel({ model, supported: true })).toEqual({
                actualModel: model,
                reason: null
            });
        }
    );

    test.each(['gpt-5.3', 'gpt-5.3-codex-spark', 'gpt-5.3-codex-spark-fast'])(
        'keeps supported GPT-5.3 family model %s before quota evaluation',
        model => {
            expect(resolveCodexEntryModel({ model, supported: true })).toEqual({
                actualModel: model,
                reason: null
            });
        }
    );

    test('reports unsupported Codex models as errors', () => {
        expect(() => resolveCodexEntryModel({ model: 'gpt-does-not-exist', supported: false }))
            .toThrow('[Codex] 不支持的模型: gpt-does-not-exist');
    });

    test('preserves the original Codex model for a batch-key Gemini fallback', () => {
        expect(resolveCodexEntryModel({
            model: 'gpt-5.4-mini-fast',
            supported: true,
            preserveRequestedModel: true
        })).toEqual({ actualModel: 'gpt-5.4-mini-fast', reason: null });
    });

    test.each([
        ['gpt-5.4', true],
        ['gpt-5.4-mini', true],
        ['gpt-5.40', false],
        ['gpt-5.4foo', false],
        ['my-gpt-5.4', false]
    ])('matches family boundary for %s', (model, expected) => {
        expect(matchesModelFamily(model, 'gpt-5.4')).toBe(expected);
    });
});
