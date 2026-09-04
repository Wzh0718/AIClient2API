import { CONFIG } from '../core/config-manager.js';
import logger from '../utils/logger.js';
import { serviceInstances, getServiceAdapter } from '../providers/adapter.js';
import { usageService } from '../services/usage-service.js';
import { readUsageCache, readUsageDisplayCache, writeUsageCache, writeUsageCacheUnlocked, readProviderUsageCache, updateProviderUsageCache } from './usage-cache.js';
import { PROVIDER_MAPPINGS } from '../utils/provider-utils.js';
import { MODEL_PROVIDER, getRequestBody } from '../utils/common.js';
import { withFileLock } from '../utils/file-lock.js';
import { normalizeAntigravityQuotaHealth, mergeCodexResetCreditsWithLastSuccessfulUsage } from './usage-cache.js';
import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import {
    appendQuotaSnapshot,
    estimateCurrentPeriodQuota,
    getWeeklyQuotaPercent,
    getWeeklyQuotaWindow,
    sumAccountTimelineCost
} from '../services/codex-weekly-estimate.js';

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    res.end(JSON.stringify(payload));
}

const supportedProviders = [
    MODEL_PROVIDER.KIRO_API, 
    MODEL_PROVIDER.GEMINI_CLI, 
    MODEL_PROVIDER.ANTIGRAVITY, 
    MODEL_PROVIDER.CODEX_API, 
    MODEL_PROVIDER.GROK_WEB,
    MODEL_PROVIDER.GROK_CLI
];

const USAGE_API_SLOW_PHASE_MS = 200;
const USAGE_API_LARGE_RESPONSE_BYTES = 300 * 1024;
const DEFAULT_USAGE_REFRESH_ACCOUNT_TIMEOUT_MS = 15_000;
const DEFAULT_USAGE_REFRESH_CONCURRENCY_PER_PROVIDER = 2;
const CODEX_WEEKLY_ESTIMATE_FILE = path.join(process.cwd(), 'configs', 'codex-weekly-estimate-snapshots.json');

function normalizePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function withUsageAccountTimeout(promise, timeoutMs, providerType, uuid) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Usage refresh timed out after ${timeoutMs}ms for ${providerType}:${uuid}`));
        }, timeoutMs);
        if (timeoutId.unref) timeoutId.unref();
    });
    return Promise.race([Promise.resolve(promise), timeoutPromise])
        .finally(() => clearTimeout(timeoutId));
}

async function mapWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

async function measureUsagePhase(timings, name, operation) {
    const startedAt = performance.now();
    try {
        return await operation();
    } finally {
        timings[name] = performance.now() - startedAt;
    }
}

function sendUsageResponse(res, payload, timings, requestStartedAt) {
    const stringifyStartedAt = performance.now();
    const body = JSON.stringify(payload);
    timings.stringifyMs = performance.now() - stringifyStartedAt;
    const bytes = Buffer.byteLength(body, 'utf8');
    const processingMs = performance.now() - requestStartedAt;
    const timingSummary = Object.entries(timings)
        .map(([name, value]) => `${name}=${value.toFixed(1)}ms`)
        .join(', ');
    const message = `[Usage API] GET /api/usage ${timingSummary}, processing=${processingMs.toFixed(1)}ms, bytes=${bytes}`;
    if (processingMs >= USAGE_API_SLOW_PHASE_MS || bytes >= USAGE_API_LARGE_RESPONSE_BYTES) {
        logger.warn(message);
    } else {
        logger.debug(message);
    }

    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    res.end(body);
}

function readCodexWeeklyEstimateStore() {
    if (!existsSync(CODEX_WEEKLY_ESTIMATE_FILE)) return { version: 1, accounts: {} };
    try {
        const parsed = JSON.parse(readFileSync(CODEX_WEEKLY_ESTIMATE_FILE, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : { version: 1, accounts: {} };
    } catch (error) {
        logger.warn(`[Usage API] Failed to read Codex weekly estimate snapshots: ${error.message}`);
        return { version: 1, accounts: {} };
    }
}

function writeCodexWeeklyEstimateStore(store) {
    try {
        writeFileSync(CODEX_WEEKLY_ESTIMATE_FILE, JSON.stringify(store, null, 2), 'utf8');
    } catch (error) {
        logger.warn(`[Usage API] Failed to persist Codex weekly estimate snapshots: ${error.message}`);
    }
}

function findAccountSummaryForInstance(accountSummary, instance) {
    const accounts = Array.isArray(accountSummary?.accounts) ? accountSummary.accounts : [];
    const candidates = [instance.codexAccountKey, instance.codexAccountId, instance.uuid].filter(Boolean);
    return accounts.find(account => candidates.some(candidate => (
        account.accountKey === candidate
        || account.providerUuid === candidate
        || account.accountIdentity === candidate
        || (account.providerUuids || []).includes(candidate)
    ))) || null;
}

function enrichCodexWeeklyEstimates(providerData, accountSummary, observedAt = new Date().toISOString()) {
    if (!providerData || providerData.providerType !== MODEL_PROVIDER.CODEX_API) return providerData;
    const store = readCodexWeeklyEstimateStore();
    store.version = 1;
    store.accounts = store.accounts && typeof store.accounts === 'object' ? store.accounts : {};

    for (const instance of providerData.instances || []) {
        if (!instance?.success || !instance.usage) continue;
        const usedPercent = getWeeklyQuotaPercent(instance.usage.items);
        const account = findAccountSummaryForInstance(accountSummary, instance);
        const window = getWeeklyQuotaWindow(instance.usage.items, instance.usage.summary?.resetAt);
        const periodUsage = sumAccountTimelineCost(account?.timeline, window.periodStart, observedAt);
        if (usedPercent === null) continue;

        const key = String(instance.uuid || instance.codexAccountId || instance.codexAccountKey || 'unknown');
        let snapshots = [];
        for (const storedSnapshot of (store.accounts[key] || [])) {
            snapshots = appendQuotaSnapshot(snapshots, {
                ...storedSnapshot,
                resetAt: storedSnapshot.resetAt || window.resetAt
            });
        }
        snapshots = appendQuotaSnapshot(snapshots, {
            observedAt,
            resetAt: window.resetAt,
            usedPercent,
            costUsd: periodUsage.costUsd
        });
        store.accounts[key] = snapshots;
        instance.weeklyQuotaEstimate = estimateCurrentPeriodQuota({
            observedAt,
            periodStart: window.periodStart,
            resetAt: window.resetAt,
            usedPercent,
            periodCostUsd: periodUsage.costUsd,
            granularity: periodUsage.granularity
        });
    }

    writeCodexWeeklyEstimateStore(store);
    return providerData;
}

function isUsageRefreshPending() {
    try {
        return globalThis.getUsageCacheAutoRefreshStatus?.()?.isRunning === true;
    } catch (error) {
        logger.warn('[Usage API] Failed to read background refresh status:', error.message);
        return false;
    }
}


/**
 * 获取所有支持用量查询的提供商的用量信息
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Promise<Object>} 所有提供商的用量信息
 */
export async function getAllProvidersUsage(currentConfig, providerPoolManager) {
    const refreshStartedAt = new Date().toISOString();
    const results = {
        refreshStartedAt,
        timestamp: null,
        providers: {}
    };

    // 并发获取所有提供商的用量数据
    const usagePromises = supportedProviders.map(async (providerType) => {
        try {
            const providerUsage = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager);
            return { providerType, data: providerUsage, success: true };
        } catch (error) {
            return {
                providerType,
                data: {
                    error: error.message,
                    instances: []
                },
                success: false
            };
        }
    });

    // 等待所有并发请求完成
    const usageResults = await Promise.all(usagePromises);

    // 将结果整合到 results.providers 中
    for (const result of usageResults) {
        results.providers[result.providerType] = result.data;
    }

    const codexUsage = results.providers[MODEL_PROVIDER.CODEX_API];
    if (codexUsage?.instances?.some(instance => instance?.success)) {
        try {
            const { getAccountUsageSummary } = await import('../plugins/api-potluck/key-manager.js');
            const accountSummary = await getAccountUsageSummary(new Date(), { includeTimeline: true });
            enrichCodexWeeklyEstimates(codexUsage, accountSummary, results.timestamp || new Date().toISOString());
        } catch (error) {
            logger.warn(`[Usage API] Failed to enrich Codex weekly quota estimates: ${error.message}`);
        }
    }

    // timestamp 表示完整快照生成完成时间，而不是开始采集时间。
    results.timestamp = new Date().toISOString();
    results.diagnostics = buildUsageDiagnostics(results.providers);

    return results;
}

/**
 * 加载提供商池数据（从内存或文件）
 * @param {string} providerType - 提供商类型
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Array} 提供商列表
 */
function loadProviderList(providerType, currentConfig, providerPoolManager) {
    // 优先从内存获取
    if (providerPoolManager && providerPoolManager.providerPools && providerPoolManager.providerPools[providerType]) {
        return providerPoolManager.providerPools[providerType];
    }
    if (currentConfig.providerPools && currentConfig.providerPools[providerType]) {
        return currentConfig.providerPools[providerType];
    }
    // Fallback: 从文件读取
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    try {
        if (existsSync(filePath)) {
            const poolsData = JSON.parse(readFileSync(filePath, 'utf-8'));
            if (poolsData[providerType] && poolsData[providerType].length > 0) {
                logger.info(`[Usage API] Loaded ${poolsData[providerType].length} providers for ${providerType} from file fallback`);
                return poolsData[providerType];
            }
        }
    } catch (fileError) {
        logger.warn(`[Usage API] Failed to load provider pools from file: ${fileError.message}`);
    }
    return [];
}

function getProviderCodexEmail(provider = {}) {
    return provider.codexEmail || provider.CODEX_EMAIL || provider.email || null;
}

function getScheduledRecoveryError(provider, now = Date.now()) {
    if (provider?.isHealthy !== false || !provider?.scheduledRecoveryTime) {
        return null;
    }

    const recoveryMs = Date.parse(provider.scheduledRecoveryTime);
    if (!Number.isFinite(recoveryMs) || now >= recoveryMs) {
        return null;
    }

    return `Provider is waiting for scheduled recovery until ${new Date(recoveryMs).toISOString()}`;
}

function getUsageItemMaxPercent(usage, predicate) {
    const values = (usage?.items || [])
        .filter(predicate)
        .map(item => Number(item.percent ?? item.used))
        .filter(value => Number.isFinite(value));
    return values.length > 0 ? Math.max(...values) : null;
}

function getLatestExhaustedResetTime(usage, predicate, now = Date.now()) {
    const exhaustedItems = (Array.isArray(usage?.items) ? usage.items : [])
        .filter(predicate)
        .filter(item => Number(item.percent ?? item.used) >= 100);

    if (exhaustedItems.length === 0) return null;

    const recoveryTimes = exhaustedItems.map(item => Date.parse(item.resetAt || ''));
    if (recoveryTimes.some(recoveryMs => !Number.isFinite(recoveryMs) || recoveryMs <= now)) {
        return null;
    }

    return new Date(Math.max(...recoveryTimes)).toISOString();
}

function mergeQuotaHealthState(existingState = {}, usedPercent, label, options = {}) {
    if (!Number.isFinite(usedPercent)) {
        return existingState;
    }

    const exhausted = usedPercent >= 100;
    const usageState = exhausted
        ? {
            isHealthy: false,
            lastErrorTime: existingState?.lastErrorTime || new Date(options.now ?? Date.now()).toISOString(),
            lastErrorMessage: `${label} 已用 ${usedPercent.toFixed(1)}%`,
            scheduledRecoveryTime: options.scheduledRecoveryTime || null,
            reasonCode: options.reasonCode || 'CODEX_QUOTA_EXHAUSTED',
            activeWindow: options.activeWindow || existingState?.activeWindow || null
        }
        : {
            isHealthy: true,
            lastErrorTime: null,
            lastErrorMessage: null,
            scheduledRecoveryTime: null,
            reasonCode: options.healthyReasonCode ?? null,
            activeWindow: options.activeWindow || existingState?.activeWindow || null
        };

    if (options.allowRecovery) {
        return {
            ...existingState,
            ...usageState
        };
    }

    if (existingState?.isHealthy === false) {
        return {
            ...usageState,
            ...existingState
        };
    }

    return {
        ...existingState,
        ...usageState
    };
}

function deriveCodexQuotaHealthFromUsage(currentHealth, usage, now = Date.now()) {
    if (!usage) return currentHealth || null;

    const quotaHealth = currentHealth && typeof currentHealth === 'object'
        ? { ...currentHealth }
        : {};
    const applicability = usage.summary?.quotaApplicability || null;
    const generalUsedPercent = getUsageItemMaxPercent(usage, item =>
        item.id === 'primary_window' || item.id === 'secondary_window'
    );
    const generalWeeklyUsedPercent = getUsageItemMaxPercent(usage, item =>
        item.scope === 'general' && (item.windowKind === 'weekly' || item.id === 'secondary_window')
    );
    const codex53UsedPercent = getUsageItemMaxPercent(usage, item => {
        const id = String(item.id || '').toLowerCase();
        const label = String(item.label || '').toLowerCase();
        return id.includes('gpt_5_3') || id.includes('codex_5_3') || label.includes('5.3');
    });

    const generalRecoveryTime = getLatestExhaustedResetTime(
        usage,
        item => item.scope === 'general' || item.id === 'primary_window' || item.id === 'secondary_window',
        now
    );
    const generalWeeklyRecoveryTime = getLatestExhaustedResetTime(
        usage,
        item => item.scope === 'general' && (item.windowKind === 'weekly' || item.id === 'secondary_window'),
        now
    );

    const generalApplicability = applicability?.general?.short?.status;
    if (generalApplicability === 'not_applicable') {
        if (Number.isFinite(generalWeeklyUsedPercent)) {
            quotaHealth.general = mergeQuotaHealthState(quotaHealth.general, generalWeeklyUsedPercent, '通用额度', {
                allowRecovery: true,
                scheduledRecoveryTime: generalWeeklyRecoveryTime,
                activeWindow: 'weekly',
                now
            });
        } else {
            quotaHealth.general = {
                ...(quotaHealth.general || {}),
                isHealthy: true,
                lastErrorTime: null,
                lastErrorMessage: null,
                scheduledRecoveryTime: null,
                reasonCode: null,
                activeWindow: null
            };
        }
        quotaHealth.general.applicability = 'not_applicable';
    } else if (Number.isFinite(generalUsedPercent)) {
        quotaHealth.general = mergeQuotaHealthState(quotaHealth.general, generalUsedPercent, '通用额度', {
            allowRecovery: true,
            scheduledRecoveryTime: generalRecoveryTime,
            activeWindow: Number.isFinite(generalWeeklyUsedPercent)
                && generalWeeklyUsedPercent >= generalUsedPercent ? 'weekly' : 'short',
            now
        });
        if (generalApplicability === 'unknown') {
            quotaHealth.general.applicability = 'unknown';
        }
    } else if (generalApplicability === 'unknown') {
        quotaHealth.general = {
            ...(quotaHealth.general || {}),
            isHealthy: quotaHealth.general?.isHealthy === false ? false : true,
            applicability: 'unknown'
        };
    }
    quotaHealth.codex53 = mergeQuotaHealthState(quotaHealth.codex53, codex53UsedPercent, '5.3 额度');
    if (applicability?.codex53) {
        quotaHealth.codex53 = {
            ...(quotaHealth.codex53 || {}),
            applicability: applicability.codex53.short.status === 'healthy' || applicability.codex53.weekly.status === 'healthy'
                ? 'healthy'
                : 'unknown'
        };
    }

    return quotaHealth;
}

function deriveAntigravityQuotaHealthFromUsage(currentHealth, now = Date.now()) {
    const quotaHealth = currentHealth && typeof currentHealth === 'object'
        ? {
            families: { ...(currentHealth.families || {}) },
            models: { ...(currentHealth.models || {}) }
        }
        : { families: {}, models: {} };

    for (const [family, familyState] of Object.entries(quotaHealth.families)) {
        if (familyState?.source === 'usage_cache') {
            delete quotaHealth.families[family];
        }
    }

    return normalizeAntigravityQuotaHealth(quotaHealth, now);
}

function getCachedInstancesByUuid(providerCache = {}) {
    const instances = Array.isArray(providerCache.instances) ? providerCache.instances : [];
    return new Map(instances.filter(inst => inst?.uuid).map(inst => [inst.uuid, inst]));
}

function collectRefreshError(providerType, instance) {
    if (instance?.skipped) return null;
    if (!instance?.error) return null;
    return {
        providerType,
        uuid: instance.uuid || null,
        name: instance.name || instance.uuid || providerType,
        error: instance.error,
        errorClass: classifyUsageRefreshError(instance.error)
    };
}

function classifyUsageRefreshError(error) {
    const message = String(error || '').toLowerCase();
    if (/401|unauthorized|reauthori[sz]e|refresh token/.test(message)) return 'auth_401';
    if (/timeout|timed out|etimedout/.test(message)) return 'timeout';
    if (/econnreset|socket hang up|econnrefused|network/.test(message)) return 'network_reset';
    if (/429|rate.?limit|too many/.test(message)) return 'upstream_429';
    return 'refresh_error';
}

function incrementDiagnosticCounter(target, key) {
    if (!key) return;
    target[key] = (target[key] || 0) + 1;
}

function buildUsageDiagnostics(providers = {}) {
    const diagnostics = {
        plans: {},
        windows: {},
        errors: {}
    };
    for (const providerData of Object.values(providers)) {
        for (const instance of providerData?.instances || []) {
            if (instance?.skipped) continue;
            const plan = instance?.usage?.summary?.plan;
            incrementDiagnosticCounter(diagnostics.plans, plan || 'UNKNOWN');
            const applicability = instance?.usage?.summary?.quotaApplicability;
            for (const bucket of ['general', 'codex53']) {
                for (const windowKind of ['short', 'weekly']) {
                    const status = applicability?.[bucket]?.[windowKind]?.status;
                    if (status) incrementDiagnosticCounter(diagnostics.windows, `${bucket}:${windowKind}:${status}`);
                    if (status) incrementDiagnosticCounter(diagnostics.windows, status);
                }
            }
            if (instance?.error) incrementDiagnosticCounter(diagnostics.errors, classifyUsageRefreshError(instance.error));
        }
    }
    return diagnostics;
}

function recalculateProviderUsageCounts(providerData) {
    const instances = Array.isArray(providerData.instances) ? providerData.instances : [];
    const activeInstances = instances.filter(inst => !inst.skipped && !inst.isDisabled);
    providerData.totalCount = instances.length;
    providerData.refreshableCount = activeInstances.length;
    providerData.successCount = activeInstances.filter(inst => inst.success).length;
    providerData.errorCount = activeInstances.filter(inst => !inst.success).length;
    providerData.skippedCount = instances.length - activeInstances.length;
    return providerData;
}

function mergeProviderUsageWithLastSuccessfulCache(providerType, freshProviderData = {}, cachedProviderData = {}, cachedAt = null) {
    const refreshErrors = [];
    const cachedSuccessfulAt = cachedProviderData?.lastSuccessfulRefreshAt || cachedAt || null;
    if (freshProviderData.error && cachedProviderData?.instances?.length) {
        refreshErrors.push({
            providerType,
            uuid: null,
            name: providerType,
            error: freshProviderData.error,
            errorClass: classifyUsageRefreshError(freshProviderData.error)
        });
        return {
            providerData: {
                ...cachedProviderData,
                providerType,
                fromCache: true,
                stale: true,
                lastRefreshError: freshProviderData.error,
                lastSuccessfulUsageAt: cachedSuccessfulAt,
                lastSuccessfulRefreshAt: cachedSuccessfulAt
            },
            refreshErrors
        };
    }

    const cachedByUuid = getCachedInstancesByUuid(cachedProviderData);
    const instances = (freshProviderData.instances || []).map(instance => {
        if (instance.success) {
            return {
                ...mergeCodexResetCreditsWithLastSuccessfulUsage(instance, cachedByUuid.get(instance.uuid), cachedSuccessfulAt),
                lastRefreshError: null
            };
        }

        const refreshError = collectRefreshError(providerType, instance);
        if (refreshError) refreshErrors.push(refreshError);

        const cachedInstance = cachedByUuid.get(instance.uuid);
        if (!cachedInstance?.success || !cachedInstance.usage) {
            return instance;
        }

        return {
            ...cachedInstance,
            name: instance.name || cachedInstance.name,
            codexAccountKey: instance.codexAccountKey || cachedInstance.codexAccountKey || null,
            codexAccountId: instance.codexAccountId || cachedInstance.codexAccountId || null,
            codexEmail: instance.codexEmail || cachedInstance.codexEmail || null,
            codexQuotaHealth: instance.codexQuotaHealth || cachedInstance.codexQuotaHealth || null,
            antigravityQuotaHealth: normalizeAntigravityQuotaHealth(
                instance.antigravityQuotaHealth || cachedInstance.antigravityQuotaHealth || null
            ),
            configFilePath: instance.configFilePath || cachedInstance.configFilePath || null,
            isHealthy: instance.isHealthy,
            isDisabled: instance.isDisabled,
            needsRefresh: instance.needsRefresh,
            scheduledRecoveryTime: instance.scheduledRecoveryTime || cachedInstance.scheduledRecoveryTime || null,
            success: true,
            error: null,
            staleUsage: true,
            lastRefreshError: instance.error,
            lastSuccessfulUsageAt: cachedSuccessfulAt
        };
    });

    const lastSuccessfulRefreshAt = refreshErrors.length === 0
        ? freshProviderData.lastSuccessfulRefreshAt || null
        : cachedSuccessfulAt;

    return {
        providerData: recalculateProviderUsageCounts({
            ...freshProviderData,
            lastSuccessfulRefreshAt,
            instances,
            refreshErrors
        }),
        refreshErrors
    };
}

function mergeUsageResultsWithLastSuccessfulCache(freshResults, cachedData) {
    if (!cachedData?.providers) {
        return freshResults;
    }

    const merged = {
        ...freshResults,
        providers: {},
        refreshErrors: []
    };

    for (const [providerType, providerData] of Object.entries(freshResults.providers || {})) {
        const { providerData: mergedProviderData, refreshErrors } = mergeProviderUsageWithLastSuccessfulCache(
            providerType,
            providerData,
            cachedData.providers?.[providerType],
            cachedData.timestamp || null
        );
        merged.providers[providerType] = mergedProviderData;
        merged.refreshErrors.push(...refreshErrors);
    }

    return merged;
}

function getCachedInstanceUsageFallback(providerType, uuid, instanceResult, cachedData) {
    const cachedInstance = getCachedInstancesByUuid(cachedData?.providers?.[providerType]).get(uuid);
    if (!instanceResult?.error || !cachedInstance?.success || !cachedInstance.usage) {
        return instanceResult;
    }

    return {
        ...cachedInstance,
        name: instanceResult.name || cachedInstance.name,
        codexAccountKey: instanceResult.codexAccountKey || cachedInstance.codexAccountKey || null,
        codexAccountId: instanceResult.codexAccountId || cachedInstance.codexAccountId || null,
        codexEmail: instanceResult.codexEmail || cachedInstance.codexEmail || null,
        codexQuotaHealth: instanceResult.codexQuotaHealth || cachedInstance.codexQuotaHealth || null,
        antigravityQuotaHealth: normalizeAntigravityQuotaHealth(
            instanceResult.antigravityQuotaHealth || cachedInstance.antigravityQuotaHealth || null
        ),
        configFilePath: instanceResult.configFilePath || cachedInstance.configFilePath || null,
        isHealthy: instanceResult.isHealthy,
        isDisabled: instanceResult.isDisabled,
        needsRefresh: instanceResult.needsRefresh,
        scheduledRecoveryTime: instanceResult.scheduledRecoveryTime || cachedInstance.scheduledRecoveryTime || null,
        success: true,
        error: null,
        staleUsage: true,
        lastRefreshError: instanceResult.error,
        lastSuccessfulUsageAt: cachedData?.timestamp || null,
        refreshErrors: [collectRefreshError(providerType, instanceResult)].filter(Boolean)
    };
}

/**
 * 获取指定提供商类型的用量信息
 * @param {string} providerType - 提供商类型
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Promise<Object>} 提供商用量信息
 */
async function getProviderTypeUsage(providerType, currentConfig, providerPoolManager) {
    const result = {
        providerType,
        instances: [],
        totalCount: 0,
        successCount: 0,
        errorCount: 0
    };

    // 获取提供商池中的所有实例（使用统一的加载函数）
    const providers = loadProviderList(providerType, currentConfig, providerPoolManager);

    result.totalCount = providers.length;
    result.refreshableCount = providers.filter(provider => !provider?.isDisabled).length;

    const accountTimeoutMs = normalizePositiveInteger(
        currentConfig.USAGE_REFRESH_ACCOUNT_TIMEOUT_MS,
        DEFAULT_USAGE_REFRESH_ACCOUNT_TIMEOUT_MS
    );
    const concurrency = normalizePositiveInteger(
        currentConfig.USAGE_REFRESH_CONCURRENCY_PER_PROVIDER,
        DEFAULT_USAGE_REFRESH_CONCURRENCY_PER_PROVIDER
    );

    // 受控并发获取同一 provider 类型下的实例，避免单账号串行阻塞全部刷新。
    result.instances = await mapWithConcurrency(providers, concurrency, async (provider) => {
        const providerKey = providerType + (provider.uuid || '');
        let adapter = serviceInstances[providerKey];
        
        const instanceResult = {
            uuid: provider.uuid || 'unknown',
            name: getProviderDisplayName(provider, providerType),
            codexAccountKey: provider.codexAccountKey || null,
            codexAccountId: provider.codexAccountId || null,
            codexEmail: getProviderCodexEmail(provider),
            codexQuotaHealth: provider.codexQuotaHealth || null,
            antigravityQuotaHealth: provider.antigravityQuotaHealth || null,
            configFilePath: getProviderConfigFilePath(provider, providerType),
            isHealthy: provider.isHealthy !== false,
            isDisabled: provider.isDisabled === true,
            needsRefresh: provider.needsRefresh === true,
            scheduledRecoveryTime: provider.scheduledRecoveryTime || null,
            success: false,
            usage: null,
            error: null,
            skipped: false,
            skipReason: null
        };

        const scheduledRecoveryError = getScheduledRecoveryError(provider);

        // First check if disabled or cooling down, skip initialization for those providers
        if (provider.isDisabled) {
            instanceResult.skipped = true;
            instanceResult.skipReason = 'disabled';
        } else if (scheduledRecoveryError) {
            instanceResult.error = scheduledRecoveryError;
            result.errorCount++;
        } else if (!adapter) {
            // Service instance not initialized, try auto-initialization
            try {
                logger.debug(`[Usage API] Auto-initializing service adapter for ${providerType}: ${provider.uuid}`);
                // Build configuration object
                const serviceConfig = {
                    ...CONFIG,
                    ...provider,
                    MODEL_PROVIDER: providerType
                };
                adapter = getServiceAdapter(serviceConfig);
            } catch (initError) {
                logger.error(`[Usage API] Failed to initialize adapter for ${providerType}: ${provider.uuid}:`, initError.message);
                instanceResult.error = `Service instance initialization failed: ${initError.message}`;
            }
        }
        
        // If adapter exists (including just initialized), and no error, try to get usage
        if (adapter && !instanceResult.error) {
            try {
                const usage = await withUsageAccountTimeout(
                    usageService.getFormattedUsage(providerType, provider.uuid),
                    accountTimeoutMs,
                    providerType,
                    provider.uuid
                );
                instanceResult.success = true;
                instanceResult.usage = usage;
                instanceResult.codexQuotaHealth = deriveCodexQuotaHealthFromUsage(instanceResult.codexQuotaHealth, usage);
                providerPoolManager?.syncCodexQuotaHealth?.(providerType, provider, instanceResult.codexQuotaHealth);
                instanceResult.antigravityQuotaHealth = deriveAntigravityQuotaHealthFromUsage(instanceResult.antigravityQuotaHealth);
                providerPoolManager?.syncAntigravityQuotaHealth?.(providerType, provider, instanceResult.antigravityQuotaHealth);
                providerPoolManager?.syncAntigravityPlan?.(providerType, provider, usage?.summary?.plan);
            } catch (error) {
                instanceResult.error = error.message;
            }
        }

        return instanceResult;
    });

    result.successCount = result.instances.filter(instance => instance.success).length;
    result.errorCount = result.instances.filter(instance => !instance.success && !instance.skipped).length;
    if (result.errorCount === 0) {
        result.lastSuccessfulRefreshAt = new Date().toISOString();
    }

    return result;
}

/**
 * 获取提供商显示名称

 * @param {Object} provider - 提供商配置
 * @param {string} providerType - 提供商类型
 * @returns {string} 显示名称
 */
function getProviderDisplayName(provider, providerType) {
    // 1. 优先使用自定义名称
    if (provider.customName) {
        return provider.customName;
    }

    // 2. 尝试从凭据文件路径提取名称（自动从文件名识别账号）
    const mapping = PROVIDER_MAPPINGS.find(m => m.providerType === providerType);
    const credPathKey = mapping ? mapping.credPathKey : null;

    // 只有当键名包含 'PATH' 或 'FILE' 时，才将其视为文件路径进行解析
    if (credPathKey && provider[credPathKey] && (credPathKey.includes('PATH') || credPathKey.includes('FILE'))) {
        const filePath = provider[credPathKey];
        // 提取文件名（不含扩展名）作为显示名称，例如 account-a.json -> account-a
        const fileName = path.basename(filePath, path.extname(filePath));
        if (fileName) return fileName;
    }

    // 3. 兜底显示 UUID
    if (provider.uuid) {
        return provider.uuid;
    }

    return 'Unnamed';
}

/**
 * 获取提供商配置文件路径
 * @param {Object} provider - 提供商配置
 * @param {string} providerType - 提供商类型
 * @returns {string|null} 配置文件路径
 */
function getProviderConfigFilePath(provider, providerType) {
    const mapping = PROVIDER_MAPPINGS.find(m => m.providerType === providerType);
    const credPathKey = mapping ? mapping.credPathKey : null;

    // 只有当键名包含 'PATH' 或 'FILE' 时，才返回路径
    if (credPathKey && provider[credPathKey] && (credPathKey.includes('PATH') || credPathKey.includes('FILE'))) {
        return provider[credPathKey];
    }
    return null;
}

function enrichProviderDataWithProviderConfig(providerType, providerData, currentConfig, providerPoolManager) {
    if (!providerData?.instances || !Array.isArray(providerData.instances)) return providerData;

    const providersByUuid = new Map(
        loadProviderList(providerType, currentConfig, providerPoolManager)
            .filter(provider => provider?.uuid)
            .map(provider => [provider.uuid, provider])
    );

    providerData.instances = providerData.instances.map(instance => {
        const provider = providersByUuid.get(instance?.uuid);
        if (!provider) return instance;

        return {
            ...instance,
            name: instance.name || getProviderDisplayName(provider, providerType),
            codexAccountKey: instance.codexAccountKey || provider.codexAccountKey || null,
            codexAccountId: instance.codexAccountId || provider.codexAccountId || null,
            codexEmail: instance.codexEmail || getProviderCodexEmail(provider),
            codexQuotaHealth: instance.codexQuotaHealth || provider.codexQuotaHealth || null,
            antigravityQuotaHealth: instance.antigravityQuotaHealth || provider.antigravityQuotaHealth || null,
            configFilePath: instance.configFilePath || getProviderConfigFilePath(provider, providerType),
            isHealthy: provider.isHealthy !== false,
            isDisabled: provider.isDisabled === true,
            needsRefresh: provider.needsRefresh === true,
            scheduledRecoveryTime: instance.scheduledRecoveryTime || provider.scheduledRecoveryTime || null
        };
    });

    return providerData;
}

function enrichUsageResultsWithProviderConfig(results, currentConfig, providerPoolManager) {
    if (!results?.providers) return results;

    for (const [providerType, providerData] of Object.entries(results.providers)) {
        enrichProviderDataWithProviderConfig(providerType, providerData, currentConfig, providerPoolManager);
    }

    return results;
}

/**
 * 重新格式化用量结果（基于保存的原始数据）
 * 确保即使格式化逻辑改变，缓存数据也能以最新格式返回
 * @param {Object} results - 用量结果对象
 */
function reformatUsageResults(results) {
    if (!results || !results.providers) return;
    
    for (const [providerType, providerData] of Object.entries(results.providers)) {
        if (providerData.instances && Array.isArray(providerData.instances)) {
            for (const instance of providerData.instances) {
                // 如果有原始数据（保存在 usage.raw 中），重新执行格式化
                if (instance.success && instance.usage && instance.usage.raw) {
                    try {
                        instance.usage = usageService.formatUsage(providerType, instance.usage.raw);
                        instance.codexQuotaHealth = deriveCodexQuotaHealthFromUsage(instance.codexQuotaHealth, instance.usage);
                        instance.antigravityQuotaHealth = deriveAntigravityQuotaHealthFromUsage(instance.antigravityQuotaHealth);
                    } catch (err) {
                        logger.error(`[Usage API] Failed to re-format cached data for ${providerType}:`, err.message);
                    }
                } else if (instance.success && instance.usage) {
                    instance.codexQuotaHealth = deriveCodexQuotaHealthFromUsage(instance.codexQuotaHealth, instance.usage);
                    instance.antigravityQuotaHealth = deriveAntigravityQuotaHealthFromUsage(instance.antigravityQuotaHealth);
                }
            }
        }
    }
}

async function resolveProviderInstance(currentConfig, providerPoolManager, providerType, uuid) {
    const providers = loadProviderList(providerType, currentConfig, providerPoolManager);
    const provider = providers.find(p => p.uuid === uuid);

    if (!provider) {
        throw new Error(`未找到指定的提供商实例: ${uuid}`);
    }

    const providerKey = providerType + (provider.uuid || '');
    let adapter = serviceInstances[providerKey];

    const instanceResult = {
        uuid: provider.uuid || 'unknown',
        name: getProviderDisplayName(provider, providerType),
        codexAccountKey: provider.codexAccountKey || null,
        codexAccountId: provider.codexAccountId || null,
        codexEmail: getProviderCodexEmail(provider),
        codexQuotaHealth: provider.codexQuotaHealth || null,
        antigravityQuotaHealth: provider.antigravityQuotaHealth || null,
        configFilePath: getProviderConfigFilePath(provider, providerType),
        isHealthy: provider.isHealthy !== false,
        isDisabled: provider.isDisabled === true,
        needsRefresh: provider.needsRefresh === true,
        scheduledRecoveryTime: provider.scheduledRecoveryTime || null,
        success: false,
        usage: null,
        error: null,
        skipped: false,
        skipReason: null
    };

    if (provider.isDisabled) {
        instanceResult.skipped = true;
        instanceResult.skipReason = 'disabled';
        return { provider, adapter: null, instanceResult };
    }

    if (!adapter) {
        const serviceConfig = {
            ...CONFIG,
            ...provider,
            MODEL_PROVIDER: providerType
        };
        adapter = getServiceAdapter(serviceConfig);
    }

    return { provider, adapter, instanceResult };
}

async function updateSingleInstanceInCache(providerType, uuid, instanceResult) {
    try {
        const usageCachePath = path.join(process.cwd(), 'configs', 'usage-cache.json');
        await withFileLock(usageCachePath, async () => {
            const cache = await readUsageCache({ maxAgeMs: null });
            if (!cache?.providers?.[providerType]?.instances || !Array.isArray(cache.providers[providerType].instances)) {
                return;
            }

            const providerCache = cache.providers[providerType];
            const idx = providerCache.instances.findIndex(inst => inst.uuid === uuid);
            if (idx !== -1) {
                providerCache.instances[idx] = instanceResult;
            } else {
                providerCache.instances.push(instanceResult);
            }

            let successCount = 0;
            let errorCount = 0;
            providerCache.instances.forEach(inst => {
                if (inst.success) {
                    successCount++;
                } else {
                    errorCount++;
                }
            });
            providerCache.successCount = successCount;
            providerCache.errorCount = errorCount;
            providerCache.totalCount = providerCache.instances.length;

            cache.timestamp = new Date().toISOString();
            await writeUsageCacheUnlocked(cache);
        });
        logger.info(`[Usage API] Updated global usage cache for single instance ${providerType}:${uuid}`);
    } catch (cacheError) {
        logger.warn('[Usage API] Failed to update global usage cache for single instance:', cacheError.message);
    }
}

/**
 * 获取支持用量查询的提供商列表
 */
export async function handleGetSupportedProviders(req, res) {
    try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(supportedProviders));
        return true;
    } catch (error) {
        logger.error('[Usage API] Failed to get supported providers:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to get supported providers: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 获取所有提供商的用量限制
 */
export async function handleGetUsage(req, res, currentConfig, providerPoolManager) {
    const requestStartedAt = performance.now();
    const timings = {};
    try {
        // 解析查询参数，检查是否需要强制刷新
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        
        let usageResults;
        
        if (refresh) {
            const cachedData = await measureUsagePhase(timings, 'readDisplayMs', () =>
                readUsageDisplayCache({ maxAgeMs: null, allowStale: true })
            );
            if (cachedData) {
                logger.debug('[Usage API] Returning cached usage data while refreshing in background');
                const refreshRunner = globalThis.runUsageCacheAutoRefreshNow;
                const refreshPending = typeof refreshRunner === 'function';
                if (refreshPending) {
                    Promise.resolve()
                        .then(() => refreshRunner())
                        .catch(error => logger.error('[Usage API] Background usage refresh failed:', error));
                }
                usageResults = { ...cachedData, fromCache: true, refreshPending };
                await measureUsagePhase(timings, 'enrichMs', () =>
                    enrichUsageResultsWithProviderConfig(usageResults, currentConfig, providerPoolManager)
                );
            }
        } else {
            // 页面读取永远只展示最后已知缓存，不因进入页面触发上游额度查询。
            const cachedData = await measureUsagePhase(timings, 'readDisplayMs', () =>
                readUsageDisplayCache({ maxAgeMs: null, allowStale: true })
            );
            logger.debug(cachedData
                ? '[Usage API] Returning cached usage data'
                : '[Usage API] No cached usage data available');
            usageResults = {
                ...(cachedData || { timestamp: null, providers: {} }),
                fromCache: true,
                refreshPending: isUsageRefreshPending()
            };
            await measureUsagePhase(timings, 'enrichMs', () =>
                enrichUsageResultsWithProviderConfig(usageResults, currentConfig, providerPoolManager)
            );
        }

        if (!usageResults) {
            // 缓存不存在或需要刷新，重新查询
            logger.info('[Usage API] Fetching fresh usage data');
            const lastKnownUsage = await readUsageCache({ maxAgeMs: null, allowStale: true });
            const freshUsageResults = await getAllProvidersUsage(currentConfig, providerPoolManager);
            usageResults = mergeUsageResultsWithLastSuccessfulCache(freshUsageResults, lastKnownUsage);
            if (!usageResults.refreshErrors || usageResults.refreshErrors.length === 0) {
                await writeUsageCache(usageResults);
            } else {
                logger.warn(`[Usage API] Fresh usage refresh had ${usageResults.refreshErrors.length} errors; keeping last successful usage visible`);
            }
        }
        
        // Always include current server time
        const finalResults = {
            ...usageResults,
            serverTime: new Date().toISOString()
        };
        
        sendUsageResponse(res, finalResults, timings, requestStartedAt);
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to get usage:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to get usage info: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 获取特定提供商实例的用量限制
 */
export async function handleGetSingleInstanceUsage(req, res, currentConfig, providerPoolManager, providerType, uuid) {
    try {
        let instanceResult = null;

        // 重新查询
        logger.info(`[Usage API] Fetching fresh usage data for ${providerType}:${uuid}`);

        const { provider, adapter, instanceResult: baseInstanceResult } = await resolveProviderInstance(
            currentConfig,
            providerPoolManager,
            providerType,
            uuid
        );

        instanceResult = baseInstanceResult;

        if (adapter && !instanceResult.error) {
            try {
                const usage = await usageService.getFormattedUsage(providerType, provider.uuid);
                instanceResult.success = true;
                instanceResult.usage = usage;
                if (providerType === MODEL_PROVIDER.CODEX_API) {
                    const { getAccountUsageSummary } = await import('../plugins/api-potluck/key-manager.js');
                    const accountSummary = await getAccountUsageSummary(new Date(), { includeTimeline: true });
                    enrichCodexWeeklyEstimates({ providerType, instances: [instanceResult] }, accountSummary);
                }
                instanceResult.codexQuotaHealth = deriveCodexQuotaHealthFromUsage(instanceResult.codexQuotaHealth, usage);
                providerPoolManager?.syncCodexQuotaHealth?.(providerType, provider, instanceResult.codexQuotaHealth);
                instanceResult.antigravityQuotaHealth = deriveAntigravityQuotaHealthFromUsage(instanceResult.antigravityQuotaHealth);
                providerPoolManager?.syncAntigravityQuotaHealth?.(providerType, provider, instanceResult.antigravityQuotaHealth);
                providerPoolManager?.syncAntigravityPlan?.(providerType, provider, usage?.summary?.plan);
            } catch (error) {
                instanceResult.error = error.message;
            }
        }

        const lastKnownUsage = await readUsageCache({ maxAgeMs: null, allowStale: true });
        instanceResult = getCachedInstanceUsageFallback(providerType, uuid, instanceResult, lastKnownUsage);
        if (instanceResult.success && !instanceResult.staleUsage) {
            await updateSingleInstanceInCache(providerType, uuid, instanceResult);
        }
        
        const finalResults = {
            ...instanceResult,
            serverTime: new Date().toISOString()
        };

        sendJson(res, 200, finalResults);
        return true;
    } catch (error) {
        logger.error(`[UI API] Failed to get usage for ${providerType}:${uuid}:`, error);
        sendJson(res, 500, {
            error: {
                message: `Failed to get usage info for ${providerType}:${uuid}: ` + error.message
            }
        });
        return true;
    }
}

export async function handleResetSingleInstanceUsage(req, res, currentConfig, providerPoolManager, providerType, uuid) {
    try {
        if (providerType !== MODEL_PROVIDER.CODEX_API) {
            throw new Error(`当前仅支持 ${MODEL_PROVIDER.CODEX_API} 的额度重置`);
        }

        const { provider, adapter, instanceResult: baseInstanceResult } = await resolveProviderInstance(
            currentConfig,
            providerPoolManager,
            providerType,
            uuid
        );

        if (baseInstanceResult.error) {
            throw new Error(baseInstanceResult.error);
        }

        if (!adapter?.codexApiService || typeof adapter.codexApiService.resetUsageQuota !== 'function') {
            throw new Error(`${providerType} 服务实例不支持额度重置: ${provider.uuid}`);
        }

        const resetResult = await adapter.codexApiService.resetUsageQuota();
        const usage = usageService.formatUsage(providerType, resetResult.usage);
        const refreshedInstanceResult = {
            ...baseInstanceResult,
            success: true,
            usage,
            codexQuotaHealth: deriveCodexQuotaHealthFromUsage(baseInstanceResult.codexQuotaHealth, usage),
            error: null
        };
        providerPoolManager?.syncCodexQuotaHealth?.(providerType, provider, refreshedInstanceResult.codexQuotaHealth);

        await updateProviderUsageCache(providerType, await getProviderTypeUsage(providerType, currentConfig, providerPoolManager));
        await updateSingleInstanceInCache(providerType, uuid, refreshedInstanceResult);

        sendJson(res, 200, {
            success: true,
            uuid,
            providerType,
            instance: refreshedInstanceResult,
            resetResult: resetResult.resetResult,
            serverTime: new Date().toISOString()
        });
        return true;
    } catch (error) {
        logger.error(`[UI API] Failed to reset usage for ${providerType}:${uuid}:`, error);
        sendJson(res, 500, {
            error: {
                message: `Failed to reset usage for ${providerType}:${uuid}: ` + error.message
            }
        });
        return true;
    }
}

export async function handlePostCodexRateLimitReset(req, res, currentConfig, providerPoolManager, providerType, uuid) {
    try {
        if (providerType !== MODEL_PROVIDER.CODEX_API) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: { message: 'Rate limit reset is only supported for Codex providers' }
            }));
            return true;
        }

        let body = {};
        try {
            body = await getRequestBody(req, { maxBytes: 1024 });
        } catch (error) {
            logger.warn('[Usage API] Failed to parse Codex reset request body, using generated redeem request id:', error.message);
        }

        const providers = loadProviderList(providerType, currentConfig, providerPoolManager);
        const provider = providers.find(p => p.uuid === uuid);

        if (!provider) {
            throw new Error(`未找到指定的提供商实例: ${uuid}`);
        }
        if (provider.isDisabled) {
            throw new Error('Provider is disabled');
        }

        const providerKey = providerType + (provider.uuid || '');
        let adapter = serviceInstances[providerKey];
        if (!adapter) {
            const serviceConfig = {
                ...CONFIG,
                ...provider,
                MODEL_PROVIDER: providerType
            };
            adapter = getServiceAdapter(serviceConfig);
        }

        const service = adapter?.codexApiService || adapter;
        if (!service || typeof service.consumeRateLimitResetCredit !== 'function') {
            throw new Error('Codex rate limit reset is not supported by this adapter');
        }

        const redeemRequestId = typeof body.redeemRequestId === 'string'
            ? body.redeemRequestId
            : (typeof body.redeem_request_id === 'string' ? body.redeem_request_id : null);
        const result = await service.consumeRateLimitResetCredit(redeemRequestId);

        let refreshedUsage = null;
        if (result?.code === 'reset' || result?.code === 'already_redeemed') {
            try {
                refreshedUsage = await usageService.getFormattedUsage(providerType, provider.uuid);
            } catch (refreshError) {
                logger.warn(`[Usage API] Failed to refresh Codex usage after reset for ${providerType}:${uuid}:`, refreshError.message);
            }
        }

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(JSON.stringify({
            success: true,
            result,
            usage: refreshedUsage,
            serverTime: new Date().toISOString()
        }));
        return true;
    } catch (error) {
        logger.error(`[UI API] Failed to reset Codex rate limit for ${providerType}:${uuid}:`, error);
        const upstreamStatus = Number(error?.response?.status) || null;
        const errorClass = upstreamStatus === 401
            ? 'auth_401'
            : upstreamStatus === 429
                ? 'upstream_429'
                : upstreamStatus === 503
                    ? 'upstream_503'
                    : classifyUsageRefreshError(error?.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: `Failed to reset Codex rate limit for ${providerType}:${uuid}: ` + error.message,
                class: errorClass,
                upstreamStatus
            }
        }));
        return true;
    }
}

/**
 * 获取特定提供商类型的用量限制
 */
export async function handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        // 解析查询参数，检查是否需要强制刷新
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        
        let usageResults;
        
        if (!refresh) {
            // Prefer reading from cache
            const cachedData = await readProviderUsageCache(providerType);
            if (cachedData) {
                logger.info(`[Usage API] Returning cached usage data for ${providerType}`);
                usageResults = { ...cachedData, fromCache: true };
                
                // 包装成 reformatUsageResults 期待的结构并重新格式化
                const tempResults = { providers: { [providerType]: usageResults } };
                reformatUsageResults(tempResults);
                usageResults = tempResults.providers[providerType];
                enrichProviderDataWithProviderConfig(providerType, usageResults, currentConfig, providerPoolManager);
            }
        }
        
        if (!usageResults) {
            // Cache does not exist or refresh required, re-query
            logger.info(`[Usage API] Fetching fresh usage data for ${providerType}`);
            usageResults = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager);
            if (providerType === MODEL_PROVIDER.CODEX_API && usageResults.instances?.some(instance => instance?.success)) {
                try {
                    const { getAccountUsageSummary } = await import('../plugins/api-potluck/key-manager.js');
                    const accountSummary = await getAccountUsageSummary(new Date(), { includeTimeline: true });
                    enrichCodexWeeklyEstimates(usageResults, accountSummary);
                } catch (error) {
                    logger.warn(`[Usage API] Failed to enrich Codex weekly quota estimates: ${error.message}`);
                }
            }
            const lastKnownUsage = await readUsageCache({ maxAgeMs: null, allowStale: true });
            const { providerData, refreshErrors } = mergeProviderUsageWithLastSuccessfulCache(
                providerType,
                usageResults,
                lastKnownUsage?.providers?.[providerType],
                lastKnownUsage?.timestamp || null
            );
            usageResults = providerData;
            if (!refreshErrors || refreshErrors.length === 0) {
                await updateProviderUsageCache(providerType, usageResults);
            } else {
                usageResults.refreshErrors = refreshErrors;
                logger.warn(`[Usage API] Fresh usage refresh for ${providerType} had ${refreshErrors.length} errors; keeping last successful usage visible`);
            }
        }
        
        // Always include current server time
        const finalResults = {
            ...usageResults,
            serverTime: new Date().toISOString()
        };
        
        res.writeHead(200, { 
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(JSON.stringify(finalResults));
        return true;
    } catch (error) {
        logger.error(`[UI API] Failed to get usage for ${providerType}:`, error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: `Failed to get usage info for ${providerType}: ` + error.message
            }
        }));
        return true;
    }
}
