function validRevision(value) {
    return Number.isInteger(value) && value > 0;
}

export function createProviderConfigEvent(providerType, providers, options = {}) {
    if (!providerType || !Array.isArray(providers) || !validRevision(options.revision)) {
        throw new Error('Invalid provider config synchronization event');
    }
    return {
        type: 'provider_config_sync',
        revision: options.revision,
        providerType: String(providerType),
        providers: structuredClone(providers),
        changedUuids: [...new Set(options.changedUuids || providers.map(provider => provider?.uuid).filter(Boolean))],
        action: String(options.action || 'sync'),
        occurredAt: new Date().toISOString()
    };
}

export function applyProviderConfigEvent(providerPools, event, current = {}) {
    if (!providerPools || event?.type !== 'provider_config_sync' ||
        !event.providerType || !Array.isArray(event.providers) || !validRevision(event.revision) ||
        event.revision < Number(current.revision || 0)) {
        return { applied: false, revision: Number(current.revision || 0), changedUuids: [] };
    }
    const previous = Array.isArray(providerPools[event.providerType]) ? providerPools[event.providerType] : [];
    const changedUuids = [...new Set([
        ...previous.map(provider => provider?.uuid),
        ...event.providers.map(provider => provider?.uuid),
        ...(event.changedUuids || [])
    ].filter(Boolean))];
    providerPools[event.providerType] = structuredClone(event.providers);
    return { applied: true, revision: event.revision, changedUuids };
}
