import plugin, { applyRawCaptureRuntimeConfig } from '../src/plugins/request-audit/index.js';

async function waitFor(expectation, timeoutMs = 1000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      expectation();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

describe('request audit plugin', () => {
  test('exposes Chinese plugin description in plugin manager', () => {
    expect(plugin.description).toContain('请求审计');
    expect(plugin.description).toContain('不保存原始 prompt');
    expect(plugin.description).toContain('request-audit.html');
  });

  test('writes finalized event with merged usage', async () => {
    const auditStore = { append: jest.fn(), cleanup: jest.fn() };
    await plugin.init({ REQUEST_AUDIT_ENABLED: true, _requestAuditStore: auditStore });

    await plugin.hooks.onUnaryResponse({
      requestId: 'req-1',
      nativeResponse: {
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 20,
          total_tokens: 1020,
          prompt_tokens_details: { cached_tokens: 100 }
        }
      },
      model: 'gpt-5.5'
    });

    await plugin.hooks.onContentGenerated({
      _monitorRequestId: 'req-1',
      potluckApiKey: 'maki_secret_key',
      originalRequestBody: { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hello' }] },
      model: 'gpt-5.5',
      toProvider: 'openai-codex-oauth'
    });

    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1));
    expect(auditStore.append.mock.calls[0][0].usage).toMatchObject({
      promptTokens: 1000,
      cachedTokens: 100,
      completionTokens: 20,
      totalTokens: 1020
    });
    expect(auditStore.append.mock.calls[0][0]).not.toHaveProperty('fingerprint');
    expect(auditStore.append.mock.calls[0][0]).not.toHaveProperty('contextBreakdown');
    expect(JSON.stringify(auditStore.append.mock.calls[0][0])).not.toContain('hello');
  });

  test('defers lifecycle-backed requests until completion and writes exactly one final event', async () => {
    const auditStore = { append: jest.fn(), cleanup: jest.fn() };
    await plugin.init({ REQUEST_AUDIT_ENABLED: true, _requestAuditStore: auditStore });

    await plugin.hooks.onUnaryResponse({
      requestId: 'req-lifecycle',
      clientResponse: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'no image' }] }] }
    });
    await plugin.hooks.onContentGenerated({
      _monitorRequestId: 'req-lifecycle',
      _requestAuditLifecycle: true,
      potluckApiKey: 'maki_secret_key',
      originalRequestBody: { model: 'gpt-image-2', messages: [{ role: 'user', content: 'draw' }] },
      model: 'gpt-image-2',
      toProvider: 'openai-codex-oauth'
    });

    await new Promise(resolve => setImmediate(resolve));
    expect(auditStore.append).not.toHaveBeenCalled();

    await plugin.hooks.onRequestCompleted({
      requestId: 'req-lifecycle',
      method: 'POST',
      path: '/openai-codex-oauth/v1/chat/completions',
      normalizedPath: '/v1/chat/completions',
      clientIp: '119.123.77.234',
      peerIp: '172.17.0.1',
      clientIpSource: 'trusted-x-real-ip',
      response: { httpStatus: 200, bytes: 512, completed: true, clientAborted: false }
    });
    await plugin.hooks.onRequestCompleted({
      requestId: 'req-lifecycle',
      response: { httpStatus: 200, bytes: 512, completed: true, clientAborted: false }
    });

    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1));
    expect(auditStore.append.mock.calls[0][0]).toMatchObject({
      requestId: 'req-lifecycle',
      response: { hasImageResult: false },
      status: { outcome: 'semantic_failure', errorClass: 'missing_image_generation_result' }
    });
  });

  test('does not block content generation when audit persistence is slow', async () => {
    let resolveAppend;
    const appendPromise = new Promise(resolve => {
      resolveAppend = resolve;
    });
    const auditStore = {
      append: jest.fn(() => appendPromise),
      cleanup: jest.fn()
    };
    await plugin.init({ REQUEST_AUDIT_ENABLED: true, _requestAuditStore: auditStore });

    await plugin.hooks.onUnaryResponse({
      requestId: 'req-slow',
      nativeResponse: {
        usage: {
          prompt_tokens: 500,
          completion_tokens: 20,
          total_tokens: 520
        }
      }
    });

    const result = await Promise.race([
      plugin.hooks.onContentGenerated({
        _monitorRequestId: 'req-slow',
        potluckApiKey: 'maki_secret_key',
        originalRequestBody: { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hello' }] },
        model: 'gpt-5.5',
        toProvider: 'openai-codex-oauth'
      }).then(() => 'returned'),
      new Promise(resolve => setTimeout(() => resolve('blocked'), 100))
    ]);

    expect(result).toBe('returned');
    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1));
    expect(auditStore.cleanup).not.toHaveBeenCalled();
    resolveAppend();
  });

  test('waits for durable runtime audit persistence and propagates write failures', async () => {
    let resolveAppend;
    const appendPromise = new Promise(resolve => { resolveAppend = resolve; });
    const auditStore = { append: jest.fn(() => appendPromise), cleanup: jest.fn() };
    await plugin.init({ REQUEST_AUDIT_ENABLED: true, _requestAuditStore: auditStore });

    const durableHook = plugin.hooks.onContentGenerated({
      _monitorRequestId: 'req-durable-audit',
      _runtimeEventId: 'event-durable-audit',
      _runtimeUsage: { promptTokens: 10, totalTokens: 10 },
      model: 'gpt-5.5',
      toProvider: 'openai-codex-oauth'
    });
    let settled = false;
    durableHook.finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    resolveAppend();
    await durableHook;

    const failedStore = { append: jest.fn().mockRejectedValue(new Error('audit disk unavailable')), cleanup: jest.fn() };
    await plugin.init({ REQUEST_AUDIT_ENABLED: true, _requestAuditStore: failedStore });
    await expect(plugin.hooks.onContentGenerated({
      _monitorRequestId: 'req-durable-audit-failure',
      _runtimeEventId: 'event-durable-audit-failure',
      _runtimeUsage: { promptTokens: 10, totalTokens: 10 },
      model: 'gpt-5.5'
    })).rejects.toThrow('audit disk unavailable');
  });

  test('does not block content generation when audit input is large', async () => {
    const auditStore = {
      append: jest.fn(),
      cleanup: jest.fn()
    };
    await plugin.init({ REQUEST_AUDIT_ENABLED: true, _requestAuditStore: auditStore });

    await plugin.hooks.onUnaryResponse({
      requestId: 'req-large',
      nativeResponse: {
        usage: {
          prompt_tokens: 120000,
          completion_tokens: 20,
          total_tokens: 120020
        }
      }
    });

    const result = await Promise.race([
      plugin.hooks.onContentGenerated({
        _monitorRequestId: 'req-large',
        potluckApiKey: 'maki_secret_key',
        originalRequestBody: {
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: `secret-large-${'x'.repeat(500000)}` }],
          tools: [{ type: 'function', function: { name: 'large_tool', parameters: { description: 'y'.repeat(500000) } } }]
        },
        model: 'gpt-5.5',
        toProvider: 'openai-codex-oauth'
      }).then(() => 'returned'),
      new Promise(resolve => setTimeout(() => resolve('blocked'), 100))
    ]);

    expect(result).toBe('returned');
    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1), 1500);
    const eventJson = JSON.stringify(auditStore.append.mock.calls[0][0]);
    expect(eventJson).not.toContain('secret-large');
    expect(auditStore.append.mock.calls[0][0]).not.toHaveProperty('fingerprint');
    expect(auditStore.append.mock.calls[0][0]).not.toHaveProperty('contextBreakdown');
  });

  test('captures raw request only when scoped raw capture is enabled for key hash', async () => {
    const auditStore = { append: jest.fn(), cleanup: jest.fn() };
    const rawCaptureStore = { capture: jest.fn(), cleanup: jest.fn() };
    await plugin.init({
      REQUEST_AUDIT_ENABLED: true,
      REQUEST_AUDIT_RAW_CAPTURE_ENABLED: true,
      REQUEST_AUDIT_RAW_CAPTURE_KEY_HASHES: ['sha256:1f223db5f9b186a5'],
      _requestAuditStore: auditStore,
      _requestAuditRawCaptureStore: rawCaptureStore
    });

    await plugin.hooks.onUnaryResponse({
      requestId: 'req-raw',
      nativeResponse: { usage: { prompt_tokens: 1000, total_tokens: 1000 } }
    });
    await plugin.hooks.onContentGenerated({
      _monitorRequestId: 'req-raw',
      potluckApiKey: 'maki_secret_key',
      originalRequestBody: { input: 'raw capture scope test' },
      model: 'gpt-5.5'
    });

    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(rawCaptureStore.capture).toHaveBeenCalledTimes(1));
    expect(rawCaptureStore.capture.mock.calls[0][0].originalRequestBody.input).toBe('raw capture scope test');
  });

  test('captures the exact prepared upstream request through the execution-local hook', async () => {
    const auditStore = { append: jest.fn(), cleanup: jest.fn() };
    const rawCaptureStore = { capture: jest.fn(async () => ({ captured: true })), cleanup: jest.fn() };
    await plugin.init({
      REQUEST_AUDIT_ENABLED: true,
      REQUEST_AUDIT_RAW_CAPTURE_ENABLED: true,
      REQUEST_AUDIT_RAW_CAPTURE_KEY_HASHES: ['sha256:1f223db5f9b186a5'],
      _requestAuditStore: auditStore,
      _requestAuditRawCaptureStore: rawCaptureStore
    });

    await plugin.hooks.onUpstreamRequestPrepared({
      requestId: 'req-prepared',
      potluckApiKey: 'maki_secret_key',
      model: 'gpt-5.4-mini',
      providerUuid: 'provider-a',
      originalRequestBody: { input: 'original prompt' },
      upstreamRequestBody: { input: 'prepared prompt', prompt_cache_key: 'cache-key' }
    });

    await waitFor(() => expect(rawCaptureStore.capture).toHaveBeenCalledTimes(1));
    expect(rawCaptureStore.capture.mock.calls[0][0]).toMatchObject({
      requestId: 'req-prepared',
      originalRequestBody: { input: 'original prompt' },
      processedRequestBody: { input: 'prepared prompt', prompt_cache_key: 'cache-key' }
    });

    await plugin.hooks.onUnaryResponse({
      requestId: 'req-prepared', nativeResponse: { usage: { prompt_tokens: 10, total_tokens: 10 } }
    });
    await plugin.hooks.onContentGenerated({
      _monitorRequestId: 'req-prepared',
      potluckApiKey: 'maki_secret_key',
      model: 'gpt-5.4-mini',
      cache: { keySource: 'shared_template' }
    });
    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(rawCaptureStore.capture).toHaveBeenCalledTimes(1));
  });

  test('applies a newer raw capture revision on an execution worker', async () => {
    const auditStore = { append: jest.fn(), cleanup: jest.fn() };
    const rawCaptureStore = { capture: jest.fn(async () => ({ captured: true })), cleanup: jest.fn(), updateOptions: jest.fn() };
    await plugin.init({
      REQUEST_AUDIT_ENABLED: true,
      REQUEST_AUDIT_RAW_CAPTURE_ENABLED: false,
      _requestAuditStore: auditStore,
      _requestAuditRawCaptureStore: rawCaptureStore
    });

    expect(applyRawCaptureRuntimeConfig({
      type: 'request_audit_raw_capture_sync',
      revision: 7,
      options: {
        enabled: true,
        keyHashes: ['sha256:1f223db5f9b186a5'],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        maxFiles: 100,
        maxTotalBytes: 100 * 1024 * 1024
      }
    })).toEqual({ applied: true, revision: 7 });

    await plugin.hooks.onUpstreamRequestPrepared({
      requestId: 'req-synced', potluckApiKey: 'maki_secret_key',
      originalRequestBody: { input: 'original' }, upstreamRequestBody: { input: 'prepared' }
    });
    await waitFor(() => expect(rawCaptureStore.capture).toHaveBeenCalledTimes(1));
  });

  test('automatically disables and broadcasts raw capture after a capacity stop', async () => {
    const sink = jest.fn();
    const rawCaptureStore = {
      capture: jest.fn(async () => ({ captured: false, stopReason: 'max_files' })),
      cleanup: jest.fn(),
      updateOptions: jest.fn(),
      maxBytes: 2 * 1024 * 1024,
      maxFiles: 100,
      maxTotalBytes: 100 * 1024 * 1024,
      ttlMinutes: 15
    };
    await plugin.init({
      REQUEST_AUDIT_ENABLED: true,
      REQUEST_AUDIT_RAW_CAPTURE_ENABLED: true,
      REQUEST_AUDIT_RAW_CAPTURE_KEY_HASHES: ['sha256:1f223db5f9b186a5'],
      _requestAuditSkipConfigPersist: true,
      _requestAuditStore: { append: jest.fn(), cleanup: jest.fn() },
      _requestAuditRawCaptureStore: rawCaptureStore,
      _requestAuditRawCaptureEventSink: sink
    });

    await plugin.hooks.onUpstreamRequestPrepared({
      requestId: 'req-capacity', potluckApiKey: 'maki_secret_key',
      originalRequestBody: { input: 'original' }, upstreamRequestBody: { input: 'prepared' }
    });

    await waitFor(() => expect(sink).toHaveBeenCalledWith(expect.objectContaining({
      type: 'request_audit_raw_capture_sync',
      options: expect.objectContaining({ enabled: false })
    })));
  });

  test('init cleans expired raw capture files without forcing audit cleanup', async () => {
    const auditStore = { append: jest.fn(), cleanup: jest.fn(async () => {}) };
    const rawCaptureStore = { capture: jest.fn(), cleanup: jest.fn(async () => {}) };
    await plugin.init({
      REQUEST_AUDIT_ENABLED: true,
      _requestAuditStore: auditStore,
      _requestAuditRawCaptureStore: rawCaptureStore
    });

    await waitFor(() => expect(rawCaptureStore.cleanup).toHaveBeenCalledTimes(1));
    expect(auditStore.cleanup).not.toHaveBeenCalled();
    expect(rawCaptureStore.cleanup).toHaveBeenCalledTimes(1);
  });

  test('commits a usage projection batch with one appendBatch call', async () => {
    const auditStore = {
      append: jest.fn(),
      appendBatch: jest.fn().mockResolvedValue({ appended: 2, duplicates: 0, results: [] }),
      cleanup: jest.fn()
    };
    await plugin.init({ REQUEST_AUDIT_ENABLED: true, _requestAuditStore: auditStore });
    plugin.beginUsageProjectionBatch();
    await plugin.hooks.onRequestCompleted({
      requestId: 'proj-1',
      _runtimeEventId: 'runtime:1',
      model: 'gemini-3.1-flash-lite'
    });
    await plugin.hooks.onRequestCompleted({
      requestId: 'proj-2',
      _runtimeEventId: 'runtime:2',
      model: 'gemini-3.1-flash-lite'
    });
    await plugin.commitUsageProjectionBatch();
    expect(auditStore.appendBatch).toHaveBeenCalledTimes(1);
    expect(auditStore.append).not.toHaveBeenCalled();
    expect(auditStore.appendBatch.mock.calls[0][0]).toHaveLength(2);
  });
});
