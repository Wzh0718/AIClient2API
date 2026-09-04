import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 请求上下文管理工具
 * 使用 AsyncLocalStorage 实现线程级（请求级）变量存储
 */
class RequestContext {
    constructor() {
        this.storage = new AsyncLocalStorage();
    }

    /**
     * 在上下文中运行
     * @param {Object} context - 上下文数据
     * @param {Function} callback - 回调函数
     * @returns {any}
     */
    run(context, callback) {
        return this.storage.run(context || {}, callback);
    }

    /**
     * 获取当前上下文
     * @returns {Object}
     */
    getStore() {
        return this.storage.getStore() || {};
    }

    /**
     * 设置上下文中的值
     * @param {string} key 
     * @param {any} value 
     */
    set(key, value) {
        const store = this.storage.getStore();
        if (store) {
            store[key] = value;
        }
    }

    /**
     * 获取上下文中的值
     * @param {string} key 
     * @returns {any}
     */
    get(key) {
        const store = this.storage.getStore();
        return store ? store[key] : undefined;
    }
}

const requestContext = new RequestContext();

const EMPTY_ROUTING_WAITS = Object.freeze({
    keyQueueWaitMs: 0,
    credentialLeaseWaitMs: 0,
    elasticQueueWaitMs: 0,
    availabilityRefreshMs: 0,
    elasticAttemptCount: 0,
    selectionPlanFilterMs: 0,
    selectionRankMs: 0,
    selectionHydrateMs: 0
});

/**
 * providerFilterMs mixes queueing with routing computation, which made a
 * seconds-long p50 look like a CPU hotspot. These accumulators keep waiting
 * separable for the request that is currently in flight.
 * @param {'keyQueueWaitMs'|'credentialLeaseWaitMs'|'elasticQueueWaitMs'|'availabilityRefreshMs'|'elasticAttemptCount'|'selectionPlanFilterMs'|'selectionRankMs'|'selectionHydrateMs'} kind
 * @param {number} waitMs
 */
export function accumulateRoutingWait(kind, waitMs) {
    const value = Math.max(0, Number(waitMs) || 0);
    if (value === 0) return;
    const store = requestContext.getStore();
    if (!store.routingWaits) store.routingWaits = { ...EMPTY_ROUTING_WAITS };
    store.routingWaits[kind] = (store.routingWaits[kind] || 0) + value;
}

export function readRoutingWaits() {
    const waits = requestContext.getStore().routingWaits;
    return {
        keyQueueWaitMs: Math.max(0, Number(waits?.keyQueueWaitMs) || 0),
        credentialLeaseWaitMs: Math.max(0, Number(waits?.credentialLeaseWaitMs) || 0),
        elasticQueueWaitMs: Math.max(0, Number(waits?.elasticQueueWaitMs) || 0),
        availabilityRefreshMs: Math.max(0, Number(waits?.availabilityRefreshMs) || 0),
        elasticAttemptCount: Math.max(0, Number(waits?.elasticAttemptCount) || 0),
        selectionPlanFilterMs: Math.max(0, Number(waits?.selectionPlanFilterMs) || 0),
        selectionRankMs: Math.max(0, Number(waits?.selectionRankMs) || 0),
        selectionHydrateMs: Math.max(0, Number(waits?.selectionHydrateMs) || 0)
    };
}

export function computeSelectionStages(totalMs, waits = readRoutingWaits()) {
    const providerFilterMs = Math.max(0, Number(totalMs) || 0);
    const keyQueueWaitMs = Math.max(0, Number(waits.keyQueueWaitMs) || 0);
    const credentialLeaseWaitMs = Math.max(0, Number(waits.credentialLeaseWaitMs) || 0);
    const elasticQueueWaitMs = Math.max(0, Number(waits.elasticQueueWaitMs) || 0);
    const availabilityRefreshMs = Math.max(0, Number(waits.availabilityRefreshMs) || 0);
    const elasticAttemptCount = Math.max(0, Number(waits.elasticAttemptCount) || 0);
    const selectionPlanFilterMs = Math.max(0, Number(waits.selectionPlanFilterMs) || 0);
    const selectionRankMs = Math.max(0, Number(waits.selectionRankMs) || 0);
    const selectionHydrateMs = Math.max(0, Number(waits.selectionHydrateMs) || 0);
    return {
        providerFilterMs,
        keyQueueWaitMs,
        credentialLeaseWaitMs,
        elasticQueueWaitMs,
        availabilityRefreshMs,
        elasticAttemptCount,
        selectionPlanFilterMs,
        selectionRankMs,
        selectionHydrateMs,
        selectionComputeMs: Math.max(0, providerFilterMs - keyQueueWaitMs - credentialLeaseWaitMs - elasticQueueWaitMs - availabilityRefreshMs - selectionPlanFilterMs - selectionRankMs - selectionHydrateMs)
    };
}

export default requestContext;
