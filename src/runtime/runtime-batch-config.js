const DEFAULTS = Object.freeze({
    appendBatchSize: 100,
    streamReadBatchSize: null,
    projectionBatchSize: null,
    waitMs: 1000,
    flushMs: 1000,
    queueMax: null,
    statusPollMs: 1000,
    claimIntervalMs: 5000
});

const MAX_BATCH_SIZE = 10_000;
const MAX_TIMER_MS = 60_000;
const MAX_CLAIM_INTERVAL_MS = 24 * 60 * 60 * 1000;

function hasValue(source, key) {
    return source && Object.prototype.hasOwnProperty.call(source, key)
        && source[key] !== undefined
        && source[key] !== null
        && source[key] !== '';
}

function readInteger(source, keys, fallback, { min = 1, allowZero = false, maximum = Number.MAX_SAFE_INTEGER } = {}) {
    for (const key of keys) {
        if (!hasValue(source, key)) continue;
        const value = Number(source[key]);
        const lowerBound = allowZero ? 0 : min;
        if (Number.isInteger(value) && value >= lowerBound) return Math.min(value, maximum);
    }
    return fallback;
}

function readNonNegative(source, keys, fallback, maximum = Number.MAX_SAFE_INTEGER) {
    for (const key of keys) {
        if (!hasValue(source, key)) continue;
        const value = Number(source[key]);
        if (Number.isFinite(value) && value >= 0) return Math.min(value, maximum);
    }
    return fallback;
}

export function resolveRuntimeBatchConfig({ env = process.env, config = {} } = {}) {
    const appendBatchSize = readInteger(
        env,
        ['USAGE_EVENT_BATCH_SIZE'],
        readInteger(config, ['USAGE_EVENT_BATCH_SIZE'], DEFAULTS.appendBatchSize, { maximum: MAX_BATCH_SIZE }),
        { maximum: MAX_BATCH_SIZE }
    );
    const streamReadBatchSize = readInteger(
        env,
        ['USAGE_EVENT_STREAM_READ_BATCH_SIZE'],
        readInteger(
            config,
            ['USAGE_EVENT_STREAM_READ_BATCH_SIZE'],
            appendBatchSize,
            { maximum: MAX_BATCH_SIZE }
        ),
        { maximum: MAX_BATCH_SIZE }
    );
    const projectionBatchSize = readInteger(
        env,
        ['USAGE_EVENT_PROJECTION_BATCH_SIZE'],
        readInteger(
            config,
            ['USAGE_EVENT_PROJECTION_BATCH_SIZE'],
            appendBatchSize,
            { maximum: MAX_BATCH_SIZE }
        ),
        { maximum: MAX_BATCH_SIZE }
    );
    const waitMs = readInteger(
        env,
        ['USAGE_EVENT_BATCH_WAIT_MS'],
        readInteger(config, ['USAGE_EVENT_BATCH_WAIT_MS'], DEFAULTS.waitMs, { maximum: MAX_TIMER_MS }),
        { maximum: MAX_TIMER_MS }
    );
    const flushMs = readNonNegative(
        env,
        ['USAGE_EVENT_BATCH_FLUSH_MS'],
        readNonNegative(config, ['USAGE_EVENT_BATCH_FLUSH_MS'], DEFAULTS.flushMs, MAX_TIMER_MS),
        MAX_TIMER_MS
    );
    const queueDefault = Math.min(10_000, Math.max(1_000, appendBatchSize * 10));
    const configuredQueueMax = readInteger(
        env,
        ['USAGE_EVENT_INGEST_QUEUE_MAX'],
        readInteger(config, ['USAGE_EVENT_INGEST_QUEUE_MAX'], queueDefault, { maximum: MAX_BATCH_SIZE }),
        { maximum: MAX_BATCH_SIZE }
    );
    const statusPollMs = readInteger(
        env,
        ['USAGE_EVENT_STATUS_POLL_MS'],
        readInteger(config, ['USAGE_EVENT_STATUS_POLL_MS'], DEFAULTS.statusPollMs, { maximum: MAX_TIMER_MS }),
        { maximum: MAX_TIMER_MS }
    );
    const claimIntervalMs = readInteger(
        env,
        ['USAGE_EVENT_CLAIM_INTERVAL_MS'],
        readInteger(config, ['USAGE_EVENT_CLAIM_INTERVAL_MS'], DEFAULTS.claimIntervalMs, { maximum: MAX_CLAIM_INTERVAL_MS }),
        { maximum: MAX_CLAIM_INTERVAL_MS }
    );

    return {
        appendBatchSize,
        batchSize: appendBatchSize,
        streamReadBatchSize,
        readBatchSize: streamReadBatchSize,
        projectionBatchSize,
        waitMs,
        flushMs,
        queueMax: Math.min(MAX_BATCH_SIZE, Math.max(appendBatchSize, configuredQueueMax)),
        statusPollMs,
        claimIntervalMs
    };
}
