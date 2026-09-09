import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ProviderPoolManager } from '../src/providers/provider-pool-manager.js';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));

const managers = [];

function createManager(options = {}) {
    const manager = new ProviderPoolManager({
        'gemini-antigravity': [{ uuid: 'credential-one', isHealthy: true }]
    }, {
        logLevel: 'error',
        saveDebounceTime: 10_000,
        ...options
    });
    const config = manager.providerStatus['gemini-antigravity'][0].config;
    Object.assign(config, {
        usageCount: 7,
        lastUsed: '2026-08-25T06:51:47.000Z',
        lastSuccessTime: '2026-08-25T06:40:00.000Z',
        lastHealthCheckTime: '2026-08-25T04:48:33.000Z',
        lastHealthCheckModel: 'gemini-2.5-flash-lite',
        lastRefreshTime: 123456,
        needsRefresh: true,
        refreshCount: 2,
        errorCount: 3,
        lastErrorTime: '2026-08-25T06:00:00.000Z',
        lastErrorMessage: 'old error'
    });
    managers.push(manager);
    return { manager, config };
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-25T07:11:58.000Z'));
});

afterEach(() => {
    for (const manager of managers.splice(0)) {
        if (manager.saveTimer) clearTimeout(manager.saveTimer);
        if (manager.stateEventTimer) clearTimeout(manager.stateEventTimer);
    }
    jest.useRealTimers();
    jest.restoreAllMocks();
});

describe('provider status update semantics', () => {
    test('cold start preserves a persisted lastSuccessTime', () => {
        const manager = new ProviderPoolManager({
            'gemini-antigravity': [{
                uuid: 'persisted-success',
                lastSuccessTime: '2026-08-25T06:40:00.000Z'
            }]
        }, { logLevel: 'error', saveDebounceTime: 10_000 });
        managers.push(manager);

        expect(manager.providerStatus['gemini-antigravity'][0].config.lastSuccessTime)
            .toBe('2026-08-25T06:40:00.000Z');
    });

    test('business success updates usage and completion time without changing routing or refresh timestamps', () => {
        const { manager, config } = createManager();
        const lastUsed = config.lastUsed;
        const lastRefreshTime = config.lastRefreshTime;

        manager.markProviderRequestSucceeded('gemini-antigravity', { uuid: config.uuid });

        expect(config).toMatchObject({
            isHealthy: true,
            needsRefresh: true,
            refreshCount: 2,
            errorCount: 0,
            usageCount: 8,
            lastSuccessTime: '2026-08-25T07:11:58.000Z',
            lastUsed,
            lastRefreshTime
        });
    });

    test('health check success only updates health and health-check fields', () => {
        const { manager, config } = createManager();
        const protectedFields = {
            usageCount: config.usageCount,
            lastUsed: config.lastUsed,
            lastSuccessTime: config.lastSuccessTime,
            lastRefreshTime: config.lastRefreshTime
        };

        manager.markProviderHealthCheckSucceeded('gemini-antigravity', { uuid: config.uuid }, 'gemini-3.1-flash-lite');

        expect(config).toMatchObject({
            ...protectedFields,
            isHealthy: true,
            errorCount: 0,
            lastHealthCheckTime: '2026-08-25T07:11:58.000Z',
            lastHealthCheckModel: 'gemini-3.1-flash-lite'
        });
    });

    test('health check timeout records the last error without accumulating errorCount', () => {
        const { manager, config } = createManager();
        const protectedFields = {
            usageCount: config.usageCount,
            lastUsed: config.lastUsed,
            lastSuccessTime: config.lastSuccessTime,
            lastRefreshTime: config.lastRefreshTime,
            needsRefresh: config.needsRefresh,
            refreshCount: config.refreshCount,
            errorCount: config.errorCount,
            isHealthy: config.isHealthy
        };

        manager.markProviderHealthCheckFailed(
            'gemini-antigravity',
            { uuid: config.uuid },
            'Health check timed out after 60000ms',
            'gemini-3.1-flash-lite'
        );

        expect(config).toMatchObject({
            ...protectedFields,
            lastHealthCheckTime: '2026-08-25T07:11:58.000Z',
            lastHealthCheckModel: 'gemini-3.1-flash-lite',
            lastErrorMessage: 'Health check timed out after 60000ms'
        });
    });

    test('health check failure records completion without changing business or token-refresh fields', () => {
        const { manager, config } = createManager();
        const protectedFields = {
            usageCount: config.usageCount,
            lastUsed: config.lastUsed,
            lastSuccessTime: config.lastSuccessTime,
            lastRefreshTime: config.lastRefreshTime,
            needsRefresh: config.needsRefresh,
            refreshCount: config.refreshCount
        };

        manager.markProviderHealthCheckFailed(
            'gemini-antigravity',
            { uuid: config.uuid },
            'Health check timed out after 60000ms',
            'gemini-3.1-flash-lite',
            true
        );

        expect(config).toMatchObject({
            ...protectedFields,
            isHealthy: false,
            lastHealthCheckTime: '2026-08-25T07:11:58.000Z',
            lastHealthCheckModel: 'gemini-3.1-flash-lite',
            lastErrorMessage: 'Health check timed out after 60000ms'
        });
    });

    test('token refresh completion does not masquerade as a health check', () => {
        const { manager, config } = createManager();
        const lastHealthCheckTime = config.lastHealthCheckTime;

        manager.resetProviderRefreshStatus('gemini-antigravity', config.uuid);

        expect(config.lastRefreshTime).toBe(Date.now());
        expect(config.lastHealthCheckTime).toBe(lastHealthCheckTime);
        expect(config.usageCount).toBe(7);
        expect(config.lastSuccessTime).toBe('2026-08-25T06:40:00.000Z');
    });

    test('high-frequency business successes still flush persistence once per batch window', async () => {
        const { manager, config } = createManager();
        const flush = jest.spyOn(manager, '_flushPendingSaves').mockResolvedValue();

        for (let i = 0; i < 100; i++) {
            manager.markProviderRequestSucceeded('gemini-antigravity', { uuid: config.uuid });
        }

        expect(flush).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(10_000);
        expect(flush).toHaveBeenCalledTimes(1);
        expect(config.usageCount).toBe(107);
    });
});
