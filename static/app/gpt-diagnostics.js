const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = value => Number(value || 0).toLocaleString('zh-CN');
const shortId = value => value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
const active = run => ['queued', 'running'].includes(run.status);
const state = { credentials: [], selected: new Map(), capabilities: null, ready: false, submitting: false,
    runs: [], loadingRuns: false, runSignature: null, cancelling: new Set() };

async function api(url, options = {}, envelope = true) {
    const token = localStorage.getItem('authToken');
    const response = await fetch(url, { ...options, headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers
    } });
    const body = await response.json();
    if (!response.ok || body.success === false) {
        throw new Error(response.status === 401 ? '登录已失效，请返回请求记录重新登录。' : body.error?.message || `请求失败（HTTP ${response.status}）`);
    }
    return envelope ? body.data : body;
}

const statusNames = { queued: '排队中', running: '检测中', completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
function badge(status) {
    const tone = { queued: 'active', running: 'active', completed: 'good', partial: 'warn', failed: 'bad', interrupted: 'warn' }[status] || '';
    return `<span class="badge ${tone}">${esc(statusNames[status] || status || '未知')}</span>`;
}
function identity(credential) { return credential.customName || credential.providerName || credential.uuid || credential.providerUuid || '未知凭据'; }
function notify(id, message, error = false) {
    $(id).textContent = message;
    $(id).classList.toggle('error', error);
}

async function loadConfig() {
    state.ready = false;
    $('retry-config').disabled = true;
    $('credential-toggle').disabled = true;
    updateBudget();
    try {
        const [providers, capabilities] = await Promise.all([
            api('/api/providers', {}, false), api('/api/gpt-diagnostics/capabilities')
        ]);
        state.credentials = Object.entries(providers.providers || {}).filter(([type]) => /openai|codex/i.test(type))
            .flatMap(([providerType, values]) => (Array.isArray(values) ? values : []).filter(c => c.uuid).map(c => ({
                uuid: c.uuid, customName: c.customName, providerType, uiAvailable: c.uiAvailable, uiUnavailableReason: c.uiUnavailableReason
            })))
            .filter(c => c.uiAvailable !== false)
            .sort((a, b) => a.providerType.localeCompare(b.providerType) || identity(a).localeCompare(identity(b), 'zh-CN'));
        state.capabilities = capabilities;
        state.ready = true;
        $('config-error').hidden = true;
        $('credential-toggle').disabled = false;
        renderFixedModels();
        renderOptions();
        renderTargets();
        updateBudget();
        // Names loaded after the initial history request should also appear in legacy records.
        renderRuns();
    } catch (error) {
        state.ready = false;
        $('start').disabled = true;
        $('config-error').hidden = false;
        $('config-error-text').textContent = `无法加载检测配置：${error.message}`;
        $('credential-summary').textContent = '配置加载失败';
        $('budget').textContent = '预算暂不可用';
    } finally { $('retry-config').disabled = false; }
}

function setPicker(open, restoreFocus = false) {
    $('credential-menu').hidden = !open;
    $('credential-toggle').setAttribute('aria-expanded', String(open));
    if (open) $('credential-search').focus();
    else if (restoreFocus) $('credential-toggle').focus();
}
function renderFixedModels() {
    const models = state.capabilities?.models || [];
    $('fixed-models').innerHTML = models.length
        ? models.map(m => `<span class="chip">${esc(m)}</span>`).join('')
        : '<span class="muted">暂无配置</span>';
}
function renderOptions() {
    const query = $('credential-search').value.trim().toLowerCase();
    const focusedId = document.activeElement?.id;
    const scrollTop = $('credential-options').scrollTop;
    let group = null;
    const visible = state.credentials.filter(c => `${identity(c)} ${c.uuid} ${c.providerType}`.toLowerCase().includes(query));
    $('credential-options').innerHTML = visible.map(c => {
        const header = group !== c.providerType ? `<h3 class="provider-heading">${esc(c.providerType)}</h3>` : '';
        group = c.providerType;
        const checked = state.selected.has(c.uuid);
        const limited = state.selected.size >= state.capabilities.maxTargets && !checked;
        return `${header}<label class="credential-option" title="${esc(c.uuid)}">
            <input id="credential-${esc(c.uuid)}" type="checkbox" data-credential="${esc(c.uuid)}" ${checked ? 'checked' : ''} ${limited ? 'disabled' : ''}>
            <span class="credential-identity"><strong>${esc(identity(c))}</strong><small>${esc(shortId(c.uuid))}</small></span></label>`;
    }).join('') || '<p class="empty">没有可用的 GPT/OpenAI 凭据</p>';
    $('picker-hint').textContent = `已选 ${state.selected.size} / ${state.capabilities.maxTargets} 个；仅展示可用凭据（未停用、健康、无需刷新、配额未耗尽）。`;
    if (focusedId && $(focusedId)) $(focusedId).focus({ preventScroll: true });
    $('credential-options').scrollTop = scrollTop;
}
function renderTargets() {
    $('target-list').innerHTML = [...state.selected.values()].map(({ credential: c }) => `
        <div class="target-row" data-target="${esc(c.uuid)}">
            <div class="target-name"><strong>${esc(identity(c))}</strong><p class="target-meta">${esc(c.providerType)} · ${esc(shortId(c.uuid))}</p></div>
            <div class="target-actions"><button class="text-button" data-remove="${esc(c.uuid)}" aria-label="移除 ${esc(identity(c))}">移除</button></div>
        </div>`).join('');
}
function updateBudget() {
    const count = state.selected.size;
    $('selection-count').textContent = `已选 ${count} 个凭据${state.capabilities ? ` / 最多 ${state.capabilities.maxTargets} 个` : ''}`;
    if (state.ready) $('credential-summary').textContent = count ? `已选择 ${count} 个凭据` : '选择检测凭据';
    if (state.capabilities) {
        const budget = state.capabilities.perCredential;
        $('budget').textContent = `${count} 个凭据 · 最多 ${fmt(count * budget.requestCount)} 次请求 · ${fmt(count * budget.maxOutputTokens)} 输出 tokens`;
    }
    $('start').disabled = !state.ready || !count || state.submitting;
    $('start').textContent = state.submitting ? '正在创建…' : '开始检测';
}

const traceReasons = { candidate_bank_unavailable: '候选库不可用', no_valid_outputs: '未获得有效指纹输出' };
const signalNames = { empty_output: '输出为空', response_model_mismatch: '上游返回模型不一致', reasoning_518n_minus_2: '推理 token 模式信号（启发式）' };
const baseModel = id => String(id || '').replace(/-(fast|ultrafast)$/i, '');
function groupResults(run) {
    const groups = new Map();
    for (const row of run.results || []) {
        if (!groups.has(row.providerUuid)) {
            const credential = state.credentials.find(c => c.uuid === row.providerUuid);
            groups.set(row.providerUuid, {
                providerUuid: row.providerUuid,
                name: row.providerName || credential?.customName || row.providerUuid || '未知凭据',
                provider: row.providerType || credential?.providerType || '渠道未知',
                rows: []
            });
        }
        groups.get(row.providerUuid).rows.push(row);
    }
    return [...groups.values()];
}
function resultHtml(group, key) {
    const overall = group.rows.some(r => ['failed', 'partial'].includes(r.status)) ? 'partial'
        : (group.rows.every(r => r.status === 'completed') ? 'completed' : group.rows[0]?.status);
    const rows = group.rows.map(row => {
        const trace = row.modelTrace;
        const mismatch = trace?.valid && trace.prediction && baseModel(trace.prediction) !== row.model;
        const upstream = (row.passiveSignals || []).find(s => s.code === 'response_model_mismatch');
        const detail = trace?.valid
            ? `${mismatch ? '⚠ 指纹与请求不一致' : '指纹与请求一致'} · 闭集概率 ${(Number(trace.closedSetProbability) * 100).toFixed(2)}%${upstream ? ` · 上游返回 ${upstream.responseModel || '未知模型'}` : ''}`
            : esc(traceReasons[trace?.reason] || trace?.reason || '暂无结果');
        return `<tr class="${mismatch ? 'mismatch' : ''}"><td class="mono">${esc(row.model)}</td>
            <td><strong>${trace?.valid ? esc(trace.predictionName || trace.prediction) : '—'}</strong><p class="field-help">${detail}</p></td>
            <td>${badge(row.status)}</td></tr>`;
    }).join('');
    return `<article class="result"><div class="result-header"><div><h3 class="result-name">${esc(group.name)}</h3>
        <p class="target-meta">${esc(group.provider)} · ${esc(group.providerUuid || '')}</p></div>${badge(overall)}</div>
        <table class="trace-table"><thead><tr><th>请求模型</th><th>ModelTrace 闭集归因</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table>
        <details id="evidence-${esc(key)}"><summary id="evidence-summary-${esc(key)}">诊断细节与请求记录</summary>
        <pre>${esc(JSON.stringify(group.rows.map(row => ({
            model: row.model, modelTrace: row.modelTrace, passiveSignals: row.passiveSignals,
            probes: (row.probes || []).map(({ text, ...metadata }) => metadata)
        })), null, 2))}</pre></details></article>`;
}
function runResults(run) {
    return `${run.error ? `<p class="notice error">${esc(run.error)}</p>` : ''}
        ${run.bankError ? '<p class="notice error">ModelTrace 候选库不可用，本次可能无法完成指纹检测。</p>' : ''}
        ${groupResults(run).map((group, index) => resultHtml(group, `${run.runId}-${index}`)).join('') || '<p class="empty">暂无目标结果</p>'}`;
}
function runMeta(run) {
    return `<p class="run-meta">${esc(run.testVersion || '版本未知')} · 预算上限 ${fmt(run.estimate?.requestCount)} 次请求 / ${fmt(run.estimate?.maxOutputTokens)} 输出 tokens</p>`;
}
function formatDate(date) { return date && Number.isFinite(Date.parse(date)) ? new Date(date).toLocaleString('zh-CN', { hour12: false }) : '时间未知'; }
function renderRuns() {
    const open = new Set([...document.querySelectorAll('#current-runs details[open], #history-runs details[open]')].map(d => d.id));
    const previouslyActive = new Set([...document.querySelectorAll('#current-runs [data-run-id]')].map(el => el.dataset.runId));
    const focus = document.activeElement;
    const focusId = focus?.id;
    const wasInside = $('current-runs').contains(focus) || $('history-runs').contains(focus);
    const current = state.runs.filter(active);
    const history = state.runs.filter(run => !active(run));
    $('current-runs').innerHTML = current.map(run => {
        const total = run.targets?.length || run.estimate?.targetCount || 0;
        const done = run.results?.length || 0;
        return `<article class="run" data-run-id="${esc(run.runId)}"><div class="run-heading">${badge(run.status)}<strong>${esc(formatDate(run.createdAt))}</strong>
            <button id="cancel-${esc(run.runId)}" data-cancel="${esc(run.runId)}" ${state.cancelling.has(run.runId) ? 'disabled' : ''}>${state.cancelling.has(run.runId) ? '已请求取消' : '取消任务'}</button></div>
            ${runMeta(run)}<div class="run-progress"><progress value="${done}" max="${Math.max(total, 1)}" aria-label="已完成目标"></progress><span>已完成 ${done} / ${total} 个目标</span></div>
            <p class="field-help">取消后不再开始后续请求，当前请求可能仍需结束。</p>${runResults(run)}</article>`;
    }).join('') || '<p class="empty">暂无进行中的任务，选择凭据即可开始。</p>';
    $('history-count').textContent = `${history.length} 条记录`;
    $('history-runs').innerHTML = history.map(run => {
        const count = run.estimate?.credentialCount
            ? `${run.estimate.credentialCount} 个凭据` : `${run.targets?.length || run.estimate?.targetCount || run.results?.length || 0} 个目标`;
        return `<details class="history-run" id="run-${esc(run.runId)}">
        <summary id="run-summary-${esc(run.runId)}"><span class="history-summary"><strong>${esc(formatDate(run.createdAt))}</strong>${badge(run.status)}
        <span class="muted">${count}</span><span class="version">${esc(run.testVersion || '版本未知')}</span></span></summary>
        ${runMeta(run)}${runResults(run)}</details>`;
    }).join('') || '<p class="empty">暂无检测记录。完成的任务会保留在这里。</p>';
    for (const id of open) if ($(id)) $(id).open = true;
    for (const id of previouslyActive) if ($(`run-${id}`)) $(`run-${id}`).open = true;
    if (wasInside) {
        const replacement = focusId && $(focusId);
        if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
        else $('current-title').focus({ preventScroll: true });
    }
}
async function loadRuns() {
    if (state.loadingRuns) return;
    state.loadingRuns = true;
    $('retry-runs').disabled = true;
    try {
        const data = await api('/api/gpt-diagnostics/runs');
        const signature = JSON.stringify(data.runs || []);
        state.runs = data.runs || [];
        if (signature !== state.runSignature) { renderRuns(); state.runSignature = signature; }
        $('runs-error').hidden = true;
    } catch (error) {
        $('runs-error').hidden = false;
        $('runs-error-text').textContent = `刷新失败，已有结果已保留：${error.message}`;
        if (state.runSignature === null) {
            $('current-runs').innerHTML = '<p class="empty">暂时无法读取任务</p>';
            $('history-runs').innerHTML = '<p class="empty">暂时无法读取历史记录</p>';
        }
    } finally { state.loadingRuns = false; $('retry-runs').disabled = false; }
}
async function startRun() {
    if ($('start').disabled || state.submitting) return;
    const targets = [...state.selected.keys()].map(providerUuid => ({ providerUuid }));
    state.submitting = true;
    updateBudget();
    notify('submit-status', '正在创建检测任务…');
    try {
        const data = await api('/api/gpt-diagnostics/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets }) });
        notify('submit-status', `任务已创建，共 ${data.run.estimate.credentialCount} 个凭据 / ${data.run.targets.length} 个目标。`);
        state.runs = [data.run, ...state.runs.filter(r => r.runId !== data.run.runId)];
        state.runSignature = null;
        renderRuns();
        await loadRuns();
    } catch (error) { notify('submit-status', `创建失败：${error.message}`, true); }
    finally { state.submitting = false; updateBudget(); }
}
async function cancelRun(button) {
    const id = button.dataset.cancel;
    if (state.cancelling.has(id)) return;
    state.cancelling.add(id);
    button.disabled = true;
    button.textContent = '正在取消…';
    try {
        await api(`/api/gpt-diagnostics/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
        button.textContent = '已请求取消';
        notify('cancel-status', '已请求取消，当前请求可能仍需结束。');
        await loadRuns();
    } catch (error) {
        state.cancelling.delete(id);
        button.disabled = false;
        button.textContent = '取消任务';
        notify('cancel-status', `取消失败：${error.message}`, true);
    }
}

$('credential-toggle').addEventListener('click', () => setPicker($('credential-menu').hidden));
$('credential-search').addEventListener('input', () => { $('credential-options').scrollTop = 0; renderOptions(); });
document.addEventListener('click', event => { if (!event.target.closest('.picker')) setPicker(false); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('credential-menu').hidden) setPicker(false, true); });
document.querySelector('.picker').addEventListener('focusout', event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setPicker(false);
});
$('credential-options').addEventListener('change', event => {
    const id = event.target.dataset.credential;
    if (!id) return;
    if (event.target.checked && state.selected.size < state.capabilities.maxTargets) {
        const credential = state.credentials.find(c => c.uuid === id);
        if (credential) state.selected.set(id, { credential });
    } else state.selected.delete(id);
    renderOptions(); renderTargets(); updateBudget();
});
$('clear-selection').addEventListener('click', () => { state.selected.clear(); renderOptions(); renderTargets(); updateBudget(); });
$('target-list').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button?.dataset.remove) return;
    state.selected.delete(button.dataset.remove);
    renderTargets(); renderOptions(); updateBudget();
    $('credential-toggle').focus();
});
$('start').addEventListener('click', startRun);
$('retry-config').addEventListener('click', loadConfig);
$('retry-runs').addEventListener('click', loadRuns);
$('current-runs').addEventListener('click', event => { const button = event.target.closest('[data-cancel]'); if (button) void cancelRun(button); });
void loadConfig();
void loadRuns();
setInterval(() => { if (!document.hidden) void loadRuns(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void loadRuns(); });
