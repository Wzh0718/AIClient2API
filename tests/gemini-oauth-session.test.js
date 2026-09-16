import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'events';
import http from 'http';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

jest.mock('google-auth-library', () => ({
    OAuth2Client: jest.fn().mockImplementation(function OAuth2Client(options) {
        this.options = options;
        this.generateAuthUrl = jest.fn(params => `https://accounts.example/auth?state=${params.state}`);
        this.getToken = jest.fn();
        this.getTokenInfo = jest.fn();
    })
}));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.mock('../src/services/ui-manager.js', () => ({ broadcastEvent: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({
    autoLinkProviderConfigs: jest.fn(),
    replaceProviderCredentialPath: jest.fn()
}));
jest.mock('../src/core/config-manager.js', () => ({ CONFIG: {} }));
jest.mock('../src/utils/tls-sidecar.js', () => ({
    getTLSSidecar: jest.fn(() => ({ isReady: jest.fn(() => false) }))
}));

import { OAuth2Client } from 'google-auth-library';
import { broadcastEvent } from '../src/services/ui-manager.js';
import { autoLinkProviderConfigs, replaceProviderCredentialPath } from '../src/services/service-manager.js';
import { handleGeminiAntigravityOAuth } from '../src/auth/gemini-oauth.js';

let tempDir;
let callbackHandler;
const originalCwd = process.cwd();

function mockServer() {
    const server = new EventEmitter();
    server.listening = false;
    server.listen = jest.fn((_port, _host, callback) => {
        server.listening = true;
        callback();
    });
    server.close = jest.fn(callback => {
        server.listening = false;
        callback?.();
    });
    return server;
}

function responseDone() {
    let resolve;
    const done = new Promise(r => { resolve = r; });
    return {
        done,
        response: {
            writeHead: jest.fn(),
            end: jest.fn(() => resolve())
        }
    };
}

function setupConfig() {
    tempDir = mkdirSync(join(tmpdir(), `aiclient2api-gemini-session-${Date.now()}-`), { recursive: true });
    process.chdir(tempDir);
    const proxyPath = join(tempDir, 'proxy-pools.json');
    writeFileSync(proxyPath, JSON.stringify([
        { id: 'proxy-selected', url: 'http://127.0.0.1:7890', enabled: true }
    ]), 'utf8');
    return { PROXY_POOLS_FILE_PATH: proxyPath };
}

afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    process.chdir(originalCwd);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    callbackHandler = null;
});

describe('Gemini OAuth session completion', () => {
    test('uses PKCE for token exchange and persists a selected proxy before broadcasting success', async () => {
        const createServer = jest.spyOn(http, 'createServer').mockImplementation(handler => {
            callbackHandler = handler;
            return mockServer();
        });
        const currentConfig = setupConfig();
        autoLinkProviderConfigs.mockResolvedValueOnce({ linked: true });

        const auth = await handleGeminiAntigravityOAuth(currentConfig, {
            saveToConfigs: true,
            providerDir: 'antigravity',
            proxyId: 'proxy-selected'
        });
        const client = OAuth2Client.mock.instances.at(-1);
        client.getToken.mockResolvedValueOnce({ tokens: { access_token: 'access', refresh_token: 'refresh' } });
        client.getTokenInfo.mockResolvedValueOnce({ email: 'gemini.user@example.com' });
        const { response, done } = responseDone();

        await callbackHandler({ url: `/?code=code-1&state=${auth.authInfo.sessionId}` }, response);
        await done;

        expect(client.getToken).toHaveBeenCalledWith(expect.objectContaining({
            code: 'code-1',
            codeVerifier: expect.any(String)
        }));
        expect(client.getTokenInfo).toHaveBeenCalledWith('access');
        expect(client.options.transporterOptions.agent).toBeDefined();
        expect(autoLinkProviderConfigs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            providerDefaults: {
                PROXY_ID: 'proxy-selected',
                accountEmail: 'gemini.user@example.com',
                customName: 'gemini.user@example.com'
            },
            throwOnPersistError: true
        }));
        expect(broadcastEvent).toHaveBeenCalledWith('oauth_success', expect.objectContaining({
            provider: 'gemini-antigravity',
            sessionId: auth.authInfo.sessionId,
            targetProviderUuid: null,
            accountEmail: 'gemini.user@example.com',
            customName: 'gemini.user@example.com'
        }));
        expect(autoLinkProviderConfigs.mock.invocationCallOrder[0])
            .toBeLessThan(broadcastEvent.mock.invocationCallOrder.at(-1));
        expect(createServer).toHaveBeenCalledTimes(1);
    });

    test('reauthorizes the same provider and updates its proxy binding in place', async () => {
        jest.spyOn(http, 'createServer').mockImplementation(handler => {
            callbackHandler = handler;
            return mockServer();
        });
        const currentConfig = {
            ...setupConfig(),
            providerPools: {
                'gemini-antigravity': [{
                    uuid: 'antigravity-1',
                    PROXY_ID: 'proxy-old',
                    providerWeight: 9
                }]
            }
        };
        replaceProviderCredentialPath.mockResolvedValueOnce({ updated: true });

        const auth = await handleGeminiAntigravityOAuth(currentConfig, {
            saveToConfigs: true,
            providerDir: 'antigravity',
            targetProviderUuid: 'antigravity-1',
            proxyId: 'proxy-selected'
        });
        const client = OAuth2Client.mock.instances.at(-1);
        client.getToken.mockResolvedValueOnce({ tokens: { access_token: 'access', refresh_token: 'refresh' } });
        client.getTokenInfo.mockResolvedValueOnce({ email: 'reauthorized@example.com' });
        const { response, done } = responseDone();

        await callbackHandler({ url: `/?code=code-2&state=${auth.authInfo.sessionId}` }, response);
        await done;

        expect(replaceProviderCredentialPath).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            providerType: 'gemini-antigravity',
            providerUuid: 'antigravity-1',
            proxyId: 'proxy-selected',
            accountEmail: 'reauthorized@example.com'
        }));
        expect(autoLinkProviderConfigs).not.toHaveBeenCalled();
    });

    test('falls back to the id token email when token info lookup fails', async () => {
        jest.spyOn(http, 'createServer').mockImplementation(handler => {
            callbackHandler = handler;
            return mockServer();
        });
        const auth = await handleGeminiAntigravityOAuth(setupConfig(), {
            saveToConfigs: true,
            providerDir: 'antigravity',
            proxyId: 'proxy-selected'
        });
        const client = OAuth2Client.mock.instances.at(-1);
        const payload = Buffer.from(JSON.stringify({ email: 'fallback@example.com', email_verified: true })).toString('base64url');
        client.getToken.mockResolvedValueOnce({
            tokens: { access_token: 'access', refresh_token: 'refresh', id_token: `header.${payload}.signature` }
        });
        client.getTokenInfo.mockRejectedValueOnce(new Error('token info unavailable'));
        const { response, done } = responseDone();

        await callbackHandler({ url: `/?code=code-fallback&state=${auth.authInfo.sessionId}` }, response);
        await done;

        expect(autoLinkProviderConfigs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            providerDefaults: expect.objectContaining({
                accountEmail: 'fallback@example.com',
                customName: 'fallback@example.com'
            })
        }));
        expect(broadcastEvent).toHaveBeenCalledWith('oauth_success', expect.objectContaining({
            accountEmail: 'fallback@example.com'
        }));
    });

    test('aborts authorization when no account email can be resolved', async () => {
        jest.spyOn(http, 'createServer').mockImplementation(handler => {
            callbackHandler = handler;
            return mockServer();
        });
        const auth = await handleGeminiAntigravityOAuth(setupConfig(), {
            saveToConfigs: true,
            providerDir: 'antigravity',
            proxyId: 'proxy-selected'
        });
        const client = OAuth2Client.mock.instances.at(-1);
        client.getToken.mockResolvedValueOnce({ tokens: { access_token: 'access', refresh_token: 'refresh' } });
        client.getTokenInfo.mockRejectedValueOnce(new Error('token info unavailable'));
        const { response, done } = responseDone();

        await callbackHandler({ url: `/?code=code-no-email&state=${auth.authInfo.sessionId}` }, response);
        await done;

        expect(autoLinkProviderConfigs).not.toHaveBeenCalled();
        expect(broadcastEvent).toHaveBeenCalledWith('oauth_error', expect.objectContaining({
            provider: 'gemini-antigravity',
            error: expect.stringContaining('无法解析 Google 账号邮箱')
        }));
        expect(broadcastEvent).not.toHaveBeenCalledWith('oauth_success', expect.anything());
    });

    test('ends the session immediately when Google token exchange fails', async () => {
        jest.spyOn(http, 'createServer').mockImplementation(handler => {
            callbackHandler = handler;
            return mockServer();
        });
        const auth = await handleGeminiAntigravityOAuth(setupConfig(), {
            saveToConfigs: true,
            providerDir: 'antigravity',
            proxyId: 'proxy-selected'
        });
        const client = OAuth2Client.mock.instances.at(-1);
        client.getToken.mockRejectedValueOnce(new Error('token exchange failed'));
        const { response, done } = responseDone();

        await callbackHandler({ url: `/?code=bad-code&state=${auth.authInfo.sessionId}` }, response);
        await done;

        expect(broadcastEvent).toHaveBeenCalledWith('oauth_error', expect.objectContaining({
            provider: 'gemini-antigravity',
            sessionId: auth.authInfo.sessionId,
            error: 'token exchange failed'
        }));
        expect(broadcastEvent).not.toHaveBeenCalledWith('oauth_success', expect.anything());
    });
});
