jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('google-auth-library', () => ({
    OAuth2Client: jest.fn().mockImplementation(function OAuth2Client() {
        this.on = jest.fn();
        this.setCredentials = jest.fn();
    })
}));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(options => options),
    getRequiredProxyConfigForProvider: jest.fn(() => null),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));
jest.mock('../src/auth/oauth-handlers.js', () => ({ handleGeminiAntigravityOAuth: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: jest.fn(() => null) }));

import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';

const createService = () => {
    const service = Object.create(AntigravityApiService.prototype);
    service.isInitialized = false;
    service.initializationPromise = null;
    service.initializationFailure = null;
    service.initializationFailureUntil = 0;
    service.projectId = 'configured-project';
    return service;
};

describe('Antigravity initialization lifecycle', () => {
    test('caches provider model probes and re-probes after token identity changes', async () => {
        const service = createService();
        service.baseURLs = ['https://example.test'];
        service.projectId = 'project-1';
        service.config = { MODEL_LIST_CACHE_TTL_MS: 60000 };
        service.authClient = {
            credentials: { access_token: 'token-a' },
            request: jest.fn().mockResolvedValue({ data: { models: { 'gemini-3.1-flash-image': {} } } })
        };

        await service.fetchAvailableModels();
        await service.fetchAvailableModels();
        expect(service.authClient.request).toHaveBeenCalledTimes(1);

        service.authClient.credentials.access_token = 'token-b';
        await service.fetchAvailableModels();
        expect(service.authClient.request).toHaveBeenCalledTimes(2);
    });

    test('coalesces concurrent provider model probes', async () => {
        const service = createService();
        service.baseURLs = ['https://example.test'];
        service.projectId = 'project-1';
        service.config = { MODEL_LIST_CACHE_TTL_MS: 60000 };
        let release;
        service.authClient = {
            credentials: { access_token: 'token-a' },
            request: jest.fn(() => new Promise(resolve => {
                release = () => resolve({ data: { models: { 'gemini-3.1-flash-image': {} } } });
            }))
        };

        const first = service.fetchAvailableModels();
        const second = service.fetchAvailableModels();
        await Promise.resolve();
        expect(service.authClient.request).toHaveBeenCalledTimes(1);
        release();
        await Promise.all([first, second]);
    });

    test('schedules a background model probe without blocking initialization', async () => {
        const service = createService();
        service.loadCredentials = jest.fn(async () => {});
        service.discoverProjectAndModels = jest.fn(async fetchModels => {
            expect(fetchModels).toBe(false);
            return 'configured-project';
        });
        service.fetchAvailableModels = jest.fn(async () => {});

        await service._initializeOnce();
        expect(service.fetchAvailableModels).not.toHaveBeenCalled();
        expect(service.isInitialized).toBe(true);

        await new Promise(resolve => setImmediate(resolve));
        expect(service.fetchAvailableModels).toHaveBeenCalledTimes(1);
    });

    test('shares one initialization promise across concurrent callers', async () => {
        const service = createService();
        let resolveDiscovery;
        const discoverProjectAndModels = jest.fn(() => new Promise(resolve => {
            resolveDiscovery = resolve;
        }));
        service.loadCredentials = jest.fn(async () => {});
        service.discoverProjectAndModels = discoverProjectAndModels;

        const first = service._ensureInitialized();
        const second = service._ensureInitialized();
        const third = service._ensureInitialized();
        await Promise.resolve();

        expect(discoverProjectAndModels).toHaveBeenCalledTimes(1);
        expect(first).toBe(second);
        expect(second).toBe(third);

        resolveDiscovery('configured-project');
        await Promise.all([first, second, third]);
        expect(service.isInitialized).toBe(true);
    });

    test('enters a 30 second cooldown after initialization failure', async () => {
        const service = createService();
        const failure = new Error('upstream unavailable');
        service.loadCredentials = jest.fn(async () => {});
        service.discoverProjectAndModels = jest.fn(async () => { throw failure; });

        await expect(service._ensureInitialized()).rejects.toBe(failure);
        expect(service.initializationFailure).toBe(failure);
        expect(service.initializationFailureUntil).toBeGreaterThan(Date.now());

        await expect(service._ensureInitialized()).rejects.toMatchObject({
            code: 'PROVIDER_INITIALIZATION_COOLDOWN',
            statusCode: 503,
            retryAfter: 30,
            cause: failure,
        });
        expect(service.discoverProjectAndModels).toHaveBeenCalledTimes(1);
    });

    test('allows one retry after cooldown and clears failure state on success', async () => {
        const service = createService();
        service.loadCredentials = jest.fn(async () => {});
        service.discoverProjectAndModels = jest
            .fn()
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValueOnce('configured-project');

        await expect(service._ensureInitialized()).rejects.toThrow('temporary failure');
        service.initializationFailureUntil = Date.now() - 1;

        await expect(service._ensureInitialized()).resolves.toBeUndefined();
        expect(service.isInitialized).toBe(true);
        expect(service.initializationFailure).toBeNull();
        expect(service.initializationFailureUntil).toBe(0);
        expect(service.discoverProjectAndModels).toHaveBeenCalledTimes(2);
    });

    test('stream, models, and usage entry points all use the same initialization gate', async () => {
        const service = createService();
        service.loadCredentials = jest.fn(async () => {});
        service.discoverProjectAndModels = jest.fn(async () => 'configured-project');
        service.generateContent = jest.fn(async () => 'content');
        service.generateContentStream = jest.fn(async function* () { yield 'chunk'; });
        service.listModels = jest.fn(async () => []);
        service.getUsageLimits = jest.fn(async () => ({}));

        await service._ensureInitialized();
        await Promise.all([
            service._ensureInitialized(),
            service._ensureInitialized(),
            service._ensureInitialized(),
        ]);

        expect(service.discoverProjectAndModels).toHaveBeenCalledTimes(1);
    });
});
