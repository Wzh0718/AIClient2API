import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { CodexApiService } from '../src/providers/openai/codex-core.js';

jest.mock('../src/auth/oauth-handlers.js', () => ({
    refreshCodexTokensWithRetry: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(config => config),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
    getProxyConfigForProvider: jest.fn(() => null)
}));

let consoleSpies = [];

beforeEach(() => {
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
});

describe('Codex image generation tool options', () => {
    test('routes gpt-image-2 through gpt-6-luna while preserving the external image model', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-image-2', {
                model: 'gpt-image-2',
                input: [{
                    role: 'user',
                    content: [{ type: 'input_text', text: 'draw one green circle' }]
                }]
            }, false);

            expect(body.model).toBe('gpt-6-luna');
            expect(body.tools).toEqual([{ type: 'image_generation', model: 'gpt-image-2' }]);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test.each([
        ['gpt-image-2.5-flare', 'gpt-image-2.5-flare'],
        ['gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst'],
        ['gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.5-flare-2026-09-08'],
        ['gpt-image-2.5-flare-fast', 'gpt-image-2.5-flare']
    ])('routes %s through gpt-6-luna with the requested image tool model', async (requestedModel, toolModel) => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody(requestedModel, {
                model: requestedModel,
                input: [{
                    role: 'user',
                    content: [{ type: 'input_text', text: 'draw one green circle' }]
                }]
            }, false);

            expect(body.model).toBe('gpt-6-luna');
            expect(body.tools).toEqual([{ type: 'image_generation', model: toolModel }]);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('does not treat flavorless gpt-image-2.5 as a hosted image model', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-image-2.5', {
                model: 'gpt-image-2.5',
                input: [{
                    role: 'user',
                    content: [{ type: 'input_text', text: 'hello' }]
                }]
            }, true);

            expect(body.model).toBe('gpt-image-2.5');
            expect(body.tools?.some(tool => tool.type === 'image_generation' && tool.model === 'gpt-image-2.5')).toBeFalsy();
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('routes gpt-image-2-fast through the same gpt-6-luna image shell', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-image-2-fast', {
                model: 'gpt-image-2-fast',
                input: [{
                    role: 'user',
                    content: [{ type: 'input_text', text: 'draw one green circle' }]
                }]
            }, false);

            expect(body.model).toBe('gpt-6-luna');
            expect(body.tools).toEqual([{ type: 'image_generation', model: 'gpt-image-2' }]);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('does not rewrite ordinary Codex models when preparing image-capable requests', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-5.5', {
                model: 'gpt-5.5',
                input: [{
                    role: 'user',
                    content: [{ type: 'input_text', text: 'hello' }]
                }]
            }, true);

            expect(body.model).toBe('gpt-5.5');
            expect(body.model).not.toBe('gpt-6-luna');
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('maps internal image quality onto the image_generation tool', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-image-2', {
                model: 'gpt-image-2',
                input: [{
                    role: 'user',
                    content: [{ type: 'input_text', text: 'draw one green circle' }]
                }],
                _imageSize: '1024x1024',
                _imageQuality: 'medium',
                _imagePromptConstraintApplied: true
            }, false);

            expect(body.tools).toEqual([{
                type: 'image_generation',
                model: 'gpt-image-2',
                size: '1024x1024',
                quality: 'medium'
            }]);
            expect(body._imageSize).toBeUndefined();
            expect(body._imageQuality).toBeUndefined();
            expect(body._imagePromptConstraintApplied).toBeUndefined();
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('maps internal image tool options onto the image_generation tool', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-image-2', {
                model: 'gpt-image-2',
                input: [{
                    role: 'user',
                    content: [{ type: 'input_text', text: 'draw one green circle' }]
                }],
                _imageToolOptions: {
                    size: '1024x1024',
                    quality: 'high',
                    background: 'transparent',
                    output_format: 'webp',
                    moderation: 'auto',
                    output_compression: 80,
                    partial_images: 2
                }
            }, false);

            expect(body.tools).toEqual([{
                type: 'image_generation',
                model: 'gpt-image-2',
                size: '1024x1024',
                quality: 'high',
                background: 'transparent',
                output_format: 'webp',
                moderation: 'auto',
                output_compression: 80,
                partial_images: 2
            }]);
            expect(body._imageToolOptions).toBeUndefined();
        } finally {
            service.stopCacheCleanup();
        }
    });

    test.each([
        { type: 'function', name: 'image_gen.imagegen', description: 'Generate image', parameters: { type: 'object', properties: {} } },
        { type: 'function', name: 'image_gen__imagegen', description: 'Generate image', parameters: { type: 'object', properties: {} } },
        { type: 'function', function: { name: 'image_gen.imagegen', description: 'Generate image', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'image_gen__imagegen', description: 'Generate image', parameters: { type: 'object', properties: {} } } }
    ])('does not add hosted image_generation when an image generation function is already present', async (imageFunctionTool) => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-5.4', {
                model: 'gpt-5.4',
                input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
                tools: [imageFunctionTool]
            }, true);

            expect(body.tools).toContainEqual(imageFunctionTool);
            expect(body.tools.filter(tool => tool.type === 'image_generation')).toHaveLength(0);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('keeps default image_generation injection for unrelated functions', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-5.4', {
                model: 'gpt-5.4',
                input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
                tools: [{ type: 'function', name: 'lookup_weather', parameters: { type: 'object', properties: {} } }]
            }, true);

            expect(body.tools.filter(tool => tool.type === 'image_generation')).toHaveLength(1);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('does not duplicate an existing hosted image_generation tool', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-5.4', {
                model: 'gpt-5.4',
                input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
                tools: [{ type: 'image_generation', output_format: 'webp' }]
            }, true);

            expect(body.tools.filter(tool => tool.type === 'image_generation')).toEqual([
                { type: 'image_generation', output_format: 'webp' }
            ]);
        } finally {
            service.stopCacheCleanup();
        }
    });

    test('injects hosted image_generation for retired Spark model names the same as other Codex models', async () => {
        const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });

        try {
            const body = await service.prepareRequestBody('gpt-5.3-codex-spark', {
                model: 'gpt-5.3-codex-spark',
                input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
            }, true);

            expect(body.tools.some(tool => tool.type === 'image_generation')).toBe(true);
        } finally {
            service.stopCacheCleanup();
        }
    });
});
