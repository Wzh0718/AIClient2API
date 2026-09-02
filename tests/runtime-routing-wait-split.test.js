import requestContext, { accumulateRoutingWait, readRoutingWaits } from '../src/utils/context.js';
import { RuntimeMetrics } from '../src/runtime/runtime-metrics.js';

describe('routing wait split', () => {
    test('accumulates key queue and credential lease waits per request', () => {
        requestContext.run({ requestId: 'split-a' }, () => {
            accumulateRoutingWait('keyQueueWaitMs', 1200);
            accumulateRoutingWait('keyQueueWaitMs', 300);
            accumulateRoutingWait('credentialLeaseWaitMs', 2000);
            expect(readRoutingWaits()).toEqual({ keyQueueWaitMs: 1500, credentialLeaseWaitMs: 2000 });
        });
    });

    test('keeps each request isolated and defaults to zero outside a request', () => {
        requestContext.run({ requestId: 'split-b' }, () => {
            accumulateRoutingWait('keyQueueWaitMs', 50);
        });
        requestContext.run({ requestId: 'split-c' }, () => {
            expect(readRoutingWaits()).toEqual({ keyQueueWaitMs: 0, credentialLeaseWaitMs: 0 });
        });
        expect(readRoutingWaits()).toEqual({ keyQueueWaitMs: 0, credentialLeaseWaitMs: 0 });
    });

    test('reports the queue and compute segments of provider filtering', () => {
        const metrics = new RuntimeMetrics({ sampleRate: 0 });
        const request = metrics.beginRequest({ workerId: 'execution-1' });
        request.recordStage('providerFilterMs', 6000);
        request.recordStage('keyQueueWaitMs', 5200);
        request.recordStage('selectionComputeMs', 100);
        request.recordStage('redisLeaseMs', 700);

        const stages = metrics.snapshot().stages;
        expect(stages.keyQueueWaitMs.p95).toBe(5200);
        expect(stages.selectionComputeMs.p95).toBe(100);
        expect(stages.redisLeaseMs.p95).toBe(700);
    });
});
