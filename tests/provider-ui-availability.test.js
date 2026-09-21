import { getProviderUiAvailability } from '../src/utils/provider-ui-availability.js';

describe('provider management UI availability', () => {
    test.each([
        ['healthy enabled credential', {}, true, null],
        ['disabled credential', { isDisabled: true }, false, 'disabled'],
        ['unhealthy credential', { isHealthy: false }, false, 'unhealthy'],
        ['credential waiting for refresh', { needsRefresh: true }, false, 'needs_refresh'],
        ['explicitly exhausted quota', { quotaAvailable: false }, false, 'quota_exhausted'],
        ['zero remaining quota', { weeklyRemainingRatio: 0 }, false, 'quota_exhausted'],
        ['unknown quota', { weeklyRemainingRatio: null }, true, null],
        ['temporarily full credential', { isAtCapacity: true, hasCapacity: false }, true, null]
    ])('%s', (_label, provider, uiAvailable, uiUnavailableReason) => {
        expect(getProviderUiAvailability(provider)).toEqual({ uiAvailable, uiUnavailableReason });
    });
});
