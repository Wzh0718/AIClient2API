const MUTABLE_STATE_FIELDS = [
    'isHealthy', 'isDisabled', 'needsRefresh', 'errorCount', 'usageCount',
    'lastUsed', 'lastSuccessTime', 'lastRefreshTime', 'lastRefreshAttemptTime', 'lastHealthStateTime', 'lastErrorTime', 'lastErrorMessage', 'lastHealthCheckTime',
    'lastHealthCheckModel', 'scheduledRecoveryTime', 'refreshCount',
    'antigravityQuotaHealth', 'codexQuotaHealth', 'lastKnownAntigravityPlan',
    'lastKnownCodexPlan'
];

const MONOTONIC_TIME_FIELDS = new Set([
    'lastUsed',
    'lastSuccessTime',
    'lastHealthCheckTime',
    'lastRefreshTime',
    'lastRefreshAttemptTime',
    'lastHealthStateTime'
]);

const HEALTH_STATE_FIELDS = new Set([
    'isHealthy',
    'errorCount',
    'lastErrorTime',
    'lastErrorMessage',
    'lastHealthStateTime'
]);

const HEALTH_CHECK_METADATA_FIELDS = new Set([
    'lastHealthCheckTime',
    'lastHealthCheckModel'
]);

function toTimestamp(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : null;
}

export function createProviderStateEvent(providerType, config = {}, configRevision = 0) {
    const state = {};
    for (const field of MUTABLE_STATE_FIELDS) {
        if (config[field] !== undefined) state[field] = structuredClone(config[field]);
    }
    return {
        type: 'provider_state',
        providerType: String(providerType || ''),
        uuid: String(config.uuid || ''),
        configRevision: Number(configRevision || 0),
        state,
        occurredAt: new Date().toISOString()
    };
}

export function applyProviderStateEvent(providerPools, event, current = {}) {
    if (Number(event?.configRevision || 0) < Number(current.revision || 0)) return false;
    const incomingEventAt = toTimestamp(event?.occurredAt);
    const currentEventAt = toTimestamp(current.stateEventAt);
    if (currentEventAt !== null && (incomingEventAt === null || incomingEventAt <= currentEventAt)) return false;
    const providers = providerPools?.[event?.providerType];
    if (!Array.isArray(providers)) return false;
    const target = providers.find(provider => provider.uuid === event.uuid);
    if (!target) return false;
    const incomingHealthStateTime = toTimestamp(event.state?.lastHealthStateTime);
    const currentHealthStateTime = toTimestamp(target.lastHealthStateTime);
    const healthStateIsStale = currentHealthStateTime !== null &&
        (incomingHealthStateTime === null || incomingHealthStateTime < currentHealthStateTime);
    const incomingHealthCheckTime = toTimestamp(event.state?.lastHealthCheckTime);
    const currentHealthCheckTime = toTimestamp(target.lastHealthCheckTime);
    const healthCheckMetadataIsStale = currentHealthCheckTime !== null &&
        (incomingHealthCheckTime === null || incomingHealthCheckTime < currentHealthCheckTime);
    for (const field of MUTABLE_STATE_FIELDS) {
        if (event.state?.[field] === undefined) continue;
        if (healthStateIsStale && HEALTH_STATE_FIELDS.has(field)) continue;
        if (healthCheckMetadataIsStale && HEALTH_CHECK_METADATA_FIELDS.has(field)) continue;
        if (MONOTONIC_TIME_FIELDS.has(field)) {
            const incomingTime = toTimestamp(event.state[field]);
            const currentTime = toTimestamp(target[field]);
            if (currentTime !== null && (incomingTime === null || incomingTime < currentTime)) continue;
        }
        target[field] = structuredClone(event.state[field]);
    }
    return true;
}
