// Mock-only browser verification. No production requests or real credentials.
// node tests/request-audit-ui.smoke.mjs [screenshot-directory]
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const output = process.argv[2];
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1680, height: 1100 } });
const errors = [], calls = [], checks = [];
let failList = false, failSummary = false, fallback = false, empty = false;
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
page.on('pageerror', error => errors.push(error.message));
const event = i => ({
  requestId: `request-${i}`, timestamp: '2026-09-23T07:33:58.000Z',
  potluckKey: { name: i === 0 ? '测试 Key 名称很长很长很长很长' : `Key ${i % 3}`, hash: 'sha256:fixture' },
  account: { providerNameDisplay: i === 0 ? '这是一个很长的账号名称用于验证文字截断与详情查看' : `account-${i % 4}` },
  request: { toProvider: 'openai-codex-oauth', model: 'gpt-5.6-sol', requestedModel: 'gpt-5.6-sol', outboundModel: i === 2 ? 'gpt-5.6-luna' : 'gpt-5.6-sol', plannedModel: 'gpt-5.6-sol', upstreamResponseModel: i === 1 ? undefined : 'gpt-5.6-sol' },
  response: { durationMs: i === 0 ? null : i === 1 ? 0 : 22600 },
  runtime: { stages: { clientFirstOutputMs: i === 0 ? 5400 : 350 } },
  usage: { promptTokens: 48152, completionTokens: 165, cachedTokens: 46848, cacheHitRatio: 0.9729, totalTokens: 48317 },
  cost: { usd: 0.0349, pricingSource: 'official', estimatedUsd: i === 3 ? 0.01 : 0 },
  status: { outcome: i === 4 ? 'upstream_error' : 'success', httpStatus: 200 },
  failure: i === 4 ? { upstreamHttpStatus: 400, errorType: 'invalid_request_error' } : undefined
});
await page.addInitScript(() => localStorage.setItem('authToken', 'mock-only'));
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.hostname !== 'audit.test') return route.fulfill({ status: 200, body: '' });
  const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { success: true, data } : { success: false, error: { message: '模拟加载失败' } }) });
  if (url.pathname === '/api/potluck/keys') return send({ keys: [] });
  if (url.pathname === '/api/request-audit/raw-capture') return send({ enabled: false, keyHashes: [] });
  if (url.pathname.startsWith('/api/request-audit/')) {
    calls.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
    if (url.searchParams.get('model') === 'slow') await new Promise(resolve => setTimeout(resolve, 250));
    if (url.pathname.endsWith('/summary')) return failSummary ? send(null, 500) : send({ summary: { requestCount: 125, promptTokens: 100000, completionTokens: 1250, totalTokens: 101250, cachedTokens: 80000, cacheHitRatio: .8 }, outcomeCounts: { success: 124 }, cost: { usd: 1.234, pricedRequestCount: 125 }, timing: { average: 3200, p95: 22600 }, analysisFreshness: { status: 'missing' }, meta: { complete: !fallback, source: fallback ? 'jsonl_fallback' : 'gpt_requests_sqlite', retentionDays: 7 } });
    const start = Number(url.searchParams.get('cursor') || 0), size = Number(url.searchParams.get('limit') || 50);
    const total = empty ? 0 : 125;
    return failList ? send(null, 500) : send({ requests: Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, j) => ({ ...event(start + j), marker: url.searchParams.get('model') })), nextCursor: start + size < total && !fallback ? String(start + size) : null, pagination: { supported: !fallback } });
  }
  const relative = url.pathname === '/' ? 'request-audit.html' : decodeURIComponent(url.pathname.slice(1));
  try {
    const file = path.resolve('static', relative);
    assert.ok(file.startsWith(path.resolve('static') + path.sep));
    return route.fulfill({ body: await readFile(file), contentType: relative.endsWith('.html') ? 'text/html' : relative.endsWith('.css') ? 'text/css' : 'text/javascript' });
  } catch { return route.fulfill({ status: 404, body: '' }); }
});
const settled = () => page.waitForFunction(() => document.querySelector('.request-card').getAttribute('aria-busy') === 'false' && document.querySelector('.stats-grid').getAttribute('aria-busy') === 'false');
try {
  await page.goto('http://audit.test/request-audit.html');
  await settled();
  assert.equal(await page.locator('#requestRows tr').count(), 50);
  assert.deepEqual(await page.locator('.request-table th').allTextContents(), ['时间', 'Key', 'Provider / 账号', '模型', '输入（含缓存）', '输出', '成本', '耗时', '状态']);
  assert.match(await page.locator('#requestRows tr').nth(0).innerText(), /总 —/);
  assert.match(await page.locator('#requestRows tr').nth(1).innerText(), /总 0ms/);
  assert.match(await page.locator('#requestRows tr').nth(4).innerText(), /上游失败 400/);
  assert.match(await page.locator('#requestRows tr').nth(2).innerText(), /gpt-5.6-sol → gpt-5.6-luna/);
  assert.ok(!(await page.locator('#requestRows').innerText()).includes('sha256:fixture'));
  pass('compact columns, null/zero duration, model difference, terminal failure with HTTP 200');
  if (output) {
    await page.locator('.request-card').evaluate(node => node.scrollIntoView());
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: false });
  }
  const summaryCalls = () => calls.filter(call => call.path.endsWith('/summary')).length;
  const before = summaryCalls(), until = calls.find(call => call.path.endsWith('/requests')).params.until;
  await page.locator('#nextPage').click(); await settled();
  assert.match(await page.locator('#pageInfo').innerText(), /第 2 页/);
  assert.equal(await page.evaluate(() => window.__auditRequests[0].requestId), 'request-50');
  await page.locator('#nextPage').click(); await settled();
  assert.equal(await page.locator('#requestRows tr').count(), 25);
  assert.equal(await page.locator('#nextPage').isDisabled(), true);
  await page.locator('#previousPage').click(); await settled();
  assert.equal(summaryCalls(), before);
  assert.ok(calls.filter(call => call.path.endsWith('/requests')).every(call => call.params.until === until));
  pass('bounded DOM, next/previous/last page, frozen window, no summary requests on paging');

  failList = true;
  await page.locator('#nextPage').click(); await settled();
  assert.match(await page.locator('#pageInfo').innerText(), /第 2 页/);
  assert.equal(await page.evaluate(() => window.__auditRequests[0].requestId), 'request-50');
  failList = false;
  await page.locator('#retryList').click(); await settled();
  assert.match(await page.locator('#pageInfo').innerText(), /第 3 页/);
  pass('failed page retains prior data and retries requested page');

  failSummary = true;
  await page.selectOption('#limit', '20'); await settled();
  assert.match(await page.locator('#pageInfo').innerText(), /第 1 页/);
  assert.equal(await page.locator('#requestRows tr').count(), 20);
  assert.equal(await page.locator('#retrySummary').isVisible(), true);
  const listCalls = calls.filter(call => call.path.endsWith('/requests')).length;
  failSummary = false;
  await page.locator('#retrySummary').click(); await settled();
  assert.equal(calls.filter(call => call.path.endsWith('/requests')).length, listCalls);
  pass('page size resets pagination; summary failure/retry independent of list');

  await page.evaluate(() => { document.getElementById('modelFilter').value = 'slow'; loadAudit(); });
  await page.waitForFunction(() => listBusy);
  await page.evaluate(() => { document.getElementById('modelFilter').value = 'fast'; loadAudit(); });
  await settled();
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => window.__auditRequests[0].marker), 'fast');
  pass('stale response cancellation and query version guard');

  await page.locator('#requestRows tr').first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#detailDrawer').getAttribute('aria-hidden'), 'false');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#requestRows tr')), true);
  pass('keyboard detail opening and focus restoration');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.mobile-request-card').count(), 20);
  assert.match(await page.locator('.mobile-request-card').first().innerText(), /首出/);
  assert.match(await page.locator('.mobile-request-card').first().innerText(), /openai-codex-oauth/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (output) {
    await page.locator('.request-card').evaluate(node => node.scrollIntoView());
    await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: false });
  }
  pass('390px mobile cards retain provider and timing without horizontal overflow');
  await page.setViewportSize({ width: 1280, height: 1000 });
  assert.equal(await page.locator('.provider-col').isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  pass('1280px preserves Provider column and confines table overflow');

  fallback = true; await page.locator('#load').click(); await settled();
  assert.match(await page.locator('#pageInfo').innerText(), /不支持分页/);
  assert.equal(await page.locator('#nextPage').isDisabled(), true);
  fallback = false; empty = true; await page.locator('#load').click(); await settled();
  assert.match(await page.locator('#requestRows').innerText(), /当前筛选没有请求/);
  assert.equal(await page.locator('#previousPage').isDisabled(), true);
  pass('explicit fallback and empty states');
  assert.deepEqual(errors, []);
  if (output) await writeFile(path.join(output, 'browser-checks.json'), JSON.stringify({ checks, errors }, null, 2));
} finally { await browser.close(); }
