import { readFileSync } from 'fs';
import { describe, expect, jest, test } from '@jest/globals';

import * as oauthPopup from '../static/app/oauth-popup.js';

const {
    createOAuthPopupSession,
    isExpectedCodexOAuthCallbackMessage
} = oauthPopup;

function createValidCallbackEvent(authWindow, overrides = {}) {
    return {
        source: authWindow,
        origin: 'http://localhost:1455',
        data: {
            type: 'codex-oauth-callback-received',
            provider: 'openai-codex-oauth',
            sessionId: 'session-current'
        },
        ...overrides
    };
}

describe('Codex OAuth popup lifecycle UI source', () => {
    test('validates callback messages against the popup, callback origin, provider, and session', () => {
        const source = readFileSync('static/app/provider-manager.js', 'utf8');
        const authWindow = {};
        const context = {
            authWindow,
            expectedCallbackOrigin: 'http://localhost:1455',
            provider: 'openai-codex-oauth',
            sessionId: 'session-current'
        };

        expect(isExpectedCodexOAuthCallbackMessage(createValidCallbackEvent(authWindow), context)).toBe(true);

        expect(isExpectedCodexOAuthCallbackMessage(createValidCallbackEvent(authWindow, { source: {} }), context)).toBe(false);
        expect(isExpectedCodexOAuthCallbackMessage({
            source: authWindow,
            origin: 'http://evil.example',
            data: { type: 'codex-oauth-callback-received', provider: 'openai-codex-oauth', sessionId: 'session-current' }
        }, context)).toBe(false);
        expect(isExpectedCodexOAuthCallbackMessage({
            source: authWindow,
            origin: 'http://localhost:1455',
            data: { type: 'codex-oauth-callback-received', provider: 'gemini-cli-oauth', sessionId: 'session-current' }
        }, context)).toBe(false);
        expect(isExpectedCodexOAuthCallbackMessage({
            source: authWindow,
            origin: 'http://localhost:1455',
            data: { type: 'codex-oauth-callback-received', provider: 'openai-codex-oauth', sessionId: 'session-old' }
        }, context)).toBe(false);

        expect(source).toContain('isExpectedCodexOAuthCallbackMessage');
        expect(source).toContain('closeAuthWindow');
    });

    test('fails closed when the expected callback origin is missing', () => {
        const authWindow = {};
        const event = createValidCallbackEvent(authWindow);

        expect(isExpectedCodexOAuthCallbackMessage(event, {
            authWindow,
            provider: 'openai-codex-oauth',
            sessionId: 'session-current'
        })).toBe(false);
    });

    test('accepts legacy completion messages only from the current popup', () => {
        const validator = oauthPopup.isExpectedOAuthPopupCompleteMessage;
        expect(typeof validator).toBe('function');

        const authWindow = {};
        const context = {
            authWindow,
            expectedOrigin: 'https://admin.example',
            provider: 'gemini-cli-oauth'
        };
        const validEvent = {
            source: authWindow,
            origin: 'https://admin.example',
            data: {
                type: 'oauth-popup-complete',
                provider: 'gemini-cli-oauth'
            }
        };

        expect(validator(validEvent, context)).toBe(true);
        expect(validator({ ...validEvent, source: {} }, context)).toBe(false);
        expect(validator({ ...validEvent, origin: 'https://evil.example' }, context)).toBe(false);
        expect(validator({
            ...validEvent,
            data: { ...validEvent.data, provider: 'openai-codex-oauth' }
        }, context)).toBe(false);
    });

    test('registers popup listeners once and disposes every shared resource', () => {
        const eventTarget = {
            addEventListener: jest.fn(),
            removeEventListener: jest.fn()
        };
        const clearIntervalFn = jest.fn();
        const clearTimeoutFn = jest.fn();
        const popup = { close: jest.fn() };
        const session = createOAuthPopupSession({
            eventTarget,
            onSuccess: jest.fn(),
            onError: jest.fn(),
            onMessage: jest.fn(),
            setIntervalFn: jest.fn(() => 'poll-timer'),
            clearIntervalFn,
            setTimeoutFn: jest.fn(() => 'listener-timer'),
            clearTimeoutFn
        });

        expect(session.registerListeners()).toBe(true);
        expect(session.registerListeners()).toBe(false);
        expect(eventTarget.addEventListener).toHaveBeenCalledTimes(3);

        session.setAuthWindow(popup);
        session.startPopupPolling(jest.fn());
        session.dispose();

        expect(eventTarget.removeEventListener).toHaveBeenCalledTimes(3);
        expect(clearIntervalFn).toHaveBeenCalledWith('poll-timer');
        expect(clearTimeoutFn).toHaveBeenCalledWith('listener-timer');
        expect(popup.close).toHaveBeenCalledTimes(1);
        expect(session.getAuthWindow()).toBeNull();
    });

    test('can register listeners before opening while rearming timeout per popup attempt', () => {
        const eventTarget = {
            addEventListener: jest.fn(),
            removeEventListener: jest.fn()
        };
        const setTimeoutFn = jest.fn()
            .mockReturnValueOnce('first-timeout')
            .mockReturnValueOnce('second-timeout');
        const clearTimeoutFn = jest.fn();
        const session = createOAuthPopupSession({
            eventTarget,
            onSuccess: jest.fn(),
            onError: jest.fn(),
            onMessage: jest.fn(),
            setTimeoutFn,
            clearTimeoutFn,
            armTimeoutOnRegister: false
        });

        session.registerListeners();
        expect(setTimeoutFn).not.toHaveBeenCalled();

        session.armListenerTimeout();
        session.armListenerTimeout(1500);
        expect(setTimeoutFn).toHaveBeenCalledTimes(2);
        expect(clearTimeoutFn).toHaveBeenCalledWith('first-timeout');
        expect(setTimeoutFn).toHaveBeenLastCalledWith(expect.any(Function), 1500);

        session.stopListenerTimeout();
        expect(clearTimeoutFn).toHaveBeenCalledWith('second-timeout');
        expect(session.isListening()).toBe(true);
    });

    test('keeps SSE success authoritative and exposes an OAuth error event', () => {
        const providerSource = readFileSync('static/app/provider-manager.js', 'utf8');
        const eventSource = readFileSync('static/app/event-stream.js', 'utf8');

        expect(providerSource).toContain('onError: handleOAuthError');
        expect(providerSource).toContain('matchesCurrentOAuthSession');
        expect(providerSource).toContain('authInfo.sessionId && data.sessionId !== authInfo.sessionId');
        expect(eventSource).toContain("newEventSource.addEventListener('oauth_error'");
        expect(eventSource).toContain("new CustomEvent('oauth_error_event'");
    });

    test('isolates Qwen and Kiro device-code terminal events by their current session', () => {
        const providerSource = readFileSync('static/app/provider-manager.js', 'utf8');
        const qwenSource = readFileSync('src/auth/qwen-oauth.js', 'utf8');
        const kiroSource = readFileSync('src/auth/kiro-oauth.js', 'utf8');

        expect(providerSource).toContain('if (authInfo.sessionId && data.sessionId !== authInfo.sessionId) return false;');
        expect(qwenSource.match(/sessionId: taskId/g)).toHaveLength(3);
        expect(kiroSource.match(/sessionId: taskId/g)).toHaveLength(3);
    });

    test('locks repeated popup opens and regenerates a fresh Codex session after errors', () => {
        const providerSource = readFileSync('static/app/provider-manager.js', 'utf8');
        const i18nSource = readFileSync('static/app/i18n.js', 'utf8');

        expect(providerSource).toContain('let requiresFreshOAuthSession = false');
        expect(providerSource).toContain('setAuthorizationBusy(true)');
        expect(providerSource).toContain('requiresFreshOAuthSession = true');
        expect(providerSource).toContain('executeGenerateAuthUrl(authInfo.provider, retryOptions)');
        expect(providerSource).toContain('authInfo.proxyOverrideProvided');
        expect(i18nSource.match(/'oauth\.modal\.retry'/g)).toHaveLength(2);
        expect(i18nSource.match(/'oauth\.modal\.timeout'/g)).toHaveLength(2);
        expect(i18nSource.match(/'oauth\.modal\.popupClosedPending'/g)).toHaveLength(2);
    });

    test('shares popup state across reopens and restores the open button after an early close', () => {
        const providerSource = readFileSync('static/app/provider-manager.js', 'utf8');
        const registerIndex = providerSource.indexOf('popupSession.registerListeners()');
        const openHandlerIndex = providerSource.indexOf("openBtn.addEventListener('click'");

        expect(providerSource).toContain('createOAuthPopupSession');
        expect(providerSource).toContain('popupSession.registerListeners()');
        expect(registerIndex).toBeGreaterThan(-1);
        expect(openHandlerIndex).toBeGreaterThan(registerIndex);
        expect(providerSource).toMatch(/if \(authInfo\.provider === 'openai-codex-oauth'\) \{\s*popupSession\.registerListeners\(\);\s*\}/);
        expect(providerSource).toContain('armTimeoutOnRegister: false');
        expect(providerSource).toContain('popupSession.armListenerTimeout()');
        expect(providerSource).toContain('const handlePopupClosed = () =>');
        expect(providerSource).toContain('popupSession.armListenerTimeout(OAUTH_FINALIZATION_TIMEOUT_MS)');
        expect(providerSource).toContain('popupCloseGraceTimer = setTimeout');
        expect(providerSource).toContain('regenerateBtn.disabled = true');
        expect(providerSource).toContain('popupSession.setAuthWindow(null)');
        expect(providerSource).toContain('openBtn.disabled = false');
    });

    test('pre-registers listeners only for Codex and registers legacy listeners after opening the popup', () => {
        const providerSource = readFileSync('static/app/provider-manager.js', 'utf8').replace(/\r\n/g, '\n');

        expect(providerSource).toContain("if (authInfo.provider === 'openai-codex-oauth') {\n        popupSession.registerListeners();\n    }");
        expect(providerSource).toContain('popupSession.setAuthWindow(authWindow);\n        popupSession.registerListeners();');
    });

    test('accepts legacy completion messages only from the current popup window', () => {
        const providerSource = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(providerSource).toContain('isExpectedOAuthPopupCompleteMessage(event, {');
        expect(providerSource).toContain('authWindow: popupSession?.getAuthWindow()');
        expect(providerSource).toContain('expectedOrigin: window.location.origin');
    });

    test('locks regeneration and manual callback submission while authorization is processing', () => {
        const providerSource = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(providerSource).toContain('const setAuthorizationBusy = (busy) =>');
        expect(providerSource).toContain('regenerateBtn.disabled = isAuthorizationBusy');
        expect(providerSource).toContain('regenerateBuilderIdBtn.disabled = isAuthorizationBusy');
        expect(providerSource).toContain('const setManualCallbackBusy = (busy) =>');
        expect(providerSource).toContain('if (isManualCallbackSubmitting) return');
    });

    test('cleans the popup lifecycle when the authorization modal is closed', () => {
        const providerSource = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(providerSource).toContain('const closeAuthModal = () =>');
        expect(providerSource).toContain('popupSession?.dispose()');
    });

    test('keeps Codex manual callback success pending until the matching SSE event', () => {
        const providerSource = readFileSync('static/app/provider-manager.js', 'utf8');
        const manualStart = providerSource.indexOf("window.apiClient.post('/oauth/manual-callback'");
        const manualEnd = providerSource.indexOf('const ensureManualCallbackControls', manualStart);
        const manualSource = providerSource.slice(manualStart, manualEnd);
        const codexStart = manualSource.indexOf("if (authInfo.provider === 'openai-codex-oauth')");
        const codexElse = manualSource.indexOf('} else {', codexStart);
        const codexSuccessSource = manualSource.slice(codexStart, codexElse);
        const legacySuccessSource = manualSource.slice(codexElse);
        const requestCatchStart = manualSource.indexOf("console.error('OAuth manual callback request failed')");
        const requestCatchSource = manualSource.slice(requestCatchStart);

        expect(manualSource).toContain("authInfo.provider === 'openai-codex-oauth'");
        expect(manualSource).toContain("showAuthStatus(t('oauth.processing'), 'info')");
        expect(codexSuccessSource).not.toContain('handleOAuthSuccess()');
        expect(legacySuccessSource).toContain('handleOAuthSuccess()');
        expect(requestCatchSource).toContain("if (authInfo.provider === 'openai-codex-oauth')");
        expect(requestCatchSource).toContain('popupSession.dispose()');
        expect(requestCatchSource).toContain('showRetryState(error.message');
    });

    test('keeps waiting for Codex SSE when a manual callback response is lost after submission', () => {
        const providerSource = readFileSync('static/app/provider-manager.js', 'utf8');
        const manualStart = providerSource.indexOf("window.apiClient.post('/oauth/manual-callback'");
        const manualEnd = providerSource.indexOf('const ensureManualCallbackControls', manualStart);
        const manualSource = providerSource.slice(manualStart, manualEnd);
        const requestCatchStart = manualSource.indexOf("console.error('OAuth manual callback request failed')");
        const requestCatchSource = manualSource.slice(requestCatchStart);

        expect(requestCatchSource).toContain('if (!modal.isConnected) return;');
        expect(requestCatchSource).toContain('const isDefiniteCallbackFailure = Number.isInteger(error?.status)');
        expect(requestCatchSource).toContain('if (isDefiniteCallbackFailure) {');
        expect(requestCatchSource).toContain('popupSession.armListenerTimeout(OAUTH_FINALIZATION_TIMEOUT_MS)');
        expect(requestCatchSource).toContain("showAuthStatus(t('oauth.processing'), 'info')");
    });

    test('uses timeout as a terminal retry state and does not log callback secrets', () => {
        const providerSource = readFileSync('static/app/provider-manager.js', 'utf8');

        expect(providerSource).toContain('onTimeout: () =>');
        expect(providerSource).toContain("showRetryState(t('oauth.modal.timeout'))");
        expect(providerSource).not.toContain("console.error('Failed to process OAuth callback:', error)");
        expect(providerSource).not.toContain("console.error('OAuth manual callback request failed:', error)");
        expect(providerSource).not.toContain("console.log('Detected code only input");
    });
});
