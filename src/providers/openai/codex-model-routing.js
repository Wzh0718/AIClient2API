export const DEFAULT_CODEX_FALLBACK_MODEL = 'gpt-5.6-luna';

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

export function resolveCodexEntryModel({
    model,
    supported,
    preserveRequestedModel = false
} = {}) {
    if (!model || preserveRequestedModel) return { actualModel: model, reason: null };
    if (!supported) {
        throw new Error(`[Codex] 不支持的模型: ${model}`);
    }
    return { actualModel: model, reason: null };
}
