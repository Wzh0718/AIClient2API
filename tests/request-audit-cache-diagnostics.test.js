import { buildDiagnostics, diagnoseCacheMiss } from '../src/plugins/request-audit/cache-diagnostics.js';

function event(overrides = {}) {
  return {
    requestId: overrides.requestId || 'req-current',
    timestamp: overrides.timestamp || '2026-08-14T06:00:00.000Z',
    potluckKey: { hash: overrides.keyHash || 'sha256:key' },
    request: { model: overrides.model || 'gpt-5.5' },
    account: { providerUuidHash: overrides.accountUuid || 'provider-a' },
    usage: {
      promptTokens: overrides.promptTokens ?? 10000,
      cachedTokens: overrides.cachedTokens ?? 1000
    },
    cache: {
      finalPromptCacheKeyHash: overrides.finalKey || 'sha256:cache-a',
      templateFingerprint: overrides.template || 'sha256:template-a',
      instructionsHash: overrides.instructionsHash || 'sha256:inst-a',
      toolsHash: overrides.toolsHash || 'sha256:tools-a',
      upstreamPrefixHashes: overrides.prefixHashes || [{ chars: 32768, hash: 'sha256:prefix-a' }],
      theoreticalCacheRatio: overrides.theoreticalCacheRatio
    }
  };
}

describe('request audit cache diagnostics v4', () => {
  test('classifies client-limited prefixes when actual is near the theoretical ceiling', () => {
    const diagnosis = diagnoseCacheMiss(event({ cachedTokens: 2500, theoreticalCacheRatio: 0.32 }), []);
    expect(diagnosis.primaryReason).toBe('client_prefix_limited');
    expect(diagnosis.cacheGap).toBeCloseTo(0.07);
  });

  test('classifies changing instructions, tools, or early structure', () => {
    const current = event({ instructionsHash: 'sha256:inst-b' });
    const previous = event({ requestId: 'previous' });
    const diagnosis = diagnoseCacheMiss(current, [previous]);
    expect(diagnosis.primaryReason).toBe('client_structure_variance');
  });

  test('classifies multiple final keys for one provider and template', () => {
    const current = event({ finalKey: 'sha256:cache-b' });
    const previous = event({ requestId: 'previous', finalKey: 'sha256:cache-a' });
    const diagnosis = diagnoseCacheMiss(current, [previous]);
    expect(diagnosis.primaryReason).toBe('gateway_key_fragmentation');
  });

  test('classifies provider fragmentation when a stable template has a large cache gap', () => {
    const current = event({ accountUuid: 'provider-b', theoreticalCacheRatio: 0.8, cachedTokens: 1000 });
    const previous = event({ requestId: 'previous', accountUuid: 'provider-a', theoreticalCacheRatio: 0.8 });
    const diagnosis = diagnoseCacheMiss(current, [previous]);
    expect(diagnosis.primaryReason).toBe('gateway_provider_fragmentation');
  });

  test('classifies stable provider, key, and prefix with a large unexplained gap', () => {
    const current = event({ theoreticalCacheRatio: 0.8, cachedTokens: 1000 });
    const previous = event({ requestId: 'previous', theoreticalCacheRatio: 0.8 });
    const diagnosis = diagnoseCacheMiss(current, [previous]);
    expect(diagnosis.primaryReason).toBe('upstream_cache_uncertain');
  });

  test('keeps schema v3 fingerprint evidence readable', () => {
    const legacy = event({ requestId: 'legacy' });
    delete legacy.cache;
    legacy.fingerprint = {
      instructionsHash: 'sha256:inst-a',
      toolsHash: 'sha256:tools-a',
      prefixHashes: [{ chars: 4096, hash: 'sha256:prefix-a' }]
    };
    const diagnosis = diagnoseCacheMiss(legacy, []);
    expect(diagnosis.primaryReason).toBe('client_prefix_limited');
  });

  test('builds diagnostics for low-cache events only', () => {
    const low = event({ requestId: 'low', cachedTokens: 100 });
    const high = event({ requestId: 'high', cachedTokens: 8000 });
    expect(buildDiagnostics([high, low]).map(item => item.requestId)).toEqual(['low']);
  });
});
