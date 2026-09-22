// Mock-only browser smoke: node tests/gpt-diagnostics-ui.smoke.mjs [screenshot-directory]
// Uses an existing Playwright installation; PLAYWRIGHT_MODULE_PATH and BROWSER_CHANNEL are optional.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = fileURLToPath(new URL('../static/', import.meta.url));
const output = process.argv[2];
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
const checks = [];
page.on('pageerror', error => errors.push(error.message));
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
const models = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra'];
const credentials = Array.from({ length: 16 }, (_, i) => ({ uuid: `credential-${String(i).padStart(2, '0')}`,
    customName: i < 2 ? '共享账户' : i === 2 ? '很长的凭据名称，用来检查窄屏布局与文字换行，不应撑宽页面' : `诊断账户 ${i}`,
    isHealthy: i !== 2, isDisabled: i === 11, needsRefresh: i === 14, quotaAvailable: i === 15 ? false : undefined,
    uiAvailable: ![2, 11, 14, 15].includes(i), uiUnavailableReason: [2, 11, 14, 15].includes(i) ? 'fixture' : null }));
const capabilities = { testVersion: 'gpt-diagnostics-v3', maxTargets: 10, models,
    defaultTests: ['modeltrace'], perCredential: { requestCount: 12, maxOutputTokens: 98304 } };
const historical = { runId: 'history-1', status: 'partial', createdAt: '2026-09-22T04:20:00Z', testVersion: 'gpt-diagnostics-v1',
    targets: [{ providerUuid: 'deleted-account', model: 'gpt-test' }], estimate: { credentialCount: 1, targetCount: 1, requestCount: 5, maxOutputTokens: 26192 },
    results: [{ providerUuid: 'deleted-account', model: 'gpt-test', status: 'failed', error: '模拟上游错误：服务暂不可用',
        knowledge: { correct: 1, total: 2, claimedKnowledgeCutoff: '2025-04', raw: '{"answers":{}}' },
        modelTrace: { valid: true, prediction: 'gpt-5.6-luna', predictionName: 'gpt-5.6-luna', closedSetProbability: .8123, bankVersion: 'fixture' },
        passiveSignals: [{ code: 'response_model_mismatch', responseModel: 'upstream-model' }], pelican: { previewSvg: '<svg></svg>', manualScore: 4 } }] };
let runs = [historical];
let failConfig = true;
let failRuns = false;
let failCreate = false;
let failCancel = false;
let createCount = 0;
let posted;
let unblockCreate;
let holdCreate = false;
let runGets = 0;
await page.clock.install();
await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.hostname, 'diagnostics.test', 'No real network requests allowed');
    const respond = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/providers') return failConfig ? respond({ error: { message: '模拟配置错误' } }, 503) : respond({ providers: {
        'openai-codex-oauth': credentials, 'gemini-cli-oauth': [{ uuid: 'excluded', customName: '非 GPT' }]
    } });
    if (url.pathname === '/api/provider-models') return respond({ 'openai-codex-oauth': ['gpt-test', 'gpt-alt'] });
    if (url.pathname.endsWith('/capabilities')) return respond({ success: true, data: capabilities });
    if (url.pathname.endsWith('/cancel')) {
        if (failCancel) return respond({ error: { message: '模拟取消失败' } }, 503);
        runs = runs.map(r => r.runId === 'new-run' ? { ...r, status: 'cancelled' } : r);
        return respond({ success: true, data: { run: runs.find(r => r.runId === 'new-run') } });
    }
    if (url.pathname === '/api/gpt-diagnostics/runs') {
        if (route.request().method() === 'POST') {
            createCount++;
            posted = route.request().postDataJSON();
            if (holdCreate) await new Promise(resolve => { unblockCreate = resolve; });
            if (failCreate) return respond({ error: { message: '模拟创建失败' } }, 503);
            const targetCount = posted.targets.length * models.length;
            const run = { runId: 'new-run', status: 'queued', createdAt: new Date().toISOString(), testVersion: 'gpt-diagnostics-v3',
                targets: posted.targets.flatMap(t => models.map(model => ({ providerUuid: t.providerUuid, model }))),
                estimate: { credentialCount: posted.targets.length, targetCount, requestCount: posted.targets.length * 12, maxOutputTokens: posted.targets.length * 98304 }, results: [] };
            runs = [run, ...runs];
            return respond({ success: true, data: { run } }, 202);
        }
        runGets++;
        return failRuns ? respond({ error: { message: '模拟历史读取失败' } }, 503) : respond({ success: true, data: { runs } });
    }
    const assets = { '/gpt-diagnostics.html': 'text/html', '/app/gpt-diagnostics.js': 'text/javascript', '/app/gpt-diagnostics.css': 'text/css' };
    if (assets[url.pathname]) return route.fulfill({ contentType: assets[url.pathname], body: await readFile(path.join(root, url.pathname)) });
    return route.fulfill({ status: 404, body: 'Not found' });
});
async function wait(check) {
    for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.fail('Timed out waiting for UI state');
}
async function refresh() {
    const before = runGets;
    await page.clock.fastForward(5000);
    await wait(() => runGets > before);
}
try {
    await page.goto('http://diagnostics.test/gpt-diagnostics.html');
    await page.locator('#config-error').waitFor({ state: 'visible' });
    assert(await page.locator('#start').isDisabled());
    failConfig = false;
    await page.locator('#retry-config').click();
    await wait(() => page.locator('#credential-toggle').isEnabled());
    assert(await page.locator('#start').isDisabled());
    assert.deepEqual(await page.locator('#fixed-models .chip').allTextContents(), models);
    pass('configuration error/retry, raw API shapes, fixed model chips, no default selections');

    await page.locator('#credential-toggle').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'credential-search');
    await page.locator('#credential-search').fill('共享账户');
    assert.equal(await page.locator('[data-credential]').count(), 2);
    assert.notEqual(await page.locator('.credential-identity small').nth(0).textContent(), await page.locator('.credential-identity small').nth(1).textContent());
    await page.locator('[data-credential="credential-00"]').check();
    await page.locator('[data-credential="credential-01"]').check();
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'credential-toggle');
    assert((await page.locator('#budget').textContent()).includes('2 个凭据'));
    assert((await page.locator('#budget').textContent()).includes('24 次请求'));
    assert((await page.locator('#budget').textContent()).includes('196,608'));
    pass('keyboard picker, duplicate names, per-credential budget');

    await page.locator('#credential-toggle').click();
    await page.locator('#credential-search').fill('');
    assert.equal(await page.locator('[data-credential]').count(), 12);
    for (const uuid of ['credential-02', 'credential-11', 'credential-14', 'credential-15']) {
        assert((await page.locator(`[data-credential="${uuid}"]`).count()) === 0, `${uuid} unavailable credential must be hidden`);
    }
    for (const i of [0, 1, 3, 4, 5, 6, 7, 8, 9]) await page.locator(`[data-credential="credential-${String(i).padStart(2, '0')}"]`).check();
    assert(await page.locator('[data-credential="credential-10"]').isEnabled());
    await page.locator('[data-credential="credential-10"]').check();
    assert.equal(await page.locator('.target-row').count(), 10);
    assert(await page.locator('[data-credential="credential-12"]').isDisabled());
    assert(await page.locator('[data-credential="credential-13"]').isDisabled());
    await page.locator('#clear-selection').click();
    assert.equal(await page.locator('.target-row').count(), 0);
    await page.locator('[data-credential="credential-03"]').check();
    await page.keyboard.press('Escape');
    pass('GPT/availability filtering, ten-credential limit, clear selection');

    await page.locator('#run-summary-history-1').click();
    assert.equal(await page.locator('iframe').count(), 0);
    const bodyText = await page.locator('body').innerText();
    assert(!bodyText.includes('鹈鹕') && !bodyText.includes('知识时间'), 'retired surfaces must stay hidden');
    assert((await page.locator('#history-runs').innerText()).includes('deleted-account'));
    assert.equal(await page.locator('#history-runs .trace-table tbody tr').count(), 1);
    assert((await page.locator('#history-runs .trace-table tbody tr').getAttribute('class') || '').includes('mismatch'));
    assert((await page.locator('#history-runs .trace-table').innerText()).includes('指纹与请求不一致'));
    assert((await page.locator('#history-runs .trace-table').innerText()).includes('81.23%'));
    assert((await page.locator('#history-runs .trace-table').innerText()).includes('upstream-model'));
    await page.locator('#evidence-summary-history-1-0').focus();
    runs[0] = { ...historical, estimate: { ...historical.estimate, requestCount: 4 } };
    await refresh();
    await wait(async () => (await page.locator('#history-runs .run-meta').textContent()).includes('4 次请求'));
    assert(await page.locator('#evidence-history-1-0').evaluate(e => e.open) === false);
    failRuns = true;
    await refresh();
    await page.locator('#runs-error').waitFor({ state: 'visible' });
    assert((await page.locator('#history-runs').innerText()).includes('deleted-account'));
    failRuns = false;
    await page.locator('#retry-runs').click();
    await page.locator('#runs-error').waitFor({ state: 'hidden' });
    pass('legacy fallback, fingerprint comparison table with mismatch highlight, refresh preserves focus, retry retains results');

    failCreate = true;
    await page.locator('#start').click();
    await wait(async () => (await page.locator('#submit-status').textContent()).includes('创建失败'));
    assert.equal(await page.locator('.target-row').count(), 1);
    failCreate = false;
    holdCreate = true;
    await page.locator('#start').click();
    await wait(() => Boolean(unblockCreate));
    assert(await page.locator('#start').isDisabled());
    await page.locator('#start').evaluate(button => { button.click(); button.click(); });
    assert.equal(createCount, 2);
    unblockCreate();
    await page.locator('#cancel-new-run').waitFor();
    assert.deepEqual(posted.targets, [{ providerUuid: 'credential-03' }]);
    pass('create failure preserves input; pending POST blocks duplicate submission and posts credential-only targets');

    if (output) {
        await page.locator('#run-summary-history-1').click();
        await page.locator('#evidence-summary-history-1-0').click();
        await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
        await page.locator('#credential-toggle').click();
        await page.screenshot({ path: path.join(output, 'picker.png'), fullPage: true });
        await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (output) await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    pass('390px responsive layout has no horizontal overflow');

    failCancel = true;
    await page.locator('#cancel-new-run').click();
    await wait(async () => (await page.locator('#cancel-status').textContent()).includes('取消失败'));
    assert(await page.locator('#cancel-new-run').isEnabled());
    failCancel = false;
    await page.locator('#cancel-new-run').click();
    await page.locator('#run-summary-new-run').waitFor();
    assert(await page.locator('#run-new-run').evaluate(e => e.open));
    assert((await page.locator('#cancel-status').textContent()).includes('当前请求可能仍需结束'));
    pass('cancel failure retry and completed cancellation');

    runs = [];
    await refresh();
    await wait(async () => (await page.locator('#history-runs').textContent()).includes('暂无检测记录'));
    assert.equal(await page.locator('.target-row').count(), 1);
    assert.deepEqual(errors, []);
    pass('empty history and polling preserve unsent selections; no browser exceptions');
    console.log(`PASS ${checks.length} browser scenario groups; all API calls mocked.`);
} finally { unblockCreate?.(); await browser.close(); }
