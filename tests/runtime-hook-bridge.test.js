import { RuntimeHookBridge } from '../src/runtime/runtime-hook-bridge.js';

describe('RuntimeHookBridge', () => {
    test('uses a bounded queue and exposes dropped event count', async () => {
        const messages = [];
        const bridge = new RuntimeHookBridge({ send: message => messages.push(message), maxPending: 1 });
        await bridge.handle('onRequestCompleted', { requestId: 'one' });
        await bridge.handle('onRequestCompleted', { requestId: 'two' });
        expect(bridge.snapshot()).toMatchObject({ pending: 1, dropped: 1 });
        bridge.retryUnacked();
        expect(messages).toHaveLength(2);
        expect(messages[1].eventId).toBe(messages[0].eventId);
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
            potluckApiKey: 'sk-potluck-test', originalRequestBody: { prompt: 'must not leave worker' }
        });

        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({ type: 'runtime_hook', hookName: 'onUnaryResponse' });
        expect(messages[0].args[0].nativeResponse.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
        expect(messages[1]).toMatchObject({ type: 'runtime_hook', hookName: 'onContentGenerated' });
        expect(JSON.stringify(messages)).not.toMatch(/secret prompt|secret response|originalRequestBody|b64_json/);
        expect(messages[1].args[0].potluckApiKey).toBe('sk-potluck-test');
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

        expect(messages[0].args[0].nativeResponse.usage).toMatchObject({
            prompt_tokens: 3007,
            completion_tokens: 16,
            total_tokens: 3023,
            cached_tokens: 2688,
            reasoning_tokens: 8
        });
        expect(messages[1].args[0]._codexRouting).toEqual({
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
        expect(messages[0].args[0].clientResponse.data[0].url).toBe('image://result');
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
        expect(messages[0].args[0].response).toEqual({
            httpStatus: 200,
            completed: true
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
        expect(messages[1].args[0].cache).toMatchObject({
            keySource: 'shared_template',
            coordinationStatus: 'shared',
            templateFingerprint: 'sha256:template',
            workerId: 'execution-2'
        });
        expect(messages[1].args[0].cache.finalPromptCacheKeyHash).toMatch(/^sha256:/);
        expect(messages[1].args[0].cache.originalPrefixHashes.length).toBeGreaterThan(0);
        expect(messages[1].args[0].cache.upstreamPrefixHashes.length).toBeGreaterThan(0);
    });
});
