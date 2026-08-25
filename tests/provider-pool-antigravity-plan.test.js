import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';
import { getProviderMappingByDirName } from '../src/utils/provider-utils.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => ['gemini-antigravity']),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

const usageCachePath = path.join(process.cwd(), 'configs', 'usage-cache.json');
let originalUsageCacheExisted = false;
let originalUsageCacheContent = null;
let manager;

function writeUsageCache(instances) {
    fs.mkdirSync(path.dirname(usageCachePath), { recursive: true });
    fs.writeFileSync(usageCachePath, JSON.stringify({
        timestamp: new Date().toISOString(),
        providers: {
            'gemini-antigravity': {
                providerType: 'gemini-antigravity',
                instances
            }
        }
    }, null, 2), 'utf8');
}

function createManager(providers) {
    manager = new ProviderPoolManager({ 'gemini-antigravity': providers }, {
        logLevel: 'error',
        saveDebounceTime: 60 * 60 * 1000,
        globalConfig: { PROVIDER_POOLS_FILE_PATH: 'configs/provider_pools.test.json' }
    });
    return manager;
}

beforeEach(() => {
    originalUsageCacheExisted = fs.existsSync(usageCachePath);
    originalUsageCacheContent = originalUsageCacheExisted ? fs.readFileSync(usageCachePath, 'utf8') : null;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    if (manager?.saveTimer) clearTimeout(manager.saveTimer);
    manager = null;
    jest.restoreAllMocks();
    if (originalUsageCacheExisted) {
        fs.writeFileSync(usageCachePath, originalUsageCacheContent, 'utf8');
    } else if (fs.existsSync(usageCachePath)) {
        fs.rmSync(usageCachePath, { force: true });
    }
});

describe('provider pool Antigravity subscription plan', () => {
    test('persists a freshly detected Antigravity plan on the managed provider', () => {
        const provider = {
            uuid: 'ultra-plan-sync',
            customName: 'Ultra plan sync',
            lastKnownAntigravityPlan: 'FREE'
        };
        const pool = createManager([provider]);

        const syncedPlan = pool.syncAntigravityPlan(
            'gemini-antigravity',
            provider,
            'Ultra'
        );

        expect(syncedPlan).toBe('Ultra');
        expect(provider.lastKnownAntigravityPlan).toBe('Ultra');
        expect(provider.lastKnownAntigravityPlanUpdatedAt).toEqual(expect.any(String));
        expect(pool.pendingSaves.has('gemini-antigravity')).toBe(true);
    });

    test('uses the lowest public Flash model for new and scheduled Antigravity health checks', () => {
        expect(getProviderMappingByDirName('antigravity').defaultCheckModel).toBe('gemini-2.5-flash-lite');
        expect(ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS['gemini-antigravity'])
            .toBe('gemini-2.5-flash-lite');
    });

    test('skips explicitly free accounts and selects a non-free account', async () => {
        writeUsageCache([
            { uuid: 'aaa-free', success: true, usage: { summary: { plan: 'Quota(free)' } } },
            { uuid: 'zzz-paid', success: true, usage: { summary: { plan: 'Antigravity Pro(standard)' } } }
        ]);
        const pool = createManager([
            { uuid: 'aaa-free', customName: 'Free', supportedModels: ['gemini-2.5-flash'] },
            { uuid: 'zzz-paid', customName: 'Paid', supportedModels: ['gemini-2.5-flash'] }
        ]);

        const selected = await pool.selectProvider('gemini-antigravity', 'gemini-2.5-flash');

        expect(selected.uuid).toBe('zzz-paid');
    });

    test('does not route when every Antigravity account is explicitly free', async () => {
        writeUsageCache([
            { uuid: 'only-free', success: true, usage: { raw: { tierId: 'Antigravity Starter Quota(free)' } } }
        ]);
        const pool = createManager([
            { uuid: 'only-free', customName: 'Free', supportedModels: ['gemini-2.5-flash'] }
        ]);

        await expect(pool.selectProvider('gemini-antigravity', 'gemini-2.5-flash'))
            .rejects.toMatchObject({
                status: 503,
                code: 'PROVIDER_CREDENTIALS_UNAVAILABLE'
            });
    });

    test('routes Google AI Pro accounts even when Antigravity reports a free entitlement', async () => {
        writeUsageCache([
            { uuid: 'starter', success: true, usage: { summary: { plan: 'Quota(free)' } } },
            { uuid: 'pro-member', success: true, usage: { summary: { plan: 'Google AI Pro(free)' } } }
        ]);
        const pool = createManager([
            { uuid: 'starter', customName: 'Starter', supportedModels: ['gemini-2.5-flash'] },
            { uuid: 'pro-member', customName: 'Pro member', supportedModels: ['gemini-2.5-flash'] }
        ]);

        const selected = await pool.selectProvider('gemini-antigravity', 'gemini-2.5-flash');

        expect(selected.uuid).toBe('pro-member');
    });
});
