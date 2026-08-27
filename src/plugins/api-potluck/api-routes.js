/**
 * API 大锅饭 - 管理 API 路由
 * 提供 Key 管理的 RESTful API
 */

import {
    createKey,
    listKeys,
    getKey,
    deleteKey,
    updateKeyLimit,
    resetKeyUsage,
    resetKeyTokenStats,
    toggleKey,
    updateKeyName,
    updateKeyRouting,
    updateKeyConcurrency,
    regenerateKey,
    getStats,
    getAccountUsageSummary,
    validateKey,
    KEY_PREFIX,
    applyDailyLimitToAllKeys,
    getAllKeyIds,
    getLedgerKeyIdentities,
    resetAllTokenStats,
    getCredentialRoutingKeyCatalog,
    applyKeyRoutingAssignments,
    resolveKeyIdByHash
} from './key-manager.js';
import { getRequestBody } from '../../utils/common.js';
import { extractCodexCredentialIdentity } from '../../utils/codex-utils.js';
import { getBeijingDateKey, listLedgerDates, readLedgerRangeStats, readSqliteRowsForDates, resolveRangeDates } from './ledger-range-stats.js';
import {
    CredentialGroupService,
    calculateCredentialCapacity,
    diagnoseKeyRouting,
    generateCredentialGroupSuggestion,
    summarizeKeyDemand,
    validateCredentialGroupSuggestion
} from '../../services/codex-credential-group-service.js';
import { readFreshUsageCacheSync, getCachedCodexUsageInstance } from '../../utils/codex-plan.js';
import { normalizeCodexRateLimitWindows } from '../../utils/codex-rate-limit.js';
import { hashSecret, sanitizeProviderName } from '../request-audit/audit-event.js';
import { randomUUID } from 'crypto';
import logger from '../../utils/logger.js';
import fs from 'fs';
import path from 'path';

const STATS_CACHE_TTL_MS = 30 * 1000;
const statsCache = new Map();
const overviewCache = new Map();
const CREDENTIAL_GROUP_PREVIEW_TTL_MS = 5 * 60 * 1000;
const credentialGroupPreviews = new Map();

/**
 * 发送 JSON 响应
 */
function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function compactUserCost(cost = {}) {
    return {
        usd: Number(cost.usd || 0),
        actualUsd: Number(cost.actualUsd || 0),
        estimatedUsd: Number(cost.estimatedUsd || 0),
        missingPriceTokens: Number(cost.missingPriceTokens || 0),
        estimatedPriceTokens: Number(cost.estimatedPriceTokens || 0),
        pricingVersion: cost.pricingVersion || null
    };
}

function getRequestCostOptions(req) {
    try {
        const url = new URL(req.url || '', 'http://localhost');
        return {
            conversionModel: url.searchParams.get('conversionModel') || undefined
        };
    } catch {
        return {};
    }
}

function getStatsCacheKey(costOptions = {}) {
    return [
        costOptions.conversionModel || '',
        costOptions.compactHistory ? 'compact-history' : 'full-history',
        costOptions.compactAccounts ? 'compact-accounts' : 'full-accounts',
        costOptions.includeKeySummaries ? 'with-key-summaries' : 'without-key-summaries'
    ].join(':');
}

function clearStatsCache() {
    statsCache.clear();
    overviewCache.clear();
}

const LIST_KEY_FIELDS = [
    'name', 'enabled', 'dailyLimit', 'todayUsage', 'todayPromptTokens', 'todayCompletionTokens',
    'todayReasoningTokens', 'todayTotalTokens', 'todayCachedTokens', 'totalUsage', 'totalPromptTokens',
    'totalCompletionTokens', 'totalReasoningTokens', 'totalTokens', 'totalCachedTokens', 'lastResetDate',
    'lastUsedAt', 'qps', 'tps', 'rpm', 'maxQps', 'maxTps', 'maxRpm', 'routingMode', 'primaryGroupId',
    'manualLock', 'concurrencyLimit', 'queueLimit', 'queueTimeoutMs', 'concurrencyMode', 'maskedKey',
    'weeklyUsage', 'weeklyPromptTokens', 'weeklyCompletionTokens', 'weeklyReasoningTokens',
    'weeklyTotalTokens', 'weeklyCachedTokens', 'todayCacheHitRatio', 'weeklyCacheHitRatio',
    'totalCacheHitRatio', 'cost'
];

function getRequestDetailOptions(req) {
    try {
        const detail = new URL(req.url || '', 'http://localhost').searchParams.get('detail');
        return ['summary', 'history', 'full'].includes(detail) ? detail : 'full';
    } catch {
        return 'full';
    }
}

function resolveManagementKeyId(keyId) {
    return (typeof resolveKeyIdByHash === 'function' ? resolveKeyIdByHash(keyId) : null) || keyId;
}

function shapeStatsByDetail(stats, detail) {
    // Supported public levels: detail=summary, detail=history, detail=full.
    if (detail === 'full') return stats;
    const shaped = { ...stats };
    if (detail === 'summary') {
        shaped.usageHistory = Object.fromEntries(
            Object.entries(stats.usageHistory || {}).map(([date, day]) => [date, { summary: day?.summary || {} }])
        );
    } else if (detail === 'history') {
        shaped.usageHistory = Object.fromEntries(
            Object.entries(stats.usageHistory || {}).map(([date, day]) => [date, {
                summary: day?.summary || {},
                providers: day?.providers || {},
                models: day?.models || {},
                providerModels: day?.providerModels || {}
            }])
        );
    }
    return shaped;
}

function getCachedStats(costOptions = {}) {
    const cacheKey = getStatsCacheKey(costOptions);
    const now = Date.now();
    const entry = statsCache.get(cacheKey);
    if (entry?.value && now - entry.createdAt < STATS_CACHE_TTL_MS) return entry.value;
    if (entry?.promise) return entry.promise;

    const promise = getStats(costOptions)
        .then(stats => {
            statsCache.set(cacheKey, { value: stats, createdAt: Date.now() });
            return stats;
        })
        .catch(error => {
            statsCache.delete(cacheKey);
            throw error;
        });
    statsCache.set(cacheKey, { promise, createdAt: now });
    return promise;
}

function getCachedOverview(costOptions = {}) {
    const cacheKey = getStatsCacheKey({ ...costOptions, compactHistory: true, compactAccounts: true });
    const now = Date.now();
    const entry = overviewCache.get(cacheKey);
    if (entry?.value && now - entry.createdAt < STATS_CACHE_TTL_MS) return entry.value;
    if (entry?.promise) return entry.promise;

    const promise = getCachedStats({
        ...costOptions,
        compactHistory: true,
        compactAccounts: true,
        includeKeySummaries: true
    }).then(stats => {
        const keys = (stats.keySummaries || []).map(key => ({
            ...key,
            maskedKey: `${String(key.id || '').substring(0, 12)}...${String(key.id || '').slice(-4)}`
        }));
        const { keySummaries, ...summaryStats } = stats;
        const overview = { keys: keys.map(compactKeyForList), stats: summaryStats };
        overviewCache.set(cacheKey, { value: overview, createdAt: Date.now() });
        return overview;
    }).catch(error => {
        overviewCache.delete(cacheKey);
        throw error;
    });
    overviewCache.set(cacheKey, { promise, createdAt: now });
    return promise;
}

function compactUsageHistoryForList(usageHistory = {}, maxDays = 7) {
    const compact = { usageHistory: {} };
    const entries = Object.entries(usageHistory || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(-Math.max(0, Number(maxDays) || 0));
    for (const [date, day] of entries) {
        compact.usageHistory[date] = { summary: day?.summary || {} };
        delete compact.usageHistory[date].providers;
        delete compact.usageHistory[date].models;
        delete compact.usageHistory[date].accounts;
        delete compact.usageHistory[date].hours;
    }
    return compact.usageHistory;
}

function compactKeyForList(key) {
    const fixedCredential = key?.fixedCredential?.uuid
        ? {
            providerType: key.fixedCredential.providerType || 'openai-codex-oauth',
            credentialRef: getCredentialRef(
                key.fixedCredential.providerType || 'openai-codex-oauth',
                key.fixedCredential.uuid
            )
        }
        : null;
    const result = { keyRef: hashSecret(key.id), id: hashSecret(key.id), fixedCredential };
    for (const field of LIST_KEY_FIELDS) result[field] = key[field];
    result.usageHistory = compactUsageHistoryForList(key.usageHistory || {}, 7);
    return result;
}

function formatDailyLimitMessage(dailyLimit) {
    return dailyLimit === 0 ? '不限量' : dailyLimit;
}

const PERSISTENCE_PENDING_MESSAGE = '变更已在内存生效，持久化暂未完成，系统将在后台重试；服务重启前请稍后确认。';

function sendManagementMutationResponse(res, {
    result,
    message,
    data = result,
    successStatusCode = 200
}) {
    const persistencePending = Boolean(result?.persistencePending);
    const responseData = data && typeof data === 'object' && !Array.isArray(data)
        ? { ...data }
        : data;
    if (responseData && typeof responseData === 'object') {
        delete responseData.persistencePending;
    }
    sendJson(res, persistencePending ? 202 : successStatusCode, {
        success: true,
        persistencePending,
        message: persistencePending ? `${message} ${PERSISTENCE_PENDING_MESSAGE}` : message,
        data: responseData
    });
}

function compactKeyManagementMutationData(keyData = {}) {
    return {
        id: keyData.id || null,
        name: keyData.name || '',
        enabled: keyData.enabled !== false,
        dailyLimit: Number(keyData.dailyLimit || 0),
        lastResetDate: keyData.lastResetDate || null,
        routingMode: keyData.routingMode || 'pool',
        primaryGroupId: keyData.primaryGroupId || null,
        fixedCredential: keyData.fixedCredential ? { ...keyData.fixedCredential } : null,
        manualLock: keyData.manualLock === true,
        concurrencyLimit: Number(keyData.concurrencyLimit || 0),
        queueLimit: Number(keyData.queueLimit || 0),
        queueTimeoutMs: Number(keyData.queueTimeoutMs || 300000),
        concurrencyMode: keyData.concurrencyMode === 'enforce' ? 'enforce' : 'shadow',
        configSyncEpoch: keyData.configSyncEpoch || null,
        configSyncRevision: keyData.configSyncRevision || null,
        routingConfigRevision: keyData.routingConfigRevision || null
    };
}

function createCredentialGroupApiError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isCodexProviderType(providerType) {
    return providerType === 'openai-codex-oauth'
        || String(providerType || '').startsWith('openai-codex-oauth-');
}

function normalizeRemainingRatio(value) {
    if (value === undefined || value === null || value === '') return null;
    let ratio = Number(value);
    if (!Number.isFinite(ratio)) return null;
    if (ratio > 1 && ratio <= 100) ratio /= 100;
    return Math.max(0, Math.min(1, ratio));
}

function normalizeUsedPercent(value) {
    const percent = Number(value);
    return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
}

function getUsageWindowUsedPercent(window) {
    return normalizeUsedPercent(
        window?.percent
        ?? window?.usedPercent
        ?? window?.used
        ?? window?.used_percent
    );
}

function getCodexQuotaRemainingRatios(usage) {
    if (!usage || typeof usage !== 'object') {
        return { fiveHourRemainingRatio: null, weeklyRemainingRatio: null };
    }

    const itemWindows = (Array.isArray(usage.items) ? usage.items : [])
        .filter(item => item && typeof item === 'object')
        .map(item => ({
            ...item,
            id: item.id || item.sourceWindow || null,
            sourceWindow: item.sourceWindow || item.id || null,
            scope: item.scope || 'general',
            windowKind: item.windowKind || null,
            usedPercent: getUsageWindowUsedPercent(item)
        }));
    const rawWindows = normalizeCodexRateLimitWindows(usage.raw || usage)
        .map(window => ({
            ...window,
            usedPercent: getUsageWindowUsedPercent(window)
        }));
    const windows = [...itemWindows, ...rawWindows]
        .filter(window => window.scope === 'general' && window.usedPercent !== null);

    const shortWindow = windows.find(window => window.windowKind === 'short')
        || windows.find(window => window.id === 'primary_window' || window.sourceWindow === 'primary_window');
    const weeklyWindow = windows.find(window => window.windowKind === 'weekly')
        || windows.find(window => window.id === 'secondary_window' || window.sourceWindow === 'secondary_window');

    return {
        fiveHourRemainingRatio: shortWindow ? 1 - shortWindow.usedPercent / 100 : null,
        weeklyRemainingRatio: weeklyWindow ? 1 - weeklyWindow.usedPercent / 100 : null
    };
}

function normalizeCodexCredential(providerType, provider, usageCache) {
    const config = provider?.config && typeof provider.config === 'object'
        ? provider.config
        : (provider || {});
    const uuid = provider?.uuid || config.uuid || null;
    if (!uuid || !isCodexProviderType(providerType)) return null;

    const cachedInstance = getCachedCodexUsageInstance(providerType, uuid, usageCache);
    const quotaRatios = getCodexQuotaRemainingRatios(cachedInstance?.usage);
    const quotaHealth = config.codexQuotaHealth || cachedInstance?.codexQuotaHealth || null;
    const fiveHourRemainingRatio = normalizeRemainingRatio(
        config.fiveHourRemainingRatio
        ?? config.shortWindowRemainingRatio
        ?? config.quota?.fiveHourRemainingRatio
        ?? config.quota?.shortRemainingRatio
        ?? quotaRatios.fiveHourRemainingRatio
    );
    const weeklyRemainingRatio = normalizeRemainingRatio(
        config.weeklyRemainingRatio
        ?? config.quota?.weeklyRemainingRatio
        ?? quotaRatios.weeklyRemainingRatio
    );

    return {
        providerType,
        uuid: String(uuid),
        customName: config.customName || cachedInstance?.name || '',
        providerWeight: config.providerWeight ?? config.weight,
        isHealthy: config.isHealthy !== false,
        isDisabled: config.isDisabled === true,
        needsRefresh: config.needsRefresh === true,
        scheduledRecoveryTime: config.scheduledRecoveryTime || null,
        available: config.available,
        hasCapacity: config.hasCapacity,
        isAtCapacity: config.isAtCapacity,
        quotaAvailable: config.quotaAvailable === false || quotaHealth?.general?.isHealthy === false
            ? false
            : config.quotaAvailable,
        manualLock: config.credentialGroupManualLock === true || config.manualLock === true,
        fiveHourRemainingRatio,
        weeklyRemainingRatio
    };
}

function readProviderPoolsFallback() {
    const filePath = path.join(process.cwd(), 'configs', 'provider_pools.json');
    try {
        if (!fs.existsSync(filePath)) return {};
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        logger.warn('[API Potluck] Failed to read provider pools for credential groups:', error.message);
        return {};
    }
}

async function loadCodexCredentialCatalog() {
    let providerStatus = null;
    try {
        const { getProviderPoolManager } = await import('../../services/service-manager.js');
        providerStatus = getProviderPoolManager()?.providerStatus || null;
    } catch (error) {
        logger.warn('[API Potluck] Provider pool manager unavailable for credential groups:', error.message);
    }

    const pools = providerStatus && typeof providerStatus === 'object'
        ? providerStatus
        : readProviderPoolsFallback();
    const usageCache = readFreshUsageCacheSync();
    const credentials = [];

    for (const [poolType, providers] of Object.entries(pools || {})) {
        if (!isCodexProviderType(poolType) || !Array.isArray(providers)) continue;
        for (const provider of providers) {
            const providerType = provider?.type || provider?.providerType || poolType;
            const credential = normalizeCodexCredential(providerType, provider, usageCache);
            if (credential) credentials.push(credential);
        }
    }

    return credentials;
}

function getCredentialRef(providerType, uuid) {
    return hashSecret(`${providerType || 'openai-codex-oauth'}:${uuid || ''}`);
}

function maskKeyId(keyId) {
    const value = String(keyId || '');
    if (!value) return null;
    if (value.length <= 12) return `${value.slice(0, 4)}...`;
    return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function isCredentialAvailable(credential) {
    if (!credential) return false;
    if (
        credential.isHealthy === false
        || credential.isDisabled === true
        || credential.needsRefresh === true
        || credential.available === false
        || credential.quotaAvailable === false
        || credential.hasCapacity === false
        || credential.isAtCapacity === true
    ) {
        return false;
    }
    return calculateCredentialCapacity(credential).capacity > 0;
}

function buildCredentialIndexes(credentials) {
    const byUuid = new Map();
    const refsByUuid = new Map();
    for (const credential of credentials || []) {
        byUuid.set(credential.uuid, credential);
        refsByUuid.set(credential.uuid, getCredentialRef(credential.providerType, credential.uuid));
    }
    return { byUuid, refsByUuid };
}

function buildPublicCredential(credential, providerEmailIndex = new Map()) {
    const capacity = calculateCredentialCapacity(credential);
    return {
        credentialRef: getCredentialRef(credential.providerType, credential.uuid),
        providerType: credential.providerType,
        accountEmail: providerEmailIndex.get(`${credential.providerType}:${credential.uuid}`) || '',
        customName: sanitizeProviderName(credential.customName),
        manualLock: credential.manualLock === true,
        isHealthy: credential.isHealthy !== false,
        isDisabled: credential.isDisabled === true,
        needsRefresh: credential.needsRefresh === true,
        available: isCredentialAvailable(credential),
        capacity: capacity.capacity,
        confidence: capacity.confidence,
        fiveHourRemainingRatio: capacity.fiveHourRemainingRatio,
        weeklyRemainingRatio: capacity.weeklyRemainingRatio
    };
}

function buildPublicGroup(group, credentials, overrides = {}) {
    const { byUuid, refsByUuid } = buildCredentialIndexes(credentials);
    const credentialUuids = Array.isArray(group?.credentialUuids) ? group.credentialUuids : [];
    let capacity = 0;
    let confidence = 'high';
    for (const uuid of credentialUuids) {
        const credential = byUuid.get(uuid);
        const details = calculateCredentialCapacity(credential || {});
        capacity += details.capacity;
        if (!credential || details.confidence !== 'high') confidence = 'low';
    }
    const publicCapacity = Number.isFinite(Number(overrides.capacity ?? group?.capacity))
        ? Number(overrides.capacity ?? group.capacity)
        : capacity;
    const predictedDemand = Number(overrides.predictedDemand ?? group?.predictedDemand ?? 0) || 0;
    const demandShare = Number(overrides.demandShare ?? group?.demandShare ?? 0) || 0;
    const capacityShare = Number(overrides.capacityShare ?? group?.capacityShare ?? 0) || 0;
    const loadIndex = Number(overrides.loadIndex ?? group?.loadIndex ?? 0) || 0;

    return {
        id: String(group?.id || ''),
        name: String(group?.name || ''),
        manualLock: group?.manualLock === true,
        credentialCount: credentialUuids.length,
        credentialRefs: credentialUuids.map(uuid => (
            refsByUuid.get(uuid) || hashSecret(`missing-codex-credential:${uuid}`)
        )),
        capacity: publicCapacity,
        confidence: overrides.confidence || group?.confidence || confidence,
        predictedDemand,
        predictedDemandUsd: Number(overrides.predictedDemandUsd ?? group?.predictedDemandUsd ?? predictedDemand) || 0,
        demandShare,
        capacityShare,
        loadIndex,
        predictedUtilization: Number.isFinite(Number(overrides.predictedUtilization ?? group?.predictedUtilization))
            ? Number(overrides.predictedUtilization ?? group.predictedUtilization)
            : predictedDemand / (publicCapacity > 0 ? publicCapacity : 0.5)
    };
}

function buildPublicKeyAssignment(key, assignment, credentials, options = {}) {
    const keyId = key?.keyId || key?.id || assignment?.keyId || '';
    const requestedRoutingMode = assignment?.routingMode || key?.routingMode;
    const routingMode = requestedRoutingMode === 'fixed'
        ? 'fixed'
        : requestedRoutingMode === 'auto' && (assignment?.primaryGroupId || key?.primaryGroupId)
            ? 'auto'
            : 'pool';
    const fixedCredential = routingMode === 'fixed'
        ? (assignment?.fixedCredential || key?.fixedCredential || null)
        : null;
    const demand = options.demand || assignment?.demand || summarizeKeyDemand(key || {}, {
        now: options.now || new Date(),
        days: 7,
        timeZone: 'Asia/Shanghai'
    });

    return {
        keyRef: hashSecret(keyId),
        maskedKey: maskKeyId(keyId),
        name: sanitizeProviderName(key?.name) || '未命名 Key',
        enabled: key?.enabled !== false,
        routingMode,
        primaryGroupId: routingMode === 'auto'
            ? (assignment?.primaryGroupId || key?.primaryGroupId || null)
            : null,
        fixedCredential: fixedCredential?.uuid
            ? {
                providerType: fixedCredential.providerType || 'openai-codex-oauth',
                credentialRef: getCredentialRef(
                    fixedCredential.providerType || 'openai-codex-oauth',
                    fixedCredential.uuid
                )
            }
            : null,
        manualLock: assignment?.manualLock === true || key?.manualLock === true,
        demand,
        highConsumption: assignment?.highConsumption === true,
        spilloverPolicy: routingMode === 'auto'
            ? 'cross-group-when-primary-unavailable'
            : routingMode === 'pool'
                ? 'weighted-whole-pool'
                : 'disabled'
    };
}

function buildPublicCredentialGroupView(currentConfig, credentials, keys, now = new Date()) {
    const providerEmailIndex = loadProviderEmailIndex();
    const assignmentByKeyId = new Map(
        (currentConfig?.keyAssignments || []).map(assignment => [String(assignment.keyId || ''), assignment])
    );
    const publicKeys = (keys || []).map(key => {
        const keyId = String(key?.keyId || key?.id || '');
        return buildPublicKeyAssignment(key, assignmentByKeyId.get(keyId), credentials, { now });
    });
    const demandMetric = publicKeys.some(key => Number(key.demand?.usd) > 0)
        ? 'usd'
        : publicKeys.some(key => Number(key.demand?.totalTokens) > 0)
            ? 'totalTokens'
            : publicKeys.some(key => Number(key.demand?.requestCount) > 0)
                ? 'requestCount'
                : 'newKey';
    const getDemandUnits = demand => {
        if (demand?.isNew) return 1;
        if (demandMetric === 'usd') return Number(demand?.usd) || 0;
        if (demandMetric === 'totalTokens') return Number(demand?.totalTokens) || 0;
        if (demandMetric === 'requestCount') return Number(demand?.requestCount) || 0;
        return 0;
    };
    const keyDemandByGroup = new Map();
    for (const key of publicKeys) {
        if (key.routingMode !== 'auto' || !key.primaryGroupId) continue;
        const demandUnits = getDemandUnits(key.demand);
        keyDemandByGroup.set(key.primaryGroupId, (keyDemandByGroup.get(key.primaryGroupId) || 0) + demandUnits);
    }

    const { byUuid } = buildCredentialIndexes(credentials);
    const totalDemand = [...keyDemandByGroup.values()].reduce((sum, value) => sum + value, 0);
    const totalCapacity = (currentConfig?.groups || []).reduce((sum, group) => {
        return sum + (group.credentialUuids || []).reduce((groupSum, uuid) => {
            return groupSum + calculateCredentialCapacity(byUuid.get(uuid) || {}).capacity;
        }, 0);
    }, 0);
    const groups = (currentConfig?.groups || []).map(group => {
        let capacity = 0;
        let confidence = 'high';
        for (const uuid of group.credentialUuids || []) {
            const credential = byUuid.get(uuid);
            const details = calculateCredentialCapacity(credential || {});
            capacity += details.capacity;
            if (!credential || details.confidence !== 'high') confidence = 'low';
        }
        const predictedDemand = keyDemandByGroup.get(group.id) || 0;
        const demandShare = totalDemand > 0 ? predictedDemand / totalDemand : 0;
        const capacityShare = totalCapacity > 0 ? capacity / totalCapacity : 0;
        return buildPublicGroup(group, credentials, {
            capacity,
            confidence,
            predictedDemand,
            predictedDemandUsd: demandMetric === 'usd' ? predictedDemand : 0,
            demandShare,
            capacityShare,
            loadIndex: capacityShare > 0 ? demandShare / capacityShare : 0,
            predictedUtilization: predictedDemand / (capacity > 0 ? capacity : 0.5)
        });
    });

    return {
        revision: Number(currentConfig?.revision || 0),
        action: currentConfig?.action || null,
        generatedAt: currentConfig?.generatedAt || null,
        timeZone: currentConfig?.timeZone || 'Asia/Shanghai',
        historyDays: Number(currentConfig?.historyDays || 7),
        demandMetric,
        demandModelFilter: currentConfig?.demandModelFilter || 'gpt-*',
        demandModelFilterCaseSensitive: currentConfig?.demandModelFilterCaseSensitive === true,
        groups,
        credentials: (credentials || []).map(credential => buildPublicCredential(credential, providerEmailIndex)),
        keys: publicKeys,
        policy: {
            fixed: 'strict-no-fallback',
            auto: 'primary-group-with-cross-group-spillover'
        }
    };
}

function buildPublicSuggestion(suggestion, credentials, keys) {
    const keyById = new Map((keys || []).map(key => [String(key?.keyId || key?.id || ''), key]));
    return {
        applicable: suggestion?.applicable === true,
        reason: suggestion?.reason || null,
        generatedAt: suggestion?.generatedAt || null,
        timeZone: suggestion?.timeZone || 'Asia/Shanghai',
        historyDays: Number(suggestion?.historyDays || 7),
        demandMetric: suggestion?.demandMetric || 'newKey',
        demandModelFilter: suggestion?.demandModelFilter || 'gpt-*',
        demandModelFilterCaseSensitive: suggestion?.demandModelFilterCaseSensitive === true,
        groupCount: Number(suggestion?.groupCount || 0),
        healthyCredentialCount: Number(suggestion?.healthyCredentialCount || 0),
        groups: (suggestion?.groups || []).map(group => buildPublicGroup(group, credentials)),
        keyAssignments: (suggestion?.keyAssignments || []).map(assignment => (
            buildPublicKeyAssignment(keyById.get(String(assignment.keyId || '')), assignment, credentials, {
                demand: assignment.demand
            })
        ))
    };
}

function pruneExpiredCredentialGroupPreviews(now = Date.now()) {
    for (const [previewId, preview] of credentialGroupPreviews.entries()) {
        if (preview.expiresAtMs <= now) credentialGroupPreviews.delete(previewId);
    }
}

function getCredentialGroupPreview(previewId) {
    if (!previewId || !credentialGroupPreviews.has(previewId)) {
        throw createCredentialGroupApiError('PREVIEW_NOT_FOUND', '未找到凭据组预览，请重新计算');
    }
    const preview = credentialGroupPreviews.get(previewId);
    if (preview.expiresAtMs <= Date.now()) {
        credentialGroupPreviews.delete(previewId);
        throw createCredentialGroupApiError('PREVIEW_EXPIRED', '凭据组预览已过期，请重新计算');
    }
    return preview;
}

function sanitizeRoutingSyncResult(sync = {}) {
    return {
        total: Number(sync.total || 0),
        updated: Number(sync.updated || 0),
        unchanged: Number(sync.unchanged || 0),
        skippedLocked: Number(sync.skippedLocked || 0)
    };
}

async function loadCredentialGroupContext() {
    const service = new CredentialGroupService();
    const [credentials, keys, currentConfig] = await Promise.all([
        loadCodexCredentialCatalog(),
        Promise.resolve(getCredentialRoutingKeyCatalog()),
        service.getCurrentConfig()
    ]);
    return {
        service,
        credentials: Array.isArray(credentials) ? credentials : [],
        keys: Array.isArray(keys) ? keys : [],
        currentConfig: currentConfig || { revision: 0, groups: [], keyAssignments: [] }
    };
}

function buildRevisionMutationData(entry, sync, extra = {}) {
    return {
        revision: Number(entry?.revision || 0),
        action: entry?.action || 'apply',
        createdAt: entry?.createdAt || null,
        previousRevision: entry?.previousRevision || null,
        sourceRevision: entry?.sourceRevision || null,
        sync: sanitizeRoutingSyncResult(sync),
        ...extra
    };
}

function getCredentialGroupErrorStatus(error) {
    switch (error?.code) {
        case 'PREVIEW_NOT_FOUND':
            return 404;
        case 'PREVIEW_EXPIRED':
            return 410;
        case 'CREDENTIAL_GROUP_REVISION_CONFLICT':
        case 'NO_CREDENTIAL_GROUP_REVISION_TO_ROLLBACK':
            return 409;
        case 'CREDENTIAL_GROUP_SUGGESTION_NOT_APPLICABLE':
        case 'INVALID_CREDENTIAL_GROUP_CONFIG':
        case 'INVALID_KEY_ROUTING_ASSIGNMENTS':
            return 400;
        case 'ROUTE_MISMATCH':
            return 503;
        case 'PROVIDER_COOLDOWN':
            return 429;
        case 'MODEL_NOT_SUPPORTED':
            return 404;
        default:
            return null;
    }
}

function readProviderCredentialEmail(provider) {
    const credPath = provider?.CODEX_OAUTH_CREDS_FILE_PATH;
    if (!credPath) return '';
    const resolvedPath = path.isAbsolute(credPath) ? credPath : path.join(process.cwd(), credPath);
    if (!fs.existsSync(resolvedPath)) return '';
    try {
        const data = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
        return extractCodexCredentialIdentity(data).codexEmail || '';
    } catch {
        return '';
    }
}

function loadProviderEmailIndex() {
    const index = new Map();

    try {
        const filePath = path.join(process.cwd(), 'configs', 'provider_pools.json');
        if (fs.existsSync(filePath)) {
            const providerPools = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            for (const [providerType, providers] of Object.entries(providerPools || {})) {
                if (!Array.isArray(providers)) continue;
                for (const provider of providers) {
                    if (!provider?.uuid) continue;
                    const email = provider.codexEmail || readProviderCredentialEmail(provider);
                    if (!email) continue;
                    index.set(`${providerType}:${provider.uuid}`, email);
                }
            }
        }
    } catch (error) {
        logger.warn('[API Potluck] Failed to load provider pool email index:', error.message);
    }

    try {
        const cachePath = path.join(process.cwd(), 'configs', 'usage-cache.json');
        if (!fs.existsSync(cachePath)) return index;
        const usageCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        for (const [providerType, providerUsage] of Object.entries(usageCache?.providers || {})) {
            const instances = Array.isArray(providerUsage?.instances) ? providerUsage.instances : [];
            for (const instance of instances) {
                const email = instance?.usage?.user?.email || instance?.usage?.user?.label || instance?.codexEmail;
                if (!instance?.uuid || !email) continue;
                index.set(`${providerType}:${instance.uuid}`, email);
            }
        }
    } catch (error) {
        logger.warn('[API Potluck] Failed to load usage cache email index:', error.message);
    }

    return index;
}

function enrichAccountWithEmail(account, providerEmailIndex) {
    if (!account || account.accountEmail) return account;
    const provider = account.provider || null;
    const candidates = Array.isArray(account.providerUuids) && account.providerUuids.length > 0
        ? account.providerUuids
        : [account.providerUuid].filter(Boolean);
    for (const uuid of candidates) {
        const email = providerEmailIndex.get(`${provider}:${uuid}`);
        if (email) {
            account.accountEmail = email;
            break;
        }
    }
    return account;
}

function enrichPotluckStatsAccountEmails(stats) {
    const providerEmailIndex = loadProviderEmailIndex();
    if (providerEmailIndex.size === 0) return stats;

    for (const day of Object.values(stats?.usageHistory || {})) {
        for (const account of Object.values(day?.accounts || {})) {
            enrichAccountWithEmail(account, providerEmailIndex);
        }
        for (const hour of Object.values(day?.hours || {})) {
            for (const account of Object.values(hour?.accounts || {})) {
                enrichAccountWithEmail(account, providerEmailIndex);
            }
        }
    }
    return stats;
}

function buildLedgerKeyHashLookup(targetKeyId = null) {
    const lookup = new Map();
    for (const identity of getLedgerKeyIdentities()) {
        if (targetKeyId && identity.keyId !== targetKeyId) continue;
        for (const hash of identity.hashes || []) lookup.set(hash, identity.keyId);
    }
    return lookup;
}

async function loadLedgerRangeStatsForRange(range, conversionModel, options = {}) {
    const ledgerDailyDir = path.join(process.cwd(), 'configs', 'permanent-usage-ledger', 'daily');
    const dates = resolveRangeDates(range, {
        ledgerDailyDir,
        from: options.from,
        to: options.to
    });
    const includeKeySummaries = Boolean(options.includeKeySummaries || options.targetKeyId);
    const keyHashToId = includeKeySummaries ? buildLedgerKeyHashLookup(options.targetKeyId) : null;
    let extraRows = [];
    try {
        const metadataPath = path.join(process.cwd(), 'configs', 'api-potluck-keys.json');
        const sqlitePath = process.env.USAGE_EVENT_DB_PATH
            || path.join(process.cwd(), 'configs', 'usage-events', 'usage-events.sqlite');
        const store = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const ledgerDateSet = new Set(listLedgerDates(ledgerDailyDir));
        const today = getBeijingDateKey();
        const missingCandidates = dates.filter(date => date === today || !ledgerDateSet.has(date));
        extraRows = readSqliteRowsForDates(sqlitePath, missingCandidates, store);
    } catch {
        extraRows = [];
    }
    const stats = await readLedgerRangeStats({
        ledgerDailyDir,
        dates,
        conversionModel,
        keyHashToId,
        includeKeySummaries,
        includeKeyModels: Boolean(options.targetKeyId),
        keyDailyLimit: options.targetKeyId ? Number.POSITIVE_INFINITY : 35,
        extraRows
    });
    const ledgerDates = listLedgerDates(ledgerDailyDir);
    const today = getBeijingDateKey();
    return {
        range,
        from: dates[0] || today,
        to: dates[dates.length - 1] || today,
        bounds: {
            from: ledgerDates[0] || today,
            to: today
        },
        dates,
        source: 'ledger',
        ...stats
    };
}

function readReconciliationLatest() {
    try {
        const filePath = path.join(process.cwd(), 'configs', 'permanent-usage-ledger', 'reconciliation', 'latest.json');
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        logger.warn('[API Potluck] Failed to read reconciliation latest:', error.message);
        return null;
    }
}

function enrichAccountUsageSummaryEmails(summary) {
    const providerEmailIndex = loadProviderEmailIndex();
    if (providerEmailIndex.size === 0) return summary;
    for (const account of summary?.accounts || []) {
        enrichAccountWithEmail(account, providerEmailIndex);
    }
    return summary;
}

/**
 * 验证管理员 Token
 * @param {http.IncomingMessage} req
 * @returns {Promise<boolean>}
 */
async function checkAdminAuth(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return false;
    }
    
    // 动态导入 ui-manager 中的 token 验证逻辑
    try {
        const { existsSync, readFileSync } = await import('fs');
        const { promises: fs } = await import('fs');
        const path = await import('path');
        
        const TOKEN_STORE_FILE = path.join(process.cwd(), 'configs', 'token-store.json');
        
        if (!existsSync(TOKEN_STORE_FILE)) {
            return false;
        }
        
        const content = readFileSync(TOKEN_STORE_FILE, 'utf8');
        const tokenStore = JSON.parse(content);
        const token = authHeader.substring(7);
        const tokenInfo = tokenStore.tokens[token];
        
        if (!tokenInfo) {
            return false;
        }
        
        // 检查是否过期
        if (Date.now() > tokenInfo.expiryTime) {
            return false;
        }
        
        return true;
    } catch (error) {
        logger.error('[API Potluck] Auth check error:', error.message);
        return false;
    }
}

/**
 * 处理 Potluck 管理 API 请求
 * @param {string} method - HTTP 方法
 * @param {string} path - 请求路径
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @param {http.ServerResponse} res - HTTP 响应对象
 * @returns {Promise<boolean>} - 是否处理了请求
 */
export async function handlePotluckApiRoutes(method, path, req, res) {
    // 只处理 /api/potluck 开头的请求
    if (!path.startsWith('/api/potluck')) {
        return false;
    }
    logger.info('[API Potluck] Handling request:', method, path);
    
    // 验证管理员权限
    const isAuthed = await checkAdminAuth(req);
    if (!isAuthed) {
        sendJson(res, 401, { 
            success: false, 
            error: { message: '未授权：请先登录', code: 'UNAUTHORIZED' } 
        });
        return true;
    }

    try {
        // GET /api/potluck/credential-groups - 获取脱敏后的凭据组、凭据与 Key 关系
        if (method === 'GET' && path === '/api/potluck/credential-groups') {
            const context = await loadCredentialGroupContext();
            const data = buildPublicCredentialGroupView(
                context.currentConfig,
                context.credentials,
                context.keys,
                new Date()
            );
            sendJson(res, 200, { success: true, data });
            return true;
        }

        // GET /api/potluck/credential-groups/diagnostics - 获取路由一致性诊断
        if (method === 'GET' && path === '/api/potluck/credential-groups/diagnostics') {
            const context = await loadCredentialGroupContext();
            const diagnostics = context.keys.map(key => {
                const result = diagnoseKeyRouting({
                    keyData: key,
                    currentConfig: context.currentConfig,
                    credentials: context.credentials
                });
                const fixed = result.fixedCredential || null;
                const nextRecoveryMs = Date.parse(result.nextRecoveryTime || '');
                const status = result.errorCode === 'FIXED_CREDENTIAL_UNAVAILABLE'
                    && Number.isFinite(nextRecoveryMs)
                    && nextRecoveryMs > Date.now()
                    ? 'PROVIDER_COOLDOWN'
                    : (result.errorCode || 'OK');
                return {
                    keyRef: hashSecret(result.keyId || ''),
                    maskedKey: maskKeyId(result.keyId),
                    name: sanitizeProviderName(key.name) || '未命名 Key',
                    routingMode: result.routingMode,
                    routingConfigSource: result.routingConfigSource,
                    assignmentMissing: result.assignmentMissing,
                    primaryGroupId: result.primaryGroupId,
                    selectedGroupId: result.selectedGroupId,
                    status,
                    routeReason: result.routeReason,
                    nextRecoveryTime: result.nextRecoveryTime,
                    fixedCredential: result.fixedCredential
                        ? {
                            providerType: fixed.providerType,
                            configured: fixed.configured,
                            inGroup: fixed.inGroup,
                            candidateAvailable: fixed.candidateAvailable,
                            credentialRef: getCredentialRef(fixed.providerType, fixed.credentialUuid)
                        }
                        : null
                };
            });
            sendJson(res, 200, {
                success: true,
                data: {
                    revision: Number(context.currentConfig.revision || 0),
                    diagnostics
                }
            });
            return true;
        }

        // POST /api/potluck/credential-groups/preview - 生成临时分配预览
        if (method === 'POST' && path === '/api/potluck/credential-groups/preview') {
            const context = await loadCredentialGroupContext();
            const suggestion = generateCredentialGroupSuggestion({
                credentials: context.credentials,
                keys: context.keys,
                currentConfig: context.currentConfig,
                now: new Date(),
                days: 7,
                timeZone: 'Asia/Shanghai'
            });

            if (!suggestion.applicable) {
                const error = createCredentialGroupApiError(
                    'CREDENTIAL_GROUP_SUGGESTION_NOT_APPLICABLE',
                    '当前没有可用的 Codex OAuth 凭据，无法生成可应用的分配建议'
                );
                error.details = { reason: suggestion.reason || 'NO_HEALTHY_CREDENTIALS' };
                throw error;
            }

            const validatedSuggestion = validateCredentialGroupSuggestion(suggestion, {
                credentials: context.credentials,
                keys: context.keys
            });
            pruneExpiredCredentialGroupPreviews();
            const previewId = randomUUID();
            const createdAtMs = Date.now();
            const expiresAtMs = createdAtMs + CREDENTIAL_GROUP_PREVIEW_TTL_MS;
            credentialGroupPreviews.set(previewId, {
                suggestion: validatedSuggestion,
                baseRevision: Number(context.currentConfig.revision || 0),
                createdAtMs,
                expiresAtMs,
                credentials: context.credentials,
                keys: context.keys
            });

            sendJson(res, 200, {
                success: true,
                data: {
                    previewId,
                    baseRevision: Number(context.currentConfig.revision || 0),
                    createdAt: new Date(createdAtMs).toISOString(),
                    expiresAt: new Date(expiresAtMs).toISOString(),
                    suggestion: buildPublicSuggestion(validatedSuggestion, context.credentials, context.keys)
                }
            });
            return true;
        }

        // POST /api/potluck/credential-groups/apply - 应用指定的预览
        if (method === 'POST' && path === '/api/potluck/credential-groups/apply') {
            const body = await getRequestBody(req, { maxBytes: 64 * 1024 });
            const preview = getCredentialGroupPreview(body?.previewId);
            const context = await loadCredentialGroupContext();
            const suggestion = validateCredentialGroupSuggestion(preview.suggestion, {
                credentials: context.credentials,
                keys: context.keys
            });
            const entry = await context.service.apply(suggestion, {
                baseRevision: preview.baseRevision,
                action: 'apply'
            });
            const sync = await applyKeyRoutingAssignments(suggestion.keyAssignments || []);
            credentialGroupPreviews.delete(body.previewId);

            const result = {
                ...entry,
                persistencePending: sync?.persistencePending === true
            };
            sendManagementMutationResponse(res, {
                result,
                message: '凭据组分配已应用',
                data: buildRevisionMutationData(entry, sync)
            });
            return true;
        }

        // GET /api/potluck/credential-groups/revisions - 获取 revision 元数据
        if (method === 'GET' && path === '/api/potluck/credential-groups/revisions') {
            const url = new URL(req.url || '', 'http://localhost');
            const context = await loadCredentialGroupContext();
            const revisions = await context.service.listRevisions({
                limit: url.searchParams.has('limit')
                    ? url.searchParams.get('limit')
                    : undefined
            });
            sendJson(res, 200, {
                success: true,
                data: {
                    currentRevision: Number(context.currentConfig.revision || 0),
                    revisions
                }
            });
            return true;
        }

        // POST /api/potluck/credential-groups/rollback - 创建新的回滚 revision
        if (method === 'POST' && path === '/api/potluck/credential-groups/rollback') {
            const body = await getRequestBody(req, { maxBytes: 64 * 1024 });
            const context = await loadCredentialGroupContext();
            const target = await context.service.getRollbackTarget({ baseRevision: body?.baseRevision });
            const targetSuggestion = validateCredentialGroupSuggestion({
                applicable: true,
                ...target.config
            }, {
                credentials: context.credentials,
                keys: context.keys
            });
            const entry = await context.service.rollback({ baseRevision: body?.baseRevision });
            const sync = await applyKeyRoutingAssignments(targetSuggestion.keyAssignments || []);
            const result = {
                ...entry,
                persistencePending: sync?.persistencePending === true
            };
            sendManagementMutationResponse(res, {
                result,
                message: '凭据组分配已回滚',
                data: buildRevisionMutationData(entry, sync)
            });
            return true;
        }

        // GET /api/potluck/stats?detail=summary|history|full - 获取分层统计信息
        if (method === 'GET' && path === '/api/potluck/stats') {
            const detail = getRequestDetailOptions(req);
            const costOptions = getRequestCostOptions(req);
            const statsOptions = detail === 'summary'
                ? { ...costOptions, compactHistory: true, compactAccounts: true }
                : detail === 'history'
                    ? { ...costOptions, compactAccounts: true }
                    : costOptions;
            const stats = enrichPotluckStatsAccountEmails(shapeStatsByDetail(await getCachedStats(statsOptions), detail));
            sendJson(res, 200, { success: true, data: stats });
            return true;
        }

        // GET /api/potluck/overview - 管理页首屏摘要与 Key 列表的合并读取
        if (method === 'GET' && path === '/api/potluck/overview') {
            const overview = await getCachedOverview(getRequestCostOptions(req));
            sendJson(res, 200, { success: true, data: overview });
            return true;
        }

        // GET /api/potluck/range-stats - 从 ledger 预聚合读取区间统计（管理页分布数据源）
        if (method === 'GET' && path === '/api/potluck/range-stats') {
            const url = new URL(req.url || '', 'http://localhost');
            const range = ['total', '30d', '7d', 'today', 'custom'].includes(url.searchParams.get('range'))
                ? url.searchParams.get('range')
                : '7d';
            const conversionModel = url.searchParams.get('conversionModel') || undefined;
            const data = await loadLedgerRangeStatsForRange(range, conversionModel, {
                from: range === 'custom' ? url.searchParams.get('from') : undefined,
                to: range === 'custom' ? url.searchParams.get('to') : undefined,
                includeKeySummaries: url.searchParams.get('includeKeys') === '1'
            });
            sendJson(res, 200, { success: true, data });
            return true;
        }

        // GET /api/potluck/reconciliation - 获取最近一次每日用量对账结果
        if (method === 'GET' && path === '/api/potluck/reconciliation') {
            const latest = readReconciliationLatest();
            sendJson(res, 200, {
                success: true,
                data: { available: latest !== null, result: latest }
            });
            return true;
        }

        // GET /api/potluck/account-usage-summary - 获取账号维度真实用量摘要
        if (method === 'GET' && path === '/api/potluck/account-usage-summary') {
            const summary = enrichAccountUsageSummaryEmails(await getAccountUsageSummary());
            sendJson(res, 200, { success: true, data: summary });
            return true;
        }

        // POST /api/potluck/stats/reset-tokens - 重置全部 Key 的 Token 统计
        if (method === 'POST' && path === '/api/potluck/stats/reset-tokens') {
            const result = await resetAllTokenStats();
            clearStatsCache();
            sendManagementMutationResponse(res, {
                result,
                message: `已重置 ${result.updated}/${result.total} 个 Key 的 Token 统计`,
                data: result
            });
            return true;
        }

        // GET /api/potluck/keys - 获取所有 Key 列表
        if (method === 'GET' && path === '/api/potluck/keys') {
            const costOptions = getRequestCostOptions(req);
            const overview = await getCachedOverview(costOptions);
            sendJson(res, 200, { success: true, data: overview });
            return true;
        }

        // POST /api/potluck/keys/apply-limit - 批量应用每日限额到所有 Key
        if (method === 'POST' && path === '/api/potluck/keys/apply-limit') {
            const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
            const { dailyLimit } = body;
            
            if (dailyLimit === undefined || typeof dailyLimit !== 'number' || dailyLimit < 0) {
                sendJson(res, 400, { success: false, error: { message: 'dailyLimit 必须是一个非负数，0 表示不限量' } });
                return true;
            }
            
            const result = await applyDailyLimitToAllKeys(dailyLimit);
            sendManagementMutationResponse(res, {
                result,
                message: `已将每日限额 ${formatDailyLimitMessage(dailyLimit)} 应用到 ${result.updated}/${result.total} 个 Key`,
                data: result
            });
            return true;
        }

        // POST /api/potluck/keys - 创建新 Key
        if (method === 'POST' && path === '/api/potluck/keys') {
            const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
            const { name, dailyLimit } = body;
            const keyData = await createKey(name, dailyLimit);
            sendManagementMutationResponse(res, {
                result: keyData,
                message: 'API Key 创建成功',
                data: compactKeyManagementMutationData(keyData),
                successStatusCode: 201
            });
            return true;
        }

        // 处理带 keyId 的路由
        const keyIdMatch = path.match(/^\/api\/potluck\/keys\/([^\/]+)(\/.*)?$/);
        if (keyIdMatch) {
            const keyId = resolveManagementKeyId(decodeURIComponent(keyIdMatch[1]));
            const subPath = keyIdMatch[2] || '';

            if (method === 'GET' && subPath === '/detail') {
                const keyData = await getKey(keyId, getRequestCostOptions(req));
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendJson(res, 200, {
                    success: true,
                    data: {
                        id: hashSecret(keyId),
                        maskedKey: keyData.maskedKey || `${keyId.substring(0, 12)}...${keyId.substring(keyId.length - 4)}`,
                        secret: keyId
                    }
                });
                return true;
            }

            if (method === 'GET' && subPath === '/range-stats') {
                const existingKey = await getKey(keyId, { summaryOnly: true, compactCosts: true });
                if (!existingKey) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                const url = new URL(req.url || '', 'http://localhost');
                const conversionModel = url.searchParams.get('conversionModel') || undefined;
                const data = await loadLedgerRangeStatsForRange('custom', conversionModel, {
                    from: url.searchParams.get('from'),
                    to: url.searchParams.get('to'),
                    targetKeyId: keyId
                });
                sendJson(res, 200, {
                    success: true,
                    data: {
                        ...data,
                        keySummary: data.keySummaries?.[keyId] || null,
                        keySummaries: undefined
                    }
                });
                return true;
            }

            // GET /api/potluck/keys/:keyId - 获取单个 Key 详情
            if (method === 'GET' && !subPath) {
                const keyData = await getKey(keyId, getRequestCostOptions(req));
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendJson(res, 200, { success: true, data: keyData });
                return true;
            }

            // DELETE /api/potluck/keys/:keyId - 删除 Key
            if (method === 'DELETE' && !subPath) {
                const deleted = await deleteKey(keyId);
                if (!deleted) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result: deleted,
                    message: 'Key 删除成功'
                });
                return true;
            }

            // PUT /api/potluck/keys/:keyId/limit - 更新每日限额
            if (method === 'PUT' && subPath === '/limit') {
                const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
                const { dailyLimit } = body;
                
                if (typeof dailyLimit !== 'number' || dailyLimit < 0) {
                    sendJson(res, 400, { 
                        success: false, 
                        error: { message: '无效的每日限额值' } 
                    });
                    return true;
                }

                const keyData = await updateKeyLimit(keyId, dailyLimit);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result: keyData,
                    message: '每日限额更新成功',
                    data: compactKeyManagementMutationData(keyData)
                });
                return true;
            }

            // POST /api/potluck/keys/:keyId/reset - 重置当天调用次数
            if (method === 'POST' && subPath === '/reset') {
                const keyData = await resetKeyUsage(keyId);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result: keyData,
                    message: '使用量重置成功',
                    data: compactKeyManagementMutationData(keyData)
                });
                return true;
            }

            // POST /api/potluck/keys/:keyId/reset-tokens - 重置 Token 统计
            if (method === 'POST' && subPath === '/reset-tokens') {
                const keyData = await resetKeyTokenStats(keyId);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result: keyData,
                    message: 'Token 统计重置成功',
                    data: compactKeyManagementMutationData(keyData)
                });
                return true;
            }

            // POST /api/potluck/keys/:keyId/toggle - 切换启用/禁用状态
            if (method === 'POST' && subPath === '/toggle') {
                const keyData = await toggleKey(keyId);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result: keyData,
                    message: `Key 已成功${keyData.enabled ? '启用' : '禁用'}`,
                    data: compactKeyManagementMutationData(keyData)
                });
                return true;
            }

            // PUT /api/potluck/keys/:keyId/name - 更新 Key 名称
            if (method === 'PUT' && subPath === '/name') {
                const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
                const { name } = body;
                
                if (!name || typeof name !== 'string') {
                    sendJson(res, 400, { 
                        success: false, 
                        error: { message: '无效的名称值' } 
                    });
                    return true;
                }

                const keyData = await updateKeyName(keyId, name);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result: keyData,
                    message: '名称更新成功',
                    data: compactKeyManagementMutationData(keyData)
                });
                return true;
            }

            // PUT /api/potluck/keys/:keyId/routing - 更新 Codex 凭据路由
            if (method === 'PUT' && subPath === '/routing') {
                const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
                let routing = body || {};
                if (routing.routingMode === 'fixed' && routing.fixedCredential?.credentialRef && !routing.fixedCredential?.uuid) {
                    const credentials = await loadCodexCredentialCatalog();
                    const matched = credentials.find(credential => getCredentialRef(
                        credential.providerType,
                        credential.uuid
                    ) === routing.fixedCredential.credentialRef);
                    if (!matched) {
                        sendJson(res, 400, { success: false, error: { message: '未找到指定凭据', code: 'FIXED_CREDENTIAL_NOT_FOUND' } });
                        return true;
                    }
                    routing = {
                        ...routing,
                        fixedCredential: {
                            providerType: matched.providerType,
                            uuid: matched.uuid
                        }
                    };
                }
                const keyData = await updateKeyRouting(keyId, routing);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                const credentialGroupService = new CredentialGroupService();
                await credentialGroupService.updateKeyAssignment(keyId, keyData);
                sendManagementMutationResponse(res, {
                    result: keyData,
                    message: 'Key 路由更新成功',
                    data: compactKeyManagementMutationData(keyData)
                });
                return true;
            }

            if (method === 'PUT' && subPath === '/concurrency') {
                const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
                const keyData = await updateKeyConcurrency(keyId, body || {});
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result: keyData,
                    message: 'Key 并发配置更新成功',
                    data: compactKeyManagementMutationData(keyData)
                });
                return true;
            }

            // POST /api/potluck/keys/:keyId/regenerate - 重新生成 Key
            if (method === 'POST' && subPath === '/regenerate') {
                const result = await regenerateKey(keyId);
                if (!result) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendManagementMutationResponse(res, {
                    result,
                    message: 'Key 重新生成成功',
                    data: {
                        oldKey: result.oldKey,
                        newKey: result.newKey,
                        keyData: compactKeyManagementMutationData(result.keyData)
                    }
                });
                return true;
            }
        }

        // 未匹配的 potluck 路由
        sendJson(res, 404, { success: false, error: { message: '未找到 Potluck API 端点' } });
        return true;

    } catch (error) {
        const credentialGroupStatus = getCredentialGroupErrorStatus(error);
        if (credentialGroupStatus) {
            sendJson(res, credentialGroupStatus, {
                success: false,
                error: {
                    message: error.message,
                    code: error.code,
                    ...(error.details ? { details: error.details } : {})
                }
            });
            return true;
        }
        if (error?.code === 'INVALID_KEY_ROUTING') {
            sendJson(res, 400, {
                success: false,
                error: { message: error.message, code: error.code }
            });
            return true;
        }
        if (error?.code === 'INVALID_DATE_RANGE') {
            sendJson(res, 400, {
                success: false,
                error: { message: error.message, code: error.code }
            });
            return true;
        }
        logger.error('[API Potluck] API error:', error);
        sendJson(res, 500, {
            success: false,
            error: { message: error.message || '内部服务器错误' }
        });
        return true;
    }
}

/**
 * 从请求中提取 Potluck API Key
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @returns {string|null}
 */
function extractApiKeyFromRequest(req) {
    // 1. 检查 Authorization header
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token.startsWith(KEY_PREFIX)) {
            return token;
        }
    }

    // 2. 检查 x-api-key header
    const xApiKey = req.headers['x-api-key'];
    if (xApiKey && xApiKey.startsWith(KEY_PREFIX)) {
        return xApiKey;
    }

    return null;
}

/**
 * 处理用户端 API 请求 - 用户通过自己的 API Key 查询使用量
 * @param {string} method - HTTP 方法
 * @param {string} path - 请求路径
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @param {http.ServerResponse} res - HTTP 响应对象
 * @returns {Promise<boolean>} - 是否处理了请求
 */
export async function handlePotluckUserApiRoutes(method, path, req, res) {
    // 只处理 /api/potluckuser 开头的请求
    if (!path.startsWith('/api/potluckuser')) {
        return false;
    }
    logger.info('[API Potluck User] Handling request:', method, path);

    try {
        // 从请求中提取 API Key
        const apiKey = extractApiKeyFromRequest(req);
        
        if (!apiKey) {
            sendJson(res, 401, {
                success: false,
                error: {
                    message: '需要 API Key。请在 Authorization 标头 (Bearer maki_xxx) 或 x-api-key 标头中提供您的 API Key。',
                    code: 'API_KEY_REQUIRED'
                }
            });
            return true;
        }

        // 验证 API Key
        const validation = await validateKey(apiKey);
        
        if (!validation.valid && validation.reason !== 'quota_exceeded') {
            const errorMessages = {
                'invalid_format': 'API Key 格式无效',
                'not_found': '未找到 API Key',
                'disabled': 'API Key 已禁用'
            };
            
            sendJson(res, 401, {
                success: false,
                error: {
                    message: errorMessages[validation.reason] || '无效的 API Key',
                    code: validation.reason
                }
            });
            return true;
        }

        // GET /api/potluckuser/usage - 获取当前用户的使用量信息
        if (method === 'GET' && path === '/api/potluckuser/usage') {
            const keyData = await getKey(apiKey, { compactUserHistory: true, compactCosts: true });
            
            if (!keyData) {
                sendJson(res, 404, {
                    success: false,
                    error: { message: '未找到 Key', code: 'KEY_NOT_FOUND' }
                });
                return true;
            }

            // 计算使用百分比
            const usagePercent = keyData.dailyLimit > 0
                ? Math.round((keyData.todayUsage / keyData.dailyLimit) * 100)
                : 0;
            const todayDate = getBeijingDateKey(new Date());
            const todayCost = keyData.usageHistory?.[todayDate]?.summary?.cost || {};

            // 返回用户友好的使用量信息（隐藏敏感信息）
            sendJson(res, 200, {
                success: true,
                data: {
                    name: keyData.name,
                    enabled: keyData.enabled,
                    usage: {
                        today: keyData.todayUsage,
                        limit: keyData.dailyLimit,
                        remaining: Math.max(0, keyData.dailyLimit - keyData.todayUsage),
                        percent: usagePercent,
                        resetDate: keyData.lastResetDate,
                        promptTokens: keyData.todayPromptTokens || 0,
                        completionTokens: keyData.todayCompletionTokens || 0,
                        totalTokens: keyData.todayTotalTokens || 0,
                        cachedTokens: keyData.todayCachedTokens || 0,
                        qps: keyData.qps || 0,
                        tps: keyData.tps || 0,
                        rpm: keyData.rpm || 0,
                        maxQps: keyData.maxQps || 0,
                        maxTps: keyData.maxTps || 0,
                        maxRpm: keyData.maxRpm || 0,
                        cost: compactUserCost(todayCost)
                    },
                    total: keyData.totalUsage,
                    cost: compactUserCost(keyData.cost),
                    tokens: {
                        prompt: keyData.totalPromptTokens || 0,
                        completion: keyData.totalCompletionTokens || 0,
                        total: keyData.totalTokens || 0,
                        cached: keyData.totalCachedTokens || 0
                    },
                    lastUsedAt: keyData.lastUsedAt,
                    createdAt: keyData.createdAt,
                    usageHistory: keyData.usageHistory || {},
                    // 显示部分遮蔽的 Key ID

                    maskedKey: `${apiKey.substring(0, 12)}...${apiKey.substring(apiKey.length - 4)}`
                }
            });
            return true;
        }

        // 未匹配的用户端路由
        sendJson(res, 404, {
            success: false,
            error: { message: '未找到用户 API 端点' }
        });
        return true;

    } catch (error) {
        logger.error('[API Potluck] User API error:', error);
        sendJson(res, 500, {
            success: false,
            error: { message: error.message || '内部服务器错误' }
        });
        return true;
    }
}
