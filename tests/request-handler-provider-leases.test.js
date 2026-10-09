import { EventEmitter } from 'events';
import requestContext from '../src/utils/context.js';
import { getProviderLeaseScope, registerProviderLease } from '../src/runtime/provider-lease-scope.js';
import { createRequestHandler } from '../src/handlers/request-handler.js';
import { handleAPIRequests } from '../src/services/api-manager.js';

jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    runWithContext: (_id, callback) => callback()
} }));
jest.mock('../src/utils/common.js', () => ({
    getClientIp: () => ({ clientIp: '127.0.0.1', peerIp: '127.0.0.1' }),
    getRequestBody: jest.fn(),
    handleError: (res, error) => { res.statusCode = error.status || 500; res.end('{}'); }
}));
jest.mock('../src/services/ui-manager.js', () => ({ handleUIApiRequests: async () => false, serveStaticFiles: async () => false }));
jest.mock('../src/services/api-manager.js', () => ({ handleAPIRequests: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getApiService: jest.fn(), getProviderStatus: jest.fn(), getProviderPoolManager: () => null }));
jest.mock('../src/providers/adapter.js', () => ({ getRegisteredProviders: () => ['openai-codex-oauth'], isRegisteredProvider: type => type === 'openai-codex-oauth' }));
jest.mock('../src/utils/grok-assets-proxy.js', () => ({ handleGrokAssetsProxy: jest.fn() }));
jest.mock('../src/core/config-manager.js', () => ({ PROMPT_LOG_FILENAME: null }));
jest.mock('../src/core/plugin-manager.js', () => ({ getPluginManager: () => ({
    isPluginStaticPath: () => false, getPluginByStaticPath: () => null,
    executeRoutes: async () => false, executeAuth: async () => ({ authorized: true }),
    executeMiddleware: async () => ({ handled: false }), executeHook: async () => {}
}) }));

class Response extends EventEmitter {
    constructor() { super(); this.statusCode = 200; this.headers = {}; }
    setHeader(name, value) { this.headers[name] = value; }
    writeHead(status) { this.statusCode = status; }
    write() { return true; }
    end() { this.writableEnded = this.writableFinished = true; this.emit('finish'); }
}

describe('HTTP terminal cleanup of provider leases', () => {
    test.each(['unary', 'stream', 'conversion_error', 'client_close', 'returned_without_response'])('%s releases the captured request resources exactly once', async scenario => {
        const coordinator = { workerId: 'w1', release: jest.fn(async () => true) };
        let store;
        handleAPIRequests.mockImplementationOnce(async (_method, _path, _req, res) => {
            store = requestContext.getStore();
            await registerProviderLease(getProviderLeaseScope(), coordinator,
                { leaseId: 'attempt-one', providerType: 'openai-codex-oauth', uuid: 'one' }, 'model');
            if (scenario === 'conversion_error') throw new Error('request conversion failed');
            if (scenario === 'client_close') {
                // A close event may be emitted from a different async request context.
                requestContext.run({}, () => res.emit('close'));
            } else if (scenario !== 'returned_without_response') {
                if (scenario === 'stream') res.write('chunk');
                res.end();
            }
            return true;
        });
        const req = new EventEmitter();
        Object.assign(req, { method: 'POST', url: '/v1/responses', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } });
        const res = new Response();
        await createRequestHandler({ MODEL_PROVIDER: 'openai-codex-oauth', UI_ENABLED: false }, null)(req, res);
        res.emit('finish'); res.emit('close');
        await new Promise(resolve => setImmediate(resolve));
        expect(coordinator.release).toHaveBeenCalledTimes(1);
        expect(coordinator.release).toHaveBeenCalledWith('attempt-one');
        expect(getProviderLeaseScope(store).closed).toBe(true);
        expect(getProviderLeaseScope(store).leases.size).toBe(0);
    });
});
