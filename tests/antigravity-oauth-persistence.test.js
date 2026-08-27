import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

const mockOauthClients = [];

jest.mock('google-auth-library', () => ({
    OAuth2Client: jest.fn().mockImplementation(function OAuth2Client() {
        const emitter = new (require('events').EventEmitter)();
        this.on = emitter.on.bind(emitter);
        this.emit = emitter.emit.bind(emitter);
        this.setCredentials = jest.fn();
        mockOauthClients.push(this);
    })
}));
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/auth/oauth-handlers.js', () => ({ handleGeminiAntigravityOAuth: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: jest.fn(() => null) }));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(options => options),
    getRequiredProxyConfigForProvider: jest.fn(() => null),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';

describe('Antigravity OAuth persistence', () => {
    afterEach(() => jest.clearAllMocks());

    test('persists credentials emitted by OAuth client token refresh', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-oauth-persist-'));
        const credentialPath = path.join(tempDir, 'oauth.json');
        fs.writeFileSync(credentialPath, JSON.stringify({
            access_token: 'expired-access-token',
            refresh_token: 'refresh-token',
            expiry_date: Date.now() - 60_000
        }));

        new AntigravityApiService({
            MODEL_PROVIDER: 'gemini-antigravity',
            ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: credentialPath,
            ANTIGRAVITY_BASE_URL: 'http://127.0.0.1:1',
            PROJECT_ID: 'test-project'
        });

        const client = mockOauthClients.at(-1);
        const refreshedExpiry = Date.now() + 60 * 60 * 1000;
        client.emit('tokens', { access_token: 'refreshed-access-token', expiry_date: refreshedExpiry });
        await new Promise(resolve => setTimeout(resolve, 50));

        const persisted = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
        expect(persisted).toMatchObject({
            access_token: 'refreshed-access-token',
            expiry_date: refreshedExpiry,
            refresh_token: 'refresh-token'
        });
    });

    test('does not let a stale token event overwrite a newer persisted expiry', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-oauth-persist-order-'));
        const credentialPath = path.join(tempDir, 'oauth.json');
        const newestExpiry = Date.now() + 2 * 60 * 60 * 1000;
        fs.writeFileSync(credentialPath, JSON.stringify({
            access_token: 'newest-access-token',
            refresh_token: 'refresh-token',
            expiry_date: newestExpiry
        }));

        new AntigravityApiService({
            MODEL_PROVIDER: 'gemini-antigravity',
            ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: credentialPath,
            ANTIGRAVITY_BASE_URL: 'http://127.0.0.1:1',
            PROJECT_ID: 'test-project'
        });

        const client = mockOauthClients.at(-1);
        client.emit('tokens', {
            access_token: 'newest-access-token',
            expiry_date: newestExpiry
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        client.emit('tokens', {
            access_token: 'stale-access-token',
            expiry_date: Date.now() + 60 * 60 * 1000
        });
        await new Promise(resolve => setTimeout(resolve, 50));

        const persisted = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
        expect(persisted).toMatchObject({
            access_token: 'newest-access-token',
            expiry_date: newestExpiry
        });
    });
});
