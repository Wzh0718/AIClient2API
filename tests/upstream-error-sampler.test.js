import { describe, expect, test } from '@jest/globals';
import { UpstreamErrorLogSampler } from '../src/utils/upstream-error-sampler.js';

describe('UpstreamErrorLogSampler', () => {
    test('logs the first transient error and suppresses duplicates until summary interval', () => {
        let now = 0;
        const sampler = new UpstreamErrorLogSampler({ windowMs: 30_000, summaryIntervalMs: 60_000, now: () => now });
        const event = { scope: 'Server', providerType: 'gemini-antigravity', model: 'gemini-3.1-flash-lite', status: 429 };

        expect(sampler.record(event)).toMatchObject({ log: true, summary: false, count: 1 });
        now = 1_000;
        expect(sampler.record(event)).toMatchObject({ log: false, summary: false, count: 2 });
        now = 60_000;
        expect(sampler.record(event)).toMatchObject({ log: true, summary: true, count: 3 });
    });

    test('does not suppress non-transient errors', () => {
        const sampler = new UpstreamErrorLogSampler({ now: () => 0 });
        const event = { scope: 'Server', providerType: 'gemini-antigravity', model: 'gemini-3.1-flash-lite', status: 400 };

        expect(sampler.record(event)).toMatchObject({ log: true, summary: false, count: 1 });
        expect(sampler.record(event)).toMatchObject({ log: true, summary: false, count: 1 });
    });
});
