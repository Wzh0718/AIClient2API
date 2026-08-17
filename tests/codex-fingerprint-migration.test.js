import { describe, expect, test } from '@jest/globals';
import { migrateCodexFingerprintProviderPools } from '../src/utils/codex-fingerprint-migration.js';

describe('Codex fingerprint provider migration', () => {
    test('defaults missing and invalid Codex OAuth modes to off without touching other providers', () => {
        const pools = {
            'openai-codex-oauth': [
                { uuid: 'missing' },
                { uuid: 'off', codexFingerprintMode: 'off' },
                { uuid: 'invalid', codexFingerprintMode: 'unexpected' }
            ],
            'openai-custom': [{ uuid: 'custom' }]
        };

        const result = migrateCodexFingerprintProviderPools(pools);

        expect(result.changed).toBe(true);
        expect(result.migratedCount).toBe(2);
        expect(result.invalidCount).toBe(1);
        expect(result.providerPools['openai-codex-oauth']).toEqual([
            expect.objectContaining({ uuid: 'missing', codexFingerprintMode: 'off', codexFingerprintVersion: 1 }),
            expect.objectContaining({ uuid: 'off', codexFingerprintMode: 'off' }),
            expect.objectContaining({ uuid: 'invalid', codexFingerprintMode: 'off', codexFingerprintVersion: 1 })
        ]);
        expect(result.providerPools['openai-custom']).toEqual([{ uuid: 'custom' }]);
        expect(pools['openai-codex-oauth'][0].codexFingerprintMode).toBeUndefined();
    });

    test('is idempotent after providers have a valid mode and version', () => {
        const pools = {
            'openai-codex-oauth': [
                { uuid: 'session', codexFingerprintMode: 'session', codexFingerprintVersion: 1 },
                { uuid: 'full', codexFingerprintMode: 'full', codexFingerprintVersion: 1 }
            ]
        };

        const result = migrateCodexFingerprintProviderPools(pools);

        expect(result.changed).toBe(false);
        expect(result.migratedCount).toBe(0);
        expect(result.invalidCount).toBe(0);
        expect(result.providerPools).toEqual(pools);
    });
});
