import {
    estimateWeeklyQuotaFromSnapshots,
    getWeeklyQuotaPercent
} from '../src/services/codex-weekly-estimate.js';

describe('Codex weekly quota estimation', () => {
    test('estimates quota from local cost delta and weekly percent delta', () => {
        const result = estimateWeeklyQuotaFromSnapshots([
            { observedAt: '2026-08-20T12:00:00.000Z', resetAt: '2026-08-27T03:00:00.000Z', usedPercent: 1, costUsd: 100 },
            { observedAt: '2026-08-21T12:00:00.000Z', resetAt: '2026-08-27T03:00:00.000Z', usedPercent: 2, costUsd: 300 }
        ]);

        expect(result).toMatchObject({
            status: 'estimated',
            estimatedUsd: 20000,
            sampleCount: 1
        });
    });

    test('does not calculate a delta across a reset window', () => {
        const result = estimateWeeklyQuotaFromSnapshots([
            { observedAt: '2026-08-20T12:00:00.000Z', resetAt: '2026-08-20T13:00:00.000Z', usedPercent: 90, costUsd: 900 },
            { observedAt: '2026-08-21T12:00:00.000Z', resetAt: '2026-08-27T03:00:00.000Z', usedPercent: 2, costUsd: 1100 }
        ]);

        expect(result).toMatchObject({ status: 'insufficient-data', sampleCount: 0 });
    });

    test('reports insufficient data when the official percentage does not change', () => {
        const result = estimateWeeklyQuotaFromSnapshots([
            { observedAt: '2026-08-20T12:00:00.000Z', resetAt: '2026-08-27T03:00:00.000Z', usedPercent: 1, costUsd: 100 },
            { observedAt: '2026-08-21T12:00:00.000Z', resetAt: '2026-08-27T03:00:00.000Z', usedPercent: 1, costUsd: 199 }
        ]);

        expect(result).toMatchObject({ status: 'insufficient-data', sampleCount: 0 });
    });

    test('estimates weekly quota from one cumulative reset-window snapshot', () => {
        const result = estimateWeeklyQuotaFromSnapshots([
            { observedAt: '2026-08-21T12:00:00.000Z', resetAt: '2026-08-27T03:00:00.000Z', usedPercent: 1, costUsd: 200 }
        ]);

        expect(result).toMatchObject({
            status: 'estimated',
            estimatedUsd: 20000,
            sampleCount: 1,
            confidence: 'low',
            method: 'single-sample-period-extrapolation'
        });
    });

    test('does not extrapolate a single snapshot without usable period evidence', () => {
        expect(estimateWeeklyQuotaFromSnapshots([
            { observedAt: '2026-08-21T12:00:00.000Z', resetAt: '2026-08-27T03:00:00.000Z', usedPercent: 0, costUsd: 200 }
        ])).toMatchObject({ status: 'insufficient-data', sampleCount: 0 });

        expect(estimateWeeklyQuotaFromSnapshots([
            { observedAt: '2026-08-21T12:00:00.000Z', resetAt: null, usedPercent: 1, costUsd: 200 }
        ])).toMatchObject({ status: 'insufficient-data', sampleCount: 0 });
    });

    test('selects the weekly quota item without confusing the five-hour window', () => {
        expect(getWeeklyQuotaPercent([
            { id: 'primary_window', percent: 50, label: 'Request Quota (5h)' },
            { id: 'secondary_window', percent: 8, label: 'Weekly Limit' }
        ])).toBe(8);
    });
});
