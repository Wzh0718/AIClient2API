import { describe, expect, test } from '@jest/globals';
import { CodexOverloadFailoverStore, resolveCodexOverloadFailoverKey } from '../src/providers/openai/codex-overload-failover.js';
import { createStreamErrorResponse } from '../src/utils/common.js';

describe('Codex overload cross-request failover', () => {
    test('records a soft exclusion and consumes it for the next request', () => {
        const store = new CodexOverloadFailoverStore({ ttlMs: 60_000 });

        store.recordFailure('session:abc', 'provider-a', 1_000);

        expect(store.getPendingExclusion('session:abc', 1_001)).toEqual('provider-a');
        expect(store.consumePendingExclusion('session:abc', 1_002)).toEqual('provider-a');
        expect(store.getPendingExclusion('session:abc', 1_003)).toBeNull();
    });

    test('can clear one session without affecting another session', () => {
        const store = new CodexOverloadFailoverStore({ ttlMs: 60_000 });

        store.recordFailure('session:abc', 'provider-a', 1_000);
        store.recordFailure('session:def', 'provider-b', 1_000);
        store.clear('session:abc');

        expect(store.getPendingExclusion('session:abc', 1_001)).toBeNull();
        expect(store.getPendingExclusion('session:def', 1_001)).toBe('provider-b');
    });

    test('allows the original provider when no alternative exists', () => {
        const store = new CodexOverloadFailoverStore({ ttlMs: 60_000 });

        store.recordFailure('session:abc', 'provider-a', 1_000);

        expect(store.resolveProviderOrder(['provider-a'], 'session:abc', 1_001)).toEqual(['provider-a']);
        expect(store.resolveProviderOrder(['provider-a', 'provider-b'], 'session:abc', 1_002)).toEqual(['provider-b', 'provider-a']);
    });

    test('pins a successful alternative until expiry', () => {
        const store = new CodexOverloadFailoverStore({ ttlMs: 60_000 });

        store.recordFailure('session:abc', 'provider-a', 1_000);
        store.pinAlternative('session:abc', 'provider-b', 1_001);

        expect(store.getPinnedProvider('session:abc', 1_002)).toBe('provider-b');
        expect(store.getPinnedProvider('session:abc', 61_001)).toBeNull();
    });

    test('clears the old pin when the pinned provider overloads', () => {
        const store = new CodexOverloadFailoverStore({ ttlMs: 60_000 });

        store.pinAlternative('session:abc', 'provider-b', 1_000);
        store.recordFailure('session:abc', 'provider-b', 1_001);

        expect(store.getPinnedProvider('session:abc', 1_002)).toBeNull();
        expect(store.getPendingExclusion('session:abc', 1_002)).toBe('provider-b');
    });

    test('derives a stable key from thread or session scope', () => {
        expect(resolveCodexOverloadFailoverKey({ threadId: 'thread-1' })).toBe('thread:thread-1');
        expect(resolveCodexOverloadFailoverKey({ sessionId: 'session-1' })).toBe('session:session-1');
        expect(resolveCodexOverloadFailoverKey(null)).toBeNull();
    });

    test('formats overload as a Responses response.failed event', () => {
        const payload = createStreamErrorResponse({
            isCodexOverload: true,
            responseSnapshot: {
                id: 'resp_upstream',
                created_at: 123,
                model: 'gpt-5.4-mini',
                metadata: { source: 'upstream' }
            },
            response: {
                status: 503,
                data: { error: { code: 'server_is_overloaded' } }
            }
        }, 'openaiResponses');

        expect(payload).toContain('event: response.failed');
        expect(payload).toContain('server_is_overloaded');
        expect(payload).toContain('[上游 Codex] 服务当前繁忙，已自动重试可用凭证后仍不可用，请稍后重试');
        const failedEvent = JSON.parse(payload.split('\n').find(line => line.startsWith('data: ')).slice(6));
        expect(failedEvent.response).toEqual(expect.objectContaining({
            id: 'resp_upstream',
            created_at: 123,
            model: 'gpt-5.4-mini',
            metadata: { source: 'upstream' },
            object: 'response',
            status: 'failed',
            output: [],
            tools: []
        }));
    });

    test('formats upstream model capacity as a Responses response.failed event', () => {
        const payload = createStreamErrorResponse({
            isCodexModelCapacity: true,
            origin: 'upstream_codex',
            response: {
                status: 429,
                data: { error: { code: 'server_is_overloaded' } }
            }
        }, 'openaiResponses');

        expect(payload).toContain('event: response.failed');
        expect(payload).toContain('server_is_overloaded');
        expect(payload).toContain('[上游 Codex] 所选模型当前容量不足，已自动重试可用凭证后仍不可用，请稍后重试');
    });

    test('formats upstream invalid_prompt as a Responses response.failed event', () => {
        const payload = createStreamErrorResponse({
            origin: 'upstream_codex',
            message: '400 Bad Request (stream): Invalid prompt: your prompt was flagged as potentially violating our usage policy.',
            response: {
                status: 400,
                data: {
                    error: {
                        type: 'invalid_request_error',
                        code: 'invalid_prompt',
                        message: 'Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt: https://platform.openai.com/docs/guides/reasoning#advice-on-prompting',
                        param: null
                    }
                }
            },
            responseSnapshot: { id: 'resp_flagged', model: 'gpt-6-astra' }
        }, 'openaiResponses');

        expect(payload).toContain('event: response.failed');
        expect(payload).not.toContain('event: error\n');
        const failedEvent = JSON.parse(payload.split('\n').find(line => line.startsWith('data: ')).slice(6));
        expect(failedEvent).toEqual(expect.objectContaining({
            type: 'response.failed',
            response: expect.objectContaining({
                id: 'resp_flagged',
                model: 'gpt-6-astra',
                status: 'failed',
                output: [],
                error: {
                    code: 'invalid_prompt',
                    message: 'Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt: https://platform.openai.com/docs/guides/reasoning#advice-on-prompting'
                }
            })
        }));
    });

    test('formats upstream context_length_exceeded as a Responses response.failed event', () => {
        const payload = createStreamErrorResponse({
            origin: 'upstream_codex',
            message: '400 Bad Request (stream): Your input exceeds the context window of this model.',
            response: {
                status: 400,
                data: {
                    error: {
                        type: 'invalid_request_error',
                        code: 'context_length_exceeded',
                        message: 'Your input exceeds the context window of this model. Please adjust your input and try again.',
                        param: 'input'
                    }
                }
            }
        }, 'openaiResponses');

        expect(payload).toContain('event: response.failed');
        const failedEvent = JSON.parse(payload.split('\n').find(line => line.startsWith('data: ')).slice(6));
        expect(failedEvent.response.error).toEqual({
            code: 'context_length_exceeded',
            message: 'Your input exceeds the context window of this model. Please adjust your input and try again.'
        });
    });

    test('labels unclassified streaming errors as 2API internal errors', () => {
        const payload = createStreamErrorResponse(new Error('converter exploded'), 'openaiResponses');

        expect(payload).toContain('event: response.failed');
        expect(payload).toContain('[2API 内部] 服务处理请求失败，请稍后重试');
        expect(payload).not.toContain('converter exploded');
    });
});
