import fs from 'fs';
import path from 'path';

describe('api potluck keys list compact source', () => {
    test('admin keys list strips heavy per-day details while keeping summaries', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/plugins/api-potluck/api-routes.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('function compactKeyForList(key)');
        expect(source).toContain('function compactUsageHistoryForList(usageHistory = {})');
        expect(source).toContain('summary: day?.summary || {}');
        expect(source).toContain('const STATS_CACHE_TTL_MS = 30 * 1000');
        expect(source).toContain('function getCachedStats(costOptions = {})');
        expect(source).toContain("costOptions.includeKeySummaries ? 'with-key-summaries' : 'without-key-summaries'");
        expect(source).toContain('if (entry?.promise) return entry.promise');
        expect(source).toContain('const overview = await getCachedOverview(costOptions);');
        expect(source).toContain('includeKeySummaries: true');
        expect(source).toContain('getKey(apiKey, { compactUserHistory: true, compactCosts: true })');
        expect(source).toContain('getCachedStats(statsOptions)');
        expect(source).toContain('keys.map(compactKeyForList)');
        expect(source).toContain('delete compact.usageHistory[date].providers');
        expect(source).toContain('delete compact.usageHistory[date].models');
        expect(source).toContain('delete compact.usageHistory[date].accounts');
        expect(source).toContain('delete compact.usageHistory[date].hours');
    });

    test('exposes a cached overview route for the management page', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/plugins/api-potluck/api-routes.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain("path === '/api/potluck/overview'");
        expect(source).toContain('function getCachedOverview(costOptions = {})');
        expect(source).toContain('overviewCache');
    });

    test('renders compact keys stats before awaiting full stats', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/potluck.html'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('const compactStats = keysResult.data.stats;');
        expect(source).toContain('renderStatsSummary(compactStats);');
        expect(source).not.toContain('loadFullStatsInBackground');
        expect(source).toContain('/range-stats?range=');
    });

    test('uses an explicit list response allowlist and on-demand secret detail', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/plugins/api-potluck/api-routes.js'), 'utf8').replace(/\r\n/g, '\n');
        const html = fs.readFileSync(path.join(process.cwd(), 'static/potluck.html'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('const LIST_KEY_FIELDS');
        expect(source).toContain("'weeklyUsage'");
        expect(source).toContain("'weeklyPromptTokens'");
        expect(source).toContain("'weeklyCompletionTokens'");
        expect(source).toContain("'weeklyReasoningTokens'");
        expect(source).toContain("'weeklyTotalTokens'");
        expect(source).toContain("'weeklyCachedTokens'");
        expect(source).toContain("'todayCacheHitRatio'");
        expect(source).toContain("'weeklyCacheHitRatio'");
        expect(source).toContain("'totalCacheHitRatio'");
        expect(source).toContain("'cost'");
        expect(source).toContain("subPath === '/detail'");
        expect(source).toContain('secret');
        expect(html).toContain('copyKeyFromDetail');
        expect(html).not.toContain("copyToClipboard('${key.id}')");
    });

    test('supports summary and full stats detail levels without changing the legacy default', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/plugins/api-potluck/api-routes.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('detail=summary');
        expect(source).toContain("detail === 'summary'");
        expect(source).toContain("detail === 'history'");
        expect(source).toContain("detail === 'full'");
        expect(source).toContain('const detail = getRequestDetailOptions(req);');
    });

    test('builds key summaries with usage-history weekly metrics and compact cost data', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/plugins/api-potluck/key-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('const summaryHistory = cloneUsageHistorySummaryOnly(');
        expect(source).toContain('const weeklySummary = getRecentHistorySummary(summaryHistory, 7);');
        expect(source).toContain('weeklyTotalTokens: weeklySummary.totalTokens');
        expect(source).toContain('weeklyCacheHitRatio: weeklySummary.cacheHitRatio');
        expect(source).toContain('cost: buildCost(');
    });

    test('uses usage history as the fallback source for every range when ledger data is unavailable', () => {
        const html = fs.readFileSync(path.join(process.cwd(), 'static/potluck.html'), 'utf8').replace(/\r\n/g, '\n');

        expect(html).toContain('const rangeSummary = summarizeUsageHistoryForRange(key.usageHistory || {}, range).summary;');
        expect(html).toContain('return buildRangeMetricsFromSummary(rangeSummary);');
        expect(html).toContain('const candidateLiveDates = ledgerData ? (ledgerData.missingDates || []) : Object.keys(key.usageHistory || {});');
    });
});
