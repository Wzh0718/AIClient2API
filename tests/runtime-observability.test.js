import {
    createCredentialManifest,
    fingerprintCredentialManifest
} from '../src/runtime/credential-manifest.js';
import { RuntimeMetrics } from '../src/runtime/runtime-metrics.js';
import {
    aggregateWorkerMetrics,
    resolveRuntimeHealthStatus,
    shutdownWorkerStages
} from '../src/runtime/multi-worker-runtime.js';
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
        request.recordStage('providerFilterMs', 8);
        metrics.recordStage('redisLeaseMs', 3);
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
        expect(snapshot.stages.providerFilterMs.p95).toBe(8);
        expect(snapshot.stages.redisLeaseMs.p95).toBe(3);
        expect(snapshot.stages.identityPersistLockWaitMs).toEqual({ count: 0, p50: 0, p95: 0, p99: 0, max: 0 });
        expect(snapshot.output.bytes).toBe(4096);
        expect(snapshot.output.backpressureMs).toBe(7);
        expect(snapshot.process.rss).toBe(1000);
        expect(snapshot.process.eventLoopDelay).toEqual({ p95: 12, p99: 20, max: 25 });
        expect(eventLoopDelay.reset).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(snapshot)).not.toContain('requestBody');
    });

    test('emits a sampled request profile with safe metadata and stage timings', () => {
        let now = 100;
        const profiles = [];
        const metrics = new RuntimeMetrics({
            now: () => now,
            eventLoopDelay: { enable: jest.fn(), reset: jest.fn(), percentile: () => 0, max: 0 },
            sampleRate: 1,
            slowRequestMs: 1000,
            random: () => 0,
            onProfile: profile => profiles.push(profile)
        });

        const request = metrics.beginRequest({
            workerId: 'execution-1',
            kind: 'model',
            metadata: {
                method: 'POST',
                path: '/v1/chat/completions',
                model: 'gpt-5.5',
                providerType: 'openai-codex-oauth',
                stream: true,
                requestBodyBytes: 512
            }
        });
        request.recordStage('requestConvertMs', 12);
        request.addOutputBytes(2048);
        now = 160;
        const profile = request.end({ statusCode: 200 });

        expect(profile).toMatchObject({
            workerId: 'execution-1',
            kind: 'model',
            statusCode: 200,
            durationMs: 60,
            metadata: {
                method: 'POST',
                path: '/v1/chat/completions',
                model: 'gpt-5.5',
                providerType: 'openai-codex-oauth',
                stream: true,
                requestBodyBytes: 512
            },
            outputBytes: 2048,
            stages: { requestConvertMs: 12 }
        });
        expect(profiles).toHaveLength(1);
        expect(JSON.stringify(profile)).not.toMatch(/prompt|imageData|apiKey|token|cookie|rawBody/i);
    });

    test('emits only slow requests when sampling is disabled', () => {
        let now = 0;
        const profiles = [];
        const metrics = new RuntimeMetrics({
            now: () => now,
            eventLoopDelay: { enable: jest.fn(), reset: jest.fn(), percentile: () => 0, max: 0 },
            sampleRate: 0,
            slowRequestMs: 50,
            random: () => 0.99,
            onProfile: profile => profiles.push(profile)
        });

        metrics.beginRequest({ metadata: { method: 'GET', path: '/health' } }).end({ statusCode: 200 });
        now = 100;
        const slowRequest = metrics.beginRequest({ metadata: { method: 'POST', path: '/v1/responses' } });
        now = 200;
        slowRequest.end({ statusCode: 500 });

        expect(profiles).toHaveLength(1);
        expect(profiles[0]).toMatchObject({ statusCode: 500, durationMs: 100 });
    });

    test('diagnostic callback failures do not affect request completion', () => {
        let now = 0;
        const metrics = new RuntimeMetrics({
            now: () => now,
            eventLoopDelay: { enable: jest.fn(), reset: jest.fn(), percentile: () => 0, max: 0 },
            sampleRate: 1,
            onProfile: () => { throw new Error('logging failed'); }
        });
        const request = metrics.beginRequest();
        now = 10;

        expect(() => request.end({ statusCode: 200 })).not.toThrow();
        expect(metrics.snapshot().requests.total).toBe(1);
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
            stages: { byWorker: {} },
            output: { bytes: 300, backpressureMs: 10 },
            hooks: { pending: 0, spooled: 0, spoolBytes: 0, dropped: 0, backpressured: 0, consumerLag: 0, oldestPendingAgeMs: 0, available: true, unavailableWorkers: [], byWorker: {} },
            inFlight: 3,
            process: { rss: 2200, heapUsed: 1100, maxEventLoopUtilization: 0.3, eventLoopDelay: { p95: 15, p99: 22, max: 30 } },
            imageCapacity: {
                activeBytes: 0,
                queued: 0,
                globalUsedBytes: 0,
                globalBudgetBytes: 0,
                overcommitted: 0,
                coordinationFailures: 0,
                redisDegraded: false,
                byWorker: {}
            },
            pricingDiagnostics: {
                estimatedAverageCount: 0,
                estimatedAverageTokens: 0,
                estimatedAverageUsd: 0,
                missingPriceCount: 0,
                missingPriceTokens: 0,
                lastEstimatedAt: null,
                lastMissingAt: null,
                byWorker: {}
            },
            temporaryRouting: {
                scheduledBypasses: 0,
                calendarDegraded: false,
                missingCalendarYears: [],
                byWorker: {}
            },
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
            },
            requestAudit: {
                runs: 0,
                failures: 0,
                skippedRuns: 0,
                lastRunMs: 0,
                lastScannedFiles: 0,
                lastScannedBytes: 0,
                lastEventCount: 0,
                lastCompletedAt: null,
                activeWorkers: [],
                byWorker: {}
            }
        });
        expect(JSON.stringify(aggregateWorkerMetrics(snapshots))).not.toMatch(/prompt|imageData|credential/i);
    });

    test('aggregates scheduled routing bypasses and missing workday calendar years', () => {
        const snapshots = new Map([
            ['execution-1', { temporaryRouting: {
                scheduledBypasses: 3,
                calendarDegraded: true,
                missingCalendarYears: [2027]
            } }],
            ['execution-2', { temporaryRouting: {
                scheduledBypasses: 2,
                calendarDegraded: true,
                missingCalendarYears: [2027, 2028]
            } }]
        ]);

        expect(aggregateWorkerMetrics(snapshots).temporaryRouting).toEqual({
            scheduledBypasses: 5,
            calendarDegraded: true,
            missingCalendarYears: [2027, 2028],
            byWorker: {
                'execution-1': expect.any(Object),
                'execution-2': expect.any(Object)
            }
        });
    });

    test('marks runtime health degraded when the statutory calendar is missing', () => {
        expect(resolveRuntimeHealthStatus({ topologyReady: false, metrics: {} })).toBe('starting');
        expect(resolveRuntimeHealthStatus({
            topologyReady: true,
            metrics: { hooks: { available: true }, temporaryRouting: { calendarDegraded: true } }
        })).toBe('degraded');
        expect(resolveRuntimeHealthStatus({
            topologyReady: true,
            metrics: { hooks: { available: true }, temporaryRouting: { calendarDegraded: false } }
        })).toBe('healthy');
    });

    test('exposes request stage latency by worker and as a conservative aggregate', () => {
        const snapshots = new Map([
            ['execution-1', { stages: {
                providerFilterMs: { count: 2, p50: 5, p95: 10, p99: 12, max: 14 }
            } }],
            ['execution-2', { stages: {
                providerFilterMs: { count: 1, p50: 7, p95: 12, p99: 15, max: 18 },
                redisLeaseMs: { count: 1, p50: 3, p95: 3, p99: 3, max: 3 }
            } }]
        ]);

        expect(aggregateWorkerMetrics(snapshots).stages).toEqual({
            providerFilterMs: { count: 3, p50: 7, p95: 12, p99: 15, max: 18 },
            redisLeaseMs: { count: 1, p50: 3, p95: 3, p99: 3, max: 3 },
            byWorker: {
                'execution-1': snapshots.get('execution-1').stages,
                'execution-2': snapshots.get('execution-2').stages
            }
        });
    });

    test('aggregates pricing anomaly diagnostics across workers', () => {
        const snapshots = new Map([
            ['control-1', { pricingDiagnostics: {
                estimatedAverageCount: 2,
                estimatedAverageTokens: 300,
                estimatedAverageUsd: 1.25,
                missingPriceCount: 1,
                missingPriceTokens: 50,
                lastEstimatedAt: '2026-08-18T01:00:00.000Z'
            } }],
            ['execution-1', { pricingDiagnostics: {
                estimatedAverageCount: 1,
                estimatedAverageTokens: 100,
                estimatedAverageUsd: 0.5,
                missingPriceCount: 0,
                missingPriceTokens: 0,
                lastEstimatedAt: '2026-08-18T02:00:00.000Z'
            } }]
        ]);

        expect(aggregateWorkerMetrics(snapshots).pricingDiagnostics).toMatchObject({
            estimatedAverageCount: 3,
            estimatedAverageTokens: 400,
            estimatedAverageUsd: 1.75,
            missingPriceCount: 1,
            missingPriceTokens: 50,
            lastEstimatedAt: '2026-08-18T02:00:00.000Z'
        });
    });

    test('aggregates request audit analyzer cost without exposing audit rows', () => {
        const snapshots = new Map([
            ['control-1', { requestAudit: {
                runs: 4,
                failures: 1,
                skippedRuns: 2,
                active: true,
                lastRunMs: 120,
                lastScannedFiles: 2,
                lastScannedBytes: 4096,
                lastEventCount: 500,
                lastCompletedAt: '2026-08-24T09:00:00.000Z'
            } }],
            ['execution-1', { requestAudit: {
                runs: 3,
                failures: 0,
                skippedRuns: 0,
                active: false,
                lastRunMs: 80,
                lastScannedFiles: 1,
                lastScannedBytes: 1024,
                lastEventCount: 100,
                lastCompletedAt: '2026-08-24T09:01:00.000Z'
            } }]
        ]);

        expect(aggregateWorkerMetrics(snapshots).requestAudit).toEqual({
            runs: 7,
            failures: 1,
            skippedRuns: 2,
            lastRunMs: 120,
            lastScannedFiles: 3,
            lastScannedBytes: 5120,
            lastEventCount: 600,
            lastCompletedAt: '2026-08-24T09:01:00.000Z',
            activeWorkers: ['control-1'],
            byWorker: {
                'control-1': snapshots.get('control-1').requestAudit,
                'execution-1': snapshots.get('execution-1').requestAudit
            }
        });
        expect(JSON.stringify(aggregateWorkerMetrics(snapshots).requestAudit)).not.toMatch(/requestId|prompt|keyHash/i);
    });

    test('aggregates local image pressure while taking the maximum shared Redis usage', () => {
        const snapshots = new Map([
            ['execution-1', { imageCapacity: {
                activeBytes: 100,
                queued: 2,
                globalUsedBytes: 300,
                globalBudgetBytes: 400,
                overcommitted: 1,
                coordinationFailures: 0,
                redisDegraded: false
            } }],
            ['execution-2', { imageCapacity: {
                activeBytes: 80,
                queued: 1,
                globalUsedBytes: 300,
                globalBudgetBytes: 400,
                overcommitted: 0,
                coordinationFailures: 2,
                redisDegraded: true
            } }]
        ]);

        expect(aggregateWorkerMetrics(snapshots).imageCapacity).toMatchObject({
            activeBytes: 180,
            queued: 3,
            globalUsedBytes: 300,
            globalBudgetBytes: 400,
            overcommitted: 1,
            coordinationFailures: 2,
            redisDegraded: true,
            byWorker: {
                'execution-1': snapshots.get('execution-1').imageCapacity,
                'execution-2': snapshots.get('execution-2').imageCapacity
            }
        });
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
