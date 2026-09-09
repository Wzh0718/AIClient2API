import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
    applyProviderRateLimitCooldown,
    getRetryAfterMs,
    handleError,
    handleStreamRequest,
    handleUnaryRequest,
    isAntigravityTransientCapacityError,
    normalizeAntigravityCapacityExhaustion
} from '../src/utils/common.js';
import requestContext from '../src/utils/context.js';

const mockGetApiServiceWithFallback = jest.fn();

jest.mock('../src/services/service-manager.js', () => ({
    getApiServiceWithFallback: mockGetApiServiceWithFallback
}));

class FakeResponse {
    constructor() {
        this.body = '';
        this.writableEnded = false;
        this.statusCode = null;
        this.headers = {};
    }
    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = headers;
    }
    end(chunk = '') {
        this.body += String(chunk);
        this.writableEnded = true;
    }
}

class StreamFakeResponse {
    constructor() {
        this.body = '';
        this.writableEnded = false;
        this.statusCode = null;
        this.headers = {};
        this._listeners = {};
    }
    on(event, handler) {
        (this._listeners[event] ||= []).push(handler);
        return this;
    }
    off(event, handler) {
        this._listeners[event] = (this._listeners[event] || []).filter(item => item !== handler);
        return this;
    }
    once(event, handler) {
        const wrapped = (...args) => {
            this.off(event, wrapped);
            handler(...args);
        };
        return this.on(event, wrapped);
    }
    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = headers;
    }
    write(chunk) {
        this.body += String(chunk);
        return true;
    }
    end(chunk = '') {
        this.body += String(chunk);
        this.writableEnded = true;
    }
}

afterEach(() => {
    restoreRandom();
    jest.restoreAllMocks();
});

const originalMathRandom = Math.random;
function freezeRandom() {
    Math.random = () => 0;
}
function restoreRandom() {
    Math.random = originalMathRandom;
}

function createQuotaError({ model = 'gemini-3.1-flash-image', resetDelay = '26h13m8s', resetAt = null } = {}) {
    const metadata = {
        model,
        quotaResetDelay: resetDelay
    };
    if (resetAt) metadata.quotaResetTimeStamp = resetAt;

    const error = new Error('Antigravity quota exhausted');
    error.response = {
        status: 429,
        data: JSON.stringify([{
            error: {
                code: 429,
                status: 'RESOURCE_EXHAUSTED',
                details: [{
                    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                    reason: 'QUOTA_EXHAUSTED',
                    metadata
                }]
            }
        }])
    };
    return error;
}

function createCapacityError() {
    const error = new Error('Upstream API Error (Status 503): No capacity available for model gemini-3.1-flash-image on the server');
    error.response = {
        status: 503,
        data: [{
            error: {
                code: 503,
                status: 'UNAVAILABLE',
                message: 'No capacity available for model gemini-3.1-flash-image on the server'
            }
        }]
    };
    return error;
}

function createCapacityCodeError() {
    const error = new Error('Upstream capacity exhausted');
    error.response = {
        status: 503,
        data: {
            error: {
                code: 503,
                status: 'MODEL_CAPACITY_EXHAUSTED',
                message: 'No capacity available for model gemini-3.1-flash-lite on the server'
            }
        }
    };
    return error;
}

function createProductionCapacityError() {
    const error = new Error('No capacity available for model gemini-3.1-flash-lite on the server');
    error.status = 'UNAVAILABLE';
    error.code = 503;
    error.response = {
        status: 503,
        data: {
            error: {
                code: 503,
                message: 'No capacity available for model gemini-3.1-flash-lite on the server',
                status: 'UNAVAILABLE',
                details: [{
                    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                    reason: 'MODEL_CAPACITY_EXHAUSTED',
                    metadata: { error_number: '2010', model: 'gemini-3.1-flash-lite' }
                }]
            }
        }
    };
    return error;
}

function createGeneric503Error() {
    const error = new Error('Upstream API Error (Status 503): backend exploded');
    error.response = {
        status: 503,
        data: { error: { code: 503, message: 'backend exploded' } }
    };
    return error;
}

function defineGetterOnly(object, key, getValue) {
    Object.defineProperty(object, key, {
        configurable: true,
        enumerable: true,
        get: getValue
    });
}

function createReadOnlyAxiosCapacityError(model = 'gemini-2.5-flash') {
    const error = new Error(`No capacity available for model ${model} on the server`);
    const response = {
        data: {
            error: {
                code: 503,
                message: error.message,
                status: 'UNAVAILABLE'
            }
        }
    };
    defineGetterOnly(response, 'status', () => 503);
    error.status = 'UNAVAILABLE';
    error.code = 503;
    error.response = response;
    return error;
}

function expiredCodexRetryContext(overrides = {}) {
    return {
        CONFIG: {
            CREDENTIAL_SWITCH_MAX_RETRIES: 1,
            CODEX_RETRY_MAX_DURATION_MS: 120000,
            ...(overrides.CONFIG || {})
        },
        maxRetries: 1,
        retryStartedAt: Date.now() - 180000,
        ...overrides
    };
}

function createGrpcCapacityError() {
    const error = new Error('Request failed');
    error.status = 'UNAVAILABLE';
    error.code = 14;
    error.response = {
        data: {
            error: {
                code: 14,
                message: 'Service Unavailable',
                status: 'UNAVAILABLE',
                details: [{
                    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                    reason: 'MODEL_CAPACITY_EXHAUSTED',
                    metadata: { error_number: '2010', model: 'gemini-3.1-flash-lite' }
                }, {
                    '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                    retryDelay: '55s'
                }]
            }
        }
    };
    return error;
}

function createCapacityPoolManager() {
    return {
        markAntigravityModelCapacityUnavailable: jest.fn(),
        markAntigravityModelQuotaUnhealthy: jest.fn(),
        markProviderUnhealthyWithRecoveryTime: jest.fn(),
        markProviderUnhealthy: jest.fn(),
        markProviderUnhealthyImmediately: jest.fn(),
        markProviderHealthy: jest.fn(),
        recordAntigravityRoutingEvent: jest.fn(),
        recordGeminiSchedulingEvent: jest.fn(),
        releaseSlot: jest.fn()
    };
}

function parseSseErrorType(body) {
    const match = String(body).match(/data: ({.*})/);
    if (!match) return null;
    try {
        return JSON.parse(match[1])?.error?.type || null;
    } catch {
        return null;
    }
}

describe('Antigravity model quota cooldown', () => {
    test('switches accounts for transient image capacity without marking the account unhealthy', async () => {
        const firstService = { generateContent: jest.fn().mockRejectedValue(createCapacityError()) };
        const secondService = { generateContent: jest.fn().mockResolvedValue({ id: 'antigravity-capacity-retry-success' }) };
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: secondService,
            uuid: 'provider-ultra-2',
            actualModel: 'gemini-3.1-flash-image',
            actualProviderType: 'gemini-antigravity',
            serviceConfig: {}
        });
        const providerPoolManager = {
            markAntigravityModelCapacityUnavailable: jest.fn(),
            markAntigravityModelQuotaUnhealthy: jest.fn(),
            markProviderUnhealthyWithRecoveryTime: jest.fn(),
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyImmediately: jest.fn(),
            markProviderHealthy: jest.fn(),
            releaseSlot: jest.fn()
        };
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            firstService,
            'gemini-3.1-flash-image',
            { contents: [] },
            'gemini',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-ultra-1',
            'Ultra 1',
            {
                CONFIG: { CREDENTIAL_SWITCH_MAX_RETRIES: 1 },
                maxRetries: 1
            }
        );

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(
            expect.anything(),
            'gemini-3.1-flash-image',
            expect.objectContaining({
                excludeProviderUuids: ['provider-ultra-1'],
                acquireSlot: true
            })
        );
        expect(secondService.generateContent).toHaveBeenCalledTimes(1);
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthyImmediately).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
        expect(providerPoolManager.markAntigravityModelCapacityUnavailable).toHaveBeenCalledWith(
            'gemini-antigravity',
            { uuid: 'provider-ultra-1' },
            'gemini-3.1-flash-image',
            expect.any(Date)
        );
        expect(res.body).toContain('antigravity-capacity-retry-success');
    });

    test('returns HTTP 429 when every alternative is unavailable after an Antigravity capacity error', async () => {
        const firstService = { generateContent: jest.fn().mockRejectedValue(createCapacityError()) };
        mockGetApiServiceWithFallback.mockRejectedValueOnce(new Error('No healthy provider found in pool'));
        const providerPoolManager = {
            markAntigravityModelCapacityUnavailable: jest.fn(),
            markAntigravityModelQuotaUnhealthy: jest.fn(),
            markProviderUnhealthyWithRecoveryTime: jest.fn(),
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyImmediately: jest.fn(),
            markProviderHealthy: jest.fn(),
            releaseSlot: jest.fn()
        };
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            firstService,
            'gemini-3.1-flash-image',
            { contents: [] },
            'gemini',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-ultra-1',
            'Ultra 1',
            { CONFIG: { CREDENTIAL_SWITCH_MAX_RETRIES: 1 }, maxRetries: 1 }
        );

        expect(res.statusCode).toBe(429);
        expect(res.headers['Retry-After']).toBeDefined();
        expect(JSON.parse(res.body).error).toMatchObject({
            code: 429,
            status: 'RESOURCE_EXHAUSTED'
        });
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
    });

    test('maps production UNAVAILABLE capacity errors to HTTP 429 instead of 500', async () => {
        mockGetApiServiceWithFallback.mockRejectedValueOnce(new Error('No healthy provider found in pool'));
        const firstService = { generateContent: jest.fn().mockRejectedValue(createProductionCapacityError()) };
        const providerPoolManager = {
            markAntigravityModelCapacityUnavailable: jest.fn(),
            markAntigravityModelQuotaUnhealthy: jest.fn(),
            markProviderUnhealthyWithRecoveryTime: jest.fn(),
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyImmediately: jest.fn(),
            markProviderHealthy: jest.fn(),
            releaseSlot: jest.fn()
        };
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            firstService,
            'gemini-3.1-flash-lite',
            { contents: [] },
            'gemini',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-ultra-1',
            'Ultra 1',
            { CONFIG: { CREDENTIAL_SWITCH_MAX_RETRIES: 1 }, maxRetries: 1 }
        );

        expect(res.statusCode).toBe(429);
        expect(res.statusCode).not.toBe(500);
        expect(JSON.parse(res.body).error).toMatchObject({
            code: 429,
            status: 'RESOURCE_EXHAUSTED'
        });
        expect(providerPoolManager.markAntigravityModelCapacityUnavailable).toHaveBeenCalled();
    });

    test('leaves generic Antigravity 503 as 503 and does not treat it as capacity', async () => {
        mockGetApiServiceWithFallback.mockReset();
        const firstService = { generateContent: jest.fn().mockRejectedValue(createGeneric503Error()) };
        const providerPoolManager = {
            markAntigravityModelCapacityUnavailable: jest.fn(),
            markAntigravityModelQuotaUnhealthy: jest.fn(),
            markProviderUnhealthyWithRecoveryTime: jest.fn(),
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyImmediately: jest.fn(),
            releaseSlot: jest.fn()
        };
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            firstService,
            'gemini-2.5-flash',
            { contents: [] },
            'gemini',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-ultra-1',
            'Ultra 1',
            { CONFIG: { CREDENTIAL_SWITCH_MAX_RETRIES: 5 }, maxRetries: 5 }
        );

        expect(mockGetApiServiceWithFallback).not.toHaveBeenCalled();
        expect(providerPoolManager.markAntigravityModelCapacityUnavailable).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(503);
    });

    test('parses compound hour-minute-second quota reset delays', () => {
        const error = createQuotaError();

        expect(getRetryAfterMs(error, 0)).toBe(((26 * 60 + 13) * 60 + 8) * 1000);
    });

    test('prefers the quota reset delay over HTTP Retry-After for Antigravity model cooldown', () => {
        const now = Date.parse('2026-08-10T08:00:00Z');
        jest.spyOn(Date, 'now').mockReturnValue(now);
        const error = createQuotaError({ resetDelay: '2m' });
        error.response.headers = { 'retry-after': '30' };
        const providerPoolManager = {
            markAntigravityModelQuotaUnhealthy: jest.fn(),
            markAntigravityModelCapacityUnavailable: jest.fn()
        };

        applyProviderRateLimitCooldown({
            error,
            config: { RATE_LIMIT_COOLDOWN_MS: 30000 },
            providerPoolManager,
            providerType: 'gemini-antigravity',
            providerUuid: 'provider-pro-1',
            requestedModel: 'gemini-3.1-flash-image'
        });

        expect(providerPoolManager.markAntigravityModelQuotaUnhealthy).toHaveBeenCalledWith(
            'gemini-antigravity',
            { uuid: 'provider-pro-1' },
            'gemini-3.1-flash-image',
            '429 Too Many Requests - model cooldown',
            new Date(now + 120000)
        );
    });

    test('treats explicit model capacity exhaustion as a model cooldown while preserving 429 semantics', () => {
        jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-10T08:00:00Z'));
        const providerPoolManager = {
            markAntigravityModelQuotaUnhealthy: jest.fn(),
            markAntigravityModelCapacityUnavailable: jest.fn()
        };
        const error = createCapacityCodeError();

        const applied = applyProviderRateLimitCooldown({
            error,
            config: { RATE_LIMIT_COOLDOWN_MS: 30000 },
            providerPoolManager,
            providerType: 'gemini-antigravity',
            providerUuid: 'provider-pro-1',
            requestedModel: 'gemini-3.1-flash-lite'
        });

        expect(applied).toBe(true);
        expect(error.status).toBe(429);
        expect(error.isAntigravityModelCapacity).toBe(true);
        expect(providerPoolManager.markAntigravityModelCapacityUnavailable).toHaveBeenCalledWith(
            'gemini-antigravity',
            { uuid: 'provider-pro-1' },
            'gemini-3.1-flash-lite',
            expect.any(Date)
        );
    });

    test('preserves 429 capacity semantics while marking the credential retryable', () => {
        const providerPoolManager = {
            markAntigravityModelQuotaUnhealthy: jest.fn(),
            markAntigravityModelCapacityUnavailable: jest.fn()
        };
        const error = createCapacityCodeError();

        const applied = applyProviderRateLimitCooldown({
            error,
            config: { RATE_LIMIT_COOLDOWN_MS: 30000 },
            providerPoolManager,
            providerType: 'gemini-antigravity',
            providerUuid: 'provider-pro-1',
            requestedModel: 'gemini-3.1-flash-lite'
        });

        expect(applied).toBe(true);
        expect(error.status).toBe(429);
        expect(error.response.status).toBe(429);
        expect(error.code).toBe('MODEL_CAPACITY_UNAVAILABLE');
        expect(error.shouldSwitchCredential).toBe(true);
        expect(error.isAntigravityModelCapacity).toBe(true);
        expect(providerPoolManager.markAntigravityModelCapacityUnavailable).toHaveBeenCalledWith(
            'gemini-antigravity',
            { uuid: 'provider-pro-1' },
            'gemini-3.1-flash-lite',
            expect.any(Date)
        );
    });

    test('marks only the exact Antigravity model as cooling down', () => {
        const now = Date.parse('2026-08-10T08:00:00Z');
        jest.spyOn(Date, 'now').mockReturnValue(now);
        const recoveryAt = '2026-08-11T09:53:38Z';
        const error = createQuotaError({ resetAt: recoveryAt });
        const providerPoolManager = {
            markAntigravityModelQuotaUnhealthy: jest.fn(),
            markProviderUnhealthyWithRecoveryTime: jest.fn()
        };

        const applied = applyProviderRateLimitCooldown({
            error,
            config: {
                RATE_LIMIT_COOLDOWN_MS: 30000,
                RATE_LIMIT_COOLDOWN_MAX_MS: 300000,
                ANTIGRAVITY_MODEL_COOLDOWN_MAX_MS: 7 * 24 * 60 * 60 * 1000
            },
            providerPoolManager,
            providerType: 'gemini-antigravity',
            providerUuid: 'provider-pro-1',
            requestedModel: 'gemini-3.1-flash-image'
        });

        expect(applied).toBe(true);
        expect(providerPoolManager.markAntigravityModelQuotaUnhealthy).toHaveBeenCalledWith(
            'gemini-antigravity',
            { uuid: 'provider-pro-1' },
            'gemini-3.1-flash-image',
            '429 Too Many Requests - model cooldown',
            new Date(recoveryAt)
        );
        expect(providerPoolManager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
    });

    test('excludes the rate-limited account and retries the same model on another account', async () => {
        freezeRandom();
        const firstService = { generateContent: jest.fn().mockRejectedValue(createQuotaError()) };
        const secondService = { generateContent: jest.fn().mockResolvedValue({ id: 'antigravity-retry-success' }) };
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: secondService,
            uuid: 'provider-pro-2',
            actualModel: 'gemini-3.1-flash-image',
            actualProviderType: 'gemini-antigravity',
            serviceConfig: {}
        });
        const providerPoolManager = {
            markAntigravityModelQuotaUnhealthy: jest.fn(),
            markProviderUnhealthyWithRecoveryTime: jest.fn(),
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyImmediately: jest.fn(),
            markProviderHealthy: jest.fn(),
            releaseSlot: jest.fn()
        };
        const config = {
            CREDENTIAL_SWITCH_MAX_RETRIES: 1,
            RATE_LIMIT_COOLDOWN_ENABLED: true,
            RATE_LIMIT_COOLDOWN_MS: 30000,
            ANTIGRAVITY_MODEL_COOLDOWN_MAX_MS: 7 * 24 * 60 * 60 * 1000
        };
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            firstService,
            'gemini-3.1-flash-image',
            { contents: [] },
            'gemini-antigravity',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-pro-1',
            'Provider Pro 1',
            { CONFIG: config, maxRetries: 1 }
        );
        restoreRandom();

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(config, 'gemini-3.1-flash-image', expect.objectContaining({
            acquireSlot: true,
            excludeProviderUuids: ['provider-pro-1']
        }));
        expect(providerPoolManager.markAntigravityModelQuotaUnhealthy).toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(secondService.generateContent).toHaveBeenCalledTimes(1);
        expect(res.body).toContain('antigravity-retry-success');
    });

    test('does not re-enter credential selection after all Antigravity models are unavailable', async () => {
        mockGetApiServiceWithFallback.mockReset();
        const terminalError = new Error('All Antigravity models are unavailable');
        terminalError.status = 429;
        terminalError.statusCode = 429;
        terminalError.code = 'ALL_MODELS_UNAVAILABLE';
        terminalError.quotaScope = 'model';
        terminalError.nextRecoveryTime = new Date(Date.now() + 3000).toISOString();
        terminalError.shouldSwitchCredential = true;
        const service = { generateContent: jest.fn().mockRejectedValue(terminalError) };
        const providerPoolManager = {
            markAntigravityModelQuotaUnhealthy: jest.fn(),
            markAntigravityModelCapacityUnavailable: jest.fn(),
            markProviderUnhealthyWithRecoveryTime: jest.fn(),
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyImmediately: jest.fn(),
            markProviderHealthy: jest.fn(),
            recordAntigravityRoutingEvent: jest.fn(),
            releaseSlot: jest.fn()
        };
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            service,
            'gemini-3.1-flash-lite',
            { contents: [] },
            'gemini',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-pro-1',
            'Provider Pro 1',
            { CONFIG: { CREDENTIAL_SWITCH_MAX_RETRIES: 5 }, maxRetries: 5 }
        );

        expect(mockGetApiServiceWithFallback).not.toHaveBeenCalled();
        expect(providerPoolManager.recordAntigravityRoutingEvent).toHaveBeenCalledWith('retrySuppressed');
        expect(res.statusCode).toBe(429);
    });

    test('does not quarantine an Antigravity credential for a generic upstream model error', async () => {
        const error = new Error('Requested entity was not found.');
        error.response = { status: 404, data: { error: { code: 404, message: error.message } } };
        const service = { generateContent: jest.fn().mockRejectedValue(error) };
        const providerPoolManager = {
            markAntigravityModelQuotaUnhealthy: jest.fn(),
            markAntigravityModelCapacityUnavailable: jest.fn(),
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyImmediately: jest.fn(),
            releaseSlot: jest.fn()
        };
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            service,
            'gemini-3.5-flash',
            { contents: [] },
            'gemini',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-pro-1',
            'Provider Pro 1',
            { CONFIG: { CREDENTIAL_SWITCH_MAX_RETRIES: 0 }, maxRetries: 0 }
        );

        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthyImmediately).not.toHaveBeenCalled();
    });

    test('records an upstream 404 as a model-level miss without switching credentials', async () => {
        mockGetApiServiceWithFallback.mockReset();
        const error = new Error('Requested entity was not found.');
        error.response = { status: 404, data: { error: { code: 404, message: error.message } } };
        const service = { generateContent: jest.fn().mockRejectedValue(error) };
        const providerPoolManager = {
            markAntigravityModelNotFound: jest.fn(),
            markAntigravityModelQuotaUnhealthy: jest.fn(),
            markAntigravityModelCapacityUnavailable: jest.fn(),
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyImmediately: jest.fn(),
            recordAntigravityRoutingEvent: jest.fn(),
            releaseSlot: jest.fn()
        };
        const res = new FakeResponse();

        await handleUnaryRequest(
            res,
            service,
            'gemini-3.6-flash-medium',
            { contents: [] },
            'gemini',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-pro-1',
            'Provider Pro 1',
            { CONFIG: { CREDENTIAL_SWITCH_MAX_RETRIES: 5 }, maxRetries: 5 }
        );

        expect(providerPoolManager.markAntigravityModelNotFound).toHaveBeenCalledWith(
            'gemini-antigravity',
            'gemini-3.6-flash-medium',
            'Requested entity was not found.'
        );
        expect(mockGetApiServiceWithFallback).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(404);
    });

    test('attributes a failed request to the routed provider, not the default one', async () => {
        mockGetApiServiceWithFallback.mockReset();
        const error = new Error('Requested entity was not found.');
        error.response = { status: 404, data: { error: { code: 404, message: error.message } } };
        const service = { generateContent: jest.fn().mockRejectedValue(error) };
        const metadata = {};
        const runtimeRequest = {
            setMetadata: update => Object.assign(metadata, update),
            mark: jest.fn(),
            recordStage: jest.fn()
        };

        await requestContext.run({ requestId: 'attribution-test', runtimeRequest }, () => handleUnaryRequest(
            new FakeResponse(),
            service,
            'gemini-3.6-flash-medium',
            { contents: [] },
            'gemini',
            'gemini-antigravity',
            'none',
            null,
            { releaseSlot: jest.fn() },
            'provider-pro-1',
            'Provider Pro 1',
            { CONFIG: { CREDENTIAL_SWITCH_MAX_RETRIES: 0 }, maxRetries: 0 }
        ));

        expect(metadata).toMatchObject({
            providerType: 'gemini-antigravity',
            model: 'gemini-3.6-flash-medium',
            stream: false
        });
    });

    test('caps upstream attempts per request even when more credentials are healthy', async () => {
        mockGetApiServiceWithFallback.mockReset();
        const upstreamCalls = [];
        const makeService = uuid => ({
            generateContent: jest.fn(() => {
                upstreamCalls.push(uuid);
                return Promise.reject(createCapacityError());
            })
        });
        mockGetApiServiceWithFallback.mockImplementation(async () => ({
            service: makeService(`retry-${upstreamCalls.length}`),
            uuid: `provider-retry-${upstreamCalls.length}`,
            actualModel: 'gemini-3.1-flash-image',
            actualProviderType: 'gemini-antigravity',
            serviceConfig: {}
        }));
        const providerPoolManager = {
            markAntigravityModelCapacityUnavailable: jest.fn(),
            markAntigravityModelQuotaUnhealthy: jest.fn(),
            markProviderUnhealthyWithRecoveryTime: jest.fn(),
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyImmediately: jest.fn(),
            markProviderHealthy: jest.fn(),
            recordAntigravityRoutingEvent: jest.fn(),
            recordGeminiSchedulingEvent: jest.fn(),
            releaseSlot: jest.fn()
        };

        await requestContext.run({ requestId: 'attempt-cap-test' }, () => handleUnaryRequest(
            new FakeResponse(),
            makeService('provider-initial'),
            'gemini-3.1-flash-image',
            { contents: [] },
            'gemini',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-initial',
            'Provider Initial',
            {
                CONFIG: {
                    CREDENTIAL_SWITCH_MAX_RETRIES: 5,
                    MAX_UPSTREAM_ATTEMPTS_PER_REQUEST: 3
                },
                maxRetries: 5
            }
        ));

        expect(upstreamCalls).toHaveLength(6);
        expect(providerPoolManager.recordAntigravityRoutingEvent).toHaveBeenCalledWith('retrySuppressed');
    });
});

describe('Antigravity capacity exhaustion across client protocols', () => {
    const clientProtocols = ['openai', 'openaiResponses', 'claude', 'gemini'];

    afterEach(() => {
        mockGetApiServiceWithFallback.mockReset();
    });

    test('detects production gRPC capacity errors hidden behind a shallow Service Unavailable message', () => {
        expect(isAntigravityTransientCapacityError(createGrpcCapacityError(), 'gemini-antigravity')).toBe(true);
        expect(isAntigravityTransientCapacityError(createGeneric503Error(), 'gemini-antigravity')).toBe(false);
    });

    test('uses upstream retryDelay for capacity cooldown instead of the 15s default', () => {
        const now = Date.parse('2026-09-06T09:41:04Z');
        jest.spyOn(Date, 'now').mockReturnValue(now);
        const error = createGrpcCapacityError();
        const providerPoolManager = createCapacityPoolManager();

        const applied = applyProviderRateLimitCooldown({
            error,
            config: { RATE_LIMIT_COOLDOWN_MS: 30000 },
            providerPoolManager,
            providerType: 'gemini-antigravity',
            providerUuid: 'provider-ultra-1',
            requestedModel: 'gemini-3.1-flash-lite'
        });

        expect(applied).toBe(true);
        expect(error.status).toBe(429);
        expect(error.statusCode).toBe(429);
        expect(error.shouldSwitchCredential).toBe(true);
        expect(providerPoolManager.markAntigravityModelCapacityUnavailable).toHaveBeenCalledWith(
            'gemini-antigravity',
            { uuid: 'provider-ultra-1' },
            'gemini-3.1-flash-lite',
            new Date(now + 55_000)
        );
    });

    test.each(clientProtocols)('switches Antigravity accounts after a gRPC capacity error for %s clients', async (fromProvider) => {
        const firstService = { generateContent: jest.fn().mockRejectedValue(createGrpcCapacityError()) };
        const secondService = {
            generateContent: jest.fn().mockResolvedValue({
                candidates: [{
                    content: {
                        role: 'model',
                        parts: [{ text: `capacity-switch-${fromProvider}` }]
                    }
                }]
            })
        };
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: secondService,
            uuid: 'provider-ultra-2',
            actualModel: 'gemini-3.1-flash-lite',
            actualProviderType: 'gemini-antigravity',
            serviceConfig: {}
        });
        const providerPoolManager = createCapacityPoolManager();
        const res = new FakeResponse();

        await requestContext.run({ requestId: `capacity-switch-${fromProvider}` }, () => handleUnaryRequest(
            res,
            firstService,
            'gemini-3.1-flash-lite',
            { contents: [] },
            fromProvider,
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-ultra-1',
            'Ultra 1',
            { CONFIG: { CREDENTIAL_SWITCH_MAX_RETRIES: 1 }, maxRetries: 1 }
        ));

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(
            expect.anything(),
            'gemini-3.1-flash-lite',
            expect.objectContaining({
                excludeProviderUuids: ['provider-ultra-1'],
                acquireSlot: true
            })
        );
        expect(secondService.generateContent).toHaveBeenCalledTimes(1);
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.markAntigravityModelCapacityUnavailable).toHaveBeenCalled();
        if (fromProvider === 'gemini') {
            expect(res.statusCode).not.toBe(500);
            expect(res.body).toContain(`capacity-switch-${fromProvider}`);
        }
    });

    test.each(clientProtocols)('returns HTTP 429 instead of 500 when capacity is exhausted for %s clients', async (fromProvider) => {
        mockGetApiServiceWithFallback.mockRejectedValueOnce(new Error('No healthy provider found in pool'));
        const firstService = { generateContent: jest.fn().mockRejectedValue(createGrpcCapacityError()) };
        const providerPoolManager = createCapacityPoolManager();
        const res = new FakeResponse();

        await requestContext.run({ requestId: `capacity-exhausted-${fromProvider}` }, () => handleUnaryRequest(
            res,
            firstService,
            'gemini-3.1-flash-lite',
            { contents: [] },
            fromProvider,
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-ultra-1',
            'Ultra 1',
            { CONFIG: { CREDENTIAL_SWITCH_MAX_RETRIES: 1 }, maxRetries: 1 }
        ));

        expect(res.statusCode).toBe(429);
        expect(res.statusCode).not.toBe(500);
        expect(res.headers['Retry-After']).toBeDefined();
        const body = JSON.parse(res.body);
        if (fromProvider === 'gemini') {
            expect(body.error).toMatchObject({ code: 429, status: 'RESOURCE_EXHAUSTED' });
        } else if (fromProvider === 'claude') {
            expect(body.error).toMatchObject({ type: 'rate_limit_error' });
        } else {
            expect(body.error).toMatchObject({ type: 'rate_limit_error', code: 'rate_limit_error' });
        }
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.markAntigravityModelCapacityUnavailable).toHaveBeenCalled();
    });

    test('switches OpenAI stream accounts before writing an error event', async () => {
        const firstService = {
            generateContentStream: jest.fn().mockImplementation(async function* () {
                throw createGrpcCapacityError();
            })
        };
        const secondService = {
            generateContentStream: jest.fn().mockImplementation(async function* () {
                yield {
                    candidates: [{
                        content: {
                            role: 'model',
                            parts: [{ text: 'capacity-stream-switch' }]
                        }
                    }]
                };
            })
        };
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: secondService,
            uuid: 'provider-ultra-2',
            actualModel: 'gemini-3.1-flash-lite',
            actualProviderType: 'gemini-antigravity',
            serviceConfig: {}
        });
        const providerPoolManager = createCapacityPoolManager();
        const res = new StreamFakeResponse();

        await requestContext.run({ requestId: 'capacity-stream-switch' }, () => handleStreamRequest(
            res,
            firstService,
            'gemini-3.1-flash-lite',
            { contents: [] },
            'openai',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-ultra-1',
            'Ultra 1',
            { CONFIG: { CREDENTIAL_SWITCH_MAX_RETRIES: 1 }, maxRetries: 1 }
        ));

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(
            expect.anything(),
            'gemini-3.1-flash-lite',
            expect.objectContaining({
                excludeProviderUuids: ['provider-ultra-1'],
                acquireSlot: true
            })
        );
        expect(secondService.generateContentStream).toHaveBeenCalledTimes(1);
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.markAntigravityModelCapacityUnavailable).toHaveBeenCalled();
    });

    test('writes OpenAI stream rate_limit_error instead of server_error when capacity stays exhausted', async () => {
        mockGetApiServiceWithFallback.mockRejectedValueOnce(new Error('No healthy provider found in pool'));
        const firstService = {
            generateContentStream: jest.fn().mockImplementation(async function* () {
                throw createGrpcCapacityError();
            })
        };
        const providerPoolManager = createCapacityPoolManager();
        const res = new StreamFakeResponse();

        await requestContext.run({ requestId: 'capacity-stream-exhausted' }, () => handleStreamRequest(
            res,
            firstService,
            'gemini-3.1-flash-lite',
            { contents: [] },
            'openai',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-ultra-1',
            'Ultra 1',
            { CONFIG: { CREDENTIAL_SWITCH_MAX_RETRIES: 1 }, maxRetries: 1 }
        ));

        expect(parseSseErrorType(res.body)).toBe('rate_limit_error');
        expect(res.body).not.toContain('"type":"server_error"');
        expect(providerPoolManager.markAntigravityModelCapacityUnavailable).toHaveBeenCalled();
    });

    test('maps bubbled OpenAI chat-completions capacity errors to HTTP 429 in handleError', () => {
        const res = new FakeResponse();
        const error = createGrpcCapacityError();

        handleError(
            res,
            error,
            'gemini-antigravity',
            null,
            { url: '/gemini-antigravity/v1/chat/completions' }
        );

        expect(res.statusCode).toBe(429);
        expect(res.statusCode).not.toBe(500);
        expect(JSON.parse(res.body).error).toMatchObject({
            type: 'rate_limit_error',
            code: 'rate_limit_error'
        });
    });
});

describe('Antigravity capacity 503 maps to 429 and switches remaining credentials', () => {
    afterEach(() => {
        mockGetApiServiceWithFallback.mockReset();
    });

    test('normalizeAntigravityCapacityExhaustion does not throw on getter-only response.status', () => {
        const error = createReadOnlyAxiosCapacityError('gemini-3.1-flash-lite');
        expect(() => normalizeAntigravityCapacityExhaustion(
            error,
            'gemini-antigravity',
            'gemini-3.1-flash-lite'
        )).not.toThrow();
        expect(error.isAntigravityModelCapacity).toBe(true);
        expect(error.shouldSwitchCredential).toBe(true);
        expect(error.code).toBe('MODEL_CAPACITY_UNAVAILABLE');
        expect(error.response.status).toBe(503);
    });

    test('returns HTTP 429 when axios keeps a read-only 503 after capacity normalize', async () => {
        mockGetApiServiceWithFallback.mockResolvedValueOnce({ service: null, uuid: null });
        const firstService = { generateContent: jest.fn().mockRejectedValue(createReadOnlyAxiosCapacityError()) };
        const providerPoolManager = createCapacityPoolManager();
        const res = new FakeResponse();

        await requestContext.run({ requestId: 'readonly-503-unary' }, () => handleUnaryRequest(
            res,
            firstService,
            'gemini-2.5-flash',
            { contents: [] },
            'openai',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-ultra-1',
            'Ultra 1',
            expiredCodexRetryContext()
        ));

        expect(res.statusCode).toBe(429);
        expect(res.statusCode).not.toBe(500);
        expect(res.statusCode).not.toBe(503);
        expect(res.headers['Retry-After']).toBeDefined();
        expect(JSON.parse(res.body).error).toMatchObject({
            type: 'rate_limit_error',
            code: 'rate_limit_error'
        });
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
    });

    test('switches to another credential after same-credential capacity failure even when Codex retry budget expired', async () => {
        const firstService = { generateContent: jest.fn().mockRejectedValue(createReadOnlyAxiosCapacityError('gemini-2.5-flash-lite')) };
        const secondService = {
            generateContent: jest.fn().mockResolvedValue({
                candidates: [{
                    content: {
                        role: 'model',
                        parts: [{ text: 'capacity-switched' }]
                    }
                }]
            })
        };
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: secondService,
            uuid: 'provider-ultra-2',
            actualModel: 'gemini-2.5-flash-lite',
            actualProviderType: 'gemini-antigravity',
            serviceConfig: {}
        });
        const providerPoolManager = createCapacityPoolManager();
        const res = new FakeResponse();

        await requestContext.run({ requestId: 'capacity-switch-after-codex-budget' }, () => handleUnaryRequest(
            res,
            firstService,
            'gemini-2.5-flash-lite',
            { contents: [] },
            'gemini',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-ultra-1',
            'Ultra 1',
            expiredCodexRetryContext()
        ));

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(
            expect.anything(),
            'gemini-2.5-flash-lite',
            expect.objectContaining({
                excludeProviderUuids: ['provider-ultra-1'],
                acquireSlot: true
            })
        );
        expect(secondService.generateContent).toHaveBeenCalledTimes(1);
        expect(res.statusCode).not.toBe(500);
        expect(res.body).toContain('capacity-switched');
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.markAntigravityModelCapacityUnavailable).toHaveBeenCalled();
    });

    test('returns HTTP 429 when remaining credentials also report no capacity', async () => {
        mockGetApiServiceWithFallback.mockRejectedValueOnce(new Error('No healthy provider found in pool'));
        const firstService = { generateContent: jest.fn().mockRejectedValue(createReadOnlyAxiosCapacityError()) };
        const providerPoolManager = createCapacityPoolManager();
        const res = new FakeResponse();

        await requestContext.run({ requestId: 'capacity-all-exhausted' }, () => handleUnaryRequest(
            res,
            firstService,
            'gemini-2.5-flash',
            { contents: [] },
            'openai',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-ultra-1',
            'Ultra 1',
            expiredCodexRetryContext()
        ));

        expect(res.statusCode).toBe(429);
        expect(res.statusCode).not.toBe(500);
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.markAntigravityModelCapacityUnavailable).toHaveBeenCalled();
    });

    test('switches OpenAI stream credentials after capacity even when Codex retry budget expired', async () => {
        const firstService = {
            generateContentStream: jest.fn().mockImplementation(async function* () {
                throw createReadOnlyAxiosCapacityError('gemini-2.5-flash');
            })
        };
        const secondService = {
            generateContentStream: jest.fn().mockImplementation(async function* () {
                yield {
                    candidates: [{
                        content: {
                            role: 'model',
                            parts: [{ text: 'capacity-stream-remaining' }]
                        }
                    }]
                };
            })
        };
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: secondService,
            uuid: 'provider-ultra-2',
            actualModel: 'gemini-2.5-flash',
            actualProviderType: 'gemini-antigravity',
            serviceConfig: {}
        });
        const providerPoolManager = createCapacityPoolManager();
        const res = new StreamFakeResponse();

        await requestContext.run({ requestId: 'capacity-stream-switch-budget' }, () => handleStreamRequest(
            res,
            firstService,
            'gemini-2.5-flash',
            { contents: [] },
            'openai',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-ultra-1',
            'Ultra 1',
            expiredCodexRetryContext()
        ));

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(
            expect.anything(),
            'gemini-2.5-flash',
            expect.objectContaining({
                excludeProviderUuids: ['provider-ultra-1']
            })
        );
        expect(secondService.generateContentStream).toHaveBeenCalledTimes(1);
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
    });

    test('writes OpenAI stream rate_limit_error for read-only 503 capacity after remaining credentials fail', async () => {
        mockGetApiServiceWithFallback.mockRejectedValueOnce(new Error('No healthy provider found in pool'));
        const firstService = {
            generateContentStream: jest.fn().mockImplementation(async function* () {
                throw createReadOnlyAxiosCapacityError();
            })
        };
        const providerPoolManager = createCapacityPoolManager();
        const res = new StreamFakeResponse();

        await requestContext.run({ requestId: 'capacity-stream-readonly-503' }, () => handleStreamRequest(
            res,
            firstService,
            'gemini-2.5-flash',
            { contents: [] },
            'openai',
            'gemini-antigravity',
            'none',
            null,
            providerPoolManager,
            'provider-ultra-1',
            'Ultra 1',
            expiredCodexRetryContext()
        ));

        expect(parseSseErrorType(res.body)).toBe('rate_limit_error');
        expect(res.body).not.toContain('"type":"server_error"');
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
    });
});
