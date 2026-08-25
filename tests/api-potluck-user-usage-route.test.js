import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Readable } from 'stream';

const mockGetKey = jest.fn();
const mockValidateKey = jest.fn();

jest.mock('../src/plugins/api-potluck/key-manager.js', () => ({
    createKey: jest.fn(),
    listKeys: jest.fn(),
    getKey: mockGetKey,
    deleteKey: jest.fn(),
    updateKeyLimit: jest.fn(),
    resetKeyUsage: jest.fn(),
    resetKeyTokenStats: jest.fn(),
    toggleKey: jest.fn(),
    updateKeyName: jest.fn(),
    updateKeyRouting: jest.fn(),
    regenerateKey: jest.fn(),
    getStats: jest.fn(),
    getAccountUsageSummary: jest.fn(),
    validateKey: mockValidateKey,
    KEY_PREFIX: 'maki_',
    applyDailyLimitToAllKeys: jest.fn(),
    getAllKeyIds: jest.fn(),
    getLedgerKeyIdentities: jest.fn(() => []),
    resetAllTokenStats: jest.fn(),
    getCredentialRoutingKeyCatalog: jest.fn(),
    applyKeyRoutingAssignments: jest.fn()
}));

describe('potluck user usage route', () => {
    let handlePotluckUserApiRoutes;

    beforeEach(async () => {
        jest.resetModules();
        jest.clearAllMocks();
        ({ handlePotluckUserApiRoutes } = await import('../src/plugins/api-potluck/api-routes.js'));
        mockValidateKey.mockResolvedValue({ valid: true, keyData: {} });
        mockGetKey.mockResolvedValue({
            name: 'Demo User',
            enabled: true,
            dailyLimit: 100,
            todayUsage: 2,
            lastResetDate: '2026-08-25',
            todayPromptTokens: 1000,
            todayCompletionTokens: 200,
            todayTotalTokens: 1200,
            todayCachedTokens: 100,
            totalUsage: 5,
            totalPromptTokens: 3000,
            totalCompletionTokens: 600,
            totalReasoningTokens: 0,
            totalTokens: 3600,
            totalCachedTokens: 300,
            cost: {
                usd: 0.1234,
                actualUsd: 0,
                estimatedUsd: 0.1234,
                missingPriceTokens: 0,
                estimatedPriceTokens: 3600,
                pricingVersion: 'test-pricing'
            },
            usageHistory: {
                '2026-08-25': {
                    summary: {
                        requestCount: 2,
                        totalTokens: 1200,
                        cost: {
                            usd: 0.0456,
                            actualUsd: 0,
                            estimatedUsd: 0.0456,
                            missingPriceTokens: 0,
                            estimatedPriceTokens: 1200,
                            pricingVersion: 'test-pricing'
                        }
                    }
                }
            },
            createdAt: '2026-08-01T00:00:00.000Z',
            lastUsedAt: '2026-08-25T10:00:00.000Z'
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('returns today and cumulative cost for the authenticated key', async () => {
        const req = Readable.from([]);
        req.headers = { authorization: 'Bearer maki_demo' };
        const res = {
            statusCode: null,
            body: null,
            writeHead(statusCode) { this.statusCode = statusCode; },
            end(value) { this.body = JSON.parse(value); }
        };

        const handled = await handlePotluckUserApiRoutes('GET', '/api/potluckuser/usage', req, res);

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.body.data.cost).toMatchObject({ usd: 0.1234, pricingVersion: 'test-pricing' });
        expect(res.body.data.usage.cost).toMatchObject({ usd: 0.0456, estimatedUsd: 0.0456 });
    });
});
