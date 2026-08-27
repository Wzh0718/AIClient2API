import { createProviderStateEvent, applyProviderStateEvent } from '../src/runtime/provider-state-event.js';

describe('provider state persistence events', () => {
    test('contains mutable scheduling state but excludes credentials and proxy data', () => {
        const event = createProviderStateEvent('provider', {
            uuid: 'one',
            accessToken: 'secret',
            refreshToken: 'refresh-secret',
            proxy: 'socks5://secret',
            isHealthy: false,
            errorCount: 2,
            lastErrorMessage: 'limited',
            scheduledRecoveryTime: '2026-08-12T10:00:00.000Z'
        });
        expect(event).toMatchObject({ providerType: 'provider', uuid: 'one', state: { isHealthy: false, errorCount: 2 } });
        expect(JSON.stringify(event)).not.toMatch(/accessToken|refreshToken|proxy|secret/);
    });

    test('applies only whitelisted state to the canonical provider', () => {
        const target = { uuid: 'one', accessToken: 'keep', isHealthy: true };
        const applied = applyProviderStateEvent({ provider: [target] }, {
            providerType: 'provider',
            uuid: 'one',
            state: { isHealthy: false, accessToken: 'replace' }
        });
        expect(applied).toBe(true);
        expect(target.isHealthy).toBe(false);
        expect(target.accessToken).toBe('keep');
    });

    test('carries config revision and rejects stale remote state', async () => {
        const { createProviderStateEvent, applyProviderStateEvent } = await import('../src/runtime/provider-state-event.js');
        const target = { uuid: 'one', isHealthy: true };
        const event = createProviderStateEvent('provider', { uuid: 'one', isHealthy: false }, 5);
        expect(event.configRevision).toBe(5);
        expect(applyProviderStateEvent({ provider: [target] }, { ...event, configRevision: 4 }, { revision: 5 })).toBe(false);
        expect(target.isHealthy).toBe(true);
        expect(applyProviderStateEvent({ provider: [target] }, event, { revision: 5 })).toBe(true);
        expect(target.isHealthy).toBe(false);
    });

    test('carries lastSuccessTime and keeps time fields monotonic when events arrive out of order', () => {
        const target = {
            uuid: 'one',
            lastSuccessTime: '2026-08-25T07:00:00.000Z',
            lastHealthCheckTime: '2026-08-25T07:05:00.000Z',
            lastUsed: '2026-08-25T07:10:00.000Z',
            lastRefreshTime: 200
        };
        const event = createProviderStateEvent('provider', {
            uuid: 'one',
            lastSuccessTime: '2026-08-25T06:00:00.000Z',
            lastHealthCheckTime: '2026-08-25T06:05:00.000Z',
            lastUsed: '2026-08-25T06:10:00.000Z',
            lastRefreshTime: 100
        });

        expect(event.state.lastSuccessTime).toBe('2026-08-25T06:00:00.000Z');
        expect(applyProviderStateEvent({ provider: [target] }, event)).toBe(true);
        expect(target).toMatchObject({
            lastSuccessTime: '2026-08-25T07:00:00.000Z',
            lastHealthCheckTime: '2026-08-25T07:05:00.000Z',
            lastUsed: '2026-08-25T07:10:00.000Z',
            lastRefreshTime: 200
        });
    });

    test('rejects null time regressions and applies health-check state atomically by completion time', () => {
        const target = {
            uuid: 'one',
            isHealthy: true,
            errorCount: 0,
            lastErrorMessage: null,
            lastHealthStateTime: '2026-08-25T07:05:00.000Z',
            lastHealthCheckModel: 'new-model',
            lastHealthCheckTime: '2026-08-25T07:05:00.000Z',
            lastSuccessTime: '2026-08-25T07:00:00.000Z'
        };

        expect(applyProviderStateEvent({ provider: [target] }, {
            providerType: 'provider',
            uuid: 'one',
            state: {
                isHealthy: false,
                errorCount: 10,
                lastErrorMessage: 'older failure',
                lastHealthStateTime: '2026-08-25T06:05:00.000Z',
                lastHealthCheckModel: 'old-model',
                lastHealthCheckTime: '2026-08-25T06:05:00.000Z',
                lastSuccessTime: null
            }
        })).toBe(true);

        expect(target).toMatchObject({
            isHealthy: true,
            errorCount: 0,
            lastErrorMessage: null,
            lastHealthStateTime: '2026-08-25T07:05:00.000Z',
            lastHealthCheckModel: 'new-model',
            lastHealthCheckTime: '2026-08-25T07:05:00.000Z',
            lastSuccessTime: '2026-08-25T07:00:00.000Z'
        });

        expect(applyProviderStateEvent({ provider: [target] }, {
            providerType: 'provider',
            uuid: 'one',
            state: {
                isHealthy: true,
                errorCount: 0,
                lastErrorMessage: null,
                lastHealthStateTime: '2026-08-25T07:10:00.000Z',
                lastHealthCheckTime: '2026-08-25T06:05:00.000Z'
            }
        })).toBe(true);
        expect(target.lastHealthStateTime).toBe('2026-08-25T07:10:00.000Z');
    });

    test('rejects an older runtime event from restoring needsRefresh after a reset', () => {
        const target = { uuid: 'one', needsRefresh: false };
        const newer = createProviderStateEvent('provider', {
            uuid: 'one',
            needsRefresh: false
        });
        newer.occurredAt = '2026-08-26T10:00:05.000Z';
        const older = createProviderStateEvent('provider', {
            uuid: 'one',
            needsRefresh: true
        });
        older.occurredAt = '2026-08-26T10:00:01.000Z';

        expect(applyProviderStateEvent({ provider: [target] }, newer, { stateEventAt: null })).toBe(true);
        expect(target.needsRefresh).toBe(false);
        expect(applyProviderStateEvent({ provider: [target] }, older, { stateEventAt: newer.occurredAt })).toBe(false);
        expect(target.needsRefresh).toBe(false);
    });

    test('does not let a stale refresh request overwrite a newer successful refresh', () => {
        const providerPools = { test: [{
            uuid: 'one',
            needsRefresh: false,
            lastRefreshTime: '2026-08-26T08:00:00.000Z',
            lastHealthStateTime: '2026-08-26T08:00:00.000Z'
        }] };
        const applied = applyProviderStateEvent(providerPools, {
            type: 'provider_state',
            providerType: 'test',
            uuid: 'one',
            configRevision: 1,
            occurredAt: '2026-08-26T08:00:05.000Z',
            state: {
                needsRefresh: true,
                lastHealthStateTime: '2026-08-26T07:59:00.000Z',
                lastRefreshTime: '2026-08-26T07:59:00.000Z'
            }
        }, { revision: 1 });

        expect(applied).toBe(true);
        expect(providerPools.test[0].needsRefresh).toBe(false);
    });

    test('does not let a stale refresh clear overwrite a newer refresh request', () => {
        const providerPools = { test: [{
            uuid: 'one',
            needsRefresh: true,
            lastHealthStateTime: '2026-08-26T08:01:00.000Z'
        }] };

        applyProviderStateEvent(providerPools, {
            type: 'provider_state',
            providerType: 'test',
            uuid: 'one',
            configRevision: 1,
            occurredAt: '2026-08-26T08:02:00.000Z',
            state: {
                needsRefresh: false,
                lastHealthStateTime: '2026-08-26T08:00:00.000Z'
            }
        }, { revision: 1 });

        expect(providerPools.test[0].needsRefresh).toBe(true);
    });

    test('ignores isDisabled from runtime state events', () => {
        const providerPools = { test: [{ uuid: 'one', isDisabled: true }] };

        applyProviderStateEvent(providerPools, {
            type: 'provider_state',
            providerType: 'test',
            uuid: 'one',
            configRevision: 1,
            occurredAt: '2026-08-26T08:02:00.000Z',
            state: { isDisabled: false }
        }, { revision: 1 });

        expect(providerPools.test[0].isDisabled).toBe(true);
    });

    test('merges quota state children instead of replacing newer entries', () => {
        const providerPools = { test: [{
            uuid: 'one',
            antigravityQuotaHealth: { models: { 'gpt-new': { isHealthy: false } } }
        }] };

        applyProviderStateEvent(providerPools, {
            type: 'provider_state',
            providerType: 'test',
            uuid: 'one',
            configRevision: 1,
            occurredAt: '2026-08-26T08:02:00.000Z',
            state: { antigravityQuotaHealth: { models: { 'gpt-old': { isHealthy: true } } } }
        }, { revision: 1 });

        expect(providerPools.test[0].antigravityQuotaHealth.models).toEqual({
            'gpt-new': { isHealthy: false },
            'gpt-old': { isHealthy: true }
        });
    });

    test('applies a newer quota recovery snapshot even when the incoming child has no error timestamp', () => {
        const providerPools = { test: [{
            uuid: 'one',
            codexQuotaHealth: {
                general: {
                    isHealthy: false,
                    lastErrorTime: '2026-08-26T08:00:00.000Z',
                    scheduledRecoveryTime: '2099-01-01T00:00:00.000Z'
                }
            }
        }] };

        const applied = applyProviderStateEvent(providerPools, {
            type: 'provider_state',
            providerType: 'test',
            uuid: 'one',
            configRevision: 1,
            occurredAt: '2026-08-26T09:00:00.000Z',
            state: {
                codexQuotaHealth: {
                    general: {
                        isHealthy: true,
                        lastErrorTime: null,
                        scheduledRecoveryTime: null,
                        updatedAt: '2026-08-26T09:00:00.000Z'
                    }
                }
            }
        }, { revision: 1 });

        expect(applied).toBe(true);
        expect(providerPools.test[0].codexQuotaHealth.general).toMatchObject({
            isHealthy: true,
            scheduledRecoveryTime: null
        });
    });

    test('replays a control worker quota recovery event to every execution worker state', () => {
        const controlConfig = {
            uuid: 'one',
            codexQuotaHealth: {
                general: {
                    isHealthy: true,
                    scheduledRecoveryTime: null,
                    updatedAt: '2026-08-26T09:00:00.000Z'
                }
            }
        };
        const event = createProviderStateEvent('openai-codex-oauth', controlConfig, 4);
        event.occurredAt = '2026-08-26T09:00:01.000Z';
        const executionPools = [
            { 'openai-codex-oauth': [{ uuid: 'one', codexQuotaHealth: { general: { isHealthy: false, scheduledRecoveryTime: '2099-01-01T00:00:00.000Z', updatedAt: '2026-08-26T08:00:00.000Z' } } }] },
            { 'openai-codex-oauth': [{ uuid: 'one', codexQuotaHealth: { general: { isHealthy: false, scheduledRecoveryTime: '2099-01-01T00:00:00.000Z', updatedAt: '2026-08-26T08:00:00.000Z' } } }] }
        ];

        for (const pools of executionPools) {
            expect(applyProviderStateEvent(pools, event, { revision: 4 })).toBe(true);
        }

        expect(executionPools.every(pools => pools['openai-codex-oauth'][0].codexQuotaHealth.general.isHealthy)).toBe(true);
        expect(executionPools.every(pools => pools['openai-codex-oauth'][0].codexQuotaHealth.general.scheduledRecoveryTime === null)).toBe(true);
    });

    test('does not let an older usage snapshot roll back usageCount', () => {
        const providerPools = { test: [{
            uuid: 'one',
            usageCount: 12,
            lastHealthStateTime: '2026-08-26T08:01:00.000Z'
        }] };

        applyProviderStateEvent(providerPools, {
            type: 'provider_state',
            providerType: 'test',
            uuid: 'one',
            configRevision: 1,
            occurredAt: '2026-08-26T08:02:00.000Z',
            state: {
                usageCount: 3,
                lastHealthStateTime: '2026-08-26T08:00:00.000Z'
            }
        }, { revision: 1 });

        expect(providerPools.test[0].usageCount).toBe(12);
    });

    test('does not let an older recovery event roll back scheduledRecoveryTime', () => {
        const providerPools = { test: [{
            uuid: 'one',
            scheduledRecoveryTime: '2026-08-26T09:00:00.000Z',
            lastHealthStateTime: '2026-08-26T08:01:00.000Z'
        }] };

        applyProviderStateEvent(providerPools, {
            type: 'provider_state',
            providerType: 'test',
            uuid: 'one',
            configRevision: 1,
            occurredAt: '2026-08-26T08:02:00.000Z',
            state: {
                scheduledRecoveryTime: '2026-08-26T08:30:00.000Z',
                lastHealthStateTime: '2026-08-26T08:00:00.000Z'
            }
        }, { revision: 1 });

        expect(providerPools.test[0].scheduledRecoveryTime).toBe('2026-08-26T09:00:00.000Z');
    });
});
