import { Readable } from 'stream';
import { jest } from '@jest/globals';
import sharp from 'sharp';
import '../src/converters/register-converters.js';
import {
    buildImageGenerationErrorAudit,
    handleAPIRequests,
    shouldRetryFastImageOverload
} from '../src/services/api-manager.js';

const mockGenerateContent = jest.fn();

jest.mock('../src/services/service-manager.js', () => ({
    getProviderPoolManager: jest.fn(() => null),
    getApiServiceWithFallback: jest.fn(async () => ({
        service: { generateContent: mockGenerateContent },
        actualProviderType: 'openai-codex-oauth'
    }))
}));

import { getApiServiceWithFallback } from '../src/services/service-manager.js';

jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }
}));

import logger from '../src/utils/logger.js';
import { runtimeMetrics } from '../src/runtime/runtime-metrics.js';
import { runtimeImageCapacity } from '../src/runtime/runtime-image-capacity.js';

function makeMultipartRequest(parts) {
    const boundary = '----aiclient2api-test-boundary';
    const chunks = [];

    for (const part of parts) {
        chunks.push(Buffer.from(`--${boundary}\r\n`));
        if (part.file) {
            chunks.push(Buffer.from(
                `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
                `Content-Type: ${part.contentType}\r\n\r\n`
            ));
            chunks.push(Buffer.from(part.value));
            chunks.push(Buffer.from('\r\n'));
        } else {
            chunks.push(Buffer.from(
                `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`
            ));
        }
    }

    chunks.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(chunks);
    const req = Readable.from(body);
    req.headers = {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length)
    };
    req.complete = true;
    return req;
}

function makeJsonRequest(body) {
    const payload = Buffer.from(JSON.stringify(body));
    const req = Readable.from(payload);
    req.headers = {
        'content-type': 'application/json',
        'content-length': String(payload.length)
    };
    req.complete = true;
    return req;
}

function makeResponse() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writableEnded: false,
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
        },
        end(body = '') {
            this.body = body;
            this.writableEnded = true;
        }
    };
}

function makeImageResponse(result = 'generated-image-b64') {
    return {
        response: {
            output: [{
                type: 'image_generation_call',
                result,
                output_format: 'png'
            }]
        }
    };
}

async function makePngBase64(width, height, background = { r: 20, g: 80, b: 160, alpha: 1 }) {
    return (await sharp({
        create: { width, height, channels: 4, background }
    }).png().toBuffer()).toString('base64');
}

function makeOverloadError() {
    return new Error('Codex API error: Our servers are currently overloaded. Please try again later.');
}

function makeStreamAbortedError() {
    return new Error('200 HTTP Error (non-stream): stream has been aborted');
}

function makeUpstreamResetError() {
    return Object.assign(
        new Error('503 Service Unavailable (non-stream): upstream connect error or disconnect/reset before headers. reset reason: connection termination'),
        {
            response: {
                status: 503,
                data: {
                    error: {
                        message: 'upstream connect error or disconnect/reset before headers. reset reason: connection termination'
                    }
                }
            }
        }
    );
}

function makeSocketHangUpError({ withCode = true } = {}) {
    const error = new Error('socket hang up');
    if (withCode) error.code = 'ECONNRESET';
    return error;
}

function makeSafetyRejectionResponse() {
    return {
        response: {
            output: [{
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Sorry, I cannot generate that shower scene with a human subject.' }]
            }]
        }
    };
}

function makeProviderPoolManager() {
    return {
        releaseSlot: jest.fn(),
        markProviderUnhealthy: jest.fn(),
        markAntigravityModelQuotaUnhealthy: jest.fn(),
        markProviderUnhealthyWithRecoveryTime: jest.fn()
    };
}

describe('fast image overload retry classification', () => {
    test('allows one retry for an explicit overload that fails before ten seconds', () => {
        expect(shouldRetryFastImageOverload(makeOverloadError(), 9999)).toBe(true);
    });

    test('does not retry overloads at or after ten seconds', () => {
        expect(shouldRetryFastImageOverload(makeOverloadError(), 10000)).toBe(false);
    });

    test.each([
        Object.assign(new Error('Internal Server Error'), { response: { status: 500 } }),
        Object.assign(makeOverloadError(), { response: { status: 429 } }),
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
        Object.assign(new Error('connection aborted'), { code: 'ECONNABORTED' })
    ])('does not retry unrelated, rate-limit, or network failures', (error) => {
        expect(shouldRetryFastImageOverload(error, 1000)).toBe(false);
    });

    test('classifies ECONNRESET image failures as network resets in retry audit', () => {
        const error = makeSocketHangUpError();
        error.imageProviderRetryKind = 'transient';

        expect(buildImageGenerationErrorAudit({
            model: 'gpt-image-2',
            error
        })).toMatchObject({
            errorClass: 'network_reset',
            errorCode: 'ECONNRESET',
            imageProviderRetryKind: 'transient'
        });
    });
});

describe('/v1/images/edits multipart handling', () => {
    beforeEach(() => {
        mockGenerateContent.mockReset();
        getApiServiceWithFallback.mockReset();
        getApiServiceWithFallback.mockResolvedValue({
            service: { generateContent: mockGenerateContent },
            actualProviderType: 'openai-codex-oauth'
        });
        logger.info.mockClear();
        logger.warn.mockClear();
        logger.error.mockClear();
        logger.debug.mockClear();
        mockGenerateContent.mockResolvedValue({
            response: {
                output: [{
                    type: 'image_generation_call',
                    result: 'generated-image-b64',
                    output_format: 'png'
                }]
            }
        });
    });

    test.each(['gpt-image-2', 'gpt-image-2.5'])('preserves multiple image[] files for %s as multiple Codex input_image parts', async model => {
        const req = makeMultipartRequest([
            { name: 'model', value: model },
            { name: 'prompt', value: 'blend these references' },
            { name: 'quality', value: 'high' },
            { name: 'image[]', file: true, filename: 'first.png', contentType: 'image/png', value: 'first-image' },
            { name: 'image[]', file: true, filename: 'second.png', contentType: 'image/png', value: 'second-image' }
        ]);
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/edits',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth' },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        expect(mockGenerateContent.mock.calls[0][0]).toBe(model);
        expect(requestBody._imageQuality).toBe('high');
        const imageParts = requestBody.input[0].content.filter(part => part.type === 'input_image');

        expect(imageParts).toHaveLength(2);
        expect(imageParts[0].image_url).toContain(Buffer.from('first-image').toString('base64'));
        expect(imageParts[1].image_url).toContain(Buffer.from('second-image').toString('base64'));
    });

    test('preserves multiple image files as multiple Codex input_image parts', async () => {
        const req = makeMultipartRequest([
            { name: 'model', value: 'gpt-image-2' },
            { name: 'prompt', value: 'blend these references' },
            { name: 'image', file: true, filename: 'first.png', contentType: 'image/png', value: 'first-image' },
            { name: 'image', file: true, filename: 'second.png', contentType: 'image/png', value: 'second-image' }
        ]);
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/edits',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth' },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        const imageParts = requestBody.input[0].content.filter(part => part.type === 'input_image');

        expect(imageParts).toHaveLength(2);
        expect(imageParts[0].image_url).toContain(Buffer.from('first-image').toString('base64'));
        expect(imageParts[1].image_url).toContain(Buffer.from('second-image').toString('base64'));
    });

    test('logs a redacted provider payload summary for gpt-image-2 edit requests', async () => {
        const req = makeMultipartRequest([
            { name: 'model', value: 'gpt-image-2' },
            { name: 'prompt', value: 'blend these references' },
            { name: 'image', file: true, filename: 'first.png', contentType: 'image/png', value: 'first-image' }
        ]);
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/edits',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth' },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        const imageBase64 = Buffer.from('first-image').toString('base64');
        const payloadSummaryLog = logger.info.mock.calls
            .map(([message]) => message)
            .find(message => message.startsWith('[Image Edits] Payload summary for model=gpt-image-2: '));

        expect(payloadSummaryLog).toBeDefined();
        expect(payloadSummaryLog).not.toContain(imageBase64);
        expect(payloadSummaryLog).not.toContain(requestBody.input[0].content[1].image_url);

        const loggedPayload = JSON.parse(payloadSummaryLog.replace('[Image Edits] Payload summary for model=gpt-image-2: ', ''));

        expect(loggedPayload.input[0].content[1].image_url).toEqual({
            kind: 'data-uri',
            media_type: 'image/png',
            base64_chars: imageBase64.length,
            bytes: Buffer.byteLength('first-image'),
            sha256: expect.stringMatching(/^[a-f0-9]{16}$/)
        });
    });

    test('preserves image tool options for gpt-image-2 edit requests', async () => {
        const req = makeMultipartRequest([
            { name: 'model', value: 'gpt-image-2' },
            { name: 'prompt', value: 'blend these references' },
            { name: 'size', value: '1024x1024' },
            { name: 'quality', value: 'high' },
            { name: 'background', value: 'transparent' },
            { name: 'output_format', value: 'webp' },
            { name: 'input_fidelity', value: 'high' },
            { name: 'moderation', value: 'auto' },
            { name: 'output_compression', value: '80' },
            { name: 'partial_images', value: '2' },
            { name: 'image', file: true, filename: 'first.png', contentType: 'image/png', value: 'first-image' }
        ]);
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/edits',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth', IMAGE_SIZE_NORMALIZATION_ENABLED: false },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        expect(requestBody._imageToolOptions).toEqual({
            size: '1024x1024',
            quality: 'high',
            background: 'transparent',
            output_format: 'webp',
            input_fidelity: 'high',
            moderation: 'auto',
            output_compression: 80,
            partial_images: 2
        });
    });

    test('retries one fast overload per failed edit task without repeating successful parallel tasks', async () => {
        const capacityBefore = runtimeImageCapacity.snapshot();
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
        mockGenerateContent
            .mockRejectedValueOnce(makeOverloadError())
            .mockResolvedValueOnce(makeImageResponse('second-image'))
            .mockResolvedValueOnce(makeImageResponse('retried-first-image'));
        const req = makeMultipartRequest([
            { name: 'model', value: 'gpt-image-2' },
            { name: 'prompt', value: 'edit this image' },
            { name: 'n', value: '2' },
            { name: 'quality', value: 'high' },
            { name: 'image', file: true, filename: 'first.png', contentType: 'image/png', value: 'first-image' }
        ]);
        const res = makeResponse();

        try {
            const handled = await handleAPIRequests(
                'POST',
                '/v1/images/edits',
                req,
                res,
                { MODEL_PROVIDER: 'openai-codex-oauth' },
                null,
                null,
                null
            );
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(mockGenerateContent).toHaveBeenCalledTimes(3);
            expect(mockGenerateContent.mock.calls.map(([, body]) => body._imageQuality)).toEqual(['high', 'high', 'high']);
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[Image Edits] internal overload retry 1/1'));
            expect(runtimeImageCapacity.snapshot()).toMatchObject({
                activeBytes: capacityBefore.activeBytes,
                queued: capacityBefore.queued
            });
        } finally {
            randomSpy.mockRestore();
        }
    });

    test('continues to call the image provider when cumulative output backpressure is already high', async () => {
        const previousBackpressureMs = runtimeMetrics.output.backpressureMs;
        runtimeMetrics.output.backpressureMs = 10_000;
        try {
            const req = makeMultipartRequest([
                { name: 'model', value: 'gpt-image-2' },
                { name: 'prompt', value: 'edit this image' },
                { name: 'image', file: true, filename: 'input.png', contentType: 'image/png', value: 'input-image' }
            ]);
            const res = makeResponse();

            const handled = await handleAPIRequests(
                'POST',
                '/v1/images/edits',
                req,
                res,
                { MODEL_PROVIDER: 'openai-codex-oauth' },
                null,
                null,
                null
            );

            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        } finally {
            runtimeMetrics.output.backpressureMs = previousBackpressureMs;
        }
    });

    test('returns Antigravity model cooldown selection failures as HTTP 429 with quota metadata', async () => {
        const error = new Error('All Antigravity providers are cooling down for model gemini-3.1-flash-image');
        error.status = 429;
        error.quotaScope = 'model';
        error.quotaKey = 'gemini-3.1-flash-image';
        error.nextRecoveryTime = '2026-08-10T10:30:00.000Z';
        getApiServiceWithFallback.mockRejectedValueOnce(error);
        const req = makeJsonRequest({
            model: 'gemini-3.1-flash-image',
            prompt: 'draw a blue circle'
        });
        const res = makeResponse();

        await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            { MODEL_PROVIDER: 'gemini-antigravity' },
            null,
            null,
            null
        );

        expect(res.statusCode).toBe(429);
        expect(JSON.parse(res.body).error).toMatchObject({
            type: 'rate_limit_error',
            quota_scope: 'model',
            quota_key: 'gemini-3.1-flash-image',
            next_recovery_time: '2026-08-10T10:30:00.000Z'
        });
    });

    test('cools only the Antigravity image model and reroutes an edit to another account', async () => {
        const capacityBefore = runtimeImageCapacity.snapshot();
        const quotaError = new Error('Antigravity quota exhausted');
        quotaError.imageProviderRetryable = true;
        quotaError.response = {
            status: 429,
            data: [{ error: { details: [{ metadata: { model: 'gemini-3.1-flash-image', quotaResetDelay: '30s' } }] } }]
        };
        const firstGenerate = jest.fn().mockRejectedValueOnce(quotaError);
        const secondGenerate = jest.fn().mockResolvedValueOnce({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'recovered-image' } }] } }]
        });
        getApiServiceWithFallback
            .mockResolvedValueOnce({ service: { generateContent: firstGenerate }, actualProviderType: 'gemini-antigravity', uuid: 'ag-a' })
            .mockResolvedValueOnce({ service: { generateContent: secondGenerate }, actualProviderType: 'gemini-antigravity', uuid: 'ag-b' });
        const providerPoolManager = makeProviderPoolManager();
        const req = makeMultipartRequest([
            { name: 'model', value: 'gemini-3.1-flash-image' },
            { name: 'prompt', value: 'edit this image' },
            { name: 'image', file: true, filename: 'first.png', contentType: 'image/png', value: 'first-image' }
        ]);
        const res = makeResponse();
        const config = {
            MODEL_PROVIDER: 'gemini-antigravity',
            REQUEST_MAX_RETRIES: 1,
            RATE_LIMIT_COOLDOWN_ENABLED: true,
            RATE_LIMIT_COOLDOWN_MS: 30000,
            providerPools: { 'gemini-antigravity': [{ uuid: 'ag-a' }, { uuid: 'ag-b' }] }
        };

        await handleAPIRequests('POST', '/v1/images/edits', req, res, config, null, providerPoolManager, null);

        expect(res.statusCode).toBe(200);
        expect(providerPoolManager.markAntigravityModelQuotaUnhealthy).toHaveBeenCalledWith(
            'gemini-antigravity',
            { uuid: 'ag-a' },
            'gemini-3.1-flash-image',
            '429 Too Many Requests - model cooldown',
            expect.any(Date)
        );
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(getApiServiceWithFallback).toHaveBeenNthCalledWith(2, expect.anything(), 'gemini-3.1-flash-image', expect.objectContaining({
            excludeProviderUuids: ['ag-a']
        }));
        expect(secondGenerate).toHaveBeenCalledTimes(1);
        expect(runtimeImageCapacity.snapshot()).toMatchObject({
            activeBytes: capacityBefore.activeBytes,
            queued: capacityBefore.queued
        });
    });

    test('preserves the original Antigravity model 429 when retry selection has no alternative account', async () => {
        jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-11T06:00:00Z'));
        const quotaError = new Error('Antigravity quota exhausted');
        quotaError.imageProviderRetryable = true;
        quotaError.response = {
            status: 429,
            data: [{ error: { details: [{ metadata: {
                model: 'gemini-3.1-flash-image',
                quotaResetTimeStamp: '2026-08-11T06:28:29Z'
            } }] } }]
        };
        const firstGenerate = jest.fn().mockRejectedValueOnce(quotaError);
        getApiServiceWithFallback
            .mockResolvedValueOnce({ service: { generateContent: firstGenerate }, actualProviderType: 'gemini-antigravity', uuid: 'ag-only' })
            .mockRejectedValueOnce(new Error('No healthy provider found in pool'));
        const providerPoolManager = makeProviderPoolManager();
        const req = makeJsonRequest({
            model: 'gemini-3.1-flash-image',
            prompt: 'draw a blue circle'
        });
        const res = makeResponse();

        await handleAPIRequests('POST', '/v1/images/generations', req, res, {
            MODEL_PROVIDER: 'gemini-antigravity',
            REQUEST_MAX_RETRIES: 1,
            RATE_LIMIT_COOLDOWN_MS: 30000,
            providerPools: { 'gemini-antigravity': [{ uuid: 'ag-only' }] }
        }, null, providerPoolManager, null);

        expect(res.statusCode).toBe(429);
        expect(JSON.parse(res.body).error).toMatchObject({
            type: 'rate_limit_error',
            quota_scope: 'model',
            quota_key: 'gemini-3.1-flash-image',
            next_recovery_time: '2026-08-11T06:28:29.000Z'
        });
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
    });

    test.each([
        ['an aborted upstream response stream', makeStreamAbortedError()],
        ['an upstream connection reset before response headers', makeUpstreamResetError()],
        ['an ECONNRESET socket hang up', makeSocketHangUpError()],
        ['a socket hang up without an error code', makeSocketHangUpError({ withCode: false })]
    ])('reroutes %s to another image account without marking the first unhealthy', async (_label, transientError) => {
        const firstGenerate = jest.fn().mockRejectedValueOnce(transientError);
        const secondGenerate = jest.fn().mockResolvedValueOnce(makeImageResponse('retried-image'));
        getApiServiceWithFallback
            .mockResolvedValueOnce({
                service: { generateContent: firstGenerate },
                actualProviderType: 'openai-codex-oauth',
                uuid: 'codex-a'
            })
            .mockResolvedValueOnce({
                service: { generateContent: secondGenerate },
                actualProviderType: 'openai-codex-oauth',
                uuid: 'codex-b'
            });
        const providerPoolManager = makeProviderPoolManager();
        const req = makeMultipartRequest([
            { name: 'model', value: 'gpt-image-2' },
            { name: 'prompt', value: 'edit this image' },
            { name: 'image', file: true, filename: 'first.png', contentType: 'image/png', value: 'first-image' }
        ]);
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/edits',
            req,
            res,
            {
                MODEL_PROVIDER: 'openai-codex-oauth',
                REQUEST_MAX_RETRIES: 2,
                providerPools: { 'openai-codex-oauth': [{ uuid: 'codex-a' }, { uuid: 'codex-b' }] }
            },
            null,
            providerPoolManager,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(firstGenerate).toHaveBeenCalledTimes(1);
        expect(secondGenerate).toHaveBeenCalledTimes(1);
        expect(getApiServiceWithFallback).toHaveBeenNthCalledWith(
            2,
            expect.anything(),
            'gpt-image-2',
            expect.objectContaining({ excludeProviderUuids: ['codex-a'] })
        );
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
    });

    test('returns 502 after socket hang up retries are exhausted for image edits', async () => {
        const firstGenerate = jest.fn().mockRejectedValueOnce(makeSocketHangUpError());
        const secondGenerate = jest.fn().mockRejectedValueOnce(makeSocketHangUpError());
        getApiServiceWithFallback
            .mockResolvedValueOnce({ service: { generateContent: firstGenerate }, actualProviderType: 'openai-codex-oauth', uuid: 'codex-a' })
            .mockResolvedValueOnce({ service: { generateContent: secondGenerate }, actualProviderType: 'openai-codex-oauth', uuid: 'codex-b' });
        const providerPoolManager = makeProviderPoolManager();
        const req = makeMultipartRequest([
            { name: 'model', value: 'gpt-image-2' },
            { name: 'prompt', value: 'edit this image' },
            { name: 'image', file: true, filename: 'first.png', contentType: 'image/png', value: 'first-image' }
        ]);
        const res = makeResponse();

        await handleAPIRequests('POST', '/v1/images/edits', req, res, {
            MODEL_PROVIDER: 'openai-codex-oauth',
            REQUEST_MAX_RETRIES: 1,
            providerPools: { 'openai-codex-oauth': [{ uuid: 'codex-a' }, { uuid: 'codex-b' }] }
        }, null, providerPoolManager, null);

        expect(firstGenerate).toHaveBeenCalledTimes(1);
        expect(secondGenerate).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(502);
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
    });

    test('reroutes an explicit image safety rejection without marking the first account unhealthy', async () => {
        const firstGenerate = jest.fn().mockResolvedValueOnce(makeSafetyRejectionResponse());
        const secondGenerate = jest.fn().mockResolvedValueOnce(makeImageResponse('recovered-image'));
        getApiServiceWithFallback
            .mockResolvedValueOnce({
                service: { generateContent: firstGenerate },
                actualProviderType: 'openai-codex-oauth',
                uuid: 'codex-a'
            })
            .mockResolvedValueOnce({
                service: { generateContent: secondGenerate },
                actualProviderType: 'openai-codex-oauth',
                uuid: 'codex-b'
            });
        const providerPoolManager = makeProviderPoolManager();
        const req = makeMultipartRequest([
            { name: 'model', value: 'gpt-image-2' },
            { name: 'prompt', value: 'create the shower scene' },
            { name: 'image', file: true, filename: 'first.png', contentType: 'image/png', value: 'first-image' }
        ]);
        const res = makeResponse();

        await handleAPIRequests(
            'POST',
            '/v1/images/edits',
            req,
            res,
            {
                MODEL_PROVIDER: 'openai-codex-oauth',
                REQUEST_MAX_RETRIES: 2,
                providerPools: { 'openai-codex-oauth': [{ uuid: 'codex-a' }, { uuid: 'codex-b' }] }
            },
            null,
            providerPoolManager,
            null
        );

        expect(res.statusCode).toBe(200);
        expect(firstGenerate).toHaveBeenCalledTimes(1);
        expect(secondGenerate).toHaveBeenCalledTimes(1);
        expect(getApiServiceWithFallback).toHaveBeenNthCalledWith(
            2,
            expect.anything(),
            'gpt-image-2',
            expect.objectContaining({ excludeProviderUuids: ['codex-a'] })
        );
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
    });

    test('routes image edits with image round robin enabled by default', async () => {
        const req = makeMultipartRequest([
            { name: 'model', value: 'gpt-image-2' },
            { name: 'prompt', value: 'edit this image' },
            { name: 'image', file: true, filename: 'input.png', contentType: 'image/png', value: 'image-data' }
        ]);
        const res = makeResponse();

        await handleAPIRequests(
            'POST',
            '/v1/images/edits',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth' },
            null,
            null,
            null
        );

        expect(getApiServiceWithFallback).toHaveBeenCalledWith(
            expect.anything(),
            'gpt-image-2',
            expect.objectContaining({ routingStrategy: 'image-round-robin' })
        );
    });

    test('adds an aspect constraint and normalizes a Codex edit result to the requested size', async () => {
        mockGenerateContent.mockResolvedValueOnce(makeImageResponse(await makePngBase64(125, 125)));
        const req = makeMultipartRequest([
            { name: 'model', value: 'gpt-image-2' },
            { name: 'prompt', value: '保留帽子主体并优化光线' },
            { name: 'size', value: '100x100' },
            { name: 'include_processing_metadata', value: 'true' },
            { name: 'image', file: true, filename: 'input.png', contentType: 'image/png', value: 'image-data' }
        ]);
        const res = makeResponse();

        await handleAPIRequests(
            'POST',
            '/v1/images/edits',
            req,
            res,
            {
                MODEL_PROVIDER: 'openai-codex-oauth',
                IMAGE_SIZE_NORMALIZATION_ENABLED: true,
                IMAGE_PROMPT_ASPECT_CONSTRAINT_ENABLED: true
            },
            null,
            null,
            null
        );

        expect(res.statusCode).toBe(200);
        const [, requestBody] = mockGenerateContent.mock.calls[0];
        expect(requestBody.input[0].content[0].text).toContain('[ASPECT RATIO] Strict 1:1');

        const payload = JSON.parse(res.body);
        const metadata = await sharp(Buffer.from(payload.data[0].b64_json, 'base64')).metadata();
        expect([metadata.width, metadata.height]).toEqual([100, 100]);
        expect(payload.x_aiclient2api.image_processing.images[0]).toEqual(expect.objectContaining({
            source_size: '125x125',
            final_size: '100x100',
            scale_operation: 'downscale'
        }));
    });
});

describe('/v1/images/generations request handling', () => {
    beforeEach(() => {
        mockGenerateContent.mockReset();
        getApiServiceWithFallback.mockReset();
        getApiServiceWithFallback.mockResolvedValue({
            service: { generateContent: mockGenerateContent },
            actualProviderType: 'openai-codex-oauth'
        });
        logger.info.mockClear();
        logger.warn.mockClear();
        logger.error.mockClear();
        logger.debug.mockClear();
        mockGenerateContent.mockResolvedValue({
            response: {
                output: [{
                    type: 'image_generation_call',
                    result: 'generated-image-b64',
                    output_format: 'png'
                }]
            }
        });
    });

    test.each([
        ['gpt-image-2.5', 'high'],
        ['gpt-image-2.5-flare', 'xhigh'],
        ['gpt-image-2.5-sunburst', 'max'],
        ['gpt-image-2.5-flare-2026-09-08', 'auto']
    ])('accepts %s generation requests with quality %s', async (model, quality) => {
        const req = makeJsonRequest({
            model,
            prompt: 'draw one green circle',
            size: '1024x1024',
            quality,
            n: 1,
            response_format: 'b64_json'
        });
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth', IMAGE_SIZE_NORMALIZATION_ENABLED: false },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        expect(requestBody.model).toBe(model);
        expect(requestBody._imageQuality).toBe(quality);
        expect(requestBody._imageToolOptions).toEqual(expect.objectContaining({
            size: '1024x1024',
            quality
        }));
    });

    test.each(['gpt-image-2.5-fast', 'gpt-image-2.5-ultrafast', 'gpt-image-2.5-2026-09-08', 'gpt-image-unknown'])('rejects unsupported image model %s', async model => {
        const req = makeJsonRequest({
            model,
            prompt: 'draw one green circle',
            n: 1,
            response_format: 'b64_json'
        });
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth' },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error.message).toContain(`model '${model}' is not supported`);
        expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    test('preserves requested image quality for gpt-image-2 generation requests', async () => {
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw one green circle',
            size: '1024x1024',
            quality: 'medium',
            n: 1,
            response_format: 'b64_json'
        });
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth', IMAGE_SIZE_NORMALIZATION_ENABLED: false },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        expect(requestBody._imageQuality).toBe('medium');
    });

    test('preserves image tool options for gpt-image-2 generation requests', async () => {
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw one green circle',
            size: '1024x1024',
            quality: 'high',
            background: 'transparent',
            output_format: 'webp',
            moderation: 'auto',
            output_compression: 80,
            partial_images: 2,
            n: 1,
            response_format: 'b64_json'
        });
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth', IMAGE_SIZE_NORMALIZATION_ENABLED: false },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        expect(requestBody._imageToolOptions).toEqual({
            size: '1024x1024',
            quality: 'high',
            background: 'transparent',
            output_format: 'webp',
            moderation: 'auto',
            output_compression: 80,
            partial_images: 2
        });
    });

    test('does not forward deprecated top-level image_config to the Gemini image request', async () => {
        getApiServiceWithFallback.mockResolvedValueOnce({
            service: { generateContent: mockGenerateContent },
            actualProviderType: 'gemini-antigravity'
        });
        mockGenerateContent.mockResolvedValueOnce({
            candidates: [{
                content: {
                    parts: [{ inlineData: { mimeType: 'image/png', data: 'generated-image-b64' } }]
                }
            }]
        });
        const req = makeJsonRequest({
            model: 'gemini-3.1-flash-image',
            prompt: 'draw a wide yellow banana',
            image_config: { aspect_ratio: '3:2', image_size: '2K' },
            n: 1,
            response_format: 'b64_json'
        });
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            { MODEL_PROVIDER: 'gemini-antigravity' },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        const [, requestBody] = mockGenerateContent.mock.calls[0];
        expect(requestBody.generationConfig?.imageConfig).toBeUndefined();
        expect(requestBody.size).toBeUndefined();
    });

    test('uses configured request body limit for large image generation requests', async () => {
        const largePrompt = 'x'.repeat(10 * 1024 * 1024);
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: largePrompt,
            n: 1,
            response_format: 'b64_json'
        });
        const res = makeResponse();

        const handled = await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth', REQUEST_BODY_MAX_BYTES: 12 * 1024 * 1024 },
            null,
            null,
            null
        );

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        expect(requestBody.input[0].content[0].text).toBe(largePrompt);
    });

    test('retries one fast overload and returns the recovered generation result', async () => {
        const capacityBefore = runtimeImageCapacity.snapshot();
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
        mockGenerateContent
            .mockRejectedValueOnce(makeOverloadError())
            .mockResolvedValueOnce(makeImageResponse('recovered-image'));
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw one green circle',
            n: 1,
            response_format: 'b64_json'
        });
        const res = makeResponse();

        try {
            const handled = await handleAPIRequests(
                'POST',
                '/v1/images/generations',
                req,
                res,
                { MODEL_PROVIDER: 'openai-codex-oauth' },
                null,
                null,
                null
            );
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(mockGenerateContent).toHaveBeenCalledTimes(2);
            expect(JSON.parse(res.body).data[0].b64_json).toBe('recovered-image');
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[Image Generation] internal overload retry 1/1'));
            expect(logger.warn.mock.calls.map(([message]) => message).join('\n')).not.toContain('Image Generation Audit');
            expect(runtimeImageCapacity.snapshot()).toMatchObject({
                activeBytes: capacityBefore.activeBytes,
                queued: capacityBefore.queued
            });
        } finally {
            randomSpy.mockRestore();
        }
    });

    test('stops after the single internal overload retry', async () => {
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
        mockGenerateContent.mockRejectedValue(makeOverloadError());
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw one green circle',
            n: 1,
            response_format: 'b64_json'
        });
        const res = makeResponse();

        try {
            await handleAPIRequests(
                'POST',
                '/v1/images/generations',
                req,
                res,
                { MODEL_PROVIDER: 'openai-codex-oauth' },
                null,
                null,
                null
            );
            expect(mockGenerateContent).toHaveBeenCalledTimes(2);
            expect(res.statusCode).toBe(500);
        } finally {
            randomSpy.mockRestore();
        }
    });

    test.each([
        ['an aborted upstream response stream', makeStreamAbortedError()],
        ['an upstream connection reset before response headers', makeUpstreamResetError()],
        ['an ECONNRESET socket hang up', makeSocketHangUpError()],
        ['a socket hang up without an error code', makeSocketHangUpError({ withCode: false })]
    ])('reroutes %s for image generation without marking the first account unhealthy', async (_label, transientError) => {
        const capacityBefore = runtimeImageCapacity.snapshot();
        const firstGenerate = jest.fn().mockRejectedValueOnce(transientError);
        const secondGenerate = jest.fn().mockResolvedValueOnce(makeImageResponse('retried-generation'));
        getApiServiceWithFallback
            .mockResolvedValueOnce({
                service: { generateContent: firstGenerate },
                actualProviderType: 'openai-codex-oauth',
                uuid: 'codex-a'
            })
            .mockResolvedValueOnce({
                service: { generateContent: secondGenerate },
                actualProviderType: 'openai-codex-oauth',
                uuid: 'codex-b'
            });
        const providerPoolManager = makeProviderPoolManager();
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw one green circle',
            n: 1,
            response_format: 'b64_json'
        });
        const res = makeResponse();

        await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            {
                MODEL_PROVIDER: 'openai-codex-oauth',
                REQUEST_MAX_RETRIES: 2,
                providerPools: { 'openai-codex-oauth': [{ uuid: 'codex-a' }, { uuid: 'codex-b' }] }
            },
            null,
            providerPoolManager,
            null
        );

        expect(res.statusCode).toBe(200);
        expect(firstGenerate).toHaveBeenCalledTimes(1);
        expect(secondGenerate).toHaveBeenCalledTimes(1);
        expect(getApiServiceWithFallback).toHaveBeenNthCalledWith(
            2,
            expect.anything(),
            'gpt-image-2',
            expect.objectContaining({ excludeProviderUuids: ['codex-a'] })
        );
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
        expect(runtimeImageCapacity.snapshot()).toMatchObject({
            activeBytes: capacityBefore.activeBytes,
            queued: capacityBefore.queued
        });
    });

    test('returns 502 after socket hang up retries are exhausted for image generation', async () => {
        const firstGenerate = jest.fn().mockRejectedValueOnce(makeSocketHangUpError());
        const secondGenerate = jest.fn().mockRejectedValueOnce(makeSocketHangUpError());
        getApiServiceWithFallback
            .mockResolvedValueOnce({ service: { generateContent: firstGenerate }, actualProviderType: 'openai-codex-oauth', uuid: 'codex-a' })
            .mockResolvedValueOnce({ service: { generateContent: secondGenerate }, actualProviderType: 'openai-codex-oauth', uuid: 'codex-b' });
        const providerPoolManager = makeProviderPoolManager();
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw one green circle',
            response_format: 'b64_json'
        });
        const res = makeResponse();

        await handleAPIRequests('POST', '/v1/images/generations', req, res, {
            MODEL_PROVIDER: 'openai-codex-oauth',
            REQUEST_MAX_RETRIES: 1,
            providerPools: { 'openai-codex-oauth': [{ uuid: 'codex-a' }, { uuid: 'codex-b' }] }
        }, null, providerPoolManager, null);

        expect(firstGenerate).toHaveBeenCalledTimes(1);
        expect(secondGenerate).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(502);
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(providerPoolManager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
    });

    test('reroutes an explicit image generation safety rejection without marking the first account unhealthy', async () => {
        const firstGenerate = jest.fn().mockResolvedValueOnce(makeSafetyRejectionResponse());
        const secondGenerate = jest.fn().mockResolvedValueOnce(makeImageResponse('recovered-generation'));
        getApiServiceWithFallback
            .mockResolvedValueOnce({
                service: { generateContent: firstGenerate },
                actualProviderType: 'openai-codex-oauth',
                uuid: 'codex-a'
            })
            .mockResolvedValueOnce({
                service: { generateContent: secondGenerate },
                actualProviderType: 'openai-codex-oauth',
                uuid: 'codex-b'
            });
        const providerPoolManager = makeProviderPoolManager();
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'create the shower scene',
            n: 1,
            response_format: 'b64_json'
        });
        const res = makeResponse();

        await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            {
                MODEL_PROVIDER: 'openai-codex-oauth',
                REQUEST_MAX_RETRIES: 2,
                providerPools: { 'openai-codex-oauth': [{ uuid: 'codex-a' }, { uuid: 'codex-b' }] }
            },
            null,
            providerPoolManager,
            null
        );

        expect(res.statusCode).toBe(200);
        expect(firstGenerate).toHaveBeenCalledTimes(1);
        expect(secondGenerate).toHaveBeenCalledTimes(1);
        expect(getApiServiceWithFallback).toHaveBeenNthCalledWith(
            2,
            expect.anything(),
            'gpt-image-2',
            expect.objectContaining({ excludeProviderUuids: ['codex-a'] })
        );
        expect(providerPoolManager.markProviderUnhealthy).not.toHaveBeenCalled();
    });

    test('routes image generations with image round robin enabled by default', async () => {
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw one green circle'
        });
        const res = makeResponse();

        await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth', IMAGE_SIZE_NORMALIZATION_ENABLED: false },
            null,
            null,
            null
        );

        expect(getApiServiceWithFallback).toHaveBeenCalledWith(
            expect.anything(),
            'gpt-image-2',
            expect.objectContaining({ routingStrategy: 'image-round-robin' })
        );
    });

    test('keeps legacy image routing when image round robin is disabled', async () => {
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw one green circle'
        });
        const res = makeResponse();

        await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            {
                MODEL_PROVIDER: 'openai-codex-oauth',
                IMAGE_PROVIDER_ROUND_ROBIN_ENABLED: false
            },
            null,
            null,
            null
        );

        const [, , options] = getApiServiceWithFallback.mock.calls.at(-1);
        expect(options).not.toHaveProperty('routingStrategy');
    });

    test('adds an aspect constraint and returns exact pixels with processing metadata', async () => {
        mockGenerateContent.mockResolvedValueOnce(makeImageResponse(await makePngBase64(125, 125)));
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw one green circle',
            size: '100x100',
            include_processing_metadata: true,
            response_format: 'b64_json'
        });
        const res = makeResponse();

        await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            {
                MODEL_PROVIDER: 'openai-codex-oauth',
                IMAGE_SIZE_NORMALIZATION_ENABLED: true,
                IMAGE_PROMPT_ASPECT_CONSTRAINT_ENABLED: true
            },
            null,
            null,
            null
        );

        expect(res.statusCode).toBe(200);
        expect(res.headers).toEqual(expect.objectContaining({
            'X-AIClient-Image-Adjusted': 'true',
            'X-AIClient-Image-Upscaled': 'false',
            'X-AIClient-Image-Requested-Size': '100x100',
            'X-AIClient-Image-Source-Size': '125x125',
            'X-AIClient-Image-Final-Size': '100x100'
        }));

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        expect(requestBody.input[0].content[0].text).toContain('[ASPECT RATIO] Strict 1:1');
        expect(requestBody.input[0].content[0].text).not.toContain('100x100');

        const payload = JSON.parse(res.body);
        const output = Buffer.from(payload.data[0].b64_json, 'base64');
        const metadata = await sharp(output).metadata();
        expect([metadata.width, metadata.height]).toEqual([100, 100]);
        expect(payload.x_aiclient2api.image_processing).toEqual(expect.objectContaining({
            requested_size: '100x100',
            allowed_aspect_deviation: 0.1,
            prompt_constraint_applied: true
        }));
        expect(payload.x_aiclient2api.image_processing.images[0]).toEqual(expect.objectContaining({
            source_size: '125x125',
            final_size: '100x100',
            size_adjusted: true,
            upscaled: false,
            scale_operation: 'downscale'
        }));
    });

    test('returns a structured Chinese 422 when the aspect mismatch exceeds the threshold', async () => {
        mockGenerateContent.mockResolvedValueOnce(makeImageResponse(await makePngBase64(200, 80)));
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw a landscape',
            size: '120x80',
            response_format: 'b64_json'
        });
        const res = makeResponse();

        await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            {
                MODEL_PROVIDER: 'openai-codex-oauth',
                IMAGE_SIZE_NORMALIZATION_ENABLED: true,
                IMAGE_ASPECT_MISMATCH_THRESHOLD: 0.10
            },
            null,
            null,
            null
        );

        expect(res.statusCode).toBe(422);
        expect(JSON.parse(res.body)).toEqual({
            error: expect.objectContaining({
                type: 'image_aspect_ratio_mismatch',
                message: '生成图片的长宽比与请求尺寸差异过大，已停止缩放以避免图片明显变形。',
                requested_size: '120x80',
                source_size: '200x80',
                allowed_deviation: 0.1,
                image_index: 0
            })
        });
    });

    test('normalizes a data URL response and preserves the requested response shape', async () => {
        mockGenerateContent.mockResolvedValueOnce(makeImageResponse(await makePngBase64(125, 125)));
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw one blue square',
            size: '100x100',
            response_format: 'url'
        });
        const res = makeResponse();

        await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth' },
            null,
            null,
            null
        );

        expect(res.statusCode).toBe(200);
        const payload = JSON.parse(res.body);
        expect(payload.data[0].url).toMatch(/^data:image\/png;base64,/);
        const output = Buffer.from(payload.data[0].url.split(',')[1], 'base64');
        const metadata = await sharp(output).metadata();
        expect([metadata.width, metadata.height]).toEqual([100, 100]);
    });

    test('fails an n>1 response atomically when a later image has an extreme mismatch', async () => {
        mockGenerateContent
            .mockResolvedValueOnce(makeImageResponse(await makePngBase64(125, 125)))
            .mockResolvedValueOnce(makeImageResponse(await makePngBase64(200, 80)));
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw two square icons',
            size: '100x100',
            n: 2,
            response_format: 'b64_json'
        });
        const res = makeResponse();

        await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            { MODEL_PROVIDER: 'openai-codex-oauth', IMAGE_ASPECT_MISMATCH_THRESHOLD: 0.10 },
            null,
            null,
            null
        );

        expect(res.statusCode).toBe(422);
        expect(JSON.parse(res.body).error).toEqual(expect.objectContaining({
            type: 'image_aspect_ratio_mismatch',
            image_index: 1
        }));
    });

    test('does not append an aspect hint when prompt constraints are disabled', async () => {
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw one green circle',
            size: '100x100'
        });
        const res = makeResponse();

        await handleAPIRequests(
            'POST',
            '/v1/images/generations',
            req,
            res,
            {
                MODEL_PROVIDER: 'openai-codex-oauth',
                IMAGE_SIZE_NORMALIZATION_ENABLED: false,
                IMAGE_PROMPT_ASPECT_CONSTRAINT_ENABLED: false
            },
            null,
            null,
            null
        );

        const [, requestBody] = mockGenerateContent.mock.calls[0];
        expect(requestBody.input[0].content[0].text).toBe('draw one green circle');
    });

    test('does not leak a Codex aspect hint when retry falls back to Gemini', async () => {
        const codexGenerate = jest.fn(async () => {
            throw Object.assign(new Error('switch provider'), { credentialMarkedUnhealthy: true });
        });
        const geminiGenerate = jest.fn(async () => ({
            candidates: [{
                content: {
                    parts: [{ inlineData: { mimeType: 'image/png', data: 'generated-image-b64' } }]
                }
            }]
        }));
        getApiServiceWithFallback
            .mockResolvedValueOnce({
                service: { generateContent: codexGenerate },
                actualProviderType: 'openai-codex-oauth',
                uuid: 'codex-a'
            })
            .mockResolvedValueOnce({
                service: { generateContent: geminiGenerate },
                actualProviderType: 'gemini-antigravity',
                uuid: 'gemini-b'
            });
        const providerPoolManager = {
            releaseSlot: jest.fn(),
            markProviderUnhealthy: jest.fn()
        };
        const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
        const req = makeJsonRequest({
            model: 'gpt-image-2',
            prompt: 'draw one green circle',
            size: '100x100',
            response_format: 'b64_json'
        });
        const res = makeResponse();

        try {
            await handleAPIRequests(
                'POST',
                '/v1/images/generations',
                req,
                res,
                {
                    MODEL_PROVIDER: 'openai-codex-oauth',
                    providerPools: {},
                    IMAGE_SIZE_NORMALIZATION_ENABLED: false
                },
                null,
                providerPoolManager,
                null
            );

            expect(res.statusCode).toBe(200);
            const [, geminiBody] = geminiGenerate.mock.calls[0];
            expect(JSON.stringify(geminiBody)).not.toContain('[ASPECT RATIO]');
            expect(geminiBody).not.toHaveProperty('_imagePromptConstraintApplied');
        } finally {
            randomSpy.mockRestore();
        }
    });
});

describe('OpenAI and Gemini content image routing', () => {
    beforeEach(() => {
        mockGenerateContent.mockReset();
        mockGenerateContent.mockResolvedValue(makeImageResponse());
        getApiServiceWithFallback.mockClear();
    });

    test('routes OpenAI Responses image-generation tools with image round robin', async () => {
        const req = makeJsonRequest({
            model: 'gpt-5.5',
            input: 'draw one green circle',
            tools: [{ type: 'image_generation' }]
        });
        const res = makeResponse();

        try {
            await handleAPIRequests(
                'POST',
                '/v1/responses',
                req,
                res,
                {
                    MODEL_PROVIDER: 'openai-codex-oauth',
                    providerPools: { 'openai-codex-oauth': [{}] }
                },
                null,
                {},
                null
            );
        } catch {
            // The routing assertion is independent of downstream response conversion.
        }

        expect(getApiServiceWithFallback).toHaveBeenCalledWith(
            expect.anything(),
            'gpt-5.5',
            expect.objectContaining({
                acquireSlot: true,
                routingStrategy: 'image-round-robin'
            })
        );
    });

    test('routes Gemini IMAGE modality requests with image round robin', async () => {
        const requestPath = '/v1beta/models/gemini-3.1-flash-image:generateContent';
        const req = makeJsonRequest({
            contents: [{ role: 'user', parts: [{ text: 'draw one green circle' }] }],
            generationConfig: { responseModalities: ['IMAGE'] }
        });
        req.url = requestPath;
        const res = makeResponse();

        try {
            await handleAPIRequests(
                'POST',
                requestPath,
                req,
                res,
                {
                    MODEL_PROVIDER: 'gemini-antigravity',
                    providerPools: { 'gemini-antigravity': [{}] }
                },
                null,
                {},
                null
            );
        } catch {
            // The routing assertion is independent of downstream response conversion.
        }

        expect(getApiServiceWithFallback).toHaveBeenCalledWith(
            expect.anything(),
            'gemini-3.1-flash-image',
            expect.objectContaining({
                acquireSlot: true,
                routingStrategy: 'image-round-robin'
            })
        );
    });
});
