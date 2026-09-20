import fs from 'fs';
import path from 'path';
import { atomicWriteFile } from '../utils/file-lock.js';

const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const DEFAULT_HISTORY_DAYS = 7;
const DEFAULT_UNKNOWN_CAPACITY = 0.5;
const STORE_VERSION = 1;
const MAX_RETAINED_REVISIONS = 2;
const MAX_CREDENTIALS_PER_GROUP = 2;
const DEMAND_MODEL_FILTER = 'gpt-*';
const DEMAND_MODEL_FILTER_CASE_SENSITIVE = false;

/**
 * Every Codex request resolves its key routing through a fresh service
 * instance, and the production store grew past 20 MB of revision history, so a
 * synchronous read plus JSON.parse per request became the single largest CPU
 * consumer in the execution workers (~23% of samples) and blocked the event
 * loop. Only the current revision's config is needed on that path, so it is
 * cached per file and invalidated by the file's mtime and size.
 * @type {Map<string, {mtimeMs: number, size: number, config: object}>}
 */
const currentConfigCache = new Map();

function statStoreSync(filePath) {
    try {
        const stats = fs.statSync(filePath);
        return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
        return null;
    }
}

function toFiniteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function toPositiveNumber(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeRemainingRatio(value) {
    if (value === undefined || value === null || value === '') return null;
    let ratio = Number(value);
    if (!Number.isFinite(ratio)) return null;
    if (ratio > 1 && ratio <= 100) ratio /= 100;
    return Math.max(0, Math.min(1, ratio));
}

function getCredentialUuid(credential) {
    return credential?.uuid || credential?.providerUuid || credential?.config?.uuid || null;
}

function getCredentialProviderType(credential) {
    return credential?.providerType || credential?.provider || credential?.type || 'openai-codex-oauth';
}

function isCredentialHealthy(credential) {
    return credential?.isHealthy !== false
        && credential?.isDisabled !== true
        && credential?.disabled !== true
        && credential?.needsRefresh !== true
        && credential?.available !== false;
}

function isCredentialRouteAvailable(credential) {
    if (!isCredentialHealthy(credential)) return false;
    if (credential?.quotaAvailable === false || credential?.hasCapacity === false || credential?.isAtCapacity === true) {
        return false;
    }
    const capacity = calculateCredentialCapacity(credential);
    return capacity.capacity > 0;
}

function dateStringInTimeZone(value, timeZone = DEFAULT_TIME_ZONE) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(value instanceof Date ? value : new Date(value));
    const partMap = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${partMap.year}-${partMap.month}-${partMap.day}`;
}

function addDateDays(dateString, delta) {
    const [year, month, day] = String(dateString).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + delta);
    return date.toISOString().slice(0, 10);
}

function getCompleteDateRange(now, days = DEFAULT_HISTORY_DAYS, timeZone = DEFAULT_TIME_ZONE) {
    const today = dateStringInTimeZone(now, timeZone);
    return {
        startDate: addDateDays(today, -(days - 1)),
        endDate: today
    };
}

function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeGroup(group = {}, index = 0) {
    return {
        ...cloneJson(group),
        id: String(group.id || `group-${index + 1}`),
        name: String(group.name || `凭据组 ${index + 1}`),
        manualLock: group.manualLock === true,
        credentialUuids: [...new Set((group.credentialUuids || []).filter(Boolean).map(String))]
    };
}

function normalizeKeyAssignment(assignment = {}) {
    const hasPrimaryGroup = Boolean(String(assignment.primaryGroupId || '').trim());
    const routingMode = assignment.routingMode === 'fixed'
        ? 'fixed'
        : assignment.routingMode === 'pool' || !hasPrimaryGroup
            ? 'pool'
            : 'auto';
    return {
        ...cloneJson(assignment),
        keyId: String(assignment.keyId || assignment.id || ''),
        routingMode,
        primaryGroupId: routingMode === 'auto' ? String(assignment.primaryGroupId) : null,
        fixedCredential: routingMode === 'fixed' && assignment.fixedCredential?.uuid
            ? {
                providerType: assignment.fixedCredential.providerType || 'openai-codex-oauth',
                uuid: String(assignment.fixedCredential.uuid)
            }
            : null,
        manualLock: assignment.manualLock === true
    };
}

function defaultStore() {
    return {
        version: STORE_VERSION,
        currentRevision: 0,
        revisions: []
    };
}

function getRevision(store, revision) {
    return (store.revisions || []).find(entry => entry.revision === revision) || null;
}

function compactRevisions(store) {
    const revisions = Array.isArray(store.revisions) ? store.revisions : [];
    if (revisions.length <= MAX_RETAINED_REVISIONS) return { store, changed: false };

    const currentRevision = Number(store.currentRevision || 0);
    const current = revisions.find(entry => Number(entry?.revision) === currentRevision)
        || revisions[revisions.length - 1];
    const previousRevision = Number(current?.previousRevision || 0);
    const previous = previousRevision
        ? revisions.find(entry => Number(entry?.revision) === previousRevision)
        : revisions
            .filter(entry => Number(entry?.revision) < Number(current?.revision || currentRevision))
            .sort((a, b) => Number(b.revision) - Number(a.revision))[0];
    const retained = [previous, current]
        .filter(Boolean)
        .filter((entry, index, entries) => entries.findIndex(item => item.revision === entry.revision) === index)
        .sort((a, b) => Number(a.revision) - Number(b.revision));

    store.revisions = retained;
    return { store, changed: true };
}

function createCredentialGroupError(code, message, details = null) {
    const error = new Error(message);
    error.code = code;
    if (details) error.details = details;
    return error;
}

function isCodexProviderType(providerType) {
    return providerType === 'openai-codex-oauth'
        || String(providerType || '').startsWith('openai-codex-oauth-');
}

function assertBaseRevision(store, baseRevision) {
    if (baseRevision === undefined || baseRevision === null) return;
    const normalizedBaseRevision = Number(baseRevision);
    if (!Number.isInteger(normalizedBaseRevision) || normalizedBaseRevision !== Number(store.currentRevision || 0)) {
        throw createCredentialGroupError(
            'CREDENTIAL_GROUP_REVISION_CONFLICT',
            'Credential group revision changed; create a new preview before applying',
            {
                expectedRevision: Number.isInteger(normalizedBaseRevision) ? normalizedBaseRevision : null,
                currentRevision: Number(store.currentRevision || 0)
            }
        );
    }
}

export function validateCredentialGroupSuggestion(suggestion, options = {}) {
    if (!suggestion || suggestion.applicable === false || !Array.isArray(suggestion.groups)) {
        throw createCredentialGroupError(
            'CREDENTIAL_GROUP_SUGGESTION_NOT_APPLICABLE',
            'Credential group suggestion is not applicable'
        );
    }

    const credentials = Array.isArray(options.credentials) ? options.credentials : [];
    const credentialByUuid = new Map();
    for (const credential of credentials) {
        const uuid = getCredentialUuid(credential);
        if (!uuid) continue;
        if (credentialByUuid.has(String(uuid))) {
            throw createCredentialGroupError(
                'INVALID_CREDENTIAL_GROUP_CONFIG',
                'Credential catalog contains an ambiguous UUID',
                { reason: 'DUPLICATE_CREDENTIAL_UUID' }
            );
        }
        credentialByUuid.set(String(uuid), credential);
    }

    const knownKeyIds = new Set(
        (Array.isArray(options.keys) ? options.keys : (Array.isArray(options.keyIds) ? options.keyIds : []))
            .map(key => String(key?.id || key?.keyId || key || ''))
            .filter(Boolean)
    );
    const groups = suggestion.groups.map(normalizeGroup);
    const groupIds = new Set();
    const assignedCredentialUuids = new Set();

    for (const group of groups) {
        if (!group.id || groupIds.has(group.id)) {
            throw createCredentialGroupError(
                'INVALID_CREDENTIAL_GROUP_CONFIG',
                'Credential group IDs must be unique',
                { reason: group.id ? 'DUPLICATE_GROUP_ID' : 'GROUP_ID_REQUIRED' }
            );
        }
        groupIds.add(group.id);

        if (!group.manualLock && group.credentialUuids.length > MAX_CREDENTIALS_PER_GROUP) {
            throw createCredentialGroupError(
                'INVALID_CREDENTIAL_GROUP_CONFIG',
                `Automatic credential groups may contain at most ${MAX_CREDENTIALS_PER_GROUP} credentials`,
                { reason: 'GROUP_EXCEEDS_MAX_SIZE' }
            );
        }

        for (const uuid of group.credentialUuids) {
            const credential = credentialByUuid.get(uuid);
            if (!credential) {
                throw createCredentialGroupError(
                    'INVALID_CREDENTIAL_GROUP_CONFIG',
                    'Credential group references an unavailable credential',
                    { reason: 'CREDENTIAL_NOT_FOUND' }
                );
            }
            if (!isCodexProviderType(getCredentialProviderType(credential))) {
                throw createCredentialGroupError(
                    'INVALID_CREDENTIAL_GROUP_CONFIG',
                    'Credential group references a non-Codex credential',
                    { reason: 'CREDENTIAL_PROVIDER_TYPE_INVALID' }
                );
            }
            if (assignedCredentialUuids.has(uuid)) {
                throw createCredentialGroupError(
                    'INVALID_CREDENTIAL_GROUP_CONFIG',
                    'A credential may belong to only one credential group',
                    { reason: 'CREDENTIAL_ASSIGNED_TO_MULTIPLE_GROUPS' }
                );
            }
            assignedCredentialUuids.add(uuid);
        }
    }

    const keyAssignments = (suggestion.keyAssignments || []).map(normalizeKeyAssignment);
    const assignedKeyIds = new Set();
    for (const assignment of keyAssignments) {
        if (!assignment.keyId || !knownKeyIds.has(assignment.keyId)) {
            throw createCredentialGroupError(
                'INVALID_CREDENTIAL_GROUP_CONFIG',
                'Credential group assignment references an unavailable Key',
                { reason: assignment.keyId ? 'KEY_NOT_FOUND' : 'KEY_ID_REQUIRED' }
            );
        }
        if (assignedKeyIds.has(assignment.keyId)) {
            throw createCredentialGroupError(
                'INVALID_CREDENTIAL_GROUP_CONFIG',
                'A Key may have only one credential routing assignment',
                { reason: 'DUPLICATE_KEY_ASSIGNMENT' }
            );
        }
        assignedKeyIds.add(assignment.keyId);

        if (assignment.routingMode === 'auto') {
            if (!assignment.primaryGroupId || !groupIds.has(String(assignment.primaryGroupId))) {
                throw createCredentialGroupError(
                    'INVALID_CREDENTIAL_GROUP_CONFIG',
                    'Automatic Key routing must reference an existing credential group',
                    { reason: 'GROUP_NOT_FOUND' }
                );
            }
            continue;
        }

        if (assignment.routingMode === 'pool') continue;

        const fixed = assignment.fixedCredential;
        const credential = fixed?.uuid ? credentialByUuid.get(String(fixed.uuid)) : null;
        if (!credential) {
            throw createCredentialGroupError(
                'INVALID_CREDENTIAL_GROUP_CONFIG',
                'Fixed Key routing references an unavailable credential',
                { reason: 'FIXED_CREDENTIAL_NOT_FOUND' }
            );
        }
        if (
            !isCodexProviderType(fixed.providerType)
            || getCredentialProviderType(credential) !== fixed.providerType
        ) {
            throw createCredentialGroupError(
                'INVALID_CREDENTIAL_GROUP_CONFIG',
                'Fixed Key routing references the wrong provider type',
                { reason: 'FIXED_CREDENTIAL_PROVIDER_TYPE_INVALID' }
            );
        }
    }

    return {
        ...cloneJson(suggestion),
        groups,
        keyAssignments
    };
}

export function calculateTargetGroupCount(healthyCredentialCount) {
    return Math.max(0, Math.ceil(toFiniteNumber(healthyCredentialCount, 0) / MAX_CREDENTIALS_PER_GROUP));
}

export function calculateCredentialCapacity(credential = {}) {
    const explicitWeight = toPositiveNumber(credential.providerWeight ?? credential.weight);
    const providerWeight = explicitWeight ?? 1;
    const fiveHourRemainingRatio = normalizeRemainingRatio(
        credential.fiveHourRemainingRatio
        ?? credential.shortWindowRemainingRatio
        ?? credential.quota?.fiveHourRemainingRatio
        ?? credential.quota?.shortRemainingRatio
    );
    const weeklyRemainingRatio = normalizeRemainingRatio(
        credential.weeklyRemainingRatio
        ?? credential.quota?.weeklyRemainingRatio
    );
    const knownRatios = [fiveHourRemainingRatio, weeklyRemainingRatio].filter(value => value !== null);

    if (knownRatios.length === 0) {
        return {
            providerWeight,
            quotaFactor: explicitWeight === null ? DEFAULT_UNKNOWN_CAPACITY : 1,
            capacity: explicitWeight === null ? DEFAULT_UNKNOWN_CAPACITY : providerWeight,
            confidence: 'low',
            fiveHourRemainingRatio,
            weeklyRemainingRatio
        };
    }

    const quotaFactor = Math.min(...knownRatios);
    return {
        providerWeight,
        quotaFactor,
        capacity: providerWeight * quotaFactor,
        confidence: knownRatios.length === 2 ? 'high' : 'low',
        fiveHourRemainingRatio,
        weeklyRemainingRatio
    };
}

export function summarizeKeyDemand(key = {}, options = {}) {
    const days = Math.max(1, Math.floor(toFiniteNumber(options.days, DEFAULT_HISTORY_DAYS)));
    const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const { startDate, endDate } = getCompleteDateRange(now, days, timeZone);
    let actualUsd = 0;
    let estimatedUsd = 0;
    let missingPriceTokens = 0;
    let estimatedPriceTokens = 0;
    let totalTokens = 0;
    let requestCount = 0;

    for (const [date, day] of Object.entries(key.usageHistory || {})) {
        if (date < startDate || date > endDate) continue;
        const compactDemand = day?.demand && typeof day.demand === 'object' ? day.demand : null;
        if (compactDemand) {
            actualUsd += toFiniteNumber(compactDemand.actualUsd, 0);
            estimatedUsd += toFiniteNumber(compactDemand.estimatedUsd, 0);
            missingPriceTokens += toFiniteNumber(compactDemand.missingPriceTokens, 0);
            estimatedPriceTokens += toFiniteNumber(compactDemand.estimatedPriceTokens, 0);
            totalTokens += toFiniteNumber(compactDemand.totalTokens, 0);
            requestCount += toFiniteNumber(compactDemand.requestCount, 0);
            continue;
        }
        const models = day?.models && typeof day.models === 'object' ? day.models : {};
        for (const [modelName, modelUsage] of Object.entries(models)) {
            if (!String(modelName || '').toLowerCase().startsWith('gpt-')) continue;
            const usage = modelUsage && typeof modelUsage === 'object' ? modelUsage : {};
            const cost = usage.cost && typeof usage.cost === 'object' ? usage.cost : {};
            actualUsd += toFiniteNumber(cost.actualUsd, 0);
            estimatedUsd += toFiniteNumber(cost.estimatedUsd, 0);
            missingPriceTokens += toFiniteNumber(cost.missingPriceTokens, 0);
            estimatedPriceTokens += toFiniteNumber(cost.estimatedPriceTokens, 0);
            totalTokens += toFiniteNumber(usage.totalTokens, 0);
            requestCount += toFiniteNumber(usage.requestCount, 0);
        }
    }

    let metric = 'newKey';
    let totalDemand = 0;
    const usd = actualUsd + estimatedUsd;
    if (usd > 0) {
        metric = 'usd';
        totalDemand = usd;
    } else if (totalTokens > 0) {
        metric = 'totalTokens';
        totalDemand = totalTokens;
    } else if (requestCount > 0) {
        metric = 'requestCount';
        totalDemand = requestCount;
    }

    return {
        startDate,
        endDate,
        timeZone,
        days,
        usd,
        actualUsd,
        estimatedUsd,
        missingPriceTokens,
        estimatedPriceTokens,
        pricingCoverage: totalTokens > 0
            ? Math.max(0, Math.min(1, (totalTokens - missingPriceTokens) / totalTokens))
            : 1,
        totalTokens,
        requestCount,
        metric,
        totalDemand,
        isNew: totalDemand === 0,
        demandModelFilter: DEMAND_MODEL_FILTER,
        demandModelFilterCaseSensitive: DEMAND_MODEL_FILTER_CASE_SENSITIVE
    };
}

function chooseGroupForCredential(groups) {
    const assignableGroups = groups.filter(group => !group.manualLock && group.credentialUuids.length < MAX_CREDENTIALS_PER_GROUP);
    return assignableGroups.reduce((best, group) => {
        if (!best) return group;
        if (group.credentialUuids.length !== best.credentialUuids.length) {
            return group.credentialUuids.length < best.credentialUuids.length ? group : best;
        }
        if (group.capacity !== best.capacity) return group.capacity < best.capacity ? group : best;
        return group._index < best._index ? group : best;
    }, null);
}

export function resolveKeyRoutingAssignment(keyData = {}, currentConfig = {}) {
    const keyId = keyData?.id || keyData?.keyId ? String(keyData.id || keyData.keyId) : '';
    const storedAssignment = keyId
        ? (currentConfig.keyAssignments || []).find(assignment => String(assignment?.keyId || assignment?.id || '') === keyId)
        : null;

    if (storedAssignment) {
        return {
            ...normalizeKeyAssignment(storedAssignment),
            keyId,
            routingConfigSource: 'credential-groups'
        };
    }

    if (keyData.routingMode === 'fixed') {
        return { ...normalizeKeyAssignment(keyData), keyId, routingConfigSource: 'key-data', assignmentMissing: true };
    }
    if (keyData.routingMode === 'pool') {
        return { keyId, routingMode: 'pool', primaryGroupId: null, fixedCredential: null, routingConfigSource: 'key-data', assignmentMissing: true };
    }
    if (keyData.routingMode === 'auto' && keyData.primaryGroupId) {
        return { ...normalizeKeyAssignment(keyData), keyId, routingConfigSource: 'key-data', assignmentMissing: true };
    }
    return { keyId, routingMode: 'pool', primaryGroupId: null, fixedCredential: null, routingConfigSource: 'default', assignmentMissing: true };
}

export function diagnoseKeyRouting({ keyData = {}, currentConfig = {}, credentials = [] } = {}) {
    const routing = resolveKeyRoutingAssignment(keyData, currentConfig);
    const route = routeKeyToCredentialCandidates({
        keyRouting: routing,
        groups: currentConfig.groups || [],
        credentials
    });
    return {
        keyId: routing.keyId || null,
        routingMode: routing.routingMode,
        routingConfigSource: routing.routingConfigSource || 'default',
        assignmentMissing: routing.assignmentMissing === true,
        primaryGroupId: routing.primaryGroupId || null,
        selectedGroupId: route.selectedGroupId || null,
        errorCode: route.errorCode || null,
        routeReason: route.routeReason || null,
        nextRecoveryTime: route.nextRecoveryTime || null,
        fixedCredential: routing.routingMode === 'fixed' && routing.fixedCredential?.uuid
            ? {
                providerType: routing.fixedCredential.providerType || 'openai-codex-oauth',
                credentialUuid: routing.fixedCredential.uuid,
                configured: true,
                inGroup: Boolean(route.selectedGroupId),
                candidateAvailable: route.candidateProviderUuids.length === 1
            }
            : null
    };
}

function chooseGroupForKey(groups, demandUnits) {
    return groups.reduce((best, group) => {
        const capacity = group.capacity > 0 ? group.capacity : DEFAULT_UNKNOWN_CAPACITY;
        const predictedUtilization = (group._assignedDemand + demandUnits) / capacity;
        if (!best || predictedUtilization < best.predictedUtilization) {
            return { group, predictedUtilization };
        }
        if (predictedUtilization === best.predictedUtilization && group._index < best.group._index) {
            return { group, predictedUtilization };
        }
        return best;
    }, null)?.group || null;
}

function findCurrentCredentialGroupId(currentGroups, uuid) {
    return currentGroups.find(group => group.credentialUuids.includes(uuid))?.id || null;
}

function selectDemandMetric(demands) {
    if (demands.some(item => item.demand.usd > 0)) return 'usd';
    if (demands.some(item => item.demand.totalTokens > 0)) return 'totalTokens';
    if (demands.some(item => item.demand.requestCount > 0)) return 'requestCount';
    return 'newKey';
}

function demandValueForMetric(demand, metric) {
    if (metric === 'usd') return demand.usd;
    if (metric === 'totalTokens') return demand.totalTokens;
    if (metric === 'requestCount') return demand.requestCount;
    return 0;
}

function markHighConsumption(demands, metric) {
    const positive = demands.map(item => demandValueForMetric(item.demand, metric)).filter(value => value > 0).sort((a, b) => a - b);
    if (positive.length < 2) return new Set();
    const median = positive[Math.floor((positive.length - 1) / 2)];
    const average = positive.reduce((sum, value) => sum + value, 0) / positive.length;
    const threshold = Math.max(median * 2, average * 1.5);
    return new Set(demands
        .filter(item => demandValueForMetric(item.demand, metric) >= threshold)
        .map(item => item.keyId));
}

export function generateCredentialGroupSuggestion(options = {}) {
    const credentials = (options.credentials || [])
        .filter(credential => getCredentialUuid(credential) && isCredentialRouteAvailable(credential));
    const targetGroupCount = calculateTargetGroupCount(credentials.length);
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const currentGroups = (options.currentConfig?.groups || []).map(normalizeGroup);
    const currentAssignments = new Map(
        (options.currentConfig?.keyAssignments || []).map(assignment => {
            const normalized = normalizeKeyAssignment(assignment);
            return [normalized.keyId, normalized];
        })
    );

    const oversizedManualGroups = currentGroups.filter(group => (
        group.manualLock && group.credentialUuids.length > MAX_CREDENTIALS_PER_GROUP
    ));
    if (oversizedManualGroups.length > 0) {
        return {
            applicable: false,
            reason: 'MANUAL_GROUP_EXCEEDS_MAX_SIZE',
            generatedAt: now.toISOString(),
            groupCount: currentGroups.length,
            healthyCredentialCount: credentials.length,
            groups: currentGroups,
            keyAssignments: [],
            anomalies: oversizedManualGroups.map(group => ({
                groupId: group.id,
                reason: 'MANUAL_GROUP_EXCEEDS_MAX_SIZE',
                credentialCount: group.credentialUuids.length
            }))
        };
    }

    if (targetGroupCount === 0) {
        return {
            applicable: false,
            reason: 'NO_HEALTHY_CREDENTIALS',
            generatedAt: now.toISOString(),
            groupCount: 0,
            groups: [],
            keyAssignments: []
        };
    }

    const lockedGroupIds = new Set(
        currentGroups
            .filter(group => group.manualLock || group.credentialUuids.some(uuid => (
                credentials.find(credential => getCredentialUuid(credential) === uuid)?.manualLock === true
            )))
            .map(group => group.id)
    );
    for (const assignment of currentAssignments.values()) {
        if (assignment.manualLock && assignment.primaryGroupId) lockedGroupIds.add(assignment.primaryGroupId);
    }
    const groupCount = Math.max(targetGroupCount, lockedGroupIds.size);
    const groups = [];
    const usedIds = new Set();
    for (let index = 0; index < groupCount; index += 1) {
        const current = currentGroups[index];
        let id = current?.id || `group-${index + 1}`;
        while (usedIds.has(id)) id = `${id}-${index + 1}`;
        usedIds.add(id);
        groups.push({
            id,
            name: current?.name || `凭据组 ${index + 1}`,
            manualLock: current?.manualLock === true,
            credentialUuids: [],
            capacity: 0,
            confidence: 'high',
            _index: index,
            _assignedDemand: 0
        });
    }

    const groupById = new Map(groups.map(group => [group.id, group]));
    const assignedCredentials = new Set();
    const credentialByUuid = new Map(credentials.map(credential => [getCredentialUuid(credential), credential]));

    for (const currentGroup of currentGroups) {
        const target = groupById.get(currentGroup.id);
        if (!target) continue;
        for (const uuid of currentGroup.credentialUuids) {
            const credential = credentialByUuid.get(uuid);
            if (!credential || assignedCredentials.has(uuid)) continue;
            if (currentGroup.manualLock || credential.manualLock === true) {
                target.credentialUuids.push(uuid);
                assignedCredentials.add(uuid);
            }
        }
    }

    const assignableCredentials = credentials
        .filter(credential => !assignedCredentials.has(getCredentialUuid(credential)))
        .sort((a, b) => {
            const capacityDifference = calculateCredentialCapacity(b).capacity - calculateCredentialCapacity(a).capacity;
            if (capacityDifference !== 0) return capacityDifference;
            return String(getCredentialUuid(a)).localeCompare(String(getCredentialUuid(b)));
        });

    for (const credential of assignableCredentials) {
        const uuid = getCredentialUuid(credential);
        const lockedGroupId = credential.manualLock === true
            ? findCurrentCredentialGroupId(currentGroups, uuid)
            : null;
        const target = groupById.get(lockedGroupId) || chooseGroupForCredential(groups);
        if (!target || target.credentialUuids.length >= MAX_CREDENTIALS_PER_GROUP) {
            return {
                applicable: false,
                reason: 'GROUP_CAPACITY_EXCEEDED',
                generatedAt: now.toISOString(),
                groupCount: groups.length,
                healthyCredentialCount: credentials.length,
                groups: groups.map(group => ({ ...group, _index: undefined, _assignedDemand: undefined })),
                keyAssignments: [],
                anomalies: [{ reason: 'GROUP_CAPACITY_EXCEEDED' }]
            };
        }
        target.credentialUuids.push(uuid);
        assignedCredentials.add(uuid);
        const capacity = calculateCredentialCapacity(credential);
        target.capacity += capacity.capacity;
        if (capacity.confidence !== 'high') target.confidence = 'low';
    }

    for (const group of groups) {
        group.capacity = 0;
        group.confidence = 'high';
        for (const uuid of group.credentialUuids) {
            const capacity = calculateCredentialCapacity(credentialByUuid.get(uuid) || {});
            group.capacity += capacity.capacity;
            if (capacity.confidence !== 'high') group.confidence = 'low';
        }
    }

    const demands = (options.keys || []).map(key => ({
        key,
        keyId: String(key.id || key.keyId || ''),
        demand: summarizeKeyDemand(key, {
            now,
            days: options.days || DEFAULT_HISTORY_DAYS,
            timeZone: options.timeZone || DEFAULT_TIME_ZONE
        })
    })).filter(item => item.keyId);
    const demandMetric = selectDemandMetric(demands);
    const highConsumptionKeyIds = markHighConsumption(demands, demandMetric);
    const assignments = [];

    for (const item of demands) {
        const current = currentAssignments.get(item.keyId);
        const manualLock = item.key.manualLock === true || current?.manualLock === true;
        if (!manualLock) continue;
        const normalized = normalizeKeyAssignment({
            ...current,
            ...item.key,
            keyId: item.keyId,
            manualLock: true
        });
        const targetGroup = normalized.routingMode === 'auto' ? groupById.get(normalized.primaryGroupId) : null;
        const demandUnits = item.demand.isNew ? 1 : demandValueForMetric(item.demand, demandMetric);
        if (targetGroup) targetGroup._assignedDemand += demandUnits;
        assignments.push({
            ...normalized,
            demand: item.demand,
            highConsumption: highConsumptionKeyIds.has(item.keyId)
        });
    }

    const unlockedDemands = demands
        .filter(item => !assignments.some(assignment => assignment.keyId === item.keyId))
        .sort((a, b) => demandValueForMetric(b.demand, demandMetric) - demandValueForMetric(a.demand, demandMetric)
            || a.keyId.localeCompare(b.keyId));

    for (const item of unlockedDemands) {
        const existing = currentAssignments.get(item.keyId);
        const routingMode = item.key.routingMode === 'fixed' || existing?.routingMode === 'fixed'
            ? 'fixed'
            : item.key.routingMode === 'pool' || existing?.routingMode === 'pool'
                ? 'pool'
                : 'auto';
        if (routingMode === 'fixed') {
            assignments.push({
                ...normalizeKeyAssignment({ ...existing, ...item.key, keyId: item.keyId, routingMode: 'fixed' }),
                demand: item.demand,
                highConsumption: highConsumptionKeyIds.has(item.keyId)
            });
            continue;
        }

        if (routingMode === 'pool') {
            assignments.push({
                ...normalizeKeyAssignment({ ...existing, ...item.key, keyId: item.keyId, routingMode: 'pool' }),
                demand: item.demand,
                highConsumption: highConsumptionKeyIds.has(item.keyId)
            });
            continue;
        }

        const demandUnits = item.demand.isNew ? 1 : demandValueForMetric(item.demand, demandMetric);
        const target = chooseGroupForKey(groups, demandUnits);
        target._assignedDemand += demandUnits;
        assignments.push({
            keyId: item.keyId,
            routingMode: 'auto',
            primaryGroupId: target.id,
            fixedCredential: null,
            manualLock: false,
            demand: item.demand,
            highConsumption: highConsumptionKeyIds.has(item.keyId)
        });
    }

    const totalAssignedDemand = groups.reduce((sum, group) => sum + group._assignedDemand, 0);
    const totalCapacity = groups.reduce((sum, group) => sum + Math.max(0, group.capacity), 0);
    const publicGroups = groups.map(group => {
        const demandShare = totalAssignedDemand > 0 ? group._assignedDemand / totalAssignedDemand : 0;
        const capacityShare = totalCapacity > 0 ? Math.max(0, group.capacity) / totalCapacity : 0;
        return {
        id: group.id,
        name: group.name,
        manualLock: group.manualLock,
        credentialUuids: group.credentialUuids,
        capacity: group.capacity,
        confidence: group.confidence,
        predictedDemand: group._assignedDemand,
        predictedDemandUsd: demandMetric === 'usd' ? group._assignedDemand : null,
        predictedDemandUsdAvailable: demandMetric === 'usd',
        demandShare,
        capacityShare,
        loadIndex: capacityShare > 0 ? demandShare / capacityShare : 0,
        predictedUtilization: group._assignedDemand / (group.capacity > 0 ? group.capacity : DEFAULT_UNKNOWN_CAPACITY)
    };
    });

    return {
        applicable: true,
        generatedAt: now.toISOString(),
        demandMetric,
        demandModelFilter: DEMAND_MODEL_FILTER,
        demandModelFilterCaseSensitive: DEMAND_MODEL_FILTER_CASE_SENSITIVE,
        timeZone: options.timeZone || DEFAULT_TIME_ZONE,
        historyDays: options.days || DEFAULT_HISTORY_DAYS,
        groupCount: publicGroups.length,
        healthyCredentialCount: credentials.length,
        groups: publicGroups,
        keyAssignments: assignments.sort((a, b) => a.keyId.localeCompare(b.keyId))
    };
}

export function routeKeyToCredentialCandidates(options = {}) {
    const keyRouting = normalizeKeyAssignment({
        ...(options.keyRouting || {}),
        keyId: options.keyRouting?.keyId || 'request-key'
    });
    const groups = (options.groups || []).map(normalizeGroup);
    const credentials = options.credentials || [];
    const availableByUuid = new Map(
        credentials
            .filter(isCredentialRouteAvailable)
            .map(credential => [getCredentialUuid(credential), credential])
    );

    if (keyRouting.routingMode === 'pool') {
        return {
            routingMode: 'pool',
            requestedPrimaryGroupId: null,
            selectedGroupId: null,
            candidateProviderUuids: [...availableByUuid.keys()],
            fallbackProviderUuids: [],
            spillover: false,
            spilloverReason: null,
            errorCode: null
        };
    }

    if (keyRouting.routingMode === 'fixed') {
        const fixed = keyRouting.fixedCredential;
        const allByUuid = new Map(
            credentials
                .filter(credential => getCredentialUuid(credential))
                .map(credential => [getCredentialUuid(credential), credential])
        );
        const credential = fixed?.uuid ? allByUuid.get(fixed.uuid) : null;
        const providerTypeMatches = credential
            && (!fixed.providerType || getCredentialProviderType(credential) === fixed.providerType);
        if (!credential) {
            return {
                routingMode: 'fixed',
                selectedGroupId: null,
                candidateProviderUuids: [],
                fallbackProviderUuids: [],
                spillover: false,
                errorCode: 'ROUTE_MISMATCH',
                routeReason: 'FIXED_CREDENTIAL_NOT_FOUND'
            };
        }
        if (!providerTypeMatches) {
            return {
                routingMode: 'fixed',
                selectedGroupId: null,
                candidateProviderUuids: [],
                fallbackProviderUuids: [],
                spillover: false,
                errorCode: 'ROUTE_MISMATCH',
                routeReason: 'FIXED_PROVIDER_TYPE_MISMATCH'
            };
        }
        const selectedGroupId = groups.find(group => group.credentialUuids.includes(fixed.uuid))?.id || null;
        if (!selectedGroupId) {
            return {
                routingMode: 'fixed',
                selectedGroupId: null,
                candidateProviderUuids: [],
                fallbackProviderUuids: [],
                spillover: false,
                errorCode: 'ROUTE_MISMATCH',
                routeReason: 'FIXED_CREDENTIAL_NOT_IN_GROUP'
            };
        }
        if (!availableByUuid.has(fixed.uuid)) {
            return {
                routingMode: 'fixed',
                selectedGroupId,
                candidateProviderUuids: [],
                fallbackProviderUuids: [],
                spillover: false,
                errorCode: 'FIXED_CREDENTIAL_UNAVAILABLE',
                routeReason: 'FIXED_CREDENTIAL_NOT_HEALTHY',
                nextRecoveryTime: credential.scheduledRecoveryTime || credential.config?.scheduledRecoveryTime || null
            };
        }
        return {
            routingMode: 'fixed',
            selectedGroupId,
            candidateProviderUuids: [fixed.uuid],
            fallbackProviderUuids: [],
            spillover: false,
            errorCode: null
        };
    }

    const primaryGroup = groups.find(group => group.id === keyRouting.primaryGroupId) || groups[0] || null;
    const primaryCandidates = (primaryGroup?.credentialUuids || []).filter(uuid => availableByUuid.has(uuid));
    if (primaryCandidates.length > 0) {
        const fallbackProviderUuids = groups
            .filter(group => group.id !== primaryGroup.id)
            .flatMap(group => group.credentialUuids)
            .filter(uuid => availableByUuid.has(uuid));
        return {
            routingMode: 'auto',
            requestedPrimaryGroupId: keyRouting.primaryGroupId || primaryGroup.id,
            selectedGroupId: primaryGroup.id,
            candidateProviderUuids: primaryCandidates,
            fallbackProviderUuids,
            spillover: false,
            spilloverReason: null,
            errorCode: null
        };
    }

    for (const group of groups) {
        if (group.id === primaryGroup?.id) continue;
        const candidates = group.credentialUuids.filter(uuid => availableByUuid.has(uuid));
        if (candidates.length > 0) {
            return {
                routingMode: 'auto',
                requestedPrimaryGroupId: keyRouting.primaryGroupId || primaryGroup?.id || null,
                selectedGroupId: group.id,
                candidateProviderUuids: candidates,
                fallbackProviderUuids: groups
                    .filter(candidateGroup => candidateGroup.id !== group.id)
                    .flatMap(candidateGroup => candidateGroup.credentialUuids)
                    .filter(uuid => availableByUuid.has(uuid)),
                spillover: true,
                spilloverReason: 'PRIMARY_GROUP_UNAVAILABLE',
                errorCode: null
            };
        }
    }

    return {
        routingMode: 'auto',
        requestedPrimaryGroupId: keyRouting.primaryGroupId || primaryGroup?.id || null,
        selectedGroupId: null,
        candidateProviderUuids: [],
        fallbackProviderUuids: [],
        spillover: false,
        spilloverReason: null,
        errorCode: 'NO_CREDENTIAL_AVAILABLE'
    };
}

export class CredentialGroupService {
    constructor(options = {}) {
        this.filePath = options.filePath
            || process.env.CODEX_CREDENTIAL_GROUPS_FILE_PATH
            || path.join(process.cwd(), 'configs', 'codex-credential-groups.json');
        this.now = typeof options.now === 'function' ? options.now : () => new Date();
    }

    readStoreSync() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            const store = {
                ...defaultStore(),
                ...parsed,
                revisions: Array.isArray(parsed.revisions) ? parsed.revisions : []
            };
            const compacted = compactRevisions(store);
            if (compacted.changed) this.writeStoreSync(store);
            return store;
        } catch (error) {
            if (error.code === 'ENOENT') return defaultStore();
            throw error;
        }
    }

    writeStoreSync(store) {
        currentConfigCache.delete(this.filePath);
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tempPath, this.filePath);
    }

    async writeStore(store) {
        currentConfigCache.delete(this.filePath);
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        await atomicWriteFile(this.filePath, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
    }

    async getCurrentConfig() {
        const cached = currentConfigCache.get(this.filePath);
        const stats = statStoreSync(this.filePath);
        if (cached && stats && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
            return cloneJson(cached.config);
        }

        const store = this.readStoreSync();
        const current = getRevision(store, store.currentRevision);
        const config = current
            ? { ...cloneJson(current.config), revision: current.revision, action: current.action }
            : { revision: 0, action: null, groups: [], keyAssignments: [] };

        // readStoreSync may have rewritten the file while compacting revisions,
        // so the identity has to be re-read rather than reused from above.
        const persisted = statStoreSync(this.filePath);
        if (persisted) {
            currentConfigCache.set(this.filePath, { ...persisted, config: cloneJson(config) });
        }
        return config;
    }

    async updateKeyAssignment(keyId, routing = {}) {
        const current = await this.getCurrentConfig();
        const normalized = normalizeKeyAssignment({ ...routing, keyId });
        const keyAssignments = (current.keyAssignments || [])
            .filter(assignment => String(assignment?.keyId || assignment?.id || '') !== String(keyId));
        keyAssignments.push(normalized);

        return this.apply({
            applicable: true,
            ...current,
            keyAssignments,
            generatedAt: this.now().toISOString()
        }, {
            action: 'key-routing-update',
            baseRevision: current.revision
        });
    }

    /**
     * Return revision metadata for management UIs without exposing the
     * revision's credential/key assignments or any future sensitive fields.
     */
    async listRevisions(options = {}) {
        const store = this.readStoreSync();
        const requestedLimit = Number(options.limit);
        const limit = Number.isFinite(requestedLimit)
            ? Math.max(1, Math.min(100, Math.floor(requestedLimit)))
            : 50;

        return (store.revisions || [])
            .slice(-limit)
            .reverse()
            .map(entry => ({
                revision: entry.revision,
                action: entry.action || 'apply',
                createdAt: entry.createdAt || null,
                previousRevision: entry.previousRevision || null,
                sourceRevision: entry.sourceRevision || null,
                groupCount: Array.isArray(entry.config?.groups) ? entry.config.groups.length : 0,
                assignmentCount: Array.isArray(entry.config?.keyAssignments)
                    ? entry.config.keyAssignments.length
                    : 0,
                isCurrent: entry.revision === store.currentRevision
            }));
    }

    async apply(suggestion, options = {}) {
        if (!suggestion || suggestion.applicable === false || !Array.isArray(suggestion.groups)) {
            const error = new Error('Credential group suggestion is not applicable');
            error.code = 'CREDENTIAL_GROUP_SUGGESTION_NOT_APPLICABLE';
            throw error;
        }
        const store = this.readStoreSync();
        assertBaseRevision(store, options.baseRevision);
        const revision = toFiniteNumber(store.currentRevision, 0) + 1;
        const config = {
            groups: suggestion.groups.map(normalizeGroup),
            keyAssignments: (suggestion.keyAssignments || []).map(normalizeKeyAssignment),
            generatedAt: suggestion.generatedAt || null,
            timeZone: suggestion.timeZone || DEFAULT_TIME_ZONE,
            historyDays: suggestion.historyDays || DEFAULT_HISTORY_DAYS,
            demandModelFilter: suggestion.demandModelFilter || DEMAND_MODEL_FILTER,
            demandModelFilterCaseSensitive: suggestion.demandModelFilterCaseSensitive === true
        };
        const entry = {
            revision,
            action: options.action || 'apply',
            createdAt: this.now().toISOString(),
            previousRevision: store.currentRevision || null,
            sourceRevision: options.sourceRevision || null,
            config
        };
        store.version = STORE_VERSION;
        store.currentRevision = revision;
        store.revisions.push(entry);
        compactRevisions(store);
        await this.writeStore(store);
        return cloneJson(entry);
    }

    async getRollbackTarget(options = {}) {
        const store = this.readStoreSync();
        assertBaseRevision(store, options.baseRevision);
        const current = getRevision(store, store.currentRevision);
        const targetRevision = current?.previousRevision;
        const target = targetRevision ? getRevision(store, targetRevision) : null;
        if (!target) {
            const error = new Error('No previous credential group revision is available');
            error.code = 'NO_CREDENTIAL_GROUP_REVISION_TO_ROLLBACK';
            throw error;
        }
        return cloneJson(target);
    }

    async rollback(options = {}) {
        const target = await this.getRollbackTarget(options);
        return this.apply({
            applicable: true,
            ...cloneJson(target.config)
        }, {
            action: 'rollback',
            sourceRevision: target.revision,
            baseRevision: options.baseRevision
        });
    }
}
