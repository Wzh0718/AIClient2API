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
import { CONFIG } from '../src/core/config-manager.js';
import { checkGeminiCredentialsDuplicate, findGeminiAccountDuplicate, handleGeminiAntigravityOAuth } from '../src/auth/gemini-oauth.js';

let tempDir;
let callbackHandler;
const originalCwd = process.cwd();

function idToken(claims) {
    const payload = Buffer.from(JSON.stringify({ email_verified: true, ...claims })).toString('base64url');
    return `header.${payload}.signature`;
}

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

function setupConfig(extraConfig = {}) {
    tempDir = mkdirSync(join(tmpdir(), `aiclient2api-gemini-dedup-${Date.now()}-`), { recursive: true });
    process.chdir(tempDir);
    const proxyPath = join(tempDir, 'proxy-pools.json');
    writeFileSync(proxyPath, JSON.stringify([
        { id: 'proxy-selected', url: 'http://127.0.0.1:7890', enabled: true }
    ]), 'utf8');
    return { PROXY_POOLS_FILE_PATH: proxyPath, ...extraConfig };
}

function writeExistingCredential(fileName, credentials) {
    const dir = join(tempDir, 'configs', 'antigravity');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), JSON.stringify(credentials), 'utf8');
}

async function completeAuthorization(currentConfig, { tokens, email, targetProviderUuid } = {}) {
    jest.spyOn(http, 'createServer').mockImplementation(handler => {
        callbackHandler = handler;
        return mockServer();
    });
    const options = {
        saveToConfigs: true,
        providerDir: 'antigravity',
        proxyId: 'proxy-selected',
        ...(targetProviderUuid ? { targetProviderUuid } : {})
    };
    const auth = await handleGeminiAntigravityOAuth(currentConfig, options);
    const client = OAuth2Client.mock.instances.at(-1);
    client.getToken.mockResolvedValueOnce({ tokens });
    if (email) client.getTokenInfo.mockResolvedValueOnce({ email });
    else client.getTokenInfo.mockRejectedValueOnce(new Error('token info unavailable'));
    const { response, done } = responseDone();
    await callbackHandler({ url: `/?code=code-1&state=${auth.authInfo.sessionId}` }, response);
    await done;
    return auth;
}

afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    process.chdir(originalCwd);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    callbackHandler = null;
});

describe('Gemini OAuth same-account duplicate detection', () => {
    test('rejects a new authorization when the same sub already exists', async () => {
        const currentConfig = setupConfig();
        writeExistingCredential('100_oauth_creds.json', {
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            id_token: idToken({ sub: 'sub-100', email: 'dup@example.com' })
        });

        await completeAuthorization(currentConfig, {
            email: 'dup@example.com',
            tokens: { access_token: 'access', refresh_token: 'new-refresh', id_token: idToken({ sub: 'sub-100', email: 'dup@example.com' }) }
        });

        expect(broadcastEvent).toHaveBeenCalledWith('oauth_error', expect.objectContaining({
            provider: 'gemini-antigravity',
            error: expect.stringContaining('已存在')
        }));
        expect(broadcastEvent).not.toHaveBeenCalledWith('oauth_success', expect.anything());
        expect(autoLinkProviderConfigs).not.toHaveBeenCalled();
    });

    test('rejects when only the email matches and sub is missing', async () => {
        const currentConfig = setupConfig();
        writeExistingCredential('101_oauth_creds.json', {
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            id_token: idToken({ email: 'dup@example.com' })
        });

        await completeAuthorization(currentConfig, {
            tokens: { access_token: 'access', refresh_token: 'new-refresh', id_token: idToken({ email: 'dup@example.com' }) }
        });

        expect(broadcastEvent).toHaveBeenCalledWith('oauth_error', expect.objectContaining({
            error: expect.stringContaining('已存在')
        }));
    });

    test('allows replacing an existing entry when targetProviderUuid is set', async () => {
        const currentConfig = setupConfig();
        writeExistingCredential('102_oauth_creds.json', {
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            id_token: idToken({ sub: 'sub-102', email: 'dup@example.com' })
        });
        replaceProviderCredentialPath.mockResolvedValueOnce({ updated: true });

        await completeAuthorization(currentConfig, {
            email: 'dup@example.com',
            targetProviderUuid: 'antigravity-1',
            tokens: { access_token: 'access', refresh_token: 'new-refresh', id_token: idToken({ sub: 'sub-102', email: 'dup@example.com' }) }
        });

        expect(replaceProviderCredentialPath).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            providerUuid: 'antigravity-1',
            accountEmail: 'dup@example.com'
        }));
        expect(broadcastEvent).toHaveBeenCalledWith('oauth_success', expect.anything());
    });

    test('allows a genuinely new account', async () => {
        const currentConfig = setupConfig();
        writeExistingCredential('103_oauth_creds.json', {
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            id_token: idToken({ sub: 'sub-old', email: 'old@example.com' })
        });
        autoLinkProviderConfigs.mockResolvedValueOnce({ linked: true });

        await completeAuthorization(currentConfig, {
            email: 'new@example.com',
            tokens: { access_token: 'access', refresh_token: 'new-refresh', id_token: idToken({ sub: 'sub-new', email: 'new@example.com' }) }
        });

        expect(broadcastEvent).toHaveBeenCalledWith('oauth_success', expect.objectContaining({
            accountEmail: 'new@example.com'
        }));
    });

    test('findGeminiAccountDuplicate reports existing pool entry context', async () => {
        setupConfig();
        writeExistingCredential('104_oauth_creds.json', {
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            id_token: idToken({ sub: 'sub-104', email: 'dup@example.com' })
        });
        CONFIG.providerPools = {
            'gemini-antigravity': [{
                uuid: 'agy-uuid-1',
                customName: 'dup@example.com',
                ANTIGRAVITY_OAUTH_CREDS_FILE_PATH: './configs/antigravity/104_oauth_creds.json'
            }]
        };

        const result = await findGeminiAccountDuplicate('gemini-antigravity', {
            access_token: 'access',
            refresh_token: 'new-refresh',
            id_token: idToken({ sub: 'sub-104', email: 'dup@example.com' })
        });

        expect(result.isDuplicate).toBe(true);
        expect(result.existingPath.replace(/\\/g, '/')).toBe('configs/antigravity/104_oauth_creds.json');
        expect(result.poolUuid).toBe('agy-uuid-1');
        expect(result.customName).toBe('dup@example.com');
        delete CONFIG.providerPools;
    });

    test('checkGeminiCredentialsDuplicate catches refresh_token and sub duplicates', async () => {
        setupConfig();
        writeExistingCredential('105_oauth_creds.json', {
            access_token: 'old-access',
            refresh_token: 'old-refresh',
            id_token: idToken({ sub: 'sub-105', email: 'dup@example.com' })
        });

        const byRefresh = await checkGeminiCredentialsDuplicate('gemini-antigravity', 'old-refresh');
        expect(byRefresh.isDuplicate).toBe(true);

        const bySub = await checkGeminiCredentialsDuplicate('gemini-antigravity', 'other-refresh', {
            access_token: 'access',
            refresh_token: 'new-refresh',
            id_token: idToken({ sub: 'sub-105', email: 'dup@example.com' })
        });
        expect(bySub.isDuplicate).toBe(true);

        const fresh = await checkGeminiCredentialsDuplicate('gemini-antigravity', 'another-refresh', {
            access_token: 'access',
            refresh_token: 'another-refresh',
            id_token: idToken({ sub: 'sub-other', email: 'other@example.com' })
        });
        expect(fresh.isDuplicate).toBe(false);
    });
});
