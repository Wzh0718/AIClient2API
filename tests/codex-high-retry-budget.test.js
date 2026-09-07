import { describe, expect, test } from '@jest/globals';
import { getCredentialSwitchMaxRetries, getMaxUpstreamAttempts } from '../src/utils/common.js';

describe('Codex high-retry budget for sol / gpt-6', () => {
    test('raises the upstream attempt cap to 20 for gpt-5.6-sol and gpt-6-astra families', () => {
        for (const model of [
            'gpt-5.6-sol',
            'gpt-5.6-sol-fast',
            'gpt-5.6-sol-ultrafast',
            'gpt-6-astra',
            'gpt-6-astra-fast',
            'gpt-6-astra-ultrafast'
        ]) {
            expect(getMaxUpstreamAttempts({}, null, model)).toBe(20);
            expect(getCredentialSwitchMaxRetries({}, model)).toBe(20);
        }
    });

    test('keeps the default 3 / 5 caps for other Codex models', () => {
        for (const model of ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.4-mini']) {
            expect(getMaxUpstreamAttempts({}, null, model)).toBe(3);
            expect(getCredentialSwitchMaxRetries({ CREDENTIAL_SWITCH_MAX_RETRIES: 5 }, model)).toBe(5);
        }
    });

    test('does not let a global MAX_UPSTREAM_ATTEMPTS_PER_REQUEST override shrink the sol/gpt-6 cap', () => {
        expect(getMaxUpstreamAttempts({ MAX_UPSTREAM_ATTEMPTS_PER_REQUEST: 3 }, null, 'gpt-5.6-sol')).toBe(20);
        expect(getMaxUpstreamAttempts({ MAX_UPSTREAM_ATTEMPTS_PER_REQUEST: 3 }, null, 'gpt-6-astra')).toBe(20);
    });
});
