export const GPT6_ASTRA_MODEL = 'gpt-6-astra';
export const GPT61_SOL_MODEL = 'gpt-6.1-sol';
export const CODEX_GPT6_OVERRIDE_MODELS = Object.freeze(['gpt-6-astra', 'gpt-6-sol', GPT61_SOL_MODEL, 'gpt-6-luna']);
const GPT6_SOL_LUNA_MODELS = new Set(['gpt-6-sol', 'gpt-6-luna']);

const GPT6_ASTRA_REASONING_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function isGpt61SolModel(model) {
    const normalized = String(model || '').trim().toLowerCase();
    return normalized === GPT61_SOL_MODEL ||
        normalized === `${GPT61_SOL_MODEL}-fast` ||
        normalized === `${GPT61_SOL_MODEL}-ultrafast`;
}

export function isGpt6AstraModel(model) {
    const normalized = String(model || '').trim().toLowerCase();
    return normalized === GPT6_ASTRA_MODEL ||
        normalized === `${GPT6_ASTRA_MODEL}-fast` ||
        normalized === `${GPT6_ASTRA_MODEL}-ultrafast`;
}

export function resolveCodexOutboundModel(model, config = {}) {
    const normalized = String(model || '').trim();
    if (!isCodexGpt6OverrideApplied(normalized, config)) return normalized;
    const target = String(config.codexGpt6OverrideModel || 'gpt-6-luna').trim().toLowerCase();
    if (!CODEX_GPT6_OVERRIDE_MODELS.includes(target)) {
        throw new Error(`[Codex] 无效的 GPT-6 上游目标模型: ${target}`);
    }
    return target;
}

export function isCodexGpt6OverrideApplied(model, config = {}) {
    return (config.codexGpt6OverrideEnabled === true || config.codexGpt6OverrideEnabled === 'true')
        && /^gpt-(?!image-)/i.test(String(model || '').trim());
}

export function normalizeCodexReasoningEffort(model, effort, isFast = /-(?:fast|ultrafast)$/i.test(String(model || ''))) {
    const requested = String(effort || '').trim().toLowerCase();
    // GPT-6.1 Sol speed tiers do not select a reasoning effort.
    if (isGpt61SolModel(model)) {
        if (requested === 'minimal') return 'low';
        return GPT6_ASTRA_REASONING_LEVELS.has(requested) ? requested : 'medium';
    }
    if (isFast) return 'xhigh';
    if (isGpt6AstraModel(model)) {
        if (requested === 'minimal') return 'low';
        if (GPT6_ASTRA_REASONING_LEVELS.has(requested)) return requested;
        return 'medium';
    }
    if (GPT6_SOL_LUNA_MODELS.has(String(model || '').trim().toLowerCase())) {
        if (requested === 'minimal') return 'low';
        if (['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(requested)) return requested;
        return 'medium';
    }
    return requested === 'minimal' ? 'none' : (requested || 'medium');
}

export function sanitizeCodexModelParameters(model, body = {}) {
    const sanitized = { ...body };
    const isSolOrLuna = GPT6_SOL_LUNA_MODELS.has(String(model || '').trim().toLowerCase());
    const reasoningEffort = String(body.reasoning?.effort || body.reasoning_effort || 'medium').trim().toLowerCase();
    if (isGpt6AstraModel(model) || isGpt61SolModel(model) || (isSolOrLuna && reasoningEffort !== 'none')) {
        delete sanitized.temperature;
        delete sanitized.top_p;
        delete sanitized.top_logprobs;
        if (Array.isArray(sanitized.include)) {
            sanitized.include = sanitized.include.filter(item => item !== 'message.output_text.logprobs');
        }
    }
    return sanitized;
}

export function getCodexModelIds(baseModels = []) {
    const models = Array.isArray(baseModels) ? baseModels : [];
    const speedModels = models.filter(model => !GPT6_SOL_LUNA_MODELS.has(model) && model !== 'gpt-image-2.5');
    const ultrafastModels = models.filter(model =>
        model === 'gpt-5.6-sol' || model === GPT6_ASTRA_MODEL || model === GPT61_SOL_MODEL
    );
    return [...new Set([
        ...models,
        ...speedModels.map(model => `${model}-fast`),
        ...ultrafastModels.map(model => `${model}-ultrafast`)
    ])];
}
