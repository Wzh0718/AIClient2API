export function createSystemPromptPersistenceQueue(options = {}) {
    const debounceMs = Math.max(0, Number(options.debounceMs ?? 100));
    const read = options.read;
    const write = options.write;
    const onSuccess = options.onSuccess || (() => {});
    const onError = options.onError || (() => {});
    let loaded = false;
    let persisted = '';
    let pending = null;
    let pendingProvider = '';
    let timer = null;
    let writeChain = Promise.resolve();
    let writes = 0;

    async function loadOnce() {
        if (loaded) return;
        loaded = true;
        try {
            persisted = String(await read() ?? '');
        } catch (error) {
            if (error?.code !== 'ENOENT') onError(error);
            persisted = '';
        }
    }

    function schedule(value, providerName = '') {
        pending = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
        pendingProvider = providerName;
        if (!timer) {
            timer = setTimeout(() => {
                timer = null;
                void flush();
            }, debounceMs);
            timer.unref?.();
        }
        return Promise.resolve();
    }

    async function flush() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (pending === null) return writeChain;
        const next = pending;
        const providerName = pendingProvider;
        pending = null;
        writeChain = writeChain.then(async () => {
            await loadOnce();
            if (next === persisted) return;
            await write(next);
            persisted = next;
            writes++;
            onSuccess(providerName, next);
        }).catch(error => onError(error));
        await writeChain;
        if (pending !== null) return flush();
    }

    return {
        schedule,
        flush,
        snapshot: () => ({ writes, pending: pending !== null || Boolean(timer) })
    };
}
