import { describe, expect, test } from '@jest/globals';
import {
    getTemporaryRouteScheduleDiagnostics,
    hashTemporaryRouteKey,
    preserveTemporaryRouteResponseModel,
    recordTemporaryRouteScheduleBypass,
    resetTemporaryRouteScheduleDiagnosticsForTests,
    resolveTemporaryKeyModelRoute
} from '../src/utils/temporary-key-model-routing.js';
import { buildRequestAuditEvent } from '../src/plugins/request-audit/audit-event.js';

const API_KEY = 'maki_test_route_secret';
const KEY_HASH = hashTemporaryRouteKey(API_KEY);

function createConfig(overrides = {}) {
    return {
        temporaryKeyModelRoutes: [
            {
                id: 'temporary-antigravity-flash',
                enabled: true,
                keyHash: KEY_HASH,
                paths: ['/v1/responses', '/v1/chat/completions'],
                sourceProviderTypes: ['openai-codex-oauth'],
                modelFamilies: ['gpt-5.3', 'gpt-5.4'],
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                fallbackModel: 'gpt-5.4-mini',
                fallbackToOriginal: true,
                preserveResponseModel: true
            }
        ],
        ...overrides
    };
}

function createScheduledConfig(overrides = {}) {
    const config = createConfig({
        workdayCalendars: {
            'cn-statutory-workday': {
                timezone: 'Asia/Shanghai',
                years: {
                    2026: {
                        holidays: ['2026-10-02'],
                        makeupWorkdays: ['2026-09-20']
                    }
                }
            }
        }
    });
    config.temporaryKeyModelRoutes[0].targetBlackout = {
        timezone: 'Asia/Shanghai',
        calendar: 'cn-statutory-workday',
        start: '10:00',
        end: '19:00',
        modelFamilies: ['gpt-5.4', 'gpt-5.3-codex-spark'],
        fallbackProviderType: 'openai-codex-oauth',
        fallbackModel: 'gpt-5.4-mini'
    };
    return { ...config, ...overrides };
}

describe('temporary per-key model routing', () => {
    test('records scheduled bypasses and missing calendar years without sensitive route data', () => {
        resetTemporaryRouteScheduleDiagnosticsForTests();
        recordTemporaryRouteScheduleBypass({ calendarDegraded: false, calendarYear: 2026 });
        recordTemporaryRouteScheduleBypass({ calendarDegraded: true, calendarYear: 2027 });

        expect(getTemporaryRouteScheduleDiagnostics()).toEqual({
            scheduledBypasses: 2,
            calendarDegraded: true,
            missingCalendarYears: [2027]
        });
        resetTemporaryRouteScheduleDiagnosticsForTests();
    });

    test.each([
        'gpt-5.3',
        'gpt-5.3-codex-spark',
        'gpt-5.3-codex-spark-fast',
        'gpt-5.4',
        'gpt-5.4-fast',
        'gpt-5.4-mini',
        'gpt-5.4-mini-fast'
    ])(
        'routes matching %s responses requests to Antigravity',
        model => {
            const route = resolveTemporaryKeyModelRoute({
                config: createConfig(),
                apiKey: API_KEY,
                requestPath: '/v1/responses',
                model,
                originalProviderType: 'openai-codex-oauth'
            });

            expect(route).toMatchObject({
                id: 'temporary-antigravity-flash',
                requestedModel: model,
                originalProviderType: 'openai-codex-oauth',
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                fallbackModel: 'gpt-5.4-mini',
                fallbackToOriginal: true,
                preserveResponseModel: true
            });
            expect(route.keyHash).toBe(KEY_HASH);
            expect(JSON.stringify(route)).not.toContain(API_KEY);
        }
    );

    test.each([
        '/v1/responses',
        '/openai-codex-oauth/v1/responses',
        '/v1/chat/completions',
        '/openai-codex-oauth/v1/chat/completions'
    ])('treats supported Codex endpoint path %s as the same routing surface', requestPath => {
        const route = resolveTemporaryKeyModelRoute({
            config: createConfig(),
            apiKey: API_KEY,
            requestPath,
            model: 'gpt-5.4-mini',
            originalProviderType: 'openai-codex-oauth'
        });

        expect(route).toMatchObject({
            targetProviderType: 'gemini-antigravity',
            targetModel: 'gemini-2.5-flash'
        });
    });

    test.each([
        '/other-provider/v1/chat/completions',
        '/v1/chat/completions/extra',
        '/prefix/v1/responses',
        '/v1/responses-extra'
    ])('does not fuzzy-match unsafe endpoint path %s', requestPath => {
        expect(resolveTemporaryKeyModelRoute({
            config: createConfig(),
            apiKey: API_KEY,
            requestPath,
            model: 'gpt-5.4-mini',
            originalProviderType: 'openai-codex-oauth'
        })).toBeNull();
    });

    test('requires the configured source provider when present', () => {
        expect(resolveTemporaryKeyModelRoute({
            config: createConfig(),
            apiKey: API_KEY,
            requestPath: '/v1/responses',
            model: 'gpt-5.4-mini',
            originalProviderType: 'openai-custom'
        })).toBeNull();
    });

    test.each([
        { apiKey: 'maki_other', requestPath: '/v1/responses', model: 'gpt-5.4-mini' },
        { apiKey: API_KEY, requestPath: '/v1/responses', model: 'gpt-5.5' },
        { apiKey: API_KEY, requestPath: '/v1/responses', model: 'gpt-5.30' },
        { apiKey: API_KEY, requestPath: '/v1/responses', model: 'gpt-5.4foo' },
        { apiKey: API_KEY, requestPath: '/v1/responses', model: 'my-gpt-5.4' }
    ])('does not route non-matching request %#', request => {
        expect(resolveTemporaryKeyModelRoute({
            config: createConfig(),
            ...request,
            originalProviderType: 'openai-codex-oauth'
        })).toBeNull();
    });

    test('does not route when the rule is disabled', () => {
        const config = createConfig();
        config.temporaryKeyModelRoutes[0].enabled = false;

        expect(resolveTemporaryKeyModelRoute({
            config,
            apiKey: API_KEY,
            requestPath: '/v1/responses',
            model: 'gpt-5.4-mini',
            originalProviderType: 'openai-codex-oauth'
        })).toBeNull();
    });

    test('keeps exact model matching backward compatible', () => {
        const config = createConfig();
        delete config.temporaryKeyModelRoutes[0].modelFamilies;
        config.temporaryKeyModelRoutes[0].models = ['gpt-5.4-mini'];

        expect(resolveTemporaryKeyModelRoute({
            config,
            apiKey: API_KEY,
            requestPath: '/v1/responses',
            model: 'gpt-5.4-mini',
            originalProviderType: 'openai-codex-oauth'
        })).not.toBeNull();
        expect(resolveTemporaryKeyModelRoute({
            config,
            apiKey: API_KEY,
            requestPath: '/v1/responses',
            model: 'gpt-5.4-mini-fast',
            originalProviderType: 'openai-codex-oauth'
        })).toBeNull();
    });

    test('requires a full SHA-256 hash instead of accepting plaintext keys', () => {
        const config = createConfig();
        config.temporaryKeyModelRoutes[0].keyHash = API_KEY;

        expect(resolveTemporaryKeyModelRoute({
            config,
            apiKey: API_KEY,
            requestPath: '/v1/responses',
            model: 'gpt-5.4-mini',
            originalProviderType: 'openai-codex-oauth'
        })).toBeNull();
    });

    test.each([
        ['2026-08-18T01:59:59.000Z', false],
        ['2026-08-18T02:00:00.000Z', true],
        ['2026-08-18T10:59:59.000Z', true],
        ['2026-08-18T11:00:00.000Z', false]
    ])('uses a Beijing half-open blackout window at %s', (now, expectedBlackout) => {
        const route = resolveTemporaryKeyModelRoute({
            config: createScheduledConfig(),
            apiKey: API_KEY,
            requestPath: '/v1/responses',
            model: 'gpt-5.4-mini',
            originalProviderType: 'openai-codex-oauth',
            now: new Date(now)
        });

        expect(Boolean(route.scheduleBypass)).toBe(expectedBlackout);
        if (expectedBlackout) {
            expect(route.scheduleBypass).toEqual({
                reason: 'scheduled_blackout',
                targetAttempted: false,
                fallbackProviderType: 'openai-codex-oauth',
                fallbackModel: 'gpt-5.4-mini',
                calendarDegraded: false,
                calendarYear: 2026
            });
        }
    });

    test.each([
        ['2026-10-02T04:00:00.000Z', false, 'weekday statutory holiday'],
        ['2026-09-20T04:00:00.000Z', true, 'weekend makeup workday'],
        ['2026-08-22T04:00:00.000Z', false, 'regular weekend']
    ])('honors the statutory calendar for a %s', (now, expectedBlackout) => {
        const route = resolveTemporaryKeyModelRoute({
            config: createScheduledConfig(),
            apiKey: API_KEY,
            requestPath: '/v1/responses',
            model: 'gpt-5.4',
            originalProviderType: 'openai-codex-oauth',
            now: new Date(now)
        });

        expect(Boolean(route.scheduleBypass)).toBe(expectedBlackout);
    });

    test.each([
        ['gpt-5.4', true],
        ['gpt-5.4-mini-fast', true],
        ['gpt-5.3-codex-spark', true],
        ['gpt-5.3-codex-spark-fast', true],
        ['gpt-5.3', false]
    ])('applies the daytime Luna bypass only to the configured safe model family %s', (model, expectedBlackout) => {
        const route = resolveTemporaryKeyModelRoute({
            config: createScheduledConfig(),
            apiKey: API_KEY,
            requestPath: '/v1/chat/completions',
            model,
            originalProviderType: 'openai-codex-oauth',
            now: new Date('2026-08-18T04:00:00.000Z')
        });

        expect(Boolean(route.scheduleBypass)).toBe(expectedBlackout);
    });

    test('falls back to weekday protection and marks the route degraded when the calendar year is missing', () => {
        const route = resolveTemporaryKeyModelRoute({
            config: createScheduledConfig(),
            apiKey: API_KEY,
            requestPath: '/v1/responses',
            model: 'gpt-5.4-mini',
            originalProviderType: 'openai-codex-oauth',
            now: new Date('2027-08-18T04:00:00.000Z')
        });

        expect(route.scheduleBypass).toMatchObject({
            reason: 'scheduled_blackout',
            calendarDegraded: true,
            calendarYear: 2027
        });
    });

    test('preserves top-level and nested response model fields without mutating input', () => {
        const response = {
            model: 'gemini-2.5-flash',
            type: 'response.completed',
            response: {
                model: 'gemini-2.5-flash',
                output: [{ type: 'message', model: 'gemini-2.5-flash' }]
            }
        };

        const preserved = preserveTemporaryRouteResponseModel(response, 'gpt-5.4-mini');

        expect(preserved).toEqual({
            model: 'gpt-5.4-mini',
            type: 'response.completed',
            response: {
                model: 'gpt-5.4-mini',
                output: [{ type: 'message', model: 'gpt-5.4-mini' }]
            }
        });
        expect(response.response.model).toBe('gemini-2.5-flash');
    });

    test('records requested and actual temporary-route details without exposing the key', () => {
        const event = buildRequestAuditEvent({
            potluckApiKey: API_KEY,
            originalRequestBody: { model: 'gpt-5.4-mini' },
            model: 'gemini-2.5-flash',
            fromProvider: 'openaiResponses',
            toProvider: 'gemini-antigravity',
            _temporaryKeyModelRouteResult: {
                id: 'temporary-antigravity-flash',
                keyHash: KEY_HASH,
                requestedModel: 'gpt-5.4-mini',
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                actualProviderType: 'gemini-antigravity',
                actualModel: 'gemini-2.5-flash',
                credentialRetryUsed: true,
                fallbackUsed: true,
                fallbackReason: 'scheduled_blackout',
                targetAttempted: false
            }
        });

        expect(event.request).toMatchObject({
            requestedModel: 'gpt-5.4-mini',
            actualModel: 'gemini-2.5-flash',
            toProvider: 'gemini-antigravity'
        });
        expect(event.routing.temporaryModelRoute).toEqual({
            id: 'temporary-antigravity-flash',
            targetProviderType: 'gemini-antigravity',
            targetModel: 'gemini-2.5-flash',
            actualProviderType: 'gemini-antigravity',
            actualModel: 'gemini-2.5-flash',
            credentialRetryUsed: true,
            fallbackUsed: true,
            fallbackReason: 'scheduled_blackout',
            targetAttempted: false
        });
        expect(JSON.stringify(event)).not.toContain(API_KEY);
    });
});
