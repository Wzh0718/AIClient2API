function normalizeRemainingRatio(value) {
    if (value === undefined || value === null || value === '') return null;
    let ratio = Number(value);
    if (!Number.isFinite(ratio)) return null;
    if (ratio > 1 && ratio <= 100) ratio /= 100;
    return Math.max(0, Math.min(1, ratio));
}

function hasKnownExhaustedQuota(provider = {}) {
    if (provider.quotaAvailable === false || provider.codexQuotaHealth?.general?.isHealthy === false) {
        return true;
    }

    const ratios = [
        provider.fiveHourRemainingRatio
            ?? provider.shortWindowRemainingRatio
            ?? provider.quota?.fiveHourRemainingRatio
            ?? provider.quota?.shortRemainingRatio,
        provider.weeklyRemainingRatio
            ?? provider.quota?.weeklyRemainingRatio
    ].map(normalizeRemainingRatio).filter(value => value !== null);

    return ratios.some(value => value <= 0);
}

/**
 * Stable availability for management UIs. Deliberately ignores transient
 * concurrency/capacity flags such as isAtCapacity and hasCapacity.
 */
export function getProviderUiAvailability(provider = {}) {
    if (provider.glmVerified === false) {
        return { uiAvailable: false, uiUnavailableReason: 'unverified' };
    }
    if (provider.isDisabled === true) {
        return { uiAvailable: false, uiUnavailableReason: 'disabled' };
    }
    if (provider.isHealthy === false) {
        return { uiAvailable: false, uiUnavailableReason: 'unhealthy' };
    }
    if (provider.needsRefresh === true) {
        return { uiAvailable: false, uiUnavailableReason: 'needs_refresh' };
    }
    if (hasKnownExhaustedQuota(provider)) {
        return { uiAvailable: false, uiUnavailableReason: 'quota_exhausted' };
    }
    return { uiAvailable: true, uiUnavailableReason: null };
}
