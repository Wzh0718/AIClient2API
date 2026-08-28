import fs from 'fs';
import path from 'path';

function loadPotluckSource() {
    return fs.readFileSync(path.join(process.cwd(), 'static', 'potluck.html'), 'utf8').replace(/\r\n/g, '\n');
}

describe('API Potluck admin range and key detail UI source', () => {
    test('admin dashboard exposes a cumulative-default usage range switcher', () => {
        const source = loadPotluckSource();

        expect(source).toContain('id="usageRangeToggle"');
        expect(source).toContain("let currentUsageRange = '7d'");
        expect(source).toContain('<button class="range-option" data-range="total" onclick="setUsageRange(\'total\')" aria-pressed="false">累计</button>');
        expect(source).toContain("data-range=\"7d\"");
        expect(source).toContain('<button class="range-option active" data-range="7d" onclick="setUsageRange(\'7d\')" aria-pressed="true">近1周</button>');
        expect(source).toContain("data-range=\"today\"");
        expect(source).toContain('function setUsageRange(range)');
        expect(source).toContain('function getUsageRangeDates(range, usageHistory = {})');
        expect(source).toContain('function summarizeUsageHistoryForRange(usageHistory = {}, range = currentUsageRange)');
        expect(source).toContain('data-range="custom"');
        expect(source).toContain('id="customRangePanel"');
        expect(source).toContain('id="customRangeFrom"');
        expect(source).toContain('id="customRangeTo"');
        expect(source).toContain('function applyCustomRange()');
        expect(source).toContain("currentUsageRange = 'custom'");
        expect(source).toContain("timeZone: 'Asia/Shanghai'");
    });

    test('each admin key card has a detail modal entry for user-facing usage diagnostics', () => {
        const source = loadPotluckSource();

        expect(source).toContain('id="keyDetailModal"');
        expect(source).toContain('function showKeyDetail(keyId)');
        expect(source).toContain('function renderKeyDetailModal(key)');
        expect(source).toContain('function closeKeyDetailModal()');
        expect(source).toContain("onclick=\"showKeyDetail('${key.id}')\"");
        expect(source).toContain('用户端视图');
        expect(source).toContain('范围内服务商');
        expect(source).toContain('范围内模型');
    });

    test('admin provider distribution shows token share from the center provider view', () => {
        const source = loadPotluckSource();

        expect(source).toContain("const overviewResult = await apiRequest(`${API_BASE}/overview?${getCostQuery()}`)");
        expect(source).toContain('const keysResult = overviewResult?.success');
        expect(source).toContain('refreshLedgerRangeStats(currentUsageRange, { force: true })');
        expect(source).toContain('function renderProviderAccountTokenTree(elementId, providers, accounts, totalTokens)');
        expect(source).toContain("elementId: 'providerAccountDistribution'");
        expect(source).toContain('renderSynchronizedProviderViews()');
        expect(source).toContain('usageTokens(b) - usageTokens(a)');
        expect(source).toContain('formatTokenCompact(tokens)');
        expect(source).toContain('Token');
        expect(source).toContain('次');
    });

    test('admin model activity follows selected range while preserving fast model visibility', () => {
        const source = loadPotluckSource();

        expect(source).toContain('模型活跃度 (Models)');
        expect(source).toContain('function buildProviderModelDistribution(providerModels = {}, accounts = {})');
        expect(source).toContain('function renderProviderModelDistribution(elementId, providerModels, accounts = {})');
        expect(source).toContain("elementId: 'modelDistribution'");
        expect(source).toContain('providerModels: rangeSummary.providerModels');
        expect(source).toContain('selectedProviderAccountName = providerName');
        expect(source).toContain('renderSynchronizedProviderViews()');
        expect(source).toContain("providerName === 'unknown'");
        expect(source).toContain("normalizedName === 'unknown'");
        expect(source).toContain('const selectedTotalCalls = usageCount(selectedProvider.summary)');
        expect(source).toContain('const selectedTotalTokens = usageTokens(selectedProvider.summary)');
        expect(source).toContain("document.getElementById('modelTotalCount').textContent = `${formatNumber(selectedTotalCalls)} 次 / ${formatTokenCompact(selectedTotalTokens)} Tokens`");
        expect(source).toContain("renderDistribution('modelProviderPanel', selectedProvider.models, selectedTotalCalls, {");
        expect(source).toContain('maxItems: Number.POSITIVE_INFINITY');
        expect(source).toContain("emptyText: '当前范围暂无模型数据'");
        expect(source).toContain('filter: usage => usageTokens(usage) > 0');
        expect(source).toContain('const MODEL_DISPLAY_ALIASES = {');
        expect(source).toContain("'gtp-5.1': 'gpt-5.3-codex-spark'");
        expect(source).toContain("'gpt-5.1': 'gpt-5.3-codex-spark'");
        expect(source).toContain("'gpt-5': 'gpt-5.3-codex-spark'");
        expect(source).toContain("'5.4': 'gpt-5.3-codex-spark'");
        expect(source).toContain("'5.5': 'gpt-5.3-codex-spark'");
        expect(source).not.toContain("'gpt-5.6-sol-fast': 'gpt-5.6-sol'");
        expect(source).not.toContain("'gpt-5.6-terra-fast': 'gpt-5.6-terra'");
        expect(source).not.toContain("'gpt-5.6-luna-fast': 'gpt-5.6-luna'");
        expect(source).not.toContain("'gpt-5.5-fast': 'gpt-5.5'");
        expect(source).not.toContain("'gpt-5.4-fast': 'gpt-5.4'");
        expect(source).not.toContain("'gpt-5.4-mini-fast': 'gpt-5.4-mini'");
        expect(source).not.toContain("'gpt-5.3-codex-spark-fast': 'gpt-5.3-codex-spark'");
        expect(source).not.toContain("'gpt-5.2-fast': 'gpt-5.2'");
        expect(source).not.toContain("'gpt-image-2-fast': 'gpt-image-2'");
        expect(source).toContain('function aggregateModelDistributionForDisplay(models = {}, minCalls = 100)');
        expect(source).toContain("const lowCallLabel = `其他模型（<${minCalls}次）`");
        expect(source).toContain('providerModels: {}');
        expect(source).not.toContain('const allModelSummary = summarizeUsageHistoryForRange(usageHistory, \'total\')');
        expect(source).not.toContain("document.getElementById('modelDistribution').innerHTML = '<div class=\"detail-empty\">当前范围暂无模型数据</div>'");
    });

    test('initial dashboard load renders the token usage calendar after range stats load', () => {
        const source = loadPotluckSource();
        const loadDataStart = source.indexOf('async function loadData()');
        const loadDataEnd = source.indexOf('\n        function renderCalendar(', loadDataStart);
        const loadData = source.slice(loadDataStart, loadDataEnd);

        expect(loadData).toContain('await refreshLedgerRangeStats(currentUsageRange, { force: true });');
        expect(loadData).toContain('renderCalendar(currentStats?.usageHistory || {});');
    });

    test('admin dashboard folds account token share into the provider tree view', () => {
        const source = loadPotluckSource();

        expect(source).toContain('Provider / 账号 Token 占比');
        expect(source).toContain('id="providerAccountDistribution"');
        expect(source).toContain('id="providerAccountTotalCount"');
        expect(source).not.toContain('id="codexAccountDistribution"');
        expect(source).not.toContain('id="codexAccountTotalCount"');
        expect(source).toContain('function buildProviderAccountTokenTree(providers, accounts)');
        expect(source).toContain('function renderProviderAccountRows(provider)');
        expect(source).toContain('provider-account-children');
        expect(source).toContain('.usage-calendar-card { grid-column: span 3; }');
        expect(source).toContain('.usage-provider-card { grid-column: span 6; }');
        expect(source).toContain('.calendar-grid { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 9px);');
        expect(source).toContain('.calendar-day { width: 9px; height: 9px;');
        expect(source).toContain('account-main-row');
        expect(source).toContain('account-calls');
        expect(source).toContain('account-token-row');
        expect(source).toContain('account-token-value');
        expect(source).toContain('account-token-share');
        expect(source).toContain('account-sub');
        expect(source).toContain('.account-sub {\n            display: none;');
        expect(source).toContain('isCodexOauthAccount(account)');
        expect(source).toContain('Object.entries(day.accounts || {})');
    });

    test('admin provider account tree preserves Codex account identity metadata', () => {
        const source = loadPotluckSource();

        expect(source).toContain('accountIdentity: account.accountIdentity ||');
        expect(source).toContain('accountEmail: account.accountEmail ||');
        expect(source).toContain('providerUuids: Array.isArray(account.providerUuids)');
        expect(source).toContain('account?.accountEmail || account?.providerName');
        expect(source).toContain('function isEmailLike(value)');
        expect(source).toContain("return value.split('@')[0];");
    });

    test('admin provider account tree renders every account without grouping into other accounts', () => {
        const source = loadPotluckSource();
        const start = source.indexOf('function renderProviderAccountRows(provider)');
        expect(start).toBeGreaterThanOrEqual(0);
        const end = source.indexOf('function renderProviderAccountTokenTree', start);
        expect(end).toBeGreaterThan(start);
        const block = source.slice(start, end);

        expect(block).toContain('const rows = provider.accounts.map(account =>');
        expect(block).not.toContain('provider.accounts.slice(0, 5)');
        expect(block).not.toContain('provider.accounts.length > 5');
        expect(block).not.toContain('其他账号');
    });

    test('admin provider account view uses dynamic tabs with Codex-first selection and stable fallback', () => {
        const source = loadPotluckSource();

        expect(source).toContain('let selectedProviderAccountName = null');
        expect(source).toContain('function getProviderDisplayName(providerName)');
        expect(source).toContain("'openai-codex-oauth': 'Codex'");
        expect(source).toContain("'gemini-antigravity': 'Gemini'");
        expect(source).toContain('function resolveSelectedProviderAccountName(providers)');
        expect(source).toContain("providers.find(provider => provider.name === 'openai-codex-oauth')");
        expect(source).toContain('providers.some(provider => provider.name === selectedProviderAccountName)');
        expect(source).toContain('function selectProviderAccount(providerName, focusElementId = providerAccountViewState.elementId)');
        expect(source).toContain('selectedProviderAccountName = providerName');
        expect(source).toContain("container.querySelector('.provider-account-tab[aria-selected=\"true\"]')?.focus()");
        expect(source).toContain('renderProviderAccountTokenTree(');
        expect(source).toContain('provider-account-tabs');
        expect(source).toContain('provider-account-panel');

        const renderStart = source.indexOf('function renderProviderAccountTokenTree(elementId, providers, accounts, totalTokens)');
        expect(renderStart).toBeGreaterThanOrEqual(0);
        const renderEnd = source.indexOf('function renderDistribution', renderStart);
        expect(renderEnd).toBeGreaterThan(renderStart);
        const renderBlock = source.slice(renderStart, renderEnd);

        expect(renderBlock).toContain('.filter(provider => usageTokens(provider.summary) > 0)');
        expect(renderBlock).toContain('const selectedProviderName = resolveSelectedProviderAccountName(sorted)');
        expect(renderBlock).toContain('const selectedProvider = sorted.find(provider => provider.name === selectedProviderName)');
        expect(renderBlock).toContain('getProviderDisplayName(provider.name)');
        expect(renderBlock).toContain('provider.accounts.length');
        expect(renderBlock).toContain('formatPercentShare(providerTokens, denominator)');
        expect(renderBlock).toContain('renderProviderAccountRows(selectedProvider)');
        expect(renderBlock).not.toContain('const topData = sorted.slice(0, 5)');
        expect(renderBlock).not.toContain('其他 Provider');
    });

    test('admin provider tabs expose accessible selection and keyboard navigation', () => {
        const source = loadPotluckSource();

        expect(source).toContain('role="tablist"');
        expect(source).toContain('role="tab"');
        expect(source).toContain('aria-selected="${selected}"');
        expect(source).toContain('aria-controls="providerAccountPanel"');
        expect(source).toContain('role="tabpanel"');
        expect(source).toContain('id="providerAccountPanel"');
        expect(source).toContain('function handleProviderAccountTabKeydown(event, providerName)');
        expect(source).toContain("const isModelTab = event.currentTarget.id.startsWith('modelProviderTab')");
        expect(source).toContain('selectProviderAccount(providers[nextIndex].name, focusElementId)');
        expect(source).toContain("event.key === 'ArrowRight'");
        expect(source).toContain("event.key === 'ArrowLeft'");
        expect(source).toContain("event.key === 'Home'");
        expect(source).toContain("event.key === 'End'");
        expect(source).not.toContain("document.querySelector('.provider-account-tab[aria-selected=\"true\"]')?.focus()");
        expect(source).toContain('overflow-x: auto');
        expect(source).toContain('.provider-account-tab:focus-visible');
    });

    test('admin dashboard scopes value conversion controls to the key list and 35 day key detail history', () => {
        const source = loadPotluckSource();

        expect(source).toContain('id="conversionModelSelect"');
        expect(source).toContain('id="keyCostModelToggle"');
        expect(source).not.toContain('id="costActualSummary"');
        expect(source).not.toContain('id="todayTokensCost"');
        expect(source).not.toContain('id="totalTokensCost"');
        expect(source.indexOf('id="keyCostModelToggle"')).toBeGreaterThan(source.indexOf('<div class="keys-header">'));
        expect(source).toContain("const ACTUAL_VALUE_MODE = 'actual'");
        expect(source).toContain("let currentConversionModel = ACTUAL_VALUE_MODE");
        expect(source).toContain('function setConversionModel(model)');
        expect(source).toContain('conversionModel=${encodeURIComponent(currentConversionModel)}');
        expect(source).toContain('function formatUsd(value)');
        expect(source).toContain('function getActualCostUsd(cost)');
        expect(source).toContain('function getDisplayCostUsd(cost)');
        expect(source).toContain('function formatDisplayCost(cost)');
        expect(source).toContain('<option value="actual">真实</option>');
        expect(source).toContain('...models.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)');
        expect(source).not.toContain('换算 ${escapeHtml(model)}');
        expect(source).toContain('function setConversionLoading(loading)');
        expect(source).toContain("const toggle = document.getElementById('keyCostModelToggle')");
        expect(source).toContain("toggle.classList.toggle('is-loading', loading)");
        expect(source).toContain('select.disabled = loading');
        expect(source).toContain('setConversionLoading(true)');
        expect(source).toContain('setConversionLoading(false)');
        expect(source).not.toContain('实际 <span class="cost-inline">');
        expect(source).not.toContain('换算 <span class="cost-inline alt">');
        expect(source).toContain('.slice(-35)');
        expect(source).toContain('summary.cost');
        expect(source).not.toContain('价格版本：2026-07-01 官方快照');
        expect(source).toContain('节点与 Token 使用统计 (最近 35 天)');
        expect(source).not.toContain('节点与 Token 使用统计 (最近 3 个月)');
    });

    test('admin overview model distribution shows row tokens and cost while keeping totals out of the dashboard chrome', () => {
        const source = loadPotluckSource();

        expect(source).toContain("document.getElementById('providerAccountTotalCount').textContent = `${formatNumber(totalCalls)} 次 / ${formatTokenCompact(totalTokens)} Tokens`");
        expect(source).toContain("document.getElementById('modelTotalCount').textContent = `${formatNumber(selectedTotalCalls)} 次 / ${formatTokenCompact(selectedTotalTokens)} Tokens`");
        expect(source).not.toContain("document.getElementById('providerAccountTotalCount').innerHTML = `${formatNumber(totalCalls)} 次 / ${formatTokenCompact(totalTokens)} Tokens${rangeSummary.summary.cost");
        expect(source).not.toContain("document.getElementById('modelTotalCount').innerHTML = `${formatNumber(totalCalls)} 次${rangeSummary.summary.cost");

        const renderDistributionStart = source.indexOf('function renderDistribution(elementId, data, total, options = {})');
        expect(renderDistributionStart).toBeGreaterThanOrEqual(0);
        const renderDistributionEnd = source.indexOf('function setUsageRange(range)', renderDistributionStart);
        expect(renderDistributionEnd).toBeGreaterThan(renderDistributionStart);
        const renderDistributionBlock = source.slice(renderDistributionStart, renderDistributionEnd);
        expect(renderDistributionBlock).toContain('const tokens = usageTokens(item)');
        expect(renderDistributionBlock).toContain('const costHtml = item?.cost ? ` · ${formatDisplayCost(item.cost)}` :');
        expect(renderDistributionBlock).not.toContain('estimatedCostHtml');
        expect(renderDistributionBlock).not.toContain('均价估算');
        expect(renderDistributionBlock).toContain('${formatNumber(count)} 次 / ${formatTokenCompact(tokens)} Tokens (${percent}%)');
        expect(renderDistributionBlock).toContain('sum.tokens += usageTokens(item[1])');
        expect(renderDistributionBlock).toContain('${formatNumber(otherCount)} 次 / ${formatTokenCompact(otherTokens)} Tokens (${otherPercent}%)');
        expect(renderDistributionBlock).toContain('${costHtml}');
        expect(renderDistributionBlock).not.toContain('missingCostHtml');
    });

    test('admin key list defaults to sorting by current range tokens', () => {
        const source = loadPotluckSource();
        const rangeTokenOption = '<option value="rangeTokens-desc">当前范围 Token ↓</option>';
        const rangeCostOption = '<option value="rangeCost-desc">当前范围金额 ↓</option>';

        expect(source.indexOf(rangeTokenOption)).toBeGreaterThanOrEqual(0);
        expect(source.indexOf(rangeTokenOption)).toBeLessThan(source.indexOf(rangeCostOption));
        expect(source).toContain("else if (field === 'rangeTokens') { va = getKeyRangeMetrics(a).totalTokens; vb = getKeyRangeMetrics(b).totalTokens; }");
    });

    test('admin key range amount sorting waits for the ledger-backed key summaries', () => {
        const source = loadPotluckSource();
        const setRangeStart = source.indexOf('async function setUsageRange(range)');
        const setRangeEnd = source.indexOf('function setLimitControl', setRangeStart);
        const setRangeBlock = source.slice(setRangeStart, setRangeEnd);

        expect(setRangeStart).toBeGreaterThanOrEqual(0);
        expect(setRangeBlock).toContain('await refreshLedgerRangeStats(currentUsageRange, { force: true });');
        expect(setRangeBlock.indexOf('await refreshLedgerRangeStats(currentUsageRange, { force: true });'))
            .toBeLessThan(setRangeBlock.indexOf('applyFilterAndSort();'));
        expect(source).toContain('&includeKeys=1');
        expect(source).toContain('ledgerData?.keySummaries?.[key.id]');
    });

    test('admin request frequency follows the selected usage range', () => {
        const source = loadPotluckSource();

        expect(source).toContain('function getRangeRateMetrics(');
        expect(source).toContain('rangeSummary.summary.requestCount');
        expect(source).toContain('rangeRate.qps');
        expect(source).toContain('rangeRate.rpm');
        expect(source).toContain('所选范围平均');
    });

    test('admin provider account tree rolls account cost up to provider headers', () => {
        const source = loadPotluckSource();

        expect(source).toContain('function addCostBucket(targetCost, sourceCost)');
        expect(source).toContain('function rollupProviderCostFromAccounts(provider)');
        expect(source).toContain('rollupProviderCostFromAccounts(provider)');
        expect(source).not.toContain("provider.summary?.cost ? ` · <span class=\"cost-inline\">${formatUsd(provider.summary.cost.actualUsd)}</span>`");
    });
});
