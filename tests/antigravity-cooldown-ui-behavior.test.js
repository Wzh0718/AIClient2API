import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';

describe('Antigravity cooldown UI behavior', () => {
    beforeAll(() => {
        // The fixtures below use absolute cooldown timestamps, so the clock must be
        // pinned before them or every cooldown reads as already recovered.
        jest.useFakeTimers({ now: new Date('2026-08-24T08:00:00.000Z') });
        globalThis.window = {
            location: { origin: 'http://localhost' }
        };
        globalThis.localStorage = {
            getItem: jest.fn(() => null),
            setItem: jest.fn(),
            removeItem: jest.fn()
        };
    });

    afterAll(() => {
        jest.useRealTimers();
        delete globalThis.window;
        delete globalThis.localStorage;
    });

    test('reports a model only when every Antigravity instance explicitly marks it unhealthy', async () => {
        const usageManager = await import('../static/app/usage-manager.js');
        expect(typeof usageManager.getAntigravityPoolUnavailableModels).toBe('function');

        const instances = [
            {
                antigravityQuotaHealth: {
                    models: {
                        'gemini-2.5-flash': {
                            isHealthy: false,
                            scheduledRecoveryTime: '2026-08-24T10:30:00.000Z'
                        },
                        'gemini-3.1-flash-lite': { isHealthy: false }
                    }
                }
            },
            {
                antigravityQuotaHealth: {
                    models: {
                        'gemini-2.5-flash': {
                            isHealthy: false,
                            scheduledRecoveryTime: '2026-08-24T09:30:00.000Z'
                        }
                    }
                }
            }
        ];

        expect(usageManager.getAntigravityPoolUnavailableModels('gemini-antigravity', instances)).toEqual([
            {
                model: 'gemini-2.5-flash',
                scheduledRecoveryTime: '2026-08-24T09:30:00.000Z'
            }
        ]);
    });

    test('does not report pool cooldowns for another provider or an empty pool', async () => {
        const usageManager = await import('../static/app/usage-manager.js');
        const instances = [{
            antigravityQuotaHealth: {
                models: { 'gemini-2.5-flash': { isHealthy: false } }
            }
        }];

        expect(usageManager.getAntigravityPoolUnavailableModels('gemini-cli-oauth', instances)).toEqual([]);
        expect(usageManager.getAntigravityPoolUnavailableModels('gemini-antigravity', [])).toEqual([]);
    });

    test('summarizes only models with unavailable credentials and exposes earliest recovery when none are schedulable', async () => {
        const usageManager = await import('../static/app/usage-manager.js');
        expect(typeof usageManager.getAntigravityModelAvailabilitySummaries).toBe('function');

        const instances = [
            {
                isHealthy: true,
                antigravityQuotaHealth: {
                    models: {
                        'gemini-2.5-flash': { isHealthy: false, scheduledRecoveryTime: '2026-08-25T10:30:00.000Z' },
                        'gemini-2.5-pro': { isHealthy: false, scheduledRecoveryTime: '2026-08-25T11:30:00.000Z' }
                    }
                }
            },
            {
                isHealthy: true,
                antigravityQuotaHealth: {
                    models: {
                        'gemini-2.5-pro': { isHealthy: false, scheduledRecoveryTime: '2026-08-25T09:30:00.000Z' }
                    }
                }
            },
            {
                isHealthy: true,
                antigravityQuotaHealth: { models: {} }
            }
        ];

        expect(usageManager.getAntigravityModelAvailabilitySummaries('gemini-antigravity', instances)).toEqual([
            {
                model: 'gemini-2.5-flash',
                availableCount: 0,
                quotaExhaustedCount: 1,
                credentialUnavailableCount: 0,
                unprobedCount: 2,
                earliestRecoveryTime: '2026-08-25T10:30:00.000Z'
            },
            {
                model: 'gemini-2.5-pro',
                availableCount: 0,
                quotaExhaustedCount: 2,
                credentialUnavailableCount: 0,
                unprobedCount: 1,
                earliestRecoveryTime: '2026-08-25T09:30:00.000Z'
            }
        ]);

        const fullyUnavailable = instances.map(instance => ({
            ...instance,
            antigravityQuotaHealth: {
                models: {
                    'gemini-2.5-pro': {
                        isHealthy: false,
                        scheduledRecoveryTime: instance.uuid === 'missing' ? null : '2026-08-25T11:30:00.000Z'
                    }
                }
            }
        }));
        fullyUnavailable[0].antigravityQuotaHealth.models['gemini-2.5-pro'].scheduledRecoveryTime = '2026-08-25T12:30:00.000Z';
        fullyUnavailable[1].antigravityQuotaHealth.models['gemini-2.5-pro'].scheduledRecoveryTime = '2026-08-25T09:30:00.000Z';
        fullyUnavailable[2].antigravityQuotaHealth.models['gemini-2.5-pro'].scheduledRecoveryTime = '2026-08-25T10:30:00.000Z';

        expect(usageManager.getAntigravityModelAvailabilitySummaries('gemini-antigravity', fullyUnavailable)).toEqual([
            {
                model: 'gemini-2.5-pro',
                availableCount: 0,
                quotaExhaustedCount: 3,
                credentialUnavailableCount: 0,
                unprobedCount: 0,
                earliestRecoveryTime: '2026-08-25T09:30:00.000Z'
            }
        ]);
    });

    test('only summarizes explicitly reported Gemini models and keeps missing model states as unprobed', async () => {
        const usageManager = await import('../static/app/usage-manager.js');
        const instances = [
            { isHealthy: true, antigravityQuotaHealth: { models: {
                'gemini-3.1-flash-image': { isHealthy: true },
                'gemini-3.1-flash-lite': { isHealthy: false, source: 'upstream_429', scheduledRecoveryTime: '2026-08-25T13:00:00.000Z' }
            } } },
            { isHealthy: true, antigravityQuotaHealth: { models: { 'gemini-3.1-flash-image': { isHealthy: false, source: 'upstream_429', scheduledRecoveryTime: '2026-08-25T12:00:00.000Z' } } } },
            { isHealthy: true, antigravityQuotaHealth: { models: {} } },
            { isHealthy: false, antigravityQuotaHealth: { models: {} } }
        ];

        expect(usageManager.getAntigravityModelAvailabilitySummaries('gemini-antigravity', instances)).toContainEqual({
            model: 'gemini-3.1-flash-image',
            availableCount: 1,
            quotaExhaustedCount: 1,
            credentialUnavailableCount: 0,
            unprobedCount: 2,
            earliestRecoveryTime: '2026-08-25T12:00:00.000Z'
        });
        expect(usageManager.getAntigravityModelAvailabilitySummaries('gemini-antigravity', instances)).toContainEqual({
            model: 'gemini-3.1-flash-lite',
            availableCount: 0,
            quotaExhaustedCount: 1,
            credentialUnavailableCount: 0,
            unprobedCount: 3,
            earliestRecoveryTime: '2026-08-25T13:00:00.000Z'
        });
    });

    test('does not create rows from static models or overall credential errors', async () => {
        const usageManager = await import('../static/app/usage-manager.js');
        const instances = [
            { isHealthy: false, needsRefresh: true, error: 'refresh failed', antigravityQuotaHealth: { models: {} } },
            { isHealthy: true, antigravityQuotaHealth: { models: {} } }
        ];
        expect(usageManager.getAntigravityModelAvailabilitySummaries('gemini-antigravity', instances)).toEqual([]);
    });

    test('does not expose healthy-only models and classifies needsRefresh as credential unavailable', async () => {
        const usageManager = await import('../static/app/usage-manager.js');
        const instances = [
            { isHealthy: true, antigravityQuotaHealth: { models: { 'gemini-3.1-flash-image': { isHealthy: true } } } },
            { isHealthy: true, needsRefresh: true, antigravityQuotaHealth: { models: { 'gemini-3.1-flash-image': { isHealthy: true } } } }
        ];
        expect(usageManager.getAntigravityModelAvailabilitySummaries('gemini-antigravity', instances)).toContainEqual({
            model: 'gemini-3.1-flash-image',
            availableCount: 1,
            quotaExhaustedCount: 0,
            credentialUnavailableCount: 1,
            unprobedCount: 0,
            earliestRecoveryTime: null
        });
        expect(usageManager.getAntigravityModelAvailabilitySummaries('gemini-cli-oauth', instances)).toEqual([]);
    });

    test('ignores disabled, refresh-blocked, unhealthy, and uninitialized instances in the pool calculation', async () => {
        const usageManager = await import('../static/app/usage-manager.js');
        const cooled = {
            isHealthy: true,
            antigravityQuotaHealth: {
                models: { 'gemini-2.5-flash': { isHealthy: false } }
            }
        };
        const ineligibleWithoutModelState = [
            { isDisabled: true },
            { needsRefresh: true },
            { isHealthy: false },
            { error: 'provider not initialized' }
        ];

        expect(usageManager.getAntigravityPoolUnavailableModels(
            'gemini-antigravity',
            [cooled, ...ineligibleWithoutModelState]
        )).toEqual([
            { model: 'gemini-2.5-flash', scheduledRecoveryTime: null }
        ]);
    });

    test('sorts per-instance unavailable models by known recovery time with unknown recovery last', async () => {
        const usageManager = await import('../static/app/usage-manager.js');
        expect(typeof usageManager.getAntigravityUnavailableModels).toBe('function');

        const instance = {
            antigravityQuotaHealth: {
                models: {
                    'gemini-late': {
                        isHealthy: false,
                        scheduledRecoveryTime: '2026-08-24T12:30:00.000Z',
                        lastErrorMessage: 'late'
                    },
                    'gemini-unknown': {
                        isHealthy: false,
                        scheduledRecoveryTime: null,
                        lastErrorMessage: 'unknown'
                    },
                    'gemini-early': {
                        isHealthy: false,
                        scheduledRecoveryTime: '2026-08-24T09:30:00.000Z',
                        lastErrorMessage: 'early'
                    },
                    'gemini-healthy': { isHealthy: true }
                }
            }
        };

        expect(usageManager.getAntigravityUnavailableModels(instance, 'gemini-antigravity')).toEqual([
            {
                model: 'gemini-early',
                scheduledRecoveryTime: '2026-08-24T09:30:00.000Z',
                lastErrorMessage: 'early'
            },
            {
                model: 'gemini-late',
                scheduledRecoveryTime: '2026-08-24T12:30:00.000Z',
                lastErrorMessage: 'late'
            },
            {
                model: 'gemini-unknown',
                scheduledRecoveryTime: null,
                lastErrorMessage: 'unknown'
            }
        ]);
        expect(usageManager.getAntigravityUnavailableModels(instance, 'gemini-cli-oauth')).toEqual([]);
    });
});
