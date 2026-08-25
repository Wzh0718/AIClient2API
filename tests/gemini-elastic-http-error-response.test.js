import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn(),
    serviceInstances: {}
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({ broadcastEvent: jest.fn() }));

import {
    createRequestLifecycleAbortController,
    handleError
} from '../src/utils/common.js';

function createResponse() {
    return {
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        writeHead: jest.fn(),
        end: jest.fn()
    };
}

describe('Gemini elastic HTTP error metadata', () => {
    test('writes Retry-After for a queue-related 429', () => {
        const res = createResponse();

        handleError(res, {
            status: 429,
            code: 'QUEUE_WAIT_TIMEOUT',
            message: 'queue timed out',
            nextRecoveryTime: new Date(Date.now() + 5000).toISOString()
        }, 'gemini-antigravity', 'openai');

        expect(res.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
            'Content-Type': 'application/json',
            'Retry-After': expect.stringMatching(/^\d+$/)
        }));
    });

    test('uses a short Retry-After when a 429 has no recovery timestamp', () => {
        const res = createResponse();

        handleError(res, {
            status: 429,
            code: 'QUEUE_CAPACITY_EXCEEDED',
            message: 'queue full'
        }, 'gemini-antigravity', 'openai');

        expect(res.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
            'Retry-After': '1'
        }));
    });

    test('cleans request lifecycle listeners after a normal response', () => {
        const req = new EventEmitter();
        const res = new EventEmitter();
        const controller = createRequestLifecycleAbortController(req, res);

        expect(req.listenerCount('aborted')).toBe(1);
        expect(res.listenerCount('close')).toBe(1);
        res.emit('finish');

        expect(controller.signal.aborted).toBe(false);
        expect(req.listenerCount('aborted')).toBe(0);
        expect(res.listenerCount('close')).toBe(0);
        expect(res.listenerCount('finish')).toBe(0);
    });
});
