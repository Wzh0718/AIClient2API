/**
 * API 大锅饭 - Ledger 区间预聚合
 * 从 permanent-usage-ledger/daily JSONL 流式聚合区间统计，
 * 为管理页提供 provider/账号/模型分布，替代全量现算路径。
 * 输出不包含任何 key 原文/哈希/前缀。
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import Database from 'better-sqlite3';

import { buildAveragePricingProfile, DEFAULT_CONVERSION_MODEL, PRICING_VERSION, estimateUsageCost, normalizeConversionModel } from './cost-estimator.js';
import { buildDailyRowsFromSqliteRows } from '../../../scripts/usage-ledger/daily-usage-ledger.mjs';

const LEDGER_READ_CONCURRENCY = 4;

async function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function createBucket() {
    return {
        requestCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        maxQps: 0,
        maxRpm: 0,
        maxTps: 0,
        cost: {
            usd: 0,
            actualUsd: 0,
            estimatedUsd: 0,
            convertedUsd: 0,
            missingPriceTokens: 0,
            estimatedPriceTokens: 0,
            _pricingSources: new Set(),
            _estimationScopes: new Set()
        }
    };
}

function addRowToBucket(bucket, row, currentCost = estimateUsageCost(row.usage || {}, row.model || 'unknown')) {
    const usage = row.usage || {};
    bucket.requestCount += toNumber(usage.requestCount);
    bucket.promptTokens += toNumber(usage.promptTokens);
    bucket.completionTokens += toNumber(usage.completionTokens);
    bucket.totalTokens += toNumber(usage.totalTokens);
    bucket.cachedTokens += toNumber(usage.cachedTokens);
    bucket.maxQps = Math.max(bucket.maxQps || 0, toNumber(usage.maxQps));
    bucket.maxRpm = Math.max(bucket.maxRpm || 0, toNumber(usage.maxRpm));
    bucket.maxTps = Math.max(bucket.maxTps || 0, toNumber(usage.maxTps));
    bucket.cost.usd += currentCost.usd;
    bucket.cost.actualUsd += currentCost.actualUsd;
    bucket.cost.estimatedUsd += currentCost.estimatedUsd;
    bucket.cost.missingPriceTokens += currentCost.missingPriceTokens;
    bucket.cost.estimatedPriceTokens += currentCost.estimatedPriceTokens;
    if (currentCost.pricingSource) bucket.cost._pricingSources.add(currentCost.pricingSource);
    if (currentCost.estimationScope) bucket.cost._estimationScopes.add(currentCost.estimationScope);
}

function ensureBucket(map, name) {
    if (!map[name]) map[name] = createBucket();
    return map[name];
}

function finalizeBucket(bucket, conversionModel) {
    bucket.cost.convertedUsd = estimateUsageCost({
        promptTokens: bucket.promptTokens,
        cachedTokens: bucket.cachedTokens,
        completionTokens: bucket.completionTokens,
        totalTokens: bucket.totalTokens
    }, conversionModel).usd;
    bucket.cost.conversionModel = conversionModel;
    bucket.cost.pricingVersion = PRICING_VERSION;
    const pricingSources = [...bucket.cost._pricingSources];
    bucket.cost.pricingSource = pricingSources.includes('estimated-average')
        ? (pricingSources.some(source => source !== 'estimated-average') ? 'mixed' : 'estimated-average')
        : (pricingSources.includes('missing') ? (pricingSources.length > 1 ? 'mixed' : 'missing') : 'official');
    const estimationScopes = [...bucket.cost._estimationScopes];
    if (estimationScopes.length === 1) bucket.cost.estimationScope = estimationScopes[0];
    else if (estimationScopes.length > 1) bucket.cost.estimationScope = 'mixed';
    delete bucket.cost._pricingSources;
    delete bucket.cost._estimationScopes;
    bucket.cacheHitRatio = bucket.promptTokens > 0 ? bucket.cachedTokens / bucket.promptTokens : 0;
    return bucket;
}

function addUsage(target, usage = {}) {
    for (const field of ['promptTokens', 'cachedTokens', 'completionTokens', 'reasoningTokens', 'totalTokens']) {
        target[field] = toNumber(target[field]) + toNumber(usage[field]);
    }
}

function addPricingSample(groups, key, row) {
    if (!groups.has(key)) groups.set(key, {});
    const models = groups.get(key);
    const model = row.model || 'unknown';
    if (!models[model]) models[model] = {};
    addUsage(models[model], row.usage);
}

function buildPricingProfiles(rows) {
    const providerSamples = new Map();
    const globalSamples = new Map();
    for (const row of rows) {
        const date = row.date || 'unknown-date';
        const provider = row.provider || 'unknown';
        addPricingSample(providerSamples, `${date}\u0000${provider}`, row);
        addPricingSample(globalSamples, date, row);
    }
    const providerProfiles = new Map([...providerSamples].map(([key, models]) => [key, buildAveragePricingProfile(models)]));
    const globalProfiles = new Map([...globalSamples].map(([key, models]) => [key, buildAveragePricingProfile(models)]));
    return { providerProfiles, globalProfiles };
}

function ensureAccount(accounts, row) {
    const name = row.accountKey || `${row.provider || 'unknown'}:unknown`;
    if (!accounts[name]) {
        accounts[name] = {
            provider: row.provider || 'unknown',
            providerUuid: row.accountIdentity || '',
            accountIdentity: row.accountIdentity || '',
            accountEmail: row.accountEmail || '',
            providerUuids: [],
            providerName: row.providerName || '',
            summary: createBucket(),
            models: {}
        };
    }
    const account = accounts[name];
    if (row.accountEmail && !account.accountEmail) account.accountEmail = row.accountEmail;
    if (row.providerName && !account.providerName) account.providerName = row.providerName;
    if (Array.isArray(row.providerUuids)) {
        account.providerUuids = [...new Set([...account.providerUuids, ...row.providerUuids].filter(Boolean))];
    }
    return account;
}

export function createLedgerRangeAggregator({
    conversionModel = DEFAULT_CONVERSION_MODEL,
    keyHashToId = null,
    includeKeySummaries = false,
    includeKeyModels = false,
    keyDailyLimit = 35
} = {}) {
    const normalizedConversionModel = normalizeConversionModel(conversionModel);
    const summary = createBucket();
    const providers = {};
    const models = {};
    const providerModels = {};
    const accounts = {};
    const daily = {};
    const keySummaries = {};
    const rows = [];
    let cachedResult = null;

    function ensureKeySummary(keyId) {
        if (!keySummaries[keyId]) {
            keySummaries[keyId] = {
                summary: createBucket(),
                providers: {},
                models: {},
                daily: {}
            };
        }
        return keySummaries[keyId];
    }

    return {
        addRow(row) {
            if (!row || typeof row !== 'object') return;
            rows.push(row);
        },
        result() {
            if (cachedResult) return cachedResult;
            const { providerProfiles, globalProfiles } = buildPricingProfiles(rows);
            for (const row of rows) {
                const date = row.date || 'unknown-date';
                const providerName = row.provider || 'unknown';
                const providerProfile = providerProfiles.get(`${date}\u0000${providerName}`);
                const globalProfile = globalProfiles.get(date);
                const averageProfile = providerProfile || globalProfile;
                const averageScope = providerProfile ? 'provider-day' : 'global-day';
                const currentCost = estimateUsageCost(row.usage || {}, row.model || 'unknown', { averageProfile, averageScope });

                addRowToBucket(summary, row, currentCost);

                addRowToBucket(ensureBucket(providers, providerName), row, currentCost);

                const modelName = row.model || 'unknown';
                addRowToBucket(ensureBucket(models, modelName), row, currentCost);
                if (!providerModels[providerName]) providerModels[providerName] = {};
                addRowToBucket(ensureBucket(providerModels[providerName], modelName), row, currentCost);

                if (row.date) addRowToBucket(ensureBucket(daily, row.date), row, currentCost);

                const account = ensureAccount(accounts, row);
                addRowToBucket(account.summary, row, currentCost);
                if (!account.models[modelName]) account.models[modelName] = createBucket();
                addRowToBucket(account.models[modelName], row, currentCost);

                if (includeKeySummaries && keyHashToId instanceof Map) {
                    const keyId = keyHashToId.get(row.keyHash);
                    if (keyId) {
                        const keySummary = ensureKeySummary(keyId);
                        addRowToBucket(keySummary.summary, row, currentCost);
                        addRowToBucket(ensureBucket(keySummary.providers, providerName), row, currentCost);
                        if (includeKeyModels) addRowToBucket(ensureBucket(keySummary.models, modelName), row, currentCost);
                        if (row.date) addRowToBucket(ensureBucket(keySummary.daily, row.date), row, currentCost);
                    }
                }
            }
            finalizeBucket(summary, normalizedConversionModel);
            for (const bucket of Object.values(providers)) finalizeBucket(bucket, normalizedConversionModel);
            for (const bucket of Object.values(models)) finalizeBucket(bucket, normalizedConversionModel);
            for (const providerModelMap of Object.values(providerModels)) {
                for (const bucket of Object.values(providerModelMap)) finalizeBucket(bucket, normalizedConversionModel);
            }
            for (const bucket of Object.values(daily)) finalizeBucket(bucket, normalizedConversionModel);
            for (const account of Object.values(accounts)) {
                finalizeBucket(account.summary, normalizedConversionModel);
                for (const bucket of Object.values(account.models)) finalizeBucket(bucket, normalizedConversionModel);
            }
            for (const keySummary of Object.values(keySummaries)) {
                finalizeBucket(keySummary.summary, normalizedConversionModel);
                for (const bucket of Object.values(keySummary.providers)) finalizeBucket(bucket, normalizedConversionModel);
                for (const bucket of Object.values(keySummary.models)) finalizeBucket(bucket, normalizedConversionModel);
                for (const bucket of Object.values(keySummary.daily)) finalizeBucket(bucket, normalizedConversionModel);
                const dates = Object.keys(keySummary.daily).sort();
                if (Number.isFinite(keyDailyLimit) && dates.length > keyDailyLimit) {
                    for (const date of dates.slice(0, dates.length - keyDailyLimit)) delete keySummary.daily[date];
                }
                if (!includeKeyModels) delete keySummary.models;
            }
            cachedResult = {
                summary,
                providers,
                models,
                providerModels,
                accounts,
                daily,
                ...(includeKeySummaries ? { keySummaries } : {}),
                conversionModel: normalizedConversionModel,
                pricingVersion: PRICING_VERSION
            };
            return cachedResult;
        }
    };
}

async function readFileRows(filePath) {
    const rows = [];
    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            if (!line.trim()) continue;
            try {
                rows.push(JSON.parse(line));
            } catch {
                // Ignore corrupted partial lines.
            }
        }
    } finally {
        lines.close();
        input.destroy();
    }
    return rows;
}

export function readSqliteRowsForDates(databasePath, dates, store) {
    if (!databasePath || !fs.existsSync(databasePath) || !Array.isArray(dates) || dates.length === 0) return [];
    let database;
    try {
        database = new Database(databasePath, { readonly: true, fileMustExist: true });
        const table = database.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'potluck_usage_history'"
        ).get();
        if (!table) return [];
        const placeholders = dates.map(() => '?').join(',');
        const rows = database.prepare(`
            SELECT key_ref, usage_date, day_json
            FROM potluck_usage_history
            WHERE usage_date IN (${placeholders})
            ORDER BY usage_date, key_ref
        `).all(...dates);
        return buildDailyRowsFromSqliteRows(rows, store);
    } catch {
        return [];
    } finally {
        database?.close();
    }
}

export function listLedgerDates(ledgerDailyDir) {
    if (!fs.existsSync(ledgerDailyDir)) return [];
    return fs.readdirSync(ledgerDailyDir)
        .map(name => name.match(/^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1])
        .filter(Boolean)
        .sort();
}

/**
 * 读取并聚合指定日期集合的 ledger 日文件。
 * 目标 Key 查询必须扫描账本行，避免用不完整的 SQLite 预聚合覆盖目标明细。
 * @returns {{availableDates: string[], missingDates: string[], summary, providers, models, accounts, conversionModel, pricingVersion}}
 */
export async function readLedgerRangeStats({
    ledgerDailyDir,
    dates = [],
    conversionModel,
    now = new Date(),
    keyHashToId = null,
    includeKeySummaries = false,
    includeKeyModels = false,
    targetKeyId = null,
    keyDailyLimit = 35,
    extraRows = [],
    keySummaryRows = []
} = {}) {
    const availableDates = [];
    const missingDates = [];
    const todayKey = getBeijingDateKey(now);
    const extraRowsByDate = new Map();
    for (const row of extraRows || []) {
        if (!row?.date) continue;
        if (!extraRowsByDate.has(row.date)) extraRowsByDate.set(row.date, []);
        extraRowsByDate.get(row.date).push(row);
    }

    const fileResults = await mapWithConcurrency(dates, LEDGER_READ_CONCURRENCY, async date => {
        // 当天账本可能是凌晨 write 的静态快照，分布面板始终以实时 usageHistory 为准。
        if (date === todayKey) {
            const liveRows = extraRowsByDate.get(date) || [];
            if (liveRows.length > 0) {
                return { date, rows: liveRows, available: true };
            } else {
                return { date, rows: [], available: false };
            }
        }
        const filePath = path.join(ledgerDailyDir, `usage-${date}.jsonl`);
        if (!fs.existsSync(filePath)) {
            const liveRows = extraRowsByDate.get(date) || [];
            if (liveRows.length > 0) {
                return { date, rows: liveRows, available: true };
            } else {
                return { date, rows: [], available: false };
            }
        }
        return { date, rows: await readFileRows(filePath), available: true };
    });
    const preaggregateDates = new Set((keySummaryRows || []).map(row => row?.date).filter(Boolean));
    const ledgerDatesWithRows = fileResults
        .filter(result => result.available && result.rows.length > 0)
        .map(result => result.date);
    const useKeyPreaggregate = includeKeySummaries
        && targetKeyId === null
        && Array.isArray(keySummaryRows)
        && keySummaryRows.length > 0
        && ledgerDatesWithRows.every(date => preaggregateDates.has(date));
    const targetKeyHashes = targetKeyId !== null && keyHashToId instanceof Map
        ? new Set([...keyHashToId.entries()]
            .filter(([, mappedKeyId]) => mappedKeyId === targetKeyId)
            .map(([keyHash]) => keyHash))
        : null;
    const aggregator = createLedgerRangeAggregator({
        conversionModel,
        keyHashToId,
        includeKeySummaries: includeKeySummaries && !useKeyPreaggregate,
        includeKeyModels,
        keyDailyLimit
    });
    for (const result of fileResults) {
        if (result.available) {
            const date = result.date;
            let rows = result.rows || [];
            if (targetKeyHashes?.size > 0 && !rows.some(row => targetKeyHashes.has(row?.keyHash))) {
                const supplementalRows = (keySummaryRows || []).filter(row => (
                    row?.date === date && targetKeyHashes.has(row?.keyHash)
                ));
                if (supplementalRows.length > 0) rows = rows.concat(supplementalRows);
            }
            rows.forEach(row => aggregator.addRow(row));
            availableDates.push(date);
        } else {
            const date = result.date;
            missingDates.push(date);
        }
    }

    const result = {
        availableDates,
        missingDates,
        ...aggregator.result()
    };
    if (useKeyPreaggregate) {
        const keyAggregator = createLedgerRangeAggregator({
            conversionModel,
            keyHashToId,
            includeKeySummaries: true,
            includeKeyModels,
            keyDailyLimit
        });
        for (const row of keySummaryRows) keyAggregator.addRow(row);
        result.keySummaries = keyAggregator.result().keySummaries;
        result.keySummarySource = 'sqlite-preaggregated';
    } else if (includeKeySummaries) {
        result.keySummarySource = 'ledger-scan';
    }
    return result;
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export function getBeijingDateKey(now = new Date()) {
    return new Date(now.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftDateKey(dateKey, deltaDays) {
    const date = new Date(`${dateKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + deltaDays);
    return date.toISOString().slice(0, 10);
}

function dateKeysBetween(from, to) {
    const keys = [];
    for (let key = from; key <= to; key = shiftDateKey(key, 1)) keys.push(key);
    return keys;
}

function isValidDateKey(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function invalidDateRange(message) {
    const error = new Error(message);
    error.code = 'INVALID_DATE_RANGE';
    return error;
}

/**
 * 将管理页的 range 参数换算为北京时间日期列表。
 * `total` 返回 ledger 目录里已有的全部日期加上今天。
 */
export function resolveRangeDates(range, { ledgerDailyDir, now = new Date(), from, to } = {}) {
    const todayKey = getBeijingDateKey(now);
    if (range === 'custom') {
        if (!isValidDateKey(from) || !isValidDateKey(to)) {
            throw invalidDateRange('自定义时间范围必须使用 YYYY-MM-DD 日期格式');
        }
        if (from > to) throw invalidDateRange('开始日期不能晚于结束日期');
        if (to > todayKey) throw invalidDateRange('结束日期不能晚于北京时间今天');
        if (ledgerDailyDir) {
            const earliestDate = listLedgerDates(ledgerDailyDir)[0] || todayKey;
            if (from < earliestDate) throw invalidDateRange(`最早可查询日期为 ${earliestDate}`);
        }
        return dateKeysBetween(from, to);
    }
    if (range === 'today') return [todayKey];
    if (range === '7d') return dateKeysBetween(shiftDateKey(todayKey, -6), todayKey);
    if (range === '30d') return dateKeysBetween(shiftDateKey(todayKey, -29), todayKey);
    const ledgerDates = listLedgerDates(ledgerDailyDir);
    return [...new Set([...ledgerDates, todayKey])].sort();
}
