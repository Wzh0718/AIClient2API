import { describe, expect, jest, test } from '@jest/globals';
import { Readable } from 'node:stream';
jest.mock('../src/utils/proxy-utils.js', () => ({ configureTLSSidecar: jest.fn() }));
import { resolveGlmSessionRoute, recordGlmResponseOwnership, GLM_AFFINITY_TTL_MS } from '../src/services/glm-session-routing.js';
import { GlmCodingPlanAdapter } from '../src/providers/glm/coding-plan-adapter.js';
import { createProviderConfigEvent } from '../src/runtime/provider-config-event.js';

const endpointType = 'openai_responses';
const nodes = {
    providerStatus: {
        'openai-codex-oauth': [{ uuid: 'codex-a', config: { uuid: 'codex-a', isHealthy: true, providerWeight: 1 } }],
        'glm-coding-plan': [{ uuid: 'glm-a', config: { uuid: 'glm-a', isHealthy: true, glmVerified: true, GLM_API_KEY: 'test-key', providerWeight: 20 } }]
    }
};
function memoryRedis() {
    const records = new Map();
    return { records, async command(parts) {
        if (parts[0] === 'GET') return records.get(parts[1]) || null;
        if (parts[0] === 'SET') { records.set(parts[1], parts[2]); return 'OK'; }
        throw new Error('unsupported command');
    }, async evalScript(_name, _script, [key], [candidate, ttl]) {
        expect(Number(ttl)).toBe(GLM_AFFINITY_TTL_MS);
        const existed = records.has(key);
        if (!existed && candidate) records.set(key, candidate);
        return [existed ? 'affinity' : 'assigned', records.get(key) || ''];
    } };
}
function config(threadId, enabled = true) {
    return { MODEL_PROVIDER: 'openai-codex-oauth', GLM_SESSION_ROUTING_ENABLED: enabled,
        _glmClientIdentity: 'key-A', _codexCacheAffinityScope: { threadId } };
}

describe('GLM session routing', () => {
    test('config event carries the hot switch with its revision', () => {
        const event = createProviderConfigEvent('glm-coding-plan', [], { revision: 4, glmRoutingEnabled: true });
        expect(event).toMatchObject({ type: 'provider_config_sync', revision: 4, glmRoutingEnabled: true });
    });
    test('weighted first assignment remains bound after the switch is disabled', async () => {
        const executor = memoryRedis();
        let selected;
        for (let i = 0; i < 30; i++) {
            const current = await resolveGlmSessionRoute({ config: config(`thread-${i}`), body: { model: 'gpt-6-sol' }, endpointType, manager: nodes, redisExecutor: executor });
            if (current.type === 'glm-coding-plan') { selected = i; break; }
        }
        expect(selected).toBeDefined();
        nodes.providerStatus['glm-coding-plan'][0].config.providerWeight = 1;
        const again = await resolveGlmSessionRoute({ config: config(`thread-${selected}`, false), body: { model: 'gpt-6-sol' }, endpointType, manager: nodes, redisExecutor: executor });
        expect(again.type).toBe('glm-coding-plan');
        expect(again.uuid).toBe('glm-a');
    });
    test('new sessions distribute approximately according to node weights', async () => {
        const executor = memoryRedis();
        nodes.providerStatus['glm-coding-plan'][0].config.providerWeight = 3;
        let glmCount = 0;
        for (let i = 0; i < 1000; i++) {
            const route = await resolveGlmSessionRoute({ config: config(`distribution-${i}`), body: { model: 'gpt-6-sol' }, endpointType, manager: nodes, redisExecutor: executor });
            if (route.type === 'glm-coding-plan') glmCount++;
        }
        expect(glmCount).toBeGreaterThan(680);
        expect(glmCount).toBeLessThan(820);
    });
    test('different client keys do not share bindings', async () => {
        const executor = memoryRedis();
        const first = config('shared-thread');
        const second = config('shared-thread');
        second._glmClientIdentity = 'key-B';
        await resolveGlmSessionRoute({ config: first, body: { model: 'gpt-6-sol' }, endpointType, manager: nodes, redisExecutor: executor });
        await resolveGlmSessionRoute({ config: second, body: { model: 'gpt-6-sol' }, endpointType, manager: nodes, redisExecutor: executor });
        expect(executor.records.size).toBe(2);
    });
    test('known response continuation reuses its session and unknown IDs fail closed', async () => {
        const executor = memoryRedis();
        const current = config('continuation');
        const first = await resolveGlmSessionRoute({ config: current, body: { model: 'gpt-6-sol' }, endpointType, manager: nodes, redisExecutor: executor });
        current._glmRouting = first;
        await recordGlmResponseOwnership(current, 'resp-known', executor);
        const continued = await resolveGlmSessionRoute({ config: config(null), body: { model: 'gpt-6-sol', previous_response_id: 'resp-known' }, endpointType, manager: nodes, redisExecutor: executor });
        expect(continued.uuid).toBe(first.uuid);
        await expect(resolveGlmSessionRoute({ config: current, body: { model: 'gpt-6-sol', previous_response_id: 'resp-missing' }, endpointType, manager: nodes, redisExecutor: executor })).rejects.toMatchObject({ code: 'GLM_CONTINUATION_UNKNOWN' });
    });
    test('bound GLM rejects unsupported input instead of switching to Codex', async () => {
        const executor = memoryRedis();
        const current = config('bound');
        nodes.providerStatus['glm-coding-plan'][0].config.providerWeight = 100000;
        await resolveGlmSessionRoute({ config: current, body: { model: 'gpt-6-sol' }, endpointType, manager: nodes, redisExecutor: executor });
        await expect(resolveGlmSessionRoute({ config: current, body: { model: 'gpt-6-sol', input: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }] }, endpointType, manager: nodes, redisExecutor: executor })).rejects.toMatchObject({ code: 'GLM_UNSUPPORTED_CAPABILITY' });
    });
});

describe('GLM Coding Plan adapter', () => {
    test('uses separate official endpoints and keeps client model alias', async () => {
        const service = new GlmCodingPlanAdapter({ GLM_API_KEY: 'test-key', MODEL_PROVIDER: 'glm-coding-plan' });
        const calls = [];
        service.client.request = async request => { calls.push(request); return { data: { model: 'glm-5.3-flash', choices: [{ message: { content: 'ok' } }] } }; };
        const chat = await service.generateContent('gpt-6-sol', { model: 'gpt-6-sol', messages: [{ role: 'user', content: 'hi' }], _glmRequestedModel: 'gpt-6-sol' });
        const next = await service.generateContent('gpt-6-luna', { model: 'gpt-6-luna', input: 'hi', _glmRequestedModel: 'gpt-6-luna' });
        expect(calls[0].url).toBe('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
        expect(calls[1].url).toBe('https://open.bigmodel.cn/api/v1/responses');
        expect(calls.every(call => call.data.model === 'glm-5.3-flash')).toBe(true);
        expect(chat.model).toBe('gpt-6-sol');
        expect(next.model).toBe('gpt-6-luna');
    });
    test('stream requires a terminal event', async () => {
        const service = new GlmCodingPlanAdapter({ GLM_API_KEY: 'test-key', MODEL_PROVIDER: 'glm-coding-plan' });
        service.client.request = async () => ({ data: Readable.from(['data: {"type":"response.output_text.delta","delta":"ok"}\n\n']) });
        const events = [];
        await expect((async () => { for await (const event of service.generateContentStream('gpt-6-sol', { input: 'hi' })) events.push(event); })()).rejects.toMatchObject({ code: 'GLM_INCOMPLETE_STREAM' });
        expect(events).toHaveLength(1);
    });
    test('stream preserves the GPT alias and accepts a completed tool call', async () => {
        const service = new GlmCodingPlanAdapter({ GLM_API_KEY: 'test-key', MODEL_PROVIDER: 'glm-coding-plan' });
        service.client.request = async () => ({ data: Readable.from([
            'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"probe","call_id":"call-1","arguments":"{}"}}\n\n',
            'data: {"type":"response.completed","response":{"id":"resp-1","model":"glm-5.3-flash"}}\n\n',
            'data: [DONE]\n\n'
        ]) });
        const events = [];
        for await (const event of service.generateContentStream('gpt-6-sol', { input: 'Call probe', _glmRequestedModel: 'gpt-6-sol' })) events.push(event);
        expect(events.at(-1).response.model).toBe('gpt-6-sol');
        expect(events[0].item.call_id).toBe('call-1');
    });
});
