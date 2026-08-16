#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

function normalizeModel(event) {
  return String(event.request?.actualModel || event.request?.model || 'unknown').trim().toLowerCase() || 'unknown';
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

function usageTokens(event) {
  return Number(event.usage?.totalTokens || 0);
}

export async function createUnknownUsageCleanupBundle({ base, outDir, now = new Date() }) {
  const potluckStore = JSON.parse(fs.readFileSync(path.join(base, 'api-potluck-keys.json'), 'utf8'));
  const providerByEmail = buildUniqueEmailProviderMap(potluckStore);
  const knownPotluckKeyHashes = new Set(Object.keys(potluckStore.keys || {}).map(hashSecret));
  const files = await discoverRepairAuditFiles({
    auditDir: path.join(base, 'request-audit'),
    from: FROM,
    to: TO,
  });
  const scan = await scanRepairAuditFiles({ files, from: FROM, to: TO });
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
    targetDates: [FROM, TO],
    sourceEvents: classified.length,
    keptEvents: classified.length - dropped.length,
    droppedEvents: dropped.length,
    droppedTokens: dropped.reduce((sum, item) => sum + usageTokens(item.event), 0),
    estimatedRemovalUsd,
    estimateMethod: averageUsdPerToken > 0 ? 'known-event-effective-average' : 'no-priced-sample',
    averageUsdPerToken,
    reasonCounts,
    thresholdUsd: MAX_ESTIMATED_REMOVAL_USD,
  };
  if (estimatedRemovalUsd >= MAX_ESTIMATED_REMOVAL_USD) {
    throw new Error(`estimated removal $${estimatedRemovalUsd.toFixed(2)} reaches approval threshold $${MAX_ESTIMATED_REMOVAL_USD}`);
  }
  return createRepairBundle({
    base,
    from: FROM,
    to: TO,
    outDir,
    now,
    allowDecreasing: true,
    eventFilter: event => classifyCleanupEvent(event, { providerByEmail, knownPotluckKeyHashes }).keep,
    cleanupMetadata,
  });
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
