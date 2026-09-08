import fs from 'fs';
import path from 'path';

describe('usage manager display source regressions', () => {
    test('provider usage groups use one full-width row and stack Gemini quota badges', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');
        const css = fs.readFileSync(path.join(process.cwd(), 'static/components/section-usage.css'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain("group.className = 'usage-provider-group is-full-width collapsed'");
        expect(source).toContain('antigravity-model-availability-summary');
        expect(source).toContain('quotaExhaustedCount');
        expect(source).toContain('credentialUnavailableCount');
        expect(source).not.toContain('Claude+GPT');
        expect(source).not.toContain('usage-provider-summary-tooltip');
        expect(css).toMatch(/\.usage-provider-groups\s*\{[^}]*grid-template-columns:\s*1fr;/s);
        expect(css).toContain('.antigravity-model-availability-summary');
        expect(css).toContain('.antigravity-model-availability-row');
    });

    test('provider header shows Gemini model availability before the success count', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');
        const providerHeader = source.slice(
            source.indexOf('<div class="usage-group-title">'),
            source.indexOf('<div class="usage-group-actions">')
        );

        expect(providerHeader.indexOf('${providerQuotaStack}')).toBeGreaterThanOrEqual(0);
        expect(providerHeader.indexOf('${providerQuotaStack}')).toBeLessThan(providerHeader.indexOf('<span class="success-count'));
    });

    test('usage details prefer backend-provided display values for token units', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');
        const renderStart = source.indexOf('function renderUsageDetails(usage, accountSummary = null, instance = {}) {');
        expect(renderStart).toBeGreaterThanOrEqual(0);

        const renderEnd = source.indexOf('function getProviderDisplayName', renderStart);
        expect(renderEnd).toBeGreaterThan(renderStart);

        const renderBlock = source.slice(renderStart, renderEnd);
        expect(renderBlock).toContain('item.displayValue');
    });

    test('Codex usage details render semantic summary labels and no progress bar for telemetry', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');
        const renderStart = source.indexOf('function renderUsageDetails(usage, accountSummary = null, instance = {}) {');
        const renderEnd = source.indexOf('function getProviderDisplayName', renderStart);
        const renderBlock = source.slice(renderStart, renderEnd);

        expect(renderBlock).toContain("summary.label || t('usage.card.quotaOverview')");
        expect(renderBlock).toContain("item.category === 'telemetry'");
        expect(renderBlock).toContain('item.available === false');
        expect(renderBlock).toContain("t('usage.card.dataDelayed')");
    });

    test('quota detail section uses concise usage wording', () => {
        const i18n = fs.readFileSync(path.join(process.cwd(), 'static/app/i18n.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(i18n).toContain("'usage.card.quotaDetails': '额度使用'");
        expect(i18n).toContain("'usage.card.quotaDetails': 'Quota Usage'");
    });

    test('Token telemetry consolidates matching local update hours and shows outlier differences', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');
        const i18n = fs.readFileSync(path.join(process.cwd(), 'static/app/i18n.js'), 'utf8').replace(/\r\n/g, '\n');
        const css = fs.readFileSync(path.join(process.cwd(), 'static/components/section-usage.css'), 'utf8').replace(/\r\n/g, '\n');
        const renderStart = source.indexOf('function renderUsageDetails(usage, accountSummary = null, instance = {}) {');
        const renderEnd = source.indexOf('function getProviderDisplayName', renderStart);
        const renderBlock = source.slice(renderStart, renderEnd);

        expect(source).toContain("timeZone: 'Asia/Shanghai'");
        expect(source).toContain('function formatUsageUpdatedHour(value)');
        expect(source).toContain('function formatTelemetryUpdateDifference(updatedAt, commonUpdatedAt)');
        expect(source).toContain('function getTelemetryCommonUpdatedAt(items, toleranceMs = 5 * 60 * 1000)');
        expect(renderBlock).toContain('const telemetryCommonUpdatedAt = getTelemetryCommonUpdatedAt(telemetryItems);');
        expect(renderBlock).toContain('usage-breakdown-title-meta');
        expect(renderBlock).toContain('isTelemetryUpdateOutlier(item.updatedAt, commonUpdatedAt)');
        expect(renderBlock).toContain("t('usage.card.updatedAtMismatch'");
        expect(renderBlock).toContain("difference: formatTelemetryUpdateDifference(item.updatedAt, commonUpdatedAt)");
        expect(renderBlock).toContain("t('usage.card.dataDelayedBy', { difference: formatTelemetryDataDelay(item.delayDays) })");
        expect(i18n).toContain("'usage.card.tokenTelemetry': '官方统计'");
        expect(i18n).toContain("'usage.card.dataDelayedBy': '数据延迟 {difference}'");
        expect(source).not.toContain('(Beijing time)');
        expect(source).not.toContain('（北京时间）');
        expect(css).toContain('.usage-breakdown-title-meta');
        expect(css).toContain('.telemetry-update-outlier');
    });

    test('account usage summaries index only provider UUIDs with one unambiguous owner', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('addIndex(account.accountKey, account)');
        expect(source).toContain('[account.providerUuid, account.accountIdentity, ...(account.providerUuids || [])]');
        expect(source).toContain('const providerUuidOwners = new Map()');
        expect(source).toContain('if (owners?.size === 1)');
        expect(source).toContain('instance.codexAccountKey');
        expect(source).not.toContain('account-usage-identity');
    });

    test('account usage summary shows recent request only when available', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('accountSummary.lastUsedAt || accountSummary.today?.lastUsedAt');
        expect(source).toContain('account-usage-last-used');
        expect(source).toContain('最近请求 ${formatDate(lastUsedAt)}');
        expect(source).not.toContain('本地统计源');
        expect(source).not.toContain('真实使用');
        expect(source).not.toContain('tokens / requests');
        expect(source).not.toContain('官方未返回重置时间');
    });

    test('Antigravity quota details do not render internal quota relation labels', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).not.toContain('quotaRelationText');
        expect(source).not.toContain('官方额度桶');
        expect(source).not.toContain('共享模型额度观测');
        expect(source).not.toContain('模型额度观测');
    });

    test('account usage summary renders estimated weekly quota below the recent request', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');
        const css = fs.readFileSync(path.join(process.cwd(), 'static/components/section-usage.css'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('renderEstimatedWeeklyQuota(accountSummary, instance)');
        expect(source).toContain('account-usage-estimated-weekly');
        expect(source).toContain('预估月额度');
        expect(source).toContain('account-usage-recent-request-row');
        expect(source).toContain('account-usage-estimated-weekly-row');
        expect(css).toContain('.account-usage-recent-request-row');
        expect(css).toContain('.account-usage-estimated-weekly-row');
    });

    test('weekly and monthly quota estimates use two full-width rows', () => {
        const css = fs.readFileSync(path.join(process.cwd(), 'static/components/section-usage.css'), 'utf8').replace(/\r\n/g, '\n');

        expect(css).toMatch(/\.account-usage-estimated-weekly-row\s*\{[^}]*flex-direction:\s*column;/s);
        expect(css).toMatch(/\.account-usage-estimated-weekly-row\s*\{[^}]*gap:\s*0\.375rem;/s);
        expect(css).toMatch(/\.account-usage-estimated-weekly\s*\{[^}]*width:\s*100%;/s);
        expect(css).toMatch(/\.account-usage-estimated-weekly strong\s*\{[^}]*margin-left:\s*auto;/s);
    });

    test('current-period estimate explains its low-confidence source', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('当前周期低置信度估算');
        expect(source).toContain('本地金额');
    });

    test('exhausted weekly quota renders a determined amount or exhausted state instead of sampling', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain("estimate.status === 'exhausted'");
        expect(source).toContain('本周期已用完，额度已确定');
        expect(source).toContain('已用完（100%）');
        expect(source).toContain("estimate.method === 'exhausted-period-total'");
    });

    test('account usage summary keeps an estimate row visible while sampling', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('<div class="account-usage-estimated-weekly-row">${renderEstimatedWeeklyQuota(accountSummary, instance)}</div>');
        expect(source).toContain('当前周期金额或官方额度不足，继续采样中');
    });

    test('account usage summary renders total cost without pricing estimate badges', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('function renderAccountUsageCost(usage = {})');
        expect(source).toContain('account-usage-period-cost');
        expect(source).toContain('cost.usd ?? (Number(cost.actualUsd || 0) + Number(cost.estimatedUsd || 0))');
        expect(source).not.toContain('estimatedPriceTokens > 0');
        expect(source).not.toContain('均价估算');
        expect(source).not.toContain('missingPriceTokens > 0');
        expect(source).not.toContain('account-usage-cost-missing');
        expect(source).toContain('${renderAccountUsageCost(usage)}');
    });

    test('three-column account usage cards keep long dollar amounts inside the card', () => {
        const css = fs.readFileSync(path.join(process.cwd(), 'static/components/section-usage.css'), 'utf8').replace(/\r\n/g, '\n');

        expect(css).toContain('.account-usage-period-cost > span');
        expect(css).toContain('overflow-wrap: anywhere');
        expect(css).toContain('max-width: 100%');
    });

    test('account usage summary labels use rolling week and month wording', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain("renderAccountUsagePeriod('近1周', accountSummary.week)");
        expect(source).toContain("renderAccountUsagePeriod('近1月', accountSummary.month)");
        expect(source).not.toContain("renderAccountUsagePeriod('本周', accountSummary.week)");
        expect(source).not.toContain("renderAccountUsagePeriod('本月', accountSummary.month)");
    });

    test('account usage summary keeps coverage metadata without rendering a partial history notice', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('coverage: summary.coverage || null');
        expect(source).not.toContain('function renderAccountUsageCoverageNotice(accountUsageSummaryMeta)');
        expect(source).not.toContain('account-usage-coverage-notice');
        expect(source).not.toContain('部分历史未归属到账号');
        expect(source).not.toContain('${renderAccountUsageCoverageNotice(accountUsageSummaryMeta)}');
    });

    test('Codex usage cards render general quota health badges without Spark 5.3', () => {
        const usageApiSource = fs.readFileSync(path.join(process.cwd(), 'src/ui-modules/usage-api.js'), 'utf8').replace(/\r\n/g, '\n');
        const usageManagerSource = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(usageApiSource).toContain('codexQuotaHealth: provider.codexQuotaHealth || null');
        expect(usageApiSource).toContain('deriveCodexQuotaHealthFromUsage(instanceResult.codexQuotaHealth, usage)');
        expect(usageManagerSource).toContain('function renderCodexQuotaHealthBadges(instance, providerType)');
        expect(usageManagerSource).toContain("renderBadge('通用', quotaHealth.general)");
        expect(usageManagerSource).not.toContain("renderBadge('5.3', quotaHealth.codex53)");
        expect(usageApiSource).toContain('delete quotaHealth.codex53');
        expect(usageApiSource).not.toContain('codex53UsedPercent');
        expect(usageManagerSource).not.toContain("renderBadge('通用额度'");
        expect(usageManagerSource).not.toContain("renderBadge('5.3额度'");
        expect(usageManagerSource).toContain('renderCodexQuotaHealthBadges(instance, providerType)');
    });

    test('Codex collapsed header renders base and general status icons separately', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('function getBaseStatusState(instance)');
        expect(source).toContain('function renderCollapsedStatusIcons(instance, providerType)');
        expect(source).toContain("renderStatusIcon('基础状态', getBaseStatusState(instance))");
        expect(source).toContain("renderStatusIcon('通用额度', getQuotaStatusState(instance.codexQuotaHealth?.general))");
        expect(source).not.toContain("renderStatusIcon('5.3额度', getQuotaStatusState(instance.codexQuotaHealth?.codex53))");
        expect(source).toContain('${renderCollapsedStatusIcons(instance, providerType)}');
        expect(source).not.toContain("${instance.success ? '<i class=\"fas fa-check-circle status-success\"></i>' : '<i class=\"fas fa-times-circle status-error\"></i>'}");
    });

    test('Codex quota badges use the earlier healthy/restricted rule and keep unknown distinct', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain("state?.applicability === 'unknown'");
        expect(source).toContain("label: isHealthy ? '正常' : '受限'");
        expect(source).toContain('badge-unhealthy');
        expect(source).not.toContain("if (state.applicability === 'not_applicable')");
        expect(source).not.toContain("if (state?.applicability === 'not_applicable')");
        expect(source).not.toContain('fa-minus-circle status-neutral');
        expect(source).not.toContain('badge-neutral');
        expect(source).not.toContain('label}：不适用');

        const functionSource = source.match(/function getQuotaStatusState\(state = \{\}\) \{[\s\S]*?\n\}/)?.[0];
        expect(functionSource).toBeTruthy();
        const getQuotaStatusState = new Function('t', 'formatDate', `${functionSource}; return getQuotaStatusState;`)(key => key, value => value);
        expect(getQuotaStatusState({ applicability: 'not_applicable', isHealthy: true })).toMatchObject({
            isHealthy: true,
            label: '正常'
        });
        expect(getQuotaStatusState({ applicability: 'not_applicable', isHealthy: false })).toMatchObject({
            isHealthy: false,
            label: '受限'
        });
    });

    test('base status follows scheduler health instead of usage refresh outcome', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');
        const functionSource = source.match(/function getBaseStatusState\(instance\) \{[\s\S]*?\n\}/)?.[0];
        expect(functionSource).toBeTruthy();
        const getBaseStatusState = new Function('t', `${functionSource}; return getBaseStatusState;`)(key => key);

        expect(getBaseStatusState({ isHealthy: false, success: true })).toMatchObject({
            isHealthy: false,
            label: 'usage.card.status.unhealthy'
        });
        expect(getBaseStatusState({ isHealthy: true, success: false, lastRefreshError: 'usage refresh failed' })).toMatchObject({
            isHealthy: true,
            label: 'usage.card.status.healthy'
        });
    });

    test('Codex expanded base status badge is independent from quota bucket state', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('function renderBaseStatusBadge(instance)');
        expect(source).toContain('const baseStatus = getBaseStatusState(instance)');
        expect(source).toContain('${renderBaseStatusBadge(instance)}');
        expect(source).not.toContain('${instance.isDisabled ? `<span class="badge badge-disabled">${t(\'usage.card.status.disabled\')}</span>`');
    });

    test('provider selection filters base health before Codex quota bucket health', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/providers/provider-pool-manager.js'), 'utf8').replace(/\r\n/g, '\n');
        const baseFilterIndex = source.indexOf('let availableAndHealthyProviders = availableProviders.filter(p =>\n            p.config.isHealthy && !p.config.isDisabled && !p.config.needsRefresh');
        const codexFilterIndex = source.search(/availableAndHealthyProviders = this\._filterCodexProvidersByTokenQuota\(providerType, availableAndHealthyProviders, requestedModel(?:, selectionDiagnostics)?\);/);

        expect(baseFilterIndex).toBeGreaterThanOrEqual(0);
        expect(codexFilterIndex).toBeGreaterThan(baseFilterIndex);
    });

    test('usage refresh failures keep last successful cached data visible', () => {
        const usageApiSource = fs.readFileSync(path.join(process.cwd(), 'src/ui-modules/usage-api.js'), 'utf8').replace(/\r\n/g, '\n');
        const usageManagerSource = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');
        const usageCacheSource = fs.readFileSync(path.join(process.cwd(), 'src/ui-modules/usage-cache.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(usageApiSource).toContain('mergeUsageResultsWithLastSuccessfulCache');
        expect(usageApiSource).toContain('lastRefreshError');
        expect(usageApiSource).toContain('refreshErrors');
        expect(usageApiSource).toContain('readUsageCache({ maxAgeMs: null, allowStale: true })');
        expect(usageCacheSource).toContain('mergeUsageDataWithExistingLastSuccessfulUsage');
        expect(usageCacheSource).toContain('lastRefreshError: incomingInstance.error');
        expect(usageCacheSource).toContain('subscriptionExpired: true');
        expect(usageApiSource).toContain('isPaidPlanDowngrade');
        expect(usageManagerSource).toContain('const hasVisibleUsage = Boolean(instance.usage);');
        expect(usageManagerSource).toContain('contentArea.appendChild(renderUsageDetails(instance.usage, accountUsageSummary, instance));');
        expect(usageManagerSource).toContain('renderUsageRefreshWarning(instance)');
        expect(usageManagerSource).toContain('Pro 订阅已过期，正在显示最后一次成功数据');
        expect(usageManagerSource).toContain('instance.staleUsage || instance.subscriptionExpired');
        expect(usageManagerSource).toContain('data.refreshErrors.length === 0');
        expect(usageManagerSource).toContain('showUsageRefreshErrors(data.refreshErrors)');
    });
    test('Codex usage cards prefer backend codexEmail before provider display name', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('const displayName = user.email || instance.codexEmail || instance.name || instance.uuid;');
    });

    test('usage api normalizes legacy CODEX_EMAIL into codexEmail', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/ui-modules/usage-api.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('function getProviderCodexEmail(provider = {})');
        expect(source).toContain('return provider.codexEmail || provider.CODEX_EMAIL || provider.email || null;');
        expect(source).toContain('codexEmail: getProviderCodexEmail(provider)');
    });
    test('cached usage responses are enriched from current provider config metadata', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/ui-modules/usage-api.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('function enrichUsageResultsWithProviderConfig(results, currentConfig, providerPoolManager)');
        expect(source).toContain('function enrichProviderDataWithProviderConfig(providerType, providerData, currentConfig, providerPoolManager)');
        expect(source).toContain('enrichUsageResultsWithProviderConfig(usageResults, currentConfig, providerPoolManager)');
        expect(source).toContain('enrichProviderDataWithProviderConfig(providerType, usageResults, currentConfig, providerPoolManager);');
    });

    test('Codex usage cards show subscription until next to the plan badge and hide empty values', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');
        const i18n = fs.readFileSync(path.join(process.cwd(), 'static/app/i18n.js'), 'utf8').replace(/\r\n/g, '\n');
        const css = fs.readFileSync(path.join(process.cwd(), 'static/components/section-usage.css'), 'utf8').replace(/\r\n/g, '\n');
        const cardStart = source.indexOf('function createInstanceUsageCard(instance, providerType) {');
        const cardEnd = source.indexOf('card.querySelector(\'.usage-card-collapsed-summary\')', cardStart);
        const cardBlock = source.slice(cardStart, cardEnd);

        expect(cardBlock).toContain('${renderCodexSubscriptionUntil(instance)}');
        expect(cardBlock.indexOf('collapsed-plan-badge')).toBeGreaterThanOrEqual(0);
        expect(cardBlock.indexOf('${renderCodexSubscriptionUntil(instance)}')).toBeGreaterThan(cardBlock.indexOf('collapsed-plan-badge'));
        expect(source).toContain("if (!label) return '';");
        expect(source).toContain('function renderCodexSubscriptionUntil(instance = {}, now = Date.now())');
        expect(source.slice(source.indexOf('function renderCodexSubscriptionUntil'))).not.toContain('summary.resetAt');
        expect(i18n).toContain("'usage.card.subscriptionUntilExpired': '{time} · 已到期'");
        expect(i18n).toContain("'usage.card.subscriptionUntilExpired': '{time} · expired'");
        expect(css).toContain('.collapsed-subscription-until');
    });
});
