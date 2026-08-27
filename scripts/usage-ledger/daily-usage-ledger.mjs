#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

// Single pricing source shared with src/plugins/api-potluck/cost-estimator.js.
// Resolution order supports both in-repo runs and standalone copies under the
// config volume (e.g. /app/configs/tools/): env override, file next to this
// script, repo-relative path, then the in-container repo path.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolvePricingFile() {
  const candidates = [
    process.env.USAGE_LEDGER_PRICING_FILE,
    path.join(SCRIPT_DIR, 'pricing.json'),
    path.join(SCRIPT_DIR, '..', '..', 'src', 'plugins', 'api-potluck', 'pricing.json'),
    '/app/src/plugins/api-potluck/pricing.json',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'pricing.json not found. Copy src/plugins/api-potluck/pricing.json next to this script ' +
    'or set USAGE_LEDGER_PRICING_FILE.'
  );
}

const PRICING = JSON.parse(fs.readFileSync(resolvePricingFile(), 'utf8'));

export const PRICING_VERSION = PRICING.pricingVersion;

const PRICE_PER_MILLION = PRICING.pricePerMillion;

const MODEL_PRICE_ALIASES = PRICING.modelPriceAliases;

const MODEL_PRICE_MULTIPLIERS = PRICING.modelPriceMultipliers || {};

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeModelName(model) {
  const normalized = String(model || 'unknown').trim().toLowerCase();
  return MODEL_PRICE_ALIASES[normalized] || normalized || 'unknown';
}

function resolvePricedModel(model) {
  const normalized = String(model || 'unknown').trim().toLowerCase();
  const multiplierConfig = MODEL_PRICE_MULTIPLIERS[normalized];
  return {
    displayModel: normalizeModelName(normalized),
    pricedModel: normalizeModelName(multiplierConfig?.baseModel || normalized),
    multiplier: toNumber(multiplierConfig?.multiplier) || 1,
  };
}

function normalizeEmail(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
}

function inDateRange(date, { from, to } = {}) {
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function normalizeUsage(usage = {}) {
  return {
    requestCount: usage.requestCount !== undefined ? toNumber(usage.requestCount) : 1,
    promptTokens: toNumber(usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens),
    cachedTokens: toNumber(
      usage.cachedTokens ??
      usage.cached_tokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens
    ),
    completionTokens: toNumber(usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens),
    reasoningTokens: toNumber(
      usage.reasoningTokens ??
      usage.reasoning_tokens ??
      usage.completion_tokens_details?.reasoning_tokens ??
      usage.output_tokens_details?.reasoning_tokens
    ),
    totalTokens: toNumber(usage.totalTokens ?? usage.total_tokens) ||
      toNumber(usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens) +
      toNumber(usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens),
  };
}

function emptyUsage() {
  return {
    requestCount: 0,
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(target, usage) {
  const normalized = normalizeUsage(usage);
  target.requestCount += normalized.requestCount;
  target.promptTokens += normalized.promptTokens;
  target.cachedTokens += normalized.cachedTokens;
  target.completionTokens += normalized.completionTokens;
  target.reasoningTokens += normalized.reasoningTokens;
  target.totalTokens += normalized.totalTokens;
}

function subtractUsage(total, covered) {
  const normalizedTotal = normalizeUsage(total);
  const normalizedCovered = normalizeUsage(covered);
  return {
    requestCount: Math.max(0, normalizedTotal.requestCount - normalizedCovered.requestCount),
    promptTokens: Math.max(0, normalizedTotal.promptTokens - normalizedCovered.promptTokens),
    cachedTokens: Math.max(0, normalizedTotal.cachedTokens - normalizedCovered.cachedTokens),
    completionTokens: Math.max(0, normalizedTotal.completionTokens - normalizedCovered.completionTokens),
    reasoningTokens: Math.max(0, normalizedTotal.reasoningTokens - normalizedCovered.reasoningTokens),
    totalTokens: Math.max(0, normalizedTotal.totalTokens - normalizedCovered.totalTokens),
  };
}

function hasUsageValue(usage) {
  const normalized = normalizeUsage(usage);
  return normalized.requestCount > 0 ||
    normalized.promptTokens > 0 ||
    normalized.cachedTokens > 0 ||
    normalized.completionTokens > 0 ||
    normalized.reasoningTokens > 0 ||
    normalized.totalTokens > 0;
}

export function hashSecret(value, length = 16) {
  if (!value) return null;
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length)}`;
}

export function makeKeyRef(rawKey, keyName = null) {
  const text = String(rawKey || '');
  return {
    key: text || null,
    keyHash: hashSecret(text),
    keyPrefix: text ? `${text.slice(0, 11)}...` : null,
    keyName: keyName || null,
  };
}

export function buildKeyLookup(store = {}) {
  const byHash = new Map();
  const byPrefix = new Map();
  for (const [rawKey, keyData] of Object.entries(store.keys || {})) {
    const ref = makeKeyRef(rawKey, keyData?.name);
    if (ref.keyHash) byHash.set(ref.keyHash, ref);
    if (ref.keyPrefix && !byPrefix.has(ref.keyPrefix)) byPrefix.set(ref.keyPrefix, ref);
  }
  return { byHash, byPrefix };
}

function makeAuditKeyRef(potluckKey = {}, keyLookup = null) {
  const rawKey = potluckKey.key || potluckKey.rawKey || null;
  if (rawKey) return makeKeyRef(rawKey, potluckKey.name || null);
  const hash = potluckKey.hash || potluckKey.keyHash || null;
  const prefix = potluckKey.prefix || potluckKey.keyPrefix || null;
  const matched = keyLookup?.byHash?.get(hash) || keyLookup?.byPrefix?.get(prefix) || null;
  if (matched) {
    return {
      ...matched,
      keyName: potluckKey.name || matched.keyName || null,
    };
  }
  return {
    key: null,
    keyHash: hash,
    keyPrefix: prefix,
    keyName: potluckKey.name || null,
  };
}

function canonicalAccount(account = {}, fallbackProvider = 'unknown') {
  const provider = account.provider || fallbackProvider || 'unknown';
  const email = normalizeEmail(account.accountEmail) ||
    normalizeEmail(account.accountIdentity) ||
    normalizeEmail(account.providerUuid) ||
    normalizeEmail(account.providerName);
  if (provider === 'openai-codex-oauth' && email) {
    return {
      provider: 'openai-codex-oauth',
      accountEmail: email,
      accountKey: `openai-codex-oauth:${email}`,
      accountIdentity: email,
    };
  }

  const identity = account.accountIdentity || account.providerUuid || account.providerUuidHash || 'unknown';
  return {
    provider,
    accountEmail: email,
    accountKey: `${provider}:${identity}`,
    accountIdentity: identity,
  };
}

function buildAveragePricingProfile(models = {}) {
  const totals = {
    billableInputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0,
    inputUsd: 0, cachedInputUsd: 0, outputUsd: 0, usd: 0,
  };
  let sampleModelCount = 0;
  for (const [model, usage] of Object.entries(models || {})) {
    if (!isTextPricingModel(model)) continue;
    const resolvedModel = resolvePricedModel(model);
    const pricing = PRICE_PER_MILLION[resolvedModel.pricedModel];
    if (!pricing) continue;
    const normalized = normalizeUsage(usage);
    if (normalized.totalTokens <= 0) continue;
    const cachedTokens = Math.min(normalized.promptTokens, normalized.cachedTokens);
    const billableInputTokens = Math.max(0, normalized.promptTokens - cachedTokens);
    const inputUsd = billableInputTokens * pricing.input * resolvedModel.multiplier / 1_000_000;
    const cachedInputUsd = cachedTokens * pricing.cachedInput * resolvedModel.multiplier / 1_000_000;
    const outputUsd = normalized.completionTokens * pricing.output * resolvedModel.multiplier / 1_000_000;
    totals.billableInputTokens += billableInputTokens;
    totals.cachedTokens += cachedTokens;
    totals.outputTokens += normalized.completionTokens;
    totals.totalTokens += normalized.totalTokens;
    totals.inputUsd += inputUsd;
    totals.cachedInputUsd += cachedInputUsd;
    totals.outputUsd += outputUsd;
    totals.usd += inputUsd + cachedInputUsd + outputUsd;
    sampleModelCount += 1;
  }
  if (sampleModelCount === 0 || totals.totalTokens <= 0 || totals.usd <= 0) return null;
  return {
    input: totals.billableInputTokens > 0 ? totals.inputUsd * 1_000_000 / totals.billableInputTokens : null,
    cachedInput: totals.cachedTokens > 0 ? totals.cachedInputUsd * 1_000_000 / totals.cachedTokens : null,
    output: totals.outputTokens > 0 ? totals.outputUsd * 1_000_000 / totals.outputTokens : null,
    effective: totals.usd * 1_000_000 / totals.totalTokens,
    sampleTokens: totals.totalTokens,
    sampleModelCount,
  };
}

export function buildUniqueEmailProviderMap(store = {}) {
  const providersByEmail = new Map();
  for (const keyData of Object.values(store.keys || {})) {
    for (const day of Object.values(keyData?.usageHistory || {})) {
      for (const account of Object.values(day?.accounts || {})) {
        const email = normalizeEmail(account?.accountEmail || account?.accountIdentity);
        const provider = account?.provider;
        if (!email || !provider || provider === 'unknown') continue;
        if (!providersByEmail.has(email)) providersByEmail.set(email, new Set());
        providersByEmail.get(email).add(provider);
      }
    }
  }
  return new Map([...providersByEmail]
    .filter(([, providers]) => providers.size === 1)
    .map(([email, providers]) => [email, [...providers][0]]));
}

export function resolveAuditProvider(event = {}, providerByEmail = new Map()) {
  const provider = event.request?.toProvider || event.request?.fromProvider || 'unknown';
  if (provider !== 'unknown') return provider;
  const email = normalizeEmail(event.account?.accountEmail);
  return (email && providerByEmail.get(email)) || 'unknown';
}

function estimateUsageCost(usage, model, { averageProfile = null, averageScope = null } = {}) {
  const resolvedModel = resolvePricedModel(model);
  const pricing = PRICE_PER_MILLION[resolvedModel.pricedModel];
  if (!pricing) {
    const normalized = normalizeUsage(usage);
    if (averageProfile?.effective > 0 && normalized.totalTokens > 0) {
      const cachedTokens = Math.min(normalized.promptTokens, normalized.cachedTokens);
      const billableInputTokens = Math.max(0, normalized.promptTokens - cachedTokens);
      const classifiedTokens = billableInputTokens + cachedTokens + normalized.completionTokens;
      const fallback = averageProfile.effective;
      const estimatedUsd = classifiedTokens > 0
        ? (
          billableInputTokens * (averageProfile.input || fallback) +
          cachedTokens * (averageProfile.cachedInput || fallback) +
          normalized.completionTokens * (averageProfile.output || fallback) +
          Math.max(0, normalized.totalTokens - classifiedTokens) * fallback
        ) / 1_000_000
        : normalized.totalTokens * fallback / 1_000_000;
      return {
        usd: estimatedUsd,
        actualUsd: 0,
        estimatedUsd,
        estimatedPriceTokens: normalized.totalTokens,
        missingPriceTokens: 0,
        pricingModel: resolvedModel.displayModel,
        pricingSource: 'estimated-average',
        estimationScope: averageScope,
        estimationMethod: `${averageScope}-weighted-average`,
        averageSampleTokens: averageProfile.sampleTokens,
        averageSampleModelCount: averageProfile.sampleModelCount,
      };
    }
    return {
      usd: 0,
      actualUsd: 0,
      estimatedUsd: 0,
      estimatedPriceTokens: 0,
      missingPriceTokens: normalized.totalTokens,
      pricingModel: resolvedModel.displayModel,
      pricingSource: 'missing',
    };
  }

  const normalized = normalizeUsage(usage);
  const cachedTokens = Math.min(normalized.promptTokens, normalized.cachedTokens);
  const billableInputTokens = Math.max(0, normalized.promptTokens - cachedTokens);
  const actualUsd = ((
    billableInputTokens * pricing.input +
    cachedTokens * pricing.cachedInput +
    normalized.completionTokens * pricing.output
  ) / 1_000_000) * resolvedModel.multiplier;

  return {
    usd: actualUsd,
    actualUsd,
    estimatedUsd: 0,
    estimatedPriceTokens: 0,
    missingPriceTokens: 0,
    pricingModel: resolvedModel.displayModel,
    pricingSource: pricing.source,
  };
}

function addUsageToModelMap(models, model, usage) {
  if (!models[model]) models[model] = emptyUsage();
  addUsage(models[model], usage);
}

function applyAveragePricing(rows) {
  const providerSamples = new Map();
  const globalSamples = new Map();
  for (const row of rows) {
    const date = row.date || 'unknown-date';
    const provider = row.provider || 'unknown';
    const providerKey = `${date}\u0000${provider}`;
    if (!providerSamples.has(providerKey)) providerSamples.set(providerKey, {});
    if (!globalSamples.has(date)) globalSamples.set(date, {});
    addUsageToModelMap(providerSamples.get(providerKey), row.model || 'unknown', row.usage);
    addUsageToModelMap(globalSamples.get(date), row.model || 'unknown', row.usage);
  }
  const providerProfiles = new Map([...providerSamples].map(([key, models]) => [key, buildAveragePricingProfile(models)]));
  const globalProfiles = new Map([...globalSamples].map(([key, models]) => [key, buildAveragePricingProfile(models)]));
  return rows.map(row => {
    const date = row.date || 'unknown-date';
    const providerProfile = providerProfiles.get(`${date}\u0000${row.provider || 'unknown'}`);
    const globalProfile = globalProfiles.get(date);
    const averageProfile = providerProfile || globalProfile;
    const averageScope = providerProfile ? 'provider-day' : 'global-day';
    return {
      ...row,
      cost: estimateUsageCost(row.usage, row.model, { averageProfile, averageScope }),
      pricingVersion: PRICING_VERSION,
    };
  });
}

function baseRow({
  date,
  hour = null,
  source,
  keyRef,
  account,
  providerUuids = [],
  providerName = null,
  model,
  usage,
}) {
  const normalizedUsage = normalizeUsage(usage);
  const cost = estimateUsageCost(normalizedUsage, model);
  return {
    schemaVersion: 1,
    ledgerType: hour === null ? 'daily-key-account-model' : 'hourly-key-account-model',
    date,
    ...(hour === null ? {} : { hour }),
    source,
    provider: account.provider,
    accountKey: account.accountKey,
    accountEmail: account.accountEmail,
    accountIdentity: account.accountIdentity,
    providerName,
    providerUuids: [...new Set(providerUuids.filter(Boolean))],
    ...keyRef,
    model: normalizeModelName(model),
    usage: normalizedUsage,
    cost: {
      usd: cost.usd,
      actualUsd: cost.actualUsd,
      estimatedUsd: cost.estimatedUsd,
      missingPriceTokens: cost.missingPriceTokens,
      estimatedPriceTokens: cost.estimatedPriceTokens,
      pricingModel: cost.pricingModel,
      pricingSource: cost.pricingSource,
    },
    pricingVersion: PRICING_VERSION,
  };
}

function rowGroupKey(row) {
  return [
    row.date,
    row.hour || '',
    row.provider,
    row.accountKey,
    row.keyHash || row.keyPrefix || '',
    row.model,
  ].join('\t');
}

function mergeRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = rowGroupKey(row);
    if (!grouped.has(key)) {
      grouped.set(key, {
        ...row,
        usage: emptyUsage(),
        cost: { usd: 0, actualUsd: 0, estimatedUsd: 0, missingPriceTokens: 0, estimatedPriceTokens: 0, pricingModel: row.cost?.pricingModel },
        providerUuids: [...row.providerUuids],
      });
    }
    const target = grouped.get(key);
    addUsage(target.usage, row.usage);
    target.providerUuids = [...new Set([...target.providerUuids, ...row.providerUuids])];
    target.cost.usd += toNumber(row.cost.usd);
    target.cost.actualUsd += row.cost.actualUsd;
    target.cost.estimatedUsd += toNumber(row.cost.estimatedUsd);
    target.cost.missingPriceTokens += row.cost.missingPriceTokens;
    target.cost.estimatedPriceTokens += toNumber(row.cost.estimatedPriceTokens);
  }
  return applyAveragePricing([...grouped.values()].sort((a, b) => rowGroupKey(a).localeCompare(rowGroupKey(b))));
}

function rowsFromAccounts(accounts = {}, { date, hour = null, source, keyRef }) {
  const rows = [];
  for (const accountRecord of Object.values(accounts || {})) {
    const account = canonicalAccount(accountRecord, accountRecord.provider);
    const models = Object.entries(accountRecord.models || {});
    const sourceModels = models.length > 0 ? models : [['unknown', accountRecord.summary || {}]];
    for (const [model, usage] of sourceModels) {
      rows.push(baseRow({
        date,
        hour,
        source,
        keyRef,
        account,
        providerUuids: accountRecord.providerUuids || [accountRecord.providerUuid],
        providerName: accountRecord.providerName || null,
        model,
        usage,
      }));
    }
  }
  return rows;
}

function inferSingleProvider(record = {}) {
  const providers = Object.keys(record.providers || {}).filter(Boolean);
  return providers.length === 1 ? providers[0] : 'unknown';
}

function coveredUsageByModel(rows = []) {
  const covered = new Map();
  for (const row of rows) {
    const model = normalizeModelName(row.model);
    if (!covered.has(model)) covered.set(model, emptyUsage());
    addUsage(covered.get(model), row.usage);
  }
  return covered;
}

function aggregateUsageEntriesByModel(entries = []) {
  const grouped = new Map();
  for (const [model, usage] of entries) {
    const normalizedModel = normalizeModelName(model);
    if (!grouped.has(normalizedModel)) grouped.set(normalizedModel, emptyUsage());
    addUsage(grouped.get(normalizedModel), usage);
  }
  return [...grouped.entries()];
}

function rowsFromDaySummary(day = {}, { date, keyRef, coveredRows = [] }) {
  const provider = inferSingleProvider(day);
  const account = canonicalAccount({
    provider,
    accountIdentity: 'unknown',
  });
  const covered = coveredUsageByModel(coveredRows);
  const modelEntries = Object.entries(day.models || {});
  const sourceModels = modelEntries.length > 0
    ? aggregateUsageEntriesByModel(modelEntries)
    : (Object.keys(day.summary || {}).length > 0 ? [['unknown', day.summary]] : []);
  const source = coveredRows.length > 0 ? 'api-potluck-keys-summary-delta' : 'api-potluck-keys-summary';
  const rows = [];

  for (const [model, usage] of sourceModels) {
    const normalizedModel = normalizeModelName(model);
    const delta = subtractUsage(usage, covered.get(normalizedModel) || emptyUsage());
    if (!hasUsageValue(delta)) continue;
    rows.push(baseRow({
      date,
      source,
      keyRef,
      account,
      providerUuids: [],
      providerName: null,
      model,
      usage: delta,
    }));
  }

  return rows;
}

export function buildDailyRowsFromPotluck(store = {}, range = {}) {
  const rows = [];
  for (const [rawKey, keyData] of Object.entries(store.keys || {})) {
    const keyRef = makeKeyRef(rawKey, keyData?.name);
    for (const [date, day] of Object.entries(keyData?.usageHistory || {})) {
      if (!inDateRange(date, range)) continue;
      const accountRows = rowsFromAccounts(day.accounts || {}, {
        date,
        source: 'api-potluck-keys',
        keyRef,
      });
      rows.push(...accountRows);
      rows.push(...rowsFromDaySummary(day, { date, keyRef, coveredRows: accountRows }));
    }
  }
  return mergeRows(rows);
}

function resolveSqliteKeyRef(keyHash, keyLookup) {
  return keyLookup?.byHash?.get(keyHash) || {
    key: null,
    keyHash,
    keyPrefix: null,
    keyName: null,
  };
}

function readSqliteUsageDays(databasePath, range = {}) {
  if (!databasePath || !fs.existsSync(databasePath)) return null;
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const table = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'potluck_usage_history'"
    ).get();
    if (!table) return null;
    const from = range.from || '0000-01-01';
    const to = range.to || '9999-12-31';
    return database.prepare(`
      SELECT key_ref, usage_date, day_json
      FROM potluck_usage_history
      WHERE usage_date >= ? AND usage_date <= ?
      ORDER BY usage_date, key_ref
    `).all(from, to).map(row => ({
      keyHash: row.key_ref,
      date: row.usage_date,
      day: JSON.parse(row.day_json)
    }));
  } finally {
    database.close();
  }
}

export function buildDailyRowsFromSqliteRows(rows = [], store = {}, range = {}) {
  const keyLookup = buildKeyLookup(store);
  const ledgerRows = [];
  for (const row of rows) {
    const keyRef = resolveSqliteKeyRef(row.key_ref, keyLookup);
    const date = row.usage_date;
    const day = typeof row.day_json === 'string' ? JSON.parse(row.day_json) : row.day_json;
    const accountRows = rowsFromAccounts(day.accounts || {}, {
      date,
      source: 'sqlite-potluck-usage-history',
      keyRef,
    });
    ledgerRows.push(...accountRows);
    ledgerRows.push(...rowsFromDaySummary(day, { date, keyRef, coveredRows: accountRows }));
  }
  return mergeRows(ledgerRows);
}

export function buildDailyRowsFromSqlite(databasePath, store = {}, range = {}) {
  const days = readSqliteUsageDays(databasePath, range);
  if (days === null) return null;
  return buildDailyRowsFromSqliteRows(days.map(({ keyHash, date, day }) => ({
    key_ref: keyHash,
    usage_date: date,
    day_json: day,
  })), store, range);
}

export function buildHourlyRowsFromPotluck(store = {}, range = {}) {
  const rows = [];
  for (const [rawKey, keyData] of Object.entries(store.keys || {})) {
    const keyRef = makeKeyRef(rawKey, keyData?.name);
    for (const [date, day] of Object.entries(keyData?.usageHistory || {})) {
      if (!inDateRange(date, range)) continue;
      for (const [hour, hourData] of Object.entries(day.hours || {})) {
        rows.push(...rowsFromAccounts(hourData.accounts || {}, {
          date,
          hour,
          source: 'api-potluck-keys',
          keyRef,
        }));
      }
    }
  }
  return mergeRows(rows);
}

export function buildHourlyRowsFromSqlite(databasePath, store = {}, range = {}) {
  const days = readSqliteUsageDays(databasePath, range);
  if (days === null) return null;
  const keyLookup = buildKeyLookup(store);
  const rows = [];
  for (const { keyHash, date, day } of days) {
    const keyRef = resolveSqliteKeyRef(keyHash, keyLookup);
    for (const [hour, hourData] of Object.entries(day.hours || {})) {
      rows.push(...rowsFromAccounts(hourData.accounts || {}, {
        date,
        hour,
        source: 'sqlite-potluck-usage-history',
        keyRef,
      }));
    }
  }
  return mergeRows(rows);
}

function auditEventToRows(event, options = {}) {
  const date = event.beijingDate || String(event.timestamp || '').slice(0, 10);
  const hour = event.beijingHour || '00';
  const provider = resolveAuditProvider(event, options.providerByEmail);
  const accountRecord = {
    provider,
    providerUuid: event.account?.providerUuidHash || event.account?.providerUuid || event.account?.accountEmail || null,
    accountEmail: event.account?.accountEmail || null,
    accountIdentity: event.account?.accountEmail || event.account?.providerUuidHash || event.account?.providerUuid || null,
    providerName: event.account?.providerNameDisplay || null,
    providerUuids: [event.account?.providerUuidHash || event.account?.providerUuid].filter(Boolean),
    models: {
      [event.request?.actualModel || event.request?.model || 'unknown']: {
        ...normalizeUsage(event.usage || {}),
        requestCount: 1,
      },
    },
  };
  const keyRef = makeAuditKeyRef(event.potluckKey || {}, options.keyLookup);
  const daily = rowsFromAccounts({ account: accountRecord }, { date, source: 'request-audit', keyRef });
  const hourly = rowsFromAccounts({ account: accountRecord }, { date, hour, source: 'request-audit', keyRef });
  return { daily, hourly };
}

export function aggregateAuditEvents(events = [], range = {}) {
  const seen = new Set();
  const skipped = {
    duplicateRequestIds: 0,
    outsideRange: 0,
    nonSuccess: 0,
    missingUsage: 0,
  };
  const dailyRows = [];
  const hourlyRows = [];

  for (const event of events) {
    const date = event.beijingDate || String(event.timestamp || '').slice(0, 10);
    if (!inDateRange(date, range)) {
      skipped.outsideRange += 1;
      continue;
    }
    if (event.status?.outcome && event.status.outcome !== 'success') {
      skipped.nonSuccess += 1;
      continue;
    }
    const usage = normalizeUsage(event.usage || {});
    if (usage.totalTokens <= 0 && usage.promptTokens <= 0 && usage.completionTokens <= 0) {
      skipped.missingUsage += 1;
      continue;
    }
    if (event.requestId) {
      const dedupeKey = `${event.potluckKey?.hash || ''}:${event.requestId}`;
      if (seen.has(dedupeKey)) {
        skipped.duplicateRequestIds += 1;
        continue;
      }
      seen.add(dedupeKey);
    }

    const rows = auditEventToRows(event, { keyLookup: range.keyLookup, providerByEmail: range.providerByEmail });
    dailyRows.push(...rows.daily);
    hourlyRows.push(...rows.hourly);
  }

  return {
    dailyRows: mergeRows(dailyRows),
    hourlyRows: mergeRows(hourlyRows),
    skipped,
    eventCount: events.length,
    includedRequestCount: seen.size,
  };
}

export function summarizeAggregationResult(result = {}) {
  return {
    eventCount: result.eventCount || 0,
    includedRequestCount: result.includedRequestCount || 0,
    skipped: result.skipped || {},
    dailyRows: Array.isArray(result.dailyRows) ? result.dailyRows.length : 0,
    hourlyRows: Array.isArray(result.hourlyRows) ? result.hourlyRows.length : 0,
  };
}

export function summarizeLedgerRows(rows = []) {
  const summary = { requestCount: 0, totalTokens: 0, usd: 0, actualUsd: 0, estimatedUsd: 0, missingPriceTokens: 0, estimatedPriceTokens: 0, rowCount: rows.length };
  for (const row of rows) {
    const usage = normalizeUsage(row.usage || {});
    summary.requestCount += usage.requestCount;
    summary.totalTokens += usage.totalTokens;
    summary.usd += toNumber(row.cost?.usd ?? (toNumber(row.cost?.actualUsd) + toNumber(row.cost?.estimatedUsd)));
    summary.actualUsd += toNumber(row.cost?.actualUsd);
    summary.estimatedUsd += toNumber(row.cost?.estimatedUsd);
    summary.missingPriceTokens += toNumber(row.cost?.missingPriceTokens);
    summary.estimatedPriceTokens += toNumber(row.cost?.estimatedPriceTokens);
  }
  return summary;
}

export function summarizePotluckDay(store = {}, date) {
  const summary = { requestCount: 0, totalTokens: 0 };
  let seen = false;
  for (const keyData of Object.values(store.keys || {})) {
    const day = keyData?.usageHistory?.[date];
    if (!day?.summary) continue;
    seen = true;
    const usage = normalizeUsage(day.summary);
    summary.requestCount += usage.requestCount;
    summary.totalTokens += usage.totalTokens;
  }
  return seen ? summary : null;
}

const RECONCILE_METRICS = ['requestCount', 'totalTokens'];

function compareSummaries(pair, left, right, thresholdRatio) {
  const metrics = {};
  let exceeded = false;
  for (const metric of RECONCILE_METRICS) {
    const a = toNumber(left?.[metric]);
    const b = toNumber(right?.[metric]);
    const base = Math.max(a, b);
    const deviationRatio = base === 0 ? 0 : Math.abs(a - b) / base;
    const metricExceeded = deviationRatio > thresholdRatio;
    if (metricExceeded) exceeded = true;
    metrics[metric] = { left: a, right: b, deviationRatio, exceeded: metricExceeded };
  }
  return { pair, metrics, exceeded };
}

export function reconcileDay({
  date,
  ledgerSummary = null,
  hourlySummary = null,
  auditSummary = null,
  potluckSummary = null,
  thresholdRatio = 0.005,
} = {}) {
  const sources = {
    ledger: { available: ledgerSummary !== null, summary: ledgerSummary },
    audit: { available: auditSummary !== null, summary: auditSummary },
    potluck: { available: potluckSummary !== null, summary: potluckSummary },
  };

  const comparisons = [];
  if (ledgerSummary !== null && auditSummary !== null) {
    comparisons.push(compareSummaries('ledger-vs-audit', ledgerSummary, auditSummary, thresholdRatio));
  }
  if (ledgerSummary !== null && potluckSummary !== null) {
    comparisons.push(compareSummaries('ledger-vs-potluck', ledgerSummary, potluckSummary, thresholdRatio));
  }
  if (auditSummary !== null && potluckSummary !== null) {
    comparisons.push(compareSummaries('audit-vs-potluck', auditSummary, potluckSummary, thresholdRatio));
  }

  const allAvailable = Object.values(sources).every(source => source.available);
  const anyExceeded = comparisons.some(comparison => comparison.exceeded);
  const status = anyExceeded ? 'deviation' : (allAvailable ? 'ok' : 'partial');
  const hourlyCoverage = ledgerSummary === null || hourlySummary === null
    ? { status: 'unavailable', syntheticAllocation: false }
    : {
        status: (
          toNumber(ledgerSummary.requestCount) === toNumber(hourlySummary.requestCount) &&
          toNumber(ledgerSummary.totalTokens) === toNumber(hourlySummary.totalTokens)
        ) ? 'complete' : 'partial',
        requestCount: {
          daily: toNumber(ledgerSummary.requestCount),
          hourly: toNumber(hourlySummary.requestCount),
          delta: Math.abs(toNumber(ledgerSummary.requestCount) - toNumber(hourlySummary.requestCount)),
          unattributed: Math.max(0, toNumber(ledgerSummary.requestCount) - toNumber(hourlySummary.requestCount)),
          coverageRatio: toNumber(ledgerSummary.requestCount) > 0
            ? Math.min(1, toNumber(hourlySummary.requestCount) / toNumber(ledgerSummary.requestCount))
            : 1,
        },
        totalTokens: {
          daily: toNumber(ledgerSummary.totalTokens),
          hourly: toNumber(hourlySummary.totalTokens),
          delta: Math.abs(toNumber(ledgerSummary.totalTokens) - toNumber(hourlySummary.totalTokens)),
          unattributed: Math.max(0, toNumber(ledgerSummary.totalTokens) - toNumber(hourlySummary.totalTokens)),
          coverageRatio: toNumber(ledgerSummary.totalTokens) > 0
            ? Math.min(1, toNumber(hourlySummary.totalTokens) / toNumber(ledgerSummary.totalTokens))
            : 1,
        },
        syntheticAllocation: false,
      };

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    date,
    status,
    thresholdRatio,
    pricingVersion: PRICING_VERSION,
    sources,
    hourlyCoverage,
    comparisons,
  };
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

async function readJsonlFiles(files) {
  const rows = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const input = fs.createReadStream(file, { encoding: 'utf8' });
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
  }
  return rows;
}

function rowsByDate(rows) {
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }
  return byDate;
}

async function atomicWriteJsonl(filePath, rows) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  const body = rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  await fsp.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, filePath);
}

async function writeRowsByDate(rows, outDir, prefix = 'usage') {
  const byDate = rowsByDate(rows);
  const written = [];
  for (const [date, dateRows] of byDate.entries()) {
    const filePath = path.join(outDir, `${prefix}-${date}.jsonl`);
    await atomicWriteJsonl(filePath, dateRows);
    written.push({ filePath, rowCount: dateRows.length });
  }
  return written.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function dateKeys(from, to) {
  const keys = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (const date = start; date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    keys.push(date.toISOString().slice(0, 10));
  }
  return keys;
}

function shiftDateKey(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function repairAuditFileDate(filePath) {
  return path.basename(filePath).match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl(?:\.|$)/)?.[1] || '';
}

export async function discoverRepairAuditFiles({ auditDir, from, to }) {
  if (!auditDir || !from) throw new Error('auditDir and from are required');
  const end = to || from;
  const allowedDates = new Set(dateKeys(shiftDateKey(from, -1), shiftDateKey(end, 1)));
  const files = [];
  const directories = [auditDir, path.join(auditDir, 'archived-large')];

  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.includes('.tmp')) continue;
      const date = repairAuditFileDate(entry.name);
      if (!date || !allowedDates.has(date)) continue;
      files.push(path.join(directory, entry.name));
    }
  }

  return files.sort((left, right) => {
    const dateCompare = repairAuditFileDate(left).localeCompare(repairAuditFileDate(right));
    if (dateCompare !== 0) return dateCompare;
    const leftArchived = path.dirname(left) === auditDir ? 0 : 1;
    const rightArchived = path.dirname(right) === auditDir ? 0 : 1;
    return leftArchived - rightArchived || left.localeCompare(right);
  });
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(filePath);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}

function deriveBeijingParts(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return { date: null, hour: null };
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const value = type => parts.find(part => part.type === type)?.value;
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    hour: value('hour') || '00',
  };
}

function compactRepairEvent(event = {}) {
  const derived = deriveBeijingParts(event.timestamp);
  return {
    timestamp: event.timestamp || null,
    beijingDate: event.beijingDate || derived.date,
    beijingHour: event.beijingHour || derived.hour || '00',
    requestId: event.requestId || null,
    request: {
      fromProvider: event.request?.fromProvider || null,
      toProvider: event.request?.toProvider || null,
      model: event.request?.model || null,
      actualModel: event.request?.actualModel || event.request?.model || 'unknown',
    },
    potluckKey: {
      present: Boolean(event.potluckKey?.present),
      hash: event.potluckKey?.hash || null,
      prefix: event.potluckKey?.prefix || null,
      name: event.potluckKey?.name || null,
    },
    account: {
      providerUuid: event.account?.providerUuidHash || event.account?.providerUuid || null,
      accountEmail: event.account?.accountEmail || null,
      providerNameDisplay: event.account?.providerNameDisplay || null,
    },
    status: {
      outcome: event.status?.outcome || 'success',
      httpStatus: event.status?.httpStatus ?? null,
    },
    usage: normalizeUsage(event.usage || {}),
  };
}

function repairEventFingerprint(event) {
  return crypto.createHash('sha256').update(JSON.stringify([
    event.timestamp,
    event.beijingDate,
    event.beijingHour,
    event.request?.toProvider,
    event.request?.actualModel,
    event.potluckKey?.hash,
    event.account?.providerUuidHash || event.account?.providerUuid,
    event.account?.accountEmail,
    event.usage,
  ])).digest('hex');
}

function repairEventQuality(rawEvent, compactEvent) {
  const usage = rawEvent?.usage || {};
  const usageFields = [
    'promptTokens', 'prompt_tokens', 'input_tokens',
    'cachedTokens', 'cached_tokens',
    'completionTokens', 'completion_tokens', 'output_tokens',
    'reasoningTokens', 'reasoning_tokens',
    'totalTokens', 'total_tokens',
  ].filter(field => usage[field] !== undefined).length;
  return usageFields * 1000 +
    (compactEvent.account.accountEmail ? 100 : 0) +
    (compactEvent.account.providerUuid ? 50 : 0) +
    (compactEvent.request.actualModel !== 'unknown' ? 10 : 0) +
    Math.min(compactEvent.usage.totalTokens, 9);
}

export async function scanRepairAuditFiles({ files = [], from, to, collectEvents = true, onEvent = null }) {
  if (!from) throw new Error('from is required');
  const end = to || from;
  const selected = new Map();
  const parseErrors = [];
  const sourceFiles = [];
  let duplicateCount = 0;
  let nonSuccessCount = 0;
  let outsideRangeCount = 0;
  let invalidEventCount = 0;

  for (const [fileIndex, filePath] of files.entries()) {
    const stat = await fsp.stat(filePath);
    const source = {
      path: filePath,
      utcDate: repairAuditFileDate(filePath),
      size: stat.size,
      sha256: await sha256File(filePath),
      parsedLines: 0,
      matchedLines: 0,
      parseErrorCount: 0,
    };
    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (!line.trim()) continue;
        let rawEvent;
        try {
          rawEvent = JSON.parse(line);
          source.parsedLines += 1;
        } catch {
          source.parseErrorCount += 1;
          parseErrors.push({ file: filePath, line: lineNumber });
          continue;
        }

        const event = compactRepairEvent(rawEvent);
        if (!event.beijingDate) {
          invalidEventCount += 1;
          continue;
        }
        if (!inDateRange(event.beijingDate, { from, to: end })) {
          outsideRangeCount += 1;
          continue;
        }
        if (event.status.outcome !== 'success') {
          nonSuccessCount += 1;
          continue;
        }
        source.matchedLines += 1;

        const dedupeKey = event.requestId
          ? `request:${event.requestId}`
          : `fingerprint:${repairEventFingerprint(event)}`;
        const candidate = [repairEventQuality(rawEvent, event), fileIndex, lineNumber];
        const current = selected.get(dedupeKey);
        if (current) {
          duplicateCount += 1;
          const candidateComesFirst = candidate[1] < current[1] ||
            (candidate[1] === current[1] && candidate[2] < current[2]);
          if (candidate[0] > current[0] ||
              (candidate[0] === current[0] && candidateComesFirst)) {
            selected.set(dedupeKey, candidate);
          }
        } else {
          selected.set(dedupeKey, candidate);
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
    sourceFiles.push(source);
  }

  const events = collectEvents ? [] : null;
  const sourceEventHash = crypto.createHash('sha256');
  let includedEventCount = 0;
  let zeroTokenSuccessCount = 0;
  for (const [fileIndex, filePath] of files.entries()) {
    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (!line.trim()) continue;
        let rawEvent;
        try {
          rawEvent = JSON.parse(line);
        } catch {
          continue;
        }
        const event = compactRepairEvent(rawEvent);
        if (!event.beijingDate || !inDateRange(event.beijingDate, { from, to: end }) || event.status.outcome !== 'success') continue;
        const dedupeKey = event.requestId
          ? `request:${event.requestId}`
          : `fingerprint:${repairEventFingerprint(event)}`;
        const chosen = selected.get(dedupeKey);
        if (!chosen || chosen[1] !== fileIndex || chosen[2] !== lineNumber) continue;
        selected.delete(dedupeKey);
        includedEventCount += 1;
        if (event.usage.totalTokens <= 0 && event.usage.promptTokens <= 0 && event.usage.completionTokens <= 0) {
          zeroTokenSuccessCount += 1;
        }
        sourceEventHash.update(stableJson(event));
        sourceEventHash.update('\n');
        if (events) events.push(event);
        if (onEvent) await onEvent(event);
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }
  if (selected.size > 0) throw new Error('repair audit files changed while replaying selected events');
  if (events) {
    events.sort((left, right) => `${left.timestamp || ''}:${left.requestId || ''}`.localeCompare(`${right.timestamp || ''}:${right.requestId || ''}`));
  }
  return {
    ...(events ? { events } : {}),
    includedEventCount,
    sourceEventDigest: sourceEventHash.digest('hex'),
    duplicateCount,
    nonSuccessCount,
    outsideRangeCount,
    invalidEventCount,
    zeroTokenSuccessCount,
    parseErrors,
    sourceFiles,
  };
}

function createRepairUsageBucket() {
  return {
    requestCount: 0,
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    maxQps: 0,
    maxRpm: 0,
    maxTps: 0,
    lastUsedAt: null,
  };
}

function addRepairUsage(target, usage, timestamp = null) {
  const normalized = normalizeUsage(usage);
  target.requestCount += normalized.requestCount;
  target.promptTokens += normalized.promptTokens;
  target.cachedTokens += normalized.cachedTokens;
  target.completionTokens += normalized.completionTokens;
  target.reasoningTokens += normalized.reasoningTokens;
  target.totalTokens += normalized.totalTokens;
  if (timestamp && (!target.lastUsedAt || timestamp > target.lastUsedAt)) target.lastUsedAt = timestamp;
  return target;
}

function currentUsageSummary(value = {}) {
  return {
    requestCount: toNumber(value?.requestCount),
    promptTokens: toNumber(value?.promptTokens),
    cachedTokens: toNumber(value?.cachedTokens),
    completionTokens: toNumber(value?.completionTokens),
    reasoningTokens: toNumber(value?.reasoningTokens),
    totalTokens: toNumber(value?.totalTokens),
  };
}

function makeRepairAccount(event) {
  const provider = event.request?.toProvider || event.request?.fromProvider || 'unknown';
  const email = normalizeEmail(event.account?.accountEmail);
  if ((provider === 'openai-codex-oauth' || provider === 'openaiResponses-custom') && email) {
    return {
      key: `openai-codex-oauth:${email}`,
      provider: 'openai-codex-oauth',
      providerUuid: email,
      accountIdentity: email,
      accountEmail: email,
      providerUuids: [event.account?.providerUuidHash || event.account?.providerUuid].filter(Boolean),
      providerName: event.account?.providerNameDisplay || null,
    };
  }
  const identity = event.account?.providerUuidHash || event.account?.providerUuid || email;
  if (!identity) return null;
  return {
    key: `${provider}:${identity}`,
    provider,
    providerUuid: identity,
    accountIdentity: identity,
    accountEmail: email,
    providerUuids: [event.account?.providerUuidHash || event.account?.providerUuid].filter(Boolean),
    providerName: event.account?.providerNameDisplay || null,
  };
}

function ensureRepairAccount(accounts, account) {
  if (!account) return null;
  if (!accounts[account.key]) {
    accounts[account.key] = {
      provider: account.provider,
      providerUuid: account.providerUuid,
      accountIdentity: account.accountIdentity,
      accountEmail: account.accountEmail,
      providerUuids: [...account.providerUuids],
      providerName: account.providerName,
      summary: createRepairUsageBucket(),
      models: {},
    };
  } else {
    accounts[account.key].providerUuids = [...new Set([
      ...accounts[account.key].providerUuids,
      ...account.providerUuids,
    ])];
  }
  return accounts[account.key];
}

function ensureRepairDay(days, date) {
  if (!days[date]) {
    days[date] = {
      summary: createRepairUsageBucket(),
      providers: {},
      models: {},
      accounts: {},
      hours: {},
    };
  }
  return days[date];
}

function addRepairEventToDay(day, event) {
  const usage = event.usage || {};
  const timestamp = event.timestamp;
  const provider = event.request?.toProvider || event.request?.fromProvider || 'unknown';
  const model = normalizeModelName(event.request?.actualModel || event.request?.model || 'unknown');
  addRepairUsage(day.summary, usage, timestamp);
  if (!day.providers[provider]) day.providers[provider] = createRepairUsageBucket();
  addRepairUsage(day.providers[provider], usage, timestamp);
  if (!day.models[model]) day.models[model] = createRepairUsageBucket();
  addRepairUsage(day.models[model], usage, timestamp);

  const account = makeRepairAccount(event);
  const accountBucket = ensureRepairAccount(day.accounts, account);
  if (accountBucket) {
    addRepairUsage(accountBucket.summary, usage, timestamp);
    if (!accountBucket.models[model]) accountBucket.models[model] = createRepairUsageBucket();
    addRepairUsage(accountBucket.models[model], usage, timestamp);
  }

  const hour = event.beijingHour || '00';
  if (!day.hours[hour]) {
    day.hours[hour] = { summary: createRepairUsageBucket(), providers: {}, models: {}, accounts: {} };
  }
  const hourBucket = day.hours[hour];
  addRepairUsage(hourBucket.summary, usage, timestamp);
  if (!hourBucket.providers[provider]) hourBucket.providers[provider] = createRepairUsageBucket();
  addRepairUsage(hourBucket.providers[provider], usage, timestamp);
  if (!hourBucket.models[model]) hourBucket.models[model] = createRepairUsageBucket();
  addRepairUsage(hourBucket.models[model], usage, timestamp);
  const hourAccount = ensureRepairAccount(hourBucket.accounts, account);
  if (hourAccount) {
    addRepairUsage(hourAccount.summary, usage, timestamp);
    if (!hourAccount.models[model]) hourAccount.models[model] = createRepairUsageBucket();
    addRepairUsage(hourAccount.models[model], usage, timestamp);
  }
}

function buildRepairKeyLookup(store = {}) {
  const byHash = new Map();
  for (const [rawKey, keyData] of Object.entries(store.keys || {})) {
    const hash = hashSecret(rawKey);
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push({ ...makeKeyRef(rawKey, keyData?.name), rawKey });
  }
  return byHash;
}

function addRepairRowsToGroup(grouped, rows) {
  for (const row of rows) {
    const key = rowGroupKey(row);
    if (!grouped.has(key)) {
      grouped.set(key, {
        ...row,
        usage: emptyUsage(),
        cost: { usd: 0, actualUsd: 0, estimatedUsd: 0, missingPriceTokens: 0, estimatedPriceTokens: 0, pricingModel: row.cost?.pricingModel },
        providerUuids: [...row.providerUuids],
      });
    }
    const target = grouped.get(key);
    addUsage(target.usage, row.usage);
    target.providerUuids = [...new Set([...target.providerUuids, ...row.providerUuids])];
    target.cost.usd += toNumber(row.cost.usd);
    target.cost.actualUsd += row.cost.actualUsd;
    target.cost.estimatedUsd += toNumber(row.cost.estimatedUsd);
    target.cost.missingPriceTokens += row.cost.missingPriceTokens;
    target.cost.estimatedPriceTokens += toNumber(row.cost.estimatedPriceTokens);
  }
}

function finishRepairRows(grouped) {
  return applyAveragePricing([...grouped.values()].sort((left, right) => rowGroupKey(left).localeCompare(rowGroupKey(right))));
}

async function sha256FilePrefix(filePath, byteLength) {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(filePath, { start: 0, end: Math.max(0, byteLength - 1) });
  let read = 0;
  for await (const chunk of input) {
    hash.update(chunk);
    read += chunk.length;
  }
  return { sha256: hash.digest('hex'), size: read };
}

function createRepairCandidateAccumulator(potluckStore) {
  const byHash = buildRepairKeyLookup(potluckStore);
  const ledgerKeyLookup = buildKeyLookup(potluckStore);
  const providerByEmail = buildUniqueEmailProviderMap(potluckStore);
  const potluckDaysByKey = {};
  const modelDays = {};
  const modelProviderDays = {};
  const modelAccountEvents = {};
  const unknownPotluckByDate = {};
  const dailyRows = new Map();
  const hourlyRows = new Map();

  function add(event) {
    const resolvedProvider = resolveAuditProvider(event, providerByEmail);
    if (resolvedProvider !== 'unknown' && (event.request?.toProvider || event.request?.fromProvider || 'unknown') === 'unknown') {
      event.request = { ...(event.request || {}), toProvider: resolvedProvider };
    }
    const date = event.beijingDate;
    const modelDay = ensureRepairDay(modelDays, date);
    addRepairEventToDay(modelDay, event);
    const provider = event.request?.toProvider || event.request?.fromProvider || 'unknown';
    if (!modelProviderDays[date]) modelProviderDays[date] = {};
    if (!modelProviderDays[date][provider]) {
      modelProviderDays[date][provider] = { summary: createRepairUsageBucket(), models: {} };
    }
    addRepairUsage(modelProviderDays[date][provider].summary, event.usage, event.timestamp);
    const providerModel = normalizeModelName(event.request?.actualModel || event.request?.model || 'unknown');
    if (!modelProviderDays[date][provider].models[providerModel]) {
      modelProviderDays[date][provider].models[providerModel] = createRepairUsageBucket();
    }
    addRepairUsage(modelProviderDays[date][provider].models[providerModel], event.usage, event.timestamp);
    const account = makeRepairAccount(event);
    if (account) {
      if (!modelAccountEvents[account.key]) modelAccountEvents[account.key] = [];
      modelAccountEvents[account.key].push({ timestamp: event.timestamp, totalTokens: toNumber(event.usage?.totalTokens) });
    }

    if (!event.potluckKey?.present) return;
    const matches = event.potluckKey.hash ? byHash.get(event.potluckKey.hash) || [] : [];
    if (matches.length !== 1) {
      unknownPotluckByDate[date] = (unknownPotluckByDate[date] || 0) + 1;
      return;
    }
    const keyRef = matches[0];
    if (!potluckDaysByKey[keyRef.rawKey]) potluckDaysByKey[keyRef.rawKey] = {};
    const potluckDay = ensureRepairDay(potluckDaysByKey[keyRef.rawKey], date);
    addRepairEventToDay(potluckDay, event);
    const rows = auditEventToRows(event, { keyLookup: ledgerKeyLookup });
    addRepairRowsToGroup(dailyRows, rows.daily);
    addRepairRowsToGroup(hourlyRows, rows.hourly);
  }

  function finish() {
    return {
      potluckDaysByKey,
      modelDays,
      modelProviderDays,
      modelAccountEvents,
      unknownPotluckByDate,
      dailyRows: finishRepairRows(dailyRows),
      hourlyRows: finishRepairRows(hourlyRows),
    };
  }

  return { add, finish };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function repairRowsForDate(rows, date) {
  return rows.filter(row => row.date === date);
}

function potluckCandidateSummary(candidates, date) {
  const summary = createRepairUsageBucket();
  for (const days of Object.values(candidates.potluckDaysByKey)) {
    const day = days[date];
    if (day) addRepairUsage(summary, { ...day.summary, requestCount: day.summary.requestCount }, day.summary.lastUsedAt);
  }
  return currentUsageSummary(summary);
}

function hasNonDecreasingCandidate(candidate, current) {
  return ['requestCount', 'promptTokens', 'cachedTokens', 'completionTokens', 'reasoningTokens', 'totalTokens']
    .every(metric => toNumber(candidate?.[metric]) >= toNumber(current?.[metric]));
}

function potluckKeysNonDecreasing(potluckStore, candidates, date) {
  return Object.entries(potluckStore.keys || {}).every(([rawKey, keyData]) => {
    const current = currentUsageSummary(keyData?.usageHistory?.[date]?.summary || {});
    const candidate = currentUsageSummary(candidates.potluckDaysByKey[rawKey]?.[date]?.summary || {});
    return hasNonDecreasingCandidate(candidate, current);
  });
}

function usageMapNonDecreasing(candidateMap = {}, currentMap = {}) {
  return Object.entries(currentMap || {}).every(([key, current]) =>
    hasNonDecreasingCandidate(candidateMap?.[key] || {}, current));
}

function accountMapNonDecreasing(candidateMap = {}, currentMap = {}) {
  return Object.entries(currentMap || {}).every(([accountKey, current]) => {
    const candidate = candidateMap?.[accountKey];
    return Boolean(candidate) &&
      hasNonDecreasingCandidate(candidate.summary, current?.summary) &&
      usageMapNonDecreasing(candidate.models, current?.models);
  });
}

function hourMapNonDecreasing(candidateMap = {}, currentMap = {}) {
  return Object.entries(currentMap || {}).every(([hour, current]) => {
    const candidate = candidateMap?.[hour];
    return Boolean(candidate) &&
      hasNonDecreasingCandidate(candidate.summary, current?.summary) &&
      usageMapNonDecreasing(candidate.providers, current?.providers) &&
      usageMapNonDecreasing(candidate.models, current?.models) &&
      accountMapNonDecreasing(candidate.accounts, current?.accounts);
  });
}

function dayDimensionsNonDecreasing(candidateDay = {}, currentDay = {}) {
  return usageMapNonDecreasing(candidateDay.providers, currentDay.providers) &&
    usageMapNonDecreasing(candidateDay.models, currentDay.models) &&
    accountMapNonDecreasing(candidateDay.accounts, currentDay.accounts) &&
    hourMapNonDecreasing(candidateDay.hours, currentDay.hours);
}

function potluckDimensionsNonDecreasing(potluckStore, candidates, date) {
  return Object.entries(potluckStore.keys || {}).every(([rawKey, keyData]) =>
    dayDimensionsNonDecreasing(
      candidates.potluckDaysByKey?.[rawKey]?.[date] || {},
      keyData?.usageHistory?.[date] || {},
    ));
}

function ledgerRowsNonDecreasing(candidateRows = [], currentRows = []) {
  const candidateByKey = new Map(candidateRows.map(row => [rowGroupKey(row), row]));
  return (currentRows || []).every(row => {
    const candidate = candidateByKey.get(rowGroupKey(row));
    return Boolean(candidate) && hasNonDecreasingCandidate(candidate.usage, row.usage);
  });
}

function modelProviderAttributionSafe(currentDay = {}, candidateProviders = {}) {
  const covered = createRepairUsageBucket();
  for (const account of Object.values(currentDay?.accounts || {})) {
    for (const field of REPAIR_USAGE_FIELDS) covered[field] += toNumber(account?.summary?.[field]);
  }
  const fullyCovered = REPAIR_USAGE_FIELDS.every(field => toNumber(covered[field]) === toNumber(currentDay?.[field]));
  return fullyCovered || Object.keys(candidateProviders || {}).length === 1;
}

function beijingDateNow(now) {
  return deriveBeijingParts(now.toISOString()).date;
}

async function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

async function writeJsonMode(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function buildRepairBaseline({
  potluckStore,
  modelStatsStore,
  ledgerRoot,
  dates,
  targets = ['potluck', 'model-stats', 'ledger'],
  dailyLedgerRowsByDate = null,
  hourlyLedgerRowsByDate = null,
}) {
  const selected = new Set(targets);
  const baseline = {};
  if (selected.has('potluck')) baseline.potluckSlices = Object.fromEntries(Object.entries(potluckStore.keys || {}).map(([rawKey, keyData]) => [
      rawKey,
      Object.fromEntries(dates.map(date => [date, keyData?.usageHistory?.[date] || null])),
    ]));
  if (selected.has('model-stats')) baseline.modelSlices = Object.fromEntries(dates.map(date => [date, modelStatsStore.daily?.[date] || null]));
  if (selected.has('ledger')) baseline.dailyLedgerSlices = Object.fromEntries(await Promise.all(dates.map(async date => [
      date,
      dailyLedgerRowsByDate && Object.hasOwn(dailyLedgerRowsByDate, date)
        ? dailyLedgerRowsByDate[date]
        : await readLedgerDailyRows(ledgerRoot, date),
    ])));
  if (selected.has('ledger')) baseline.hourlyLedgerSlices = Object.fromEntries(await Promise.all(dates.map(async date => [
      date,
      hourlyLedgerRowsByDate && Object.hasOwn(hourlyLedgerRowsByDate, date)
        ? hourlyLedgerRowsByDate[date]
        : await readLedgerHourlyRows(ledgerRoot, date),
    ])));
  return baseline;
}

function normalizeRepairTargets(targets) {
  const normalized = [...new Set((targets || ['potluck', 'model-stats', 'ledger']).map(value => String(value).trim()).filter(Boolean))];
  const supported = new Set(['potluck', 'model-stats', 'ledger']);
  if (normalized.length === 0 || normalized.some(target => !supported.has(target))) {
    throw new Error('repair targets must contain potluck, model-stats, or ledger');
  }
  return normalized;
}

export async function createRepairBundle({
  base,
  from,
  to,
  outDir,
  now = new Date(),
  allowCurrentDate = false,
  allowDecreasing = false,
  targets = ['potluck', 'model-stats', 'ledger'],
  repairMode = 'replace',
  eventFilter = null,
  cleanupMetadata = null,
}) {
  if (!base || !from || !outDir) throw new Error('base, from, and outDir are required');
  if (fs.existsSync(outDir)) throw new Error('out-dir already exists');
  const end = to || from;
  const repairTargets = normalizeRepairTargets(targets);
  if (!['replace', 'incremental'].includes(repairMode)) throw new Error('repairMode must be replace or incremental');
  if (repairMode === 'incremental' && (repairTargets.length !== 1 || repairTargets[0] !== 'model-stats')) {
    throw new Error('incremental repair currently supports only model-stats');
  }
  const selectedTargets = new Set(repairTargets);
  const auditDir = path.join(base, 'request-audit');
  const files = await discoverRepairAuditFiles({ auditDir, from, to: end });
  const potluckPath = path.join(base, 'api-potluck-keys.json');
  const modelStatsPath = path.join(base, 'model-usage-stats.json');
  const ledgerRoot = path.join(base, 'permanent-usage-ledger');
  const potluckStore = await readJson(potluckPath);
  const candidateAccumulator = createRepairCandidateAccumulator(potluckStore);
  const scan = await scanRepairAuditFiles({
    files,
    from,
    to: end,
    collectEvents: false,
    onEvent: event => {
      if (!eventFilter || eventFilter(event) !== false) candidateAccumulator.add(event);
    },
  });
  const modelStatsStore = await readJsonIfExists(modelStatsPath, { summary: {}, providers: {}, accounts: {}, accountUsageEvents: {}, daily: {} });
  const candidates = candidateAccumulator.finish();
  const today = beijingDateNow(now);
  const sourceDateSet = new Set(scan.sourceFiles.map(file => file.utcDate));
  const parseErrorDates = new Set(scan.parseErrors.map(error => repairAuditFileDate(error.file)));
  const days = [];

  for (const date of dateKeys(from, end)) {
    const requiredUtcDates = [shiftDateKey(date, -1), date];
    const missingSourceDates = requiredUtcDates.filter(required => !sourceDateSet.has(required));
    const corruptSourceDates = requiredUtcDates.filter(required => parseErrorDates.has(required));
    const currentPotluck = summarizePotluckDay(potluckStore, date) || { requestCount: 0, totalTokens: 0 };
    const currentModelStats = currentUsageSummary(modelStatsStore.daily?.[date] || {});
    const currentLedgerRows = await readLedgerDailyRows(ledgerRoot, date);
    const currentLedger = currentLedgerRows === null
      ? { requestCount: 0, totalTokens: 0 }
      : summarizeLedgerRows(currentLedgerRows);
    const currentHourlyLedgerRows = await readLedgerHourlyRows(ledgerRoot, date);
    const currentHourlyLedger = currentHourlyLedgerRows === null
      ? { requestCount: 0, totalTokens: 0 }
      : summarizeLedgerRows(currentHourlyLedgerRows);
    const candidatePotluck = potluckCandidateSummary(candidates, date);
    const candidateModelStats = currentUsageSummary(candidates.modelDays[date]?.summary || {});
    const candidateLedgerRows = repairRowsForDate(candidates.dailyRows, date);
    const candidateLedger = summarizeLedgerRows(candidateLedgerRows);
    const candidateHourlyLedgerRows = repairRowsForDate(candidates.hourlyRows, date);
    const candidateHourlyLedger = summarizeLedgerRows(candidateHourlyLedgerRows);
    const unknownPotluckKeys = candidates.unknownPotluckByDate[date] || 0;
    const nonDecreasing = {
      potluckTotals: hasNonDecreasingCandidate(candidatePotluck, currentPotluck),
      potluckKeys: potluckKeysNonDecreasing(potluckStore, candidates, date),
      potluckDimensions: potluckDimensionsNonDecreasing(potluckStore, candidates, date),
      modelStatsTotals: hasNonDecreasingCandidate(candidateModelStats, currentModelStats),
      modelStatsDimensions: dayDimensionsNonDecreasing(candidates.modelDays[date] || {}, modelStatsStore.daily?.[date] || {}),
      modelProviderAttribution: modelProviderAttributionSafe(
        modelStatsStore.daily?.[date] || {},
        candidates.modelProviderDays?.[date] || {},
      ),
      ledgerTotals: hasNonDecreasingCandidate(candidateLedger, currentLedger),
      ledgerDimensions: ledgerRowsNonDecreasing(candidateLedgerRows, currentLedgerRows || []),
      ledgerHourlyTotals: hasNonDecreasingCandidate(candidateHourlyLedger, currentHourlyLedger),
      ledgerHourlyDimensions: ledgerRowsNonDecreasing(candidateHourlyLedgerRows, currentHourlyLedgerRows || []),
    };
    const selectedNonDecreasing = [
      ...(selectedTargets.has('potluck') ? [nonDecreasing.potluckTotals, nonDecreasing.potluckKeys, nonDecreasing.potluckDimensions] : []),
      ...(selectedTargets.has('model-stats') ? [nonDecreasing.modelStatsTotals, nonDecreasing.modelStatsDimensions, nonDecreasing.modelProviderAttribution] : []),
      ...(selectedTargets.has('ledger') ? [nonDecreasing.ledgerTotals, nonDecreasing.ledgerDimensions, nonDecreasing.ledgerHourlyTotals, nonDecreasing.ledgerHourlyDimensions] : []),
    ];
    const eligible = (date < today || (allowCurrentDate && date === today)) &&
      missingSourceDates.length === 0 &&
      corruptSourceDates.length === 0 &&
      (!selectedTargets.has('potluck') || unknownPotluckKeys === 0) &&
      (repairMode === 'incremental' || allowDecreasing
        ? nonDecreasing.modelProviderAttribution
        : selectedNonDecreasing.every(Boolean));
    days.push({
      date,
      eligible,
      requiredUtcDates,
      missingSourceDates,
      corruptSourceDates,
      unknownPotluckKeys,
      nonDecreasing,
      current: {
        potluck: currentUsageSummary(currentPotluck),
        modelStats: currentModelStats,
        ledger: currentUsageSummary(currentLedger),
        ledgerHourly: currentUsageSummary(currentHourlyLedger),
      },
      candidate: {
        potluck: candidatePotluck,
        modelStats: candidateModelStats,
        ledger: currentUsageSummary(candidateLedger),
        ledgerHourly: currentUsageSummary(candidateHourlyLedger),
      },
    });
  }

  const eligibleDates = days.filter(day => day.eligible).map(day => day.date);
  const baseline = await buildRepairBaseline({
    potluckStore,
    modelStatsStore,
    ledgerRoot,
    dates: eligibleDates,
    targets: repairTargets,
  });
  const patch = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    from,
    to: end,
    eligibleDates,
    currentDateOverride: allowCurrentDate === true,
    allowDecreasing: allowDecreasing === true,
    targets: repairTargets,
    repairMode,
    cleanupMetadata,
    sourceEventDigest: scan.sourceEventDigest,
    sourceFiles: scan.sourceFiles.map(file => ({ utcDate: file.utcDate, sha256: file.sha256, size: file.size })),
    baselineDigest: sha256Text(stableJson(baseline)),
    baseline,
    potluckDaysByKey: candidates.potluckDaysByKey,
    modelDays: candidates.modelDays,
    modelProviderDays: candidates.modelProviderDays,
    modelAccountEvents: candidates.modelAccountEvents,
  };
  const report = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    range: { from, to: end, excludedActiveDate: today },
    currentDateOverride: allowCurrentDate === true,
    allowDecreasing: allowDecreasing === true,
    targets: repairTargets,
    repairMode,
    cleanupMetadata,
    scan: {
      sourceFiles: scan.sourceFiles.map(file => ({
        path: path.relative(base, file.path).replaceAll('\\', '/'),
        utcDate: file.utcDate,
        size: file.size,
        sha256: file.sha256,
        parsedLines: file.parsedLines,
        matchedLines: file.matchedLines,
        parseErrorCount: file.parseErrorCount,
      })),
      includedEvents: scan.includedEventCount,
      duplicateCount: scan.duplicateCount,
      nonSuccessCount: scan.nonSuccessCount,
      zeroTokenSuccessCount: scan.zeroTokenSuccessCount,
      parseErrorCount: scan.parseErrors.length,
    },
    days,
  };

  await fsp.mkdir(outDir, { recursive: true, mode: 0o700 });
  const reportPath = path.join(outDir, 'report.json');
  const patchPath = path.join(outDir, 'patch.json');
  await writeJsonMode(reportPath, report);
  await writeJsonMode(patchPath, patch);
  if (selectedTargets.has('ledger')) for (const date of eligibleDates) {
    await atomicWriteJsonl(path.join(outDir, 'ledger', 'daily', `usage-${date}.jsonl`), repairRowsForDate(candidates.dailyRows, date));
    await atomicWriteJsonl(path.join(outDir, 'ledger', 'hourly', `usage-${date}.jsonl`), repairRowsForDate(candidates.hourlyRows, date));
  }
  const reportSha256 = await sha256File(reportPath);
  const artifacts = [];
  const artifactPaths = [reportPath, patchPath];
  if (selectedTargets.has('ledger')) for (const date of eligibleDates) {
    artifactPaths.push(path.join(outDir, 'ledger', 'daily', `usage-${date}.jsonl`));
    artifactPaths.push(path.join(outDir, 'ledger', 'hourly', `usage-${date}.jsonl`));
  }
  for (const filePath of artifactPaths) {
    artifacts.push({
      path: path.relative(outDir, filePath).replaceAll('\\', '/'),
      sha256: await sha256File(filePath),
      size: (await fsp.stat(filePath)).size,
    });
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    reportSha256,
    eligibleDates,
    currentDateOverride: allowCurrentDate === true,
    targets: repairTargets,
    repairMode,
    artifacts,
  };
  const manifestPath = path.join(outDir, 'manifest.json');
  await writeJsonMode(manifestPath, manifest);
  const manifestSha256 = await sha256File(manifestPath);
  return { report, manifest, reportSha256, manifestSha256, outDir };
}

const REPAIR_USAGE_FIELDS = [
  'requestCount',
  'promptTokens',
  'cachedTokens',
  'completionTokens',
  'reasoningTokens',
  'totalTokens',
];

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function preserveRepairPeaks(candidate, current) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
  const result = cloneJson(candidate);
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    for (const field of ['maxQps', 'maxRpm', 'maxTps']) {
      if (field in result || field in current) result[field] = Math.max(toNumber(result[field]), toNumber(current[field]));
    }
    if ('lastUsedAt' in result || 'lastUsedAt' in current) {
      result.lastUsedAt = [result.lastUsedAt, current.lastUsedAt].filter(Boolean).sort().at(-1) || null;
    }
    if (Array.isArray(result.providerUuids) || Array.isArray(current.providerUuids)) {
      result.providerUuids = [...new Set([...(result.providerUuids || []), ...(current.providerUuids || [])].filter(Boolean))];
    }
    for (const [key, value] of Object.entries(result)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && current[key] && typeof current[key] === 'object') {
        result[key] = preserveRepairPeaks(value, current[key]);
      }
    }
  }
  return result;
}

function usageDelta(next = {}, previous = {}) {
  const safeNext = next || {};
  const safePrevious = previous || {};
  return Object.fromEntries(REPAIR_USAGE_FIELDS.map(field => [field, toNumber(safeNext[field]) - toNumber(safePrevious[field])]));
}

function isTextPricingModel(model) {
  return !/(?:image|audio|tts|transcrib|whisper)/.test(String(model || '').trim().toLowerCase());
}

function applyUsageDelta(target = {}, delta = {}) {
  for (const field of REPAIR_USAGE_FIELDS) {
    target[field] = Math.max(0, toNumber(target[field]) + toNumber(delta[field]));
  }
  return target;
}

function adjustUsageMap(targetMap = {}, nextMap = {}, previousMap = {}) {
  for (const key of new Set([...Object.keys(nextMap || {}), ...Object.keys(previousMap || {})])) {
    if (!targetMap[key]) targetMap[key] = createRepairUsageBucket();
    applyUsageDelta(targetMap[key], usageDelta(nextMap?.[key], previousMap?.[key]));
    targetMap[key] = preserveRepairPeaks(targetMap[key], previousMap?.[key]);
  }
  return targetMap;
}

function modelDailySlice(day) {
  if (!day) return null;
  return {
    ...cloneJson(day.summary || createRepairUsageBucket()),
    models: cloneJson(day.models || {}),
    accounts: cloneJson(day.accounts || {}),
  };
}

function usageRemainder(total, covered) {
  return Object.fromEntries(REPAIR_USAGE_FIELDS.map(field => [field, Math.max(0, toNumber(total?.[field]) - toNumber(covered?.[field]))]));
}

function deriveOldProviderDay(oldDay, candidateProviders = {}) {
  const result = {};
  const coveredSummary = createRepairUsageBucket();
  const coveredModels = {};
  for (const account of Object.values(oldDay?.accounts || {})) {
    const provider = account?.provider || 'unknown';
    if (!result[provider]) result[provider] = { summary: createRepairUsageBucket(), models: {} };
    applyUsageDelta(result[provider].summary, currentUsageSummary(account?.summary));
    applyUsageDelta(coveredSummary, currentUsageSummary(account?.summary));
    for (const [model, usage] of Object.entries(account?.models || {})) {
      if (!result[provider].models[model]) result[provider].models[model] = createRepairUsageBucket();
      if (!coveredModels[model]) coveredModels[model] = createRepairUsageBucket();
      applyUsageDelta(result[provider].models[model], currentUsageSummary(usage));
      applyUsageDelta(coveredModels[model], currentUsageSummary(usage));
    }
  }
  const candidateProviderNames = Object.keys(candidateProviders || {});
  if (candidateProviderNames.length === 1) {
    const provider = candidateProviderNames[0];
    if (!result[provider]) result[provider] = { summary: createRepairUsageBucket(), models: {} };
    applyUsageDelta(result[provider].summary, usageRemainder(oldDay, coveredSummary));
    for (const [model, usage] of Object.entries(oldDay?.models || {})) {
      if (!result[provider].models[model]) result[provider].models[model] = createRepairUsageBucket();
      applyUsageDelta(result[provider].models[model], usageRemainder(usage, coveredModels[model]));
    }
  }
  return result;
}

function buildNextPotluckStore(currentStore, patch) {
  const next = cloneJson(currentStore);
  for (const date of patch.eligibleDates) {
    for (const [rawKey, keyData] of Object.entries(next.keys || {})) {
      const previousDay = keyData?.usageHistory?.[date] || null;
      const candidateDay = patch.potluckDaysByKey?.[rawKey]?.[date]
        || (patch.allowDecreasing && previousDay ? ensureRepairDay({}, date) : null);
      if (!candidateDay) continue;
      const replacement = preserveRepairPeaks(candidateDay, previousDay);
      if (!keyData.usageHistory) keyData.usageHistory = {};
      keyData.usageHistory[date] = replacement;
      const delta = usageDelta(replacement.summary, previousDay?.summary);
      keyData.totalUsage = Math.max(0, toNumber(keyData.totalUsage) + delta.requestCount);
      keyData.totalPromptTokens = Math.max(0, toNumber(keyData.totalPromptTokens) + delta.promptTokens);
      keyData.totalCachedTokens = Math.max(0, toNumber(keyData.totalCachedTokens) + delta.cachedTokens);
      keyData.totalCompletionTokens = Math.max(0, toNumber(keyData.totalCompletionTokens) + delta.completionTokens);
      keyData.totalReasoningTokens = Math.max(0, toNumber(keyData.totalReasoningTokens) + delta.reasoningTokens);
      keyData.totalTokens = Math.max(0, toNumber(keyData.totalTokens) + delta.totalTokens);
      if (!keyData.totalModels) keyData.totalModels = {};
      adjustUsageMap(keyData.totalModels, replacement.models, previousDay?.models);
    }
  }
  return next;
}

function buildNextModelStatsStore(currentStore, patch, now) {
  const next = cloneJson(currentStore);
  next.summary ||= createRepairUsageBucket();
  next.providers ||= {};
  next.accounts ||= {};
  next.accountUsageEvents ||= {};
  next.daily ||= {};

  for (const date of patch.eligibleDates) {
    const previousDay = next.daily[date] || null;
    const candidateDay = modelDailySlice(
      patch.modelDays?.[date]
        || (patch.allowDecreasing && previousDay ? ensureRepairDay({}, date) : null),
    );
    if (!candidateDay) continue;
    const replacement = preserveRepairPeaks(candidateDay, previousDay);
    applyUsageDelta(next.summary, usageDelta(replacement, previousDay));

    const candidateProviders = patch.modelProviderDays?.[date] || {};
    const previousProviders = deriveOldProviderDay(previousDay, candidateProviders);
    for (const provider of new Set([...Object.keys(candidateProviders), ...Object.keys(previousProviders)])) {
      if (!next.providers[provider]) next.providers[provider] = { summary: createRepairUsageBucket(), models: {} };
      next.providers[provider].summary ||= createRepairUsageBucket();
      next.providers[provider].models ||= {};
      applyUsageDelta(next.providers[provider].summary, usageDelta(
        candidateProviders?.[provider]?.summary,
        previousProviders?.[provider]?.summary,
      ));
      adjustUsageMap(
        next.providers[provider].models,
        candidateProviders?.[provider]?.models,
        previousProviders?.[provider]?.models,
      );
    }

    for (const accountKey of new Set([
      ...Object.keys(replacement.accounts || {}),
      ...Object.keys(previousDay?.accounts || {}),
    ])) {
      const candidateAccount = replacement.accounts?.[accountKey];
      const previousAccount = previousDay?.accounts?.[accountKey];
      if (!next.accounts[accountKey]) {
        next.accounts[accountKey] = cloneJson(candidateAccount || previousAccount || {});
        next.accounts[accountKey].summary = createRepairUsageBucket();
        next.accounts[accountKey].models = {};
      }
      if (candidateAccount) {
        for (const field of ['provider', 'providerUuid', 'accountIdentity', 'accountEmail', 'providerName']) {
          if (candidateAccount[field] !== undefined) next.accounts[accountKey][field] = candidateAccount[field];
        }
        next.accounts[accountKey].providerUuids = [...new Set([
          ...(next.accounts[accountKey].providerUuids || []),
          ...(candidateAccount.providerUuids || []),
        ].filter(Boolean))];
      }
      next.accounts[accountKey].summary ||= createRepairUsageBucket();
      next.accounts[accountKey].models ||= {};
      applyUsageDelta(next.accounts[accountKey].summary, usageDelta(candidateAccount?.summary, previousAccount?.summary));
      adjustUsageMap(next.accounts[accountKey].models, candidateAccount?.models, previousAccount?.models);
    }

    next.daily[date] = replacement;
  }

  const selectedDates = new Set(patch.eligibleDates);
  for (const accountKey of new Set([
    ...Object.keys(next.accountUsageEvents || {}),
    ...Object.keys(patch.modelAccountEvents || {}),
  ])) {
    const retained = (next.accountUsageEvents[accountKey] || []).filter(event => {
      const eventDate = event?.timestamp ? deriveBeijingParts(event.timestamp).date : null;
      return !selectedDates.has(eventDate);
    });
    const replacements = (patch.modelAccountEvents?.[accountKey] || []).filter(event => {
      const eventDate = event?.timestamp ? deriveBeijingParts(event.timestamp).date : null;
      return selectedDates.has(eventDate);
    });
    next.accountUsageEvents[accountKey] = [...retained, ...replacements]
      .sort((left, right) => String(left.timestamp || '').localeCompare(String(right.timestamp || '')));
  }
  next.updatedAt = now.toISOString();
  return next;
}

function addIncrementalAccount(targetMap, accountKey, accountDelta = {}) {
  if (!targetMap[accountKey]) {
    targetMap[accountKey] = cloneJson(accountDelta);
    targetMap[accountKey].summary = createRepairUsageBucket();
    targetMap[accountKey].models = {};
  }
  const target = targetMap[accountKey];
  for (const field of ['provider', 'providerUuid', 'accountIdentity', 'accountEmail', 'providerName']) {
    if (accountDelta[field] !== undefined) target[field] = accountDelta[field];
  }
  target.providerUuids = [...new Set([...(target.providerUuids || []), ...(accountDelta.providerUuids || [])].filter(Boolean))];
  target.summary ||= createRepairUsageBucket();
  target.models ||= {};
  applyUsageDelta(target.summary, currentUsageSummary(accountDelta.summary));
  adjustUsageMap(target.models, accountDelta.models, {});
  target.summary = preserveRepairPeaks(target.summary, accountDelta.summary);
  for (const [model, usage] of Object.entries(accountDelta.models || {})) {
    target.models[model] = preserveRepairPeaks(target.models[model], usage);
  }
}

function buildNextModelStatsIncremental(currentStore, patch, now) {
  const next = cloneJson(currentStore);
  next.summary ||= createRepairUsageBucket();
  next.providers ||= {};
  next.accounts ||= {};
  next.accountUsageEvents ||= {};
  next.daily ||= {};

  for (const date of patch.eligibleDates) {
    const deltaDay = patch.modelDays?.[date];
    if (!deltaDay) continue;
    applyUsageDelta(next.summary, currentUsageSummary(deltaDay.summary));
    const day = next.daily[date] ||= { ...createRepairUsageBucket(), models: {}, accounts: {} };
    day.models ||= {};
    day.accounts ||= {};
    applyUsageDelta(day, currentUsageSummary(deltaDay.summary));
    adjustUsageMap(day.models, deltaDay.models, {});
    for (const [accountKey, accountDelta] of Object.entries(deltaDay.accounts || {})) {
      addIncrementalAccount(day.accounts, accountKey, accountDelta);
      addIncrementalAccount(next.accounts, accountKey, accountDelta);
    }

    for (const [provider, providerDelta] of Object.entries(patch.modelProviderDays?.[date] || {})) {
      if (!next.providers[provider]) next.providers[provider] = { summary: createRepairUsageBucket(), models: {} };
      next.providers[provider].summary ||= createRepairUsageBucket();
      next.providers[provider].models ||= {};
      applyUsageDelta(next.providers[provider].summary, currentUsageSummary(providerDelta.summary));
      adjustUsageMap(next.providers[provider].models, providerDelta.models, {});
    }
  }

  for (const [accountKey, events] of Object.entries(patch.modelAccountEvents || {})) {
    next.accountUsageEvents[accountKey] = [...(next.accountUsageEvents[accountKey] || []), ...(events || [])]
      .sort((left, right) => String(left?.timestamp || '').localeCompare(String(right?.timestamp || '')));
  }
  next.updatedAt = now.toISOString();
  return next;
}

function resolveInside(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('artifact path escapes bundle');
  }
  return resolved;
}

async function verifyRepairArtifacts(bundle, manifest) {
  for (const artifact of manifest.artifacts || []) {
    const filePath = resolveInside(bundle, artifact.path);
    if (!fs.existsSync(filePath)) throw new Error(`repair artifact missing: ${artifact.path}`);
    if (await sha256File(filePath) !== artifact.sha256) throw new Error(`repair artifact hash mismatch: ${artifact.path}`);
  }
}

async function repairMarkerMatches({ markerPath, manifestSha256, reportSha256, base, bundle, eligibleDates, targets }) {
  if (!fs.existsSync(markerPath)) return false;
  const marker = await readJson(markerPath);
  if (marker.manifestSha256 !== manifestSha256 || marker.reportSha256 !== reportSha256) {
    throw new Error('repair marker approval mismatch');
  }
  const potluckStore = await readJson(path.join(base, 'api-potluck-keys.json'));
  const modelStatsStore = await readJsonIfExists(path.join(base, 'model-usage-stats.json'), {
    summary: {}, providers: {}, accounts: {}, accountUsageEvents: {}, daily: {},
  });
  const currentBaseline = await buildRepairBaseline({
    potluckStore,
    modelStatsStore,
    ledgerRoot: path.join(base, 'permanent-usage-ledger'),
    dates: eligibleDates,
    targets,
  });
  if (sha256Text(stableJson(currentBaseline)) !== marker.appliedBaselineDigest) {
    throw new Error('repair marker exists but approved slices changed');
  }
  if (targets.includes('ledger')) for (const date of eligibleDates) {
    for (const kind of ['daily', 'hourly']) {
      const target = path.join(base, 'permanent-usage-ledger', kind, `usage-${date}.jsonl`);
      const candidate = path.join(bundle, 'ledger', kind, `usage-${date}.jsonl`);
      if (!fs.existsSync(target) || await sha256File(target) !== await sha256File(candidate)) {
        throw new Error('repair marker exists but ledger verification failed');
      }
    }
  }
  return true;
}

async function backupRepairTargets({ base, targets, backupDir }) {
  if (fs.existsSync(backupDir)) throw new Error('backup directory already exists');
  await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const entries = [];
  for (const target of targets) {
    const relative = path.relative(base, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('repair target escapes base');
    const backupPath = path.join(backupDir, relative);
    const exists = fs.existsSync(target);
    if (exists) {
      await fsp.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      await fsp.copyFile(target, backupPath);
      await fsp.chmod(backupPath, 0o600).catch(() => {});
    }
    entries.push({ relative, existed: exists, sha256: exists ? await sha256File(target) : null });
  }
  await writeJsonMode(path.join(backupDir, 'backup-manifest.json'), { createdAt: new Date().toISOString(), entries });
  return entries;
}

async function restoreRepairTargets({ base, backupDir, entries }) {
  for (const entry of entries) {
    const target = path.join(base, entry.relative);
    const backupPath = path.join(backupDir, entry.relative);
    if (entry.existed) {
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fsp.copyFile(backupPath, target);
      await fsp.chmod(target, 0o600).catch(() => {});
    } else {
      await fsp.rm(target, { force: true });
    }
  }
}

async function replaceRepairTargets(targets) {
  const staged = [];
  try {
    for (const target of targets) {
      await fsp.mkdir(path.dirname(target.path), { recursive: true, mode: 0o700 });
      const tempPath = `${target.path}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.repair.tmp`;
      const handle = await fsp.open(tempPath, 'w', 0o600);
      try {
        await handle.writeFile(target.body);
        await handle.sync();
      } finally {
        await handle.close();
      }
      staged.push({ ...target, tempPath });
    }
    for (const target of staged) {
      await fsp.rename(target.tempPath, target.path);
      await fsp.chmod(target.path, 0o600).catch(() => {});
    }
  } finally {
    await Promise.all(staged.map(target => fsp.rm(target.tempPath, { force: true }).catch(() => {})));
  }
}

export async function applyRepairBundle({
  base,
  bundle,
  approvedManifestSha256,
  approvedReportSha256,
  backupDir,
  now = new Date(),
  replaceTargets = replaceRepairTargets,
}) {
  if (!base || !bundle || !backupDir) throw new Error('base, bundle, and backupDir are required');
  const manifestPath = path.join(bundle, 'manifest.json');
  const reportPath = path.join(bundle, 'report.json');
  const patchPath = path.join(bundle, 'patch.json');
  const manifestSha256 = await sha256File(manifestPath);
  if (manifestSha256 !== approvedManifestSha256) throw new Error('manifest approval hash mismatch');
  const reportSha256 = await sha256File(reportPath);
  if (reportSha256 !== approvedReportSha256) throw new Error('report approval hash mismatch');
  const manifest = await readJson(manifestPath);
  if (manifest.reportSha256 !== reportSha256) throw new Error('manifest report hash mismatch');
  await verifyRepairArtifacts(bundle, manifest);
  const patch = await readJson(patchPath);
  if (!Array.isArray(patch.eligibleDates) || patch.eligibleDates.length === 0) throw new Error('repair bundle has no eligible dates');
  const repairTargets = normalizeRepairTargets(patch.targets);

  const markerPath = path.join(base, 'permanent-usage-ledger', 'repairs', `${manifestSha256}.json`);
  if (await repairMarkerMatches({
    markerPath,
    manifestSha256,
    reportSha256,
    base,
    bundle,
    eligibleDates: patch.eligibleDates,
    targets: repairTargets,
  })) {
    return { status: 'already-applied', eligibleDates: patch.eligibleDates };
  }

  const files = await discoverRepairAuditFiles({
    auditDir: path.join(base, 'request-audit'),
    from: patch.from,
    to: patch.to,
  });
  const exactFrom = patch.eventWindowFrom || patch.from;
  const exactTo = patch.eventWindowTo || patch.to;
  const scan = await scanRepairAuditFiles({ files, from: exactFrom, to: exactTo, collectEvents: false });
  if (!patch.eventWindowFrom && scan.sourceEventDigest !== patch.sourceEventDigest) {
    throw new Error('repair source event digest changed');
  }
  const currentSourceFiles = scan.sourceFiles.map(file => ({ utcDate: file.utcDate, sha256: file.sha256, size: file.size }));
  const currentByPath = new Map(scan.sourceFiles.map(file => [path.relative(base, file.path).replaceAll('\\', '/'), file]));
  for (const expected of patch.sourceFiles || []) {
    const expectedPath = expected.path || null;
    let current = expectedPath ? currentByPath.get(expectedPath) : null;
    if (!current) {
      const candidates = scan.sourceFiles.filter(file => file.utcDate === expected.utcDate && file.size >= expected.size);
      const matches = [];
      for (const candidate of candidates) {
        const prefix = await sha256FilePrefix(candidate.path, expected.size);
        if (prefix.size === expected.size && prefix.sha256 === expected.sha256) matches.push(candidate);
      }
      if (matches.length === 1) current = matches[0];
      else if (matches.length > 1) throw new Error(`repair source file match ambiguous: ${expected.utcDate}`);
    }
    if (!current) throw new Error(`repair source file missing: ${expectedPath || expected.utcDate}`);
    if (current.size < expected.size) throw new Error(`repair source file truncated: ${expectedPath}`);
    const prefix = await sha256FilePrefix(current.path, expected.size);
    if (prefix.size !== expected.size || prefix.sha256 !== expected.sha256) {
      throw new Error(`repair source file prefix changed: ${expectedPath}`);
    }
  }

  const potluckPath = path.join(base, 'api-potluck-keys.json');
  const modelStatsPath = path.join(base, 'model-usage-stats.json');
  const ledgerRoot = path.join(base, 'permanent-usage-ledger');
  const potluckStore = await readJson(potluckPath);
  const modelStatsStore = await readJsonIfExists(modelStatsPath, { summary: {}, providers: {}, accounts: {}, accountUsageEvents: {}, daily: {} });
  const baseline = await buildRepairBaseline({
    potluckStore,
    modelStatsStore,
    ledgerRoot,
    dates: patch.eligibleDates,
    targets: repairTargets,
  });
  if (sha256Text(stableJson(baseline)) !== patch.baselineDigest) throw new Error('repair baseline changed');

  const nextPotluck = repairTargets.includes('potluck') ? buildNextPotluckStore(potluckStore, patch) : potluckStore;
  const nextModelStats = repairTargets.includes('model-stats')
    ? (patch.repairMode === 'incremental'
      ? buildNextModelStatsIncremental(modelStatsStore, patch, now)
      : buildNextModelStatsStore(modelStatsStore, patch, now))
    : modelStatsStore;
  const candidateDailyRowsByDate = {};
  const candidateHourlyRowsByDate = {};
  for (const date of patch.eligibleDates) {
    candidateDailyRowsByDate[date] = await readJsonlFiles([
      path.join(bundle, 'ledger', 'daily', `usage-${date}.jsonl`),
    ]);
    candidateHourlyRowsByDate[date] = await readJsonlFiles([
      path.join(bundle, 'ledger', 'hourly', `usage-${date}.jsonl`),
    ]);
  }
  const expectedAppliedBaseline = await buildRepairBaseline({
    potluckStore: nextPotluck,
    modelStatsStore: nextModelStats,
    ledgerRoot,
    dates: patch.eligibleDates,
    targets: repairTargets,
    dailyLedgerRowsByDate: candidateDailyRowsByDate,
    hourlyLedgerRowsByDate: candidateHourlyRowsByDate,
  });
  const appliedBaselineDigest = sha256Text(stableJson(expectedAppliedBaseline));
  const targetBodies = [];
  if (repairTargets.includes('potluck')) targetBodies.push({ path: potluckPath, body: `${JSON.stringify(nextPotluck, null, 2)}\n` });
  if (repairTargets.includes('model-stats')) targetBodies.push({ path: modelStatsPath, body: `${JSON.stringify(nextModelStats, null, 2)}\n` });
  if (repairTargets.includes('ledger')) for (const date of patch.eligibleDates) {
    for (const kind of ['daily', 'hourly']) {
      const source = path.join(bundle, 'ledger', kind, `usage-${date}.jsonl`);
      targetBodies.push({
        path: path.join(ledgerRoot, kind, `usage-${date}.jsonl`),
        body: await fsp.readFile(source),
      });
    }
  }
  targetBodies.push({
    path: markerPath,
    body: `${JSON.stringify({
      schemaVersion: 1,
      appliedAt: now.toISOString(),
      manifestSha256,
      reportSha256,
      eligibleDates: patch.eligibleDates,
      targets: repairTargets,
      appliedBaselineDigest,
    }, null, 2)}\n`,
  });

  const backupEntries = await backupRepairTargets({
    base,
    targets: targetBodies.map(target => target.path),
    backupDir,
  });
  try {
    await replaceTargets(targetBodies);
  } catch (error) {
    await restoreRepairTargets({ base, backupDir, entries: backupEntries });
    throw error;
  }
  return { status: 'applied', eligibleDates: patch.eligibleDates, backupDir, markerPath };
}

async function commandRepairReport(args) {
  const base = args.base || process.cwd();
  const from = args.from;
  const to = args.to || from;
  const outDir = args['out-dir'];
  if (!from) throw new Error('--from is required');
  if (!outDir) throw new Error('--out-dir is required');
  const now = args.now ? new Date(args.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('--now must be an ISO timestamp');
  const allowCurrentDate = args['allow-current-date'] === 'true';
  const targets = args.targets ? args.targets.split(',') : undefined;
  const result = await createRepairBundle({ base, from, to, outDir, now, allowCurrentDate, targets });
  console.log(JSON.stringify({
    outDir: result.outDir,
    manifestSha256: result.manifestSha256,
    reportSha256: result.reportSha256,
    eligibleDates: result.manifest.eligibleDates,
    days: result.report.days.map(day => ({
      date: day.date,
      eligible: day.eligible,
      unknownPotluckKeys: day.unknownPotluckKeys,
      missingSourceDates: day.missingSourceDates,
      corruptSourceDates: day.corruptSourceDates,
    })),
  }, null, 2));
}

async function commandRepairApply(args) {
  const base = args.base || process.cwd();
  const bundle = args.bundle;
  const backupDir = args['backup-dir'];
  const approvedManifestSha256 = args['approved-manifest-sha256'];
  const approvedReportSha256 = args['approved-report-sha256'];
  if (!bundle) throw new Error('--bundle is required');
  if (!backupDir) throw new Error('--backup-dir is required');
  if (!approvedManifestSha256) throw new Error('--approved-manifest-sha256 is required');
  if (!approvedReportSha256) throw new Error('--approved-report-sha256 is required');
  const now = args.now ? new Date(args.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('--now must be an ISO timestamp');
  const result = await applyRepairBundle({
    base,
    bundle,
    approvedManifestSha256,
    approvedReportSha256,
    backupDir,
    now,
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function commandWrite(args) {
  const base = args.base || process.cwd();
  const from = args.from;
  const to = args.to || from;
  if (!from) throw new Error('--from is required');
  const store = await readJson(path.join(base, 'api-potluck-keys.json'));
  const ledgerRoot = args['ledger-dir'] || path.join(base, 'permanent-usage-ledger');
  const sqlitePath = args['sqlite-path'] || process.env.USAGE_EVENT_DB_PATH || path.join(base, 'usage-events', 'usage-events.sqlite');
  const dailyRows = args.hourly ? [] : (
    buildDailyRowsFromSqlite(sqlitePath, store, { from, to })
      ?? buildDailyRowsFromPotluck(store, { from, to })
  );
  const hourlyRows = args.daily ? [] : (
    buildHourlyRowsFromSqlite(sqlitePath, store, { from, to })
      ?? buildHourlyRowsFromPotluck(store, { from, to })
  );
  const result = {
    daily: await writeRowsByDate(dailyRows, path.join(ledgerRoot, 'daily')),
    hourly: await writeRowsByDate(hourlyRows, path.join(ledgerRoot, 'hourly')),
    dailyRows: dailyRows.length,
    hourlyRows: hourlyRows.length,
  };
  console.log(JSON.stringify(result, null, 2));
}

async function commandRecomputeAudit(args) {
  const base = args.base || process.cwd();
  const from = args.from;
  const to = args.to || from;
  if (!from) throw new Error('--from is required');
  const auditDir = args['audit-dir'] || path.join(base, 'request-audit');
  const files = dateKeys(from, to).map(date => path.join(auditDir, `audit-${date}.jsonl`));
  const events = await readJsonlFiles(files);
  let keyLookup = null;
  try {
    keyLookup = buildKeyLookup(await readJson(path.join(base, 'api-potluck-keys.json')));
  } catch {
    keyLookup = null;
  }
  const result = aggregateAuditEvents(events, { from, to, keyLookup });
  const outRoot = args['out-dir'] || path.join(base, 'permanent-usage-ledger', 'recompute-candidates', new Date().toISOString().replace(/[:.]/g, ''));
  const written = {
    daily: await writeRowsByDate(result.dailyRows, path.join(outRoot, 'daily')),
    hourly: await writeRowsByDate(result.hourlyRows, path.join(outRoot, 'hourly')),
  };
  console.log(JSON.stringify({ ...summarizeAggregationResult(result), written }, null, 2));
}

async function readLedgerDailyRows(ledgerRoot, date) {
  const filePath = path.join(ledgerRoot, 'daily', `usage-${date}.jsonl`);
  if (!fs.existsSync(filePath)) return null;
  return readJsonlFiles([filePath]);
}

async function readLedgerHourlyRows(ledgerRoot, date) {
  const filePath = path.join(ledgerRoot, 'hourly', `usage-${date}.jsonl`);
  if (!fs.existsSync(filePath)) return null;
  return readJsonlFiles([filePath]);
}

async function commandReconcile(args) {
  const base = args.base || process.cwd();
  const from = args.from;
  const to = args.to || from;
  if (!from) throw new Error('--from is required');
  const thresholdRatio = Number(args.threshold ?? 0.005);
  const ledgerRoot = args['ledger-dir'] || path.join(base, 'permanent-usage-ledger');
  const auditDir = args['audit-dir'] || path.join(base, 'request-audit');
  const outDir = args['out-dir'] || path.join(ledgerRoot, 'reconciliation');

  let store = null;
  let keyLookup = null;
  let providerByEmail = new Map();
  try {
    store = await readJson(path.join(base, 'api-potluck-keys.json'));
    keyLookup = buildKeyLookup(store);
    providerByEmail = buildUniqueEmailProviderMap(store);
  } catch {
    store = null;
  }

  const results = [];
  for (const date of dateKeys(from, to)) {
    const ledgerRows = await readLedgerDailyRows(ledgerRoot, date);
    const ledgerSummary = ledgerRows === null ? null : summarizeLedgerRows(ledgerRows);
    const hourlyRows = await readLedgerHourlyRows(ledgerRoot, date);
    const hourlySummary = hourlyRows === null ? null : summarizeLedgerRows(hourlyRows);

    const auditFile = path.join(auditDir, `audit-${date}.jsonl`);
    let auditSummary = null;
    if (fs.existsSync(auditFile)) {
      const events = await readJsonlFiles([auditFile]);
      const aggregated = aggregateAuditEvents(events, { from: date, to: date, keyLookup, providerByEmail });
      auditSummary = summarizeLedgerRows(aggregated.dailyRows);
    }

    const potluckSummary = store === null ? null : summarizePotluckDay(store, date);

    const result = reconcileDay({ date, ledgerSummary, hourlySummary, auditSummary, potluckSummary, thresholdRatio });
    results.push(result);

    await fsp.mkdir(outDir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify(result, null, 2);
    await fsp.writeFile(path.join(outDir, `reconcile-${date}.json`), body, { encoding: 'utf8', mode: 0o600 });
  }

  if (results.length > 0) {
    const latest = results[results.length - 1];
    await fsp.writeFile(path.join(outDir, 'latest.json'), JSON.stringify(latest, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  console.log(JSON.stringify({
    thresholdRatio,
    results: results.map(result => ({
      date: result.date,
      status: result.status,
      comparisons: result.comparisons.map(comparison => ({
        pair: comparison.pair,
        exceeded: comparison.exceeded,
      })),
    })),
  }, null, 2));

  if (results.some(result => result.status === 'deviation')) {
    process.exitCode = 2;
  }
}

async function commandCleanupHourly(args) {
  const base = args.base || process.cwd();
  const days = Number(args.days || 35);
  const hourlyDir = args['hourly-dir'] || path.join(base, 'permanent-usage-ledger', 'hourly');
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const deleted = [];
  if (fs.existsSync(hourlyDir)) {
    for (const name of await fsp.readdir(hourlyDir)) {
      const match = name.match(/^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match || match[1] >= cutoffKey) continue;
      const filePath = path.join(hourlyDir, name);
      await fsp.unlink(filePath);
      deleted.push(filePath);
    }
  }
  console.log(JSON.stringify({ cutoffKey, deleted }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command === 'write') return commandWrite(args);
  if (command === 'recompute-audit') return commandRecomputeAudit(args);
  if (command === 'cleanup-hourly') return commandCleanupHourly(args);
  if (command === 'reconcile') return commandReconcile(args);
  if (command === 'repair-report') return commandRepairReport(args);
  if (command === 'repair-apply') return commandRepairApply(args);
  throw new Error('Usage: daily-usage-ledger.mjs <write|recompute-audit|cleanup-hourly|reconcile|repair-report|repair-apply> [options]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
