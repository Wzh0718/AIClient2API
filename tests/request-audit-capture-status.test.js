import { captureStatus } from '../src/plugins/request-audit/capture-status.js';
import { buildRequestAuditEvent } from '../src/plugins/request-audit/audit-event.js';

const codexSuccess = {
    request: { path: '/openai-codex-oauth/v1/responses', toProvider: 'openai-codex-oauth', requestedModel: 'gpt-6-luna' },
    account: { accountEmail: 'owner@example.com' },
    usage: { totalTokens: 12 },
    status: { outcome: 'success', httpStatus: 200 }
};

describe('Codex audit capture status', () => {
    test('requires actual identity, request model and usage for a successful text request', () => {
        expect(captureStatus(codexSuccess)).toEqual({ status: 'complete', missingFields: [] });
        expect(captureStatus({
            ...codexSuccess,
            request: { ...codexSuccess.request, requestedModel: 'unknown' },
            account: {},
            usage: { totalTokens: 0 }
        })).toEqual({ status: 'failed', missingFields: ['accountEmail', 'requestedModel', 'usage'] });
    });

    test('does not require usage for rejected or unrelated requests', () => {
        expect(captureStatus({ ...codexSuccess, status: { outcome: 'http_error', httpStatus: 429 }, usage: {} }).status).toBe('complete');
        expect(captureStatus({ ...codexSuccess, request: { path: '/gemini-antigravity/v1/chat/completions', toProvider: 'gemini-antigravity' }, usage: {} }).status).toBe('complete');
    });

    test('new audit events carry capture status without changing request outcome', () => {
        const event = buildRequestAuditEvent({
            requestId: 'capture-missing',
            path: '/openai-codex-oauth/v1/responses',
            toProvider: 'openai-codex-oauth',
            response: { httpStatus: 200, completed: true }
        });
        expect(event.status.outcome).toBe('success');
        expect(event.capture.status).toBe('failed');
    });
});
