import { buildSuccessLogPayload, formatSuccessLog, shouldEmitSuccessLog } from '../src/runtime/success-log.js';
import fs from 'node:fs';

describe('compact success performance log', () => {
    test('preserves completion timing fields without sensitive payloads', () => {
        const completion = {
            requestId: 'req-1',
            statusCode: 200,
            durationMs: 1234,
            metadata: {
                requestId: 'req-1',
                providerType: 'gemini-antigravity',
                model: 'gemini-3.1-flash-lite',
                stream: false,
                apiKey: 'secret-key',
                prompt: 'do not log'
            },
            stages: {
                providerFilterMs: 12,
                redisLeaseMs: 3,
                complete: 1234
            },
            outputBytes: 456,
            backpressureMs: 7
        };

        expect(buildSuccessLogPayload(completion)).toEqual({
            event: 'request_completed',
            requestId: 'req-1',
            statusCode: 200,
            durationMs: 1234,
            providerType: 'gemini-antigravity',
            model: 'gemini-3.1-flash-lite',
            stream: false,
            outputBytes: 456,
            backpressureMs: 7,
            stages: {
                providerFilterMs: 12,
                redisLeaseMs: 3,
                complete: 1234
            }
        });
        expect(formatSuccessLog(completion, { mode: 'compact' })).toContain('"durationMs":1234');
        expect(formatSuccessLog(completion, { mode: 'compact' })).not.toContain('secret-key');
        expect(formatSuccessLog(completion, { mode: 'compact' })).not.toContain('do not log');
    });

    test('supports compact, sampled, and off emission modes', () => {
        expect(shouldEmitSuccessLog({ mode: 'compact', sampleRate: 1, random: () => 0.99 })).toBe(true);
        expect(shouldEmitSuccessLog({ mode: 'sampled', sampleRate: 0.25, random: () => 0.2 })).toBe(true);
        expect(shouldEmitSuccessLog({ mode: 'sampled', sampleRate: 0.25, random: () => 0.3 })).toBe(false);
        expect(shouldEmitSuccessLog({ mode: 'off', sampleRate: 1, random: () => 0 })).toBe(false);
    });

    test('routes high-frequency request receipt logging below INFO and emits compact completion logs', () => {
        const source = fs.readFileSync(new URL('../src/handlers/request-handler.js', import.meta.url), 'utf8');
        expect(source).toContain("logger.debug(`[Server] Received request:");
        expect(source).toContain('formatSuccessLog(completion');
    });
});
