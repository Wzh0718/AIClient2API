import { Readable } from 'stream';
import {
  captureSafeUpstreamErrorDiagnostic,
  getSafeUpstreamResponseSummary
} from '../src/utils/common.js';

describe('bounded upstream error diagnostics', () => {
  test('consumes a streamed error once and reuses a bounded original snapshot', async () => {
    const payload = JSON.stringify({
      error: {
        type: 'invalid_request_error',
        code: 'unsupported_parameter',
        param: 'tools[0].type',
        message: `Rejected private@example.com Bearer abcdefghijklmnopqrstuvwxyz ${'x'.repeat(70 * 1024)}`
      }
    });
    const stream = Readable.from([payload]);
    const error = new Error('Request failed with status code 400');
    error.response = {
      status: 400,
      headers: { 'x-request-id': 'upstream-req-1' },
      data: stream
    };

    const first = await captureSafeUpstreamErrorDiagnostic(error);
    const second = await captureSafeUpstreamErrorDiagnostic(error);
    const summary = getSafeUpstreamResponseSummary(error);

    expect(second).toBe(first);
    expect(first).toMatchObject({
      status: 400,
      code: 'unsupported_parameter',
      type: 'invalid_request_error',
      param: 'tools[0].type',
      requestId: 'upstream-req-1',
      truncated: true
    });
    expect(Buffer.byteLength(first.message, 'utf8')).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(summary.body, 'utf8')).toBeLessThanOrEqual(4096);
    expect(JSON.stringify({ first, summary })).toContain('private@example.com');
    expect(JSON.stringify({ first, summary })).toContain('abcdefghijklmnopqrstuvwxyz');
    expect(summary.body).not.toBe('[object Object]');
  });

  test('handles circular and missing response bodies without persisting raw objects', async () => {
    const circular = { error: { message: 'circular failure' } };
    circular.self = circular;
    const circularError = new Error('fallback');
    circularError.response = { status: 502, data: circular };
    const missingError = new Error('socket failed');
    missingError.code = 'ECONNRESET';

    const circularDiagnostic = await captureSafeUpstreamErrorDiagnostic(circularError);
    const missingDiagnostic = await captureSafeUpstreamErrorDiagnostic(missingError);

    expect(circularDiagnostic).toMatchObject({ status: 502, message: 'circular failure' });
    expect(circularDiagnostic.body).toBe('[object Object]');
    expect(missingDiagnostic).toMatchObject({ status: null, code: 'ECONNRESET', message: 'socket failed' });
  });
});
