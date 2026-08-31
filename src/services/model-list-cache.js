const cache = new Map();

export function clearModelListCache() {
    cache.clear();
}

export async function getCachedModelList(key, loader, { ttlMs = 5000 } = {}) {
    const now = Date.now();
    const existing = cache.get(key);
    if (existing?.value && existing.expiresAt > now) return existing.value;
    if (existing?.promise) return existing.promise;

    const promise = Promise.resolve().then(loader).then(value => {
        cache.set(key, { value, expiresAt: Date.now() + Math.max(0, Number(ttlMs) || 0) });
        return value;
    }).catch(error => {
        cache.delete(key);
        throw error;
    });
    cache.set(key, { promise, expiresAt: 0 });
    return promise;
}
