import { beforeEach, describe, expect, test } from '@jest/globals';
import {
    CODEX_RUNTIME_CONFIG_SYNC_TYPE,
    applyCodexRuntimeConfigEvent,
    buildCodexRuntimeConfigEvent,
    resetCodexRuntimeConfigSyncForTests
} from '../src/runtime/codex-runtime-config-sync.js';

describe('Codex runtime config sync', () => {
    beforeEach(() => resetCodexRuntimeConfigSyncForTests());

    test('builds events with strictly increasing revisions and only sync-able keys', () => {
        const first = buildCodexRuntimeConfigEvent({ CODEX_FINGERPRINT_ENABLED: true, PROXY_URL: 'http://secret' });
        const second = buildCodexRuntimeConfigEvent({ CODEX_FINGERPRINT_ENABLED: false });

        expect(first.type).toBe(CODEX_RUNTIME_CONFIG_SYNC_TYPE);
        expect(first.config).toEqual({ CODEX_FINGERPRINT_ENABLED: true });
        expect(second.revision).toBeGreaterThan(first.revision);
    });

    test('applies a newer event, updates config and invalidates only Codex adapters', () => {
        const config = { CODEX_FINGERPRINT_ENABLED: false };
        const instances = {
            'openai-codex-oauthuuid-1': {},
            'openai-codex-oauthuuid-2': {},
            'openai-custom': {}
        };

        const result = applyCodexRuntimeConfigEvent(
            { type: CODEX_RUNTIME_CONFIG_SYNC_TYPE, revision: 10, config: { CODEX_FINGERPRINT_ENABLED: true } },
            config,
            instances
        );

        expect(result).toEqual({ applied: true, revision: 10, invalidated: 2 });
        expect(config.CODEX_FINGERPRINT_ENABLED).toBe(true);
        expect(Object.keys(instances)).toEqual(['openai-custom']);
    });

    test('rejects stale or duplicate revisions without touching config', () => {
        const config = { CODEX_FINGERPRINT_ENABLED: true };
        applyCodexRuntimeConfigEvent({ type: CODEX_RUNTIME_CONFIG_SYNC_TYPE, revision: 20, config: { CODEX_FINGERPRINT_ENABLED: true } }, config, {});

        const stale = applyCodexRuntimeConfigEvent(
            { type: CODEX_RUNTIME_CONFIG_SYNC_TYPE, revision: 20, config: { CODEX_FINGERPRINT_ENABLED: false } },
            config,
            { 'openai-codex-oauthx': {} }
        );

        expect(stale.applied).toBe(false);
        expect(config.CODEX_FINGERPRINT_ENABLED).toBe(true);
    });

    test('ignores events of another type', () => {
        const config = { CODEX_FINGERPRINT_ENABLED: true };
        expect(applyCodexRuntimeConfigEvent({ type: 'other', revision: 99, config: { CODEX_FINGERPRINT_ENABLED: false } }, config, {}).applied).toBe(false);
        expect(config.CODEX_FINGERPRINT_ENABLED).toBe(true);
    });
});

describe('Codex fingerprint audit forwarding', () => {
    test('control worker keeps only the newest remote audit summary', async () => {
        const audit = await import('../src/providers/openai/codex-fingerprint-audit.js');
        audit.clearCodexFingerprintAudit();

        expect(audit.applyRemoteCodexFingerprintAudit('p1', { mode: 'session', rewritten: true, rewrittenAt: '2026-10-12T10:00:00.000Z' })).toBe(true);
        expect(audit.applyRemoteCodexFingerprintAudit('p1', { mode: 'session', rewritten: false, rewrittenAt: '2026-10-12T09:00:00.000Z' })).toBe(false);
        expect(audit.getCodexFingerprintAudit('p1').rewritten).toBe(true);
        expect(audit.applyRemoteCodexFingerprintAudit('', { rewrittenAt: 'x' })).toBe(false);
    });

    test('execution worker forwards a summary at most once per interval per provider', async () => {
        const audit = await import('../src/providers/openai/codex-fingerprint-audit.js');
        audit.clearCodexFingerprintAudit();
        const originalRole = process.env.RUNTIME_WORKER_ROLE;
        const originalSend = process.send;
        const sent = [];
        process.env.RUNTIME_WORKER_ROLE = 'execution';
        process.send = message => sent.push(message);
        try {
            audit.recordCodexFingerprintAudit({ uuid: 'p2' }, { sessionId: 's' }, 'session');
            audit.recordCodexFingerprintAudit({ uuid: 'p2' }, { sessionId: 's' }, 'session');
            audit.recordCodexFingerprintAudit({ uuid: 'p3' }, null, 'off');
        } finally {
            process.env.RUNTIME_WORKER_ROLE = originalRole;
            process.send = originalSend;
        }
        if (originalRole === undefined) delete process.env.RUNTIME_WORKER_ROLE;

        expect(sent.map(message => message.uuid)).toEqual(['p2', 'p3']);
        expect(sent[0].type).toBe(audit.CODEX_FINGERPRINT_AUDIT_SYNC_TYPE);
        expect(JSON.stringify(sent[0])).not.toContain('"sessionId"');
    });
});
