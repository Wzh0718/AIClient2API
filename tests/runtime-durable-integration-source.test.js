import fs from 'node:fs';

describe('runtime durable hook integration source', () => {
    test('workers wire Redis stream transport, polling, metrics, and shutdown drain', () => {
        const server = fs.readFileSync('src/services/api-server.js', 'utf8').replace(/\r\n/g, '\n');
        const plugins = fs.readFileSync('src/core/plugin-manager.js', 'utf8').replace(/\r\n/g, '\n');
        const runtime = fs.readFileSync('src/runtime/multi-worker-runtime.js', 'utf8').replace(/\r\n/g, '\n');
        const ledgerStore = fs.readFileSync('src/runtime/usage-event-store-worker.js', 'utf8').replace(/\r\n/g, '\n');
        const potluckStore = fs.readFileSync('src/plugins/api-potluck/usage-history-store.js', 'utf8').replace(/\r\n/g, '\n');
        const modelStore = fs.readFileSync('src/plugins/model-usage-stats/sqlite-store.js', 'utf8').replace(/\r\n/g, '\n');

        expect(server).toContain('createRuntimeHookStreamFromEnv');
        expect(server).toContain('runtimeHookStream.readBatch');
        expect(server).toContain('runtimeHookConsumer.consumeBatch(events)');
        expect(server).toContain('RuntimeUsageProjector');
        expect(server).toContain('scheduleProjections');
        expect(server).toContain('let usageProjectionRefreshPromise = null');
        expect(server).toContain('let usageProjectionRefreshRequested = false');
        expect(server).toContain('scheduleProjections: scheduleUsageProjectionRefresh');
        expect(server).toMatch(/function scheduleUsageProjectionRefresh\(\)[\s\S]*if \(usageProjectionRefreshPromise\) return usageProjectionRefreshPromise;[\s\S]*await runtimeUsageProjector\?\.schedule\?\.\(\);[\s\S]*usageEventStoreSnapshot = await usageEventStore\.snapshot\(\);/);
        expect(server).not.toContain('await runtimeUsageProjector.schedule();');
        expect(server).toContain("scheduleUsageProjectionRefresh().catch(error => logger.error('[Usage Projection] Startup drain failed:', error.message))");
        expect(server).toContain('executeUsageProjection');
        expect(server).toContain('onFatalProjectionError');
        expect(server).toContain('onProgress: async () =>');
        expect(server).toContain('process.exit(1)');
        expect(plugins).toContain('executeUsageProjectionBatch');
        expect(server).toContain('await runtimeUsageProjector?.drain?.()');
        expect(runtime).toContain("if (message?.type === 'runtime_metrics' && message.snapshot)");
        expect(runtime).toContain('ready.add(id)');
        expect(server).toContain('runtimeHookBridge?.snapshot?.()');
        expect(server).toContain("await runtimeHookStream?.flushSpool?.()");
        expect(plugins).toContain('configureRuntimeHookBridge');
        expect(server).toContain('runtimeHookStreamStatus = { pending: 0, consumerLag: 0, available: false');
        expect(runtime).toContain('metrics.hooks.pending + metrics.hooks.spooled + metrics.hooks.consumerLag');
        expect(runtime).toContain('resolveRuntimeHealthStatus({ topologyReady, metrics })');
        expect(runtime).toContain("metrics?.temporaryRouting?.calendarDegraded === true");
        expect(ledgerStore).toContain("db.pragma('synchronous = FULL')");
        expect(potluckStore).toContain("database.pragma('synchronous = NORMAL')");
        expect(modelStore).toContain("database.pragma('synchronous = NORMAL')");
        expect(potluckStore).toContain('let usageEventStatements = null');
        expect(modelStore).toContain('let modelEventStatements = null');
    });
});
