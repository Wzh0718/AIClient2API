import { describe, expect, test } from '@jest/globals';
import {
    buildGeminiSelectionDiagnostic,
    buildGeminiRetryDiagnostic,
    buildGeminiCleanupDiagnostic,
    classifyProviderInitializationError,
    hashDiagnosticIdentifier
} from '../src/utils/gemini-diagnostics.js';

describe('Gemini diagnostics', () => {
    test('hashes sensitive provider identifiers deterministically', () => {
        expect(hashDiagnosticIdentifier('provider-uuid')).toHaveLength(16);
        expect(hashDiagnosticIdentifier('provider-uuid')).toBe(hashDiagnosticIdentifier('provider-uuid'));
        expect(hashDiagnosticIdentifier('provider-uuid')).not.toBe('provider-uuid');
    });

    test('builds a sanitized provider selection event with filter and timing fields', () => {
        const event = buildGeminiSelectionDiagnostic({
            workerId: 'execution-1',
            requestedModel: 'gemini-2.5-flash',
            selectionDiagnostics: {
                totalCandidateCount: 4,
                eligibleCandidateCount: 1,
                filterReasons: { model_cooldown: 2, needs_refresh: 1 },
                keyQueueWaitMs: 4200,
                keyQueueOutcome: 'admitted',
                attempts: [{ eligibleCandidateCount: 1 }]
            },
            selectedProvider: {
                uuid: 'provider-uuid',
                config: {
                    uuid: 'provider-uuid',
                    providerWeight: 3,
                    proxyPool: 'secret-proxy-name'
                },
                state: { activeCount: 2, waitingCount: 1 }
            },
            durationMs: 4300
        });

        expect(event).toMatchObject({
            event: 'provider_selection',
            providerType: 'gemini-antigravity',
            requestedModel: 'gemini-2.5-flash',
            initialCandidateCount: 4,
            eligibleCandidateCount: 1,
            selectedProviderUuidHash: hashDiagnosticIdentifier('provider-uuid'),
            selectedProviderWeight: 3,
            selectedActiveCount: 2,
            selectedWaitingCount: 1,
            queueWaitMs: 4200,
            selectionDurationMs: 4300
        });
        expect(event.selectedProxyPool).toBe(hashDiagnosticIdentifier('secret-proxy-name'));
        expect(event).not.toHaveProperty('selectedProviderUuid');
    });

    test('classifies initialization failures without exposing upstream details', () => {
        expect(classifyProviderInitializationError({ response: { status: 429 } })).toBe('quota_exhausted');
        expect(classifyProviderInitializationError({ response: { status: 401 } })).toBe('auth_error');
        expect(classifyProviderInitializationError({ code: 'ECONNRESET' })).toBe('network_error');
        expect(classifyProviderInitializationError(new Error('timeout'))).toBe('network_error');
    });

    test('builds sanitized retry and cleanup events', () => {
        const retry = buildGeminiRetryDiagnostic({
            mode: 'stream', requestedModel: 'gemini-2.5-flash', providerUuid: 'secret-uuid',
            attempt: 2, maxRetries: 5, reason: 'RESOURCE_EXHAUSTED', status: 429,
            backoffMs: 40, switchedProvider: true, nextEligibleCount: 3, fallbackCount: 1, outcome: 'switch'
        });
        expect(retry).toMatchObject({ event: 'retry', mode: 'stream', attempt: 2, status: 429, switchedProvider: true });
        expect(retry.providerUuidHash).toBe(hashDiagnosticIdentifier('secret-uuid'));
        expect(retry).not.toHaveProperty('providerUuid');

        const cleanup = buildGeminiCleanupDiagnostic({
            requestedModel: 'gemini-2.5-flash', providerUuid: 'secret-uuid', clientAborted: true,
            queueCancelled: true, leaseReleased: true, upstreamAborted: true, retryTimerCancelled: true, cleanupMs: 12
        });
        expect(cleanup).toMatchObject({ event: 'cleanup', clientAborted: true, queueCancelled: true, leaseReleased: true, upstreamAborted: true });
        expect(cleanup.providerUuidHash).toBe(hashDiagnosticIdentifier('secret-uuid'));
    });
});
