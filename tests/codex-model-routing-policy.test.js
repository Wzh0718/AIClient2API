import { describe, expect, test } from '@jest/globals';
import {
    DEFAULT_CODEX_FALLBACK_MODEL,
    matchesModelFamily,
    resolveCodexEntryModel
} from '../src/providers/openai/codex-model-routing.js';

describe('Codex entry model routing policy', () => {
    test.each(['gpt-5.4', 'gpt-5.4-fast', 'gpt-5.4-mini', 'gpt-5.4-mini-fast'])(
        'routes non-batch %s directly to Luna',
        model => {
            expect(resolveCodexEntryModel({ model, supported: true })).toEqual({
                actualModel: DEFAULT_CODEX_FALLBACK_MODEL,
                reason: 'GPT_54_DIRECT_LUNA'
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

    test('routes unsupported Codex models to Luna', () => {
        expect(resolveCodexEntryModel({ model: 'gpt-does-not-exist', supported: false })).toEqual({
            actualModel: DEFAULT_CODEX_FALLBACK_MODEL,
            reason: 'UNSUPPORTED_MODEL'
        });
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
