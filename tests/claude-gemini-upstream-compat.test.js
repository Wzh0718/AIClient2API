import { ClaudeConverter } from '../src/converters/strategies/ClaudeConverter.js';

const converter = new ClaudeConverter();
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'synthetic-image' } };
const urlImage = { type: 'image', source: { type: 'url', url: 'https://example.invalid/image.png' } };
const text = { type: 'text', text: 'synthetic result' };
const unknown = { type: 'custom', payload: 'retained' };
const fn = { name: 'read_file', input_schema: { type: 'object', properties: {} } };

function convertResult(content) {
    return converter.toGeminiRequest({ messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_arbitrary_uuid', name: 'read_file', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_arbitrary_uuid', content }] }
    ] });
}
function resultParts(content) {
    return convertResult(content).contents.flatMap(item => item.parts).filter(part => !part.functionCall);
}
function convertTools(tools, tool_choice = { type: 'auto' }) {
    return converter.toGeminiRequest({ messages: [{ role: 'user', content: 'synthetic request' }], tools, tool_choice });
}

describe('Claude to Gemini selective upstream compatibility', () => {
    test('maps arbitrary IDs to exact tool names and retains original IDs', () => {
        const result = converter.toGeminiRequest({ messages: [
            { role: 'assistant', content: [
                { type: 'tool_use', id: 'tool_random_one', name: 'read_file', input: {} },
                { type: 'tool_use', id: 'tool_random_two', name: 'shell', input: {} }
            ] },
            { role: 'user', content: ['tool_random_two', 'tool_random_one', 'fallback-uuid'].map(id => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })) }
        ] });
        const responses = result.contents.flatMap(item => item.parts).filter(part => part.functionResponse).map(part => part.functionResponse);
        expect(responses.map(item => [item.id, item.name])).toEqual([
            ['tool_random_two', 'shell'], ['tool_random_one', 'read_file'], ['fallback-uuid', 'fallback']
        ]);
    });

    test.each([[image], [text, image]])('extracts base64 images as visual parts', (...content) => {
        const parts = resultParts(content);
        expect(parts[0].functionResponse).toMatchObject({ name: 'read_file', id: 'tool_arbitrary_uuid' });
        expect(parts[0].functionResponse.response.result).toBe(content.includes(text) ? text.text : '');
        expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'synthetic-image' } });
    });

    test.each([[urlImage], [text, urlImage, unknown], [text, urlImage, unknown, image]])('preserves unconverted blocks alongside text', (...content) => {
        const parts = resultParts(content);
        const retained = JSON.parse(parts[0].functionResponse.response.result);
        expect(retained).toEqual(content.filter(item => item !== image));
        expect(parts.filter(part => part.inlineData)).toHaveLength(content.includes(image) ? 1 : 0);
    });

    test('keeps malformed base64 blocks and uses a default MIME for valid images', () => {
        const malformed = { type: 'image', source: { type: 'base64', data: '' } };
        expect(JSON.parse(resultParts([text, malformed])[0].functionResponse.response.result)).toEqual([text, malformed]);
        expect(resultParts([{ type: 'image', source: { type: 'base64', data: 'synthetic' } }])[1].inlineData.mimeType).toBe('image/jpeg');
    });

    test('maps server search without creating a pseudo function or forwarding search constraints', () => {
        const result = convertTools([{ type: 'web_search_20250305', name: 'web_search', max_uses: 1, allowed_domains: ['example.invalid'] }, fn]);
        expect(result.tools).toEqual([{ functionDeclarations: [expect.objectContaining({ name: 'read_file' })] }, { googleSearch: {} }]);
    });

    test('preserves native extensions without declaring them as functions', () => {
        const result = convertTools([{ name: 'search', google_search: { custom: true } }, { url_context: {} }, { googleMaps: {} }, fn]);
        expect(result.tools).toEqual([
            { functionDeclarations: [expect.objectContaining({ name: 'read_file' })] },
            { googleSearch: { custom: true } }, { urlContext: {} }, { googleMaps: {} }
        ]);
    });

    test('none removes native tools and disables ordinary functions', () => {
        const native = [{ type: 'web_search_20250305', name: 'web_search' }, { google_search: {} }, { url_context: {} }, { googleMaps: {} }];
        expect(convertTools(native, { type: 'none' }).tools).toBeUndefined();
        const mixed = convertTools([...native, fn], { type: 'none' });
        expect(mixed.tools).toEqual([{ functionDeclarations: [expect.objectContaining({ name: 'read_file' })] }]);
        expect(mixed.toolConfig.functionCallingConfig.mode).toBe('NONE');
    });

    test('allows forcing declared functions and rejects missing or native ones', () => {
        expect(convertTools([fn], { type: 'tool', name: 'read_file' }).toolConfig.functionCallingConfig).toEqual({ mode: 'ANY', allowedFunctionNames: ['read_file'] });
        for (const tools of [[], [fn], [{ type: 'web_search_20250305', name: 'web_search' }], [{ name: 'web_search', google_search: {} }]]) {
            expect(() => convertTools(tools, { type: 'tool', name: 'web_search' })).toThrow('no matching FunctionDeclaration');
        }
    });
});
