import { describe, expect, jest, test } from '@jest/globals';

jest.mock('open', () => ({
    __esModule: true,
    default: jest.fn()
}));

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

describe('Antigravity image payloads', () => {
    test('rejects an absent model instead of mapping it inside the adapter', () => {
        const service = new AntigravityApiService({
            MODEL_PROVIDER: 'gemini-antigravity',
            ANTIGRAVITY_BASE_URL: 'http://127.0.0.1:1',
            PROJECT_ID: 'test-project'
        });
        service.availableModels = ['gemini-3.6-flash-low'];

        const request = {
            model: 'gemini-3.6-flash',
            contents: [{ role: 'user', parts: [{ text: 'hello' }] }]
        };
        expect(() => service.buildAntigravityPayload('gemini-3.6-flash', request))
            .toThrow('模型不存在');
        expect(request.model).toBe('gemini-3.6-flash');
    });

    test('passes the dedicated health-check timeout to the underlying request', async () => {
        const service = new AntigravityApiService({
            MODEL_PROVIDER: 'gemini-antigravity',
            ANTIGRAVITY_BASE_URL: 'https://example.invalid',
            PROJECT_ID: 'test-project',
            HEALTH_CHECK_REQUEST_TIMEOUT_MS: 15_000,
            REQUEST_MAX_RETRIES: 0
        });
        service.authClient.request = jest.fn(async () => ({ data: { ok: true } }));

        await service.callApi('generateContent', { request: {} });

        expect(service.authClient.request).toHaveBeenCalledWith(expect.objectContaining({ timeout: 15_000 }));
    });

    test('preserves explicit official image config without converting legacy size', () => {
        const service = new AntigravityApiService({
            MODEL_PROVIDER: 'gemini-antigravity',
            ANTIGRAVITY_BASE_URL: 'http://127.0.0.1:1',
            PROJECT_ID: 'test-project'
        });
        service.availableModels = ['gemini-3.1-flash-image'];

        const { payload } = service.buildAntigravityPayload('gemini-3.1-flash-image', {
            model: 'gemini-3.1-flash-image',
            contents: [{ role: 'user', parts: [{ text: 'draw a yellow banana on a blue table' }] }],
            generationConfig: {
                imageConfig: {
                    aspectRatio: '16:9',
                    imageSize: '1K'
                }
            },
            _imageSize: '1536x1024',
            _imageQuality: 'high',
            _imageToolOptions: { background: 'transparent', output_format: 'png' }
        });

        expect(payload.request).not.toHaveProperty('_imageSize');
        expect(payload.request).not.toHaveProperty('_imageQuality');
        expect(payload.request).not.toHaveProperty('_imageToolOptions');
        expect(payload.request.contents[0].parts[0].text).toContain('yellow banana');
        expect(payload.request.generationConfig.imageConfig).toMatchObject({
            imageSize: '1K',
            aspectRatio: '16:9'
        });
    });

    test('uses the official 1K default for image models', () => {
        const service = new AntigravityApiService({
            MODEL_PROVIDER: 'gemini-antigravity',
            ANTIGRAVITY_BASE_URL: 'http://127.0.0.1:1',
            PROJECT_ID: 'test-project'
        });
        service.availableModels = ['gemini-3.1-flash-image'];

        const { payload } = service.buildAntigravityPayload('gemini-3.1-flash-image', {
            model: 'gemini-3.1-flash-image',
            contents: [{ role: 'user', parts: [{ text: 'draw a yellow banana' }] }]
        });

        expect(payload.request.generationConfig.imageConfig.imageSize).toBe('1K');
    });
});
