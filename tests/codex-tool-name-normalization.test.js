import { describe, expect, test } from '@jest/globals';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';
import { OpenAIResponsesConverter } from '../src/converters/strategies/OpenAIResponsesConverter.js';

describe('Codex tool name normalization', () => {
    test('maps image_gen.imagegen to an upstream-safe name and preserves the reverse mapping', () => {
        const converter = new CodexConverter();
        const requestId = 'imagegen-tool-request';
        const tools = [{
            type: 'function',
            name: 'image_gen.imagegen',
            description: 'Generate image',
            parameters: { type: 'object', properties: {} }
        }];

        converter.buildToolNameMap(tools, requestId);
        const converted = converter.convertTools(tools, requestId);

        expect(converted[0].name).toBe('image_gen__imagegen');
        expect(converter.getOriginalToolName('image_gen__imagegen', requestId)).toBe('image_gen.imagegen');
    });

    test('keeps the already safe image_gen__imagegen name unchanged', () => {
        const converter = new CodexConverter();
        const requestId = 'safe-imagegen-tool-request';
        const tools = [{
            type: 'function',
            function: {
                name: 'image_gen__imagegen',
                description: 'Generate image',
                parameters: { type: 'object', properties: {} }
            }
        }];

        converter.buildToolNameMap(tools, requestId);
        const converted = converter.convertTools(tools, requestId);

        expect(converted[0].name).toBe('image_gen__imagegen');
        expect(converter.getOriginalToolName('image_gen__imagegen', requestId)).toBe('image_gen__imagegen');
    });

    test('normalizes tools on the OpenAI Responses to Codex request path', () => {
        const converter = new OpenAIResponsesConverter();
        const converted = converter.convertRequest({
            model: 'gpt-5.4',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
            tools: [{
                type: 'function',
                name: 'image_gen.imagegen',
                description: 'Generate image',
                parameters: { type: 'object', properties: {} }
            }]
        }, 'codex', 'responses-to-codex-request');

        expect(converted.tools).toEqual([expect.objectContaining({
            type: 'function',
            name: 'image_gen__imagegen'
        })]);
    });

    test('sanitizes illegal tool-name characters after the image_gen mapping and restores the original name', () => {
        const converter = new CodexConverter();
        const requestId = 'illegal-tool-name-request';
        const tools = [{
            type: 'function',
            name: 'my.tool',
            description: 'Lookup',
            parameters: { type: 'object', properties: {} }
        }];

        converter.buildToolNameMap(tools, requestId);
        const converted = converter.convertTools(tools, requestId);

        expect(converted[0].name).toBe('my_tool');
        expect(converter.getOriginalToolName('my_tool', requestId)).toBe('my.tool');
        expect(converter.shortenToolName('lookup_weather')).toBe('lookup_weather');
    });

    test('recursively strips schema dialect keywords and fills empty object properties', () => {
        const converter = new CodexConverter();
        const requestId = 'schema-dialect-request';
        const tools = [{
            type: 'function',
            name: 'lookup_weather',
            description: 'Lookup weather',
            parameters: {
                $schema: 'http://json-schema.org/draft-07/schema#',
                type: 'object',
                properties: {
                    city: {
                        $id: 'city-field',
                        type: 'string'
                    },
                    extras: {
                        type: 'object'
                    }
                }
            }
        }];

        const converted = converter.convertTools(tools, requestId);

        expect(converted[0].parameters).toEqual({
            type: 'object',
            properties: {
                city: { type: 'string' },
                extras: { type: 'object', properties: {} }
            }
        });
        expect(converted[0].parameters).not.toHaveProperty('$schema');
        expect(converted[0].parameters.properties.city).not.toHaveProperty('$id');
    });

    test('leaves a clean function tool schema unchanged', () => {
        const converter = new CodexConverter();
        const requestId = 'clean-schema-request';
        const parameters = {
            type: 'object',
            properties: {
                q: { type: 'string' }
            },
            required: ['q']
        };
        const tools = [{
            type: 'function',
            name: 'lookup_weather',
            description: 'Lookup weather',
            parameters
        }];

        const converted = converter.convertTools(tools, requestId);

        expect(converted[0].parameters).toEqual(parameters);
        expect(converted[0].name).toBe('lookup_weather');
    });

    test('keeps distinct deterministic hashes for long tool names with the same prefix', () => {
        const converter = new CodexConverter();
        const sharedPrefix = 'tool_' + 'x'.repeat(80);
        const first = converter.shortenToolName(`${sharedPrefix}_first`);
        const second = converter.shortenToolName(`${sharedPrefix}_second`);

        expect(first).toHaveLength(64);
        expect(second).toHaveLength(64);
        expect(first).toMatch(/_[0-9a-f]{16}$/);
        expect(second).toMatch(/_[0-9a-f]{16}$/);
        expect(first).not.toBe(second);
        expect(converter.shortenToolName(`${sharedPrefix}_first`)).toBe(first);
    });

    test('preserves malformed function arguments in Gemini and Claude responses', () => {
        const converter = new CodexConverter();
        const completed = {
            type: 'response.completed',
            response: {
                id: 'resp_tool_args',
                model: 'gpt-5.5',
                status: 'completed',
                usage: {},
                output: [{
                    type: 'function_call',
                    call_id: 'call_bad_args',
                    name: 'example_tool',
                    arguments: '{not valid json'
                }]
            }
        };

        expect(() => converter.toGeminiResponse(completed, 'gpt-5.5')).not.toThrow();
        expect(converter.toGeminiResponse(completed, 'gpt-5.5')
            .candidates[0].content.parts[0].functionCall.args).toEqual({
            _raw_arguments: '{not valid json'
        });

        expect(() => converter.toClaudeResponse(completed, 'gpt-5.5')).not.toThrow();
        expect(converter.toClaudeResponse(completed, 'gpt-5.5').content[0].input).toEqual({
            _raw_arguments: '{not valid json'
        });
    });

    test.each([
        [null, {}],
        ['', {}],
        [{ value: 1 }, { value: 1 }],
        ['{"value":1}', { value: 1 }]
    ])('safely parses tool arguments %#', (input, expected) => {
        const converter = new CodexConverter();
        expect(converter.safeParseToolArguments(input)).toEqual(expected);
    });
});
