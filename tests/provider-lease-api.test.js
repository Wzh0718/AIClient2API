import { handleUIApiRequests } from '../src/services/ui-manager.js';
import { checkAuth } from '../src/ui-modules/auth.js';

jest.mock('../src/ui-modules/auth.js', () => ({ checkAuth: jest.fn() }));
// Keep unrelated management integrations out of this route contract test.
jest.mock('../src/ui-modules/config-api.js', () => ({}));
jest.mock('../src/ui-modules/provider-api.js', () => ({}));
jest.mock('../src/ui-modules/usage-api.js', () => ({}));
jest.mock('../src/ui-modules/plugin-api.js', () => ({}));
jest.mock('../src/ui-modules/upload-config-api.js', () => ({}));
jest.mock('../src/ui-modules/system-api.js', () => ({}));
jest.mock('../src/ui-modules/update-api.js', () => ({}));
jest.mock('../src/ui-modules/oauth-api.js', () => ({}));
jest.mock('../src/ui-modules/custom-models-api.js', () => ({}));
jest.mock('../src/ui-modules/access-api.js', () => ({}));
jest.mock('../src/ui-modules/event-broadcast.js', () => ({}));
jest.mock('../src/ui-modules/proxy-pool-api.js', () => ({}));

function response() {
    return { statusCode: 200, headers: {},
        setHeader(name, value) { this.headers[name] = value; },
        writeHead(code) { this.statusCode = code; },
        end(body) { this.body = JSON.parse(body); } };
}

describe('admin provider lease diagnostics', () => {
    test('rejects ordinary unauthenticated calls without querying Redis', async () => {
        checkAuth.mockResolvedValue(false);
        const query = jest.fn();
        const res = response();
        await handleUIApiRequests('GET', '/api/provider-leases', { url: '/api/provider-leases', headers: {} }, res, {}, { coordination: { listProviderLeases: query } });
        expect(res.statusCode).toBe(401);
        expect(query).not.toHaveBeenCalled();
    });
    test('returns the current epoch snapshot through the authenticated management route', async () => {
        checkAuth.mockResolvedValue(true);
        const snapshot = { epoch: 'current', leases: [], accounts: [], total: 0, truncated: false };
        const query = jest.fn(async () => snapshot);
        const res = response();
        await handleUIApiRequests('GET', '/api/provider-leases', { url: '/api/provider-leases?providerType=p&providerUuid=one' }, res, {}, { coordination: { listProviderLeases: query } });
        expect(query).toHaveBeenCalledWith({ providerType: 'p', providerUuid: 'one' });
        expect(res.headers['Cache-Control']).toBe('no-store');
        expect(res.body).toEqual(snapshot);
    });
    test.each([null, { listProviderLeases: async () => { throw new Error('private Redis connection details'); } }])('does not report a Redis failure as empty occupancy', async coordination => {
        checkAuth.mockResolvedValue(true);
        const res = response();
        await handleUIApiRequests('GET', '/api/provider-leases', { url: '/api/provider-leases' }, res, {}, { coordination });
        expect(res.statusCode).toBe(503);
        expect(res.body.error.code).toBe('COORDINATION_UNAVAILABLE');
        expect(JSON.stringify(res.body)).not.toContain('private Redis');
    });
});
