const DEFAULTS = Object.freeze({
    appendBatchSize: 100,
    streamReadBatchSize: null,
    projectionBatchSize: null,
    waitMs: 20,
    flushMs: 1000,
    queueMax: null,
    statusPollMs: 1000,
    claimIntervalMs: 5000
});

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
        if (Number.isInteger(value) && value >= lowerBound && value <= maximum) return value;
    }
    return fallback;
}

function readNonNegative(source, keys, fallback) {
    for (const key of keys) {
        if (!hasValue(source, key)) continue;
        const value = Number(source[key]);
        if (Number.isFinite(value) && value >= 0) return value;
    }
    return fallback;
}

export function resolveRuntimeBatchConfig({ env = process.env, config = {} } = {}) {
    const appendBatchSize = readInteger(
        env,
        ['USAGE_EVENT_BATCH_SIZE'],
        readInteger(config, ['USAGE_EVENT_BATCH_SIZE'], DEFAULTS.appendBatchSize)
    );
    const streamReadBatchSize = readInteger(
        env,
        ['USAGE_EVENT_STREAM_READ_BATCH_SIZE'],
        readInteger(
            config,
            ['USAGE_EVENT_STREAM_READ_BATCH_SIZE'],
            appendBatchSize
        )
    );
    const projectionBatchSize = readInteger(
        env,
        ['USAGE_EVENT_PROJECTION_BATCH_SIZE'],
        readInteger(
            config,
            ['USAGE_EVENT_PROJECTION_BATCH_SIZE'],
            appendBatchSize
        )
    );
    const waitMs = readInteger(
        env,
        ['USAGE_EVENT_BATCH_WAIT_MS'],
        readInteger(config, ['USAGE_EVENT_BATCH_WAIT_MS'], DEFAULTS.waitMs),
        { min: 1, allowZero: true }
    );
    const flushMs = readNonNegative(
        env,
        ['USAGE_EVENT_BATCH_FLUSH_MS'],
        readNonNegative(config, ['USAGE_EVENT_BATCH_FLUSH_MS'], DEFAULTS.flushMs)
    );
    const queueDefault = Math.min(10_000, Math.max(1_000, appendBatchSize * 10));
    const configuredQueueMax = readInteger(
        env,
        ['USAGE_EVENT_INGEST_QUEUE_MAX'],
        readInteger(config, ['USAGE_EVENT_INGEST_QUEUE_MAX'], queueDefault)
    );
    const statusPollMs = readInteger(
        env,
        ['USAGE_EVENT_STATUS_POLL_MS'],
        readInteger(config, ['USAGE_EVENT_STATUS_POLL_MS'], DEFAULTS.statusPollMs),
        { min: 1, allowZero: true }
    );
    const claimIntervalMs = readInteger(
        env,
        ['USAGE_EVENT_CLAIM_INTERVAL_MS'],
        readInteger(config, ['USAGE_EVENT_CLAIM_INTERVAL_MS'], DEFAULTS.claimIntervalMs),
        { min: 1, allowZero: true }
    );

    return {
        appendBatchSize,
        batchSize: appendBatchSize,
        streamReadBatchSize,
        readBatchSize: streamReadBatchSize,
        projectionBatchSize,
        waitMs,
        flushMs,
        queueMax: Math.min(10_000, Math.max(appendBatchSize, configuredQueueMax)),
        statusPollMs,
        claimIntervalMs
    };
}
