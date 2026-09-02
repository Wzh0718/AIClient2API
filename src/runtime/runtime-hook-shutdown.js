function createDrainTimeoutError(layer, result) {
    const error = new Error(`Runtime hook ${layer} drain timed out`);
    error.code = 'RUNTIME_HOOK_DRAIN_TIMEOUT';
    error.layer = layer;
    error.result = result;
    return error;
}

function assertDrained(layer, result) {
    if (result && result.drained === false) throw createDrainTimeoutError(layer, result);
    return result;
}

/**
 * Stop the runtime-hook durable path in dependency order.
 *
 * The usage store is deliberately closed last. If any in-memory or durable
 * layer cannot drain, this function throws before checkpoint/close so callers
 * can retain the store and pending batcher state for recovery.
 */
export async function drainRuntimeHookTransport({
    batcher = null,
    bridge = null,
    stream = null,
    projector = null,
    usageEventStore = null,
    batcherTimeoutMs = 30_000,
    bridgeTimeoutMs = 20_000,
    projectorTimeoutMs = 30_000,
    waitForProjectionRefresh = null,
    onUsageEventStoreSnapshot = null
} = {}) {
    await batcher?.close?.({ timeoutMs: batcherTimeoutMs });

    const bridgeResult = await bridge?.drain?.({ timeoutMs: bridgeTimeoutMs });
    assertDrained('bridge', bridgeResult);

    await stream?.flushSpool?.();
    await projector?.drain?.({ timeoutMs: projectorTimeoutMs });
    await waitForProjectionRefresh?.();

    let usageEventStoreSnapshot = null;
    if (usageEventStore) {
        usageEventStoreSnapshot = await usageEventStore.checkpoint();
        await usageEventStore.close();
        await onUsageEventStoreSnapshot?.(usageEventStoreSnapshot);
    }

    await stream?.close?.();
    return { usageEventStoreSnapshot };
}
