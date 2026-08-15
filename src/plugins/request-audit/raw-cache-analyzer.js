import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';

const gunzip = promisify(zlib.gunzip);

function stableNormalize(value, depth = 0) {
    if (value === undefined) return null;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return value;
    if (depth >= 8) return '[depth-limit]';
    if (Array.isArray(value)) return value.map(item => stableNormalize(item, depth + 1));
    if (typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableNormalize(value[key], depth + 1)]));
    }
    return String(value);
}

function stableStringify(value) {
    return JSON.stringify(stableNormalize(value));
}

function commonPrefixChars(left, right) {
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
    return index;
}

function ratio(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function classify({ actual, theoretical, record, previous, history }) {
    const request = record.request || {};
    const previousRequest = previous.request || {};
    const body = record.processedRequestBody || {};
    const previousBody = previous.processedRequestBody || {};
    const gap = actual === null || theoretical === null ? null : Math.max(0, theoretical - actual);
    const sameTemplateHistory = request.templateFingerprint
        ? history.filter(item => item.request?.templateFingerprint === request.templateFingerprint)
        : [];
    const sameProviderHistory = sameTemplateHistory.filter(item => item.request?.providerUuidHash === request.providerUuidHash);
    const finalKeys = new Set([request.finalPromptCacheKeyHash, ...sameProviderHistory.map(item => item.request?.finalPromptCacheKeyHash)].filter(Boolean));
    const providers = new Set([request.providerUuidHash, ...sameTemplateHistory.map(item => item.request?.providerUuidHash)].filter(Boolean));
    if (finalKeys.size > 1) return 'gateway_key_fragmentation';
    if (stableStringify(body.instructions || '') !== stableStringify(previousBody.instructions || '') ||
        stableStringify(body.tools || []) !== stableStringify(previousBody.tools || [])) return 'client_structure_variance';
    if (providers.size > 1 && gap !== null && gap >= 0.15) return 'gateway_provider_fragmentation';
    const stableRoute = sameProviderHistory.some(item => item.request?.finalPromptCacheKeyHash === request.finalPromptCacheKeyHash);
    if (stableRoute && gap !== null && gap >= 0.15) return 'upstream_cache_uncertain';
    return 'client_prefix_limited';
}

export function analyzeRawCaptureRecords(records = [], { auditEvents = [] } = {}) {
    const audits = new Map(auditEvents.filter(event => event?.requestId).map(event => [event.requestId, event]));
    const sorted = [...records].sort((left, right) => String(left.timestamp || '').localeCompare(String(right.timestamp || '')));
    const historyByScope = new Map();
    const results = [];

    for (const record of sorted) {
        const body = record.processedRequestBody || {};
        const request = record.request || {};
        const scope = `${record.potluckKeyHash || 'unknown'}:${request.model || 'unknown'}`;
        const history = historyByScope.get(scope) || [];
        const previous = history.at(-1);
        history.push(record);
        historyByScope.set(scope, history);
        if (!previous) continue;

        const currentText = stableStringify(body);
        const previousText = stableStringify(previous.processedRequestBody || {});
        const prefixChars = commonPrefixChars(previousText, currentText);
        const audit = audits.get(record.requestId);
        const promptTokens = Number(audit?.usage?.promptTokens || 0);
        const cachedTokens = Number(audit?.usage?.cachedTokens || 0);
        const actual = promptTokens > 0 ? ratio(cachedTokens / promptTokens) : null;
        const prefixTokensApprox = Math.floor(prefixChars / 4);
        const theoretical = promptTokens > 0 ? ratio(prefixTokensApprox / promptTokens) : null;
        const gap = actual === null || theoretical === null ? null : Math.max(0, theoretical - actual);

        results.push({
            requestId: record.requestId || null,
            previousRequestId: previous.requestId || null,
            commonPrefixChars: prefixChars,
            commonPrefixTokensApprox: prefixTokensApprox,
            actualCacheRatio: actual,
            theoreticalCacheRatio: theoretical,
            cacheGap: gap,
            firstChangeArea: prefixChars < 4096 ? '0-4K' : prefixChars < 8192 ? '4K-8K' : prefixChars < 16384 ? '8K-16K' : prefixChars < 32768 ? '16K-32K' : 'after-32K',
            classification: classify({ actual, theoretical, record, previous, history: history.slice(0, -1) })
        });
    }
    return results;
}

export async function readRawCaptureDirectory(dir) {
    const root = path.resolve(dir);
    if (!fs.existsSync(root)) return [];
    const files = [];
    const walk = async current => {
        for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) await walk(fullPath);
            else if (entry.isFile() && entry.name.endsWith('.json.gz')) files.push(fullPath);
        }
    };
    await walk(root);
    const records = [];
    for (const file of files.sort()) {
        try {
            const wrapped = JSON.parse((await gunzip(await fsp.readFile(file))).toString('utf8'));
            records.push(JSON.parse(wrapped.payload));
        } catch {
            // Skip corrupt or deliberately truncated snapshots.
        }
    }
    return records;
}
