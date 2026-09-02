#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export function resolveUsageLedgerScript({ baseDir = process.env.CONFIG_BASE_DIR || '/app/configs', scriptPath } = {}) {
  if (scriptPath) return path.resolve(scriptPath);
  if (path.resolve(baseDir) === path.resolve('/app/configs')) {
    return '/app/scripts/usage-ledger/daily-usage-ledger.mjs';
  }
  return path.resolve(baseDir, '..', 'scripts', 'usage-ledger', 'daily-usage-ledger.mjs');
}

export function resolveReconciliationDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
    return result;
  }, {});
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1)).toISOString().slice(0, 10);
}

export function classifyReconcileExitCode(code) {
  if (code === 0) return { generated: true, deviation: false };
  if (code === 2) return { generated: true, deviation: true };
  return { generated: false, deviation: false };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    result[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return result;
}

function runCommand(nodePath, script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [script, ...args], { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

async function withLock(lockPath, fn) {
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      console.log(JSON.stringify({ event: 'reconciliation_skipped', reason: 'already_running' }));
      return { skipped: true };
    }
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n`);
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

export async function runReconciliation({
  baseDir = process.env.CONFIG_BASE_DIR || '/app/configs',
  from = resolveReconciliationDate(),
  to = from,
  threshold = process.env.RECONCILIATION_THRESHOLD || '0.005',
  scriptPath = resolveUsageLedgerScript({ baseDir }),
} = {}) {
  const reconciliationDir = path.join(baseDir, 'permanent-usage-ledger', 'reconciliation');
  await fs.mkdir(reconciliationDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(reconciliationDir, '.runner.lock');
  return withLock(lockPath, async () => {
    const common = ['--base', baseDir, '--from', from, '--to', to];
    const write = await runCommand(process.execPath, scriptPath, ['write', ...common]);
    if (write.code !== 0) throw new Error(`usage ledger write failed with exit ${write.code}`);
    const cleanup = await runCommand(process.execPath, scriptPath, ['cleanup-hourly', '--base', baseDir, '--days', String(process.env.USAGE_LEDGER_HOURLY_RETENTION_DAYS || 35)]);
    if (cleanup.code !== 0) throw new Error(`hourly cleanup failed with exit ${cleanup.code}`);
    const reconcile = await runCommand(process.execPath, scriptPath, ['reconcile', ...common, '--threshold', String(threshold)]);
    const classification = classifyReconcileExitCode(reconcile.code);
    if (!classification.generated) throw new Error(`reconciliation failed with exit ${reconcile.code}`);
    console.log(JSON.stringify({ event: 'reconciliation_completed', from, to, ...classification }));
    return { from, to, ...classification };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(SCRIPT_DIR, 'reconcile-current-day.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  runReconciliation({
    baseDir: args.base || process.env.CONFIG_BASE_DIR || '/app/configs',
    from: args.from || resolveReconciliationDate(),
    to: args.to || args.from || resolveReconciliationDate(),
    threshold: args.threshold || process.env.RECONCILIATION_THRESHOLD || '0.005',
  }).catch(error => {
    console.error(JSON.stringify({ event: 'reconciliation_failed', error: error.message }));
    process.exitCode = 1;
  });
}
