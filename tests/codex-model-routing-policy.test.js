import { describe, expect, test } from '@jest/globals';
import {
    DEFAULT_CODEX_FALLBACK_MODEL,
    matchesModelFamily,
    resolveCodexEntryModel
} from '../src/providers/openai/codex-model-routing.js';

describe('Codex entry model routing policy', () => {
    test.each(['gpt-5.4-mini', 'gpt-5.4-mini-fast'])(
        'rejects retired GPT-5.4 mini model %s',
        model => {
            expect(() => resolveCodexEntryModel({ model, supported: false }))
                .toThrow(`[Codex] 不支持的模型: ${model}`);
        }
    );

    test.each(['gpt-5.4', 'gpt-5.4-fast'])(
        'rejects retired GPT-5.4 flagship model %s',
        model => {
            expect(() => resolveCodexEntryModel({ model, supported: false }))
                .toThrow(`[Codex] 不支持的模型: ${model}`);
        }
    );

    test.each([
        ['gpt-5.3-codex-spark', 'gpt-6-luna'],
        ['gpt-5.3-codex-spark-fast', 'gpt-6-luna']
    ])('maps retired Spark model %s to %s before the supported check', (model, actualModel) => {
        expect(resolveCodexEntryModel({ model, supported: false })).toEqual({
            actualModel,
            reason: 'SPARK_ALIAS'
        });
    });

    test('rejects bare GPT-5.3 instead of aliasing it to Luna', () => {
        expect(() => resolveCodexEntryModel({ model: 'gpt-5.3', supported: false }))
            .toThrow('[Codex] 不支持的模型: gpt-5.3');
    });

    test('does not default unknown Codex models to Luna', () => {
        expect(DEFAULT_CODEX_FALLBACK_MODEL).toBeNull();
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

    test('still maps Spark for a batch-key Gemini fallback', () => {
        expect(resolveCodexEntryModel({
            model: 'gpt-5.3-codex-spark',
            supported: false,
            preserveRequestedModel: true
        })).toEqual({ actualModel: 'gpt-6-luna', reason: 'SPARK_ALIAS' });
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
