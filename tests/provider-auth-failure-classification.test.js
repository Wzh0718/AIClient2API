import { describe, expect, test } from '@jest/globals';
import { isDefinitiveProviderAuthFailure } from '../src/utils/common.js';

function httpError(status, data, message = 'Request failed') {
    return Object.assign(new Error(message), { response: { status, data } });
}

describe('definitive provider auth failure classification', () => {
    test('401 is always definitive', () => {
        expect(isDefinitiveProviderAuthFailure(httpError(401, 'nope'))).toBe(true);
    });

    test('403 with explicit invalidation or deactivation text is definitive', () => {
        expect(isDefinitiveProviderAuthFailure(httpError(403, { error: { code: 'token_invalidated' } }))).toBe(true);
        expect(isDefinitiveProviderAuthFailure(httpError(403, { detail: { code: 'account_deactivated' } }))).toBe(true);
        expect(isDefinitiveProviderAuthFailure(httpError(403, { error: { code: 'deactivated_workspace' } }))).toBe(true);
        expect(isDefinitiveProviderAuthFailure(httpError(403, 'Your authentication token has been invalidated. Please try signing in again.'))).toBe(true);
    });

    test('a bare forbidden 403 is not treated as a dead credential', () => {
        expect(isDefinitiveProviderAuthFailure(httpError(403, { error: { message: 'Forbidden' } }))).toBe(false);
        expect(isDefinitiveProviderAuthFailure(httpError(403, 'forbidden'))).toBe(false);
    });

    test('Cloudflare or HTML challenge pages on 403 never mark the credential dead', () => {
        const challenge = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Unauthorized access forbidden cf-ray</body></html>';
        expect(isDefinitiveProviderAuthFailure(httpError(403, challenge))).toBe(false);
        expect(isDefinitiveProviderAuthFailure(httpError(403, '<html><body>Attention Required! | Cloudflare unauthorized</body></html>'))).toBe(false);
    });

    test('non-auth statuses without markers are not definitive', () => {
        expect(isDefinitiveProviderAuthFailure(httpError(500, 'boom'))).toBe(false);
        expect(isDefinitiveProviderAuthFailure(httpError(429, 'slow down'))).toBe(false);
    });
});
