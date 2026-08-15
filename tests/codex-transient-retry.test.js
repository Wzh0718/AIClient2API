import { EventEmitter } from 'events';
import { describe, expect, jest, test } from '@jest/globals';

const mockGetApiServiceWithFallback = jest.fn();

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        getCurrentRequestId: jest.fn(() => null)
    }
}));

jest.mock('../src/services/service-manager.js', () => ({
    __esModule: true,
    getApiServiceWithFallback: mockGetApiServiceWithFallback
}));

import { handleUnaryRequest, resolveFinalUsageAccountContext } from '../src/utils/common.js';
import logger from '../src/utils/logger.js';

class FakeResponse extends EventEmitter {
    constructor() {
        super();
        this.body = '';
        this.writableEnded = false;
    }

    writeHead() {}

    write(chunk) {
        this.body += String(chunk);
    }

    end(chunk = '') {
        this.body += String(chunk);
        this.writableEnded = true;
    }
}

function createProviderPoolManager() {
    return {
        markProviderHealthy: jest.fn(),
        markProviderUnhealthy: jest.fn(),
        markProviderUnhealthyImmediately: jest.fn(),
        markProviderUnhealthyWithRecoveryTime: jest.fn(),
        markCodexQuotaBucketUnhealthy: jest.fn(),
        releaseSlot: jest.fn()
    };
}

function createCapacityError() {
    const error = new Error('Selected model is at capacity. Please try a different model.');
    error.response = { status: 429, data: { error: { code: 'server_is_overloaded' } } };
    error.isCodexModelCapacity = true;
    error.origin = 'upstream_codex';
    error.shouldSwitchCredential = true;
    error.skipErrorCount = true;
    return error;
}

describe('Codex transient credential retry', () => {
    test('uses one final credential snapshot for usage metadata after switching providers', () => {
        expect(resolveFinalUsageAccountContext({
            selectedProviderUuid: 'codex-b',
            providerName: 'Codex B',
            accountIdentity: 'account-b',
            accountEmail: 'b@example.com'
        }, {
            providerUuid: 'codex-a',
            providerName: 'Codex A',
            accountIdentity: 'account-a',
            accountEmail: 'a@example.com'
        })).toEqual({
            providerUuid: 'codex-b',
            providerName: 'Codex B',
            accountIdentity: 'account-b',
            accountEmail: 'b@example.com'
        });

        expect(resolveFinalUsageAccountContext({
            selectedProviderUuid: 'codex-b'
        }, {
            providerUuid: 'codex-a',
            providerName: 'Codex A',
            accountIdentity: 'account-a',
            accountEmail: 'a@example.com'
        })).toEqual({
            providerUuid: 'codex-b',
            providerName: null,
            accountIdentity: null,
            accountEmail: null
        });
    });

    test('re-enters standard service selection without delay and allows eligible credential reuse', async () => {
        const firstError = createCapacityError();
        const firstService = { generateContent: jest.fn().mockRejectedValue(firstError) };
        const secondService = { generateContent: jest.fn().mockResolvedValue({ id: 'resp_retry_success' }) };
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: secondService,
            uuid: 'codex-b',
            actualModel: 'gpt-5.5',
            actualProviderType: 'openai-codex-oauth',
            serviceConfig: {}
        });
        const providerPoolManager = createProviderPoolManager();
        const res = new FakeResponse();
        const config = { CREDENTIAL_SWITCH_MAX_RETRIES: 1 };

        await handleUnaryRequest(
            res,
            firstService,
            'gpt-5.5',
            { input: [] },
            'openai-codex-oauth',
            'openai-codex-oauth',
            'none',
            null,
            providerPoolManager,
            'codex-a',
            'Codex A',
            { CONFIG: config, maxRetries: 1 }
        );

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(config, 'gpt-5.5', expect.objectContaining({
            acquireSlot: true,
            excludeProviderUuids: ['codex-a'],
            allowExcludedProviderFallback: true
        }));
        expect(secondService.generateContent).toHaveBeenCalledTimes(1);
        expect(res.body).toContain('resp_retry_success');
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('kind=capacity'));
        expect(mockGetApiServiceWithFallback.mock.calls[0][2]).not.toHaveProperty('forceCodexModelFallback');
    });

    test('requests a one-time Luna fallback after an upstream 429 for 5.4 mini', async () => {
        const firstError = createCapacityError();
        const firstService = { generateContent: jest.fn().mockRejectedValue(firstError) };
        const lunaService = { generateContent: jest.fn().mockResolvedValue({ id: 'resp_luna_success' }) };
        mockGetApiServiceWithFallback.mockResolvedValueOnce({
            service: lunaService,
            uuid: 'codex-luna',
            actualModel: 'gpt-5.6-luna',
            actualProviderType: 'openai-codex-oauth',
            serviceConfig: {}
        });
        const providerPoolManager = createProviderPoolManager();
        const res = new FakeResponse();
        const config = { CREDENTIAL_SWITCH_MAX_RETRIES: 1 };

        await handleUnaryRequest(
            res,
            firstService,
            'gpt-5.4-mini',
            { input: [] },
            'openai-codex-oauth',
            'openai-codex-oauth',
            'none',
            null,
            providerPoolManager,
            'codex-a',
            'Codex A',
            { CONFIG: config, maxRetries: 1 }
        );

        expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(config, 'gpt-5.4-mini', expect.objectContaining({
            forceCodexModelFallback: true,
            modelFallbackReason: 'UPSTREAM_429'
        }));
        expect(lunaService.generateContent).toHaveBeenCalledTimes(1);
        expect(res.body).toContain('resp_luna_success');
    });
});
