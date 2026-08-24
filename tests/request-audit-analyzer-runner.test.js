import { createRequestAuditAnalyzerRunner, runRequestAuditAnalyzer } from '../src/plugins/request-audit/analyzer-runner.js';
import plugin from '../src/plugins/request-audit/index.js';

describe('request audit analyzer runner', () => {
  test('materializes diagnostics from recent audit events', async () => {
    const auditStore = {
      query: jest.fn(async () => [
        event({ requestId: 'high', cachedTokens: 9000, prefix: 'same' }),
        event({ requestId: 'low', cachedTokens: 100, prefix: 'changed' })
      ])
    };
    const analysisStore = {
      writeDiagnostics: jest.fn()
    };

    await runRequestAuditAnalyzer({ auditStore, analysisStore, lookbackMinutes: 180, maxEvents: 5000 });

    expect(auditStore.query).toHaveBeenCalledWith(expect.objectContaining({ limit: 5000 }));
    expect(analysisStore.writeDiagnostics).toHaveBeenCalledWith(
      [expect.objectContaining({ requestId: 'low' })],
      expect.objectContaining({ generatedAt: expect.any(String) })
    );
  });

  test('plugin analyzer does not block content generation', async () => {
    let resolveQuery;
    const slowQuery = new Promise(resolve => {
      resolveQuery = resolve;
    });
    const auditStore = {
      query: jest.fn(() => slowQuery),
      append: jest.fn(),
      cleanup: jest.fn()
    };
    const analysisStore = {
      writeDiagnostics: jest.fn(),
      readDiagnostics: jest.fn(async () => ({})),
      readFreshness: jest.fn(async () => ({ status: 'missing', generatedAt: null, staleSeconds: null }))
    };

    await plugin.init({
      REQUEST_AUDIT_ENABLED: true,
      REQUEST_AUDIT_ANALYZER_ENABLED: true,
      REQUEST_AUDIT_ANALYZER_RUN_ON_INIT: true,
      _requestAuditStore: auditStore,
      _requestAuditAnalysisStore: analysisStore
    });

    await plugin.hooks.onUnaryResponse({
      requestId: 'req-fast',
      nativeResponse: { usage: { prompt_tokens: 1000, cached_tokens: 0 } }
    });

    const result = await Promise.race([
      plugin.hooks.onContentGenerated({
        _monitorRequestId: 'req-fast',
        originalRequestBody: { input: 'hello' },
        model: 'gpt-5.5'
      }).then(() => 'returned'),
      new Promise(resolve => setTimeout(() => resolve('blocked'), 100))
    ]);

    expect(result).toBe('returned');
    resolveQuery([]);
    await plugin.destroy();
  });

  test('reports bounded analyzer scan metrics after a completed run', async () => {
    const auditStore = {
      query: jest.fn(async () => [event({ requestId: 'low', cachedTokens: 100, prefix: 'changed' })]),
      getLastQueryStats: jest.fn(() => ({ scannedFiles: 2, scannedBytes: 4096 }))
    };
    const analysisStore = { writeDiagnostics: jest.fn() };
    const runner = createRequestAuditAnalyzerRunner({ auditStore, analysisStore, intervalMs: 60000 });

    await runner.run();

    expect(runner.snapshot()).toMatchObject({
      runs: 1,
      failures: 0,
      active: false,
      lastRunMs: expect.any(Number),
      lastScannedFiles: 2,
      lastScannedBytes: 4096,
      lastEventCount: 1,
      lastCompletedAt: expect.any(String)
    });
  });
});

function event({ requestId, cachedTokens, prefix }) {
  return {
    requestId,
    timestamp: `2026-06-24T06:0${requestId === 'high' ? 0 : 1}:00.000Z`,
    potluckKey: { hash: 'sha256:key' },
    request: { model: 'gpt-5.5' },
    account: { providerUuid: 'account-a' },
    usage: { promptTokens: 10000, cachedTokens },
    fingerprint: {
      toolsHash: 'sha256:tools',
      instructionsHash: 'sha256:inst',
      prefixHashes: [{ chars: 4096, hash: `sha256:${prefix}` }],
      sections: { attachments: { count: 0 } }
    }
  };
}
