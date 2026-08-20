import { PassThrough, Readable } from 'stream';
import { describe, expect, jest, test } from '@jest/globals';

jest.mock('open', () => ({
    __esModule: true,
    default: jest.fn()
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(options => options),
    getRequiredProxyConfigForProvider: jest.fn(() => null),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

jest.mock('../src/auth/oauth-handlers.js', () => ({
    handleGeminiAntigravityOAuth: jest.fn()
}));

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null)
}));

import { GeminiConverter } from '../src/converters/strategies/GeminiConverter.js';
import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';

async function collect(iterable) {
    const items = [];
    for await (const item of iterable) items.push(item);
    return items;
}

function createService(overrides = {}) {
    return new AntigravityApiService({
        MODEL_PROVIDER: 'gemini-antigravity',
        ANTIGRAVITY_BASE_URL: 'http://127.0.0.1:1',
        PROJECT_ID: 'test-project',
        ...overrides
    });
}

describe('Gemini and Antigravity streaming fixes from upstream v3.3.9', () => {
    test('keeps a stream chunk that only contains thoughtSignature', () => {
        const converter = new GeminiConverter();
        const result = converter.toOpenAIStreamChunk({
            candidates: [{
                content: { parts: [{ thoughtSignature: 'internal-signature' }] }
            }]
        }, 'gemini-3-flash');

        expect(result).not.toBeNull();
        expect(result.choices[0].delta).toEqual({});
        expect(result.choices[0].finish_reason).toBeNull();
    });

    test('recovers a non-SSE JSON array response', async () => {
        const service = createService({ ANTIGRAVITY_STREAM_IDLE_TIMEOUT_MS: 1000 });
        const upstreamChunks = [
            { response: { candidates: [{ index: 0 }] } },
            { response: { candidates: [{ index: 1 }] } }
        ];
        const stream = Readable.from([JSON.stringify(upstreamChunks, null, 2)]);

        await expect(collect(service.parseSSEStream(stream))).resolves.toEqual(upstreamChunks);
    });

    test('fails a stream that remains idle', async () => {
        const service = createService({ ANTIGRAVITY_STREAM_IDLE_TIMEOUT_MS: 20 });
        const stream = new PassThrough();

        await expect(collect(service.parseSSEStream(stream))).rejects.toMatchObject({
            code: 'ETIMEDOUT'
        });
    });

    test('uses a first-byte AbortController instead of an absolute stream timeout', async () => {
        const service = createService();
        const responseStream = Readable.from([]);
        let requestOptions;
        service.authClient.request = jest.fn(async options => {
            requestOptions = options;
            return { status: 200, data: responseStream };
        });

        await expect(collect(service.streamApi('streamGenerateContent', {}))).resolves.toEqual([]);
        expect(requestOptions.timeout).toBeUndefined();
        expect(requestOptions.signal).toBeInstanceOf(AbortSignal);
    });

    test('caps error response bodies at 1 MiB', async () => {
        const service = createService();
        const body = await service.readErrorResponseBody(Readable.from([Buffer.alloc(1024 * 1024 + 32, 'x')]));

        expect(Buffer.byteLength(body)).toBeLessThanOrEqual(1024 * 1024 + Buffer.byteLength('\n[error body truncated]'));
        expect(body.endsWith('[error body truncated]')).toBe(true);
    });

    test('refreshes the idle watchdog when raw stream data arrives without a newline', async () => {
        const service = createService({ ANTIGRAVITY_STREAM_IDLE_TIMEOUT_MS: 100 });
        const stream = new PassThrough();
        const resultPromise = collect(service.parseSSEStream(stream));

        stream.write('data: {"response":');
        await new Promise(resolve => setTimeout(resolve, 40));
        stream.write('{"candidates":[]}');
        await new Promise(resolve => setTimeout(resolve, 40));
        stream.end('}\n\n');

        await expect(resultPromise).resolves.toEqual([{ response: { candidates: [] } }]);
    });

    test('does not retry a stream after partial output', async () => {
        const service = createService({ REQUEST_MAX_RETRIES: 1 });
        service.parseSSEStream = jest.fn(async function* () {
            yield { response: { candidates: [{ index: 0 }] } };
            const error = new Error('socket reset after output');
            error.code = 'ECONNRESET';
            throw error;
        });
        service.authClient.request = jest.fn(async () => ({
            status: 200,
            data: Readable.from([])
        }));

        const output = [];
        await expect((async () => {
            for await (const chunk of service.streamApi('streamGenerateContent', {})) output.push(chunk);
        })()).rejects.toMatchObject({ code: 'ECONNRESET' });

        expect(output).toHaveLength(1);
        expect(service.authClient.request).toHaveBeenCalledTimes(1);
    });
});
