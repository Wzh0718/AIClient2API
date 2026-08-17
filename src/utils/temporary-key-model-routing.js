import crypto from 'crypto';
import { matchesModelFamily } from '../providers/openai/codex-model-routing.js';

const FULL_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/i;

export function hashTemporaryRouteKey(value) {
    if (!value) return null;
    return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

function safelyEqualHash(expected, actual) {
    if (!FULL_SHA256_PATTERN.test(String(expected || ''))) return false;
    const expectedBuffer = Buffer.from(String(expected).toLowerCase());
    const actualBuffer = Buffer.from(String(actual || '').toLowerCase());
    return expectedBuffer.length === actualBuffer.length
        && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function matchesConfiguredModel(rule, model) {
    const exactModels = Array.isArray(rule?.models) ? rule.models : [];
    if (exactModels.includes(model)) return true;
    const modelFamilies = Array.isArray(rule?.modelFamilies) ? rule.modelFamilies : [];
    return modelFamilies.some(family => matchesModelFamily(model, family));
}

export function resolveTemporaryKeyModelRoute({
    config,
    apiKey,
    requestPath,
    model,
    originalProviderType
}) {
    if (!apiKey || !requestPath || !model) return null;
    const keyHash = hashTemporaryRouteKey(apiKey);
    const rules = Array.isArray(config?.temporaryKeyModelRoutes)
        ? config.temporaryKeyModelRoutes
        : [];

    for (const rule of rules) {
        if (!rule || rule.enabled !== true) continue;
        if (!safelyEqualHash(rule.keyHash, keyHash)) continue;
        if (!Array.isArray(rule.paths) || !rule.paths.includes(requestPath)) continue;
        if (!matchesConfiguredModel(rule, model)) continue;
        if (!rule.targetProviderType || !rule.targetModel) continue;

        return {
            id: String(rule.id || 'temporary-key-model-route'),
            keyHash,
            requestedModel: model,
            originalProviderType,
            targetProviderType: String(rule.targetProviderType),
            targetModel: String(rule.targetModel),
            fallbackToOriginal: rule.fallbackToOriginal === true,
            preserveResponseModel: rule.preserveResponseModel === true
        };
    }

    return null;
}

export function preserveTemporaryRouteResponseModel(value, requestedModel) {
    if (!value || typeof value !== 'object' || !requestedModel) return value;
    if (Array.isArray(value)) {
        return value.map(item => preserveTemporaryRouteResponseModel(item, requestedModel));
    }

    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
        key,
        key === 'model'
            ? requestedModel
            : preserveTemporaryRouteResponseModel(child, requestedModel)
    ]));
}
