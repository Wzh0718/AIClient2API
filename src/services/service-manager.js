import { getServiceAdapter, invalidateServiceAdapter, serviceInstances } from '../providers/adapter.js';
import logger from '../utils/logger.js';
import {
    ProviderPoolManager,
    getCodexModelFallbackTarget,
    getCodex53QuotaFallbackModel,
    shouldTryCodex53QuotaModelFallback
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
import requestContext from '../utils/context.js';
import { PotluckKeyConcurrencyLimiter } from '../plugins/api-potluck/key-concurrency-limiter.js';

// 存储 ProviderPoolManager 实例
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
    return model?.endsWith('-fast') && models.includes(model.slice(0, -5));
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
    'keyCapacityExhausted'
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
        attempts: []
    });
    return selectionDiagnostics;
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

async function getCodex53QuotaFallbackService(config, requestedModel, options = {}) {
    const fallbackModel = getCodex53QuotaFallbackModel(config);
    const fallbackResult = await getApiServiceWithFallback(config, fallbackModel, {
        ...options,
        forceCodexModelFallback: false,
        modelFallbackAttempted: true,
        allowCodexFixedFallbackToOtherCredentials: true,
        excludeProviderUuids: []
    });
    const actualModel = fallbackResult.actualModel || fallbackModel;
    const result = {
        ...fallbackResult,
        isFallback: true,
        actualModel,
        modelFallbackFrom: requestedModel,
        modelFallbackTo: actualModel,
        modelFallbackReason: 'CODEX53_QUOTA_EXHAUSTED'
    };
    finalizeCodexRouteResult(config, {
        selectedProviderUuid: result.uuid,
        actualProviderType: result.actualProviderType,
        serviceConfig: result.serviceConfig,
        actualModel,
        modelFallbackFrom: requestedModel,
        modelFallbackTo: actualModel,
        modelFallbackReason: result.modelFallbackReason
    });
    return result;
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
    if (requested.endsWith('-fast') && requested.slice(0, -5) === configured) return true;
    return configured.endsWith('-fast') && configured.slice(0, -5) === requested;
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

    if (keyRouting.routingMode === 'pool') {
        const keyHash = config.potluckKeyData?.id
            ? `sha256:${crypto.createHash('sha256').update(String(config.potluckKeyData.id)).digest('hex').slice(0, 16)}`
            : 'none';
        logger.info(`[Codex Routing] pool selection key=${keyHash} mode=pool revision=${keyRouting.routingConfigRevision || 0}`);
        const poolKeyId = config.potluckKeyData?.id || null;
        if (useAcquire && poolKeyId && !requestContext.get('potluckKeyConcurrencyLease')) {
            const keyData = config.potluckKeyData || {};
            const keyQueueStartedAt = Date.now();
            try {
                const lease = await potluckKeyConcurrencyLimiter.acquire(poolKeyId, {
                    maxConcurrency: keyData.concurrencyLimit,
                    queueLimit: keyData.queueLimit,
                    queueTimeoutMs: keyData.queueTimeoutMs,
                    mode: keyData.concurrencyMode,
                    coordination: providerPoolManager?.coordination || null
                });
                requestContext.set('potluckKeyConcurrencyLease', lease);
                requestContext.set('potluckKeyConcurrencyKeyId', poolKeyId);
                selectionDiagnostics.keyQueueOutcome = lease.shadow ? 'shadow' : 'admitted';
                selectionDiagnostics.keyCapacityExhausted = lease.capacityExhausted === true;
                selectionDiagnostics.keyQueueWaitMs = Math.max(0, Date.now() - keyQueueStartedAt);
            } catch (error) {
                const reason = error?.details?.reason || 'key_capacity_exhausted';
                selectionDiagnostics.keyQueueOutcome = reason;
                selectionDiagnostics.keyQueueWaitMs = Math.max(0, Date.now() - keyQueueStartedAt);
                selectionDiagnostics.keyCapacityExhausted = true;
                updateCodexRoutingDiagnostics(config, {
                    routingMode: 'pool',
                    keyQueueWaitMs: selectionDiagnostics.keyQueueWaitMs,
                    keyQueueOutcome: reason,
                    keyCapacityExhausted: true
                });
                throw error;
            }
        }
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

    const attemptGroups = async ({ excludeProviderUuids, preferredProviderUuid }) => {
        for (const group of orderedGroups) {
            if (group.credentialUuids.length === 0) continue;
            const groupOptions = withStickyProviderAffinity(config, providerType, {
                ...options,
                selectionDiagnostics,
                requestedModel,
                allowedProviderUuids: group.credentialUuids,
                disableProviderFallback: true,
                preferredProviderUuid,
                excludeProviderUuids
            });
            try {
                const selectedResult = await selectFromPool(groupOptions);
                if (selectedResult) return { selectedResult, group };
            } catch (error) {
                if (!isCredentialAvailabilityError(error)) throw error;
                availabilityError = error;
            }
        }
        return null;
    };

    let selected = await attemptGroups({
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

async function acquirePotluckKeyConcurrencyLeaseIfNeeded(config, providerType, options, selectionDiagnostics) {
    if (options.acquireSlot !== true || !config?.potluckKeyData?.id) return false;
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
        return true;
    } catch (error) {
        const reason = error?.details?.reason || 'key_capacity_exhausted';
        selectionDiagnostics.keyQueueOutcome = reason;
        selectionDiagnostics.keyQueueWaitMs = Math.max(0, Date.now() - startedAt);
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
 * 扫描 configs 目录并自动关联未关联的配置文件到对应的提供商
 * @param {Object} config - 服务器配置对象
 * @param {Object} options - 可选参数
 * @param {boolean} options.onlyCurrentCred - 为 true 时，只自动关联当前凭证
 * @param {string} options.credPath - 当前凭证的路径（当 onlyCurrentCred 为 true 时必需）
 * @param {boolean} options.throwOnPersistError - 为 true 时，写盘失败回滚内存并抛错
 * @returns {Promise<Object>} 更新后的 providerPools 对象
 */
export async function autoLinkProviderConfigs(config, options = {}) {
    const previousProviderPools = JSON.parse(JSON.stringify(config.providerPools || {}));
    const originalProviderPools = options.throwOnPersistError
        ? JSON.parse(JSON.stringify(previousProviderPools))
        : null;
    // 确保 providerPools 对象存在
    if (!config.providerPools) {
        config.providerPools = {};
    }
    
    let totalNewProviders = 0;
    let updatedExistingProviders = 0;
    const allNewProviders = {};
    
    // 如果只关联当前凭证
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
        // 遍历所有提供商映射
        for (const mapping of PROVIDER_MAPPINGS) {
            const configsPath = path.join(process.cwd(), 'configs', mapping.dirName);
            const { providerType, credPathKey, defaultCheckModel, displayName, needsProjectId } = mapping;
            
            // 确保提供商类型数组存在
            if (!config.providerPools[providerType]) {
                config.providerPools[providerType] = [];
            }
            
            // 检查目录是否存在
            if (!fs.existsSync(configsPath)) {
                continue;
            }

            updatedExistingProviders += await backfillGeminiProviderAccountNames(
                config.providerPools[providerType],
                providerType,
                credPathKey
            );
            
            // 获取已关联的配置文件路径集合
            const linkedPaths = new Set();
            for (const provider of config.providerPools[providerType]) {
                if (provider[credPathKey]) {
                    // 使用公共方法添加路径的所有变体格式
                    addToUsedPaths(linkedPaths, provider[credPathKey]);
                }
            }
            
            // 递归扫描目录
            const newProviders = [];
            await scanProviderDirectory(configsPath, linkedPaths, newProviders, {
                providerType,
                credPathKey,
                defaultCheckModel,
                needsProjectId,
                existingProviders: config.providerPools[providerType]
            });
            
            // 如果有新的配置文件需要关联
            if (newProviders.length > 0) {
                config.providerPools[providerType].push(...newProviders);
                totalNewProviders += newProviders.length;
                allNewProviders[displayName] = newProviders;
            }
        }
    }
    
    // 如果有新的配置文件需要关联，保存更新后的 provider_pools.json
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
                    // 获取凭据路径键（支持 _CREDS_FILE_PATH 和 _TOKEN_FILE_PATH 两种格式）
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
 * 关联单个凭证文件到对应的提供商
 * @param {Object} config - 服务器配置对象
 * @param {string} credPath - 凭证文件路径（相对或绝对路径）
 * @returns {Promise<Object|null>} 返回关联结果或 null
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
        // 规范化路径
        const absolutePath = path.isAbsolute(credPath) ? credPath : path.join(process.cwd(), credPath);
        const relativePath = path.relative(process.cwd(), absolutePath);
        
        // 检查文件是否存在
        if (!fs.existsSync(absolutePath)) {
            logger.warn(`[Auto-Link] Credential file not found: ${relativePath}`);
            return null;
        }
        
        // 检查文件扩展名
        const ext = path.extname(absolutePath).toLowerCase();
        if (ext !== '.json') {
            logger.warn(`[Auto-Link] Only JSON files are supported: ${relativePath}`);
            return null;
        }
        
        // 根据文件路径确定提供商类型
        let matchedMapping = null;
        for (const mapping of PROVIDER_MAPPINGS) {
            const configsPath = path.join(process.cwd(), 'configs', mapping.dirName);
            // 检查文件是否在该提供商的配置目录下
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
        
        // 确保提供商类型数组存在
        if (!config.providerPools[providerType]) {
            config.providerPools[providerType] = [];
        }
        
        // 检查是否已关联
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
        
        // 创建新的提供商配置
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
        
        // 添加到配置
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
 * 递归扫描提供商配置目录
 * @param {string} dirPath - 目录路径
 * @param {Set} linkedPaths - 已关联的路径集合
 * @param {Array} newProviders - 新提供商配置数组
 * @param {Object} options - 配置选项
 * @param {string} options.credPathKey - 凭据路径键名
 * @param {string} options.defaultCheckModel - 默认检测模型
 * @param {boolean} options.needsProjectId - 是否需要 PROJECT_ID
 */
async function scanProviderDirectory(dirPath, linkedPaths, newProviders, options) {
    const { providerType, credPathKey, defaultCheckModel, needsProjectId, existingProviders = [] } = options;
    
    try {
        const files = await pfs.readdir(dirPath, { withFileTypes: true });
        
        for (const file of files) {
            const fullPath = path.join(dirPath, file.name);
            
            if (file.isFile()) {
                const ext = path.extname(file.name).toLowerCase();
                // 只处理 JSON 文件
                if (ext === '.json') {
                    const relativePath = path.relative(process.cwd(), fullPath);
                    const fileName = getFileName(fullPath);
                    const customName = isCodexProviderType(providerType)
                        ? await readCodexCredentialDisplayName(fullPath)
                        : await getGeminiProviderEmail(providerType, fullPath);
                    const codexIdentity = isCodexProviderType(providerType)
                        ? await readCodexCredentialIdentity(fullPath)
                        : null;
                    
                    // 使用与 ui-manager.js 相同的 isPathUsed 函数检查是否已关联
                    const isLinked = isPathUsed(relativePath, fileName, linkedPaths);
                    
                    if (!isLinked) {
                        if (isCodexProviderType(providerType)) {
                            const providersForIdentityCheck = [...existingProviders, ...newProviders];
                            if (findProviderIndexByCodexIdentity(providersForIdentityCheck, codexIdentity) >= 0) {
                                logger.info(`[Auto-Link] Skipping duplicate Codex credential identity: ${relativePath}`);
                                continue;
                            }
                        }
                        // 使用公共方法创建新的提供商配置
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
                // 递归扫描子目录（限制深度为 3 层）
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

// 注意：isValidOAuthCredentials 已移至 provider-utils.js 公共模块

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
            // --- V2: 触发系统预热 ---
            // 预热逻辑是异步的，不会阻塞服务器启动
            providerPoolManager.warmupNodes().catch(err => {
                logger.error(`[Initialization] Warmup failed: ${err.message}`);
            });

            // 检查并刷新即将过期的节点（异步调用，不阻塞启动）
            providerPoolManager.checkAndRefreshExpiringNodes().catch(err => {
                logger.error(`[Initialization] Check and refresh expiring nodes failed: ${err.message}`);
            });
        }
    } else {
        logger.info('[Initialization] Provider pools are currently empty.');
    }

    // Initialize all provider pool nodes at startup
    // 初始化号池中所有提供商的所有节点，以避免首个请求的额外延迟
    if (config.providerPools && Object.keys(config.providerPools).length > 0) {
        let totalInitialized = 0;
        let totalFailed = 0;
        
        for (const [providerType, providerConfigs] of Object.entries(config.providerPools)) {
            // 验证提供商类型是否有效且被包含在 DEFAULT_MODEL_PROVIDERS 中
            // 如果没设置 DEFAULT_MODEL_PROVIDERS，则允许所有已注册的类型
            const isDefaultProvider = !config.DEFAULT_MODEL_PROVIDERS || 
                                     (Array.isArray(config.DEFAULT_MODEL_PROVIDERS) && config.DEFAULT_MODEL_PROVIDERS.includes(providerType));
            
            if (!isDefaultProvider) {
                // 进一步检查是否是注册提供商的变体（带后缀）
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
            
            // 初始化该提供商类型的所有节点
            for (const providerConfig of providerConfigs) {
                // 跳过已禁用的节点
                if (providerConfig.isDisabled) {
                    continue;
                }
                
                try {
                    // 合并全局配置和节点配置
                    const nodeConfig = deepmerge(config, {
                        ...providerConfig,
                        MODEL_PROVIDER: providerType
                    });
                    delete nodeConfig.providerPools; // 移除 providerPools 避免递归
                    
                    // 初始化服务适配器
                    getServiceAdapter(nodeConfig);
                    totalInitialized++;
                    
                    const identifier = providerConfig.customName || providerConfig.uuid || 'unknown';
                    logger.info(`  ✓ Initialized node: ${identifier}`);
                } catch (error) {
                    totalFailed++;
                    const identifier = providerConfig.customName || providerConfig.uuid || 'unknown';
                    logger.warn(`  ✗ Failed to initialize node ${identifier}: ${error.message}`);
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
 * [路由解析层] 负责前置处理前缀和 AUTO 模式转换
 * @private
 * @returns {Promise<Object>} { effectiveProvider, actualModelName }
 */
async function _resolveEffectiveRouting(config, requestedModel, options = {}) {
    let effectiveProvider = config.MODEL_PROVIDER;
    let actualModelName = requestedModel;

    // 1. 处理显式前缀 (无论是否是 AUTO 模式都支持)
    if (requestedModel && requestedModel.includes(':')) {
        const [prefix, ...modelParts] = requestedModel.split(':');
        const modelSuffix = modelParts.join(':');
        // 检查前缀是否是有效的提供商标识
        if (providerPoolManager && (providerPoolManager.providerStatus[prefix] || config.providerPools?.[prefix])) {
            effectiveProvider = prefix;
            actualModelName = modelSuffix;
            logger.info(`[Routing] Prefix resolved: ${prefix}:${modelSuffix}`);
        }
    }

    if (isCodexProviderType(effectiveProvider) && actualModelName) {
        const resolved = resolveCodexEntryModel({
            model: actualModelName,
            supported: isSupportedCodexModel(effectiveProvider, actualModelName),
            preserveRequestedModel: options.preserveRequestedCodexModel === true
        });
        if (resolved.actualModel !== actualModelName) {
            const log = resolved.reason === 'UNSUPPORTED_MODEL' ? logger.warn.bind(logger) : logger.info.bind(logger);
            log(`[Routing] Codex model '${actualModelName}' routed to '${resolved.actualModel}' (${resolved.reason})`);
            actualModelName = resolved.actualModel;
        }
    }

    // 2. 严格性检查：在 AUTO 模式下，如果到这里还没解析出具体提供商，则报错 (除非是列出模型场景)
    if (effectiveProvider === MODEL_PROVIDER.AUTO && requestedModel) {
        throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${requestedModel}'`);
    }

    return { effectiveProvider, actualModelName };
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
    // 1. 前置路由解析
    const { effectiveProvider, actualModelName } = await _resolveEffectiveRouting(config, requestedModel, options);
    config.MODEL_PROVIDER = effectiveProvider;

    // 模型列表特殊场景：AUTO 且无模型名
    if (effectiveProvider === MODEL_PROVIDER.AUTO && !actualModelName) return null;

    let serviceConfig = config;
    const isPoolable = PROVIDER_MAPPINGS.some(m => m.providerType === config.MODEL_PROVIDER);
    const providerFilterStartedAt = performance.now();
    if (providerPoolManager && ((config.providerPools && config.providerPools[config.MODEL_PROVIDER]) || isPoolable)) {
        const selectionDiagnostics = initializeSelectionDiagnostics(options.selectionDiagnostics || {});
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
            // 合并选中的提供者配置到当前请求的 config 中
            serviceConfig = deepmerge(config, selectedProviderConfig);
            delete serviceConfig.providerPools; // 移除 providerPools 属性
            config.uuid = serviceConfig.uuid;
            config.customName = serviceConfig.customName;
            const customNameDisplay = serviceConfig.customName ? ` (${serviceConfig.customName})` : '';
            logger.info(`[API Service] Using pooled configuration for ${config.MODEL_PROVIDER}: ${serviceConfig.uuid}${customNameDisplay}${actualModelName ? ` (model: ${actualModelName})` : ''}`);
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
        // 如果在 AUTO 模式下依然没能解析出具体提供商，则报错
        throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${actualModelName}'`);
    }
    runtimeMetrics.recordStage('providerFilterMs', performance.now() - providerFilterStartedAt);
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
    // 1. 前置路由解析
    const { effectiveProvider, actualModelName } = await _resolveEffectiveRouting(config, requestedModel, options);
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

    // 模型列表特殊场景：AUTO 且无模型名
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
    const routingOptions = {
        ...options,
        selectionDiagnostics
    };
    const providerFilterStartedAt = performance.now();
    
    const isPoolable = PROVIDER_MAPPINGS.some(m => m.providerType === config.MODEL_PROVIDER);
    if (providerPoolManager && ((config.providerPools && config.providerPools[config.MODEL_PROVIDER]) || isPoolable)) {
        // selectProviderWithFallback 现在是异步的，使用链式锁确保并发安全
        // 如果开启了并发限制，则使用 acquireSlot 进行选择和占位
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
            if (
                options.modelFallbackAttempted !== true
                && shouldTryCodex53QuotaModelFallback(effectiveProvider, actualModelName, error, config)
            ) {
                return getCodex53QuotaFallbackService(config, actualModelName, options);
            }
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
            if (
                !selectedResult
                && options.modelFallbackAttempted !== true
                && shouldTryCodex53QuotaModelFallback(effectiveProvider, actualModelName, availabilityError, config)
            ) {
                return getCodex53QuotaFallbackService(config, actualModelName, options);
            }
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

            // 过载 UUID 只是软排除；如果没有其他可用节点，撤销该排除并允许继续使用唯一/原凭证。
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

            // 请求内瞬态错误重试会先排除已尝试的凭证以优先覆盖其他账号。
            // 若全部已尝试凭证仍然满足标准号池调度条件，则允许重新进入选择器循环；
            // 不直接指定凭证，因此健康、额度、冷却、模型支持和并发限制仍会完整生效。
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
            
            // 合并选中的提供者配置到当前请求的 config 中
            serviceConfig = deepmerge(config, selectedProviderConfig);
            delete serviceConfig.providerPools;
            
            actualProviderType = selectedType;
            isFallback = fallbackUsed;
            selectedUuid = selectedProviderConfig.uuid;
            actualModel = fallbackModel || actualModelName;
            selectedModelFallbackReason = fallbackReason || null;
            config._modelRouting = {
                requestedModel: actualModelName,
                actualModel,
                modelFallbackFrom: fallbackUsed && actualModel !== actualModelName ? actualModelName : null,
                modelFallbackTo: fallbackUsed && actualModel !== actualModelName ? actualModel : null,
                modelFallbackReason: fallbackReason || null,
                queueWaitMs: Number(queueWaitMs || 0),
                fallbackAttemptCount: Number(fallbackAttemptCount || 0),
                queueOutcome: queueOutcome || null
            };

            // mixed pool/fallback 可能跨 providerType 命中真实节点，需要切到真实 adapter。
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
        // 如果在 AUTO 模式下依然没能解析出具体提供商，则报错
        throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${actualModelName}'`);
    }
    runtimeMetrics.recordStage('providerFilterMs', performance.now() - providerFilterStartedAt);

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
    }

    const fallbackMetadata = isFallback && actualModel !== actualModelName
        ? {
            modelFallbackFrom: actualModelName,
            modelFallbackTo: actualModel,
            modelFallbackReason: selectedModelFallbackReason || options.modelFallbackReason || 'MODEL_UNAVAILABLE'
        }
        : {};
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
    const selectedGroupId = routingMode === 'pool'
        ? null
        : diagnostics.selectedGroupId || previous.selectedGroupId || null;
    const actualProviderGroupId = routingMode === 'pool' ? null : selectedGroupId;
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

    // providerPoolsSlim 只保留顶级 key 及部分字段
    const slimFields = [
        'uuid',
        'customName',
        'isHealthy',
        'isDisabled',
        'lastErrorTime',
        'lastErrorMessage',
        'needsRefresh'
    ];
    // identify 字段映射表
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
            // 尝试通过前缀查找 identifyField (例如 openai-custom-1 -> openai-custom)
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
                // identify 字段
                if (identifyField && item.hasOwnProperty(identifyField)) {
                    let tmpCustomName = item.customName ? `${item.customName}` : (slim.uuid || 'NoUUID');
                    let identifyStr = `${tmpCustomName}::${key}`;
                    slim.identify = identifyStr;
                } else {
                    slim.identify = null;
                }
                slim.provider = key;
                // 统计
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
