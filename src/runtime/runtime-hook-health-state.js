export class RuntimeHookHealthState {
    constructor({ failureThreshold = 3 } = {}) {
        this.failureThreshold = Math.max(1, Number(failureThreshold) || 1);
        this.consecutiveFailures = 0;
        this.lastError = null;
        this.lastSuccessAt = null;
        this.snapshot = { pending: 0, consumerLag: 0 };
    }

    recordFailure(error) {
        this.consecutiveFailures += 1;
        this.lastError = error?.message || String(error);
        return {
            ...this.snapshot,
            available: this.consecutiveFailures < this.failureThreshold,
            consecutiveFailures: this.consecutiveFailures,
            error: this.lastError,
            lastSuccessAt: this.lastSuccessAt
        };
    }

    recordSuccess(snapshot = {}) {
        this.consecutiveFailures = 0;
        this.lastError = null;
        this.lastSuccessAt = new Date().toISOString();
        this.snapshot = { ...snapshot };
        return {
            ...this.snapshot,
            available: true,
            consecutiveFailures: 0,
            error: null,
            lastSuccessAt: this.lastSuccessAt
        };
    }

    recordSnapshot(snapshot = {}) {
        if (snapshot?.available === false) return this.recordFailure(snapshot.error || 'runtime hook unavailable');
        return this.recordSuccess(snapshot);
    }
}
