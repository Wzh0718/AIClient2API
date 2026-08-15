import { buildAuditSummary, handleRequestAuditRoutes, setRawCaptureController } from '../src/plugins/request-audit/api-routes.js';

describe('request audit api aggregation', () => {
  test('summarizes usage models accounts and context sections', () => {
    const summary = buildAuditSummary([
      {
        request: { model: 'gpt-5.5', toProvider: 'openai-codex-oauth' },
        account: { providerNameDisplay: 'A' },
        usage: { promptTokens: 1000, cachedTokens: 100, completionTokens: 20, reasoningTokens: 5, totalTokens: 1025 },
        contextBreakdown: { sections: [{ id: 'conversation', calibratedTokens: 800 }, { id: 'tools', calibratedTokens: 200 }] }
      },
      {
        request: { model: 'gpt-5.4-mini', toProvider: 'openai-codex-oauth' },
        account: { providerNameDisplay: 'B' },
        usage: { promptTokens: 500, cachedTokens: 50, completionTokens: 10, reasoningTokens: 0, totalTokens: 510 },
        contextBreakdown: { sections: [{ id: 'conversation', calibratedTokens: 450 }] }
      }
    ]);

    expect(summary.summary).toMatchObject({
      requestCount: 2,
      promptTokens: 1500,
      cachedTokens: 150,
      completionTokens: 30,
      reasoningTokens: 5,
      totalTokens: 1535,
      cacheHitRatio: 0.1
    });
    expect(summary.models['gpt-5.5'].requestCount).toBe(1);
    expect(summary.accounts.A.promptTokens).toBe(1000);
    expect(summary.contextSections.conversation.tokens).toBe(1250);
  });

  test('summary includes analysis freshness and diagnostic counts', async () => {
    const payload = await callRoute('/api/request-audit/summary', {
      _requestAuditSkipAuth: true,
      _requestAuditStore: {
        query: jest.fn(async () => [{ requestId: 'req-1', usage: { promptTokens: 1000, cachedTokens: 10 } }])
      },
      _requestAuditAnalysisStore: {
        readFreshness: jest.fn(async () => ({ status: 'fresh', generatedAt: '2026-06-24T06:10:00.000Z', staleSeconds: 60 })),
        readDiagnostics: jest.fn(async () => ({
          'req-1': { requestId: 'req-1', primaryReason: 'prefix_changed' }
        }))
      }
    });

    expect(payload.success).toBe(true);
    expect(payload.data.analysisFreshness.status).toBe('fresh');
    expect(payload.data.diagnosticsSummary.prefix_changed).toBe(1);
  });

  test('requests attach materialized diagnosis when available', async () => {
    const payload = await callRoute('/api/request-audit/requests', {
      _requestAuditSkipAuth: true,
      _requestAuditStore: {
        query: jest.fn(async () => [{ requestId: 'req-1', usage: { promptTokens: 1000, cachedTokens: 10 } }])
      },
      _requestAuditAnalysisStore: {
        readFreshness: jest.fn(async () => ({ status: 'fresh', generatedAt: '2026-06-24T06:10:00.000Z', staleSeconds: 60 })),
        readDiagnostics: jest.fn(async () => ({
          'req-1': { requestId: 'req-1', primaryReason: 'tools_changed' }
        }))
      }
    });

    expect(payload.data.requests[0].diagnosis.primaryReason).toBe('tools_changed');
  });

  test('passes client ip and original path filters to the audit store', async () => {
    const query = jest.fn(async () => []);
    await callRoute('/api/request-audit/requests?clientIp=119.123.77.234&path=%2Fopenai-codex-oauth%2Fv1%2Fchat%2Fcompletions', {
      _requestAuditSkipAuth: true,
      _requestAuditStore: { query },
      _requestAuditAnalysisStore: {
        readDiagnostics: jest.fn(async () => ({}))
      }
    });

    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      clientIp: '119.123.77.234',
      path: '/openai-codex-oauth/v1/chat/completions'
    }));
  });

  test('raw capture status exposes scoped capture settings and file count', async () => {
    const controller = {
      getStatus: jest.fn(() => ({
        enabled: true,
        keyHashes: ['sha256:abcdef1234567890'],
        ttlMinutes: 30,
        maxBytes: 2097152,
        dir: 'configs/request-audit-raw',
        fileCount: 2
      })),
      updateOptions: jest.fn()
    };
    setRawCaptureController(controller);

    const payload = await callRoute('/api/request-audit/raw-capture', { _requestAuditSkipAuth: true });

    expect(payload.success).toBe(true);
    expect(payload.data).toMatchObject({
      enabled: true,
      keyHashes: ['sha256:abcdef1234567890'],
      ttlMinutes: 30,
      maxBytes: 2097152,
      fileCount: 2
    });
  });

  test('raw capture update validates key hashes and updates runtime config', async () => {
    const controller = {
      getStatus: jest.fn(() => ({ enabled: false, keyHashes: [], ttlMinutes: 60, maxBytes: 1048576 })),
      updateOptions: jest.fn()
    };
    const config = {
      _requestAuditSkipConfigPersist: true,
      _requestAuditSkipAuth: true,
      REQUEST_AUDIT_RAW_CAPTURE_ENABLED: false,
      REQUEST_AUDIT_RAW_CAPTURE_KEY_HASHES: []
    };
    setRawCaptureController(controller);

    const payload = await callRoute('/api/request-audit/raw-capture', config, 'POST', {
      enabled: true,
      keyHashes: ['sha256:abcdef1234567890'],
      durationMinutes: 15,
      maxBytes: 2097152,
      maxFiles: 100,
      maxTotalBytes: 100 * 1024 * 1024
    });

    expect(payload.success).toBe(true);
    expect(config.REQUEST_AUDIT_RAW_CAPTURE_ENABLED).toBe(true);
    expect(config.REQUEST_AUDIT_RAW_CAPTURE_KEY_HASHES).toEqual(['sha256:abcdef1234567890']);
    expect(controller.updateOptions).toHaveBeenCalledWith({
      enabled: true,
      keyHashes: ['sha256:abcdef1234567890'],
      ttlMinutes: 15,
      durationMinutes: 15,
      expiresAt: expect.any(String),
      maxBytes: 2097152,
      maxFiles: 100,
      maxTotalBytes: 100 * 1024 * 1024
    }, { publish: true });
  });

  test('raw capture update limits scope to two keys and sixty minutes', async () => {
    setRawCaptureController({ getStatus: jest.fn(), updateOptions: jest.fn() });
    const payload = await callRoute('/api/request-audit/raw-capture', {
      _requestAuditSkipConfigPersist: true,
      _requestAuditSkipAuth: true
    }, 'POST', {
      enabled: true,
      keyHashes: [
        'sha256:aaaaaaaaaaaaaaaa',
        'sha256:bbbbbbbbbbbbbbbb',
        'sha256:cccccccccccccccc'
      ],
      durationMinutes: 120
    }, 400);

    expect(payload.success).toBe(false);
    expect(payload.error.message).toContain('two');
  });

  test('raw capture update rejects invalid key hash', async () => {
    setRawCaptureController({ getStatus: jest.fn(), updateOptions: jest.fn() });

    const payload = await callRoute('/api/request-audit/raw-capture', { _requestAuditSkipConfigPersist: true, _requestAuditSkipAuth: true }, 'POST', {
      enabled: true,
      keyHashes: ['maki_secret_key']
    }, 400);

    expect(payload.success).toBe(false);
    expect(payload.error.message).toContain('key hash');
  });

  test('raw capture endpoint requires admin auth by default', async () => {
    setRawCaptureController({ getStatus: jest.fn(), updateOptions: jest.fn() });

    const payload = await callRoute('/api/request-audit/raw-capture', {}, 'GET', null, 401);

    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('UNAUTHORIZED');
  });

  test.each([
    '/api/request-audit/summary',
    '/api/request-audit/requests'
  ])('%s requires admin auth by default', async path => {
    const payload = await callRoute(path, {}, 'GET', null, 401);

    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('UNAUTHORIZED');
  });
});

async function callRoute(path, config, method = 'GET', requestBody = null, expectedStatus = 200) {
  let statusCode = null;
  let responseBody = '';
  const res = {
    writeHead(code) {
      statusCode = code;
    },
    end(value) {
      responseBody = value;
    }
  };
  const req = {
    url: path,
    headers: {},
    on(event, callback) {
      if (event === 'data' && requestBody !== null) {
        process.nextTick(() => callback(Buffer.from(JSON.stringify(requestBody))));
      }
      if (event === 'end') {
        process.nextTick(callback);
      }
      return this;
    },
    resume() {},
    destroy() {}
  };

  const routePath = new URL(path, 'http://localhost').pathname;
  await handleRequestAuditRoutes(method, routePath, req, res, config);
  expect(statusCode).toBe(expectedStatus);
  return JSON.parse(responseBody);
}
