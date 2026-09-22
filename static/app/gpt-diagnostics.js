const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = value => Number(value || 0).toLocaleString('zh-CN');
const shortId = value => value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
const active = run => ['queued', 'running'].includes(run.status);
const state = { credentials: [], models: {}, selected: new Map(), capabilities: null, ready: false, submitting: false,
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
function credentialState(credential) {
    if (credential.isDisabled) return '<span class="badge">已停用</span>';
    if (credential.isHealthy === false) return '<span class="badge warn">健康异常</span>';
    if (credential.isHealthy === true) return '<span class="badge good">健康</span>';
    return '<span class="badge">状态未知</span>';
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
    $('shared-model').disabled = true;
    updateBudget();
    try {
        const [providers, models, capabilities] = await Promise.all([
            api('/api/providers', {}, false), api('/api/provider-models', {}, false), api('/api/gpt-diagnostics/capabilities')
        ]);
        state.credentials = Object.entries(providers.providers || {}).filter(([type]) => /openai|codex/i.test(type))
            .flatMap(([providerType, values]) => (Array.isArray(values) ? values : []).filter(c => c.uuid).map(c => ({
                uuid: c.uuid, customName: c.customName, providerType, isHealthy: c.isHealthy, isDisabled: c.isDisabled,
                supportedModels: c.supportedModels, notSupportedModels: c.notSupportedModels
            })))
            .sort((a, b) => a.providerType.localeCompare(b.providerType) || identity(a).localeCompare(identity(b), 'zh-CN'));
        state.models = models;
        state.capabilities = capabilities;
        state.ready = true;
        $('config-error').hidden = true;
        $('credential-toggle').disabled = false;
        $('shared-model').disabled = false;
        renderOptions();
        renderTargets();
        renderModelOptions();
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
            <input id="credential-${esc(c.uuid)}" type="checkbox" data-credential="${esc(c.uuid)}" ${checked ? 'checked' : ''} ${c.isDisabled || limited ? 'disabled' : ''}>
            <span class="credential-identity"><strong>${esc(identity(c))}</strong><small>${esc(shortId(c.uuid))}</small></span>${credentialState(c)}</label>`;
    }).join('') || '<p class="empty">没有匹配的 GPT/OpenAI 凭据</p>';
    $('picker-hint').textContent = `已选 ${state.selected.size} / ${state.capabilities.maxTargets} 个；停用凭据不可选，健康异常凭据仍可检测。`;
    if (focusedId && $(focusedId)) $(focusedId).focus({ preventScroll: true });
    $('credential-options').scrollTop = scrollTop;
}
function modelsFor(credential) {
    const configured = Array.isArray(credential.supportedModels) && credential.supportedModels.length
        ? credential.supportedModels : state.models[credential.providerType] || [];
    return configured.filter(m => typeof m === 'string' && !credential.notSupportedModels?.includes(m));
}
function renderModelOptions() {
    const credentials = state.selected.size ? [...state.selected.values()].map(t => t.credential) : state.credentials;
    const candidates = [...new Set(credentials.flatMap(modelsFor))].sort();
    $('shared-model-options').innerHTML = candidates.map(m => `<option value="${esc(m)}"></option>`).join('');
}
function targetModel(target) { return (target.overridden ? target.model : $('shared-model').value).trim(); }
function renderTargets() {
    $('target-list').innerHTML = [...state.selected.values()].map(({ credential: c, overridden, model }) => `
        <div class="target-row" data-target="${esc(c.uuid)}">
            <div class="target-name"><strong>${esc(identity(c))}</strong><p class="target-meta">${esc(c.providerType)} · ${esc(shortId(c.uuid))}</p></div>
            <div><label class="sr-only" for="model-${esc(c.uuid)}">${esc(identity(c))} 的模型</label>
                <input id="model-${esc(c.uuid)}" data-target-model="${esc(c.uuid)}" list="models-${esc(c.uuid)}" value="${esc(overridden ? model : $('shared-model').value)}" placeholder="使用统一模型或单独输入">
                <datalist id="models-${esc(c.uuid)}">${modelsFor(c).map(m => `<option value="${esc(m)}"></option>`).join('')}</datalist>
                <span id="mode-${esc(c.uuid)}" class="field-help">${overridden ? '单独指定' : '跟随统一模型'}</span></div>
            <div class="target-actions"><button class="text-button" data-reset="${esc(c.uuid)}" ${overridden ? '' : 'hidden'}>恢复统一</button>
                <button class="text-button" data-remove="${esc(c.uuid)}" aria-label="移除 ${esc(identity(c))}">移除</button></div>
        </div>`).join('');
}
function updateBudget() {
    const count = state.selected.size;
    $('selection-count').textContent = `已选 ${count} 个凭据${state.capabilities ? ` / 最多 ${state.capabilities.maxTargets} 个` : ''}`;
    if (state.ready) $('credential-summary').textContent = count ? `已选择 ${count} 个凭据` : '选择检测凭据';
    if (state.capabilities) {
        const budget = state.capabilities.perTarget;
        $('budget').textContent = `${count} 个目标 · 最多 ${fmt(count * budget.requestCount)} 次请求 · ${fmt(count * budget.maxOutputTokens)} 输出 tokens`;
    }
    const invalid = [...state.selected.values()].some(t => !targetModel(t));
    $('start').disabled = !state.ready || !count || invalid || state.submitting;
    $('start').textContent = state.submitting ? '正在创建…' : '开始检测';
}

function resultHtml(target, key) {
    const credential = state.credentials.find(c => c.uuid === target.providerUuid);
    const name = target.providerName || credential?.customName || target.providerUuid || '未知凭据';
    const provider = target.providerType || credential?.providerType || '渠道未知';
    const trace = target.modelTrace;
    const knowledge = target.knowledge;
    const reasons = { candidate_bank_unavailable: '候选库不可用', no_valid_outputs: '未获得有效指纹输出' };
    const signalNames = { empty_output: '输出为空', response_model_mismatch: '上游返回模型不一致', reasoning_518n_minus_2: '推理 token 模式信号（启发式）' };
    const signals = (target.passiveSignals || []).map(s => signalNames[s.code] || s.code);
    return `<article class="result"><div class="result-header"><div><h3 class="result-name">${esc(name)}</h3>
        <p class="target-meta">${esc(provider)} · ${esc(target.providerUuid || '')}</p><p class="result-model">${esc(target.model)}</p></div>${badge(target.status)}</div>
        ${target.error ? `<p class="notice error">${esc(target.error)}</p>` : ''}
        <div class="result-metrics"><div><span class="metric-label">知识时间</span><strong>${knowledge ? `${fmt(knowledge.correct)} / ${fmt(knowledge.total)} 题正确` : '暂无结果'}</strong>
        ${knowledge ? `<p class="field-help">自报知识截止时间：${esc(knowledge.claimedKnowledgeCutoff || '未提供')}</p>` : ''}</div>
        <div><span class="metric-label">ModelTrace 闭集归因</span><strong>${trace?.valid ? esc(trace.predictionName || trace.prediction) : esc(reasons[trace?.reason] || trace?.reason || '暂无结果')}</strong>
        ${trace?.valid ? `<p class="field-help">闭集概率 ${(Number(trace.closedSetProbability) * 100).toFixed(2)}% · 不证明模型身份</p>` : ''}</div></div>
        <p class="signals ${signals.length ? 'has-signals' : ''}">被动信号：${signals.length ? esc(signals.join('；')) : '无已记录信号'}</p>
        ${knowledge ? `<details id="knowledge-${esc(key)}"><summary id="knowledge-summary-${esc(key)}">知识时间原始输出</summary><pre>${esc(knowledge.raw)}</pre></details>` : ''}
        <details id="evidence-${esc(key)}"><summary id="evidence-summary-${esc(key)}">诊断细节与请求记录</summary>
        <pre>${esc(JSON.stringify({ checks: knowledge?.checks, modelTrace: trace, passiveSignals: target.passiveSignals,
            probes: (target.probes || []).map(({ text, ...metadata }) => metadata) }, null, 2))}</pre></details></article>`;
}
function runResults(run) {
    return `${run.error ? `<p class="notice error">${esc(run.error)}</p>` : ''}
        ${run.bankError ? '<p class="notice error">ModelTrace 候选库不可用，本次可能无法完成指纹检测。</p>' : ''}
        ${(run.results || []).map((t, index) => resultHtml(t, `${run.runId}-${index}`)).join('') || '<p class="empty">暂无目标结果</p>'}`;
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
    }).join('') || '<p class="empty">暂无进行中的任务，选择凭据和模型即可开始。</p>';
    $('history-count').textContent = `${history.length} 条记录`;
    $('history-runs').innerHTML = history.map(run => `<details class="history-run" id="run-${esc(run.runId)}">
        <summary id="run-summary-${esc(run.runId)}"><span class="history-summary"><strong>${esc(formatDate(run.createdAt))}</strong>${badge(run.status)}
        <span class="muted">${run.targets?.length || run.estimate?.targetCount || run.results?.length || 0} 个目标</span><span class="version">${esc(run.testVersion || '版本未知')}</span></span></summary>
        ${runMeta(run)}${runResults(run)}</details>`).join('') || '<p class="empty">暂无检测记录。完成的任务会保留在这里。</p>';
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
    const targets = [...state.selected.values()].map(t => ({ providerUuid: t.credential.uuid, model: targetModel(t) }));
    state.submitting = true;
    updateBudget();
    notify('submit-status', '正在创建检测任务…');
    try {
        const data = await api('/api/gpt-diagnostics/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets }) });
        notify('submit-status', `任务已创建，共 ${data.run.targets.length} 个目标。`);
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
    const credential = state.credentials.find(c => c.uuid === id);
    if (event.target.checked && credential && !credential.isDisabled && state.selected.size < state.capabilities.maxTargets) {
        state.selected.set(id, { credential, overridden: false, model: '' });
    } else state.selected.delete(id);
    renderOptions(); renderTargets(); renderModelOptions(); updateBudget();
});
$('clear-selection').addEventListener('click', () => { state.selected.clear(); renderOptions(); renderTargets(); renderModelOptions(); updateBudget(); });
$('shared-model').addEventListener('input', () => {
    for (const [id, target] of state.selected) if (!target.overridden) $(`model-${id}`).value = $('shared-model').value;
    updateBudget();
});
$('target-list').addEventListener('input', event => {
    const id = event.target.dataset.targetModel;
    const target = state.selected.get(id);
    if (!target) return;
    target.overridden = true;
    target.model = event.target.value;
    $(`mode-${id}`).textContent = '单独指定';
    event.target.closest('.target-row').querySelector('[data-reset]').hidden = false;
    updateBudget();
});
$('target-list').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.remove) {
        state.selected.delete(button.dataset.remove);
        renderTargets(); renderOptions(); renderModelOptions(); updateBudget();
        $('credential-toggle').focus();
    } else if (button.dataset.reset) {
        const id = button.dataset.reset;
        const target = state.selected.get(id);
        target.overridden = false;
        target.model = '';
        $(`model-${id}`).value = $('shared-model').value;
        $(`mode-${id}`).textContent = '跟随统一模型';
        button.hidden = true;
        $(`model-${id}`).focus();
        updateBudget();
    }
});
$('start').addEventListener('click', startRun);
$('retry-config').addEventListener('click', loadConfig);
$('retry-runs').addEventListener('click', loadRuns);
$('current-runs').addEventListener('click', event => { const button = event.target.closest('[data-cancel]'); if (button) void cancelRun(button); });
void loadConfig();
void loadRuns();
setInterval(() => { if (!document.hidden) void loadRuns(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void loadRuns(); });
