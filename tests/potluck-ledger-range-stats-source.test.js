import fs from 'fs';
import path from 'path';

function loadSource(relativePath) {
    return fs.readFileSync(path.join(process.cwd(), ...relativePath.split('/')), 'utf8').replace(/\r\n/g, '\n');
}

describe('API Potluck ledger range stats surface', () => {
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
        expect(source).toContain('const sqliteRows = readSqliteRowsForDates(sqlitePath, includeKeySummaries ? dates : missingCandidates, store);');
        expect(source).toContain('keySummaryRows = sqliteRows;');
        expect(source).toContain('keySummaryRows');
        expect(source).toContain('performance.now()');
        expect(source).toContain('sqliteMs=');
        expect(source).toContain('aggregationMs=');
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
