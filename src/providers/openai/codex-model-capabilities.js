export const GPT6_ASTRA_MODEL = 'gpt-6-astra';

const GPT6_ASTRA_REASONING_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function isGpt6AstraModel(model) {
    const normalized = String(model || '').trim().toLowerCase();
    return normalized === GPT6_ASTRA_MODEL || normalized === `${GPT6_ASTRA_MODEL}-fast`;
}

export function normalizeCodexReasoningEffort(model, effort, isFast = /-fast$/i.test(String(model || ''))) {
    const requested = String(effort || '').trim().toLowerCase();
    if (isFast) return 'xhigh';
    if (isGpt6AstraModel(model)) {
        if (requested === 'minimal') return 'low';
        if (GPT6_ASTRA_REASONING_LEVELS.has(requested)) return requested;
        return 'medium';
    }
    return requested === 'minimal' ? 'none' : (requested || 'medium');
}

export function sanitizeCodexModelParameters(model, body = {}) {
    const sanitized = { ...body };
    if (isGpt6AstraModel(model)) {
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
    return [...new Set([...models, ...models.map(model => `${model}-fast`)])];
}
