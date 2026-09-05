import { describe, expect, test } from '@jest/globals';
import { normalizeProviderConfigFields } from '../src/utils/provider-config-normalizer.js';

describe('provider config normalizer', () => {
    test('normalizes split Codex percentage quota limits as non-negative numbers', () => {
        const normalized = normalizeProviderConfigFields({
            codexGeneralMax5hPercent: '80',
            codexGeneralMaxWeeklyPercent: '90',
            codex53Max5hPercent: '70',
            codex53MaxWeeklyPercent: '75'
        });

        expect(normalized).toMatchObject({
            codexGeneralMax5hPercent: 80,
            codexGeneralMaxWeeklyPercent: 90
        });
        expect(normalized).not.toHaveProperty('codex53Max5hPercent');
        expect(normalized).not.toHaveProperty('codex53MaxWeeklyPercent');
    });

    test('normalizes Antigravity family quota limits as non-negative numbers', () => {
        const normalized = normalizeProviderConfigFields({
            antigravityGeminiMax5hPercent: '80',
            antigravityGeminiMaxWeeklyPercent: '90',
            antigravityThirdPartyMax5hPercent: '70',
            antigravityThirdPartyMaxWeeklyPercent: '75'
        });

        expect(normalized).toMatchObject({
            antigravityGeminiMax5hPercent: 80,
            antigravityGeminiMaxWeeklyPercent: 90,
            antigravityThirdPartyMax5hPercent: 70,
            antigravityThirdPartyMaxWeeklyPercent: 75
        });
    });

    test('removes legacy Codex token quota limit fields from saved config', () => {
        const normalized = normalizeProviderConfigFields({
            codexMax5hTokens: '100000000',
            codexMaxWeeklyTokens: '500000000',
            codexMax5hPercent: '80',
            codexMaxWeeklyPercent: '90',
            codexGeneralMax5hPercent: '85'
        });

        expect(normalized.codexMax5hTokens).toBeUndefined();
        expect(normalized.codexMaxWeeklyTokens).toBeUndefined();
        expect(normalized.codexMax5hPercent).toBeUndefined();
        expect(normalized.codexMaxWeeklyPercent).toBeUndefined();
        expect(normalized.codexGeneralMax5hPercent).toBe(85);
    });

    test('removes legacy provider node proxy fields from saved config', () => {
        const normalized = normalizeProviderConfigFields({
            PROXY_URL: 'socks5h://127.0.0.1:11001',
            PROXY_REQUIRED: 'true',
            PROXY_ID: 'res-ip-1'
        });

        expect(normalized.PROXY_URL).toBeUndefined();
        expect(normalized.PROXY_REQUIRED).toBeUndefined();
        expect(normalized.PROXY_ID).toBe('res-ip-1');
    });
});
