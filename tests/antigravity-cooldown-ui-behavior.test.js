import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';

describe('Antigravity cooldown UI behavior', () => {
    beforeAll(() => {
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
