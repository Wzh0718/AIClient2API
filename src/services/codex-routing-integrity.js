function createRoutingIntegrityError(reason, route = {}) {
    const error = new Error(`Codex routing integrity violation: ${reason}`);
    error.code = 'ROUTING_INTEGRITY_VIOLATION';
    error.status = 500;
    error.details = {
        reason,
        routingMode: route.routingMode || null,
        selectedGroupId: route.selectedGroupId || null,
        actualProviderGroupId: route.actualProviderGroupId || null
    };
    return error;
}

export function getCodexRoutingConsistencyStatus(route = {}, actualProviderUuid = null) {
    const selectedProviderUuid = route.selectedProviderUuid || null;
    if (!selectedProviderUuid || !actualProviderUuid) return 'unverifiable';
    if (selectedProviderUuid !== actualProviderUuid) return 'mismatch';

    if (route.routingMode === 'pool') {
        return route.selectedGroupId === null && route.actualProviderGroupId === null
            ? 'consistent'
            : 'mismatch';
    }

    if (route.routingMode === 'restricted') {
        return Array.isArray(route.restrictedCredentialUuids)
            && route.restrictedCredentialUuids.includes(actualProviderUuid)
            && route.selectedGroupId === null
            && route.actualProviderGroupId === null
            ? 'consistent'
            : 'mismatch';
    }

    if (route.routingMode === 'auto' || route.routingMode === 'fixed') {
        if (
            !route.selectedGroupId
            || !route.actualProviderGroupId
            || route.selectedGroupId !== route.actualProviderGroupId
        ) {
            return 'mismatch';
        }
        if (
            route.routingMode === 'fixed'
            && route.fixedCredentialUuid
            && route.fixedCredentialUuid !== actualProviderUuid
        ) {
            return 'mismatch';
        }
        return 'consistent';
    }

    return 'unverifiable';
}

export function assertCodexRoutingIntegrity(config = {}, actualProviderUuid = null) {
    const route = config._codexRouteResult || config._codexRouting;
    if (!route || !['pool', 'auto', 'fixed', 'restricted'].includes(route.routingMode)) return true;

    const consistencyStatus = getCodexRoutingConsistencyStatus(route, actualProviderUuid);
    route.consistencyStatus = consistencyStatus;
    if (consistencyStatus === 'consistent') return true;

    throw createRoutingIntegrityError(
        consistencyStatus === 'unverifiable' ? 'ROUTE_UNVERIFIABLE' : 'ROUTE_MISMATCH',
        route
    );
}
