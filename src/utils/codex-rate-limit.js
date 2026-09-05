function numberOrNull(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function getWindowDurationSeconds(windowData = {}) {
    const seconds = numberOrNull(
        windowData.limit_window_seconds ??
        windowData.limitWindowSeconds ??
        windowData.window_seconds ??
        windowData.windowSeconds
    );
    if (seconds !== null && seconds > 0) return seconds;

    const minutes = numberOrNull(
        windowData.limit_window_minutes ??
        windowData.limitWindowMinutes ??
        windowData.window_minutes ??
        windowData.windowMinutes
    );
    return minutes !== null && minutes > 0 ? minutes * 60 : null;
}

export function classifyCodexWindow(windowData = {}) {
    const durationSeconds = getWindowDurationSeconds(windowData);
    if (durationSeconds === null) {
        return { windowKind: 'unknown', durationSeconds: null };
    }

    if (durationSeconds >= 4 * 60 * 60 && durationSeconds <= 6 * 60 * 60) {
        return { windowKind: 'short', durationSeconds };
    }
    if (durationSeconds >= 6 * 24 * 60 * 60 && durationSeconds <= 8 * 24 * 60 * 60) {
        return { windowKind: 'weekly', durationSeconds };
    }
    return { windowKind: 'custom', durationSeconds };
}

function slugify(name, fallback) {
    return String(name || fallback || 'additional')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'additional';
}

function getUsedPercent(windowData) {
    return numberOrNull(windowData?.used_percent ?? windowData?.usedPercent) ?? 0;
}

function getResetAt(windowData) {
    return windowData?.reset_at ?? windowData?.resetAt ?? null;
}

function getWindowLabel({ scope, limitName, sourceWindow, windowKind, durationSeconds }) {
    const baseName = scope === 'model' ? limitName : null;
    if (windowKind === 'short') return baseName ? `${baseName} (5h)` : 'Request Quota (5h)';
    if (windowKind === 'weekly') return baseName ? `${baseName} (Weekly)` : 'Weekly Limit';
    if (windowKind === 'custom' && durationSeconds) {
        const hours = durationSeconds / 3600;
        const duration = Number.isInteger(hours) ? `${hours}h` : `${durationSeconds}s`;
        return baseName ? `${baseName} (${duration})` : `Usage Limit (${duration})`;
    }
    if (baseName) {
        return sourceWindow === 'secondary_window' ? `${baseName} (Weekly)` : `${baseName} (5h)`;
    }
    return sourceWindow === 'secondary_window' ? 'Weekly Limit' : 'Request Quota (5h)';
}

function normalizeWindow({ windowData, sourceWindow, scope, limitName = null, id }) {
    if (!windowData || typeof windowData !== 'object') return null;
    const classification = classifyCodexWindow(windowData);
    return {
        id,
        category: 'quota',
        scope,
        limitName,
        sourceWindow,
        ...classification,
        label: getWindowLabel({ scope, limitName, sourceWindow, ...classification }),
        usedPercent: getUsedPercent(windowData),
        resetAt: getResetAt(windowData),
        allowed: windowData.allowed ?? null,
        limitReached: windowData.limit_reached ?? windowData.limitReached ?? null
    };
}

function isRetiredCodexSparkWindow(window = {}) {
    const haystack = `${window.id || ''} ${window.limitName || ''} ${window.label || ''}`.toLowerCase();
    return haystack.includes('5.3') || haystack.includes('spark');
}

export function normalizeCodexRateLimitWindows(usageData = {}) {
    const windows = [];
    const rateLimit = usageData.rate_limit || usageData.rateLimit;
    const mainSlots = [
        ['primary_window', rateLimit?.primary_window || rateLimit?.primaryWindow],
        ['secondary_window', rateLimit?.secondary_window || rateLimit?.secondaryWindow]
    ];
    for (const [sourceWindow, windowData] of mainSlots) {
        const normalized = normalizeWindow({
            windowData,
            sourceWindow,
            scope: 'general',
            id: sourceWindow
        });
        if (normalized && !isRetiredCodexSparkWindow(normalized)) windows.push(normalized);
    }

    const additional = Array.isArray(usageData.additional_rate_limits)
        ? usageData.additional_rate_limits
        : (Array.isArray(usageData.additionalRateLimits) ? usageData.additionalRateLimits : []);
    additional.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        const nested = entry.rate_limit || entry.rateLimit || entry;
        const limitName = entry.limit_name || entry.limitName || entry.metered_feature || entry.meteredFeature || `Additional Limit ${index + 1}`;
        const slug = slugify(limitName, `additional_${index + 1}`);
        const slots = [
            ['primary_window', nested?.primary_window || nested?.primaryWindow],
            ['secondary_window', nested?.secondary_window || nested?.secondaryWindow]
        ];
        for (const [sourceWindow, windowData] of slots) {
            const normalized = normalizeWindow({
                windowData,
                sourceWindow,
                scope: 'model',
                limitName,
                id: `additional_${slug}_${sourceWindow}`
            });
            if (normalized && !isRetiredCodexSparkWindow(normalized)) windows.push(normalized);
        }
    });

    return windows;
}

function buildWindowApplicability(windows, scope, windowKind) {
    const matching = windows.filter(window => window.scope === scope && window.windowKind === windowKind);
    if (matching.length > 0) {
        return { status: 'healthy', windowCount: matching.length };
    }
    return {
        status: 'unknown',
        windowCount: 0
    };
}

function isProPlanWithoutPlus(plan) {
    const normalized = String(plan || '').trim().toLowerCase();
    return normalized.includes('pro') && !normalized.includes('plus') && !normalized.includes('+');
}

export function getCodexQuotaApplicability(usageData = {}) {
    const rawUsage = usageData?.raw && typeof usageData.raw === 'object' ? usageData.raw : usageData;
    const plan = usageData.summary?.plan || rawUsage.plan_type || rawUsage.planType || '';
    const windows = Array.isArray(usageData)
        ? usageData
        : normalizeCodexRateLimitWindows(rawUsage);
    const general = {
        short: buildWindowApplicability(windows, 'general', 'short'),
        weekly: buildWindowApplicability(windows, 'general', 'weekly')
    };
    if (general.short.status === 'unknown' && general.weekly.status === 'healthy' && isProPlanWithoutPlus(plan)) {
        general.short = {
            status: 'not_applicable',
            reason: 'plan_weekly_only'
        };
    }
    return {
        general
    };
}

export function selectCodexSummaryWindow(windows = []) {
    const general = windows.filter(window => window.scope === 'general');
    return general.find(window => window.windowKind === 'weekly')
        || general.find(window => window.sourceWindow === 'secondary_window')
        || general.find(window => window.windowKind === 'short')
        || general[0]
        || null;
}
