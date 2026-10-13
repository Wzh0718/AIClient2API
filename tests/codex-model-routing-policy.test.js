import { describe, expect, test } from '@jest/globals';
import {
    DEFAULT_CODEX_FALLBACK_MODEL,
    createUnsupportedCodexModelError,
    matchesModelFamily,
    resolveCodexEntryModel
} from '../src/providers/openai/codex-model-routing.js';

describe('Codex entry model routing policy', () => {
    test.each([false, true])('maps Image 2.5 to flare with preserveRequestedModel=%s', preserveRequestedModel => {
        expect(resolveCodexEntryModel({
            model: 'gpt-image-2.5', supported: false, preserveRequestedModel
        })).toEqual({ actualModel: 'gpt-image-2.5-flare', reason: 'IMAGE_MODEL_ALIAS' });
    });

    test.each(['gpt-image-2.5-fast', 'gpt-image-2.5-ultrafast', 'gpt-image-2.5-2026-09-08'])(
        'does not register an additional Image 2.5 alias %s', model => {
            expect(() => resolveCodexEntryModel({ model, supported: false })).toThrow('不支持的模型');
        }
    );

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

    test('reports an unsupported model as a 400 client error instead of a 500', () => {
        let caught;
        try {
            resolveCodexEntryModel({ model: 'not-a-real-model', supported: false });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(caught.message).toBe('[Codex] 不支持的模型: not-a-real-model');
        expect(caught.status).toBe(400);
        expect(caught.statusCode).toBe(400);
        expect(caught.code).toBe('model_not_found');
        expect(createUnsupportedCodexModelError('x').status).toBe(400);
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
