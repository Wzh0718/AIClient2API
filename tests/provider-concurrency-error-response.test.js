import { createErrorResponse, handleError } from '../src/utils/common.js';

jest.mock('../src/providers/adapter.js', () => ({ getServiceAdapter: jest.fn(), getRegisteredProviders: () => [], invalidateServiceAdapter: jest.fn(), serviceInstances: {} }));
jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));

describe('provider concurrency error wire format', () => {
    const error = Object.assign(new Error('All eligible providers are at concurrency capacity'), {
        status: 429, statusCode: 429, code: 'PROVIDER_CONCURRENCY_EXHAUSTED'
    });
    test.each(['openai', 'openaiResponses'])('keeps the capacity code for %s', protocol => {
        expect(createErrorResponse(error, protocol).error.code).toBe('PROVIDER_CONCURRENCY_EXHAUSTED');
    });
    test('keeps the capacity code on the generic Responses route', () => {
        const res = { writeHead: jest.fn(), end: jest.fn() };
        handleError(res, error, 'openai-codex-oauth');
        expect(res.writeHead).toHaveBeenCalledWith(429, expect.any(Object));
        expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('PROVIDER_CONCURRENCY_EXHAUSTED');
    });
    test('does not reclassify credential unavailability', () => {
        const unavailable = Object.assign(new Error('No usable provider credentials'), { status: 503, code: 'PROVIDER_CREDENTIALS_UNAVAILABLE' });
        const res = { writeHead: jest.fn(), end: jest.fn() };
        handleError(res, unavailable, 'openai-codex-oauth');
        expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
        expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe(503);
    });
});
