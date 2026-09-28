import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
jest.mock('../src/utils/proxy-utils.js', () => ({ configureTLSSidecar: jest.fn() }));
jest.mock('../src/providers/adapter.js', () => ({
    getRegisteredProviders: jest.fn(), getServiceAdapter: jest.fn(),
    invalidateServiceAdapter: jest.fn(), serviceInstances: {}
}));
import { handleGlmProtocolTest } from '../src/ui-modules/provider-api.js';
import { GlmCodingPlanAdapter } from '../src/providers/glm/coding-plan-adapter.js';

test('six complete GLM responses verify the node with enough room for reasoning tokens', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-protocol-'));
    const poolsPath = path.join(dir, 'pools.json');
    const node = { uuid: 'glm-test', GLM_API_KEY: 'test-key', glmVerified: false, isHealthy: false };
    fs.writeFileSync(poolsPath, JSON.stringify({ 'glm-coding-plan': [node] }));
    const bodies = [];
    const nonStream = jest.spyOn(GlmCodingPlanAdapter.prototype, 'generateContent').mockImplementation(async (_model, body) => {
        bodies.push(body);
        if (body.messages) return { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] };
        if (body.tools) return { status: 'completed', output: [{ type: 'function_call', name: 'probe', call_id: 'call-1', arguments: '{"value":"ok"}' }] };
        return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] };
    });
    const stream = jest.spyOn(GlmCodingPlanAdapter.prototype, 'generateContentStream').mockImplementation(async function* (_model, body) {
        bodies.push(body);
        if (body.tools) yield { type: 'response.output_item.done', item: { type: 'function_call' } };
        yield { type: 'response.completed' };
    });
    try {
        const manager = { providerPools: { 'glm-coding-plan': [node] }, publishProviderConfig: jest.fn() };
        const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
        await handleGlmProtocolTest({}, res, { PROVIDER_POOLS_FILE_PATH: poolsPath }, manager, node.uuid);
        expect(res.status).toBe(200);
        expect(res.body.results).toHaveLength(6);
        expect(res.body.verified).toBe(true);
        expect(bodies.every(body => (body.max_tokens || body.max_output_tokens) >= 1024)).toBe(true);
        expect(JSON.parse(fs.readFileSync(poolsPath))['glm-coding-plan'][0]).toMatchObject({ glmVerified: true, isHealthy: true });
    } finally {
        nonStream.mockRestore();
        stream.mockRestore();
        fs.rmSync(dir, { recursive: true });
    }
});
