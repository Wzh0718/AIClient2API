const SNAPSHOT_LIMIT = 60;

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizeSnapshot(snapshot = {}) {
    const observedAt = typeof snapshot.observedAt === 'string' ? snapshot.observedAt : null;
    const observedMs = observedAt ? Date.parse(observedAt) : NaN;
    const resetAt = typeof snapshot.resetAt === 'string' ? snapshot.resetAt : null;
    const usedPercent = finiteNumber(snapshot.usedPercent);
    const costUsd = finiteNumber(snapshot.costUsd);
    if (!Number.isFinite(observedMs) || usedPercent === null || costUsd === null || costUsd < 0) {
        return null;
    }
    return { observedAt, observedMs, resetAt, usedPercent, costUsd };
}

function getWeeklyQuotaItem(items = []) {
    const list = Array.isArray(items) ? items : [];
    return list.find(item => item?.windowKind === 'weekly' && item?.resetAt)
        || list.find(item => item?.windowKind === 'weekly')
        || list.find(item => item?.id === 'secondary_window' && item?.resetAt)
        || list.find(item => item?.id === 'secondary_window')
        || list.find(item => /weekly/i.test(String(item?.label || '')));
}

export function getWeeklyQuotaPercent(items = []) {
    const weeklyItem = getWeeklyQuotaItem(items);
    const percent = finiteNumber(weeklyItem?.percent ?? weeklyItem?.used ?? weeklyItem?.usedPercent);
    return percent !== null && percent >= 0 && percent <= 100 ? percent : null;
}

export function getWeeklyQuotaResetAt(items = [], fallback = null) {
    const list = Array.isArray(items) ? items : [];
    return list.find(item => item?.windowKind === 'weekly' && item?.resetAt)?.resetAt
        || list.find(item => item?.id === 'secondary_window' && item?.resetAt)?.resetAt
        || list.find(item => item?.windowKind === 'weekly')?.resetAt
        || fallback
        || null;
}

function dedupeSnapshots(snapshots) {
    const byState = new Map();
    for (const snapshot of snapshots) {
        const key = `${snapshot.resetAt || ''}|${snapshot.usedPercent}|${snapshot.costUsd}`;
        byState.set(key, snapshot);
    }
    return [...byState.values()].sort((left, right) => left.observedMs - right.observedMs);
}

export function estimateWeeklyQuotaFromSnapshots(snapshots = []) {
    const normalized = dedupeSnapshots((Array.isArray(snapshots) ? snapshots : [])
        .map(normalizeSnapshot)
        .filter(Boolean));
    const estimates = [];

    for (let index = 1; index < normalized.length; index += 1) {
        const previous = normalized[index - 1];
        const current = normalized[index];
        if (previous.resetAt !== current.resetAt) continue;

        const percentDelta = current.usedPercent - previous.usedPercent;
        const costDelta = current.costUsd - previous.costUsd;
        if (percentDelta <= 0 || costDelta < 0) continue;

        const estimatedUsd = costDelta * 100 / percentDelta;
        if (!Number.isFinite(estimatedUsd) || estimatedUsd <= 0) continue;
        estimates.push({
            estimatedUsd,
            weight: percentDelta,
            from: previous.observedAt,
            to: current.observedAt
        });
    }

    if (estimates.length === 0) {
        const latest = normalized.at(-1);
        if (normalized.length === 1 && latest?.resetAt && latest.usedPercent > 0 && latest.costUsd > 0) {
            return {
                status: 'estimated',
                estimatedUsd: Math.round((latest.costUsd * 100 / latest.usedPercent) * 100) / 100,
                sampleCount: 1,
                confidence: 'low',
                method: 'single-sample-period-extrapolation',
                observedFrom: latest.observedAt,
                observedTo: latest.observedAt
            };
        }
        return {
            status: 'insufficient-data',
            estimatedUsd: null,
            sampleCount: 0,
            confidence: 'low',
            observedFrom: normalized[0]?.observedAt || null,
            observedTo: normalized.at(-1)?.observedAt || null
        };
    }

    const totalWeight = estimates.reduce((sum, item) => sum + item.weight, 0);
    const weightedUsd = estimates.reduce((sum, item) => sum + item.estimatedUsd * item.weight, 0) / totalWeight;
    return {
        status: 'estimated',
        estimatedUsd: Math.round(weightedUsd * 100) / 100,
        sampleCount: estimates.length,
        confidence: estimates.length >= 4 ? 'high' : estimates.length >= 2 ? 'medium' : 'low',
        method: 'multi-sample-delta',
        observedFrom: estimates[0].from,
        observedTo: estimates.at(-1).to
    };
}

export function appendQuotaSnapshot(existingSnapshots = [], snapshot = {}, limit = SNAPSHOT_LIMIT) {
    const normalized = normalizeSnapshot(snapshot);
    if (!normalized) return Array.isArray(existingSnapshots) ? existingSnapshots : [];
    const next = (Array.isArray(existingSnapshots) ? existingSnapshots : [])
        .filter(item => normalizeSnapshot(item))
        .filter(item => !(
            Number(item.usedPercent) === normalized.usedPercent
            && Number(item.costUsd) === normalized.costUsd
            && (item.resetAt || null) === normalized.resetAt
        ));
    next.push({
        observedAt: normalized.observedAt,
        resetAt: normalized.resetAt,
        usedPercent: normalized.usedPercent,
        costUsd: normalized.costUsd
    });
    return next
        .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
        .slice(-Math.max(1, Number(limit) || SNAPSHOT_LIMIT));
}

export { SNAPSHOT_LIMIT };
