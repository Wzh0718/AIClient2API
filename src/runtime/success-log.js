const ALLOWED_STAGES = new Set([
    'providerFilterMs',
    'redisLeaseMs',
    'identityReadMs',
    'identityPersistLockWaitMs',
    'identityPersistIoMs',
    'requestConvertMs',
    'systemPromptPersistMs',
    'upstreamFirstByteMs',
    'upstreamCompleteMs',
    'responseFinalizeMs',
    'complete'
]);

function finiteNonNegative(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function buildSuccessLogPayload(completion = {}) {
    const metadata = completion.metadata || {};
    const payload = {
        event: 'request_completed',
        requestId: completion.requestId || metadata.requestId || null,
        statusCode: Number(completion.statusCode || metadata.responseStatus || 200),
        durationMs: finiteNonNegative(completion.durationMs),
        providerType: metadata.providerType || metadata.toProvider || undefined,
        model: metadata.model || undefined,
        stream: typeof metadata.stream === 'boolean' ? metadata.stream : undefined,
        outputBytes: finiteNonNegative(completion.outputBytes),
        backpressureMs: finiteNonNegative(completion.backpressureMs),
        stages: Object.fromEntries(Object.entries(completion.stages || {})
            .filter(([name, value]) => ALLOWED_STAGES.has(name) && finiteNonNegative(value) !== undefined)
            .map(([name, value]) => [name, finiteNonNegative(value)]))
    };
    return Object.fromEntries(Object.entries(payload)
        .filter(([, value]) => value !== undefined && value !== null));
}

export function shouldEmitSuccessLog({ mode = 'compact', sampleRate = 1, random = Math.random } = {}) {
    if (mode === 'off') return false;
    if (mode === 'compact') return true;
    const rate = Math.min(1, Math.max(0, Number(sampleRate) || 0));
    return random() < rate;
}

export function formatSuccessLog(completion, options = {}) {
    const mode = options.mode || process.env.REQUEST_SUCCESS_LOG_MODE || 'compact';
    const sampleRate = options.sampleRate ?? process.env.REQUEST_SUCCESS_LOG_SAMPLE_RATE ?? 1;
    if (!shouldEmitSuccessLog({ mode, sampleRate, random: options.random || Math.random })) return null;
    return JSON.stringify(buildSuccessLogPayload(completion));
}
