import { readFileSync } from 'fs';

describe('request audit workspace source', () => {
  const html = readFileSync('static/request-audit.html', 'utf8');

  test('uses the Potluck design system and compact admin workspace layout', () => {
    expect(html).toContain('href="app/base.css"');
    expect(html).toContain('class="audit-navbar"');
    expect(html).toContain('class="workspace"');
    expect(html).toContain('class="stats-grid"');
    expect(html).toContain('id="themeToggle"');
    expect(html).toContain('id="advancedFilters"');
    expect(html).toContain('无需开启原始请求采集');
    expect(html).toContain('最近 20 分钟 · 全部 Key');
    expect(html).toContain('value="100"');
  });

  test('keeps filters compact and moves request details into an accessible drawer', () => {
    for (const id of ['keySelect', 'modelFilter', 'outcome', 'since', 'until', 'clientIp', 'requestPath', 'credential', 'providerFilter', 'modelMismatch']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('class="request-table"');
    expect(html).toContain('Provider / 账号');
    expect(html).toContain('id="detailDrawer"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('function openRequestDetail');
    expect(html).toContain('上游调用时间线');
    expect(html).toContain('失败详情');
    expect(html).toContain('上游失败 ${escapeHtml(upstreamStatus)}');
    expect(html).toContain('上游错误原文');
    expect(html).toContain('attempt.errorMessage');
    // [turn-state-disabled 2026-09-23] expect(html).toContain('Turn-State');
    expect(html).toContain('路由、计费与安全元数据');
    expect(html).not.toContain('colspan="13"');
  });

  test('isolates raw capture in advanced tools and preserves the legacy hash', () => {
    expect(html).toContain('id="openTools"');
    expect(html).toContain('id="toolsDrawer"');
    expect(html).toContain('高风险操作与日常审计隔离');
    expect(html).toContain('/api/request-audit/raw-capture');
    expect(html).toContain('rawCaptureKeySelect');
    expect(html).toContain('rawCaptureKeyInput');
    expect(html).toContain('resolveRawCaptureKeyHash');
    expect(html).toContain("view === 'capture'");
    expect(html).toContain("'#capture'");
    expect(html).toContain('会保存原始 prompt');
  });

  test('authenticates every audit request, auto-loads, and supports responsive keyboard interaction', () => {
    expect(html).toContain('const { auth = true');
    expect(html).toContain("localStorage.getItem('authToken')");
    expect(html).toContain('response.status === 401');
    expect(html).toContain('/login.html?returnUrl=');
    expect(html).toContain('Promise.allSettled([loadKeyOptions(), loadRawCaptureStatus()]).then(() => loadAudit())');
    expect(html).toContain("event.key === 'Escape'");
    expect(html).toContain("event.key === 'Tab'");
    expect(html).toContain('@media (max-width: 860px)');
    expect(html).toContain('@media (prefers-reduced-motion: reduce)');
    expect(html).toContain('mobile-request-list');
  });

  test('renders complete-window source metadata and existing audit evidence', () => {
    expect(html).toContain('/api/request-audit/summary');
    expect(html).toContain('/api/request-audit/requests');
    expect(html).toContain('SQLite 完整汇总');
    expect(html).toContain('降级汇总');
    expect(html).toContain('outcomeCounts');
    expect(html).toContain('cacheHitRatio');
    expect(html).toContain('averageLatency');
    expect(html).not.toContain('class="insights-grid"');
    expect(html).not.toContain('id="cacheGauge"');
    expect(html).not.toContain('id="contextStack"');
    expect(html).toContain('输入 / 输出 / 缓存');
    expect(html).toContain('model-chain-compact');
    expect(html).toContain('toFixed(seconds < 100 ? 1 : 0)');
    expect(html).toContain('clientFirstOutputMs');
    expect(html).toContain('costDisplay');
    expect(html).toContain('modelEvidence');
  });
});
