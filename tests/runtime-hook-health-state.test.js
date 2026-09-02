import { RuntimeHookHealthState } from '../src/runtime/runtime-hook-health-state.js';

describe('RuntimeHookHealthState', () => {
    test('keeps transient Redis failures healthy and degrades after threshold', () => {
        const state = new RuntimeHookHealthState({ failureThreshold: 3 });

        expect(state.recordFailure('timeout')).toMatchObject({ available: true, consecutiveFailures: 1 });
        expect(state.recordFailure('timeout')).toMatchObject({ available: true, consecutiveFailures: 2 });
        expect(state.recordFailure('timeout')).toMatchObject({ available: false, consecutiveFailures: 3, error: 'timeout' });
    });

    test('clears degraded state after a successful poll', () => {
        const state = new RuntimeHookHealthState({ failureThreshold: 2 });
        state.recordFailure('timeout');
        state.recordFailure('timeout');

        expect(state.recordSuccess({ pending: 0, consumerLag: 0 })).toMatchObject({
            available: true,
            consecutiveFailures: 0,
            pending: 0,
            consumerLag: 0,
            error: null
        });
    });

    test('treats an unavailable status snapshot as a failure', () => {
        const state = new RuntimeHookHealthState({ failureThreshold: 2 });

        expect(state.recordSnapshot({ available: false, error: 'redis unavailable' })).toMatchObject({
            available: true,
            consecutiveFailures: 1,
            error: 'redis unavailable'
        });
        expect(state.recordSnapshot({ available: false, error: 'redis unavailable' })).toMatchObject({
            available: false,
            consecutiveFailures: 2
        });
    });
});
