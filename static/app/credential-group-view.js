const DEFAULT_FOCUS_SHARE = 0.8;

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function keyStableRef(key = {}) {
    return String(key.maskedKey || key.keyRef || key.keyId || '');
}

function keySortCategory(key = {}, preferUsd = true) {
    if (key.enabled === false) return 2;
    return keyDemandValue(key, preferUsd) > 0 ? 0 : 1;
}

function keyDemandValue(key = {}, preferUsd = true) {
    const usd = finiteNumber(key?.demand?.usd)
        || finiteNumber(key?.demand?.actualUsd) + finiteNumber(key?.demand?.estimatedUsd);
    if (preferUsd) return usd;
    return finiteNumber(key?.demand?.totalTokens) || finiteNumber(key?.demand?.requestCount);
}

export function sortCredentialGroupKeys(keys = []) {
    const preferUsd = keys.some(key => key.enabled !== false && (
        finiteNumber(key?.demand?.usd)
        || finiteNumber(key?.demand?.actualUsd)
        || finiteNumber(key?.demand?.estimatedUsd)
    ));
    return [...keys].sort((left, right) => {
        const categoryDelta = keySortCategory(left, preferUsd) - keySortCategory(right, preferUsd);
        if (categoryDelta !== 0) return categoryDelta;

        const demandDelta = keyDemandValue(right, preferUsd) - keyDemandValue(left, preferUsd);
        if (demandDelta !== 0) return demandDelta;

        const requestDelta = finiteNumber(right?.demand?.requestCount) - finiteNumber(left?.demand?.requestCount);
        if (requestDelta !== 0) return requestDelta;

        return keyStableRef(left).localeCompare(keyStableRef(right));
    });
}

export function getFocusedCredentialGroupKeys(keys = [], focusShare = DEFAULT_FOCUS_SHARE) {
    const all = sortCredentialGroupKeys(keys);
    const active = all.filter(key => key.enabled !== false);
    const preferUsd = active.some(key => finiteNumber(key?.demand?.usd)
        || finiteNumber(key?.demand?.actualUsd)
        || finiteNumber(key?.demand?.estimatedUsd));
    const activeWithUsage = active.filter(key => keyDemandValue(key, preferUsd) > 0);
    const totalTokens = activeWithUsage.reduce((sum, key) => sum + finiteNumber(key?.demand?.totalTokens), 0);
    const totalDemand = activeWithUsage.reduce((sum, key) => sum + keyDemandValue(key, preferUsd), 0);
    const normalizedShare = Math.max(0, Math.min(1, finiteNumber(focusShare) || DEFAULT_FOCUS_SHARE));
    const visibleRefs = new Set();
    let coveredTokens = 0;
    let coveredDemand = 0;

    for (const key of activeWithUsage) {
        if (totalDemand <= 0 || coveredDemand / totalDemand >= normalizedShare) break;
        visibleRefs.add(keyStableRef(key));
        coveredTokens += finiteNumber(key?.demand?.totalTokens);
        coveredDemand += keyDemandValue(key, preferUsd);
    }

    all.forEach(key => {
        const isOperationalException = key.enabled !== false
            && (key.routingMode === 'fixed' || key.routingMode === 'restricted' || key.manualLock === true);
        if (isOperationalException) visibleRefs.add(keyStableRef(key));
    });

    const visible = all.filter(key => visibleRefs.has(keyStableRef(key)));
    return {
        all,
        visible,
        hiddenCount: Math.max(0, all.length - visible.length),
        totalTokens,
        coveredTokens,
        totalDemand,
        coveredDemand,
        metric: preferUsd ? 'usd' : 'totalTokens'
    };
}

export function resolveCredentialGroupMemberLabel(credentialRef, credentials = []) {
    const ref = String(credentialRef || '');
    const credential = credentials.find(item => String(item?.credentialRef || '') === ref);
    const email = String(credential?.accountEmail || '').trim();
    const customName = String(credential?.customName || '').trim();
    const primary = email || customName || ref;
    return {
        primary,
        secondary: primary !== ref ? ref : ''
    };
}

function credentialStableRef(credential = {}) {
    return String(credential.credentialRef || '');
}

export function getFocusedCredentials(credentials = []) {
    const all = [...credentials].sort((left, right) => {
        const capacityDelta = finiteNumber(right?.capacity) - finiteNumber(left?.capacity);
        if (capacityDelta !== 0) return capacityDelta;
        return credentialStableRef(left).localeCompare(credentialStableRef(right));
    });
    const visible = all.filter(credential => credential.available === true
        && credential.isHealthy !== false
        && credential.isDisabled !== true
        && credential.needsRefresh !== true
        && finiteNumber(credential.capacity) > 0);

    return {
        all,
        visible,
        hiddenCount: Math.max(0, all.length - visible.length)
    };
}

export function buildCredentialGroupCredentialSections(groups = [], credentials = []) {
    const credentialByRef = new Map(
        credentials.map(credential => [credentialStableRef(credential), credential])
    );
    const membershipCount = new Map();

    groups.forEach(group => {
        const refs = new Set(Array.isArray(group?.credentialRefs) ? group.credentialRefs.map(String) : []);
        refs.forEach(ref => membershipCount.set(ref, (membershipCount.get(ref) || 0) + 1));
    });

    const duplicateCredentialRefs = [...membershipCount.entries()]
        .filter(([, count]) => count > 1)
        .map(([ref]) => ref)
        .sort();
    const duplicateSet = new Set(duplicateCredentialRefs);
    const assignedRefs = new Set(membershipCount.keys());

    return {
        groups: groups.map(group => {
            const refs = Array.isArray(group?.credentialRefs) ? group.credentialRefs.map(String) : [];
            return {
                ...group,
                credentials: refs.map(ref => credentialByRef.get(ref)).filter(Boolean),
                missingCredentialRefs: refs.filter(ref => !credentialByRef.has(ref)),
                duplicateCredentialRefs: refs.filter(ref => duplicateSet.has(ref))
            };
        }),
        duplicateCredentialRefs,
        ungroupedCredentials: credentials.filter(credential => !assignedRefs.has(credentialStableRef(credential)))
    };
}
