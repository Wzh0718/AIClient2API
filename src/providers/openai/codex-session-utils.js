import crypto from 'crypto';

function firstNonEmptyString(...values) {
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const normalized = value.trim();
        if (normalized) return normalized;
    }
    return null;
}

function hashValue(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stablePrefix(value, limit = 4096) {
    let output = '';
    const append = text => {
        if (output.length >= limit) return false;
        output += String(text).slice(0, limit - output.length);
        return output.length < limit;
    };
    const visit = (item, depth = 0) => {
        if (output.length >= limit) return;
        if (item === undefined || item === null || typeof item === 'number' || typeof item === 'boolean' || typeof item === 'string') {
            append(JSON.stringify(item ?? null));
            return;
        }
        if (depth >= 8) {
            append('"[depth-limit]"');
            return;
        }
        if (Array.isArray(item)) {
            append('[');
            for (let index = 0; index < Math.min(item.length, 200) && output.length < limit; index += 1) {
                if (index > 0) append(',');
                visit(item[index], depth + 1);
            }
            append(']');
            return;
        }
        if (typeof item === 'object') {
            const priority = ['model', 'instructions', 'tools', 'reasoning'];
            const keys = Object.keys(item).slice(0, 100).sort((left, right) => {
                const leftPriority = priority.indexOf(left);
                const rightPriority = priority.indexOf(right);
                if (leftPriority !== -1 || rightPriority !== -1) {
                    return (leftPriority === -1 ? priority.length : leftPriority) - (rightPriority === -1 ? priority.length : rightPriority);
                }
                return left.localeCompare(right);
            });
            append('{');
            for (let index = 0; index < keys.length && output.length < limit; index += 1) {
                if (index > 0) append(',');
                append(JSON.stringify(keys[index]));
                append(':');
                visit(item[keys[index]], depth + 1);
            }
            append('}');
            return;
        }
        append(JSON.stringify(String(item)));
    };
    visit(value);
    return output;
}

export function resolveCodexSessionScope(requestBody = {}) {
    const metadata = requestBody.metadata || {};
    const clientMetadata = requestBody.client_metadata || {};
    const fingerprintContext = requestBody._codexFingerprintContext || {};
    const inboundHeaders = fingerprintContext.inboundCodexHeaders || {};
    return firstNonEmptyString(
        requestBody.session_id,
        requestBody.thread_id,
        metadata.session_id,
        metadata.conversation_id,
        metadata.user_id,
        clientMetadata.session_id,
        clientMetadata.conversation_id,
        clientMetadata.thread_id,
        clientMetadata.user_id,
        fingerprintContext.originalClientSessionId,
        inboundHeaders['thread-id']
    );
}

export function resolveCodexSessionId(requestBody = {}) {
    return resolveCodexSessionScope(requestBody) || 'default';
}

export function getProvidedPromptCacheKey(requestBody = {}) {
    return firstNonEmptyString(requestBody.prompt_cache_key);
}

export function buildCodexTemplateFingerprint({ potluckApiKey = '', model = '', upstreamBody = {} } = {}) {
    const serializedPrefix = stablePrefix(upstreamBody, 4096);
    const instructions = stablePrefix(upstreamBody.instructions || '', 64 * 1024);
    const tools = stablePrefix(upstreamBody.tools || [], 64 * 1024);
    return hashValue(JSON.stringify({
        potluckKeyHash: hashValue(potluckApiKey || ''),
        model: String(model || ''),
        instructionsHash: hashValue(instructions),
        toolsHash: hashValue(tools),
        prefixHash: hashValue(serializedPrefix)
    }));
}
