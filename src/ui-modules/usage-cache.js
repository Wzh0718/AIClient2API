import { atomicWriteFile } from '../utils/file-lock.js';
import { existsSync } from 'fs';
import logger from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';

// 用量缓存文件路径
const USAGE_CACHE_FILE = path.join(process.cwd(), 'configs', 'usage-cache.json');
const USAGE_DISPLAY_CACHE_FILE = path.join(process.cwd(), 'configs', 'usage-display-cache.json');
const USAGE_DISPLAY_CACHE_SCHEMA_VERSION = 1;
export const DEFAULT_USAGE_CACHE_TTL_MS = 60 * 60 * 1000;

let inMemoryDisplayCache = null;

export function buildUsageDisplaySnapshot(usageData = {}) {
    const providers = {};
    for (const [providerType, providerData] of Object.entries(usageData.providers || {})) {
        providers[providerType] = {
            ...providerData,
            instances: Array.isArray(providerData?.instances)
                ? providerData.instances.map(instance => {
                    if (!instance?.usage || typeof instance.usage !== 'object') return { ...instance };
                    const { raw: _raw, ...displayUsage } = instance.usage;
                    return { ...instance, usage: displayUsage };
                })
                : providerData?.instances
        };
    }

    return { ...usageData, providers };
}

function createDisplayCacheEnvelope(usageData) {
    return {
        schemaVersion: USAGE_DISPLAY_CACHE_SCHEMA_VERSION,
        sourceTimestamp: usageData?.timestamp || null,
        generatedAt: new Date().toISOString(),
        data: buildUsageDisplaySnapshot(usageData)
    };
}

function getCachedInstancesByUuid(providerCache = {}) {
    const instances = Array.isArray(providerCache.instances) ? providerCache.instances : [];
    return new Map(instances.filter(inst => inst?.uuid).map(inst => [inst.uuid, inst]));
}

function recalculateProviderCounts(providerData = {}) {
    const instances = Array.isArray(providerData.instances) ? providerData.instances : [];
    providerData.totalCount = instances.length;
    providerData.successCount = instances.filter(inst => inst?.success).length;
    providerData.errorCount = instances.filter(inst => !inst?.success).length;
    return providerData;
}

function mergeInstanceWithLastSuccessfulUsage(incomingInstance, cachedByUuid, cachedAt) {
    const cachedInstance = cachedByUuid.get(incomingInstance?.uuid);
    if (incomingInstance?.success || !incomingInstance?.error) {
        return {
            ...incomingInstance,
            antigravityModelStatus: incomingInstance?.antigravityModelStatus
                || cachedInstance?.antigravityModelStatus
                || null
        };
    }

    if (!cachedInstance?.success || !cachedInstance.usage) {
        return incomingInstance;
    }

    return {
        ...cachedInstance,
        name: incomingInstance.name || cachedInstance.name,
        codexAccountKey: incomingInstance.codexAccountKey || cachedInstance.codexAccountKey || null,
        codexAccountId: incomingInstance.codexAccountId || cachedInstance.codexAccountId || null,
        codexEmail: incomingInstance.codexEmail || cachedInstance.codexEmail || null,
        codexQuotaHealth: incomingInstance.codexQuotaHealth || cachedInstance.codexQuotaHealth || null,
        antigravityQuotaHealth: incomingInstance.antigravityQuotaHealth || cachedInstance.antigravityQuotaHealth || null,
        antigravityModelStatus: incomingInstance.antigravityModelStatus || cachedInstance.antigravityModelStatus || null,
        configFilePath: incomingInstance.configFilePath || cachedInstance.configFilePath || null,
        isHealthy: incomingInstance.isHealthy,
        isDisabled: incomingInstance.isDisabled,
        success: true,
        error: null,
        staleUsage: true,
        lastRefreshError: incomingInstance.error,
        lastSuccessfulUsageAt: cachedAt || null
    };
}

function mergeProviderWithLastSuccessfulUsage(providerType, incomingProviderData = {}, cachedProviderData = {}, cachedAt) {
    if (incomingProviderData.error && Array.isArray(cachedProviderData?.instances) && cachedProviderData.instances.length > 0) {
        return {
            ...cachedProviderData,
            providerType,
            fromCache: true,
            stale: true,
            lastRefreshError: incomingProviderData.error,
            lastSuccessfulUsageAt: cachedAt || null
        };
    }

    if (!Array.isArray(incomingProviderData.instances)) {
        return incomingProviderData;
    }

    const cachedByUuid = getCachedInstancesByUuid(cachedProviderData);
    const instances = incomingProviderData.instances.map(instance =>
        mergeInstanceWithLastSuccessfulUsage(instance, cachedByUuid, cachedAt)
    );

    return recalculateProviderCounts({
        ...incomingProviderData,
        instances
    });
}

async function mergeUsageDataWithExistingLastSuccessfulUsage(usageData) {
    const existingCache = await readUsageCache({ maxAgeMs: null, allowStale: true });
    if (!existingCache?.providers || !usageData?.providers) {
        return usageData;
    }

    const mergedProviders = {};
    for (const [providerType, incomingProviderData] of Object.entries(usageData.providers)) {
        mergedProviders[providerType] = mergeProviderWithLastSuccessfulUsage(
            providerType,
            incomingProviderData,
            existingCache.providers?.[providerType],
            existingCache.timestamp || null
        );
    }

    return {
        ...usageData,
        providers: {
            ...usageData.providers,
            ...mergedProviders
        }
    };
}

function isUsageCacheFresh(cache, { maxAgeMs = DEFAULT_USAGE_CACHE_TTL_MS, now = new Date() } = {}) {
    if (maxAgeMs === null || maxAgeMs === undefined) {
        return true;
    }

    const cachedAt = Date.parse(cache?.timestamp || '');
    if (!Number.isFinite(cachedAt)) {
        return false;
    }

    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    if (!Number.isFinite(nowMs)) {
        return false;
    }

    return nowMs - cachedAt <= maxAgeMs;
}

function readDisplayEnvelopeData(envelope, options = {}) {
    if (!envelope?.data || envelope.schemaVersion !== USAGE_DISPLAY_CACHE_SCHEMA_VERSION) return null;
    const timestampedData = {
        ...envelope.data,
        timestamp: envelope.data.timestamp || envelope.sourceTimestamp
    };
    if (!isUsageCacheFresh(timestampedData, options)) {
        if (!options.allowStale) return null;
        return { ...timestampedData, stale: true };
    }
    return timestampedData;
}

/**
 * 读取用量缓存文件
 * @param {Object} [options] - 缓存读取选项
 * @param {number|null} [options.maxAgeMs=DEFAULT_USAGE_CACHE_TTL_MS] - 最大缓存年龄；null 表示不做 TTL 判断
 * @param {Date|string|number} [options.now] - 测试用当前时间
 * @returns {Promise<Object|null>} 缓存的用量数据，如果不存在或读取失败则返回 null
 */
export async function readUsageCache(options = {}) {
    try {
        if (existsSync(USAGE_CACHE_FILE)) {
            const content = await fs.readFile(USAGE_CACHE_FILE, 'utf8');
            const cache = JSON.parse(content);
            if (!isUsageCacheFresh(cache, options)) {
                if (options.allowStale) {
                    logger.info('[Usage Cache] Returning stale usage data as last-known fallback');
                    return { ...cache, stale: true };
                }
                logger.info('[Usage Cache] Cached usage data is stale, ignoring cache');
                return null;
            }
            return cache;
        }
        return null;
    } catch (error) {
        logger.warn('[Usage Cache] Failed to read usage cache:', error.message);
        return null;
    }
}

/**
 * 读取供管理页面使用的轻量快照。进程内命中时不再读取或解析完整 raw cache。
 */
export async function readUsageDisplayCache(options = {}) {
    try {
        const memoryData = readDisplayEnvelopeData(inMemoryDisplayCache, options);
        if (memoryData) return memoryData;

        if (existsSync(USAGE_DISPLAY_CACHE_FILE)) {
            const content = await fs.readFile(USAGE_DISPLAY_CACHE_FILE, 'utf8');
            const envelope = JSON.parse(content);
            const displayData = readDisplayEnvelopeData(envelope, options);
            if (displayData) {
                inMemoryDisplayCache = envelope;
                return displayData;
            }
        }

        // 升级兼容：只有 raw cache 时迁移一次，不访问上游额度接口。
        const rawCache = await readUsageCache(options);
        if (!rawCache) return null;
        const envelope = createDisplayCacheEnvelope(rawCache);
        await atomicWriteFile(USAGE_DISPLAY_CACHE_FILE, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
        inMemoryDisplayCache = envelope;
        return readDisplayEnvelopeData(envelope, options);
    } catch (error) {
        logger.warn('[Usage Cache] Failed to read usage display cache:', error.message);
        return null;
    }
}

/**
 * 写入用量缓存文件
 * @param {Object} usageData - 用量数据
 */
export async function writeUsageCache(usageData) {
    try {
        const safeUsageData = await mergeUsageDataWithExistingLastSuccessfulUsage(usageData);
        await fs.mkdir(path.dirname(USAGE_CACHE_FILE), { recursive: true });
        await atomicWriteFile(USAGE_CACHE_FILE, JSON.stringify(safeUsageData, null, 2), { encoding: 'utf8', mode: 0o600 });
        logger.info('[Usage Cache] Usage data cached to', USAGE_CACHE_FILE);
        try {
            const displayEnvelope = createDisplayCacheEnvelope(safeUsageData);
            await atomicWriteFile(USAGE_DISPLAY_CACHE_FILE, JSON.stringify(displayEnvelope), { encoding: 'utf8', mode: 0o600 });
            inMemoryDisplayCache = displayEnvelope;
            logger.debug('[Usage Cache] Usage display snapshot updated');
        } catch (displayError) {
            logger.error('[Usage Cache] Failed to write usage display cache:', displayError.message);
        }
    } catch (error) {
        logger.error('[Usage Cache] Failed to write usage cache:', error.message);
    }
}

/**
 * 读取特定提供商类型的用量缓存
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Object|null>} 缓存的用量数据
 */
export async function readProviderUsageCache(providerType, options = {}) {
    const cache = await readUsageCache(options);
    if (cache && cache.providers && cache.providers[providerType]) {
        return {
            ...cache.providers[providerType],
            cachedAt: cache.timestamp,
            fromCache: true,
            stale: cache.stale === true
        };
    }
    return null;
}

/**
 * 更新特定提供商类型的用量缓存
 * @param {string} providerType - 提供商类型
 * @param {Object} usageData - 用量数据
 */
export async function updateProviderUsageCache(providerType, usageData) {
    let cache = await readUsageCache({ maxAgeMs: null });
    if (!cache) {
        cache = {
            timestamp: new Date().toISOString(),
            providers: {}
        };
    }
    cache.providers[providerType] = usageData;
    cache.timestamp = new Date().toISOString();
    await writeUsageCache(cache);
}
