import { describe, expect, jest, test } from '@jest/globals';
import { buildImageCapacityErrorLog, buildImageGenerationErrorAudit } from '../src/services/api-manager.js';

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(),
    getApiServiceWithFallback: jest.fn()
}));

describe('image generation error audit', () => {
    test('keeps capacity diagnostics safe and separate from the client-facing error message', () => {
        const error = new Error('Image capacity exceeded');
        error.code = 'IMAGE_CAPACITY_EXCEEDED';
        error.details = {
            blockedReasons: ['rss', 'event_loop'],
            activeBytes: 0,
            budgetBytes: 100,
            estimatedBytes: 20,
            rssBytes: 850,
            rssLimitBytes: 1000,
            eventLoopP95Ms: 250,
            queued: 0
        };

        expect(buildImageCapacityErrorLog(error)).toEqual(error.details);
        expect(buildImageCapacityErrorLog(new Error('upstream failed'))).toBeNull();
        expect(JSON.stringify(buildImageCapacityErrorLog(error))).not.toMatch(/token|cookie|apiKey|uuid/i);
    });

    test('captures upstream 429 details and retry decision without raw payloads', () => {
        const error = new Error('rate limited');
        error.response = {
            status: 429,
            headers: {
                'retry-after': '60',
                'x-request-id': 'upstream-req-1'
            },
            data: {
                error: {
                    code: 'rate_limit_exceeded',
                    type: 'rate_limit',
                    message: 'too many requests'
                }
            }
        };

        const audit = buildImageGenerationErrorAudit({
            requestId: 'client:req-1',
            model: 'gpt-image-2',
            providerType: 'openai-codex-oauth',
            providerUuid: 'codex-account-a',
            providerName: 'Codex Account A',
            currentRetry: 1,
            maxRetries: 3,
            error,
            cooldownApplied: true,
            willRetry: true
        });

        expect(audit).toMatchObject({
            event: 'image_generation_error',
            reqId: 'client:req-1',
            providerType: 'openai-codex-oauth',
            accountUuid: 'codex-account-a',
            accountLabel: 'Codex Account A',
            model: 'gpt-image-2',
            status: 'failed',
            errorClass: 'upstream_429',
            httpStatus: 429,
            errorCode: 'rate_limit_exceeded',
            errorType: 'rate_limit',
            message: 'too many requests',
            retryAfterMs: 60000,
            upstreamRequestId: 'upstream-req-1',
            currentRetry: 1,
            maxRetries: 3,
            cooldownApplied: true,
            willRetry: true
        });
        expect(JSON.stringify(audit)).not.toContain('prompt');
        expect(JSON.stringify(audit)).not.toContain('access_token');
    });

    test('classifies local image capacity separately from an upstream 429', () => {
        const error = new Error('Image service is temporarily at capacity');
        error.code = 'image_capacity_exceeded';
        error.type = 'server_overloaded';
        error.status = 503;
        error.statusCode = 503;

        const audit = buildImageGenerationErrorAudit({
            requestId: 'client:req-local-capacity',
            model: 'gpt-image-2',
            error
        });

        expect(audit).toMatchObject({
            errorClass: 'local_capacity',
            httpStatus: 503,
            errorCode: 'image_capacity_exceeded',
            errorType: 'server_overloaded'
        });
    });
});
