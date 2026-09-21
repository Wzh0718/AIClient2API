import { GptRequestStore } from '../src/plugins/request-audit/gpt-request-store.js';

describe('GPT request SQLite query filters', () => {
  test('queryAll applies the full window and JSON-backed filters without pagination', () => {
    const calls = [];
    const store = new GptRequestStore();
    store.db = {
      prepare(sql) {
        return {
          all(params) {
            calls.push({ sql, params });
            return [{ payload_json: JSON.stringify({ requestId: 'req-1' }) }];
          }
        };
      }
    };

    const rows = store.queryAll({
      since: '2026-09-20T00:00:00.000Z',
      until: '2026-09-21T00:00:00.000Z',
      keyHash: 'sha256:key',
      clientIp: '119.123.77.234',
      path: '/openai-codex-oauth/v1/responses',
      provider: 'openai-codex-oauth',
      outcome: 'success',
      modelMismatch: true,
      cursor: 'ignored',
      limit: 1
    });

    expect(rows).toEqual([{ requestId: 'req-1' }]);
    expect(calls[0].sql).toContain('timestamp >= @since');
    expect(calls[0].sql).toContain('timestamp < @until');
    expect(calls[0].sql).toContain("json_extract(payload_json, '$.network.clientIp') = @clientIp");
    expect(calls[0].sql).toContain("json_extract(payload_json, '$.request.path') = @path");
    expect(calls[0].sql).toContain('model_mismatch = 1');
    expect(calls[0].sql).not.toContain('LIMIT');
    expect(calls[0].sql).not.toContain('cursorTime');
    expect(calls[0].params).toMatchObject({
      since: '2026-09-20T00:00:00.000Z',
      until: '2026-09-21T00:00:00.000Z',
      keyHash: 'sha256:key',
      clientIp: '119.123.77.234',
      path: '/openai-codex-oauth/v1/responses',
      provider: 'openai-codex-oauth',
      outcome: 'success'
    });
  });

  test('paginated query keeps the 100 default and 500 maximum', () => {
    const calls = [];
    const store = new GptRequestStore();
    store.db = {
      prepare(sql) {
        return {
          all(params) {
            calls.push({ sql, params });
            return [];
          }
        };
      }
    };

    store.query({});
    store.query({ limit: 2000 });

    expect(calls[0].params.limit).toBe(101);
    expect(calls[1].params.limit).toBe(501);
  });
});
