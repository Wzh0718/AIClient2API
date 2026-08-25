import { applyModelFallbackResponseHeaders, shouldPreserveFallbackResponseModel } from '../src/utils/model-fallback-response-metadata.js';

describe('model fallback response metadata', () => {
    test('exposes requested and actual model without changing the compatibility model', () => {
        const headers = {};
        const res = { setHeader: (name, value) => { headers[name] = value; } };
        const routing = {
            requestedModel: 'gemini-2.5-flash-lite',
            actualModel: 'gemini-2.5-flash',
            modelFallbackReason: 'SOURCE_MODEL_UNAVAILABLE'
        };

        applyModelFallbackResponseHeaders(res, routing);

        expect(headers).toEqual({
            'X-Requested-Model': 'gemini-2.5-flash-lite',
            'X-Actual-Model': 'gemini-2.5-flash',
            'X-Model-Fallback': 'true',
            'X-Fallback-Reason': 'SOURCE_MODEL_UNAVAILABLE'
        });
        expect(shouldPreserveFallbackResponseModel(routing)).toBe(true);
    });

    test('does not emit fallback metadata when the actual model is unchanged', () => {
        const res = { setHeader: jest.fn() };
        const routing = {
            requestedModel: 'gemini-2.5-flash-lite',
            actualModel: 'gemini-2.5-flash-lite'
        };

        applyModelFallbackResponseHeaders(res, routing);

        expect(res.setHeader).not.toHaveBeenCalled();
        expect(shouldPreserveFallbackResponseModel(routing)).toBe(false);
    });
});
