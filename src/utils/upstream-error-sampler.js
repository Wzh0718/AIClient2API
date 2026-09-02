const TRANSIENT_STATUSES = new Set([429, 503]);

export class UpstreamErrorLogSampler {
    constructor({ windowMs = 30_000, summaryIntervalMs = 60_000, now = () => Date.now() } = {}) {
        this.windowMs = Math.max(1000, Number(windowMs) || 30_000);
        this.summaryIntervalMs = Math.max(this.windowMs, Number(summaryIntervalMs) || 60_000);
        this.now = now;
        this.buckets = new Map();
    }

    record({ scope = 'Server', providerType = 'unknown', model = 'unknown', status = 0 } = {}) {
        const numericStatus = Number(status) || 0;
        if (!TRANSIENT_STATUSES.has(numericStatus)) return { log: true, summary: false, count: 1 };
        const key = `${scope}:${providerType}:${model}:${numericStatus}`;
        const current = this.now();
        let bucket = this.buckets.get(key);
        if (!bucket || current - bucket.windowStartedAt >= this.summaryIntervalMs) {
            bucket = bucket
                ? { ...bucket, windowStartedAt: current, windowCount: 0 }
                : { windowStartedAt: current, lastLoggedAt: current, windowCount: 0, totalCount: 0 };
            this.buckets.set(key, bucket);
        }
        bucket.windowCount += 1;
        bucket.totalCount += 1;
        const shouldLog = bucket.windowCount === 1 || current - bucket.lastLoggedAt >= this.summaryIntervalMs;
        const summary = shouldLog && bucket.totalCount > 1;
        if (shouldLog) bucket.lastLoggedAt = current;
        return { log: shouldLog, summary, count: bucket.totalCount };
    }
}

export const upstreamErrorLogSampler = new UpstreamErrorLogSampler();
