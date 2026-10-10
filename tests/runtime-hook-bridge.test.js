import { RuntimeHookBridge } from '../src/runtime/runtime-hook-bridge.js';
import { buildRequestAuditEvent } from '../src/plugins/request-audit/audit-event.js';

describe('RuntimeHookBridge', () => {
    test('preserves request network metadata for audit events', async () => {
        const published = [];
        const bridge = new RuntimeHookBridge({
            send: jest.fn(),
            durableTransport: { publish: event => published.push(event), snapshot: () => ({}) }
        });

        await bridge.handle('onRequestCompleted', {
            requestId: 'network-metadata-request',
            REQUEST_AUDIT_NETWORK_METADATA_ENABLED: true,
            clientIp: '192.168.1.42',
            peerIp: '172.21.0.1',
            clientIpSource: 'trusted-x-real-ip'
        });

        expect(published[0].args[0]).toMatchObject({
            clientIp: '192.168.1.42',
            peerIp: '172.21.0.1',
            clientIpSource: 'trusted-x-real-ip'
        });
    });

    test('uses a stable event id for replaying the same terminal request hook', async () => {
        const published = [];
        const durableTransport = { publish: event => { published.push(event); return { streamId: `${published.length}-0` }; }, snapshot: () => ({}) };
        const bridge = new RuntimeHookBridge({ send: jest.fn(), durableTransport });
        await bridge.handle('onRequestCompleted', { requestId: 'stable-request-id' });
        await bridge.handle('onRequestCompleted', { requestId: 'stable-request-id' });
        expect(published[0].eventId).toBe(published[1].eventId);
    });
    test('uses only the durable stream when transport is configured', async () => {
        const messages = [];
        const durableTransport = {
            publish: jest.fn().mockResolvedValue({ persisted: true, streamId: '1-0' }),
            acknowledge: jest.fn().mockResolvedValue(undefined),
            snapshot: () => ({ spooled: 0, spoolBytes: 0 })
        };
        const bridge = new RuntimeHookBridge({ send: message => messages.push(message), durableTransport, maxPending: 1 });
        await bridge.handle('onRequestCompleted', { requestId: 'one' });
        await bridge.handle('onRequestCompleted', { requestId: 'two' });
        expect(bridge.snapshot()).toMatchObject({ pending: 1, dropped: 0, backpressured: 1, spooled: 0 });
        expect(durableTransport.publish).toHaveBeenCalledTimes(2);
        expect(messages).toHaveLength(0);
        bridge.retryUnacked();
        expect(messages).toHaveLength(0);
    });

    test('releases local outbound tracking when the durable transport confirms an immediate ACK', async () => {
        const durableTransport = {
            publish: jest.fn().mockResolvedValue({ persisted: true, acknowledged: true, streamId: 'local:1' }),
            acknowledge: jest.fn().mockResolvedValue(undefined),
            snapshot: () => ({ spooled: 0 })
        };
        const bridge = new RuntimeHookBridge({ send: jest.fn(), durableTransport });

        await bridge.handle('onRequestCompleted', { requestId: 'local-auto-ack' });

        expect(bridge.snapshot()).toMatchObject({ pending: 0 });
        expect(durableTransport.acknowledge).toHaveBeenCalledWith(expect.any(String));
    });

    test('does not resurrect an outbound event when its durable ACK arrives before publish resolves', async () => {
        let bridge;
        const durableTransport = {
            publish: jest.fn(async event => {
                await bridge.ack(event.eventId);
                return { persisted: true, streamId: '1-0' };
            }),
            acknowledge: jest.fn().mockResolvedValue(undefined),
            snapshot: () => ({ spooled: 0, spoolBytes: 0 })
        };
        bridge = new RuntimeHookBridge({ send: jest.fn(), durableTransport });

        await bridge.handle('onRequestCompleted', { requestId: 'fast-ack' });

        expect(bridge.snapshot()).toMatchObject({ pending: 0 });
        expect(durableTransport.acknowledge).toHaveBeenCalledTimes(1);
    });

    test('persists only a key hash in durable runtime events', async () => {
        const published = [];
        const bridge = new RuntimeHookBridge({
            send: jest.fn(),
            durableTransport: { publish: event => published.push(event), snapshot: () => ({}) }
        });
        await bridge.handle('onContentGenerated', {
            requestId: 'secret-key-event',
            potluckApiKey: 'maki_raw_secret_value',
            model: 'gpt-5.4-mini'
        });
        const serialized = JSON.stringify(published);
        expect(serialized).not.toContain('maki_raw_secret_value');
        expect(published[0].args[0].potluckKeyHash).toMatch(/^sha256:/);
        expect(published[0].args[0]).not.toHaveProperty('potluckApiKey');
    });

    test('keeps separate session hashes and only hashed affinity fields across workers', async () => {
        const messages = [];
        const bridge = new RuntimeHookBridge({ send: async message => { messages.push(message); } });
        for (const [requestId, key] of [
            ['route-a', 'private-session-a'],
            ['route-b', 'private-session-b']
        ]) {
            await bridge.handle('onContentGenerated', {
                requestId,
                _requestAuditLifecycle: true,
                model: 'gpt-6-sol',
                _codexCacheAffinityScope: {
                    promptCacheKey: key,
                    threadId: 'private-thread-' + requestId,
                    sessionId: 'private-client-session-' + requestId
                }
            });
            await bridge.handle('onRequestCompleted', { requestId, response: { httpStatus: 200, completed: true } });
        }
        const finalEvents = messages.filter(message => message.hookName === 'onRequestCompleted')
            .map(message => buildRequestAuditEvent(message.args[0]));
        expect(finalEvents).toHaveLength(2);
        expect(finalEvents[0].prompt_cache_key_hash).toMatch(/^sha256:[a-f0-9]{32}$/);
        expect(finalEvents[0].thread_id_hash).toMatch(/^sha256:[a-f0-9]{32}$/);
        expect(finalEvents[0].session_id_hash).toMatch(/^sha256:[a-f0-9]{32}$/);
        expect(finalEvents[0].prompt_cache_key_hash).not.toBe(finalEvents[1].prompt_cache_key_hash);
        const serialized = JSON.stringify(messages);
        expect(serialized).not.toContain('private-session-');
        expect(serialized).not.toContain('private-thread-');
        expect(serialized).not.toContain('private-client-session-');
    });

    test('audits restricted routing without transmitting its raw member list', async () => {
        const messages = [];
        const bridge = new RuntimeHookBridge({ send: async message => { messages.push(message); } });
        for (const [requestId, uuid, email] of [
            ['restricted-audit-a', 'codex-a', 'account-a@example.com'],
            ['restricted-audit-b', 'codex-b', 'account-b@example.com']
        ]) {
            await bridge.handle('onContentGenerated', {
                requestId,
                _requestAuditLifecycle: true,
                model: 'gpt-6-luna',
                providerUuid: uuid,
                accountEmail: email,
                _codexRouting: {
                    routingMode: 'restricted',
                    selectedProviderUuid: uuid,
                    restrictedCredentialUuids: ['private-member-a', 'private-member-b'],
                    selectedGroupId: null,
                    actualProviderGroupId: null
                }
            });
            await bridge.handle('onRequestCompleted', {
                requestId,
                response: { httpStatus: 200, completed: true }
            });
        }
        const events = messages.filter(message => message.hookName === 'onRequestCompleted')
            .map(message => buildRequestAuditEvent(message.args[0]));
        expect(events.map(event => [event.requestId, event.account.accountEmail])).toEqual([
            ['restricted-audit-a', 'account-a@example.com'],
            ['restricted-audit-b', 'account-b@example.com']
        ]);
        expect(events.every(event => event.routing.routingMode === 'restricted'
            && event.routing.consistencyStatus === 'consistent')).toBe(true);
        expect(events[0].routing.selectedProviderUuidHash).not.toBe(events[1].routing.selectedProviderUuidHash);
        expect(JSON.stringify(messages)).not.toContain('private-member-');
    });

    test('preserves Potluck quota reservation metadata across workers', async () => {
        const messages = [];
        const bridge = new RuntimeHookBridge({
            send: message => messages.push(message),
            durableTransport: { publish: event => messages.push(event), snapshot: () => ({}) }
        });
        await bridge.handle('onRequestCompleted', {
            requestId: 'quota-bridge-1',
            potluckApiKey: 'maki_raw_secret_value',
            potluckQuotaReservationId: 'quota-reservation-1',
            potluckQuotaMode: 'distributed-strict',
            response: { statusCode: 502, completed: true }
        });

        expect(messages[0].args[0]).toMatchObject({
            potluckQuotaReservationId: 'quota-reservation-1',
            potluckQuotaMode: 'distributed-strict'
        });
        expect(JSON.stringify(messages)).not.toContain('maki_raw_secret_value');
    });

    test('preserves terminal upstream failure outcome and original error text across workers', async () => {
        const messages = [];
        const bridge = new RuntimeHookBridge({
            send: jest.fn(),
            durableTransport: { publish: event => messages.push(event), snapshot: () => ({}) }
        });
        const originalMessage = 'Invalid value for private@example.com with Bearer original-upstream-token';

        await bridge.handle('onRequestCompleted', {
            requestId: 'terminal-failure-1',
            outcome: 'upstream_error',
            errorClass: 'invalid_request_error',
            failure: {
                source: 'upstream',
                upstreamHttpStatus: 400,
                code: 'invalid_value',
                type: 'invalid_request_error',
                message: originalMessage,
                requestId: 'upstream-request-1',
                truncated: false
            },
            response: { httpStatus: 200, completed: true }
        });

        expect(messages[0].args[0]).toMatchObject({
            outcome: 'upstream_error',
            errorClass: 'invalid_request_error',
            failure: {
                source: 'upstream', upstreamHttpStatus: 400, code: 'invalid_value',
                type: 'invalid_request_error', message: originalMessage,
                requestId: 'upstream-request-1', truncated: false
            },
            response: { httpStatus: 200, completed: true }
        });
    });

    test('preserves compact runtime diagnostics across workers without payload data', async () => {
        const published = [];
        const bridge = new RuntimeHookBridge({
            send: jest.fn(),
            durableTransport: { publish: event => published.push(event), snapshot: () => ({}) }
        });
        await bridge.handle('onRequestCompleted', {
            requestId: 'runtime-bridge-1',
            runtime: {
                workerId: 'execution-2',
                kind: 'model',
                durationMs: 842,
                outputBytes: 1234,
                backpressureMs: 7,
                stages: { upstreamCompleteMs: 825, complete: 842 }
            },
            response: { statusCode: 200, completed: true, durationMs: 842 }
        });

        expect(published[0].args[0]).toMatchObject({
            runtime: {
                workerId: 'execution-2',
                kind: 'model',
                durationMs: 842,
                outputBytes: 1234,
                stages: { upstreamCompleteMs: 825, complete: 842 }
            },
            response: { durationMs: 842 }
        });
        expect(JSON.stringify(published)).not.toMatch(/prompt|body|token|cookie/i);
    });

    test('drain retries pending ipc events and flushes durable spool', async () => {
        const published = [];
        const transport = {
            publish: jest.fn(async event => {
                published.push(event);
                return { streamId: '3-0' };
            }),
            flushSpool: jest.fn().mockResolvedValue(1),
            snapshot: () => ({ spooled: 0 })
        };
        const sent = [];
        const bridge = new RuntimeHookBridge({ send: event => sent.push(event), durableTransport: transport });
        await bridge.handle('onRequestCompleted', { requestId: 'drain-1' });
        const drain = bridge.drain({ timeoutMs: 100, pollIntervalMs: 1 });
        await Promise.resolve();
        await bridge.ack(published[0].eventId);
        await expect(drain).resolves.toMatchObject({ drained: true, pending: 0 });
        expect(transport.flushSpool).toHaveBeenCalled();
    });
    test('aggregates stream usage and emits compact persistence hooks without payload data', async () => {
        const messages = [];
        const bridge = new RuntimeHookBridge({ send: message => messages.push(message) });
        await bridge.handle('onStreamChunk', {
            requestId: 'req-1', model: 'model', toProvider: 'provider', providerUuid: 'uuid',
            nativeChunk: { usage: { prompt_tokens: 10, completion_tokens: 2 }, data: 'secret prompt' },
            chunkToSend: { choices: [{ delta: { content: 'secret response' } }] }
        });
        await bridge.handle('onStreamChunk', {
            requestId: 'req-1', model: 'model', toProvider: 'provider', providerUuid: 'uuid',
            nativeChunk: { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
        });
        await bridge.handle('onContentGenerated', {
            _monitorRequestId: 'req-1', model: 'model', toProvider: 'provider', providerUuid: 'uuid',
            potluckApiKey: 'sk-potluck-test', usagePricingModel: 'gpt-6-luna',
            originalRequestBody: { prompt: 'must not leave worker' }
        });

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ type: 'runtime_hook', hookName: 'onContentGenerated' });
        expect(messages[0].args[0]._runtimeUsage).toMatchObject({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
        expect(messages[0].args[0].usagePricingModel).toBe('gpt-6-luna');
        expect(JSON.stringify(messages)).not.toMatch(/secret prompt|secret response|originalRequestBody|b64_json/);
        expect(messages[0].args[0].potluckApiKey).toBe('sk-potluck-test');
    });

    test('preserves Responses cached and reasoning token details across the worker bridge', async () => {
        const messages = [];
        const bridge = new RuntimeHookBridge({ send: message => messages.push(message) });

        await bridge.handle('onUnaryResponse', {
            requestId: 'responses-usage-1',
            model: 'gpt-5.4-mini',
            toProvider: 'openai-codex-oauth',
            nativeResponse: {
                usage: {
                    input_tokens: 3007,
                    output_tokens: 16,
                    total_tokens: 3023,
                    input_tokens_details: { cached_tokens: 2688 },
                    output_tokens_details: { reasoning_tokens: 8 }
                }
            }
        });
        await bridge.handle('onContentGenerated', {
            _monitorRequestId: 'responses-usage-1',
            model: 'gpt-5.4-mini',
            toProvider: 'openai-codex-oauth',
            _codexRouting: {
                routingMode: 'auto',
                requestedPrimaryGroupId: 'group-a',
                selectedGroupId: 'group-b',
                selectedProviderUuid: 'provider-uuid-selected',
                actualProviderGroupId: 'group-b',
                providerSwitchCount: 1,
                modelFallbackFrom: 'gpt-5.4-mini',
                modelFallbackTo: 'gpt-5.6-luna',
                modelFallbackReason: 'UPSTREAM_429',
                spillover: true,
                spilloverReason: 'PRIMARY_GROUP_UNAVAILABLE',
                assignmentMissing: false,
                affinitySource: 'session_id',
                hotShardApplied: true,
                affinityKey: 'session:private-affinity-value',
                oauthToken: 'must-not-cross-worker-bridge'
            }
        });

        expect(messages[0].args[0]._runtimeUsage).toMatchObject({
            prompt_tokens: 3007,
            completion_tokens: 16,
            total_tokens: 3023,
            cached_tokens: 2688,
            reasoning_tokens: 8
        });
        expect(messages[0].args[0]._codexRouting).toMatchObject({
            routingMode: 'auto',
            requestedPrimaryGroupId: 'group-a',
            selectedGroupId: 'group-b',
            selectedProviderUuid: 'provider-uuid-selected',
            actualProviderGroupId: 'group-b',
            providerSwitchCount: 1,
            modelFallbackFrom: 'gpt-5.4-mini',
            modelFallbackTo: 'gpt-5.6-luna',
            modelFallbackReason: 'UPSTREAM_429',
            spillover: true,
            spilloverReason: 'PRIMARY_GROUP_UNAVAILABLE',
            assignmentMissing: false,
            affinitySource: 'session_id',
            hotShardApplied: true
        });
        expect(JSON.stringify(messages)).not.toContain('private-affinity-value');
        expect(JSON.stringify(messages)).not.toContain('must-not-cross-worker-bridge');
    });

    test('reports only the presence of an image result, never Base64 bytes', async () => {
        const messages = [];
        const bridge = new RuntimeHookBridge({ send: message => messages.push(message) });
        await bridge.handle('onUnaryResponse', {
            requestId: 'image-1', model: 'gpt-image-2', toProvider: 'provider',
            clientResponse: { data: [{ b64_json: 'A'.repeat(1024 * 1024) }] }
        });
        await bridge.handle('onContentGenerated', { _monitorRequestId: 'image-1', model: 'gpt-image-2' });

        const serialized = JSON.stringify(messages);
        expect(serialized.length).toBeLessThan(4096);
        expect(serialized).not.toContain('AAAAAA');
        expect(messages[0].args[0]._runtimeHasImage).toBe(true);
    });

    test('does not send empty provider metadata on request completion', async () => {
        const messages = [];
        const bridge = new RuntimeHookBridge({ send: message => messages.push(message) });

        await bridge.handle('onRequestCompleted', {
            requestId: 'completion-1',
            response: { statusCode: 200, completed: true }
        });

        expect(messages[0].args[0]).not.toHaveProperty('providerUuid');
        expect(messages[0].args[0]).not.toHaveProperty('providerName');
        expect(messages[0].args[0]).not.toHaveProperty('accountIdentity');
        expect(messages[0].args[0]).not.toHaveProperty('accountEmail');
        expect(messages[0].args[0]).not.toHaveProperty('model');
        expect(messages[0].args[0]).not.toHaveProperty('fromProvider');
        expect(messages[0].args[0]).not.toHaveProperty('toProvider');
        expect(messages[0].args[0]).not.toHaveProperty('isStream');
        expect(messages[0].args[0].response).toEqual({
            httpStatus: 200,
            completed: true
        });
    });

    test('completion retains observed stream identity and usage when content hook is missing', async () => {
        const messages = [];
        const bridge = new RuntimeHookBridge({ send: message => messages.push(message) });
        await bridge.handle('onStreamChunk', {
            requestId: 'fallback-request',
            model: 'gpt-6-astra',
            toProvider: 'openai-codex-oauth',
            providerUuid: 'credential-a',
            accountEmail: 'owner@example.com',
            nativeChunk: { usage: { input_tokens: 120, output_tokens: 9, total_tokens: 129 }, data: 'private output' }
        });
        await bridge.handle('onStreamChunk', {
            requestId: 'other-request',
            model: 'gpt-6-luna',
            accountEmail: 'other@example.com',
            nativeChunk: { usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } }
        });
        await bridge.handle('onRequestCompleted', {
            requestId: 'fallback-request',
            _requestAuditLifecycle: true,
            response: { httpStatus: 200, completed: true }
        });

        expect(messages).toHaveLength(1);
        expect(messages[0].args[0]).toMatchObject({
            model: 'gpt-6-astra',
            toProvider: 'openai-codex-oauth',
            providerUuid: 'credential-a',
            accountEmail: 'owner@example.com',
            _runtimeUsage: { prompt_tokens: 120, completion_tokens: 9, total_tokens: 129 }
        });
        expect(JSON.stringify(messages)).not.toContain('private output');
        expect(messages[0].args[0].accountEmail).not.toBe('other@example.com');
        expect(bridge.pending.has('fallback-request')).toBe(false);
        expect(bridge.pending.has('other-request')).toBe(true);
    });

    test('completion is self-contained when the earlier content event is spooled', async () => {
        const messages = [];
        const bridge = new RuntimeHookBridge({ send: message => messages.push(message) });
        await bridge.handle('onStreamChunk', {
            requestId: 'spooled-request',
            nativeChunk: { usage: { input_tokens: 80, output_tokens: 4, total_tokens: 84 } }
        });
        await bridge.handle('onContentGenerated', {
            requestId: 'spooled-request',
            _requestAuditLifecycle: true,
            model: 'gpt-6-astra',
            accountEmail: 'owner@example.com'
        });
        expect(bridge.pending.has('spooled-request')).toBe(true);
        await bridge.handle('onRequestCompleted', {
            requestId: 'spooled-request',
            _requestAuditLifecycle: true,
            response: { httpStatus: 200, completed: true }
        });

        expect(messages.map(message => message.hookName)).toEqual(['onContentGenerated', 'onRequestCompleted']);
        expect(messages[1].args[0]).toMatchObject({
            model: 'gpt-6-astra',
            accountEmail: 'owner@example.com',
            _runtimeUsage: { prompt_tokens: 80, completion_tokens: 4, total_tokens: 84 }
        });
        expect(bridge.pending.has('spooled-request')).toBe(false);
    });

    test('bounds and expires request snapshots without mixing request identities', async () => {
        jest.useFakeTimers({ now: new Date('2026-09-28T00:00:00Z') });
        try {
            const bridge = new RuntimeHookBridge({ send: jest.fn(), pendingRequestLimit: 2, pendingRequestTtlMs: 1000 });
            for (const requestId of ['a', 'b', 'c']) {
                await bridge.handle('onStreamChunk', { requestId, model: requestId, nativeChunk: { usage: { total_tokens: 1 } } });
            }
            expect(bridge.pending.has('a')).toBe(false);
            expect(bridge.snapshot()).toMatchObject({ pendingRequests: 2, pendingEvicted: 1 });
            jest.advanceTimersByTime(1001);
            expect(bridge.snapshot()).toMatchObject({ pendingRequests: 0, pendingExpired: 2 });
        } finally {
            jest.useRealTimers();
        }
    });

    test('preserves safe final route identity and requested model metadata across workers', async () => {
        const messages = [];
        const bridge = new RuntimeHookBridge({ send: message => messages.push(message) });

        await bridge.handle('onContentGenerated', {
            requestId: 'temporary-route-1',
            model: 'gemini-2.5-flash',
            fromProvider: 'openaiResponses',
            toProvider: 'gemini-antigravity',
            isStream: true,
            originalRequestBody: { model: 'gpt-5.4-mini', input: 'private prompt' },
            processedRequestBody: { model: 'gemini-2.5-flash', contents: [{ text: 'private prompt' }] },
            potluckKeyData: { id: 'raw-key-id', name: 'Route smoke key' },
            _temporaryKeyModelRouteResult: {
                id: 'temporary-antigravity-flash',
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                actualProviderType: 'gemini-antigravity',
                actualModel: 'gemini-2.5-flash',
                providerUuid: 'raw-provider-uuid',
                providerName: 'provider@example.com',
                accountIdentity: 'account-1',
                accountEmail: 'provider@example.com',
                credentialRetryUsed: true,
                fallbackUsed: false
            }
        });

        expect(messages[0].args[0]).toMatchObject({
            model: 'gemini-2.5-flash',
            fromProvider: 'openaiResponses',
            toProvider: 'gemini-antigravity',
            isStream: true,
            originalRequestBody: { model: 'gpt-5.4-mini' },
            processedRequestBody: { model: 'gemini-2.5-flash' },
            potluckKeyData: { name: 'Route smoke key' },
            _temporaryKeyModelRouteResult: {
                id: 'temporary-antigravity-flash',
                actualProviderType: 'gemini-antigravity',
                actualModel: 'gemini-2.5-flash',
                credentialRetryUsed: true,
                fallbackUsed: false
            }
        });
        const serialized = JSON.stringify(messages[0]);
        expect(serialized).not.toContain('private prompt');
        expect(serialized).not.toContain('raw-key-id');
        expect(messages[0].args[0]._temporaryKeyModelRouteResult).not.toHaveProperty('providerUuid');
        expect(messages[0].args[0]._temporaryKeyModelRouteResult).not.toHaveProperty('accountIdentity');
    });

    test('reuses one event id when a Luna fallback usage event is replayed', async () => {
        const published = [];
        const bridge = new RuntimeHookBridge({
            send: jest.fn(),
            durableTransport: {
                publish: event => {
                    published.push(event);
                    return { persisted: true, streamId: `${published.length}-0` };
                },
                snapshot: () => ({})
            }
        });
        const fallbackPayload = {
            _monitorRequestId: 'batch-luna-fallback-event',
            model: 'gpt-5.6-luna',
            fromProvider: 'openaiResponses',
            toProvider: 'openai-codex-oauth',
            originalRequestBody: { model: 'gpt-5.4-mini' },
            processedRequestBody: { model: 'gpt-5.6-luna' },
            _temporaryKeyModelRouteResult: {
                id: 'temporary-antigravity-flash',
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                actualProviderType: 'openai-codex-oauth',
                actualModel: 'gpt-5.6-luna',
                credentialRetryUsed: true,
                fallbackUsed: true
            }
        };

        await bridge.handle('onContentGenerated', fallbackPayload);
        await bridge.handle('onContentGenerated', fallbackPayload);

        expect(published).toHaveLength(2);
        expect(published[0].eventId).toBe(published[1].eventId);
        expect(published[0].args[0]).toMatchObject({
            model: 'gpt-5.6-luna',
            toProvider: 'openai-codex-oauth',
            _temporaryKeyModelRouteResult: {
                actualProviderType: 'openai-codex-oauth',
                actualModel: 'gpt-5.6-luna',
                fallbackUsed: true
            }
        });
    });

    test('bridges only cache fingerprints for prepared upstream requests, never raw prompts', async () => {
        const messages = [];
        const bridge = new RuntimeHookBridge({ send: message => messages.push(message) });

        await bridge.handle('onUpstreamRequestPrepared', {
            requestId: 'prepared-1',
            model: 'gpt-5.4-mini',
            providerUuid: 'provider-a',
            workerId: 'execution-2',
            clientPromptCacheKey: null,
            finalPromptCacheKey: 'final-cache-key',
            cacheKeySource: 'shared_template',
            cacheCoordinationStatus: 'shared',
            templateFingerprint: 'sha256:template',
            originalRequestBody: { input: 'private original prompt' },
            upstreamRequestBody: { input: 'private upstream prompt', prompt_cache_key: 'final-cache-key' }
        });
        await bridge.handle('onContentGenerated', {
            _monitorRequestId: 'prepared-1',
            model: 'gpt-5.4-mini',
            providerUuid: 'provider-a'
        });

        const serialized = JSON.stringify(messages);
        expect(serialized).not.toContain('private original prompt');
        expect(serialized).not.toContain('private upstream prompt');
        expect(messages[0].args[0].cache).toMatchObject({
            keySource: 'shared_template',
            coordinationStatus: 'shared',
            templateFingerprint: 'sha256:template',
            workerId: 'execution-2'
        });
        expect(messages[0].args[0].cache.finalPromptCacheKeyHash).toMatch(/^sha256:/);
        expect(messages[0].args[0].cache.originalPrefixHashes.length).toBeGreaterThan(0);
        expect(messages[0].args[0].cache.upstreamPrefixHashes.length).toBeGreaterThan(0);
    });

    test('keeps Antigravity routing stages in compact runtime metadata', async () => {
        const published = [];
        const bridge = new RuntimeHookBridge({
            send: jest.fn(),
            durableTransport: { publish: event => published.push(event), snapshot: () => ({}) }
        });

        await bridge.handle('onRequestCompleted', {
            requestId: 'agy-stage-split',
            runtime: {
                durationMs: 5300,
                stages: {
                    providerFilterMs: 5300,
                    keyQueueWaitMs: 100,
                    credentialLeaseWaitMs: 200,
                    elasticQueueWaitMs: 4000,
                    availabilityRefreshMs: 50,
                    elasticAttemptCount: 3,
                    selectionPlanFilterMs: 10,
                    selectionRankMs: 20,
                    selectionHydrateMs: 400,
                    selectionComputeMs: 520
                }
            }
        });

        expect(published[0].args[0].runtime.stages).toMatchObject({
            elasticQueueWaitMs: 4000,
            availabilityRefreshMs: 50,
            elasticAttemptCount: 3,
            selectionPlanFilterMs: 10,
            selectionRankMs: 20,
            selectionHydrateMs: 400,
            selectionComputeMs: 520
        });
    });
});
