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

    test('uses coordination reservations to enforce queueLimit across workers', async () => {
        let active = 0;
        const reservations = new Set();
        const coordination = {
            async acquirePotluckKeyLease() {
                if (active >= 1) return { acquired: false, active };
                active += 1;
                const leaseId = `lease-${active}`;
                return { acquired: true, leaseId, release: async () => { active = Math.max(0, active - 1); } };
            },
            async reservePotluckKeyQueue(_keyId, { queueLimit }) {
                if (reservations.size >= queueLimit) return { reserved: false, waiting: reservations.size };
                const reservationId = `reservation-${reservations.size + 1}`;
                reservations.add(reservationId);
                return { reserved: true, reservationId };
            },
            async releasePotluckKeyQueueReservation(reservation) {
                reservations.delete(reservation.reservationId);
                return true;
            }
        };
        const firstWorker = new PotluckKeyConcurrencyLimiter();
        const secondWorker = new PotluckKeyConcurrencyLimiter();
        const first = await firstWorker.acquire('shared', { maxConcurrency: 1, queueLimit: 1, coordination });
        const waiting = secondWorker.acquire('shared', { maxConcurrency: 1, queueLimit: 1, queueTimeoutMs: 1000, coordination });
        await expect(firstWorker.acquire('shared', { maxConcurrency: 1, queueLimit: 1, coordination }))
            .rejects.toMatchObject({ details: { reason: 'key_capacity_exhausted' } });
        await first.release();
        await (await waiting).release();
        expect(reservations.size).toBe(0);
    });

    test('releases a distributed reservation when a waiter is cancelled', async () => {
        const reservations = new Set();
        const coordination = {
            async acquirePotluckKeyLease() { return { acquired: false, active: 1 }; },
            async reservePotluckKeyQueue() {
                const reservationId = 'cancelled';
                reservations.add(reservationId);
                return { reserved: true, reservationId };
            },
            async releasePotluckKeyQueueReservation(reservation) {
                reservations.delete(reservation.reservationId);
                return true;
            }
        };
        const controller = new AbortController();
        const pending = new PotluckKeyConcurrencyLimiter().acquire('shared', {
            maxConcurrency: 1,
            queueLimit: 1,
            queueTimeoutMs: 1000,
            coordination,
            signal: controller.signal
        });
        await Promise.resolve();
        controller.abort();
        await expect(pending).rejects.toMatchObject({ details: { reason: 'key_queue_cancelled' } });
        expect(reservations.size).toBe(0);
    });
});

test('createKeyConcurrencyError returns a stable 429 contract', () => {
    expect(createKeyConcurrencyError('batch', 'key_queue_timeout')).toMatchObject({
        status: 429,
        code: 'POTLUCK_KEY_CONCURRENCY_LIMIT',
        details: { keyId: 'batch', reason: 'key_queue_timeout' }
    });
});
