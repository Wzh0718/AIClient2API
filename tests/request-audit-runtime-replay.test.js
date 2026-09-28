import { RuntimeHookBridge } from '../src/runtime/runtime-hook-bridge.js';
import plugin from '../src/plugins/request-audit/index.js';

describe('Codex audit replay across workers', () => {
    test('completion-first replay keeps two accounts and usage isolated', async () => {
        const stored = [];
        const published = [];
        await plugin.init({
            REQUEST_AUDIT_ENABLED: true,
            REQUEST_AUDIT_ANALYZER_ENABLED: false,
            _requestAuditStore: { append: async event => stored.push(event), cleanup: async () => {} },
            _gptRequestStore: { append: () => {}, close: () => {} },
            _gptDiagnosticsRunner: {}
        });
        try {
            const bridge = new RuntimeHookBridge({
                send: () => {},
                durableTransport: {
                    publish: async message => { published.push(message); return { persisted: true, spooled: true }; },
                    acknowledge: async () => {}
                }
            });
            for (const [requestId, email, model, tokens] of [
                ['request-a', 'a@example.com', 'gpt-6-astra', 110],
                ['request-b', 'b@example.com', 'gpt-6-luna', 240]
            ]) {
                await bridge.handle('onStreamChunk', {
                    requestId, model, toProvider: 'openai-codex-oauth', accountEmail: email,
                    nativeChunk: { usage: { input_tokens: tokens - 10, output_tokens: 10, total_tokens: tokens } }
                });
                await bridge.handle('onContentGenerated', {
                    requestId, _requestAuditLifecycle: true,
                    model, toProvider: 'openai-codex-oauth', accountEmail: email,
                    originalRequestBody: { model }
                });
                await bridge.handle('onRequestCompleted', {
                    requestId, _requestAuditLifecycle: true,
                    path: '/openai-codex-oauth/v1/responses',
                    originalRequestBody: { model },
                    response: { httpStatus: 200, completed: true }
                });
            }
            for (const message of published.filter(item => item.hookName === 'onRequestCompleted')) {
                await plugin.hooks.onRequestCompleted({ ...message.args[0], _runtimeEventId: message.eventId });
            }
            for (const message of published.filter(item => item.hookName === 'onContentGenerated')) {
                await plugin.hooks.onContentGenerated({ ...message.args[0], _runtimeEventId: message.eventId });
            }
            expect(stored).toHaveLength(2);
            expect(stored.map(event => [event.requestId, event.account.accountEmail, event.request.requestedModel, event.usage.totalTokens, event.capture.status])).toEqual([
                ['request-a', 'a@example.com', 'gpt-6-astra', 110, 'complete'],
                ['request-b', 'b@example.com', 'gpt-6-luna', 240, 'complete']
            ]);
            expect(stored[0].eventId).toBe('request-audit:request-a');
            expect(stored[1].eventId).toBe('request-audit:request-b');
        } finally {
            await plugin.destroy();
        }
    });
});
