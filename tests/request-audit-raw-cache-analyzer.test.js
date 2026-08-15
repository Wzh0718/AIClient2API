import { analyzeRawCaptureRecords } from '../src/plugins/request-audit/raw-cache-analyzer.js';

describe('raw cache analyzer', () => {
  test('reports common prefix and cache gap without returning prompt text', () => {
    const stablePrefix = 'x'.repeat(12000);
    const records = [
      {
        requestId: 'first', timestamp: '2026-08-14T01:00:00.000Z', potluckKeyHash: 'sha256:key',
        request: { model: 'gpt-5.5', providerUuidHash: 'provider-a', finalPromptCacheKeyHash: 'cache-a', templateFingerprint: 'template-a' },
        processedRequestBody: { input: `${stablePrefix} first` }
      },
      {
        requestId: 'second', timestamp: '2026-08-14T01:01:00.000Z', potluckKeyHash: 'sha256:key',
        request: { model: 'gpt-5.5', providerUuidHash: 'provider-a', finalPromptCacheKeyHash: 'cache-a', templateFingerprint: 'template-a' },
        processedRequestBody: { input: `${stablePrefix} second` }
      }
    ];
    const report = analyzeRawCaptureRecords(records, { auditEvents: [
      { requestId: 'second', usage: { promptTokens: 4000, cachedTokens: 400 } }
    ] });

    expect(report[0]).toMatchObject({
      requestId: 'second',
      previousRequestId: 'first',
      firstChangeArea: '8K-16K',
      classification: 'upstream_cache_uncertain'
    });
    expect(report[0].commonPrefixTokensApprox).toBeGreaterThan(2500);
    expect(JSON.stringify(report)).not.toContain(stablePrefix);
  });

  test('distinguishes client structure, cache-key fragmentation, and provider fragmentation', () => {
    const auditEvents = [
      { requestId: 'structure', usage: { promptTokens: 4000, cachedTokens: 0 } },
      { requestId: 'key-fragment', usage: { promptTokens: 4000, cachedTokens: 0 } },
      { requestId: 'provider-fragment', usage: { promptTokens: 4000, cachedTokens: 0 } }
    ];
    const base = {
      timestamp: '2026-08-14T01:00:00.000Z', potluckKeyHash: 'sha256:key',
      request: { model: 'gpt-5.5', providerUuidHash: 'provider-a', finalPromptCacheKeyHash: 'cache-a', templateFingerprint: 'template-a' },
      processedRequestBody: { instructions: 'stable', tools: [], input: 'x'.repeat(12000) }
    };
    const records = [
      { ...base, requestId: 'base' },
      { ...base, requestId: 'structure', timestamp: '2026-08-14T01:01:00.000Z', processedRequestBody: { ...base.processedRequestBody, instructions: 'changed' } },
      { ...base, requestId: 'key-fragment', timestamp: '2026-08-14T01:02:00.000Z', request: { ...base.request, finalPromptCacheKeyHash: 'cache-b' } },
      { ...base, requestId: 'provider-fragment', timestamp: '2026-08-14T01:03:00.000Z', request: { ...base.request, providerUuidHash: 'provider-b' } }
    ];

    const byId = Object.fromEntries(analyzeRawCaptureRecords(records, { auditEvents }).map(item => [item.requestId, item.classification]));
    expect(byId.structure).toBe('client_structure_variance');
    expect(byId['key-fragment']).toBe('gateway_key_fragmentation');
    expect(byId['provider-fragment']).toBe('gateway_provider_fragmentation');
  });
});
