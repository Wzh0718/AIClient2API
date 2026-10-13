import { buildRequestAuditEvent, resolveAuditAccountCandidate } from '../src/plugins/request-audit/audit-event.js';

const failedResponse = { httpStatus: 400, completed: false };

describe('request audit account attribution', () => {
  test('uses the final provider when the request reached a credential', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-used',
      providerUuid: 'uuid-used',
      accountEmail: 'used@example.com',
      _codexRouting: { selectedProviderUuid: 'uuid-used' },
      response: { httpStatus: 200, completed: true }
    });
    expect(event.account).toMatchObject({ accountEmail: 'used@example.com', attribution: 'used' });
    expect(event.account.providerUuidHash).toMatch(/^sha256:/);
  });

  test('attributes a failed request to the credential of the last attempt', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-attempt',
      requestAttempts: [{ providerType: 'openai-codex-oauth', providerUuid: 'uuid-attempt', status: 'failed', httpStatus: 400 }],
      selectedAccount: { providerUuid: 'uuid-attempt', providerName: 'attempt-name', accountEmail: 'attempt@example.com' },
      response: failedResponse
    });
    expect(event.account).toMatchObject({ accountEmail: 'attempt@example.com', attribution: 'used' });
    expect(event.account.providerUuidHash).toMatch(/^sha256:/);
  });

  test('marks a selected-but-never-sent credential instead of leaving the account empty', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-selected',
      _codexRouting: { selectedProviderUuid: 'uuid-selected' },
      selectedAccount: { providerUuid: 'uuid-selected', providerName: 'selected-name', accountEmail: 'selected@example.com' },
      response: failedResponse
    });
    expect(event.account).toMatchObject({ accountEmail: 'selected@example.com', attribution: 'selected-not-sent', providerUuidHash: null });
    expect(event.routing.selectedProviderUuidHash).toMatch(/^sha256:/);
  });

  test('keeps only a hash when the selected credential cannot be resolved to an account', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-unresolved',
      _codexRouting: { selectedProviderUuid: 'uuid-gone' },
      response: failedResponse
    });
    expect(event.account).toMatchObject({ accountEmail: null, providerNameDisplay: null, attribution: 'selected-not-sent' });
    expect(event.routing.selectedProviderUuidHash).toMatch(/^sha256:/);
  });

  test('reports none-before-selection when no credential was ever chosen', () => {
    const event = buildRequestAuditEvent({ requestId: 'req-none', response: failedResponse });
    expect(event.account).toMatchObject({ accountEmail: null, attribution: 'none-before-selection' });
  });

  test('does not let the resolved account override the one already recorded on the context', () => {
    const event = buildRequestAuditEvent({
      requestId: 'req-keep',
      providerUuid: 'uuid-real',
      accountEmail: 'real@example.com',
      selectedAccount: { providerUuid: 'uuid-other', providerName: 'other', accountEmail: 'other@example.com' },
      response: failedResponse
    });
    expect(event.account).toMatchObject({ accountEmail: 'real@example.com', attribution: 'used' });
  });

  test('resolveAuditAccountCandidate prefers the used credential, then the last attempt, then the routing selection', () => {
    expect(resolveAuditAccountCandidate({ providerUuid: 'a', requestAttempts: [{ providerUuid: 'b' }], _codexRouting: { selectedProviderUuid: 'c' } }))
      .toEqual({ uuid: 'a', attribution: 'used' });
    expect(resolveAuditAccountCandidate({ requestAttempts: [{ providerUuid: 'b' }], _codexRouting: { selectedProviderUuid: 'c' } }))
      .toEqual({ uuid: 'b', attribution: 'used' });
    expect(resolveAuditAccountCandidate({ _codexRouting: { selectedProviderUuid: 'c' } }))
      .toEqual({ uuid: 'c', attribution: 'selected-not-sent' });
    expect(resolveAuditAccountCandidate({})).toEqual({ uuid: null, attribution: 'none-before-selection' });
  });
});
