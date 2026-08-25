import {
    appendQuotaSnapshot,
    estimateCurrentPeriodQuota,
    estimateWeeklyQuotaFromSnapshots,
    getWeeklyQuotaWindow,
    getWeeklyQuotaPercent,
    getWeeklyQuotaResetAt,
    sumAccountTimelineCost
} from '../src/services/codex-weekly-estimate.js';

describe('Codex weekly quota estimation', () => {
    test('derives the active weekly period from reset time and official duration', () => {
        expect(getWeeklyQuotaWindow([
            {
                id: 'primary_window',
                windowKind: 'weekly',
                durationSeconds: 604800,
                resetAt: '2026-08-27T03:34:03.000Z'
            }
        ])).toMatchObject({
            resetAt: '2026-08-27T03:34:03.000Z',
            periodStart: '2026-08-20T03:34:03.000Z',
            durationSeconds: 604800
        });
    });

    test('falls back to a seven day duration for a weekly item', () => {
        expect(getWeeklyQuotaWindow([
            {
                id: 'secondary_window',
                windowKind: 'weekly',
                resetAt: '2026-08-27T03:34:03.000Z'
            }
        ])).toMatchObject({
            periodStart: '2026-08-20T03:34:03.000Z',
            durationSeconds: 604800
        });
    });

    test('estimates weekly and four-week monthly quota from current-period cost', () => {
        const result = estimateCurrentPeriodQuota({
            observedAt: '2026-08-23T03:00:00.000Z',
            periodStart: '2026-08-20T03:34:03.000Z',
            resetAt: '2026-08-27T03:34:03.000Z',
            usedPercent: 13,
            periodCostUsd: 773.27328936,
            granularity: 'hour'
        });

        expect(result).toMatchObject({
            status: 'estimated',
            estimatedWeeklyUsd: 5948.26,
            estimatedMonthlyUsd: 23793.04,
            periodCostUsd: 773.27,
            usedPercent: 13,
            method: 'current-period-extrapolation',
            granularity: 'hour'
        });
        expect(result.lowerBoundUsd).toBeLessThan(result.estimatedWeeklyUsd);
        expect(result.upperBoundUsd).toBeGreaterThan(result.estimatedWeeklyUsd);
    });

    test('does not estimate at zero percent', () => {
        expect(estimateCurrentPeriodQuota({
            observedAt: '2026-08-23T03:00:00.000Z',
            periodStart: '2026-08-20T03:34:03.000Z',
            resetAt: '2026-08-27T03:34:03.000Z',
            usedPercent: 0,
            periodCostUsd: 100
        })).toMatchObject({ status: 'insufficient-data' });
    });

    test('treats a fully exhausted weekly quota as a determined current-period total', () => {
        const result = estimateCurrentPeriodQuota({
            observedAt: '2026-08-23T03:00:00.000Z',
            periodStart: '2026-08-20T03:34:03.000Z',
            resetAt: '2026-08-27T03:34:03.000Z',
            usedPercent: 100,
            periodCostUsd: 100
        });

        expect(result).toMatchObject({
            status: 'exhausted',
            estimatedWeeklyUsd: 100,
            estimatedMonthlyUsd: 400,
            confidence: 'high',
            method: 'exhausted-period-total'
        });
    });

    test('does not invent a determined amount when an exhausted quota has no local cost', () => {
        expect(estimateCurrentPeriodQuota({
            observedAt: '2026-08-23T03:00:00.000Z',
            periodStart: '2026-08-20T03:34:03.000Z',
            resetAt: '2026-08-27T03:34:03.000Z',
            usedPercent: 100,
            periodCostUsd: 0
        })).toMatchObject({
            status: 'exhausted',
            estimatedWeeklyUsd: null,
            estimatedMonthlyUsd: null,
            method: 'exhausted-period-total'
        });
    });

    test('sums only account timeline buckets that overlap the active period', () => {
        const result = sumAccountTimelineCost({
            '2026-08-19': { summary: { cost: { usd: 1000 } }, hours: {} },
            '2026-08-20': {
                summary: { cost: { usd: 240 } },
                hours: {
                    '02': { cost: { usd: 10 } },
                    '03': { cost: { usd: 20 } },
                    '04': { cost: { usd: 30 } }
                }
            },
            '2026-08-21': { summary: { cost: { usd: 400 } }, hours: {} },
            '2026-08-23': {
                summary: { cost: { usd: 90 } },
                hours: {
                    '01': { cost: { usd: 10 } },
                    '02': { cost: { usd: 20 } },
                    '03': { cost: { usd: 30 } }
                }
            }
        }, '2026-08-20T03:34:03+08:00', '2026-08-23T03:00:00+08:00');

        expect(result).toMatchObject({ costUsd: 480, granularity: 'hour' });
    });

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

    test('selects weekly reset time from the weekly window before legacy secondary window', () => {
        expect(getWeeklyQuotaResetAt([
            { id: 'primary_window', percent: 12, label: 'Weekly Limit', windowKind: 'weekly', resetAt: '2026-08-27T03:34:03.000Z' },
            { id: 'secondary_window', percent: 12, label: 'legacy', resetAt: '2026-08-20T03:34:03.000Z' }
        ], '2026-08-28T00:00:00.000Z')).toBe('2026-08-27T03:34:03.000Z');
    });

    test('falls back to summary reset time when the weekly item omits reset time', () => {
        expect(getWeeklyQuotaResetAt([
            { id: 'primary_window', percent: 12, label: 'Weekly Limit', windowKind: 'weekly', resetAt: null }
        ], '2026-08-27T03:34:03.000Z')).toBe('2026-08-27T03:34:03.000Z');
    });

    test('folds repeated quota snapshots into one effective sample', () => {
        const first = appendQuotaSnapshot([], {
            observedAt: '2026-08-21T12:00:00.000Z',
            resetAt: '2026-08-27T03:00:00.000Z',
            usedPercent: 12,
            costUsd: 200
        });
        const repeated = appendQuotaSnapshot(first, {
            observedAt: '2026-08-21T13:00:00.000Z',
            resetAt: '2026-08-27T03:00:00.000Z',
            usedPercent: 12,
            costUsd: 200
        });

        expect(repeated).toHaveLength(1);
        expect(repeated[0].observedAt).toBe('2026-08-21T13:00:00.000Z');
    });

    test('deduplicates repeated snapshots before single-sample estimation', () => {
        const result = estimateWeeklyQuotaFromSnapshots([
            { observedAt: '2026-08-21T12:00:00.000Z', resetAt: '2026-08-27T03:00:00.000Z', usedPercent: 12, costUsd: 200 },
            { observedAt: '2026-08-21T13:00:00.000Z', resetAt: '2026-08-27T03:00:00.000Z', usedPercent: 12, costUsd: 200 }
        ]);

        expect(result).toMatchObject({
            status: 'estimated',
            estimatedUsd: 1666.67,
            sampleCount: 1,
            method: 'single-sample-period-extrapolation'
        });
    });
});
