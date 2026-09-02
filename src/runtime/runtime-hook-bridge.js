import { extractUsage, mergeUsage, toWireUsage } from '../utils/usage-normalizer.js';
import { createHash } from 'crypto';
import { buildRequestFingerprint } from '../plugins/request-audit/fingerprint.js';

function hashSecret(value, length = 32) {
    if (!value) return null;
    return `sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, length)}`;
}

function stableRuntimeEventId(message = {}) {
    const context = message.args?.[0] || {};
    const requestId = context.requestId || context._monitorRequestId;
    if (!requestId) return null;
    const epoch = process.env.RUNTIME_DEPLOYMENT_EPOCH || 'default';
    const sourceWorkerId = process.env.RUNTIME_WORKER_ID || 'standalone';
    return `runtime:${createHash('sha256')
        .update(`${epoch}\0${sourceWorkerId}\0${message.hookName || 'unknown'}\0${requestId}`)
        .digest('hex')}`;
}

function containsImage(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (typeof value.b64_json === 'string' && value.b64_json) return true;
    if (typeof value.url === 'string' && value.url.startsWith('data:image/')) return true;
    if (value.type === 'image_generation_call' && typeof value.result === 'string') return true;
    return Object.values(value).some(item => Array.isArray(item)
        ? item.some(child => containsImage(child, seen))
        : containsImage(item, seen));
}

function compactCodexRouting(routing) {
    if (!routing || typeof routing !== 'object') return undefined;
    return {
        routingMode: ['pool', 'auto', 'fixed'].includes(routing.routingMode)
            ? routing.routingMode
            : null,
        requestedPrimaryGroupId: routing.requestedPrimaryGroupId || null,
        selectedGroupId: routing.selectedGroupId || null,
        selectedProviderUuid: routing.selectedProviderUuid || null,
        actualProviderGroupId: routing.actualProviderGroupId || null,
        providerSwitchCount: Math.max(0, Number(routing.providerSwitchCount) || 0),
        modelFallbackFrom: routing.modelFallbackFrom || null,
        modelFallbackTo: routing.modelFallbackTo || null,
        modelFallbackReason: routing.modelFallbackReason || null,
        spillover: routing.spillover === true,
        spilloverReason: routing.spilloverReason || null,
        assignmentMissing: routing.assignmentMissing === true,
        affinitySource: routing.affinitySource || null,
        hotShardApplied: routing.hotShardApplied === true
    };
}

function compactTemporaryModelRoute(route) {
    if (!route || typeof route !== 'object') return undefined;
    return {
        id: route.id || null,
        targetProviderType: route.targetProviderType || null,
        targetModel: route.targetModel || null,
        actualProviderType: route.actualProviderType || null,
        actualModel: route.actualModel || null,
        credentialRetryUsed: route.credentialRetryUsed === true,
        fallbackUsed: route.fallbackUsed === true,
        fallbackReason: route.fallbackReason || null,
        targetAttempted: route.targetAttempted !== false
    };
}

function compactMetadata(context = {}) {
    const allowedStages = new Set([
        'providerFilterMs', 'redisLeaseMs', 'identityReadMs', 'identityPersistLockWaitMs',
        'identityPersistIoMs', 'requestConvertMs', 'systemPromptPersistMs',
        'upstreamFirstByteMs', 'upstreamCompleteMs', 'responseFinalizeMs', 'complete'
    ]);
    const runtime = context.runtime && typeof context.runtime === 'object' ? {
        workerId: typeof context.runtime.workerId === 'string' ? context.runtime.workerId : undefined,
        kind: context.runtime.kind === 'image' || context.runtime.kind === 'model' ? context.runtime.kind : undefined,
        durationMs: Number.isFinite(Number(context.runtime.durationMs)) && Number(context.runtime.durationMs) >= 0 ? Number(context.runtime.durationMs) : undefined,
        outputBytes: Number.isFinite(Number(context.runtime.outputBytes)) && Number(context.runtime.outputBytes) >= 0 ? Number(context.runtime.outputBytes) : undefined,
        backpressureMs: Number.isFinite(Number(context.runtime.backpressureMs)) && Number(context.runtime.backpressureMs) >= 0 ? Number(context.runtime.backpressureMs) : undefined,
        stages: context.runtime.stages && typeof context.runtime.stages === 'object' ? Object.fromEntries(Object.entries(context.runtime.stages).filter(([name, value]) => allowedStages.has(name) && Number.isFinite(Number(value)) && Number(value) >= 0).map(([name, value]) => [name, Number(value)])) : undefined
    } : undefined;
    const metadata = {
        requestId: context.requestId || context._monitorRequestId || null,
        _monitorRequestId: context._monitorRequestId || context.requestId || null,
        _requestAuditLifecycle: context._requestAuditLifecycle === true,
        model: context.model || null,
        fromProvider: context.fromProvider || null,
        toProvider: context.toProvider || null,
        potluckApiKey: context.potluckApiKey || null,
        potluckKeyData: context.potluckKeyData?.name ? { name: context.potluckKeyData.name } : undefined,
        potluckQuotaReservationId: context.potluckQuotaReservationId || null,
        potluckQuotaMode: context.potluckQuotaMode || null,
        _codexRouting: compactCodexRouting(context._codexRouting),
        _temporaryKeyModelRouteResult: compactTemporaryModelRoute(context._temporaryKeyModelRouteResult),
        originalRequestBody: context.originalRequestBody?.model
            ? { model: context.originalRequestBody.model }
            : undefined,
        processedRequestBody: context.processedRequestBody?.model
            ? { model: context.processedRequestBody.model }
            : undefined,
        isStream: typeof context.isStream === 'boolean' ? context.isStream : undefined,
        method: context.method || null,
        path: context.path || null,
        normalizedPath: context.normalizedPath || null,
        ...(context.REQUEST_AUDIT_NETWORK_METADATA_ENABLED === true ? {
            clientIp: context.clientIp || null,
            peerIp: context.peerIp || null,
            clientIpSource: context.clientIpSource || null
        } : {}),
        response: context.response ? {
            httpStatus: context.response.httpStatus ?? context.response.statusCode,
            bytes: context.response.bytes,
            completed: context.response.completed,
            clientAborted: context.response.clientAborted,
            hasImageResult: context.response.hasImageResult,
            durationMs: Number.isFinite(Number(context.response.durationMs)) && Number(context.response.durationMs) >= 0 ? Number(context.response.durationMs) : undefined,
            errorCode: context.response.errorCode
        } : undefined,
        runtime,
        errorClass: context.errorClass || null
    };

    for (const key of ['providerUuid', 'providerName', 'accountIdentity', 'accountEmail']) {
        if (context[key] !== undefined && context[key] !== null && context[key] !== '') metadata[key] = context[key];
    }
    if (metadata.response) {
        metadata.response = Object.fromEntries(Object.entries(metadata.response).filter(([, value]) => value !== undefined));
    }
    return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

export class RuntimeHookBridge {
    constructor({ send, durableTransport = null, maxPending = 1000 }) {
        this.send = send;
        this.durableTransport = durableTransport;
        this.pending = new Map();
        this.maxPending = Math.max(1, Number(maxPending) || 1);
        this.outbound = new Map();
        this.dropped = 0;
        this.backpressured = 0;
    }

    async _send(message) {
        const eventId = message.eventId || stableRuntimeEventId(message) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const outbound = {
            ...message,
            eventId,
            sourceWorkerId: process.env.RUNTIME_WORKER_ID || null,
            createdAt: new Date().toISOString()
        };
        const tracked = this.outbound.size < this.maxPending;
        if (tracked) this.outbound.set(eventId, outbound);
        else this.backpressured += 1;
        try {
            if (this.durableTransport) {
                const durableEvent = JSON.parse(JSON.stringify(outbound));
                for (const arg of durableEvent.args || []) {
                    if (arg?.potluckApiKey) {
                        arg.potluckKeyHash = hashSecret(arg.potluckApiKey, 16);
                        delete arg.potluckApiKey;
                    }
                }
                const durableResult = await this.durableTransport.publish(durableEvent);
                if (durableResult?.streamId) outbound.streamId = durableResult.streamId;
                // Local standalone transports can append directly to their
                // durable store and return an explicit acknowledgement. Do
                // not retain such events in the IPC retry map: there is no
                // control worker that could send the normal ACK frame.
                if (tracked && durableResult?.acknowledged === true) await this.ack(eventId);
            }
        } catch (error) {
            if (tracked) this.outbound.delete(eventId);
            throw error;
        }
        if (!this.durableTransport) this.send?.(outbound);
        return true;
    }

    async ack(eventId) {
        const deleted = this.outbound.delete(eventId);
        await this.durableTransport?.acknowledge?.(eventId);
        return deleted;
    }

    retryUnacked() {
        if (this.durableTransport) return;
        for (const message of this.outbound.values()) this.send(message);
    }

    snapshot() {
        const oldestCreatedAt = [...this.outbound.values()].map(item => Date.parse(item.createdAt)).filter(Number.isFinite).sort()[0];
        return {
            pending: this.outbound.size,
            dropped: this.dropped,
            backpressured: this.backpressured,
            maxPending: this.maxPending,
            oldestPendingAgeMs: oldestCreatedAt ? Math.max(0, Date.now() - oldestCreatedAt) : 0,
            ...(this.durableTransport?.snapshot?.() || {})
        };
    }

    async handle(hookName, context = {}) {
        const requestId = context.requestId || context._monitorRequestId;
        if (hookName === 'onUpstreamRequestPrepared') {
            if (!requestId) return;
            const current = this.pending.get(requestId) || { metadata: {}, usage: {}, hasImage: false };
            const originalFingerprint = buildRequestFingerprint({ originalRequestBody: context.originalRequestBody });
            const upstreamFingerprint = buildRequestFingerprint({ processedRequestBody: context.upstreamRequestBody });
            current.metadata = {
                ...current.metadata,
                cache: {
                    clientPromptCacheKeyHash: hashSecret(context.clientPromptCacheKey),
                    finalPromptCacheKeyHash: hashSecret(context.finalPromptCacheKey),
                    keySource: context.cacheKeySource || null,
                    coordinationStatus: context.cacheCoordinationStatus || null,
                    templateFingerprint: context.templateFingerprint || null,
                    originalPrefixHashes: originalFingerprint.prefixHashes,
                    upstreamPrefixHashes: upstreamFingerprint.prefixHashes,
                    instructionsHash: upstreamFingerprint.instructionsHash,
                    toolsHash: upstreamFingerprint.toolsHash,
                    metadataHash: upstreamFingerprint.metadataHash,
                    workerId: context.workerId || process.env.RUNTIME_WORKER_ID || null
                }
            };
            this.pending.set(requestId, current);
            return;
        }
        if (hookName === 'onStreamChunk') {
            if (!requestId) return;
            const current = this.pending.get(requestId) || { metadata: compactMetadata(context), usage: {}, hasImage: false };
            current.usage = mergeUsage(current.usage, extractUsage(context.nativeChunk, context.chunkToSend));
            current.hasImage ||= containsImage(context.nativeChunk) || containsImage(context.chunkToSend);
            this.pending.set(requestId, current);
            return;
        }

        if (hookName === 'onUnaryResponse') {
            if (!requestId) return;
            const usage = extractUsage(context.nativeResponse, context.clientResponse);
            const current = this.pending.get(requestId) || { metadata: {}, usage: {}, hasImage: false };
            this.pending.set(requestId, {
                metadata: { ...current.metadata, ...compactMetadata(context) },
                usage: mergeUsage(current.usage, usage),
                hasImage: current.hasImage || containsImage(context.nativeResponse) || containsImage(context.clientResponse)
            });
            return;
        }

        if (hookName === 'onContentGenerated') {
            const pending = this.pending.get(requestId) || { metadata: {}, usage: {}, hasImage: false };
            this.pending.delete(requestId);
            const metadata = {
                ...pending.metadata,
                ...compactMetadata(context),
                _runtimeUsage: toWireUsage(pending.usage),
                _runtimeHasImage: pending.hasImage
            };
            await this._send({ type: 'runtime_hook', hookName, args: [metadata] });
            return;
        }

        if (hookName === 'onRequestCompleted') {
            await this._send({ type: 'runtime_hook', hookName, args: [compactMetadata(context)] });
        }
    }

    async drain({ timeoutMs = 30000, pollIntervalMs = 25 } = {}) {
        const deadline = Date.now() + timeoutMs;
        do {
            this.retryUnacked();
            await this.durableTransport?.flushSpool?.();
            const snapshot = this.snapshot();
            if (snapshot.pending === 0 && Number(snapshot.spooled || 0) === 0) {
                return { drained: true, pending: 0, spooled: 0 };
            }
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        } while (Date.now() < deadline);
        const snapshot = this.snapshot();
        return { drained: false, pending: snapshot.pending, spooled: Number(snapshot.spooled || 0) };
    }
}
