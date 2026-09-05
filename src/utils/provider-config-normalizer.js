const PROVIDER_STRING_ARRAY_CONFIG_FIELDS = [
    'DEFAULT_MODEL_PROVIDERS',
    'PROXY_ENABLED_PROVIDERS',
    'TLS_SIDECAR_ENABLED_PROVIDERS'
];

const PROVIDER_BOOLEAN_CONFIG_FIELDS = [
    'TLS_SIDECAR_ENABLED'
];

const LEGACY_PROVIDER_PROXY_FIELDS = [
    'PROXY_URL',
    'PROXY_REQUIRED'
];

const LEGACY_CODEX_QUOTA_FIELDS = [
    'codexMax5hTokens',
    'codexMaxWeeklyTokens',
    'codexMax5hPercent',
    'codexMaxWeeklyPercent',
    'codex53Max5hPercent',
    'codex53MaxWeeklyPercent'
];

const PROVIDER_POSITIVE_NUMBER_CONFIG_FIELDS = [
    'providerWeight'
];

const PROVIDER_NON_NEGATIVE_NUMBER_CONFIG_FIELDS = [
    'codexGeneralMax5hPercent',
    'codexGeneralMaxWeeklyPercent',
    'antigravityGeminiMax5hPercent',
    'antigravityGeminiMaxWeeklyPercent',
    'antigravityThirdPartyMax5hPercent',
    'antigravityThirdPartyMaxWeeklyPercent'
];

function normalizeStringArrayConfigValue(value) {
    if (Array.isArray(value)) {
        return value
            .filter(item => item !== undefined && item !== null && item !== false)
            .map(item => String(item).trim())
            .filter(Boolean);
    }

    if (value === undefined || value === null || typeof value === 'boolean') {
        return [];
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return [];
        }

        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    return normalizeStringArrayConfigValue(parsed);
                }
            } catch {
                // Fall back to comma-separated parsing below.
            }
        }

        return trimmed
            .split(',')
            .map(item => item.trim())
            .filter(Boolean);
    }

    return [];
}

function normalizeBooleanConfigValue(value) {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) {
            return true;
        }
        if (['false', '0', 'no', 'off', 'disabled', ''].includes(normalized)) {
            return false;
        }
    }

    return Boolean(value);
}

function normalizePositiveNumberConfigValue(value, fallback = 1) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return parsed;
}

function normalizeNonNegativeNumberConfigValue(value, fallback = 0) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
    }

    return parsed;
}

/**
 * Provider edit UI renders unknown provider fields as text inputs. If root-level
 * proxy/TLS settings are stored on a provider node, arrays and booleans can
 * round-trip as strings and silently disable proxy routing. Normalize only known
 * typed fields that are present in the request, without adding new fields.
 */
export function normalizeProviderConfigFields(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;

    const result = { ...data };
    for (const key of LEGACY_PROVIDER_PROXY_FIELDS) {
        delete result[key];
    }
    for (const key of LEGACY_CODEX_QUOTA_FIELDS) {
        delete result[key];
    }

    for (const key of PROVIDER_STRING_ARRAY_CONFIG_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(result, key)) {
            result[key] = normalizeStringArrayConfigValue(result[key]);
        }
    }

    for (const key of PROVIDER_BOOLEAN_CONFIG_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(result, key)) {
            result[key] = normalizeBooleanConfigValue(result[key]);
        }
    }

    for (const key of PROVIDER_POSITIVE_NUMBER_CONFIG_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(result, key)) {
            result[key] = normalizePositiveNumberConfigValue(result[key], 1);
        }
    }

    for (const key of PROVIDER_NON_NEGATIVE_NUMBER_CONFIG_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(result, key)) {
            result[key] = normalizeNonNegativeNumberConfigValue(result[key], 0);
        }
    }

    return result;
}
