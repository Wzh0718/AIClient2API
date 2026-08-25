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
});
