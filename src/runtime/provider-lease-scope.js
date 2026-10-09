import { createHash } from 'crypto';
import requestContext from '../utils/context.js';
import logger from '../utils/logger.js';

export function getProviderLeaseScope(store = requestContext.getStore()) {
    return store.providerLeaseScope ||= {
        closed: false, leases: new Map(), byProvider: new Map(), pending: new Set(), keyRef: null
    };
}

export function setProviderLeaseKey(config, store = requestContext.getStore()) {
    const key = config?.potluckKeyData?.id || config?.potluckApiKey;
    if (key) getProviderLeaseScope(store).keyRef = `sha256:${createHash('sha256').update(String(key)).digest('hex').slice(0, 16)}`;
}

export function providerLeaseOwner(model, store = requestContext.getStore()) {
    return {
        requestId: store.requestId || null,
        keyRef: getProviderLeaseScope(store).keyRef,
        model: model || null,
        createdAt: Date.now()
    };
}

function logLease(event, record, reason) {
    logger.info(`[Provider Lease] ${JSON.stringify({ event, leaseId: record.leaseId,
        providerType: record.providerType, providerUuid: record.uuid,
        requestId: record.requestId, workerId: record.workerId, keyRef: record.keyRef,
        model: record.model, createdAt: record.createdAt, reason })}`);
}

function releaseRecord(scope, record, reason) {
    // Remove ownership synchronously so concurrent finish/close/finally cannot release twice.
    scope.leases.delete(record.leaseId);
    const key = `${record.providerType}:${record.uuid}`;
    const ids = scope.byProvider.get(key);
    ids?.delete(record.leaseId);
    if (!ids?.size) scope.byProvider.delete(key);
    let operation;
    operation = Promise.resolve().then(() => record.release()).then(() => {
        logLease('provider_lease_released', record, reason);
        return true;
    }).catch(() => {
        // Coordinator.release stops renewal before contacting Redis; TTL is the fallback.
        logLease('provider_lease_release_failed', record, reason);
        return false;
    }).finally(() => scope.pending.delete(operation));
    scope.pending.add(operation);
    return operation;
}

export async function registerProviderLease(scope, coordinator, lease, model, store = requestContext.getStore()) {
    const record = { ...providerLeaseOwner(model, store), ...lease,
        workerId: coordinator.workerId || null, release: () => coordinator.release(lease.leaseId) };
    if (scope.closed) {
        await releaseRecord(scope, record, 'request_already_closed');
        throw Object.assign(new Error('Request ended before provider lease acquisition completed'), { name: 'AbortError', status: 499 });
    }
    scope.leases.set(record.leaseId, record);
    const key = `${record.providerType}:${record.uuid}`;
    if (!scope.byProvider.has(key)) scope.byProvider.set(key, new Set());
    scope.byProvider.get(key).add(record.leaseId);
    logLease('provider_lease_acquired', record, 'acquire');
}

export function releaseProviderLease(providerType, uuid, store = requestContext.getStore()) {
    const scope = getProviderLeaseScope(store);
    const ids = scope.byProvider.get(`${providerType}:${uuid}`);
    const id = ids && [...ids].at(-1);
    const record = scope.leases.get(id);
    return record ? releaseRecord(scope, record, 'release_slot') : Promise.resolve(false);
}

export async function rollbackProviderLeases(checkpoint, store = requestContext.getStore()) {
    const scope = getProviderLeaseScope(store);
    await Promise.all([...scope.leases.values()]
        .filter(record => !checkpoint.has(record.leaseId))
        .map(record => releaseRecord(scope, record, 'selection_failed')));
}

export async function closeProviderLeaseScope(store, reason = 'handler_return') {
    const scope = getProviderLeaseScope(store);
    scope.closed = true;
    for (const record of [...scope.leases.values()]) releaseRecord(scope, record, reason);
    const keyLease = store.potluckKeyConcurrencyLease;
    store.potluckKeyConcurrencyLease = null;
    if (keyLease) {
        const pending = Promise.resolve().then(() => keyLease.release()).catch(() => {
            logger.warn('[Provider Lease] Request key lease release failed; renewal stopped by coordinator');
        });
        scope.pending.add(pending);
        pending.finally(() => scope.pending.delete(pending));
    }
    await Promise.all([...scope.pending]);
}
