import { jest } from '@jest/globals';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));

import { createProviderSelectionError } from '../src/services/service-manager.js';
import fs from 'fs';

describe('provider selection error semantics', () => {
    test('keeps Gemini Key concurrency scoped to pool routing', () => {
        const source = fs.readFileSync('src/services/service-manager.js', 'utf8');
        expect(source).toContain("config?.potluckKeyData?.routingMode !== 'pool'");
    });

    test('maps temporary model cooldown to 429 with Retry-After metadata', () => {
        const error = createProviderSelectionError('gemini-antigravity', 'gemini-2.5-flash-lite', {
            totalCandidateCount: 3,
            eligibleCandidateCount: 0,
            filterReasons: { model_cooldown: 3 },
            nextModelRecoveryTime: '2026-08-25T10:00:09.000Z'
        });

        expect(error).toMatchObject({
            status: 429,
            code: 'MODEL_RATE_LIMITED',
            retryAfter: '2026-08-25T10:00:09.000Z'
        });
    });

    test('maps disabled or refresh-required credentials to 503', () => {
        const error = createProviderSelectionError('gemini-antigravity', 'gemini-2.5-flash-lite', {
            totalCandidateCount: 3,
            eligibleCandidateCount: 0,
            filterReasons: { disabled: 1, needs_refresh: 2 }
        });

        expect(error).toMatchObject({ status: 503, code: 'PROVIDER_CREDENTIALS_UNAVAILABLE' });
    });

    test('maps unsupported models to 404 and reserves 500 for internal failures', () => {
        const error = createProviderSelectionError('gemini-antigravity', 'gemini-unknown', {
            totalCandidateCount: 2,
            eligibleCandidateCount: 0,
            filterReasons: { model_unsupported: 2 }
        });

        expect(error).toMatchObject({ status: 404, code: 'MODEL_NOT_SUPPORTED' });
    });
});
