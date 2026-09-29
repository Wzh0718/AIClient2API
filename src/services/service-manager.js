import { getServiceAdapter, invalidateServiceAdapter, serviceInstances } from '../providers/adapter.js';
import logger from '../utils/logger.js';
import {
    ProviderPoolManager,
    getCodexModelFallbackTarget
} from '../providers/provider-pool-manager.js';
import deepmerge from 'deepmerge';
import crypto from 'crypto';
import * as fs from 'fs';
import { promises as pfs } from 'fs';
import * as path from 'path';
import {
    PROVIDER_MAPPINGS,
    createProviderConfig,
    addToUsedPaths,
    isPathUsed,
    getFileName,
    formatSystemPath
} from '../utils/provider-utils.js';
import { readCodexCredentialDisplayName, readCodexCredentialIdentity } from '../utils/codex-utils.js';
import { withFileLock, atomicWriteFile } from '../utils/file-lock.js';
import { MODEL_PROVIDER } from '../utils/constants.js';
import { getProviderModels } from '../providers/provider-models.js';
import { codexOverloadFailoverStore } from '../providers/openai/codex-overload-failover.js';
import { codexCredentialGroupAffinityStore } from '../providers/openai/codex-credential-group-affinity.js';
import { readGeminiCredentialEmail } from '../utils/gemini-account.js';
import { normalizeCodexFingerprintProviderConfig } from '../utils/codex-fingerprint-migration.js';
import { CredentialGroupService, resolveKeyRoutingAssignment, routeKeyToCredentialCandidates } from './codex-credential-group-service.js';
import { getCodexRoutingConsistencyStatus } from './codex-routing-integrity.js';
import { resolveCodexEntryModel } from '../providers/openai/codex-model-routing.js';
import { performance } from 'node:perf_hooks';
import { runtimeMetrics } from '../runtime/runtime-metrics.js';
import requestContext, { accumulateRoutingWait, computeSelectionStages } from '../utils/context.js';
import { PotluckKeyConcurrencyLimiter } from '../plugins/api-potluck/key-concurrency-limiter.js';
import { buildGeminiSelectionDiagnostic } from '../utils/gemini-diagnostics.js';

// 瀛樺偍 ProviderPoolManager 瀹炰緥
let providerPoolManager = null;
const potluckKeyConcurrencyLimiter = new PotluckKeyConcurrencyLimiter({
    onEvent: event => logger.info(`[Potluck Key Concurrency] ${event.event} key=${event.keyId} active=${event.active ?? 0} waiting=${event.waiting ?? 0}`)
});

function isCodexModelFallbackEligibleError(error) {
    if (!error) return false;
    if (error.code === 'POTLUCK_KEY_CONCURRENCY_LIMIT') return false;
    if (error.status === 401 || error.status === 403 || error.status >= 500 && error.status !== 503) return false;
    return error.status === 429
        || error.code === 429
        || error.code === 'FIXED_CREDENTIAL_UNAVAILABLE'
        || error.code === 'NO_CREDENTIAL_AVAILABLE'
        || /No healthy provider|unavailable|support.*model|model.*support/i.test(String(error.message || ''));
}

function isTruthyConfigFlag(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
}

function isCodexProviderType(providerType) {
    return providerType === MODEL_PROVIDER.CODEX_API || providerType?.startsWith(`${MODEL_PROVIDER.CODEX_API}-`);
}

function isGeminiProviderType(providerType) {
    return providerType === MODEL_PROVIDER.GEMINI_CLI || providerType === MODEL_PROVIDER.ANTIGRAVITY;
}

function logGeminiSelectionDiagnostic(providerType, requestedModel, selectionDiagnostics, selectedProvider, startedAt, config = null) {
    if (!isGeminiProviderType(providerType)) return;
    try {
        if (selectionDiagnostics && typeof selectionDiagnostics === 'object' && !selectionDiagnostics.sourceAvailability) {
            selectionDiagnostics.sourceAvailability =
                requestContext.getStore()?.antigravityRouting?.sourceAvailability || null;
        }
        const event = buildGeminiSelectionDiagnostic({
            workerId: process.env.RUNTIME_WORKER_ID || 'standalone',
            providerType,
            requestedModel,
            selectionDiagnostics,
            selectedProvider,
            durationMs: performance.now() - startedAt
        });
        if (config) config._geminiSelectionDiagnostic = event;
        logger.info(`[Gemini Diagnostics] ${JSON.stringify(event)}`);
    } catch {
        // Diagnostics must never change request behavior.
    }
}

async function getGeminiProviderEmail(providerType, credPath) {
    if (!isGeminiProviderType(providerType) || !credPath) return '';
    const absolutePath = path.isAbsolute(credPath) ? credPath : path.join(process.cwd(), credPath);
    return readGeminiCredentialEmail(absolutePath);
}

async function backfillGeminiProviderAccountNames(providers, providerType, credPathKey) {
    if (!isGeminiProviderType(providerType) || !Array.isArray(providers)) return 0;
    let updated = 0;
    for (const provider of providers) {
        if (!provider || (provider.accountEmail && provider.customName)) continue;
        const accountEmail = await getGeminiProviderEmail(providerType, provider[credPathKey]);
        if (!accountEmail) continue;
        if (!provider.accountEmail) provider.accountEmail = accountEmail;
        if (!String(provider.customName || '').trim()) provider.customName = accountEmail;
        updated += 1;
    }
    return updated;
}

function isSupportedCodexModel(providerType, model) {
    const models = getProviderModels(providerType);
    if (models.includes(model)) return true;
    return /-(?:fast|ultrafast)$/i.test(String(model || ''))
        && models.includes(String(model).replace(/-(?:fast|ultrafast)$/i, ''));
}

function hashAffinityScope(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

export function resolveCodexAffinityKey(config, providerType, requestedModel = null) {
    if (
        !isTruthyConfigFlag(config?.CODEX_POTLUCK_STICKY_PROVIDER_ENABLED) ||
        !config?.potluckApiKey ||
        !isCodexProviderType(providerType)
    ) {
        return null;
    }

    const scope = config._codexCacheAffinityScope || {};
    if (scope.promptCacheKey) {
        return { key: `prompt-cache:${hashAffinityScope(scope.promptCacheKey)}`, source: 'prompt_cache_key' };
    }
    if (scope.threadId) {
        return { key: `thread:${hashAffinityScope(scope.threadId)}`, source: 'thread_id' };
    }
    if (scope.sessionId) {
        return { key: `session:${hashAffinityScope(scope.sessionId)}`, source: 'session_id' };
    }
    if (scope.installationId) {
        return { key: `installation:${hashAffinityScope(scope.installationId)}:model:${requestedModel || ''}`, source: 'installation_id' };
    }

    return { key: `potluck:${hashAffinityScope(config.potluckApiKey)}:model:${requestedModel || ''}`, source: 'potluck_key' };
}

export function withStickyProviderAffinity(config, providerType, options = {}) {
    const selectionOptions = { ...options };
    if (selectionOptions.routingStrategy === 'image-round-robin') {
        delete selectionOptions.preferredProviderUuid;
        delete selectionOptions.stickyProviderKey;
        delete selectionOptions.stickyProviderSource;
        delete selectionOptions.shardDiscriminator;
        return selectionOptions;
    }
    if (!selectionOptions.stickyProviderKey) {
        const affinity = resolveCodexAffinityKey(config, providerType, options.requestedModel);
        if (affinity) {
            selectionOptions.stickyProviderKey = affinity.key;
            selectionOptions.stickyProviderSource = affinity.source;
            selectionOptions.shardDiscriminator = config._codexCacheAffinityScope?.turnId;
            config._codexRouting = {
                ...(config._codexRouting || {}),
                affinitySource: affinity.source,
                hotShardApplied: false
            };
        }
    }
    return selectionOptions;
}

const CODEX_ROUTING_DIAGNOSTIC_FIELDS = new Set([
    'routingMode',
    'requestedPrimaryGroupId',
    'selectedGroupId',
    'selectedProviderUuid',
    'restrictedCredentialUuids',
    'actualProviderGroupId',
    'providerSwitchCount',
    'modelFallbackFrom',
    'modelFallbackTo',
    'modelFallbackReason',
    'consistencyStatus',
    'spillover',
    'spilloverReason',
    'affinitySource',
    'hotShardApplied',
    'assignmentMissing',
    'keyQueueWaitMs',
    'keyQueueOutcome',
    'keyCapacityExhausted',
    'spilloverCause',
    'groupWaitMs',
    'groupRetryCount',
    'fallbackAttemptCount',
    'availabilityReason',
    'candidateGroupId',
    'candidateProviderCount',
    'unavailableProviderCount'
]);

function updateCodexRoutingDiagnostics(config, patch = {}) {
    const sanitizedPatch = {};
    for (const [key, value] of Object.entries(patch)) {
        if (CODEX_ROUTING_DIAGNOSTIC_FIELDS.has(key)) sanitizedPatch[key] = value;
    }
    config._codexRouting = {
        ...(config._codexRouting || {}),
        ...sanitizedPatch
    };
    return config._codexRouting;
}

function resolveCodexCredentialGroupAffinity(config, providerType) {
    if (!isCodexProviderType(providerType) || !config?.potluckKeyData?.id) return null;

    const scope = config._codexCacheAffinityScope || {};
    const candidates = [
        ['prompt_cache_key', scope.promptCacheKey],
        ['thread_id', scope.threadId],
        ['session_id', scope.sessionId],
        ['installation_id', scope.installationId]
    ];
    const selected = candidates.find(([, value]) => value !== undefined && value !== null && value !== '');
    if (!selected) return null;

    const [source, value] = selected;
    return {
        key: [
            'credential-group',
            hashAffinityScope(providerType),
            hashAffinityScope(config.potluckKeyData.id),
            source,
            hashAffinityScope(value)
        ].join(':'),
        source
    };
}

function initializeSelectionDiagnostics(selectionDiagnostics = {}) {
    Object.assign(selectionDiagnostics, {
        totalCandidateCount: 0,
        healthCooldownSkipped: 0,
        temporaryCooldownSkipped: 0,
        nextTemporaryRecoveryTime: null,
        concurrencyLimitSkipped: 0,
        keyQueueWaitMs: 0,
        keyQueueOutcome: null,
        keyCapacityExhausted: false,
        eligibleCandidateCount: 0,
        capacityExhausted: false,
        filterReasons: {},
        attempts: [],
        groupWaitMs: 0,
        groupRetryCount: 0,
        fallbackAttemptCount: 0,
        availabilityReason: null
    });
    return selectionDiagnostics;
}

function isUpstreamCodexRateLimit(error) {
    if (!error || error.origin !== 'upstream_codex') return false;
    if (Number(error.response?.status || error.status || error.statusCode) !== 429) return false;
    if (error.isCodexUsageLimit === true || error.quotaScope || error.filterReasons?.general_quota_exceeded) return false;
    return error.details?.reason === 'UPSTREAM_RATE_LIMIT'
        || error.isCodexRateLimit === true
        || !error.filterReasons;
}

function getCodexGroupRateLimitWaitMs(config, error) {
    const configured = Number(config?.CODEX_GROUP_RATE_LIMIT_WAIT_MS ?? 30_000);
    const maxWaitMs = Number.isFinite(configured) ? Math.min(300_000, Math.max(0, configured)) : 30_000;
    if (maxWaitMs <= 0) return 0;
    const recoveryMs = Date.parse(error?.nextRecoveryTime || error?.details?.nextRecoveryAt || '');
    if (Number.isFinite(recoveryMs)) return Math.min(maxWaitMs, Math.max(0, recoveryMs - Date.now()));
    const retryAfterMs = Number(error?.retryAfterMs || error?.retryAfter);
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return Math.min(maxWaitMs, retryAfterMs);
    return maxWaitMs;
}

function normalizeCredentialGroups(groups = []) {
    return (Array.isArray(groups) ? groups : [])
        .filter(group => group && group.id)
        .map(group => ({
            ...group,
            id: String(group.id),
            credentialUuids: [...new Set(
                (Array.isArray(group.credentialUuids) ? group.credentialUuids : [])
                    .filter(Boolean)
                    .map(String)
            )]
        }));
}

async function resolveCodexCredentialGroupContext(config, providerType) {
    if (!isCodexProviderType(providerType) || !config?.potluckKeyData) {
        return { handled: false };
    }

    const service = new CredentialGroupService({
        filePath: config.CODEX_CREDENTIAL_GROUPS_FILE_PATH
    });
    const currentConfig = await service.getCurrentConfig();
    const keyRouting = resolveKeyRoutingAssignment(config.potluckKeyData, currentConfig);
    return {
        handled: true,
        keyRouting,
        groups: normalizeCredentialGroups(currentConfig.groups),
        configRevision: Number(currentConfig.revision || 0)
    };
}

function getProviderCredentialCatalog(providerType) {
    return (providerPoolManager?.providerStatus?.[providerType] || [])
        .map(provider => {
            const config = provider?.config || provider;
            const uuid = provider?.uuid || config?.uuid;
            if (!uuid) return null;
            return {
                uuid: String(uuid),
                providerType,
                providerWeight: Number(config?.providerWeight || 1),
                isHealthy: config?.isHealthy,
                isDisabled: config?.isDisabled,
                needsRefresh: config?.needsRefresh,
                scheduledRecoveryTime: config?.scheduledRecoveryTime,
                quotaAvailable: config?.quotaAvailable,
                hasCapacity: config?.hasCapacity,
                isAtCapacity: config?.isAtCapacity
            };
        })
        .filter(Boolean);
}

function getProviderStatusByUuid(providerType, uuid) {
    return (providerPoolManager?.providerStatus?.[providerType] || [])
        .find(provider => String(provider?.uuid || provider?.config?.uuid || '') === String(uuid));
}

function modelAliasMatches(requestedModel, configuredModel) {
    const requested = String(requestedModel || '').trim().toLowerCase();
    const configured = String(configuredModel || '').trim().toLowerCase();
    if (!requested || !configured) return false;
    if (requested === configured) return true;
    if (/(?:-fast|-ultrafast)$/.test(requested) && requested.replace(/-(?:fast|ultrafast)$/, '') === configured) return true;
    return /(?:-fast|-ultrafast)$/.test(configured)
        && configured.replace(/-(?:fast|ultrafast)$/, '') === requested;
}

function isFixedCredentialModelSupported(providerType, uuid, requestedModel) {
    if (!requestedModel) return true;

    const providerStatus = getProviderStatusByUuid(providerType, uuid);
    const providerConfig = providerStatus?.config || providerStatus;
    if (!providerConfig) return false;

    const supportedModels = Array.isArray(providerConfig.supportedModels)
        ? providerConfig.supportedModels.filter(Boolean)
        : [];
    if (supportedModels.length > 0 && !supportedModels.some(model => modelAliasMatches(requestedModel, model))) {
        return false;
    }

    const notSupportedModels = Array.isArray(providerConfig.notSupportedModels)
        ? providerConfig.notSupportedModels.filter(Boolean)
        : [];
    return !notSupportedModels.some(model => modelAliasMatches(requestedModel, model));
}

function createFixedCredentialUnavailableError(cause = null, route = {}, configRevision = null) {
    const error = new Error('The fixed Codex credential is unavailable');
    error.code = 'FIXED_CREDENTIAL_UNAVAILABLE';
    error.status = cause?.status || 503;
    error.statusCode = error.status;
    error.details = {
        routingMode: 'fixed',
        selectedGroupId: route.selectedGroupId || null,
        ...(Number.isFinite(Number(configRevision)) ? { configRevision: Number(configRevision) } : {}),
        ...(cause?.code ? { causeCode: cause.code } : {}),
        ...(cause?.retryAfter || cause?.details?.nextRecoveryAt
            ? { nextRecoveryAt: cause.retryAfter || cause.details.nextRecoveryAt }
            : {}),
        retryable: true
    };
    if (cause) error.cause = cause;
    return error;
}

function createFixedRouteMismatchError(route = {}, configRevision = null) {
    const error = new Error('Fixed Codex routing configuration is inconsistent');
    error.code = 'ROUTE_MISMATCH';
    error.status = 503;
    error.statusCode = 503;
    error.details = {
        reason: route.routeReason || route.errorCode || 'ROUTE_MISMATCH',
        routingMode: 'fixed',
        selectedGroupId: route.selectedGroupId || null,
        ...(Number.isFinite(Number(configRevision)) ? { configRevision: Number(configRevision) } : {}),
        retryable: false
    };
    return error;
}

function createFixedModelNotSupportedError(model, route = {}, configRevision = null) {
    const error = new Error(`Fixed Codex credential does not support model ${model}`);
    error.code = 'MODEL_NOT_SUPPORTED';
    error.status = 404;
    error.statusCode = 404;
    error.details = {
        reason: 'FIXED_CREDENTIAL_MODEL_UNSUPPORTED',
        routingMode: 'fixed',
        selectedGroupId: route.selectedGroupId || null,
        ...(Number.isFinite(Number(configRevision)) ? { configRevision: Number(configRevision) } : {}),
        retryable: false
    };
    return error;
}

function createProviderCooldownError(recoveryTime, route = {}, configRevision = null) {
    const error = new Error('Fixed Codex credential is cooling down');
    error.code = 'PROVIDER_COOLDOWN';
    error.status = 429;
    error.statusCode = 429;
    error.retryAfter = recoveryTime || null;
    error.details = {
        reason: 'FIXED_CREDENTIAL_COOLDOWN',
        routingMode: 'fixed',
        selectedGroupId: route.selectedGroupId || null,
        nextRecoveryAt: recoveryTime || null,
        ...(Number.isFinite(Number(configRevision)) ? { configRevision: Number(configRevision) } : {}),
        retryable: true
    };
    return error;
}

function isCredentialAvailabilityError(error) {
    return error?.status === 429
        || error?.code === 429
        || /^Queue timeout\b/.test(String(error?.message || ''));
}

function getOrderedCredentialGroups(groups, requestedPrimaryGroupId, pinnedGroupId = null) {
    const groupById = new Map(groups.map(group => [group.id, group]));
    const ordered = [];
    const addGroup = groupId => {
        const group = groupId ? groupById.get(String(groupId)) : null;
        if (group && !ordered.some(candidate => candidate.id === group.id)) ordered.push(group);
    };

    addGroup(pinnedGroupId);
    addGroup(requestedPrimaryGroupId);
    for (const group of groups) addGroup(group.id);
    return ordered;
}

// Key concurrency used to apply only to routingMode=pool, so the vast majority
// of keys (routingMode=auto) advertised a limit in the UI that was never
// enforced. Auto keys are now limited too, but only when they actually declare
// a positive limit, which keeps unconfigured keys on the previous path.
async function acquireCodexKeyConcurrencyLease(config, keyRouting, selectionDiagnostics, useAcquire) {
    const keyId = config.potluckKeyData?.id || null;
    if (!useAcquire || !keyId) return false;
    if (requestContext.get('potluckKeyConcurrencyLease') || requestContext.get('edgeAdmissionLease')) return false;
    const keyData = config.potluckKeyData || {};
    const routingMode = keyRouting?.routingMode || 'auto';
    if (routingMode !== 'pool' && !(Number(keyData.concurrencyLimit) > 0)) return false;

    const keyQueueStartedAt = Date.now();
    try {
        const lease = await potluckKeyConcurrencyLimiter.acquire(keyId, {
            maxConcurrency: keyData.concurrencyLimit,
            queueLimit: keyData.queueLimit,
            queueTimeoutMs: keyData.queueTimeoutMs,
            mode: keyData.concurrencyMode,
            coordination: providerPoolManager?.coordination || null
        });
        requestContext.set('potluckKeyConcurrencyLease', lease);
        requestContext.set('potluckKeyConcurrencyKeyId', keyId);
        selectionDiagnostics.keyQueueOutcome = lease.shadow ? 'shadow' : 'admitted';
        selectionDiagnostics.keyCapacityExhausted = lease.capacityExhausted === true;
        selectionDiagnostics.keyQueueWaitMs = Math.max(0, Date.now() - keyQueueStartedAt);
        accumulateRoutingWait('keyQueueWaitMs', selectionDiagnostics.keyQueueWaitMs);
        return true;
    } catch (error) {
        const reason = error?.details?.reason || 'key_capacity_exhausted';
        selectionDiagnostics.keyQueueOutcome = reason;
        selectionDiagnostics.keyQueueWaitMs = Math.max(0, Date.now() - keyQueueStartedAt);
        accumulateRoutingWait('keyQueueWaitMs', selectionDiagnostics.keyQueueWaitMs);
        selectionDiagnostics.keyCapacityExhausted = true;
        updateCodexRoutingDiagnostics(config, {
            routingMode,
            keyQueueWaitMs: selectionDiagnostics.keyQueueWaitMs,
            keyQueueOutcome: reason,
            keyCapacityExhausted: true
        });
        throw error;
    }
}

async function selectCodexCredentialGroupProvider(config, providerType, requestedModel, options = {}, selectionDiagnostics = {}) {
    const context = await resolveCodexCredentialGroupContext(config, providerType);
    if (!context.handled) return context;

    const { keyRouting, groups } = context;
    const useAcquire = options.acquireSlot === true;
    const selectFromPool = selectionOptions => useAcquire
        ? providerPoolManager.acquireSlotWithFallback(providerType, requestedModel, selectionOptions)
        : providerPoolManager.selectProviderWithFallback(providerType, requestedModel, {
            ...selectionOptions,
            skipUsageCount: true
        });

    if (keyRouting.routingMode === 'fixed') {
        if (options.allowCodexFixedFallbackToOtherCredentials === true) {
            const fallbackOptions = {
                ...options,
                selectionDiagnostics,
                preferredProviderUuid: null,
                disableProviderFallback: true
            };
            delete fallbackOptions.allowedProviderUuids;
            const selectedResult = await selectFromPool(fallbackOptions);
            return { handled: true, selectedResult, availabilityError: null };
        }
        const fixedUuid = keyRouting.fixedCredential?.uuid || null;
        if (fixedUuid) providerPoolManager.reconcileProviderForRouting?.(providerType, fixedUuid);
        const route = routeKeyToCredentialCandidates({
            keyRouting,
            groups,
            credentials: getProviderCredentialCatalog(providerType)
        });
        updateCodexRoutingDiagnostics(config, {
            routingMode: 'fixed',
            requestedPrimaryGroupId: null,
            selectedGroupId: route.selectedGroupId || null,
            selectedProviderUuid: null,
            spillover: false,
            spilloverReason: null,
            assignmentMissing: false
        });
        if (route.errorCode === 'ROUTE_MISMATCH') {
            throw createFixedRouteMismatchError(route, context.configRevision);
        }
        if (route.errorCode === 'FIXED_CREDENTIAL_UNAVAILABLE' && route.nextRecoveryTime) {
            const recoveryMs = Date.parse(route.nextRecoveryTime);
            if (Number.isFinite(recoveryMs) && recoveryMs > Date.now()) {
                throw createProviderCooldownError(route.nextRecoveryTime, route, context.configRevision);
            }
        }
        if (route.errorCode || route.candidateProviderUuids.length !== 1) {
            throw createFixedCredentialUnavailableError(route.errorCode ? { code: route.errorCode } : null, route, context.configRevision);
        }
        if (!isFixedCredentialModelSupported(
            providerType,
            route.candidateProviderUuids[0],
            requestedModel
        )) {
            throw createFixedModelNotSupportedError(requestedModel, route, context.configRevision);
        }

        const fixedOptions = withStickyProviderAffinity(config, providerType, {
            ...options,
            selectionDiagnostics,
            requestedModel,
            allowedProviderUuids: route.candidateProviderUuids,
            disableProviderFallback: true,
            preferredProviderUuid: null
        });
        try {
            const selectedResult = await selectFromPool(fixedOptions);
            if (!selectedResult) throw createFixedCredentialUnavailableError(null, route, context.configRevision);
            updateCodexRoutingDiagnostics(config, {
                selectedProviderUuid: selectedResult.config?.uuid || null,
                hotShardApplied: selectionDiagnostics.hotShardApplied === true
            });
            return { handled: true, selectedResult, availabilityError: null };
        } catch (error) {
            if (error?.code === 'FIXED_CREDENTIAL_UNAVAILABLE') throw error;
            if (error?.code === 'MODEL_RATE_LIMITED' || error?.code === 'PROVIDER_TEMPORARILY_UNAVAILABLE') {
                throw createProviderCooldownError(error.nextRecoveryTime || error.retryAfter || null, route, context.configRevision);
            }
            throw createFixedCredentialUnavailableError(error, route, context.configRevision);
        }
    }

    await acquireCodexKeyConcurrencyLease(config, keyRouting, selectionDiagnostics, useAcquire);

    if (keyRouting.routingMode === 'restricted') {
        const route = routeKeyToCredentialCandidates({
            keyRouting,
            groups,
            credentials: getProviderCredentialCatalog(providerType)
        });
        updateCodexRoutingDiagnostics(config, {
            routingMode: 'restricted',
            requestedPrimaryGroupId: null,
            selectedGroupId: null,
            selectedProviderUuid: null,
            restrictedCredentialUuids: [...(keyRouting.restrictedCredentialUuids || [])],
            spillover: false,
            assignmentMissing: false
        });
        if (route.errorCode) {
            await releasePotluckKeyConcurrencyLease();
            const error = new Error('The restricted Codex credential pool is unavailable');
            error.code = route.errorCode;
            error.status = route.errorCode === 'PROVIDER_COOLDOWN' ? 429 : 503;
            if (route.nextRecoveryTime) error.retryAfter = route.nextRecoveryTime;
            error.details = { routingMode: 'restricted', retryable: route.errorCode !== 'ROUTE_MISMATCH' };
            throw error;
        }
        const restrictedOptions = withStickyProviderAffinity(config, providerType, {
            ...options,
            selectionDiagnostics,
            requestedModel,
            allowedProviderUuids: route.candidateProviderUuids,
            disableProviderFallback: true,
            preferredProviderUuid: null
        });
        let selectedResult;
        try {
            selectedResult = await selectFromPool(restrictedOptions);
        } catch (error) {
            await releasePotluckKeyConcurrencyLease();
            throw error;
        }
        if (!selectedResult || !route.restrictedCredentialUuids.includes(selectedResult.config?.uuid)) {
            await releasePotluckKeyConcurrencyLease();
            const error = new Error('No selected Codex credential is available');
            error.code = 'RESTRICTED_CREDENTIALS_UNAVAILABLE';
            error.status = 503;
            throw error;
        }
        updateCodexRoutingDiagnostics(config, {
            selectedProviderUuid: selectedResult.config.uuid,
            hotShardApplied: selectionDiagnostics.hotShardApplied === true
        });
        return { handled: true, selectedResult, availabilityError: null };
    }

    if (keyRouting.routingMode === 'pool') {
        const keyHash = config.potluckKeyData?.id
            ? `sha256:${crypto.createHash('sha256').update(String(config.potluckKeyData.id)).digest('hex').slice(0, 16)}`
            : 'none';
        logger.info(`[Codex Routing] pool selection key=${keyHash} mode=pool revision=${keyRouting.routingConfigRevision || 0}`);
        const poolKeyId = config.potluckKeyData?.id || null;
        const poolOptions = {
            ...options,
            selectionDiagnostics,
            requestedModel,
            preferredProviderUuid: null,
            routingMode: 'pool',
            poolKeyId
        };
        let selectedResult;
        try {
            selectedResult = await selectFromPool(poolOptions);
        } catch (error) {
            await releasePotluckKeyConcurrencyLease();
            throw error;
        }
        if (!selectedResult) await releasePotluckKeyConcurrencyLease();
        const selectedUuid = selectedResult?.config?.uuid || null;
        updateCodexRoutingDiagnostics(config, {
            routingMode: 'pool',
            requestedPrimaryGroupId: null,
            selectedGroupId: null,
            selectedProviderUuid: selectedUuid,
            spillover: false,
            spilloverReason: null,
            assignmentMissing: false,
            hotShardApplied: selectionDiagnostics.hotShardApplied === true
        });
        return { handled: true, selectedResult: selectedResult || null, availabilityError: null };
    }

    const requestedPrimaryGroupId = keyRouting.primaryGroupId || groups[0]?.id || null;
    const groupAffinity = resolveCodexCredentialGroupAffinity(config, providerType);
    const pinnedGroupId = groupAffinity
        ? codexCredentialGroupAffinityStore.getPinnedGroup(groupAffinity.key)
        : null;
    const orderedGroups = getOrderedCredentialGroups(groups, requestedPrimaryGroupId, pinnedGroupId);
    const failoverKey = config._codexOverloadFailoverKey || null;
    const pendingExcludedUuid = failoverKey
        ? codexOverloadFailoverStore.getPendingExclusion(failoverKey)
        : null;
    const pinnedProviderUuid = failoverKey
        ? codexOverloadFailoverStore.getPinnedProvider(failoverKey)
        : null;
    const originalExcludedUuids = Array.isArray(options.excludeProviderUuids)
        ? options.excludeProviderUuids
        : [];
    let availabilityError = null;

    updateCodexRoutingDiagnostics(config, {
        routingMode: 'auto',
        requestedPrimaryGroupId,
        selectedGroupId: null,
        selectedProviderUuid: null,
        spillover: false,
        spilloverReason: null,
        affinitySource: groupAffinity?.source || config._codexRouting?.affinitySource || null,
        assignmentMissing: false
    });

    const attemptGroups = async ({ excludeProviderUuids, preferredProviderUuid, primaryOnly = false, onlyGroupId = null }) => {
        for (const group of orderedGroups) {
            if (primaryOnly && group.id !== requestedPrimaryGroupId) continue;
            if (onlyGroupId && group.id !== onlyGroupId) continue;
            if (group.credentialUuids.length === 0) continue;
            selectionDiagnostics.candidateGroupId = group.id;
            selectionDiagnostics.candidateProviderCount = group.credentialUuids.length;
            const groupOptions = () => withStickyProviderAffinity(config, providerType, {
                ...options,
                selectionDiagnostics,
                requestedModel,
                allowedProviderUuids: config._glmRouting?.uuid
                    ? group.credentialUuids.filter(uuid => uuid === config._glmRouting.uuid)
                    : group.credentialUuids,
                disableProviderFallback: true,
                preferredProviderUuid,
                excludeProviderUuids,
                candidateGroupId: group.id
            });
            try {
                const selectedResult = await selectFromPool(groupOptions());
                if (selectedResult) return { selectedResult, group };
            } catch (error) {
                if (!isCredentialAvailabilityError(error)) {
                    await releasePotluckKeyConcurrencyLease();
                    throw error;
                }
                const isPrimaryGroup = group.id === requestedPrimaryGroupId;
                if (isPrimaryGroup && isUpstreamCodexRateLimit(error) && !options.retryReason && !options._codexGroupRateLimitRetried) {
                    const waitMs = getCodexGroupRateLimitWaitMs(config, error);
                    selectionDiagnostics.groupRetryCount = Number(selectionDiagnostics.groupRetryCount || 0) + 1;
                    selectionDiagnostics.groupWaitMs = Number(selectionDiagnostics.groupWaitMs || 0) + waitMs;
                    selectionDiagnostics.availabilityReason = 'UPSTREAM_RATE_LIMIT';
                    updateCodexRoutingDiagnostics(config, {
                        candidateGroupId: group.id,
                        candidateProviderCount: group.credentialUuids.length,
                        groupRetryCount: selectionDiagnostics.groupRetryCount,
                        groupWaitMs: selectionDiagnostics.groupWaitMs,
                        availabilityReason: 'UPSTREAM_RATE_LIMIT'
                    });
                    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
                    try {
                        const retriedResult = await selectFromPool(groupOptions());
                        if (retriedResult) return { selectedResult: retriedResult, group };
                    } catch (retryError) {
                        if (!isCredentialAvailabilityError(retryError)) {
                            await releasePotluckKeyConcurrencyLease();
                            throw retryError;
                        }
                        availabilityError = retryError;
                        selectionDiagnostics.availabilityReason = 'RATE_LIMIT_WAIT_EXPIRED';
                        continue;
                    }
                } else if (isPrimaryGroup && error?.filterReasons?.general_quota_exceeded) {
                    selectionDiagnostics.availabilityReason = 'QUOTA_EXHAUSTED';
                } else if (isPrimaryGroup && (error?.code === 'PROVIDER_CONCURRENCY_EXHAUSTED' || error?.details?.reason === 'PROVIDER_QUEUE_EXHAUSTED')) {
                    selectionDiagnostics.availabilityReason = 'QUEUE_EXHAUSTED';
                } else if (isPrimaryGroup && error?.details?.reason === 'key_capacity_exhausted') {
                    selectionDiagnostics.availabilityReason = 'KEY_QUEUE_EXHAUSTED';
                }
                if (!availabilityError) availabilityError = error;
            }
            selectionDiagnostics.fallbackAttemptCount = Number(selectionDiagnostics.fallbackAttemptCount || 0) + 1;
        }
        return null;
    };

    const retryGroupId = options.retryReason === 'UPSTREAM_RATE_LIMIT'
        ? (options.retryGroupId || config._codexRouting?.selectedGroupId || requestedPrimaryGroupId)
        : null;
    let selected = retryGroupId
        ? await attemptGroups({
            onlyGroupId: retryGroupId,
            preferredProviderUuid: null,
            excludeProviderUuids: originalExcludedUuids
        })
        : null;

    if (!selected && retryGroupId && options.retryReason === 'UPSTREAM_RATE_LIMIT') {
        selected = await attemptGroups({
            onlyGroupId: retryGroupId,
            preferredProviderUuid: null,
            excludeProviderUuids: []
        });
        if (!selected) selectionDiagnostics.availabilityReason = 'RATE_LIMIT_WAIT_EXPIRED';
    }

    if (!selected) selected = await attemptGroups({
        preferredProviderUuid: pinnedProviderUuid === pendingExcludedUuid ? null : pinnedProviderUuid,
        excludeProviderUuids: [...new Set([
            ...originalExcludedUuids,
            ...(pendingExcludedUuid ? [pendingExcludedUuid] : [])
        ])]
    });

    if (!selected && pendingExcludedUuid) {
        selected = await attemptGroups({
            preferredProviderUuid: null,
            excludeProviderUuids: originalExcludedUuids
        });
    }

    if (!selected && options.allowExcludedProviderFallback === true && originalExcludedUuids.length > 0) {
        selected = await attemptGroups({
            preferredProviderUuid: null,
            excludeProviderUuids: []
        });
    }

    if (!selected) {
        await releasePotluckKeyConcurrencyLease();
        return { handled: true, selectedResult: null, availabilityError };
    }

    const selectedUuid = selected.selectedResult.config?.uuid || null;
    if (failoverKey && pendingExcludedUuid) {
        if (selectedUuid && selectedUuid !== pendingExcludedUuid) {
            codexOverloadFailoverStore.pinAlternative(failoverKey, selectedUuid);
        } else {
            codexOverloadFailoverStore.consumePendingExclusion(failoverKey);
        }
    }
    if (groupAffinity) {
        codexCredentialGroupAffinityStore.pinGroup(groupAffinity.key, selected.group.id);
    }

    const spillover = Boolean(requestedPrimaryGroupId && selected.group.id !== requestedPrimaryGroupId);
    updateCodexRoutingDiagnostics(config, {
        selectedGroupId: selected.group.id,
        selectedProviderUuid: selectedUuid,
        spillover,
        spilloverReason: spillover ? 'PRIMARY_GROUP_UNAVAILABLE' : null,
        spilloverCause: spillover ? (selectionDiagnostics.availabilityReason || 'PRIMARY_GROUP_UNAVAILABLE') : null,
        hotShardApplied: selectionDiagnostics.hotShardApplied === true
    });
    return { handled: true, selectedResult: selected.selectedResult, availabilityError: null };
}

async function releasePotluckKeyConcurrencyLease() {
    const lease = requestContext.get('potluckKeyConcurrencyLease');
    if (!lease) return false;
    requestContext.set('potluckKeyConcurrencyLease', null);
    requestContext.set('potluckKeyConcurrencyKeyId', null);
    try {
        return await lease.release();
    } catch (error) {
        logger.warn(`[Potluck Key Concurrency] release failed: ${error.message}`);
        return false;
    }
}

// providerFilterMs alone cannot distinguish "queued behind a Key limit" from
// "the routing loop is slow"; the credential lease share is already reported as
// redisLeaseMs, so the remainder is genuine selection computation.
function recordProviderFilterStages(startedAt) {
    const stages = computeSelectionStages(performance.now() - startedAt);
    runtimeMetrics.recordStage('providerFilterMs', stages.providerFilterMs);
    const runtimeRequest = requestContext.get('runtimeRequest');
    const record = (name, value) => {
        if (runtimeRequest?.recordStage) runtimeRequest.recordStage(name, value);
        else runtimeMetrics.recordStage(name, value);
    };
    record('keyQueueWaitMs', stages.keyQueueWaitMs);
    record('elasticQueueWaitMs', stages.elasticQueueWaitMs);
    record('availabilityRefreshMs', stages.availabilityRefreshMs);
    record('elasticAttemptCount', stages.elasticAttemptCount);
    record('selectionPlanFilterMs', stages.selectionPlanFilterMs);
    record('selectionRankMs', stages.selectionRankMs);
    record('selectionHydrateMs', stages.selectionHydrateMs);
    record('selectionComputeMs', stages.selectionComputeMs);
}

async function acquirePotluckKeyConcurrencyLeaseIfNeeded(config, providerType, options, selectionDiagnostics) {
    if (options.acquireSlot !== true || !config?.potluckKeyData?.id || requestContext.get('edgeAdmissionLease')) return false;
    if (!isGeminiProviderType(providerType)) return false;
    if (config?.potluckKeyData?.routingMode !== 'pool') return false;
    if (requestContext.get('potluckKeyConcurrencyLease')) return true;
    const keyData = config.potluckKeyData;
    const startedAt = Date.now();
    try {
        const lease = await potluckKeyConcurrencyLimiter.acquire(keyData.id, {
            maxConcurrency: keyData.concurrencyLimit,
            queueLimit: keyData.queueLimit,
            queueTimeoutMs: keyData.queueTimeoutMs,
            mode: keyData.concurrencyMode,
            coordination: providerPoolManager?.coordination || null
        });
        requestContext.set('potluckKeyConcurrencyLease', lease);
        requestContext.set('potluckKeyConcurrencyKeyId', keyData.id);
        selectionDiagnostics.keyQueueOutcome = lease.shadow ? 'shadow' : 'admitted';
        selectionDiagnostics.keyCapacityExhausted = lease.capacityExhausted === true;
        selectionDiagnostics.keyQueueWaitMs = Math.max(0, Date.now() - startedAt);
        accumulateRoutingWait('keyQueueWaitMs', selectionDiagnostics.keyQueueWaitMs);
        return true;
    } catch (error) {
        const reason = error?.details?.reason || 'key_capacity_exhausted';
        selectionDiagnostics.keyQueueOutcome = reason;
        selectionDiagnostics.keyQueueWaitMs = Math.max(0, Date.now() - startedAt);
        accumulateRoutingWait('keyQueueWaitMs', selectionDiagnostics.keyQueueWaitMs);
        selectionDiagnostics.keyCapacityExhausted = true;
        throw error;
    }
}

export function createProviderSelectionError(providerType, model, selectionDiagnostics = {}, options = {}) {
    const suffix = `${providerType}${model ? ` supporting model: ${model}` : ''}`;
    const reasons = selectionDiagnostics.filterReasons || {};
    let status = 503;
    let code = 'PROVIDER_CREDENTIALS_UNAVAILABLE';
    let message = `[API Service] No usable provider credentials for ${suffix}`;
    let retryAfter = null;

    if (options.acquireSlot === true && selectionDiagnostics.capacityExhausted === true) {
        status = 429;
        code = 'PROVIDER_CONCURRENCY_EXHAUSTED';
        message = `[API Service] All healthy providers are at concurrency capacity for ${suffix}`;
    } else if (Number(reasons.model_cooldown || 0) > 0) {
        status = 429;
        code = 'MODEL_RATE_LIMITED';
        message = `[API Service] All providers are cooling down for ${suffix}`;
        retryAfter = selectionDiagnostics.nextModelRecoveryTime || null;
    } else if (
        selectionDiagnostics.temporaryCooldownSkipped > 0
        && selectionDiagnostics.eligibleCandidateCount === 0
    ) {
        status = 429;
        code = 'PROVIDER_TEMPORARILY_UNAVAILABLE';
        message = `[API Service] All providers are temporarily unavailable during cooldown for ${suffix}`;
        retryAfter = selectionDiagnostics.nextTemporaryRecoveryTime || null;
    } else if (
        Number(reasons.model_unsupported || 0) > 0
        && Number(reasons.model_unsupported || 0) >= Number(selectionDiagnostics.totalCandidateCount || 0)
    ) {
        status = 404;
        code = 'MODEL_NOT_SUPPORTED';
        message = `[API Service] No configured provider supports model ${model}`;
    }

    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    if (retryAfter) error.retryAfter = retryAfter;
    error.filterReasons = { ...reasons };
    return error;
}

function throwProviderSelectionFailure(config, model, options, selectionDiagnostics, availabilityError = null) {
    logGeminiSelectionDiagnostic(config.MODEL_PROVIDER, model, selectionDiagnostics, null, selectionDiagnostics.selectionStartedAt || performance.now(), config);
    if (availabilityError) throw availabilityError;
    const error = createProviderSelectionError(config.MODEL_PROVIDER, model, selectionDiagnostics, options);
    if (error.status >= 500) logger.error(error.message);
    else logger.warn(error.message);
    throw error;
}

function restoreProviderPoolsAfterFailedPersist(config, originalProviderPools) {
    config.providerPools = originalProviderPools;
    if (!providerPoolManager) return;

    providerPoolManager.providerPools = originalProviderPools;
    try {
        providerPoolManager.initializeProviderStatus();
    } catch (refreshError) {
        logger.warn(`[Auto-Link] Provider pool rollback restored data but status refresh failed: ${refreshError.message}`);
    }
}

/**
 * 鎵弿 configs 鐩綍骞惰嚜鍔ㄥ叧鑱旀湭鍏宠仈鐨勯厤缃枃浠跺埌瀵瑰簲鐨勬彁渚涘晢
 * @param {Object} config - 鏈嶅姟鍣ㄩ厤缃璞?
 * @param {Object} options - 鍙€夊弬鏁?
 * @param {boolean} options.onlyCurrentCred - 涓?true 鏃讹紝鍙嚜鍔ㄥ叧鑱斿綋鍓嶅嚟璇?
 * @param {string} options.credPath - 褰撳墠鍑瘉鐨勮矾寰勶紙褰?onlyCurrentCred 涓?true 鏃跺繀闇€锛?
 * @param {boolean} options.throwOnPersistError - 涓?true 鏃讹紝鍐欑洏澶辫触鍥炴粴鍐呭瓨骞舵姏閿?
 * @returns {Promise<Object>} 鏇存柊鍚庣殑 providerPools 瀵硅薄
 */
export async function autoLinkProviderConfigs(config, options = {}) {
    const previousProviderPools = JSON.parse(JSON.stringify(config.providerPools || {}));
    const originalProviderPools = options.throwOnPersistError
        ? JSON.parse(JSON.stringify(previousProviderPools))
        : null;
    // 纭繚 providerPools 瀵硅薄瀛樺湪
    if (!config.providerPools) {
        config.providerPools = {};
    }
    
    let totalNewProviders = 0;
    let updatedExistingProviders = 0;
    const allNewProviders = {};
    
    // 濡傛灉鍙叧鑱斿綋鍓嶅嚟璇?
    if (options.onlyCurrentCred && options.credPath) {
        const result = await linkSingleCredential(config, options.credPath, options.providerDefaults || {});
        if (result) {
            totalNewProviders = 1;
            allNewProviders[result.displayName] = [result.provider];
        } else if (options.throwOnPersistError) {
            restoreProviderPoolsAfterFailedPersist(config, originalProviderPools);
            throw new Error(`Failed to link current credential: ${options.credPath}`);
        }
    } else {
        // 閬嶅巻鎵€鏈夋彁渚涘晢鏄犲皠
        for (const mapping of PROVIDER_MAPPINGS) {
            const configsPath = path.join(process.cwd(), 'configs', mapping.dirName);
            const { providerType, credPathKey, defaultCheckModel, displayName, needsProjectId } = mapping;
            
            // 纭繚鎻愪緵鍟嗙被鍨嬫暟缁勫瓨鍦?
            if (!config.providerPools[providerType]) {
                config.providerPools[providerType] = [];
            }
            
            // 妫€鏌ョ洰褰曟槸鍚﹀瓨鍦?
            if (!fs.existsSync(configsPath)) {
                continue;
            }

            updatedExistingProviders += await backfillGeminiProviderAccountNames(
                config.providerPools[providerType],
                providerType,
                credPathKey
            );
            
            // 鑾峰彇宸插叧鑱旂殑閰嶇疆鏂囦欢璺緞闆嗗悎
            const linkedPaths = new Set();
            for (const provider of config.providerPools[providerType]) {
                if (provider[credPathKey]) {
                    // 浣跨敤鍏叡鏂规硶娣诲姞璺緞鐨勬墍鏈夊彉浣撴牸寮?
                    addToUsedPaths(linkedPaths, provider[credPathKey]);
                }
            }
            
            // 閫掑綊鎵弿鐩綍
            const newProviders = [];
            await scanProviderDirectory(configsPath, linkedPaths, newProviders, {
                providerType,
                credPathKey,
                defaultCheckModel,
                needsProjectId,
                existingProviders: config.providerPools[providerType]
            });
            
            // 濡傛灉鏈夋柊鐨勯厤缃枃浠堕渶瑕佸叧鑱?
            if (newProviders.length > 0) {
                config.providerPools[providerType].push(...newProviders);
                totalNewProviders += newProviders.length;
                allNewProviders[displayName] = newProviders;
            }
        }
    }
    
    // 濡傛灉鏈夋柊鐨勯厤缃枃浠堕渶瑕佸叧鑱旓紝淇濆瓨鏇存柊鍚庣殑 provider_pools.json
    let persistedProviderChanges = false;
    if (totalNewProviders > 0 || updatedExistingProviders > 0) {
        const filePath = config.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        try {
            await withFileLock(filePath, async () => {
                await atomicWriteFile(filePath, JSON.stringify(config.providerPools, null, 2), 'utf8');
            });
            persistedProviderChanges = true;
            logger.info(`[Auto-Link] Added ${totalNewProviders} new config(s) to provider pools:`);
            for (const [displayName, providers] of Object.entries(allNewProviders)) {
                logger.info(`  ${displayName}: ${providers.length} config(s)`);
                providers.forEach(p => {
                    // 鑾峰彇鍑嵁璺緞閿紙鏀寔 _CREDS_FILE_PATH 鍜?_TOKEN_FILE_PATH 涓ょ鏍煎紡锛?
                    const credKey = Object.keys(p).find(k =>
                        k.endsWith('_CREDS_FILE_PATH') || k.endsWith('_TOKEN_FILE_PATH')
                    );
                    if (credKey) {
                        logger.info(`    - ${p[credKey]}`);
                    }
                });
            }
            if (updatedExistingProviders > 0) {
                logger.info(`[Auto-Link] Backfilled account names for ${updatedExistingProviders} existing Gemini provider(s)`);
            }
        } catch (error) {
            logger.error(`[Auto-Link] Failed to save provider_pools.json: ${error.message}`);
            if (options.throwOnPersistError) {
                restoreProviderPoolsAfterFailedPersist(config, originalProviderPools);
                throw error;
            }
        }
    } else {
        logger.info('[Auto-Link] No new configs to link');
    }
    
    // Update provider pool manager if available only after persistence succeeds.
    try {
        if (providerPoolManager && persistedProviderChanges) {
            const providerTypes = new Set([
                ...Object.keys(previousProviderPools),
                ...Object.keys(config.providerPools || {})
            ]);
            for (const providerType of providerTypes) {
                if (JSON.stringify(previousProviderPools[providerType] || []) === JSON.stringify(config.providerPools[providerType] || [])) continue;
                providerPoolManager.publishProviderConfig(providerType, config.providerPools[providerType] || [], {
                    action: 'auto_link',
                    changedUuids: [...new Set([
                        ...(previousProviderPools[providerType] || []).map(provider => provider.uuid),
                        ...(config.providerPools[providerType] || []).map(provider => provider.uuid)
                    ].filter(Boolean))]
                });
            }
        }
    } catch (refreshError) {
        logger.warn(`[Auto-Link] Provider pools saved but manager refresh failed: ${refreshError.message}`);
    }
    return config.providerPools;
}

/**
 * Replace the credential file path on an existing provider without recreating it.
 * This is used by reauthorization flows so routing settings (weight, limits,
 * supported models, etc.) stay attached to the same provider UUID.
 */
export async function replaceProviderCredentialPath(config, options = {}) {
    const { providerType, providerUuid, credPath } = options;
    const hasProxyOverride = Object.prototype.hasOwnProperty.call(options, 'proxyId');
    const normalizedProxyId = hasProxyOverride && typeof options.proxyId === 'string'
        ? options.proxyId.trim()
        : '';
    if (!providerType || !providerUuid || !credPath) {
        throw new Error('providerType, providerUuid and credPath are required');
    }
    if (hasProxyOverride && typeof options.proxyId !== 'string') {
        throw new Error('proxyId must be a string when provided');
    }

    const mapping = PROVIDER_MAPPINGS.find(item => item.providerType === providerType);
    if (!mapping) {
        throw new Error(`Unsupported provider type: ${providerType}`);
    }

    const filePath = config.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    let updatedProvider = null;
    const absoluteCredPath = path.isAbsolute(credPath) ? credPath : path.join(process.cwd(), credPath);
    const codexIdentity = isCodexProviderType(providerType)
        ? await readCodexCredentialIdentity(absoluteCredPath)
        : null;

    await withFileLock(filePath, async () => {
        const providerPools = fs.existsSync(filePath)
            ? JSON.parse(await pfs.readFile(filePath, 'utf8'))
            : {};
        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex(provider => provider.uuid === providerUuid);

        if (providerIndex === -1) {
            throw new Error(`Provider not found: ${providerType}/${providerUuid}`);
        }

        const nextProvider = {
            ...providers[providerIndex],
            [mapping.credPathKey]: formatSystemPath(credPath),
            isHealthy: true,
            needsRefresh: false,
            errorCount: 0,
            lastErrorTime: null,
            lastErrorMessage: null
        };

        if (hasProxyOverride) {
            if (normalizedProxyId) {
                nextProvider.PROXY_ID = normalizedProxyId;
            } else {
                delete nextProvider.PROXY_ID;
            }
        }

        if (isGeminiProviderType(providerType) && typeof options.accountEmail === 'string' && options.accountEmail.trim()) {
            nextProvider.accountEmail = options.accountEmail.trim();
            if (!String(nextProvider.customName || '').trim()) {
                nextProvider.customName = nextProvider.accountEmail;
            }
        }

        updatedProvider = applyCodexIdentityToProvider(nextProvider, codexIdentity);

        providerPools[providerType][providerIndex] = updatedProvider;
        await atomicWriteFile(filePath, JSON.stringify(providerPools, null, 2), 'utf8');

        try {
            if (config) {
                config.providerPools = providerPools;
            }
        } catch (configRefreshError) {
            logger.warn(`[Auto-Link] Provider pool persisted but config refresh failed: ${configRefreshError.message}`);
        }
        try {
            if (providerPoolManager) {
                providerPoolManager.publishProviderConfig(providerType, providerPools[providerType], { action: 'reauthorize', changedUuids: [providerUuid] });
            }
        } catch (managerRefreshError) {
            logger.warn(`[Auto-Link] Provider pool persisted but manager refresh failed: ${managerRefreshError.message}`);
        }
        try {
            invalidateServiceAdapter(providerType, providerUuid);
        } catch (invalidateError) {
            logger.warn(`[Auto-Link] Provider persisted but cached adapter invalidation failed: ${invalidateError.message}`);
        }
    });

    logger.info(`[Auto-Link] Reauthorized provider ${providerType}/${providerUuid} with new credential path`);
    return {
        updated: true,
        providerType,
        providerUuid,
        provider: updatedProvider
    };
}

/**
 * 鍏宠仈鍗曚釜鍑瘉鏂囦欢鍒板搴旂殑鎻愪緵鍟?
 * @param {Object} config - 鏈嶅姟鍣ㄩ厤缃璞?
 * @param {string} credPath - 鍑瘉鏂囦欢璺緞锛堢浉瀵规垨缁濆璺緞锛?
 * @returns {Promise<Object|null>} 杩斿洖鍏宠仈缁撴灉鎴?null
 */
function pickProviderDefaults(providerDefaults = {}) {
    const defaults = {};
    if (typeof providerDefaults.PROXY_ID === 'string' && providerDefaults.PROXY_ID.trim()) {
        defaults.PROXY_ID = providerDefaults.PROXY_ID.trim();
    }
    if (typeof providerDefaults.accountEmail === 'string' && providerDefaults.accountEmail.trim()) {
        defaults.accountEmail = providerDefaults.accountEmail.trim();
    }
    if (typeof providerDefaults.customName === 'string' && providerDefaults.customName.trim()) {
        defaults.customName = providerDefaults.customName.trim();
    }
    return defaults;
}

function applyCodexIdentityToProvider(providerConfig, identity = {}) {
    if (!providerConfig || !identity?.codexAccountKey) return providerConfig;
    providerConfig.codexAccountKey = identity.codexAccountKey;
    providerConfig.codexAccountId = identity.codexAccountId || '';
    providerConfig.codexEmail = identity.codexEmail || '';
    return providerConfig;
}

function findProviderIndexByCodexIdentity(providers = [], identity = {}) {
    if (!identity?.codexAccountKey) return -1;
    const identityKey = String(identity.codexAccountKey).toLowerCase();
    const identityEmail = String(identity.codexEmail || '').toLowerCase();
    return providers.findIndex(provider => {
        const providerKey = String(provider.codexAccountKey || provider.codexAccountId || '').toLowerCase();
        const providerEmail = String(provider.codexEmail || provider.customName || '').toLowerCase();
        return providerKey === identityKey || (identityEmail && providerEmail === identityEmail);
    });
}

async function ensureCodexIdentityForServiceConfig(serviceConfig, providerType, providerUuid = null) {
    if (!isCodexProviderType(providerType) || serviceConfig?.codexAccountKey) {
        return serviceConfig;
    }

    const cachedIdentity = providerUuid
        ? providerPoolManager?.getProviderIdentity?.(providerType, providerUuid)
        : null;
    if (cachedIdentity?.codexAccountKey) {
        applyCodexIdentityToProvider(serviceConfig, cachedIdentity);
        return serviceConfig;
    }

    const credPath = serviceConfig?.CODEX_OAUTH_CREDS_FILE_PATH;
    if (!credPath) return serviceConfig;

    const absolutePath = path.isAbsolute(credPath) ? credPath : path.join(process.cwd(), credPath);
    const identityReadStartedAt = performance.now();
    const identity = await readCodexCredentialIdentity(absolutePath);
    runtimeMetrics.recordStage('identityReadMs', performance.now() - identityReadStartedAt);
    applyCodexIdentityToProvider(serviceConfig, identity);
    return serviceConfig;
}

async function persistCodexIdentityToProviderPool(config, providerType, providerUuid, identity = {}) {
    if (!providerUuid || !identity?.codexAccountKey || !isCodexProviderType(providerType)) return;
    const startedAt = performance.now();
    try {
        return await providerPoolManager?.reconcileProviderIdentity?.(providerType, providerUuid, identity);
    } finally {
        runtimeMetrics.recordStage('identityPersistIoMs', performance.now() - startedAt);
    }
}

async function linkSingleCredential(config, credPath, providerDefaults = {}) {
    try {
        // 瑙勮寖鍖栬矾寰?
        const absolutePath = path.isAbsolute(credPath) ? credPath : path.join(process.cwd(), credPath);
        const relativePath = path.relative(process.cwd(), absolutePath);
        
        // 妫€鏌ユ枃浠舵槸鍚﹀瓨鍦?
        if (!fs.existsSync(absolutePath)) {
            logger.warn(`[Auto-Link] Credential file not found: ${relativePath}`);
            return null;
        }
        
        // 妫€鏌ユ枃浠舵墿灞曞悕
        const ext = path.extname(absolutePath).toLowerCase();
        if (ext !== '.json') {
            logger.warn(`[Auto-Link] Only JSON files are supported: ${relativePath}`);
            return null;
        }
        
        // 鏍规嵁鏂囦欢璺緞纭畾鎻愪緵鍟嗙被鍨?
        let matchedMapping = null;
        for (const mapping of PROVIDER_MAPPINGS) {
            const configsPath = path.join(process.cwd(), 'configs', mapping.dirName);
            // 妫€鏌ユ枃浠舵槸鍚﹀湪璇ユ彁渚涘晢鐨勯厤缃洰褰曚笅
            if (absolutePath.startsWith(configsPath)) {
                matchedMapping = mapping;
                break;
            }
        }
        
        if (!matchedMapping) {
            logger.warn(`[Auto-Link] Could not determine provider type for: ${relativePath}`);
            return null;
        }
        
        const { providerType, credPathKey, defaultCheckModel, displayName, needsProjectId } = matchedMapping;
        const geminiAccountEmail = await getGeminiProviderEmail(providerType, absolutePath);
        const customName = isCodexProviderType(providerType)
            ? await readCodexCredentialDisplayName(absolutePath)
            : geminiAccountEmail;
        const codexIdentity = isCodexProviderType(providerType)
            ? await readCodexCredentialIdentity(absolutePath)
            : null;
        
        // 纭繚鎻愪緵鍟嗙被鍨嬫暟缁勫瓨鍦?
        if (!config.providerPools[providerType]) {
            config.providerPools[providerType] = [];
        }
        
        // 妫€鏌ユ槸鍚﹀凡鍏宠仈
        const linkedPaths = new Set();
        for (const provider of config.providerPools[providerType]) {
            if (provider[credPathKey]) {
                addToUsedPaths(linkedPaths, provider[credPathKey]);
            }
        }
        
        const fileName = getFileName(absolutePath);
        const isLinked = isPathUsed(relativePath, fileName, linkedPaths);
        
        if (isLinked) {
            logger.info(`[Auto-Link] Credential already linked: ${relativePath}`);
            return null;
        }

        if (isCodexProviderType(providerType)) {
            const existingIdentityIndex = findProviderIndexByCodexIdentity(config.providerPools[providerType], codexIdentity);
            if (existingIdentityIndex >= 0) {
                const existingProvider = config.providerPools[providerType][existingIdentityIndex];
                const updatedProvider = applyCodexIdentityToProvider({
                    ...existingProvider,
                    [credPathKey]: formatSystemPath(relativePath),
                    customName: customName || existingProvider.customName || '',
                    isHealthy: true,
                    needsRefresh: false,
                    errorCount: 0,
                    lastErrorTime: null,
                    lastErrorMessage: null,
                    ...pickProviderDefaults(providerDefaults)
                }, codexIdentity);
                config.providerPools[providerType][existingIdentityIndex] = updatedProvider;
                logger.info(`[Auto-Link] Updated existing Codex provider by account identity: ${updatedProvider.uuid}`);
                return {
                    provider: updatedProvider,
                    displayName,
                    providerType,
                    updatedExisting: true
                };
            }
        }
        
        // 鍒涘缓鏂扮殑鎻愪緵鍟嗛厤缃?
        let newProvider = {
            ...createProviderConfig({
                credPathKey,
                credPath: formatSystemPath(relativePath),
                defaultCheckModel,
                needsProjectId,
                customName
            }),
            ...(geminiAccountEmail ? { accountEmail: geminiAccountEmail } : {}),
            ...pickProviderDefaults(providerDefaults)
        };
        if (isCodexProviderType(providerType)) {
            newProvider = normalizeCodexFingerprintProviderConfig(providerType, newProvider);
            applyCodexIdentityToProvider(newProvider, codexIdentity);
        }
        
        // 娣诲姞鍒伴厤缃?
        config.providerPools[providerType].push(newProvider);
        
        logger.info(`[Auto-Link] Successfully linked credential: ${relativePath} to ${displayName}`);
        
        return {
            provider: newProvider,
            displayName,
            providerType
        };
    } catch (error) {
        logger.error(`[Auto-Link] Failed to link credential ${credPath}: ${error.message}`);
        return null;
    }
}

/**
 * 閫掑綊鎵弿鎻愪緵鍟嗛厤缃洰褰?
 * @param {string} dirPath - 鐩綍璺緞
 * @param {Set} linkedPaths - 宸插叧鑱旂殑璺緞闆嗗悎
 * @param {Array} newProviders - 鏂版彁渚涘晢閰嶇疆鏁扮粍
 * @param {Object} options - 閰嶇疆閫夐」
 * @param {string} options.credPathKey - 鍑嵁璺緞閿悕
 * @param {string} options.defaultCheckModel - 榛樿妫€娴嬫ā鍨?
 * @param {boolean} options.needsProjectId - 鏄惁闇€瑕?PROJECT_ID
 */
async function scanProviderDirectory(dirPath, linkedPaths, newProviders, options) {
    const { providerType, credPathKey, defaultCheckModel, needsProjectId, existingProviders = [] } = options;
    
    try {
        const files = await pfs.readdir(dirPath, { withFileTypes: true });
        
        for (const file of files) {
            const fullPath = path.join(dirPath, file.name);
            
            if (file.isFile()) {
                const ext = path.extname(file.name).toLowerCase();
                // 鍙鐞?JSON 鏂囦欢
                if (ext === '.json') {
                    const relativePath = path.relative(process.cwd(), fullPath);
                    const fileName = getFileName(fullPath);
                    const customName = isCodexProviderType(providerType)
                        ? await readCodexCredentialDisplayName(fullPath)
                        : await getGeminiProviderEmail(providerType, fullPath);
                    const codexIdentity = isCodexProviderType(providerType)
                        ? await readCodexCredentialIdentity(fullPath)
                        : null;
                    
                    // 浣跨敤涓?ui-manager.js 鐩稿悓鐨?isPathUsed 鍑芥暟妫€鏌ユ槸鍚﹀凡鍏宠仈
                    const isLinked = isPathUsed(relativePath, fileName, linkedPaths);
                    
                    if (!isLinked) {
                        if (isCodexProviderType(providerType)) {
                            const providersForIdentityCheck = [...existingProviders, ...newProviders];
                            if (findProviderIndexByCodexIdentity(providersForIdentityCheck, codexIdentity) >= 0) {
                                logger.info(`[Auto-Link] Skipping duplicate Codex credential identity: ${relativePath}`);
                                continue;
                            }
                        }
                        // 浣跨敤鍏叡鏂规硶鍒涘缓鏂扮殑鎻愪緵鍟嗛厤缃?
                        let newProvider = createProviderConfig({
                            credPathKey,
                            credPath: formatSystemPath(relativePath),
                            defaultCheckModel,
                            needsProjectId,
                            customName
                        });
                        if (isGeminiProviderType(providerType) && customName) {
                            newProvider.accountEmail = customName;
                        }
                        if (isCodexProviderType(providerType)) {
                            newProvider = normalizeCodexFingerprintProviderConfig(providerType, newProvider);
                            applyCodexIdentityToProvider(newProvider, codexIdentity);
                        }
                        
                        newProviders.push(newProvider);
                    }
                }
            } else if (file.isDirectory()) {
                // 閫掑綊鎵弿瀛愮洰褰曪紙闄愬埗娣卞害涓?3 灞傦級
                const relativePath = path.relative(process.cwd(), fullPath);
                const depth = relativePath.split(path.sep).length;
                if (depth < 5) { // configs/{provider}/subfolder/subsubfolder
                    await scanProviderDirectory(fullPath, linkedPaths, newProviders, options);
                }
            }
        }
    } catch (error) {
        logger.warn(`[Auto-Link] Failed to scan directory ${dirPath}: ${error.message}`);
    }
}

// 娉ㄦ剰锛歩sValidOAuthCredentials 宸茬Щ鑷?provider-utils.js 鍏叡妯″潡

/**
 * Initialize API services and provider pool manager
 * @param {Object} config - The server configuration
 * @returns {Promise<Object>} The initialized services
 */
export async function initApiService(config, isReady = false, runtimeOptions = {}) {

    // Initialize or update ProviderPoolManager
    if (providerPoolManager) {
        if (!runtimeOptions.preserveProviderPools) {
            providerPoolManager.providerPools = config.providerPools || {};
            providerPoolManager.initializeProviderStatus();
        }
        providerPoolManager.globalConfig = config;
        providerPoolManager.fallbackChain = config.providerFallbackChain || {};
        providerPoolManager.modelFallbackMapping = config.modelFallbackMapping || {};
        providerPoolManager.mixedProviderPools = config.mixedProviderPools || {};
        providerPoolManager.coordination = runtimeOptions.coordination || providerPoolManager.coordination;
        providerPoolManager.persistenceEnabled = runtimeOptions.persistenceEnabled ?? providerPoolManager.persistenceEnabled;
        providerPoolManager.stateEventSink = runtimeOptions.stateEventSink ?? providerPoolManager.stateEventSink;
        providerPoolManager.configEventSink = runtimeOptions.configEventSink ?? providerPoolManager.configEventSink;
        providerPoolManager.identityEventSink = runtimeOptions.identityEventSink ?? providerPoolManager.identityEventSink;
        logger.info('[Initialization] ProviderPoolManager existing instance updated.');
    } else {
        providerPoolManager = new ProviderPoolManager(config.providerPools || {}, {
            globalConfig: config,
            maxErrorCount: config.MAX_ERROR_COUNT ?? 10,
            providerFallbackChain: config.providerFallbackChain || {},
            coordination: runtimeOptions.coordination || null,
            persistenceEnabled: runtimeOptions.persistenceEnabled !== false,
            stateEventSink: runtimeOptions.stateEventSink || null,
            configEventSink: runtimeOptions.configEventSink || null,
            identityEventSink: runtimeOptions.identityEventSink || null,
            providerConfigRevision: runtimeOptions.providerConfigRevision || 0,
        });
        logger.info('[Initialization] ProviderPoolManager initialized.');
    }

    if (config.providerPools && Object.keys(config.providerPools).length > 0) {
        if(isReady){
            // --- V2: 瑙﹀彂绯荤粺棰勭儹 ---
            // 棰勭儹閫昏緫鏄紓姝ョ殑锛屼笉浼氶樆濉炴湇鍔″櫒鍚姩
            providerPoolManager.warmupNodes().catch(err => {
                logger.error(`[Initialization] Warmup failed: ${err.message}`);
            });

            // 妫€鏌ュ苟鍒锋柊鍗冲皢杩囨湡鐨勮妭鐐癸紙寮傛璋冪敤锛屼笉闃诲鍚姩锛?
            providerPoolManager.checkAndRefreshExpiringNodes().catch(err => {
                logger.error(`[Initialization] Check and refresh expiring nodes failed: ${err.message}`);
            });
        }
    } else {
        logger.info('[Initialization] Provider pools are currently empty.');
    }

    // Initialize all provider pool nodes at startup
    // 鍒濆鍖栧彿姹犱腑鎵€鏈夋彁渚涘晢鐨勬墍鏈夎妭鐐癸紝浠ラ伩鍏嶉涓姹傜殑棰濆寤惰繜
    if (config.providerPools && Object.keys(config.providerPools).length > 0) {
        let totalInitialized = 0;
        let totalFailed = 0;
        
        for (const [providerType, providerConfigs] of Object.entries(config.providerPools)) {
            // 楠岃瘉鎻愪緵鍟嗙被鍨嬫槸鍚︽湁鏁堜笖琚寘鍚湪 DEFAULT_MODEL_PROVIDERS 涓?
            // 濡傛灉娌¤缃?DEFAULT_MODEL_PROVIDERS锛屽垯鍏佽鎵€鏈夊凡娉ㄥ唽鐨勭被鍨?
            const isDefaultProvider = !config.DEFAULT_MODEL_PROVIDERS || 
                                     (Array.isArray(config.DEFAULT_MODEL_PROVIDERS) && config.DEFAULT_MODEL_PROVIDERS.includes(providerType));
            
            if (!isDefaultProvider) {
                // 杩涗竴姝ユ鏌ユ槸鍚︽槸娉ㄥ唽鎻愪緵鍟嗙殑鍙樹綋锛堝甫鍚庣紑锛?
                const isVariantOfDefault = Array.isArray(config.DEFAULT_MODEL_PROVIDERS) && 
                                          config.DEFAULT_MODEL_PROVIDERS.some(p => providerType.startsWith(p + '-'));
                
                if (!isVariantOfDefault) {
                    logger.info(`[Initialization] Skipping provider type '${providerType}' (not in DEFAULT_MODEL_PROVIDERS).`);
                    continue;
                }
            }
            
            if (!Array.isArray(providerConfigs) || providerConfigs.length === 0) {
                continue;
            }
            
            logger.info(`[Initialization] Initializing ${providerConfigs.length} node(s) for provider '${providerType}'...`);
            
            // 鍒濆鍖栬鎻愪緵鍟嗙被鍨嬬殑鎵€鏈夎妭鐐?
            for (const providerConfig of providerConfigs) {
                // 璺宠繃宸茬鐢ㄧ殑鑺傜偣
                if (providerConfig.isDisabled) {
                    continue;
                }
                
                try {
                    // 鍚堝苟鍏ㄥ眬閰嶇疆鍜岃妭鐐归厤缃?
                    const nodeConfig = deepmerge(config, {
                        ...providerConfig,
                        MODEL_PROVIDER: providerType
                    });
                    delete nodeConfig.providerPools; // 绉婚櫎 providerPools 閬垮厤閫掑綊
                    
                    // 鍒濆鍖栨湇鍔￠€傞厤鍣?
                    getServiceAdapter(nodeConfig);
                    totalInitialized++;
                    
                    const identifier = providerConfig.customName || providerConfig.uuid || 'unknown';
                    logger.info(`  鉁?Initialized node: ${identifier}`);
                } catch (error) {
                    totalFailed++;
                    const identifier = providerConfig.customName || providerConfig.uuid || 'unknown';
                    logger.warn(`  鉁?Failed to initialize node ${identifier}: ${error.message}`);
                }
            }
        }
        
        logger.info(`[Initialization] Provider pool initialization complete: ${totalInitialized} succeeded, ${totalFailed} failed.`);
    } else {
        logger.info('[Initialization] No provider pools configured. Skipping node initialization.');
    }
    return serviceInstances; // Return the collection of initialized service instances
}

/**
 * [璺敱瑙ｆ瀽灞俔 璐熻矗鍓嶇疆澶勭悊鍓嶇紑鍜?AUTO 妯″紡杞崲
 * @private
 * @returns {Promise<Object>} { effectiveProvider, actualModelName }
 */
async function _resolveEffectiveRouting(config, requestedModel, options = {}) {
    let effectiveProvider = config.MODEL_PROVIDER;
    let actualModelName = requestedModel;

    // 1. 澶勭悊鏄惧紡鍓嶇紑 (鏃犺鏄惁鏄?AUTO 妯″紡閮芥敮鎸?
    if (requestedModel && requestedModel.includes(':')) {
        const [prefix, ...modelParts] = requestedModel.split(':');
        const modelSuffix = modelParts.join(':');
        // 妫€鏌ュ墠缂€鏄惁鏄湁鏁堢殑鎻愪緵鍟嗘爣璇?
        if (providerPoolManager && (providerPoolManager.providerStatus[prefix] || config.providerPools?.[prefix])) {
            effectiveProvider = prefix;
            actualModelName = modelSuffix;
            logger.info(`[Routing] Prefix resolved: ${prefix}:${modelSuffix}`);
        }
    }

    let entryModelReason = null;
    let requestedEntryModel = actualModelName;
    if (isCodexProviderType(effectiveProvider) && actualModelName) {
        requestedEntryModel = actualModelName;
        const resolved = resolveCodexEntryModel({
            model: actualModelName,
            supported: isSupportedCodexModel(effectiveProvider, actualModelName),
            preserveRequestedModel: options.preserveRequestedCodexModel === true
        });
        entryModelReason = resolved.reason || null;
        if (resolved.actualModel !== actualModelName) {
            const log = resolved.reason === 'UNSUPPORTED_MODEL' ? logger.warn.bind(logger) : logger.info.bind(logger);
            log(`[Routing] Codex model '${actualModelName}' routed to '${resolved.actualModel}' (${resolved.reason})`);
            actualModelName = resolved.actualModel;
        }
    }

    // 2. 涓ユ牸鎬ф鏌ワ細鍦?AUTO 妯″紡涓嬶紝濡傛灉鍒拌繖閲岃繕娌¤В鏋愬嚭鍏蜂綋鎻愪緵鍟嗭紝鍒欐姤閿?(闄ら潪鏄垪鍑烘ā鍨嬪満鏅?
    if (effectiveProvider === MODEL_PROVIDER.AUTO && requestedModel) {
        throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${requestedModel}'`);
    }

    return { effectiveProvider, actualModelName, entryModelReason, requestedEntryModel };
}

/**
 * Get API service adapter, considering provider pools
 * @param {Object} config - The current request configuration
 * @param {string} [requestedModel] - Optional. The model name to filter providers by.
 * @param {Object} [options] - Optional. Additional options.
 * @param {boolean} [options.skipUsageCount] - Optional. If true, skip incrementing usage count.
 * @returns {Promise<Object>} The API service adapter
 */
export async function getApiService(config, requestedModel = null, options = {}) {
    // 1. 鍓嶇疆璺敱瑙ｆ瀽
    const { effectiveProvider, actualModelName } = await _resolveEffectiveRouting(config, requestedModel, options);
    config.MODEL_PROVIDER = effectiveProvider;

    // 妯″瀷鍒楄〃鐗规畩鍦烘櫙锛欰UTO 涓旀棤妯″瀷鍚?
    if (effectiveProvider === MODEL_PROVIDER.AUTO && !actualModelName) return null;

    let serviceConfig = config;
    const isPoolable = PROVIDER_MAPPINGS.some(m => m.providerType === config.MODEL_PROVIDER);
    const providerFilterStartedAt = performance.now();
    if (providerPoolManager && ((config.providerPools && config.providerPools[config.MODEL_PROVIDER]) || isPoolable)) {
        const selectionDiagnostics = initializeSelectionDiagnostics(options.selectionDiagnostics || {});
        selectionDiagnostics.selectionStartedAt = providerFilterStartedAt;
        const groupSelection = await selectCodexCredentialGroupProvider(
            config,
            config.MODEL_PROVIDER,
            actualModelName,
            options,
            selectionDiagnostics
        );
        const selectedProviderConfig = groupSelection.handled
            ? groupSelection.selectedResult?.config
            : await providerPoolManager.selectProvider(
                config.MODEL_PROVIDER,
                actualModelName,
                withStickyProviderAffinity(config, config.MODEL_PROVIDER, {
                    ...options,
                    selectionDiagnostics,
                    requestedModel: actualModelName,
                    skipUsageCount: true
                })
            );
        if (selectedProviderConfig) {
            // 鍚堝苟閫変腑鐨勬彁渚涜€呴厤缃埌褰撳墠璇锋眰鐨?config 涓?
            serviceConfig = deepmerge(config, selectedProviderConfig);
            delete serviceConfig.providerPools; // 绉婚櫎 providerPools 灞炴€?
            config.uuid = serviceConfig.uuid;
            config.customName = serviceConfig.customName;
            const customNameDisplay = serviceConfig.customName ? ` (${serviceConfig.customName})` : '';
            logger.info(`[API Service] Using pooled configuration for ${config.MODEL_PROVIDER}: ${serviceConfig.uuid}${customNameDisplay}${actualModelName ? ` (model: ${actualModelName})` : ''}`);
            logGeminiSelectionDiagnostic(config.MODEL_PROVIDER, actualModelName, selectionDiagnostics, selectedProviderConfig, providerFilterStartedAt, config);
        } else {
            throwProviderSelectionFailure(
                config,
                actualModelName,
                options,
                selectionDiagnostics,
                groupSelection.availabilityError
            );
        }
    } else if (effectiveProvider === MODEL_PROVIDER.AUTO && actualModelName) {
        // 濡傛灉鍦?AUTO 妯″紡涓嬩緷鐒舵病鑳借В鏋愬嚭鍏蜂綋鎻愪緵鍟嗭紝鍒欐姤閿?
        throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${actualModelName}'`);
    }
    recordProviderFilterStages(providerFilterStartedAt);
    await ensureCodexIdentityForServiceConfig(serviceConfig, config.MODEL_PROVIDER);
    return getServiceAdapter(serviceConfig);
}

/**
 * Get API service adapter with fallback support and return detailed result
 * @param {Object} config - The current request configuration
 * @param {string} [requestedModel] - Optional. The model name to filter providers by.
 * @param {Object} [options] - Optional. Additional options.
 * @returns {Promise<Object>} Object containing service adapter and metadata
 */
export async function getApiServiceWithFallback(config, requestedModel = null, options = {}) {
    // 1. 鍓嶇疆璺敱瑙ｆ瀽
    const { effectiveProvider, actualModelName, entryModelReason, requestedEntryModel } = await _resolveEffectiveRouting(config, requestedModel, options);
    config.MODEL_PROVIDER = effectiveProvider;

    const codexFallbackTarget = isCodexProviderType(effectiveProvider)
        ? getCodexModelFallbackTarget(actualModelName, config)
        : null;
    if (codexFallbackTarget && options.forceCodexModelFallback === true && options.modelFallbackAttempted !== true) {
        const fallbackResult = await getApiServiceWithFallback(config, codexFallbackTarget, {
            ...options,
            forceCodexModelFallback: false,
            modelFallbackAttempted: true,
            excludeProviderUuids: []
        });
        const result = {
            ...fallbackResult,
            isFallback: true,
            actualModel: fallbackResult.actualModel || codexFallbackTarget,
            modelFallbackFrom: actualModelName,
            modelFallbackTo: fallbackResult.actualModel || codexFallbackTarget,
            modelFallbackReason: options.modelFallbackReason || 'MODEL_UNAVAILABLE'
        };
        finalizeCodexRouteResult(config, {
            selectedProviderUuid: result.uuid,
            actualProviderType: result.actualProviderType,
            serviceConfig: result.serviceConfig,
            actualModel: result.actualModel,
            modelFallbackFrom: result.modelFallbackFrom,
            modelFallbackTo: result.modelFallbackTo,
            modelFallbackReason: result.modelFallbackReason
        });
        return result;
    }

    // 妯″瀷鍒楄〃鐗规畩鍦烘櫙锛欰UTO 涓旀棤妯″瀷鍚?
    if (effectiveProvider === MODEL_PROVIDER.AUTO && !actualModelName) {
        return { service: null, serviceConfig: config, actualProviderType: effectiveProvider, isFallback: false, uuid: null, actualModel: null };
    }

    let serviceConfig = config;
    let actualProviderType = config.MODEL_PROVIDER;
    let isFallback = false;
    let selectedUuid = null;
    let actualModel = actualModelName;
    let selectedModelFallbackReason = null;
    const selectionDiagnostics = initializeSelectionDiagnostics(options.selectionDiagnostics || {});
    selectionDiagnostics.selectionStartedAt = null;
    const routingOptions = {
        ...options,
        selectionDiagnostics
    };
    const providerFilterStartedAt = performance.now();
    selectionDiagnostics.selectionStartedAt = providerFilterStartedAt;
    
    const isPoolable = PROVIDER_MAPPINGS.some(m => m.providerType === config.MODEL_PROVIDER);
    if (providerPoolManager && ((config.providerPools && config.providerPools[config.MODEL_PROVIDER]) || isPoolable)) {
        // selectProviderWithFallback 鐜板湪鏄紓姝ョ殑锛屼娇鐢ㄩ摼寮忛攣纭繚骞跺彂瀹夊叏
        // 濡傛灉寮€鍚簡骞跺彂闄愬埗锛屽垯浣跨敤 acquireSlot 杩涜閫夋嫨鍜屽崰浣?
        const useAcquire = options.acquireSlot === true;
        let selectedResult;
        let availabilityError = null;
        let groupSelection;
        const genericKeyLease = await acquirePotluckKeyConcurrencyLeaseIfNeeded(
            config,
            config.MODEL_PROVIDER,
            routingOptions,
            selectionDiagnostics
        );
        try {
            groupSelection = await selectCodexCredentialGroupProvider(
                config,
                config.MODEL_PROVIDER,
                actualModelName,
                routingOptions,
                selectionDiagnostics
            );
        } catch (error) {
            if (codexFallbackTarget && options.modelFallbackAttempted !== true && isCodexModelFallbackEligibleError(error)) {
                return getApiServiceWithFallback(config, actualModelName, {
                    ...options,
                    forceCodexModelFallback: true,
                    modelFallbackAttempted: false,
                    modelFallbackReason: error.status === 429 ? 'PROVIDER_SELECTION_429' : 'MODEL_UNAVAILABLE'
                });
            }
            if (genericKeyLease) await releasePotluckKeyConcurrencyLease();
            throw error;
        }

        if (groupSelection.handled) {
            selectedResult = groupSelection.selectedResult;
            availabilityError = groupSelection.availabilityError;
            if (!selectedResult && codexFallbackTarget && options.modelFallbackAttempted !== true) {
                return getApiServiceWithFallback(config, actualModelName, {
                    ...options,
                    forceCodexModelFallback: true,
                    modelFallbackAttempted: false,
                    modelFallbackReason: 'MODEL_UNAVAILABLE'
                });
            }
        } else {
            const failoverKey = isCodexProviderType(config.MODEL_PROVIDER)
                ? config._codexOverloadFailoverKey
                : null;
            const pendingExcludedUuid = failoverKey
                ? codexOverloadFailoverStore.getPendingExclusion(failoverKey)
                : null;
            const pinnedProviderUuid = failoverKey
                ? codexOverloadFailoverStore.getPinnedProvider(failoverKey)
                : null;
            const originalExcludedUuids = options.excludeProviderUuids || [];
            const preferredProviderUuid = pinnedProviderUuid === pendingExcludedUuid
                ? null
                : pinnedProviderUuid;

            const selectFromPool = async (selectionOptions) => {
                if (useAcquire) {
                    return providerPoolManager.acquireSlotWithFallback(
                        config.MODEL_PROVIDER,
                        actualModelName,
                        selectionOptions
                    );
                }
                return providerPoolManager.selectProviderWithFallback(
                    config.MODEL_PROVIDER,
                    actualModelName,
                    { ...selectionOptions, skipUsageCount: true }
                );
            };

            const selectionOptions = withStickyProviderAffinity(config, config.MODEL_PROVIDER, {
                ...routingOptions,
                requestedModel: actualModelName,
                preferredProviderUuid,
                excludeProviderUuids: [...new Set([
                    ...originalExcludedUuids,
                    ...(pendingExcludedUuid ? [pendingExcludedUuid] : [])
                ])]
            });

            try {
                selectedResult = await selectFromPool(selectionOptions);
            } catch (error) {
                if (genericKeyLease) await releasePotluckKeyConcurrencyLease();
                throw error;
            }

            // 杩囪浇 UUID 鍙槸杞帓闄わ紱濡傛灉娌℃湁鍏朵粬鍙敤鑺傜偣锛屾挙閿€璇ユ帓闄ゅ苟鍏佽缁х画浣跨敤鍞竴/鍘熷嚟璇併€?
            if (!selectedResult && pendingExcludedUuid) {
                logger.info(`[Codex Overload] No alternative provider available; retrying selection with previous provider allowed: ${pendingExcludedUuid}`);
                const fallbackSelectionOptions = withStickyProviderAffinity(config, config.MODEL_PROVIDER, {
                    ...routingOptions,
                    requestedModel: actualModelName,
                    preferredProviderUuid: null,
                    excludeProviderUuids: originalExcludedUuids
                });
                try {
                    selectedResult = await selectFromPool(fallbackSelectionOptions);
                } catch (error) {
                    if (genericKeyLease) await releasePotluckKeyConcurrencyLease();
                    throw error;
                }
            }

            // 璇锋眰鍐呯灛鎬侀敊璇噸璇曚細鍏堟帓闄ゅ凡灏濊瘯鐨勫嚟璇佷互浼樺厛瑕嗙洊鍏朵粬璐﹀彿銆?
            // 鑻ュ叏閮ㄥ凡灏濊瘯鍑瘉浠嶇劧婊¤冻鏍囧噯鍙锋睜璋冨害鏉′欢锛屽垯鍏佽閲嶆柊杩涘叆閫夋嫨鍣ㄥ惊鐜紱
            // 涓嶇洿鎺ユ寚瀹氬嚟璇侊紝鍥犳鍋ュ悍銆侀搴︺€佸喎鍗淬€佹ā鍨嬫敮鎸佸拰骞跺彂闄愬埗浠嶄細瀹屾暣鐢熸晥銆?
            if (!selectedResult && options.allowExcludedProviderFallback === true && originalExcludedUuids.length > 0) {
                logger.info(`[Credential Retry] No untried provider available; retrying standard selection with previously tried providers eligible again`);
                const retrySelectionOptions = withStickyProviderAffinity(config, config.MODEL_PROVIDER, {
                    ...routingOptions,
                    requestedModel: actualModelName,
                    preferredProviderUuid: null,
                    excludeProviderUuids: []
                });
                try {
                    selectedResult = await selectFromPool(retrySelectionOptions);
                } catch (error) {
                    if (genericKeyLease) await releasePotluckKeyConcurrencyLease();
                    throw error;
                }
            }

            if (selectedResult && failoverKey && pendingExcludedUuid) {
                const selectedUuid = selectedResult.config?.uuid;
                if (selectedUuid && selectedUuid !== pendingExcludedUuid) {
                    codexOverloadFailoverStore.pinAlternative(failoverKey, selectedUuid);
                    logger.info(`[Codex Overload] Switched session to alternative provider: ${selectedUuid}`);
                } else {
                    codexOverloadFailoverStore.consumePendingExclusion(failoverKey);
                    logger.info(`[Codex Overload] Reusing previous provider because no alternative was available: ${pendingExcludedUuid}`);
                }
            }
        }

        if (genericKeyLease && !selectedResult) await releasePotluckKeyConcurrencyLease();
        
        if (selectedResult) {
            const {
                config: selectedProviderConfig,
                actualProviderType: selectedType,
                isFallback: fallbackUsed,
                actualModel: fallbackModel,
                modelFallbackReason: fallbackReason,
                queueWaitMs = 0,
                fallbackAttemptCount = 0,
                queueOutcome = null
            } = selectedResult;
            
            // 鍚堝苟閫変腑鐨勬彁渚涜€呴厤缃埌褰撳墠璇锋眰鐨?config 涓?
            serviceConfig = deepmerge(config, selectedProviderConfig);
            delete serviceConfig.providerPools;
            
            actualProviderType = selectedType;
            isFallback = fallbackUsed;
            selectedUuid = selectedProviderConfig.uuid;
            actualModel = fallbackModel || actualModelName;
            selectedModelFallbackReason = fallbackReason || null;
            logGeminiSelectionDiagnostic(config.MODEL_PROVIDER, actualModelName, selectionDiagnostics, selectedProviderConfig, providerFilterStartedAt, config);
            const sourceAvailability = selectionDiagnostics.sourceAvailability
                || selectedResult.sourceAvailability
                || requestContext.getStore()?.antigravityRouting?.sourceAvailability
                || null;
            config._modelRouting = {
                requestedModel: actualModelName,
                actualModel,
                modelFallbackFrom: fallbackUsed && actualModel !== actualModelName ? actualModelName : null,
                modelFallbackTo: fallbackUsed && actualModel !== actualModelName ? actualModel : null,
                modelFallbackReason: fallbackReason || null,
                queueWaitMs: Number(queueWaitMs || 0),
                fallbackAttemptCount: Number(fallbackAttemptCount || 0),
                queueOutcome: queueOutcome || null,
                ...(sourceAvailability ? { sourceAvailability } : {})
            };

            // mixed pool/fallback 鍙兘璺?providerType 鍛戒腑鐪熷疄鑺傜偣锛岄渶瑕佸垏鍒扮湡瀹?adapter銆?
            if (actualProviderType && actualProviderType !== config.MODEL_PROVIDER) {
                serviceConfig.MODEL_PROVIDER = actualProviderType;
            }
        } else {
            throwProviderSelectionFailure(
                config,
                actualModelName,
                options,
                selectionDiagnostics,
                availabilityError
            );
        }
    } else if (effectiveProvider === MODEL_PROVIDER.AUTO && actualModelName) {
        // 濡傛灉鍦?AUTO 妯″紡涓嬩緷鐒舵病鑳借В鏋愬嚭鍏蜂綋鎻愪緵鍟嗭紝鍒欐姤閿?
        throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${actualModelName}'`);
    }
    recordProviderFilterStages(providerFilterStartedAt);

    await ensureCodexIdentityForServiceConfig(serviceConfig, actualProviderType, selectedUuid);
    if (selectedUuid && serviceConfig.codexAccountKey) {
        await persistCodexIdentityToProviderPool(config, actualProviderType, selectedUuid, {
            codexAccountKey: serviceConfig.codexAccountKey,
            codexAccountId: serviceConfig.codexAccountId,
            codexEmail: serviceConfig.codexEmail
        });
    }
    
    const service = getServiceAdapter(serviceConfig);
    if (config._codexRouting) {
        config._codexRouting.hotShardApplied = selectionDiagnostics.hotShardApplied === true;
        config._codexRouting.keyQueueWaitMs = Number(selectionDiagnostics.keyQueueWaitMs || 0);
        config._codexRouting.keyQueueOutcome = selectionDiagnostics.keyQueueOutcome || null;
        config._codexRouting.keyCapacityExhausted = selectionDiagnostics.keyCapacityExhausted === true;
        config._codexRouting.groupWaitMs = Number(selectionDiagnostics.groupWaitMs || config._codexRouting.groupWaitMs || 0);
        config._codexRouting.groupRetryCount = Number(selectionDiagnostics.groupRetryCount || config._codexRouting.groupRetryCount || 0);
        config._codexRouting.fallbackAttemptCount = Number(selectionDiagnostics.fallbackAttemptCount || 0);
        config._codexRouting.availabilityReason = selectionDiagnostics.availabilityReason || config._codexRouting.availabilityReason || null;
        config._codexRouting.candidateGroupId = selectionDiagnostics.candidateGroupId || null;
        config._codexRouting.candidateProviderCount = Number(selectionDiagnostics.candidateProviderCount || 0);
        config._codexRouting.unavailableProviderCount = Number(selectionDiagnostics.unavailableProviderCount || 0);
    }

    const sparkAliasMetadata = entryModelReason === 'SPARK_ALIAS' && requestedEntryModel && actualModel
        ? {
            modelFallbackFrom: requestedEntryModel,
            modelFallbackTo: actualModel,
            modelFallbackReason: 'SPARK_ALIAS'
        }
        : {};
    const fallbackMetadata = isFallback && actualModel !== actualModelName
        ? {
            modelFallbackFrom: actualModelName,
            modelFallbackTo: actualModel,
            modelFallbackReason: selectedModelFallbackReason || options.modelFallbackReason || 'MODEL_UNAVAILABLE'
        }
        : sparkAliasMetadata;
    finalizeCodexRouteResult(config, {
        selectedProviderUuid: selectedUuid,
        actualProviderType,
        serviceConfig,
        actualModel,
        ...fallbackMetadata
    });
    
    return {
        service,
        serviceConfig,
        actualProviderType,
        isFallback,
        uuid: selectedUuid,
        actualModel,
        ...(config._modelRouting ? {
            queueWaitMs: config._modelRouting.queueWaitMs,
            fallbackAttemptCount: config._modelRouting.fallbackAttemptCount,
            queueOutcome: config._modelRouting.queueOutcome
        } : {}),
        ...fallbackMetadata
    };
}

function finalizeCodexRouteResult(config, {
    selectedProviderUuid = null,
    actualProviderType = null,
    serviceConfig = null,
    actualModel = null,
    modelFallbackFrom = null,
    modelFallbackTo = null,
    modelFallbackReason = null
} = {}) {
    const diagnostics = config._codexRouting || {};
    const previous = config._codexRouteResult || {};
    const routingMode = diagnostics.routingMode || previous.routingMode || null;
    const finalProviderUuid = selectedProviderUuid || diagnostics.selectedProviderUuid || previous.selectedProviderUuid || null;
    const previousProviderUuid = previous.selectedProviderUuid || null;
    const preservePreviousIdentity = !previousProviderUuid || previousProviderUuid === finalProviderUuid;
    const selectedGroupId = routingMode === 'pool' || routingMode === 'restricted'
        ? null
        : diagnostics.selectedGroupId || previous.selectedGroupId || null;
    const actualProviderGroupId = routingMode === 'pool' || routingMode === 'restricted' ? null : selectedGroupId;
    const providerSwitchCount = Number(previous.providerSwitchCount || 0)
        + (previousProviderUuid && finalProviderUuid && previousProviderUuid !== finalProviderUuid ? 1 : 0);
    const routeResult = {
        ...previous,
        ...diagnostics,
        routingMode,
        selectedGroupId,
        selectedProviderUuid: finalProviderUuid,
        actualProviderType: actualProviderType || (preservePreviousIdentity ? previous.actualProviderType : null),
        providerName: serviceConfig?.customName || (preservePreviousIdentity ? previous.providerName : null),
        accountIdentity: serviceConfig?.codexAccountKey
            || serviceConfig?.codexAccountId
            || (preservePreviousIdentity ? previous.accountIdentity : null),
        accountEmail: serviceConfig?.codexEmail || (preservePreviousIdentity ? previous.accountEmail : null),
        actualProviderGroupId,
        providerSwitchCount,
        actualModel: actualModel || previous.actualModel || null,
        modelFallbackFrom: modelFallbackFrom || previous.modelFallbackFrom || null,
        modelFallbackTo: modelFallbackTo || previous.modelFallbackTo || null,
        modelFallbackReason: modelFallbackReason || previous.modelFallbackReason || null,
        ...(routingMode === 'fixed'
            ? { fixedCredentialUuid: config.potluckKeyData?.fixedCredential?.uuid || previous.fixedCredentialUuid || null }
            : {})
    };
    routeResult.consistencyStatus = getCodexRoutingConsistencyStatus(routeResult, finalProviderUuid);
    config._codexRouteResult = routeResult;
    updateCodexRoutingDiagnostics(config, routeResult);
    return routeResult;
}

/**
 * Get the provider pool manager instance
 * @returns {Object} The provider pool manager
 */
export function getProviderPoolManager() {
    return providerPoolManager;
}

/**
 * Mark provider as unhealthy
 * @param {string} provider - The model provider
 * @param {Object} providerInfo - Provider information including uuid
 */
export function markProviderUnhealthy(provider, providerInfo) {
    if (providerPoolManager) {
        providerPoolManager.markProviderUnhealthy(provider, providerInfo);
    }
}

/**
 * Get providers status
 * @param {Object} config - The current request configuration
 * @param {Object} [options] - Optional. Additional options.
 * @param {boolean} [options.provider] - Optional.provider filter by provider type
 * @param {boolean} [options.customName] - Optional.customName filter by customName
 * @returns {Promise<Object>} The API service adapter
 */
export async function getProviderStatus(config, options = {}) {
    let providerPools = {};
    const filePath = config.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    try {
        if (providerPoolManager && providerPoolManager.providerPools) {
            providerPools = providerPoolManager.providerPools;
        } else if (filePath && fs.existsSync(filePath)) {
            const poolsData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            providerPools = poolsData;
        }
    } catch (error) {
        logger.warn('[API Service] Failed to load provider pools:', error.message);
    }

    // providerPoolsSlim 鍙繚鐣欓《绾?key 鍙婇儴鍒嗗瓧娈?
    const slimFields = [
        'uuid',
        'customName',
        'isHealthy',
        'isDisabled',
        'lastErrorTime',
        'lastErrorMessage',
        'needsRefresh'
    ];
    // identify 瀛楁鏄犲皠琛?
    const identifyFieldMap = {
        'openai-custom': 'OPENAI_BASE_URL',
        'atlascloud': 'OPENAI_BASE_URL',
        'openaiResponses-custom': 'OPENAI_BASE_URL',
        'gemini-cli-oauth': 'GEMINI_OAUTH_CREDS_FILE_PATH',
        'claude-custom': 'CLAUDE_BASE_URL',
        'claude-kiro-oauth': 'KIRO_OAUTH_CREDS_FILE_PATH',
        'openai-qwen-oauth': 'QWEN_OAUTH_CREDS_FILE_PATH',
        'gemini-antigravity': 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH',
        'openai-iflow': 'IFLOW_TOKEN_FILE_PATH',
        'forward-api': 'FORWARD_BASE_URL',
        'grok-web': 'GROK_COOKIE_TOKEN',
        'grok-cli-oauth': 'GROK_CLI_OAUTH_CREDS_FILE_PATH',
        'openai-codex-oauth': 'CODEX_OAUTH_CREDS_FILE_PATH'
    };
    let providerPoolsSlim = [];
    let unhealthyProvideIdentifyList = [];
    let count = 0;
    let unhealthyCount = 0;
    let unhealthyRatio = 0;
    const filterProvider = options && options.provider;
    const filterCustomName = options && options.customName;
    for (const key of Object.keys(providerPools)) {
        if (!Array.isArray(providerPools[key])) continue;
        if (filterProvider && key !== filterProvider) continue;
        
        let identifyField = identifyFieldMap[key] || null;
        if (!identifyField) {
            // 灏濊瘯閫氳繃鍓嶇紑鏌ユ壘 identifyField (渚嬪 openai-custom-1 -> openai-custom)
            for (const [prefix, field] of Object.entries(identifyFieldMap)) {
                if (key.startsWith(prefix + '-')) {
                    identifyField = field;
                    break;
                }
            }
        }
        
        const slimArr = providerPools[key]
            .filter(item => {
                if (item.isDisabled) return false;
                if (filterCustomName && item.customName !== filterCustomName) return false;
                return true;
            })
            .map(item => {
                const slim = {};
                for (const f of slimFields) {
                    let val = item.hasOwnProperty(f) ? item[f] : null;
                    if (f === 'uuid' && typeof val === 'string' && val.length > 8) {
                        val = val.substring(0, 8) + '...' + val.substring(val.length - 4);
                    }
                    slim[f] = val;
                }
                // identify 瀛楁
                if (identifyField && item.hasOwnProperty(identifyField)) {
                    let tmpCustomName = item.customName ? `${item.customName}` : (slim.uuid || 'NoUUID');
                    let identifyStr = `${tmpCustomName}::${key}`;
                    slim.identify = identifyStr;
                } else {
                    slim.identify = null;
                }
                slim.provider = key;
                // 缁熻
                count++;
                if (slim.isHealthy === false) {
                    unhealthyCount++;
                    if (slim.identify) unhealthyProvideIdentifyList.push(slim.identify);
                }
                return slim;
            });
        providerPoolsSlim.push(...slimArr);
    }
    if (count > 0) {
        unhealthyRatio = Number((unhealthyCount / count).toFixed(2));
    }
        let unhealthySummeryMessage = unhealthyProvideIdentifyList.join('\n');
        if (unhealthySummeryMessage === '') unhealthySummeryMessage = null;
    return {
        providerPoolsSlim,
        unhealthySummeryMessage,
        count,
        unhealthyCount,
        unhealthyRatio
    };
}
