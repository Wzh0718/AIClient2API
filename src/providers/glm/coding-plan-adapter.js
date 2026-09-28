// Adapted protocol boundary from CLIProxyAPI acdace93, MIT License.
// Source: internal/runtime/executor/openai_compat_executor.go.
// GLM Coding Plan uses its dedicated domestic Chat and Responses endpoints.
import axios from 'axios';
import { configureTLSSidecar } from '../../utils/proxy-utils.js';
import { GLM_MODEL, recordGlmResponseOwnership } from '../../services/glm-session-routing.js';
import requestContext from '../../utils/context.js';

const CHAT_BASE = 'https://open.bigmodel.cn/api/coding/paas/v4';
const RESPONSES_BASE = 'https://open.bigmodel.cn/api/v1';

function classify(error) {
    const status = error.response?.status || error.status;
    const upstreamError = error.response?.data?.error || error.response?.data || {};
    const detail = `${upstreamError.code || ''} ${upstreamError.message || ''}`;
    const quota = /(?:quota|balance|credit|额度|余额|1113)/i.test(detail);
    const code = quota ? 'GLM_QUOTA_EXHAUSTED'
        : status === 401 || status === 403 ? 'GLM_AUTH_FAILED'
        : status === 429 ? 'GLM_RATE_LIMITED'
        : status >= 500 ? 'GLM_UPSTREAM_ERROR' : 'GLM_NETWORK_ERROR';
    error.code = error.code?.startsWith('GLM_') ? error.code : code;
    error.status = status || 502;
    return error;
}

async function classifyAsync(error) {
    const body = error.response?.data;
    if (body && typeof body[Symbol.asyncIterator] === 'function') {
        let text = '';
        for await (const chunk of body) {
            text += chunk.toString('utf8');
            if (text.length >= 4096) break;
        }
        body.destroy?.();
        try { error.response.data = JSON.parse(text.slice(0, 4096)); }
        catch { error.response.data = { message: text.slice(0, 4096) }; }
    }
    return classify(error);
}

function cleanBody(body) {
    const data = { ...body, model: GLM_MODEL };
    for (const key of Object.keys(data)) if (key.startsWith('_')) delete data[key];
    return data;
}

function ownershipConfig(config, body) {
    return { ...config, _glmRouting: body._glmRouting || null, _glmClientIdentity: body._glmClientIdentity || null };
}

function preserveAlias(value, alias) {
    if (!alias || !value || typeof value !== 'object') return value;
    if (value.model === GLM_MODEL) value.model = alias;
    if (value.response?.model === GLM_MODEL) value.response.model = alias;
    return value;
}

export class GlmCodingPlanAdapter {
    constructor(config) {
        if (!config.GLM_API_KEY) throw new Error('GLM Coding Plan API key is required');
        this.config = config;
        this.client = axios.create({ timeout: Number(config.GLM_TIMEOUT_MS) || 120000 });
    }

    request(body, streaming) {
        const responses = body.input !== undefined || body.instructions !== undefined;
        const base = responses ? RESPONSES_BASE : CHAT_BASE;
        const request = {
            method: 'post',
            url: `${base}${responses ? '/responses' : '/chat/completions'}`,
            data: { ...cleanBody(body), stream: streaming },
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.GLM_API_KEY}` },
            ...(streaming ? { responseType: 'stream' } : {})
        };
        configureTLSSidecar(request, this.config, this.config.MODEL_PROVIDER, base);
        return request;
    }

    async generateContent(_model, body) {
        try {
            const response = await this.client.request(this.request(body, false));
            if (response.data?.model) requestContext.set('glmUpstreamResponseModel', response.data.model);
            await recordGlmResponseOwnership(ownershipConfig(this.config, body), response.data?.id);
            return preserveAlias(response.data, body._glmRequestedModel);
        } catch (error) { throw await classifyAsync(error); }
    }

    async *generateContentStream(_model, body) {
        let response;
        try { response = await this.client.request(this.request(body, true)); }
        catch (error) { throw await classifyAsync(error); }
        let buffer = '';
        let completed = false;
        try {
            for await (const chunk of response.data) {
                buffer += chunk.toString('utf8');
                let boundary;
                while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
                    const frame = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
                    const payload = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                    if (!payload) continue;
                    if (payload === '[DONE]') {
                        if (!completed) throw Object.assign(new Error('GLM stream ended without terminal event'), { code: 'GLM_INCOMPLETE_STREAM', status: 502 });
                        return;
                    }
                    let event;
                    try { event = JSON.parse(payload); }
                    catch { throw Object.assign(new Error('Invalid GLM SSE JSON'), { code: 'GLM_BAD_STREAM', status: 502 }); }
                    if (event.type === 'response.completed' || event.type === 'response.failed' || event.choices?.some(choice => choice.finish_reason)) completed = true;
                    if (event.type === 'response.completed') await recordGlmResponseOwnership(ownershipConfig(this.config, body), event.response?.id);
                    if (event.response?.model) requestContext.set('glmUpstreamResponseModel', event.response.model);
                    yield preserveAlias(event, body._glmRequestedModel);
                }
            }
        } catch (error) { throw await classifyAsync(error); }
        finally { response.data.destroy(); }
        if (!completed) throw Object.assign(new Error('GLM stream ended without terminal event'), { code: 'GLM_INCOMPLETE_STREAM', status: 502 });
    }

    async listModels() {
        return { object: 'list', data: [{ id: GLM_MODEL, object: 'model', owned_by: 'glm-coding-plan' }] };
    }
    async refreshToken() { return false; }
    async forceRefreshToken() { return false; }
    isExpiryDateNear() { return false; }
}
