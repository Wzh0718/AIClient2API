import { describe, expect, test } from '@jest/globals';
import {
    hashTemporaryRouteKey,
    preserveTemporaryRouteResponseModel,
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
                paths: ['/v1/responses'],
                models: ['gpt-5.4-mini', 'gpt-5.3-codex-spark'],
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                fallbackToOriginal: true,
                preserveResponseModel: true
            }
        ],
        ...overrides
    };
}

describe('temporary per-key model routing', () => {
    test.each(['gpt-5.4-mini', 'gpt-5.3-codex-spark'])(
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
                fallbackToOriginal: true,
                preserveResponseModel: true
            });
            expect(route.keyHash).toBe(KEY_HASH);
            expect(JSON.stringify(route)).not.toContain(API_KEY);
        }
    );

    test.each([
        { apiKey: 'maki_other', requestPath: '/v1/responses', model: 'gpt-5.4-mini' },
        { apiKey: API_KEY, requestPath: '/v1/chat/completions', model: 'gpt-5.4-mini' },
        { apiKey: API_KEY, requestPath: '/v1/responses', model: 'gpt-5.5' },
        { apiKey: API_KEY, requestPath: '/v1/responses', model: 'gpt-5.4-mini-fast' }
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
                fallbackUsed: false
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
            fallbackUsed: false
        });
        expect(JSON.stringify(event)).not.toContain(API_KEY);
    });
});
