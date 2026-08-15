const LOW_CACHE_RATIO = 0.2;
const SHORT_PROMPT_TOKENS = 1200;
const SMALL_GAP = 0.10;
const LARGE_GAP = 0.15;

function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function clampRatio(value) {
    return Math.max(0, Math.min(1, toNumber(value)));
}

function cacheHitRatio(event) {
    const promptTokens = toNumber(event?.usage?.promptTokens);
    return promptTokens > 0 ? clampRatio(toNumber(event?.usage?.cachedTokens) / promptTokens) : 0;
}

function keyHash(event) {
    return event?.potluckKey?.hash || null;
}

function providerId(event) {
    return event?.account?.providerUuidHash || event?.account?.providerUuid || event?.account?.providerNameDisplay || null;
}

function templateId(event) {
    return event?.cache?.templateFingerprint || null;
}

function finalCacheKey(event) {
    return event?.cache?.finalPromptCacheKeyHash || event?.prompt_cache_key_hash || null;
}

function instructionsHash(event) {
    return event?.cache?.instructionsHash || event?.fingerprint?.instructionsHash || null;
}

function toolsHash(event) {
    return event?.cache?.toolsHash || event?.fingerprint?.toolsHash || null;
}

function prefixHashes(event) {
    return event?.cache?.upstreamPrefixHashes || event?.fingerprint?.prefixHashes || [];
}

function prefixHashMap(event) {
    const map = new Map();
    for (const item of prefixHashes(event)) {
        if (item?.chars && item?.hash) map.set(Number(item.chars), item.hash);
    }
    return map;
}

function longestSharedPrefixChars(current, previous) {
    const currentMap = prefixHashMap(current);
    const previousMap = prefixHashMap(previous);
    let longest = 0;
    for (const [chars, hash] of currentMap) {
        if (previousMap.get(chars) === hash) longest = Math.max(longest, chars);
    }
    return longest;
}

function hasComparablePrefix(current, previous) {
    const currentMap = prefixHashMap(current);
    const previousMap = prefixHashMap(previous);
    for (const chars of currentMap.keys()) {
        if (previousMap.has(chars)) return true;
    }
    return false;
}

function findComparable(current, candidates = []) {
    return [...candidates]
        .filter(candidate => candidate && candidate.requestId !== current?.requestId)
        .filter(candidate => !keyHash(current) || keyHash(current) === keyHash(candidate))
        .sort((left, right) => {
            const score = candidate =>
                Number(templateId(current) && templateId(current) === templateId(candidate)) * 8 +
                Number(providerId(current) && providerId(current) === providerId(candidate)) * 4 +
                Number(finalCacheKey(current) && finalCacheKey(current) === finalCacheKey(candidate)) * 2 +
                Number(longestSharedPrefixChars(current, candidate) > 0);
            return score(right) - score(left);
        })[0] || null;
}

function theoreticalCacheRatio(event, comparable) {
    const explicit = Number(event?.cache?.theoreticalCacheRatio);
    if (Number.isFinite(explicit)) return clampRatio(explicit);
    const promptTokens = toNumber(event?.usage?.promptTokens);
    const sharedChars = comparable ? longestSharedPrefixChars(event, comparable) : 0;
    if (promptTokens > 0 && sharedChars > 0) return clampRatio((sharedChars / 4) / promptTokens);
    return cacheHitRatio(event);
}

function evidenceReason(code, severity, evidence = {}) {
    return { code, severity, evidence };
}

export function diagnoseCacheMiss(event, candidates = []) {
    const actual = cacheHitRatio(event);
    const scopedCandidates = candidates
        .filter(candidate => candidate && candidate.requestId !== event?.requestId)
        .filter(candidate => !keyHash(event) || keyHash(event) === keyHash(candidate));
    const comparable = findComparable(event, scopedCandidates);
    const theoretical = theoreticalCacheRatio(event, comparable);
    const gap = Math.max(0, theoretical - actual);
    const templateCandidates = templateId(event)
        ? scopedCandidates.filter(candidate => templateId(candidate) === templateId(event))
        : [];
    const sameTemplate = templateCandidates.length > 0;
    const sameProvider = Boolean(comparable && providerId(event) && providerId(event) === providerId(comparable));
    const sameFinalKey = Boolean(comparable && finalCacheKey(event) && finalCacheKey(event) === finalCacheKey(comparable));
    const providerTemplateCandidates = templateCandidates.filter(candidate => providerId(candidate) === providerId(event));
    const distinctFinalKeys = new Set([finalCacheKey(event), ...providerTemplateCandidates.map(finalCacheKey)].filter(Boolean));
    const distinctProviders = new Set([providerId(event), ...templateCandidates.map(providerId)].filter(Boolean));
    const stableRouteCandidate = templateCandidates.find(candidate =>
        providerId(candidate) === providerId(event) && finalCacheKey(candidate) === finalCacheKey(event));
    const structureChanged = Boolean(comparable && (
        (instructionsHash(event) && instructionsHash(comparable) && instructionsHash(event) !== instructionsHash(comparable)) ||
        (toolsHash(event) && toolsHash(comparable) && toolsHash(event) !== toolsHash(comparable)) ||
        (hasComparablePrefix(event, comparable) && longestSharedPrefixChars(event, comparable) === 0)
    ));

    let primaryReason;
    let severity;
    if (distinctFinalKeys.size > 1) {
        primaryReason = 'gateway_key_fragmentation';
        severity = 'high';
    } else if (structureChanged) {
        primaryReason = 'client_structure_variance';
        severity = 'high';
    } else if (distinctProviders.size > 1 && gap >= LARGE_GAP) {
        primaryReason = 'gateway_provider_fragmentation';
        severity = 'high';
    } else if (stableRouteCandidate && gap >= LARGE_GAP) {
        primaryReason = 'upstream_cache_uncertain';
        severity = 'medium';
    } else {
        primaryReason = 'client_prefix_limited';
        severity = toNumber(event?.usage?.promptTokens) < SHORT_PROMPT_TOKENS || gap <= SMALL_GAP ? 'high' : 'medium';
    }

    return {
        requestId: event?.requestId || null,
        cacheHitRatio: actual,
        theoreticalCacheRatio: theoretical,
        cacheGap: gap,
        primaryReason,
        reasons: [evidenceReason(primaryReason, severity, {
            comparableRequestId: comparable?.requestId || null,
            sameTemplate,
            sameProvider,
            sameFinalKey,
            distinctFinalKeyCount: distinctFinalKeys.size,
            distinctProviderCount: distinctProviders.size,
            sharedPrefixChars: comparable ? longestSharedPrefixChars(event, comparable) : 0
        })],
        comparableRequestId: comparable?.requestId || null,
        confidence: severity === 'high' ? 0.85 : 0.65
    };
}

export function buildDiagnostics(events = []) {
    const sorted = [...events].sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    const diagnostics = [];
    for (let index = 0; index < sorted.length; index += 1) {
        const event = sorted[index];
        if (cacheHitRatio(event) >= LOW_CACHE_RATIO) continue;
        diagnostics.push(diagnoseCacheMiss(event, sorted.slice(0, index)));
    }
    return diagnostics;
}
