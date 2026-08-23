import { describe, expect, jest, test } from '@jest/globals';

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn()
}));

jest.mock('../src/providers/adapter.js', () => ({
    serviceInstances: {}
}));

import { formatAntigravityUsage } from '../src/services/usage-service.js';

describe('Antigravity usage formatting', () => {
    test('shows UNKNOWN instead of FREE when tier discovery is unavailable', () => {
        const formatted = formatAntigravityUsage({
            account: 'user@example.com',
            models: {}
        });

        expect(formatted.summary.plan).toBe('UNKNOWN');
    });

    test('collapses models with the same quota fingerprint into one shared quota item', () => {
        const formatted = formatAntigravityUsage({
            tierId: 'Antigravity Starter Quota(free)',
            account: 'user@example.com',
            models: {
                'gemini-2.5-flash': {
                    quotaInfo: { remainingFraction: 0.75, resetTime: '2026-08-11T01:00:00Z' }
                },
                'gemini-3.1-flash-image': {
                    quotaInfo: { remainingFraction: 0.75, resetTime: '2026-08-11T01:00:00Z' }
                },
                'claude-sonnet-4-6': {
                    quotaInfo: { remainingFraction: 0.5, resetTime: '2026-08-12T01:00:00Z' }
                }
            }
        });

        expect(formatted.items).toHaveLength(2);
        expect(formatted.items[0]).toMatchObject({
            label: 'Shared quota (2 models)',
            percent: 25,
            modelIds: ['gemini-2.5-flash', 'gemini-3.1-flash-image'],
            source: 'fetchAvailableModels',
            authoritative: false,
            quotaRelation: 'shared-pool'
        });
        expect(formatted.items[1]).toMatchObject({
            label: 'gemini-claude-sonnet-4-6',
            percent: 50,
            modelIds: ['gemini-claude-sonnet-4-6'],
            quotaRelation: 'model-observed'
        });
        expect(formatted.summary.usedPercent).toBe(37.5);
        expect(formatted.summary.plan).toBe('Quota(free)');
    });

    test('adds authoritative 5h and weekly remaining quota items from quota groups', () => {
        const formatted = formatAntigravityUsage({
            tierId: 'Antigravity Pro',
            account: 'user@example.com',
            models: {
                'gemini-3-flash': {
                    quotaInfo: { remainingFraction: 0.8, resetTime: '2026-08-06T22:00:00Z' }
                }
            },
            quotaGroups: [
                {
                    displayName: 'Gemini Models',
                    buckets: [
                        {
                            bucketId: 'gemini-weekly',
                            displayName: 'Weekly Limit Remaining',
                            window: 'weekly',
                            remainingFraction: 0.9,
                            resetTime: '2026-08-11T04:53:25Z'
                        },
                        {
                            bucketId: 'gemini-5h',
                            displayName: 'Five Hour Limit Remaining',
                            window: '5h',
                            remainingFraction: 0.75,
                            resetTime: '2026-08-06T22:01:21Z'
                        }
                    ]
                },
                {
                    displayName: 'Claude and GPT models',
                    buckets: [
                        {
                            bucketId: '3p-weekly',
                            displayName: 'Weekly Limit Remaining',
                            window: 'weekly',
                            remainingFraction: 1,
                            resetTime: '2026-08-13T17:01:21Z'
                        }
                    ]
                }
            ]
        });

        const authoritativeItems = formatted.items.filter(item => item.source === 'retrieveUserQuotaSummary');
        expect(authoritativeItems).toHaveLength(3);
        expect(formatted.summary).toMatchObject({
            label: 'Gemini · Weekly Limit',
            usedPercent: 10,
            resetAt: '2026-08-11T04:53:25.000Z'
        });
        expect(authoritativeItems).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'quota-group:gemini-5h',
                label: 'Gemini · 5h Limit',
                percent: 25,
                remainingPercent: 75,
                displayValue: '25.0%',
                windowKind: 'short',
                resetAt: '2026-08-06T22:01:21.000Z',
                authoritative: true,
                quotaRelation: 'official-bucket'
            }),
            expect.objectContaining({
                id: 'quota-group:gemini-weekly',
                label: 'Gemini · Weekly Limit',
                percent: 10,
                remainingPercent: 90,
                displayValue: '10.0%',
                windowKind: 'weekly'
            }),
            expect.objectContaining({
                id: 'quota-group:3p-weekly',
                label: 'Claude + GPT · Weekly Limit',
                percent: 0,
                remainingPercent: 100,
                displayValue: '0.0%',
                windowKind: 'weekly'
            })
        ]));
        expect(formatted.items.some(item => item.id === 'gemini-3-flash')).toBe(true);
    });
});
