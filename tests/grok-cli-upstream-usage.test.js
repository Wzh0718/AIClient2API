import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/auth/oauth-handlers.js', () => ({
    refreshGrokCliTokensWithRetry: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

jest.mock('../src/providers/adapter.js', () => ({
    serviceInstances: {}
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(config => config)
}));

import { GrokCliApiService } from '../src/providers/grok/grok-cli-core.js';
import { formatGrokCliUsage } from '../src/services/usage-service.js';

describe('Grok CLI upstream usage support', () => {
    test('ignores SSE comments and accepts data prefixes without a space', () => {
        const service = new GrokCliApiService({
            MODEL_PROVIDER: 'grok-cli-oauth'
        });

        expect(service.parseSSELine(': keepalive')).toBeNull();
        expect(service.parseSSELine('event: message')).toBeNull();
        expect(service.parseSSELine('data:{"type":"message"}')).toEqual({ type: 'message' });
    });

    test('formats the billing response as quota rather than credential status', () => {
        const formatted = formatGrokCliUsage({
            account: 'grok@example.com',
            summary: {
                weeklyLimitPercent: 37.5,
                periodEnd: '2026-08-01T00:00:00.000Z',
                grokAccountTier: 'SuperGrok',
                products: [
                    { product: 'Grok 4', usagePercent: 42 }
                ]
            }
        });

        expect(formatted.summary).toMatchObject({
            usedPercent: 37.5,
            plan: 'SuperGrok',
            unit: 'percent',
            resetAt: '2026-08-01T00:00:00.000Z'
        });
        expect(formatted.items).toEqual([
            expect.objectContaining({
                id: 'Grok 4',
                used: 42,
                limit: 100,
                unit: 'percent'
            })
        ]);
    });

    test('deduplicates built-in tools that share the same xAI tool name', async () => {
        const service = new GrokCliApiService({
            MODEL_PROVIDER: 'grok-cli-oauth',
            GROK_CLI_ENABLE_BUILTIN_TOOLS: false
        });

        const request = await service.prepareRequestBody('grok-3-mini', {
            tools: [
                { type: 'web_search' },
                { type: 'web_search_preview' }
            ]
        }, false);

        expect(request.tools).toHaveLength(1);
        expect(request.tools[0].type).toBe('web_search');
    });
});
