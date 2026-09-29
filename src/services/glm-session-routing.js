// GLM Coding Plan routing. Protocol handling follows the OpenAI-compatible
// executor in CLIProxyAPI acdace93 (MIT); selection remains owned by this app.
import crypto from 'node:crypto';
import { RedisRespClient } from '../runtime/redis-resp-client.js';
import { MODEL_PROVIDER } from '../utils/constants.js';
import { CredentialGroupService, resolveKeyRoutingAssignment, routeKeyToCredentialCandidates } from './codex-credential-group-service.js';

export const GLM_MODEL = 'glm-5.3-flash';
export const GLM_AFFINITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIX = 'aiclient:glm-session:v1:';
let redisClient;

export function isGlmPrefixedResponsesEligible(path, providerHeader) {
    return !providerHeader && path === `/${MODEL_PROVIDER.CODEX_API}/v1/responses`;
}

export function shouldAttemptGlmSessionRouting(config = {}, { temporaryRoute = false, customModelConfig = false } = {}) {
    return !temporaryRoute
        && !customModelConfig
        && !config.potluckKeyData?.fixedCredential?.uuid
        && config.potluckKeyData?.routingMode !== 'restricted'
        && config.MODEL_PROVIDER === MODEL_PROVIDER.CODEX_API
        && (!config._explicitProviderSelection || config._glmPrefixedResponsesEligible === true);
}

function redis() {
    if (redisClient) return redisClient;
    if (!process.env.REDIS_URL) throw Object.assign(new Error('GLM session routing requires Redis'), { status: 503, code: 'GLM_AFFINITY_UNAVAILABLE' });
    const url = new URL(process.env.REDIS_URL);
    if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('Invalid Redis URL');
    redisClient = new RedisRespClient({
        host: url.hostname,
        port: Number(url.port || (url.protocol === 'rediss:' ? 6380 : 6379)),
        password: url.password ? decodeURIComponent(url.password) : null,
        database: Number(url.pathname.slice(1) || 0),
        tls: url.protocol === 'rediss:'
    });
    return redisClient;
}

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function weight(config) {
    const value = Number(config?.providerWeight ?? 1);
    return Number.isFinite(value) && value > 0 ? value : 1;
}
function stableScore(key, candidate) {
    const bytes = crypto.createHash('sha256').update(`${key}:${candidate.type}:${candidate.uuid}`).digest();
    const unit = (bytes.readUIntBE(0, 6) + 1) / 281474976710657;
    return -Math.log(unit) / weight(candidate.config);
}
function statusError(message, code, status = 503) {
    return Object.assign(new Error(message), { code, status });
}

export function glmUnsupportedCapability(body, endpointType) {
    if (!body || !['openai_chat', 'openai_responses'].includes(endpointType)) return 'endpoint';
    if (body.conversation) return 'stored_response';
    if (body.background || body.audio || body.image_generation) return 'unsupported_feature';
    if (['service_tier', 'modalities', 'prediction', 'web_search_options'].some(key => body[key] !== undefined)) return 'unsupported_parameter';
    const serialized = JSON.stringify(body);
    if (/"(?:input_image|input_file|image_url|video_url|input_audio|audio_url|file_data|file_id|image_generation|computer_use|code_interpreter|web_search|file_search)"/.test(serialized)) return 'unsupported_content';
    if (Array.isArray(body.tools) && body.tools.some(tool => tool?.type !== 'function')) return 'unsupported_tool';
    return null;
}

export function glmSessionIdentity(config, body) {
    const scope = config?._codexCacheAffinityScope || {};
    const raw = scope.threadId || scope.sessionId || scope.promptCacheKey;
    if ((typeof raw !== 'string' && typeof raw !== 'number') || !String(raw).trim() || String(raw).length > 256) return null;
    const client = config._glmClientIdentity || config.potluckKeyData?.id || config.potluckKeyHash || config.potluckApiKey;
    if (!client) return null;
    return hash(`${client}\0${raw}`);
}

export async function glmRouteCandidates(manager, requestedModel, config = {}) {
    const types = [MODEL_PROVIDER.CODEX_API, MODEL_PROVIDER.GLM_CODING_PLAN];
    const pools = await Promise.all(types.map(async type => {
        if (!manager?._getHealthyProvidersForType) return manager?.providerStatus?.[type] || [];
        return manager._getHealthyProvidersForType(type, type === MODEL_PROVIDER.GLM_CODING_PLAN ? GLM_MODEL : requestedModel);
    }));
    let allowedCodexUuids = null;
    if (config.potluckKeyData) {
        const groupConfig = await new CredentialGroupService({ filePath: config.CODEX_CREDENTIAL_GROUPS_FILE_PATH }).getCurrentConfig();
        const keyRouting = resolveKeyRoutingAssignment(config.potluckKeyData, groupConfig);
        if (keyRouting.routingMode === 'fixed' || keyRouting.routingMode === 'restricted') return [];
        const route = routeKeyToCredentialCandidates({
            keyRouting,
            groups: groupConfig.groups || [],
            credentials: pools[0].map(item => ({ ...item.config, uuid: item.uuid || item.config?.uuid, providerType: MODEL_PROVIDER.CODEX_API }))
        });
        allowedCodexUuids = new Set([...(route.candidateProviderUuids || []), ...(route.fallbackProviderUuids || [])]);
        if (allowedCodexUuids.size === 0) return [];
    }
    return types.flatMap((type, index) => pools[index]
        .filter(item => item?.config?.isDisabled !== true && item?.config?.isHealthy === true && item?.config?.needsRefresh !== true)
        .filter(item => type !== MODEL_PROVIDER.CODEX_API || !allowedCodexUuids || allowedCodexUuids.has(item.uuid || item.config?.uuid))
        .filter(item => type !== MODEL_PROVIDER.GLM_CODING_PLAN || (Boolean(item.config.GLM_API_KEY) && item.config.glmVerified === true))
        .map(item => ({ type, uuid: item.uuid || item.config.uuid, config: item.config }))
        .filter(item => item.uuid));
}

const BIND_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return {'affinity', existing}
end
if ARGV[1] == '' then return {'unassigned', ''} end
local created = redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
local winner = redis.call('GET', KEYS[1]) or ''
return {created and 'assigned' or 'affinity', winner}`;

export async function resolveGlmSessionRoute({ config, body, endpointType, manager, redisExecutor = null }) {
    if (config.MODEL_PROVIDER !== MODEL_PROVIDER.CODEX_API || !/^gpt-(?!image)/i.test(body?.model || '')) return null;
    if (!config.GLM_SESSION_ROUTING_ENABLED && !process.env.REDIS_URL && !redisExecutor) return null;
    let executor;
    try { executor = redisExecutor || (config.GLM_SESSION_ROUTING_ENABLED || process.env.REDIS_URL ? redis() : null); }
    catch (error) { throw statusError(`GLM session affinity unavailable: ${error.message}`, 'GLM_AFFINITY_UNAVAILABLE'); }
    let identity = glmSessionIdentity(config, body);
    let unknownContinuation = false;
    if (body.previous_response_id) {
        const client = config._glmClientIdentity || config.potluckKeyData?.id || config.potluckKeyHash || config.potluckApiKey;
        if (!client) throw statusError('Cannot identify client for response continuation', 'GLM_CONTINUATION_UNKNOWN', 422);
        try {
            const fromResponse = await executor?.command(['GET', `${PREFIX}response:${hash(`${client}\0${body.previous_response_id}`)}`]);
            if (!fromResponse) {
                if (!identity) throw statusError('Unknown response continuation', 'GLM_CONTINUATION_UNKNOWN', 422);
                unknownContinuation = true;
            } else {
                if (identity && identity !== fromResponse) throw statusError('Response continuation belongs to a different session', 'GLM_CONTINUATION_MISMATCH', 422);
                identity = fromResponse;
            }
        } catch (error) {
            if (error.code?.startsWith('GLM_CONTINUATION_')) throw error;
            throw statusError('Response continuation lookup unavailable', 'GLM_AFFINITY_UNAVAILABLE');
        }
    }
    if (!identity) return { reason: 'no_session_id' };
    const candidates = await glmRouteCandidates(manager, body.model, config);
    const capability = glmUnsupportedCapability(body, endpointType);
    const usable = capability || unknownContinuation ? candidates.filter(item => item.type !== MODEL_PROVIDER.GLM_CODING_PLAN) : candidates;
    const selected = usable.length
        ? (config.GLM_SESSION_ROUTING_ENABLED
            ? usable
            : usable.filter(item => item.type === MODEL_PROVIDER.CODEX_API)
        ).sort((a, b) => stableScore(identity, a) - stableScore(identity, b))[0]
        : null;
    const key = `${PREFIX}${identity}`;
    let bindingResult;
    try {
        bindingResult = await executor.evalScript('glm-session-bind-v2', BIND_SCRIPT, [key], [selected ? `${selected.type}:${selected.uuid}` : '', String(GLM_AFFINITY_TTL_MS)]);
    } catch (error) {
        throw statusError(`GLM session affinity unavailable: ${error.message}`, 'GLM_AFFINITY_UNAVAILABLE');
    }
    const [decision, binding] = Array.isArray(bindingResult) ? bindingResult : ['affinity', bindingResult];
    if (!binding) return { reason: capability || 'disabled_or_no_glm' };
    const index = String(binding).lastIndexOf(':');
    const type = String(binding).slice(0, index);
    const uuid = String(binding).slice(index + 1);
    if (![MODEL_PROVIDER.CODEX_API, MODEL_PROVIDER.GLM_CODING_PLAN].includes(type)) throw statusError('Invalid GLM session binding', 'GLM_BINDING_INVALID');
    if (type === MODEL_PROVIDER.GLM_CODING_PLAN) {
        if (unknownContinuation) throw statusError('Unknown GLM response continuation', 'GLM_CONTINUATION_UNKNOWN', 422);
        if (capability) throw statusError(`GLM session cannot process ${capability}`, 'GLM_UNSUPPORTED_CAPABILITY', 422);
        if (!candidates.some(item => item.type === type && item.uuid === uuid)) throw statusError('Bound GLM node is unavailable', 'GLM_BOUND_NODE_UNAVAILABLE');
    }
    return { type, uuid, identity, reason: decision };
}

export async function recordGlmResponseOwnership(config, responseId, redisExecutor = null) {
    const identity = config?._glmRouting?.identity;
    if (!identity || !responseId) return;
    const client = config._glmClientIdentity || config.potluckKeyData?.id || config.potluckKeyHash || config.potluckApiKey;
    if (!client) return;
    await (redisExecutor || redis()).command(['SET', `${PREFIX}response:${hash(`${client}\0${responseId}`)}`, identity, 'PX', String(GLM_AFFINITY_TTL_MS)]);
}

export async function countGlmBindings(uuid) {
    let cursor = '0';
    let count = 0;
    do {
        const [next, keys] = await redis().command(['SCAN', cursor, 'MATCH', `${PREFIX}*`, 'COUNT', '200']);
        cursor = String(next);
        if (keys.length) {
            const values = await redis().command(['MGET', ...keys]);
            count += values.filter(value => value === `${MODEL_PROVIDER.GLM_CODING_PLAN}:${uuid}`).length;
        }
    } while (cursor !== '0');
    return count;
}
