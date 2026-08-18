import fs from 'fs';
import { monitorEventLoopDelay } from 'perf_hooks';
import { BigObjectCapacity, ImageCapacityExceededError, resolveBigObjectBudget, resolveImageQueueLimit } from './big-object-capacity.js';

export function readContainerLimitBytes(env = process.env) {
    const configured = Number(env.RUNTIME_CONTAINER_MEMORY_LIMIT_BYTES);
    if (Number.isFinite(configured) && configured > 0) return configured;
    for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
        try {
            const value = fs.readFileSync(file, 'utf8').trim();
            const parsed = Number(value);
            if (value !== 'max' && Number.isFinite(parsed) && parsed > 0 && parsed < Number.MAX_SAFE_INTEGER) return parsed;
        } catch {}
    }
    return null;
}

function abortableDelay(delayMs, signal) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('Image capacity wait aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
        const onAbort = () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('Image capacity wait aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

export class RuntimeImageCapacity {
    constructor({
        budgetBytes = resolveBigObjectBudget({ containerLimitBytes: readContainerLimitBytes() }),
        executionWorkers = Number(process.env.RUNTIME_EXECUTION_WORKERS || 1),
        multiWorker = process.env.RUNTIME_MULTI_WORKER_ENABLED === 'true' && process.env.RUNTIME_WORKER_ROLE === 'execution',
        waitMs = Number(process.env.RUNTIME_IMAGE_QUEUE_WAIT_MS || 3_000),
        metrics = {},
        retryIntervalMs = 50,
        localCapacity = null
    } = {}) {
        this.globalBudgetBytes = Math.max(1, Number(budgetBytes) || 1);
        this.executionWorkers = Math.max(1, Number(executionWorkers) || 1);
        this.multiWorker = multiWorker === true;
        this.waitMs = Math.max(0, Number(waitMs) || 0);
        this.retryIntervalMs = Math.max(1, Number(retryIntervalMs) || 50);
        this.metrics = metrics;
        this.fallbackBudgetBytes = Math.max(1, Math.floor(this.globalBudgetBytes / this.executionWorkers));
        this.localCapacity = localCapacity || new BigObjectCapacity({
            budgetBytes: this.globalBudgetBytes,
            queueLimit: 20,
            waitMs: this.waitMs,
            metrics
        });
        this.redisDegraded = false;
        this.lastGlobalUsedBytes = 0;
        this.overcommitted = 0;
        this.coordinationFailures = 0;
        this.globalRejections = 0;
        this.lastCoordinationError = null;
    }

    updateSignals(signals = {}) {
        Object.assign(this.metrics, signals);
        this.localCapacity.samplePressure();
    }

    setQueueLimit(queueLimit) {
        this.localCapacity.queueLimit = Math.max(0, Number(queueLimit) || 0);
    }

    async _acquireGlobal({ bytes, coordination, requestId, signal }) {
        if (!this.multiWorker || !coordination?.acquireImageCapacity) return { lease: null, mode: 'local' };
        const deadline = Date.now() + this.waitMs;
        while (true) {
            try {
                const lease = await coordination.acquireImageCapacity({
                    bytes,
                    budgetBytes: this.globalBudgetBytes,
                    requestId,
                    ttlMs: 120_000
                });
                this.redisDegraded = false;
                this.lastCoordinationError = null;
                if (lease) {
                    this.lastGlobalUsedBytes = Number(lease.usedBytes || this.lastGlobalUsedBytes);
                    return { lease, mode: 'redis-global' };
                }
                this.globalRejections += 1;
            } catch (error) {
                this.redisDegraded = true;
                this.coordinationFailures += 1;
                this.lastCoordinationError = String(error?.message || error).slice(0, 200);
                return { lease: null, mode: 'local-fallback' };
            }
            if (Date.now() >= deadline) {
                throw new ImageCapacityExceededError('Image service is temporarily at capacity', {
                    blockedReasons: ['global_budget'],
                    activeBytes: this.localCapacity.activeBytes,
                    budgetBytes: this.globalBudgetBytes,
                    estimatedBytes: bytes,
                    rssBytes: Number(this.metrics.rssBytes) || 0,
                    rssLimitBytes: Number(this.metrics.rssLimitBytes) || 0,
                    eventLoopP95Ms: Number(this.metrics.eventLoopP95Ms) || 0,
                    queued: this.localCapacity.queue.length
                });
            }
            await abortableDelay(Math.min(this.retryIntervalMs, Math.max(1, deadline - Date.now())), signal);
        }
    }

    async acquire({ bytes, kind = 'image', coordination = null, requestId = '', signal } = {}) {
        const estimatedBytes = Math.max(1, Number(bytes) || 1);
        const global = await this._acquireGlobal({ bytes: estimatedBytes, coordination, requestId, signal });
        const localBudgetBytes = global.mode === 'local-fallback' ? this.fallbackBudgetBytes : this.globalBudgetBytes;
        this.localCapacity.setBudgetBytes(localBudgetBytes);
        let localTicket;
        try {
            localTicket = await this.localCapacity.acquire({ bytes: estimatedBytes, kind, signal });
        } catch (error) {
            if (global.lease && coordination?.releaseImageCapacity) {
                await coordination.releaseImageCapacity(global.lease.leaseId).catch(() => {});
            }
            throw error;
        }
        return {
            bytes: estimatedBytes,
            kind,
            localTicket,
            globalLeaseId: global.lease?.leaseId || null,
            coordination: global.lease ? coordination : null,
            coordinationMode: global.mode
        };
    }

    async resize(ticket, bytes) {
        if (!ticket) return { resized: false, overcommitted: false };
        const nextBytes = Math.max(1, Number(bytes) || 1);
        const localWithinBudget = this.localCapacity.resize(ticket.localTicket, nextBytes);
        ticket.bytes = nextBytes;
        let globalState = { resized: true, overcommitted: false };
        if (ticket.globalLeaseId && ticket.coordination?.resizeImageCapacity) {
            try {
                globalState = await ticket.coordination.resizeImageCapacity(ticket.globalLeaseId, nextBytes, {
                    budgetBytes: this.globalBudgetBytes
                });
            } catch {
                this.redisDegraded = true;
                this.coordinationFailures += 1;
                globalState = { resized: false, overcommitted: true };
            }
        }
        const overcommitted = !localWithinBudget || globalState.overcommitted === true || globalState.resized === false;
        if (overcommitted) this.overcommitted += 1;
        return { ...globalState, resized: !overcommitted, overcommitted };
    }

    async release(ticket) {
        if (!ticket) return false;
        this.localCapacity.release(ticket.localTicket);
        if (ticket.globalLeaseId && ticket.coordination?.releaseImageCapacity) {
            try {
                await ticket.coordination.releaseImageCapacity(ticket.globalLeaseId);
            } catch {
                this.redisDegraded = true;
                this.coordinationFailures += 1;
            }
        }
        return true;
    }

    snapshot() {
        return {
            ...this.localCapacity.snapshot(),
            globalBudgetBytes: this.globalBudgetBytes,
            localBudgetBytes: this.localCapacity.budgetBytes,
            fallbackBudgetBytes: this.fallbackBudgetBytes,
            globalUsedBytes: this.lastGlobalUsedBytes,
            redisDegraded: this.redisDegraded,
            coordinationFailures: this.coordinationFailures,
            globalRejections: this.globalRejections,
            overcommitted: this.overcommitted,
            lastCoordinationError: this.lastCoordinationError
        };
    }
}

const containerLimitBytes = readContainerLimitBytes();
const metrics = {};
export const runtimeImageCapacity = new RuntimeImageCapacity({
    budgetBytes: Number(process.env.RUNTIME_BIG_OBJECT_BUDGET_BYTES) || resolveBigObjectBudget({ containerLimitBytes }),
    executionWorkers: Number(process.env.RUNTIME_EXECUTION_WORKERS || 1),
    multiWorker: process.env.RUNTIME_MULTI_WORKER_ENABLED === 'true' && process.env.RUNTIME_WORKER_ROLE === 'execution',
    waitMs: Number(process.env.RUNTIME_IMAGE_QUEUE_WAIT_MS || 3_000),
    metrics
});

export function estimateImageResponseBytes({ n = 1, inputBytes = 0 } = {}) {
    const images = Math.max(1, Number(n) || 1);
    const perImagePeakBytes = Number(process.env.RUNTIME_IMAGE_ESTIMATED_BYTES) || 32 * 1024 * 1024;
    const inputPeakMultiplier = Number(process.env.RUNTIME_IMAGE_INPUT_MEMORY_MULTIPLIER) || 3;
    return Math.ceil(images * perImagePeakBytes + Math.max(0, Number(inputBytes) || 0) * inputPeakMultiplier);
}

export function estimateActualImagePeakBytes(data = [], { inputBytes = 0, reservedBytes = 0 } = {}) {
    const encodedChars = (Array.isArray(data) ? data : []).reduce((total, item) => {
        const value = item?.b64_json || item?.url || '';
        return total + (typeof value === 'string' ? value.length : 0);
    }, 0);
    const retainedPeak = encodedChars * 2 + Math.max(0, Number(inputBytes) || 0) * 3;
    return Math.max(1, Number(reservedBytes) || 0, Math.ceil(retainedPeak));
}

export function buildImageCapacitySignals(snapshot = {}, rssLimitBytes = 0) {
    return {
        rssBytes: Number(snapshot?.process?.rss) || 0,
        rssLimitBytes: Number(rssLimitBytes) || 0,
        eventLoopP95Ms: Number(snapshot?.process?.eventLoopDelay?.p95) || 0
    };
}

export function updateImageCapacitySignals(providerPoolManager, snapshot = null) {
    const memory = process.memoryUsage();
    runtimeImageCapacity.updateSignals({
        rssBytes: Number(snapshot?.process?.rss) || memory.rss,
        rssLimitBytes: readContainerLimitBytes() || 0,
        ...(snapshot?.process?.eventLoopDelay ? { eventLoopP95Ms: Number(snapshot.process.eventLoopDelay.p95) || 0 } : {})
    });
    const healthy = Object.keys(providerPoolManager?.providerStatus || {})
        .reduce((total, type) => total + providerPoolManager.getHealthyCount(type), 0);
    runtimeImageCapacity.setQueueLimit(resolveImageQueueLimit(healthy));
}

const imageEventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
imageEventLoopDelay.enable?.();
const sampler = setInterval(() => {
    runtimeImageCapacity.updateSignals({
        rssBytes: process.memoryUsage().rss,
        rssLimitBytes: readContainerLimitBytes() || 0,
        eventLoopP95Ms: Number(imageEventLoopDelay.percentile?.(95) || 0) / 1e6
    });
    imageEventLoopDelay.reset?.();
}, 1000);
sampler.unref?.();
