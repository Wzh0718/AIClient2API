import { resolveRuntimeBatchConfig } from '../src/runtime/runtime-batch-config.js';

describe('runtime batch configuration', () => {
    test('prefers explicit environment values over CONFIG defaults, including zero', () => {
        expect(resolveRuntimeBatchConfig({
            env: {
                USAGE_EVENT_BATCH_SIZE: '500',
                USAGE_EVENT_BATCH_FLUSH_MS: '0',
                USAGE_EVENT_STREAM_READ_BATCH_SIZE: '250',
                USAGE_EVENT_PROJECTION_BATCH_SIZE: '75'
            },
            config: {
                USAGE_EVENT_BATCH_SIZE: 100,
                USAGE_EVENT_BATCH_FLUSH_MS: 1000,
                USAGE_EVENT_PROJECTION_BATCH_SIZE: 100
            }
        })).toMatchObject({
            appendBatchSize: 500,
            streamReadBatchSize: 250,
            projectionBatchSize: 75,
            flushMs: 0
        });
    });

    test('uses the legacy batch size as the stream read fallback', () => {
        expect(resolveRuntimeBatchConfig({
            env: { USAGE_EVENT_BATCH_SIZE: '500' },
            config: { USAGE_EVENT_BATCH_SIZE: 100 }
        })).toMatchObject({
            appendBatchSize: 500,
            streamReadBatchSize: 500,
            projectionBatchSize: 500
        });
    });

    test('clamps invalid values without changing the configured defaults', () => {
        expect(resolveRuntimeBatchConfig({
            env: {
                USAGE_EVENT_BATCH_SIZE: '-1',
                USAGE_EVENT_BATCH_FLUSH_MS: '-4',
                USAGE_EVENT_INGEST_QUEUE_MAX: '0'
            },
            config: {}
        })).toMatchObject({
            appendBatchSize: 100,
            flushMs: 1000,
            queueMax: 1000
        });

        expect(resolveRuntimeBatchConfig({
            env: { USAGE_EVENT_INGEST_QUEUE_MAX: '50000' },
            config: { USAGE_EVENT_BATCH_SIZE: 500 }
        }).queueMax).toBe(10000);
    });

    test('rejects zero values that would create infinite Redis blocking or hot status polling', () => {
        expect(resolveRuntimeBatchConfig({
            env: {
                USAGE_EVENT_BATCH_WAIT_MS: '0',
                USAGE_EVENT_STATUS_POLL_MS: '0',
                USAGE_EVENT_CLAIM_INTERVAL_MS: '0'
            },
            config: {}
        })).toMatchObject({
            waitMs: 1000,
            statusPollMs: 1000,
            claimIntervalMs: 5000
        });
    });

    test('caps every Redis and projection batch size at the bounded maximum', () => {
        expect(resolveRuntimeBatchConfig({
            env: {
                USAGE_EVENT_BATCH_SIZE: '50000',
                USAGE_EVENT_STREAM_READ_BATCH_SIZE: '40000',
                USAGE_EVENT_PROJECTION_BATCH_SIZE: '30000'
            },
            config: {}
        })).toMatchObject({
            appendBatchSize: 10000,
            streamReadBatchSize: 10000,
            projectionBatchSize: 10000,
            queueMax: 10000
        });
    });

    test('caps timing values so Redis BLOCK and Node timers remain bounded', () => {
        expect(resolveRuntimeBatchConfig({
            env: {
                USAGE_EVENT_BATCH_WAIT_MS: '999999999',
                USAGE_EVENT_BATCH_FLUSH_MS: '999999999',
                USAGE_EVENT_STATUS_POLL_MS: '999999999',
                USAGE_EVENT_CLAIM_INTERVAL_MS: '9999999999'
            },
            config: {}
        })).toMatchObject({
            waitMs: 60000,
            flushMs: 60000,
            statusPollMs: 60000,
            claimIntervalMs: 86400000
        });
    });
});
