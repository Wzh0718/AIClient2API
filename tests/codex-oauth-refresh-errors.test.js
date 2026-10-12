import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockPost = jest.fn();

jest.mock('axios', () => ({
    __esModule: true,
    default: { create: jest.fn(() => ({ post: mockPost })) }
}));

jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));

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
    getTLSSidecar: jest.fn(() => ({ isReady: jest.fn(() => false), wrapAxiosConfig: jest.fn() }))
}));

import { refreshCodexTokensWithRetry } from '../src/auth/codex-oauth.js';

function oauthError(error, description = 'rejected') {
    return Object.assign(new Error(description), {
        response: { status: 400, data: { error, error_description: description } }
    });
}

function fakeIdToken() {
    const payload = Buffer.from(JSON.stringify({
        email: 'user@example.com',
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1' }
    })).toString('base64url');
    return `header.${payload}.sig`;
}

describe('Codex OAuth refresh', () => {
    beforeEach(() => mockPost.mockReset());
    afterEach(() => jest.useRealTimers());

    test.each(['invalid_grant', 'refresh_token_reused', 'refresh_token_expired', 'refresh_token_invalidated'])(
        'does not retry a terminal refresh error: %s',
        async code => {
            mockPost.mockRejectedValue(oauthError(code, 'Refresh token is no longer valid'));

            await expect(refreshCodexTokensWithRetry('rt_1', {}, 3)).rejects.toMatchObject({ refreshErrorCode: code });
            expect(mockPost).toHaveBeenCalledTimes(1);
        }
    );

    test('retries transient failures and then succeeds', async () => {
        jest.useFakeTimers();
        mockPost
            .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
            .mockResolvedValueOnce({ data: { id_token: fakeIdToken(), access_token: 'at', refresh_token: 'rt_2', expires_in: 3600 } });

        const pending = refreshCodexTokensWithRetry('rt_1', {}, 3);
        await jest.advanceTimersByTimeAsync(1500);
        const tokens = await pending;

        expect(mockPost).toHaveBeenCalledTimes(2);
        expect(tokens.access_token).toBe('at');
    });

    test('sends the Codex client scope and JSON accept header on refresh', async () => {
        mockPost.mockResolvedValue({ data: { id_token: fakeIdToken(), access_token: 'at', expires_in: 3600 } });

        await refreshCodexTokensWithRetry('rt_1', {}, 1);

        const [, body, options] = mockPost.mock.calls[0];
        const params = new URLSearchParams(body);
        expect(params.get('grant_type')).toBe('refresh_token');
        expect(params.get('scope')).toBe('openid profile email');
        expect(options.headers.Accept).toBe('application/json');
    });
});
