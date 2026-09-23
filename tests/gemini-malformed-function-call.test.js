import { EventEmitter } from 'node:events';
import { afterEach, expect, jest, test } from '@jest/globals';

const mockGetApiServiceWithFallback = jest.fn();
jest.mock('../src/services/service-manager.js', () => ({
    getApiServiceWithFallback: mockGetApiServiceWithFallback
}));

import { GeminiStrategy } from '../src/providers/gemini/gemini-strategy.js';
import { handleStreamRequest, handleUnaryRequest } from '../src/utils/common.js';
import requestContext from '../src/utils/context.js';

const model = 'gemini-3.1-flash-lite';
const malformed = { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] };
const successful = { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] };

class FakeResponse extends EventEmitter {
    constructor() {
        super();
        this.body = '';
        this.writableEnded = false;
        this.headersSent = false;
    }
    writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
        this.headersSent = true;
    }
    write(chunk) {
        this.body += String(chunk);
        return true;
    }
    end(chunk = '') {
        this.body += String(chunk);
        this.writableEnded = true;
    }
}

function manager() {
    return {
        markProviderUnhealthy: jest.fn(),
        markProviderHealthy: jest.fn(),
        recordGeminiSchedulingEvent: jest.fn(),
        releaseSlot: jest.fn()
    };
}

function route(service, uuid) {
    return { service, uuid, actualModel: model, actualProviderType: 'gemini-antigravity', serviceConfig: {} };
}

function runUnary(service, res, pool, audit, retryContext = {}) {
    return requestContext.run({ requestId: 'malformed-unary', requestAudit: audit }, () => handleUnaryRequest(
        res, service, model, { contents: [] }, 'gemini', 'gemini-antigravity',
        'none', null, pool, 'credential-1', 'Gemini 1',
        { CONFIG: { MAX_UPSTREAM_ATTEMPTS_PER_REQUEST: 10 }, maxRetries: 5, ...retryContext }
    ));
}

function runStream(service, res, pool, audit, retryContext = {}, fromProvider = 'gemini') {
    return requestContext.run({ requestId: 'malformed-stream', requestAudit: audit }, () => handleStreamRequest(
        res, service, model, { contents: [] }, fromProvider, 'gemini-antigravity',
        'none', null, pool, 'credential-1', 'Gemini 1',
        { CONFIG: { MAX_UPSTREAM_ATTEMPTS_PER_REQUEST: 10 }, maxRetries: 5, ...retryContext }
    ));
}

afterEach(() => {
    mockGetApiServiceWithFallback.mockReset();
});

test('recognizes native and wrapped malformed function call failures', () => {
    const strategy = new GeminiStrategy();
    expect(strategy.classifyResponseFailure(malformed)).toEqual({ code: 'MALFORMED_FUNCTION_CALL' });
    expect(strategy.classifyResponseFailure({ response: malformed })).toEqual({ code: 'MALFORMED_FUNCTION_CALL' });
    expect(strategy.classifyResponseFailure(successful)).toBeNull();
});

test('retries a unary malformed response with another credential before reporting success', async () => {
    const first = { generateContent: jest.fn().mockResolvedValue(malformed) };
    const second = { generateContent: jest.fn().mockResolvedValue(successful) };
    mockGetApiServiceWithFallback.mockResolvedValueOnce(route(second, 'credential-2'));
    const res = new FakeResponse();
    const pool = manager();
    await runUnary(first, res, pool, {});
    expect(mockGetApiServiceWithFallback).toHaveBeenCalledWith(expect.anything(), model,
        expect.objectContaining({ excludeProviderUuids: ['credential-1'] }));
    expect(second.generateContent).toHaveBeenCalledTimes(1);
    expect(res.body).toContain('OK');
    expect(pool.markProviderUnhealthy).not.toHaveBeenCalled();
});

test('stops unary retries after two switches and records an upstream failure', async () => {
    const first = { generateContent: jest.fn().mockResolvedValue(malformed) };
    const second = { generateContent: jest.fn().mockResolvedValue(malformed) };
    const third = { generateContent: jest.fn().mockResolvedValue(malformed) };
    mockGetApiServiceWithFallback
        .mockResolvedValueOnce(route(second, 'credential-2'))
        .mockResolvedValueOnce(route(third, 'credential-3'));
    const res = new FakeResponse();
    const audit = {};
    await runUnary(first, res, manager(), audit);
    expect(mockGetApiServiceWithFallback).toHaveBeenCalledTimes(2);
    expect(res.body).toContain('"code":502');
    expect(res.body).not.toContain('"finishReason":"STOP"');
    expect(audit.terminal?.outcome).toBe('upstream_error');
});

test('retries a malformed stream before sending output', async () => {
    const first = { async *generateContentStream() { yield malformed; } };
    const second = { async *generateContentStream() { yield successful; } };
    mockGetApiServiceWithFallback.mockResolvedValueOnce(route(second, 'credential-2'));
    const res = new FakeResponse();
    await runStream(first, res, manager(), {});
    expect(mockGetApiServiceWithFallback).toHaveBeenCalledTimes(1);
    expect(res.body).toContain('OK');
    expect(res.body).not.toContain('MALFORMED_FUNCTION_CALL');
});

test('ends a partial stream as failure without retry or synthetic success', async () => {
    const service = { async *generateContentStream() {
        yield { candidates: [{ content: { parts: [{ text: 'partial' }] } }] };
        yield malformed;
    } };
    const res = new FakeResponse();
    const audit = {};
    await runStream(service, res, manager(), audit);
    expect(mockGetApiServiceWithFallback).not.toHaveBeenCalled();
    expect(res.body).toContain('partial');
    expect(res.body).toContain('"code":502');
    expect(res.body).not.toContain('"finishReason":"STOP"');
    expect(audit.terminal?.outcome).toBe('upstream_error');
});

test('uses response.failed for a terminal Responses client failure', async () => {
    const service = { async *generateContentStream() { yield malformed; } };
    const res = new FakeResponse();
    const audit = {};
    await runStream(service, res, manager(), audit, { maxRetries: 0 }, 'openaiResponses');
    expect(res.body).toContain('event: response.failed');
    expect(res.body).not.toContain('response.completed');
    expect(audit.terminal?.outcome).toBe('upstream_error');
});
