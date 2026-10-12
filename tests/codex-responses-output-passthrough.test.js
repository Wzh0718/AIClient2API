import { describe, expect, test } from '@jest/globals';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';
import { isSupportedImageApiModel } from '../src/utils/constants.js';

const LONG_TOOL = `mcp__${'very_long_server_name_'.repeat(3)}__lookup_the_weather_for_a_city`;

function completed(output, extra = {}) {
    return {
        type: 'response.completed',
        response: {
            id: 'resp_1', object: 'response', model: 'gpt-6-sol', status: 'completed', created_at: 1,
            output,
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 } },
            ...extra
        }
    };
}

describe('Codex -> OpenAI Responses non-stream output passthrough', () => {
    test('keeps function_call call_id, web_search_call, reasoning, annotations and compaction items', () => {
        const converter = new CodexConverter();
        const reasoning = { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }], encrypted_content: 'enc' };
        const search = { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'codex release' } };
        const message = {
            id: 'msg_1', type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: '0.162.1', annotations: [{ type: 'url_citation', url: 'https://github.com/openai/codex/releases' }] }]
        };
        const call = { id: 'fc_1', type: 'function_call', call_id: 'call_abc', name: 'get_weather', arguments: '{"city":"上海"}', status: 'completed' };
        const compaction = { id: 'cmp_1', type: 'compaction', encrypted_content: 'cmp-enc' };

        const out = converter.toOpenAIResponsesResponse(completed([reasoning, search, message, call, compaction]), 'gpt-6-sol');

        expect(out.object).toBe('response');
        expect(out.output).toEqual([reasoning, search, message, call, compaction]);
        expect(out.output[3].call_id).toBe('call_abc');
        expect(out.usage.input_tokens_details.cached_tokens).toBe(4);
    });

    test('restores a shortened function tool name from the request mapping', () => {
        const converter = new CodexConverter();
        const request = converter.toOpenAIResponsesToCodexRequest({
            model: 'gpt-6-sol', input: 'hi',
            tools: [{ type: 'function', name: LONG_TOOL, parameters: { type: 'object', properties: {} } }]
        });
        const shortName = request.tools.find(tool => tool.type === 'function').name;
        expect(shortName.length).toBeLessThanOrEqual(64);
        expect(shortName).not.toBe(LONG_TOOL);

        const out = converter.toOpenAIResponsesResponse(completed([
            { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: shortName, arguments: '{}' }
        ]), 'gpt-6-sol');

        expect(out.output[0].name).toBe(LONG_TOOL);
        expect(out.output[0].call_id).toBe('call_1');
    });

    test('returns null for non-completed events like before', () => {
        expect(new CodexConverter().toOpenAIResponsesResponse({ type: 'response.created' }, 'm')).toBeNull();
    });
});

describe('Codex -> OpenAI Responses stream passthrough', () => {
    test('passes events through unchanged when no tool name was shortened', () => {
        const converter = new CodexConverter();
        const chunk = { type: 'response.output_item.done', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' } };
        expect(converter.toOpenAIResponsesStreamChunk(chunk, 'gpt-6-sol', 'req-1')).toBe(chunk);
    });

    test('restores shortened function names on output items and the completed response', () => {
        const converter = new CodexConverter();
        const request = converter.toOpenAIResponsesToCodexRequest({
            model: 'gpt-6-sol', input: 'hi',
            tools: [{ type: 'function', name: LONG_TOOL, parameters: { type: 'object', properties: {} } }]
        });
        const shortName = request.tools.find(tool => tool.type === 'function').name;
        const item = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: shortName, arguments: '{}' };

        const done = converter.toOpenAIResponsesStreamChunk({ type: 'response.output_item.done', output_index: 0, item }, 'gpt-6-sol', 'req-2');
        expect(done.item.name).toBe(LONG_TOOL);
        expect(done.item.call_id).toBe('call_1');
        expect(item.name).toBe(shortName);

        const final = converter.toOpenAIResponsesStreamChunk(completed([item]), 'gpt-6-sol', 'req-2');
        expect(final.response.output[0].name).toBe(LONG_TOOL);
    });
});

describe('OpenAI Responses -> Codex request tools and include', () => {
    test('only rewrites function tools and passes other tool types through unchanged', () => {
        const converter = new CodexConverter();
        const namespace = { type: 'namespace', name: 'mcp__node_repl', description: 'repl', tools: [{ type: 'function', name: 'js', parameters: { type: 'object', properties: {} } }] };
        const custom = { type: 'custom', name: 'apply_patch', description: 'patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: "x"' } };
        const localShell = { type: 'local_shell' };
        const web = { type: 'web_search', external_web_access: true };
        const fn = { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } };

        const request = converter.toOpenAIResponsesToCodexRequest({ model: 'gpt-6-sol', input: 'hi', tools: [namespace, custom, localShell, web, fn] });

        expect(request.tools[0]).toEqual(namespace);
        expect(request.tools[1]).toEqual(custom);
        expect(request.tools[2]).toEqual(localShell);
        expect(request.tools[3]).toEqual(web);
        expect(request.tools[4]).toMatchObject({ type: 'function', name: 'exec_command' });
    });

    test('shortens replayed function_call names in input to match the shortened tool definition', () => {
        const converter = new CodexConverter();
        const request = converter.toOpenAIResponsesToCodexRequest({
            model: 'gpt-6-sol',
            tools: [{ type: 'function', name: LONG_TOOL, parameters: { type: 'object', properties: {} } }],
            input: [
                { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
                { type: 'function_call', call_id: 'call_1', name: LONG_TOOL, arguments: '{}' },
                { type: 'function_call_output', call_id: 'call_1', output: 'ok' }
            ]
        });
        const shortName = request.tools[0].name;

        expect(request.input[1]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: shortName });
        expect(request.input[2]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'ok' });
    });

    test('keeps client include entries while always requesting encrypted reasoning', () => {
        const converter = new CodexConverter();
        const request = converter.toOpenAIResponsesToCodexRequest({
            model: 'gpt-6-sol', input: 'hi', include: ['web_search_call.action.sources']
        });

        expect(request.include).toEqual(['reasoning.encrypted_content', 'web_search_call.action.sources']);
        expect(converter.toOpenAIResponsesToCodexRequest({ model: 'gpt-6-sol', input: 'hi' }).include)
            .toEqual(['reasoning.encrypted_content']);
    });
});

describe('Image API accepts Codex image speed variants listed in /v1/models', () => {
    test.each([
        ['gpt-image-2-fast', true],
        ['gpt-image-2.5-flare-fast', true],
        ['gpt-image-2.5-sunburst-fast', true],
        ['gpt-image-2.5-fast', false],
        ['gpt-5.5-fast', false],
        ['gpt-image-2', true]
    ])('%s -> %s', (model, expected) => {
        expect(isSupportedImageApiModel(model)).toBe(expected);
    });
});
