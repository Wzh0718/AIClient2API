#!/usr/bin/env node

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';
import Database from 'better-sqlite3';

import { estimateUsageCost } from '../../src/plugins/api-potluck/cost-estimator.js';
import {
  buildUniqueEmailProviderMap,
  createRepairBundle,
  discoverRepairAuditFiles,
  hashSecret,
  resolveAuditProvider,
  scanRepairAuditFiles,
} from '../usage-ledger/daily-usage-ledger.mjs';

const FROM = '2026-08-14';
const TO = '2026-08-15';
const MAX_ESTIMATED_REMOVAL_USD = 1000;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=', 2);
    args[name] = inline ?? argv[++index];
  }
  return args;
}

function usableIdentity(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized && !['unknown', 'null', 'undefined'].includes(normalized) ? normalized : null;
}

function normalizeModel(event) {
  return usableIdentity(event.request?.actualModel)
    || usableIdentity(event.request?.model)
    || 'unknown';
}

function accountIdentity(event) {
  return event.account?.accountEmail
    || event.account?.providerUuidHash
    || event.account?.providerUuid
    || null;
}

export function classifyCleanupEvent(event, {
  providerByEmail = new Map(),
  knownPotluckKeyHashes = new Set(),
} = {}) {
  const provider = resolveAuditProvider(event, providerByEmail);
  const model = normalizeModel(event);
  const cost = estimateUsageCost(event.usage || {}, model);
  const reasons = [];
  if (provider === 'unknown') reasons.push('unknown-provider');
  if (model === 'unknown') reasons.push('unknown-model');
  if (!accountIdentity(event)) reasons.push('unknown-account');
  if (Number(cost.missingPriceTokens || 0) > 0) reasons.push('missing-price');
  if (event.potluckKey?.present && (
    !event.potluckKey?.hash
    || !knownPotluckKeyHashes.has(event.potluckKey.hash)
  )) reasons.push('unknown-key');
  return { keep: reasons.length === 0, reasons, provider, model, cost };
}

function hasEstimatedAverage(value) {
  if (!value || typeof value !== 'object') return false;
  if (Number(value.estimatedPriceTokens || 0) > 0) return true;
  if (['estimated-average', 'mixed'].includes(value.pricingSource) && Number(value.estimatedUsd || 0) > 0) return true;
  return Object.values(value).some(hasEstimatedAverage);
}

async function scanEstimatedLedgerFile(filePath, dates) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (hasEstimatedAverage(row.cost || row)) {
          const date = String(row.date || path.basename(filePath).match(/\d{4}-\d{2}-\d{2}/)?.[0] || '');
          if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates.add(date);
        }
      } catch {}
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function discoverEstimatedAverageDates(base) {
  const dates = new Set();
  const dailyDir = path.join(base, 'permanent-usage-ledger', 'daily');
  if (fs.existsSync(dailyDir)) {
    for (const entry of fs.readdirSync(dailyDir, { withFileTypes: true })) {
      if (entry.isFile() && /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) {
        await scanEstimatedLedgerFile(path.join(dailyDir, entry.name), dates);
      }
    }
  }

  const sqlitePath = path.join(base, 'usage-events', 'usage-events.sqlite');
  if (fs.existsSync(sqlitePath)) {
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    try {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      if (tables.has('potluck_usage_history')) {
        for (const row of db.prepare('SELECT usage_date, day_json FROM potluck_usage_history').iterate()) {
          try { if (hasEstimatedAverage(JSON.parse(row.day_json))) dates.add(row.usage_date); } catch {}
        }
      }
      if (tables.has('model_usage_daily')) {
        for (const row of db.prepare('SELECT usage_date, state_json FROM model_usage_daily').iterate()) {
          try { if (hasEstimatedAverage(JSON.parse(row.state_json))) dates.add(row.usage_date); } catch {}
        }
      }
    } finally {
      db.close();
    }
  }
  return [...dates].sort();
}

function usageTokens(event) {
  return Number(event.usage?.totalTokens || 0);
}

export async function createUnknownUsageCleanupBundle({ base, outDir, now = new Date(), from = null, to = null }) {
  const estimatedDates = await discoverEstimatedAverageDates(base);
  const selectedFrom = from || estimatedDates[0] || FROM;
  const selectedTo = to || estimatedDates.at(-1) || TO;
  const potluckStore = JSON.parse(fs.readFileSync(path.join(base, 'api-potluck-keys.json'), 'utf8'));
  const providerByEmail = buildUniqueEmailProviderMap(potluckStore);
  const knownPotluckKeyHashes = new Set(Object.keys(potluckStore.keys || {}).map(hashSecret));
  const files = await discoverRepairAuditFiles({
    auditDir: path.join(base, 'request-audit'),
    from: selectedFrom,
    to: selectedTo,
  });
  const scan = await scanRepairAuditFiles({ files, from: selectedFrom, to: selectedTo });
  const classified = scan.events.map(event => ({
    event,
    result: classifyCleanupEvent(event, { providerByEmail, knownPotluckKeyHashes }),
  }));
  const keptKnown = classified.filter(item => item.result.keep && item.result.cost.actualUsd > 0);
  const knownTokens = keptKnown.reduce((sum, item) => sum + usageTokens(item.event), 0);
  const knownUsd = keptKnown.reduce((sum, item) => sum + Number(item.result.cost.actualUsd || 0), 0);
  const averageUsdPerToken = knownTokens > 0 ? knownUsd / knownTokens : 0;
  const dropped = classified.filter(item => !item.result.keep);
  const estimatedRemovalUsd = dropped.reduce((sum, item) => {
    const direct = Number(item.result.cost.usd || item.result.cost.actualUsd || 0);
    return sum + (direct > 0 ? direct : usageTokens(item.event) * averageUsdPerToken);
  }, 0);
  const reasonCounts = {};
  for (const item of dropped) {
    for (const reason of item.result.reasons) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }
  const cleanupMetadata = {
    operation: 'drop-unresolved-derived-usage',
    targetDates: estimatedDates.filter(date => date >= selectedFrom && date <= selectedTo),
    sourceEvents: classified.length,
    keptEvents: classified.length - dropped.length,
    droppedEvents: dropped.length,
    droppedTokens: dropped.reduce((sum, item) => sum + usageTokens(item.event), 0),
    estimatedRemovalUsd,
    estimateMethod: averageUsdPerToken > 0 ? 'known-event-effective-average' : 'no-priced-sample',
    averageUsdPerToken,
    reasonCounts,
    thresholdUsd: MAX_ESTIMATED_REMOVAL_USD,
    batchId: `estimated-average:${crypto.createHash('sha256').update(JSON.stringify(dropped.map(item => [
      item.event.requestId,
      item.event.beijingDate,
      usageTokens(item.event),
      item.result.reasons,
    ]))).digest('hex').slice(0, 16)}`,
  };
  if (estimatedRemovalUsd >= MAX_ESTIMATED_REMOVAL_USD) {
    throw new Error(`estimated removal $${estimatedRemovalUsd.toFixed(2)} reaches approval threshold $${MAX_ESTIMATED_REMOVAL_USD}`);
  }
  const result = await createRepairBundle({
    base,
    from: selectedFrom,
    to: selectedTo,
    outDir,
    now,
    allowDecreasing: true,
    eventFilter: event => {
      const classifiedEvent = classifyCleanupEvent(event, { providerByEmail, knownPotluckKeyHashes });
      if (classifiedEvent.keep) {
        event.request = {
          ...(event.request || {}),
          toProvider: classifiedEvent.provider,
          actualModel: classifiedEvent.model,
        };
      }
      return classifiedEvent.keep;
    },
    cleanupMetadata,
  });

  const quarantinePath = path.join(outDir, 'quarantine-events.jsonl');
  const quarantineRows = dropped.map(item => ({
    requestId: item.event.requestId || null,
    date: item.event.beijingDate,
    hour: item.event.beijingHour,
    provider: item.result.provider,
    model: item.result.model,
    usage: item.event.usage,
    estimatedRemovalUsd: Number(item.result.cost.usd || 0) || usageTokens(item.event) * averageUsdPerToken,
    reasons: item.result.reasons,
    batchId: cleanupMetadata.batchId,
  }));
  fs.writeFileSync(quarantinePath, quarantineRows.length > 0 ? `${quarantineRows.map(JSON.stringify).join('\n')}\n` : '', { mode: 0o600 });
  const body = fs.readFileSync(quarantinePath);
  result.manifest.artifacts.push({
    path: 'quarantine-events.jsonl',
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    size: body.length,
  });
  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`, { mode: 0o600 });
  result.manifestSha256 = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.base || !args['out-dir']) {
    throw new Error('Usage: cleanup-unknown-usage-2026-08-14-15.mjs --base <config-dir> --out-dir <bundle-dir> [--now <ISO>]');
  }
  const now = args.now ? new Date(args.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('--now must be an ISO timestamp');
  const result = await createUnknownUsageCleanupBundle({
    base: path.resolve(args.base),
    outDir: path.resolve(args['out-dir']),
    now,
    from: args.from || null,
    to: args.to || null,
  });
  process.stdout.write(`${JSON.stringify({
    outDir: result.outDir,
    manifestSha256: result.manifestSha256,
    reportSha256: result.reportSha256,
    eligibleDates: result.manifest.eligibleDates,
    cleanup: result.report.cleanupMetadata,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
