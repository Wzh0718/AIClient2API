import {
    createCredentialManifest,
    fingerprintCredentialManifest
} from '../src/runtime/credential-manifest.js';
import { RuntimeMetrics } from '../src/runtime/runtime-metrics.js';
import { aggregateWorkerMetrics, shutdownWorkerStages } from '../src/runtime/multi-worker-runtime.js';
import { Readable } from 'stream';
import requestContext from '../src/utils/context.js';
import { getRequestBody } from '../src/utils/common.js';

describe('runtime observability baseline', () => {
    test('credential manifest excludes secrets while preserving scheduling inputs', () => {
        const pools = {
            'gemini-antigravity': [{
                uuid: 'ag-1',
                isDisabled: false,
                supportedModels: ['gemini-3.1-flash-image'],
                concurrencyLimit: 3,
                queueLimit: 2,
                accessToken: 'secret-token',
                refreshToken: 'secret-refresh',
                proxy: 'socks5://user:pass@example.test:1080'
            }]
        };

        const manifest = createCredentialManifest(pools);

        expect(manifest).toEqual([{
            providerType: 'gemini-antigravity',
            uuid: 'ag-1',
            enabled: true,
            supportedModels: ['gemini-3.1-flash-image'],
            notSupportedModels: [],
            concurrencyLimit: 3,
            queueLimit: 2,
            weight: 1
        }]);
        expect(JSON.stringify(manifest)).not.toMatch(/secret|proxy|pass/i);
        expect(fingerprintCredentialManifest(manifest)).toMatch(/^[a-f0-9]{64}$/);
    });

    test('manifest fingerprint is stable across provider and model ordering', () => {
        const first = createCredentialManifest({
            b: [{ uuid: '2', supportedModels: ['z', 'a'] }],
            a: [{ uuid: '1' }]
        });
        const second = createCredentialManifest({
            a: [{ uuid: '1' }],
            b: [{ uuid: '2', supportedModels: ['a', 'z'] }]
        });

        expect(fingerprintCredentialManifest(first)).toBe(fingerprintCredentialManifest(second));
    });

    test('runtime metrics report request stages and process pressure without payloads', () => {
        let now = 100;
        const eventLoopDelay = {
            max: 25_000_000,
            percentile: value => value === 95 ? 12_000_000 : 20_000_000,
            enable: jest.fn(),
            reset: jest.fn()
        };
        const metrics = new RuntimeMetrics({
            now: () => now,
            eventLoopDelay,
            sampleProcess: () => ({ rss: 1000, heapUsed: 500, eventLoopUtilization: 0.25 })
        });
        const request = metrics.beginRequest({ workerId: 'execution-1', kind: 'image' });
        now = 112;
        request.mark('bodyParsed');
        now = 127;
        request.mark('leaseAcquired');
        now = 160;
        request.mark('firstByte');
        request.addOutputBytes(4096);
        request.addBackpressureMs(7);
        now = 190;
        request.end({ statusCode: 200 });

        const snapshot = metrics.snapshot();
        expect(snapshot.requests.total).toBe(1);
        expect(snapshot.requests.byWorker['execution-1']).toBe(1);
        expect(snapshot.requests.byKind.image).toBe(1);
        expect(snapshot.stages.bodyParsed.p95).toBe(12);
        expect(snapshot.stages.leaseAcquired.p95).toBe(27);
        expect(snapshot.stages.firstByte.p95).toBe(60);
        expect(snapshot.output.bytes).toBe(4096);
        expect(snapshot.output.backpressureMs).toBe(7);
        expect(snapshot.process.rss).toBe(1000);
        expect(snapshot.process.eventLoopDelay).toEqual({ p95: 12, p99: 20, max: 25 });
        expect(eventLoopDelay.reset).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(snapshot)).not.toContain('requestBody');
    });

    test('request body parsing marks the active runtime request without retaining the body', async () => {
        const marks = [];
        const body = JSON.stringify({ ok: true });
        const req = Readable.from([Buffer.from(body)]);
        req.headers = { 'content-length': String(Buffer.byteLength(body)) };
        const parsed = requestContext.run({ runtimeRequest: { mark: name => marks.push(name) } }, async () => {
            const promise = getRequestBody(req, { maxBytes: 1024 });
            return promise;
        });

        await expect(parsed).resolves.toEqual({ ok: true });
        expect(marks).toContain('bodyParsed');
    });

    test('aggregates worker request distribution and pressure without payloads', () => {
        const snapshots = new Map([
            ['execution-1', {
                requests: { total: 5, success: 4, failed: 1, byWorker: { 'execution-1': 5 }, byKind: { model: 3, image: 2 } },
                output: { bytes: 100, backpressureMs: 7 },
                inFlight: 2,
                process: { rss: 1000, heapUsed: 500, eventLoopUtilization: 0.2, eventLoopDelay: { p95: 12, p99: 20, max: 25 } }
            }],
            ['execution-2', {
                requests: { total: 7, success: 7, failed: 0, byWorker: { 'execution-2': 7 }, byKind: { model: 7 } },
                output: { bytes: 200, backpressureMs: 3 },
                inFlight: 1,
                process: { rss: 1200, heapUsed: 600, eventLoopUtilization: 0.3, eventLoopDelay: { p95: 15, p99: 22, max: 30 } }
            }]
        ]);

        expect(aggregateWorkerMetrics(snapshots)).toEqual({
            requests: { total: 12, success: 11, failed: 1, byWorker: { 'execution-1': 5, 'execution-2': 7 }, byKind: { model: 10, image: 2 } },
            output: { bytes: 300, backpressureMs: 10 },
            hooks: { pending: 0, spooled: 0, spoolBytes: 0, dropped: 0, backpressured: 0, consumerLag: 0, oldestPendingAgeMs: 0, available: true, unavailableWorkers: [], byWorker: {} },
            inFlight: 3,
            process: { rss: 2200, heapUsed: 1100, maxEventLoopUtilization: 0.3, eventLoopDelay: { p95: 15, p99: 22, max: 30 } },
            providerCoordination: {
                byWorker: {},
                geminiScheduling: {
                    cooldownWrites: 0,
                    probeAcquired: 0,
                    probeRejected: 0,
                    rateLimited: 0,
                    retryAttempts: 0,
                    fallbacks: 0,
                    byModel: {}
                }
            }
        });
        expect(JSON.stringify(aggregateWorkerMetrics(snapshots))).not.toMatch(/prompt|imageData|credential/i);
    });

    test('sums Gemini scheduling counters while taking the maximum shared-state gauges', () => {
        const snapshots = new Map([
            ['execution-1', { providerCoordination: { geminiScheduling: {
                cooldownWrites: 1,
                probeAcquired: 1,
                probeRejected: 0,
                rateLimited: 1,
                retryAttempts: 2,
                fallbacks: 1,
                byModel: { 'gemini-2.5-flash': { schedulable: 2, cooling: 1, quotaUnknown: 1 } }
            } } }],
            ['execution-2', { providerCoordination: { geminiScheduling: {
                cooldownWrites: 0,
                probeAcquired: 0,
                probeRejected: 1,
                rateLimited: 0,
                retryAttempts: 1,
                fallbacks: 0,
                byModel: { 'gemini-2.5-flash': { schedulable: 2, cooling: 1, quotaUnknown: 1 } }
            } } }]
        ]);

        expect(aggregateWorkerMetrics(snapshots).providerCoordination.geminiScheduling).toEqual({
            cooldownWrites: 1,
            probeAcquired: 1,
            probeRejected: 1,
            rateLimited: 1,
            retryAttempts: 3,
            fallbacks: 1,
            byModel: { 'gemini-2.5-flash': { schedulable: 2, cooling: 1, quotaUnknown: 1 } }
        });
    });

    test('aggregates durable hook backlog and dropped counters', () => {
        const snapshots = new Map([
            ['execution-1', { hooks: { pending: 2, spooled: 3, spoolBytes: 400, dropped: 0, backpressured: 1, oldestPendingAgeMs: 1200 } }],
            ['execution-2', { hooks: { pending: 1, spooled: 0, spoolBytes: 0, dropped: 0, backpressured: 2, oldestPendingAgeMs: 800 } }],
            ['control-1', { hooks: { pending: 4, consumerLag: 5, dropped: 0, oldestPendingAgeMs: 2000 } }]
        ]);

        expect(aggregateWorkerMetrics(snapshots).hooks).toEqual({
            pending: 7,
            spooled: 3,
            spoolBytes: 400,
            dropped: 0,
            backpressured: 3,
            consumerLag: 5,
            oldestPendingAgeMs: 2000,
            available: true,
            unavailableWorkers: [],
            byWorker: {
                'execution-1': snapshots.get('execution-1').hooks,
                'execution-2': snapshots.get('execution-2').hooks,
                'control-1': snapshots.get('control-1').hooks
            }
        });
    });

    test('aggregates unavailable durable hook transports for degraded health', () => {
        const snapshots = new Map([
            ['control-1', { hooks: { available: false, error: 'Redis connection timeout' } }],
            ['execution-1', { hooks: { available: true } }]
        ]);

        expect(aggregateWorkerMetrics(snapshots).hooks).toMatchObject({
            available: false,
            unavailableWorkers: ['control-1']
        });
    });

    test('shutdown drains execution hooks before stopping control', async () => {
        const order = [];
        let backlog = 2;
        await shutdownWorkerStages({
            closeProxy: async () => order.push('proxy'),
            stopRole: async role => {
                order.push(role);
                if (role === 'execution') backlog = 0;
            },
            getBacklog: () => backlog,
            wait: async () => {},
            drainTimeoutMs: 100
        });
        expect(order).toEqual(['proxy', 'execution', 'control']);
    });
});
