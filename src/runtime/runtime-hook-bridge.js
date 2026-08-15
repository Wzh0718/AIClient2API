import { extractUsage, mergeUsage, toWireUsage } from '../utils/usage-normalizer.js';
import { createHash } from 'crypto';
import { buildRequestFingerprint } from '../plugins/request-audit/fingerprint.js';

function hashSecret(value, length = 32) {
    if (!value) return null;
    return `sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, length)}`;
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

function compactMetadata(context = {}) {
    const metadata = {
        requestId: context.requestId || context._monitorRequestId || null,
        _monitorRequestId: context._monitorRequestId || context.requestId || null,
        _requestAuditLifecycle: context._requestAuditLifecycle === true,
        model: context.model || null,
        fromProvider: context.fromProvider || null,
        toProvider: context.toProvider || null,
        potluckApiKey: context.potluckApiKey || null,
        _codexRouting: compactCodexRouting(context._codexRouting),
        isStream: context.isStream === true,
        method: context.method || null,
        path: context.path || null,
        normalizedPath: context.normalizedPath || null,
        response: context.response ? {
            httpStatus: context.response.httpStatus ?? context.response.statusCode,
            bytes: context.response.bytes,
            completed: context.response.completed,
            clientAborted: context.response.clientAborted,
            hasImageResult: context.response.hasImageResult,
            durationMs: context.response.durationMs,
            errorCode: context.response.errorCode
        } : undefined,
        errorClass: context.errorClass || null
    };

    for (const key of ['providerUuid', 'providerName', 'accountIdentity', 'accountEmail']) {
        if (context[key] !== undefined && context[key] !== null && context[key] !== '') metadata[key] = context[key];
    }
    if (metadata.response) {
        metadata.response = Object.fromEntries(Object.entries(metadata.response).filter(([, value]) => value !== undefined));
    }
    return metadata;
}

export class RuntimeHookBridge {
    constructor({ send, maxPending = 1000 }) {
        this.send = send;
        this.pending = new Map();
        this.maxPending = Math.max(1, Number(maxPending) || 1);
        this.outbound = new Map();
        this.dropped = 0;
    }

    _send(message) {
        if (this.outbound.size >= this.maxPending) {
            this.dropped += 1;
            return false;
        }
        const eventId = message.eventId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const outbound = { ...message, eventId };
        this.outbound.set(eventId, outbound);
        this.send(outbound);
        return true;
    }

    ack(eventId) {
        return this.outbound.delete(eventId);
    }

    retryUnacked() {
        for (const message of this.outbound.values()) this.send(message);
    }

    snapshot() {
        return { pending: this.outbound.size, dropped: this.dropped, maxPending: this.maxPending };
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
            const metadata = { ...pending.metadata, ...compactMetadata(context) };
            this._send({
                type: 'runtime_hook',
                hookName: 'onUnaryResponse',
                args: [{
                    ...metadata,
                    nativeResponse: { usage: toWireUsage(pending.usage) },
                    clientResponse: pending.hasImage ? { data: [{ url: 'image://result' }] } : { usage: toWireUsage(pending.usage) }
                }]
            });
            this._send({ type: 'runtime_hook', hookName, args: [metadata] });
            return;
        }

        if (hookName === 'onRequestCompleted') {
            this._send({ type: 'runtime_hook', hookName, args: [compactMetadata(context)] });
        }
    }
}
