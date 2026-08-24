const DEFAULT_DELAY_MS = 750;

function normalizeModelName(model) {
    const value = typeof model === 'string' ? model : model?.name;
    return String(value || '').trim().replace(/^models\//, '');
}

function getHttpStatus(error) {
    const value = error?.response?.status ?? error?.status ?? error?.statusCode;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function safeErrorMessage(status) {
    if (status === 429) return '429 Too Many Requests - model cooldown';
    if (status === 503) return 'Upstream model capacity is temporarily unavailable';
    if (status === 404 || status === 400) return 'Model is unsupported by this credential';
    return 'Model availability check failed';
}

export function classifyAntigravityProbeError(error) {
    const httpStatus = getHttpStatus(error);
    const status = httpStatus === 429
        ? 'cooldown'
        : httpStatus === 503
            ? 'capacity'
            : (httpStatus === 404 || httpStatus === 400)
                ? 'unsupported'
                : 'error';

    return {
        status,
        httpStatus,
        message: safeErrorMessage(httpStatus),
        scheduledRecoveryTime: error?.scheduledRecoveryTime || error?.recoveryTime || null
    };
}

function isActiveCooldown(state, now) {
    if (state?.isHealthy !== false) return false;
    if (!state?.scheduledRecoveryTime) return true;
    const recoveryMs = Date.parse(state.scheduledRecoveryTime);
    return !Number.isFinite(recoveryMs) || recoveryMs > now.getTime();
}

function createProbeRequest(model) {
    const imageModel = model.includes('image');
    const body = {
        contents: [{
            role: 'user',
            parts: [{ text: imageModel ? 'Generate a minimal plain white square image.' : 'Reply exactly OK' }]
        }],
        generationConfig: { maxOutputTokens: 16 }
    };
    if (imageModel) body._imageSize = '1K';
    return body;
}

function wait(delayMs) {
    if (!delayMs) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, delayMs));
}

export async function probeAntigravityModelAvailability({
    adapter,
    quotaHealth = null,
    now = new Date(),
    delayMs = DEFAULT_DELAY_MS
}) {
    if (!adapter || typeof adapter.listModels !== 'function' || typeof adapter.generateContent !== 'function') {
        throw new Error('Antigravity adapter does not support model availability checks');
    }

    const listed = await adapter.listModels();
    const seen = new Set();
    const models = (listed?.models || [])
        .map(normalizeModelName)
        .filter(model => model && !seen.has(model) && seen.add(model));
    const results = [];

    for (const model of models) {
        const startedAt = Date.now();
        const cooldown = quotaHealth?.models?.[model];
        if (isActiveCooldown(cooldown, now)) {
            results.push({
                model,
                status: 'cooldown',
                httpStatus: 429,
                latencyMs: 0,
                message: cooldown.lastErrorMessage || safeErrorMessage(429),
                scheduledRecoveryTime: cooldown.scheduledRecoveryTime || null
            });
            continue;
        }

        try {
            await adapter.generateContent(model, createProbeRequest(model));
            results.push({
                model,
                status: 'available',
                httpStatus: 200,
                latencyMs: Date.now() - startedAt,
                message: null,
                scheduledRecoveryTime: null
            });
        } catch (error) {
            results.push({
                model,
                latencyMs: Date.now() - startedAt,
                ...classifyAntigravityProbeError(error)
            });
        }
        await wait(delayMs);
    }

    const availableModels = results.filter(result => result.status === 'available').length;
    return {
        checkedAt: new Date().toISOString(),
        totalModels: results.length,
        availableModels,
        availabilityPercent: results.length > 0
            ? Number(((availableModels / results.length) * 100).toFixed(1))
            : 0,
        models: results
    };
}
