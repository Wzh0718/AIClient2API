import { describe, expect, test } from '@jest/globals';
import { isTransientProviderJitterError } from '../src/utils/provider-error-classification.js';

describe('transient provider jitter classification', () => {
    test('treats Cloudflare 520 and other edge timeouts as jitter', () => {
        expect(isTransientProviderJitterError({ response: { status: 520 } })).toBe(true);
        expect(isTransientProviderJitterError({ response: { status: 522 } })).toBe(true);
        expect(isTransientProviderJitterError({ response: { status: 504 } })).toBe(true);
        expect(isTransientProviderJitterError({ response: { status: 408 } })).toBe(true);
        expect(isTransientProviderJitterError({ response: { status: 429 } })).toBe(true);
        expect(isTransientProviderJitterError({ response: { status: 503 } })).toBe(true);
    });

    test('treats network resets and health-check timeouts as jitter', () => {
        expect(isTransientProviderJitterError({ code: 'ECONNRESET', message: 'aborted' })).toBe(true);
        expect(isTransientProviderJitterError({ message: 'socket hang up' })).toBe(true);
        expect(isTransientProviderJitterError({ code: 'ETIMEDOUT' })).toBe(true);
        expect(isTransientProviderJitterError({ code: 'HEALTH_CHECK_TIMEOUT', message: 'Health check timed out after 60000ms' })).toBe(true);
        expect(isTransientProviderJitterError('Health check timed out after 60000ms')).toBe(true);
        expect(isTransientProviderJitterError('520 Web Server Returned an Unknown Error')).toBe(true);
        expect(isTransientProviderJitterError('aborted')).toBe(true);
    });

    test('does not treat auth or generic application failures as jitter', () => {
        expect(isTransientProviderJitterError({ response: { status: 401 } })).toBe(false);
        expect(isTransientProviderJitterError({ response: { status: 403 } })).toBe(false);
        expect(isTransientProviderJitterError({ response: { status: 400 } })).toBe(false);
        expect(isTransientProviderJitterError({ response: { status: 500 } })).toBe(false);
        expect(isTransientProviderJitterError({ message: 'token_invalidated' })).toBe(false);
    });
});
