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
    if (isCodex54Family(model)) {
        return { actualModel: DEFAULT_CODEX_FALLBACK_MODEL, reason: 'GPT_54_DIRECT_LUNA' };
    }
    if (!supported) {
        return { actualModel: DEFAULT_CODEX_FALLBACK_MODEL, reason: 'UNSUPPORTED_MODEL' };
    }
    return { actualModel: model, reason: null };
}
