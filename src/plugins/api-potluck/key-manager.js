/**
 * API 大锅饭 - Key 管理模块
 * 使用内存缓存 + 写锁 + 定期持久化，解决并发安全问题
 */

import { atomicWriteFile, atomicWriteFileSync } from '../../utils/file-lock.js';
import {
    importLegacyUsageHistories,
    hasAppliedUsageEvent,
    loadUsageHistory,
    loadUsageTotals,
    persistUsageHistory,
    persistUsageHistoryEvent,
    deleteUsageHistory
} from './usage-history-store.js';
import { promises as fs } from 'fs';
import logger from '../../utils/logger.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { RateManager } from '../../utils/rate-tracker.js';
import { getBeijingDateString } from '../../utils/common.js';
import { hashSecret, sanitizeProviderName } from '../request-audit/audit-event.js';
import {
    DEFAULT_CONVERSION_MODEL,
    buildCost,
    getConversionModels,
    normalizeConversionModel
} from './cost-estimator.js';

// 配置文件路径
const KEYS_STORE_FILE = path.join(process.cwd(), 'configs', 'api-potluck-keys.json');
const MODEL_USAGE_STATS_FILE = path.join(process.cwd(), 'configs', 'model-usage-stats.json');

const KEY_PREFIX = 'maki_';
const USAGE_HISTORY_RETENTION_DAYS = 35;
const LEDGER_KEY_HASH_PATTERN = /^sha256:[a-f0-9]{16}$/i;

const DEFAULT_CONFIG = {
    persistInterval: 30_000,
    maxDirtyAge: 60_000,
    defaultDailyLimit: 500
};
const PERSIST_RETRY_DELAY_MS = 5_000;

let configGetter = null;

/**
 * 设置配置获取器
 */
export function setConfigGetter(getter) {
    configGetter = getter;
}

/**
 * 获取当前配置
 */
function getConfig() {
    if (configGetter) {
        return configGetter();
    }
    return DEFAULT_CONFIG;
}

function normalizePersistenceDuration(value, fallback) {
    const duration = Number(value);
    return Number.isFinite(duration) && duration > 0 ? duration : fallback;
}

function refreshPersistenceConfig() {
    const config = getConfig() || {};
    currentPersistInterval = normalizePersistenceDuration(
        config.persistInterval,
        DEFAULT_CONFIG.persistInterval
    );
    currentMaxDirtyAge = normalizePersistenceDuration(
        config.maxDirtyAge,
        DEFAULT_CONFIG.maxDirtyAge
    );
}

/**
 * 获取今日日期字符串
 */
function getTodayDateString() {
    return getBeijingDateString();
}

// 插件状态
let keyStore = null;
const dirtyUsageKeys = new Set();
let legacyUsageMigrationPending = false;
let isDirty = false;
let isWriting = false;
let persistTimer = null;
let maxDirtyTimer = null;
let currentPersistInterval = DEFAULT_CONFIG.persistInterval;
let currentMaxDirtyAge = DEFAULT_CONFIG.maxDirtyAge;
let dirtySince = null;
let mutationVersion = 0;
let lastPersistedVersion = 0;
let routingConfigRevision = 0;
let keyStoreSyncPublisher = null;
let persistPromise = null;
let retryNotBefore = 0;

const rateManager = new RateManager(60);

export function setKeyStoreSyncPublisher(publisher) {
    keyStoreSyncPublisher = typeof publisher === 'function' ? publisher : null;
}

export function getKeyRoutingRevision() {
    return routingConfigRevision;
}

function routingSnapshot(keyData) {
    return {
        keyId: keyData.id,
        routingMode: keyData.routingMode || 'pool',
        primaryGroupId: keyData.routingMode === 'auto' ? (keyData.primaryGroupId || null) : null,
        fixedCredential: keyData.routingMode === 'fixed' && keyData.fixedCredential ? { ...keyData.fixedCredential } : null,
        manualLock: keyData.manualLock === true
    };
}

function publishRoutingSync(keyIds, reason) {
    if (!keyStoreSyncPublisher || !Array.isArray(keyIds) || keyIds.length === 0) return;
    const records = keyIds.map(keyId => keyStore.keys[keyId]).filter(Boolean).map(routingSnapshot);
    if (records.length === 0) return;
    const revision = ++routingConfigRevision;
    keyStoreSyncPublisher({ type: 'potluck_key_routing_sync', revision, reason, records });
}

export function applyKeyStoreSyncEvent(event = {}) {
    ensureLoaded();
    const revision = Number(event.revision || 0);
    if (!Number.isInteger(revision) || revision <= routingConfigRevision) {
        return { applied: false, revision: routingConfigRevision, stale: true };
    }
    if (!Array.isArray(event.records)) return { applied: false, revision: routingConfigRevision, malformed: true };
    for (const record of event.records) {
        const keyData = keyStore.keys[record?.keyId];
        if (!keyData || !record?.keyId) continue;
        const routingMode = ['pool', 'auto', 'fixed'].includes(record.routingMode) ? record.routingMode : 'pool';
        keyData.routingMode = routingMode;
        keyData.primaryGroupId = routingMode === 'auto' ? (record.primaryGroupId || null) : null;
        keyData.fixedCredential = routingMode === 'fixed' && record.fixedCredential ? { ...record.fixedCredential } : null;
        if (typeof record.manualLock === 'boolean') keyData.manualLock = record.manualLock;
    }
    routingConfigRevision = revision;
    return { applied: true, revision, records: event.records.length };
}

function createUsageBucket() {
    return {
        requestCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        maxQps: 0,
        maxRpm: 0,
        maxTps: 0,
        lastUsedAt: null
    };
}

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function normalizeUsageBucket(bucket) {
    if (typeof bucket === 'number') {
        return {
            ...createUsageBucket(),
            requestCount: bucket
        };
    }

    return {
        ...createUsageBucket(),
        ...(bucket || {}),
        requestCount: toNumber(bucket?.requestCount),
        promptTokens: toNumber(bucket?.promptTokens),
        completionTokens: toNumber(bucket?.completionTokens),
        reasoningTokens: toNumber(bucket?.reasoningTokens),
        totalTokens: toNumber(bucket?.totalTokens),
        cachedTokens: toNumber(bucket?.cachedTokens),
        maxQps: toNumber(bucket?.maxQps),
        maxRpm: toNumber(bucket?.maxRpm),
        maxTps: toNumber(bucket?.maxTps),
        lastUsedAt: bucket?.lastUsedAt || null
    };
}

function normalizeUsageMap(map = {}) {
    const normalized = {};
    for (const [name, usage] of Object.entries(map || {})) {
        normalized[name] = normalizeUsageBucket(usage);
    }
    return normalized;
}

function normalizeProviderModelUsageMap(map = {}) {
    const normalized = {};
    for (const [provider, models] of Object.entries(map || {})) {
        normalized[provider] = normalizeUsageMap(models);
    }
    return normalized;
}

function normalizeAccountUsageMap(map = {}) {
    const normalized = {};
    for (const [accountKey, account] of Object.entries(map || {})) {
        const providerUuid = account?.providerUuid || accountKey.split(':').slice(1).join(':') || null;
        normalized[accountKey] = {
            provider: account?.provider || accountKey.split(':')[0] || 'unknown',
            providerUuid,
            accountIdentity: account?.accountIdentity || null,
            accountEmail: account?.accountEmail || null,
            providerUuids: Array.isArray(account?.providerUuids)
                ? [...new Set(account.providerUuids.filter(Boolean))]
                : (providerUuid ? [providerUuid] : []),
            providerName: account?.providerName || null,
            summary: normalizeUsageBucket(account?.summary),
            models: normalizeUsageMap(account?.models)
        };
    }
    return normalized;
}

function normalizeHourlyUsageMap(map = {}) {
    const normalized = {};
    for (const [hour, hourData] of Object.entries(map || {})) {
        normalized[hour] = {
            summary: normalizeUsageBucket(hourData?.summary),
            providers: normalizeUsageMap(hourData?.providers),
            models: normalizeUsageMap(hourData?.models),
            providerModels: normalizeProviderModelUsageMap(hourData?.providerModels),
            accounts: normalizeAccountUsageMap(hourData?.accounts)
        };
    }
    return normalized;
}

function normalizeUsageHistoryDay(day = {}) {
    return {
        summary: normalizeUsageBucket(day.summary || {
            requestCount: day.requestCount
        }),
        providers: normalizeUsageMap(day.providers),
        models: normalizeUsageMap(day.models),
        providerModels: normalizeProviderModelUsageMap(day.providerModels),
        accounts: normalizeAccountUsageMap(day.accounts),
        hours: normalizeHourlyUsageMap(day.hours)
    };
}

function addCacheHitRatio(bucket) {
    if (!bucket || typeof bucket !== 'object') return bucket;
    const promptTokens = toNumber(bucket.promptTokens);
    bucket.cacheHitRatio = promptTokens > 0 ? toNumber(bucket.cachedTokens) / promptTokens : 0;
    return bucket;
}

function addUsageHistoryRatios(usageHistory = {}) {
    for (const day of Object.values(usageHistory || {})) {
        addCacheHitRatio(day.summary);
        for (const usage of Object.values(day.providers || {})) {
            addCacheHitRatio(usage);
        }
        for (const usage of Object.values(day.models || {})) {
            addCacheHitRatio(usage);
        }
        for (const models of Object.values(day.providerModels || {})) {
            for (const usage of Object.values(models || {})) addCacheHitRatio(usage);
        }
        for (const account of Object.values(day.accounts || {})) {
            addCacheHitRatio(account.summary);
            for (const usage of Object.values(account.models || {})) {
                addCacheHitRatio(usage);
            }
        }
        for (const hour of Object.values(day.hours || {})) {
            addCacheHitRatio(hour.summary);
            for (const usage of Object.values(hour.providers || {})) {
                addCacheHitRatio(usage);
            }
            for (const usage of Object.values(hour.models || {})) {
                addCacheHitRatio(usage);
            }
            for (const account of Object.values(hour.accounts || {})) {
                addCacheHitRatio(account.summary);
                for (const usage of Object.values(account.models || {})) {
                    addCacheHitRatio(usage);
                }
            }
        }
    }
    return usageHistory;
}

function createInvalidKeyRoutingError(message) {
    const error = new Error(message);
    error.code = 'INVALID_KEY_ROUTING';
    return error;
}

function normalizeKeyRouting(routing = {}, { strict = false } = {}) {
    const hasPrimaryGroup = typeof routing.primaryGroupId === 'string' && routing.primaryGroupId.trim();
    const routingMode = routing.routingMode === 'fixed'
        ? 'fixed'
        : routing.routingMode === 'pool'
            ? 'pool'
            : (routing.routingMode === 'auto' || routing.routingMode === undefined || routing.routingMode === null)
                ? (hasPrimaryGroup ? 'auto' : 'pool')
                : null;

    if (!routingMode) {
        throw createInvalidKeyRoutingError('routingMode 必须是 pool、auto 或 fixed');
    }

    const manualLock = routing.manualLock === true;
    if (routingMode === 'fixed') {
        const uuid = typeof routing.fixedCredential?.uuid === 'string'
            ? routing.fixedCredential.uuid.trim()
            : '';
        if (strict && !uuid) {
            throw createInvalidKeyRoutingError('fixed 模式必须指定凭据 UUID');
        }
        return {
            routingMode,
            primaryGroupId: null,
            fixedCredential: uuid
                ? {
                    providerType: typeof routing.fixedCredential?.providerType === 'string'
                        && routing.fixedCredential.providerType.trim()
                        ? routing.fixedCredential.providerType.trim()
                        : 'openai-codex-oauth',
                    uuid
                }
                : null,
            manualLock
        };
    }

    const primaryGroupId = routingMode === 'auto' && hasPrimaryGroup
        ? routing.primaryGroupId.trim()
        : null;
    return {
        routingMode,
        primaryGroupId,
        fixedCredential: null,
        manualLock
    };
}

function createInvalidKeyRoutingAssignmentsError(message, details = null) {
    const error = new Error(message);
    error.code = 'INVALID_KEY_ROUTING_ASSIGNMENTS';
    if (details) error.details = details;
    return error;
}

function isSameKeyRouting(keyData, routing) {
    if (keyData.routingMode !== routing.routingMode) return false;
    if ((keyData.primaryGroupId || null) !== (routing.primaryGroupId || null)) return false;
    if ((keyData.manualLock === true) !== (routing.manualLock === true)) return false;

    const currentFixed = keyData.fixedCredential || null;
    const nextFixed = routing.fixedCredential || null;
    if (!currentFixed || !nextFixed) return currentFixed === nextFixed;
    return currentFixed.providerType === nextFixed.providerType
        && currentFixed.uuid === nextFixed.uuid;
}

function normalizeKeyData(keyData = {}) {
    const routing = normalizeKeyRouting(keyData);
    const normalized = {
        ...keyData,
        ...routing,
        todayUsage: toNumber(keyData.todayUsage),
        totalUsage: toNumber(keyData.totalUsage),
        todayPromptTokens: toNumber(keyData.todayPromptTokens),
        todayCompletionTokens: toNumber(keyData.todayCompletionTokens),
        todayReasoningTokens: toNumber(keyData.todayReasoningTokens),
        todayTotalTokens: toNumber(keyData.todayTotalTokens),
        todayCachedTokens: toNumber(keyData.todayCachedTokens),
        totalPromptTokens: toNumber(keyData.totalPromptTokens),
        totalCompletionTokens: toNumber(keyData.totalCompletionTokens),
        totalReasoningTokens: toNumber(keyData.totalReasoningTokens),
        totalTokens: toNumber(keyData.totalTokens),
        totalCachedTokens: toNumber(keyData.totalCachedTokens),
        totalModels: normalizeUsageMap(keyData.totalModels),
        ledgerKeyHashes: [...new Set(
            (Array.isArray(keyData.ledgerKeyHashes) ? keyData.ledgerKeyHashes : [])
                .filter(value => LEDGER_KEY_HASH_PATTERN.test(String(value || '')))
                .map(value => String(value).toLowerCase())
        )],
        usageHistory: {}
    };

    for (const [date, day] of Object.entries(keyData.usageHistory || {})) {
        normalized.usageHistory[date] = normalizeUsageHistoryDay(day);
    }

    if (Object.keys(normalized.totalModels).length === 0) {
        normalized.totalModels = collectModelsFromUsageHistory(normalized.usageHistory);
    }

    trimUsageHistory(normalized.usageHistory, USAGE_HISTORY_RETENTION_DAYS);

    return normalized;
}

function trimUsageHistory(usageHistory = {}, retentionDays = USAGE_HISTORY_RETENTION_DAYS) {
    const dates = Object.keys(usageHistory || {}).sort();
    if (dates.length <= retentionDays) return usageHistory;
    for (const date of dates.slice(0, dates.length - retentionDays)) {
        delete usageHistory[date];
    }
    return usageHistory;
}

function normalizeStore(store = {}) {
    const normalized = { keys: {} };
    for (const [keyId, keyData] of Object.entries(store.keys || {})) {
        normalized.keys[keyId] = normalizeKeyData(keyData);
    }
    return normalized;
}

function addUsage(target, usage = {}) {
    // 默认请求数为 1，确保总量与明细一致
    const rCount = usage.requestCount !== undefined ? toNumber(usage.requestCount) : 1;
    target.requestCount += rCount;
    target.promptTokens += toNumber(usage.promptTokens);
    target.completionTokens += toNumber(usage.completionTokens);
    target.reasoningTokens += toNumber(usage.reasoningTokens);
    target.totalTokens += toNumber(usage.totalTokens);
    target.cachedTokens += toNumber(usage.cachedTokens);
    
    // 聚合峰值：使用累加还是最大值取决于上下文。
    // 在汇总多个 Key 的历史数据时，累加可能更能代表系统总峰值（假设可能同时发生）
    // 但更准确的是记录全局 RateTracker 的峰值。
    // 这里简单处理：如果 usage 中有峰值，则取最大值或累加。
    // 鉴于这是日历展示，我们取最大值以展示该日达到的最高单项或汇总峰值。
    target.maxQps = Math.max(target.maxQps || 0, toNumber(usage.maxQps));
    target.maxRpm = Math.max(target.maxRpm || 0, toNumber(usage.maxRpm));
    target.maxTps = Math.max(target.maxTps || 0, toNumber(usage.maxTps));
    if (usage.lastUsedAt && (!target.lastUsedAt || Date.parse(usage.lastUsedAt) > Date.parse(target.lastUsedAt))) {
        target.lastUsedAt = usage.lastUsedAt;
    }
}

function latestTimestamp(current, candidate) {
    if (!candidate) return current || null;
    if (!current) return candidate;
    const currentMs = Date.parse(current);
    const candidateMs = Date.parse(candidate);
    if (!Number.isFinite(candidateMs)) return current;
    if (!Number.isFinite(currentMs)) return candidate;
    return candidateMs > currentMs ? candidate : current;
}

function isCodexEmailAccountProvider(provider) {
    return provider === 'openai-codex-oauth' || provider === 'openaiResponses-custom';
}

function getCanonicalAccountUsageIdentity(provider, providerUuid, accountIdentity = null, accountEmail = null, providerName = null) {
    if (isCodexEmailAccountProvider(provider)) {
        const email = normalizeEmailAlias(accountEmail) || normalizeEmailAlias(accountIdentity) || normalizeEmailAlias(providerName);
        if (!email) return null;
        return {
            provider: 'openai-codex-oauth',
            identity: email,
            accountEmail: email
        };
    }

    const identity = accountIdentity || providerUuid;
    if (!provider || !identity) return null;
    return {
        provider,
        identity,
        accountEmail: normalizeEmailAlias(accountEmail)
    };
}

function getAccountUsageKey(provider, providerUuid, accountIdentity = null, accountEmail = null, providerName = null) {
    const canonical = getCanonicalAccountUsageIdentity(provider, providerUuid, accountIdentity, accountEmail, providerName);
    if (!canonical?.provider || !canonical?.identity) return null;
    return `${canonical.provider}:${canonical.identity}`;
}

function addProviderUuidToAccount(accountUsage, providerUuid) {
    if (!accountUsage || !providerUuid) return;
    const existing = Array.isArray(accountUsage.providerUuids) ? accountUsage.providerUuids : [];
    accountUsage.providerUuids = [...new Set([...existing, providerUuid].filter(Boolean))];
}

function ensureAccountUsage(map, provider, providerUuid, providerName, accountIdentity = null, accountEmail = null) {
    const accountKey = getAccountUsageKey(provider, providerUuid, accountIdentity, accountEmail, providerName);
    if (!accountKey) return null;
    const canonical = getCanonicalAccountUsageIdentity(provider, providerUuid, accountIdentity, accountEmail, providerName);

    if (!map[accountKey]) {
        map[accountKey] = {
            provider: canonical.provider,
            providerUuid: canonical.identity,
            accountIdentity: canonical.identity || null,
            accountEmail: canonical.accountEmail || null,
            providerUuids: providerUuid ? [providerUuid] : [],
            providerName: providerName || null,
            summary: createUsageBucket(),
            models: {}
        };
    } else {
        if (canonical?.identity) {
            map[accountKey].provider = canonical.provider;
            map[accountKey].accountIdentity = canonical.identity;
            map[accountKey].providerUuid = canonical.identity;
        }
        if (canonical?.accountEmail) {
            map[accountKey].accountEmail = canonical.accountEmail;
        }
        addProviderUuidToAccount(map[accountKey], providerUuid);
        if (providerName && !map[accountKey].providerName) {
            map[accountKey].providerName = providerName;
        }
    }

    return map[accountKey];
}

function getBeijingHourString(timestamp = new Date()) {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        hour12: false
    }).formatToParts(date);
    return parts.find(part => part.type === 'hour')?.value || '00';
}

function ensureHourUsage(dayHistory, hour) {
    if (!dayHistory.hours[hour]) {
        dayHistory.hours[hour] = {
            summary: createUsageBucket(),
            providers: {},
            models: {},
            providerModels: {},
            accounts: {}
        };
    }
    return dayHistory.hours[hour];
}

function addAccountUsage(targetMap, account = {}) {
    const provider = account.provider || 'unknown';
    const providerUuids = Array.isArray(account.providerUuids)
        ? account.providerUuids.filter(Boolean)
        : [];
    const providerUuid = providerUuids[0] || account.providerUuid || null;
    const accountUsage = ensureAccountUsage(targetMap, provider, providerUuid, account.providerName, account.accountIdentity || null, account.accountEmail || null);
    if (!accountUsage) return;
    if (account.accountEmail && !accountUsage.accountEmail) {
        accountUsage.accountEmail = account.accountEmail;
    }
    for (const uuid of providerUuids) {
        addProviderUuidToAccount(accountUsage, uuid);
    }
    if (account.providerUuid && account.providerUuid !== account.accountIdentity) {
        addProviderUuidToAccount(accountUsage, account.providerUuid);
    }

    addUsage(accountUsage.summary, account.summary);
    for (const [model, usage] of Object.entries(account.models || {})) {
        accountUsage.models[model] = normalizeUsageBucket(accountUsage.models[model]);
        addUsage(accountUsage.models[model], usage);
    }
}

function addProviderModelUsage(targetMap, provider, model, usage = {}) {
    if (!provider || !model) return;
    if (!targetMap[provider]) targetMap[provider] = {};
    targetMap[provider][model] = normalizeUsageBucket(targetMap[provider][model]);
    addUsage(targetMap[provider][model], usage);
}

function addProviderModelsFromAccounts(targetMap, accounts = {}) {
    for (const account of Object.values(accounts || {})) {
        const provider = account?.provider;
        if (!provider) continue;
        for (const [model, usage] of Object.entries(account.models || {})) {
            addProviderModelUsage(targetMap, provider, model, usage);
        }
    }
}

function getBeijingDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const getPart = (type) => Number(parts.find(part => part.type === type)?.value);
    return {
        year: getPart('year'),
        month: getPart('month'),
        day: getPart('day')
    };
}

function dateKeyFromUtcDate(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getBeijingPeriodStarts(now = new Date()) {
    const parts = getBeijingDateParts(now);
    const todayUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const weekStartUtc = new Date(todayUtc);
    weekStartUtc.setUTCDate(todayUtc.getUTCDate() - 6);
    const monthStartUtc = new Date(todayUtc);
    monthStartUtc.setUTCDate(todayUtc.getUTCDate() - 29);

    return {
        today: dateKeyFromUtcDate(todayUtc),
        week: dateKeyFromUtcDate(weekStartUtc),
        month: dateKeyFromUtcDate(monthStartUtc)
    };
}

function cloneUsageBucket(bucket = {}) {
    const normalized = normalizeUsageBucket(bucket);
    if (bucket?.cost) {
        normalized.cost = cloneCostBucket(bucket.cost);
    }
    return normalized;
}

function createCostBucket(sourceCost = {}) {
    return {
        usd: 0,
        actualUsd: 0,
        estimatedUsd: 0,
        convertedUsd: 0,
        missingPriceTokens: 0,
        estimatedPriceTokens: 0,
        conversionModel: sourceCost.conversionModel || DEFAULT_CONVERSION_MODEL,
        pricingVersion: sourceCost.pricingVersion || '',
        byModel: {}
    };
}

function cloneCostBucket(cost = {}) {
    return {
        ...createCostBucket(cost),
        ...cost,
        usd: toNumber(cost.usd ?? (toNumber(cost.actualUsd) + toNumber(cost.estimatedUsd))),
        actualUsd: toNumber(cost.actualUsd),
        estimatedUsd: toNumber(cost.estimatedUsd),
        convertedUsd: toNumber(cost.convertedUsd),
        missingPriceTokens: toNumber(cost.missingPriceTokens),
        estimatedPriceTokens: toNumber(cost.estimatedPriceTokens),
        byModel: { ...(cost.byModel || {}) }
    };
}

function cloneCompactCostBucket(cost = {}) {
    const cloned = cloneCostBucket(cost);
    delete cloned.byModel;
    return cloned;
}

function addCost(targetUsage, sourceCost = null) {
    if (!sourceCost) return;
    if (!targetUsage.cost) targetUsage.cost = createCostBucket(sourceCost);
    targetUsage.cost.usd += toNumber(sourceCost.usd ?? (toNumber(sourceCost.actualUsd) + toNumber(sourceCost.estimatedUsd)));
    targetUsage.cost.actualUsd += toNumber(sourceCost.actualUsd);
    targetUsage.cost.estimatedUsd += toNumber(sourceCost.estimatedUsd);
    targetUsage.cost.convertedUsd += toNumber(sourceCost.convertedUsd);
    targetUsage.cost.missingPriceTokens += toNumber(sourceCost.missingPriceTokens);
    targetUsage.cost.estimatedPriceTokens += toNumber(sourceCost.estimatedPriceTokens);
    targetUsage.cost.conversionModel = sourceCost.conversionModel || targetUsage.cost.conversionModel;
    targetUsage.cost.pricingVersion = sourceCost.pricingVersion || targetUsage.cost.pricingVersion;
    for (const [model, estimate] of Object.entries(sourceCost.byModel || {})) {
        const current = targetUsage.cost.byModel[model] || {};
        targetUsage.cost.byModel[model] = {
            ...estimate,
            usd: toNumber(current.usd) + toNumber(estimate.usd),
            actualUsd: toNumber(current.actualUsd) + toNumber(estimate.actualUsd),
            estimatedUsd: toNumber(current.estimatedUsd) + toNumber(estimate.estimatedUsd),
            estimatedPriceTokens: toNumber(current.estimatedPriceTokens) + toNumber(estimate.estimatedPriceTokens),
            missingPriceTokens: toNumber(current.missingPriceTokens) + toNumber(estimate.missingPriceTokens)
        };
    }
}

function addAccountSummaryRange(target, rangeName, account) {
    if (!target[rangeName]) target[rangeName] = createUsageBucket();
    addUsage(target[rangeName], account?.summary);
    addCost(target[rangeName], account?.summary?.cost);
}

function isEmailLike(value) {
    return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function normalizeEmailAlias(value) {
    return isEmailLike(value) ? value.trim().toLowerCase() : null;
}

function getProviderFromAccountKey(accountKey) {
    return accountKey?.split(':')[0] || 'unknown';
}

function getIdentityFromAccountKey(accountKey) {
    return accountKey?.split(':').slice(1).join(':') || null;
}

function getAccountProvider(accountKey, account = {}) {
    return account.provider || getProviderFromAccountKey(accountKey);
}

function getSummaryCanonicalAccountKey(accountKey, account = {}) {
    const provider = getAccountProvider(accountKey, account);
    return getAccountUsageKey(
        provider,
        account.providerUuid || getIdentityFromAccountKey(accountKey),
        account.accountIdentity || null,
        account.accountEmail || null,
        account.providerName || null
    ) || accountKey;
}

function getAccountSummaryAliases(accountKey, account = {}, options = {}) {
    const provider = getAccountProvider(accountKey, account);
    const aliases = new Set([`account-key:${accountKey}`]);
    const addProviderAlias = (value) => {
        if (!value) return;
        const alias = `provider:${provider}:${value}`;
        if (!options.ambiguousProviderAliases?.has(alias)) aliases.add(alias);
    };

    addProviderAlias(getIdentityFromAccountKey(accountKey));
    addProviderAlias(account.providerUuid);
    addProviderAlias(account.accountIdentity);
    for (const uuid of account.providerUuids || []) {
        addProviderAlias(uuid);
    }

    const emailAlias = normalizeEmailAlias(account.accountEmail) || normalizeEmailAlias(account.providerName);
    if (emailAlias) {
        aliases.add(`email:${provider}:${emailAlias}`);
    }

    return [...aliases];
}

function collectRawProviderUuidAliases(accountKey, account = {}) {
    const provider = getAccountProvider(accountKey, account);
    const canonical = getCanonicalAccountUsageIdentity(
        provider,
        account.providerUuid || getIdentityFromAccountKey(accountKey),
        account.accountIdentity || null,
        account.accountEmail || null,
        account.providerName || null
    );
    const values = new Set(account.providerUuids || []);
    const keyIdentity = getIdentityFromAccountKey(accountKey);
    for (const value of [account.providerUuid, keyIdentity]) {
        if (value && value !== canonical?.identity) values.add(value);
    }
    const providers = new Set([provider, canonical?.provider].filter(Boolean));
    return [...providers].flatMap(aliasProvider => (
        [...values].map(value => `provider:${aliasProvider}:${value}`)
    ));
}

function findAmbiguousProviderAliases(usageHistory = {}, starts = {}) {
    const ownersByAlias = new Map();
    for (const [dateKey, day] of Object.entries(usageHistory || {})) {
        if (dateKey !== starts.today && dateKey < starts.week && dateKey < starts.month) continue;
        for (const [accountKey, account] of Object.entries(day.accounts || {})) {
            const owner = getSummaryCanonicalAccountKey(accountKey, account);
            for (const alias of collectRawProviderUuidAliases(accountKey, account)) {
                const owners = ownersByAlias.get(alias) || new Set();
                owners.add(owner);
                ownersByAlias.set(alias, owners);
            }
        }
    }
    return new Set(
        [...ownersByAlias.entries()]
            .filter(([, owners]) => owners.size > 1)
            .map(([alias]) => alias)
    );
}

function createAccountSummaryEntry(accountKey, account = {}) {
    const provider = getAccountProvider(accountKey, account);
    const canonical = getCanonicalAccountUsageIdentity(
        provider,
        account.providerUuid || getIdentityFromAccountKey(accountKey),
        account.accountIdentity || null,
        account.accountEmail || null,
        account.providerName || null
    );
    const providerUuid = canonical?.identity
        || account.accountIdentity
        || account.providerUuid
        || getIdentityFromAccountKey(accountKey);
    const providerUuids = Array.isArray(account.providerUuids)
        ? [...new Set(account.providerUuids.filter(Boolean))]
        : (account.providerUuid && account.providerUuid !== account.accountIdentity ? [account.providerUuid] : []);

    return {
        accountKey: getSummaryCanonicalAccountKey(accountKey, account),
        provider: canonical?.provider || provider,
        providerUuid,
        accountIdentity: canonical?.identity || account.accountIdentity || null,
        accountEmail: canonical?.accountEmail || account.accountEmail || normalizeEmailAlias(account.providerName),
        providerUuids,
        providerName: account.providerName || null,
        today: createUsageBucket(),
        week: createUsageBucket(),
        month: createUsageBucket()
    };
}

function mergeAccountSummaryMeta(target, account = {}, accountKey = null) {
    if (!target) return;
    const canonical = getCanonicalAccountUsageIdentity(
        account.provider || target.provider || getProviderFromAccountKey(accountKey),
        account.providerUuid || getIdentityFromAccountKey(accountKey),
        account.accountIdentity || null,
        account.accountEmail || null,
        account.providerName || null
    );
    if (canonical?.provider) {
        target.provider = canonical.provider;
    }
    if (canonical?.identity) {
        target.accountIdentity = canonical.identity;
        target.providerUuid = canonical.identity;
    }
    if (canonical?.accountEmail) {
        target.accountEmail = canonical.accountEmail;
    }
    if (account.providerName && !target.providerName) {
        target.providerName = account.providerName;
    }
    if (account.accountEmail && !target.accountEmail) {
        target.accountEmail = account.accountEmail;
    } else if (!target.accountEmail && normalizeEmailAlias(account.providerName)) {
        target.accountEmail = normalizeEmailAlias(account.providerName);
    }
    if (account.accountIdentity && !target.accountIdentity) {
        target.accountIdentity = account.accountIdentity;
        target.providerUuid = account.accountIdentity;
    }

    const uuids = new Set(Array.isArray(target.providerUuids) ? target.providerUuids : []);
    for (const uuid of account.providerUuids || []) {
        if (uuid && uuid !== target.accountIdentity) uuids.add(uuid);
    }
    if (account.providerUuid && account.providerUuid !== target.accountIdentity) {
        uuids.add(account.providerUuid);
    }
    const keyIdentity = getIdentityFromAccountKey(accountKey);
    if (keyIdentity && keyIdentity !== target.accountIdentity) {
        uuids.add(keyIdentity);
    }
    target.providerUuids = [...uuids];
}

function reassignAccountSummaryAliases(aliasIndex, fromKey, toKey) {
    for (const [alias, key] of aliasIndex.entries()) {
        if (key === fromKey) {
            aliasIndex.set(alias, toKey);
        }
    }
}

function getLatestUsageTimestampFromAccount(account = {}) {
    let latest = account?.summary?.lastUsedAt || account?.lastUsedAt || null;
    for (const usage of Object.values(account?.models || {})) {
        latest = latestTimestamp(latest, usage?.lastUsedAt);
    }
    return latest;
}

function readModelUsageAccountLastUsedIndex() {
    const index = new Map();
    if (!existsSync(MODEL_USAGE_STATS_FILE)) return index;

    try {
        const stats = JSON.parse(readFileSync(MODEL_USAGE_STATS_FILE, 'utf8'));
        for (const [accountKey, account] of Object.entries(stats.accounts || {})) {
            const lastUsedAt = getLatestUsageTimestampFromAccount(account);
            if (!lastUsedAt) continue;
            for (const alias of getAccountSummaryAliases(accountKey, account)) {
                index.set(alias, latestTimestamp(index.get(alias), lastUsedAt));
            }
        }
    } catch (error) {
        logger.warn(`[API Potluck] Failed to read model usage account timestamps: ${error.message}`);
    }

    return index;
}

function readModelUsageDailyHistory(conversionModel = DEFAULT_CONVERSION_MODEL) {
    if (!existsSync(MODEL_USAGE_STATS_FILE)) return null;

    try {
        const stats = JSON.parse(readFileSync(MODEL_USAGE_STATS_FILE, 'utf8'));
        const daily = stats.daily || {};
        const usageHistory = {};
        let hasAccountUsage = false;

        for (const [dateKey, day] of Object.entries(daily)) {
            const normalizedDay = normalizeUsageHistoryDay({
                summary: day,
                models: day?.models || {},
                accounts: day?.accounts || {}
            });
            if (Object.keys(normalizedDay.accounts || {}).length > 0) {
                hasAccountUsage = true;
            }
            usageHistory[dateKey] = normalizedDay;
        }

        if (!hasAccountUsage) return null;
        trimUsageHistory(usageHistory, USAGE_HISTORY_RETENTION_DAYS);
        addUsageHistoryRatios(usageHistory);
        addCostToUsageHistory(usageHistory, conversionModel);
        return usageHistory;
    } catch (error) {
        logger.warn(`[API Potluck] Failed to read model usage daily account history: ${error.message}`);
        return null;
    }
}

function hasAccountUsageInSummaryWindow(usageHistory = {}, starts = {}) {
    for (const [dateKey, day] of Object.entries(usageHistory || {})) {
        if (dateKey !== starts.today && dateKey < starts.week && dateKey < starts.month) continue;
        if (Object.keys(day?.accounts || {}).length > 0) return true;
    }
    return false;
}

function createAccountCoverageBucket() {
    return {
        totalTokens: 0,
        accountTokens: 0,
        missingTokens: 0,
        totalRequests: 0,
        accountRequests: 0,
        missingRequests: 0,
        coverageRatio: 1,
        status: 'complete',
        firstTrackedDay: null,
        lastTrackedDay: null
    };
}

function addAccountCoverageDay(bucket, day = {}, dateKey = null) {
    const totalTokens = toNumber(day?.summary?.totalTokens);
    const totalRequests = toNumber(day?.summary?.requestCount);
    const accountTotals = createUsageBucket();
    for (const account of Object.values(day?.accounts || {})) {
        addUsage(accountTotals, account.summary || {});
    }

    bucket.totalTokens += totalTokens;
    bucket.accountTokens += accountTotals.totalTokens;
    bucket.totalRequests += totalRequests;
    bucket.accountRequests += accountTotals.requestCount;
    if (dateKey) {
        bucket.firstTrackedDay = bucket.firstTrackedDay ? Math.min(bucket.firstTrackedDay, dateKey) : dateKey;
        bucket.lastTrackedDay = bucket.lastTrackedDay ? Math.max(bucket.lastTrackedDay, dateKey) : dateKey;
    }
}

function finalizeAccountCoverageBucket(bucket) {
    bucket.missingTokens = Math.max(0, bucket.totalTokens - bucket.accountTokens);
    bucket.missingRequests = Math.max(0, bucket.totalRequests - bucket.accountRequests);
    bucket.coverageRatio = bucket.totalTokens > 0
        ? Math.min(1, bucket.accountTokens / bucket.totalTokens)
        : 1;
    bucket.status = bucket.missingTokens > 0 || bucket.missingRequests > 0 ? 'partial' : 'complete';
    return bucket;
}

function buildAccountHistoryCoverage(usageHistory = {}, starts = {}) {
    const coverage = {
        today: createAccountCoverageBucket(),
        week: createAccountCoverageBucket(),
        month: createAccountCoverageBucket()
    };

    for (const [dateKey, day] of Object.entries(usageHistory || {})) {
        if (dateKey === starts.today) addAccountCoverageDay(coverage.today, day, dateKey);
        if (dateKey >= starts.week) addAccountCoverageDay(coverage.week, day, dateKey);
        if (dateKey >= starts.month) addAccountCoverageDay(coverage.month, day, dateKey);
    }

    return {
        today: finalizeAccountCoverageBucket(coverage.today),
        week: finalizeAccountCoverageBucket(coverage.week),
        month: finalizeAccountCoverageBucket(coverage.month)
    };
}

function getIndexedAccountLastUsedAt(account, lastUsedIndex) {
    let latest = null;
    for (const alias of getAccountSummaryAliases(account.accountKey, account)) {
        latest = latestTimestamp(latest, lastUsedIndex.get(alias));
    }
    return latest;
}

function resetUsageBucketTokens(bucket) {
    if (!bucket || typeof bucket !== 'object') return;
    bucket.promptTokens = 0;
    bucket.completionTokens = 0;
    bucket.reasoningTokens = 0;
    bucket.totalTokens = 0;
    bucket.cachedTokens = 0;
    bucket.maxQps = 0;
    bucket.maxRpm = 0;
    bucket.maxTps = 0;
}

function resetUsageHistoryTokens(usageHistory) {
    if (!usageHistory || typeof usageHistory !== 'object') return;

    for (const day of Object.values(usageHistory)) {
        if (!day || typeof day !== 'object') continue;
        resetUsageBucketTokens(day.summary);

        for (const usage of Object.values(day.providers || {})) {
            resetUsageBucketTokens(usage);
        }

        for (const usage of Object.values(day.models || {})) {
            resetUsageBucketTokens(usage);
        }
        for (const models of Object.values(day.providerModels || {})) {
            for (const usage of Object.values(models || {})) resetUsageBucketTokens(usage);
        }

        for (const account of Object.values(day.accounts || {})) {
            resetUsageBucketTokens(account.summary);
            for (const usage of Object.values(account.models || {})) {
                resetUsageBucketTokens(usage);
            }
        }

        for (const hour of Object.values(day.hours || {})) {
            resetUsageBucketTokens(hour.summary);
            for (const usage of Object.values(hour.providers || {})) {
                resetUsageBucketTokens(usage);
            }
            for (const usage of Object.values(hour.models || {})) {
                resetUsageBucketTokens(usage);
            }
            for (const models of Object.values(hour.providerModels || {})) {
                for (const usage of Object.values(models || {})) resetUsageBucketTokens(usage);
            }
            for (const account of Object.values(hour.accounts || {})) {
                resetUsageBucketTokens(account.summary);
                for (const usage of Object.values(account.models || {})) {
                    resetUsageBucketTokens(usage);
                }
            }
        }
    }
}

function getRecentDateKeys(days = 7, now = new Date()) {
    const parts = getBeijingDateParts(now);
    const todayUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const dateKeys = [];
    for (let offset = days - 1; offset >= 0; offset--) {
        const date = new Date(todayUtc);
        date.setUTCDate(todayUtc.getUTCDate() - offset);
        dateKeys.push(dateKeyFromUtcDate(date));
    }
    return dateKeys;
}

function getRecentHistorySummary(usageHistory = {}, days = 7, now = new Date()) {
    const summary = createUsageBucket();
    for (const date of getRecentDateKeys(days, now)) {
        const daySummary = usageHistory[date]?.summary;
        if (daySummary) addUsage(summary, daySummary);
    }
    addCacheHitRatio(summary);
    return summary;
}

function collectRelatedAccountNames(usageHistory = {}, limit = 2) {
    const accounts = new Map();
    const collectAccount = (account, dateKey = '') => {
        if (!account || typeof account !== 'object') return;
        const displayName = sanitizeProviderName(account.providerName) || account.providerUuid || account.provider;
        if (!displayName) return;

        const accountKey = `${account.provider || ''}:${account.providerUuid || displayName}`;
        const current = accounts.get(accountKey) || {
            name: displayName,
            requestCount: 0,
            totalTokens: 0,
            latestDate: ''
        };
        current.name = current.name || displayName;
        current.requestCount += toNumber(account.summary?.requestCount);
        current.totalTokens += toNumber(account.summary?.totalTokens);
        current.latestDate = current.latestDate > dateKey ? current.latestDate : dateKey;
        accounts.set(accountKey, current);
    };

    for (const [dateKey, day] of Object.entries(usageHistory || {})) {
        for (const account of Object.values(day?.accounts || {})) {
            collectAccount(account, dateKey);
        }
        for (const [hourKey, hour] of Object.entries(day?.hours || {})) {
            for (const account of Object.values(hour?.accounts || {})) {
                collectAccount(account, `${dateKey}T${hourKey}`);
            }
        }
    }

    return [...accounts.values()]
        .sort((a, b) => (
            b.requestCount - a.requestCount ||
            b.totalTokens - a.totalTokens ||
            b.latestDate.localeCompare(a.latestDate) ||
            a.name.localeCompare(b.name)
        ))
        .slice(0, limit)
        .map(account => account.name);
}

function collectModelsFromUsageHistory(usageHistory = {}) {
    const models = {};
    for (const day of Object.values(usageHistory || {})) {
        for (const [model, usage] of Object.entries(day?.models || {})) {
            models[model] = normalizeUsageBucket(models[model]);
            addUsage(models[model], usage);
        }
    }
    return models;
}

function addCostToUsageHistory(usageHistory = {}, conversionModel = DEFAULT_CONVERSION_MODEL) {
    for (const day of Object.values(usageHistory || {})) {
        if (!day?.summary) continue;
        day.summary.cost = buildCost(day.summary, day.models || {}, conversionModel);
        for (const [model, usage] of Object.entries(day.models || {})) {
            usage.cost = buildCost(usage, { [model]: usage }, conversionModel);
        }
        for (const models of Object.values(day.providerModels || {})) {
            for (const [model, usage] of Object.entries(models || {})) {
                usage.cost = buildCost(usage, { [model]: usage }, conversionModel);
            }
        }
        for (const account of Object.values(day.accounts || {})) {
            account.summary.cost = buildCost(account.summary, account.models || {}, conversionModel);
            for (const [model, usage] of Object.entries(account.models || {})) {
                usage.cost = buildCost(usage, { [model]: usage }, conversionModel);
            }
        }
        for (const hour of Object.values(day.hours || {})) {
            hour.summary.cost = buildCost(hour.summary, hour.models || {}, conversionModel);
            for (const [model, usage] of Object.entries(hour.models || {})) {
                usage.cost = buildCost(usage, { [model]: usage }, conversionModel);
            }
            for (const models of Object.values(hour.providerModels || {})) {
                for (const [model, usage] of Object.entries(models || {})) {
                    usage.cost = buildCost(usage, { [model]: usage }, conversionModel);
                }
            }
            for (const account of Object.values(hour.accounts || {})) {
                account.summary.cost = buildCost(account.summary, account.models || {}, conversionModel);
                for (const [model, usage] of Object.entries(account.models || {})) {
                    usage.cost = buildCost(usage, { [model]: usage }, conversionModel);
                }
            }
        }
    }
    return usageHistory;
}

function cloneUsageHistorySummaryOnly(usageHistory = {}, conversionModel = DEFAULT_CONVERSION_MODEL, options = {}) {
    const compact = {};
    for (const [date, day] of Object.entries(usageHistory || {})) {
        const summary = cloneUsageBucket(day?.summary || {});
        addCacheHitRatio(summary);
        if (!options.compactCosts) {
            summary.cost = buildCost(summary, day?.models || {}, conversionModel);
        } else {
            summary.cost = cloneCompactCostBucket(buildCost(summary, day?.models || {}, conversionModel));
        }
        compact[date] = { summary };
    }
    return compact;
}

function cloneCredentialRoutingUsageHistory(usageHistory = {}) {
    const recentEntries = Object.entries(usageHistory || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(-7);
    const recentHistory = Object.fromEntries(recentEntries);
    const compact = cloneUsageHistorySummaryOnly(
        recentHistory,
        DEFAULT_CONVERSION_MODEL,
        { compactCosts: true }
    );
    for (const [date, day] of recentEntries) {
        if (day?.summary?.cost) {
            compact[date].summary.cost = cloneCompactCostBucket(day.summary.cost);
        }
    }
    return compact;
}

function cloneUsageMapForCompactHistory(usageMap = {}) {
    const compact = {};
    for (const [name, usage] of Object.entries(usageMap || {})) {
        compact[name] = cloneUsageBucket(usage);
        addCacheHitRatio(compact[name]);
        delete compact[name].cost;
    }
    return compact;
}

function cloneUsageHistoryForUser(usageHistory = {}, conversionModel = DEFAULT_CONVERSION_MODEL, options = {}) {
    const compact = {};
    for (const [date, day] of Object.entries(usageHistory || {})) {
        const summary = cloneUsageBucket(day?.summary || {});
        addCacheHitRatio(summary);
        const summaryCost = buildCost(summary, day?.models || {}, conversionModel);
        summary.cost = options.compactCosts ? cloneCompactCostBucket(summaryCost) : summaryCost;
        compact[date] = {
            summary,
            providers: cloneUsageMapForCompactHistory(day?.providers),
            models: cloneUsageMapForCompactHistory(day?.models)
        };
    }
    return compact;
}

function getCostOptions(options = {}) {
    return {
        conversionModel: normalizeConversionModel(options?.conversionModel)
    };
}

function enrichKeyUsage(keyData, options = {}) {
    const { conversionModel } = getCostOptions(options);
    const usageHistory = options.compactUserHistory
        ? cloneUsageHistoryForUser(keyData.usageHistory || {}, conversionModel, options)
        : options.summaryOnly
            ? cloneUsageHistorySummaryOnly(keyData.usageHistory || {}, conversionModel, options)
            : addUsageHistoryRatios(JSON.parse(JSON.stringify(keyData.usageHistory || {})));
    if (!options.summaryOnly && !options.compactUserHistory) {
        addCostToUsageHistory(usageHistory, conversionModel);
    }
    const weeklySummary = getRecentHistorySummary(usageHistory, 7);
    const keyHash = hashSecret(keyData.id);
    const relatedAccountHistory = options.summaryOnly || options.compactUserHistory
        ? keyData.usageHistory || {}
        : usageHistory;
    const enriched = {
        ...keyData,
        usageHistory,
        cost: buildCost(
            {
                promptTokens: keyData.totalPromptTokens,
                cachedTokens: keyData.totalCachedTokens,
                completionTokens: keyData.totalCompletionTokens,
                reasoningTokens: keyData.totalReasoningTokens,
                totalTokens: keyData.totalTokens
            },
            keyData.totalModels || collectModelsFromUsageHistory(usageHistory),
            conversionModel
        ),
        pricing: {
            conversionModels: getConversionModels()
        },
        audit: {
            keyHash,
            summaryPath: `/api/request-audit/summary?keyHash=${encodeURIComponent(keyHash || '')}`,
            requestsPath: `/api/request-audit/requests?keyHash=${encodeURIComponent(keyHash || '')}`,
            defaultWindow: 'last20m',
            relatedNames: collectRelatedAccountNames(relatedAccountHistory)
        },
        weeklyUsage: weeklySummary.requestCount,
        weeklyPromptTokens: weeklySummary.promptTokens,
        weeklyCompletionTokens: weeklySummary.completionTokens,
        weeklyReasoningTokens: weeklySummary.reasoningTokens,
        weeklyTotalTokens: weeklySummary.totalTokens,
        weeklyCachedTokens: weeklySummary.cachedTokens,
        todayCacheHitRatio: keyData.todayPromptTokens > 0 ? keyData.todayCachedTokens / keyData.todayPromptTokens : 0,
        weeklyCacheHitRatio: weeklySummary.cacheHitRatio,
        totalCacheHitRatio: keyData.totalPromptTokens > 0 ? keyData.totalCachedTokens / keyData.totalPromptTokens : 0
    };
    return enriched;
}

/**
 * 初始化：从文件加载数据到内存
 */
function ensureLoaded() {
    if (keyStore !== null) return;
    try {
        if (existsSync(KEYS_STORE_FILE)) {
            const content = readFileSync(KEYS_STORE_FILE, 'utf8');
            const parsedStore = JSON.parse(content);
            keyStore = normalizeStore(parsedStore);
            const legacyHistories = Object.entries(keyStore.keys || {})
                .filter(([apiKey, keyData]) => (
                    Object.keys(keyData.usageHistory || {}).length > 0
                    && Object.keys(loadUsageHistory(apiKey)).length === 0
                ))
                .map(([apiKey, keyData]) => ({
                    apiKey,
                    usageHistory: keyData.usageHistory,
                    totalModels: keyData.totalModels || {}
                }));
            if (legacyHistories.length > 0) {
                const sourceSha256 = crypto.createHash('sha256').update(content).digest('hex');
                const backupPath = `${KEYS_STORE_FILE}.pre-usage-split-${sourceSha256.slice(0, 12)}.bak`;
                if (!existsSync(backupPath)) {
                    writeFileSync(backupPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
                }
                importLegacyUsageHistories({
                    sourceSha256,
                    sourcePath: path.basename(KEYS_STORE_FILE),
                    histories: legacyHistories
                });
                legacyUsageMigrationPending = true;
            }
            for (const [apiKey, keyData] of Object.entries(keyStore.keys || {})) {
                const storedHistory = loadUsageHistory(apiKey);
                if (Object.keys(storedHistory).length > 0) {
                    keyData.usageHistory = storedHistory;
                }
                const storedTotals = loadUsageTotals(apiKey);
                keyData.totalModels = Object.keys(storedTotals).length > 0
                    ? storedTotals
                    : collectModelsFromUsageHistory(keyData.usageHistory || {});
            }
        } else {
            keyStore = { keys: {} };
            syncWriteToFile();
        }
    } catch (error) {
        logger.error('[API Potluck] Failed to load key store:', error.message);
        keyStore = { keys: {} };
    }

    refreshPersistenceConfig();
    if (legacyUsageMigrationPending) markDirty();
}

function buildMetadataSnapshot() {
    return {
        ...keyStore,
        keys: Object.fromEntries(Object.entries(keyStore?.keys || {}).map(([apiKey, keyData]) => {
            const { usageHistory, totalModels, ...metadata } = keyData;
            return [apiKey, metadata];
        }))
    };
}

function persistDirtyUsageHistories() {
    const keysToPersist = [...dirtyUsageKeys];
    for (const apiKey of keysToPersist) {
        const keyData = keyStore?.keys?.[apiKey];
        if (keyData) persistUsageHistory(apiKey, keyData.usageHistory || {}, keyData.totalModels || {});
        else deleteUsageHistory(apiKey);
    }
    return keysToPersist;
}

function unrefTimer(timer) {
    if (timer?.unref) timer.unref();
    return timer;
}

function clearScheduledPersistence() {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    if (maxDirtyTimer) {
        clearTimeout(maxDirtyTimer);
        maxDirtyTimer = null;
    }
}

function schedulePersistence({ resetDebounce = false } = {}) {
    if (!isDirty || keyStore === null) return;

    const now = Date.now();
    const retryDelay = Math.max(0, retryNotBefore - now);
    const debounceDelay = retryDelay > 0 ? retryDelay : currentPersistInterval;

    if (resetDebounce && persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    if (!persistTimer) {
        persistTimer = unrefTimer(setTimeout(async () => {
            persistTimer = null;
            await persistIfDirty();
            if (isDirty) schedulePersistence();
        }, debounceDelay));
    }

    if (maxDirtyTimer) {
        clearTimeout(maxDirtyTimer);
        maxDirtyTimer = null;
    }
    const dirtyAge = dirtySince === null ? 0 : Math.max(0, now - dirtySince);
    const remainingDirtyAge = Math.max(0, currentMaxDirtyAge - dirtyAge);
    const maxDirtyDelay = Math.max(remainingDirtyAge, retryDelay);
    maxDirtyTimer = unrefTimer(setTimeout(async () => {
        maxDirtyTimer = null;
        await persistIfDirty();
        if (isDirty) schedulePersistence();
    }, maxDirtyDelay));
}

/**
 * 同步写入文件（仅初始化时使用）
 */
function syncWriteToFile() {
    try {
        const dir = path.dirname(KEYS_STORE_FILE);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        persistDirtyUsageHistories();
        atomicWriteFileSync(KEYS_STORE_FILE, JSON.stringify(buildMetadataSnapshot()), { encoding: 'utf8', mode: 0o600 });
        dirtyUsageKeys.clear();
        legacyUsageMigrationPending = false;
    } catch (error) {
        logger.error('[API Potluck] Sync write failed:', error.message);
    }
}

/**
 * 异步持久化。每次调度最多写一个快照，避免持续流量下形成无界全量写循环。
 */
async function persistIfDirty() {
    if (persistPromise) return persistPromise;
    if (!isDirty || keyStore === null) return true;

    clearScheduledPersistence();

    const versionAtStart = mutationVersion;
    const dirtySinceAtStart = dirtySince;
    const serializeStartedAt = performance.now();
    let snapshot;
    try {
        persistDirtyUsageHistories();
        snapshot = JSON.stringify(buildMetadataSnapshot());
    } catch (error) {
        retryNotBefore = Date.now() + PERSIST_RETRY_DELAY_MS;
        logger.error('[API Potluck] Usage history or snapshot preparation failed:', error.message);
        schedulePersistence({ resetDebounce: true });
        return false;
    }
    const serializeMs = performance.now() - serializeStartedAt;
    const snapshotBytes = Buffer.byteLength(snapshot, 'utf8');

    // 当前快照已接管现有 dirty 状态；写入期间的新 mutation 会重新标脏。
    isDirty = false;
    dirtySince = null;

    persistPromise = (async () => {
        isWriting = true;
        const writeStartedAt = performance.now();
        try {
            const dir = path.dirname(KEYS_STORE_FILE);
            if (!existsSync(dir)) {
                await fs.mkdir(dir, { recursive: true });
            }
            await atomicWriteFile(KEYS_STORE_FILE, snapshot, { encoding: 'utf8', mode: 0o600 });

            lastPersistedVersion = Math.max(lastPersistedVersion, versionAtStart);
            if (mutationVersion === versionAtStart) {
                dirtyUsageKeys.clear();
                legacyUsageMigrationPending = false;
            }
            retryNotBefore = 0;
            const writeMs = performance.now() - writeStartedAt;
            const memory = process.memoryUsage();
            const toMiB = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
            logger.info(
                `[API Potluck] Persisted key store: version=${versionAtStart}, bytes=${snapshotBytes}, ` +
                `serializeMs=${serializeMs.toFixed(1)}, writeMs=${writeMs.toFixed(1)}, ` +
                `heapUsedMiB=${toMiB(memory.heapUsed)}, externalMiB=${toMiB(memory.external)}, rssMiB=${toMiB(memory.rss)}, ` +
                `dirtyAfterWrite=${mutationVersion !== versionAtStart}`
            );
            return true;
        } catch (error) {
            isDirty = true;
            dirtySince = dirtySince === null
                ? (dirtySinceAtStart ?? Date.now())
                : Math.min(dirtySince, dirtySinceAtStart ?? dirtySince);
            retryNotBefore = Date.now() + PERSIST_RETRY_DELAY_MS;
            logger.error('[API Potluck] Persist failed:', error.message);
            return false;
        } finally {
            isWriting = false;
            persistPromise = null;
            if (isDirty) schedulePersistence();
        }
    })();

    return persistPromise;
}

/**
 * 关闭插件前排空所有已知 mutation，并等待正在进行的写入完成。
 */
export async function flushPendingChanges({ targetVersion = mutationVersion, shutdown = false } = {}) {
    if (keyStore === null) return true;
    let remainingFailureRetries = shutdown ? 1 : 0;

    while (lastPersistedVersion < targetVersion) {
        clearScheduledPersistence();
        if (!persistPromise && !isDirty) {
            logger.error(`[API Potluck] Persistence stalled before version ${targetVersion}`);
            return false;
        }
        if (!shutdown && !persistPromise && retryNotBefore > Date.now()) {
            schedulePersistence();
            return false;
        }
        try {
            const succeeded = await (persistPromise || persistIfDirty());
            if (!succeeded) {
                if (remainingFailureRetries <= 0) return false;
                remainingFailureRetries -= 1;
            }
        } catch (error) {
            logger.error(`[API Potluck] Failed to flush key store through version ${targetVersion}:`, error.message);
            if (remainingFailureRetries <= 0) return false;
            remainingFailureRetries -= 1;
        }
    }
    return true;
}

function attachPersistenceStatus(result, persistencePending) {
    const response = { ...result };
    Object.defineProperty(response, 'persistencePending', {
        value: persistencePending,
        enumerable: false
    });
    return response;
}

async function buildManagementMutationResult(targetVersion, result) {
    const persisted = await flushPendingChanges({ targetVersion });
    return attachPersistenceStatus(result, !persisted);
}

/**
 * 标记数据已修改
 */
function markDirty() {
    mutationVersion += 1;
    if (!isDirty) dirtySince = Date.now();
    isDirty = true;
    schedulePersistence({ resetDebounce: true });
    return mutationVersion;
}

/**
 * 生成随机 API Key（确保不重复）
 */
function generateApiKey() {
    ensureLoaded();
    let apiKey;
    let attempts = 0;
    const maxAttempts = 10;
    
    do {
        apiKey = `${KEY_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
        attempts++;
        if (attempts >= maxAttempts) {
            throw new Error('Failed to generate unique API key after multiple attempts');
        }
    } while (keyStore.keys[apiKey]);
    
    return apiKey;
}

/**
 * 检查并重置过期的每日计数
 */
function checkAndResetDailyCount(keyData) {
    const today = getTodayDateString();
    if (keyData.lastResetDate !== today) {
        keyData.todayUsage = 0;
        keyData.todayPromptTokens = 0;
        keyData.todayCompletionTokens = 0;
        keyData.todayReasoningTokens = 0;
        keyData.todayTotalTokens = 0;
        keyData.todayCachedTokens = 0;
        keyData.lastResetDate = today;
    }
    return keyData;
}

/**
 * 创建新的 API Key
 * @param {string} name - Key 名称
 * @param {number} [dailyLimit] - 每日限额，不传则使用配置的默认值
 */
export async function createKey(name = '', dailyLimit = null) {
    ensureLoaded();
    const config = getConfig();
    const actualDailyLimit = dailyLimit ?? config.defaultDailyLimit ?? DEFAULT_CONFIG.defaultDailyLimit;
    
    const apiKey = generateApiKey();
    const now = new Date().toISOString();
    const today = getTodayDateString();

    const keyData = {
        id: apiKey,
        name: name || `Key-${Object.keys(keyStore.keys).length + 1}`,
        createdAt: now,
        dailyLimit: actualDailyLimit,
        todayUsage: 0,
        totalUsage: 0,
        todayPromptTokens: 0,
        todayCompletionTokens: 0,
        todayReasoningTokens: 0,
        todayTotalTokens: 0,
        todayCachedTokens: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalReasoningTokens: 0,
        totalTokens: 0,
        totalCachedTokens: 0,
        totalModels: {},
        lastResetDate: today,
        lastUsedAt: null,
        enabled: true,
        routingMode: 'pool',
        primaryGroupId: null,
        fixedCredential: null,
        manualLock: false,
        usageHistory: {}
    };

    keyStore.keys[apiKey] = keyData;
    const targetVersion = markDirty();
    const result = await buildManagementMutationResult(targetVersion, keyData);

    logger.info(`[API Potluck] Created key: ${apiKey.substring(0, 12)}...`);
    return result;
}

/**
 * 获取所有 Key 列表
 */
export async function listKeys(options = {}) {
    ensureLoaded();
    const keys = [];
    for (const [keyId, keyData] of Object.entries(keyStore.keys)) {
        const updated = enrichKeyUsage(checkAndResetDailyCount({ ...keyData }), options);
        const rates = rateManager.getStats(`key:${keyId}`);
        keys.push({
            ...updated,
            qps: rates.qps,
            tps: rates.tps,
            rpm: rates.rpm,
            maxQps: Math.max(updated.maxQps || 0, rates.maxQps),
            maxTps: Math.max(updated.maxTps || 0, rates.maxTps),
            maxRpm: Math.max(updated.maxRpm || 0, rates.maxRpm),
            maskedKey: `${keyId.substring(0, 12)}...${keyId.substring(keyId.length - 4)}`
        });
    }
    return keys;
}

/**
 * 获取单个 Key 详情
 */
export async function getKey(keyId, options = {}) {
    ensureLoaded();
    const keyData = keyStore.keys[keyId];
    if (!keyData) return null;
    const updated = enrichKeyUsage(checkAndResetDailyCount({ ...keyData }), options);
    const rates = rateManager.getStats(`key:${keyId}`);
    return {
        ...updated,
        qps: rates.qps,
        tps: rates.tps,
        rpm: rates.rpm,
        maxQps: Math.max(updated.maxQps || 0, rates.maxQps),
        maxTps: Math.max(updated.maxTps || 0, rates.maxTps),
        maxRpm: Math.max(updated.maxRpm || 0, rates.maxRpm)
    };
}

/**
 * 获取凭据组管理服务使用的完整 Key 目录。
 * 该接口只供服务端内部使用；返回管理响应前必须脱敏 ID。
 */
export function getCredentialRoutingKeyCatalog() {
    ensureLoaded();
    return Object.entries(keyStore.keys).map(([keyId, keyData]) => ({
        id: keyId,
        keyId,
        name: keyData.name || '',
        enabled: keyData.enabled !== false,
        routingMode: keyData.routingMode,
        primaryGroupId: keyData.primaryGroupId || null,
        fixedCredential: keyData.fixedCredential ? { ...keyData.fixedCredential } : null,
        manualLock: keyData.manualLock === true,
        usageHistory: cloneCredentialRoutingUsageHistory(keyData.usageHistory || {})
    }));
}

/**
 * 删除 Key
 */
export async function deleteKey(keyId) {
    ensureLoaded();
    if (!keyStore.keys[keyId]) return null;
    delete keyStore.keys[keyId];
    dirtyUsageKeys.add(keyId);
    
    // 清理速率追踪器，防止内存泄漏
    rateManager.remove(`key:${keyId}`);

    const targetVersion = markDirty();
    const result = await buildManagementMutationResult(targetVersion, {
        deleted: true,
        keyId
    });
    logger.info(`[API Potluck] Deleted key: ${keyId.substring(0, 12)}...`);
    return result;
}

/**
 * 更新 Key 的每日限额
 */
export async function updateKeyLimit(keyId, newLimit) {
    ensureLoaded();
    if (!keyStore.keys[keyId]) return null;
    keyStore.keys[keyId].dailyLimit = newLimit;
    const targetVersion = markDirty();
    return buildManagementMutationResult(targetVersion, keyStore.keys[keyId]);
}

/**
 * 重置 Key 的当天调用次数
 */
export async function resetKeyUsage(keyId) {
    ensureLoaded();
    if (!keyStore.keys[keyId]) return null;
    keyStore.keys[keyId].todayUsage = 0;
    keyStore.keys[keyId].todayPromptTokens = 0;
    keyStore.keys[keyId].todayCompletionTokens = 0;
    keyStore.keys[keyId].todayReasoningTokens = 0;
    keyStore.keys[keyId].todayTotalTokens = 0;
    keyStore.keys[keyId].todayCachedTokens = 0;
    keyStore.keys[keyId].lastResetDate = getTodayDateString();
    if (!keyStore.keys[keyId].usageHistory) keyStore.keys[keyId].usageHistory = {};
    keyStore.keys[keyId].usageHistory[getTodayDateString()] = normalizeUsageHistoryDay();
    dirtyUsageKeys.add(keyId);
    const targetVersion = markDirty();
    return buildManagementMutationResult(targetVersion, keyStore.keys[keyId]);
}

/**
 * 重置单个 Key 的 Token 统计（保留调用次数）
 */
export async function resetKeyTokenStats(keyId) {
    ensureLoaded();
    const keyData = keyStore.keys[keyId];
    if (!keyData) return null;

    keyData.todayPromptTokens = 0;
    keyData.todayCompletionTokens = 0;
    keyData.todayReasoningTokens = 0;
    keyData.todayTotalTokens = 0;
    keyData.todayCachedTokens = 0;
    keyData.totalPromptTokens = 0;
    keyData.totalCompletionTokens = 0;
    keyData.totalReasoningTokens = 0;
    keyData.totalTokens = 0;
    keyData.totalCachedTokens = 0;
    keyData.totalModels = {};
    resetUsageHistoryTokens(keyData.usageHistory);
    dirtyUsageKeys.add(keyId);

    // 重置该 Key 的速率追踪器
    rateManager.remove(`key:${keyId}`);

    const targetVersion = markDirty();
    const result = await buildManagementMutationResult(targetVersion, keyData);
    logger.info(`[API Potluck] Reset token stats for key: ${keyId.substring(0, 12)}...`);
    return result;
}

/**
 * 重置所有 Key 的 Token 统计（保留调用次数）
 */
export async function resetAllTokenStats() {
    ensureLoaded();
    let updated = 0;

    for (const [keyId, keyData] of Object.entries(keyStore.keys)) {
        keyData.todayPromptTokens = 0;
        keyData.todayCompletionTokens = 0;
        keyData.todayReasoningTokens = 0;
        keyData.todayTotalTokens = 0;
        keyData.todayCachedTokens = 0;
        keyData.totalPromptTokens = 0;
        keyData.totalCompletionTokens = 0;
        keyData.totalReasoningTokens = 0;
        keyData.totalTokens = 0;
        keyData.totalCachedTokens = 0;
        keyData.totalModels = {};
        resetUsageHistoryTokens(keyData.usageHistory);
        dirtyUsageKeys.add(keyId);
        updated++;
    }

    // 重置所有 Key 的速率追踪器
    rateManager.clear();

    const targetVersion = updated > 0 ? markDirty() : null;
    const result = targetVersion === null
        ? attachPersistenceStatus({ total: Object.keys(keyStore.keys).length, updated }, false)
        : await buildManagementMutationResult(targetVersion, {
            total: Object.keys(keyStore.keys).length,
            updated
        });

    logger.info(`[API Potluck] Reset token stats for all keys: ${updated}`);
    return result;
}

/**
 * 切换 Key 的启用/禁用状态
 */
export async function toggleKey(keyId) {
    ensureLoaded();
    if (!keyStore.keys[keyId]) return null;
    keyStore.keys[keyId].enabled = !keyStore.keys[keyId].enabled;
    const targetVersion = markDirty();
    return buildManagementMutationResult(targetVersion, keyStore.keys[keyId]);
}

/**
 * 更新 Key 名称
 */
export async function updateKeyName(keyId, newName) {
    ensureLoaded();
    if (!keyStore.keys[keyId]) return null;
    keyStore.keys[keyId].name = newName;
    const targetVersion = markDirty();
    return buildManagementMutationResult(targetVersion, keyStore.keys[keyId]);
}

/**
 * 更新 Key 的 Codex 凭据路由配置。
 */
export async function updateKeyRouting(keyId, routing = {}) {
    ensureLoaded();
    const keyData = keyStore.keys[keyId];
    if (!keyData) return null;

    const normalizedRouting = normalizeKeyRouting(routing, { strict: true });
    Object.assign(keyData, normalizedRouting);
    const targetVersion = markDirty();
    const result = await buildManagementMutationResult(targetVersion, keyData);
    publishRoutingSync([keyId], 'key-routing-updated');
    return result;
}

/**
 * 事务式批量应用凭据路由。所有 assignment 会在任何写入发生前完成校验，
 * 然后整批只触发一次持久化 mutation。
 */
export async function applyKeyRoutingAssignments(assignments) {
    ensureLoaded();
    if (!Array.isArray(assignments)) {
        throw createInvalidKeyRoutingAssignmentsError('assignments 必须是数组');
    }

    const normalizedAssignments = [];
    const seenKeyIds = new Set();
    for (const assignment of assignments) {
        const keyId = typeof assignment?.keyId === 'string'
            ? assignment.keyId.trim()
            : typeof assignment?.id === 'string'
                ? assignment.id.trim()
                : '';
        if (!keyId || !keyStore.keys[keyId]) {
            throw createInvalidKeyRoutingAssignmentsError('路由分配引用了不存在的 Key', {
                reason: keyId ? 'KEY_NOT_FOUND' : 'KEY_ID_REQUIRED'
            });
        }
        if (seenKeyIds.has(keyId)) {
            throw createInvalidKeyRoutingAssignmentsError('同一个 Key 不能重复分配路由', {
                reason: 'DUPLICATE_KEY_ASSIGNMENT'
            });
        }
        seenKeyIds.add(keyId);

        let routing;
        try {
            routing = normalizeKeyRouting(assignment?.routing || assignment, { strict: true });
        } catch (error) {
            if (error?.code === 'INVALID_KEY_ROUTING') {
                throw createInvalidKeyRoutingAssignmentsError(error.message, {
                    reason: 'INVALID_ROUTING',
                    keyId
                });
            }
            throw error;
        }
        normalizedAssignments.push({ keyId, routing });
    }

    let updated = 0;
    let unchanged = 0;
    let skippedLocked = 0;
    for (const { keyId, routing } of normalizedAssignments) {
        const keyData = keyStore.keys[keyId];
        if (keyData.manualLock === true) {
            skippedLocked += 1;
            continue;
        }
        if (isSameKeyRouting(keyData, routing)) {
            unchanged += 1;
            continue;
        }
        Object.assign(keyData, routing);
        updated += 1;
    }

    const summary = {
        total: normalizedAssignments.length,
        updated,
        unchanged,
        skippedLocked
    };
    if (updated === 0) return attachPersistenceStatus(summary, false);

    const targetVersion = markDirty();
    const result = await buildManagementMutationResult(targetVersion, summary);
    publishRoutingSync(normalizedAssignments.filter(({ keyId }) => keyStore.keys[keyId] && keyStore.keys[keyId].manualLock !== true).map(({ keyId }) => keyId), 'key-routing-assignments-updated');
    return result;
}

// 用于防止同一 Key 下同一请求重复入账，保留短窗口覆盖 stream/fallback 重复 finalize。
const recordedRequests = new Map();
let lastCleanupTime = Date.now();

/**
 * 清理过期的请求记录
 */
function cleanupRecordedRequests() {
    const now = Date.now();
    if (now - lastCleanupTime < 60000) return; // 每分钟清理一次
    
    const cutoff = now - 5 * 60 * 1000;
    for (const [id, entry] of recordedRequests.entries()) {
        const timestamp = typeof entry === 'number' ? entry : entry?.timestamp;
        if (timestamp < cutoff) recordedRequests.delete(id);
    }
    lastCleanupTime = now;
}

function normalizeRecordedUsage(usage = {}) {
    const promptTokens = toNumber(usage.promptTokens);
    const cachedTokens = toNumber(usage.cachedTokens);
    const completionTokens = toNumber(usage.completionTokens);
    const reasoningTokens = toNumber(usage.reasoningTokens);
    const totalTokens = toNumber(usage.totalTokens) || (promptTokens + completionTokens);
    return {
        requestCount: usage.requestCount !== undefined ? toNumber(usage.requestCount) : 1,
        promptTokens,
        cachedTokens,
        completionTokens,
        reasoningTokens,
        totalTokens
    };
}

function maxRecordedUsage(a = {}, b = {}) {
    return {
        requestCount: Math.max(toNumber(a.requestCount), toNumber(b.requestCount)),
        promptTokens: Math.max(toNumber(a.promptTokens), toNumber(b.promptTokens)),
        cachedTokens: Math.max(toNumber(a.cachedTokens), toNumber(b.cachedTokens)),
        completionTokens: Math.max(toNumber(a.completionTokens), toNumber(b.completionTokens)),
        reasoningTokens: Math.max(toNumber(a.reasoningTokens), toNumber(b.reasoningTokens)),
        totalTokens: Math.max(toNumber(a.totalTokens), toNumber(b.totalTokens))
    };
}

function subtractRecordedUsage(next = {}, previous = {}, { includeRequestCount = true } = {}) {
    return {
        requestCount: includeRequestCount ? Math.max(0, toNumber(next.requestCount) - toNumber(previous.requestCount)) : 0,
        promptTokens: Math.max(0, toNumber(next.promptTokens) - toNumber(previous.promptTokens)),
        cachedTokens: Math.max(0, toNumber(next.cachedTokens) - toNumber(previous.cachedTokens)),
        completionTokens: Math.max(0, toNumber(next.completionTokens) - toNumber(previous.completionTokens)),
        reasoningTokens: Math.max(0, toNumber(next.reasoningTokens) - toNumber(previous.reasoningTokens)),
        totalTokens: Math.max(0, toNumber(next.totalTokens) - toNumber(previous.totalTokens))
    };
}

function hasBillableUsage(usage = {}) {
    return toNumber(usage.requestCount) > 0
        || toNumber(usage.promptTokens) > 0
        || toNumber(usage.cachedTokens) > 0
        || toNumber(usage.completionTokens) > 0
        || toNumber(usage.reasoningTokens) > 0
        || toNumber(usage.totalTokens) > 0;
}

/**
 * 增加 API Key 的使用量
 * @param {string} apiKey - API Key ID
 * @param {string} pName - 提供商名称
 * @param {string} mName - 模型名称
 * @param {Object} usage - 用量数据
 * @param {string} [requestId] - 请求 ID，用于防止重复统计速率
 */
export async function incrementUsage(apiKey, pName = 'unknown', mName = 'unknown', usage = {}, requestId = null, context = {}) {
    ensureLoaded();
    const storedKeyData = keyStore.keys[apiKey];
    if (!storedKeyData) return { usageRecordingStatus: 'missing-key', persistencePending: false };
    const runtimeEventId = context.runtimeEventId || null;
    if (runtimeEventId && hasAppliedUsageEvent(runtimeEventId)) {
        return {
            ...storedKeyData,
            usedBonus: false,
            usageRecordingStatus: 'deduplicated-event',
            persistencePending: isDirty
        };
    }
    const today = getTodayDateString();
    const keyData = runtimeEventId
        ? {
            ...storedKeyData,
            usageHistory: {
                ...(storedKeyData.usageHistory || {}),
                ...(storedKeyData.usageHistory?.[today]
                    ? { [today]: structuredClone(storedKeyData.usageHistory[today]) }
                    : {})
            },
            totalModels: structuredClone(storedKeyData.totalModels || {})
        }
        : storedKeyData;
    const previousResetDate = keyData.lastResetDate;
    checkAndResetDailyCount(keyData);
    const dailyCountReset = previousResetDate !== keyData.lastResetDate;

    let usageToApply = usage;
    let shouldRecordRate = true;
    let usageRecordingStatus = 'recorded';
    if (requestId) {
        cleanupRecordedRequests();
        const recordKey = `${apiKey}:${requestId}`;
        const nextUsage = normalizeRecordedUsage(usage);
        const previous = recordedRequests.get(recordKey)?.usage;
        if (previous) {
            const maxUsage = maxRecordedUsage(previous, nextUsage);
            usageToApply = subtractRecordedUsage(maxUsage, previous, { includeRequestCount: false });
            recordedRequests.set(recordKey, { timestamp: Date.now(), usage: maxUsage });
            shouldRecordRate = hasBillableUsage(usageToApply);
            usageRecordingStatus = shouldRecordRate ? 'updated-by-delta' : 'deduplicated';
        } else {
            usageToApply = nextUsage;
            recordedRequests.set(recordKey, { timestamp: Date.now(), usage: nextUsage });
        }
    }

    if (!hasBillableUsage(usageToApply)) {
        if (dailyCountReset) markDirty();
        return {
            ...keyData,
            usedBonus: false,
            usageRecordingStatus,
            persistencePending: isDirty
        };
    }

    // 记录速率统计
    if (shouldRecordRate) {
        rateManager.record(`key:${apiKey}`, usageToApply.totalTokens);
    }

    const rates = rateManager.getGlobalStats();
    const updatePeaks = (target) => {
        target.maxQps = Math.max(target.maxQps || 0, rates.qps);
        target.maxRpm = Math.max(target.maxRpm || 0, rates.rpm);
        target.maxTps = Math.max(target.maxTps || 0, rates.tps);
    };

    // 更新每日和历史统计
    const recordedAt = new Date(context.timestamp || usage.timestamp || new Date()).toISOString();
    const usageRecord = {
        ...usageToApply,
        lastUsedAt: usage.lastUsedAt || recordedAt
    };
    if (!keyData.usageHistory) keyData.usageHistory = {};
    if (!keyData.usageHistory[today]) {
        keyData.usageHistory[today] = normalizeUsageHistoryDay();
    }
    
    const dayHistory = keyData.usageHistory[today];
    addUsage(dayHistory.summary, usageRecord);
    updatePeaks(dayHistory.summary);
    
    if (!dayHistory.providers[pName]) dayHistory.providers[pName] = createUsageBucket();
    addUsage(dayHistory.providers[pName], usageRecord);
    updatePeaks(dayHistory.providers[pName]);
    
    if (!dayHistory.models[mName]) dayHistory.models[mName] = createUsageBucket();
    addUsage(dayHistory.models[mName], usageRecord);
    updatePeaks(dayHistory.models[mName]);
    addProviderModelUsage(dayHistory.providerModels, pName, mName, usageRecord);
    updatePeaks(dayHistory.providerModels[pName][mName]);

    if (!keyData.totalModels) keyData.totalModels = {};
    if (!keyData.totalModels[mName]) keyData.totalModels[mName] = createUsageBucket();
    addUsage(keyData.totalModels[mName], usageRecord);
    updatePeaks(keyData.totalModels[mName]);

    const providerUuid = context.providerUuid || usageRecord.providerUuid || null;
    const providerName = context.providerName || usageRecord.providerName || null;
    const accountIdentity = context.accountIdentity || usageRecord.accountIdentity || null;
    const accountEmail = context.accountEmail || usageRecord.accountEmail || null;
    const accountUsage = ensureAccountUsage(dayHistory.accounts, pName, providerUuid, providerName, accountIdentity, accountEmail);
    if (accountUsage) {
        if (accountEmail && !accountUsage.accountEmail) accountUsage.accountEmail = accountEmail;
        addUsage(accountUsage.summary, usageRecord);
        updatePeaks(accountUsage.summary);
        if (!accountUsage.models[mName]) accountUsage.models[mName] = createUsageBucket();
        addUsage(accountUsage.models[mName], usageRecord);
        updatePeaks(accountUsage.models[mName]);
    }

    const hour = getBeijingHourString(recordedAt);
    const hourUsage = ensureHourUsage(dayHistory, hour);
    addUsage(hourUsage.summary, usageRecord);
    updatePeaks(hourUsage.summary);
    if (!hourUsage.providers[pName]) hourUsage.providers[pName] = createUsageBucket();
    addUsage(hourUsage.providers[pName], usageRecord);
    updatePeaks(hourUsage.providers[pName]);
    if (!hourUsage.models[mName]) hourUsage.models[mName] = createUsageBucket();
    addUsage(hourUsage.models[mName], usageRecord);
    updatePeaks(hourUsage.models[mName]);
    addProviderModelUsage(hourUsage.providerModels, pName, mName, usageRecord);
    updatePeaks(hourUsage.providerModels[pName][mName]);
    const hourAccountUsage = ensureAccountUsage(hourUsage.accounts, pName, providerUuid, providerName, accountIdentity, accountEmail);
    if (hourAccountUsage) {
        if (accountEmail && !hourAccountUsage.accountEmail) hourAccountUsage.accountEmail = accountEmail;
        addUsage(hourAccountUsage.summary, usageRecord);
        updatePeaks(hourAccountUsage.summary);
        if (!hourAccountUsage.models[mName]) hourAccountUsage.models[mName] = createUsageBucket();
        addUsage(hourAccountUsage.models[mName], usageRecord);
        updatePeaks(hourAccountUsage.models[mName]);
    }

    // 更新今日和累计总量 (统一处理默认调用次数)
    const rCount = usageRecord.requestCount !== undefined ? toNumber(usageRecord.requestCount) : 1;
    keyData.todayUsage += rCount;
    keyData.totalUsage += rCount;
    keyData.todayPromptTokens += toNumber(usageRecord.promptTokens);
    keyData.todayCompletionTokens += toNumber(usageRecord.completionTokens);
    keyData.todayReasoningTokens += toNumber(usageRecord.reasoningTokens);
    keyData.todayTotalTokens += toNumber(usageRecord.totalTokens);
    keyData.todayCachedTokens += toNumber(usageRecord.cachedTokens);
    keyData.totalPromptTokens += toNumber(usageRecord.promptTokens);
    keyData.totalCompletionTokens += toNumber(usageRecord.completionTokens);
    keyData.totalReasoningTokens += toNumber(usageRecord.reasoningTokens);
    keyData.totalTokens += toNumber(usageRecord.totalTokens);
    keyData.totalCachedTokens += toNumber(usageRecord.cachedTokens);
    keyData.lastUsedAt = recordedAt;

    // 同时也给 keyData 注入实时峰值（如果需要持久化）
    if (!keyData.maxQps) keyData.maxQps = 0;
    if (!keyData.maxRpm) keyData.maxRpm = 0;
    if (!keyData.maxTps) keyData.maxTps = 0;
    updatePeaks(keyData);

    // 清理该 Key 的过期历史。
    trimUsageHistory(keyData.usageHistory, USAGE_HISTORY_RETENTION_DAYS);
    if (runtimeEventId) {
        const persistedEvent = persistUsageHistoryEvent(
            apiKey,
            {
                usageDate: today,
                day: keyData.usageHistory[today],
                modelName: mName,
                modelUsage: keyData.totalModels?.[mName] || {},
                retentionDays: USAGE_HISTORY_RETENTION_DAYS
            },
            runtimeEventId
        );
        if (persistedEvent.duplicate) {
            return {
                ...storedKeyData,
                usedBonus: false,
                usageRecordingStatus: 'deduplicated-event',
                persistencePending: isDirty
            };
        }
        keyStore.keys[apiKey] = keyData;
    }
    dirtyUsageKeys.add(apiKey);

    markDirty();
    
    return {
        ...keyData,
        usedBonus: false,
        usageRecordingStatus,
        persistencePending: isDirty
    };
}

/**
 * 获取统计信息
 */
export async function getStats(options = {}) {
    ensureLoaded();
    const { conversionModel } = getCostOptions(options);
    const compactHistory = Boolean(options.compactHistory);
    const keys = Object.values(keyStore.keys);
    let enabledKeys = 0, todayTotalUsage = 0, totalUsage = 0;
    let todayPromptTokens = 0, todayCompletionTokens = 0, todayReasoningTokens = 0, todayTotalTokens = 0, todayCachedTokens = 0;
    let totalPromptTokens = 0, totalCompletionTokens = 0, totalReasoningTokens = 0, totalTokens = 0, totalCachedTokens = 0;
    const aggregatedHistory = {};
    const aggregateModels = {};
    const today = getTodayDateString();

    for (const key of keys) {
        const hasCurrentDailyCounters = key.lastResetDate === today;
        if (key.enabled) enabledKeys++;
        todayTotalUsage += hasCurrentDailyCounters ? toNumber(key.todayUsage) : 0;
        totalUsage += key.totalUsage;
        todayPromptTokens += hasCurrentDailyCounters ? toNumber(key.todayPromptTokens) : 0;
        todayCompletionTokens += hasCurrentDailyCounters ? toNumber(key.todayCompletionTokens) : 0;
        todayReasoningTokens += hasCurrentDailyCounters ? toNumber(key.todayReasoningTokens) : 0;
        todayTotalTokens += hasCurrentDailyCounters ? toNumber(key.todayTotalTokens) : 0;
        todayCachedTokens += hasCurrentDailyCounters ? toNumber(key.todayCachedTokens) : 0;
        totalPromptTokens += key.totalPromptTokens || 0;
        totalCompletionTokens += key.totalCompletionTokens || 0;
        totalReasoningTokens += key.totalReasoningTokens || 0;
        totalTokens += key.totalTokens || 0;
        totalCachedTokens += key.totalCachedTokens || 0;
        if (!compactHistory) {
            Object.entries(key.totalModels || collectModelsFromUsageHistory(key.usageHistory || {})).forEach(([model, usage]) => {
                aggregateModels[model] = normalizeUsageBucket(aggregateModels[model]);
                addUsage(aggregateModels[model], usage);
            });
        }

        // 汇总每个 Key 的历史数据
        if (key.usageHistory) {
            Object.entries(key.usageHistory).forEach(([date, history]) => {
                if (!aggregatedHistory[date]) {
                    aggregatedHistory[date] = normalizeUsageHistoryDay();
                }
                addUsage(aggregatedHistory[date].summary, history.summary);
                
                // 汇总提供商
                if (!compactHistory && history.providers) {
                    Object.entries(history.providers).forEach(([p, usage]) => {
                        aggregatedHistory[date].providers[p] = normalizeUsageBucket(aggregatedHistory[date].providers[p]);
                        addUsage(aggregatedHistory[date].providers[p], usage);
                    });
                }
                
                // 汇总模型
                if (!compactHistory && history.models) {
                    Object.entries(history.models).forEach(([m, usage]) => {
                        aggregatedHistory[date].models[m] = normalizeUsageBucket(aggregatedHistory[date].models[m]);
                        addUsage(aggregatedHistory[date].models[m], usage);
                    });
                }

                if (!compactHistory) {
                    const providerModels = normalizeProviderModelUsageMap(history.providerModels);
                    if (Object.keys(providerModels).length > 0) {
                        for (const [provider, models] of Object.entries(providerModels)) {
                            for (const [model, usage] of Object.entries(models)) {
                                addProviderModelUsage(aggregatedHistory[date].providerModels, provider, model, usage);
                            }
                        }
                    } else {
                        addProviderModelsFromAccounts(aggregatedHistory[date].providerModels, history.accounts);
                    }
                }

                // 汇总账号维度，供管理页展示 Codex OAuth 账号 Token 占比。
                if (!compactHistory && !options.compactAccounts && history.accounts) {
                    Object.values(history.accounts).forEach((account) => {
                        addAccountUsage(aggregatedHistory[date].accounts, account);
                    });
                }
            });
        }
    }

    const globalRates = rateManager.getGlobalStats();
    trimUsageHistory(aggregatedHistory, USAGE_HISTORY_RETENTION_DAYS);
    addUsageHistoryRatios(aggregatedHistory);
    if (!compactHistory) {
        addCostToUsageHistory(aggregatedHistory, conversionModel);
    }
    const aggregateUsage = {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        reasoningTokens: totalReasoningTokens,
        totalTokens,
        cachedTokens: totalCachedTokens
    };
    return {
        totalKeys: keys.length,
        enabledKeys,
        disabledKeys: keys.length - enabledKeys,
        todayTotalUsage,
        totalUsage,
        todayPromptTokens,
        todayCompletionTokens,
        todayReasoningTokens,
        todayTotalTokens,
        todayCachedTokens,
        todayCacheHitRatio: todayPromptTokens > 0 ? todayCachedTokens / todayPromptTokens : 0,
        totalPromptTokens,
        totalCompletionTokens,
        totalReasoningTokens,
        totalTokens,
        totalCachedTokens,
        totalCacheHitRatio: totalPromptTokens > 0 ? totalCachedTokens / totalPromptTokens : 0,
        qps: globalRates.qps,
        tps: globalRates.tps,
        rpm: globalRates.rpm,
        maxQps: globalRates.maxQps,
        maxTps: globalRates.maxTps,
        maxRpm: globalRates.maxRpm,
        cost: buildCost(aggregateUsage, compactHistory ? {} : aggregateModels, conversionModel),
        pricing: {
            conversionModels: getConversionModels()
        },
        usageHistory: aggregatedHistory
    };
}

/**
 * 获取按真实账号聚合的今日 / 本周 / 本月使用量。
 * 用量查询页只需要轻量摘要，避免拉取全部 Potluck Key 历史。
 */
export async function getAccountUsageSummary(now = new Date()) {
    const { conversionModel } = getCostOptions();
    const starts = getBeijingPeriodStarts(now);
    const stats = await getStats({ conversionModel });
    const potluckUsageHistory = stats.usageHistory || {};
    const usePotluckHistory = hasAccountUsageInSummaryWindow(potluckUsageHistory, starts);
    const modelUsageHistory = usePotluckHistory ? null : readModelUsageDailyHistory(conversionModel);
    const usageHistory = usePotluckHistory ? potluckUsageHistory : (modelUsageHistory || potluckUsageHistory);
    const source = usePotluckHistory || !modelUsageHistory ? 'potluck/model-usage-stats' : 'model-usage-stats/daily';
    const accounts = new Map();
    const aliasIndex = new Map();
    const ambiguousProviderAliases = findAmbiguousProviderAliases(usageHistory, starts);
    if (ambiguousProviderAliases.size > 0) {
        logger.warn(`[API Potluck] Ignored ${ambiguousProviderAliases.size} ambiguous provider UUID alias(es) while building account usage summary`);
    }

    for (const [dateKey, day] of Object.entries(usageHistory)) {
        const inToday = dateKey === starts.today;
        const inWeek = dateKey >= starts.week;
        const inMonth = dateKey >= starts.month;
        if (!inToday && !inWeek && !inMonth) continue;

        for (const [accountKey, account] of Object.entries(day.accounts || {})) {
            const aliases = getAccountSummaryAliases(accountKey, account, { ambiguousProviderAliases });
            let targetKey = aliases.map(alias => aliasIndex.get(alias)).find(Boolean);
            const preferredKey = getSummaryCanonicalAccountKey(accountKey, account);

            if (!targetKey) {
                targetKey = preferredKey;
            } else {
                const current = accounts.get(targetKey);
                const currentPreferredKey = getSummaryCanonicalAccountKey(targetKey, current);
                const shouldPromoteToIncomingIdentity = account.accountIdentity && !current?.accountIdentity;
                const nextKey = shouldPromoteToIncomingIdentity ? preferredKey : currentPreferredKey;
                if (nextKey && nextKey !== targetKey) {
                    accounts.delete(targetKey);
                    current.accountKey = nextKey;
                    accounts.set(nextKey, current);
                    reassignAccountSummaryAliases(aliasIndex, targetKey, nextKey);
                    targetKey = nextKey;
                }
            }

            const current = accounts.get(targetKey) || createAccountSummaryEntry(targetKey, account);
            current.accountKey = targetKey;
            mergeAccountSummaryMeta(current, account, accountKey);
            if (!accounts.has(targetKey)) {
                accounts.set(targetKey, current);
            }

            if (inToday) addAccountSummaryRange(current, 'today', account);
            if (inWeek) addAccountSummaryRange(current, 'week', account);
            if (inMonth) addAccountSummaryRange(current, 'month', account);

            for (const alias of getAccountSummaryAliases(current.accountKey, current, { ambiguousProviderAliases })) {
                aliasIndex.set(alias, targetKey);
            }
            for (const alias of aliases) {
                aliasIndex.set(alias, targetKey);
            }
        }
    }

    const modelUsageLastUsedIndex = modelUsageHistory ? readModelUsageAccountLastUsedIndex() : new Map();
    const accountList = [...accounts.values()]
        .map(account => {
            const today = cloneUsageBucket(account.today);
            const week = cloneUsageBucket(account.week);
            const month = cloneUsageBucket(account.month);
            return {
                ...account,
                providerUuids: (account.providerUuids || []).filter(uuid => (
                    !ambiguousProviderAliases.has(`provider:${account.provider}:${uuid}`)
                )),
                lastUsedAt: latestTimestamp(
                    latestTimestamp(today.lastUsedAt, week.lastUsedAt),
                    latestTimestamp(month.lastUsedAt, getIndexedAccountLastUsedAt(account, modelUsageLastUsedIndex))
                ),
                today,
                week,
                month
            };
        })
        .sort((a, b) => (
            b.month.totalTokens - a.month.totalTokens ||
            b.week.totalTokens - a.week.totalTokens ||
            b.today.totalTokens - a.today.totalTokens ||
            (a.providerName || a.providerUuid || '').localeCompare(b.providerName || b.providerUuid || '')
        ));

    return {
        source,
        timezone: 'Asia/Shanghai',
        periods: starts,
        coverage: buildAccountHistoryCoverage(usageHistory, starts),
        updatedAt: new Date().toISOString(),
        accounts: accountList
    };
}


/**
 * 批量更新所有 Key 的每日限额
 * @param {number} newLimit - 新s的每日限额
 * @returns {Promise<{total: number, updated: number}>}
 */
export async function applyDailyLimitToAllKeys(newLimit) {
    ensureLoaded();
    const keys = Object.values(keyStore.keys);
    let updated = 0;
    
    for (const keyData of keys) {
        if (keyData.dailyLimit !== newLimit) {
            keyData.dailyLimit = newLimit;
            updated++;
        }
    }
    
    const targetVersion = updated > 0 ? markDirty() : null;
    const result = targetVersion === null
        ? attachPersistenceStatus({ total: keys.length, updated }, false)
        : await buildManagementMutationResult(targetVersion, { total: keys.length, updated });
    
    logger.info(`[API Potluck] Applied daily limit ${newLimit} to ${updated}/${keys.length} keys`);
    return result;
}

/**
 * 获取所有 Key ID 列表
 * @returns {string[]}
 */
export function getAllKeyIds() {
    ensureLoaded();
    return Object.keys(keyStore.keys);
}

export function resolveKeyIdByHash(keyHash) {
    ensureLoaded();
    if (!keyHash) return null;
    const matches = Object.keys(keyStore.keys || {}).filter(keyId => hashSecret(keyId) === keyHash);
    return matches.length === 1 ? matches[0] : null;
}

/**
 * 验证 API Key 是否有效
 * @param {string} apiKey - 待验证的 Key
 * @returns {Promise<{valid: boolean, reason?: string, keyData?: Object}>}
 */
export async function validateKey(apiKey) {
    ensureLoaded();
    if (!apiKey || !apiKey.startsWith(KEY_PREFIX)) {
        return { valid: false, reason: 'invalid_format' };
    }
    const keyData = keyStore.keys[apiKey];
    if (!keyData) {
        return { valid: false, reason: 'not_found' };
    }
    if (!keyData.enabled) {
        return { valid: false, reason: 'disabled' };
    }
    const updated = checkAndResetDailyCount(keyData);
    const validationKeyData = {
        id: updated.id,
        name: updated.name,
        dailyLimit: updated.dailyLimit,
        todayUsage: updated.todayUsage,
        lastResetDate: updated.lastResetDate,
        enabled: updated.enabled,
        routingMode: updated.routingMode,
        primaryGroupId: updated.primaryGroupId,
        fixedCredential: updated.fixedCredential ? { ...updated.fixedCredential } : null,
        manualLock: updated.manualLock === true,
        routingConfigRevision
    };
    if (updated.dailyLimit > 0 && updated.todayUsage >= updated.dailyLimit) {
        return { valid: false, reason: 'quota_exceeded', keyData: validationKeyData };
    }
    return { valid: true, keyData: validationKeyData };
}

export function getLedgerKeyIdentities() {
    ensureLoaded();
    return Object.entries(keyStore.keys).map(([keyId, keyData]) => ({
        keyId,
        hashes: [...new Set([
            hashSecret(keyId),
            ...(Array.isArray(keyData.ledgerKeyHashes) ? keyData.ledgerKeyHashes : [])
        ].filter(Boolean))]
    }));
}

/**
 * 重新生成 API Key（保留原有数据，更换 Key ID）
 * @param {string} oldKeyId - 原 Key ID
 * @returns {Promise<{oldKey: string, newKey: string, keyData: Object}|null>}
 */
export async function regenerateKey(oldKeyId) {
    ensureLoaded();
    const oldKeyData = keyStore.keys[oldKeyId];
    if (!oldKeyData) return null;
    
    // 生成新的唯一 Key
    const newKeyId = generateApiKey();
    
    // 复制数据到新 Key
    const newKeyData = {
        ...oldKeyData,
        id: newKeyId,
        regeneratedAt: new Date().toISOString(),
        regeneratedFrom: oldKeyId.substring(0, 12) + '...',
        ledgerKeyHashes: [...new Set([
            ...(Array.isArray(oldKeyData.ledgerKeyHashes) ? oldKeyData.ledgerKeyHashes : []),
            hashSecret(oldKeyId)
        ].filter(Boolean))]
    };
    
    // 删除旧 Key，添加新 Key
    delete keyStore.keys[oldKeyId];
    keyStore.keys[newKeyId] = newKeyData;
    dirtyUsageKeys.add(oldKeyId);
    dirtyUsageKeys.add(newKeyId);
    
    // 清理旧 Key 的速率追踪器
    rateManager.remove(`key:${oldKeyId}`);

    const targetVersion = markDirty();
    const persistence = await buildManagementMutationResult(targetVersion, {});
    
    return attachPersistenceStatus({
        oldKey: oldKeyId,
        newKey: newKeyId,
        keyData: newKeyData
    }, persistence.persistencePending);
}

// 导出常量
export { KEY_PREFIX };
