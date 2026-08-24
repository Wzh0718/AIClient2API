import { beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/providers/adapter.js', () => ({
    serviceInstances: {},
    getServiceAdapter: jest.fn()
}));

jest.mock('../src/services/usage-service.js', () => ({
    usageService: {
        getFormattedUsage: jest.fn()
    }
}));

import { getServiceAdapter } from '../src/providers/adapter.js';
import { usageService } from '../src/services/usage-service.js';
import { getAllProvidersUsage } from '../src/ui-modules/usage-api.js';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('usage api scheduled recovery handling', () => {
    test('syncs the detected Antigravity plan back to the provider pool', async () => {
        const provider = {
            uuid: 'ultra-antigravity',
            customName: 'Ultra Antigravity',
            lastKnownAntigravityPlan: 'FREE',
            isHealthy: true
        };
        const syncAntigravityPlan = jest.fn();
        getServiceAdapter.mockReturnValue({});
        usageService.getFormattedUsage.mockResolvedValue({
            summary: { plan: 'Ultra' },
            items: []
        });

        const usage = await getAllProvidersUsage({}, {
            providerPools: {
                'gemini-antigravity': [provider]
            },
            syncAntigravityPlan
        });

        expect(usage.providers['gemini-antigravity'].instances[0]).toMatchObject({
            success: true,
            usage: { summary: { plan: 'Ultra' } }
        });
        expect(syncAntigravityPlan).toHaveBeenCalledWith(
            'gemini-antigravity',
            provider,
            'Ultra'
        );
    });

    test('keeps periodic Antigravity quotas observational without removing model cooldowns', async () => {
        const provider = {
            uuid: 'pro-antigravity-quota',
            customName: 'Pro Antigravity quota',
            lastKnownAntigravityPlan: 'Pro',
            isHealthy: true,
            antigravityGeminiMax5hPercent: 80,
            antigravityGeminiMaxWeeklyPercent: 90,
            antigravityThirdPartyMax5hPercent: 80,
            antigravityThirdPartyMaxWeeklyPercent: 90,
            antigravityQuotaHealth: {
                families: {},
                models: {
                    'gemini-3.1-flash-image': {
                        isHealthy: false,
                        scheduledRecoveryTime: '2099-01-02T00:00:00.000Z',
                        source: 'upstream_429'
                    }
                }
            }
        };
        const syncAntigravityQuotaHealth = jest.fn();
        getServiceAdapter.mockReturnValue({});
        usageService.getFormattedUsage.mockResolvedValue({
            summary: { plan: 'Google AI Pro' },
            items: [
                { id: 'quota-group:gemini-5h', percent: 80, resetAt: '2099-01-01T00:00:00.000Z' },
                { id: 'quota-group:gemini-weekly', percent: 20, resetAt: '2099-01-03T00:00:00.000Z' },
                { id: 'quota-group:3p-5h', percent: 10, resetAt: '2099-01-01T00:00:00.000Z' },
                { id: 'quota-group:3p-weekly', percent: 10, resetAt: '2099-01-03T00:00:00.000Z' }
            ]
        });

        const usage = await getAllProvidersUsage({}, {
            providerPools: { 'gemini-antigravity': [provider] },
            syncAntigravityQuotaHealth
        });

        const quotaHealth = usage.providers['gemini-antigravity'].instances[0].antigravityQuotaHealth;
        expect(quotaHealth.families).toEqual({});
        expect(quotaHealth.models['gemini-3.1-flash-image']).toMatchObject({
            isHealthy: false,
            source: 'upstream_429'
        });
        expect(syncAntigravityQuotaHealth).toHaveBeenCalledWith(
            'gemini-antigravity',
            provider,
            quotaHealth
        );
    });

    test('skips disabled providers without surfacing refresh errors', async () => {
        const usage = await getAllProvidersUsage({}, {
            providerPools: {
                'gemini-cli-oauth': [
                    {
                        uuid: 'disabled-gemini',
                        customName: 'Disabled Gemini',
                        isDisabled: true,
                        isHealthy: true
                    }
                ]
            }
        });

        expect(getServiceAdapter).not.toHaveBeenCalled();
        expect(usageService.getFormattedUsage).not.toHaveBeenCalled();
        expect(usage.providers['gemini-cli-oauth']).toMatchObject({
            totalCount: 1,
            successCount: 0,
            errorCount: 0
        });
        expect(usage.providers['gemini-cli-oauth'].instances[0]).toMatchObject({
            uuid: 'disabled-gemini',
            success: false,
            skipped: true,
            error: null,
            skipReason: 'disabled'
        });
    });

    test('skips Codex usage refresh while a provider is waiting for scheduled recovery', async () => {
        const usage = await getAllProvidersUsage({}, {
            providerPools: {
                'openai-codex-oauth': [
                    {
                        uuid: 'cooling-codex',
                        customName: 'Cooling Codex',
                        isHealthy: false,
                        scheduledRecoveryTime: '2099-01-01T00:00:00.000Z'
                    }
                ]
            }
        });

        expect(getServiceAdapter).not.toHaveBeenCalled();
        expect(usageService.getFormattedUsage).not.toHaveBeenCalled();
        expect(usage.providers['openai-codex-oauth'].instances[0]).toMatchObject({
            uuid: 'cooling-codex',
            success: false,
            error: 'Provider is waiting for scheduled recovery until 2099-01-01T00:00:00.000Z'
        });
    });

    test('syncs exhausted general quota with the latest exhausted window reset time', async () => {
        const provider = {
            uuid: 'general-quota-exhausted',
            customName: 'General Quota Exhausted',
            isHealthy: true
        };
        const syncCodexQuotaHealth = jest.fn();
        getServiceAdapter.mockReturnValue({});
        usageService.getFormattedUsage.mockResolvedValue({
            summary: { plan: 'Pro' },
            items: [
                {
                    id: 'primary_window',
                    scope: 'general',
                    windowKind: 'short',
                    percent: 100,
                    resetAt: '2099-01-01T00:00:00.000Z'
                },
                {
                    id: 'secondary_window',
                    scope: 'general',
                    windowKind: 'weekly',
                    percent: 100,
                    resetAt: '2099-01-08T00:00:00.000Z'
                }
            ]
        });

        const usage = await getAllProvidersUsage({}, {
            providerPools: {
                'openai-codex-oauth': [provider]
            },
            syncCodexQuotaHealth
        });

        const quotaHealth = usage.providers['openai-codex-oauth'].instances[0].codexQuotaHealth;
        expect(quotaHealth.general).toMatchObject({
            isHealthy: false,
            scheduledRecoveryTime: '2099-01-08T00:00:00.000Z'
        });
        expect(syncCodexQuotaHealth).toHaveBeenCalledWith(
            'openai-codex-oauth',
            provider,
            quotaHealth
        );
    });

    test('keeps exhausted general quota blocked when reset time is unavailable', async () => {
        const provider = {
            uuid: 'general-quota-no-reset',
            customName: 'General Quota No Reset',
            isHealthy: true
        };
        getServiceAdapter.mockReturnValue({});
        usageService.getFormattedUsage.mockResolvedValue({
            summary: { plan: 'Pro' },
            items: [{
                id: 'secondary_window',
                scope: 'general',
                windowKind: 'weekly',
                percent: 100,
                resetAt: null
            }]
        });

        const usage = await getAllProvidersUsage({}, {
            providerPools: {
                'openai-codex-oauth': [provider]
            },
            syncCodexQuotaHealth: jest.fn()
        });

        expect(usage.providers['openai-codex-oauth'].instances[0].codexQuotaHealth.general).toMatchObject({
            isHealthy: false,
            scheduledRecoveryTime: null
        });
    });

    test('keeps general quota blocked when any exhausted window lacks a valid future reset', async () => {
        const provider = {
            uuid: 'general-quota-partial-reset',
            customName: 'General Quota Partial Reset',
            isHealthy: true
        };
        getServiceAdapter.mockReturnValue({});
        usageService.getFormattedUsage.mockResolvedValue({
            summary: { plan: 'Pro' },
            items: [
                {
                    id: 'primary_window',
                    scope: 'general',
                    percent: 100,
                    resetAt: '2099-01-01T00:00:00.000Z'
                },
                {
                    id: 'secondary_window',
                    scope: 'general',
                    percent: 100,
                    resetAt: null
                }
            ]
        });

        const usage = await getAllProvidersUsage({}, {
            providerPools: {
                'openai-codex-oauth': [provider]
            },
            syncCodexQuotaHealth: jest.fn()
        });

        expect(usage.providers['openai-codex-oauth'].instances[0].codexQuotaHealth.general).toMatchObject({
            isHealthy: false,
            scheduledRecoveryTime: null
        });
    });

    test('fresh usage below the limit clears the general quota cooldown', async () => {
        const provider = {
            uuid: 'general-quota-recovered',
            customName: 'General Quota Recovered',
            isHealthy: true,
            codexQuotaHealth: {
                general: {
                    isHealthy: false,
                    lastErrorTime: '2026-07-24T00:00:00.000Z',
                    lastErrorMessage: '通用额度已用 100.0%',
                    scheduledRecoveryTime: '2099-01-01T00:00:00.000Z'
                }
            }
        };
        const syncCodexQuotaHealth = jest.fn();
        getServiceAdapter.mockReturnValue({});
        usageService.getFormattedUsage.mockResolvedValue({
            summary: { plan: 'Pro' },
            items: [
                {
                    id: 'primary_window',
                    scope: 'general',
                    percent: 20,
                    resetAt: '2099-01-01T00:00:00.000Z'
                },
                {
                    id: 'secondary_window',
                    scope: 'general',
                    percent: 30,
                    resetAt: '2099-01-08T00:00:00.000Z'
                }
            ]
        });

        const usage = await getAllProvidersUsage({}, {
            providerPools: {
                'openai-codex-oauth': [provider]
            },
            syncCodexQuotaHealth
        });

        const quotaHealth = usage.providers['openai-codex-oauth'].instances[0].codexQuotaHealth;
        expect(quotaHealth.general).toMatchObject({
            isHealthy: true,
            lastErrorTime: null,
            lastErrorMessage: null,
            scheduledRecoveryTime: null
        });
        expect(syncCodexQuotaHealth).toHaveBeenCalledWith(
            'openai-codex-oauth',
            provider,
            quotaHealth
        );
    });
});
