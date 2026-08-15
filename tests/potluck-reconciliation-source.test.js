import fs from 'fs';
import path from 'path';

function loadSource(relativePath) {
    return fs.readFileSync(path.join(process.cwd(), ...relativePath.split('/')), 'utf8').replace(/\r\n/g, '\n');
}

describe('API Potluck reconciliation surface', () => {
    test('ledger script exposes a reconcile command with three-source comparison', () => {
        const source = loadSource('scripts/usage-ledger/daily-usage-ledger.mjs');

        expect(source).toContain("if (command === 'reconcile') return commandReconcile(args);");
        expect(source).toContain('export function reconcileDay(');
        expect(source).toContain('export function summarizeLedgerRows(');
        expect(source).toContain('export function summarizePotluckDay(');
        expect(source).toContain("'ledger-vs-audit'");
        expect(source).toContain("'ledger-vs-potluck'");
        expect(source).toContain("'audit-vs-potluck'");
        expect(source).toContain("path.join(outDir, 'latest.json')");
        expect(source).toContain('thresholdRatio = 0.005');
    });

    test('admin API serves the latest reconciliation result from the config volume', () => {
        const source = loadSource('src/plugins/api-potluck/api-routes.js');

        expect(source).toContain("path === '/api/potluck/reconciliation'");
        expect(source).toContain('function readReconciliationLatest()');
        expect(source).toContain("'permanent-usage-ledger', 'reconciliation', 'latest.json'");
        expect(source).toContain('available: latest !== null');
    });

    test('admin dashboard renders stats meta bar with last update and health badge', () => {
        const source = loadSource('static/potluck.html');

        expect(source).toContain('id="statsMetaBar"');
        expect(source).toContain('id="statsLastUpdatedAt"');
        expect(source).toContain('id="statsHealthBadge"');
        expect(source).toContain('统计数据最后更新');
        expect(source).toContain('function shouldShowStatsMetaBar(result)');
        expect(source).toContain('STATS_META_HIDE_FRESH_MS');
        expect(source).toContain('if (!shouldShowStatsMetaBar(result)) { bar.style.display = \'none\'; return; }');
        expect(source).toContain('统计异常');
        expect(source).not.toContain('统计正常');
        expect(source).toContain('function formatStatsUpdatedAt(isoString)');
        expect(source).toContain('async function loadReconciliationStatus()');
        expect(source).toContain('apiRequest(`${API_BASE}/reconciliation`)');
        expect(source).toContain("result.hourlyCoverage?.status === 'partial'");
        expect(source).toContain('小时明细覆盖');
        expect(source).toContain('loadReconciliationStatus();');
        expect(source).not.toContain('id="reconcileStatusBar"');
        expect(source).not.toContain('每日对账正常');
        expect(source).not.toContain('对账偏差');
    });
});
