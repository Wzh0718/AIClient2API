import { GptRequestStore } from '../src/plugins/request-audit/gpt-request-store.js';
import { buildAuditSummary } from '../src/plugins/request-audit/api-routes.js';

const event = (i, durationMs) => ({
  requestId: `req-${String(i).padStart(4, '0')}`, timestamp: '2026-09-23T00:00:00.000Z',
  request: { model: `gpt-${i % 3}`, requestedModel: `gpt-${i % 3}`, toProvider: 'openai-codex-oauth', path: '/v1/responses' },
  potluckKey: { hash: `key-${i % 2}`, prefix: 'prefix' },
  account: i % 3 ? { providerNameDisplay: 'account', providerUuidHash: 'credential' } : { accountEmail: 'redacted:test' },
  network: { clientIp: '127.0.0.1' },
  status: { outcome: i % 2 ? 'success' : 'upstream_error' },
  response: { durationMs },
  usage: { promptTokens: 100, cachedTokens: 20, completionTokens: 10, reasoningTokens: 3, totalTokens: 110 },
  cost: i % 4 === 0 ? null : { usd: 0.125, actualUsd: 0.125, estimatedUsd: i % 4 === 1 ? 0.125 : 0,
    missingPriceTokens: i % 4 === 2 ? 100 : 0, estimatedPriceTokens: 10, pricingSource: i % 4 === 2 ? 'missing' : 'official' },
  contextBreakdown: { sections: [{ id: 'tools', tokens: 100, calibratedTokens: 25 }, { id: 'conversation', tokens: '75' }] }
});

describe('real SQLite audit aggregation and cursor pagination', () => {
  let store;
  beforeEach(async () => { store = await new GptRequestStore({ dbPath: ':memory:' }).init(); });
  afterEach(() => store.close());

  test('SQL matches full-event summary across filters, costs, groups and exact percentiles', () => {
    const durations = [null, undefined, '', ' ', false, -1, 'bad', 0, 1, 999, '1000', 2500];
    store.appendBatch(Array.from({ length: 120 }, (_, i) => event(i, durations[i % durations.length])));
    for (const filters of [{}, { keyHash: 'key-1' }, { credential: 'credential' }, { provider: 'openai-codex-oauth', outcome: 'success' },
      { model: 'gpt-1' }, { clientIp: '127.0.0.1', path: '/v1/responses', keyPrefix: 'prefix' },
      { since: '2026-09-24', cursor: 'ignored', limit: 1 }]) {
      const actual = store.querySummary(filters), expected = buildAuditSummary(store.queryAll(filters));
      if (expected.timing.average !== null) expect(actual.timing.average).toBeCloseTo(expected.timing.average, 8);
      expect({ ...actual, timing: { ...actual.timing, average: expected.timing.average } }).toEqual(expected);
    }
    expect(store.querySummary().timing.count).toBe(50);
    expect(store.querySummary().timing.p95).toBe(2500);
    expect(store.queryRequestIds({ keyHash: 'key-1' })).toHaveLength(60);
  });

  test('same timestamp rows traverse without duplicates, honor upper bound and ignore later arrivals', () => {
    store.appendBatch(Array.from({ length: 121 }, (_, i) => event(i, i)));
    const filters = { until: '2026-09-23T00:01:00.000Z', limit: 50 };
    const first = store.query(filters);
    store.append({ ...event(1000, 1), timestamp: '2026-09-23T00:02:00.000Z' });
    const second = store.query({ ...filters, cursor: first.nextCursor });
    const third = store.query({ ...filters, cursor: second.nextCursor });
    expect([first.requests.length, second.requests.length, third.requests.length]).toEqual([50, 50, 21]);
    expect(new Set([...first.requests, ...second.requests, ...third.requests].map(row => row.requestId)).size).toBe(121);
    expect(third.nextCursor).toBeNull();
    expect(store.query(filters)).toEqual(first);
  });

  test('common filtered deep-page queries seek the matching composite index', () => {
    for (const [filter, value, index] of [['keyHash', 'key-1', 'key'], ['credential', 'credential', 'credential'], ['provider', 'openai-codex-oauth', 'provider'], ['outcome', 'success', 'outcome']]) {
      const cursor = Buffer.from(JSON.stringify(['2026-09-23', 'req'])).toString('base64url');
      const { clauses, params } = store.buildFilter({ [filter]: value, cursor });
      const plan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT payload_json FROM gpt_requests WHERE ${clauses.join(' AND ')} ORDER BY timestamp DESC, request_id DESC LIMIT 51`).all(params);
      expect(plan.map(row => row.detail).join(' ')).toContain(`idx_gpt_requests_${index}_time`);
      expect(plan.map(row => row.detail).join(' ')).not.toContain('TEMP B-TREE');
    }
  });
});
