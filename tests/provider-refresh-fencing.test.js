import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['test']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));

describe('provider refresh fencing', () => {
    afterEach(() => jest.clearAllMocks());

    test('does not refresh when another worker owns the refresh lock', async () => {
        const coordination = { acquireRefreshFence: jest.fn(async () => null) };
        const manager = new ProviderPoolManager({ test: [{ uuid: 'one' }] }, {
            coordination,
            persistenceEnabled: false
        });
        await expect(manager._refreshNodeToken('test', manager.providerStatus.test[0], true)).resolves.toBe(false);
        expect(coordination.acquireRefreshFence).toHaveBeenCalled();
    });

    test('validates the fencing token before accepting refreshed state', async () => {
        const coordination = {
            acquireRefreshFence: jest.fn(async () => 7),
            validateRefreshFence: jest.fn(async () => false),
            releaseRefreshFence: jest.fn(async () => true)
        };
        const serviceAdapterFactory = jest.fn(() => ({
            refreshToken: jest.fn(async () => true),
            forceRefreshToken: jest.fn(async () => true)
        }));
        const manager = new ProviderPoolManager({ test: [{ uuid: 'one' }] }, {
            coordination,
            persistenceEnabled: false,
            serviceAdapterFactory
        });
        const status = manager.providerStatus.test[0];

        await expect(manager._refreshNodeToken('test', status, true)).rejects.toMatchObject({ code: 'STALE_REFRESH_FENCE' });
        expect(status.config.lastRefreshTime).toBeFalsy();
        expect(coordination.releaseRefreshFence).toHaveBeenCalledWith('test', 'one', 7);
    });

    test('failed token refresh records a retry cooldown without changing lastRefreshTime', async () => {
        const serviceAdapterFactory = jest.fn(() => ({
            refreshToken: jest.fn(async () => { throw new Error('temporary refresh failure'); }),
            forceRefreshToken: jest.fn(async () => { throw new Error('temporary refresh failure'); })
        }));
        const manager = new ProviderPoolManager({ test: [{ uuid: 'one' }] }, {
            persistenceEnabled: false,
            serviceAdapterFactory
        });
        const status = manager.providerStatus.test[0];
        status.config.lastRefreshTime = 123;

        await expect(manager._refreshNodeToken('test', status, true)).rejects.toThrow('temporary refresh failure');

        expect(status.config.lastRefreshTime).toBe(123);
        expect(status.config.lastRefreshAttemptTime).toEqual(expect.any(Number));
    });

    test('antigravity refresh rejects a successful adapter result when the credential file remains expired', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-refresh-'));
        const credentialPath = path.join(tempDir, 'oauth.json');
        fs.writeFileSync(credentialPath, JSON.stringify({
            access_token: 'expired-access-token',
            refresh_token: 'refresh-token',
            expiry_date: Date.now() - 60_000
        }));
        const manager = new ProviderPoolManager({ 'gemini-antigravity': [{
            uuid: 'one',
            ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: credentialPath,
            needsRefresh: true
        }] }, {
            persistenceEnabled: false,
            serviceAdapterFactory: () => ({
                refreshToken: jest.fn(async () => true),
                forceRefreshToken: jest.fn(async () => true)
            })
        });

        const status = manager.providerStatus['gemini-antigravity'][0];
        await expect(manager._refreshNodeToken('gemini-antigravity', status, true))
            .rejects.toMatchObject({ code: 'REFRESH_POSTCONDITION_FAILED' });
        expect(status.config.needsRefresh).toBe(true);
        expect(status.config.lastErrorMessage).toContain('REFRESH_POSTCONDITION_FAILED');
    });
});
