import fs from 'fs';

describe('raw capture config synchronization source', () => {
  test('broadcasts control updates and applies them in execution workers', () => {
    const runtime = fs.readFileSync('src/runtime/multi-worker-runtime.js', 'utf8');
    const server = fs.readFileSync('src/services/api-server.js', 'utf8');

    expect(runtime).toContain("message?.type === 'request_audit_raw_capture_sync'");
    expect(runtime).toContain("type: 'request_audit_raw_capture_sync_status'");
    expect(runtime).toContain("message?.type === 'request_audit_raw_capture_sync_ack'");
    expect(server).toContain('_requestAuditRawCaptureEventSink');
    expect(server).toContain('applyRawCaptureRuntimeConfig');
    expect(server).toContain("type: 'request_audit_raw_capture_sync_ack'");
  });
});
