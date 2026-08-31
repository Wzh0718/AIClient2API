import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { applyProviderRateLimitCooldown } from '../src/utils/common.js';

function create429({ body = {}, retryAfter = null } = {}) {
    const error = new Error(body?.error?.message || 'Too Many Requests');
    error.response = { status: 429, data: body };
    if (retryAfter !== null) error.response.headers = { 'retry-after': String(retryAfter) };
    return error;
}

afterEach(() => jest.restoreAllMocks());

describe('Codex rate-limit cooldown', () => {
    test('uses credential + quota bucket cooldown for ordinary 429 with a 3 second default', () => {
        const now = Date.parse('2026-08-10T08:00:00Z');
        jest.spyOn(Date, 'now').mockReturnValue(now);
        const manager = {
            markCodexRateLimitCooldown: jest.fn(),
            markProviderUnhealthyWithRecoveryTime: jest.fn(),
            markCodexQuotaBucketUnhealthy: jest.fn()
        };

        const applied = applyProviderRateLimitCooldown({
            error: create429(),
            config: { RATE_LIMIT_COOLDOWN_ENABLED: true },
            providerPoolManager: manager,
            providerType: 'openai-codex-oauth',
            providerUuid: 'cred-1',
            requestedModel: 'gpt-5.4-mini'
        });

        expect(applied).toBe(true);
        expect(manager.markCodexRateLimitCooldown).toHaveBeenCalledWith(
            'openai-codex-oauth',
            { uuid: 'cred-1' },
            'general',
            expect.stringContaining('429'),
            new Date(now + 3000)
        );
        expect(manager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
        expect(manager.markCodexQuotaBucketUnhealthy).not.toHaveBeenCalled();
    });

    test('uses upstream Retry-After for ordinary 429', () => {
        const now = Date.parse('2026-08-10T08:00:00Z');
        jest.spyOn(Date, 'now').mockReturnValue(now);
        const manager = { markCodexRateLimitCooldown: jest.fn() };

        applyProviderRateLimitCooldown({
            error: create429({ retryAfter: 9 }),
            config: { RATE_LIMIT_COOLDOWN_ENABLED: true },
            providerPoolManager: manager,
            providerType: 'openai-codex-oauth',
            providerUuid: 'cred-1',
            requestedModel: 'gpt-5.4-mini'
        });

        expect(manager.markCodexRateLimitCooldown).toHaveBeenCalledWith(
            'openai-codex-oauth', { uuid: 'cred-1' }, 'general', expect.any(String), new Date(now + 9000)
        );
    });

    test('keeps the upstream 429 when cooldown state writing hits the persisted string bug', () => {
        const now = Date.parse('2026-08-10T08:00:00Z');
        jest.spyOn(Date, 'now').mockReturnValue(now);
        const manager = {
            markCodexRateLimitCooldown: jest.fn(() => {
                throw new TypeError("Cannot create property 'general' on string '[object Object]'");
            }),
            markProviderUnhealthyWithRecoveryTime: jest.fn(),
            markCodexQuotaBucketUnhealthy: jest.fn()
        };

        expect(() => applyProviderRateLimitCooldown({
            error: create429({ retryAfter: 3 }),
            config: { RATE_LIMIT_COOLDOWN_ENABLED: true },
            providerPoolManager: manager,
            providerType: 'openai-codex-oauth',
            providerUuid: 'cred-1',
            requestedModel: 'gpt-5.4-mini'
        })).not.toThrow();
    });

    test('normalizes persisted quota health strings before writing a bucket state', () => {
        const manager = {
            _findProvider: jest.fn(() => ({ config: { uuid: 'cred-1', codexQuotaHealth: '{}' } })),
            _log: jest.fn(),
            _debouncedSave: jest.fn()
        };

        manager.markCodexQuotaBucketUnhealthy = function (providerType, providerConfig, bucket) {
            const provider = this._findProvider(providerType, providerConfig.uuid);
            let health = provider.config.codexQuotaHealth;
            if (!health || typeof health !== 'object' || Array.isArray(health)) {
                try { health = JSON.parse(health); } catch { health = {}; }
                if (!health || typeof health !== 'object' || Array.isArray(health)) health = {};
                provider.config.codexQuotaHealth = health;
            }
            health[bucket] = { isHealthy: false };
        };

        expect(() => manager.markCodexQuotaBucketUnhealthy('openai-codex-oauth', { uuid: 'cred-1' }, 'general')).not.toThrow();
    });

    test('keeps usage_limit_reached on the quota exhaustion path', () => {
        const now = Date.parse('2026-08-10T08:00:00Z');
        jest.spyOn(Date, 'now').mockReturnValue(now);
        const manager = {
            markCodexRateLimitCooldown: jest.fn(),
            markCodexQuotaBucketUnhealthy: jest.fn()
        };
        const error = create429({ body: { error: { type: 'usage_limit_reached', message: 'usage limit has been reached' } } });

        applyProviderRateLimitCooldown({
            error,
            config: { RATE_LIMIT_COOLDOWN_ENABLED: true },
            providerPoolManager: manager,
            providerType: 'openai-codex-oauth',
            providerUuid: 'cred-1',
            requestedModel: 'gpt-5.3-codex-spark'
        });

        expect(manager.markCodexQuotaBucketUnhealthy).toHaveBeenCalled();
        expect(manager.markCodexRateLimitCooldown).not.toHaveBeenCalled();
    });

    test('persists Codex quota exhaustion until reset even when generic 429 cooldown is disabled', () => {
        const now = Date.parse('2026-08-10T08:00:00Z');
        jest.spyOn(Date, 'now').mockReturnValue(now);
        const manager = {
            markCodexRateLimitCooldown: jest.fn(),
            markCodexQuotaBucketUnhealthy: jest.fn()
        };
        const error = create429({
            body: {
                error: {
                    type: 'usage_limit_reached',
                    message: 'The usage limit has been reached',
                    resets_in_seconds: 4481
                }
            }
        });

        applyProviderRateLimitCooldown({
            error,
            config: { RATE_LIMIT_COOLDOWN_ENABLED: false },
            providerPoolManager: manager,
            providerType: 'openai-codex-oauth',
            providerUuid: 'cred-1',
            requestedModel: 'gpt-5.5'
        });

        expect(manager.markCodexQuotaBucketUnhealthy).toHaveBeenCalledWith(
            'openai-codex-oauth',
            { uuid: 'cred-1' },
            'general',
            expect.stringContaining('quota'),
            new Date(now + 4481 * 1000)
        );
        expect(manager.markCodexRateLimitCooldown).not.toHaveBeenCalled();
    });
});
