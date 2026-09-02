import path from 'node:path';

import {
  resolveUsageLedgerScript,
  resolveReconciliationDate,
  classifyReconcileExitCode,
} from '../scripts/ops/reconcile-current-day.mjs';

describe('reconciliation runner', () => {
  test('resolves the in-image usage ledger script instead of the bind-mounted config directory', () => {
    expect(resolveUsageLedgerScript({ baseDir: '/app/configs' })).toBe(
      '/app/scripts/usage-ledger/daily-usage-ledger.mjs'
    );
  });

  test('uses the previous Shanghai calendar day by default', () => {
    expect(resolveReconciliationDate(new Date('2026-09-02T00:30:00.000Z'))).toBe('2026-09-01');
  });

  test('treats reconcile exit code 2 as a generated deviation, not a task failure', () => {
    expect(classifyReconcileExitCode(0)).toEqual({ generated: true, deviation: false });
    expect(classifyReconcileExitCode(2)).toEqual({ generated: true, deviation: true });
    expect(classifyReconcileExitCode(1)).toEqual({ generated: false, deviation: false });
  });
});
