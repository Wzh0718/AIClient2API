const MUTABLE_STATE_FIELDS = [
    'isHealthy', 'needsRefresh', 'errorCount', 'usageCount',
    'lastUsed', 'lastSuccessTime', 'lastRefreshTime', 'lastRefreshAttemptTime', 'lastHealthStateTime', 'lastErrorTime', 'lastErrorMessage', 'lastHealthCheckTime',
    'lastHealthCheckModel', 'scheduledRecoveryTime', 'refreshCount',
    'antigravityQuotaHealth', 'codexQuotaHealth', 'codexRateLimitCooldown', 'lastKnownAntigravityPlan',
    'lastKnownAntigravityPlanUpdatedAt', 'lastKnownCodexPlan', 'lastKnownCodexPlanUpdatedAt'
];

const MONOTONIC_TIME_FIELDS = new Set([
    'lastUsed',
    'lastSuccessTime',
    'lastHealthCheckTime',
    'lastRefreshTime',
    'lastRefreshAttemptTime',
    'lastHealthStateTime',
    'lastKnownAntigravityPlanUpdatedAt',
    'lastKnownCodexPlanUpdatedAt'
]);

const HEALTH_STATE_FIELDS = new Set([
    'isHealthy',
    'errorCount',
    'usageCount',
    'refreshCount',
    'lastErrorTime',
    'lastErrorMessage',
    'lastHealthStateTime',
    'scheduledRecoveryTime'
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

function mergeQuotaState(currentValue, incomingValue) {
    if (!currentValue || typeof currentValue !== 'object') return structuredClone(incomingValue);
    if (!incomingValue || typeof incomingValue !== 'object') return structuredClone(currentValue);

    const merged = { ...structuredClone(currentValue), ...structuredClone(incomingValue) };
    for (const childKey of ['families', 'models']) {
        if (currentValue[childKey] || incomingValue[childKey]) {
            merged[childKey] = { ...(currentValue[childKey] || {}) };
            for (const [name, incomingChild] of Object.entries(incomingValue[childKey] || {})) {
                const currentChild = currentValue[childKey]?.[name];
                if (!currentChild || !incomingChild || typeof incomingChild !== 'object') {
                    merged[childKey][name] = structuredClone(incomingChild);
                    continue;
                }
                const incomingAt = Math.max(
                    toTimestamp(incomingChild.lastErrorTime) ?? -Infinity,
                    toTimestamp(incomingChild.scheduledRecoveryTime) ?? -Infinity
                );
                const currentAt = Math.max(
                    toTimestamp(currentChild.lastErrorTime) ?? -Infinity,
                    toTimestamp(currentChild.scheduledRecoveryTime) ?? -Infinity
                );
                if (incomingAt >= currentAt || (incomingAt === -Infinity && currentAt === -Infinity)) {
                    merged[childKey][name] = structuredClone(incomingChild);
                }
            }
        }
    }
    return merged;
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
    const incomingRefreshRequestIsStale = event.state?.needsRefresh === true &&
        target.needsRefresh !== true &&
        currentHealthStateTime !== null &&
        (incomingHealthStateTime === null || incomingHealthStateTime < currentHealthStateTime);
    for (const field of MUTABLE_STATE_FIELDS) {
        if (event.state?.[field] === undefined) continue;
        if (field === 'needsRefresh' && incomingRefreshRequestIsStale) continue;
        if (healthStateIsStale && (HEALTH_STATE_FIELDS.has(field) || field === 'needsRefresh')) continue;
        if (healthCheckMetadataIsStale && HEALTH_CHECK_METADATA_FIELDS.has(field)) continue;
        if (MONOTONIC_TIME_FIELDS.has(field)) {
            const incomingTime = toTimestamp(event.state[field]);
            const currentTime = toTimestamp(target[field]);
            if (currentTime !== null && (incomingTime === null || incomingTime < currentTime)) continue;
        }
        if (field === 'usageCount' && !healthStateIsStale) {
            const incomingHealth = toTimestamp(event.state.lastHealthStateTime);
            const currentHealth = toTimestamp(target.lastHealthStateTime);
            if (incomingHealth === null || (currentHealth !== null && incomingHealth < currentHealth)) {
                target[field] = Math.max(Number(target[field] || 0), Number(event.state[field] || 0));
                continue;
            }
        }
        if (field === 'antigravityQuotaHealth' || field === 'codexQuotaHealth' || field === 'codexRateLimitCooldown') {
            target[field] = mergeQuotaState(target[field], event.state[field]);
        } else {
            target[field] = structuredClone(event.state[field]);
        }
    }
    return true;
}
