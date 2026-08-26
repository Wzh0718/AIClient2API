import { jest } from '@jest/globals';
import {
    PotluckKeyConcurrencyLimiter,
    createKeyConcurrencyError
} from '../src/plugins/api-potluck/key-concurrency-limiter.js';

describe('PotluckKeyConcurrencyLimiter', () => {
    test('queues until a key slot is released, then admits the oldest waiter', async () => {
        const limiter = new PotluckKeyConcurrencyLimiter();
        const first = await limiter.acquire('batch', { maxConcurrency: 1, queueLimit: 1, queueTimeoutMs: 1000 });
        let admitted = false;
        const second = limiter.acquire('batch', { maxConcurrency: 1, queueLimit: 1, queueTimeoutMs: 1000 })
            .then(lease => { admitted = true; return lease; });

        await Promise.resolve();
        expect(admitted).toBe(false);
        await first.release();
        const secondLease = await second;
        expect(admitted).toBe(true);
        await secondLease.release();
    });

    test('rejects when the bounded queue is full with a diagnosable 429', async () => {
        const limiter = new PotluckKeyConcurrencyLimiter();
        const first = await limiter.acquire('batch', { maxConcurrency: 1, queueLimit: 1, queueTimeoutMs: 1000 });
        const waiting = limiter.acquire('batch', { maxConcurrency: 1, queueLimit: 1, queueTimeoutMs: 1000 });
        await expect(limiter.acquire('batch', { maxConcurrency: 1, queueLimit: 1, queueTimeoutMs: 1000 }))
            .rejects.toMatchObject({ status: 429, code: 'POTLUCK_KEY_CONCURRENCY_LIMIT', details: { reason: 'key_capacity_exhausted' } });
        await first.release();
        await (await waiting).release();
    });

    test('supports shadow mode without blocking while reporting the theoretical limit', async () => {
        const onEvent = jest.fn();
        const limiter = new PotluckKeyConcurrencyLimiter({ onEvent });
        const first = await limiter.acquire('batch', { maxConcurrency: 1, queueLimit: 0, mode: 'enforce' });
        const shadow = await limiter.acquire('batch', { maxConcurrency: 1, queueLimit: 0, mode: 'shadow' });
        expect(shadow.shadow).toBe(true);
        expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'key_capacity_exhausted', keyId: 'batch' }));
        await first.release();
    });
});

test('createKeyConcurrencyError returns a stable 429 contract', () => {
    expect(createKeyConcurrencyError('batch', 'key_queue_timeout')).toMatchObject({
        status: 429,
        code: 'POTLUCK_KEY_CONCURRENCY_LIMIT',
        details: { keyId: 'batch', reason: 'key_queue_timeout' }
    });
});
