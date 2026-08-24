import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/providers/adapter.js', () => ({
    serviceInstances: {},
    getServiceAdapter: jest.fn(() => ({}))
}));

jest.mock('../src/services/usage-service.js', () => ({
    usageService: {
        getFormattedUsage: jest.fn(() => new Promise(() => {})),
        formatUsage: jest.fn(value => value)
    }
}));

jest.mock('../src/ui-modules/usage-cache.js', () => ({
    readUsageCache: jest.fn(),
    readUsageDisplayCache: jest.fn(),
    writeUsageCache: jest.fn(),
    readProviderUsageCache: jest.fn(),
    updateProviderUsageCache: jest.fn()
}));

import { usageService } from '../src/services/usage-service.js';
import { readUsageCache, readUsageDisplayCache } from '../src/ui-modules/usage-cache.js';
import { handleGetUsage } from '../src/ui-modules/usage-api.js';

function createResponse() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
        },
        end(body = '') {
            this.body = body;
        }
    };
}

describe('usage refresh request', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        readUsageDisplayCache.mockResolvedValue({
            timestamp: '2026-08-11T00:00:00.000Z',
            providers: {
                'gemini-antigravity': {
                    providerType: 'gemini-antigravity',
                    totalCount: 1,
                    successCount: 1,
                    errorCount: 0,
                    instances: [{
                        uuid: 'antigravity-a',
                        success: true,
                        usage: { summary: { plan: 'Ultra', usedPercent: 2.5 }, items: [] }
                    }]
                }
            }
        });
        globalThis.runUsageCacheAutoRefreshNow = jest.fn(() => new Promise(() => {}));
    });

    afterEach(() => {
        delete globalThis.runUsageCacheAutoRefreshNow;
        delete globalThis.getUsageCacheAutoRefreshStatus;
    });

    test('returns cached usage immediately while the full refresh continues in background', async () => {
        const req = { url: '/api/usage?refresh=true', headers: { host: 'localhost' } };
        const res = createResponse();
        const providerPoolManager = {
            providerPools: {
                'gemini-antigravity': [{ uuid: 'antigravity-a', isHealthy: true }]
            }
        };

        const outcome = await Promise.race([
            handleGetUsage(req, res, {}, providerPoolManager).then(() => 'completed'),
            new Promise(resolve => setTimeout(() => resolve('timed_out'), 50))
        ]);

        expect(outcome).toBe('completed');
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toMatchObject({
            fromCache: true,
            refreshPending: true
        });
        expect(globalThis.runUsageCacheAutoRefreshNow).toHaveBeenCalledTimes(1);
        expect(usageService.getFormattedUsage).not.toHaveBeenCalled();
        expect(usageService.formatUsage).not.toHaveBeenCalled();
        expect(readUsageCache).not.toHaveBeenCalled();
    });

    test('reports an active background refresh on subsequent cached reads', async () => {
        globalThis.getUsageCacheAutoRefreshStatus = jest.fn(() => ({ isRunning: true }));
        const req = { url: '/api/usage', headers: { host: 'localhost' } };
        const res = createResponse();

        await handleGetUsage(req, res, {}, { providerPools: {} });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toMatchObject({
            fromCache: true,
            refreshPending: true
        });
        expect(globalThis.getUsageCacheAutoRefreshStatus).toHaveBeenCalledTimes(1);
    });

    test('opening the usage page never queries providers when no cache exists', async () => {
        readUsageDisplayCache.mockResolvedValueOnce(null);
        const req = { url: '/api/usage', headers: { host: 'localhost' } };
        const res = createResponse();

        const outcome = await Promise.race([
            handleGetUsage(req, res, {}, { providerPools: {} }).then(() => 'completed'),
            new Promise(resolve => setTimeout(() => resolve('timed_out'), 50))
        ]);

        expect(outcome).toBe('completed');
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toMatchObject({
            fromCache: true,
            providers: {}
        });
        expect(readUsageDisplayCache).toHaveBeenCalledWith({ maxAgeMs: null, allowStale: true });
        expect(usageService.getFormattedUsage).not.toHaveBeenCalled();
        expect(readUsageCache).not.toHaveBeenCalled();
    });
});
