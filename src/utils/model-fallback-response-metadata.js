export function shouldPreserveFallbackResponseModel(routing = {}) {
    return Boolean(
        routing.requestedModel
        && routing.actualModel
        && routing.requestedModel !== routing.actualModel
    );
}

export function applyModelFallbackResponseHeaders(res, routing = {}) {
    if (!res?.setHeader || !shouldPreserveFallbackResponseModel(routing)) return false;
    res.setHeader('X-Requested-Model', routing.requestedModel);
    res.setHeader('X-Actual-Model', routing.actualModel);
    res.setHeader('X-Model-Fallback', 'true');
    res.setHeader('X-Fallback-Reason', routing.modelFallbackReason || 'SOURCE_MODEL_UNAVAILABLE');
    return true;
}
