import { atomicWriteFile, atomicWriteFileSync } from '../../utils/file-lock.js';
import { promises as fs } from 'fs';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';
import { RateManager } from '../../utils/rate-tracker.js';
import { getBeijingDateString } from '../../utils/common.js';
import { normalizeCodexRateLimitWindows } from '../../utils/codex-rate-limit.js';
import {
    extractUsage as extractNormalizedUsage,
    mergeUsage as mergeNormalizedUsage,
    normalizeUsageCandidate as normalizeSharedUsageCandidate
} from '../../utils/usage-normalizer.js';
import {
    hasAppliedModelUsageEvent,
    loadModelAccountUsageEvents,
    loadModelUsageState,
    persistModelUsageEvent,
    persistModelUsageState,
    closeModelUsageStore
} from './sqlite-store.js';

const STATS_STORE_FILE = path.join(process.cwd(), 'configs', 'model-usage-stats.json');
const USAGE_CACHE_FILE = path.join(process.cwd(), 'configs', 'usage-cache.json');
const DEFAULT_CONFIG = {
    persistDebounceMs: 30_000,
    maxDirtyAgeMs: 60_000
};
const ACCOUNT_EVENT_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
const ROLLING_5H_MS = 5 * 60 * 60 * 1000;
const USAGE_CACHE_SNAPSHOT_TTL_MS = 1000;
const PENDING_REQUEST_CLEANUP_INTERVAL_MS = 60_000;
const PERSIST_RETRY_DELAY_MS = 5_000;

let configGetter = null;
let statsStore = null;
let isDirty = false;
let dirtySince = null;
let debounceTimer = null;
let maxDirtyTimer = null;
let currentPersistDebounceMs = DEFAULT_CONFIG.persistDebounceMs;
let currentMaxDirtyAgeMs = DEFAULT_CONFIG.maxDirtyAgeMs;
let mutationVersion = 0;
let lastPersistedVersion = 0;
let persistPromise = null;
let persistenceStopped = false;
let retryNotBefore = 0;

const rateManager = new RateManager(60); // 使用 60 秒滑动窗口，更平滑
const pendingRequests = new Map();
let lastPendingCleanupAt = 0;
let usageCacheSnapshot = null;
let usageCacheSnapshotLoadedAt = 0;

function getTraceRequestId(requestId) {
    return requestId || 'N/A';
}

function getTracePrefix(requestId) {
    return `[Model Usage Stats][${getTraceRequestId(requestId)}]`;
}

function createEmptyUsage() {
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

function createDefaultStore() {
    return {
        updatedAt: null,
        summary: createEmptyUsage(),
        providers: {},
        accounts: {},
        accountUsageEvents: {},
        daily: {} // 新增每日统计
    };
}

function createDailyUsage() {
    return {
        ...createEmptyUsage(),
        models: {},
        accounts: {}
    };
}

function isEmailLike(value) {
    return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function normalizeEmail(value) {
    return isEmailLike(value) ? value.trim().toLowerCase() : null;
}

function isCodexEmailAccountProvider(provider) {
    return provider === 'openai-codex-oauth' || provider === 'openaiResponses-custom';
}

function getCanonicalAccountIdentity(provider, providerUuid, accountIdentity = null, accountEmail = null, providerName = null) {
    if (isCodexEmailAccountProvider(provider)) {
        const email = normalizeEmail(accountEmail) || normalizeEmail(accountIdentity) || normalizeEmail(providerName);
        if (!email) return null;
        return {
            provider: 'openai-codex-oauth',
            identity: email,
            accountEmail: email,
            providerUuid
        };
    }

    const identity = accountIdentity || providerUuid;
    if (!provider || !identity) return null;
    return {
        provider,
        identity,
        accountEmail: normalizeEmail(accountEmail),
        providerUuid
    };
}

function createAccountStore(provider, providerUuid, providerName = null, accountIdentity = null, accountEmail = null) {
    const canonical = getCanonicalAccountIdentity(provider, providerUuid, accountIdentity, accountEmail, providerName);
    const canonicalProvider = canonical?.provider || provider;
    const canonicalIdentity = canonical?.identity || accountIdentity || providerUuid;
    return {
        provider: canonicalProvider,
        providerUuid: canonicalIdentity,
        accountIdentity: canonicalIdentity || null,
        accountEmail: canonical?.accountEmail || normalizeEmail(accountEmail) || null,
        providerUuids: providerUuid ? [providerUuid] : [],
        providerName,
        summary: createEmptyUsage(),
        models: {}
    };
}

function normalizeUsageBlock(block) {
    const empty = createEmptyUsage();
    if (!block || typeof block !== 'object') return empty;
    return {
        requestCount: toNumber(block.requestCount),
        promptTokens: toNumber(block.promptTokens),
        completionTokens: toNumber(block.completionTokens),
        reasoningTokens: toNumber(block.reasoningTokens),
        totalTokens: toNumber(block.totalTokens),
        cachedTokens: toNumber(block.cachedTokens),
        maxQps: toNumber(block.maxQps),
        maxRpm: toNumber(block.maxRpm),
        maxTps: toNumber(block.maxTps),
        lastUsedAt: block.lastUsedAt || null
    };
}

function normalizeStore(store) {
    const normalizedStore = {
        updatedAt: store?.updatedAt || null,
        summary: normalizeUsageBlock(store?.summary),
        providers: {},
        accounts: {},
        accountUsageEvents: {},
        daily: {} // 新增每日统计
    };

    for (const [provider, providerStore] of Object.entries(store?.providers || {})) {
        normalizedStore.providers[provider] = {
            summary: normalizeUsageBlock(providerStore?.summary),
            models: {}
        };

        for (const [model, modelStore] of Object.entries(providerStore?.models || {})) {
            normalizedStore.providers[provider].models[model] = normalizeUsageBlock(modelStore);
        }
    }

    for (const [accountKey, accountStore] of Object.entries(store?.accounts || {})) {
        const [providerFromKey, uuidFromKey] = accountKey.split(':');
        const accountIdentity = accountStore?.accountIdentity || null;
        const providerUuid = accountStore?.providerUuid || uuidFromKey || 'unknown';
        normalizedStore.accounts[accountKey] = {
            provider: accountStore?.provider || providerFromKey || 'unknown',
            providerUuid,
            accountIdentity,
            accountEmail: normalizeEmail(accountStore?.accountEmail) || normalizeEmail(accountIdentity) || normalizeEmail(accountStore?.providerName) || null,
            providerUuids: Array.isArray(accountStore?.providerUuids)
                ? [...new Set(accountStore.providerUuids.filter(Boolean))]
                : (providerUuid ? [providerUuid] : []),
            providerName: accountStore?.providerName || null,
            summary: normalizeUsageBlock(accountStore?.summary),
            models: {}
        };

        for (const [model, modelStore] of Object.entries(accountStore?.models || {})) {
            normalizedStore.accounts[accountKey].models[model] = normalizeUsageBlock(modelStore);
        }
    }

    for (const [accountKey, events] of Object.entries(store?.accountUsageEvents || {})) {
        if (!Array.isArray(events)) continue;
        normalizedStore.accountUsageEvents[accountKey] = events
            .map(event => ({
                timestamp: event?.timestamp || null,
                totalTokens: toNumber(event?.totalTokens)
            }))
            .filter(event => event.timestamp && event.totalTokens > 0);
    }

    if (store?.daily) {
        for (const [date, dailyStore] of Object.entries(store.daily)) {
            normalizedStore.daily[date] = {
                ...normalizeUsageBlock(dailyStore),
                models: {},
                accounts: {}
            };

            for (const [model, modelStore] of Object.entries(dailyStore?.models || {})) {
                normalizedStore.daily[date].models[model] = normalizeUsageBlock(modelStore);
            }

            for (const [accountKey, accountStore] of Object.entries(dailyStore?.accounts || {})) {
                const [providerFromKey, uuidFromKey] = accountKey.split(':');
                const accountIdentity = accountStore?.accountIdentity || null;
                const providerUuid = accountStore?.providerUuid || uuidFromKey || 'unknown';
                normalizedStore.daily[date].accounts[accountKey] = {
                    provider: accountStore?.provider || providerFromKey || 'unknown',
                    providerUuid,
                    accountIdentity,
                    accountEmail: normalizeEmail(accountStore?.accountEmail) || normalizeEmail(accountIdentity) || normalizeEmail(accountStore?.providerName) || null,
                    providerUuids: Array.isArray(accountStore?.providerUuids)
                        ? [...new Set(accountStore.providerUuids.filter(Boolean))]
                        : (providerUuid ? [providerUuid] : []),
                    providerName: accountStore?.providerName || null,
                    summary: normalizeUsageBlock(accountStore?.summary),
                    models: {}
                };

                for (const [model, modelStore] of Object.entries(accountStore?.models || {})) {
                    normalizedStore.daily[date].accounts[accountKey].models[model] = normalizeUsageBlock(modelStore);
                }
            }
        }
    }

    return normalizedStore;
}

function getConfig() {
    if (typeof configGetter === 'function') {
        return configGetter();
    }
    return DEFAULT_CONFIG;
}

function normalizeDurationMs(value, fallback) {
    const normalized = Number(value);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

function applyPersistenceConfig(config = {}) {
    currentPersistDebounceMs = normalizeDurationMs(
        config.persistDebounceMs ?? config.persistInterval,
        DEFAULT_CONFIG.persistDebounceMs
    );
    currentMaxDirtyAgeMs = normalizeDurationMs(
        config.maxDirtyAgeMs,
        DEFAULT_CONFIG.maxDirtyAgeMs
    );
}

function ensureProviderStore(provider) {
    ensureLoaded();
    if (!statsStore.providers[provider]) {
        statsStore.providers[provider] = {
            summary: createEmptyUsage(),
            models: {}
        };
    }
    return statsStore.providers[provider];
}

function ensureModelStore(provider, model) {
    const providerStore = ensureProviderStore(provider);
    if (!providerStore.models[model]) {
        providerStore.models[model] = createEmptyUsage();
    }
    return providerStore.models[model];
}

function getAccountKey(provider, providerUuid, accountIdentity = null, accountEmail = null, providerName = null) {
    const canonical = getCanonicalAccountIdentity(provider, providerUuid, accountIdentity, accountEmail, providerName);
    if (!canonical?.provider || !canonical?.identity) return null;
    return `${canonical.provider}:${canonical.identity}`;
}

function addProviderUuidToAccount(accountStore, providerUuid) {
    if (!accountStore || !providerUuid) return;
    const existing = Array.isArray(accountStore.providerUuids) ? accountStore.providerUuids : [];
    accountStore.providerUuids = [...new Set([...existing, providerUuid].filter(Boolean))];
}

function ensureAccountStore(provider, providerUuid, providerName = null, accountIdentity = null, accountEmail = null) {
    ensureLoaded();
    const accountKey = getAccountKey(provider, providerUuid, accountIdentity, accountEmail, providerName);
    if (!accountKey) return null;
    const canonical = getCanonicalAccountIdentity(provider, providerUuid, accountIdentity, accountEmail, providerName);

    if (!statsStore.accounts[accountKey]) {
        statsStore.accounts[accountKey] = createAccountStore(provider, providerUuid, providerName, accountIdentity, accountEmail);
    }

    if (canonical?.identity) {
        statsStore.accounts[accountKey].provider = canonical.provider;
        statsStore.accounts[accountKey].accountIdentity = canonical.identity;
        statsStore.accounts[accountKey].providerUuid = canonical.identity;
    }
    if (canonical?.accountEmail) {
        statsStore.accounts[accountKey].accountEmail = canonical.accountEmail;
    }
    addProviderUuidToAccount(statsStore.accounts[accountKey], providerUuid);

    if (providerName && !statsStore.accounts[accountKey].providerName) {
        statsStore.accounts[accountKey].providerName = providerName;
    }

    return statsStore.accounts[accountKey];
}

function ensureAccountModelStore(provider, providerUuid, providerName, model, accountIdentity = null, accountEmail = null) {
    const accountStore = ensureAccountStore(provider, providerUuid, providerName, accountIdentity, accountEmail);
    if (!accountStore) return null;

    if (!accountStore.models[model]) {
        accountStore.models[model] = createEmptyUsage();
    }

    return accountStore.models[model];
}

function ensureDailyStore(dateKey) {
    ensureLoaded();
    if (!statsStore.daily[dateKey]) {
        statsStore.daily[dateKey] = createDailyUsage();
    } else {
        statsStore.daily[dateKey].models = statsStore.daily[dateKey].models || {};
        statsStore.daily[dateKey].accounts = statsStore.daily[dateKey].accounts || {};
    }
    return statsStore.daily[dateKey];
}

function ensureDailyModelStore(dateKey, model) {
    const dailyStore = ensureDailyStore(dateKey);
    if (!dailyStore.models[model]) {
        dailyStore.models[model] = createEmptyUsage();
    }
    return dailyStore.models[model];
}

function ensureDailyAccountStore(dateKey, provider, providerUuid, providerName = null, accountIdentity = null, accountEmail = null) {
    const accountKey = getAccountKey(provider, providerUuid, accountIdentity, accountEmail, providerName);
    if (!accountKey) return null;
    const canonical = getCanonicalAccountIdentity(provider, providerUuid, accountIdentity, accountEmail, providerName);

    const dailyStore = ensureDailyStore(dateKey);
    if (!dailyStore.accounts[accountKey]) {
        dailyStore.accounts[accountKey] = createAccountStore(provider, providerUuid, providerName, accountIdentity, accountEmail);
    }

    if (canonical?.identity) {
        dailyStore.accounts[accountKey].provider = canonical.provider;
        dailyStore.accounts[accountKey].accountIdentity = canonical.identity;
        dailyStore.accounts[accountKey].providerUuid = canonical.identity;
    }
    if (canonical?.accountEmail) {
        dailyStore.accounts[accountKey].accountEmail = canonical.accountEmail;
    }
    addProviderUuidToAccount(dailyStore.accounts[accountKey], providerUuid);

    if (providerName && !dailyStore.accounts[accountKey].providerName) {
        dailyStore.accounts[accountKey].providerName = providerName;
    }

    return dailyStore.accounts[accountKey];
}

function ensureDailyAccountModelStore(dateKey, provider, providerUuid, providerName, model, accountIdentity = null, accountEmail = null) {
    const dailyAccountStore = ensureDailyAccountStore(dateKey, provider, providerUuid, providerName, accountIdentity, accountEmail);
    if (!dailyAccountStore) return null;

    if (!dailyAccountStore.models[model]) {
        dailyAccountStore.models[model] = createEmptyUsage();
    }

    return dailyAccountStore.models[model];
}

function ensureLoaded() {
    if (statsStore !== null) return;

    try {
        const sqliteState = loadModelUsageState();
        if (sqliteState) {
            statsStore = normalizeStore(sqliteState);
            logger.info(`[Model Usage Stats] Loaded SQLite stats store: providers=${Object.keys(statsStore.providers).length}, requests=${statsStore.summary.requestCount}, totalTokens=${statsStore.summary.totalTokens}`);
        } else if (existsSync(STATS_STORE_FILE)) {
            const content = readFileSync(STATS_STORE_FILE, 'utf8');
            statsStore = normalizeStore(JSON.parse(content));
            persistModelUsageState(statsStore);
            logger.info(`[Model Usage Stats] Loaded stats store: providers=${Object.keys(statsStore.providers).length}, requests=${statsStore.summary.requestCount}, totalTokens=${statsStore.summary.totalTokens}`);
        } else {
            statsStore = createDefaultStore();
            syncWriteToFile();
            logger.info('[Model Usage Stats] Created new stats store');
        }
    } catch (error) {
        logger.error('[Model Usage Stats] Failed to load stats store:', error.message);
        statsStore = createDefaultStore();
    }

    applyPersistenceConfig(getConfig());
}

export function syncWriteToFile() {
    try {
        if (!statsStore || !isDirty) return;
        clearPersistenceTimers();
        const dir = path.dirname(STATS_STORE_FILE);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        const heapUsedBefore = process.memoryUsage().heapUsed;
        const startedAt = process.hrtime.bigint();
        const snapshot = JSON.stringify(statsStore);
        const snapshotBytes = Buffer.byteLength(snapshot, 'utf8');
        atomicWriteFileSync(STATS_STORE_FILE, snapshot, { encoding: 'utf8', mode: 0o600 });
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const heapUsedAfter = process.memoryUsage().heapUsed;
        isDirty = false;
        dirtySince = null;
        lastPersistedVersion = mutationVersion;
        retryNotBefore = 0;
        logger.info(`[Model Usage Stats] Sync persisted stats store: snapshotBytes=${snapshotBytes}, durationMs=${durationMs.toFixed(2)}, heapUsedBefore=${heapUsedBefore}, heapUsedAfter=${heapUsedAfter}`);
    } catch (error) {
        logger.error('[Model Usage Stats] Sync write failed:', error.message);
    }
}

function clearPersistenceTimers() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (maxDirtyTimer) {
        clearTimeout(maxDirtyTimer);
        maxDirtyTimer = null;
    }
}

function unrefTimer(timer) {
    if (timer?.unref) {
        timer.unref();
    }
}

function schedulePersistenceTimers() {
    if (persistenceStopped || !isDirty || statsStore === null) return;

    const now = Date.now();
    const retryDelay = Math.max(0, retryNotBefore - now);
    const debounceDelay = retryDelay > 0 ? retryDelay : currentPersistDebounceMs;

    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(async () => {
        debounceTimer = null;
        cleanupPendingRequests();
        await flushStatsPersistence();
    }, debounceDelay);
    unrefTimer(debounceTimer);

    if (!maxDirtyTimer) {
        const elapsedDirtyMs = dirtySince === null ? 0 : Math.max(0, now - dirtySince);
        const remainingDirtyMs = Math.max(0, currentMaxDirtyAgeMs - elapsedDirtyMs);
        const maxDirtyDelay = Math.max(remainingDirtyMs, retryDelay);
        maxDirtyTimer = setTimeout(async () => {
            maxDirtyTimer = null;
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
            cleanupPendingRequests();
            await flushStatsPersistence();
        }, maxDirtyDelay);
        unrefTimer(maxDirtyTimer);
    }
}

function getPersistRetryDelayMs() {
    return Math.max(PERSIST_RETRY_DELAY_MS, currentPersistDebounceMs);
}

async function persistStatsSnapshot({ rescheduleOnFailure = true } = {}) {
    if (persistPromise) return persistPromise;
    if (!isDirty || statsStore === null) return true;

    clearPersistenceTimers();

    const versionAtStart = mutationVersion;
    const dirtySinceAtStart = dirtySince;
    const heapUsedBefore = process.memoryUsage().heapUsed;
    const startedAt = process.hrtime.bigint();
    let snapshot;
    try {
        snapshot = JSON.stringify(statsStore);
    } catch (error) {
        retryNotBefore = Date.now() + getPersistRetryDelayMs();
        logger.error('[Model Usage Stats] Snapshot serialization failed:', error.message);
        if (!persistenceStopped && rescheduleOnFailure) schedulePersistenceTimers();
        return false;
    }
    const snapshotBytes = Buffer.byteLength(snapshot, 'utf8');

    // 当前快照接管已有 dirty；写入期间的新 mutation 会重新标脏并延后处理。
    isDirty = false;
    dirtySince = null;

    persistPromise = (async () => {
        try {
            const dir = path.dirname(STATS_STORE_FILE);
            if (!existsSync(dir)) {
                await fs.mkdir(dir, { recursive: true });
            }

            await atomicWriteFile(STATS_STORE_FILE, snapshot, { encoding: 'utf8', mode: 0o600 });

            lastPersistedVersion = Math.max(lastPersistedVersion, versionAtStart);
            retryNotBefore = 0;
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
            const heapUsedAfter = process.memoryUsage().heapUsed;
            const versionAfterWrite = mutationVersion;
            logger.info(`[Model Usage Stats] Persisted stats store: version=${versionAtStart}, versionAfterWrite=${versionAfterWrite}, snapshotBytes=${snapshotBytes}, durationMs=${durationMs.toFixed(2)}, heapUsedBefore=${heapUsedBefore}, heapUsedAfter=${heapUsedAfter}, requests=${statsStore.summary.requestCount}, totalTokens=${statsStore.summary.totalTokens}`);
            return true;
        } catch (error) {
            isDirty = true;
            dirtySince = dirtySince === null
                ? (dirtySinceAtStart ?? Date.now())
                : Math.min(dirtySince, dirtySinceAtStart ?? dirtySince);
            retryNotBefore = Date.now() + getPersistRetryDelayMs();
            logger.error('[Model Usage Stats] Persist failed:', error.message);
            return false;
        } finally {
            persistPromise = null;
            if (isDirty && !persistenceStopped && rescheduleOnFailure) {
                schedulePersistenceTimers();
            }
        }
    })();

    return await persistPromise;
}

export async function flushStatsPersistence({ targetVersion = mutationVersion, rescheduleOnFailure = true } = {}) {
    ensureLoaded();
    while (lastPersistedVersion < targetVersion) {
        clearPersistenceTimers();
        if (!persistPromise && !isDirty) {
            logger.error(`[Model Usage Stats] Persistence stalled before version ${targetVersion}`);
            return false;
        }
        const persisted = await (persistPromise || persistStatsSnapshot({ rescheduleOnFailure }));
        if (!persisted) return false;
    }
    return true;
}

export async function shutdownStatsPersistence() {
    const targetVersion = mutationVersion;
    persistenceStopped = true;
    clearPersistenceTimers();
    let persisted = await flushStatsPersistence({ targetVersion, rescheduleOnFailure: false });
    if (!persisted) {
        retryNotBefore = 0;
        persisted = await flushStatsPersistence({ targetVersion, rescheduleOnFailure: false });
    }
    clearPersistenceTimers();
    closeModelUsageStore();
    return persisted;
}

function markDirty() {
    ensureLoaded();
    statsStore.updatedAt = new Date().toISOString();
    mutationVersion += 1;
    if (!isDirty || dirtySince === null) {
        dirtySince = Date.now();
    }
    isDirty = true;
    schedulePersistenceTimers();
    return mutationVersion;
}

function cleanupPendingRequests(now = Date.now()) {
    let removedCount = 0;
    for (const [requestId, state] of pendingRequests.entries()) {
        if (now - state.updatedAt > 10 * 60 * 1000) {
            pendingRequests.delete(requestId);
            removedCount += 1;
            logger.warn(`${getTracePrefix(requestId)} Dropped stale pending request: Provider: ${state.provider} | Model: ${state.model}`);
        }
    }
    if (removedCount > 0) {
        logger.warn(`[Model Usage Stats] Cleaned stale pending requests: count=${removedCount}`);
    }
}

function maybeCleanupPendingRequests() {
    const now = Date.now();
    if (now - lastPendingCleanupAt < PENDING_REQUEST_CLEANUP_INTERVAL_MS) return;
    lastPendingCleanupAt = now;
    cleanupPendingRequests(now);
}

function toNumber(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function readUsageCacheSnapshot() {
    const now = Date.now();
    if (now - usageCacheSnapshotLoadedAt < USAGE_CACHE_SNAPSHOT_TTL_MS) {
        return usageCacheSnapshot;
    }

    usageCacheSnapshotLoadedAt = now;
    try {
        if (!existsSync(USAGE_CACHE_FILE)) {
            usageCacheSnapshot = null;
            return usageCacheSnapshot;
        }
        usageCacheSnapshot = JSON.parse(readFileSync(USAGE_CACHE_FILE, 'utf8'));
        return usageCacheSnapshot;
    } catch (error) {
        logger.warn('[Request Audit] Failed to read usage cache:', error.message);
        usageCacheSnapshot = null;
        return usageCacheSnapshot;
    }
}

function getPercentFromUsageItem(usage, id, label) {
    const items = Array.isArray(usage?.items) ? usage.items : [];
    const item = items.find(entry => entry?.id === id || entry?.key === id || entry?.name === id || entry?.label === label);
    const percent = Number(item?.percent ?? item?.usedPercent ?? item?.used);
    return Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : null;
}

function getPercentFromRateLimitWindow(usage, windowKey) {
    const rateLimit = usage?.raw?.rate_limit || usage?.raw?.rateLimit || usage?.rate_limit || usage?.rateLimit;
    const windowData = rateLimit?.[windowKey] || rateLimit?.[windowKey.replace('_', '')];
    const percent = Number(windowData?.used_percent ?? windowData?.usedPercent ?? windowData?.percent ?? windowData?.used);
    return Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : null;
}

function getPercentFromSemanticWindow(usage, windowKind) {
    const items = Array.isArray(usage?.items) ? usage.items : [];
    const item = items.find(entry =>
        entry?.windowKind === windowKind &&
        (entry?.scope === 'general' || entry?.id === 'primary_window' || entry?.id === 'secondary_window')
    );
    const itemPercent = Number(item?.percent ?? item?.usedPercent ?? item?.used);
    if (Number.isFinite(itemPercent)) return Math.min(Math.max(itemPercent, 0), 100);

    const rawWindows = normalizeCodexRateLimitWindows(usage?.raw || {});
    const rawWindow = rawWindows.find(entry => entry.scope === 'general' && entry.windowKind === windowKind);
    const rawPercent = Number(rawWindow?.usedPercent);
    return Number.isFinite(rawPercent) ? Math.min(Math.max(rawPercent, 0), 100) : null;
}

function formatPercent(value) {
    if (!Number.isFinite(Number(value))) return 'unavailable';
    const rounded = Math.round(Number(value) * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatUsageWindow(label, usedPercent) {
    if (usedPercent === null) {
        return `${label}: unavailable`;
    }
    const remainingPercent = Math.max(0, 100 - usedPercent);
    return `${label}: ${formatPercent(usedPercent)}% used/${formatPercent(remainingPercent)}% remaining`;
}

function getAccountUsageSnapshot(provider, providerUuid) {
    if (!provider || !providerUuid) {
        return {
            cacheAgeMs: null,
            fiveHourPercent: null,
            weeklyPercent: null
        };
    }

    const cache = readUsageCacheSnapshot();
    if (!cache?.providers) {
        return {
            cacheAgeMs: null,
            fiveHourPercent: null,
            weeklyPercent: null
        };
    }

    const providerCache = cache.providers[provider];
    const instances = Array.isArray(providerCache?.instances) ? providerCache.instances : [];
    const matched = instances.find(instance => {
        const uuid = instance?.uuid || instance?.providerUuid || instance?.config?.uuid;
        return uuid === providerUuid;
    });
    const usage = matched?.usage || null;
    const cacheTimestampMs = Date.parse(cache.timestamp || '');
    const cacheAgeMs = Number.isFinite(cacheTimestampMs) ? Math.max(0, Date.now() - cacheTimestampMs) : null;

    const hasSemanticWindows = (Array.isArray(usage?.items) ? usage.items : []).some(entry => entry?.windowKind)
        || normalizeCodexRateLimitWindows(usage?.raw || {}).some(entry => entry.scope === 'general' && entry.windowKind !== 'unknown');
    return {
        cacheAgeMs,
        fiveHourPercent: getPercentFromSemanticWindow(usage, 'short')
            ?? (hasSemanticWindows ? null : (
                getPercentFromUsageItem(usage, 'primary_window', 'Request Quota (5h)')
                ?? getPercentFromRateLimitWindow(usage, 'primary_window')
            )),
        weeklyPercent: getPercentFromSemanticWindow(usage, 'weekly')
            ?? (hasSemanticWindows ? null : (
                getPercentFromUsageItem(usage, 'secondary_window', 'Weekly Limit')
                ?? getPercentFromRateLimitWindow(usage, 'secondary_window')
            ))
    };
}

function normalizeUsageCandidate(candidate) {
    const usage = normalizeSharedUsageCandidate(candidate);
    if (!usage) return null;
    return Object.values(usage).some(value => value > 0) ? usage : null;
}

function mergeUsage(baseUsage, nextUsage) {
    return mergeNormalizedUsage(baseUsage, nextUsage);
}

function extractUsage(...candidates) {
    return extractNormalizedUsage(...candidates);
}

function getPendingRequest(requestId, meta = {}) {
    ensureLoaded();
    maybeCleanupPendingRequests();

    if (!pendingRequests.has(requestId)) {
        pendingRequests.set(requestId, {
            requestId,
            model: meta.model || 'unknown',
            provider: meta.provider || 'unknown',
            providerUuid: meta.providerUuid || null,
            accountIdentity: meta.accountIdentity || null,
            accountEmail: normalizeEmail(meta.accountEmail) || null,
            providerName: meta.providerName || null,
            fromProvider: meta.fromProvider || null,
            isStream: Boolean(meta.isStream),
            hasResponse: false,
            usage: {
                promptTokens: 0,
                completionTokens: 0,
                reasoningTokens: 0,
                totalTokens: 0,
                cachedTokens: 0
            },
            updatedAt: Date.now()
        });
    }

    const state = pendingRequests.get(requestId);
    state.model = meta.model || state.model;
    state.provider = meta.provider || state.provider;
    state.providerUuid = state.providerUuid || meta.providerUuid || null;
    state.accountIdentity = state.accountIdentity || meta.accountIdentity || null;
    state.accountEmail = state.accountEmail || normalizeEmail(meta.accountEmail) || null;
    state.providerName = state.providerName || meta.providerName || null;
    state.fromProvider = meta.fromProvider || state.fromProvider;
    state.isStream = meta.isStream ?? state.isStream;
    state.updatedAt = Date.now();

    return state;
}

function applyUsage(target, usage, timestamp) {
    target.requestCount += 1;
    target.promptTokens += usage.promptTokens;
    target.completionTokens += usage.completionTokens;
    target.reasoningTokens += usage.reasoningTokens || 0;
    target.totalTokens += usage.totalTokens || (usage.promptTokens + usage.completionTokens);
    target.cachedTokens += usage.cachedTokens;
    target.lastUsedAt = timestamp;
}

function resetUsageBlockTokens(block) {
    if (!block || typeof block !== 'object') return;
    block.promptTokens = 0;
    block.completionTokens = 0;
    block.reasoningTokens = 0;
    block.totalTokens = 0;
    block.cachedTokens = 0;
    block.maxQps = 0;
    block.maxRpm = 0;
    block.maxTps = 0;
}

function getBeijingDateStringFromDate(date) {
    const source = date instanceof Date ? date : new Date(date);
    const utc8Time = new Date(source.getTime() + (8 * 60 * 60 * 1000));
    return utc8Time.toISOString().split('T')[0];
}

function getCurrentBeijingWeekDateKeys(now = new Date()) {
    const utc8Time = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    const year = utc8Time.getUTCFullYear();
    const month = utc8Time.getUTCMonth();
    const day = utc8Time.getUTCDate();
    const dayOfWeek = utc8Time.getUTCDay();
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const mondayMs = Date.UTC(year, month, day) - daysSinceMonday * 24 * 60 * 60 * 1000;
    const keys = new Set();
    for (let offset = 0; offset < 7; offset++) {
        keys.add(new Date(mondayMs + offset * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
    }
    return keys;
}

function getNextBeijingWeekStartTime(now = new Date()) {
    const utc8Time = new Date(now.getTime() + (8 * 60 * 60 * 1000));
    const year = utc8Time.getUTCFullYear();
    const month = utc8Time.getUTCMonth();
    const day = utc8Time.getUTCDate();
    const dayOfWeek = utc8Time.getUTCDay();
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const mondayMs = Date.UTC(year, month, day) - daysSinceMonday * 24 * 60 * 60 * 1000;
    return new Date(mondayMs + 7 * 24 * 60 * 60 * 1000 - 8 * 60 * 60 * 1000);
}

function getRollingRecoveryTime(events, limit, rollingWindowMs, nowMs) {
    const tokenLimit = toNumber(limit);
    if (!Number.isFinite(tokenLimit) || tokenLimit <= 0) return null;

    const rollingEvents = events
        .map(event => ({
            eventMs: Date.parse(event.timestamp),
            totalTokens: toNumber(event.totalTokens)
        }))
        .filter(event => Number.isFinite(event.eventMs)
            && event.eventMs >= nowMs - rollingWindowMs
            && event.eventMs <= nowMs
            && event.totalTokens > 0)
        .sort((a, b) => a.eventMs - b.eventMs);

    let runningTotal = rollingEvents.reduce((sum, event) => sum + event.totalTokens, 0);
    if (runningTotal < tokenLimit) return null;

    for (const event of rollingEvents) {
        runningTotal -= event.totalTokens;
        if (runningTotal < tokenLimit) {
            return new Date(event.eventMs + rollingWindowMs + 1).toISOString();
        }
    }

    return null;
}

function cleanupAccountUsageEvents(nowMs = Date.now(), onlyAccountKey = null) {
    if (!statsStore?.accountUsageEvents) return;
    const cutoff = nowMs - ACCOUNT_EVENT_RETENTION_MS;
    for (const [accountKey, events] of Object.entries(statsStore.accountUsageEvents)) {
        if (onlyAccountKey && accountKey !== onlyAccountKey) continue;
        if (!Array.isArray(events)) {
            delete statsStore.accountUsageEvents[accountKey];
            continue;
        }
        let firstRetainedIndex = 0;
        while (
            firstRetainedIndex < events.length
            && Date.parse(events[firstRetainedIndex]?.timestamp) < cutoff
        ) {
            firstRetainedIndex += 1;
        }
        if (firstRetainedIndex > 0) events.splice(0, firstRetainedIndex);
        if (events.length > 0) {
            statsStore.accountUsageEvents[accountKey] = events;
        } else {
            delete statsStore.accountUsageEvents[accountKey];
        }
    }
}

function recordAccountUsageEvent(provider, providerUuid, usage, timestamp, accountIdentity = null, accountEmail = null, providerName = null) {
    const accountKey = getAccountKey(provider, providerUuid, accountIdentity, accountEmail, providerName);
    if (!accountKey) return null;
    statsStore.accountUsageEvents = statsStore.accountUsageEvents || {};
    const existed = Array.isArray(statsStore.accountUsageEvents[accountKey]);
    if (!statsStore.accountUsageEvents[accountKey]) {
        statsStore.accountUsageEvents[accountKey] = [];
    }
    const events = statsStore.accountUsageEvents[accountKey];
    const cutoff = Date.parse(timestamp) - ACCOUNT_EVENT_RETENTION_MS;
    let firstRetainedIndex = 0;
    while (
        firstRetainedIndex < events.length
        && Date.parse(events[firstRetainedIndex]?.timestamp) < cutoff
    ) {
        firstRetainedIndex += 1;
    }
    const removedEvents = firstRetainedIndex > 0
        ? events.splice(0, firstRetainedIndex)
        : [];
    const previousLength = events.length;
    events.push({
        timestamp,
        totalTokens: usage.totalTokens || (usage.promptTokens + usage.completionTokens)
    });
    return { accountKey, existed, previousLength, removedEvents };
}

function addCacheHitRatio(block) {
    if (!block || typeof block !== 'object') return;
    const promptTokens = toNumber(block.promptTokens);
    block.cacheHitRatio = promptTokens > 0 ? block.cachedTokens / promptTokens : 0;
}

function addDerivedUsageMetricsToTree(value) {
    if (!value || typeof value !== 'object') return;

    if (
        Object.prototype.hasOwnProperty.call(value, 'promptTokens') ||
        Object.prototype.hasOwnProperty.call(value, 'cachedTokens')
    ) {
        addCacheHitRatio(value);
    }

    for (const child of Object.values(value)) {
        if (child && typeof child === 'object') {
            addDerivedUsageMetricsToTree(child);
        }
    }
}

function resetUsageTokensInTree(value) {
    if (!value || typeof value !== 'object') return;

    if (
        Object.prototype.hasOwnProperty.call(value, 'promptTokens') ||
        Object.prototype.hasOwnProperty.call(value, 'cachedTokens')
    ) {
        resetUsageBlockTokens(value);
    }

    for (const child of Object.values(value)) {
        if (child && typeof child === 'object') {
            resetUsageTokensInTree(child);
        }
    }
}

export function setConfigGetter(getter) {
    configGetter = getter;
    persistenceStopped = false;
    if (statsStore !== null) {
        applyPersistenceConfig(getConfig());
        if (isDirty) {
            clearPersistenceTimers();
            schedulePersistenceTimers();
        }
    }
}

export function recordUnaryUsage({ requestId, model, provider, providerUuid, providerName, accountIdentity, accountEmail, fromProvider, nativeResponse, clientResponse }) {
    if (!requestId) return;
    const state = getPendingRequest(requestId, { model, provider, providerUuid, providerName, accountIdentity, accountEmail, fromProvider, isStream: false });
    const prevTotalTokens = state.usage.totalTokens;
    const prevCachedTokens = state.usage.cachedTokens;
    state.hasResponse = true;
    state.usage = mergeUsage(state.usage, extractUsage(nativeResponse, clientResponse));
    if (state.usage.totalTokens > prevTotalTokens || state.usage.cachedTokens > prevCachedTokens) {
        logger.debug(`${getTracePrefix(requestId)} <<< Unary Usage Captured: Provider: ${state.provider} | Model: ${state.model} | Prompt: ${state.usage.promptTokens} | Completion: ${state.usage.completionTokens} | Reasoning: ${state.usage.reasoningTokens || 0} | Total: ${state.usage.totalTokens} | Cached: ${state.usage.cachedTokens}`);
    }
}

export function recordStreamChunkUsage({ requestId, model, provider, providerUuid, providerName, accountIdentity, accountEmail, fromProvider, nativeChunk, clientChunk }) {
    if (!requestId) return;
    const state = getPendingRequest(requestId, { model, provider, providerUuid, providerName, accountIdentity, accountEmail, fromProvider, isStream: true });
    const prevTotalTokens = state.usage.totalTokens;
    const prevCachedTokens = state.usage.cachedTokens;
    state.hasResponse = true;
    state.usage = mergeUsage(state.usage, extractUsage(nativeChunk, clientChunk));
    if (state.usage.totalTokens > prevTotalTokens || state.usage.cachedTokens > prevCachedTokens) {
        logger.debug(`${getTracePrefix(requestId)} <<< Stream Usage Captured: Provider: ${state.provider} | Model: ${state.model} | Prompt: ${state.usage.promptTokens} | Completion: ${state.usage.completionTokens} | Reasoning: ${state.usage.reasoningTokens || 0} | Total: ${state.usage.totalTokens} | Cached: ${state.usage.cachedTokens}`);
    }
}

export async function finalizeRequest({ requestId, model, provider, providerUuid, providerName, accountIdentity, accountEmail, fromProvider, isStream, runtimeEventId = null }) {
    if (!requestId) {
        logger.warn(`${getTracePrefix(null)} Skip finalize: missing requestId`);
        return false;
    }

    const state = getPendingRequest(requestId, { model, provider, providerUuid, providerName, accountIdentity, accountEmail, fromProvider, isStream });
    
    // 防重逻辑：如果该请求已经处理过速率统计，则直接删除并返回
    if (state.rateRecorded) {
        pendingRequests.delete(requestId);
        return true;
    }
    state.rateRecorded = true;

    pendingRequests.delete(requestId);

    if (!state.hasResponse) {
        logger.warn(`${getTracePrefix(requestId)} Skip finalize: no response captured. Provider: ${state.provider} | Model: ${state.model}`);
        return false;
    }

    if (runtimeEventId && hasAppliedModelUsageEvent(runtimeEventId)) {
        return true;
    }

    const now = new Date();
    const timestamp = now.toISOString();
    const dateKey = getBeijingDateString();
    const normalizedProvider = state.provider || provider || 'unknown';
    const normalizedModel = state.model || model || 'unknown';
    const normalizedProviderUuid = state.providerUuid || providerUuid || null;
    const normalizedAccountIdentity = state.accountIdentity || accountIdentity || null;
    const normalizedAccountEmail = state.accountEmail || normalizeEmail(accountEmail) || null;
    const normalizedProviderName = state.providerName || providerName || null;
    const normalizedAccountKey = getAccountKey(
        normalizedProvider,
        normalizedProviderUuid,
        normalizedAccountIdentity,
        normalizedAccountEmail,
        normalizedProviderName
    );
    const snapshotEntry = (collection, key) => ({
        existed: Boolean(key) && Object.prototype.hasOwnProperty.call(collection || {}, key),
        value: key && Object.prototype.hasOwnProperty.call(collection || {}, key)
            ? structuredClone(collection[key])
            : null
    });
    const durableRollbackState = runtimeEventId ? {
        summary: structuredClone(statsStore.summary),
        provider: snapshotEntry(statsStore.providers, normalizedProvider),
        account: snapshotEntry(statsStore.accounts, normalizedAccountKey),
        daily: snapshotEntry(statsStore.daily, dateKey),
        accountEvents: null
    } : null;
    
    const usage = {
        promptTokens: state.usage.promptTokens,
        completionTokens: state.usage.completionTokens,
        reasoningTokens: state.usage.reasoningTokens || 0,
        totalTokens: state.usage.totalTokens || (state.usage.promptTokens + state.usage.completionTokens),
        cachedTokens: state.usage.cachedTokens
    };

    applyUsage(statsStore.summary, usage, timestamp);
    applyUsage(ensureProviderStore(normalizedProvider).summary, usage, timestamp);
    applyUsage(ensureModelStore(normalizedProvider, normalizedModel), usage, timestamp);

    const accountStore = ensureAccountStore(normalizedProvider, normalizedProviderUuid, normalizedProviderName, normalizedAccountIdentity, normalizedAccountEmail);
    let accountEventMutation = null;
    let durableAccountEvent = null;
    if (accountStore) {
        applyUsage(accountStore.summary, usage, timestamp);
        applyUsage(ensureAccountModelStore(normalizedProvider, normalizedProviderUuid, normalizedProviderName, normalizedModel, normalizedAccountIdentity, normalizedAccountEmail), usage, timestamp);
        if (runtimeEventId) {
            durableAccountEvent = {
                timestamp,
                totalTokens: usage.totalTokens || (usage.promptTokens + usage.completionTokens)
            };
        } else {
            accountEventMutation = recordAccountUsageEvent(normalizedProvider, normalizedProviderUuid, usage, timestamp, normalizedAccountIdentity, normalizedAccountEmail, normalizedProviderName);
        }
    }

    // 记录速率统计
    rateManager.record(`provider:${normalizedProvider}`, usage.totalTokens);
    rateManager.record(`model:${normalizedModel}`, usage.totalTokens);
    if (normalizedAccountKey) {
        rateManager.record(`account:${normalizedAccountKey}`, usage.totalTokens);
    }

    const globalRates = rateManager.getGlobalStats();
    const usageSnapshot = getAccountUsageSnapshot(normalizedProvider, normalizedProviderUuid);
    
    // 更新持久化峰值
    const updatePeaks = (target) => {
        target.maxQps = Math.max(target.maxQps || 0, globalRates.qps);
        target.maxRpm = Math.max(target.maxRpm || 0, globalRates.rpm);
        target.maxTps = Math.max(target.maxTps || 0, globalRates.tps);
    };

    updatePeaks(statsStore.summary);
    updatePeaks(ensureProviderStore(normalizedProvider).summary);
    updatePeaks(ensureModelStore(normalizedProvider, normalizedModel));
    if (accountStore) {
        updatePeaks(accountStore.summary);
        updatePeaks(ensureAccountModelStore(normalizedProvider, normalizedProviderUuid, normalizedProviderName, normalizedModel, normalizedAccountIdentity, normalizedAccountEmail));
    }

    const dailyBlock = ensureDailyStore(dateKey);
    applyUsage(dailyBlock, usage, timestamp);
    applyUsage(ensureDailyModelStore(dateKey, normalizedModel), usage, timestamp);
    updatePeaks(dailyBlock);
    updatePeaks(ensureDailyModelStore(dateKey, normalizedModel));

    const dailyAccountStore = ensureDailyAccountStore(dateKey, normalizedProvider, normalizedProviderUuid, normalizedProviderName, normalizedAccountIdentity, normalizedAccountEmail);
    if (dailyAccountStore) {
        applyUsage(dailyAccountStore.summary, usage, timestamp);
        applyUsage(ensureDailyAccountModelStore(dateKey, normalizedProvider, normalizedProviderUuid, normalizedProviderName, normalizedModel, normalizedAccountIdentity, normalizedAccountEmail), usage, timestamp);
        updatePeaks(dailyAccountStore.summary);
        updatePeaks(ensureDailyAccountModelStore(dateKey, normalizedProvider, normalizedProviderUuid, normalizedProviderName, normalizedModel, normalizedAccountIdentity, normalizedAccountEmail));
    }

    logger.debug(`[Request Audit][${requestId}] Provider: ${normalizedProvider} | Account: ${normalizedProviderName || 'unknown'} | UUID: ${normalizedProviderUuid || 'unknown'} | Model: ${normalizedModel} | ${formatUsageWindow('5h', usageSnapshot.fiveHourPercent)} | ${formatUsageWindow('Weekly', usageSnapshot.weeklyPercent)} | UsageCacheAgeMs: ${usageSnapshot.cacheAgeMs ?? 'unavailable'} | Prompt: ${usage.promptTokens} | Completion: ${usage.completionTokens} | Reasoning: ${usage.reasoningTokens} | Total: ${usage.totalTokens} | Cached: ${usage.cachedTokens} | Stream: ${Boolean(state.isStream)}`);
    logger.debug(`${getTracePrefix(requestId)} >>> Request Finalized: Provider: ${normalizedProvider} | Account: ${normalizedProviderName || 'unknown'} | UUID: ${normalizedProviderUuid || 'unknown'} | Model: ${normalizedModel} | Prompt: ${usage.promptTokens} | Completion: ${usage.completionTokens} | Reasoning: ${usage.reasoningTokens} | Total: ${usage.totalTokens} | Cached: ${usage.cachedTokens} | Stream: ${Boolean(state.isStream)} | QPS: ${globalRates.qps}`);
    if (runtimeEventId) {
        try {
            persistModelUsageEvent(runtimeEventId, statsStore, {
                provider: normalizedProvider,
                accountKey: normalizedAccountKey,
                dateKey,
                accountEvent: durableAccountEvent
            });
        } catch (error) {
            const restoreEntry = (collection, key, snapshot) => {
                if (!key) return;
                if (snapshot.existed) collection[key] = snapshot.value;
                else delete collection[key];
            };
            statsStore.summary = durableRollbackState.summary;
            restoreEntry(statsStore.providers, normalizedProvider, durableRollbackState.provider);
            restoreEntry(statsStore.accounts, normalizedAccountKey, durableRollbackState.account);
            restoreEntry(statsStore.daily, dateKey, durableRollbackState.daily);
            if (accountEventMutation) {
                const events = statsStore.accountUsageEvents[accountEventMutation.accountKey] || [];
                events.length = Math.min(events.length, accountEventMutation.previousLength);
                if (accountEventMutation.removedEvents.length > 0) {
                    events.unshift(...accountEventMutation.removedEvents);
                }
                if (accountEventMutation.existed || events.length > 0) {
                    statsStore.accountUsageEvents[accountEventMutation.accountKey] = events;
                } else {
                    delete statsStore.accountUsageEvents[accountEventMutation.accountKey];
                }
            }
            throw error;
        }
    }
    if (!runtimeEventId) markDirty();
    return true;
}

export async function getStats() {
    ensureLoaded();
    const stats = JSON.parse(JSON.stringify(statsStore));
    
    // 注入速率统计
    const globalRates = rateManager.getGlobalStats();
    stats.summary.qps = globalRates.qps;
    stats.summary.tps = globalRates.tps;
    stats.summary.rpm = globalRates.rpm;
    // 峰值取持久化值和当前内存值中的较大者
    stats.summary.maxQps = Math.max(stats.summary.maxQps || 0, globalRates.maxQps);
    stats.summary.maxTps = Math.max(stats.summary.maxTps || 0, globalRates.maxTps);
    stats.summary.maxRpm = Math.max(stats.summary.maxRpm || 0, globalRates.maxRpm);

    for (const [provider, providerStore] of Object.entries(stats.providers || {})) {
        const pRates = rateManager.getStats(`provider:${provider}`);
        providerStore.summary.qps = pRates.qps;
        providerStore.summary.tps = pRates.tps;
        providerStore.summary.rpm = pRates.rpm;
        providerStore.summary.maxQps = Math.max(providerStore.summary.maxQps || 0, pRates.maxQps);
        providerStore.summary.maxTps = Math.max(providerStore.summary.maxTps || 0, pRates.maxTps);
        providerStore.summary.maxRpm = Math.max(providerStore.summary.maxRpm || 0, pRates.maxRpm);

        for (const [model, modelStore] of Object.entries(providerStore.models || {})) {
            const mRates = rateManager.getStats(`model:${model}`);
            modelStore.qps = mRates.qps;
            modelStore.tps = mRates.tps;
            modelStore.rpm = mRates.rpm;
            modelStore.maxQps = Math.max(modelStore.maxQps || 0, mRates.maxQps);
            modelStore.maxTps = Math.max(modelStore.maxTps || 0, mRates.maxTps);
            modelStore.maxRpm = Math.max(modelStore.maxRpm || 0, mRates.maxRpm);
        }
    }

    for (const [accountKey, accountStore] of Object.entries(stats.accounts || {})) {
        const aRates = rateManager.getStats(`account:${accountKey}`);
        accountStore.summary.qps = aRates.qps;
        accountStore.summary.tps = aRates.tps;
        accountStore.summary.rpm = aRates.rpm;
        accountStore.summary.maxQps = Math.max(accountStore.summary.maxQps || 0, aRates.maxQps);
        accountStore.summary.maxTps = Math.max(accountStore.summary.maxTps || 0, aRates.maxTps);
        accountStore.summary.maxRpm = Math.max(accountStore.summary.maxRpm || 0, aRates.maxRpm);
    }

    addDerivedUsageMetricsToTree(stats);

    return stats;
}

export function getAccountTokenUsageSummary(provider, providerUuid, options = {}) {
    ensureLoaded();
    const accountKey = getAccountKey(
        provider,
        providerUuid,
        options.accountIdentity,
        options.accountEmail,
        options.providerName
    );
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const nowMs = now.getTime();
    const rollingWindowMs = toNumber(options.rollingWindowMs) || ROLLING_5H_MS;
    const rollingCutoff = nowMs - rollingWindowMs;
    const weekDateKeys = getCurrentBeijingWeekDateKeys(now);
    const persistedEvents = accountKey
        ? loadModelAccountUsageEvents(accountKey, {
            since: new Date(nowMs - ACCOUNT_EVENT_RETENTION_MS),
            until: now
        })
        : [];
    const events = persistedEvents.length > 0
        ? persistedEvents
        : (accountKey ? (statsStore.accountUsageEvents?.[accountKey] || []) : []);

    let rolling5hTokens = 0;
    let weeklyTokens = 0;
    let totalTokens = 0;

    for (const event of events) {
        const eventMs = Date.parse(event.timestamp);
        if (!Number.isFinite(eventMs)) continue;
        const total = toNumber(event.totalTokens);
        totalTokens += total;
        if (eventMs >= rollingCutoff && eventMs <= nowMs) {
            rolling5hTokens += total;
        }
        if (weekDateKeys.has(getBeijingDateStringFromDate(new Date(eventMs)))) {
            weeklyTokens += total;
        }
    }

    const rolling5hRecoveryTime = getRollingRecoveryTime(
        events,
        options.rolling5hTokenLimit,
        rollingWindowMs,
        nowMs
    );
    const weeklyTokenLimit = toNumber(options.weeklyTokenLimit);
    const weeklyRecoveryTime = weeklyTokenLimit > 0 && weeklyTokens >= weeklyTokenLimit
        ? getNextBeijingWeekStartTime(now).toISOString()
        : null;

    return {
        accountKey,
        rolling5hTokens,
        weeklyTokens,
        totalTokens,
        eventCount: events.length,
        rolling5hRecoveryTime,
        weeklyRecoveryTime
    };
}

export async function resetStats() {
    ensureLoaded();
    statsStore = createDefaultStore();
    pendingRequests.clear();
    rateManager.clear(); // 同时重置速率统计
    persistModelUsageState(statsStore);
    const targetVersion = markDirty();
    const persisted = await flushStatsPersistence({ targetVersion });
    logger.warn(persisted
        ? '[Model Usage Stats] Stats store reset'
        : '[Model Usage Stats] Stats store reset in memory; persistence pending');
    return attachPersistencePending(await getStats(), !persisted);
}

export async function resetTokenStats() {
    ensureLoaded();

    resetUsageTokensInTree(statsStore);

    pendingRequests.clear();
    rateManager.clear(); // 同时重置速率统计
    persistModelUsageState(statsStore);
    const targetVersion = markDirty();
    const persisted = await flushStatsPersistence({ targetVersion });
    logger.warn(persisted
        ? '[Model Usage Stats] Token stats reset'
        : '[Model Usage Stats] Token stats reset in memory; persistence pending');
    return attachPersistencePending(await getStats(), !persisted);
}

function attachPersistencePending(stats, persistencePending) {
    Object.defineProperty(stats, 'persistencePending', {
        value: persistencePending,
        enumerable: false,
        configurable: true
    });
    return stats;
}
