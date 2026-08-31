import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { getCodexRetryDelayMs, hasCodexRetryBudget, shouldRetryCodex429 } from '../src/providers/openai/codex-retry-policy.js';
import { getCachedModelList, clearModelListCache } from '../src/services/model-list-cache.js';

afterEach(() => jest.restoreAllMocks());

describe('Codex retry protection', () => {
    test('retries upstream 429 using Retry-After instead of immediately surfacing it', () => {
        const error = { response: { status: 429, headers: { 'retry-after': '3' } } };

        expect(shouldRetryCodex429(error, { attempts: 0, maxAttempts: 2 })).toBe(true);
        expect(getCodexRetryDelayMs(error, { fallbackMs: 800, maxDelayMs: 10000 })).toBe(3000);
    });

    test('stops retrying after the per-credential budget is exhausted', () => {
        const error = { response: { status: 429 } };

        expect(shouldRetryCodex429(error, { attempts: 2, maxAttempts: 2 })).toBe(false);
    });

    test('does not retry non-429 responses', () => {
        expect(shouldRetryCodex429({ response: { status: 500 } }, { attempts: 0, maxAttempts: 2 })).toBe(false);
    });

    test('stops the retry chain when the unified total duration budget is exhausted', () => {
        expect(hasCodexRetryBudget({ startedAt: 1000, now: 31001, maxDurationMs: 30000 })).toBe(false);
        expect(hasCodexRetryBudget({ startedAt: 1000, now: 29999, maxDurationMs: 30000 })).toBe(true);
    });

    test('coalesces concurrent model list fetches and reuses the short-lived result', async () => {
        clearModelListCache();
        let calls = 0;
        const loader = async () => {
            calls += 1;
            await new Promise(resolve => setTimeout(resolve, 5));
            return { data: [{ id: 'gpt-5.5' }] };
        };

        const [first, second] = await Promise.all([
            getCachedModelList('openai-codex-oauth:openai', loader, { ttlMs: 1000 }),
            getCachedModelList('openai-codex-oauth:openai', loader, { ttlMs: 1000 })
        ]);

        expect(calls).toBe(1);
        expect(second).toEqual(first);
        await getCachedModelList('openai-codex-oauth:openai', loader, { ttlMs: 1000 });
        expect(calls).toBe(1);
    });
});
