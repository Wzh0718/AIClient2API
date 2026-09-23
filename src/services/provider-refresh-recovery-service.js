import logger from '../utils/logger.js';

export const PROVIDER_REFRESH_RECOVERY_INTERVAL_MS = 60 * 1000;

export class ProviderRefreshRecoveryService {
    constructor(providerPoolManager, log = logger) {
        this.providerPoolManager = providerPoolManager;
        this.log = log;
        this.timer = null;
    }

    start() {
        if (this.timer) return this;
        this.timer = setInterval(() => {
            try {
                const result = this.providerPoolManager.sweepStuckNeedsRefresh();
                if (result?.skippedQueued || result?.skippedFenceRetry) {
                    this.log.warn(`[Provider Refresh Recovery] Deferred stale credentials: queued=${result.skippedQueued || 0}, fenceRetry=${result.skippedFenceRetry || 0}`);
                }
            } catch (error) {
                this.log.error(`[Provider Refresh Recovery] Sweep failed: ${error.message}`);
            }
        }, PROVIDER_REFRESH_RECOVERY_INTERVAL_MS);
        this.timer.unref?.();
        this.log.info(`[Provider Refresh Recovery] Scheduled every ${PROVIDER_REFRESH_RECOVERY_INTERVAL_MS}ms`);
        return this;
    }

    stop() {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
        this.log.info('[Provider Refresh Recovery] Timer stopped');
    }
}

export function startProviderRefreshRecoveryService(providerPoolManager) {
    return new ProviderRefreshRecoveryService(providerPoolManager).start();
}
