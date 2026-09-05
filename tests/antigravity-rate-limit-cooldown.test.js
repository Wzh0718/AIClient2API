import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
    applyProviderRateLimitCooldown,
    getRetryAfterMs,
    handleUnaryRequest
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

afterEach(() => {
    jest.restoreAllMocks();
});

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

describe('Antigravity model quota cooldown', () => {
    test('switches accounts for transient image capacity without marking the account unhealthy', async () => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
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
        jest.spyOn(Math, 'random').mockReturnValue(0);
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
        jest.spyOn(Math, 'random').mockReturnValue(0);
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
        jest.spyOn(Math, 'random').mockReturnValue(0);
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
        jest.spyOn(Math, 'random').mockReturnValue(0);
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
