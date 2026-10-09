import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const PROVIDER = 'openai-codex-oauth';
const SUM_FIELDS = ['requestCount', 'promptTokens', 'cachedTokens', 'completionTokens', 'reasoningTokens', 'totalTokens'];
const MAX_FIELDS = ['maxQps', 'maxRpm', 'maxTps'];
const COST_FIELDS = ['usd', 'actualUsd', 'estimatedUsd', 'missingPriceTokens', 'estimatedPriceTokens'];
const KNOWN_USAGE_FIELDS = new Set([...SUM_FIELDS, ...MAX_FIELDS, 'lastUsedAt']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function email(value) {
  return String(value || '').trim().toLowerCase();
}

function hashUuid(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
}

function number(value, field) {
  const result = Number(value ?? 0);
  assert(Number.isFinite(result), `invalid ${field}`);
  return result;
}

function instanceFor(cache, targetEmail) {
  const providers = cache.data?.providers || cache.providers || {};
  const matches = (providers[PROVIDER]?.instances || []).filter(instance =>
    email(instance.codexEmail || instance.name) === targetEmail
  );
  assert(matches.length === 1, `expected one ${PROVIDER} cache instance for ${targetEmail}; found ${matches.length}`);
  const instance = matches[0];
  assert(instance.uuid && instance.codexAccountId, `missing UUID or Codex account ID for ${targetEmail}`);
  return instance;
}

function identity(base, oldCachePath, oldEmail, newEmail) {
  assert(oldEmail && newEmail && oldEmail !== newEmail, 'distinct old/new emails are required');
  const oldInstance = instanceFor(readJson(oldCachePath), oldEmail);
  const currentInstance = instanceFor(readJson(path.join(base, 'usage-display-cache.json')), newEmail);
  assert(oldInstance.codexAccountId === currentInstance.codexAccountId, 'Codex account IDs differ; aborting');
  const currentPool = readJson(path.join(base, 'provider_pools.json'));
  const poolMatches = (currentPool[PROVIDER] || []).filter(provider => provider.uuid === currentInstance.uuid);
  assert(poolMatches.length === 1, 'current credential UUID does not uniquely match provider_pools.json');
  assert(poolMatches[0].codexAccountId === currentInstance.codexAccountId, 'current pool account ID differs from usage cache');
  return {
    oldUuid: oldInstance.uuid,
    currentUuid: currentInstance.uuid,
    oldHash: hashUuid(oldInstance.uuid),
    currentHash: hashUuid(currentInstance.uuid),
    accountIdHash: hashUuid(currentInstance.codexAccountId),
  };
}

function usageTotals(accounts) {
  const totals = Object.fromEntries(SUM_FIELDS.map(field => [field, 0]));
  for (const account of Object.values(accounts || {})) {
    for (const field of SUM_FIELDS) totals[field] += number(account?.summary?.[field], field);
  }
  return totals;
}

function checkUsageFields(value) {
  for (const field of Object.keys(value || {})) {
    assert(KNOWN_USAGE_FIELDS.has(field), `unknown usage field ${field}; aborting instead of dropping it`);
  }
}

function mergeUsage(left = {}, right = {}) {
  checkUsageFields(left);
  checkUsageFields(right);
  const result = {};
  for (const field of SUM_FIELDS) result[field] = number(left[field], field) + number(right[field], field);
  for (const field of MAX_FIELDS) result[field] = Math.max(number(left[field], field), number(right[field], field));
  result.lastUsedAt = [left.lastUsedAt, right.lastUsedAt].filter(Boolean).sort().at(-1) || null;
  return result;
}

function canonicalAccount(account, newEmail) {
  assert(account?.provider === PROVIDER, 'old email account has an unexpected provider');
  const result = clone(account);
  result.provider = PROVIDER;
  result.providerUuid = newEmail;
  result.accountIdentity = newEmail;
  result.accountEmail = newEmail;
  result.providerName = newEmail;
  result.providerUuids = [...new Set((result.providerUuids || []).filter(Boolean))];
  return result;
}

function mergeAccounts(left, right, newEmail) {
  const result = canonicalAccount(left, newEmail);
  const incoming = canonicalAccount(right, newEmail);
  result.providerUuids = [...new Set([...result.providerUuids, ...incoming.providerUuids])];
  result.summary = mergeUsage(result.summary, incoming.summary);
  for (const [model, usage] of Object.entries(incoming.models || {})) {
    result.models ||= {};
    result.models[model] = result.models[model] ? mergeUsage(result.models[model], usage) : clone(usage);
  }
  return result;
}

function transformAccountMap(accounts, context, stats) {
  const oldKey = `${PROVIDER}:${context.oldEmail}`;
  const newKey = `${PROVIDER}:${context.newEmail}`;
  const verifiedUnknownKey = `unknown:${context.identity.oldHash}`;
  const before = usageTotals(accounts);
  let changed = false;
  if (Object.hasOwn(accounts, oldKey)) {
    const old = accounts[oldKey];
    assert(email(old.accountEmail || old.accountIdentity || old.providerName) === context.oldEmail,
      `old account metadata disagrees with ${oldKey}`);
    const incoming = canonicalAccount(old, context.newEmail);
    accounts[newKey] = accounts[newKey]
      ? mergeAccounts(accounts[newKey], incoming, context.newEmail)
      : incoming;
    delete accounts[oldKey];
    stats.rekeyedAccountMaps += 1;
    changed = true;
  }
  if (context.includeVerifiedUnknown && Object.hasOwn(accounts, verifiedUnknownKey)) {
    const unknown = accounts[verifiedUnknownKey];
    assert(unknown.provider === 'unknown' && unknown.providerUuid === context.identity.oldHash,
      'verified legacy hash record has unexpected identity');
    if (email(unknown.accountEmail) === context.oldEmail) {
      unknown.accountEmail = context.newEmail;
      if (email(unknown.providerName) === context.oldEmail) unknown.providerName = context.newEmail;
      stats.verifiedUnknownMetadata += 1;
      changed = true;
    }
  }
  assert(JSON.stringify(before) === JSON.stringify(usageTotals(accounts)), 'account totals changed');
  return changed;
}

function transformTree(root, context, stats) {
  function visit(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (node.accounts && typeof node.accounts === 'object' && !Array.isArray(node.accounts)) {
      transformAccountMap(node.accounts, context, stats);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'accounts' && key !== 'accountUsageEvents') visit(value);
    }
  }
  visit(root);
  return root;
}

function transformModelStats(value, context, stats) {
  transformTree(value, { ...context, includeVerifiedUnknown: true }, stats);
  const oldKey = `${PROVIDER}:${context.oldEmail}`;
  const newKey = `${PROVIDER}:${context.newEmail}`;
  const events = value.accountUsageEvents || {};
  if (Object.hasOwn(events, oldKey)) {
    assert(Array.isArray(events[oldKey]), 'old account usage events are not an array');
    assert(!events[newKey] || Array.isArray(events[newKey]), 'new account usage events are not an array');
    stats.movedAccountEvents = events[oldKey].length;
    events[newKey] = [...(events[newKey] || []), ...events[oldKey]]
      .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    delete events[oldKey];
  }
  return value;
}

function ledgerKey(row) {
  return JSON.stringify([
    row.schemaVersion, row.ledgerType, row.date, row.hour || null, row.source,
    row.provider, row.accountKey, row.keyHash || row.key || null, row.model,
    row.pricingVersion || null, row.cost?.pricingModel || null, row.cost?.pricingSource || null,
  ]);
}

function rowTotals(rows) {
  const totals = Object.fromEntries([...SUM_FIELDS, ...COST_FIELDS].map(field => [field, 0]));
  for (const row of rows) {
    for (const field of SUM_FIELDS) totals[field] += number(row.usage?.[field], field);
    for (const field of COST_FIELDS) totals[field] += number(row.cost?.[field], field);
  }
  return totals;
}

function mergeLedgerRows(left, right) {
  const result = clone(left);
  for (const field of SUM_FIELDS) result.usage[field] = number(left.usage?.[field], field) + number(right.usage?.[field], field);
  for (const field of COST_FIELDS) result.cost[field] = number(left.cost?.[field], field) + number(right.cost?.[field], field);
  result.providerUuids = [...new Set([...(left.providerUuids || []), ...(right.providerUuids || [])])];
  return result;
}

function transformLedgerRows(rows, context, stats) {
  const oldKey = `${PROVIDER}:${context.oldEmail}`;
  const newKey = `${PROVIDER}:${context.newEmail}`;
  if (!rows.some(row => row.provider === PROVIDER && row.accountKey === oldKey)) return rows;
  const before = rowTotals(rows);
  const result = [];
  const accountIndices = new Map();
  for (const input of rows) {
    const old = input.provider === PROVIDER && input.accountKey === oldKey;
    if (old) assert(!input.accountEmail || email(input.accountEmail) === context.oldEmail,
      'old ledger account has conflicting email');
    const row = old ? {
      ...input,
      accountKey: newKey,
      accountEmail: context.newEmail,
      accountIdentity: context.newEmail,
      providerName: context.newEmail,
    } : input;
    if (old) stats.rekeyedLedgerRows += 1;
    if (row.provider !== PROVIDER || row.accountKey !== newKey) {
      result.push(row);
      continue;
    }
    const key = ledgerKey(row);
    const index = accountIndices.get(key);
    if (index === undefined) {
      accountIndices.set(key, result.length);
      result.push(row);
    } else {
      result[index] = mergeLedgerRows(result[index], row);
      stats.mergedLedgerRows += 1;
    }
  }
  assert(JSON.stringify(before) === JSON.stringify(rowTotals(result)), 'ledger totals changed');
  return result;
}

function ledgerFiles(base) {
  const files = [];
  for (const kind of ['daily', 'hourly']) {
    const dir = path.join(base, 'permanent-usage-ledger', kind);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (/^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) files.push(path.join(dir, name));
    }
  }
  return files.sort();
}

async function atomicWrite(filePath, body) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const handle = await fsp.open(tempPath, 'w', 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tempPath, filePath);
}

function freshStats() {
  return { rekeyedAccountMaps: 0, verifiedUnknownMetadata: 0, movedAccountEvents: 0,
    rekeyedLedgerRows: 0, mergedLedgerRows: 0, changedLedgerFiles: 0, changedSqliteRows: 0 };
}

export async function createSnapshot({ base, oldCachePath, snapshotDir } = {}) {
  assert(base && oldCachePath && snapshotDir, 'base, oldCachePath and snapshotDir are required');
  const sourceRoot = path.resolve(base);
  const targetRoot = path.resolve(snapshotDir);
  assert(targetRoot !== sourceRoot && !targetRoot.startsWith(`${sourceRoot}${path.sep}`),
    'snapshot must be outside the config volume');
  assert(!fs.existsSync(targetRoot), 'snapshot directory already exists');
  await fsp.mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const files = [
    'provider_pools.json', 'usage-display-cache.json', 'model-usage-stats.json', 'api-potluck-keys.json',
  ];
  const oldRelative = path.relative(sourceRoot, path.resolve(oldCachePath));
  assert(!oldRelative.startsWith('..') && !path.isAbsolute(oldRelative), 'old cache must be inside config volume');
  files.push(oldRelative);
  for (const relative of files) {
    const destination = path.join(targetRoot, relative);
    await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fsp.copyFile(path.join(sourceRoot, relative), destination);
  }
  for (const kind of ['daily', 'hourly']) {
    const source = path.join(sourceRoot, 'permanent-usage-ledger', kind);
    if (!fs.existsSync(source)) continue;
    await fsp.cp(source, path.join(targetRoot, 'permanent-usage-ledger', kind), { recursive: true });
  }
  const sourceDb = new Database(path.join(sourceRoot, 'usage-events', 'usage-events.sqlite'),
    { readonly: true, fileMustExist: true });
  const destinationPath = path.join(targetRoot, 'usage-events', 'usage-events.sqlite');
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  const targetDb = new Database(destinationPath);
  let copiedRows = 0;
  try {
    targetDb.exec(`CREATE TABLE potluck_usage_history (
      key_ref TEXT NOT NULL, usage_date TEXT NOT NULL, day_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (key_ref, usage_date)
    )`);
    const insert = targetDb.prepare('INSERT INTO potluck_usage_history (key_ref, usage_date, day_json, updated_at) VALUES (?, ?, ?, ?)');
    targetDb.transaction(() => {
      for (const row of sourceDb.prepare('SELECT key_ref, usage_date, day_json, updated_at FROM potluck_usage_history').iterate()) {
        insert.run(row.key_ref, row.usage_date, row.day_json, row.updated_at);
        copiedRows += 1;
      }
    })();
  } finally {
    sourceDb.close();
    targetDb.close();
  }
  return { status: 'snapshot-created', snapshotDir: targetRoot, copiedRows,
    sqliteProjection: 'potluck_usage_history only' };
}

export async function runRepair({ base, oldCachePath, oldEmail, newEmail, apply = false, backupArchive = null } = {}) {
  assert(base && oldCachePath, 'base and oldCachePath are required');
  const configRoot = path.resolve(base);
  const oldValue = email(oldEmail);
  const newValue = email(newEmail);
  assert(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(oldValue), 'invalid old email');
  assert(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newValue), 'invalid new email');
  const verified = identity(configRoot, path.resolve(oldCachePath), oldValue, newValue);
  const context = { oldEmail: oldValue, newEmail: newValue, identity: verified };
  const stats = freshStats();
  const changes = [];

  const modelPath = path.join(configRoot, 'model-usage-stats.json');
  const modelBefore = fs.readFileSync(modelPath, 'utf8');
  const modelAfter = `${JSON.stringify(transformModelStats(JSON.parse(modelBefore), context, stats), null, 2)}\n`;
  if (JSON.stringify(JSON.parse(modelBefore)) !== JSON.stringify(JSON.parse(modelAfter))) {
    changes.push({ path: modelPath, body: modelAfter });
  }

  const potluckPath = path.join(configRoot, 'api-potluck-keys.json');
  if (fs.existsSync(potluckPath)) {
    const before = fs.readFileSync(potluckPath, 'utf8');
    const after = `${JSON.stringify(transformTree(JSON.parse(before), context, stats), null, 2)}\n`;
    if (JSON.stringify(JSON.parse(before)) !== JSON.stringify(JSON.parse(after))) {
      changes.push({ path: potluckPath, body: after });
    }
  }

  for (const filePath of ledgerFiles(configRoot)) {
    const before = fs.readFileSync(filePath, 'utf8');
    const rows = before.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const afterRows = transformLedgerRows(rows, context, stats);
    if (JSON.stringify(rows) === JSON.stringify(afterRows)) continue;
    stats.changedLedgerFiles += 1;
    changes.push({ path: filePath, body: `${afterRows.map(JSON.stringify).join('\n')}\n` });
  }

  const sqlitePath = path.join(configRoot, 'usage-events', 'usage-events.sqlite');
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const sqliteUpdates = [];
  try {
    for (const row of db.prepare('SELECT key_ref, usage_date, day_json FROM potluck_usage_history').iterate()) {
      const value = JSON.parse(row.day_json);
      const before = JSON.stringify(value);
      transformTree(value, context, stats);
      const after = JSON.stringify(value);
      if (before === after) continue;
      sqliteUpdates.push({ keyRef: row.key_ref, usageDate: row.usage_date, dayJson: after });
    }
  } finally {
    db.close();
  }
  stats.changedSqliteRows = sqliteUpdates.length;

  const report = {
    status: apply ? 'pending' : 'dry-run',
    accountIdHash: verified.accountIdHash,
    oldUuidHash: verified.oldHash,
    currentUuidHash: verified.currentHash,
    changedFiles: changes.map(item => path.relative(configRoot, item.path)),
    ...stats,
  };
  if (!apply) return report;
  assert(backupArchive, 'apply requires an external backup archive');
  const archive = path.resolve(backupArchive);
  assert(!archive.startsWith(`${configRoot}${path.sep}`), 'backup archive must be outside the config volume');
  assert(fs.statSync(archive).size > 0, 'backup archive is empty');
  for (const item of changes) await atomicWrite(item.path, item.body);
  if (sqliteUpdates.length > 0) {
    const writable = new Database(sqlitePath, { fileMustExist: true });
    try {
      const update = writable.prepare('UPDATE potluck_usage_history SET day_json = ?, updated_at = CURRENT_TIMESTAMP WHERE key_ref = ? AND usage_date = ?');
      writable.transaction(rows => {
        for (const row of rows) {
          const result = update.run(row.dayJson, row.keyRef, row.usageDate);
          assert(result.changes === 1, 'SQLite row disappeared during migration');
        }
      })(sqliteUpdates);
      assert(writable.pragma('integrity_check', { simple: true }) === 'ok', 'SQLite integrity check failed');
    } finally {
      writable.close();
    }
  }
  return { ...report, status: 'applied', backupArchive: archive };
}

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    if (!item.startsWith('--')) throw new Error(`unknown argument ${item}`);
    const [key, ...rest] = item.slice(2).split('=');
    args[key] = rest.length ? rest.join('=') : true;
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const action = args['snapshot-dir'] ? createSnapshot({
    base: args.base,
    oldCachePath: args['old-cache'],
    snapshotDir: args['snapshot-dir'],
  }) : runRepair({
    base: args.base,
    oldCachePath: args['old-cache'],
    oldEmail: args['old-email'],
    newEmail: args['new-email'],
    apply: args.apply === true,
    backupArchive: args['backup-archive'],
  });
  action.then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
