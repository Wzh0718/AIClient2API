// 用量管理模块

import { showToast, escapeHtml, getBaseProviderConfigs } from './utils.js';
import { getAuthHeaders } from './auth.js';
import { t, getCurrentLanguage } from './i18n.js';

// 提供商配置缓存
let currentProviderConfigs = null;
let usagePageDataPromise = null;
let accountUsageSummaryByKey = new Map();
let accountUsageSummaryMeta = null;
let antigravityRecoveryRefreshTimer = null;
const USAGE_REFRESH_POLL_INTERVAL_MS = 1500;
const USAGE_REFRESH_WAIT_TIMEOUT_MS = 150000;
const ANTIGRAVITY_PROVIDER_TYPE = 'gemini-antigravity';
const ANTIGRAVITY_VISIBLE_MODEL_LIMIT = 3;

function sleepForUsageRefresh(delayMs) {
    return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function fetchUsageSnapshot() {
    const response = await fetch('/api/usage', { method: 'GET', headers: getAuthHeaders() });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `HTTP ${response.status}`);
    }
    return response.json();
}

export async function waitForUsageRefreshCompletion({
    fetchUsage = fetchUsageSnapshot,
    sleep = sleepForUsageRefresh,
    now = () => Date.now(),
    intervalMs = USAGE_REFRESH_POLL_INTERVAL_MS,
    timeoutMs = USAGE_REFRESH_WAIT_TIMEOUT_MS
} = {}) {
    const deadline = now() + timeoutMs;
    let data = null;

    while (true) {
        data = await fetchUsage();
        if (!data?.refreshPending) {
            return { completed: true, data };
        }
        if (now() + intervalMs >= deadline) {
            return { completed: false, data };
        }
        await sleep(intervalMs);
    }
}

export function setUsageRefreshButtonState(button, refreshing) {
    if (!button) return;

    if (refreshing) {
        if (!button.dataset.idleHtml) button.dataset.idleHtml = button.innerHTML;
        button.disabled = true;
        button.innerHTML = `<i class="fas fa-sync-alt fa-spin"></i> <span>${t('usage.refreshing')}</span>`;
        return;
    }

    button.disabled = false;
    if (button.dataset.idleHtml) {
        button.innerHTML = button.dataset.idleHtml;
    }
}

export function buildProviderUsageRefreshUrl(providerType) {
    return `/api/usage/${encodeURIComponent(providerType)}?refresh=true`;
}

export function setProviderUsageRefreshButtonState(button, refreshing) {
    if (!button) return;

    if (refreshing) {
        if (!button.dataset.idleHtml) button.dataset.idleHtml = button.innerHTML;
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.innerHTML = `<i class="fas fa-rotate fa-spin" aria-hidden="true"></i><span class="button-label">${t('usage.refreshing')}</span>`;
        return;
    }

    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.idleHtml) button.innerHTML = button.dataset.idleHtml;
}

/**
 * 更新提供商配置
 * @param {Array} configs - 提供商配置列表
 */
export function updateUsageProviderConfigs(configs) {
    currentProviderConfigs = configs;
}

/**
 * 初始化用量管理功能
 */
export function initUsageManager() {
    // 页面不再暴露全量刷新按钮；refreshUsage 继续导出以兼容已有调用方。
}

/**
 * 加载页面数据
 */
export function loadUsagePageData() {
    if (usagePageDataPromise) {
        return usagePageDataPromise;
    }

    usagePageDataPromise = Promise.all([
        loadUsage(),
        loadSupportedProviders()
    ]).finally(() => {
        usagePageDataPromise = null;
    });

    return usagePageDataPromise;
}

/**
 * 加载支持用量查询的提供商列表
 */
async function loadSupportedProviders() {
    const listEl = document.getElementById('supportedProvidersList');
    if (!listEl) return;

    try {
        const response = await fetch('/api/usage/supported-providers', {
            method: 'GET',
            headers: getAuthHeaders()
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const providers = await response.json();
        
        listEl.innerHTML = '';
        const displayOrder = currentProviderConfigs ? currentProviderConfigs.map(c => c.id) : providers;

        displayOrder.forEach(providerId => {
            if (!providers.includes(providerId)) return;
            if (currentProviderConfigs) {
                const config = currentProviderConfigs.find(c => c.id === providerId);
                if (config && config.visible === false) return;
            }

            const tag = document.createElement('span');
            tag.className = 'provider-tag';
            tag.textContent = getProviderDisplayName(providerId);
            listEl.appendChild(tag);
        });
    } catch (error) {
        console.error('获取支持的提供商列表失败:', error);
        listEl.innerHTML = `<span class="error-text">${t('usage.failedToLoad')}</span>`;
    }
}

/**
 * 加载用量数据
 */
export async function loadUsage() {
    const loadingEl = document.getElementById('usageLoading');
    const errorEl = document.getElementById('usageError');
    const contentEl = document.getElementById('usageContent');

    if (loadingEl) loadingEl.style.display = 'block';
    if (errorEl) errorEl.style.display = 'none';

    try {
        const [response, accountUsageSummary] = await Promise.all([
            fetch('/api/usage', { method: 'GET', headers: getAuthHeaders() }),
            loadAccountUsageSummary()
        ]);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        updateAccountUsageSummaryCache(accountUsageSummary);
        
        if (loadingEl) loadingEl.style.display = 'none';
        renderUsageData(data, contentEl);
        updateTimeInfo(data);
    } catch (error) {
        console.error('获取用量数据失败:', error);
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) {
            errorEl.style.display = 'block';
            document.getElementById('usageErrorMessage').textContent = error.message;
        }
    }
}

/**
 * 刷新全部用量
 */
export async function refreshUsage() {
    const refreshBtn = document.getElementById('refreshUsageBtn');
    setUsageRefreshButtonState(refreshBtn, true);

    try {
        const [response, initialAccountUsageSummary] = await Promise.all([
            fetch('/api/usage?refresh=true', { method: 'GET', headers: getAuthHeaders() }),
            loadAccountUsageSummary()
        ]);
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `HTTP ${response.status}`);
        }
        
        let data = await response.json();
        let accountUsageSummary = initialAccountUsageSummary;

        if (data.refreshPending) {
            showToast(t('common.info'), t('usage.refreshStarted'), 'info');
            const refreshResult = await waitForUsageRefreshCompletion();
            data = refreshResult.data || data;

            if (!refreshResult.completed) {
                updateAccountUsageSummaryCache(accountUsageSummary);
                showUsageRefreshErrors(data.refreshErrors);
                renderUsageData(data, document.getElementById('usageContent'));
                updateTimeInfo(data);
                showToast(t('common.info'), t('usage.refreshStillRunning'), 'info');
                return;
            }

            accountUsageSummary = await loadAccountUsageSummary();
        }

        updateAccountUsageSummaryCache(accountUsageSummary);
        showUsageRefreshErrors(data.refreshErrors);
        
        // 渲染数据
        renderUsageData(data, document.getElementById('usageContent'));
        updateTimeInfo(data);
        
        // 成功提示
        if (!Array.isArray(data.refreshErrors) || data.refreshErrors.length === 0) {
            showToast(t('common.success'), t('common.refresh.success'), 'success', 6000);
        }
    } catch (error) {
        console.error('刷新用量失败:', error);
        showToast(t('common.error'), error.message || t('common.requestFailed'), 'error');
    } finally {
        setUsageRefreshButtonState(refreshBtn, false);
    }
}

/**
 * 刷新单个实例
 */
export async function refreshSingleInstanceUsage(providerType, uuid, displayName) {
    try {
        showToast(t('usage.refreshingInstance', { name: displayName }), 'info');
        const response = await fetch(`/api/usage/${providerType}/${uuid}?refresh=true`, { 
            method: 'GET', 
            headers: getAuthHeaders() 
        });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `HTTP ${response.status}`);
        }
        
        const data = await response.json();
        showUsageRefreshErrors(data.refreshErrors);
        
        // 局部更新该实例的卡片
        if (data && data.uuid) {
            updateSingleInstanceCard(providerType, data);
            showToast(t('common.refresh.success'), 'success');
        } else {
            await loadUsage();
        }
    } catch (error) {
        console.error('刷新单个实例用量失败:', error);
        showToast(error.message || t('common.requestFailed'), 'error');
    }
}

async function resetSingleInstanceUsage(providerType, uuid, displayName, buttonEl) {
    const confirmed = window.confirm(t('usage.codex.resetConfirm', { name: displayName }));
    if (!confirmed) {
        return;
    }

    const originalDisabled = buttonEl?.disabled;
    if (buttonEl) {
        buttonEl.disabled = true;
    }

    try {
        showToast(t('common.info'), t('usage.codex.resetting', { name: displayName }), 'info');

        const response = await fetch(`/api/usage/${providerType}/${uuid}/reset`, {
            method: 'POST',
            headers: getAuthHeaders()
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        if (data?.instance?.uuid) {
            updateSingleInstanceCard(providerType, data.instance);
        } else {
            await refreshSingleInstanceUsage(providerType, uuid, displayName);
        }

        showToast(t('common.success'), t('usage.codex.resetSuccess'), 'success');
    } catch (error) {
        console.error('重置单个实例用量失败:', error);
        showToast(t('common.error'), error.message || t('common.requestFailed'), 'error');
    } finally {
        if (buttonEl) {
            buttonEl.disabled = originalDisabled || false;
        }
    }
}

/**
 * 更新单个实例卡片 (局部更新 DOM)
 */
function updateSingleInstanceCard(providerType, instanceData) {
    const container = document.getElementById('usageContent');
    if (!container) return;

    const group = container.querySelector(`.usage-provider-group[data-provider="${providerType}"]`);
    if (!group) return;

    const grid = group.querySelector('.usage-cards-grid');
    if (!grid) return;

    // 找到该实例的卡片。卡片本身没有 data-uuid 属性，我们需要通过内部的 span 查找或添加它
    // 在 createInstanceUsageCard 中，我们可以为卡片添加 data-uuid
    const cards = grid.querySelectorAll('.usage-instance-card');
    let targetCard = null;
    
    for (const card of cards) {
        if (card.getAttribute('data-uuid') === instanceData.uuid) {
            targetCard = card;
            break;
        }
    }

    if (targetCard) {
        const isCollapsed = targetCard.classList.contains('collapsed');
        const newCard = createInstanceUsageCard(instanceData, providerType);
        newCard.classList.toggle('collapsed', isCollapsed);
        grid.replaceChild(newCard, targetCard);
    }
}

/**
 * 刷新单个提供商
 */
export async function refreshProviderUsage(providerType, refreshButton = null) {
    setProviderUsageRefreshButtonState(refreshButton, true);
    try {
        showToast(t('usage.refreshingProvider', { name: getProviderDisplayName(providerType) }), 'info');
        const [response, accountUsageSummary] = await Promise.all([
            fetch(buildProviderUsageRefreshUrl(providerType), { method: 'GET', headers: getAuthHeaders() }),
            loadAccountUsageSummary()
        ]);
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `HTTP ${response.status}`);
        }
        const data = await response.json();
        updateAccountUsageSummaryCache(accountUsageSummary);
        showUsageRefreshErrors(data.refreshErrors);
        
        const providerData = data.providers?.[providerType]
            || (Array.isArray(data.instances) ? data : null);
        if (providerData) {
            updateSingleProviderGroup(providerType, providerData);
            updateTimeInfo(data);
        } else {
            await loadUsage();
        }
        
        if (!Array.isArray(data.refreshErrors) || data.refreshErrors.length === 0) {
            showToast(t('common.refresh.success'), 'success');
        }
    } catch (error) {
        console.error('刷新提供商用量失败:', error);
        showToast(error.message || t('common.requestFailed'), 'error');
    } finally {
        setProviderUsageRefreshButtonState(refreshButton, false);
    }
}

function getCodexResetAvailableCount(rateLimitResetCredits) {
    const availableCount = Number(rateLimitResetCredits?.availableCount ?? 0);
    return Number.isFinite(availableCount) ? availableCount : 0;
}

function formatCodexResetCreditsTooltip(rateLimitResetCredits) {
    const availableCount = getCodexResetAvailableCount(rateLimitResetCredits);
    const credits = Array.isArray(rateLimitResetCredits?.credits)
        ? rateLimitResetCredits.credits
        : [];

    if (credits.length === 0) {
        return `${availableCount} available\nNo expiration details`;
    }

    return credits.map((credit, index) => {
        const status = credit?.status || '--';
        const title = credit?.title || '--';
        const grantedAt = credit?.grantedAt ? formatDate(credit.grantedAt) : '--';
        const expiresAt = credit?.expiresAt ? formatDate(credit.expiresAt) : '--';
        return [
            `Credit ${index + 1}`,
            `Status: ${status}`,
            `Title: ${title}`,
            `Granted: ${grantedAt}`,
            `Expires: ${expiresAt}`
        ].join('\n');
    }).join('\n\n');
}

function showUsageRefreshErrors(refreshErrors = []) {
    if (!Array.isArray(refreshErrors) || refreshErrors.length === 0) return;

    const firstError = refreshErrors[0];
    const label = firstError?.name || firstError?.uuid || firstError?.providerType || '用量刷新';
    const suffix = refreshErrors.length > 1 ? `，另有 ${refreshErrors.length - 1} 个异常` : '';
    showToast(t('common.error'), `${label}: ${firstError?.error || t('common.requestFailed')}${suffix}`, 'error');
}

async function loadAccountUsageSummary() {
    try {
        const response = await fetch('/api/potluck/account-usage-summary', {
            method: 'GET',
            headers: getAuthHeaders()
        });
        if (!response.ok) return null;
        const result = await response.json();
        return result?.success ? result.data : null;
    } catch (error) {
        console.debug('Potluck account usage summary unavailable:', error?.message || error);
        return null;
    }
}

function getAccountUsageKey(providerType, uuid) {
    if (!providerType || !uuid) return null;
    return `${providerType}:${uuid}`;
}

function updateAccountUsageSummaryCache(summary) {
    if (!summary?.accounts) return;
    const next = new Map();
    const providerUuidOwners = new Map();
    const addIndex = (key, account) => {
        if (key && !next.has(key)) next.set(key, account);
    };
    const recordProviderUuidOwner = (account, uuid) => {
        const key = getAccountUsageKey(account.provider, uuid);
        if (!key) return;
        const owners = providerUuidOwners.get(key) || new Set();
        owners.add(account.accountKey);
        providerUuidOwners.set(key, owners);
    };
    summary.accounts.forEach(account => {
        recordProviderUuidOwner(account, account.providerUuid);
        recordProviderUuidOwner(account, account.accountIdentity);
        (account.providerUuids || []).forEach(uuid => recordProviderUuidOwner(account, uuid));
    });
    summary.accounts.forEach(account => {
        addIndex(account.accountKey, account);
        [account.providerUuid, account.accountIdentity, ...(account.providerUuids || [])].forEach(uuid => {
            const key = getAccountUsageKey(account.provider, uuid);
            const owners = key ? providerUuidOwners.get(key) : null;
            if (owners?.size === 1) addIndex(key, account);
        });
    });
    accountUsageSummaryByKey = next;
    accountUsageSummaryMeta = {
        source: summary.source || 'potluck/model-usage-stats',
        timezone: summary.timezone || 'Asia/Shanghai',
        updatedAt: summary.updatedAt || null,
        coverage: summary.coverage || null
    };
}

function getAccountUsageSummary(providerType, instance = {}) {
    const candidates = [
        instance.codexAccountKey,
        instance.codexAccountId,
        instance.uuid
    ].filter(Boolean);
    for (const candidate of candidates) {
        const key = getAccountUsageKey(providerType, candidate);
        const summary = key ? accountUsageSummaryByKey.get(key) : null;
        if (summary) return summary;
    }
    return null;
}

function canUseCodexRateLimitReset(rateLimitResetCredits) {
    return Boolean(rateLimitResetCredits && (rateLimitResetCredits.canReset || getCodexResetAvailableCount(rateLimitResetCredits) > 0));
}

function getBaseStatusState(instance) {
    if (instance.isDisabled) {
        return {
            isHealthy: false,
            label: t('usage.card.status.disabled'),
            title: t('usage.card.status.disabled')
        };
    }

    const isHealthy = instance.isHealthy !== false;
    return {
        isHealthy,
        label: t(isHealthy ? 'usage.card.status.healthy' : 'usage.card.status.unhealthy'),
        title: instance.lastErrorMessage
            || t(isHealthy ? 'usage.card.status.healthy' : 'usage.card.status.unhealthy')
    };
}

function getQuotaStatusState(state = {}) {
    if (state?.applicability === 'unknown') {
        return {
            status: 'unknown',
            isHealthy: true,
            label: t('usage.card.status.unknown'),
            title: state.lastErrorMessage || t('usage.card.status.unknown')
        };
    }
    const isHealthy = state?.isHealthy !== false;
    const titleParts = [];
    if (state?.lastErrorMessage) titleParts.push(state.lastErrorMessage);
    if (state?.scheduledRecoveryTime) titleParts.push(`恢复时间: ${formatDate(state.scheduledRecoveryTime)}`);
    return {
        isHealthy,
        label: isHealthy ? '正常' : '受限',
        title: titleParts.join('；') || (isHealthy ? '正常' : '受限')
    };
}

function renderStatusIcon(label, state) {
    const iconClass = state.status === 'unknown'
        ? 'fa-question-circle status-warning'
        : state.isHealthy
        ? 'fa-check-circle status-success'
        : 'fa-times-circle status-error';
    const title = `${label}：${state.label}${state.title && state.title !== state.label ? `；${state.title}` : ''}`;
    return `<i class="fas ${iconClass}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"></i>`;
}

function renderCollapsedStatusIcons(instance, providerType) {
    const icons = [
        renderStatusIcon('基础状态', getBaseStatusState(instance))
    ];

    if (instance.staleUsage || instance.subscriptionExpired) {
        const title = instance.subscriptionExpired
            ? 'Pro 订阅已过期，当前显示最后一次成功数据'
            : `刷新异常，当前显示最后一次成功数据${instance.lastRefreshError ? `：${instance.lastRefreshError}` : ''}`;
        icons.push(`<i class="fas fa-exclamation-triangle status-warning" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"></i>`);
    }

    if (providerType === 'openai-codex-oauth') {
        icons.push(
            renderStatusIcon('通用额度', getQuotaStatusState(instance.codexQuotaHealth?.general))
        );
    }
    if (providerType === 'gemini-antigravity') {
        icons.push(renderStatusIcon('Gemini额度', getQuotaStatusState(instance.antigravityQuotaHealth?.families?.gemini)));
    }

    return icons.join('');
}

function renderBaseStatusBadge(instance) {
    const baseStatus = getBaseStatusState(instance);
    return `<span class="badge ${baseStatus.isHealthy ? 'badge-healthy' : 'badge-unhealthy'}" title="${escapeHtml(baseStatus.title || baseStatus.label)}">${escapeHtml(baseStatus.label)}</span>`;
}

function renderCodexQuotaHealthBadges(instance, providerType) {
    if (providerType !== 'openai-codex-oauth') return '';

    const quotaHealth = instance.codexQuotaHealth || {};
    const renderBadge = (label, state = {}) => {
        if (state.applicability === 'unknown') {
            return `<span class="badge badge-warning" title="${escapeHtml(state.lastErrorMessage || '上游未提供')}">${label}：未知</span>`;
        }
        const isHealthy = state.isHealthy !== false;
        const titleParts = [];
        if (state.lastErrorMessage) titleParts.push(state.lastErrorMessage);
        if (state.scheduledRecoveryTime) titleParts.push(`恢复时间: ${formatDate(state.scheduledRecoveryTime)}`);
        const title = titleParts.length > 0 ? ` title="${escapeHtml(titleParts.join('；'))}"` : '';
        return `<span class="badge ${isHealthy ? 'badge-healthy' : 'badge-unhealthy'}"${title}>${label}：${isHealthy ? '正常' : '受限'}</span>`;
    };

    return [
        renderBadge('通用', quotaHealth.general)
    ].join('');
}

function renderAntigravityQuotaHealthBadges(instance, providerType) {
    if (providerType !== ANTIGRAVITY_PROVIDER_TYPE) return '';

    const quotaHealth = instance.antigravityQuotaHealth || {};
    // 模型级冷却明细仍由实例详情/Provider 摘要 tooltip 消费，Provider 头部不再常驻展示大徽标。
    // 既有模型状态数据结构（Object.entries(quotaHealth.models || {})）保持兼容。
    const renderBadge = (label, state = {}) => {
        const isHealthy = state?.isHealthy !== false;
        const titleParts = [];
        if (state?.lastErrorMessage) titleParts.push(state.lastErrorMessage);
        if (state?.scheduledRecoveryTime) titleParts.push(`恢复时间: ${formatDate(state.scheduledRecoveryTime)}`);
        const title = titleParts.length > 0 ? ` title="${escapeHtml(titleParts.join('；'))}"` : '';
        return `<span class="badge ${isHealthy ? 'badge-healthy' : 'badge-unhealthy'}"${title}>${label}：${isHealthy ? '正常' : '受限'}</span>`;
    };
    return renderBadge('Gemini', quotaHealth.families?.gemini);
}

function renderAntigravityProviderQuotaStack(instances, providerType) {
    if (providerType !== ANTIGRAVITY_PROVIDER_TYPE) return '';

    return renderAntigravityModelAvailabilitySummary(instances, providerType);
}

function getAntigravityRecoveryTimestamp(value) {
    const timestamp = Date.parse(value || '');
    return Number.isFinite(timestamp) ? timestamp : null;
}

function sortAntigravityUnavailableModels(models) {
    return [...models].sort((left, right) => {
        const leftRecovery = getAntigravityRecoveryTimestamp(left.scheduledRecoveryTime);
        const rightRecovery = getAntigravityRecoveryTimestamp(right.scheduledRecoveryTime);
        if (leftRecovery !== null && rightRecovery !== null && leftRecovery !== rightRecovery) {
            return leftRecovery - rightRecovery;
        }
        if (leftRecovery !== null) return -1;
        if (rightRecovery !== null) return 1;
        return left.model.localeCompare(right.model);
    });
}

export function getAntigravityUnavailableModels(instance, providerType) {
    if (providerType !== ANTIGRAVITY_PROVIDER_TYPE) return [];

    const now = Date.now();
    const models = Object.entries(instance.antigravityQuotaHealth?.models || {})
        .filter(([, state]) => state?.isHealthy === false && (
            !state?.scheduledRecoveryTime
            || Date.parse(state.scheduledRecoveryTime) > now
        ))
        .map(([model, state]) => ({
            model,
            scheduledRecoveryTime: state.scheduledRecoveryTime || null,
            lastErrorMessage: state.lastErrorMessage || null
        }));

    return sortAntigravityUnavailableModels(models);
}

export function getAntigravityPoolUnavailableModels(providerType, instances) {
    if (providerType !== ANTIGRAVITY_PROVIDER_TYPE || !Array.isArray(instances) || instances.length === 0) {
        return [];
    }

    const eligibleInstances = instances.filter(instance => (
        !instance?.isDisabled
        && !instance?.needsRefresh
        && instance?.isHealthy !== false
        && !instance?.error?.includes('not initialized')
    ));
    if (eligibleInstances.length === 0) return [];

    const now = Date.now();
    const candidateModels = new Set();
    eligibleInstances.forEach(instance => {
        Object.entries(instance.antigravityQuotaHealth?.models || {}).forEach(([model, state]) => {
            if (state?.isHealthy === false && (!state?.scheduledRecoveryTime || Date.parse(state.scheduledRecoveryTime) > now)) candidateModels.add(model);
        });
    });

    const unavailableModels = [];
    candidateModels.forEach(model => {
        const states = eligibleInstances.map(instance => instance.antigravityQuotaHealth?.models?.[model]);
        if (!states.every(state => state?.isHealthy === false && (!state?.scheduledRecoveryTime || Date.parse(state.scheduledRecoveryTime) > now))) return;

        const earliestRecovery = states
            .map(state => ({
                value: state.scheduledRecoveryTime || null,
                timestamp: getAntigravityRecoveryTimestamp(state.scheduledRecoveryTime)
            }))
            .filter(item => item.timestamp !== null)
            .sort((left, right) => left.timestamp - right.timestamp)[0];
        unavailableModels.push({
            model,
            scheduledRecoveryTime: earliestRecovery?.value || null
        });
    });

    return sortAntigravityUnavailableModels(unavailableModels);
}

export function getAntigravityModelAvailabilitySummaries(providerType, instances) {
    if (providerType !== ANTIGRAVITY_PROVIDER_TYPE || !Array.isArray(instances) || instances.length === 0) {
        return [];
    }

    const now = Date.now();
    const activeInstances = instances.filter(instance => !instance?.error?.includes('not initialized'));
    if (activeInstances.length === 0) return [];

    // Only summarize models that have an explicit per-credential state. Static
    // model catalogs must not create availability rows before a real request
    // has probed that model.
    const models = new Set();
    activeInstances.forEach(instance => Object.keys(instance.antigravityQuotaHealth?.models || {})
        .filter(model => model.toLowerCase().startsWith('gemini-'))
        .forEach(model => models.add(model)));

    return [...models].map(model => {
        let availableCount = 0;
        let quotaExhaustedCount = 0;
        let credentialUnavailableCount = 0;
        let unprobedCount = 0;
        const recoveryTimes = [];

        activeInstances.forEach(instance => {
            const credentialUnavailable = instance.isDisabled === true
                || instance.needsRefresh === true
                || instance.isHealthy === false
                || Boolean(instance.error);
            const modelState = instance.antigravityQuotaHealth?.models?.[model];
            if (!modelState) {
                if (instance.needsRefresh === true) {
                    credentialUnavailableCount++;
                    return;
                }
                unprobedCount++;
                return;
            }
            if (credentialUnavailable) {
                credentialUnavailableCount++;
                return;
            }
            if (modelState.isHealthy === true || (modelState.scheduledRecoveryTime && Date.parse(modelState.scheduledRecoveryTime) <= now)) {
                availableCount++;
                return;
            }
            const reason = `${modelState.source || ''} ${modelState.lastErrorMessage || ''}`.toLowerCase();
            const isQuotaExhausted = modelState.isHealthy === false && (
                modelState.source === 'upstream_429'
                || Boolean(modelState.scheduledRecoveryTime)
                || /quota|cooldown|rate[ -]?limit|429|exhausted|too many requests/.test(reason)
            );
            if (isQuotaExhausted) {
                quotaExhaustedCount++;
                if (modelState.scheduledRecoveryTime) recoveryTimes.push(modelState.scheduledRecoveryTime);
            } else {
                credentialUnavailableCount++;
            }
        });

        const earliestRecoveryTime = recoveryTimes
            .map(value => ({ value, timestamp: getAntigravityRecoveryTimestamp(value) }))
            .filter(item => item.timestamp !== null)
            .sort((left, right) => left.timestamp - right.timestamp)[0]?.value || null;

        return { model, availableCount, quotaExhaustedCount, credentialUnavailableCount, unprobedCount, earliestRecoveryTime };
    })
        .filter(summary => summary.quotaExhaustedCount > 0 || summary.credentialUnavailableCount > 0)
        .sort((left, right) => left.model.localeCompare(right.model));
}

function renderAntigravityModelAvailabilitySummary(instances, providerType) {
    if (providerType !== ANTIGRAVITY_PROVIDER_TYPE) return '';
    const summaries = getAntigravityModelAvailabilitySummaries(providerType, instances);
    if (summaries.length === 0) return '';
    const renderCount = (symbol, label, count, className) => count > 0
        ? `<span class="antigravity-model-availability-count ${className}" aria-label="${label} ${count} 个凭据" title="${label}：${count} 个凭据">${symbol}${count}</span>`
        : '';
    const rows = summaries.map(summary => {
        const details = [
            t('usage.antigravity.availability.available', { count: summary.availableCount }),
            t('usage.antigravity.availability.quotaExhausted', { count: summary.quotaExhaustedCount }),
            t('usage.antigravity.availability.credentialUnavailable', { count: summary.credentialUnavailableCount }),
            t('usage.antigravity.availability.unprobed', { count: summary.unprobedCount })
        ];
        if (summary.earliestRecoveryTime) details.push(t('usage.antigravity.availability.recoveryAt', { time: formatDate(summary.earliestRecoveryTime) }));
        return `<div class="antigravity-model-availability-row" title="${escapeHtml(details.join('；'))}">
            <code class="antigravity-model-availability-name">${escapeHtml(summary.model)}</code>
            <span class="antigravity-model-availability-counts" aria-label="${escapeHtml(details.join('；'))}">
                ${renderCount('✓', t('usage.antigravity.availability.availableLabel'), summary.availableCount, 'is-available')}
                ${renderCount('⚠', t('usage.antigravity.availability.quotaExhaustedLabel'), summary.quotaExhaustedCount, 'is-quota-exhausted')}
                ${renderCount('✕', t('usage.antigravity.availability.credentialUnavailableLabel'), summary.credentialUnavailableCount, 'is-credential-unavailable')}
            </span>
        </div>`;
    }).join('');
    return `<div class="antigravity-model-availability-summary" aria-label="Gemini 模型可用性摘要">${rows}</div>`;
}

function formatAntigravityCompactRecovery(value) {
    const timestamp = getAntigravityRecoveryTimestamp(value);
    if (timestamp === null) return t('usage.antigravity.recoveryUnknown');

    const date = new Date(timestamp);
    const now = new Date();
    const time = date.toLocaleTimeString(getCurrentLanguage(), {
        hour: '2-digit',
        minute: '2-digit'
    });
    if (date.toDateString() === now.toDateString()) {
        return t('usage.antigravity.recoveryToday', { time });
    }
    return date.toLocaleString(getCurrentLanguage(), {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function renderAntigravityUnavailableModels(instance, providerType) {
    const models = getAntigravityUnavailableModels(instance, providerType);

    if (models.length === 0) return null;

    const section = document.createElement('div');
    section.className = 'usage-section antigravity-unavailable-models';
    const visibleModels = models.slice(0, ANTIGRAVITY_VISIBLE_MODEL_LIMIT);
    const extraModels = models.slice(ANTIGRAVITY_VISIBLE_MODEL_LIMIT);
    const renderRow = (model, isExtra = false) => {
        const recoveryText = formatAntigravityCompactRecovery(model.scheduledRecoveryTime);
        const statusTitle = [
            model.lastErrorMessage,
            model.scheduledRecoveryTime ? t('usage.antigravity.recoveryAt', { time: formatDate(model.scheduledRecoveryTime) }) : null
        ].filter(Boolean).join('；');
        return `<div class="antigravity-model-status-row${isExtra ? ' is-extra' : ''}">
            <span class="antigravity-model-status-dot" aria-hidden="true"></span>
            <code class="antigravity-model-name" title="${escapeHtml(model.model)}">${escapeHtml(model.model)}</code>
            <span class="antigravity-model-status antigravity-model-status-cooldown"${statusTitle ? ` title="${escapeHtml(statusTitle)}"` : ''}>${t('usage.antigravity.status.cooldown')}</span>
            <span class="antigravity-model-recovery" title="${model.scheduledRecoveryTime ? escapeHtml(formatDate(model.scheduledRecoveryTime)) : ''}"><i class="fas fa-clock" aria-hidden="true"></i>${escapeHtml(recoveryText)}</span>
        </div>`;
    };
    const rows = [
        ...visibleModels.map(model => renderRow(model)),
        ...extraModels.map(model => renderRow(model, true))
    ].join('');
    const toggle = extraModels.length > 0
        ? `<button type="button" class="antigravity-model-status-toggle" aria-expanded="false">
            <span>${t('usage.antigravity.moreModels', { count: extraModels.length })}</span>
            <i class="fas fa-chevron-down" aria-hidden="true"></i>
        </button>`
        : '';

    section.innerHTML = `
        <div class="antigravity-unavailable-models-header">
            <span><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> ${t('usage.antigravity.unavailableModels')}</span>
            <span class="antigravity-unavailable-models-count">${models.length}</span>
        </div>
        <div class="antigravity-model-status-list">${rows}</div>
        ${toggle}
    `;
    const toggleButton = section.querySelector('.antigravity-model-status-toggle');
    if (toggleButton) {
        toggleButton.addEventListener('click', () => {
            const expanded = section.classList.toggle('is-expanded');
            toggleButton.setAttribute('aria-expanded', String(expanded));
            toggleButton.querySelector('span').textContent = expanded
                ? t('usage.antigravity.collapseModels')
                : t('usage.antigravity.moreModels', { count: extraModels.length });
            toggleButton.querySelector('i').className = expanded ? 'fas fa-chevron-up' : 'fas fa-chevron-down';
        });
    }
    return section;
}

export function scheduleAntigravityRecoveryRefresh(data, now = Date.now(), schedule = setTimeout) {
    if (antigravityRecoveryRefreshTimer) {
        clearTimeout(antigravityRecoveryRefreshTimer);
        antigravityRecoveryRefreshTimer = null;
    }

    const recoveryTimes = [];
    for (const provider of Object.values(data?.providers || {})) {
        for (const instance of provider?.instances || []) {
            for (const state of Object.values(instance?.antigravityQuotaHealth?.models || {})) {
                const scheduledRecoveryTime = Date.parse(state?.scheduledRecoveryTime || '');
                if (state?.isHealthy === false && Number.isFinite(scheduledRecoveryTime) && scheduledRecoveryTime > now) {
                    recoveryTimes.push(scheduledRecoveryTime);
                }
            }
        }
    }
    if (recoveryTimes.length === 0) return null;

    const delay = Math.max(0, Math.min(...recoveryTimes) - now + 50);
    antigravityRecoveryRefreshTimer = schedule(() => {
        antigravityRecoveryRefreshTimer = null;
        refreshProviderUsage(ANTIGRAVITY_PROVIDER_TYPE).catch(error => {
            console.debug('Antigravity recovery refresh failed:', error?.message || error);
        });
    }, delay);
    if (antigravityRecoveryRefreshTimer?.unref) antigravityRecoveryRefreshTimer.unref();
    return delay;
}

function renderUsageRefreshWarning(instance) {
    if (instance.subscriptionExpired) {
        const warning = document.createElement('div');
        warning.className = 'usage-error-message usage-stale-warning';
        warning.innerHTML = '<i class="fas fa-exclamation-triangle"></i> <span>Pro 订阅已过期，正在显示最后一次成功数据</span>';
        return warning;
    }
    const message = instance.lastRefreshError || instance.error;
    if (!message) return null;

    const warning = document.createElement('div');
    warning.className = 'usage-error-message usage-stale-warning';
    warning.innerHTML = `<i class="fas fa-exclamation-triangle"></i> <span>刷新异常，正在显示最后一次成功数据：${escapeHtml(message)}</span>`;
    return warning;
}

function confirmCodexRateLimitReset(displayName, availableCount) {
    return window.confirm([
        `Use one Codex rate-limit reset for ${displayName}?`,
        `Available resets: ${availableCount}`,
        'This contacts OpenAI and may consume one reset credit.'
    ].join('\n'));
}

async function resetCodexRateLimit(providerType, uuid, displayName, button, availableCount) {
    if (providerType !== 'openai-codex-oauth') return;
    if (availableCount <= 0) {
        showToast(t('common.warning'), 'No Codex rate-limit resets are available', 'warning');
        return;
    }
    if (!confirmCodexRateLimitReset(displayName, availableCount)) return;

    const redeemRequestId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const originalHtml = button?.innerHTML;

    try {
        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        }

        const response = await fetch(`/api/usage/${providerType}/${encodeURIComponent(uuid)}/rate-limit-reset`, {
            method: 'POST',
            headers: {
                ...getAuthHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ redeemRequestId })
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        const code = data.result?.code;
        if (code === 'reset' || code === 'already_redeemed') {
            showToast(t('common.success'), 'Codex usage windows reset', 'success');
            await refreshSingleInstanceUsage(providerType, uuid, displayName);
        } else if (code === 'nothing_to_reset') {
            showToast(t('common.info'), 'Usage does not need a reset right now', 'info');
        } else if (code === 'no_credit') {
            showToast(t('common.warning'), 'No Codex rate-limit resets are available', 'warning');
            await refreshSingleInstanceUsage(providerType, uuid, displayName);
        } else {
            showToast(t('common.info'), `Codex reset returned: ${code || 'unknown'}`, 'info');
            await refreshSingleInstanceUsage(providerType, uuid, displayName);
        }
    } catch (error) {
        console.error('重置 Codex 用量窗口失败:', error);
        showToast(t('common.error'), error.message || t('common.requestFailed'), 'error');
    } finally {
        if (button) {
            button.disabled = false;
            button.innerHTML = originalHtml;
        }
    }
}

/**
 * 更新单个提供商分组 (局部更新 DOM)
 */
function updateSingleProviderGroup(providerType, providerData) {
    const container = document.getElementById('usageContent');
    if (!container) return;

    const existingGroup = container.querySelector(`.usage-provider-group[data-provider="${providerType}"]`);
    const instances = (providerData.instances || []).filter(i => !i.isDisabled && !i.error?.includes('not initialized'));
    
    if (instances.length === 0) {
        if (existingGroup) existingGroup.remove();
        if (container.children.length === 0) {
            renderUsageData({ providers: {} }, container);
        }
        return;
    }

    const newGroup = createProviderGroup(providerType, { ...providerData, instances });
    if (existingGroup) {
        // 保留展开/折叠状态
        if (!existingGroup.classList.contains('collapsed')) {
            newGroup.classList.remove('collapsed');
        }
        container.replaceChild(newGroup, existingGroup);
    } else {
        // 如果原本没有，则按顺序插入或直接追加
        container.appendChild(newGroup);
        // 这里简化处理，实际可能需要根据 displayOrder 重新排序
    }
}

/**
 * 更新时间相关信息
 */
function updateTimeInfo(data) {
    if (data.serverTime) {
        const el = document.getElementById('serverTimeValue');
        if (el) el.textContent = new Date(data.serverTime).toLocaleString(getCurrentLanguage());
    }
}

/**
 * 渲染数据
 */
function renderUsageData(data, container) {
    if (!container) return;
    container.innerHTML = '';
    container.classList.add('usage-provider-groups');
    scheduleAntigravityRecoveryRefresh(data);

    if (!data?.providers || Object.keys(data.providers).length === 0) {
        container.classList.remove('usage-provider-groups');
        container.innerHTML = `<div class="usage-empty"><p>${t('usage.noData')}</p></div>`;
        return;
    }

    const groupedProviders = {};
    for (const [type, pData] of Object.entries(data.providers)) {
        if (currentProviderConfigs?.find(c => c.id === type)?.visible === false) continue;
        const valid = (pData.instances || []).filter(i => !i.isDisabled && !i.error?.includes('not initialized'));
        if (valid.length > 0) groupedProviders[type] = { ...pData, instances: valid };
    }

    const displayOrder = currentProviderConfigs ? currentProviderConfigs.map(c => c.id) : Object.keys(groupedProviders);
    displayOrder.forEach(type => {
        if (groupedProviders[type]) container.appendChild(createProviderGroup(type, groupedProviders[type]));
    });
}

/**
 * 创建分组
 */
function createProviderGroup(providerType, providerData) {
    const group = document.createElement('div');
    group.className = 'usage-provider-group is-full-width collapsed';
    group.setAttribute('data-provider', providerType);

    const instances = providerData.instances || [];
    const refreshableInstances = instances.filter(i => !i?.skipped && !i?.isDisabled);
    const successCount = refreshableInstances.filter(i => i.success).length;
    const successTotal = refreshableInstances.length;
    const refreshedAt = providerData.lastSuccessfulRefreshAt;
    const refreshedDate = refreshedAt ? new Date(refreshedAt) : null;
    const hasValidRefreshTime = refreshedDate && Number.isFinite(refreshedDate.getTime());
    const refreshTimeText = hasValidRefreshTime
        ? t('usage.group.lastUpdated', { time: refreshedDate.toLocaleString(getCurrentLanguage()) })
        : t('usage.group.neverUpdated');
    const providerQuotaStack = renderAntigravityProviderQuotaStack(instances, providerType);
    group.innerHTML = `
        <div class="usage-group-header">
            <div class="usage-group-title">
                <i class="fas fa-chevron-right toggle-icon"></i>
                <i class="${getProviderIcon(providerType)} provider-icon"></i>
                <span class="provider-name">${getProviderDisplayName(providerType)}</span>
                <span class="instance-count">${t('usage.group.instances', { count: instances.length })}</span>
                ${providerQuotaStack}
                <span class="success-count ${successCount === successTotal ? 'all-success' : ''}">${t('usage.group.success', { count: successCount, total: successTotal })}</span>
            </div>
            <div class="usage-group-actions">
                <span class="provider-last-update" title="${escapeHtml(refreshTimeText)}">${escapeHtml(refreshTimeText)}</span>
                <button class="btn-refresh-provider" type="button"></button>
                <button class="btn-toggle-cards" type="button" aria-label="${t('usage.group.expandAll')}" title="${t('usage.group.expandAll')}"><i class="fas fa-expand-alt" aria-hidden="true"></i></button>
            </div>
        </div>
        <div class="usage-group-content"><div class="usage-cards-grid"></div></div>
    `;
    
    group.querySelector('.usage-group-title').onclick = () => group.classList.toggle('collapsed');
    const refreshButton = group.querySelector('.btn-refresh-provider');
    const providerName = getProviderDisplayName(providerType);
    const refreshLabel = t('usage.group.refreshAria', { name: providerName });
    refreshButton.innerHTML = `<i class="fas fa-rotate" aria-hidden="true"></i><span class="button-label">${t('usage.group.refresh')}</span>`;
    refreshButton.setAttribute('aria-label', escapeHtml(refreshLabel));
    refreshButton.setAttribute('title', escapeHtml(refreshLabel));
    refreshButton.addEventListener('click', async event => {
        event.stopPropagation();
        await refreshProviderUsage(providerType, refreshButton);
    });
    
    const toggleBtn = group.querySelector('.btn-toggle-cards');
    toggleBtn.onclick = (e) => {
        e.stopPropagation();
        const cards = group.querySelectorAll('.usage-instance-card');
        const allCollapsed = Array.from(cards).every(card => card.classList.contains('collapsed'));
        cards.forEach(card => card.classList.toggle('collapsed', !allCollapsed));
        const icon = toggleBtn.querySelector('i');
        icon.className = allCollapsed ? 'fas fa-compress-alt' : 'fas fa-expand-alt';
        const labelKey = allCollapsed ? 'usage.group.collapseAll' : 'usage.group.expandAll';
        toggleBtn.setAttribute('aria-label', t(labelKey));
        toggleBtn.setAttribute('title', t(labelKey));
    };
    
    const grid = group.querySelector('.usage-cards-grid');
    instances.forEach(inst => grid.appendChild(createInstanceUsageCard(inst, providerType)));

    return group;
}

/**
 * 创建实例卡片 (全面适配新结构)
 */
function createInstanceUsageCard(instance, providerType) {
    const card = document.createElement('div');
    const hasVisibleUsage = Boolean(instance.usage);
    card.className = `usage-instance-card ${instance.success || hasVisibleUsage ? 'success' : 'error'} collapsed`;
    card.setAttribute('data-uuid', instance.uuid);

    const usage = instance.usage || {};
    const accountUsageSummary = getAccountUsageSummary(providerType, instance);
    const summary = usage.summary || { usedPercent: 0, status: 'normal' };
    const user = usage.user || {};
    const displayName = user.email || instance.codexEmail || instance.name || instance.uuid;
    const providerDisplayName = getProviderDisplayName(providerType);
    const rateLimitResetCredits = summary.rateLimitResetCredits
        || (providerType === 'openai-codex-oauth' && summary.resetAvailableCount !== undefined
            ? {
                availableCount: summary.resetAvailableCount,
                canReset: Number(summary.resetAvailableCount) > 0
            }
            : null);
    const showCodexReset = providerType === 'openai-codex-oauth' && rateLimitResetCredits;
    const resetAvailableCount = getCodexResetAvailableCount(rateLimitResetCredits);

    // 使用后端返回的 planClass，如果缺失则兜底
    const planClass = summary.planClass || 'plan-default';

    card.innerHTML = `
        <div class="usage-card-collapsed-summary">
            <div class="collapsed-summary-row collapsed-summary-name-row">
                <i class="fas fa-chevron-right usage-toggle-icon"></i>
                <span class="collapsed-name" title="${displayName} ${t('usage.clickToManage')}" onclick="event.stopPropagation(); window.jumpToProviderNode('${providerType}', '${instance.uuid}', event)">${displayName}</span>
                ${summary.plan ? `<span class="collapsed-plan-badge ${planClass}${instance.subscriptionExpired ? ' is-expired' : ''}"${instance.subscriptionExpired ? ' title="历史订阅数据：Pro 订阅已过期"' : ''}>${summary.plan}${instance.subscriptionExpired ? '（已过期）' : ''}</span>` : ''}
                ${renderCodexSubscriptionUntil(instance)}
                ${renderCollapsedStatusIcons(instance, providerType)}
            </div>
            ${hasVisibleUsage ? `
            <div class="collapsed-summary-row collapsed-summary-usage-row">
                <div class="collapsed-progress-bar ${summary.status}"><div class="progress-fill" style="width: ${summary.usedPercent}%"></div></div>
                <span class="collapsed-percent">
                    ${summary.unit === 'percent' 
                        ? `${summary.usedPercent.toFixed(1)}%` 
                        : `${formatNumber(summary.totalUsed || 0)} / ${formatNumber(summary.totalLimit || 0)}`
                    }
                </span>
            </div>
            ` : (instance.error ? `<div class="collapsed-summary-row collapsed-summary-usage-row"><span class="collapsed-error">${t('common.error')}</span></div>` : '')}
        </div>
        <div class="usage-card-expanded-content">
            <div class="usage-instance-header">
                <div class="instance-header-top">
                    <div class="instance-provider-type" title="${providerDisplayName}"><i class="${getProviderIcon(providerType)}"></i><span>${providerDisplayName}</span></div>
                    <div class="instance-status-badges">
                        ${instance.configFilePath ? `<button class="btn-download-config" title="${t('usage.card.downloadConfig')}"><i class="fas fa-download"></i></button>` : ''}
                        <button class="btn-refresh-usage" title="${t('usage.card.refresh')}"><i class="fas fa-sync-alt"></i></button>
                        ${renderBaseStatusBadge(instance)}
                        ${renderCodexQuotaHealthBadges(instance, providerType)}
                    </div>
                </div>
                <div class="instance-name"><span class="instance-name-text" title="${displayName}">${displayName}</span></div>
                <div class="instance-user-info">
                    ${user.label ? `<span class="user-email"><i class="fas fa-envelope"></i> ${user.label}</span>` : ''}
                </div>
            </div>
            <div class="usage-instance-content"></div>
        </div>
    `;

    card.querySelector('.usage-card-collapsed-summary').onclick = () => card.classList.toggle('collapsed');
    
    if (instance.configFilePath) {
        card.querySelector('.btn-download-config').onclick = (e) => { e.stopPropagation(); downloadConfigFile(instance.configFilePath); };
    }
    
    card.querySelector('.btn-refresh-usage').onclick = (e) => { 
        e.stopPropagation(); 
        refreshSingleInstanceUsage(providerType, instance.uuid, displayName); 
    };
    const contentArea = card.querySelector('.usage-instance-content');
    const refreshWarning = renderUsageRefreshWarning(instance);
    if (refreshWarning) {
        contentArea.appendChild(refreshWarning);
    }
    const unavailableModels = renderAntigravityUnavailableModels(instance, providerType);
    if (unavailableModels) {
        contentArea.appendChild(unavailableModels);
    }
    if (instance.usage) {
        contentArea.appendChild(renderUsageDetails(instance.usage, accountUsageSummary, instance));
    } else if (instance.error) {
        contentArea.innerHTML = `<div class="usage-error-message"><i class="fas fa-exclamation-triangle"></i> <span>${escapeHtml(instance.error)}</span></div>`;
    }

    card.querySelectorAll('.btn-reset-codex-usage-inline').forEach(resetButton => {
        resetButton.onclick = (e) => {
            e.stopPropagation();
            resetCodexRateLimit(providerType, instance.uuid, displayName, resetButton, resetAvailableCount);
        };
    });

    return card;
}

function parseTelemetryUpdatedAt(value) {
    if (!value) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function formatUsageUpdatedHour(value) {
    const timestamp = parseTelemetryUpdatedAt(value);
    if (timestamp === null) return '--';
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false,
        hourCycle: 'h23'
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}时`;
}

function formatTelemetryUpdateDifference(updatedAt, commonUpdatedAt) {
    const timestamp = parseTelemetryUpdatedAt(updatedAt);
    const commonTimestamp = parseTelemetryUpdatedAt(commonUpdatedAt);
    if (timestamp === null || commonTimestamp === null) return '--';
    const totalMinutes = Math.max(1, Math.round(Math.abs(timestamp - commonTimestamp) / (60 * 1000)));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `${minutes}分钟`;
    if (minutes === 0) return `${hours}小时`;
    return `${hours}小时 ${minutes}分钟`;
}

function formatTelemetryDataDelay(delayDays) {
    const days = Number(delayDays);
    if (!Number.isFinite(days)) return '';
    if (days < 1) return '不足1天';
    return `${Math.floor(days)}天`;
}

function getTelemetryCommonUpdatedAt(items, toleranceMs = 5 * 60 * 1000) {
    const timestamps = (Array.isArray(items) ? items : [])
        .map(item => ({ value: item?.updatedAt, timestamp: parseTelemetryUpdatedAt(item?.updatedAt) }))
        .filter(item => item.timestamp !== null);
    if (timestamps.length < 2) return null;

    let bestCluster = [];
    for (const candidate of timestamps) {
        const cluster = timestamps.filter(item => Math.abs(item.timestamp - candidate.timestamp) <= toleranceMs);
        if (cluster.length > bestCluster.length) bestCluster = cluster;
    }
    if (bestCluster.length < 2) return null;
    return bestCluster.reduce((latest, item) => item.timestamp > latest.timestamp ? item : latest).value;
}

function isTelemetryUpdateOutlier(updatedAt, commonUpdatedAt, toleranceMs = 5 * 60 * 1000) {
    const timestamp = parseTelemetryUpdatedAt(updatedAt);
    const commonTimestamp = parseTelemetryUpdatedAt(commonUpdatedAt);
    if (timestamp === null || commonTimestamp === null) return false;
    return Math.abs(timestamp - commonTimestamp) > toleranceMs;
}

/**
 * 渲染用量详情 (全面适配新结构)
 */
function renderUsageDetails(usage, accountSummary = null, instance = {}) {
    const container = document.createElement('div');
    container.className = 'usage-details';

    const { summary, items } = usage;

    if (accountSummary) {
        container.appendChild(renderAccountUsageSummary(accountSummary, instance));
    }
    
    if (summary?.usedPercent !== undefined) {
        const total = document.createElement('div');
        total.className = 'usage-section total-usage';
        const summaryLabel = summary.label || t('usage.card.quotaOverview');
        total.innerHTML = `
            <div class="total-usage-header">
                <span class="total-label"><i class="fas fa-chart-pie"></i> <span>${escapeHtml(summaryLabel)}</span></span>
                <span class="total-value">${summary.usedPercent.toFixed(1)}%</span>
            </div>
            <div class="progress-bar ${summary.status}"><div class="progress-fill" style="width: ${summary.usedPercent}%"></div></div>
            <div class="total-footer">
                ${summary.resetAt ? `<div class="total-reset-info"><i class="fas fa-history"></i> ${t('usage.card.resetAt', { time: formatDate(summary.resetAt) })}</div>` : ''}
            </div>
        `;
        container.appendChild(total);
    }

    if (summary?.rateLimitResetCredits || summary?.rateLimitResetCreditsStale) {
        const credits = summary.rateLimitResetCredits;
        const availableCount = getCodexResetAvailableCount(credits);
        const canReset = canUseCodexRateLimitReset(credits);
        const stale = summary.rateLimitResetCreditsStale === true;
        const staleAt = summary.rateLimitResetCreditsLastSuccessfulAt
            ? formatDate(summary.rateLimitResetCreditsLastSuccessfulAt)
            : '--';
        const resetCreditsTooltip = stale
            ? `上次成功数据 · ${staleAt}`
            : formatCodexResetCreditsTooltip(credits);
        const buttonTitle = canReset
            ? `Use Codex rate-limit reset (${availableCount} available)`
            : 'No Codex rate-limit resets available';
        const resetInfo = document.createElement('div');
        resetInfo.className = `usage-section usage-reset-credits${stale ? ' is-stale' : ''}`;
        resetInfo.innerHTML = `
            <div class="codex-reset-action-row">
                <div class="codex-reset-meta">
                    <span class="codex-reset-icon"><i class="fas fa-rotate-left"></i>${stale ? '<i class="fas fa-circle-exclamation codex-reset-stale-icon" aria-label="上次成功数据"></i>' : ''}</span>
                    <div class="codex-reset-copy">
                        <span class="codex-reset-label">Rate-limit resets</span>
                        <span class="codex-reset-count" title="${escapeHtml(resetCreditsTooltip)}">${availableCount} available</span>
                    </div>
                </div>
                <button type="button" class="btn-reset-codex-usage-inline" title="${buttonTitle}" aria-label="${buttonTitle}" ${canReset ? '' : 'disabled'}>
                    <i class="fas fa-rotate-left"></i>
                    <span>${canReset ? 'Use reset' : 'Unavailable'}</span>
                </button>
            </div>
        `;
        container.appendChild(resetInfo);
    }

    const visibleItems = summary?.rateLimitResetCredits
        ? items?.filter(item => item.id !== 'rate_limit_reset_credits')
        : items;

    if (visibleItems?.length > 0) {
        const telemetryItems = visibleItems.filter(item => item.category === 'telemetry');
        const telemetryCommonUpdatedAt = getTelemetryCommonUpdatedAt(telemetryItems);
        const renderBreakdownGroup = (groupItems, title, className, commonUpdatedAt = null) => {
            if (groupItems.length === 0) return;
            const breakdown = document.createElement('div');
            breakdown.className = `usage-section usage-breakdown-compact ${className}`;
            const titleMeta = commonUpdatedAt
                ? `<span class="usage-breakdown-title-meta"><i class="fas fa-clock"></i> ${t('usage.card.updatedAt', { time: formatUsageUpdatedHour(commonUpdatedAt) })}</span>`
                : '';
            breakdown.innerHTML = `<div class="usage-breakdown-title"><span>${escapeHtml(title)}</span>${titleMeta}</div>`;
            groupItems.forEach(item => {
                const isTelemetry = item.category === 'telemetry';
                const isUnavailable = item.available === false;
                const updateIsOutlier = isTelemetryUpdateOutlier(item.updatedAt, commonUpdatedAt);
                const updateIsMissing = isTelemetry && Boolean(commonUpdatedAt) && !item.updatedAt;
                const individualUpdateText = updateIsOutlier
                    ? t('usage.card.updatedAtMismatch', {
                        time: formatUsageUpdatedHour(item.updatedAt),
                        difference: formatTelemetryUpdateDifference(item.updatedAt, commonUpdatedAt)
                    })
                    : updateIsMissing
                    ? t('usage.card.updatedAtMissing')
                    : (isTelemetry && !commonUpdatedAt && item.updatedAt
                        ? t('usage.card.updatedAt', { time: formatUsageUpdatedHour(item.updatedAt) })
                        : '');
                const val = isUnavailable
                    ? '—'
                    : item.displayValue !== undefined && item.displayValue !== null
                    ? item.displayValue
                    : item.unit === 'percent'
                    ? `${item.percent.toFixed(1)}%`
                    : (item.limit === null || item.limit === undefined ? formatNumber(item.used) : `${formatNumber(item.used)} / ${formatNumber(item.limit)}`);
                const delayedText = isUnavailable && Number.isFinite(Number(item.delayDays))
                    ? t('usage.card.dataDelayedBy', { difference: formatTelemetryDataDelay(item.delayDays) })
                    : t('usage.card.dataDelayed');
                const itemEl = document.createElement('div');
                itemEl.className = `breakdown-item-compact${isTelemetry ? ' telemetry-item' : ''}`;
                itemEl.innerHTML = `
                    <div class="breakdown-header-compact"><span class="breakdown-name">${escapeHtml(item.label)}</span><span class="breakdown-usage">${escapeHtml(String(val))}</span></div>
                    ${isTelemetry ? '' : `<div class="progress-bar-small ${item.status}"><div class="progress-fill" style="width: ${item.percent}%"></div></div>`}
                    ${item.resetAt ? `<div class="extra-usage-info reset-time"><i class="fas fa-history"></i> ${formatDate(item.resetAt)}</div>` : ''}
                    ${isUnavailable ? `<div class="extra-usage-info telemetry-as-of"><i class="fas fa-circle-exclamation"></i> ${delayedText}</div>` : ''}
                    ${individualUpdateText ? `<div class="extra-usage-info telemetry-as-of${updateIsOutlier || updateIsMissing ? ' telemetry-update-outlier' : ''}"><i class="fas fa-clock"></i> ${individualUpdateText}</div>` : ''}
                `;
                breakdown.appendChild(itemEl);
            });
            container.appendChild(breakdown);
        };

        renderBreakdownGroup(
            visibleItems.filter(item => item.category !== 'telemetry'),
            t('usage.card.quotaDetails'),
            'quota-breakdown'
        );
        renderBreakdownGroup(
            telemetryItems,
            t('usage.card.tokenTelemetry'),
            'telemetry-breakdown',
            telemetryCommonUpdatedAt
        );
    }

    if (summary?.tokenUsageAvailable === false) {
        const tokenNote = document.createElement('div');
        tokenNote.className = 'usage-section usage-token-note';
        tokenNote.innerHTML = `
            <div class="extra-usage-info official-token-note">
                <i class="fas fa-info-circle"></i>
                <span>${t('usage.card.codexTokenUsageUnavailable')}</span>
            </div>
        `;
        container.appendChild(tokenNote);
    }

    return container;
}

function renderAccountUsageSummary(accountSummary, instance = {}) {
    const section = document.createElement('div');
    section.className = 'usage-section account-usage-summary';
    const lastUsedAt = accountSummary.lastUsedAt || accountSummary.today?.lastUsedAt || accountSummary.week?.lastUsedAt || accountSummary.month?.lastUsedAt || null;
    section.innerHTML = `
        <div class="account-usage-summary-meta">
            ${lastUsedAt ? `<div class="account-usage-recent-request-row"><div class="account-usage-last-used"><i class="fas fa-clock"></i> 最近请求 ${formatDate(lastUsedAt)}</div></div>` : ''}
            <div class="account-usage-estimated-weekly-row">${renderEstimatedWeeklyQuota(accountSummary, instance)}</div>
        </div>
            <div class="account-usage-period-grid">
                ${renderAccountUsagePeriod('今日', accountSummary.today)}
                ${renderAccountUsagePeriod('近1周', accountSummary.week)}
                ${renderAccountUsagePeriod('近1月', accountSummary.month)}
            </div>
        `;
    return section;
}

function renderEstimatedWeeklyQuota(accountSummary, instance = {}) {
    const estimate = instance.weeklyQuotaEstimate;
    if (estimate && estimate.status === 'exhausted' && estimate.method === 'exhausted-period-total') {
        const weeklyAmount = Number(estimate.estimatedWeeklyUsd);
        const monthlyAmount = Number(estimate.estimatedMonthlyUsd);
        if (Number.isFinite(weeklyAmount)) {
            return `<div class="account-usage-estimated-weekly" title="本周期已用完，额度已确定：当前周期累计金额 ${formatUsd(estimate.periodCostUsd)}"><i class="fas fa-chart-line"></i><span>预估周额度（已用完）</span><strong>$${Math.round(weeklyAmount).toLocaleString(getCurrentLanguage())}</strong></div><div class="account-usage-estimated-weekly account-usage-estimated-monthly" title="本周期已用完，按确定周额度 × 4 推算"><i class="fas fa-calendar-alt"></i><span>预估月额度</span><strong>$${Math.round(monthlyAmount).toLocaleString(getCurrentLanguage())}</strong></div>`;
        }
        return '<div class="account-usage-estimated-weekly" title="官方周额度已用完，但本地累计金额不可用"><i class="fas fa-chart-line"></i><span>周额度</span><strong>已用完（100%）</strong></div><div class="account-usage-estimated-weekly account-usage-estimated-monthly" title="本地累计金额不可用，无法推算月额度"><i class="fas fa-calendar-alt"></i><span>预估月额度</span><strong>不可估算</strong></div>';
    }
    if (!estimate || estimate.status !== 'estimated' || !Number.isFinite(Number(estimate.estimatedWeeklyUsd))) {
        return '<div class="account-usage-estimated-weekly" title="当前周期金额或官方额度不足，继续采样中"><i class="fas fa-chart-line"></i><span>预估周额度</span><strong>采样中</strong></div><div class="account-usage-estimated-weekly account-usage-estimated-monthly" title="周额度可估算后按 4 周推算"><i class="fas fa-calendar-alt"></i><span>预估月额度</span><strong>采样中</strong></div>';
    }
    const weeklyAmount = Math.round(Number(estimate.estimatedWeeklyUsd));
    const monthlyAmount = Math.round(Number(estimate.estimatedMonthlyUsd));
    const range = Number.isFinite(Number(estimate.lowerBoundUsd)) && Number.isFinite(Number(estimate.upperBoundUsd))
        ? `，区间 $${Math.round(Number(estimate.lowerBoundUsd)).toLocaleString(getCurrentLanguage())}–$${Math.round(Number(estimate.upperBoundUsd)).toLocaleString(getCurrentLanguage())}`
        : '';
    const tooltip = `当前周期低置信度估算：${estimate.periodStart ? `自 ${formatDate(estimate.periodStart)} 起，` : ''}本地金额 ${formatUsd(estimate.periodCostUsd)} ÷ 官方已用 ${Number(estimate.usedPercent).toFixed(1)}%${range}`;
    return `<div class="account-usage-estimated-weekly" title="${escapeHtml(tooltip)}"><i class="fas fa-chart-line"></i><span>预估周额度</span><strong>$${weeklyAmount.toLocaleString(getCurrentLanguage())}</strong></div><div class="account-usage-estimated-weekly account-usage-estimated-monthly" title="按预估周额度 × 4 推算，不代表官方月度限额"><i class="fas fa-calendar-alt"></i><span>预估月额度</span><strong>$${monthlyAmount.toLocaleString(getCurrentLanguage())}</strong></div>`;
}

function renderAccountUsagePeriod(label, usage = {}) {
    const tokens = formatTokenCompact(usage.totalTokens || 0);
    const requests = formatInteger(usage.requestCount || 0);
    return `
        <div class="account-usage-period">
            <div class="account-usage-period-label">${label}</div>
            <div class="account-usage-period-value">${tokens}</div>
            <div class="account-usage-period-sub">${requests} req</div>
            ${renderAccountUsageCost(usage)}
        </div>
    `;
}

function renderAccountUsageCost(usage = {}) {
    const cost = usage.cost;
    if (!cost) return '';
    const amount = Number(cost.usd ?? (Number(cost.actualUsd || 0) + Number(cost.estimatedUsd || 0)));
    return `
        <div class="account-usage-period-cost">
            <span>${formatUsd(amount)}</span>
        </div>
    `;
}

function getProviderDisplayName(type) {
    return getProviderMeta(type).name;
}

function getProviderIcon(type) {
    const icon = getProviderMeta(type).icon;
    return icon.startsWith('fa-') ? `fas ${icon}` : icon;
}

function getProviderMeta(type) {
    const config = currentProviderConfigs?.find(c => c.id === type) || getBaseProviderConfigs().find(c => c.id === type);
    return {
        name: config?.usageName || config?.shortName || config?.name || type,
        icon: config?.icon || 'fa-server'
    };
}

async function downloadConfigFile(path) {
    try {
        const response = await fetch(`/api/upload-configs/download/${encodeURIComponent(path)}`, { headers: getAuthHeaders() });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = path.split(/[/\\]/).pop();
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        showToast(t('common.success'), t('usage.card.downloadSuccess'), 'success');
    } catch (error) {
        showToast(t('common.error'), t('usage.card.downloadFailed') + ': ' + error.message, 'error');
    }
}

function formatNumber(num) {
    if (num === null || num === undefined) return '0.00';
    return (Math.ceil(num * 100) / 100).toFixed(2);
}

function formatInteger(num) {
    const value = Number(num);
    if (!Number.isFinite(value)) return '0';
    return Math.round(value).toLocaleString(getCurrentLanguage());
}

function formatTokenCompact(num) {
    const value = Number(num);
    if (!Number.isFinite(value) || value <= 0) return '0';
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}k`;
    return Math.round(value).toLocaleString(getCurrentLanguage());
}

function formatUsd(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return '$0.00';
    if (num < 0.01) return `$${num.toFixed(4)}`;
    return `$${num.toFixed(2)}`;
}

function formatDate(str) {
    if (!str) return '--';
    try {
        return new Date(str).toLocaleString(getCurrentLanguage(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        return str;
    }
}

export function formatCodexSubscriptionUntilLabel(until, now = Date.now()) {
    const untilMs = Date.parse(until);
    if (!Number.isFinite(untilMs)) return '';

    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Shanghai',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).formatToParts(new Date(untilMs)).map(part => [part.type, part.value])
    );
    const compact = `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
    const diffMs = untilMs - Number(now);
    if (diffMs <= 0) {
        return t('usage.card.subscriptionUntilExpired', { time: compact });
    }

    const dayMs = 24 * 60 * 60 * 1000;
    const hourMs = 60 * 60 * 1000;
    if (diffMs < dayMs) {
        return t('usage.card.subscriptionUntil', {
            time: compact,
            relative: t('usage.card.subscriptionRelativeHours', { count: Math.max(1, Math.round(diffMs / hourMs)) })
        });
    }

    return t('usage.card.subscriptionUntil', {
        time: compact,
        relative: t('usage.card.subscriptionRelativeDays', { count: Math.max(1, Math.round(diffMs / dayMs)) })
    });
}

function renderCodexSubscriptionUntil(instance = {}, now = Date.now()) {
    const until = instance.subscription_active_until;
    const label = formatCodexSubscriptionUntilLabel(until, now);
    if (!label) return '';
    const expired = Date.parse(until) <= Number(now) || instance.subscriptionExpired === true;
    return `<span class="collapsed-subscription-until${expired ? ' is-expired' : ''}" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}
