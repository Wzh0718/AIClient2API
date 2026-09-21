import { describe, expect, test } from '@jest/globals';
import {
    applyCodexFingerprintClientMetadata,
    applyCodexFingerprintHeaders,
    resolveCodexFingerprintIds,
    resolveCodexFingerprintMode
} from '../src/providers/openai/codex-fingerprint.js';

function provider(overrides = {}) {
    return {
        MODEL_PROVIDER: 'openai-codex-oauth',
        uuid: 'provider-a',
        codexAccountKey: 'account-a',
        ...overrides
    };
}

describe('Codex OAuth fingerprint convergence', () => {
    test('defaults eligible Codex OAuth providers to off and requires explicit global opt-in', () => {
        expect(resolveCodexFingerprintMode(provider(), {})).toBe('off');
        expect(resolveCodexFingerprintMode(provider({ codexFingerprintMode: 'device' }), {})).toBe('off');
        expect(resolveCodexFingerprintMode(provider({ codexFingerprintMode: 'device' }), { CODEX_FINGERPRINT_ENABLED: true })).toBe('device');
        expect(resolveCodexFingerprintMode(provider({ codexFingerprintMode: 'session' }), { CODEX_FINGERPRINT_ENABLED: true })).toBe('session');
        expect(resolveCodexFingerprintMode(provider({ codexFingerprintMode: 'full' }), { CODEX_FINGERPRINT_ENABLED: true })).toBe('full');
        expect(resolveCodexFingerprintMode(provider({ codexFingerprintMode: 'off' }), {})).toBe('off');
        expect(resolveCodexFingerprintMode({ MODEL_PROVIDER: 'openai-custom' }, {})).toBe('off');
        expect(resolveCodexFingerprintMode(provider(), { CODEX_FINGERPRINT_ENABLED: false })).toBe('off');
    });

    test('derives stable account ids and session-scoped threads', () => {
        const first = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            globalConfig: { CODEX_FINGERPRINT_ENABLED: true },
            originalClientSessionId: 'client-session-a'
        });
        const repeated = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            globalConfig: { CODEX_FINGERPRINT_ENABLED: true },
            originalClientSessionId: 'client-session-a'
        });
        const otherClient = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            globalConfig: { CODEX_FINGERPRINT_ENABLED: true },
            originalClientSessionId: 'client-session-b'
        });
        const otherAccount = resolveCodexFingerprintIds({
            providerConfig: provider({ uuid: 'provider-b', codexAccountKey: 'account-b', codexFingerprintMode: 'session' }),
            globalConfig: { CODEX_FINGERPRINT_ENABLED: true },
            originalClientSessionId: 'client-session-a'
        });

        expect(first.installationId).toBe(repeated.installationId);
        expect(first.sessionId).toBe(repeated.sessionId);
        expect(first.threadId).toBe(repeated.threadId);
        expect(first.turnId).not.toBe(repeated.turnId);
        expect(first.threadId).not.toBe(otherClient.threadId);
        expect(first.installationId).not.toBe(otherAccount.installationId);
        expect(first.sessionId).not.toBe(otherAccount.sessionId);
    });

    test('keeps a rewritten turn ID stable when the client supplies the same original turn', () => {
        const options = {
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            globalConfig: { CODEX_FINGERPRINT_ENABLED: true },
            originalClientSessionId: 'client-session-a',
            originalTurnId: 'client-turn-a'
        };
        expect(resolveCodexFingerprintIds(options).turnId).toBe(resolveCodexFingerprintIds(options).turnId);
        expect(resolveCodexFingerprintIds(options).turnId).not.toBe(resolveCodexFingerprintIds({ ...options, originalTurnId: 'client-turn-b' }).turnId);
    });

    test('full mode converges threads while device mode only changes installation identity', () => {
        const fullA = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'full' }),
            globalConfig: { CODEX_FINGERPRINT_ENABLED: true },
            originalClientSessionId: 'client-a'
        });
        const fullB = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'full' }),
            globalConfig: { CODEX_FINGERPRINT_ENABLED: true },
            originalClientSessionId: 'client-b'
        });
        const device = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'device' }),
            globalConfig: { CODEX_FINGERPRINT_ENABLED: true },
            originalClientSessionId: 'client-a'
        });

        expect(fullA.threadId).toBe(fullA.sessionId);
        expect(fullB.threadId).toBe(fullA.threadId);
        expect(device.installationId).toBeTruthy();
        expect(device.sessionId).toBeNull();
        expect(device.threadId).toBeNull();

        const headers = {
            'x-codex-installation-id': 'original-installation',
            'session-id': 'original-session',
            session_id: 'original-session-underscore',
            'thread-id': 'original-thread'
        };
        applyCodexFingerprintHeaders(headers, device);
        expect(headers['x-codex-installation-id']).toBe(device.installationId);
        expect(headers['session-id']).toBe('original-session');
        expect(headers.session_id).toBe('original-session-underscore');
        expect(headers['thread-id']).toBe('original-thread');
    });

    test('rewrites headers and client metadata with one shared id set', () => {
        const ids = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            globalConfig: { CODEX_FINGERPRINT_ENABLED: true },
            originalClientSessionId: 'client-session-a'
        });
        const headers = {
            'x-codex-turn-metadata': JSON.stringify({ sandbox: 'workspace-write', turn_id: 'old-turn' })
        };
        const body = {
            client_metadata: {
                sandbox: 'workspace-write',
                'x-codex-turn-metadata': JSON.stringify({ thread_source: 'cli', turn_id: 'old-turn' })
            }
        };

        applyCodexFingerprintHeaders(headers, ids);
        applyCodexFingerprintClientMetadata(body, ids);

        const headerMetadata = JSON.parse(headers['x-codex-turn-metadata']);
        const bodyMetadata = JSON.parse(body.client_metadata['x-codex-turn-metadata']);
        expect(headers['x-codex-installation-id']).toBe(ids.installationId);
        expect(headers['Session-Id']).toBe(ids.sessionId);
        expect(headers['session-id']).toBeUndefined();
        expect(headers['thread-id']).toBe(ids.threadId);
        expect(body.client_metadata.session_id).toBe(ids.sessionId);
        expect(body.client_metadata.thread_id).toBe(ids.threadId);
        expect(headerMetadata.turn_id).toBe(ids.turnId);
        expect(bodyMetadata.turn_id).toBe(ids.turnId);
        expect(headerMetadata.sandbox).toBe('workspace-write');
        expect(bodyMetadata.thread_source).toBe('cli');
    });

    test('fails open for malformed embedded metadata and off mode leaves inputs unchanged', () => {
        const headers = { 'x-codex-turn-metadata': '{bad-json', 'session-id': 'original' };
        const body = { client_metadata: { 'x-codex-turn-metadata': '{bad-json', session_id: 'original' } };
        const originalHeaders = structuredClone(headers);
        const originalBody = structuredClone(body);

        applyCodexFingerprintHeaders(headers, null);
        applyCodexFingerprintClientMetadata(body, null);

        expect(headers).toEqual(originalHeaders);
        expect(body).toEqual(originalBody);

        const ids = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            globalConfig: { CODEX_FINGERPRINT_ENABLED: true },
            originalClientSessionId: 'client'
        });
        expect(() => applyCodexFingerprintHeaders(headers, ids)).not.toThrow();
        expect(() => applyCodexFingerprintClientMetadata(body, ids)).not.toThrow();
        expect(headers['x-codex-turn-metadata']).toBe('{bad-json');
        expect(body.client_metadata['x-codex-turn-metadata']).toBe('{bad-json');
    });

    test('removes case-insensitive header collisions before applying converged IDs', () => {
        const ids = resolveCodexFingerprintIds({
            providerConfig: provider({ codexFingerprintMode: 'session' }),
            globalConfig: { CODEX_FINGERPRINT_ENABLED: true },
            originalClientSessionId: 'client'
        });
        const headers = {
            Session_id: 'cache-session',
            SESSION_ID: 'legacy-session',
            'X-Codex-Installation-Id': 'legacy-installation'
        };

        applyCodexFingerprintHeaders(headers, ids);

        expect(headers.Session_id).toBeUndefined();
        expect(headers.SESSION_ID).toBeUndefined();
        expect(headers['X-Codex-Installation-Id']).toBeUndefined();
        expect(headers['Session-Id']).toBe(ids.sessionId);
        expect(headers.session_id).toBeUndefined();
        expect(headers['x-codex-installation-id']).toBe(ids.installationId);
    });
});
