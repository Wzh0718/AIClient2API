import fs from 'node:fs';

describe('runtime durable hook integration source', () => {
    test('workers wire Redis stream transport, polling, metrics, and shutdown drain', () => {
        const server = fs.readFileSync('src/services/api-server.js', 'utf8').replace(/\r\n/g, '\n');
        const plugins = fs.readFileSync('src/core/plugin-manager.js', 'utf8').replace(/\r\n/g, '\n');
        const runtime = fs.readFileSync('src/runtime/multi-worker-runtime.js', 'utf8').replace(/\r\n/g, '\n');

        expect(server).toContain('createRuntimeHookStreamFromEnv');
        expect(server).toContain('runtimeHookStream.readBatch');
        expect(server).toContain('runtimeHookConsumer.consume(event)');
        expect(server).toContain('runtimeHookBridge?.snapshot?.()');
        expect(server).toContain("await runtimeHookStream?.flushSpool?.()");
        expect(plugins).toContain('configureRuntimeHookBridge');
        expect(server).toContain('runtimeHookStreamStatus = { pending: 0, consumerLag: 0, available: false');
        expect(runtime).toContain('metrics.hooks.pending + metrics.hooks.spooled + metrics.hooks.consumerLag');
        expect(runtime).toContain("metrics.hooks.available === false ? 'degraded'");
    });
});
