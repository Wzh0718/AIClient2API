import { resolveGptImageModelAlias } from '../../utils/constants.js';

// No implicit cross-model fallback. Callers must provide an explicit, scoped fallback.
export const DEFAULT_CODEX_FALLBACK_MODEL = null;

const SPARK_ALIAS_BY_MODEL = {
    'gpt-5.3-codex-spark': 'gpt-6-luna',
    'gpt-5.3-codex-spark-fast': 'gpt-6-luna'
};

export function matchesModelFamily(model, family) {
    const normalizedModel = String(model || '').trim().toLowerCase();
    const normalizedFamily = String(family || '').trim().toLowerCase();
    if (!normalizedModel || !normalizedFamily) return false;
    return normalizedModel === normalizedFamily
        || normalizedModel.startsWith(`${normalizedFamily}-`);
}

export function isCodex54Family(model) {
    return matchesModelFamily(model, 'gpt-5.4');
}

export function resolveCodexSparkAlias(model) {
    const normalized = String(model || '').trim().toLowerCase();
    return SPARK_ALIAS_BY_MODEL[normalized] || null;
}

// A model the service does not offer is a client error: it must not surface as a 500
// (which clients retry) nor count against any credential.
export function createUnsupportedCodexModelError(model) {
    const error = new Error(`[Codex] 不支持的模型: ${model}`);
    error.status = 400;
    error.statusCode = 400;
    error.code = 'model_not_found';
    return error;
}

export function resolveCodexEntryModel({
    model,
    supported,
    preserveRequestedModel = false
} = {}) {
    if (!model) return { actualModel: model, reason: null };

    const imageAlias = resolveGptImageModelAlias(model);
    if (String(model).trim() === 'gpt-image-2.5') {
        return { actualModel: imageAlias, reason: 'IMAGE_MODEL_ALIAS' };
    }

    const sparkAlias = resolveCodexSparkAlias(model);
    if (sparkAlias) {
        return { actualModel: sparkAlias, reason: 'SPARK_ALIAS' };
    }

    if (preserveRequestedModel) return { actualModel: model, reason: null };
    if (!supported) {
        throw createUnsupportedCodexModelError(model);
    }
    return { actualModel: model, reason: null };
}
