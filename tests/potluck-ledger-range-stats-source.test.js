import fs from 'fs';
import path from 'path';
import { createLedgerRangeAggregator } from '../src/plugins/api-potluck/ledger-range-stats.js';

function loadSource(relativePath) {
    return fs.readFileSync(path.join(process.cwd(), ...relativePath.split('/')), 'utf8').replace(/\r\n/g, '\n');
}

describe('API Potluck ledger range stats surface', () => {
    test('range aggregation preserves the maximum peak rates across rows', () => {
        const aggregator = createLedgerRangeAggregator();
        aggregator.addRow({
            date: '2026-09-03',
            provider: 'provider-a',
            model: 'model-a',
            usage: { requestCount: 10, totalTokens: 100, maxQps: 2.5, maxRpm: 150, maxTps: 900 }
        });
        aggregator.addRow({
            date: '2026-09-04',
            provider: 'provider-a',
            model: 'model-a',
            usage: { requestCount: 20, totalTokens: 200, maxQps: 4.25, maxRpm: 255, maxTps: 1200 }
        });

        const result = aggregator.result();

        expect(result.summary.maxQps).toBe(4.25);
        expect(result.summary.maxRpm).toBe(255);
        expect(result.summary.maxTps).toBe(1200);
        expect(result.daily['2026-09-03'].maxQps).toBe(2.5);
        expect(result.daily['2026-09-04'].maxTps).toBe(1200);
    });

    test('admin API exposes ledger-backed range stats endpoint', () => {
        const source = loadSource('src/plugins/api-potluck/api-routes.js');

        expect(source).toContain("path === '/api/potluck/range-stats'");
        expect(source).toContain('async function loadLedgerRangeStatsForRange(range, conversionModel, options = {})');
        expect(source).toContain('const stats = await readLedgerRangeStats({');
        expect(source).toContain('keyHashToId,');
        expect(source).toContain("'permanent-usage-ledger', 'daily'");
        expect(source).toContain("source: 'ledger'");
        expect(source).toContain("range === 'custom'");
        expect(source).toContain("url.searchParams.get('from')");
        expect(source).toContain("url.searchParams.get('to')");
        expect(source).toContain('includeKeySummaries');
        expect(source).toContain("subPath === '/range-stats'");
    });

    test('ledger range stats module aggregates without exposing key material', () => {
        const source = loadSource('src/plugins/api-potluck/ledger-range-stats.js');

        expect(source).toContain('export function createLedgerRangeAggregator(');
        expect(source).toContain('export async function readLedgerRangeStats(');
        expect(source).toContain('export function resolveRangeDates(');
        expect(source).toContain('readline.createInterface');
        expect(source).toContain('keyHashToId.get(row.keyHash)');
        expect(source).not.toContain('keyPrefixToId');
    });

    test('ledger range stats reads dates in parallel and accepts SQLite key preaggregates', () => {
        const source = loadSource('src/plugins/api-potluck/ledger-range-stats.js');
        expect(source).toContain('const LEDGER_READ_CONCURRENCY = 4;');
        expect(source).toContain('mapWithConcurrency(dates, LEDGER_READ_CONCURRENCY, async date =>');
        expect(source).toContain('keySummaryRows');
        expect(source).toContain("result.keySummarySource = 'sqlite-preaggregated'");
    });

    test('range-stats route queries SQLite once for range key summaries', () => {
        const source = loadSource('src/plugins/api-potluck/api-routes.js');
        const ledgerSource = loadSource('src/plugins/api-potluck/ledger-range-stats.js');
        expect(source).toContain('const sqliteRows = readSqliteRowsForDates(sqlitePath, includeKeySummaries ? dates : missingCandidates, store);');
        expect(source).toContain('keySummaryRows = sqliteRows;');
        expect(source).toContain('keySummaryRows');
        expect(source).toContain('performance.now()');
        expect(source).toContain('sqliteMs=');
        expect(source).toContain('aggregationMs=');
        expect(source).toContain('targetKeyId: options.targetKeyId || null');
        expect(ledgerSource).toContain('targetKeyId === null');
    });

    test('key-scoped range stats preserves fixed range semantics outside custom date validation', () => {
        const source = loadSource('src/plugins/api-potluck/api-routes.js');

        expect(source).toContain("const requestedRange = url.searchParams.get('range');");
        expect(source).toContain("const detailRange = ['total', '30d', '7d', 'today'].includes(requestedRange)");
        expect(source).toContain("from: detailRange === 'custom' ? url.searchParams.get('from') : undefined");
        expect(source).toContain("targetKeyId: keyId");
    });

    test('admin dashboard prefers ledger range stats without verbose data-source title', () => {
        const source = loadSource('static/potluck.html');

        expect(source).toContain('async function refreshLedgerRangeStats(range = currentUsageRange, { force = false } = {})');
        expect(source).toContain('function buildRangeSummaryFromLedger(ledgerStats, usageHistory = {}, range = currentUsageRange)');
        expect(source).not.toContain('function formatRangeDataSourceLabel(rangeSummary)');
        expect(source).not.toContain('数据源: 账本');
        expect(source).not.toContain('数据源: 实时统计');
        expect(source).toContain("apiRequest(`${API_BASE}/range-stats?range=${encodeURIComponent(range)}${customQuery}&includeKeys=1&${getCostQuery()}`)");
        expect(source).toContain("refreshLedgerRangeStats(currentUsageRange, { force: true });");
        expect(source).toContain('await refreshLedgerRangeStats(currentUsageRange, { force: true });');
        expect(source).toContain('from=${encodeURIComponent(currentCustomRange.from)}');
        expect(source).toContain('to=${encodeURIComponent(currentCustomRange.to)}');
    });

    test('key cards and detail modal render peaks from the selected range summary', () => {
        const source = loadSource('static/potluck.html');

        expect(source).toContain('rangeSummary.summary?.maxQps');
        expect(source).toContain('rangeSummary.summary?.maxRpm');
        expect(source).toContain('rangeSummary.summary?.maxTps');
        expect(source).not.toContain('峰值: ${(key.maxQps || 0).toFixed(2)} QPS');
        expect(source).not.toContain('峰值: ${(key.maxRpm || 0).toFixed(0)} RPM');
        expect(source).not.toContain('峰值: ${(key.maxTps || 0).toFixed(1)} TPS');
    });

    test('uses sanitized key references consistently for range summaries and local full-key search', () => {
        const source = loadSource('src/plugins/api-potluck/api-routes.js');
        const html = loadSource('static/potluck.html');

        expect(source).toContain('keySummaries');
        expect(source).toContain('hashSecret(keyId)');
        expect(source).toContain('keySummary: data.keySummaries?.[hashSecret(keyId)] || null');
        expect(html).toContain('ledgerData?.keySummaries?.[key?.keyRef || key?.id]');
        expect(html).toContain('crypto.subtle.digest');
        expect(html).toContain('SHA-256');
        expect(html).toContain('filterRequestSerial');
    });
});
