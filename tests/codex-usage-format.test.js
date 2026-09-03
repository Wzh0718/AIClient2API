import { describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import { formatCodexUsage } from '../src/services/usage-service.js';

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn()
}));

jest.mock('../src/providers/adapter.js', () => ({
    serviceInstances: {}
}));

describe('Codex usage formatting', () => {
    const weeklyOnlyFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/codex-usage-weekly-only.json', import.meta.url), 'utf8'));

    function dateKey(offsetDays = 0) {
        const date = new Date();
        date.setUTCHours(12, 0, 0, 0);
        date.setUTCDate(date.getUTCDate() + offsetDays);
        return date.toISOString().slice(0, 10);
    }

    test('extracts daily weekly and cumulative token usage from official usage payload', () => {
        const formatted = formatCodexUsage({
            account: 'codex@example.com',
            plan_type: 'PRO',
            rate_limit: {
                primary_window: { used_percent: 25, reset_at: 1780000000 },
                secondary_window: { used_percent: 60, reset_at: 1780500000 }
            },
            token_usage: {
                daily: {
                    input_tokens: 1000,
                    cached_input_tokens: 400,
                    output_tokens: 200,
                    total_tokens: 1200
                },
                weekly: {
                    input_tokens: 8000,
                    cached_input_tokens: 3000,
                    output_tokens: 1000,
                    total_tokens: 9000
                },
                total: {
                    input_tokens: 50000,
                    cached_input_tokens: 20000,
                    output_tokens: 10000,
                    total_tokens: 60000
                }
            }
        });

        expect(formatted.summary.tokenUsage).toMatchObject({
            daily: { totalTokens: 1200, cachedTokens: 400 },
            weekly: { totalTokens: 9000, cachedTokens: 3000 },
            total: { totalTokens: 60000, cachedTokens: 20000 }
        });
        expect(formatted.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'daily_token_usage', label: 'Daily Tokens', used: 1200, unit: 'tokens', displayValue: '1.20k' }),
            expect.objectContaining({ id: 'weekly_token_usage', label: 'Weekly Tokens', used: 9000, unit: 'tokens', displayValue: '9.00k' }),
            expect.objectContaining({ id: 'total_token_usage', label: 'Total Tokens', used: 60000, unit: 'tokens', displayValue: '60.00k' })
        ]));
    });

    test('marks token usage unavailable when official Codex payload only returns quota windows', () => {
        const formatted = formatCodexUsage({
            account: 'codex@example.com',
            plan_type: 'PRO',
            rate_limit: {
                primary_window: { used_percent: 25, reset_at: 1780000000 },
                secondary_window: { used_percent: 60, reset_at: 1780500000 }
            }
        });

        expect(formatted.summary.tokenUsage).toBeNull();
        expect(formatted.summary.tokenUsageAvailable).toBe(false);
        expect(formatted.summary.tokenUsageUnavailableReason).toBe('official_usage_token_fields_missing');
        expect(formatted.items.map(item => item.id)).not.toContain('weekly_token_usage');
        expect(formatted.items.map(item => item.id)).not.toContain('total_token_usage');
    });

    test('preserves primary window reset time when usage is zero percent', () => {
        const formatted = formatCodexUsage({
            account: 'codex@example.com',
            plan_type: 'PRO',
            rate_limit: {
                primary_window: { used_percent: 0, reset_at: 1780000000 },
                secondary_window: { used_percent: 60, reset_at: 1780500000 }
            }
        });

        expect(formatted.items).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'primary_window',
                percent: 0,
                resetAt: new Date(1780000000 * 1000).toISOString()
            })
        ]));
    });

    test('uses the general weekly window as the Codex summary percent instead of the highest general window', () => {
        const formatted = formatCodexUsage({
            account: 'codex@example.com',
            plan_type: 'PRO',
            rate_limit: {
                primary_window: { used_percent: 91, reset_at: 1780000000 },
                secondary_window: { used_percent: 64, reset_at: 1780500000 }
            }
        });

        expect(formatted.summary.usedPercent).toBe(64);
        expect(formatted.summary.status).toBe('normal');
        expect(formatted.summary.resetAt).toBe(new Date(1780500000 * 1000).toISOString());
    });

    test('exposes quota applicability alongside formatted usage', () => {
        const formatted = formatCodexUsage({
            account: 'codex@example.com',
            plan_type: 'PRO',
            rate_limit: {
                primary_window: { used_percent: 92, limit_window_seconds: 604800 }
            }
        });

        expect(formatted.summary.quotaApplicability).toMatchObject({
            general: {
                short: { status: 'not_applicable' },
                weekly: { status: 'healthy' }
            }
        });
    });

    test('extracts account token usage from Codex CLI profile payload', () => {
        const formatted = formatCodexUsage({
            account: 'codex@example.com',
            plan_type: 'PRO',
            rate_limit: {
                primary_window: { used_percent: 25, reset_at: 1780000000 },
                secondary_window: { used_percent: 60, reset_at: 1780500000 }
            },
            token_usage_profile: {
                stats: {
                    lifetime_tokens: 123456,
                    daily_usage_buckets: [
                        { start_date: dateKey(), tokens: 1200 },
                        { start_date: dateKey(-1), tokens: 800 },
                        { start_date: dateKey(-6), tokens: 600 },
                        { start_date: dateKey(-8), tokens: 9000 }
                    ]
                }
            }
        });

        expect(formatted.summary.tokenUsage).toMatchObject({
            daily: { totalTokens: 1200 },
            weekly: { totalTokens: 2600 },
            total: { totalTokens: 123456 }
        });
        expect(formatted.summary.tokenUsageProfile.stats.lifetime_tokens).toBe(123456);
        expect(formatted.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'daily_token_usage', used: 1200, unit: 'tokens', displayValue: '1.20k' }),
            expect.objectContaining({ id: 'weekly_token_usage', used: 2600, unit: 'tokens', displayValue: '2.60k' }),
            expect.objectContaining({ id: 'total_token_usage', used: 123456, unit: 'tokens', displayValue: '123.46k' })
        ]));
    });

    test('formats large Codex token usage in billions', () => {
        const formatted = formatCodexUsage({
            account: 'codex@example.com',
            plan_type: 'PRO',
            token_usage: {
                daily: { total_tokens: 999000000 },
                weekly: { total_tokens: 1000000000 },
                total: { total_tokens: 7400433719 }
            }
        });

        expect(formatted.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'daily_token_usage', used: 999000000, displayValue: '999.00M' }),
            expect.objectContaining({ id: 'weekly_token_usage', used: 1000000000, displayValue: '1.00B' }),
            expect.objectContaining({ id: 'total_token_usage', used: 7400433719, displayValue: '7.40B' })
        ]));
    });

    test('keeps Codex Spark additional rate limits visible without counting them in total summary', () => {
        const formatted = formatCodexUsage({
            account: 'codex@example.com',
            plan_type: 'PRO',
            rate_limit: {
                primary_window: { used_percent: 25, reset_at: 1780000000 },
                secondary_window: { used_percent: 60, reset_at: 1780500000 }
            },
            additional_rate_limits: [
                {
                    limit_name: 'GPT-5.3-Codex-Spark',
                    metered_feature: 'codex_bengalfox',
                    rate_limit: {
                        primary_window: { used_percent: 91, reset_at: 1780100000 },
                        secondary_window: { used_percent: 64, reset_at: 1780600000 }
                    }
                }
            ]
        });

        expect(formatted.summary.usedPercent).toBe(60);
        expect(formatted.items).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'additional_gpt_5_3_codex_spark_primary_window',
                label: 'GPT-5.3-Codex-Spark (5h)',
                percent: 91
            }),
            expect.objectContaining({
                id: 'additional_gpt_5_3_codex_spark_secondary_window',
                label: 'GPT-5.3-Codex-Spark (Weekly)',
                percent: 64
            })
        ]));
    });

    test('extracts available Codex rate limit reset credits from official usage payload', () => {
        const formatted = formatCodexUsage({
            account: 'codex@example.com',
            plan_type: 'PRO',
            rate_limit: {
                primary_window: { used_percent: 91, reset_at: 1780000000 },
                secondary_window: { used_percent: 64, reset_at: 1780500000 }
            },
            rate_limit_reset_credits: {
                available_count: 3
            }
        });

        expect(formatted.summary.rateLimitResetCredits).toEqual({
            availableCount: 3,
            canReset: true
        });
        expect(formatted.items).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'rate_limit_reset_credits',
                label: 'Rate Limit Resets',
                used: 3,
                unit: 'count',
                displayValue: '3 available'
            })
        ]));
    });

    test('extracts Codex rate limit reset credit expiration details for hover display', () => {
        const formatted = formatCodexUsage({
            account: 'codex@example.com',
            plan_type: 'PRO',
            rate_limit_reset_credits: {
                available_count: 2,
                credits: [
                    {
                        id: 'credit-full-id-should-not-be-required',
                        status: 'available',
                        title: 'Codex reset credit',
                        granted_at: '2026-07-02T02:12:48.211Z',
                        expires_at: '2026-07-09T02:12:48.211Z'
                    },
                    {
                        status: 'used',
                        title: 'Consumed reset credit',
                        granted_at: '2026-07-01T01:00:00.000Z',
                        expires_at: '2026-07-08T01:00:00.000Z'
                    }
                ]
            }
        });

        expect(formatted.summary.rateLimitResetCredits).toEqual({
            availableCount: 2,
            canReset: true,
            credits: [
                {
                    status: 'available',
                    title: 'Codex reset credit',
                    grantedAt: '2026-07-02T02:12:48.211Z',
                    expiresAt: '2026-07-09T02:12:48.211Z'
                },
                {
                    status: 'used',
                    title: 'Consumed reset credit',
                    grantedAt: '2026-07-01T01:00:00.000Z',
                    expiresAt: '2026-07-08T01:00:00.000Z'
                }
            ]
        });
        expect(JSON.stringify(formatted.summary.rateLimitResetCredits)).not.toContain('credit-full-id-should-not-be-required');
    });

    test('renders a weekly-only primary window from the live Codex schema without a fake 5h label', () => {
        const formatted = formatCodexUsage(weeklyOnlyFixture);

        expect(formatted.summary).toMatchObject({
            usedPercent: 3,
            label: 'Weekly Limit',
            windowKind: 'weekly'
        });
        expect(formatted.items).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'primary_window',
                label: 'Weekly Limit',
                windowKind: 'weekly',
                durationSeconds: 604800,
                percent: 3
            }),
            expect.objectContaining({
                id: 'additional_gpt_5_3_codex_spark_primary_window',
                label: 'GPT-5.3-Codex-Spark (Weekly)',
                windowKind: 'weekly',
                durationSeconds: 604800,
                percent: 48
            })
        ]));
        expect(formatted.items.filter(item => item.unit === 'percent').map(item => item.label).join(' ')).not.toContain('5h');
    });

    test('shows delayed daily profile telemetry as unavailable instead of exact zero', () => {
        jest.useFakeTimers().setSystemTime(new Date('2026-07-13T12:00:00Z'));
        try {
            const formatted = formatCodexUsage(weeklyOnlyFixture);
            const daily = formatted.items.find(item => item.id === 'daily_token_usage');
            const weekly = formatted.items.find(item => item.id === 'weekly_token_usage');

            expect(daily).toMatchObject({
                displayValue: '—',
                available: false,
                asOf: '2026-07-12',
                delayDays: 1,
                category: 'telemetry'
            });
            expect(weekly).toMatchObject({
                label: 'Weekly Tokens',
                used: 3382115315,
                displayValue: '3.38B',
                category: 'telemetry'
            });
        } finally {
            jest.useRealTimers();
        }
    });

    test('propagates the OpenAI profile generation timestamp to all token telemetry items', () => {
        const formatted = formatCodexUsage(weeklyOnlyFixture);
        const telemetry = formatted.items.filter(item => item.category === 'telemetry');

        expect(telemetry).toHaveLength(3);
        expect(telemetry.map(item => item.updatedAt)).toEqual([
            '2026-07-13T02:09:15.016Z',
            '2026-07-13T02:09:15.016Z',
            '2026-07-13T02:09:15.016Z'
        ]);
    });
});
