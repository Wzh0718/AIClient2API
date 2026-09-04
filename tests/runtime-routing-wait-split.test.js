import requestContext, { accumulateRoutingWait, computeSelectionStages, readRoutingWaits } from '../src/utils/context.js';
import { RuntimeMetrics } from '../src/runtime/runtime-metrics.js';

const emptyWaits = {
    keyQueueWaitMs: 0,
    credentialLeaseWaitMs: 0,
    elasticQueueWaitMs: 0,
    availabilityRefreshMs: 0,
    elasticAttemptCount: 0
};

describe('routing wait split', () => {
    test('accumulates key queue and credential lease waits per request', () => {
        requestContext.run({ requestId: 'split-a' }, () => {
            accumulateRoutingWait('keyQueueWaitMs', 1200);
            accumulateRoutingWait('keyQueueWaitMs', 300);
            accumulateRoutingWait('credentialLeaseWaitMs', 2000);
            expect(readRoutingWaits()).toEqual({
                ...emptyWaits,
                keyQueueWaitMs: 1500,
                credentialLeaseWaitMs: 2000
            });
        });
    });

    test('keeps each request isolated and defaults to zero outside a request', () => {
        requestContext.run({ requestId: 'split-b' }, () => {
            accumulateRoutingWait('keyQueueWaitMs', 50);
        });
        requestContext.run({ requestId: 'split-c' }, () => {
            expect(readRoutingWaits()).toEqual(emptyWaits);
        });
        expect(readRoutingWaits()).toEqual(emptyWaits);
    });

    test('subtracts elastic queue wait and availability refresh from selectionComputeMs', () => {
        requestContext.run({ requestId: 'split-elastic' }, () => {
            accumulateRoutingWait('keyQueueWaitMs', 100);
            accumulateRoutingWait('credentialLeaseWaitMs', 200);
            accumulateRoutingWait('elasticQueueWaitMs', 4000);
            accumulateRoutingWait('availabilityRefreshMs', 50);
            accumulateRoutingWait('elasticAttemptCount', 3);
            const stages = computeSelectionStages(5300);
            expect(stages).toEqual({
                providerFilterMs: 5300,
                keyQueueWaitMs: 100,
                credentialLeaseWaitMs: 200,
                elasticQueueWaitMs: 4000,
                availabilityRefreshMs: 50,
                elasticAttemptCount: 3,
                selectionComputeMs: 950
            });
            expect(stages.providerFilterMs).toBe(
                stages.keyQueueWaitMs
                + stages.credentialLeaseWaitMs
                + stages.elasticQueueWaitMs
                + stages.availabilityRefreshMs
                + stages.selectionComputeMs
            );
        });
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
