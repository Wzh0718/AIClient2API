import crypto from 'node:crypto';

const USAGE_SUM_FIELDS = [
  'requestCount',
  'promptTokens',
  'cachedTokens',
  'completionTokens',
  'reasoningTokens',
  'totalTokens',
];
const USAGE_MAX_FIELDS = ['maxQps', 'maxRpm', 'maxTps'];

function normalizeEmail(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
}

function hashSecret(value) {
  if (!value) return null;
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function mergeUsage(target = {}, source = {}) {
  for (const field of USAGE_SUM_FIELDS) target[field] = toNumber(target[field]) + toNumber(source[field]);
  for (const field of USAGE_MAX_FIELDS) target[field] = Math.max(toNumber(target[field]), toNumber(source[field]));
  if (source.lastUsedAt && (!target.lastUsedAt || source.lastUsedAt > target.lastUsedAt)) target.lastUsedAt = source.lastUsedAt;
  return target;
}

function mergeUsageMap(target = {}, source = {}) {
  for (const [key, value] of Object.entries(source || {})) {
    if (!target[key]) target[key] = {};
    mergeUsage(target[key], value);
  }
  return target;
}

export function buildCanonicalIdentityCatalog({ providerPools = {}, overrides = {}, aliases = {} } = {}) {
  const identityByReference = new Map();
  const aliasMap = new Map();

  for (const providers of Object.values(providerPools || {})) {
    if (!Array.isArray(providers)) continue;
    for (const provider of providers) {
      const uuid = provider?.uuid;
      const email = normalizeEmail(provider?.codexEmail)
        || normalizeEmail(provider?.CODEX_EMAIL)
        || normalizeEmail(provider?.email)
        || normalizeEmail(provider?.customName);
      if (!uuid || !email) continue;
      identityByReference.set(uuid, email);
      identityByReference.set(hashSecret(uuid), email);
    }
  }

  for (const [reference, value] of Object.entries(overrides || {})) {
    const email = normalizeEmail(value);
    if (!email) continue;
    identityByReference.set(reference, email);
    const uuid = reference.includes(':') ? reference.split(':').at(-1) : reference;
    identityByReference.set(uuid, email);
    identityByReference.set(hashSecret(uuid), email);
  }

  for (const [oldEmail, newEmail] of Object.entries(aliases || {})) {
    const oldValue = normalizeEmail(oldEmail);
    const newValue = normalizeEmail(newEmail);
    if (oldValue && newValue) aliasMap.set(oldValue, newValue);
  }

  return {
    resolve(account = {}) {
      const references = [
        account.providerUuidHash,
        account.providerUuid,
        ...(Array.isArray(account.providerUuids) ? account.providerUuids : []),
      ].filter(Boolean);
      for (const reference of references) {
        const email = identityByReference.get(reference);
        if (email) return email;
      }
      const direct = normalizeEmail(account.accountEmail)
        || normalizeEmail(account.accountIdentity)
        || normalizeEmail(account.providerName)
        || normalizeEmail(account.providerUuid);
      return aliasMap.get(direct) || direct;
    },
    identityByReference,
    aliasMap,
  };
}

function canonicalAccount(email, source = {}) {
  return {
    ...clone(source),
    provider: 'openai-codex-oauth',
    providerUuid: email,
    accountIdentity: email,
    accountEmail: email,
    providerName: email,
    providerUuids: [...new Set((source.providerUuids || []).filter(value => value && !normalizeEmail(value)))],
    summary: {},
    models: {},
  };
}

export function canonicalizeAccountMap(accounts = {}, catalog) {
  const result = {};
  for (const [accountKey, account] of Object.entries(accounts || {})) {
    const provider = account?.provider || String(accountKey).split(':')[0];
    if (!['openai-codex-oauth', 'openaiResponses-custom'].includes(provider)) {
      result[accountKey] = clone(account);
      continue;
    }
    const email = catalog.resolve(account) || normalizeEmail(String(accountKey).split(':').slice(1).join(':'));
    if (!email) {
      result[accountKey] = clone(account);
      continue;
    }
    const targetKey = `openai-codex-oauth:${email}`;
    if (!result[targetKey]) result[targetKey] = canonicalAccount(email, account);
    const target = result[targetKey];
    target.providerUuids = [...new Set([
      ...(target.providerUuids || []),
      ...(account.providerUuids || []),
      ...(!normalizeEmail(account.providerUuid) && account.providerUuid ? [account.providerUuid] : []),
    ].filter(Boolean))];
    mergeUsage(target.summary, account.summary);
    mergeUsageMap(target.models, account.models);
  }
  return result;
}

export function canonicalizeUsageTree(value, catalog) {
  const result = clone(value);
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.accounts && typeof node.accounts === 'object' && !Array.isArray(node.accounts)) {
      node.accounts = canonicalizeAccountMap(node.accounts, catalog);
    }
    for (const child of Object.values(node)) visit(child);
  }
  visit(result);
  return result;
}

function canonicalizeLedgerRow(row, catalog) {
  if (!['openai-codex-oauth', 'openaiResponses-custom'].includes(row?.provider)) return clone(row);
  const email = catalog.resolve(row);
  if (!email) return clone(row);
  return {
    ...clone(row),
    provider: 'openai-codex-oauth',
    accountKey: `openai-codex-oauth:${email}`,
    accountEmail: email,
    accountIdentity: email,
    providerName: email,
  };
}

function ledgerDimensionKey(row) {
  return JSON.stringify([
    row.schemaVersion, row.ledgerType, row.date, row.hour || null, row.source,
    row.provider, row.accountKey, row.keyHash || row.key, row.model,
    row.pricingVersion || null, row.cost?.pricingModel || null,
  ]);
}

export function canonicalizeLedgerRows(rows = [], catalog) {
  const merged = new Map();
  const order = [];
  for (const original of rows) {
    const row = canonicalizeLedgerRow(original, catalog);
    const key = ledgerDimensionKey(row);
    if (!merged.has(key)) {
      merged.set(key, row);
      order.push(key);
      continue;
    }
    const target = merged.get(key);
    target.providerUuids = [...new Set([...(target.providerUuids || []), ...(row.providerUuids || [])].filter(Boolean))];
    mergeUsage(target.usage ||= {}, row.usage || {});
    target.cost ||= {};
    target.cost.actualUsd = toNumber(target.cost.actualUsd) + toNumber(row.cost?.actualUsd);
    target.cost.missingPriceTokens = toNumber(target.cost.missingPriceTokens) + toNumber(row.cost?.missingPriceTokens);
  }
  return order.map(key => merged.get(key));
}

export function createCodexAuditEventCanonicalizer({ catalog, from, to }) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error('valid from/to timestamps are required');
  }
  return event => {
    const provider = event?.request?.toProvider || event?.request?.actualProvider || event?.provider;
    if (!['openai-codex-oauth', 'openaiResponses-custom'].includes(provider)) return false;
    const timestampMs = Date.parse(event?.timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs < fromMs || timestampMs >= toMs) return false;
    event.account ||= {};
    const email = catalog.resolve(event.account);
    if (!email) return false;
    event.account.accountEmail = email;
    return true;
  };
}

export function summarizeUsage(value = {}) {
  return Object.fromEntries(USAGE_SUM_FIELDS.map(field => [field, toNumber(value[field])]));
}
