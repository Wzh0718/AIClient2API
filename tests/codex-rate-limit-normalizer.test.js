import { describe, expect, test } from '@jest/globals';
import {
    classifyCodexWindow,
    getCodexQuotaApplicability,
    normalizeCodexRateLimitWindows
} from '../src/utils/codex-rate-limit.js';

describe('Codex rate-limit window normalization', () => {
    test('classifies windows from their duration instead of source slot', () => {
        expect(classifyCodexWindow({ limit_window_seconds: 18000 })).toMatchObject({
            windowKind: 'short',
            durationSeconds: 18000
        });
        expect(classifyCodexWindow({ limitWindowSeconds: 604800 })).toMatchObject({
            windowKind: 'weekly',
            durationSeconds: 604800
        });
    });

    test('normalizes a weekly-only primary window as weekly', () => {
        const windows = normalizeCodexRateLimitWindows({
            rate_limit: {
                primary_window: {
                    used_percent: 3,
                    limit_window_seconds: 604800,
                    reset_at: 1784487507
                }
            }
        });

        expect(windows).toEqual([
            expect.objectContaining({
                id: 'primary_window',
                sourceWindow: 'primary_window',
                windowKind: 'weekly',
                durationSeconds: 604800,
                usedPercent: 3,
                scope: 'general'
            })
        ]);
    });

    test('marks a Pro weekly-only general quota as not applicable for 5h', () => {
        expect(getCodexQuotaApplicability({
            plan_type: 'PRO',
            rate_limit: {
                primary_window: { used_percent: 92, limit_window_seconds: 604800 }
            }
        })).toMatchObject({
            general: {
                short: { status: 'not_applicable' },
                weekly: { status: 'healthy' }
            }
        });
    });

    test('marks a Plus weekly-only general quota as unknown for 5h', () => {
        expect(getCodexQuotaApplicability({
            plan_type: 'PLUS',
            rate_limit: {
                primary_window: { used_percent: 92, limit_window_seconds: 604800 }
            }
        })).toMatchObject({
            general: {
                short: { status: 'unknown' },
                weekly: { status: 'healthy' }
            }
        });
    });

    test('keeps Spark model windows separate from general windows', () => {
        const result = getCodexQuotaApplicability({
            plan_type: 'PRO',
            rate_limit: {
                primary_window: { used_percent: 92, limit_window_seconds: 604800 }
            },
            additional_rate_limits: [{
                limit_name: 'GPT-5.3-Codex-Spark',
                rate_limit: {
                    primary_window: { used_percent: 100, limit_window_seconds: 18000 },
                    secondary_window: { used_percent: 80, limit_window_seconds: 604800 }
                }
            }]
        });

        expect(result).toMatchObject({
            general: { short: { status: 'not_applicable' } },
            codex53: {
                short: { status: 'healthy' },
                weekly: { status: 'healthy' }
            }
        });
    });

    test('does not infer a 5h window when duration is missing', () => {
        expect(getCodexQuotaApplicability({
            plan_type: 'PRO',
            rate_limit: {
                primary_window: { used_percent: 92 }
            }
        })).toMatchObject({
            general: {
                short: { status: 'unknown' },
                weekly: { status: 'unknown' }
            }
        });
    });
});
