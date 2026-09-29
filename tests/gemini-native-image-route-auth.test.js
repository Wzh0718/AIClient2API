import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        runWithContext: jest.fn((_requestId, callback) => callback())
    }
}));

jest.mock('../src/utils/context.js', () => ({
    __esModule: true,
    default: {
        run: jest.fn((_context, callback) => callback()),
        set: jest.fn(),
        get: jest.fn()
    }
}));

jest.mock('../src/utils/common.js', () => ({
    handleError: jest.fn(),
    getClientIp: jest.fn((req, _config, options) => options?.detailed
        ? {
            clientIp: req.headers?.['x-real-ip'] || req.socket?.remoteAddress || '127.0.0.1',
            peerIp: req.socket?.remoteAddress || '127.0.0.1',
            clientIpSource: req.headers?.['x-real-ip'] ? 'trusted-x-real-ip' : 'peer'
        }
        : (req.socket?.remoteAddress || '127.0.0.1')),
    getRequestBody: jest.fn(),
    countTokensAnthropic: jest.fn()
}));

jest.mock('../src/services/ui-manager.js', () => ({
    handleUIApiRequests: jest.fn(async () => false),
    serveStaticFiles: jest.fn(async () => false)
}));

jest.mock('../src/utils/ui-utils.js', () => ({
    isUIPath: jest.fn(() => false),
    isUIApiPath: jest.fn(() => false)
}));

jest.mock('../src/services/api-manager.js', () => ({
    handleAPIRequests: jest.fn(async () => true)
}));

jest.mock('../src/services/service-manager.js', () => ({
    getApiService: jest.fn(),
    getProviderStatus: jest.fn(),
    getProviderPoolManager: jest.fn(() => null)
}));

jest.mock('../src/providers/adapter.js', () => ({
    getRegisteredProviders: jest.fn(() => ['gemini-antigravity', 'openai-codex-oauth']),
    isRegisteredProvider: jest.fn(provider => ['gemini-antigravity', 'openai-codex-oauth'].includes(provider))
}));

jest.mock('../src/core/config-manager.js', () => ({
    PROMPT_LOG_FILENAME: null
}));

const mockPluginManager = {
    isPluginStaticPath: jest.fn(() => false),
    getPluginByStaticPath: jest.fn(() => null),
    executeRoutes: jest.fn(async () => false),
    executeAuth: jest.fn(async () => ({ handled: false, authorized: true })),
    executeMiddleware: jest.fn(async () => ({ handled: false })),
    executeHook: jest.fn(async () => {})
};

jest.mock('../src/core/plugin-manager.js', () => ({
    getPluginManager: jest.fn(() => mockPluginManager)
}));

jest.mock('../src/utils/grok-assets-proxy.js', () => ({
    handleGrokAssetsProxy: jest.fn()
}));

import defaultAuthPlugin from '../src/plugins/default-auth/index.js';
import { createRequestHandler } from '../src/handlers/request-handler.js';
import { handleError } from '../src/utils/common.js';
import { handleUIApiRequests } from '../src/services/ui-manager.js';
import { handleAPIRequests as mockHandleAPIRequests } from '../src/services/api-manager.js';

function makeResponse() {
    const listeners = new Map();
    return {
        headers: {},
        statusCode: 200,
        writableEnded: false,
        writableFinished: false,
        setHeader(name, value) {
            this.headers[name] = value;
        },
        writeHead: jest.fn(function (code) {
            this.statusCode = code;
        }),
        write: jest.fn(() => true),
        end: jest.fn(function () {
            this.writableEnded = true;
            this.writableFinished = true;
            for (const callback of listeners.get('finish') || []) callback();
        }),
        on(event, callback) {
            const callbacks = listeners.get(event) || [];
            callbacks.push(callback);
            listeners.set(event, callbacks);
            return this;
        },
        off(event, callback) {
            listeners.set(event, (listeners.get(event) || []).filter(item => item !== callback));
            return this;
        }
    };
}

describe('Gemini native route and authentication contract', () => {
    test.each([
        ['/openai-codex-oauth/v1/responses', undefined, true],
        ['/openai-codex-oauth/v1/responses', 'openai-codex-oauth', false],
        ['/openai-codex-oauth/v1/chat/completions', undefined, false]
    ])('marks GLM eligibility for %s with provider header %s as %s', async (url, providerHeader, expected) => {
        mockHandleAPIRequests.mockClear();
        const handler = createRequestHandler({
            UI_ENABLED: false, MODEL_PROVIDER: 'openai-codex-oauth', GLM_SESSION_ROUTING_ENABLED: true,
            REQUIRED_API_KEY: 'contract-key'
        }, null);
        const req = {
            method: 'POST', url,
            headers: { host: 'localhost:3000', ...(providerHeader ? { 'model-provider': providerHeader } : {}) },
            socket: { encrypted: false, remoteAddress: '127.0.0.1' }
        };
        await handler(req, makeResponse());
        expect(mockHandleAPIRequests).toHaveBeenCalledTimes(1);
        const [method, path, , , requestConfig] = mockHandleAPIRequests.mock.calls[0];
        expect(method).toBe('POST');
        expect(path).toBe(url.replace(/^\/openai-codex-oauth/, ''));
        expect(requestConfig._explicitProviderSelection).toBe(true);
        expect(requestConfig._glmPrefixedResponsesEligible).toBe(expected);
        mockHandleAPIRequests.mockClear();
        handleUIApiRequests.mockClear();
    });
    test.each([
        ['query key', {}, 'http://localhost/v1beta/models/gemini-3.1-flash-image:generateContent?key=contract-key'],
        ['x-goog-api-key', { 'x-goog-api-key': 'contract-key' }, 'http://localhost/v1beta/models/gemini-3.1-flash-image:generateContent'],
        ['Bearer token', { authorization: 'Bearer contract-key' }, 'http://localhost/v1beta/models/gemini-3.1-flash-image:generateContent']
    ])('accepts %s authentication', async (_label, headers, url) => {
        const result = await defaultAuthPlugin.authenticate(
            { headers },
            {},
            new URL(url),
            { REQUIRED_API_KEY: 'contract-key' }
        );

        expect(result).toEqual({ handled: false, authorized: true });
    });

    test('strips the gemini-antigravity provider prefix before routing generateContent', async () => {
        const handler = createRequestHandler({
            UI_ENABLED: false,
            MODEL_PROVIDER: 'gemini-cli-oauth',
            REQUIRED_API_KEY: 'contract-key'
        }, null);
        const req = {
            method: 'POST',
            url: '/gemini-antigravity/v1beta/models/gemini-3.1-flash-image:generateContent?key=contract-key',
            headers: { host: 'localhost:3000' },
            socket: { encrypted: false }
        };

        await handler(req, makeResponse());

        expect(handleError).not.toHaveBeenCalled();
        expect(handleUIApiRequests).toHaveBeenCalledTimes(1);
        expect(mockHandleAPIRequests).toHaveBeenCalledTimes(1);
        const [method, path, , , currentConfig] = mockHandleAPIRequests.mock.calls[0];
        expect(method).toBe('POST');
        expect(path).toBe('/v1beta/models/gemini-3.1-flash-image:generateContent');
        expect(currentConfig.MODEL_PROVIDER).toBe('gemini-antigravity');
    });

    test('returns a request id and finalizes one audit event with original and normalized paths', async () => {
        mockPluginManager.executeHook.mockClear();
        mockHandleAPIRequests.mockImplementationOnce(async (_method, _path, _req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return true;
        });
        const handler = createRequestHandler({
            UI_ENABLED: false,
            MODEL_PROVIDER: 'gemini-cli-oauth',
            REQUIRED_API_KEY: 'contract-key',
            TRUST_PROXY: true,
            TRUSTED_PROXY_IPS: ['172.17.0.1']
        }, null);
        const req = {
            method: 'POST',
            url: '/gemini-antigravity/v1beta/models/gemini-3.1-flash-image:generateContent?key=secret',
            headers: {
                host: 'localhost:3000',
                'x-real-ip': '119.123.77.234',
                'x-forwarded-for': '198.51.100.9'
            },
            socket: { encrypted: false, remoteAddress: '172.17.0.1' }
        };
        const res = makeResponse();

        await handler(req, res);
        await new Promise(resolve => setImmediate(resolve));

        expect(res.headers['X-Request-ID']).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        const completionCalls = mockPluginManager.executeHook.mock.calls.filter(([name]) => name === 'onRequestCompleted');
        expect(completionCalls).toHaveLength(1);
        expect(completionCalls[0][1]).toMatchObject({
            requestId: res.headers['X-Request-ID'],
            method: 'POST',
            path: '/gemini-antigravity/v1beta/models/gemini-3.1-flash-image:generateContent',
            normalizedPath: '/v1beta/models/gemini-3.1-flash-image:generateContent',
            clientIp: '119.123.77.234',
            peerIp: '172.17.0.1',
            clientIpSource: 'trusted-x-real-ip',
            response: expect.objectContaining({ httpStatus: 200, completed: true, clientAborted: false })
        });
        expect(JSON.stringify(completionCalls[0][1])).not.toContain('secret');
    });

    test('audits an authentication rejection before model routing with its real HTTP status', async () => {
        mockPluginManager.executeHook.mockClear();
        mockHandleAPIRequests.mockClear();
        mockPluginManager.executeAuth.mockResolvedValueOnce({ handled: false, authorized: false });
        handleError.mockImplementationOnce(res => {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        });
        const handler = createRequestHandler({
            UI_ENABLED: false,
            MODEL_PROVIDER: 'gemini-cli-oauth',
            REQUIRED_API_KEY: 'contract-key'
        }, null);
        const req = {
            method: 'POST',
            url: '/gemini-antigravity/v1beta/models/gemini-3.1-flash-image:generateContent?key=invalid',
            headers: { host: 'localhost:3000' },
            socket: { encrypted: false, remoteAddress: '127.0.0.1' }
        };

        await handler(req, makeResponse());

        expect(mockHandleAPIRequests).not.toHaveBeenCalled();
        const completionCalls = mockPluginManager.executeHook.mock.calls.filter(([name]) => name === 'onRequestCompleted');
        expect(completionCalls).toHaveLength(1);
        expect(completionCalls[0][1]).toMatchObject({
            path: '/gemini-antigravity/v1beta/models/gemini-3.1-flash-image:generateContent',
            normalizedPath: '/v1beta/models/gemini-3.1-flash-image:generateContent',
            response: expect.objectContaining({ httpStatus: 401, completed: true })
        });
    });
});
