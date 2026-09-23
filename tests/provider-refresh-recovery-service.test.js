import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
    PROVIDER_REFRESH_RECOVERY_INTERVAL_MS,
    ProviderRefreshRecoveryService
} from '../src/services/provider-refresh-recovery-service.js';

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('ProviderRefreshRecoveryService', () => {
    test('sweeps every minute without depending on health-check configuration and stops cleanly', () => {
        const manager = { sweepStuckNeedsRefresh: jest.fn(() => ({ requeued: 0, skippedQueued: 0, skippedFenceRetry: 0 })) };
        const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        const service = new ProviderRefreshRecoveryService(manager, log).start();
        service.start();

        jest.advanceTimersByTime(PROVIDER_REFRESH_RECOVERY_INTERVAL_MS - 1);
        expect(manager.sweepStuckNeedsRefresh).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(manager.sweepStuckNeedsRefresh).toHaveBeenCalledTimes(1);

        service.stop();
        jest.advanceTimersByTime(PROVIDER_REFRESH_RECOVERY_INTERVAL_MS * 2);
        expect(manager.sweepStuckNeedsRefresh).toHaveBeenCalledTimes(1);
        expect(log.info).toHaveBeenCalledWith('[Provider Refresh Recovery] Timer stopped');
    });

    test('reports deferred queue ownership without clearing credential state', () => {
        const manager = { sweepStuckNeedsRefresh: jest.fn(() => ({ requeued: 0, skippedQueued: 2, skippedFenceRetry: 1 })) };
        const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        const service = new ProviderRefreshRecoveryService(manager, log).start();

        jest.advanceTimersByTime(PROVIDER_REFRESH_RECOVERY_INTERVAL_MS);

        expect(log.warn).toHaveBeenCalledWith('[Provider Refresh Recovery] Deferred stale credentials: queued=2, fenceRetry=1');
        service.stop();
    });

    test('logs one failed sweep and keeps the next tick scheduled', () => {
        const manager = { sweepStuckNeedsRefresh: jest.fn()
            .mockImplementationOnce(() => { throw new Error('temporary scan failure'); })
            .mockReturnValue({ requeued: 0, skippedQueued: 0, skippedFenceRetry: 0 }) };
        const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
        const service = new ProviderRefreshRecoveryService(manager, log).start();

        jest.advanceTimersByTime(PROVIDER_REFRESH_RECOVERY_INTERVAL_MS * 2);

        expect(manager.sweepStuckNeedsRefresh).toHaveBeenCalledTimes(2);
        expect(log.error).toHaveBeenCalledWith('[Provider Refresh Recovery] Sweep failed: temporary scan failure');
        service.stop();
    });
});
