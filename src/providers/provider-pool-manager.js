import * as fs from 'fs';
import path from 'path';
import { getServiceAdapter, getRegisteredProviders, invalidateServiceAdapter } from './adapter.js';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import { MODEL_PROVIDER, getProtocolPrefix } from '../utils/common.js';
import { withFileLock, atomicWriteFile } from '../utils/file-lock.js';
import { applyProviderConfigEvent, createProviderConfigEvent } from '../runtime/provider-config-event.js';
import { convertData } from '../convert/convert.js';

import {
    getConfiguredSupportedModels,
    getCustomModelListProvider,
    getProviderModels,
    normalizeModelIds
} from './provider-models.js';
import { broadcastEvent } from '../ui-modules/event-broadcast.js';
import { ENDPOINT_TYPE } from '../utils/common.js';
import {
    getCachedCodexUsageInstance,
    getCodexPlanStatusForProvider,
    readFreshUsageCacheSync
} from '../utils/codex-plan.js';
import { getCodexQuotaApplicability, normalizeCodexRateLimitWindows } from '../utils/codex-rate-limit.js';
import requestContext, { accumulateRoutingWait } from '../utils/context.js';
import { SmoothWeightedRoundRobin } from './smooth-weighted-round-robin.js';
import { performance } from 'node:perf_hooks';
import { createProviderStateEvent, applyProviderStateEvent } from '../runtime/provider-state-event.js';
import { matchesModelFamily } from './openai/codex-model-routing.js';
import { ANTIGRAVITY_ELASTIC_MODEL_ORDER, ANTIGRAVITY_ELASTIC_SOURCE_MODEL } from './antigravity-model-order.js';

const ANTIGRAVITY_ELASTIC_MODEL_FALLBACKS = Object.freeze(
    Object.fromEntries(ANTIGRAVITY_ELASTIC_MODEL_ORDER.map((model, index) => [
        model,
        ANTIGRAVITY_ELASTIC_MODEL_ORDER.slice(index + 1)
    ]))
);
// A 404 from upstream means the model does not exist at all, so the entry can
// live far longer than a quota cooldown. It is still bounded so an upstream
// rename or a newly granted tier recovers without an operator action.
const ANTIGRAVITY_AVAILABILITY_INVALIDATE_MIN_INTERVAL_MS = 200;
const ANTIGRAVITY_AVAILABILITY_SCOPE_CACHE_LIMIT = 256;
const ANTIGRAVITY_MODEL_NOT_FOUND_TTL_MS = 60 * 60 * 1000;
const ANTIGRAVITY_MODEL_NOT_FOUND_SYNC_INTERVAL_MS = 5000;
const ANTIGRAVITY_ELASTIC_DEFAULTS = Object.freeze({
    enabled: true,
    maxQueueWaitMs: 45_000,
    preferOriginalWaitMs: 10_000,
    fallbackModels: ANTIGRAVITY_ELASTIC_MODEL_ORDER,
    globalQueueLimit: 512,
    perKeyModelQueueLimit: 256,
    globalQueuedBytesLimit: 64 * 1024 * 1024,
    recoveryJitterMinMs: 50,
    recoveryJitterMaxMs: 250
});

function isCodexQuotaExhaustionMessage(value) {
    const message = String(value || '').toLowerCase();
    return message.includes('usage_limit_reached')
        || message.includes('insufficient_quota')
        || message.includes('usage limit has been reached');
}

export function getAntigravityElasticFallbackModels(requestedModel, configuredFallbacks = [], availableModels = []) {
    const canonicalRequestedModel = normalizeAntigravityQuotaModel(requestedModel);
    const allowedFallbacks = ANTIGRAVITY_ELASTIC_MODEL_FALLBACKS[canonicalRequestedModel] || [];
    const configured = Array.isArray(configuredFallbacks)
        ? configuredFallbacks.map(model => String(model || '').trim()).filter(Boolean)
        : [];
    const available = new Set(Array.isArray(availableModels) ? availableModels.map(normalizeAntigravityQuotaModel) : []);
    return allowedFallbacks
        .filter(model => configured.length === 0 || configured.includes(model))
        .filter(model => available.size === 0 || available.has(model));
}

function getConfiguredGeminiFallbackModels(globalConfig = {}) {
    const configured = globalConfig?.geminiModelFallbacks
        || globalConfig?.antigravityElasticRouting?.fallbackModels;
    return Array.isArray(configured) ? configured : ANTIGRAVITY_ELASTIC_DEFAULTS.fallbackModels;
}

function getAntigravityAvailableModels(providerStatuses = []) {
    return [...new Set(providerStatuses.flatMap(status => {
        const config = status?.config || status || {};
        return Array.isArray(config.availableModels)
            ? config.availableModels.map(normalizeAntigravityQuotaModel)
            : Array.isArray(config.supportedModels)
                ? config.supportedModels.map(normalizeAntigravityQuotaModel)
                : [];
    }).filter(Boolean))];
}

function positiveInteger(value, fallback, { allowZero = false } = {}) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) return fallback;
    return parsed;
}

function createGeminiRoutingError(message, code, status = 429, extras = {}) {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    Object.assign(error, extras);
    return error;
}

function getCustomModelAliasesForProvider(config, providerType) {
    const customModels = Array.isArray(config?.customModels) ? config.customModels : [];
    return new Set(
        customModels
            .filter(model => {
                const listProvider = getCustomModelListProvider(model);
                return model?.alias &&
                    model.alias !== model.id &&
                    listProvider &&
                    (listProvider === providerType || providerType.startsWith(listProvider + '-'));
            })
            .map(model => model.alias)
    );
}

function getCustomModelIdsForProvider(config, providerType) {
    const customModels = Array.isArray(config?.customModels) ? config.customModels : [];
    return customModels
        .filter(model => {
            const listProvider = getCustomModelListProvider(model);
            return model?.id &&
                listProvider &&
                (listProvider === providerType || providerType.startsWith(listProvider + '-'));
        })
        .map(model => model.id);
}

function stableHashToUnitInterval(value) {
    const hash = crypto.createHash('sha256').update(String(value)).digest();
    return (hash.readUInt32BE(0) + 1) / 0x100000001;
}

function isCodexProviderType(providerType) {
    return providerType === MODEL_PROVIDER.CODEX_API || providerType?.startsWith(`${MODEL_PROVIDER.CODEX_API}-`);
}

function isAntigravityProviderType(providerType) {
    return providerType === MODEL_PROVIDER.ANTIGRAVITY;
}

function isGeminiProviderType(providerType) {
    return providerType === MODEL_PROVIDER.GEMINI_CLI || providerType === MODEL_PROVIDER.ANTIGRAVITY;
}

function normalizeAntigravityPlan(plan) {
    const value = String(plan || '').trim();
    if (!value) return { plan: 'unknown', isFree: false };
    return {
        plan: value,
        isFree: /^(?:antigravity\s+)?(?:starter\s+)?quota\s*\(\s*free\s*\)$/i.test(value)
    };
}

function getAntigravityPlanStatusForProvider(providerType, uuid, usageCache, providerConfig = {}) {
    const providerCache = usageCache?.providers?.[providerType];
    const instance = Array.isArray(providerCache?.instances)
        ? providerCache.instances.find(entry => (entry?.uuid || entry?.config?.uuid || entry?.providerUuid) === uuid)
        : null;
    const usageCandidates = [
        instance?.usage?.summary?.plan,
        instance?.usage?.raw?.tierId,
        instance?.usage?.tierId
    ];
    for (const candidate of usageCandidates) {
        const normalized = normalizeAntigravityPlan(candidate);
        if (normalized.plan !== 'unknown') return { ...normalized, source: 'usage' };
    }
    const lastKnown = normalizeAntigravityPlan(providerConfig.lastKnownAntigravityPlan);
    return { ...lastKnown, source: lastKnown.plan === 'unknown' ? 'unknown' : 'last_known' };
}

function normalizeAntigravityQuotaModel(modelName) {
    let model = String(modelName || '').trim();
    if (model.startsWith(`${MODEL_PROVIDER.ANTIGRAVITY}:`)) {
        model = model.slice(`${MODEL_PROVIDER.ANTIGRAVITY}:`.length);
    }
    if (model.startsWith('models/')) model = model.slice('models/'.length);
    if (model.startsWith('gemini-claude-')) model = model.replace(/^gemini-/, '');
    return model;
}

function getActiveAntigravityQuotaState(state, now = Date.now()) {
    if (state?.isHealthy !== false) return null;
    const recoveryMs = Date.parse(state.scheduledRecoveryTime || '');
    if (Number.isFinite(recoveryMs) && now >= recoveryMs) return null;
    return state;
}

function getProviderWeight(config = {}) {
    const weight = Number(config.providerWeight ?? config.weight ?? 1);
    return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

function medianNumber(values = []) {
    const nums = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
    if (nums.length === 0) return 0;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

function hasCustomProviderWeights(providers) {
    return providers.some(provider => getProviderWeight(provider.config) !== 1);
}

function getProviderStableId(provider) {
    const type = provider.type || '';
    const uuid = provider.uuid || provider.config?.uuid || '';
    return `${type}:${uuid}`;
}

function normalizeImageRoundRobinModel(model) {
    let normalized = String(model || '').trim().toLowerCase();
    if (normalized.includes(':')) {
        normalized = normalized.split(':').slice(1).join(':');
    }
    return normalized.endsWith('-fast') ? normalized.slice(0, -5) : normalized;
}

function selectWeightedStickyProvider(providers, affinityScope) {
    if (!Array.isArray(providers) || providers.length === 0) return null;

    return providers
        .map(provider => {
            const weight = getProviderWeight(provider.config);
            const unit = stableHashToUnitInterval(`${affinityScope}:${getProviderStableId(provider)}`);
            return {
                provider,
                score: -Math.log(unit) / weight
            };
        })
        .sort((a, b) => {
            if (a.score !== b.score) return a.score - b.score;
            return getProviderStableId(a.provider).localeCompare(getProviderStableId(b.provider));
        })[0].provider;
}

function toStringArray(value) {
    if (Array.isArray(value)) {
        return value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim());
    }
    if (typeof value === 'string' && value.trim()) {
        return [value.trim()];
    }
    return [];
}

function globPatternToRegExp(pattern) {
    const escaped = String(pattern)
        .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
        .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
}

function modelMatchesAnyPattern(model, patterns) {
    if (!model || patterns.length === 0) return false;
    return patterns.some(pattern => globPatternToRegExp(pattern).test(model));
}

const CODEX_QUOTA_BUCKET = {
    GENERAL: 'general',
    CODEX_53: 'codex53'
};

const DEFAULT_CODEX_53_MODEL_PATTERNS = [
    '*5.3*',
    '*codexspark*',
    '*codex-spark*',
    '*codex_spark*'
];

const DEFAULT_CODEX_53_QUOTA_FALLBACK_MODEL = 'gpt-5.6-luna';

const DEFAULT_CODEX_STICKY_HOT_SHARD_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_CODEX_STICKY_HOT_SHARD_MIN_REQUESTS = 100;
const DEFAULT_CODEX_STICKY_HOT_SHARD_MAX_SHARDS = 5;
const DEFAULT_PROVIDER_SELECTION_SLOW_WARN_MS = 50;
const PROVIDER_SELECTION_LOAD_BUCKET_MS = 60 * 1000;
const PROVIDER_SELECTION_LOAD_MAX_WINDOW_MS = 60 * 60 * 1000;
const CODEX_HOT_KEY_BUCKET_MS = 10 * 1000;

function getPositivePercentLimit(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return Math.min(parsed, 100);
}

function getPercentLimit(value, fallback = null) {
    return getPositivePercentLimit(value) ?? fallback;
}

function getPositiveIntegerConfig(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.floor(parsed);
}

function isFalseConfigFlag(value) {
    return value === false || value === 0 || value === '0' || value === 'false';
}

function normalizePercentValue(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return null;
    }
    return Math.min(parsed, 100);
}

function getCachedCodexUsageForProvider(providerType, uuid, usageCache) {
    return getCachedCodexUsageInstance(providerType, uuid, usageCache)?.usage || null;
}

function getUsageItemPercent(usage, itemId) {
    const items = Array.isArray(usage?.items) ? usage.items : [];
    const item = items.find(entry => entry?.id === itemId || entry?.key === itemId || entry?.name === itemId);
    if (!item) return null;
    return normalizePercentValue(item.percent ?? item.usedPercent ?? item.used);
}

function getUsageItemPercentByMatcher(usage, matcher) {
    const items = Array.isArray(usage?.items) ? usage.items : [];
    const item = items.find(entry => matcher({
        id: String(entry?.id || entry?.key || entry?.name || '').toLowerCase(),
        label: String(entry?.label || '').toLowerCase(),
        windowKind: String(entry?.windowKind || '').toLowerCase(),
        scope: String(entry?.scope || '').toLowerCase(),
        entry
    }));
    if (!item) return null;
    return normalizePercentValue(item.percent ?? item.usedPercent ?? item.used);
}

function getRawRateLimitWindowPercent(rawUsage, windowId) {
    const desiredKind = windowId === 'primary_window' ? 'short' : 'weekly';
    const normalized = normalizeCodexRateLimitWindows(rawUsage || {});
    const semantic = normalized.find(window => window.scope === 'general' && window.windowKind === desiredKind);
    if (semantic) return normalizePercentValue(semantic.usedPercent);

    const rateLimit = rawUsage?.rate_limit || rawUsage?.rateLimit;
    const windowAliases = windowId === 'primary_window'
        ? ['primary_window', 'primaryWindow']
        : ['secondary_window', 'secondaryWindow'];

    for (const alias of windowAliases) {
        const window = rateLimit?.[alias];
        const percent = normalizePercentValue(window?.used_percent ?? window?.usedPercent ?? window?.percent ?? window?.used);
        if (percent !== null) return percent;
    }

    return null;
}

function resolveCodexQuotaBucket(requestedModel = null, patterns = DEFAULT_CODEX_53_MODEL_PATTERNS) {
    const model = String(requestedModel || '').trim();
    if (!model) return CODEX_QUOTA_BUCKET.GENERAL;
    const normalizedPatterns = toStringArray(patterns).map(pattern => pattern.toLowerCase());
    return modelMatchesAnyPattern(model.toLowerCase(), normalizedPatterns) ? CODEX_QUOTA_BUCKET.CODEX_53 : CODEX_QUOTA_BUCKET.GENERAL;
}

function getCodex53UsagePercent(usage, windowId) {
    const isPrimary = windowId === 'primary_window';
    const desiredKind = isPrimary ? 'short' : 'weekly';
    const windowNeedle = isPrimary ? 'primary_window' : 'secondary_window';
    const labelNeedle = isPrimary ? '5h' : 'weekly';
    const semanticPercent = getUsageItemPercentByMatcher(usage, ({ id, label, windowKind, scope }) =>
        windowKind === desiredKind &&
        (scope === 'model' || id.includes('additional')) &&
        (id.includes('gpt_5_3') || id.includes('codex_5_3') || label.includes('gpt-5.3'))
    );
    if (semanticPercent !== null) return semanticPercent;

    const rawWindows = normalizeCodexRateLimitWindows(usage?.raw || {});
    const rawSemantic = rawWindows.find(window =>
        window.scope === 'model' &&
        window.windowKind === desiredKind &&
        String(window.limitName || '').toLowerCase().includes('gpt-5.3')
    );
    if (rawSemantic) return normalizePercentValue(rawSemantic.usedPercent);
    const hasSemanticModelWindows = (Array.isArray(usage?.items) ? usage.items : []).some(entry => {
        const id = String(entry?.id || '').toLowerCase();
        const label = String(entry?.label || '').toLowerCase();
        return entry?.windowKind && (id.includes('gpt_5_3') || label.includes('gpt-5.3'));
    });
    if (hasSemanticModelWindows) return null;

    return getUsageItemPercentByMatcher(usage, ({ id, label }) =>
        id.includes('additional') &&
        id.includes('gpt_5_3_codex_spark') &&
        id.includes(windowNeedle)
    ) ?? getUsageItemPercentByMatcher(usage, ({ id, label }) =>
        (id.includes('gpt_5_3') || label.includes('gpt-5.3')) &&
        (id.includes(windowNeedle) || label.includes(labelNeedle))
    );
}

function getCodexCachedUsagePercent(providerType, uuid, usageCache, windowId, bucket = CODEX_QUOTA_BUCKET.GENERAL) {
    const usage = getCachedCodexUsageForProvider(providerType, uuid, usageCache);
    if (!usage) return null;

    if (bucket === CODEX_QUOTA_BUCKET.CODEX_53) {
        return getCodex53UsagePercent(usage, windowId);
    }

    const desiredKind = windowId === 'primary_window' ? 'short' : 'weekly';
    const semanticPercent = getUsageItemPercentByMatcher(usage, ({ id, windowKind, scope }) =>
        windowKind === desiredKind &&
        (scope === 'general' || id === 'primary_window' || id === 'secondary_window')
    );
    if (semanticPercent !== null) return semanticPercent;
    const hasSemanticGeneralWindows = (Array.isArray(usage?.items) ? usage.items : []).some(entry =>
        entry?.windowKind &&
        (entry?.scope === 'general' || entry?.id === 'primary_window' || entry?.id === 'secondary_window')
    );
    if (hasSemanticGeneralWindows) return null;

    const itemPercent = getUsageItemPercent(usage, windowId);
    if (itemPercent !== null) return itemPercent;

    return getRawRateLimitWindowPercent(usage.raw || usage, windowId);
}

function getCodexCachedQuotaPressure(providerType, uuid, usageCache, bucket = CODEX_QUOTA_BUCKET.GENERAL) {
    const primary = getCodexCachedUsagePercent(providerType, uuid, usageCache, 'primary_window', bucket);
    const secondary = getCodexCachedUsagePercent(providerType, uuid, usageCache, 'secondary_window', bucket);
    return {
        primary: primary ?? 0,
        secondary: secondary ?? 0
    };
}

function getCodexQuotaLimits(config = {}, bucket = CODEX_QUOTA_BUCKET.GENERAL) {
    if (bucket === CODEX_QUOTA_BUCKET.CODEX_53) {
        return {
            max5hPercent: getPercentLimit(config.codex53Max5hPercent, 100),
            maxWeeklyPercent: getPercentLimit(config.codex53MaxWeeklyPercent, 100)
        };
    }

    return {
        max5hPercent: getPercentLimit(config.codexGeneralMax5hPercent, 100),
        maxWeeklyPercent: getPercentLimit(config.codexGeneralMaxWeeklyPercent, 100)
    };
}

function getCodexQuotaState(config = {}, bucket = CODEX_QUOTA_BUCKET.GENERAL) {
    return config.codexQuotaHealth?.[bucket] || {};
}

function isCodexQuotaBucketCoolingDown(config = {}, bucket = CODEX_QUOTA_BUCKET.GENERAL, now = Date.now()) {
    const quotaState = getCodexQuotaState(config, bucket);
    if (quotaState.isHealthy !== false) return false;

    const recoveryMs = Date.parse(quotaState.scheduledRecoveryTime || '');
    return Number.isFinite(recoveryMs) && now < recoveryMs;
}

function getCodexRateLimitCooldownState(config = {}, bucket = CODEX_QUOTA_BUCKET.GENERAL) {
    return config.codexRateLimitCooldown?.[bucket] || {};
}

function isCodexRateLimitCoolingDown(config = {}, bucket = CODEX_QUOTA_BUCKET.GENERAL, now = Date.now()) {
    const state = getCodexRateLimitCooldownState(config, bucket);
    if (state.isCoolingDown !== true) return false;
    const recoveryMs = Date.parse(state.scheduledRecoveryTime || '');
    return Number.isFinite(recoveryMs) && now < recoveryMs;
}

function getCodexAutomaticHealthCheckCooldown(providerType, config = {}) {
    if (!isCodexProviderType(providerType)) return null;

    const quotaState = getCodexQuotaState(config, CODEX_QUOTA_BUCKET.GENERAL);
    if (quotaState.isHealthy !== false) return null;

    const recoveryMs = Date.parse(quotaState.scheduledRecoveryTime || '');
    return {
        recoveryTime: Number.isFinite(recoveryMs) ? new Date(recoveryMs).toISOString() : null,
        reason: quotaState.lastErrorMessage || 'Codex general quota exhausted'
    };
}

export function getCodexTokenQuotaStatus(providerType, providerStatus, usageCache = null, bucket = CODEX_QUOTA_BUCKET.GENERAL) {
    const config = providerStatus?.config || {};
    const { max5hPercent, maxWeeklyPercent } = getCodexQuotaLimits(config, bucket);
    if (!max5hPercent && !maxWeeklyPercent) {
        return { limited: false, exceeded: false, configured: false };
    }

    const uuid = config.uuid || providerStatus?.uuid;
    if (!uuid) {
        return { limited: true, exceeded: false, reason: null };
    }

    const warnings = [];
    const cachedUsage = getCachedCodexUsageForProvider(providerType, uuid, usageCache);
    const applicability = cachedUsage?.summary?.quotaApplicability
        || getCodexQuotaApplicability(cachedUsage || {});

    if (max5hPercent) {
        const usagePercent = getCodexCachedUsagePercent(providerType, uuid, usageCache, 'primary_window', bucket);
        if (usagePercent === null) {
            const status = bucket === CODEX_QUOTA_BUCKET.GENERAL
                ? applicability?.general?.short?.status
                : applicability?.codex53?.short?.status;
            if (status !== 'not_applicable') {
                warnings.push(`official ${bucket} 5h usage percent unavailable`);
            }
        } else if (usagePercent >= max5hPercent) {
            return {
                limited: true,
                exceeded: true,
                configured: true,
                bucket,
                reason: `${bucket} 5h usage quota reached (${usagePercent.toFixed(1)}%/${max5hPercent}%)`,
                usagePercent
            };
        }
    }

    if (maxWeeklyPercent) {
        const usagePercent = getCodexCachedUsagePercent(providerType, uuid, usageCache, 'secondary_window', bucket);
        if (usagePercent === null) {
            warnings.push(`official ${bucket} weekly usage percent unavailable`);
        } else if (usagePercent >= maxWeeklyPercent) {
            return {
                limited: true,
                exceeded: true,
                configured: true,
                bucket,
                reason: `${bucket} weekly usage quota reached (${usagePercent.toFixed(1)}%/${maxWeeklyPercent}%)`,
                usagePercent
            };
        }
    }

    return { limited: true, exceeded: false, configured: true, reason: warnings.join('; ') || null };
}

export function isCodex53QuotaExhaustionError(error) {
    if (!error || (error.status !== 429 && error.code !== 429)) return false;
    let current = error;
    while (current) {
        const filterReasons = current.filterReasons || {};
        if (Object.keys(filterReasons).some(reason => reason === 'codex53_quota_exceeded' || reason === 'cooldown')) {
            return true;
        }
        current = current.cause;
    }
    return false;
}

function getCodexQuotaFilterTtlMs(globalConfig = {}, unavailable = false) {
    const configured = unavailable
        ? globalConfig.CODEX_UNAVAILABLE_CACHE_TTL_MS ?? globalConfig.codexUnavailableCacheTtlMs
        : globalConfig.CODEX_QUOTA_FILTER_CACHE_TTL_MS ?? globalConfig.codexQuotaFilterCacheTtlMs;
    const fallback = unavailable ? 60_000 : 30_000;
    const value = Number(configured ?? fallback);
    return Math.min(Math.max(Number.isFinite(value) ? value : fallback, 500), 300_000);
}

function getCodexUsageCacheVersion(usageCache) {
    return usageCache?.timestamp || 'none';
}

export function getCodex53QuotaFallbackModel(globalConfig = {}) {
    return globalConfig?.codex53QuotaFallbackModel ||
        globalConfig?.CODEX_53_QUOTA_FALLBACK_MODEL ||
        DEFAULT_CODEX_53_QUOTA_FALLBACK_MODEL;
}

export function getCodexModelFallbackTarget(requestedModel, globalConfig = {}) {
    const model = String(requestedModel || '').trim();
    if (!model) return null;
    const configured = globalConfig?.CODEX_UNAVAILABLE_MODEL_FALLBACKS
        || globalConfig?.codexUnavailableModelFallbacks
        || {};
    const target = Object.prototype.hasOwnProperty.call(configured, model)
        ? configured[model]
        : null;
    if (!target || target === false || target === model) return null;
    return String(target);
}

export function shouldTryCodex53QuotaModelFallback(providerType, requestedModel, error, globalConfig = {}) {
    if (!isCodexProviderType(providerType)) return false;
    const bucket = resolveCodexQuotaBucket(
        requestedModel,
        toStringArray(globalConfig?.CODEX_53_QUOTA_MODEL_PATTERNS || globalConfig?.codex53QuotaModelPatterns || DEFAULT_CODEX_53_MODEL_PATTERNS)
    );
    return bucket === CODEX_QUOTA_BUCKET.CODEX_53 && isCodex53QuotaExhaustionError(error);
}

export function isCodex53SparkModel(requestedModel) {
    return String(requestedModel || '').trim() === 'gpt-5.3-codex-spark';
}

/**
 * Manages a pool of API service providers, handling their health and selection.
 */
export class ProviderPoolManager {
    // 默认健康检查模型配置
    // 键名必须与 MODEL_PROVIDER 常量值一致
    static DEFAULT_HEALTH_CHECK_MODELS = {
        'gemini-cli-oauth': 'gemini-2.5-flash',
        'gemini-antigravity': 'gemini-2.5-flash-lite',
        'openai-custom': 'gpt-4o-mini',
        'atlascloud': 'gpt-4o-mini',
        'claude-custom': 'claude-3-7-sonnet-20250219',
        'claude-kiro-oauth': 'claude-haiku-4-5',
        'openai-qwen-oauth': 'qwen3-coder-flash',
        'openai-iflow': 'qwen3-coder-plus',
        'openai-codex-oauth': 'gpt-5-codex-mini',
        'openaiResponses-custom': 'gpt-4o-mini',
        'forward-api': 'gpt-4o-mini',
        'grok-cli-oauth': 'grok-4.6',
        'grok-web': 'grok-4.1-mini',
    };

    constructor(providerPools, options = {}) {
        this.providerPools = providerPools;
        this.globalConfig = options.globalConfig || {}; // 存储全局配置
        this.providerStatus = {}; // Tracks health and usage for each provider instance
        this.roundRobinIndex = {}; // Tracks the current index for round-robin selection for each provider type
        this.imageRoundRobinIndex = new Map(); // Tracks image-only round-robin cursors by provider type and model
        // 使用 ?? 运算符确保 0 也能被正确设置，而不是被 || 替换为默认值
        this.maxErrorCount = options.maxErrorCount ?? 10; // Default to 10 errors before marking unhealthy
        this.healthCheckInterval = options.healthCheckInterval ?? 10 * 60 * 1000; // Default to 10 minutes

            // 日志级别控制
        this.logLevel = options.logLevel || 'info'; // 'debug', 'info', 'warn', 'error'
        
        // 添加防抖机制，避免频繁的文件 I/O 操作
        this.saveDebounceTime = options.saveDebounceTime ?? 10000; // 默认10秒批量落盘
        this.saveTimer = null;
        this.pendingSaves = new Set(); // 记录待保存的 providerType
        this.coordination = options.coordination || null;
        this.persistenceEnabled = options.persistenceEnabled !== false;
        this.stateEventSink = options.stateEventSink || null;
        this.configEventSink = options.configEventSink || null;
        this.identityEventSink = options.identityEventSink || null;
        this.providerConfigRevision = Number(options.providerConfigRevision || 0);
        this.serviceAdapterFactory = options.serviceAdapterFactory || getServiceAdapter;
        this.pendingStateEvents = new Map();
        this.providerStateEventTimes = new Map();
        this.stateEventTimer = null;
        this.providerIdentityConflicts = 0;
        
        // Fallback 链配置
        this.fallbackChain = options.globalConfig?.providerFallbackChain || {};
        
        // Model Fallback 映射配置
        this.modelFallbackMapping = options.globalConfig?.modelFallbackMapping || {};

        // Mixed Provider Pool 配置：将多个 providerType 展平后统一按 providerWeight 选点
        this.mixedProviderPools = options.globalConfig?.mixedProviderPools || {};

        // 并发控制：每个 providerType 的选择锁
        // 用于确保 selectProvider 的排序 and 更新操作是原子的
        this._selectionLocks = {};
        this._isSelecting = {}; // 同步标志位锁
        this._codexStickyHotStats = new Map();
        this._codexPoolExhaustedSnapshots = new Map();
        this._codexPoolSnapshotLocks = new Map();
        this._codexQuotaFilterSnapshots = new Map();
        this._codexQuotaFilterMetrics = {
            calls: 0,
            cacheHits: 0,
            cacheMisses: 0,
            providersScanned: 0,
            unavailableProviders: 0,
            crossWorkerReuse: 0,
            fastPathHits: 0,
            fastPathMisses: 0,
            fastPathFallbackFailures: 0
        };
        this._antigravityAvailabilityLocal = new Map();
        this._antigravityAvailabilityFlights = new Map();
        this._antigravityAvailabilityRevision = 0;
        this._antigravityAvailabilityModelRevisions = new Map();
        this._antigravityAvailabilityLastInvalidateAt = new Map();
        this._antigravityCredentialHashCache = new Map();
        this._antigravityAvailabilityScopeCache = new Map();
        this._antigravityPlanFilterCache = { usageCache: null, byUuid: new Map() };
        this._antigravityAvailabilityMetrics = {
            cacheHits: 0,
            cacheMisses: 0,
            negativeCacheHits: 0,
            singleFlightHits: 0,
            providersScanned: 0,
            refreshMs: 0,
            invalidations: 0,
            allModelsUnavailable: 0
        };
        this._antigravityRoutingMetrics = {
            sourceAttempts: 0,
            fallbackAttempts: 0,
            fallbackSuccesses: 0,
            skippedByNegativeCache: 0,
            allModelsUnavailable: 0,
            queueEnqueued: 0,
            queueWaitMs: 0,
            queueTimeouts: 0,
            retrySuppressed: 0,
            modelNotFoundMarked: 0,
            modelNotFoundFastFails: 0,
            availableModelsUnknown: 0
        };
        this._antigravityModelNotFound = new Map();
        this._antigravityModelNotFoundSync = { fetchedAt: 0, promise: null };
        this._antigravityAvailableModelsWarnedAt = 0;
        this._providerSelectionLoadStats = new Map();
        this._poolKeySchedulers = new Map();
        this._geminiElasticQueue = {
            waiting: 0,
            queuedBytes: 0,
            perKeyModel: new Map(),
            waiters: new Set()
        };

        // --- V2: 读写分离 and 异步刷新队列 ---
        // 刷新并发控制配置
        this.refreshConcurrency = {
            global: options.globalConfig?.REFRESH_CONCURRENCY_GLOBAL ?? 2, // 全局最大并行提供商数
            perProvider: options.globalConfig?.REFRESH_CONCURRENCY_PER_PROVIDER ?? 1 // 每个提供商内部最大并行数
        };
        
        this.activeProviderRefreshes = 0; // 当前正在刷新的提供商类型数量
        this.globalRefreshWaiters = []; // 等待全局并发槽位的任务
        
        this.warmupTarget = options.globalConfig?.WARMUP_TARGET || 0; // 默认预热0个节点
        this.refreshingUuids = new Set(); // 正在刷新的节点 UUID 集合
        this.healthCheckPromises = new Map(); // 同一凭据只允许一个上游健康检测
        
        this.refreshQueues = {}; // 按 providerType 分组的队列
        // 缓冲队列机制：延迟5秒，去重后再执行刷新
        this.refreshBufferQueues = {}; // 按 providerType 分组的缓冲队列
        this.refreshBufferTimers = {}; // 按 providerType 分组的定时器
        this.bufferDelay = options.globalConfig?.REFRESH_BUFFER_DELAY ?? 5000; // 默认5秒缓冲延迟
        this.refreshTaskTimeoutMs = options.globalConfig?.REFRESH_TASK_TIMEOUT_MS ?? 60000; // 默认60秒刷新超时
        this.refreshShutdownRequested = false;
        this.refreshShutdownPromise = null;
        this.activeRefreshTasks = new Set();
        this.activeRefreshOperations = new Set();
        
        // 用于并发选点时的原子排序辅助（自增序列）
        this._selectionSequence = 0;
 
        this.initializeProviderStatus();
    }

    _getCodexStickyHotShardConfig() {
        return {
            enabled: !isFalseConfigFlag(this.globalConfig?.CODEX_STICKY_HOT_SHARD_ENABLED),
            windowMs: getPositiveIntegerConfig(
                this.globalConfig?.CODEX_STICKY_HOT_SHARD_WINDOW_MS,
                DEFAULT_CODEX_STICKY_HOT_SHARD_WINDOW_MS
            ),
            minRequests: getPositiveIntegerConfig(
                this.globalConfig?.CODEX_STICKY_HOT_SHARD_MIN_REQUESTS,
                DEFAULT_CODEX_STICKY_HOT_SHARD_MIN_REQUESTS
            ),
            maxShards: getPositiveIntegerConfig(
                this.globalConfig?.CODEX_STICKY_HOT_SHARD_MAX_SHARDS,
                DEFAULT_CODEX_STICKY_HOT_SHARD_MAX_SHARDS
            )
        };
    }

    _recordCodexStickyHotRequest(stickyProviderKey, now = Date.now()) {
        const config = this._getCodexStickyHotShardConfig();
        const existing = this._codexStickyHotStats.get(stickyProviderKey) || { buckets: new Map() };
        const cutoff = now - config.windowMs;
        const bucketMs = Math.min(CODEX_HOT_KEY_BUCKET_MS, Math.max(1000, config.windowMs));
        const bucket = Math.floor(now / bucketMs) * bucketMs;
        const buckets = existing.buckets instanceof Map ? existing.buckets : new Map();
        buckets.set(bucket, (buckets.get(bucket) || 0) + 1);

        let count = 0;
        for (const [bucketStart, bucketCount] of buckets.entries()) {
            if (bucketStart < cutoff) {
                buckets.delete(bucketStart);
                continue;
            }
            count += bucketCount;
        }

        const stats = { buckets };
        this._codexStickyHotStats.set(stickyProviderKey, stats);
        return { count, config };
    }

    _getCodexHotObservationId(stickyProviderKey, options = {}) {
        if (options.hotRequestObservationId) return String(options.hotRequestObservationId);
        const store = requestContext.getStore();
        if (store.requestId) return String(store.requestId);
        store.codexHotObservationIds = store.codexHotObservationIds || new Map();
        if (!store.codexHotObservationIds.has(stickyProviderKey)) {
            store.codexHotObservationIds.set(
                stickyProviderKey,
                `selection:${crypto.randomUUID()}`
            );
        }
        return store.codexHotObservationIds.get(stickyProviderKey);
    }

    async _getCodexStickyHotRequestCount(stickyProviderKey, options = {}, now = Date.now()) {
        const config = this._getCodexStickyHotShardConfig();
        if (!config.enabled) return { count: 0, config };
        if (this.coordination?.recordHotRequest) {
            const result = await this.coordination.recordHotRequest(stickyProviderKey, {
                observationId: this._getCodexHotObservationId(stickyProviderKey, options),
                now,
                windowMs: config.windowMs,
                bucketMs: Math.min(CODEX_HOT_KEY_BUCKET_MS, Math.max(1000, config.windowMs))
            });
            return { count: Number(result?.count || 0), config };
        }
        return this._recordCodexStickyHotRequest(stickyProviderKey, now);
    }

    _getCodexHotShardCount(requestCount, providerCount, config) {
        if (!config.enabled || providerCount < 2 || requestCount < config.minRequests) {
            return 1;
        }
        let desired = 2;
        if (requestCount >= config.minRequests * 12) {
            desired = 5;
        } else if (requestCount >= config.minRequests * 6) {
            desired = 4;
        } else if (requestCount >= config.minRequests * 3) {
            desired = 3;
        }
        return Math.max(1, Math.min(config.maxShards, providerCount, desired));
    }

    _getProviderSelectionLoadKey(providerType, provider) {
        const uuid = provider?.uuid || provider?.config?.uuid || '';
        return `${providerType}:${uuid}`;
    }

    _recordProviderSelectionLoad(providerType, provider, now = Date.now()) {
        if (!providerType || !provider) return;
        const key = this._getProviderSelectionLoadKey(providerType, provider);
        if (!key) return;

        const bucket = Math.floor(now / PROVIDER_SELECTION_LOAD_BUCKET_MS) * PROVIDER_SELECTION_LOAD_BUCKET_MS;
        const existing = this._providerSelectionLoadStats.get(key) || { buckets: new Map() };
        const buckets = existing.buckets instanceof Map ? existing.buckets : new Map();
        buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
        this._providerSelectionLoadStats.set(key, { buckets });
        this._pruneProviderSelectionLoadStats(key, now);
    }

    _pruneProviderSelectionLoadStats(key, now = Date.now()) {
        const stats = this._providerSelectionLoadStats.get(key);
        if (!stats?.buckets) return;
        const cutoff = now - PROVIDER_SELECTION_LOAD_MAX_WINDOW_MS;
        for (const bucketStart of stats.buckets.keys()) {
            if (bucketStart < cutoff) {
                stats.buckets.delete(bucketStart);
            }
        }
        if (stats.buckets.size === 0) {
            this._providerSelectionLoadStats.delete(key);
        }
    }

    _getProviderSelectionLoad(providerType, provider, windowMs, now = Date.now()) {
        const key = this._getProviderSelectionLoadKey(providerType, provider);
        const stats = this._providerSelectionLoadStats.get(key);
        if (!stats?.buckets) return 0;

        const cutoff = now - windowMs;
        let count = 0;
        for (const [bucketStart, bucketCount] of stats.buckets.entries()) {
            if (bucketStart >= cutoff) {
                count += bucketCount;
            }
        }
        return count;
    }

    _getEligibleBalanceSiblings(providerType, excludeUuid) {
        return (this.providerStatus[providerType] || []).filter(provider =>
            provider.uuid !== excludeUuid &&
            provider.config.isHealthy &&
            !provider.config.isDisabled &&
            !provider.config.needsRefresh
        );
    }

    _getProviderBalanceUnits(providerType, providerStatus, now = Date.now()) {
        const recentLoad = this._getProviderSelectionLoad(
            providerType,
            providerStatus,
            PROVIDER_SELECTION_LOAD_MAX_WINDOW_MS,
            now
        );
        return recentLoad > 0 ? recentLoad : (providerStatus.config.usageCount || 0);
    }

    _getProviderWeightedBalanceScore(providerType, providerStatus, now = Date.now()) {
        const weight = getProviderWeight(providerStatus.config);
        return this._getProviderBalanceUnits(providerType, providerStatus, now) / weight;
    }

    _seedProviderSelectionLoad(providerType, provider, targetCount, now = Date.now()) {
        const key = this._getProviderSelectionLoadKey(providerType, provider);
        if (!key) return;

        const normalizedCount = Math.max(0, Math.round(Number(targetCount) || 0));
        if (normalizedCount <= 0) {
            this._providerSelectionLoadStats.delete(key);
            return;
        }

        const bucket = Math.floor(now / PROVIDER_SELECTION_LOAD_BUCKET_MS) * PROVIDER_SELECTION_LOAD_BUCKET_MS;
        this._providerSelectionLoadStats.set(key, { buckets: new Map([[bucket, normalizedCount]]) });
    }

    _syncProviderBalanceOnEnable(providerType, provider, now = Date.now()) {
        const siblings = this._getEligibleBalanceSiblings(providerType, provider.uuid);
        if (siblings.length === 0) return;

        const siblingScores = siblings.map(sibling =>
            this._getProviderWeightedBalanceScore(providerType, sibling, now)
        );
        const medianScore = medianNumber(siblingScores);
        const weight = getProviderWeight(provider.config);
        const previousUsageCount = provider.config.usageCount || 0;
        provider.config.usageCount = Math.max(0, Math.round(medianScore * weight));

        const medianRecentLoad = medianNumber(siblings.map(sibling =>
            this._getProviderSelectionLoad(
                providerType,
                sibling,
                PROVIDER_SELECTION_LOAD_MAX_WINDOW_MS,
                now
            )
        ));
        this._seedProviderSelectionLoad(providerType, provider, medianRecentLoad, now);
        provider.config.lastUsed = new Date(now).toISOString();
        provider.config._lastSelectionSeq = this._selectionSequence;

        this._log(
            'info',
            `Synced provider balance on enable: ${this._getDisplayName(provider.config)} ` +
            `(usageCount ${previousUsageCount} -> ${provider.config.usageCount}, ` +
            `recent60m -> ${Math.round(medianRecentLoad)})`
        );
    }

    _rankCodexShardProviders(providers, providerType, requestedModel, usageCache, now = Date.now()) {
        const bucket = resolveCodexQuotaBucket(
            requestedModel,
            toStringArray(this.globalConfig?.CODEX_53_QUOTA_MODEL_PATTERNS || this.globalConfig?.codex53QuotaModelPatterns || DEFAULT_CODEX_53_MODEL_PATTERNS)
        );

        return [...providers].sort((a, b) => {
            const rank = (provider) => {
                const config = provider.config || {};
                const uuid = config.uuid || provider.uuid;
                const weight = getProviderWeight(config);
                const quota = getCodexCachedQuotaPressure(providerType, uuid, usageCache, bucket);
                const recent15m = this._getProviderSelectionLoad(providerType, provider, 15 * 60 * 1000, now);
                const recent60m = this._getProviderSelectionLoad(providerType, provider, 60 * 60 * 1000, now);
                return {
                    score:
                        quota.primary * 0.5 +
                        quota.secondary * 0.3 +
                        ((config.usageCount || 0) / weight) * 0.05 +
                        ((recent15m / weight) * 0.3) +
                        ((recent60m / weight) * 0.15) +
                        ((provider.state?.activeCount || 0) * 0.1),
                    lastUsed: config.lastUsed ? Date.parse(config.lastUsed) || 0 : 0
                };
            };
            const rankA = rank(a);
            const rankB = rank(b);
            if (rankA.score !== rankB.score) return rankA.score - rankB.score;
            if (rankA.lastUsed !== rankB.lastUsed) return rankA.lastUsed - rankB.lastUsed;
            return getProviderStableId(a).localeCompare(getProviderStableId(b));
        });
    }

    async _selectCodexHotShardProvider(providers, providerType, requestedModel, options, now) {
        if (!options.stickyProviderKey || !isCodexProviderType(providerType)) {
            return null;
        }

        const { count, config } = await this._getCodexStickyHotRequestCount(
            `${providerType}:${requestedModel || ''}:${options.stickyProviderKey}`,
            options,
            now
        );
        const shardCount = this._getCodexHotShardCount(count, providers.length, config);
        if (shardCount <= 1) {
            return null;
        }

        const usageCache = readFreshUsageCacheSync();
        const shardProviders = this
            ._rankCodexShardProviders(providers, providerType, requestedModel, usageCache, now)
            .slice(0, shardCount);
        if (shardProviders.length <= 1) {
            return null;
        }

        const discriminator = options.shardDiscriminator || count;
        const shardUnit = stableHashToUnitInterval(`${providerType}:${requestedModel || ''}:${options.stickyProviderKey}:shard:${discriminator}`);
        const shardIndex = Math.min(shardProviders.length - 1, Math.floor(shardUnit * shardProviders.length));
        const selected = shardProviders[shardIndex];
        if (options.selectionDiagnostics) {
            options.selectionDiagnostics.hotShardApplied = true;
        }
        this._log('debug', `Selected provider for ${providerType} by hot sticky shard ${shardIndex + 1}/${shardProviders.length}: ${this._getDisplayName(selected.config)}${requestedModel ? ` for model: ${requestedModel}` : ''}`);
        return selected;
    }

    _selectImageRoundRobinProvider(providers, providerType, requestedModel) {
        if (!Array.isArray(providers) || providers.length === 0) return null;

        const candidates = [...providers].sort((a, b) =>
            getProviderStableId(a).localeCompare(getProviderStableId(b))
        );
        const cursorKey = `${providerType}:${normalizeImageRoundRobinModel(requestedModel)}`;
        const cursor = this.imageRoundRobinIndex.get(cursorKey) || 0;
        const selected = candidates[cursor % candidates.length];
        this.imageRoundRobinIndex.set(cursorKey, cursor + 1);
        this._log(
            'debug',
            `Selected provider for ${providerType} by image round robin ` +
            `(${(cursor % candidates.length) + 1}/${candidates.length}): ${this._getDisplayName(selected.config)}` +
            `${requestedModel ? ` for model: ${requestedModel}` : ''}`
        );
        return selected;
    }

    /**
     * 强制刷新特定节点的令牌
     * @param {string} providerType 
     * @param {string} uuid 
     * @param {boolean} force 
     */
    async refreshNode(providerType, uuid, force = true) {
        const provider = this._findProvider(providerType, uuid);
        if (provider) {
            this._log('info', `Manually triggering refresh for node ${this._getDisplayName(provider.config)} (${providerType})`);
            this._enqueueRefresh(providerType, provider, force);
            return true;
        }
        return false;
    }

    /**
     * 检查所有节点的配置文件，如果发现即将过期则触发刷新
     */
    async checkAndRefreshExpiringNodes() {
        this._log('info', 'Checking nodes for approaching expiration dates using provider adapters...');
        
        for (const providerType in this.providerStatus) {
            const providers = this.providerStatus[providerType];
            for (const providerStatus of providers) {
                const config = providerStatus.config;
                
                // 根据 providerType 确定配置文件路径字段名
                let configPath = null;
                if (providerType.startsWith('claude-kiro')) {
                    configPath = config.KIRO_OAUTH_CREDS_FILE_PATH;
                } else if (providerType.startsWith('gemini-cli')) {
                    configPath = config.GEMINI_OAUTH_CREDS_FILE_PATH;
                } else if (providerType.startsWith('gemini-antigravity')) {
                    configPath = config.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH;
                } else if (providerType.startsWith('openai-qwen')) {
                    configPath = config.QWEN_OAUTH_CREDS_FILE_PATH;
                } else if (providerType.startsWith('openai-iflow')) {
                    configPath = config.IFLOW_OAUTH_CREDS_FILE_PATH;
                } else if (providerType.startsWith('openai-codex')) {
                    configPath = config.CODEX_OAUTH_CREDS_FILE_PATH;
                } else if (providerType.startsWith('grok-cli')) {
                    configPath = config.GROK_CLI_OAUTH_CREDS_FILE_PATH;
                }
                
                // logger.info(`Checking node ${this._getDisplayName(config)} (${providerType}) expiry date... configPath: ${configPath}`);
                // 排除禁用的节点（不健康节点也应允许尝试刷新以恢复健康）
                if (config.isDisabled) continue;

                if (configPath && fs.existsSync(configPath)) {
                    try {
                        const fileContent = fs.readFileSync(configPath, 'utf-8');
                        const credData = JSON.parse(fileContent);
                        const rawExpiryTime = credData.expiry_date ?? credData.expiry ?? credData.expires_at ?? credData.expiresAt;
                        let expiryTime = null;
                        if (typeof rawExpiryTime === 'number') {
                            expiryTime = rawExpiryTime;
                        } else if (typeof rawExpiryTime === 'string') {
                            const parsedDate = Date.parse(rawExpiryTime);
                            expiryTime = Number.isNaN(parsedDate) ? Number(rawExpiryTime) : parsedDate;
                        }
                        const nearExpiryMs = (this.globalConfig?.CRON_NEAR_MINUTES || 10) * 60 * 1000;
                        if (!Number.isFinite(expiryTime)) {
                            // 凭据文件缺少 expiry 字段，无法判断是否快过期，作为安全措施强制刷新
                            this._log('warn', `Node ${this._getDisplayName(config)} (${providerType}) has no expiry field. Forcing refresh as safety measure...`);
                            this._enqueueRefresh(providerType, providerStatus);
                        } else if ((expiryTime - Date.now()) < nearExpiryMs) {
                            this._log('warn', `Node ${this._getDisplayName(config)} (${providerType}) is near expiration. Enqueuing refresh...`);
                            this._enqueueRefresh(providerType, providerStatus);
                        }
                    } catch (err) {
                        this._log('error', `Failed to check expiry for node ${this._getDisplayName(config)}: ${err.message}`);
                    }
                } else {
                    this._log('debug', `Node ${this._getDisplayName(config)} (${providerType}) has no valid config file path or file does not exist.`);
                }
            }
        }
    }

    _scheduleAntigravityModelProbes() {
        for (const type in this.providerStatus) {
            if (!isAntigravityProviderType(type)) continue;
            const candidate = (this.providerStatus[type] || []).find(
                provider => provider.config.isHealthy && !provider.config.isDisabled
            );
            if (candidate) {
                void this._probeAntigravityAvailableModels(type, candidate);
            }
        }
    }

    /**
     * 系统预热逻辑：按提供商分组，每组预热 warmupTarget 个节点
     * @returns {Promise<void>}
     */
    async warmupNodes() {
        this._scheduleAntigravityModelProbes();
        if (this.warmupTarget <= 0) return;
        this._log('info', `Starting system warmup (Group Target: ${this.warmupTarget} nodes per provider)...`);

        const nodesToWarmup = [];

        for (const type in this.providerStatus) {
            const pool = this.providerStatus[type];
            
            // 挑选当前提供商下需要预热的节点
            const candidates = pool
                .filter(p => p.config.isHealthy && !p.config.isDisabled && !this.refreshingUuids.has(p.uuid))
                .sort((a, b) => {
                    // 优先级 A: 明确标记需要刷新的
                    if (a.config.needsRefresh && !b.config.needsRefresh) return -1;
                    if (!a.config.needsRefresh && b.config.needsRefresh) return 1;

                    // 优先级 B: 按照正常的选择权重排序（最久没用过的优先补）
                    const scoreA = this._calculateNodeScore(a);
                    const scoreB = this._calculateNodeScore(b);
                    return scoreA - scoreB;
                })
                .slice(0, this.warmupTarget);

            candidates.forEach(p => nodesToWarmup.push({ type, status: p }));
        }

        this._log('info', `Warmup: Selected total ${nodesToWarmup.length} nodes across all providers to refresh.`);

        for (const node of nodesToWarmup) {
            this._enqueueRefresh(node.type, node.status, true);
        }

        // 注意：warmupNodes 不等待队列结束，它是异步后台执行的
    }

    /**
     * 将节点放入缓冲队列，延迟5秒后去重并执行刷新
     * @param {string} providerType 
     * @param {object} providerStatus 
     * @param {boolean} force - 是否强制刷新（跳过缓冲队列）
     * @private
     */
    _enqueueRefresh(providerType, providerStatus, force = false) {
        if (this.refreshShutdownRequested) {
            this._log('debug', `Ignoring refresh enqueue for ${providerType} during shutdown.`);
            return;
        }
        const uuid = providerStatus.uuid;
        
        // 如果节点被禁用，不进行刷新
        if (providerStatus.config.isDisabled) {
            this._log('debug', `Skipping refresh for disabled node ${this._getDisplayName(providerStatus.config)}`);
            return;
        }
        
        // 如果已经在刷新中，直接返回
        if (this.refreshingUuids.has(uuid)) {
            this._log('debug', `Node ${this._getDisplayName(providerStatus.config)} is already in refresh queue.`);
            return;
        }

        // 判断提供商池内的总可用节点数，小于5个时，不等待缓冲，直接加入刷新队列
        const healthyCount = this.getHealthyCount(providerType);
        if (healthyCount < 5) {
            this._log('info', `Provider ${providerType} has only ${healthyCount} healthy nodes. Bypassing buffer and enqueuing refresh for ${this._getDisplayName(providerStatus.config)} immediately.`);
            this._enqueueRefreshImmediate(providerType, providerStatus, force);
            return;
        }

        // 初始化缓冲队列
        if (!this.refreshBufferQueues[providerType]) {
            this.refreshBufferQueues[providerType] = new Map(); // 使用 Map 自动去重
        }

        const bufferQueue = this.refreshBufferQueues[providerType];
        
        // 检查是否已在缓冲队列中
        const existing = bufferQueue.get(uuid);
        const isNewEntry = !existing;
        
        // 更新或添加节点（保留 force: true 状态）
        bufferQueue.set(uuid, {
            providerStatus,
            force: existing ? (existing.force || force) : force
        });
        
        if (isNewEntry) {
            this._log('debug', `Node ${this._getDisplayName(providerStatus.config)} added to buffer queue for ${providerType}. Buffer size: ${bufferQueue.size}`);
        } else {
            this._log('debug', `Node ${this._getDisplayName(providerStatus.config)} already in buffer queue, updated force flag. Buffer size: ${bufferQueue.size}`);
        }

        // 只在新增节点或缓冲队列为空时重置定时器
        // 避免频繁重置导致刷新被无限延迟
        if (isNewEntry || !this.refreshBufferTimers[providerType]) {
            // 清除之前的定时器
            if (this.refreshBufferTimers[providerType]) {
                clearTimeout(this.refreshBufferTimers[providerType]);
            }

            // 设置新的定时器，延迟5秒后处理缓冲队列
            this.refreshBufferTimers[providerType] = setTimeout(() => {
                this._flushRefreshBuffer(providerType);
            }, this.bufferDelay);
        }
    }

    /**
     * 处理缓冲队列，将去重后的节点放入实际刷新队列
     * @param {string} providerType 
     * @private
     */
    _flushRefreshBuffer(providerType) {
        if (this.refreshShutdownRequested) {
            delete this.refreshBufferQueues[providerType];
            delete this.refreshBufferTimers[providerType];
            return;
        }
        const bufferQueue = this.refreshBufferQueues[providerType];
        if (!bufferQueue || bufferQueue.size === 0) {
            return;
        }

        this._log('info', `Flushing refresh buffer for ${providerType}. Processing ${bufferQueue.size} unique nodes.`);

        // 将缓冲队列中的所有节点放入实际刷新队列
        for (const [uuid, { providerStatus, force }] of bufferQueue.entries()) {
            this._enqueueRefreshImmediate(providerType, providerStatus, force);
        }

        // 清空缓冲队列和定时器
        bufferQueue.clear();
        delete this.refreshBufferTimers[providerType];
    }

    /**
     * 立即将节点放入刷新队列（内部方法，由缓冲队列调用）
     * @param {string} providerType 
     * @param {object} providerStatus 
     * @param {boolean} force 
     * @private
     */
    _enqueueRefreshImmediate(providerType, providerStatus, force = false) {
        if (this.refreshShutdownRequested) {
            this._log('debug', `Ignoring immediate refresh enqueue for ${providerType} during shutdown.`);
            return;
        }
        const uuid = providerStatus.uuid;
        
        // 再次检查是否已经在刷新中（防止并发问题）
        if (this.refreshingUuids.has(uuid)) {
            this._log('debug', `Node ${this._getDisplayName(providerStatus.config)} is already in refresh queue (immediate check).`);
            return;
        }

        this.refreshingUuids.add(uuid);

        // 初始化提供商队列
        if (!this.refreshQueues[providerType]) {
            this.refreshQueues[providerType] = {
                activeCount: 0,
                waitingTasks: [],
                ownsGlobalSlot: false,
                waitingForGlobalSlot: false
            };
        }

        const queue = this.refreshQueues[providerType];

        const runTask = async () => {
            try {
                await this._refreshNodeToken(providerType, providerStatus, force);
            } catch (err) {
                this._log('error', `Failed to process refresh for node ${this._getDisplayName(providerStatus.config)}: ${err.message}`);
            } finally {
                this.refreshingUuids.delete(uuid);

                // 再次获取当前队列引用
                const currentQueue = this.refreshQueues[providerType];
                if (!currentQueue) return;

                currentQueue.activeCount--;

                // 1. 尝试从当前提供商队列中取下一个任务
                if (!this.refreshShutdownRequested && currentQueue.waitingTasks.length > 0) {
                    const nextTask = currentQueue.waitingTasks.shift();
                    currentQueue.activeCount++;
                    this._startTrackedRefreshTask(nextTask, providerType);
                } else if (currentQueue.activeCount === 0) {
                    const ownsGlobalSlot = currentQueue.ownsGlobalSlot;
                    currentQueue.ownsGlobalSlot = false;

                    // 清理空队列：无论是否持有全局槽位，都应删除已无任务的队列对象
                    if (currentQueue.waitingTasks.length === 0 &&
                        this.refreshQueues[providerType] === currentQueue) {
                        delete this.refreshQueues[providerType];
                    }

                    // 只有持有全局槽位的任务才能递减计数器
                    if (ownsGlobalSlot) {
                        this.activeProviderRefreshes = Math.max(0, this.activeProviderRefreshes - 1);
                    }

                    // 3. 尝试启动下一个等待中的提供商队列
                    if (!this.refreshShutdownRequested && this.globalRefreshWaiters.length > 0) {
                        const nextProviderStart = this.globalRefreshWaiters.shift();
                        nextProviderStart();
                    }
                }
            }
        };
        runTask.refreshUuid = uuid;
        runTask.providerType = providerType;

        const tryStartProviderQueue = () => {
            const currentQueue = this.refreshQueues[providerType];
            if (!currentQueue || this.refreshShutdownRequested) {
                if (runTask.refreshUuid) this.refreshingUuids.delete(runTask.refreshUuid);
                return;
            }

            if (currentQueue.activeCount < this.refreshConcurrency.perProvider) {
                currentQueue.activeCount++;
                this._startTrackedRefreshTask(runTask, providerType);
            } else {
                currentQueue.waitingTasks.push(runTask);
            }
        };

        // 检查全局并发限制（按提供商分组）
        // 情况1: 该提供商已经在运行，直接加入其队列（不占用新的全局槽位）
        if (queue.ownsGlobalSlot) {
            tryStartProviderQueue();
        }
        // 情况2: 该提供商正在等待全局槽位，后续任务只加入队列
        else if (queue.waitingForGlobalSlot) {
            queue.waitingTasks.push(runTask);
        }
        // 情况3: 该提供商未运行，需要检查全局槽位，此路径持有全局槽位
        else if (this.activeProviderRefreshes < this.refreshConcurrency.global) {
            queue.ownsGlobalSlot = true;
            this.activeProviderRefreshes++;
            tryStartProviderQueue();
        }
        // 情况4: 全局槽位已满，进入等待队列，由等待回调负责标记持槽
        else {
            queue.waitingForGlobalSlot = true;
            const startWaitingProvider = () => {
                if (this.refreshShutdownRequested) {
                    this.refreshingUuids.delete(uuid);
                    return;
                }

                // 重新获取最新的队列引用
                if (!this.refreshQueues[providerType]) {
                    this.refreshQueues[providerType] = {
                        activeCount: 0,
                        waitingTasks: [],
                        ownsGlobalSlot: false,
                        waitingForGlobalSlot: false
                    };
                }
                // 从等待队列启动时持有全局槽位
                const currentQueue = this.refreshQueues[providerType];
                currentQueue.waitingForGlobalSlot = false;
                currentQueue.ownsGlobalSlot = true;
                this.activeProviderRefreshes++;
                tryStartProviderQueue();
            };
            startWaitingProvider.refreshUuid = uuid;
            startWaitingProvider.providerType = providerType;
            this.globalRefreshWaiters.push(startWaitingProvider);
        }
    }

    _startTrackedRefreshTask(task, providerType) {
        if (this.refreshShutdownRequested) {
            if (task.refreshUuid) this.refreshingUuids.delete(task.refreshUuid);
            return null;
        }

        const taskPromise = Promise.resolve().then(task);
        this.activeRefreshTasks.add(taskPromise);
        taskPromise.then(
            () => this.activeRefreshTasks.delete(taskPromise),
            error => {
                this.activeRefreshTasks.delete(taskPromise);
                this._log('error', `Failed to execute refresh task for ${providerType}: ${error.message}`);
            }
        );
        return taskPromise;
    }

    _trackRefreshOperation(operation) {
        const operationPromise = Promise.resolve(operation);
        this.activeRefreshOperations.add(operationPromise);
        operationPromise.then(
            () => this.activeRefreshOperations.delete(operationPromise),
            () => this.activeRefreshOperations.delete(operationPromise)
        );
        return operationPromise;
    }

    shutdownRefreshQueue() {
        if (this.refreshShutdownPromise) {
            return this.refreshShutdownPromise;
        }

        this.refreshShutdownRequested = true;

        for (const timer of Object.values(this.refreshBufferTimers)) {
            clearTimeout(timer);
        }
        this.refreshBufferTimers = {};
        this.refreshBufferQueues = {};

        for (const [providerType, queue] of Object.entries(this.refreshQueues)) {
            for (const task of queue.waitingTasks.splice(0)) {
                if (task.refreshUuid) this.refreshingUuids.delete(task.refreshUuid);
            }
            if (queue.activeCount === 0) {
                delete this.refreshQueues[providerType];
            }
        }

        for (const waiter of this.globalRefreshWaiters.splice(0)) {
            if (waiter.refreshUuid) this.refreshingUuids.delete(waiter.refreshUuid);
            const queue = this.refreshQueues[waiter.providerType];
            if (queue?.activeCount === 0 && queue.waitingTasks.length === 0) {
                delete this.refreshQueues[waiter.providerType];
            }
        }

        const drainActiveTasks = async () => {
            while (this.activeRefreshTasks.size > 0 || this.activeRefreshOperations.size > 0) {
                await Promise.allSettled([
                    ...this.activeRefreshTasks,
                    ...this.activeRefreshOperations
                ]);
            }
        };
        this.refreshShutdownPromise = drainActiveTasks();
        return this.refreshShutdownPromise;
    }

    /**
     * 实际执行节点刷新逻辑
     * @private
     */
    async _refreshNodeToken(providerType, providerStatus, force = false) {
        const config = providerStatus.config;
        let refreshFence = null;
        let refreshFenceTimer = null;

        if (this.coordination?.acquireRefreshFence) {
            refreshFence = await this.coordination.acquireRefreshFence(
                providerType,
                config.uuid,
                this.refreshTaskTimeoutMs + 30000
            );
            if (refreshFence === null) {
                this._log('debug', `Token refresh already owned by another worker for ${this._getDisplayName(config)}`);
                return false;
            }
            const refreshFenceTtl = this.refreshTaskTimeoutMs + 30000;
            refreshFenceTimer = setInterval(() => {
                this.coordination.renewRefreshFence?.(providerType, config.uuid, refreshFence, refreshFenceTtl).catch(error => {
                    this._log('warn', `Failed to renew refresh fence for ${this._getDisplayName(config)}: ${error.message}`);
                });
            }, Math.min(20000, Math.max(1000, Math.floor(refreshFenceTtl / 3))));
            refreshFenceTimer.unref?.();
        }
        
        // 检查刷新次数是否已达上限（最大5次）
        const currentRefreshCount = config.refreshCount || 0;
        if (currentRefreshCount >= 5 && !force) {
            this._log('warn', `Node ${this._getDisplayName(config)} has reached maximum refresh count (5), marking as unhealthy`);
            // 标记为不健康
            this.markProviderUnhealthyImmediately(providerType, config, 'Maximum refresh count (5) reached');
            return;
        }
        
        // 添加5秒内的随机等待时间，避免并发刷新时的冲突
        // const randomDelay = Math.floor(Math.random() * 5000);
        // this._log('info', `Starting token refresh for node ${this._getDisplayName(config)} (${providerType}) with ${randomDelay}ms delay`);
        // await new Promise(resolve => setTimeout(resolve, randomDelay));

        try {
            // 增加刷新计数
            config.refreshCount = currentRefreshCount + 1;

            // 使用适配器进行刷新
            const tempConfig = {
                ...this.globalConfig,
                ...config,
                MODEL_PROVIDER: providerType
            };
            delete tempConfig.providerPools;
            const serviceAdapter = this.serviceAdapterFactory(tempConfig);
            
            // 调用适配器的 refreshToken 方法（内部封装了具体的刷新逻辑）
            if (typeof serviceAdapter.refreshToken === 'function') {
                const startTime = Date.now();
                let refreshOperation;
                if (force) {
                    if (typeof serviceAdapter.forceRefreshToken === 'function') {
                        refreshOperation = serviceAdapter.forceRefreshToken();
                    } else {
                        this._log('warn', `forceRefreshToken not implemented for ${providerType}, falling back to refreshToken`);
                        refreshOperation = serviceAdapter.refreshToken();
                    }
                } else {
                    refreshOperation = serviceAdapter.refreshToken();
                }
                const trackedRefreshOperation = this._trackRefreshOperation(refreshOperation);
                const refreshResult = await this._awaitRefreshWithTimeout(trackedRefreshOperation, providerType, this._getDisplayName(config));

                if (refreshFence !== null && !await this.coordination.validateRefreshFence(providerType, config.uuid, refreshFence)) {
                    const staleError = new Error(`Stale token refresh fence for ${providerType}/${config.uuid}`);
                    staleError.code = 'STALE_REFRESH_FENCE';
                    staleError.skipErrorCount = true;
                    throw staleError;
                }

                const duration = Date.now() - startTime;
                
                // 只有在真正执行了刷新操作时，才更新 lastRefreshTime
                // 这可以防止 heartbeat 的 no-op 刷新误更新时间，导致后续真正的刷新被 markProviderNeedRefresh 拦截（30秒保护）
                if (isAntigravityProviderType(providerType)) {
                    const postcondition = this._validateAntigravityRefreshPostcondition(config, serviceAdapter);
                    if (!postcondition.ok) {
                        const postconditionError = new Error(`REFRESH_POSTCONDITION_FAILED: ${postcondition.reason}`);
                        postconditionError.code = 'REFRESH_POSTCONDITION_FAILED';
                        postconditionError.skipErrorCount = false;
                        throw postconditionError;
                    }
                }
                if (refreshResult === true) {
                    this._log('info', `Token refresh successful for node ${this._getDisplayName(config)} (Duration: ${duration}ms)`);
                    config.lastRefreshTime = Date.now(); // 记录最后实际刷新成功时间
                } else {
                    this._log('info', `Token refresh no-op for node ${this._getDisplayName(config)} (Already valid)`);
                }
                
                // 刷新流程结束（无论是否真正刷新），重置状态
                config.needsRefresh = false;
                config.refreshCount = 0;
                config.errorCount = 0; // 成功/无操作也重置错误计数
                config.lastHealthStateTime = new Date().toISOString();
                if (isAntigravityProviderType(providerType)) {
                    invalidateServiceAdapter(providerType, config.uuid);
                    void this._probeAntigravityAvailableModels(providerType, providerStatus);
                }
                
                this._debouncedSave(providerType);
            } else {
                throw new Error(`refreshToken method not implemented for ${providerType}`);
            }

        } catch (error) {
            this._log('error', `Token refresh failed for node ${this._getDisplayName(config)}: ${error.message}`);
            
            // 记录错误信息
            if (error.code !== 'STALE_REFRESH_FENCE') {
                config.lastErrorTime = new Date().toISOString();
                config.lastErrorMessage = `Refresh failed: ${error.message}`;
            }
            
            // 增加错误计数（用于普通的健康检查参考，虽然刷新错误主要参考 refreshCount）
            if (error.code !== 'STALE_REFRESH_FENCE') config.errorCount = (config.errorCount || 0) + 1;
            if (error.code !== 'STALE_REFRESH_FENCE') config.lastHealthStateTime = new Date().toISOString();

            // 只有当刷新重试次数达到上限（5次）时，才标记为不健康
            // 注意：refreshCount 在进入本方法后的 try 块前已经自增（L466）
            if (error.code === 'STALE_REFRESH_FENCE') {
                config.needsRefresh = false;
            } else if (error.code === 'REFRESH_POSTCONDITION_FAILED') {
                config.needsRefresh = true;
                config.lastRefreshAttemptTime = Date.now();
                config.lastErrorMessage = error.message;
                this._debouncedSave(providerType);
            } else if (config.refreshCount >= 5) {
                this.markProviderUnhealthyImmediately(providerType, config, `Refresh failed after maximum attempts (5): ${error.message}`);
            } else {
                // 关键修复：重置 needsRefresh 为 false，允许该节点回到池中
                // 这样它才有机会被下一次请求选中，从而再次触发刷新重试
                config.needsRefresh = false;

                // 增加冷却保护：更新 lastRefreshTime，利用 markProviderNeedRefresh 中的 30s 保护逻辑，
                // 防止因瞬时高并发请求导致 5 次重试机会在短时间内被耗尽。
                config.lastRefreshAttemptTime = Date.now();
                
                this._debouncedSave(providerType);
            }
            throw error;
        } finally {
            if (refreshFenceTimer) clearInterval(refreshFenceTimer);
            if (refreshFence !== null) {
                await this.coordination.releaseRefreshFence(providerType, config.uuid, refreshFence).catch(error => {
                    this._log('warn', `Failed to release refresh fence for ${providerType}/${config.uuid}: ${error.message}`);
                });
            }
        }
    }

    _validateAntigravityRefreshPostcondition(providerConfig, serviceAdapter = null) {
        const filePath = providerConfig?.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH;
        if (!filePath) return { ok: false, reason: 'credential_path_missing' };

        try {
            const resolvedPath = path.resolve(filePath);
            const credentials = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
            const expiryTime = Number(credentials.expiry_date);
            if (!credentials.access_token) return { ok: false, reason: 'access_token_missing' };
            if (!Number.isFinite(expiryTime)) return { ok: false, reason: 'expiry_date_invalid' };
            // 安全窗口只用于请求前的提前刷新触发，不用于判断刷新后的授权是否健康。
            // 只要凭据当前仍未过期，就不应因“距离过期不足安全窗口”进入中间异常状态。
            if (expiryTime <= Date.now()) return { ok: false, reason: 'expiry_date_expired' };
            const adapterCredentials = serviceAdapter?.antigravityApiService?.authClient?.credentials
                || serviceAdapter?.authClient?.credentials
                || serviceAdapter?.credentials;
            if (!adapterCredentials?.access_token) return { ok: false, reason: 'adapter_access_token_missing' };
            if (String(adapterCredentials.access_token) !== String(credentials.access_token)) {
                return { ok: false, reason: 'adapter_access_token_mismatch' };
            }
            const adapterExpiryTime = Number(adapterCredentials.expiry_date);
            if (!Number.isFinite(adapterExpiryTime) || adapterExpiryTime !== expiryTime) {
                return { ok: false, reason: 'adapter_expiry_date_mismatch' };
            }
            return { ok: true, expiryTime };
        } catch (error) {
            return { ok: false, reason: error?.code === 'ENOENT' ? 'credential_file_missing' : 'credential_file_invalid' };
        }
    }

    /**
     * 为刷新任务附加超时保护，避免单个适配器调用无限挂起。
     * @private
     */
    async _awaitRefreshWithTimeout(refreshOperation, providerType, displayName) {
        if (this.refreshTaskTimeoutMs <= 0) {
            return await refreshOperation;
        }

        let timeoutId = null;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(`Refresh timeout after ${this.refreshTaskTimeoutMs}ms for node ${displayName} (${providerType})`));
            }, this.refreshTaskTimeoutMs);
        });

        try {
            return await Promise.race([Promise.resolve(refreshOperation), timeoutPromise]);
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    }

    /**
     * 计算节点的权重/评分，用于排序
     * 分数越低，优先级越高
     * @private
     */
    _calculateNodeScore(providerStatus, now = Date.now(), minSeqInPool = -1) {
        const config = providerStatus.config;
        const state = providerStatus.state;
        
        // 1. 基础健康分：不健康的排最后
        if (!config.isHealthy || config.isDisabled) return 1e18;
        
        // 检查并发限制
        const concurrencyLimit = parseInt(config.concurrencyLimit || 0);
        const queueLimit = parseInt(config.queueLimit || 0);
        
        if (concurrencyLimit > 0) {
            if (state.activeCount >= concurrencyLimit) {
                // 如果队列也满了，排在最后（但优于不健康节点）
                if (queueLimit > 0 && state.waitingCount >= queueLimit) {
                    return 1e17;
                }
                // 没满，但需要排队。排队数量越多，权重越大
                return 1e15 + (state.waitingCount || 0) * 1e10;
            }
        }
        
        // 2. 预热/新鲜度判断
        const lastHealthCheckTime = config.lastHealthCheckTime ? new Date(config.lastHealthCheckTime).getTime() : 0;
        const isFresh = lastHealthCheckTime && (now - lastHealthCheckTime < 60000);

        // 3. 计算统一评分
        // 基础分：新鲜节点使用固定负偏移 (-1e14)，普通节点使用上次使用时间 (约 1.7e12)
        const lastUsedTime = config.lastUsed ? new Date(config.lastUsed).getTime() : (now - 86400000);
        const baseScore = isFresh ? -1e14 : lastUsedTime;

        // 惩罚项 A: 近 60 分钟选路负载优先，无近期信号时回退到累计 usageCount
        const usageCount = config.usageCount || 0;
        const recentLoad = this._getProviderSelectionLoad(
            providerStatus.type,
            providerStatus,
            PROVIDER_SELECTION_LOAD_MAX_WINDOW_MS,
            now
        );
        const balanceUnits = recentLoad > 0 ? recentLoad : usageCount;
        const usageScore = balanceUnits * 10000;

        // 惩罚项 B: 相对序列号 (用于打破平局，确保轮询)
        const lastSelectionSeq = config._lastSelectionSeq || 0;
        if (minSeqInPool === -1) {
            const pool = this.providerStatus[providerStatus.type] || [];
            minSeqInPool = pool.reduce((min, p) => Math.min(min, p.config._lastSelectionSeq || 0), Infinity);
        }
        const relativeSeq = Math.max(0, lastSelectionSeq - minSeqInPool);
        const cappedRelativeSeq = Math.min(relativeSeq, 100);
        const sequenceScore = cappedRelativeSeq * 1000;

        // 惩罚项 C: 负载 (每个活跃请求增加 5 秒权重)
        const loadScore = (state.activeCount || 0) * 5000;

        // 新鲜节点的微调：配合 usageScore 和 sequenceScore 在多个新鲜节点间轮询
        const freshBonus = isFresh ? (now - lastHealthCheckTime) : 0;

        return baseScore + usageScore + sequenceScore + loadScore + freshBonus;
    }

    _getMixedProviderPoolConfig(entryProviderType, requestedModel) {
        if (!entryProviderType || !requestedModel || !this.mixedProviderPools || typeof this.mixedProviderPools !== 'object') {
            return null;
        }

        for (const [poolName, rawConfig] of Object.entries(this.mixedProviderPools)) {
            if (!rawConfig || typeof rawConfig !== 'object' || rawConfig.enabled === false) {
                continue;
            }

            const entryProviders = toStringArray(rawConfig.entryProviders || rawConfig.entryProvider);
            if (entryProviders.length > 0 && !entryProviders.includes(entryProviderType)) {
                continue;
            }

            const matchModels = toStringArray(rawConfig.matchModels || rawConfig.models || ['gpt-*']);
            if (!modelMatchesAnyPattern(requestedModel, matchModels)) {
                continue;
            }

            const candidateProviders = toStringArray(rawConfig.candidateProviders || rawConfig.providers);
            if (candidateProviders.length === 0) {
                continue;
            }

            return {
                name: poolName,
                candidateProviders
            };
        }

        return null;
    }

    async _getHealthyProvidersForType(providerType, requestedModel, options = {}) {
        const excludedProviderTypes = new Set(options.excludeProviderTypes || []);
        if (excludedProviderTypes.has(providerType)) {
            return [];
        }

        this._checkAndRecoverScheduledProviders(providerType);

        let candidates;
        if (isAntigravityProviderType(providerType) && Array.isArray(options.antigravityBaseCandidates)) {
            candidates = options.antigravityBaseCandidates.filter(p =>
                p.config.isHealthy && !p.config.isDisabled && !p.config.needsRefresh
            );
        } else {
            const availableProviders = this.providerStatus[providerType] || [];
            candidates = availableProviders.filter(p =>
                p.config.isHealthy && !p.config.isDisabled && !p.config.needsRefresh
            );

            if (Array.isArray(options.allowedProviderUuids)) {
                const allowedProviderUuids = new Set(options.allowedProviderUuids.filter(Boolean).map(String));
                candidates = candidates.filter(p => {
                    const uuid = p.uuid || p.config?.uuid;
                    return allowedProviderUuids.has(uuid);
                });
            }

            const excludedProviderUuids = new Set(options.excludeProviderUuids || []);
            if (excludedProviderUuids.size > 0) {
                candidates = candidates.filter(p => {
                    const uuid = p.uuid || p.config?.uuid;
                    return !excludedProviderUuids.has(uuid);
                });
            }
        }

        if (requestedModel) {
            candidates = candidates.filter(p => {
                const supportedModels = getConfiguredSupportedModels(providerType, p.config);
                if (supportedModels.length > 0) {
                    return supportedModels.includes(requestedModel);
                }
                if (!p.config.notSupportedModels || !Array.isArray(p.config.notSupportedModels)) {
                    return true;
                }
                return !p.config.notSupportedModels.includes(requestedModel);
            });
        }

        if (isCodexProviderType(providerType) && candidates.length > 0) {
            candidates = this._filterCodexProvidersByTokenQuota(providerType, candidates, requestedModel, options.selectionDiagnostics);
        }
        if (isAntigravityProviderType(providerType) && candidates.length > 0) {
            if (!Array.isArray(options.antigravityBaseCandidates)) {
                candidates = this._filterAntigravityProvidersByPlan(providerType, candidates, options.selectionDiagnostics);
            }
            candidates = await this._filterAntigravityProvidersByQuota(
                providerType,
                candidates,
                requestedModel,
                options.selectionDiagnostics,
                options
            );
        }

        return candidates;
    }

    _getAntigravityBaseCandidates(providerType, options = {}) {
        this._checkAndRecoverScheduledProviders(providerType);
        let candidates = (this.providerStatus[providerType] || []).filter(p =>
            p.config.isHealthy && !p.config.isDisabled && !p.config.needsRefresh
        );
        if (Array.isArray(options.allowedProviderUuids)) {
            const allowedProviderUuids = new Set(options.allowedProviderUuids.filter(Boolean).map(String));
            candidates = candidates.filter(p => allowedProviderUuids.has(p.uuid || p.config?.uuid));
        }
        const excludedProviderUuids = new Set(options.excludeProviderUuids || []);
        if (excludedProviderUuids.size > 0) {
            candidates = candidates.filter(p => !excludedProviderUuids.has(p.uuid || p.config?.uuid));
        }
        if (candidates.length > 0) {
            candidates = this._filterAntigravityProvidersByPlan(providerType, candidates, options.selectionDiagnostics);
        }
        return candidates;
    }

    _getCodexPoolSnapshotScope(providerType, bucket) {
        return `codex-pool:${providerType}:${bucket}:${this.providerConfigRevision}`;
    }

    async _getCodex53ExhaustedFastPath(providerType, requestedModel) {
        if (providerType !== 'openai-codex-oauth' || requestedModel !== 'gpt-5.3-codex-spark') return null;
        const providers = this.providerStatus[providerType] || [];
        if (!providers.length) return null;
        await this._hydrateCodexPoolSnapshot(providerType, providers, requestedModel);
        const snapshotKey = `${providerType}:codex53`;
        const snapshot = this._codexPoolExhaustedSnapshots.get(snapshotKey);
        const usageCache = readFreshUsageCacheSync();
        const usageCacheVersion = getCodexUsageCacheVersion(usageCache);
        const now = Date.now();
        const stateFingerprint = this._getCodexPoolStateFingerprint(providers, 'codex53');
        const valid = snapshot
            && snapshot.exhausted === true
            && snapshot.expiresAt > now
            && snapshot.providerConfigRevision === this.providerConfigRevision
            && snapshot.stateFingerprint === stateFingerprint
            && (snapshot.usageCacheVersion || 'none') === usageCacheVersion;
        if (!valid) {
            this._codexQuotaFilterMetrics.fastPathMisses += 1;
            return null;
        }
        this._codexQuotaFilterMetrics.fastPathHits += 1;
        return snapshot;
    }

    _getCodexPoolStateFingerprint(providers, bucket) {
        return providers.map(provider => {
            const config = provider.config || {};
            const quota = config.codexQuotaHealth?.[bucket] || {};
            const cooldown = config.codexRateLimitCooldown?.[bucket] || {};
            return [
                config.uuid || provider.uuid || '',
                config.isHealthy === true,
                config.isDisabled === true,
                config.needsRefresh === true,
                config.codexGeneralMax5hPercent ?? '',
                config.codexGeneralMaxWeeklyPercent ?? '',
                config.codex53Max5hPercent ?? '',
                config.codex53MaxWeeklyPercent ?? '',
                quota.isHealthy === false,
                quota.scheduledRecoveryTime || '',
                cooldown.isCoolingDown === true,
                cooldown.scheduledRecoveryTime || ''
            ].join('|');
        }).sort().join('||');
    }

    async _hydrateCodexPoolSnapshot(providerType, providers, requestedModel) {
        if (!isCodexProviderType(providerType)) return;
        if (!this.coordination?.getRuntimeSnapshot || !providers?.length) return;
        const startedAt = performance.now();
        try {
            await this._hydrateCodexPoolSnapshotUnmetered(providerType, providers, requestedModel);
        } finally {
            accumulateRoutingWait('selectionHydrateMs', performance.now() - startedAt);
        }
    }

    async _hydrateCodexPoolSnapshotUnmetered(providerType, providers, requestedModel) {
        const bucket = resolveCodexQuotaBucket(
            requestedModel,
            toStringArray(this.globalConfig?.CODEX_53_QUOTA_MODEL_PATTERNS || this.globalConfig?.codex53QuotaModelPatterns || DEFAULT_CODEX_53_MODEL_PATTERNS)
        );
        const scope = this._getCodexPoolSnapshotScope(providerType, bucket);
        try {
            const snapshot = await this.coordination.getRuntimeSnapshot(scope);
            if (!snapshot || snapshot.providerConfigRevision !== this.providerConfigRevision) {
                if (this.coordination.acquireRuntimeSnapshotLock) {
                    const owner = await this.coordination.acquireRuntimeSnapshotLock(scope, { ttlMs: 1500 });
                    if (owner) this._codexPoolSnapshotLocks.set(`${providerType}:${bucket}`, { scope, owner });
                    else {
                        for (let attempt = 0; attempt < 3; attempt += 1) {
                            await new Promise(resolve => setTimeout(resolve, 50));
                            const waited = await this.coordination.getRuntimeSnapshot(scope);
                            if (waited && waited.providerConfigRevision === this.providerConfigRevision) {
                                this._applySharedCodexPoolSnapshot(providerType, bucket, providers, waited);
                                return;
                            }
                        }
                    }
                }
                return;
            }
            this._applySharedCodexPoolSnapshot(providerType, bucket, providers, snapshot);
        } catch {
            // Shared coordination is best effort; local filtering remains authoritative.
        }
    }

    _applySharedCodexPoolSnapshot(providerType, bucket, providers, snapshot) {
        const ttlMs = Math.max(500, Number(snapshot.ttlMs) || getCodexQuotaFilterTtlMs(this.globalConfig, Number(snapshot.unavailableCount || 0) > 0));
        if (snapshot.exhausted) {
            this._codexPoolExhaustedSnapshots.set(`${providerType}:${bucket}`, {
                ...snapshot,
                expiresAt: Date.now() + ttlMs
            });
            return;
        }
        const expectedFingerprint = this._getCodexPoolStateFingerprint(providers, bucket);
        if (snapshot.stateFingerprint && snapshot.stateFingerprint !== expectedFingerprint) return;
        this._codexQuotaFilterSnapshots.set(`${providerType}:${bucket}:*`, {
            ...snapshot,
            allowedProviderUuids: Array.isArray(snapshot.allowedProviderUuids) ? snapshot.allowedProviderUuids : [],
            expiresAt: Date.now() + ttlMs,
            crossWorkerReuse: true,
            shared: true
        });
    }

    _hasAcquireCapacity(providerStatus, options = {}) {
        const config = providerStatus.config;
        const state = providerStatus.state;
        const concurrencyLimit = parseInt(config.concurrencyLimit || 0);
        const queueLimit = parseInt(config.queueLimit || 0);

        if (concurrencyLimit <= 0) return true;
        if (state.activeCount < concurrencyLimit) return true;
        if (options.skipCredentialQueue === true) return false;
        return queueLimit > 0 && state.waitingCount < queueLimit;
    }

    _compareProviderCandidates(a, b, requestedModel, options = {}, now = Date.now(), rankOptions = {}) {
        const deprioritizedTypes = new Set(options.deprioritizeProviderTypes || []);
        if (deprioritizedTypes.size > 0) {
            const aDeprioritized = deprioritizedTypes.has(a.type);
            const bDeprioritized = deprioritizedTypes.has(b.type);
            if (aDeprioritized !== bDeprioritized) return aDeprioritized ? 1 : -1;
        }

        const minSeq = Number.isFinite(rankOptions.minSeq)
            ? rankOptions.minSeq
            : Math.min(a.config?._lastSelectionSeq || 0, b.config?._lastSelectionSeq || 0);
        const weighted = rankOptions.weighted === true;

        if (weighted) {
            const weightedUsageA = this._getProviderWeightedBalanceScore(a.type, a, now);
            const weightedUsageB = this._getProviderWeightedBalanceScore(b.type, b, now);
            if (weightedUsageA !== weightedUsageB) return weightedUsageA - weightedUsageB;

            const loadA = a.state?.activeCount || 0;
            const loadB = b.state?.activeCount || 0;
            if (loadA !== loadB) return loadA - loadB;

            const lastUsedA = a.config.lastUsed ? new Date(a.config.lastUsed).getTime() : 0;
            const lastUsedB = b.config.lastUsed ? new Date(b.config.lastUsed).getTime() : 0;
            if (lastUsedA !== lastUsedB) return lastUsedA - lastUsedB;

            const typeCompare = (a.type || '').localeCompare(b.type || '');
            if (typeCompare !== 0) return typeCompare;
            return String(a.uuid || a.config?.uuid || '').localeCompare(String(b.uuid || b.config?.uuid || ''));
        }

        const scoreA = this._calculateNodeScore(a, now, minSeq);
        const scoreB = this._calculateNodeScore(b, now, minSeq);
        if (scoreA !== scoreB) return scoreA - scoreB;
        const typeCompare = (a.type || '').localeCompare(b.type || '');
        if (typeCompare !== 0) return typeCompare;
        return String(a.uuid || a.config?.uuid || '').localeCompare(String(b.uuid || b.config?.uuid || ''));
    }

    _selectFromMixedCandidates(candidates, requestedModel, options = {}) {
        if (candidates.length === 0) return null;

        const deprioritizedTypes = new Set(options.deprioritizeProviderTypes || []);
        if (deprioritizedTypes.size > 0) {
            const preferredCandidates = candidates.filter(p => !deprioritizedTypes.has(p.type));
            if (preferredCandidates.length > 0) {
                candidates = preferredCandidates;
            }
        }

        const now = Date.now();
        const minSeq = Math.min(...candidates.map(p => p.config._lastSelectionSeq || 0));
        const weighted = hasCustomProviderWeights(candidates);

        let selected;
        if (options.stickyProviderKey) {
            selected = selectWeightedStickyProvider(
                candidates,
                `mixed:${requestedModel || ''}:${options.stickyProviderKey}`
            );
        } else {
            selected = [...candidates].sort((a, b) => this._compareProviderCandidates(
                a,
                b,
                requestedModel,
                options,
                now,
                { minSeq, weighted }
            ))[0];
        }

        selected.config.lastUsed = new Date().toISOString();
        this._selectionSequence++;
        selected.config._lastSelectionSeq = this._selectionSequence;

        if (!options.skipUsageCount) {
            selected.config.usageCount++;
        }

        this._recordProviderSelectionLoad(selected.type, selected, now);
        this._debouncedSave(selected.type);
        return selected;
    }

    async selectProviderFromMixedPool(providerType, requestedModel = null, options = {}) {
        const mixedPool = this._getMixedProviderPoolConfig(providerType, requestedModel);
        if (!mixedPool) return null;

        const candidates = [];
        for (const candidateType of mixedPool.candidateProviders) {
            try {
                const candidateProviders = this.providerStatus[candidateType] || [];
                await this._hydrateCodexPoolSnapshot(candidateType, candidateProviders, requestedModel);
                const providers = await this._getHealthyProvidersForType(candidateType, requestedModel, options);
                candidates.push(...providers);
            } catch (error) {
                if (error.status === 429 || error.code === 429) {
                    this._log('info', `Mixed pool ${mixedPool.name} skipping busy/limited type ${candidateType}: ${error.message}`);
                    continue;
                }
                throw error;
            }
        }

        const selected = this._selectFromMixedCandidates(candidates, requestedModel, options);
        if (!selected) {
            this._log('warn', `No available provider found in mixed pool ${mixedPool.name} for ${providerType} (${requestedModel})`);
            return null;
        }

        this._log('info', `Mixed pool ${mixedPool.name} selected ${selected.type}: ${this._getDisplayName(selected.config)}${requestedModel ? ` for model: ${requestedModel}` : ''}`);
        return {
            config: selected.config,
            actualProviderType: selected.type,
            isFallback: false,
            isMixedPool: true
        };
    }

    async acquireSlotFromMixedPool(providerType, requestedModel = null, options = {}) {
        const mixedPool = this._getMixedProviderPoolConfig(providerType, requestedModel);
        if (!mixedPool) return null;

        const candidates = [];
        for (const candidateType of mixedPool.candidateProviders) {
            try {
                const candidateProviders = this.providerStatus[candidateType] || [];
                await this._hydrateCodexPoolSnapshot(candidateType, candidateProviders, requestedModel);
                const providers = (await this._getHealthyProvidersForType(candidateType, requestedModel, options))
                    .filter(provider => this._hasAcquireCapacity(provider, options));
                candidates.push(...providers);
            } catch (error) {
                if (error.status === 429 || error.code === 429) {
                    this._log('info', `Mixed pool ${mixedPool.name} skipping busy/limited type ${candidateType}: ${error.message}`);
                    continue;
                }
                throw error;
            }
        }

        if (this.coordination) {
            const ordered = this._orderCoordinatedCandidates(candidates, providerType, requestedModel, options);
            const hasStickyAffinity = Boolean(options.stickyProviderKey);
            const coordinatedCandidates = ordered.map((provider, index) => ({
                providerType: provider.type,
                uuid: provider.uuid || provider.config?.uuid,
                concurrencyLimit: parseInt(provider.config?.concurrencyLimit || 0),
                preferred: hasStickyAffinity && index === 0,
                probeRequired: false
            }));
            const leaseStartedAt = performance.now();
            const lease = hasStickyAffinity
                ? await this.coordination.acquire(coordinatedCandidates, {
                    affinityKey: `mixed:${providerType}:${requestedModel || ''}:${options.stickyProviderKey}`,
                    requestedModel
                })
                : await this.coordination.acquire(coordinatedCandidates, { requestedModel });
            const leaseWaitMs = performance.now() - leaseStartedAt;
            requestContext.get('runtimeRequest')?.recordStage?.('redisLeaseMs', leaseWaitMs);
            accumulateRoutingWait('credentialLeaseWaitMs', leaseWaitMs);
            if (!lease) return null;
            const selected = this._findProvider(lease.providerType, lease.uuid);
            if (!selected) {
                await this.coordination.release(lease.leaseId);
                return null;
            }
            const store = requestContext.getStore();
            store.providerLeases = store.providerLeases || new Map();
            store.providerLeases.set(`${lease.providerType}:${lease.uuid}`, lease.leaseId);
            selected.config.lastUsed = new Date().toISOString();
            return {
                config: selected.config,
                actualProviderType: selected.type,
                isFallback: false,
                isMixedPool: true
            };
        }

        const selected = this._selectFromMixedCandidates(candidates, requestedModel, { ...options, skipUsageCount: true });
        if (!selected) {
            this._log('warn', `No available slot found in mixed pool ${mixedPool.name} for ${providerType} (${requestedModel})`);
            return null;
        }

        const acquiredConfig = await this._acquireSelectedProviderSlot(selected, options);
        this._log('info', `Mixed pool ${mixedPool.name} acquired ${selected.type}: ${this._getDisplayName(acquiredConfig)}${requestedModel ? ` for model: ${requestedModel}` : ''}`);
        return {
            config: acquiredConfig,
            actualProviderType: selected.type,
            isFallback: false,
            isMixedPool: true
        };
    }

    async _acquireSelectedProviderSlot(provider, options = {}) {
        const config = provider.config;
        const state = provider.state;
        const concurrencyLimit = parseInt(config.concurrencyLimit || 0);
        const queueLimit = parseInt(config.queueLimit || 0);

        if (concurrencyLimit <= 0) {
            state.activeCount++;
            return config;
        }

        if (state.activeCount < concurrencyLimit) {
            state.activeCount++;
            return config;
        }

        if (queueLimit > 0 && state.waitingCount < queueLimit) {
            this._log('info', `[Concurrency] Node ${this._getDisplayName(config)} busy (${state.activeCount}/${concurrencyLimit}), enqueuing request (queue: ${state.waitingCount + 1}/${queueLimit})`);

            state.waitingCount++;
            try {
                await new Promise((resolve, reject) => {
                    const timeoutMs = options.queueTimeout || 300000;
                    const timeout = setTimeout(() => {
                        const idx = state.queue.indexOf(handler);
                        if (idx !== -1) {
                            state.queue.splice(idx, 1);
                            reject(new Error(`Queue timeout after ${timeoutMs / 1000}s`));
                        }
                    }, timeoutMs);

                    const handler = () => {
                        clearTimeout(timeout);
                        resolve();
                    };
                    state.queue.push(handler);
                });
            } finally {
                state.waitingCount--;
            }

            state.activeCount++;
            return config;
        }

        this._log('warn', `[Concurrency] Node ${this._getDisplayName(config)} full capacity (${state.activeCount}/${concurrencyLimit}, queue: ${state.waitingCount}/${queueLimit}), returning 429`);
        const error = new Error('Too many requests: account concurrency limit and queue reached');
        error.status = 429;
        error.code = 429;
        error.details = { reason: 'PROVIDER_QUEUE_EXHAUSTED' };
        throw error;
    }

    /**
     * 获取指定类型的健康节点数量
     */
    getHealthyCount(providerType) {
        return (this.providerStatus[providerType] || []).filter(p => p.config.isHealthy && !p.config.isDisabled).length;
    }

    /**
     * 日志输出方法，支持日志级别控制
     * @private
     */
    _log(level, message) {
        const levels = { debug: 0, info: 1, warn: 2, error: 3 };
        if (levels[level] >= levels[this.logLevel]) {
            logger[level](`[ProviderPoolManager] ${message}`);
        }
    }

    /**
     * 获取节点的显示名称（优先显示自定义名称/别名）
     * @param {object} config - 节点配置对象
     * @returns {string} 显示名称
     * @private
     */
    _getDisplayName(config) {
        if (!config) return 'unknown';
        return config.customName || (config.uuid ? config.uuid.substring(0, 8) : 'unknown');
    }

    /**
     * 记录健康状态变化日志
     * @param {string} providerType - 提供商类型
     * @param {object} providerConfig - 提供商配置
     * @param {string} fromStatus - 之前状态
     * @param {string} toStatus - 当前状态
     * @param {string} [errorMessage] - 错误信息（可选）
     * @private
     */
    _logHealthStatusChange(providerType, providerConfig, fromStatus, toStatus, errorMessage = null) {
        const customName = providerConfig.customName || providerConfig.uuid;
        const timestamp = new Date().toISOString();
        
        const logEntry = {
            timestamp,
            providerType,
            uuid: providerConfig.uuid,
            customName,
            fromStatus,
            toStatus,
            errorMessage,
            usageCount: providerConfig.usageCount || 0,
            errorCount: providerConfig.errorCount || 0
        };
        
        // 输出详细的状态变化日志
        if (toStatus === 'unhealthy') {
            logger.warn(`[HealthMonitor] ⚠️ Provider became UNHEALTHY: ${customName} (${providerType})`);
            logger.warn(`[HealthMonitor]    Reason: ${errorMessage || 'Unknown'}`);
            logger.warn(`[HealthMonitor]    Error Count: ${providerConfig.errorCount}`);
            
            // 触发告警（如果配置了 Webhook）
            this._triggerHealthAlert(providerType, providerConfig, 'unhealthy', errorMessage);
        } else if (toStatus === 'healthy' && fromStatus === 'unhealthy') {
            logger.info(`[HealthMonitor] ✅ Provider recovered to HEALTHY: ${customName} (${providerType})`);
            
            // 触发恢复通知
            this._triggerHealthAlert(providerType, providerConfig, 'recovered', null);
        }
        
        // 广播健康状态变化事件
        broadcastEvent('health_status_change', logEntry);
    }

    /**
     * 触发健康状态告警
     * @param {string} providerType - 提供商类型
     * @param {object} providerConfig - 提供商配置
     * @param {string} status - 状态 ('unhealthy' | 'recovered')
     * @param {string} [errorMessage] - 错误信息
     * @private
     */
    async _triggerHealthAlert(providerType, providerConfig, status, errorMessage = null) {
        const webhookUrl = this.globalConfig?.HEALTH_ALERT_WEBHOOK_URL;
        if (!webhookUrl) {
            return; // 未配置 Webhook，跳过
        }
        
        const customName = providerConfig.customName || providerConfig.uuid;
        const payload = {
            timestamp: new Date().toISOString(),
            providerType,
            uuid: providerConfig.uuid,
            customName,
            status,
            errorMessage,
            stats: {
                usageCount: providerConfig.usageCount || 0,
                errorCount: providerConfig.errorCount || 0
            }
        };
        
        try {
            const axios = (await import('axios')).default;
            await axios.post(webhookUrl, payload, {
                timeout: 5000,
                headers: { 'Content-Type': 'application/json' }
            });
            this._log('info', `Health alert sent to webhook for ${customName}: ${status}`);
        } catch (error) {
            this._log('error', `Failed to send health alert to webhook: ${error.message}`);
        }
    }

    /**
     * 查找指定的 provider
     * @private
     */
    _findProvider(providerType, uuid) {
        if (!providerType || !uuid) {
            this._log('error', `Invalid parameters: providerType=${providerType}, uuid=${uuid}`);
            return null;
        }
        const pool = this.providerStatus[providerType];
        return pool?.find(p => p.uuid === uuid) || null;
    }

    /**
     * 根据 UUID 在所有池中查找提供商配置
     * @param {string} uuid - 提供商 UUID
     * @returns {object|null} 提供商配置对象或 null
     */
    findProviderByUuid(uuid) {
        if (!uuid) return null;
        for (const type in this.providerStatus) {
            const provider = this.providerStatus[type].find(p => p.uuid === uuid);
            if (provider) return provider.config;
        }
        return null;
    }

    /**
     * Initializes the status for each provider in the pools.
     * Initially, all providers are considered healthy and have zero usage.
     * @param {boolean} syncFromConfig - 是否强制从配置同步统计数据（不保留内存中的旧数据）
     */
    initializeProviderStatus(syncFromConfig = false) {
        const oldFullStatus = this.providerStatus || {};
        const isColdStart = Object.keys(oldFullStatus).length === 0;
        this.providerStatus = {}; // Tracks health and usage for each provider instance
        for (const providerType in this.providerPools) {
            const oldStatus = oldFullStatus[providerType] || [];
            this.providerStatus[providerType] = [];
            this.roundRobinIndex[providerType] = 0; // Initialize round-robin index for each type
            // 只有在锁不存在时才初始化，避免在运行中被重置导致并发问题
            if (!this._selectionLocks[providerType]) {
                this._selectionLocks[providerType] = Promise.resolve();
            }
            
            const pool = this.providerPools[providerType];
            
            // 如果是同步配置，主动使该类型下所有已有的服务适配器失效，确保代理等设置能即时生效
            if (syncFromConfig) {
                this._log('info', `Syncing config for type ${providerType}, invalidating existing service adapters to apply new proxy settings.`);
                pool.forEach(config => {
                    if (config.uuid) {
                        invalidateServiceAdapter(providerType, config.uuid);
                    }
                });
            }
            
            pool.forEach((providerConfig) => {
                try {
                    // 尝试从旧状态中恢复活跃请求计数和队列，避免重载配置时重置并发限制
                    const existing = oldStatus.find(p => p.uuid === providerConfig.uuid);

                    // Ensure initial health and usage stats are present in the config
                    providerConfig.isHealthy = providerConfig.isHealthy !== undefined ? providerConfig.isHealthy : true;
                    providerConfig.isDisabled = providerConfig.isDisabled !== undefined ? providerConfig.isDisabled : false;
                    
                    // --- V3: 统计数据管理 ---
                    if (isColdStart && !syncFromConfig) {
                        // 冷启动：清空所有统计数据，确保重启后计数重置
                        providerConfig.lastUsed = null;
                        providerConfig.lastSuccessTime = providerConfig.lastSuccessTime || null;
                        providerConfig.lastHealthStateTime = providerConfig.lastHealthStateTime || null;
                        providerConfig.usageCount = 0;
                        providerConfig.errorCount = 0;
                        // providerConfig.lastErrorTime = null;
                        // providerConfig.lastErrorMessage = null;
                    } else if (syncFromConfig) {
                        // 强制同步：从配置中恢复统计数据
                        providerConfig.lastUsed = providerConfig.lastUsed || null;
                        providerConfig.lastSuccessTime = providerConfig.lastSuccessTime || null;
                        providerConfig.lastHealthStateTime = providerConfig.lastHealthStateTime || null;
                        providerConfig.usageCount = providerConfig.usageCount || 0;
                        providerConfig.errorCount = providerConfig.errorCount || 0;
                        providerConfig.lastErrorTime = providerConfig.lastErrorTime || null;
                        providerConfig.lastErrorMessage = providerConfig.lastErrorMessage || null;
                    } else if (existing) {
                        // 热重载：从旧状态中恢复统计数据，避免被配置文件中的旧数据覆盖
                        providerConfig.lastUsed = existing.config.lastUsed;
                        providerConfig.lastSuccessTime = existing.config.lastSuccessTime;
                        providerConfig.lastHealthStateTime = existing.config.lastHealthStateTime;
                        providerConfig.usageCount = existing.config.usageCount;
                        providerConfig.errorCount = existing.config.errorCount;
                        providerConfig.lastErrorTime = existing.config.lastErrorTime;
                        providerConfig.lastErrorMessage = existing.config.lastErrorMessage;
                    } else {
                        // 新增节点或默认初始化
                        providerConfig.lastUsed = providerConfig.lastUsed || null;
                        providerConfig.lastSuccessTime = providerConfig.lastSuccessTime || null;
                        providerConfig.lastHealthStateTime = providerConfig.lastHealthStateTime || null;
                        providerConfig.usageCount = providerConfig.usageCount || 0;
                        providerConfig.errorCount = providerConfig.errorCount || 0;
                    }
                    
                    // --- V2: 刷新监控字段 ---
                    const persistedNeedsRefresh = providerConfig.needsRefresh !== undefined ? providerConfig.needsRefresh : false;
                    const persistedRefreshCount = providerConfig.refreshCount !== undefined ? providerConfig.refreshCount : 0;
                    if (isColdStart && (persistedNeedsRefresh || persistedRefreshCount > 0)) {
                        this._log('info', `Resetting stale refresh state for provider ${this._getDisplayName(providerConfig)} (${providerType}) on startup.`);
                    }
                    providerConfig.needsRefresh = isColdStart ? false : persistedNeedsRefresh;
                    providerConfig.refreshCount = isColdStart ? 0 : persistedRefreshCount;
                    
                    // 优化2: 简化 lastErrorTime 处理逻辑
                    providerConfig.lastErrorTime = providerConfig.lastErrorTime instanceof Date
                        ? providerConfig.lastErrorTime.toISOString()
                        : (providerConfig.lastErrorTime || null);
                    
                    // 健康检测相关字段
                    providerConfig.lastHealthCheckTime = providerConfig.lastHealthCheckTime || null;
                    providerConfig.lastHealthCheckModel = providerConfig.lastHealthCheckModel || null;
                    providerConfig.lastErrorMessage = providerConfig.lastErrorMessage || null;
                    providerConfig.customName = providerConfig.customName || null;
                    providerConfig.providerWeight = getProviderWeight(providerConfig);
                    delete providerConfig.weight;

                    // Quota exhaustion is bucket-scoped and must not leave a
                    // persisted Codex credential looking auth-unhealthy.
                    if (isCodexProviderType(providerType)
                        && providerConfig.isDisabled !== true
                        && providerConfig.isHealthy === false
                        && isCodexQuotaExhaustionMessage(providerConfig.lastErrorMessage)) {
                        providerConfig.isHealthy = true;
                        providerConfig.errorCount = 0;
                        providerConfig.lastErrorTime = null;
                        providerConfig.lastErrorMessage = null;
                        providerConfig.scheduledRecoveryTime = null;
                        providerConfig.lastHealthStateTime = new Date().toISOString();
                        this._log('info', `Repaired persisted Codex quota-only health state for ${this._getDisplayName(providerConfig)}`);
                    }

                    this.providerStatus[providerType].push({
                        config: providerConfig,
                        uuid: providerConfig.uuid, // Still keep uuid at the top level for easy access
                        type: providerType, // 保存 providerType 引用
                        state: existing ? existing.state : {
                            activeCount: 0,
                            waitingCount: 0,
                            queue: []
                        }
                    });
                } catch (nodeError) {
                    logger.error(`[ProviderPoolManager] Error initializing node for ${providerType}: ${nodeError.message}`);
                }
            });
            
            // 确保初始化时的默认值补全也能写盘
            this._debouncedSave(providerType);
        }
        this._log('info', `Initialized provider statuses: ok (maxErrorCount: ${this.maxErrorCount})`);
    }

    /**
     * 获取一个可用的提供商插槽，考虑并发限制和队列
     * @param {string} providerType 
     * @param {string} requestedModel 
     * @param {object} options 
     */
    async acquireSlot(providerType, requestedModel = null, options = {}) {
        if (this.coordination) {
            await this._hydrateCodexPoolSnapshot(providerType, this.providerStatus[providerType] || [], requestedModel);
            const healthyProviders = await this._getHealthyProvidersForType(providerType, requestedModel, options);
            const ordered = this._orderCoordinatedCandidates(
                healthyProviders,
                providerType,
                requestedModel,
                options
            );
            const hasStickyAffinity = Boolean(options.stickyProviderKey) && isCodexProviderType(providerType);
            const hotShardProvider = hasStickyAffinity
                ? await this._selectCodexHotShardProvider(
                    healthyProviders,
                    providerType,
                    requestedModel,
                    options,
                    Date.now()
                )
                : null;
            const candidates = ordered.map((provider, index) => ({
                    providerType,
                    uuid: provider.uuid || provider.config?.uuid,
                    concurrencyLimit: parseInt(provider.config?.concurrencyLimit || 0),
                    preferred: hasStickyAffinity && index === 0,
                    probeRequired: false
                }));
            const leaseStartedAt = performance.now();
            const lease = hasStickyAffinity
                ? await this.coordination.acquire(candidates, {
                    affinityKey: `${providerType}:${requestedModel || ''}:${options.stickyProviderKey}`,
                    requestedModel,
                    routedProviderKey: hotShardProvider
                        ? `${providerType}:${hotShardProvider.uuid || hotShardProvider.config?.uuid}`
                        : ''
                })
                : await this.coordination.acquire(candidates, { requestedModel });
            const leaseWaitMs = performance.now() - leaseStartedAt;
            requestContext.get('runtimeRequest')?.recordStage?.('redisLeaseMs', leaseWaitMs);
            accumulateRoutingWait('credentialLeaseWaitMs', leaseWaitMs);
            if (!lease) return null;
            const selected = this._findProvider(lease.providerType, lease.uuid);
            if (!selected) {
                await this.coordination.release(lease.leaseId);
                return null;
            }
            const store = requestContext.getStore();
            store.providerLeases = store.providerLeases || new Map();
            store.providerLeases.set(`${lease.providerType}:${lease.uuid}`, lease.leaseId);
            selected.config.lastUsed = new Date().toISOString();
            if (!options.skipUsageCount) {
                selected.config.usageCount = (selected.config.usageCount || 0) + 1;
            }
            this._recordProviderSelectionLoad(lease.providerType, selected, Date.now());
            return selected.config;
        }
        // 使用 selectProvider 进行初次选择（评分逻辑已经包含了并发考虑）
        const selectedConfig = await this.selectProvider(providerType, requestedModel, { ...options, skipUsageCount: true });
        
        if (!selectedConfig) {
            return null;
        }

        const provider = this._findProvider(providerType, selectedConfig.uuid);
        if (!provider) return selectedConfig;

        const config = provider.config;
        const state = provider.state;
        const concurrencyLimit = parseInt(config.concurrencyLimit || 0);
        const queueLimit = parseInt(config.queueLimit || 0);

        // 如果没有限制，直接增加活跃计数并返回
        if (concurrencyLimit <= 0) {
            state.activeCount++;
            return config;
        }

        // 检查是否在并发限制内
        if (state.activeCount < concurrencyLimit) {
            state.activeCount++;
            return config;
        }

        // 超过并发限制，尝试进入队列
        if (queueLimit > 0 && state.waitingCount < queueLimit) {
            this._log('info', `[Concurrency] Node ${this._getDisplayName(config)} busy (${state.activeCount}/${concurrencyLimit}), enqueuing request (queue: ${state.waitingCount + 1}/${queueLimit})`);
            
            state.waitingCount++;
            try {
                // 等待释放信号
                await new Promise((resolve, reject) => {
                    // 设置较短的超时用于测试验证，或者由外部控制
                    const timeoutMs = options.queueTimeout || 300000;
                    const timeout = setTimeout(() => {
                        const idx = state.queue.indexOf(handler);
                        if (idx !== -1) {
                            state.queue.splice(idx, 1);
                            reject(new Error(`Queue timeout after ${timeoutMs/1000}s`));
                        }
                    }, timeoutMs);

                    const handler = () => {
                        clearTimeout(timeout);
                        resolve();
                    };
                    state.queue.push(handler);
                });
            } finally {
                state.waitingCount--;
            }

            // 获得信号后，增加活跃计数
            state.activeCount++;
            return config;
        }

        // 队列也满了
        this._log('warn', `[Concurrency] Node ${this._getDisplayName(config)} full capacity (${state.activeCount}/${concurrencyLimit}, queue: ${state.waitingCount}/${queueLimit}), returning 429`);
        const error = new Error('Too many requests: account concurrency limit and queue reached');
        error.status = 429;
        error.code = 429;
        error.details = { reason: 'PROVIDER_QUEUE_EXHAUSTED' };
        throw error;
    }

    /**
     * 释放提供商插槽
     */
    releaseSlot(providerType, uuid) {
        if (!providerType || !uuid) return;

        const keyLease = requestContext.get('potluckKeyConcurrencyLease');
        if (keyLease) {
            requestContext.set('potluckKeyConcurrencyLease', null);
            Promise.resolve(keyLease.release()).catch(error => this._log('warn', `[Potluck Key Concurrency] release failed: ${error.message}`));
        }

        if (this.coordination) {
            const leases = requestContext.get('providerLeases');
            const key = `${providerType}:${uuid}`;
            const leaseId = leases?.get(key);
            if (!leaseId) return false;
            leases.delete(key);
            const released = this.coordination.release(leaseId).catch(error => {
                this._log('warn', `[Coordination] Lease release deferred to TTL for ${key}: ${error.message}`);
                return false;
            });
            this._notifyGeminiElasticWaiters(providerType);
            return released;
        }
        
        const provider = this._findProvider(providerType, uuid);
        if (!provider) return;

        const state = provider.state;
        if (state.activeCount > 0) {
            state.activeCount--;
        }

        // 如果队列中有等待的任务，释放下一个
        if (state.queue && state.queue.length > 0) {
            const next = state.queue.shift();
            if (next) {
                // 异步触发
                setImmediate(next);
            }
        }
        this._notifyGeminiElasticWaiters(providerType);
    }

    /**
     * Selects a provider from the pool for a given provider type.
     * Currently uses a simple round-robin for healthy providers.
     * If requestedModel is provided, providers that don't support the model will be excluded.
     *
     * 注意：此方法现在返回 Promise，使用互斥锁确保并发安全。
     *
     * @param {string} providerType - The type of provider to select (e.g., 'gemini-cli', 'openai-custom').
     * @param {string} [requestedModel] - Optional. The model name to filter providers by.
     * @returns {Promise<object|null>} The selected provider's configuration, or null if no healthy provider is found.
     */
    async selectProvider(providerType, requestedModel = null, options = {}) {
        // 参数校验
        if (!providerType || typeof providerType !== 'string') {
            this._log('error', `Invalid providerType: ${providerType}`);
            return null;
        }

        const selectionStartedAt = Date.now();
        const callerDiagnostics = options.selectionDiagnostics;
        const attemptDiagnostics = callerDiagnostics ? {} : null;
        const attemptOptions = attemptDiagnostics
            ? { ...options, selectionDiagnostics: attemptDiagnostics }
            : options;
 
        // 使用标志位 + 异步等待实现更强力的互斥锁
        // 这种方式能更好地处理同一微任务循环内的并发
        while (this._isSelecting[providerType]) {
            await new Promise(resolve => setImmediate(resolve));
        }
        
        this._isSelecting[providerType] = true;
        
        try {
            // 在锁内部串行执行选择；Redis 热度统计可能需要异步协调
            return await this._doSelectProvider(providerType, requestedModel, attemptOptions);
        } finally {
            this._isSelecting[providerType] = false;
            if (callerDiagnostics && attemptDiagnostics) {
                const attempts = Array.isArray(callerDiagnostics.attempts)
                    ? callerDiagnostics.attempts
                    : [];
                attempts.push({ ...attemptDiagnostics });
                Object.assign(callerDiagnostics, attemptDiagnostics, { attempts });
                callerDiagnostics.capacityExhausted = attempts.some(attempt => attempt.capacityExhausted === true);
            }
            this._logSlowProviderSelection(providerType, requestedModel, selectionStartedAt);
        }
    }

    _getProviderSelectionSlowWarnMs() {
        return getPositiveIntegerConfig(
            this.globalConfig?.CODEX_PROVIDER_SELECTION_SLOW_WARN_MS,
            DEFAULT_PROVIDER_SELECTION_SLOW_WARN_MS
        );
    }

    _logSlowProviderSelection(providerType, requestedModel, startedAt) {
        const elapsedMs = Date.now() - startedAt;
        const thresholdMs = this._getProviderSelectionSlowWarnMs();
        if (elapsedMs < thresholdMs) return;

        this._log(
            'warn',
            `Slow provider selection for ${providerType}${requestedModel ? `/${requestedModel}` : ''}: ${elapsedMs}ms (threshold=${thresholdMs}ms)`
        );
    }

    /**
     * 实际执行 provider 选择的内部方法（由锁保护）
     * @private
     */
    async _doSelectProvider(providerType, requestedModel, options) {
        const availableProviders = this.providerStatus[providerType] || [];
        const selectionDiagnostics = options.selectionDiagnostics;
        if (selectionDiagnostics) {
            Object.assign(selectionDiagnostics, {
                totalCandidateCount: availableProviders.length,
                healthCooldownSkipped: 0,
                temporaryCooldownSkipped: 0,
                nextTemporaryRecoveryTime: null,
                concurrencyLimitSkipped: 0,
                eligibleCandidateCount: 0,
                capacityExhausted: false,
                filterReasons: {},
                hotShardApplied: false
            });
        }
        
        // 检查并恢复已到恢复时间的提供商
        this._checkAndRecoverScheduledProviders(providerType);
        
        // 获取固定时间戳，确保排序过程中一致
        const now = Date.now();

        if (selectionDiagnostics) {
            const temporaryRecoveryTimes = availableProviders
                .filter(provider => provider.config.isHealthy === false && !provider.config.isDisabled)
                .map(provider => Date.parse(provider.config.scheduledRecoveryTime || ''))
                .filter(recoveryTime => Number.isFinite(recoveryTime) && recoveryTime > now);
            selectionDiagnostics.temporaryCooldownSkipped = temporaryRecoveryTimes.length;
            if (temporaryRecoveryTimes.length > 0) {
                selectionDiagnostics.nextTemporaryRecoveryTime = new Date(Math.min(...temporaryRecoveryTimes)).toISOString();
            }
        }
        
        // 提前计算池中最小序列号，避免在排序算法中重复 O(N) 计算
        const minSeq = Math.min(...availableProviders.map(p => p.config._lastSelectionSeq || 0));

        let availableAndHealthyProviders = availableProviders.filter(p =>
            p.config.isHealthy && !p.config.isDisabled && !p.config.needsRefresh
        );
        if (selectionDiagnostics) {
            selectionDiagnostics.healthCooldownSkipped = availableProviders.length - availableAndHealthyProviders.length;
            const healthReasons = {};
            for (const provider of availableProviders) {
                if (provider.config.isDisabled) healthReasons.disabled = (healthReasons.disabled || 0) + 1;
                else if (provider.config.needsRefresh) healthReasons.needs_refresh = (healthReasons.needs_refresh || 0) + 1;
                else if (!provider.config.isHealthy) healthReasons.unhealthy = (healthReasons.unhealthy || 0) + 1;
            }
            selectionDiagnostics.filterReasons = {
                ...(selectionDiagnostics.filterReasons || {}),
                ...healthReasons
            };
        }

        if (Array.isArray(options.allowedProviderUuids)) {
            const allowedProviderUuids = new Set(options.allowedProviderUuids.filter(Boolean).map(String));
            availableAndHealthyProviders = availableAndHealthyProviders.filter(p => {
                const uuid = p.uuid || p.config?.uuid;
                return allowedProviderUuids.has(uuid);
            });
        }

        const excludedProviderUuids = new Set(options.excludeProviderUuids || []);
        if (excludedProviderUuids.size > 0) {
            availableAndHealthyProviders = availableAndHealthyProviders.filter(p => {
                const uuid = p.uuid || p.config?.uuid;
                return !excludedProviderUuids.has(uuid);
            });
        }

        // 如果指定了模型，则排除不支持该模型的提供商
        if (requestedModel) {
            const modelFilteredProviders = availableAndHealthyProviders.filter(p => {
                const supportedModels = getConfiguredSupportedModels(providerType, p.config);
                if (supportedModels.length > 0) {
                    return supportedModels.includes(requestedModel);
                }
                // 如果提供商没有配置 notSupportedModels，则认为它支持所有模型
                if (!p.config.notSupportedModels || !Array.isArray(p.config.notSupportedModels)) {
                    return true;
                }
                // 检查 notSupportedModels 数组中是否包含请求的模型，如果包含则排除
                return !p.config.notSupportedModels.includes(requestedModel);
            });

            if (modelFilteredProviders.length === 0) {
                if (selectionDiagnostics && availableAndHealthyProviders.length > 0) {
                    selectionDiagnostics.filterReasons = {
                        ...(selectionDiagnostics.filterReasons || {}),
                        model_unsupported: availableAndHealthyProviders.length
                    };
                }
                this._log('warn', `No available providers for type: ${providerType} that support model: ${requestedModel}`);
                return null;
            }

            availableAndHealthyProviders = modelFilteredProviders;
            this._log('debug', `Filtered ${modelFilteredProviders.length} providers supporting model: ${requestedModel}`);
        }

        if (availableAndHealthyProviders.length === 0) {
            this._log('warn', `No available and healthy providers for type: ${providerType}`);
            return null;
        }

        if (isCodexProviderType(providerType)) {
            await this._hydrateCodexPoolSnapshot(providerType, this.providerStatus[providerType] || availableAndHealthyProviders, requestedModel);
            availableAndHealthyProviders = this._filterCodexProvidersByTokenQuota(providerType, availableAndHealthyProviders, requestedModel, selectionDiagnostics);
        }
        if (isAntigravityProviderType(providerType)) {
            if (!Array.isArray(options.antigravityBaseCandidates)) {
                availableAndHealthyProviders = this._filterAntigravityProvidersByPlan(providerType, availableAndHealthyProviders, selectionDiagnostics);
            }
            availableAndHealthyProviders = await this._filterAntigravityProvidersByQuota(
                providerType,
                availableAndHealthyProviders,
                requestedModel,
                selectionDiagnostics,
                options
            );
        }

        if (options.acquireSlot === true) {
            const beforeConcurrencyFilter = availableAndHealthyProviders.length;
            availableAndHealthyProviders = availableAndHealthyProviders.filter(provider => this._hasAcquireCapacity(provider, options));
            if (selectionDiagnostics) {
                selectionDiagnostics.concurrencyLimitSkipped = beforeConcurrencyFilter - availableAndHealthyProviders.length;
                selectionDiagnostics.capacityExhausted = beforeConcurrencyFilter > 0
                    && availableAndHealthyProviders.length === 0
                    && selectionDiagnostics.concurrencyLimitSkipped === beforeConcurrencyFilter;
            }
        }
        if (selectionDiagnostics) {
            selectionDiagnostics.eligibleCandidateCount = availableAndHealthyProviders.length;
        }

        if (availableAndHealthyProviders.length === 0) {
            this._log('warn', `No normally schedulable providers for type: ${providerType}`);
            return null;
        }

        let selected;
        if (options.preferredProviderUuid) {
            selected = availableAndHealthyProviders.find(provider =>
                (provider.uuid || provider.config?.uuid) === options.preferredProviderUuid
            );
            if (selected) {
                this._log('debug', `Selected preferred provider for ${providerType}: ${this._getDisplayName(selected.config)}`);
            }
        }
        if (!selected && options.routingStrategy === 'image-round-robin') {
            selected = this._selectImageRoundRobinProvider(
                availableAndHealthyProviders,
                providerType,
                requestedModel
            );
        } else if (!selected && options.routingMode === 'pool' && options.poolKeyId) {
            const schedulerKey = `${options.poolKeyId}:${providerType}:${requestedModel || ''}`;
            let scheduler = this._poolKeySchedulers.get(schedulerKey);
            if (!scheduler) {
                scheduler = new SmoothWeightedRoundRobin();
                this._poolKeySchedulers.set(schedulerKey, scheduler);
            }
            for (const provider of availableAndHealthyProviders) {
                scheduler.setWeight(provider.uuid || provider.config?.uuid, getProviderWeight(provider.config));
            }
            scheduler.clearMissing(availableAndHealthyProviders.map(provider => provider.uuid || provider.config?.uuid));
            const selectedUuid = scheduler.select(availableAndHealthyProviders.map(provider => provider.uuid || provider.config?.uuid));
            selected = availableAndHealthyProviders.find(provider => (provider.uuid || provider.config?.uuid) === selectedUuid) || null;
            this._log('debug', `Selected provider for pool key ${options.poolKeyId} by smooth weighted round robin: ${this._getDisplayName(selected?.config || {})}`);
        } else if (!selected && options.stickyProviderKey && isCodexProviderType(providerType)) {
            selected = await this._selectCodexHotShardProvider(
                availableAndHealthyProviders,
                providerType,
                requestedModel,
                options,
                now
            ) || selectWeightedStickyProvider(
                    availableAndHealthyProviders,
                    `${providerType}:${requestedModel || ''}:${options.stickyProviderKey}`
                );
            this._log('debug', `Selected provider for ${providerType} by sticky affinity: ${this._getDisplayName(selected.config)}${requestedModel ? ` for model: ${requestedModel}` : ''}`);
        } else if (!selected && hasCustomProviderWeights(availableAndHealthyProviders)) {
            selected = [...availableAndHealthyProviders].sort((a, b) => {
                const weightedUsageA = this._getProviderWeightedBalanceScore(providerType, a, now);
                const weightedUsageB = this._getProviderWeightedBalanceScore(providerType, b, now);
                if (weightedUsageA !== weightedUsageB) return weightedUsageA - weightedUsageB;

                const loadA = a.state?.activeCount || 0;
                const loadB = b.state?.activeCount || 0;
                if (loadA !== loadB) return loadA - loadB;

                const lastUsedA = a.config.lastUsed ? new Date(a.config.lastUsed).getTime() : 0;
                const lastUsedB = b.config.lastUsed ? new Date(b.config.lastUsed).getTime() : 0;
                if (lastUsedA !== lastUsedB) return lastUsedA - lastUsedB;

                return (a.uuid || '').localeCompare(b.uuid || '');
            })[0];
            this._log('debug', `Selected provider for ${providerType} by weight: ${this._getDisplayName(selected.config)} (weight=${getProviderWeight(selected.config)})${requestedModel ? ` for model: ${requestedModel}` : ''}`);
        } else if (!selected) {
            // 改进：使用统一的评分策略进行选择
            // 传入当前时间戳 now 确保一致性
            selected = availableAndHealthyProviders.sort((a, b) => {
                const scoreA = this._calculateNodeScore(a, now, minSeq);
                const scoreB = this._calculateNodeScore(b, now, minSeq);
                if (scoreA !== scoreB) return scoreA - scoreB;
                // 如果分值相同，使用 UUID 排序确保确定性
                return a.uuid < b.uuid ? -1 : 1;
            })[0];
        }

        // 始终更新 lastUsed（确保 LRU 策略生效，避免并发请求选到同一个 provider）
        // usageCount 只在请求成功后才增加（由 skipUsageCount 控制）
        selected.config.lastUsed = new Date().toISOString();
        
        // 更新自增序列号，确保即使毫秒级并发，也能在下一轮排序中被区分开
        this._selectionSequence++;
        selected.config._lastSelectionSeq = this._selectionSequence;
        this._recordProviderSelectionLoad(providerType, selected, now);
        
        // 强制打印选中日志，方便排查并发问题
        this._log('info', `[Concurrency Control] Atomic selection: ${this._getDisplayName(selected.config)} (Seq: ${this._selectionSequence})`);

        if (!options.skipUsageCount) {
            selected.config.usageCount++;
        }
        // 使用防抖保存（文件 I/O 是异步的，但内存已经更新）
        this._debouncedSave(providerType);

        this._log('debug', `Selected provider for ${providerType} (LRU): ${this._getDisplayName(selected.config)}${requestedModel ? ` for model: ${requestedModel}` : ''}${options.skipUsageCount ? ' (skip usage count)' : ''}`);
        
        return selected.config;
    }

    _filterCodexProvidersByTokenQuota(providerType, providers, requestedModel = null, selectionDiagnostics = null) {
        if (selectionDiagnostics) {
            selectionDiagnostics.candidateProviderCount = providers.length;
            selectionDiagnostics.unavailableProviderCount = 0;
        }
        const bucket = resolveCodexQuotaBucket(
            requestedModel,
            toStringArray(this.globalConfig?.CODEX_53_QUOTA_MODEL_PATTERNS || this.globalConfig?.codex53QuotaModelPatterns || DEFAULT_CODEX_53_MODEL_PATTERNS)
        );
        const snapshotKey = `${providerType}:${bucket}`;
        const getStateFingerprint = () => this._getCodexPoolStateFingerprint(this.providerStatus[providerType] || providers, bucket);
        const stateFingerprint = getStateFingerprint();
        const cachedExhaustion = this._codexPoolExhaustedSnapshots.get(snapshotKey);
        const snapshotTtlMs = Math.min(Math.max(500, Number(this.globalConfig?.CODEX_POOL_SNAPSHOT_TTL_MS ?? 3000) || 3000), 15000);
        if (cachedExhaustion
            && cachedExhaustion.expiresAt > Date.now()
            && cachedExhaustion.providerConfigRevision === this.providerConfigRevision
            ) {
            const error = new Error(cachedExhaustion.message);
            error.status = 429;
            error.code = 429;
            error.filterReasons = { ...cachedExhaustion.filterReasons };
            error.details = {
                reason: 'CODEX_QUOTA_EXHAUSTED',
                candidateGroupId: selectionDiagnostics?.candidateGroupId || null,
                candidateProviderCount: providers.length,
                unavailableProviderCount: Number(Object.values(cachedExhaustion.filterReasons || {}).reduce((sum, value) => sum + Number(value || 0), 0))
            };
            if (selectionDiagnostics) {
                selectionDiagnostics.filterReasons = {
                    ...(selectionDiagnostics.filterReasons || {}),
                    ...cachedExhaustion.filterReasons
                };
                selectionDiagnostics.candidateProviderCount = providers.length;
                selectionDiagnostics.unavailableProviderCount = error.details.unavailableProviderCount;
            }
            throw error;
        }

        let limitedCount = 0;
        let unavailableCount = 0;
        const allowed = [];
        const filterReasons = {};
        const recordFilterReason = (reason) => {
            filterReasons[reason] = (filterReasons[reason] || 0) + 1;
        };
        let updatedLastKnownPlan = false;
        const usageCache = readFreshUsageCacheSync();
        const now = Date.now();
        const candidateUuids = providers.map(provider => provider.config?.uuid || provider.uuid || '').sort();
        const usageCacheVersion = getCodexUsageCacheVersion(usageCache);
        const filterCacheKey = `${providerType}:${bucket}:${candidateUuids.join(',')}`;
        const stateFingerprintBefore = getStateFingerprint();
        const localCachedFilter = this._codexQuotaFilterSnapshots.get(filterCacheKey);
        const sharedCachedFilter = this._codexQuotaFilterSnapshots.get(`${providerType}:${bucket}:*`);
        const cachedFilter = localCachedFilter || sharedCachedFilter;
        const cachedStateMatches = cachedFilter && (
            cachedFilter.stateFingerprint === stateFingerprintBefore
            || (cachedFilter.shared === true
                && cachedFilter.stateFingerprint === this._getCodexPoolStateFingerprint(
                    this.providerStatus[providerType] || providers,
                    bucket
                ))
        );
        this._codexQuotaFilterMetrics.calls += 1;
        if (cachedFilter
            && cachedFilter.expiresAt > now
            && cachedFilter.providerConfigRevision === this.providerConfigRevision
            && cachedStateMatches
            && cachedFilter.usageCacheVersion === usageCacheVersion
        ) {
            this._codexQuotaFilterMetrics.cacheHits += 1;
            this._codexQuotaFilterMetrics.crossWorkerReuse += cachedFilter.crossWorkerReuse ? 1 : 0;
            if (selectionDiagnostics) {
                selectionDiagnostics.filterReasons = {
                    ...(selectionDiagnostics.filterReasons || {}),
                    ...cachedFilter.filterReasons
                };
            }
            const allowedUuids = new Set(cachedFilter.allowedProviderUuids);
            return providers.filter(provider => allowedUuids.has(provider.config?.uuid || provider.uuid || ''));
        }
        this._codexQuotaFilterMetrics.cacheMisses += 1;

        for (const provider of providers) {
            const state = getCodexRateLimitCooldownState(provider.config, bucket);
            if (state.isCoolingDown !== true || !state.scheduledRecoveryTime) continue;
            const recoveryMs = Date.parse(state.scheduledRecoveryTime);
            if (Number.isFinite(recoveryMs) && now >= recoveryMs) {
                delete provider.config.codexRateLimitCooldown[bucket];
                this._debouncedSave(providerType);
            }
        }

        for (const provider of providers) {
            const uuid = provider.config?.uuid || provider.uuid;
            const planStatus = getCodexPlanStatusForProvider(providerType, uuid, usageCache, provider.config);
            if (!planStatus.allowed) {
                limitedCount += 1;
                recordFilterReason(planStatus.plan === 'unknown' ? 'plan_unknown' : `plan_${planStatus.plan}`);
                this._log('info', `Skipping Codex provider ${this._getDisplayName(provider.config)}: plan ${planStatus.plan} is not eligible for routing`);
                continue;
            }
            if (planStatus.source === 'usage' && provider.config?.lastKnownCodexPlan !== planStatus.plan) {
                provider.config.lastKnownCodexPlan = planStatus.plan;
                provider.config.lastKnownCodexPlanUpdatedAt = new Date().toISOString();
                updatedLastKnownPlan = true;
            }

            const quotaStatus = getCodexTokenQuotaStatus(providerType, provider, usageCache, bucket);
            if (quotaStatus.configured === false) {
                // No local quota limit is configured; leave any diagnostic state untouched.
            } else if (!quotaStatus.limited) {
                this.markCodexQuotaBucketHealthy(providerType, provider.config, bucket);
            } else if (quotaStatus.exceeded) {
                limitedCount += 1;
                recordFilterReason(`${bucket}_quota_exceeded`);
                this._log('info', `Skipping Codex provider ${this._getDisplayName(provider.config)}: ${quotaStatus.reason}`);
                this.markCodexQuotaBucketUnhealthy(providerType, provider.config, bucket, quotaStatus.reason);
                continue;
            } else {
                if (quotaStatus.reason) {
                    unavailableCount += 1;
                    this._log('warn', `Codex quota check for ${this._getDisplayName(provider.config)}: ${quotaStatus.reason}`);
                }
                this.markCodexQuotaBucketHealthy(providerType, provider.config, bucket);
            }

            if (isCodexRateLimitCoolingDown(provider.config, bucket, now)) {
                limitedCount += 1;
                recordFilterReason('rate_limit_cooldown');
                const recoveryMs = Date.parse(getCodexRateLimitCooldownState(provider.config, bucket).scheduledRecoveryTime || '');
                this._log('info', `Skipping Codex provider ${this._getDisplayName(provider.config)}: ${bucket} rate-limit cooldown is active until ${new Date(recoveryMs).toISOString()}`);
                continue;
            }

            if (!quotaStatus.limited) {
                allowed.push(provider);
                continue;
            }
            allowed.push(provider);
        }

        const finalStateFingerprint = getStateFingerprint();
        const filterTtlMs = getCodexQuotaFilterTtlMs(this.globalConfig, unavailableCount > 0);
        this._codexQuotaFilterMetrics.providersScanned += providers.length;
        this._codexQuotaFilterMetrics.unavailableProviders += unavailableCount;
        if (allowed.length === 0 && providers.length > 0 && limitedCount > 0) {
            if (updatedLastKnownPlan) {
                this._debouncedSave(providerType);
            }
            const reasonSummary = Object.entries(filterReasons)
                .map(([reason, count]) => `${reason}=${count}`)
                .join(', ');
            const message = reasonSummary
                ? `${selectionDiagnostics?.candidateGroupId ? `All Codex providers in credential group ${selectionDiagnostics.candidateGroupId}` : 'All Codex providers'} exceeded configured usage quotas (${reasonSummary})`
                : `${selectionDiagnostics?.candidateGroupId ? `All Codex providers in credential group ${selectionDiagnostics.candidateGroupId}` : 'All Codex providers'} exceeded configured usage quotas`;
            const error = new Error(message);
            error.status = 429;
            error.code = 429;
            error.filterReasons = filterReasons;
            error.details = {
                reason: 'CODEX_QUOTA_EXHAUSTED',
                candidateGroupId: selectionDiagnostics?.candidateGroupId || null,
                candidateProviderCount: providers.length,
                unavailableProviderCount: limitedCount
            };
            if (selectionDiagnostics) selectionDiagnostics.unavailableProviderCount = limitedCount;
            this._codexPoolExhaustedSnapshots.set(snapshotKey, {
                exhausted: true,
                expiresAt: Date.now() + snapshotTtlMs,
                providerConfigRevision: this.providerConfigRevision,
                stateFingerprint: getStateFingerprint(),
                message,
                filterReasons: { ...filterReasons },
                usageCacheVersion
            });
            const lock = this._codexPoolSnapshotLocks.get(snapshotKey);
            if (this.coordination?.setRuntimeSnapshot) {
                Promise.resolve(this.coordination.setRuntimeSnapshot(this._getCodexPoolSnapshotScope(providerType, bucket), {
                    providerConfigRevision: this.providerConfigRevision,
                    stateFingerprint: getStateFingerprint(),
                    message,
                    filterReasons: { ...filterReasons },
                    exhausted: true,
                    ttlMs: snapshotTtlMs,
                    usageCacheVersion
                }, { ttlMs: snapshotTtlMs })).catch(() => {});
            }
            if (lock && this.coordination?.releaseRuntimeSnapshotLock) {
                Promise.resolve(this.coordination.releaseRuntimeSnapshotLock(lock.scope, lock.owner)).catch(() => {});
                this._codexPoolSnapshotLocks.delete(snapshotKey);
            }
            throw error;
        }

        this._codexQuotaFilterSnapshots.set(filterCacheKey, {
            allowedProviderUuids: allowed.map(provider => provider.config?.uuid || provider.uuid || ''),
            filterReasons: { ...filterReasons },
            unavailableCount,
            computedAt: now,
            expiresAt: now + filterTtlMs,
            stateFingerprint: finalStateFingerprint,
            usageCacheVersion,
            providerConfigRevision: this.providerConfigRevision,
            crossWorkerReuse: false
        });
        if (this.coordination?.setRuntimeSnapshot) {
            Promise.resolve(this.coordination.setRuntimeSnapshot(this._getCodexPoolSnapshotScope(providerType, bucket), {
                providerConfigRevision: this.providerConfigRevision,
                stateFingerprint: finalStateFingerprint,
                allowedProviderUuids: allowed.map(provider => provider.config?.uuid || provider.uuid || ''),
                filterReasons: { ...filterReasons },
                unavailableCount,
                exhausted: false,
                ttlMs: filterTtlMs,
                usageCacheVersion
            }, { ttlMs: filterTtlMs })).catch(() => {});
        }
        this._log('debug', `Codex quota snapshot computed: providerType=${providerType} bucket=${bucket} providers=${providers.length} unavailable=${unavailableCount} ttlMs=${filterTtlMs}`);

        this._codexPoolExhaustedSnapshots.delete(snapshotKey);
        const lock = this._codexPoolSnapshotLocks.get(snapshotKey);
        if (lock && this.coordination?.deleteRuntimeSnapshot) {
            Promise.resolve(this.coordination.deleteRuntimeSnapshot(lock.scope)).catch(() => {});
        }
        if (lock && this.coordination?.releaseRuntimeSnapshotLock) {
            Promise.resolve(this.coordination.releaseRuntimeSnapshotLock(lock.scope, lock.owner)).catch(() => {});
            this._codexPoolSnapshotLocks.delete(snapshotKey);
        }

        if (updatedLastKnownPlan) {
            this._debouncedSave(providerType);
        }

        if (selectionDiagnostics) {
            selectionDiagnostics.filterReasons = {
                ...(selectionDiagnostics.filterReasons || {}),
                ...filterReasons
            };
        }

        return allowed;
    }

    _filterAntigravityProvidersByPlan(providerType, providers, selectionDiagnostics = null) {
        const startedAt = performance.now();
        try {
            return this._filterAntigravityProvidersByPlanUnmetered(providerType, providers, selectionDiagnostics);
        } finally {
            accumulateRoutingWait('selectionPlanFilterMs', performance.now() - startedAt);
        }
    }

    _filterAntigravityProvidersByPlanUnmetered(providerType, providers, selectionDiagnostics = null) {
        const usageCache = readFreshUsageCacheSync();
        if (this._antigravityPlanFilterCache.usageCache !== usageCache) {
            this._antigravityPlanFilterCache = { usageCache, byUuid: new Map() };
        }
        const planByUuid = this._antigravityPlanFilterCache.byUuid;
        const allowed = [];
        let freeCount = 0;
        let updatedLastKnownPlan = false;

        for (const provider of providers) {
            const uuid = provider.config?.uuid || provider.uuid;
            let planStatus = planByUuid.get(uuid);
            if (!planStatus) {
                planStatus = getAntigravityPlanStatusForProvider(providerType, uuid, usageCache, provider.config);
                planByUuid.set(uuid, planStatus);
            }
            if (planStatus.isFree) {
                freeCount += 1;
                this._log('info', `Skipping Antigravity provider ${this._getDisplayName(provider.config)}: plan ${planStatus.plan} is free`);
                continue;
            }
            if (
                planStatus.source === 'usage'
                && provider.config?.lastKnownAntigravityPlan !== planStatus.plan
            ) {
                provider.config.lastKnownAntigravityPlan = planStatus.plan;
                provider.config.lastKnownAntigravityPlanUpdatedAt = new Date().toISOString();
                updatedLastKnownPlan = true;
            }
            allowed.push(provider);
        }

        if (updatedLastKnownPlan) this._debouncedSave(providerType);
        if (selectionDiagnostics && freeCount > 0) {
            selectionDiagnostics.filterReasons = {
                ...(selectionDiagnostics.filterReasons || {}),
                plan_free: freeCount
            };
        }
        if (allowed.length === 0 && providers.length > 0 && freeCount > 0) {
            const error = new Error(`All Antigravity providers are on the free plan (plan_free=${freeCount})`);
            error.status = 503;
            error.statusCode = 503;
            error.code = 'PROVIDER_CREDENTIALS_UNAVAILABLE';
            error.filterReasons = { plan_free: freeCount };
            throw error;
        }
        return allowed;
    }

    _getAntigravityAvailabilityScope(providerType, canonicalModel, providers = [], options = {}) {
        const modelRevision = this._antigravityAvailabilityModelRevisions.get(canonicalModel) || 0;
        const fingerprint = providers
            .map(provider => provider.config?.uuid || provider.uuid || '')
            .sort()
            .join(',');
        const routingStrategy = String(options.routingStrategy || '').trim();
        const cacheKey = `${providerType}|${canonicalModel}|${this.providerConfigRevision}|${this._antigravityAvailabilityRevision}|${modelRevision}|${routingStrategy}|${fingerprint}`;
        const cached = this._antigravityAvailabilityScopeCache.get(cacheKey);
        if (cached) return cached;
        const candidateHash = fingerprint
            .split(',')
            .filter(Boolean)
            .map(uuid => this._getAntigravityCredentialHash(uuid))
            .sort()
            .join(',');
        const scope = `antigravity-availability:${providerType}:${canonicalModel}:${this.providerConfigRevision}:${this._antigravityAvailabilityRevision}:${modelRevision}:${routingStrategy}:${candidateHash}`;
        this._antigravityAvailabilityScopeCache.set(cacheKey, scope);
        if (this._antigravityAvailabilityScopeCache.size > ANTIGRAVITY_AVAILABILITY_SCOPE_CACHE_LIMIT) {
            const oldest = this._antigravityAvailabilityScopeCache.keys().next().value;
            this._antigravityAvailabilityScopeCache.delete(oldest);
        }
        return scope;
    }

    _getAntigravityCredentialHash(providerUuid) {
        const key = String(providerUuid || '');
        const cached = this._antigravityCredentialHashCache.get(key);
        if (cached) return cached;
        const hash = crypto.createHash('sha256')
            .update(`antigravity-credential:${key}`)
            .digest('hex')
            .slice(0, 16);
        this._antigravityCredentialHashCache.set(key, hash);
        return hash;
    }

    _getAntigravityAvailabilityTtl(snapshot) {
        if (snapshot?.exhausted === true) {
            const recoveryMs = Date.parse(snapshot.nearestRecoveryTime || '');
            const retryMs = Number.isFinite(recoveryMs) ? Math.max(1000, recoveryMs - Date.now()) : 3000;
            return Math.min(30_000, retryMs);
        }
        return 1000;
    }

    _isAntigravityAvailabilitySnapshotValid(snapshot, now = Date.now()) {
        const expiry = Number(snapshot?.localExpiresAt || snapshot?.expiresAt);
        return Boolean(snapshot
            && snapshot.version === 1
            && snapshot.configRevision === this.providerConfigRevision
            && expiry > now
            && Array.isArray(snapshot.eligibleCredentialHashes)
            && Array.isArray(snapshot.coolingCredentialHashes));
    }

    _attachAntigravityLocalExpiry(snapshot) {
        if (!snapshot || !Number.isFinite(Number(snapshot.expiresAt))) return snapshot;
        const createdAt = Number(snapshot.createdAt) || Date.now();
        const sharedExpiry = Number(snapshot.expiresAt);
        const localTtlMs = Math.min(200, Math.max(1, sharedExpiry - createdAt));
        return {
            ...snapshot,
            localExpiresAt: Math.min(sharedExpiry, createdAt + localTtlMs)
        };
    }

    async _getOrRefreshAntigravityAvailability(scope, refresh) {
        const startedAt = performance.now();
        try {
            return await this._getOrRefreshAntigravityAvailabilityUnmetered(scope, refresh);
        } finally {
            accumulateRoutingWait('availabilityRefreshMs', performance.now() - startedAt);
        }
    }

    async _getOrRefreshAntigravityAvailabilityUnmetered(scope, refresh) {
        const now = Date.now();
        const local = this._antigravityAvailabilityLocal.get(scope);
        if (this._isAntigravityAvailabilitySnapshotValid(local, now)) {
            this._antigravityAvailabilityMetrics.cacheHits += 1;
            if (local.exhausted) this._antigravityAvailabilityMetrics.negativeCacheHits += 1;
            return local;
        }

        const existingFlight = this._antigravityAvailabilityFlights.get(scope);
        if (existingFlight) {
            this._antigravityAvailabilityMetrics.singleFlightHits += 1;
            return existingFlight;
        }

        const flight = (async () => {
            let owner = null;
            let shared = null;
            try {
                try {
                    shared = await this.coordination?.getRuntimeSnapshot?.(scope);
                } catch {
                    shared = null;
                }
                if (this._isAntigravityAvailabilitySnapshotValid(shared)) {
                    this._antigravityAvailabilityMetrics.cacheHits += 1;
                    if (shared.exhausted) this._antigravityAvailabilityMetrics.negativeCacheHits += 1;
                    const localShared = this._attachAntigravityLocalExpiry(shared);
                    this._antigravityAvailabilityLocal.set(scope, localShared);
                    return localShared;
                }

                try {
                    owner = await this.coordination?.acquireRuntimeSnapshotLock?.(scope, { ttlMs: 1500 });
                } catch {
                    owner = null;
                }
                if (!owner && this.coordination?.getRuntimeSnapshot) {
                    for (let attempt = 0; attempt < 5; attempt += 1) {
                        await new Promise(resolve => setTimeout(resolve, 10));
                        try {
                            shared = await this.coordination.getRuntimeSnapshot(scope);
                        } catch {
                            shared = null;
                        }
                        if (this._isAntigravityAvailabilitySnapshotValid(shared)) {
                            this._antigravityAvailabilityMetrics.cacheHits += 1;
                            if (shared.exhausted) this._antigravityAvailabilityMetrics.negativeCacheHits += 1;
                            const localShared = this._attachAntigravityLocalExpiry(shared);
                            this._antigravityAvailabilityLocal.set(scope, localShared);
                            return localShared;
                        }
                    }
                    // Another worker owns the refresh. Do not duplicate the
                    // expensive credential scan; let the caller proceed with
                    // the current provider set while the shared snapshot is
                    // being published.
                    const inProgress = this._attachAntigravityLocalExpiry({
                        version: 1,
                        providerType: MODEL_PROVIDER.ANTIGRAVITY,
                        model: 'unknown',
                        eligibleCredentialHashes: [],
                        coolingCredentialHashes: [],
                        unavailableCredentialCount: 0,
                        reason: 'refresh_in_progress',
                        refreshInProgress: true,
                        exhausted: false,
                        configRevision: this.providerConfigRevision,
                        createdAt: Date.now(),
                        expiresAt: Date.now() + 100,
                        ttlMs: 100
                    });
                    this._antigravityAvailabilityLocal.set(scope, inProgress);
                    return inProgress;
                }

                this._antigravityAvailabilityMetrics.cacheMisses += 1;
                const startedAt = performance.now();
                const snapshot = await refresh();
                const ttlMs = this._getAntigravityAvailabilityTtl(snapshot);
                const createdAt = Date.now();
                const enriched = {
                    version: 1,
                    ...snapshot,
                    configRevision: this.providerConfigRevision,
                    createdAt,
                    expiresAt: createdAt + ttlMs,
                    ttlMs
                };
                this._antigravityAvailabilityMetrics.providersScanned += Number(snapshot.providersScanned || 0);
                this._antigravityAvailabilityMetrics.refreshMs += performance.now() - startedAt;
                const localSnapshot = this._attachAntigravityLocalExpiry(enriched);
                this._antigravityAvailabilityLocal.set(scope, localSnapshot);
                try {
                    const sharedSnapshot = { ...enriched };
                    await this.coordination?.setRuntimeSnapshot?.(scope, sharedSnapshot, { ttlMs });
                } catch {
                    // Local filtering remains authoritative when Redis is unavailable.
                }
                return localSnapshot;
            } finally {
                if (owner) {
                    try {
                        await this.coordination?.releaseRuntimeSnapshotLock?.(scope, owner);
                    } catch {
                        // Lock expiry remains the fallback when release cannot reach Redis.
                    }
                }
            }
        })();
        this._antigravityAvailabilityFlights.set(scope, flight);
        try {
            return await flight;
        } finally {
            this._antigravityAvailabilityFlights.delete(scope);
        }
    }

    getAntigravityAvailabilityMetrics() {
        const metrics = this._antigravityAvailabilityMetrics;
        const calls = metrics.cacheHits + metrics.cacheMisses;
        return {
            ...metrics,
            cacheHitRatio: calls > 0 ? metrics.cacheHits / calls : 0,
            negativeCacheHitRatio: calls > 0 ? metrics.negativeCacheHits / calls : 0,
            singleFlightHitRatio: calls > 0 ? metrics.singleFlightHits / calls : 0,
            activeSnapshots: [...this._antigravityAvailabilityLocal.values()]
                .filter(snapshot => this._isAntigravityAvailabilitySnapshotValid(snapshot)).length
        };
    }

    getAntigravityRoutingMetrics() {
        return { ...this._antigravityRoutingMetrics };
    }

    recordAntigravityRoutingEvent(field) {
        if (!Object.prototype.hasOwnProperty.call(this._antigravityRoutingMetrics, field)) return false;
        this._antigravityRoutingMetrics[field] += 1;
        return true;
    }

    invalidateAntigravityAvailability(canonicalModel = null, options = {}) {
        const minIntervalMs = Math.max(0, Number(options.minIntervalMs) || 0);
        const now = Date.now();
        if (canonicalModel) {
            const model = normalizeAntigravityQuotaModel(canonicalModel);
            if (minIntervalMs > 0) {
                const last = this._antigravityAvailabilityLastInvalidateAt.get(model) || 0;
                if (now - last < minIntervalMs) return 0;
            }
            const prefix = `antigravity-availability:${MODEL_PROVIDER.ANTIGRAVITY}:${model}:`;
            let count = 0;
            for (const key of this._antigravityAvailabilityLocal.keys()) {
                if (!key.startsWith(prefix)) continue;
                this._antigravityAvailabilityLocal.delete(key);
                count += 1;
            }
            this._antigravityAvailabilityModelRevisions.set(
                model,
                (this._antigravityAvailabilityModelRevisions.get(model) || 0) + 1
            );
            this._antigravityAvailabilityLastInvalidateAt.set(model, now);
            this._antigravityAvailabilityMetrics.invalidations += count;
            return count;
        }
        const prefix = `antigravity-availability:${MODEL_PROVIDER.ANTIGRAVITY}:`;
        let count = 0;
        for (const key of this._antigravityAvailabilityLocal.keys()) {
            if (!key.startsWith(prefix)) continue;
            this._antigravityAvailabilityLocal.delete(key);
            count += 1;
        }
        this._antigravityAvailabilityRevision += 1;
        this._antigravityAvailabilityModelRevisions.clear();
        this._antigravityAvailabilityLastInvalidateAt.clear();
        this._antigravityAvailabilityScopeCache.clear();
        this._antigravityAvailabilityMetrics.invalidations += count;
        return count;
    }

    /**
     * Records the model list an Antigravity credential actually advertises
     * upstream. Without this write-back `getAntigravityAvailableModels` sees an
     * empty set in production and the intersection filter silently degrades to
     * the hand-maintained static chain.
     */
    async _probeAntigravityAvailableModels(providerType, providerStatus) {
        if (!isAntigravityProviderType(providerType)) return false;
        const config = providerStatus?.config;
        if (!config || config.isDisabled) return false;

        try {
            const tempConfig = {
                ...this.globalConfig,
                ...config,
                MODEL_PROVIDER: providerType
            };
            delete tempConfig.providerPools;
            const serviceAdapter = this.serviceAdapterFactory(tempConfig);
            const service = serviceAdapter?.antigravityApiService;
            if (!service?.fetchAvailableModels) return false;

            await service._ensureInitialized();
            await service.fetchAvailableModels();
            return true;
        } catch (error) {
            this._log('warn', `Antigravity model probe failed for ${this._getDisplayName(config)}: ${error.message}`);
            return false;
        }
    }

    recordAntigravityAvailableModels(providerType, providerUuid, models) {
        if (!isAntigravityProviderType(providerType) || !providerUuid) return false;
        const provider = this._findProvider(providerType, providerUuid);
        if (!provider) return false;
        const normalized = [...new Set(
            (Array.isArray(models) ? models : [])
                .map(model => String(model || '').trim())
                .filter(Boolean)
        )];
        if (normalized.length === 0) return false;
        const existing = Array.isArray(provider.config.availableModels) ? provider.config.availableModels : [];
        if (existing.length === normalized.length && existing.every((model, index) => model === normalized[index])) {
            return false;
        }
        provider.config.availableModels = normalized;
        this.invalidateAntigravityAvailability();
        this._log('info', `Recorded ${normalized.length} probed Antigravity models for ${this._getDisplayName(provider.config)}`);
        return true;
    }

    _getAntigravityVerifiedModels(providerType) {
        const models = getAntigravityAvailableModels(this.providerStatus?.[providerType] || []);
        if (models.length === 0 && isAntigravityProviderType(providerType)) {
            this._antigravityRoutingMetrics.availableModelsUnknown += 1;
            const now = Date.now();
            if (now - this._antigravityAvailableModelsWarnedAt > 60_000) {
                this._antigravityAvailableModelsWarnedAt = now;
                this._log('warn', `No probed model list is known for ${providerType}; the elastic chain is falling back to the static model order`);
            }
        }
        return models;
    }

    _getAntigravityModelNotFoundScope(providerType) {
        return `antigravity-model-not-found:${providerType}:${this.providerConfigRevision}`;
    }

    _getAntigravityModelNotFoundKey(providerType, canonicalModel) {
        return `${providerType}:${this.providerConfigRevision}:${canonicalModel}`;
    }

    isAntigravityModelNotFound(providerType, model) {
        const canonicalModel = normalizeAntigravityQuotaModel(model);
        if (!canonicalModel) return false;
        const key = this._getAntigravityModelNotFoundKey(providerType, canonicalModel);
        const expiresAt = Number(this._antigravityModelNotFound.get(key));
        if (!Number.isFinite(expiresAt)) return false;
        if (expiresAt <= Date.now()) {
            this._antigravityModelNotFound.delete(key);
            return false;
        }
        return true;
    }

    markAntigravityModelNotFound(providerType, model, errorMessage = null) {
        if (!isAntigravityProviderType(providerType)) return false;
        const canonicalModel = normalizeAntigravityQuotaModel(model);
        if (!canonicalModel) return false;
        const alreadyKnown = this.isAntigravityModelNotFound(providerType, canonicalModel);
        this._antigravityModelNotFound.set(
            this._getAntigravityModelNotFoundKey(providerType, canonicalModel),
            Date.now() + ANTIGRAVITY_MODEL_NOT_FOUND_TTL_MS
        );
        this._antigravityRoutingMetrics.modelNotFoundMarked += 1;
        if (!alreadyKnown) {
            this._log('warn', `Antigravity model ${canonicalModel} does not exist upstream; excluding it from routing for ${ANTIGRAVITY_MODEL_NOT_FOUND_TTL_MS / 60000} minutes (${errorMessage || 'not found'})`);
            this.invalidateAntigravityAvailability(canonicalModel);
        }
        this._publishAntigravityModelNotFound(providerType);
        return true;
    }

    clearAntigravityModelNotFound() {
        const count = this._antigravityModelNotFound.size;
        this._antigravityModelNotFound.clear();
        this._antigravityModelNotFoundSync.fetchedAt = 0;
        return count;
    }

    getAntigravityModelNotFoundModels(providerType) {
        const now = Date.now();
        const prefix = `${providerType}:${this.providerConfigRevision}:`;
        const models = [];
        for (const [key, expiresAt] of this._antigravityModelNotFound) {
            if (!key.startsWith(prefix)) continue;
            if (Number(expiresAt) <= now) {
                this._antigravityModelNotFound.delete(key);
                continue;
            }
            models.push(key.slice(prefix.length));
        }
        return models;
    }

    _publishAntigravityModelNotFound(providerType) {
        if (typeof this.coordination?.setModelNegativeCache !== 'function') return;
        const models = {};
        for (const model of this.getAntigravityModelNotFoundModels(providerType)) {
            models[model] = Number(this._antigravityModelNotFound.get(
                this._getAntigravityModelNotFoundKey(providerType, model)
            ));
        }
        Promise.resolve(this.coordination.setModelNegativeCache(
            this._getAntigravityModelNotFoundScope(providerType),
            { version: 1, models },
            { ttlMs: ANTIGRAVITY_MODEL_NOT_FOUND_TTL_MS }
        )).catch(error => this._log('warn', `Failed to publish Antigravity model-not-found cache: ${error.message}`));
    }

    /**
     * Pulls the shared model-not-found set so a worker that has never seen the
     * 404 itself still skips the model. Rate limited so the routing path costs
     * at most one Redis read per interval instead of one per request.
     */
    async _hydrateAntigravityModelNotFound(providerType) {
        if (!isAntigravityProviderType(providerType)) return;
        if (typeof this.coordination?.getModelNegativeCache !== 'function') return;
        const sync = this._antigravityModelNotFoundSync;
        if (sync.promise) {
            await sync.promise;
            return;
        }
        if (Date.now() - sync.fetchedAt < ANTIGRAVITY_MODEL_NOT_FOUND_SYNC_INTERVAL_MS) return;
        sync.promise = (async () => {
            try {
                const shared = await this.coordination.getModelNegativeCache(
                    this._getAntigravityModelNotFoundScope(providerType)
                );
                const models = shared?.models;
                if (!models || typeof models !== 'object') return;
                const now = Date.now();
                for (const [model, expiresAt] of Object.entries(models)) {
                    const canonicalModel = normalizeAntigravityQuotaModel(model);
                    const numericExpiry = Number(expiresAt);
                    if (!canonicalModel || !Number.isFinite(numericExpiry) || numericExpiry <= now) continue;
                    const key = this._getAntigravityModelNotFoundKey(providerType, canonicalModel);
                    const localExpiry = Number(this._antigravityModelNotFound.get(key)) || 0;
                    if (numericExpiry > localExpiry) this._antigravityModelNotFound.set(key, numericExpiry);
                }
            } catch (error) {
                this._log('warn', `Failed to hydrate Antigravity model-not-found cache: ${error.message}`);
            } finally {
                sync.fetchedAt = Date.now();
                sync.promise = null;
            }
        })();
        await sync.promise;
    }

    _excludeAntigravityModelsNotFound(providerType, models) {
        if (!isAntigravityProviderType(providerType)) return models;
        return models.filter(model => {
            if (!this.isAntigravityModelNotFound(providerType, model)) return true;
            this._antigravityRoutingMetrics.skippedByNegativeCache += 1;
            return false;
        });
    }

    _createAntigravityModelNotFoundError(requestedModel) {
        const canonicalModel = normalizeAntigravityQuotaModel(requestedModel);
        this._antigravityRoutingMetrics.modelNotFoundFastFails += 1;
        return createGeminiRoutingError(
            `Antigravity model ${canonicalModel} does not exist upstream`,
            'MODEL_NOT_FOUND',
            404,
            { quotaScope: 'model', quotaKey: canonicalModel }
        );
    }

    async _filterAntigravityProvidersByQuota(providerType, providers, requestedModel = null, selectionDiagnostics = null, options = {}) {
        if (!requestedModel) return providers;

        const canonicalModel = normalizeAntigravityQuotaModel(requestedModel);
        const scope = this._getAntigravityAvailabilityScope(providerType, canonicalModel, providers, options);
        const providerByHash = new Map(providers.map(provider => {
            const uuid = provider.config?.uuid || provider.uuid || '';
            return [this._getAntigravityCredentialHash(uuid), provider];
        }));
        const snapshot = await this._getOrRefreshAntigravityAvailability(scope, async () => {
            const now = Date.now();
            const allowed = [];
            const coolingCredentialHashes = [];
            const filterReasons = {};
            const recoveryTimes = [];
            let updated = false;
            const recordReason = reason => {
                filterReasons[reason] = (filterReasons[reason] || 0) + 1;
            };

            for (const provider of providers) {
                const config = provider.config || {};
                const quotaHealth = config.antigravityQuotaHealth || { families: {}, models: {} };
                quotaHealth.families = quotaHealth.families || {};
                quotaHealth.models = quotaHealth.models || {};
                config.antigravityQuotaHealth = quotaHealth;
                for (const [family, familyState] of Object.entries(quotaHealth.families)) {
                    if (familyState?.source === 'usage_cache') {
                        delete quotaHealth.families[family];
                        updated = true;
                    }
                }
                const uuid = provider.config?.uuid || provider.uuid || '';
                const credentialHash = this._getAntigravityCredentialHash(uuid);
                const modelState = getActiveAntigravityQuotaState(quotaHealth.models[canonicalModel], now);
                if (modelState) {
                    coolingCredentialHashes.push(credentialHash);
                    recordReason('model_cooldown');
                    const recoveryMs = Date.parse(modelState.scheduledRecoveryTime || '');
                    if (Number.isFinite(recoveryMs) && recoveryMs > now) recoveryTimes.push(recoveryMs);
                    continue;
                }
                if (quotaHealth.models[canonicalModel]) {
                    delete quotaHealth.models[canonicalModel];
                    updated = true;
                }
                allowed.push(provider);
            }
            this.coordination?.updateGeminiSchedulingGauge?.(canonicalModel, {
                schedulable: allowed.length,
                cooling: Number(filterReasons.model_cooldown || 0),
                quotaUnknown: 0
            });
            if (updated) this._debouncedSave(providerType);
            const nearestRecoveryTime = recoveryTimes.length > 0
                ? new Date(Math.min(...recoveryTimes)).toISOString()
                : null;
            return {
                providerType,
                model: canonicalModel,
                eligibleCredentialHashes: allowed.map(provider => this._getAntigravityCredentialHash(provider.config?.uuid || provider.uuid || '')),
                coolingCredentialHashes,
                unavailableCredentialCount: coolingCredentialHashes.length,
                nearestRecoveryTime,
                reason: allowed.length === 0 ? 'all_credentials_unavailable' : 'partial_cooldown',
                exhausted: allowed.length === 0 && coolingCredentialHashes.length > 0,
                filterReasons,
                providersScanned: providers.length
            };
        });

        if (selectionDiagnostics && snapshot.filterReasons && Object.keys(snapshot.filterReasons).length > 0) {
            selectionDiagnostics.filterReasons = {
                ...(selectionDiagnostics.filterReasons || {}),
                ...snapshot.filterReasons
            };
            if (snapshot.nearestRecoveryTime) selectionDiagnostics.nextModelRecoveryTime = snapshot.nearestRecoveryTime;
        }
        if (snapshot.exhausted === true) {
            this._antigravityAvailabilityMetrics.allModelsUnavailable += 1;
            this._antigravityRoutingMetrics.skippedByNegativeCache += 1;
            const error = new Error(`All Antigravity providers are cooling down for model ${canonicalModel}`);
            error.status = 429;
            error.code = 429;
            error.quotaScope = 'model';
            error.quotaKey = canonicalModel;
            error.filterReasons = { ...(snapshot.filterReasons || {}) };
            if (snapshot.nearestRecoveryTime) error.nextRecoveryTime = snapshot.nearestRecoveryTime;
            throw error;
        }
        if (snapshot.refreshInProgress === true) return [];
        return providers.filter(provider => providerByHash.has(this._getAntigravityCredentialHash(provider.config?.uuid || provider.uuid || ''))
            && snapshot.eligibleCredentialHashes.includes(this._getAntigravityCredentialHash(provider.config?.uuid || provider.uuid || '')));
    }

    _getAntigravityElasticRoutingConfig() {
        const configured = this.globalConfig?.antigravityElasticRouting || {};
        const configuredFallbacks = Array.isArray(configured.fallbackModels)
            ? configured.fallbackModels.map(model => String(model || '').trim()).filter(Boolean)
            : ANTIGRAVITY_ELASTIC_DEFAULTS.fallbackModels;
        return {
            enabled: configured.enabled !== false,
            maxQueueWaitMs: positiveInteger(configured.maxQueueWaitMs, ANTIGRAVITY_ELASTIC_DEFAULTS.maxQueueWaitMs),
            preferOriginalWaitMs: positiveInteger(configured.preferOriginalWaitMs, ANTIGRAVITY_ELASTIC_DEFAULTS.preferOriginalWaitMs, { allowZero: true }),
            fallbackModels: configuredFallbacks,
            globalQueueLimit: positiveInteger(configured.globalQueueLimit, ANTIGRAVITY_ELASTIC_DEFAULTS.globalQueueLimit),
            perKeyModelQueueLimit: positiveInteger(configured.perKeyModelQueueLimit, ANTIGRAVITY_ELASTIC_DEFAULTS.perKeyModelQueueLimit),
            globalQueuedBytesLimit: positiveInteger(configured.globalQueuedBytesLimit, ANTIGRAVITY_ELASTIC_DEFAULTS.globalQueuedBytesLimit),
            recoveryJitterMinMs: positiveInteger(configured.recoveryJitterMinMs, ANTIGRAVITY_ELASTIC_DEFAULTS.recoveryJitterMinMs, { allowZero: true }),
            recoveryJitterMaxMs: positiveInteger(configured.recoveryJitterMaxMs, ANTIGRAVITY_ELASTIC_DEFAULTS.recoveryJitterMaxMs, { allowZero: true })
        };
    }

    _isAntigravityElasticRoutingEligible(providerType, requestedModel) {
        const canonicalModel = normalizeAntigravityQuotaModel(requestedModel);
        return this._getAntigravityElasticRoutingConfig().enabled
            && isAntigravityProviderType(providerType)
            && Object.prototype.hasOwnProperty.call(ANTIGRAVITY_ELASTIC_MODEL_FALLBACKS, canonicalModel);
    }

    getCodexQuotaFilterMetrics() {
        const calls = Number(this._codexQuotaFilterMetrics?.calls || 0);
        const cacheHits = Number(this._codexQuotaFilterMetrics?.cacheHits || 0);
        const snapshots = [...this._codexQuotaFilterSnapshots.values()];
        const now = Date.now();
        const snapshotAgeMs = snapshots.length > 0
            ? Math.max(0, now - Math.max(...snapshots.map(snapshot => Number(snapshot.computedAt) || now)))
            : 0;
        return {
            ...this._codexQuotaFilterMetrics,
            cacheHitRatio: calls > 0 ? cacheHits / calls : 0,
            activeSnapshots: this._codexQuotaFilterSnapshots.size,
            snapshotAgeMs,
            codexQuotaFilterCalls: calls,
            codexQuotaFilterCacheHits: cacheHits,
            codexQuotaFilterCacheMisses: Number(this._codexQuotaFilterMetrics?.cacheMisses || 0),
            codexQuotaProvidersScanned: Number(this._codexQuotaFilterMetrics?.providersScanned || 0),
            codexQuotaUnavailableProviders: Number(this._codexQuotaFilterMetrics?.unavailableProviders || 0),
            codexQuotaSnapshotAgeMs: snapshotAgeMs,
            codexQuotaCrossWorkerReuse: Number(this._codexQuotaFilterMetrics?.crossWorkerReuse || 0)
        };
    }

    async _selectGeminiWithModelFallback(providerType, requestedModel, options, select) {
        await this._hydrateAntigravityModelNotFound(providerType);
        const availableModels = this._getAntigravityVerifiedModels(providerType);
        const models = this._excludeAntigravityModelsNotFound(providerType, [
            requestedModel,
            ...getAntigravityElasticFallbackModels(
                requestedModel,
                getConfiguredGeminiFallbackModels(this.globalConfig),
                availableModels
            )
        ]);
        if (models.length === 0) throw this._createAntigravityModelNotFoundError(requestedModel);
        let lastError = null;
        for (let index = 0; index < models.length; index += 1) {
            const model = models[index];
            try {
                const selectedConfig = await select(model);
                if (!selectedConfig) continue;
                const isFallback = index > 0;
                return {
                    config: selectedConfig,
                    actualProviderType: providerType,
                    actualModel: model,
                    isFallback,
                    modelFallbackReason: isFallback ? 'SOURCE_MODEL_UNAVAILABLE' : null,
                    fallbackAttemptCount: index
                };
            } catch (error) {
                lastError = error;
                if (error?.status !== 429 && error?.code !== 429) throw error;
            }
        }
        if (lastError) throw lastError;
        return null;
    }

    getGeminiElasticQueueSnapshot() {
        return {
            waiting: this._geminiElasticQueue.waiting,
            queuedBytes: this._geminiElasticQueue.queuedBytes,
            perKeyModel: Object.fromEntries(this._geminiElasticQueue.perKeyModel)
        };
    }

    // Only Antigravity requests queue here, yet every releaseSlot call used to
    // wake all of them. Codex traffic dominates release volume, so unscoped
    // wakes made each Codex completion re-run the whole Gemini selection loop
    // for every waiter.
    _notifyGeminiElasticWaiters(providerType = null) {
        for (const waiter of [...this._geminiElasticQueue.waiters]) {
            if (providerType && waiter.providerType && waiter.providerType !== providerType) continue;
            waiter.wake();
        }
    }

    async _acquireGeminiElasticQueueEntry(requestedModel, options, config) {
        const queueKey = `${String(options.queueKey || 'anonymous')}:${requestedModel}`;
        const bytes = Math.max(0, Number(options.queueRequestBytes) || 0);

        if (this.coordination) {
            if (typeof this.coordination.acquireGeminiQueueSlot !== 'function') {
                throw createGeminiRoutingError('Gemini queue coordination is unavailable', 'COORDINATION_UNAVAILABLE', 503);
            }
            let entry;
            try {
                entry = await this.coordination.acquireGeminiQueueSlot({
                    queueKey,
                    bytes,
                    ttlMs: config.maxQueueWaitMs + 5000,
                    globalLimit: config.globalQueueLimit,
                    perKeyLimit: config.perKeyModelQueueLimit,
                    byteLimit: config.globalQueuedBytesLimit
                });
            } catch (cause) {
                const error = createGeminiRoutingError(
                    'Gemini queue coordination is unavailable',
                    'COORDINATION_UNAVAILABLE',
                    503
                );
                error.cause = cause;
                throw error;
            }
            if (!entry) {
                throw createGeminiRoutingError('Gemini elastic queue capacity exceeded', 'QUEUE_CAPACITY_EXCEEDED', 429);
            }
            return entry;
        }

        const currentForKey = this._geminiElasticQueue.perKeyModel.get(queueKey) || 0;
        if (
            this._geminiElasticQueue.waiting >= config.globalQueueLimit
            || currentForKey >= config.perKeyModelQueueLimit
            || this._geminiElasticQueue.queuedBytes + bytes > config.globalQueuedBytesLimit
        ) {
            throw createGeminiRoutingError('Gemini elastic queue capacity exceeded', 'QUEUE_CAPACITY_EXCEEDED', 429);
        }
        this._geminiElasticQueue.waiting += 1;
        this._geminiElasticQueue.queuedBytes += bytes;
        this._geminiElasticQueue.perKeyModel.set(queueKey, currentForKey + 1);
        return { local: true, queueKey, bytes };
    }

    async _releaseGeminiElasticQueueEntry(entry) {
        if (!entry) return;
        if (!entry.local) {
            await this.coordination?.releaseGeminiQueueSlot?.(entry.leaseId).catch(error => {
                this._log('warn', `[Coordination] Gemini queue slot release deferred to TTL: ${error.message}`);
            });
            return;
        }
        const currentForKey = this._geminiElasticQueue.perKeyModel.get(entry.queueKey) || 0;
        if (currentForKey <= 1) this._geminiElasticQueue.perKeyModel.delete(entry.queueKey);
        else this._geminiElasticQueue.perKeyModel.set(entry.queueKey, currentForKey - 1);
        this._geminiElasticQueue.waiting = Math.max(0, this._geminiElasticQueue.waiting - 1);
        this._geminiElasticQueue.queuedBytes = Math.max(0, this._geminiElasticQueue.queuedBytes - entry.bytes);
    }

    _waitForGeminiElasticWake({ timeoutMs, abortSignal, providerType = null }) {
        if (abortSignal?.aborted) {
            return Promise.reject(createGeminiRoutingError('Client aborted while queued', 'CLIENT_ABORTED', 499));
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            const waiter = { providerType, wake: () => finish(resolve) };
            const onAbort = () => finish(() => reject(createGeminiRoutingError('Client aborted while queued', 'CLIENT_ABORTED', 499)));
            const cleanup = () => {
                clearTimeout(timer);
                this._geminiElasticQueue.waiters.delete(waiter);
                abortSignal?.removeEventListener?.('abort', onAbort);
            };
            const finish = callback => {
                if (settled) return;
                settled = true;
                cleanup();
                callback();
            };
            const timer = setTimeout(waiter.wake, Math.max(1, timeoutMs));
            timer.unref?.();
            this._geminiElasticQueue.waiters.add(waiter);
            abortSignal?.addEventListener?.('abort', onAbort, { once: true });
        });
    }

    async _waitForGeminiElasticWakeTracked(args) {
        const startedAt = performance.now();
        try {
            return await this._waitForGeminiElasticWake(args);
        } finally {
            accumulateRoutingWait('elasticQueueWaitMs', performance.now() - startedAt);
        }
    }

    _getRecoveryTimeFromError(error) {
        const value = Date.parse(error?.nextRecoveryTime || error?.retryAfter || '');
        return Number.isFinite(value) ? value : null;
    }

    async _tryAntigravityElasticModel(providerType, model, options) {
        accumulateRoutingWait('elasticAttemptCount', 1);
        try {
            const config = await this.acquireSlot(providerType, model, {
                ...options,
                skipCredentialQueue: true
            });
            return { config, error: null };
        } catch (error) {
            if (error?.status === 429 || error?.code === 429) return { config: null, error };
            throw error;
        }
    }

    _createAntigravityAllModelsUnavailableError(requestedModel, errors = []) {
        const recoveryTimes = errors
            .map(error => error?.nextRecoveryTime || error?.retryAfter)
            .map(value => Date.parse(value || ''))
            .filter(value => Number.isFinite(value) && value > Date.now());
        const nextRecoveryTime = recoveryTimes.length > 0
            ? new Date(Math.min(...recoveryTimes)).toISOString()
            : null;
        const error = createGeminiRoutingError(
            `All Antigravity models are unavailable for ${normalizeAntigravityQuotaModel(requestedModel)}`,
            'ALL_MODELS_UNAVAILABLE',
            429,
            {
                quotaScope: 'model',
                quotaKey: normalizeAntigravityQuotaModel(requestedModel),
                nextRecoveryTime,
                retryAfter: nextRecoveryTime
            }
        );
        this._antigravityAvailabilityMetrics.allModelsUnavailable += 1;
        this._antigravityRoutingMetrics.allModelsUnavailable += 1;
        this._antigravityRoutingMetrics.retrySuppressed += 1;
        return error;
    }

    _shouldFastFailAntigravityModels(errors, models) {
        if (!Array.isArray(errors) || errors.length !== models.length || errors.length === 0) return false;
        if (!errors.every(error => error?.quotaScope === 'model')) return false;
        const recoveryTimes = errors.map(error => this._getRecoveryTimeFromError(error));
        if (recoveryTimes.some(value => Number.isFinite(value) && value <= Date.now())) return false;
        const futureRecoveries = recoveryTimes.filter(value => Number.isFinite(value) && value > Date.now());
        const nearestRecoveryMs = futureRecoveries.length > 0
            ? Math.min(...futureRecoveries) - Date.now()
            : null;
        return nearestRecoveryMs === null || nearestRecoveryMs > 2000;
    }

    _isAntigravityModelStillCooling(error, now = Date.now()) {
        if (error?.quotaScope !== 'model') return false;
        const recovery = this._getRecoveryTimeFromError(error);
        return Number.isFinite(recovery) && recovery > now;
    }

    _shouldWaitOnlyForModelRecovery(errors) {
        return Array.isArray(errors)
            && errors.length > 0
            && errors.every(error => error?.quotaScope === 'model');
    }

    async _acquireAntigravityElasticSlot(providerType, requestedModel, options = {}) {
        const policy = this._getAntigravityElasticRoutingConfig();
        const canonicalRequestedModel = normalizeAntigravityQuotaModel(requestedModel);
        const requestStore = requestContext.getStore();
        const requestRouting = requestStore.antigravityRouting || {
            attemptedModels: [],
            passAttemptedModels: [],
            skippedNotFoundModels: [],
            modelErrors: {},
            negativeCacheVersion: this._antigravityAvailabilityRevision,
            sourceModelCooldownMs: null
        };
        requestRouting.passAttemptedModels = Array.isArray(requestRouting.passAttemptedModels)
            ? requestRouting.passAttemptedModels
            : [];
        requestRouting.skippedNotFoundModels = Array.isArray(requestRouting.skippedNotFoundModels)
            ? requestRouting.skippedNotFoundModels
            : [];
        requestRouting.modelErrors = requestRouting.modelErrors && typeof requestRouting.modelErrors === 'object'
            ? requestRouting.modelErrors
            : {};
        requestStore.antigravityRouting = requestRouting;
        const configuredFallbacks = Array.isArray(policy.fallbackModels) ? policy.fallbackModels : [];
        const availableModels = this._getAntigravityVerifiedModels(providerType);
        await this._hydrateAntigravityModelNotFound(providerType);
        const models = this._excludeAntigravityModelsNotFound(
            providerType,
            [requestedModel, ...getAntigravityElasticFallbackModels(requestedModel, configuredFallbacks, availableModels)]
        );
        if (models.length === 0) throw this._createAntigravityModelNotFoundError(requestedModel);
        // The requested model itself may be the one upstream does not host, in
        // which case every surviving entry is a fallback and must be attempted.
        const sourceModelUsable = models[0] === requestedModel;
        const startedAt = Date.now();
        const deadline = startedAt + policy.maxQueueWaitMs;
        let queueEntry = null;
        let queueStartedAt = null;
        let latestErrors = [];
        let passOptions = {
            ...options,
            antigravityBaseCandidates: this._getAntigravityBaseCandidates(providerType, options)
        };

        const markStructuralSkip = (model, error) => {
            if (error?.code === 'MODEL_NOT_FOUND' || Number(error?.status) === 404 || this.isAntigravityModelNotFound(providerType, model)) {
                if (!requestRouting.skippedNotFoundModels.includes(model)) {
                    requestRouting.skippedNotFoundModels.push(model);
                }
            }
        };

        const attemptModels = async ({ includeSource = true, resetPass = false } = {}) => {
            if (resetPass) requestRouting.passAttemptedModels = [];
            latestErrors = [];
            const startIndex = (includeSource || !sourceModelUsable) ? 0 : 1;
            for (let index = startIndex; index < models.length; index += 1) {
                const model = models[index];
                if (requestRouting.skippedNotFoundModels.includes(model) || this.isAntigravityModelNotFound(providerType, model)) {
                    this._antigravityRoutingMetrics.retrySuppressed += 1;
                    continue;
                }
                const priorError = requestRouting.modelErrors[model];
                if (this._isAntigravityModelStillCooling(priorError)) {
                    this._antigravityRoutingMetrics.retrySuppressed += 1;
                    latestErrors.push(priorError);
                    continue;
                }
                if (requestRouting.passAttemptedModels.includes(model)) {
                    this._antigravityRoutingMetrics.retrySuppressed += 1;
                    continue;
                }
                requestRouting.passAttemptedModels.push(model);
                if (!requestRouting.attemptedModels.includes(model)) requestRouting.attemptedModels.push(model);
                if (index === 0) this._antigravityRoutingMetrics.sourceAttempts += 1;
                else this._antigravityRoutingMetrics.fallbackAttempts += 1;
                const attempt = await this._tryAntigravityElasticModel(providerType, model, passOptions);
                if (attempt.config) {
                    const isFallback = model !== requestedModel;
                    if (isFallback) {
                        this.recordGeminiSchedulingEvent('fallbacks');
                        this._antigravityRoutingMetrics.fallbackSuccesses += 1;
                    }
                    return {
                        config: attempt.config,
                        actualProviderType: providerType,
                        actualModel: model,
                        isFallback,
                        modelFallbackReason: isFallback ? 'SOURCE_MODEL_UNAVAILABLE' : null,
                        fallbackAttemptCount: index,
                        queueWaitMs: queueEntry ? Date.now() - startedAt : 0
                    };
                }
                markStructuralSkip(model, attempt.error);
                if (attempt.error) requestRouting.modelErrors[model] = attempt.error;
                latestErrors.push(attempt.error);
            }
            return null;
        };

        try {
            let sourceAttempt = { config: null, error: null };
            if (sourceModelUsable) {
                if (!requestRouting.attemptedModels.includes(requestedModel)) requestRouting.attemptedModels.push(requestedModel);
                if (!requestRouting.passAttemptedModels.includes(requestedModel)) requestRouting.passAttemptedModels.push(requestedModel);
                sourceAttempt = await this._tryAntigravityElasticModel(providerType, requestedModel, passOptions);
                this._antigravityRoutingMetrics.sourceAttempts += 1;
                if (sourceAttempt.config) {
                    return {
                        config: sourceAttempt.config,
                        actualProviderType: providerType,
                        actualModel: requestedModel,
                        isFallback: false,
                        fallbackAttemptCount: 0,
                        queueWaitMs: 0
                    };
                }
                markStructuralSkip(requestedModel, sourceAttempt.error);
                if (sourceAttempt.error) requestRouting.modelErrors[requestedModel] = sourceAttempt.error;
            }

            const sourceRecovery = this._getRecoveryTimeFromError(sourceAttempt.error);
            const sourceWaitMs = sourceRecovery ? sourceRecovery - Date.now() : Infinity;
            requestRouting.sourceModelCooldownMs = sourceWaitMs === Infinity ? null : Math.max(0, sourceWaitMs);
            requestRouting.negativeCacheVersion = this._antigravityAvailabilityRevision;
            if (sourceWaitMs > 0 && sourceWaitMs <= policy.preferOriginalWaitMs) {
                queueEntry = await this._acquireGeminiElasticQueueEntry(requestedModel, options, policy);
                queueStartedAt = Date.now();
                this._antigravityRoutingMetrics.queueEnqueued += 1;
                await this._waitForGeminiElasticWakeTracked({
                    timeoutMs: Math.min(sourceWaitMs, Math.max(1, deadline - Date.now())),
                    abortSignal: options.abortSignal,
                    providerType
                });
                this.invalidateAntigravityAvailability(canonicalRequestedModel);
                const jitterRange = Math.max(0, policy.recoveryJitterMaxMs - policy.recoveryJitterMinMs);
                const jitterMs = policy.recoveryJitterMinMs + Math.floor(Math.random() * (jitterRange + 1));
                if (jitterMs > 0 && Date.now() < deadline) {
                    await this._waitForGeminiElasticWakeTracked({
                        timeoutMs: Math.min(jitterMs, Math.max(1, deadline - Date.now())),
                        abortSignal: options.abortSignal,
                        providerType
                    });
                }
                passOptions = {
                    ...options,
                    antigravityBaseCandidates: this._getAntigravityBaseCandidates(providerType, options)
                };
                const recovered = await this._tryAntigravityElasticModel(providerType, requestedModel, passOptions);
                if (recovered.config) {
                    return {
                        config: recovered.config,
                        actualProviderType: providerType,
                        actualModel: requestedModel,
                        isFallback: false,
                        queueOutcome: 'recovered_original',
                        fallbackAttemptCount: 0,
                        queueWaitMs: Date.now() - startedAt
                    };
                }
                if (recovered.error) requestRouting.modelErrors[requestedModel] = recovered.error;
            }

            const immediateFallback = await attemptModels({ includeSource: false });
            if (immediateFallback) return immediateFallback;
            const allModelErrors = sourceModelUsable
                ? [sourceAttempt.error, ...latestErrors]
                : [...latestErrors];
            if (this._shouldFastFailAntigravityModels(allModelErrors, models)) {
                throw this._createAntigravityAllModelsUnavailableError(requestedModel, allModelErrors);
            }
            if (!queueEntry) {
                queueEntry = await this._acquireGeminiElasticQueueEntry(requestedModel, options, policy);
                queueStartedAt = Date.now();
                this._antigravityRoutingMetrics.queueEnqueued += 1;
            }

            while (Date.now() < deadline) {
                const now = Date.now();
                const recoveryTimes = latestErrors
                    .map(error => this._getRecoveryTimeFromError(error))
                    .filter(value => Number.isFinite(value) && value > now);
                const nearestRecovery = recoveryTimes.length > 0 ? Math.min(...recoveryTimes) : null;
                const remainingMs = Math.max(1, deadline - now);
                const recoveryDelay = nearestRecovery ? Math.max(1, nearestRecovery - now) : remainingMs;
                const quotaOnly = nearestRecovery !== null && this._shouldWaitOnlyForModelRecovery(latestErrors);
                const wakeCapMs = (!quotaOnly && this.coordination) ? 1000 : remainingMs;
                await this._waitForGeminiElasticWakeTracked({
                    timeoutMs: Math.min(remainingMs, recoveryDelay, wakeCapMs),
                    abortSignal: options.abortSignal,
                    providerType
                });
                this.invalidateAntigravityAvailability(canonicalRequestedModel, {
                    minIntervalMs: ANTIGRAVITY_AVAILABILITY_INVALIDATE_MIN_INTERVAL_MS
                });
                passOptions = {
                    ...options,
                    antigravityBaseCandidates: this._getAntigravityBaseCandidates(providerType, options)
                };
                const selected = await attemptModels({ includeSource: true, resetPass: true });
                if (selected) {
                    selected.queueOutcome = selected.isFallback ? 'fallback_after_wait' : 'recovered_original';
                    return selected;
                }
                if (this._shouldFastFailAntigravityModels(latestErrors, models)) {
                    throw this._createAntigravityAllModelsUnavailableError(requestedModel, latestErrors);
                }
            }

            const recoveryTimes = latestErrors
                .map(error => this._getRecoveryTimeFromError(error))
                .filter(value => Number.isFinite(value) && value > Date.now());
            const nextRecoveryTime = recoveryTimes.length > 0
                ? new Date(Math.min(...recoveryTimes)).toISOString()
                : null;
            this._antigravityRoutingMetrics.queueTimeouts += 1;
            throw createGeminiRoutingError(
                `Gemini model queue wait timed out after ${policy.maxQueueWaitMs}ms`,
                'QUEUE_WAIT_TIMEOUT',
                429,
                {
                    quotaScope: 'model',
                    quotaKey: normalizeAntigravityQuotaModel(requestedModel),
                    nextRecoveryTime,
                    retryAfter: nextRecoveryTime
                }
            );
        } finally {
            if (queueEntry && queueStartedAt !== null) {
                this._antigravityRoutingMetrics.queueWaitMs += Math.max(0, Date.now() - queueStartedAt);
            }
            await this._releaseGeminiElasticQueueEntry(queueEntry);
        }
    }

    recordGeminiSchedulingEvent(field) {
        return this.coordination?.recordGeminiSchedulingEvent?.(field) === true;
    }

    /**
     * 获取一个可用的提供商插槽，支持 Fallback 机制
     */
    async acquireSlotWithFallback(providerType, requestedModel = null, options = {}) {
        if (!providerType || typeof providerType !== 'string') {
            this._log('error', `Invalid providerType: ${providerType}`);
            return null;
        }

        if (this._isAntigravityElasticRoutingEligible(providerType, requestedModel)) {
            return this._acquireAntigravityElasticSlot(providerType, requestedModel, options);
        }

        // Gemini stays on the same provider type, but model fallback is still
        // allowed when the requested model has no selectable credential.
        if (isGeminiProviderType(providerType)) {
            return this._selectGeminiWithModelFallback(
                providerType,
                requestedModel,
                options,
                model => this.acquireSlot(providerType, model, options)
            );
        }

        if (options.disableProviderFallback === true) {
            const selectedConfig = await this.acquireSlot(providerType, requestedModel, options);
            return selectedConfig
                ? {
                    config: selectedConfig,
                    actualProviderType: providerType,
                    isFallback: false
                }
                : null;
        }

        const mixedSlot = options.routingStrategy === 'image-round-robin'
            ? null
            : await this.acquireSlotFromMixedPool(providerType, requestedModel, options);
        if (mixedSlot) {
            return mixedSlot;
        }

        const triedTypes = new Set();
        const typesToTry = [providerType];
        
        const fallbackTypes = this.fallbackChain[providerType] || [];
        if (Array.isArray(fallbackTypes)) {
            typesToTry.push(...fallbackTypes);
        }
        let codex53QuotaFallbackReason = null;
        let modelFallbackReason = null;
        const modelFallbackTarget = getCodexModelFallbackTarget(requestedModel, this.globalConfig);
        let lastQuotaError = null;

        for (const currentType of typesToTry) {
            if (triedTypes.has(currentType)) continue;
            triedTypes.add(currentType);

            if (!this.providerStatus[currentType] || this.providerStatus[currentType].length === 0) {
                continue;
            }

            if (currentType !== providerType && requestedModel) {
                const primaryProtocol = getProtocolPrefix(providerType);
                const fallbackProtocol = getProtocolPrefix(currentType);
                if (primaryProtocol !== fallbackProtocol) continue;

                const supportedModels = getProviderModels(currentType);
                if (supportedModels.length > 0 && !supportedModels.includes(requestedModel)) continue;
            }

            // 尝试获取插槽
            try {
                const selectedConfig = await this.acquireSlot(currentType, requestedModel, options);
                if (selectedConfig) {
                    if (currentType !== providerType) {
                        this._log('info', `Fallback Slot activated (Chain): ${providerType} -> ${currentType} (node: ${this._getDisplayName(selectedConfig)})`);
                    }
                    return {
                        config: selectedConfig,
                        actualProviderType: currentType,
                        isFallback: currentType !== providerType
                    };
                }
            } catch (err) {
                if (shouldTryCodex53QuotaModelFallback(currentType, requestedModel, err, this.globalConfig)
                    || (currentType === providerType && isCodex53SparkModel(requestedModel))) {
                    codex53QuotaFallbackReason = err.message;
                    break;
                }
                if (modelFallbackTarget && (err.status === 429 || err.code === 429)) {
                    modelFallbackReason = err.message;
                    break;
                }
                if (err.status === 429) {
                    // 如果是因为 429 (并发/队列满)，尝试下一个 Fallback
                    if (err.quotaScope) lastQuotaError = err;
                    this._log('info', `Type ${currentType} busy (429), trying next fallback...`);
                    continue;
                }
                throw err; // 其他错误抛出
            }
            if (currentType === providerType && isCodex53SparkModel(requestedModel)) {
                codex53QuotaFallbackReason = `No selectable provider for ${requestedModel}`;
                break;
            }
        }

        if (codex53QuotaFallbackReason) {
            const targetModel = getCodex53QuotaFallbackModel(this.globalConfig);
            this._log('info', `Trying Codex 5.3 quota fallback for ${requestedModel}: -> ${providerType} (${targetModel}); reason: ${codex53QuotaFallbackReason}`);
            const selectedConfig = await this.acquireSlot(providerType, targetModel, options);
            if (selectedConfig) {
                this._log('info', `Fallback Slot activated (Codex 5.3 quota): ${providerType} (${requestedModel}) -> ${providerType} (${targetModel}) (node: ${this._getDisplayName(selectedConfig)})`);
                return {
                    config: selectedConfig,
                    actualProviderType: providerType,
                    isFallback: true,
                    actualModel: targetModel
                };
            }
        }

        if (modelFallbackTarget && !codex53QuotaFallbackReason) {
            const selectedConfig = await this.acquireSlot(providerType, modelFallbackTarget, options);
            if (selectedConfig) {
                return {
                    config: selectedConfig,
                    actualProviderType: providerType,
                    isFallback: true,
                    actualModel: modelFallbackTarget,
                    modelFallbackReason: modelFallbackReason || 'SOURCE_MODEL_UNAVAILABLE'
                };
            }
        }

        // Model Fallback Mapping
        if (requestedModel && this.modelFallbackMapping && this.modelFallbackMapping[requestedModel]) {
            const mapping = this.modelFallbackMapping[requestedModel];
            const targetProviderType = mapping.targetProviderType;
            const targetModel = mapping.targetModel;

            if (targetProviderType && targetModel) {
                if (this.providerStatus[targetProviderType] && this.providerStatus[targetProviderType].length > 0) {
                    try {
                        const selectedConfig = await this.acquireSlot(targetProviderType, targetModel, options);
                        if (selectedConfig) {
                            return {
                                config: selectedConfig,
                                actualProviderType: targetProviderType,
                                isFallback: true,
                                actualModel: targetModel
                            };
                        }
                    } catch (err) {
                        // 如果目标类型繁忙，尝试它的 fallback chain
                        const targetFallbackTypes = this.fallbackChain[targetProviderType] || [];
                        for (const fallbackType of targetFallbackTypes) {
                             const targetProtocol = getProtocolPrefix(targetProviderType);
                             const fallbackProtocol = getProtocolPrefix(fallbackType);
                             if (targetProtocol !== fallbackProtocol) continue;
                             
                             const supportedModels = getProviderModels(fallbackType);
                             if (supportedModels.length > 0 && !supportedModels.includes(targetModel)) continue;
                             
                             try {
                                const fallbackSelectedConfig = await this.acquireSlot(fallbackType, targetModel, options);
                                if (fallbackSelectedConfig) {
                                    return {
                                        config: fallbackSelectedConfig,
                                        actualProviderType: fallbackType,
                                        isFallback: true,
                                        actualModel: targetModel
                                    };
                                }
                             } catch (e) {
                                 continue;
                             }
                        }
                    }
                }
            }
        }

        if (lastQuotaError) throw lastQuotaError;
        return null;
    }

    /**
     * Selects a provider from the pool with fallback support.
     * When the primary provider type has no healthy providers, it will try fallback types.
     * @param {string} providerType - The primary type of provider to select.
     * @param {string} [requestedModel] - Optional. The model name to filter providers by.
     * @param {Object} [options] - Optional. Additional options.
     * @param {boolean} [options.skipUsageCount] - Optional. If true, skip incrementing usage count.
     * @returns {object|null} An object containing the selected provider's configuration and the actual provider type used, or null if no healthy provider is found.
     */
    /**
     * Selects a provider from the pool with fallback support.
     * When the primary provider type has no healthy providers, it will try fallback types.
     *
     * 注意：此方法现在返回 Promise，因为内部调用的 selectProvider 是异步的。
     *
     * @param {string} providerType - The primary type of provider to select.
     * @param {string} [requestedModel] - Optional. The model name to filter providers by.
     * @param {Object} [options] - Optional. Additional options.
     * @param {boolean} [options.skipUsageCount] - Optional. If true, skip incrementing usage count.
     * @returns {Promise<object|null>} An object containing the selected provider's configuration and the actual provider type used, or null if no healthy provider is found.
     */
    async selectProviderWithFallback(providerType, requestedModel = null, options = {}) {
        // 参数校验
        if (!providerType || typeof providerType !== 'string') {
            this._log('error', `Invalid providerType: ${providerType}`);
            return null;
        }

        if (this._isAntigravityElasticRoutingEligible(providerType, requestedModel)) {
            return this._acquireAntigravityElasticSlot(providerType, requestedModel, options);
        }

        // Gemini stays on the same provider type, but model fallback is still
        // allowed when the requested model has no selectable credential.
        if (isGeminiProviderType(providerType)) {
            return this._selectGeminiWithModelFallback(
                providerType,
                requestedModel,
                options,
                model => this.selectProvider(providerType, model, options)
            );
        }

        if (options.disableProviderFallback === true) {
            const selectedConfig = await this.selectProvider(providerType, requestedModel, options);
            return selectedConfig
                ? {
                    config: selectedConfig,
                    actualProviderType: providerType,
                    isFallback: false
                }
                : null;
        }

        const mixedSelection = options.routingStrategy === 'image-round-robin'
            ? null
            : await this.selectProviderFromMixedPool(providerType, requestedModel, options);
        if (mixedSelection) {
            return mixedSelection;
        }

        const exhaustedFastPath = await this._getCodex53ExhaustedFastPath(providerType, requestedModel);
        if (exhaustedFastPath) {
            const targetModel = getCodex53QuotaFallbackModel(this.globalConfig);
            const selectedConfig = await this.selectProvider(providerType, targetModel, options);
            if (selectedConfig) {
                this._log('info', `Fast path activated (Codex 5.3 quota): ${providerType} (${requestedModel}) -> ${providerType} (${targetModel}) (snapshot exhausted)`);
                return {
                    config: selectedConfig,
                    actualProviderType: providerType,
                    isFallback: true,
                    actualModel: targetModel,
                    modelFallbackReason: 'CODEX53_POOL_EXHAUSTED'
                };
            }
            this._codexQuotaFilterMetrics.fastPathFallbackFailures += 1;
        }

        // ==========================
        // 优先级 1: Provider Fallback Chain (同协议/兼容协议的回退)
        // ==========================
        
        // 记录尝试过的类型，避免循环
        const triedTypes = new Set();
        const typesToTry = [providerType];
        
        const fallbackTypes = this.fallbackChain[providerType] || [];
        if (Array.isArray(fallbackTypes)) {
            typesToTry.push(...fallbackTypes);
        }
        let codex53QuotaFallbackReason = null;
        let modelFallbackReason = null;
        const modelFallbackTarget = getCodexModelFallbackTarget(requestedModel, this.globalConfig);

        for (const currentType of typesToTry) {
            // 避免重复尝试
            if (triedTypes.has(currentType)) {
                continue;
            }
            triedTypes.add(currentType);

            // 检查该类型是否有配置的池
            if (!this.providerStatus[currentType] || this.providerStatus[currentType].length === 0) {
                this._log('debug', `No provider pool configured for type: ${currentType}`);
                continue;
            }

            // 如果是 fallback 类型，需要检查模型兼容性
            if (currentType !== providerType && requestedModel) {
                // 检查协议前缀是否兼容
                const primaryProtocol = getProtocolPrefix(providerType);
                const fallbackProtocol = getProtocolPrefix(currentType);
                
                if (primaryProtocol !== fallbackProtocol) {
                    this._log('debug', `Skipping fallback type ${currentType}: protocol mismatch (${primaryProtocol} vs ${fallbackProtocol})`);
                    continue;
                }

                // 检查 fallback 类型是否支持请求的模型
                const supportedModels = getProviderModels(currentType);
                if (supportedModels.length > 0 && !supportedModels.includes(requestedModel)) {
                    this._log('debug', `Skipping fallback type ${currentType}: model ${requestedModel} not supported`);
                    continue;
                }
            }

            // 尝试从当前类型选择提供商（现在是异步的）
            let selectedConfig;
            try {
                selectedConfig = await this.selectProvider(currentType, requestedModel, options);
            } catch (error) {
                if (shouldTryCodex53QuotaModelFallback(currentType, requestedModel, error, this.globalConfig)
                    || (currentType === providerType && isCodex53SparkModel(requestedModel))) {
                    codex53QuotaFallbackReason = error.message;
                    break;
                }
                if (modelFallbackTarget && (error.status === 429 || error.code === 429)) {
                    modelFallbackReason = error.message;
                    break;
                }
                throw error;
            }
            
            if (selectedConfig) {
                if (currentType !== providerType) {
                    this._log('info', `Fallback activated (Chain): ${providerType} -> ${currentType} (node: ${this._getDisplayName(selectedConfig)})`);
                }
                return {
                    config: selectedConfig,
                    actualProviderType: currentType,
                    isFallback: currentType !== providerType
                };
            }
            if (currentType === providerType && isCodex53SparkModel(requestedModel)) {
                codex53QuotaFallbackReason = `No selectable provider for ${requestedModel}`;
                break;
            }
        }

        if (codex53QuotaFallbackReason) {
            const targetModel = getCodex53QuotaFallbackModel(this.globalConfig);
            this._log('info', `Trying Codex 5.3 quota fallback for ${requestedModel}: -> ${providerType} (${targetModel}); reason: ${codex53QuotaFallbackReason}`);
            const selectedConfig = await this.selectProvider(providerType, targetModel, options);

            if (selectedConfig) {
                this._log('info', `Fallback activated (Codex 5.3 quota): ${providerType} (${requestedModel}) -> ${providerType} (${targetModel}) (node: ${this._getDisplayName(selectedConfig)})`);
                return {
                    config: selectedConfig,
                    actualProviderType: providerType,
                    isFallback: true,
                    actualModel: targetModel
                };
            }
        }

        if (modelFallbackTarget && !codex53QuotaFallbackReason) {
            const selectedConfig = await this.selectProvider(providerType, modelFallbackTarget, options);
            if (selectedConfig) {
                return {
                    config: selectedConfig,
                    actualProviderType: providerType,
                    isFallback: true,
                    actualModel: modelFallbackTarget,
                    modelFallbackReason: modelFallbackReason || 'SOURCE_MODEL_UNAVAILABLE'
                };
            }
        }

        // ==========================
        // 优先级 2: Model Fallback Mapping (跨协议/特定模型的回退)
        // ==========================

        if (requestedModel && this.modelFallbackMapping && this.modelFallbackMapping[requestedModel]) {
            const mapping = this.modelFallbackMapping[requestedModel];
            const targetProviderType = mapping.targetProviderType;
            const targetModel = mapping.targetModel;

            if (targetProviderType && targetModel) {
                this._log('info', `Trying Model Fallback Mapping for ${requestedModel}: -> ${targetProviderType} (${targetModel})`);
                
                // 递归调用 selectProviderWithFallback，但这次针对目标提供商类型
                // 注意：这里我们直接尝试从目标提供商池中选择，因为如果再次递归可能会导致死循环或逻辑复杂化
                // 简单起见，我们直接尝试选择目标提供商
                
                // 检查目标类型是否有配置的池
                if (this.providerStatus[targetProviderType] && this.providerStatus[targetProviderType].length > 0) {
                    // 尝试从目标类型选择提供商（使用转换后的模型名，现在是异步的）
                    const selectedConfig = await this.selectProvider(targetProviderType, targetModel, options);
                    
                    if (selectedConfig) {
                        this._log('info', `Fallback activated (Model Mapping): ${providerType} (${requestedModel}) -> ${targetProviderType} (${targetModel}) (node: ${this._getDisplayName(selectedConfig)})`);
                        return {
                            config: selectedConfig,
                            actualProviderType: targetProviderType,
                            isFallback: true,
                            actualModel: targetModel // 返回实际使用的模型名，供上层进行请求转换
                        };
                    } else {
                        // 如果目标类型的主池也不可用，尝试目标类型的 fallback chain
                        // 例如 claude-kiro-oauth (mapped) -> claude-custom (chain)
                        // 这需要我们小心处理，避免无限递归。
                        // 我们可以手动检查目标类型的 fallback chain
                        
                        const targetFallbackTypes = this.fallbackChain[targetProviderType] || [];
                        for (const fallbackType of targetFallbackTypes) {
                             // 检查协议兼容性 (目标类型 vs 它的 fallback)
                             const targetProtocol = getProtocolPrefix(targetProviderType);
                             const fallbackProtocol = getProtocolPrefix(fallbackType);
                             
                             if (targetProtocol !== fallbackProtocol) continue;
                             
                             // 检查模型支持
                             const supportedModels = getProviderModels(fallbackType);
                             if (supportedModels.length > 0 && !supportedModels.includes(targetModel)) continue;
                             
                             const fallbackSelectedConfig = await this.selectProvider(fallbackType, targetModel, options);
                             if (fallbackSelectedConfig) {
                                 this._log('info', `Fallback activated (Model Mapping -> Chain): ${providerType} (${requestedModel}) -> ${targetProviderType} -> ${fallbackType} (${targetModel}) (node: ${this._getDisplayName(fallbackSelectedConfig)})`);
                                 return {
                                     config: fallbackSelectedConfig,
                                     actualProviderType: fallbackType,
                                     isFallback: true,
                                     actualModel: targetModel
                                 };
                             }
                        }
                    }
                } else {
                    this._log('warn', `Model Fallback target provider ${targetProviderType} not configured or empty.`);
                }
            }
        }

        this._log('warn', `None available provider found for ${providerType} (Model: ${requestedModel}) after checking fallback chain and model mapping.`);
        return null;
    }

    /**
     * Gets the fallback chain for a given provider type.
     * @param {string} providerType - The provider type to get fallback chain for.
     * @returns {Array<string>} The fallback chain array, or empty array if not configured.
     */
    getFallbackChain(providerType) {
        return this.fallbackChain[providerType] || [];
    }

    /**
     * Sets or updates the fallback chain for a provider type.
     * @param {string} providerType - The provider type to set fallback chain for.
     * @param {Array<string>} fallbackTypes - Array of fallback provider types.
     */
    setFallbackChain(providerType, fallbackTypes) {
        if (!Array.isArray(fallbackTypes)) {
            this._log('error', `Invalid fallbackTypes: must be an array`);
            return;
        }
        this.fallbackChain[providerType] = fallbackTypes;
        this._log('info', `Updated fallback chain for ${providerType}: ${fallbackTypes.join(' -> ')}`);
    }

    /**
     * Checks if all providers of a given type are unhealthy.
     * @param {string} providerType - The provider type to check.
     * @returns {boolean} True if all providers are unhealthy or disabled.
     */
    isAllProvidersUnhealthy(providerType) {
        const providers = this.providerStatus[providerType] || [];
        if (providers.length === 0) {
            return true;
        }
        return providers.every(p => !p.config.isHealthy || p.config.isDisabled);
    }

    /**
     * Gets statistics about provider health for a given type.
     * @param {string} providerType - The provider type to get stats for.
     * @returns {Object} Statistics object with total, healthy, unhealthy, and disabled counts.
     */
    getProviderStats(providerType) {
        const providers = this.providerStatus[providerType] || [];
        const stats = {
            total: providers.length,
            healthy: 0,
            unhealthy: 0,
            disabled: 0
        };
        
        for (const p of providers) {
            if (p.config.isDisabled) {
                stats.disabled++;
            } else if (p.config.isHealthy) {
                stats.healthy++;
            } else {
                stats.unhealthy++;
            }
        }
        
        return stats;
    }

    /**
     * Gets all available models across all provider pools, with optional format conversion.
     * @param {string} [endpointType] - Optional endpoint type for format conversion (OPENAI_MODEL_LIST or GEMINI_MODEL_LIST).
     * @returns {Promise<Object|Array>} Formatted model list or raw array of model objects.
     */
    async getAllAvailableModels(endpointType = null) {
        const allModels = [];
        
        // 获取所有已注册的提供商和号池中的提供商
        const registeredProviders = getRegisteredProviders();
        const allProviderTypes = Array.from(new Set([...registeredProviders]));

        for (const providerType of allProviderTypes) {
            if (this.providerStatus[providerType]) {
                const customAliases = getCustomModelAliasesForProvider(this.globalConfig, providerType);
                const customModelIds = getCustomModelIdsForProvider(this.globalConfig, providerType);
                const configuredSupportedModels = normalizeModelIds(
                    this.providerStatus[providerType].flatMap(providerStatus =>
                        getConfiguredSupportedModels(providerType, providerStatus.config)
                    )
                );
                let models = configuredSupportedModels.length > 0
                    ? normalizeModelIds([...configuredSupportedModels, ...customModelIds])
                    : normalizeModelIds([
                        ...getProviderModels(providerType).filter(model => !customAliases.has(model)),
                        ...customModelIds
                    ]);

                // 如果硬编码的模型列表为空，或者该类型的提供商在号池中没有配置节点，尝试从服务获取
                // 只有在非号池模式，或者号池中有节点时才尝试获取，避免无节点时读取全局默认配置
                if (models.length === 0 && (!this.providerStatus[providerType] || this.providerStatus[providerType].length > 0)) {
                    try {
                        // 确定使用的配置：优先使用号池中第一个节点的配置，否则使用全局配置
                        let targetConfig = this.globalConfig;
                        if (this.providerStatus[providerType] && this.providerStatus[providerType].length > 0) {
                            targetConfig = this.providerStatus[providerType][0].config;
                        } else {
                            // 如果该提供商是属于号池类型的提供商（在 PROVIDER_MAPPINGS 中），且号池为空，则不应尝试读取全局配置
                            const { PROVIDER_MAPPINGS } = await import('../utils/provider-utils.js');
                            const isPoolable = PROVIDER_MAPPINGS.some(m => m.providerType === providerType);
                            if (isPoolable) {
                                this._log('debug', `Skipping model fetch for poolable provider ${providerType} with empty pool to avoid reading default config.`);
                                continue;
                            }
                        }

                        const tempConfig = {
                            ...this.globalConfig,
                            ...targetConfig,
                            MODEL_PROVIDER: providerType
                        };
                        delete tempConfig.providerPools;
                        const serviceAdapter = getServiceAdapter(tempConfig);
                        
                        if (typeof serviceAdapter.listModels === 'function') {
                            const nativeModels = await serviceAdapter.listModels();
                            // 统一转换为 OpenAI 格式以便提取 ID
                            const convertedData = convertData(nativeModels, 'modelList', providerType, MODEL_PROVIDER.OPENAI_CUSTOM);
                            if (convertedData && Array.isArray(convertedData.data)) {
                                const fetchedModels = convertedData.data.map(m => m.id);
                                if (fetchedModels.length > 0) {
                                    models = fetchedModels;
                                }
                            }
                        }
                    } catch (err) {
                        this._log('debug', `Failed to fetch model list for ${providerType} from service: ${err.message}`);
                        // 保持原有的 models (可能是硬编码的空列表或 getProviderModels 返回的结果)
                    }
                }

                for (const model of models) {
                    allModels.push({
                        id: `${providerType}:${model}`,
                        provider: providerType,
                        model: model
                    });
                }
            }
        }
        
        // 如果没有指定 endpointType，返回原始数组
        if (!endpointType) {
            return allModels;
        }
        
        // 根据 endpointType 转换为对应格式        
        if (endpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST) {
            // OpenAI 格式聚合
            return {
                object: "list",
                data: allModels.map(m => ({
                    id: m.id,
                    object: "model",
                    created: Math.floor(Date.now() / 1000),
                    owned_by: m.provider
                }))
            };
        } else if (endpointType === ENDPOINT_TYPE.GEMINI_MODEL_LIST) {
            // Gemini 格式聚合
            return {
                models: allModels.map(m => ({
                    name: `models/${m.id}`,
                    baseModelId: m.model,
                    version: "v1",
                    displayName: `${m.model} (${m.provider})`,
                    description: `Model ${m.model} provided by ${m.provider}`,
                    supportedGenerationMethods: ["generateContent", "countTokens"]
                }))
            };
        }
        
        // 默认返回空列表
        return { data: [] };
    }

    /**
     * 标记提供商需要刷新并推入刷新队列
     * @param {string} providerType - 提供商类型
     * @param {object} providerConfig - 提供商配置（包含 uuid）
     */
    markProviderNeedRefresh(providerType, providerConfig) {

        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in markProviderNeedRefresh');
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            // 防并发机制 A: 如果已经在刷新中，忽略请求
            if (this.refreshingUuids.has(provider.uuid)) {
                this._log('info', `Provider ${this._getDisplayName(providerConfig)} is already in refresh queue, ignoring duplicate refresh request.`);
                return;
            }

            // 防并发机制 B: 如果 30 秒内刚刷新过，忽略请求（防止滞后的 401 错误导致重复刷新）
            const now = Date.now();
            const lastRefreshActivityTime = Math.max(
                Number(provider.config.lastRefreshTime || 0),
                Number(provider.config.lastRefreshAttemptTime || 0)
            );
            if (now - lastRefreshActivityTime < 30000) {
                this._log('info', `Provider ${this._getDisplayName(providerConfig)} had recent refresh activity (${Math.round((now - lastRefreshActivityTime)/1000)}s ago), ignoring refresh request.`);
                return;
            }

            provider.config.needsRefresh = true;
            provider.config.lastHealthStateTime = new Date().toISOString();
            this._log('info', `Marked provider ${this._getDisplayName(providerConfig)} as needsRefresh. Enqueuing...`);
            
            // 推入异步刷新队列
            this._enqueueRefresh(providerType, provider, true);
            
            this._debouncedSave(providerType);
        } else {
            let matchedType = null;
            for (const [type, providers] of Object.entries(this.providerStatus || {})) {
                if (providers.some(p => p.uuid === providerConfig.uuid)) {
                    matchedType = type;
                    break;
                }
            }
            const knownTypes = Object.keys(this.providerStatus || {}).join(', ') || 'none';
            const typeHint = matchedType ? ` Found same uuid under provider type ${matchedType}.` : '';
            this._log('warn', `Provider ${this._getDisplayName(providerConfig)} not found in providerStatus for type ${providerType}; refresh not enqueued.${typeHint} Known provider types: ${knownTypes}`);
        }
    }

    /**
     * Marks a provider as unhealthy (e.g., after an API error).
     * @param {string} providerType - The type of the provider.
     * @param {object} providerConfig - The configuration of the provider to mark.
     * @param {string} [errorMessage] - Optional error message to store.
     */
    markProviderUnhealthy(providerType, providerConfig, errorMessage = null) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in markProviderUnhealthy');
            return;
        }

        if (isCodexProviderType(providerType) && isCodexQuotaExhaustionMessage(errorMessage)) {
            this._log('info', `Ignoring Codex quota exhaustion as provider failure for ${this._getDisplayName(providerConfig)}`);
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            const wasHealthy = provider.config.isHealthy;
            const now = Date.now();
            const lastErrorTime = provider.config.lastErrorTime ? new Date(provider.config.lastErrorTime).getTime() : 0;
            const errorWindowMs = 10000; // 10 秒窗口期

            // 如果距离上次错误超过窗口期，重置错误计数
            if (now - lastErrorTime > errorWindowMs) {
                provider.config.errorCount = 1;
            } else {
                provider.config.errorCount++;
            }

            provider.config.lastErrorTime = new Date().toISOString();
            provider.config.lastHealthStateTime = new Date().toISOString();
            // 更新 lastUsed 时间，避免因 LRU 策略导致失败节点被重复选中
            provider.config.lastUsed = new Date().toISOString();
            
            // 只要报错，就清除刷新标记，由下次触发或健康检查决定是否需要刷新
            provider.config.needsRefresh = false;
            provider.config.refreshCount = 0;

            // 保存错误信息
            if (errorMessage) {
                provider.config.lastErrorMessage = errorMessage;
            }

            if (this.maxErrorCount > 0 && provider.config.errorCount >= this.maxErrorCount) {
                provider.config.isHealthy = false;
                
                // 健康状态变化日志
                if (wasHealthy) {
                    this._logHealthStatusChange(providerType, provider.config, 'healthy', 'unhealthy', errorMessage);
                }
                
                this._log('warn', `Marked provider as unhealthy: ${this._getDisplayName(providerConfig)} for type ${providerType}. Total errors: ${provider.config.errorCount}`);
            } 

            this._debouncedSave(providerType);
        }
    }

    /**
     * Marks a provider as unhealthy immediately (without accumulating error count).
     * Used for definitive authentication errors like 401/403.
     * @param {string} providerType - The type of the provider.
     * @param {object} providerConfig - The configuration of the provider to mark.
     * @param {string} [errorMessage] - Optional error message to store.
     */
    markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage = null) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in markProviderUnhealthyImmediately');
            return;
        }

        if (isCodexProviderType(providerType) && isCodexQuotaExhaustionMessage(errorMessage)) {
            this._log('info', `Ignoring Codex quota exhaustion as provider failure for ${this._getDisplayName(providerConfig)}`);
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            const wasHealthy = provider.config.isHealthy;
            provider.config.isHealthy = false;
            provider.config.needsRefresh = false; // 报错时不健康，清除刷新标记，防止卡死
            provider.config.refreshCount = 0;
            provider.config.errorCount = this.maxErrorCount; // Set to max to indicate definitive failure
            provider.config.lastErrorTime = new Date().toISOString();
            provider.config.lastHealthStateTime = new Date().toISOString();
            provider.config.lastUsed = new Date().toISOString();

            if (errorMessage) {
                provider.config.lastErrorMessage = errorMessage;
            }

            // 健康状态变化日志
            if (wasHealthy) {
                this._logHealthStatusChange(providerType, provider.config, 'healthy', 'unhealthy', errorMessage);
            }

            this._log('warn', `Immediately marked provider as unhealthy: ${this._getDisplayName(providerConfig)} for type ${providerType}. Reason: ${errorMessage || 'Authentication error'}`);
           
            this._debouncedSave(providerType);
        }
    }

    /**
     * Marks a provider as unhealthy with a scheduled recovery time.
     * Used for quota exhaustion errors (402) where the quota will reset at a specific time.
     * @param {string} providerType - The type of the provider.
     * @param {object} providerConfig - The configuration of the provider to mark.
     * @param {string} [errorMessage] - Optional error message to store.
     * @param {Date|string} [recoveryTime] - Optional recovery time when the provider should be marked healthy again.
     */
    markProviderUnhealthyWithRecoveryTime(providerType, providerConfig, errorMessage = null, recoveryTime = null) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in markProviderUnhealthyWithRecoveryTime');
            return;
        }

        if (isCodexProviderType(providerType) && isCodexQuotaExhaustionMessage(errorMessage)) {
            this._log('info', `Ignoring Codex quota exhaustion as provider failure for ${this._getDisplayName(providerConfig)}`);
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            provider.config.isHealthy = false;
            provider.config.needsRefresh = false; // 报错时不健康，清除刷新标记，防止卡死
            provider.config.refreshCount = 0;
            provider.config.errorCount = this.maxErrorCount; // Set to max to indicate definitive failure
            provider.config.lastErrorTime = new Date().toISOString();
            provider.config.lastHealthStateTime = new Date().toISOString();
            provider.config.lastUsed = new Date().toISOString();

            if (errorMessage) {
                provider.config.lastErrorMessage = errorMessage;
            }

            // Set recovery time if provided
            if (recoveryTime) {
                const recoveryDate = recoveryTime instanceof Date ? recoveryTime : new Date(recoveryTime);
                provider.config.scheduledRecoveryTime = recoveryDate.toISOString();
                this._log('warn', `Marked provider as unhealthy with recovery time: ${this._getDisplayName(providerConfig)} for type ${providerType}. Recovery at: ${recoveryDate.toISOString()}. Reason: ${errorMessage || 'Quota exhausted'}`);
            } else {
                this._log('warn', `Marked provider as unhealthy: ${this._getDisplayName(providerConfig)} for type ${providerType}. Reason: ${errorMessage || 'Quota exhausted'}`);
            }

            this._debouncedSave(providerType);
        }
    }

    _orderCoordinatedCandidates(candidates, providerType, requestedModel, options = {}) {
        const startedAt = performance.now();
        try {
            return this._orderCoordinatedCandidatesUnmetered(candidates, providerType, requestedModel, options);
        } finally {
            accumulateRoutingWait('selectionRankMs', performance.now() - startedAt);
        }
    }

    _orderCoordinatedCandidatesUnmetered(candidates, providerType, requestedModel, options = {}) {
        if (candidates.length <= 1) return candidates;
        if (options.stickyProviderKey) {
            const remaining = [...candidates];
            const ordered = [];
            while (remaining.length > 0) {
                const selected = this._selectFromMixedCandidates(remaining, requestedModel, { ...options, skipUsageCount: true })
                    || remaining[0];
                ordered.push(selected);
                const index = remaining.indexOf(selected);
                remaining.splice(index < 0 ? 0 : index, 1);
            }
            return ordered;
        }
        const now = Date.now();
        const minSeq = Math.min(...candidates.map(provider => provider.config?._lastSelectionSeq || 0));
        const weighted = hasCustomProviderWeights(candidates);
        return [...candidates].sort((a, b) => this._compareProviderCandidates(
            a,
            b,
            requestedModel,
            options,
            now,
            { minSeq, weighted }
        ));
    }

    markAntigravityModelQuotaUnhealthy(providerType, providerConfig, modelName, errorMessage = null, recoveryTime = null) {
        if (!providerConfig?.uuid || !isAntigravityProviderType(providerType)) return;
        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (!provider) return;

        const canonicalModel = normalizeAntigravityQuotaModel(modelName);
        if (!canonicalModel) return;
        this.invalidateAntigravityAvailability(canonicalModel);
        provider.config.antigravityQuotaHealth = provider.config.antigravityQuotaHealth || {};
        provider.config.antigravityQuotaHealth.families = provider.config.antigravityQuotaHealth.families || {};
        provider.config.antigravityQuotaHealth.models = provider.config.antigravityQuotaHealth.models || {};
        provider.config.antigravityQuotaHealth.models[canonicalModel] = {
            isHealthy: false,
            lastErrorTime: new Date().toISOString(),
            lastErrorMessage: errorMessage || null,
            scheduledRecoveryTime: recoveryTime ? new Date(recoveryTime).toISOString() : null,
            source: 'upstream_429'
        };
        this.recordGeminiSchedulingEvent('rateLimited');
        provider.config.lastUsed = new Date().toISOString();
        this._log('warn', `Marked Antigravity model ${canonicalModel} as cooling down for ${this._getDisplayName(provider.config)} until ${provider.config.antigravityQuotaHealth.models[canonicalModel].scheduledRecoveryTime || 'manual recovery'}`);
        if (this.coordination?.setProviderModelCooldown) {
            const recoveryMs = Date.parse(provider.config.antigravityQuotaHealth.models[canonicalModel].scheduledRecoveryTime || '');
            const retryAfterMs = Number.isFinite(recoveryMs)
                ? Math.max(1000, recoveryMs - Date.now())
                : 30_000;
            this.coordination.setProviderModelCooldown(providerType, provider.config.uuid, canonicalModel, {
                retryAfterMs,
                reason: errorMessage || 'upstream_429'
            }).catch(error => this._log('warn', `Failed to publish Antigravity cooldown: ${error.message}`));
        }
        this._debouncedSave(providerType);
    }

    markAntigravityModelCapacityUnavailable(providerType, providerConfig, modelName, recoveryTime = null, errorMessage = 'MODEL_CAPACITY_EXHAUSTED') {
        if (!providerConfig?.uuid || !isAntigravityProviderType(providerType)) return;
        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (!provider) return;

        const canonicalModel = normalizeAntigravityQuotaModel(modelName);
        if (!canonicalModel) return;
        this.invalidateAntigravityAvailability(canonicalModel);
        provider.config.antigravityQuotaHealth = provider.config.antigravityQuotaHealth || {};
        provider.config.antigravityQuotaHealth.families = provider.config.antigravityQuotaHealth.families || {};
        provider.config.antigravityQuotaHealth.models = provider.config.antigravityQuotaHealth.models || {};
        const existing = provider.config.antigravityQuotaHealth.models[canonicalModel];
        if (typeof recoveryTime === 'string' && errorMessage instanceof Date) {
            [recoveryTime, errorMessage] = [errorMessage, recoveryTime];
        }
        const recoveryDate = recoveryTime ? new Date(recoveryTime) : null;
        const requestedRecoveryMs = recoveryDate && Number.isFinite(recoveryDate.getTime())
            ? recoveryDate.getTime()
            : NaN;
        const existingRecoveryMs = Date.parse(existing?.scheduledRecoveryTime || '');
        const recoveryMs = Number.isFinite(existingRecoveryMs) && Number.isFinite(requestedRecoveryMs)
            ? Math.max(existingRecoveryMs, requestedRecoveryMs)
            : (Number.isFinite(requestedRecoveryMs) ? requestedRecoveryMs : existingRecoveryMs);
        const now = new Date().toISOString();
        const nextState = {
            isHealthy: false,
            lastErrorTime: now,
            lastErrorMessage: errorMessage,
            scheduledRecoveryTime: Number.isFinite(recoveryMs) ? new Date(recoveryMs).toISOString() : null,
            source: 'upstream_capacity'
        };
        if (existing
            && existing.isHealthy === nextState.isHealthy
            && (existing.lastErrorMessage || null) === nextState.lastErrorMessage
            && (existing.scheduledRecoveryTime || null) === nextState.scheduledRecoveryTime
            && existing.source === nextState.source) {
            return;
        }
        provider.config.antigravityQuotaHealth.models[canonicalModel] = nextState;
        provider.config.lastUsed = now;
        this._log('warn', `Marked Antigravity model ${canonicalModel} as capacity cooling down for ${this._getDisplayName(provider.config)} until ${nextState.scheduledRecoveryTime || 'manual recovery'}`);
        if (this.coordination?.setProviderModelCooldown) {
            const retryAfterMs = Number.isFinite(recoveryMs) ? Math.max(1000, recoveryMs - Date.now()) : 15_000;
            this.coordination.setProviderModelCooldown(providerType, provider.config.uuid, canonicalModel, {
                retryAfterMs,
                reason: errorMessage
            }).catch(error => this._log('warn', `Failed to publish Antigravity capacity cooldown: ${error.message}`));
        }
        this._debouncedSave(providerType);
    }

    markCodexQuotaBucketUnhealthy(providerType, providerConfig, bucket, errorMessage = null, recoveryTime = null) {
        if (!providerConfig?.uuid || !isCodexProviderType(providerType)) {
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (!provider) return;

        const persistedQuotaHealth = provider.config.codexQuotaHealth;
        if (!persistedQuotaHealth || typeof persistedQuotaHealth !== 'object' || Array.isArray(persistedQuotaHealth)) {
            let normalizedQuotaHealth = {};
            if (typeof persistedQuotaHealth === 'string') {
                try {
                    const parsed = JSON.parse(persistedQuotaHealth);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) normalizedQuotaHealth = parsed;
                } catch {
                    this._log('warn', `Invalid persisted Codex quota health state for ${this._getDisplayName(provider.config)}; resetting state`);
                }
            }
            provider.config.codexQuotaHealth = normalizedQuotaHealth;
        }
        const recoveryIso = recoveryTime ? new Date(recoveryTime).toISOString() : null;
        const existingBucket = provider.config.codexQuotaHealth[bucket];
        if (existingBucket?.isHealthy === false
            && (existingBucket.lastErrorMessage || null) === (errorMessage || null)
            && (existingBucket.scheduledRecoveryTime || null) === recoveryIso) {
            return;
        }
        provider.config.codexQuotaHealth[bucket] = {
            ...(provider.config.codexQuotaHealth[bucket] || {}),
            isHealthy: false,
            lastErrorTime: new Date().toISOString(),
            lastErrorMessage: errorMessage || null,
            scheduledRecoveryTime: recoveryIso,
            reasonCode: 'CODEX_QUOTA_EXHAUSTED',
            updatedAt: new Date().toISOString()
        };
        provider.config.lastUsed = new Date().toISOString();
        this._log('warn', `Marked Codex quota bucket ${bucket} as unhealthy for ${this._getDisplayName(provider.config)} (${providerType}). Reason: ${errorMessage || 'Quota exhausted'}`);
        this._debouncedSave(providerType);
    }

    markCodexRateLimitCooldown(providerType, providerConfig, bucket, errorMessage = null, recoveryTime = null) {
        if (!providerConfig?.uuid || !isCodexProviderType(providerType)) return;

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (!provider) return;

        const persistedCooldownState = provider.config.codexRateLimitCooldown;
        if (!persistedCooldownState || typeof persistedCooldownState !== 'object' || Array.isArray(persistedCooldownState)) {
            let normalizedCooldownState = {};
            if (typeof persistedCooldownState === 'string') {
                try {
                    const parsed = JSON.parse(persistedCooldownState);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        normalizedCooldownState = parsed;
                    }
                } catch {
                    this._log('warn', `Invalid persisted Codex rate-limit cooldown state for ${this._getDisplayName(provider.config)}; resetting state`);
                }
            }
            provider.config.codexRateLimitCooldown = normalizedCooldownState;
        }
        const recoveryIso = recoveryTime ? new Date(recoveryTime).toISOString() : null;
        const existingBucket = provider.config.codexRateLimitCooldown[bucket];
        if (existingBucket?.isCoolingDown === true
            && (existingBucket.lastErrorMessage || null) === (errorMessage || null)
            && (existingBucket.scheduledRecoveryTime || null) === recoveryIso) {
            return;
        }
        provider.config.codexRateLimitCooldown[bucket] = {
            ...(provider.config.codexRateLimitCooldown[bucket] || {}),
            isCoolingDown: true,
            lastErrorTime: new Date().toISOString(),
            lastErrorMessage: errorMessage || null,
            scheduledRecoveryTime: recoveryIso,
            source: 'upstream_429'
        };
        provider.config.lastUsed = new Date().toISOString();
        this._log('warn', `Marked Codex ${bucket} rate-limit cooldown for ${this._getDisplayName(provider.config)} (${providerType}) until ${provider.config.codexRateLimitCooldown[bucket].scheduledRecoveryTime || 'manual recovery'}`);
        this._debouncedSave(providerType);
    }

    markCodexQuotaBucketHealthy(providerType, providerConfig, bucket) {
        if (!providerConfig?.uuid || !isCodexProviderType(providerType)) {
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        const quotaState = provider?.config?.codexQuotaHealth?.[bucket];
        if (!provider || quotaState?.isHealthy !== false) return;

        provider.config.codexQuotaHealth[bucket] = {
            ...quotaState,
            isHealthy: true,
            lastErrorTime: null,
            lastErrorMessage: null,
            scheduledRecoveryTime: null,
            reasonCode: null,
            updatedAt: new Date().toISOString()
        };
        this._log('info', `Recovered Codex quota bucket ${bucket} for ${this._getDisplayName(provider.config)} (${providerType})`);
        this._debouncedSave(providerType);
    }

    syncCodexQuotaHealth(providerType, providerConfig, quotaHealth) {
        if (!providerConfig?.uuid || !isCodexProviderType(providerType) || !quotaHealth || typeof quotaHealth !== 'object') {
            return null;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (!provider) return null;

        const nextQuotaHealth = {
            ...quotaHealth,
            general: quotaHealth.general ? { ...quotaHealth.general } : quotaHealth.general,
            codex53: quotaHealth.codex53 ? { ...quotaHealth.codex53 } : quotaHealth.codex53
        };
        const currentQuotaHealth = provider.config.codexQuotaHealth || {};
        const updatedAt = new Date().toISOString();
        for (const bucket of ['general', 'codex53']) {
            if (nextQuotaHealth[bucket] && JSON.stringify(currentQuotaHealth[bucket] || null) !== JSON.stringify(nextQuotaHealth[bucket])) {
                nextQuotaHealth[bucket].updatedAt = updatedAt;
            }
        }
        if (JSON.stringify(currentQuotaHealth) === JSON.stringify(nextQuotaHealth)) {
            return provider.config.codexQuotaHealth;
        }

        provider.config.codexQuotaHealth = nextQuotaHealth;
        if (providerConfig !== provider.config) {
            providerConfig.codexQuotaHealth = nextQuotaHealth;
        }
        this._debouncedSave(providerType);
        return nextQuotaHealth;
    }

    syncAntigravityQuotaHealth(providerType, providerConfig, quotaHealth) {
        if (!providerConfig?.uuid || !isAntigravityProviderType(providerType) || !quotaHealth || typeof quotaHealth !== 'object') {
            return null;
        }
        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (!provider) return null;

        const nextQuotaHealth = {
            families: { ...(quotaHealth.families || {}) },
            models: { ...(quotaHealth.models || {}) }
        };
        if (JSON.stringify(provider.config.antigravityQuotaHealth || null) === JSON.stringify(nextQuotaHealth)) {
            return provider.config.antigravityQuotaHealth;
        }
        provider.config.antigravityQuotaHealth = nextQuotaHealth;
        if (providerConfig !== provider.config) providerConfig.antigravityQuotaHealth = nextQuotaHealth;
        this._debouncedSave(providerType);
        return nextQuotaHealth;
    }

    syncAntigravityPlan(providerType, providerConfig, plan) {
        const normalizedPlan = String(plan || '').trim();
        if (
            !providerConfig?.uuid
            || !isAntigravityProviderType(providerType)
            || !normalizedPlan
            || normalizedPlan.toLowerCase() === 'unknown'
        ) {
            return null;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (!provider) return null;
        if (provider.config.lastKnownAntigravityPlan === normalizedPlan) {
            return normalizedPlan;
        }

        const updatedAt = new Date().toISOString();
        provider.config.lastKnownAntigravityPlan = normalizedPlan;
        provider.config.lastKnownAntigravityPlanUpdatedAt = updatedAt;
        if (providerConfig !== provider.config) {
            providerConfig.lastKnownAntigravityPlan = normalizedPlan;
            providerConfig.lastKnownAntigravityPlanUpdatedAt = updatedAt;
        }
        this._debouncedSave(providerType);
        return normalizedPlan;
    }

    _markProviderHealthyState(providerType, providerConfig) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in provider health update');
            return null;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            const wasHealthy = provider.config.isHealthy;
            provider.config.isHealthy = true;
            provider.config.errorCount = 0;
            provider.config.lastErrorTime = null;
            provider.config.lastErrorMessage = null;
            provider.config.lastHealthStateTime = new Date().toISOString();
            provider.config._lastSelectionSeq = 0;
            if (!wasHealthy) {
                this._logHealthStatusChange(providerType, provider.config, 'unhealthy', 'healthy', null);
            }
            return provider;
        }
        return null;
    }

    /** Records a completed successful business request without changing routing or token-refresh timestamps. */
    markProviderRequestSucceeded(providerType, providerConfig) {
        const provider = this._markProviderHealthyState(providerType, providerConfig);
        if (!provider) return;
        provider.config.usageCount = (provider.config.usageCount || 0) + 1;
        provider.config.lastSuccessTime = new Date().toISOString();
        this._log('debug', `Recorded successful request for ${this._getDisplayName(provider.config)} (${providerType})`);
        this._debouncedSave(providerType);
    }

    /** Records a completed successful health check without changing usage, LRU, or refresh state. */
    markProviderHealthCheckSucceeded(providerType, providerConfig, healthCheckModel = null) {
        const provider = this._markProviderHealthyState(providerType, providerConfig);
        if (!provider) return;
        provider.config.lastHealthCheckTime = new Date().toISOString();
        if (healthCheckModel) provider.config.lastHealthCheckModel = healthCheckModel;
        this._log('debug', `Recorded successful health check for ${this._getDisplayName(provider.config)} (${providerType})`);
        this._debouncedSave(providerType);
    }

    /** Records a completed failed health check without polluting business-use or token-refresh fields. */
    markProviderHealthCheckFailed(providerType, providerConfig, errorMessage = null, healthCheckModel = null, immediate = false) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in markProviderHealthCheckFailed');
            return;
        }
        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (!provider) return;

        if (isCodexProviderType(providerType) && isCodexQuotaExhaustionMessage(errorMessage)) {
            this._log('info', `Ignoring Codex quota exhaustion as provider health failure for ${this._getDisplayName(provider.config)}`);
            return;
        }

        const wasHealthy = provider.config.isHealthy;
        const now = Date.now();
        const lastErrorTime = provider.config.lastErrorTime ? Date.parse(provider.config.lastErrorTime) : 0;
        if (immediate) {
            provider.config.errorCount = this.maxErrorCount;
            provider.config.isHealthy = false;
        } else {
            provider.config.errorCount = now - lastErrorTime > 10_000
                ? 1
                : (provider.config.errorCount || 0) + 1;
            if (this.maxErrorCount > 0 && provider.config.errorCount >= this.maxErrorCount) {
                provider.config.isHealthy = false;
            }
        }
        provider.config.lastErrorTime = new Date(now).toISOString();
        provider.config.lastErrorMessage = errorMessage || provider.config.lastErrorMessage || null;
        provider.config.lastHealthStateTime = new Date(now).toISOString();
        provider.config.lastHealthCheckTime = new Date(now).toISOString();
        if (healthCheckModel) provider.config.lastHealthCheckModel = healthCheckModel;
        if (wasHealthy && provider.config.isHealthy === false) {
            this._logHealthStatusChange(providerType, provider.config, 'healthy', 'unhealthy', errorMessage);
        }
        this._debouncedSave(providerType);
    }

    /**
     * Backward-compatible wrapper. New code should use the explicit business/health-check methods above.
     */
    markProviderHealthy(providerType, providerConfig, resetUsageCount = false, healthCheckModel = null) {
        if (healthCheckModel) {
            this.markProviderHealthCheckSucceeded(providerType, providerConfig, healthCheckModel);
            return;
        }
        if (resetUsageCount) {
            const provider = this._markProviderHealthyState(providerType, providerConfig);
            if (!provider) return;
            provider.config.usageCount = 0;
            this._debouncedSave(providerType);
            return;
        }
        this.markProviderRequestSucceeded(providerType, providerConfig);
    }

    /**
     * 重置提供商的刷新状态（needsRefresh 和 refreshCount）
     * 并将其标记为健康，以便立即投入使用
     * @param {string} providerType - 提供商类型
     * @param {string} uuid - 提供商 UUID
     */
    resetProviderRefreshStatus(providerType, uuid) {
        if (!providerType || !uuid) {
            this._log('error', 'Invalid parameters in resetProviderRefreshStatus');
            return;
        }

        const provider = this._findProvider(providerType, uuid);
        if (provider) {
            provider.config.needsRefresh = false;
            provider.config.refreshCount = 0;
            provider.config.lastRefreshTime = Date.now(); // 显式重置时也更新刷新时间
            // 标记为健康，以便立即投入使用
            this._log('info', `Reset refresh status and marked healthy for provider ${this._getDisplayName(provider.config)} (${providerType})`);

            this._debouncedSave(providerType);
        }
    }

    /**
     * 重置提供商的计数器（错误计数和使用计数）
     * @param {string} providerType - The type of the provider.
     * @param {object} providerConfig - The configuration of the provider to mark.
     */
    resetProviderCounters(providerType, providerConfig) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in resetProviderCounters');
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            provider.config.errorCount = 0;
            provider.config.usageCount = 0;
            provider.config.isHealthy = true;
            provider.config.lastErrorTime = null;
            provider.config.lastErrorMessage = null;
            provider.config.lastHealthStateTime = new Date().toISOString();
            provider.config._lastSelectionSeq = 0;
            this._log('info', `Reset provider counters: ${this._getDisplayName(provider.config)} for type ${providerType}`);
            
            this._debouncedSave(providerType);
        }
    }

    /**
     * 重置特定类型的所有提供商健康状态
     * @param {string} providerType - 提供商类型
     */
    resetAllHealthInType(providerType) {
        const pool = this.providerStatus[providerType];
        if (!pool) return;

        pool.forEach(provider => {
            provider.config.isHealthy = true;
            provider.config.errorCount = 0;
            provider.config.lastErrorTime = null;
            provider.config.lastErrorMessage = null;
            provider.config.lastHealthStateTime = new Date().toISOString();
            provider.config.refreshCount = 0;
            provider.config.needsRefresh = false;
        });

        this._log('info', `Reset all health status for type ${providerType}`);
        this._debouncedSave(providerType);
    }

    /**
     * 禁用指定提供商
     * @param {string} providerType - 提供商类型
     * @param {object} providerConfig - 提供商配置
     */
    disableProvider(providerType, providerConfig) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in disableProvider');
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            provider.config.isDisabled = true;
            this._log('info', `Disabled provider: ${this._getDisplayName(providerConfig)} for type ${providerType}`);
            this._debouncedSave(providerType);
        }
    }

    /**
     * 启用指定提供商
     * @param {string} providerType - 提供商类型
     * @param {object} providerConfig - 提供商配置
     */
    enableProvider(providerType, providerConfig) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in enableProvider');
            return;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            provider.config.isDisabled = false;
            this._syncProviderBalanceOnEnable(providerType, provider);
            this._log('info', `Enabled provider: ${this._getDisplayName(providerConfig)} for type ${providerType}`);
            this._debouncedSave(providerType);
        }
    }

    /**
     * 刷新指定提供商的 UUID
     * 用于在认证错误（如 401）时更换 UUID，以便重新尝试
     * @param {string} providerType - 提供商类型
     * @param {object} providerConfig - 提供商配置（包含当前 uuid）
     * @returns {string|null} 新的 UUID，如果失败则返回 null
     */
    refreshProviderUuid(providerType, providerConfig) {
        if (!providerConfig?.uuid) {
            this._log('error', 'Invalid providerConfig in refreshProviderUuid');
            return null;
        }

        const provider = this._findProvider(providerType, providerConfig.uuid);
        if (provider) {
            const oldUuid = provider.config.uuid;
            // 生成新的 UUID
            const newUuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
            
            // 更新 provider 的 UUID
            provider.uuid = newUuid;
            provider.config.uuid = newUuid;
            invalidateServiceAdapter(providerType, oldUuid);
            invalidateServiceAdapter(providerType, newUuid);
            
            // 同时更新 providerPools 中的原始数据
            const poolArray = this.providerPools[providerType];
            if (poolArray) {
                const originalProvider = poolArray.find(p => p.uuid === oldUuid);
                if (originalProvider) {
                    originalProvider.uuid = newUuid;
                }
            }
            
            this._log('info', `Refreshed provider UUID for ${this._getDisplayName(provider.config)}: ${oldUuid} -> ${newUuid} for type ${providerType}`);
            this._debouncedSave(providerType);
            
            return newUuid;
        }
        
        this._log('warn', `Provider not found for UUID refresh: ${this._getDisplayName(providerConfig)} in ${providerType}`);
        return null;
    }

    /**
     * 检查并恢复已到恢复时间的提供商
     * @param {string} [providerType] - 可选，指定要检查的提供商类型。如果不提供，检查所有类型
     * @private
     */
    _checkAndRecoverScheduledProviders(providerType = null) {
        const now = new Date();
        const typesToCheck = providerType ? [providerType] : Object.keys(this.providerStatus);
        
        for (const type of typesToCheck) {
            const providers = this.providerStatus[type] || [];
            for (const providerStatus of providers) {
                const config = providerStatus.config;
                
                // 检查是否有 scheduledRecoveryTime 且已到恢复时间
                if (config.scheduledRecoveryTime && !config.isHealthy) {
                    const recoveryTime = new Date(config.scheduledRecoveryTime);
                    if (now >= recoveryTime) {
                        this._log('info', `Auto-recovering provider ${this._getDisplayName(config)} (${type}). Scheduled recovery time reached: ${recoveryTime.toISOString()}`);
                        
                        // 恢复健康状态
                        config.isHealthy = true;
                        config.errorCount = 0;
                        config.lastErrorTime = null;
                        config.lastErrorMessage = null;
                        config.lastHealthStateTime = new Date().toISOString();
                        config.scheduledRecoveryTime = null; // 清除恢复时间
                        
                        // 保存更改
                        this._debouncedSave(type);
                    }
                }

                if (isCodexProviderType(type) && config.codexQuotaHealth && typeof config.codexQuotaHealth === 'object') {
                    let recoveredBucket = false;
                    for (const [bucket, quotaState] of Object.entries(config.codexQuotaHealth)) {
                        if (quotaState?.isHealthy !== false || !quotaState?.scheduledRecoveryTime) {
                            continue;
                        }
                        const recoveryTime = new Date(quotaState.scheduledRecoveryTime);
                        if (Number.isFinite(recoveryTime.getTime()) && now >= recoveryTime) {
                            config.codexQuotaHealth[bucket] = {
                                ...quotaState,
                                isHealthy: true,
                                lastErrorTime: null,
                                lastErrorMessage: null,
                                scheduledRecoveryTime: null
                            };
                            recoveredBucket = true;
                            this._log('info', `Auto-recovering Codex quota bucket ${bucket} for ${this._getDisplayName(config)} (${type}). Scheduled recovery time reached: ${recoveryTime.toISOString()}`);
                        }
                    }
                    if (recoveredBucket) {
                        this._debouncedSave(type);
                    }
                }

                if (isCodexProviderType(type) && config.codexRateLimitCooldown && typeof config.codexRateLimitCooldown === 'object') {
                    let recoveredRateLimit = false;
                    for (const [bucket, state] of Object.entries(config.codexRateLimitCooldown)) {
                        const recoveryTime = new Date(state?.scheduledRecoveryTime || '');
                        if (state?.isCoolingDown === true && Number.isFinite(recoveryTime.getTime()) && now >= recoveryTime) {
                            delete config.codexRateLimitCooldown[bucket];
                            recoveredRateLimit = true;
                            this._log('info', `Auto-recovered Codex ${bucket} rate-limit cooldown for ${this._getDisplayName(config)} (${type})`);
                        }
                    }
                    if (recoveredRateLimit) this._debouncedSave(type);
                }

                if (isAntigravityProviderType(type) && config.antigravityQuotaHealth && typeof config.antigravityQuotaHealth === 'object') {
                    let recoveredAntigravityQuota = false;
                    const families = config.antigravityQuotaHealth.families || {};
                    const models = config.antigravityQuotaHealth.models || {};
                    for (const [family, state] of Object.entries(families)) {
                        const recoveryTime = Date.parse(state?.scheduledRecoveryTime || '');
                        if (state?.isHealthy === false && Number.isFinite(recoveryTime) && now.getTime() >= recoveryTime) {
                            delete families[family];
                            recoveredAntigravityQuota = true;
                            this._log('info', `Auto-recovered Antigravity family quota ${family} for ${this._getDisplayName(config)}`);
                        }
                    }
                    for (const [model, state] of Object.entries(models)) {
                        const recoveryTime = Date.parse(state?.scheduledRecoveryTime || '');
                        if (state?.isHealthy === false && Number.isFinite(recoveryTime) && now.getTime() >= recoveryTime) {
                            delete models[model];
                            recoveredAntigravityQuota = true;
                            this._log('info', `Auto-recovered Antigravity model quota ${model} for ${this._getDisplayName(config)}`);
                        }
                    }
                    config.antigravityQuotaHealth.families = families;
                    config.antigravityQuotaHealth.models = models;
                    if (recoveredAntigravityQuota) this._debouncedSave(type);
                }
            }
        }

    }

    reconcileProviderForRouting(providerType, uuid) {
        const provider = this._findProvider(providerType, uuid);
        if (!provider) return { status: 'missing', provider: null };
        const before = {
            isHealthy: provider.config.isHealthy,
            scheduledRecoveryTime: provider.config.scheduledRecoveryTime || null
        };
        this._checkAndRecoverScheduledProviders(providerType);
        const after = {
            isHealthy: provider.config.isHealthy,
            scheduledRecoveryTime: provider.config.scheduledRecoveryTime || null
        };
        return {
            status: before.isHealthy !== after.isHealthy || before.scheduledRecoveryTime !== after.scheduledRecoveryTime
                ? 'recovered'
                : 'unchanged',
            provider,
            before,
            after
        };
    }

    /**
     * Performs initial (startup) health checks on selected providers.
     * Respects SCHEDULED_HEALTH_CHECK.providerTypes configuration.
     * Called once at server startup.
     *
     * 设计决策：如果没有选择任何 provider types，则不进行检查任何 provider。
     * 这是有意为之的设计 - 如果用户没有明确选择，则不需要自动健康检查。
     * 区别于原来的逻辑（检查所有 provider），现在的行为更符合用户预期。
     */
    async performInitialHealthChecks() {
        const scheduledConfig = this.globalConfig?.SCHEDULED_HEALTH_CHECK;
        const selectedProviderTypes = scheduledConfig?.providerTypes;
        
        // 如果没有选择任何 provider types，不进行检查
        // 设计决策：如果用户没有选择任何 provider，明确不执行健康检查是合理的
        if (!Array.isArray(selectedProviderTypes) || selectedProviderTypes.length === 0) {
            return;
        }
        
        this._log('info', 'Performing health checks on selected providers...');
        const now = new Date();
        
        // 首先检查并恢复已到恢复时间的提供商
        this._checkAndRecoverScheduledProviders();
        
        for (const providerType in this.providerStatus) {
            // Only check selected provider types
            if (!selectedProviderTypes.includes(providerType)) {
                continue;
            }
            
            for (const providerStatus of this.providerStatus[providerType]) {
                const providerConfig = providerStatus.config;

                const quotaCooldown = getCodexAutomaticHealthCheckCooldown(providerType, providerConfig);
                if (quotaCooldown) {
                    const recoveryDescription = quotaCooldown.recoveryTime || 'usage refresh provides a valid recovery time';
                    this._log('debug', `Skipping startup health check for ${this._getDisplayName(providerConfig)} (${providerType}): general quota exhausted; waiting until ${recoveryDescription}`);
                    continue;
                }

                // 如果提供商有 scheduledRecoveryTime 且未到恢复时间，跳过健康检查
                if (providerConfig.scheduledRecoveryTime && !providerConfig.isHealthy) {
                    const recoveryTime = new Date(providerConfig.scheduledRecoveryTime);
                    if (now < recoveryTime) {
                        this._log('debug', `Skipping health check for ${this._getDisplayName(providerConfig)} (${providerType}). Waiting for scheduled recovery at ${recoveryTime.toISOString()}`);
                        continue;
                    }
                }

                // Only attempt to health check unhealthy providers after a certain interval
                if (!providerStatus.config.isHealthy && providerStatus.config.lastErrorTime &&
                    (now.getTime() - new Date(providerStatus.config.lastErrorTime).getTime() < this.healthCheckInterval)) {
                    this._log('debug', `Skipping health check for ${this._getDisplayName(providerConfig)} (${providerType}). Last error too recent.`);
                    continue;
                }

                try {
                    // Perform actual health check based on provider type
                    const healthResult = await this._checkProviderHealth(providerType, providerConfig);
                    
                    if (healthResult === null) {
                        this._log('debug', `Health check for ${this._getDisplayName(providerConfig)} (${providerType}) skipped: Check not implemented.`);
                        this.resetProviderCounters(providerType, providerConfig);
                        continue;
                    }
                    
                    if (healthResult.success) {
                        if (!providerStatus.config.isHealthy) {
                            // Provider was unhealthy but is now healthy
                            // 恢复健康时不重置使用计数，保持原有值
                            if (!healthResult.reused) this.markProviderHealthCheckSucceeded(providerType, providerConfig, healthResult.modelName);
                            this._log('info', `Health check for ${this._getDisplayName(providerConfig)} (${providerType}): Marked Healthy (actual check)`);
                        } else {
                            // Provider was already healthy and still is
                            // 只在初始化时重置使用计数
                            if (!healthResult.reused) this.markProviderHealthCheckSucceeded(providerType, providerConfig, healthResult.modelName);
                            this._log('debug', `Health check for ${this._getDisplayName(providerConfig)} (${providerType}): Still Healthy`);
                        }
                    } else {
                        // Provider is not healthy
                        this._log('warn', `Health check for ${this._getDisplayName(providerConfig)} (${providerType}) failed: ${healthResult.errorMessage || 'Provider is not responding correctly.'}`);
                        if (!healthResult.reused) {
                            this.markProviderHealthCheckFailed(providerType, providerConfig, healthResult.errorMessage, healthResult.modelName);
                        }
                    }

                } catch (error) {
                    this._log('error', `Health check for ${this._getDisplayName(providerConfig)} (${providerType}) failed: ${error.message}`);
                    // If a health check fails, mark it unhealthy, which will update error count and lastErrorTime
                    this.markProviderHealthCheckFailed(providerType, providerConfig, error.message, null);
                }
            }
        }
    }

    /**
     * Performs scheduled health checks on all providers.
     * This method is designed to be called periodically to proactively check provider health.
     * It respects provider-level isDisabled flag.
     */
    async performHealthChecks() {
        const scheduledConfig = this.globalConfig?.SCHEDULED_HEALTH_CHECK;
        const checkStartTime = Date.now();
        
        // Check if scheduled health checks are disabled
        if (!scheduledConfig?.enabled) {
            this._log('debug', '[ScheduledHealthCheck] Scheduled health checks are disabled via configuration');
            return;
        }
        
        // Get selected provider types
        let selectedProviderTypes = scheduledConfig?.providerTypes;
        
        // Validate providerTypes is an array
        if (!Array.isArray(selectedProviderTypes) || selectedProviderTypes.length === 0) {
            this._log('info', '[ScheduledHealthCheck] No provider types selected, skipping health check');
            return;
        }

        this._checkAndRecoverScheduledProviders();
        
        // Count providers to be checked
        let totalProviders = 0;
        let skippedCount = 0;
        let providersToCheck = [];
        
        for (const providerType in this.providerStatus) {
            // Only check selected provider types
            if (!selectedProviderTypes.includes(providerType)) {
                this._log('debug', `[ScheduledHealthCheck] Skipping provider type ${providerType}: not in selected types`);
                continue;
            }
            
            for (const provider of this.providerStatus[providerType]) {
                // Skip manually disabled providers
                if (provider.config.isDisabled === true) {
                    skippedCount++;
                    this._log('debug', `[ScheduledHealthCheck] Skipping ${this._getDisplayName(provider.config)} (${providerType}): manually disabled`);
                    continue;
                }

                const quotaCooldown = getCodexAutomaticHealthCheckCooldown(providerType, provider.config);
                if (quotaCooldown) {
                    skippedCount++;
                    const recoveryDescription = quotaCooldown.recoveryTime || 'usage refresh provides a valid recovery time';
                    this._log('info', `[ScheduledHealthCheck] Skipping ${this._getDisplayName(provider.config)} (${providerType}): general quota exhausted; waiting until ${recoveryDescription}`);
                    continue;
                }
                
                totalProviders++;
                providersToCheck.push({ providerType, provider, uuid: provider.config.uuid, customName: provider.config.customName });
            }
        }
        
        this._log('info', `[ScheduledHealthCheck] Starting scheduled health checks: ${totalProviders} provider(s) to check, ${skippedCount} skipped (interval: ${scheduledConfig.interval}ms, types: ${selectedProviderTypes.join(', ')})`);
        
        let successCount = 0;
        let failCount = 0;
        
        for (const { providerType, provider, uuid, customName } of providersToCheck) {
            const providerCheckStart = Date.now();
            const baseProviderType = this._getBaseProviderType(providerType);
            const checkModelName = provider.config.checkModelName || 
                                ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS[providerType] || 
                                ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS[baseProviderType] || 
                                'unknown';
            const displayName = this._getDisplayName(provider.config);

            try {
                // Perform health check (health check is based on providerTypes configuration, not per-provider checkHealth flag)
                const result = await this._checkProviderHealth(providerType, provider.config);
                const checkDuration = Date.now() - providerCheckStart;
                
                if (!result.success) {
                    // Provider is unhealthy
                    failCount++;
                    this._log('warn', `[ScheduledHealthCheck] ${displayName} (${providerType}) FAILED: ${result.errorMessage || 'Provider is not responding correctly.'} (${checkDuration}ms)`);
                    if (!result.reused) {
                        this.markProviderHealthCheckFailed(providerType, provider.config, result.errorMessage, result.modelName, true);
                    }
                } else {
                    // Provider is healthy
                    successCount++;
                    this._log('info', `[ScheduledHealthCheck] ${displayName} (${providerType}) PASSED: model=${result.modelName || checkModelName} (${checkDuration}ms)`);
                    if (!result.reused) this.markProviderHealthCheckSucceeded(providerType, provider.config, result.modelName);
                }
            } catch (error) {
                const checkDuration = Date.now() - providerCheckStart;
                failCount++;
                this._log('error', `[ScheduledHealthCheck] ${displayName} (${providerType}) EXCEPTION: ${error.message} (${checkDuration}ms)`);
                this.markProviderHealthCheckFailed(providerType, provider.config, error.message, checkModelName, true);
            }
        }
        
        const totalDuration = Date.now() - checkStartTime;
        this._log('info', `[ScheduledHealthCheck] Completed: ${successCount} passed, ${failCount} failed, ${skippedCount} skipped, ${totalDuration}ms total`);
    }

    /**
     * 构建健康检查请求（返回多种格式用于重试）
     * @private
     * @returns {Array} 请求格式数组，按优先级排序
     */
    _buildHealthCheckRequests(providerType, modelName) {
        const baseMessage = { role: 'user', content: 'Hi' };
        const requests = [];
        
        // Gemini 使用 contents 格式
        if (providerType.startsWith('gemini')) {
            requests.push({
                contents: [{
                    role: 'user',
                    parts: [{ text: baseMessage.content }]
                }]
            });
            return requests;
        }
        
        // Kiro OAuth 只支持 messages 格式
        if (providerType.startsWith('claude-kiro')) {
            requests.push({
                messages: [baseMessage],
                model: modelName,
                max_tokens: 1
            });
            return requests;
        }
        
        // OpenAI Custom Responses 使用特殊格式
        if (this._getBaseProviderType(providerType) === MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES) {
            requests.push({
                input: [baseMessage],
                model: modelName
            });
            return requests;
        }

        // Codex OAuth 健康检查先构造标准 OpenAI messages，
        // 再在这里显式转换为 Codex 所需的 responses input 格式
        if (this._getBaseProviderType(providerType) === MODEL_PROVIDER.CODEX_API) {
            const openAICompatibleRequest = {
                model: modelName,
                messages: [baseMessage]
            };
            requests.push(convertData(
                openAICompatibleRequest,
                'request',
                MODEL_PROVIDER.OPENAI_CUSTOM,
                MODEL_PROVIDER.CODEX_API
            ));
            return requests;
        }
        
        // 其他提供商（OpenAI、Claude、Qwen）使用标准 messages 格式
        requests.push({
            messages: [baseMessage],
            model: modelName
        });
        
        return requests;
    }

    /**
     * 根据提供商类型获取基准提供商类型（用于查找配置和模型）
     * 例如：openai-custom-1 -> openai-custom
     * @private
     */
    _getBaseProviderType(providerType) {
        if (ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS[providerType]) {
            return providerType;
        }
        
        // 尝试前缀匹配
        for (const key of Object.keys(ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS)) {
            if (providerType === key || providerType.startsWith(key + '-')) {
                return key;
            }
        }
        
        return providerType;
    }

    /**
     * Performs an actual health check for a specific provider.
     * 
     * 设计决策：不检查 providerConfig.checkHealth 标志。
     * 健康检查是否执行由上层调用方（performHealthChecks / performInitialHealthChecks）
     * 通过 providerTypes 数组来决定，不在每个 provider 级别控制。
     * 这样简化了逻辑，避免 per-provider 的 checkHealth flag 变得无用。
     * 
     * @param {string} providerType - The type of the provider.
     * @param {object} providerConfig - The configuration of the provider to check.
     * @returns {Promise<{success: boolean, modelName: string, errorMessage: string}>} - Health check result object.
     */
    async _checkProviderHealth(providerType, providerConfig) {
        const healthCheckKey = providerConfig?.uuid ? `${providerType}:${providerConfig.uuid}` : null;
        if (healthCheckKey && this.healthCheckPromises.has(healthCheckKey)) {
            this._log('debug', `[HealthCheck] Reusing in-flight check for ${healthCheckKey}`);
            return this.healthCheckPromises.get(healthCheckKey).then(result => ({ ...result, reused: true }));
        }

        const baseProviderType = this._getBaseProviderType(providerType);
        const fallbackModelName = providerConfig.checkModelName ||
            ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS[providerType] ||
            ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS[baseProviderType] ||
            null;
        const healthCheckPromise = this._runProviderHealthCheck(providerType, providerConfig)
            .catch(error => ({
                success: false,
                modelName: fallbackModelName,
                errorMessage: error?.message || 'Health check failed'
            }));
        if (healthCheckKey) {
            this.healthCheckPromises.set(healthCheckKey, healthCheckPromise);
            healthCheckPromise.then(result => {
                const release = () => {
                    if (this.healthCheckPromises.get(healthCheckKey) === healthCheckPromise) {
                        this.healthCheckPromises.delete(healthCheckKey);
                    }
                };
                if (result?.timedOut) {
                    const guardMs = Number(this.globalConfig?.HEALTH_CHECK_TIMEOUT_GUARD_MS ?? 60_000);
                    const guardTimer = setTimeout(release, Math.max(0, guardMs));
                    guardTimer.unref?.();
                } else {
                    release();
                }
            }, () => {
                if (this.healthCheckPromises.get(healthCheckKey) === healthCheckPromise) {
                    this.healthCheckPromises.delete(healthCheckKey);
                }
            });
        }
        return healthCheckPromise;
    }

    async _runProviderHealthCheck(providerType, providerConfig) {
        // 确定健康检查使用的模型名称
        const baseProviderType = this._getBaseProviderType(providerType);
        const modelName = providerConfig.checkModelName ||
                        ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS[providerType] ||
                        ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS[baseProviderType];

        if (!modelName) {
            this._log('warn', `Unknown provider type for health check: ${providerType}. Please check DEFAULT_HEALTH_CHECK_MODELS.`);
            return { 
                success: false, 
                modelName: null, 
                errorMessage: `Unknown provider type '${providerType}'. No default health check model configured.` 
            };
        }

        // ========== 实际 API 健康检查（带超时保护）==========
        const healthCheckTimeout = 15000;
        const tempConfig = {
            ...this.globalConfig,
            ...providerConfig,
            MODEL_PROVIDER: providerType,
            HEALTH_CHECK_REQUEST_TIMEOUT_MS: healthCheckTimeout
        };
        delete tempConfig.providerPools;
        const serviceAdapter = this.serviceAdapterFactory(tempConfig);

        // 获取所有可能的请求格式
        const healthCheckRequests = this._buildHealthCheckRequests(providerType, modelName);

        const deadline = Date.now() + healthCheckTimeout;
        let lastError = null;

        // 重试机制：尝试不同的请求格式
        for (let i = 0; i < healthCheckRequests.length; i++) {
            const healthCheckRequest = healthCheckRequests[i];
            const remainingMs = Math.max(0, deadline - Date.now());
            if (remainingMs === 0) {
                lastError = new Error(`Health check timed out after ${healthCheckTimeout}ms`);
                lastError.code = 'HEALTH_CHECK_TIMEOUT';
                break;
            }
            let timeoutId;

            try {
                const timeoutPromise = new Promise((_, reject) => {
                    timeoutId = setTimeout(() => {
                        const timeoutError = new Error(`Health check timed out after ${healthCheckTimeout}ms`);
                        timeoutError.code = 'HEALTH_CHECK_TIMEOUT';
                        reject(timeoutError);
                    }, remainingMs);
                    timeoutId.unref?.();
                });
                await Promise.race([
                    serviceAdapter.generateContent(modelName, healthCheckRequest),
                    timeoutPromise
                ]);
                clearTimeout(timeoutId);
                // 注意：使用量计数由调用方处理（performHealthChecks/performInitialHealthChecks）
                // 这里只返回成功结果，让调用方统一处理状态更新和计数
                return { success: true, modelName, errorMessage: null };
            } catch (error) {
                if (timeoutId) clearTimeout(timeoutId);
                lastError = error;
                if (error?.code === 'HEALTH_CHECK_TIMEOUT') break;
            }
        }

        // 所有尝试都失败
        this._log('warn', `[HealthCheck] ${providerType} failed after ${healthCheckRequests.length} attempts: ${lastError?.message}`);
        return {
            success: false,
            modelName,
            errorMessage: lastError?.message || 'All health check attempts failed',
            timedOut: lastError?.code === 'HEALTH_CHECK_TIMEOUT'
        };
    }

    /**
     * 优化1: 添加防抖保存方法
     * 延迟保存操作，避免频繁的文件 I/O
     * @private
     */
    _debouncedSave(providerType, { publishStateEvent = true } = {}) {
        if (this.stateEventSink && publishStateEvent) {
            const snapshots = new Map();
            for (const provider of this.providerStatus[providerType] || []) {
                const event = createProviderStateEvent(providerType, provider.config, this.providerConfigRevision);
                snapshots.set(provider.uuid, event);
                this.providerStateEventTimes.set(`${providerType}/${provider.uuid}`, event.occurredAt);
            }
            this.pendingStateEvents.set(providerType, snapshots);
        }
        if (!this.persistenceEnabled) {
            if (!this.stateEventSink) return;
            if (this.stateEventTimer) return;
            this.stateEventTimer = setTimeout(() => {
                this.stateEventTimer = null;
                const pending = [...this.pendingStateEvents.entries()];
                this.pendingStateEvents.clear();
                for (const [, snapshots] of pending) {
                    for (const event of snapshots.values()) this.stateEventSink(event);
                }

            }, Math.min(this.saveDebounceTime, 1000));
            this.stateEventTimer.unref?.();
            return;
        }
        // 将待保存的 providerType 添加到集合中
        this.pendingSaves.add(providerType);

        // 固定批次窗口：持续流量不会不断推迟落盘，也不会每秒重写完整文件。
        if (this.saveTimer) return;
        
        // 设置新的定时器
        this.saveTimer = setTimeout(() => {
            this._flushPendingSaves();
        }, this.saveDebounceTime);
    }

    async flushPendingSaves() {
        await this._flushPendingSaves();
    }
    
    /**
     * 批量保存所有待保存的 providerType（优化为单次文件写入）
     * @private
     */
    async _flushPendingSaves() {
        // 立即置空定时器，防止重叠调用
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }

        const filePath = this.globalConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        
        // 使用文件锁确保并发安全
        await withFileLock(filePath, async (checkValidity) => {
            // 原子化提取待保存任务并清空，防止在异步循环期间丢失新更新
            const typesToSave = Array.from(this.pendingSaves);
            if (typesToSave.length === 0) return;
            this.pendingSaves.clear();

            try {
                let currentPools = {};

                // 采用“读取-合并-写入”策略，保留可能存在的未知字段
                try {
                    const fileContent = await fs.promises.readFile(filePath, 'utf8');
                    currentPools = JSON.parse(fileContent);
                } catch (readError) {
                    if (readError.code === 'ENOENT') {
                        this._log('info', 'configs/provider_pools.json does not exist, creating new file.');
                    } else {
                        throw readError;
                    }
                }

                // 检查锁是否依然有效
                checkValidity();

                // 更新所有待保存的 providerType
                for (const providerType of typesToSave) {
                    if (this.providerStatus[providerType]) {
                        currentPools[providerType] = this.providerStatus[providerType].map(p => {
                            const config = { ...p.config };
                            if (config.lastUsed instanceof Date) {
                                config.lastUsed = config.lastUsed.toISOString();
                            }
                            if (config.lastErrorTime instanceof Date) {
                                config.lastErrorTime = config.lastErrorTime.toISOString();
                            }
                            if (config.lastHealthCheckTime instanceof Date) {
                                config.lastHealthCheckTime = config.lastHealthCheckTime.toISOString();
                            }
                            return config;
                        });
                    } else {
                        this._log('warn', `Attempted to save unknown providerType: ${providerType}`);
                    }
                }

                // 一次性写入文件（使用原子化写入）
                await atomicWriteFile(filePath, JSON.stringify(currentPools, null, 2), { encoding: 'utf8', mode: 0o600 });

                if (this.stateEventSink) {
                    for (const providerType of typesToSave) {
                        const snapshots = this.pendingStateEvents.get(providerType);
                        if (!snapshots) continue;
                        for (const event of snapshots.values()) this.stateEventSink(event);
                        this.pendingStateEvents.delete(providerType);
                    }
                }

                this._log('info', `configs/provider_pools.json updated successfully for types: ${typesToSave.join(', ')}`);
            } catch (error) {
                this._log('error', `Failed to write provider_pools.json: ${error.message}`);
            }
        });
    }

    applyRemoteProviderState(event) {
        const stateKey = `${event?.providerType}/${event?.uuid}`;
        const applied = applyProviderStateEvent(this.providerPools, event, {
            revision: this.providerConfigRevision,
            stateEventAt: this.providerStateEventTimes.get(stateKey) || null
        });
        if (!applied && Number(event?.configRevision || 0) < this.providerConfigRevision) {
            this._log('warn', `Ignored stale provider state for ${event?.providerType}/${event?.uuid}: event revision ${event?.configRevision || 0}, current ${this.providerConfigRevision}`);
            return false;
        }
        if (!applied) return false;
        this.providerStateEventTimes.set(stateKey, event.occurredAt);
        const provider = this._findProvider(event?.providerType, event?.uuid);
        if (provider) {
            applyProviderStateEvent({ [event.providerType]: [provider.config] }, event, { revision: this.providerConfigRevision });
            if (isAntigravityProviderType(event.providerType) && event.state?.needsRefresh === false) {
                invalidateServiceAdapter(event.providerType, event.uuid);
            }
        }
        if (applied && this.persistenceEnabled) this._debouncedSave(event.providerType, { publishStateEvent: false });
        return applied || Boolean(provider);
    }

    applyProviderConfigSync(event) {
        const result = applyProviderConfigEvent(this.providerPools, event, { revision: this.providerConfigRevision });
        if (!result.applied) return result;
        this.providerConfigRevision = result.revision;
        this.initializeProviderStatus(true);
        return result;
    }

    publishProviderConfig(providerType, providers, options = {}) {
        const revision = this.providerConfigRevision + 1;
        const event = createProviderConfigEvent(providerType, providers, { ...options, revision });
        const result = this.applyProviderConfigSync(event);
        if (result.applied) this.configEventSink?.(event);
        return { ...result, event };
    }

    getProviderIdentity(providerType, uuid) {
        const provider = this._findProvider(providerType, uuid);
        const config = provider?.config || provider;
        if (!config?.codexAccountKey) return null;
        return {
            codexAccountKey: String(config.codexAccountKey || ''),
            codexAccountId: String(config.codexAccountId || ''),
            codexEmail: String(config.codexEmail || '')
        };
    }

    async reconcileProviderIdentity(providerType, uuid, observedIdentity = {}, options = {}) {
        const provider = this._findProvider(providerType, uuid);
        if (!provider) return { status: 'missing-provider' };

        const observed = {
            codexAccountKey: String(observedIdentity.codexAccountKey || ''),
            codexAccountId: String(observedIdentity.codexAccountId || ''),
            codexEmail: String(observedIdentity.codexEmail || '')
        };
        if (!observed.codexAccountKey) return { status: 'invalid' };

        const current = this.getProviderIdentity(providerType, uuid);
        if (current) {
            const fields = ['codexAccountKey', 'codexAccountId', 'codexEmail'];
            const conflict = fields.some(field => current[field] && observed[field] && current[field] !== observed[field]);
            if (conflict && options.allowConflictUpdate !== true) {
                this.providerIdentityConflicts++;
                return { status: 'conflict' };
            }
            if (fields.every(field => current[field] === observed[field])) return { status: 'unchanged' };
        }

        const nextConfig = {
            ...provider.config,
            codexAccountKey: observed.codexAccountKey,
            codexAccountId: observed.codexAccountId,
            codexEmail: observed.codexEmail
        };
        if (!this.persistenceEnabled) {
            provider.config = nextConfig;
            const poolConfig = (this.providerPools[providerType] || []).find(item => String(item?.uuid || '') === String(uuid));
            if (poolConfig) Object.assign(poolConfig, nextConfig);
            this.identityEventSink?.({
                type: 'provider_identity_discovered',
                providerType,
                providerUuid: uuid,
                identity: observed
            });
            return { status: 'discovered' };
        }
        const providers = (this.providerStatus[providerType] || []).map(item =>
            String(item.uuid || item.config?.uuid || '') === String(uuid) ? nextConfig : { ...item.config }
        );
        const result = this.publishProviderConfig(providerType, providers, {
            action: 'codex_identity',
            changedUuids: [uuid]
        });
        return { status: result.applied ? 'updated' : 'unchanged', revision: result.revision };
    }

}

