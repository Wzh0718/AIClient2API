import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  buildCanonicalIdentityCatalog,
  canonicalizeAccountMap,
  canonicalizeLedgerRows,
  canonicalizeUsageTree,
  summarizeUsage,
} from './codex-credential-identity.mjs';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function sumAccountMap(accounts = {}) {
  const total = {};
  for (const account of Object.values(accounts || {})) {
    const usage = summarizeUsage(account?.summary || {});
    for (const [field, value] of Object.entries(usage)) total[field] = Number(total[field] || 0) + value;
  }
  return summarizeUsage(total);
}

function canonicalizeAccountUsageEvents(events = {}, originalAccounts = {}, catalog) {
  const result = {};
  for (const [accountKey, values] of Object.entries(events || {})) {
    const account = originalAccounts[accountKey] || {
      provider: accountKey.split(':')[0],
      accountEmail: accountKey.split(':').slice(1).join(':'),
    };
    const email = catalog.resolve(account);
    if (!email) throw new Error(`unmapped account usage events identity: ${accountKey}`);
    const targetKey = `openai-codex-oauth:${email}`;
    result[targetKey] = [...(result[targetKey] || []), ...(Array.isArray(values) ? values : [])];
  }
  for (const values of Object.values(result)) {
    values.sort((left, right) => String(left?.timestamp || '').localeCompare(String(right?.timestamp || '')));
  }
  return result;
}

function canonicalizeModelStats(modelStats, catalog) {
  const originalAccounts = modelStats.accounts || {};
  const result = canonicalizeUsageTree(modelStats, catalog);
  result.accounts = canonicalizeAccountMap(originalAccounts, catalog);
  result.accountUsageEvents = canonicalizeAccountUsageEvents(modelStats.accountUsageEvents, originalAccounts, catalog);
  return result;
}

function listLedgerFiles(root) {
  const result = [];
  for (const kind of ['daily', 'hourly']) {
    const dir = path.join(root, kind);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (/^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) result.push(path.join(dir, name));
    }
  }
  return result.sort();
}

function transformLedgerFile(filePath, catalog) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const rows = lines.map(line => JSON.parse(line));
  const nextRows = canonicalizeLedgerRows(rows, catalog);
  const body = `${nextRows.map(JSON.stringify).join('\n')}\n`;
  return { changed: body !== text, body, beforeRows: rows.length, afterRows: nextRows.length };
}

function scanSqlite(sqlitePath, catalog, collectUpdates = false) {
  if (!fs.existsSync(sqlitePath)) return { changedRows: 0, updates: [] };
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const rows = db.prepare('SELECT key_ref, usage_date, day_json FROM potluck_usage_history').iterate();
  const updates = [];
  let changedRows = 0;
  try {
    for (const row of rows) {
      const next = JSON.stringify(canonicalizeUsageTree(JSON.parse(row.day_json), catalog));
      if (next === row.day_json) continue;
      changedRows += 1;
      if (collectUpdates) updates.push({ keyRef: row.key_ref, usageDate: row.usage_date, dayJson: next });
    }
  } finally {
    db.close();
  }
  return { changedRows, updates };
}

async function copyBackup(base, backupDir, target) {
  if (!fs.existsSync(target)) return null;
  const relative = path.relative(base, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('backup target escapes base');
  const destination = path.join(backupDir, relative);
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fsp.copyFile(target, destination);
  return { relative };
}

async function restoreBackups(base, backupDir, entries) {
  for (const entry of entries) {
    await fsp.copyFile(path.join(backupDir, entry.relative), path.join(base, entry.relative));
  }
}

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    if (!item.startsWith('--')) continue;
    const [key, ...rest] = item.slice(2).split('=');
    args[key] = rest.length ? rest.join('=') : true;
  }
  return args;
}

export async function runCredentialIdentityRepair({ base, aliases = {}, dryRun = true, backupDir = null } = {}) {
  if (!base) throw new Error('base is required');
  const providerPools = readJson(path.join(base, 'provider_pools.json'), {});
  const overrides = readJson(path.join(base, 'codex-email-identity-overrides.json'), {});
  const catalog = buildCanonicalIdentityCatalog({ providerPools, overrides, aliases });
  const mappingDigest = sha256(stableJson({ aliases, overrides }));
  const markerPath = path.join(base, 'permanent-usage-ledger', 'repairs', `codex-credential-identity-${mappingDigest}.json`);
  if (!dryRun && fs.existsSync(markerPath)) return { status: 'already-applied', markerPath };

  const modelPath = path.join(base, 'model-usage-stats.json');
  const potluckPath = path.join(base, 'api-potluck-keys.json');
  const sqlitePath = path.join(base, 'usage-events', 'usage-events.sqlite');
  const modelBefore = readJson(modelPath, { accounts: {}, accountUsageEvents: {}, daily: {} });
  const modelAfter = canonicalizeModelStats(modelBefore, catalog);
  const potluckBefore = readJson(potluckPath, { keys: {} });
  const potluckAfter = canonicalizeUsageTree(potluckBefore, catalog);
  const totalsBefore = sumAccountMap(modelBefore.accounts);
  const totalsAfter = sumAccountMap(modelAfter.accounts);
  if (stableJson(totalsBefore) !== stableJson(totalsAfter)) throw new Error('identity migration changes model account totals');

  const affectedLedgerFiles = [];
  let ledgerRowsBefore = 0;
  let ledgerRowsAfter = 0;
  for (const filePath of listLedgerFiles(path.join(base, 'permanent-usage-ledger'))) {
    const transformed = transformLedgerFile(filePath, catalog);
    if (!transformed.changed) continue;
    affectedLedgerFiles.push(filePath);
    ledgerRowsBefore += transformed.beforeRows;
    ledgerRowsAfter += transformed.afterRows;
  }
  const sqliteScan = scanSqlite(sqlitePath, catalog, false);
  const report = {
    status: dryRun ? 'dry-run' : 'pending',
    mappingDigest,
    totalsBefore,
    totalsAfter,
    modelChanged: stableJson(modelBefore) !== stableJson(modelAfter),
    potluckChanged: stableJson(potluckBefore) !== stableJson(potluckAfter),
    sqliteChangedRows: sqliteScan.changedRows,
    affectedLedgerFiles: affectedLedgerFiles.length,
    ledgerRowsBefore,
    ledgerRowsAfter,
  };
  if (dryRun) return report;
  if (!backupDir) throw new Error('backupDir is required for apply');
  if (fs.existsSync(backupDir)) throw new Error('backupDir already exists');
  await fsp.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backupTargets = [modelPath, potluckPath, sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`, ...affectedLedgerFiles];
  const backupEntries = (await Promise.all(backupTargets.map(target => copyBackup(base, backupDir, target)))).filter(Boolean);
  await atomicWrite(path.join(backupDir, 'backup-manifest.json'), `${JSON.stringify({ createdAt: new Date().toISOString(), entries: backupEntries }, null, 2)}\n`);

  try {
    if (report.modelChanged) await atomicWrite(modelPath, `${JSON.stringify(modelAfter, null, 2)}\n`);
    if (report.potluckChanged) await atomicWrite(potluckPath, `${JSON.stringify(potluckAfter, null, 2)}\n`);
    for (const filePath of affectedLedgerFiles) {
      const transformed = transformLedgerFile(filePath, catalog);
      if (transformed.changed) await atomicWrite(filePath, transformed.body);
    }
    if (sqliteScan.changedRows > 0) {
      const sqliteUpdates = scanSqlite(sqlitePath, catalog, true).updates;
      const db = new Database(sqlitePath);
      try {
        const update = db.prepare('UPDATE potluck_usage_history SET day_json = ?, updated_at = CURRENT_TIMESTAMP WHERE key_ref = ? AND usage_date = ?');
        db.transaction(items => {
          for (const item of items) update.run(item.dayJson, item.keyRef, item.usageDate);
        })(sqliteUpdates);
      } finally {
        db.close();
      }
    }
    await fsp.mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
    await atomicWrite(markerPath, `${JSON.stringify({ ...report, status: 'applied', appliedAt: new Date().toISOString(), backupDir }, null, 2)}\n`);
  } catch (error) {
    await restoreBackups(base, backupDir, backupEntries);
    throw error;
  }
  return { ...report, status: 'applied', backupDir, markerPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const aliases = args.aliases ? readJson(path.resolve(args.aliases), {}) : {};
  runCredentialIdentityRepair({
    base: args.base ? path.resolve(args.base) : process.cwd(),
    aliases,
    dryRun: args.apply !== true,
    backupDir: args['backup-dir'] ? path.resolve(args['backup-dir']) : null,
  }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

