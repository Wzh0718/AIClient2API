import { buildRequestAuditEvent } from '../src/plugins/request-audit/audit-event.js';
import { buildAuditSummary } from '../src/plugins/request-audit/api-routes.js';

describe('request audit event', () => {
  test('builds a self-contained v4 event with request network and response facts', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-v2',
      method: 'POST',
      path: '/openai-codex-oauth/v1/chat/completions',
      normalizedPath: '/v1/chat/completions',
      clientIp: '119.123.77.234',
      peerIp: '172.17.0.1',
      clientIpSource: 'trusted-x-real-ip',
      model: 'gpt-image-2',
      response: {
        httpStatus: 200,
        bytes: 1864,
        completed: true,
        clientAborted: false,
        hasImageResult: false
      }
    });

    expect(event).toMatchObject({
      schemaVersion: 4,
      request: {
        method: 'POST',
        path: '/openai-codex-oauth/v1/chat/completions',
        normalizedPath: '/v1/chat/completions',
        model: 'gpt-image-2'
      },
      network: {
        clientIp: '119.123.77.234',
        peerIp: '172.17.0.1',
        clientIpSource: 'trusted-x-real-ip'
      },
      response: {
        httpStatus: 200,
        bytes: 1864,
        completed: true,
        clientAborted: false,
        hasImageResult: false
      },
      status: {
        outcome: 'semantic_failure',
        httpStatus: 200,
        errorClass: 'missing_image_generation_result'
      }
    });
  });

  test('persists normalized request timing and runtime diagnostics without secrets', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-runtime-diagnostics',
      model: 'gemini-2.5-flash',
      response: {
        httpStatus: 200,
        bytes: 1234,
        completed: true,
        clientAborted: false,
        hasImageResult: null,
        durationMs: 842,
        errorCode: 'UPSTREAM_TIMEOUT'
      },
      runtime: {
        workerId: 'execution-2',
        kind: 'model',
        outputBytes: 1234,
        backpressureMs: 7,
        stages: {
          requestConvertMs: 12,
          upstreamFirstByteMs: 410,
          upstreamCompleteMs: 825,
          responseFinalizeMs: 4
        },
        metadata: { diagnosticLabel: 'internal-only' }
      }
    });

    expect(event.response).toMatchObject({ durationMs: 842, errorCode: 'UPSTREAM_TIMEOUT' });
    expect(event.runtime).toEqual({
      workerId: 'execution-2',
      requestKind: 'model',
      outputBytes: 1234,
      backpressureMs: 7,
      stages: {
        requestConvertMs: 12,
        upstreamFirstByteMs: 410,
        upstreamCompleteMs: 825,
        responseFinalizeMs: 4
      }
    });
    expect(JSON.stringify(event)).not.toContain('diagnosticLabel');
  });

  test.each([NaN, Infinity, -1, 'bad'])('normalizes invalid duration %p to null', durationMs => {
    const event = buildRequestAuditEvent({
      requestId: `req-invalid-duration-${String(durationMs)}`,
      response: { httpStatus: 200, completed: true, durationMs }
    });

    expect(event.response.durationMs).toBeNull();
  });

  test('records cache coordination evidence without raw identifiers', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-cache-v4',
      model: 'gpt-5.5',
      cache: {
        clientPromptCacheKeyHash: 'sha256:client',
        finalPromptCacheKeyHash: 'sha256:final',
        keySource: 'shared_template',
        coordinationStatus: 'shared',
        templateFingerprint: 'sha256:template',
        originalPrefixHashes: [{ chars: 4096, hash: 'sha256:original' }],
        upstreamPrefixHashes: [{ chars: 4096, hash: 'sha256:upstream' }],
        instructionsHash: 'sha256:instructions',
        toolsHash: 'sha256:tools',
        metadataHash: 'sha256:metadata',
        workerId: 'execution-1'
      }
    });

    expect(event.cache).toEqual(expect.objectContaining({
      finalPromptCacheKeyHash: 'sha256:final',
      keySource: 'shared_template',
      coordinationStatus: 'shared',
      templateFingerprint: 'sha256:template',
      workerId: 'execution-1'
    }));
  });

  test.each([
    [{ httpStatus: 503, completed: true, clientAborted: false, hasImageResult: null }, 'http_error'],
    [{ httpStatus: 200, completed: false, clientAborted: true, hasImageResult: null }, 'client_aborted'],
    [{ httpStatus: 200, completed: true, clientAborted: false, hasImageResult: true }, 'success']
  ])('derives the real outcome from response facts %#', (response, outcome) => {
    const event = buildRequestAuditEvent({ requestId: `req-${outcome}`, model: 'gpt-image-2', response });
    expect(event.status.outcome).toBe(outcome);
    expect(event.status.httpStatus).toBe(response.httpStatus);
  });

  test('builds sanitized audit event with key hash and no raw prompt', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-1',
      potluckApiKey: 'maki_4734b4e5fe29dc2af36d8296a46f3462',
      providerName: 'user@example.com',
      fromProvider: 'openai',
      toProvider: 'openai-codex-oauth',
      providerUuid: 'uuid-1',
      model: 'gpt-5.5',
      originalRequestBody: {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'secret prompt text' }]
      },
      usage: { promptTokens: 1000, cachedTokens: 100, totalTokens: 1100 }
    });

    const serialized = JSON.stringify(event);
    expect(event.potluckKey.hash).toMatch(/^sha256:/);
    expect(event.potluckKey.prefix).toBe('maki_4734b4...');
    expect(event.account.providerNameDisplay).toMatch(/^redacted-email:/);
    expect(serialized).not.toContain('maki_4734b4e5fe29dc2af36d8296a46f3462');
    expect(serialized).not.toContain('secret prompt text');
    expect(event.account.accountEmail).toBe('user@example.com');
    expect(event).not.toHaveProperty('fingerprint');
    expect(event).not.toHaveProperty('contextBreakdown');
  });

  test('omits diagnostic payload fields even when deep context breakdown is requested', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-deep',
      model: 'gpt-5.5',
      deepContextBreakdown: true,
      originalRequestBody: {
        model: 'gpt-5.5',
        instructions: 'system text',
        tools: [{ type: 'function', function: { name: 'lookup' } }],
        input: [{ role: 'user', content: 'hello' }]
      },
      usage: { promptTokens: 1000, cachedTokens: 100, totalTokens: 1100 }
    });

    expect(event).not.toHaveProperty('fingerprint');
    expect(event).not.toHaveProperty('contextBreakdown');
  });

  test('records only one-way hashes for Codex cache affinity identifiers', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-cache-affinity',
      model: 'gpt-5.5-codex',
      _codexCacheAffinityScope: {
        promptCacheKey: 'prompt-cache-private-value',
        threadId: 'thread-private-value',
        sessionId: 'session-private-value'
      }
    });

    expect(event).toMatchObject({
      prompt_cache_key_hash: expect.stringMatching(/^sha256:[a-f0-9]{32}$/),
      thread_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{32}$/),
      session_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{32}$/)
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('prompt-cache-private-value');
    expect(serialized).not.toContain('thread-private-value');
    expect(serialized).not.toContain('session-private-value');
  });

  test('keeps requested and actual model when server-side model fallback is used', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-model-fallback',
      model: 'gpt-5.4-mini',
      originalRequestBody: {
        model: 'gpt-5.3-codex-spark',
        messages: [{ role: 'user', content: 'hello' }]
      },
      processedRequestBody: {
        model: 'gpt-5.4-mini',
        messages: [{ role: 'user', content: 'hello' }]
      },
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }
    });

    expect(event.request).toMatchObject({
      model: 'gpt-5.4-mini',
      requestedModel: 'gpt-5.3-codex-spark',
      actualModel: 'gpt-5.4-mini'
    });
  });

  test('records Gemini queue and fallback metadata from the generic model route', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-gemini-elastic',
      model: 'gemini-2.5-flash',
      originalRequestBody: { model: 'gemini-2.5-flash-lite' },
      processedRequestBody: { model: 'gemini-2.5-flash' },
      _modelRouting: {
        requestedModel: 'gemini-2.5-flash-lite',
        actualModel: 'gemini-2.5-flash',
        modelFallbackFrom: 'gemini-2.5-flash-lite',
        modelFallbackTo: 'gemini-2.5-flash',
        modelFallbackReason: 'SOURCE_MODEL_UNAVAILABLE',
        queueWaitMs: 1234,
        fallbackAttemptCount: 2,
        queueOutcome: 'fallback_after_wait'
      }
    });

    expect(event.routing).toMatchObject({
      modelFallbackFrom: 'gemini-2.5-flash-lite',
      modelFallbackTo: 'gemini-2.5-flash',
      modelFallbackReason: 'SOURCE_MODEL_UNAVAILABLE',
      queueWaitMs: 1234,
      fallbackAttemptCount: 2,
      queueOutcome: 'fallback_after_wait'
    });
  });

  test('records real account email when routing context provides it', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-account-email',
      providerName: 'codex-account-a',
      providerUuid: 'uuid-1',
      accountEmail: 'Codex.User@Example.COM',
      model: 'gpt-5.5',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }
    });

    expect(event.account).toMatchObject({
      providerUuidHash: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
      accountEmail: 'codex.user@example.com'
    });
    expect(event.account).not.toHaveProperty('providerUuid');
  });

  test('records sanitized sticky routing diagnostics without the affinity key', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-routing-diagnostics',
      providerUuid: 'private-provider-uuid',
      model: 'gpt-5.4-mini',
      _codexRouting: {
        routingMode: 'auto',
        requestedPrimaryGroupId: 'group-a',
        selectedGroupId: 'group-b',
        selectedProviderUuid: 'private-selected-provider-uuid',
        actualProviderGroupId: 'group-b',
        providerSwitchCount: 2,
        modelFallbackFrom: 'gpt-5.4-mini',
        modelFallbackTo: 'gpt-5.6-luna',
        modelFallbackReason: 'UPSTREAM_429',
        spillover: true,
        spilloverReason: 'PRIMARY_GROUP_UNAVAILABLE',
        assignmentMissing: false,
        affinitySource: 'session_id',
        affinityKey: 'session:private-affinity-value',
        hotShardApplied: true,
        oauthToken: 'private-oauth-token'
      }
    });

    expect(event.routing).toEqual({
      routingMode: 'auto',
      requestedPrimaryGroupId: 'group-a',
      selectedGroupId: 'group-b',
      selectedProviderUuidHash: expect.stringMatching(/^sha256:[a-f0-9]{16}$/),
      consistencyStatus: 'mismatch',
      actualProviderGroupId: 'group-b',
      providerSwitchCount: 2,
      modelFallbackFrom: 'gpt-5.4-mini',
      modelFallbackTo: 'gpt-5.6-luna',
      modelFallbackReason: 'UPSTREAM_429',
      spillover: true,
      spilloverReason: 'PRIMARY_GROUP_UNAVAILABLE',
      assignmentMissing: false,
      affinitySource: 'session_id',
      hotShardApplied: true,
      keyQueueWaitMs: 0,
      keyQueueOutcome: null,
      keyCapacityExhausted: false
    });
    expect(event.account.providerUuidHash).toMatch(/^sha256:[a-f0-9]{16}$/);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('private-provider-uuid');
    expect(serialized).not.toContain('private-selected-provider-uuid');
    expect(serialized).not.toContain('private-affinity-value');
    expect(serialized).not.toContain('private-oauth-token');
  });

  test('marks successful Codex routing consistent when selected and actual provider hashes match', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-routing-consistent',
      providerUuid: 'provider-final',
      model: 'gpt-5.6-luna',
      _codexRouting: {
        routingMode: 'pool',
        selectedGroupId: null,
        selectedProviderUuid: 'provider-final',
        actualProviderGroupId: null,
        assignmentMissing: false
      },
      response: { httpStatus: 200, completed: true }
    });

    expect(event.routing.consistencyStatus).toBe('consistent');
    expect(event.routing.selectedProviderUuidHash).toBe(event.account.providerUuidHash);
    expect(event.routing.assignmentMissing).toBe(false);
  });

  test('continues summarizing legacy schema v2 events', () => {
    const summary = buildAuditSummary([{
      schemaVersion: 2,
      requestId: 'legacy-v2',
      request: { model: 'gpt-5.4-mini' },
      account: { providerUuidHash: 'sha256:legacy' },
      status: { outcome: 'success' },
      usage: { totalTokens: 12 }
    }]);

    expect(summary.summary.requestCount).toBe(1);
  });

  test('uses account email as the summary account key when present', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-summary-account-email',
      providerName: 'codex-account-a',
      providerUuid: 'uuid-1',
      accountEmail: 'codex.user@example.com',
      model: 'gpt-5.5',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }
    });

    const summary = buildAuditSummary([event]);

    expect(summary.accounts['codex.user@example.com']).toMatchObject({
      requestCount: 1,
      totalTokens: 12
    });
    expect(summary.accounts['codex-account-a']).toBeUndefined();
  });

  test('does not add reasoning tokens to completion tokens when normalizing usage', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-reasoning-usage',
      model: 'gpt-5.5',
      usage: {
        input_tokens: 1000,
        output_tokens: 120,
        output_tokens_details: {
          reasoning_tokens: 80
        },
        total_tokens: 1120
      }
    });

    expect(event.usage).toMatchObject({
      promptTokens: 1000,
      completionTokens: 120,
      reasoningTokens: 80,
      totalTokens: 1120
    });
  });
});
