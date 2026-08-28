import { monitorEventLoopDelay, performance } from 'perf_hooks';

function readNonNegativeNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function readSampleRate(value, fallback = 0) {
    return Math.min(1, readNonNegativeNumber(value, fallback));
}

function safeMetadata(metadata = {}) {
    const allowed = [
        'method', 'path', 'model', 'providerType', 'stream',
        'requestBodyBytes', 'responseStatus'
    ];
    return Object.fromEntries(allowed
        .filter(name => metadata[name] !== undefined && metadata[name] !== null)
        .map(name => [name, metadata[name]]));
}

const REQUIRED_STAGE_NAMES = [
    'providerFilterMs',
    'redisLeaseMs',
    'identityReadMs',
    'identityPersistLockWaitMs',
    'identityPersistIoMs',
    'requestConvertMs',
    'systemPromptPersistMs',
    'upstreamFirstByteMs',
    'upstreamCompleteMs',
    'responseFinalizeMs'
];

function percentile(values, percentage) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.max(0, Math.ceil(sorted.length * percentage / 100) - 1);
    return sorted[index];
}

function summarize(values) {
    return {
        count: values.length,
        p50: percentile(values, 50),
        p95: percentile(values, 95),
        p99: percentile(values, 99),
        max: values.length ? Math.max(...values) : 0
    };
}

export class RuntimeMetrics {
    constructor(options = {}) {
        this.now = options.now || (() => performance.now());
        this.eventLoopDelay = options.eventLoopDelay || monitorEventLoopDelay({ resolution: 20 });
        this.eventLoopDelay.enable?.();
        this.sampleProcess = options.sampleProcess || (() => {
            const memory = process.memoryUsage();
            return {
                rss: memory.rss,
                heapUsed: memory.heapUsed,
                eventLoopUtilization: performance.eventLoopUtilization().utilization
            };
        });
        this.stageSamples = new Map();
        this.requests = { total: 0, success: 0, failed: 0, byWorker: {}, byKind: {} };
        this.output = { bytes: 0, backpressureMs: 0 };
        this.inFlight = 0;
        this.sampleRate = readSampleRate(options.sampleRate ?? process.env.REQUEST_PERF_SAMPLE_RATE, 0);
        this.slowRequestMs = readNonNegativeNumber(options.slowRequestMs ?? process.env.REQUEST_PERF_SLOW_MS, 0);
        this.random = options.random || Math.random;
        this.onProfile = typeof options.onProfile === 'function' ? options.onProfile : null;
    }

    configure(options = {}) {
        if (options.sampleRate !== undefined) this.sampleRate = readSampleRate(options.sampleRate, this.sampleRate);
        if (options.slowRequestMs !== undefined) this.slowRequestMs = readNonNegativeNumber(options.slowRequestMs, this.slowRequestMs);
        return { sampleRate: this.sampleRate, slowRequestMs: this.slowRequestMs };
    }

    recordStage(name, elapsed) {
        const value = Math.max(0, Number(elapsed) || 0);
        const samples = this.stageSamples.get(name) || [];
        samples.push(value);
        if (samples.length > 10_000) samples.splice(0, samples.length - 10_000);
        this.stageSamples.set(name, samples);
    }

    beginRequest({ workerId = 'standalone', kind = 'model', metadata = {} } = {}) {
        const startedAt = this.now();
        let ended = false;
        let finalProfile = null;
        let completionSnapshot = null;
        let requestMetadata = safeMetadata(metadata);
        const sampled = this.random() < this.sampleRate;
        const stageDurations = {};
        let requestOutputBytes = 0;
        let requestBackpressureMs = 0;
        this.inFlight++;
        const recordStage = (name, elapsed) => {
            const value = Math.max(0, Number(elapsed) || 0);
            stageDurations[name] = value;
            this.recordStage(name, value);
        };
        return {
            mark: name => recordStage(name, this.now() - startedAt),
            recordStage,
            setMetadata: metadataUpdate => {
                requestMetadata = { ...requestMetadata, ...safeMetadata(metadataUpdate) };
            },
            addOutputBytes: bytes => {
                const value = Math.max(0, Number(bytes) || 0);
                requestOutputBytes += value;
                this.output.bytes += value;
            },
            addBackpressureMs: ms => {
                const value = Math.max(0, Number(ms) || 0);
                requestBackpressureMs += value;
                this.output.backpressureMs += value;
            },
            end: ({ statusCode = 200 } = {}) => {
                if (ended) return completionSnapshot;
                ended = true;
                this.inFlight--;
                this.requests.total++;
                if (statusCode >= 500) this.requests.failed++;
                else this.requests.success++;
                this.requests.byWorker[workerId] = (this.requests.byWorker[workerId] || 0) + 1;
                this.requests.byKind[kind] = (this.requests.byKind[kind] || 0) + 1;
                const durationMs = this.now() - startedAt;
                recordStage('complete', durationMs);
                requestMetadata = { ...requestMetadata, responseStatus: statusCode };
                completionSnapshot = {
                    workerId,
                    kind,
                    statusCode,
                    durationMs,
                    metadata: requestMetadata,
                    stages: { ...stageDurations },
                    outputBytes: requestOutputBytes,
                    backpressureMs: requestBackpressureMs
                };
                finalProfile = sampled || (this.slowRequestMs > 0 && durationMs >= this.slowRequestMs)
                    ? completionSnapshot
                    : null;
                if (finalProfile) {
                    try {
                        this.onProfile?.(finalProfile);
                    } catch {
                        // Diagnostics must never affect request handling.
                    }
                }
                return completionSnapshot;
            },
            getProfile: () => finalProfile,
            getCompletion: () => completionSnapshot
        };
    }

    snapshot() {
        const stages = {};
        for (const name of REQUIRED_STAGE_NAMES) stages[name] = summarize(this.stageSamples.get(name) || []);
        for (const [name, samples] of this.stageSamples.entries()) stages[name] = summarize(samples);
        const eventLoopDelay = {
            p95: Number(this.eventLoopDelay.percentile?.(95) || 0) / 1e6,
            p99: Number(this.eventLoopDelay.percentile?.(99) || 0) / 1e6,
            max: Number(this.eventLoopDelay.max || 0) / 1e6
        };
        this.eventLoopDelay.reset?.();
        return {
            requests: structuredClone(this.requests),
            stages,
            output: { ...this.output },
            inFlight: this.inFlight,
            process: {
                ...this.sampleProcess(),
                eventLoopDelay
            }
        };
    }
}

export const runtimeMetrics = new RuntimeMetrics();
