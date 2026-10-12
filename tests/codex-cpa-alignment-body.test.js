import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { CodexApiService, sanitizeCodexInputItemIds, shortenCodexInputId } from '../src/providers/openai/codex-core.js';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';

jest.mock('../src/auth/oauth-handlers.js', () => ({
    refreshCodexTokensWithRetry: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(config => config),
    isTLSSidecarEnabledForProvider: jest.fn(() => false),
    getProxyConfigForProvider: jest.fn(() => null)
}));

let consoleSpies = [];

beforeEach(() => {
    consoleSpies = ['log', 'warn', 'error'].map(method => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach(spy => spy.mockRestore());
    consoleSpies = [];
});

async function prepare(body = {}, model = 'gpt-5.5') {
    const service = new CodexApiService({ MODEL_PROVIDER: 'openai-codex-oauth' });
    try {
        return await service.prepareRequestBody(model, {
            model,
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
            ...body
        }, true);
    } finally {
        service.stopCacheCleanup();
    }
}

describe('Codex request body alignment with CLIProxyAPI', () => {
    test('strips parameters the Codex backend does not accept', async () => {
        const body = await prepare({
            truncation: 'auto',
            user: 'someone',
            max_output_tokens: 100,
            max_completion_tokens: 100,
            prompt_cache_breakpoint: 1,
            generate: false,
            previous_response_id: 'resp_1',
            safety_identifier: 'sid',
            stream_options: { include_usage: true }
        });

        for (const key of [
            'truncation', 'user', 'max_output_tokens', 'max_completion_tokens',
            'prompt_cache_breakpoint', 'generate', 'previous_response_id', 'safety_identifier', 'stream_options'
        ]) {
            expect(body).not.toHaveProperty(key);
        }
    });

    test('does not inject a hosted image_generation tool and keeps web_search declared', async () => {
        const body = await prepare();

        expect(body.tools.some(tool => tool.type === 'image_generation')).toBe(false);
        expect(body.tools.filter(tool => tool.type === 'web_search')).toEqual([{ type: 'web_search', external_web_access: true }]);
        expect(body.tool_choice).toBe('auto');
    });

    test('passes a client-supplied web_search or image_generation tool through unchanged', async () => {
        const web = { type: 'web_search', external_web_access: true };
        const image = { type: 'image_generation', output_format: 'webp' };
        const body = await prepare({ tools: [web, image] });

        expect(body.tools).toEqual([web, image]);
    });

    test('keeps encrypted reasoning include by default', async () => {
        const body = await prepare();

        expect(body.include).toEqual(['reasoning.encrypted_content']);
    });

    test('Chat requests with a system prompt are not prefixed with an injected instruction message', () => {
        const converter = new CodexConverter();
        const codex = converter.toOpenAIRequestToCodexRequest({
            model: 'gpt-5.5',
            messages: [
                { role: 'system', content: 'You are terse.' },
                { role: 'user', content: 'hi' }
            ]
        }, 'req-no-inject');

        expect(codex.instructions).toBe('You are terse.');
        expect(codex.input).toHaveLength(1);
        expect(JSON.stringify(codex.input)).not.toContain('EXECUTE ACCORDING');
        expect(codex.input[0].role).toBe('user');
    });

    test('shortens overlong item and call ids deterministically while keeping call pairs matched', () => {
        const longId = `call_${'x'.repeat(100)}`;
        const shortened = shortenCodexInputId(longId);

        expect(shortened).toHaveLength(64);
        expect(shortenCodexInputId(longId)).toBe(shortened);
        expect(shortenCodexInputId('call_short')).toBe('call_short');

        const input = [
            { type: 'function_call', call_id: longId, name: 'lookup', arguments: '{}' },
            { type: 'function_call_output', call_id: longId, output: 'ok' },
            { type: 'message', id: `msg_${'y'.repeat(80)}`, role: 'user', content: [] },
            { type: 'message', id: 'msg_ok', role: 'user', content: [] }
        ];
        const result = sanitizeCodexInputItemIds(input);

        expect(result[0].call_id).toBe(shortened);
        expect(result[1].call_id).toBe(shortened);
        expect(result[2].id).toHaveLength(64);
        expect(result[3]).toBe(input[3]);
        expect(input[0].call_id).toBe(longId);
    });

    test('passes remote compaction v2 items through unchanged (compaction_trigger and replayed compaction)', async () => {
        const compaction = { id: 'cmp_' + 'a'.repeat(50), type: 'compaction', encrypted_content: 'gAAAA-encrypted' };
        const body = await prepare({
            input: [
                compaction,
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
                { type: 'compaction_trigger' }
            ]
        });

        expect(body.input[0]).toEqual(compaction);
        expect(body.input[2]).toEqual({ type: 'compaction_trigger' });
    });
});

