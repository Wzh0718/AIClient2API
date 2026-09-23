import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { createAsyncActivityTracker } from '../src/services/async-activity-tracker.js';
import { createShutdownCoordinator } from '../src/services/shutdown-coordinator.js';

function createDeferredServer() {
    let closeCallback;
    const server = {
        close: jest.fn(callback => {
            closeCallback = callback;
        }),
        closeAllConnections: jest.fn()
    };

    return {
        server,
        finishClose(error) {
            closeCallback?.(error);
        }
    };
}

function flushAsyncWork() {
    return new Promise(resolve => setImmediate(resolve));
}

function createHarness({ server, ...overrides } = {}) {
    const calls = [];
    const dependencies = {
        getServer: () => server ?? null,
        onShutdownRequested: jest.fn(),
        waitForStartup: jest.fn(async () => {}),
        stopBackgroundServices: jest.fn(async () => {
            calls.push('background');
        }),
        waitForInFlightHandlers: jest.fn(async () => {}),
        destroyPlugins: jest.fn(async () => {
            calls.push('plugins');
        }),
        stopTlsSidecar: jest.fn(async () => {
            calls.push('tls');
        }),
        exit: jest.fn(),
        logger: {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        },
        drainTimeoutMs: 50,
        totalTimeoutMs: 500,
        ...overrides
    };

    return {
        calls,
        dependencies,
        shutdown: createShutdownCoordinator(dependencies)
    };
}

afterEach(() => {
    jest.useRealTimers();
});

describe('API server shutdown coordinator', () => {
    test('keeps an HTTP request active until both its handler and response lifecycle settle', async () => {
        const tracker = createAsyncActivityTracker();
        const response = new EventEmitter();
        response.writableEnded = false;
        response.destroyed = false;
        let releaseHandler;
        const handlerBarrier = new Promise(resolve => {
            releaseHandler = resolve;
        });
        const handler = tracker.wrapHttpHandler(async () => {
            await handlerBarrier;
        });

        const handlerPromise = handler({}, response);
        let idle = false;
        const idlePromise = tracker.waitForIdle().then(() => {
            idle = true;
        });

        response.writableEnded = true;
        response.emit('finish');
        await flushAsyncWork();
        expect(idle).toBe(false);

        releaseHandler();
        await handlerPromise;
        await idlePromise;
        expect(idle).toBe(true);
    });

    test('keeps an HTTP request active after its handler returns until the response closes', async () => {
        const tracker = createAsyncActivityTracker();
        const response = new EventEmitter();
        response.writableEnded = false;
        response.destroyed = false;
        const handler = tracker.wrapHttpHandler(() => undefined);

        const handlerPromise = handler({}, response);
        let idle = false;
        const idlePromise = tracker.waitForIdle().then(() => {
            idle = true;
        });
        await flushAsyncWork();

        expect(idle).toBe(false);
        response.destroyed = true;
        response.emit('close');
        await handlerPromise;
        await idlePromise;
        expect(idle).toBe(true);
    });

    test('exposes a real startup gate that closes immediately and rejects later startup stages', async () => {
        const activityModule = await import('../src/services/async-activity-tracker.js');
        expect(typeof activityModule.createStartupShutdownGate).toBe('function');

        const logger = { info: jest.fn() };
        const gate = activityModule.createStartupShutdownGate({ logger });
        expect(gate.shouldAbort('plugin discovery')).toBe(false);

        gate.requestShutdown();

        expect(gate.isShutdownRequested()).toBe(true);
        expect(gate.shouldAbort('HTTP listen')).toBe(true);
        expect(logger.info).toHaveBeenCalledWith(
            '[Initialization] Shutdown requested; stopping before HTTP listen'
        );
    });

    test('waits for HTTP ingress to close before stopping background work or destroying plugins', async () => {
        const deferred = createDeferredServer();
        const harness = createHarness({ server: deferred.server });

        const shutdownPromise = harness.shutdown({ trigger: 'SIGTERM' });

        expect(deferred.server.close).toHaveBeenCalledTimes(1);
        expect(harness.dependencies.stopBackgroundServices).not.toHaveBeenCalled();
        expect(harness.dependencies.destroyPlugins).not.toHaveBeenCalled();

        deferred.finishClose();
        await shutdownPromise;

        expect(harness.calls).toEqual(['background', 'plugins', 'tls']);
        expect(harness.dependencies.exit).toHaveBeenCalledWith(0);
    });

    test('does not destroy plugins until an active provider refresh has drained', async () => {
        let releaseRefresh;
        const refreshBarrier = new Promise(resolve => {
            releaseRefresh = resolve;
        });
        const providerPoolManager = {
            shutdownRefreshQueue: jest.fn(() => refreshBarrier)
        };
        const harness = createHarness({
            stopBackgroundServices: jest.fn(async () => {
                await providerPoolManager.shutdownRefreshQueue();
                harness.calls.push('background');
            })
        });

        const shutdownPromise = harness.shutdown({ trigger: 'SIGTERM' });
        await flushAsyncWork();

        expect(providerPoolManager.shutdownRefreshQueue).toHaveBeenCalledTimes(1);
        expect(harness.dependencies.destroyPlugins).not.toHaveBeenCalled();

        releaseRefresh();
        await shutdownPromise;
        expect(harness.calls).toEqual(['background', 'plugins', 'tls']);
    });

    test('waits for finish after handler calls end but writableFinished is still false', async () => {
        const tracker = createAsyncActivityTracker();
        const response = new EventEmitter();
        response.writableEnded = false;
        response.writableFinished = false;
        response.destroyed = false;
        const handler = tracker.wrapHttpHandler((_request, res) => {
            res.writableEnded = true;
        });

        const handlerPromise = handler({}, response);
        let idle = false;
        const idlePromise = tracker.waitForIdle().then(() => { idle = true; });
        await flushAsyncWork();

        expect(idle).toBe(false);
        response.writableFinished = true;
        response.emit('finish');
        await handlerPromise;
        await idlePromise;
        expect(idle).toBe(true);
    });

    test('waits for an async request handler to settle after the socket close callback before freezing plugin state', async () => {
        const tracker = createAsyncActivityTracker();
        let releaseHandler;
        let mutationVersion = 0;
        let persistedVersion = null;
        const handlerBarrier = new Promise(resolve => {
            releaseHandler = resolve;
        });
        const trackedHandler = tracker.wrap(async () => {
            await handlerBarrier;
            mutationVersion += 1;
        });
        const handlerPromise = trackedHandler();
        const server = {
            close: jest.fn(callback => callback()),
            closeAllConnections: jest.fn()
        };
        const harness = createHarness({
            server,
            waitForInFlightHandlers: () => tracker.waitForIdle(),
            destroyPlugins: jest.fn(async () => {
                harness.calls.push('plugins');
                persistedVersion = mutationVersion;
            })
        });

        const shutdownPromise = harness.shutdown({ trigger: 'SIGTERM' });
        await flushAsyncWork();

        expect(server.close).toHaveBeenCalledTimes(1);
        expect(harness.dependencies.stopBackgroundServices).not.toHaveBeenCalled();
        expect(harness.dependencies.destroyPlugins).not.toHaveBeenCalled();

        releaseHandler();
        await handlerPromise;
        await shutdownPromise;

        expect(mutationVersion).toBe(1);
        expect(persistedVersion).toBe(1);
        expect(harness.calls).toEqual(['background', 'plugins', 'tls']);
    });

    test('returns one shutdown promise and runs every dependency and exit only once', async () => {
        const deferred = createDeferredServer();
        const harness = createHarness({ server: deferred.server });

        const first = harness.shutdown({ trigger: 'master-message' });
        const second = harness.shutdown({ trigger: 'SIGTERM' });

        expect(second).toBe(first);
        expect(deferred.server.close).toHaveBeenCalledTimes(1);

        deferred.finishClose();
        await first;

        expect(harness.dependencies.stopBackgroundServices).toHaveBeenCalledTimes(1);
        expect(harness.dependencies.destroyPlugins).toHaveBeenCalledTimes(1);
        expect(harness.dependencies.stopTlsSidecar).toHaveBeenCalledTimes(1);
        expect(harness.dependencies.exit).toHaveBeenCalledTimes(1);
    });

    test('marks shutdown intent immediately and waits for startup to abort before destroying plugins', async () => {
        let releaseInitialization;
        let shutdownRequested = false;
        let startupSettled = false;
        let startupPromise;
        const initializationBarrier = new Promise(resolve => {
            releaseInitialization = resolve;
        });
        const createListener = jest.fn();
        const installTimer = jest.fn();
        const sendReady = jest.fn();
        const harness = createHarness({
            onShutdownRequested: () => {
                shutdownRequested = true;
            },
            waitForStartup: () => startupPromise,
            destroyPlugins: jest.fn(async () => {
                harness.calls.push('plugins');
                expect(startupSettled).toBe(true);
            })
        });
        startupPromise = (async () => {
            await initializationBarrier;
            if (shutdownRequested) return;
            createListener();
            installTimer();
            sendReady();
        })().finally(() => {
            startupSettled = true;
        });

        const shutdownPromise = harness.shutdown({ trigger: 'SIGTERM' });

        expect(shutdownRequested).toBe(true);
        expect(harness.dependencies.destroyPlugins).not.toHaveBeenCalled();

        releaseInitialization();
        await startupPromise;
        await shutdownPromise;

        expect(createListener).not.toHaveBeenCalled();
        expect(installTimer).not.toHaveBeenCalled();
        expect(sendReady).not.toHaveBeenCalled();
        expect(harness.dependencies.destroyPlugins).toHaveBeenCalledTimes(1);
    });

    test('continues to TLS cleanup and exits with failure when plugin destruction fails', async () => {
        const server = {
            close: jest.fn(callback => callback()),
            closeAllConnections: jest.fn()
        };
        const pluginError = new AggregateError([new Error('flush failed')], 'plugin destroy failed');
        const harness = createHarness({
            server,
            destroyPlugins: jest.fn(async () => {
                harness.calls.push('plugins');
                throw pluginError;
            })
        });

        await harness.shutdown({ trigger: 'SIGINT' });

        expect(harness.calls).toEqual(['background', 'plugins', 'tls']);
        expect(harness.dependencies.stopTlsSidecar).toHaveBeenCalledTimes(1);
        expect(harness.dependencies.exit).toHaveBeenCalledTimes(1);
        expect(harness.dependencies.exit).toHaveBeenCalledWith(1);
    });

    test('forces open connections after the drain deadline, then flushes and exits with failure', async () => {
        jest.useFakeTimers();
        const server = {
            close: jest.fn(),
            closeAllConnections: jest.fn()
        };
        const harness = createHarness({ server });

        const shutdownPromise = harness.shutdown({ trigger: 'disconnect' });
        await jest.advanceTimersByTimeAsync(50);
        await shutdownPromise;

        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
        expect(harness.calls).toEqual(['background', 'plugins', 'tls']);
        expect(harness.dependencies.exit).toHaveBeenCalledWith(1);
    });

    test('does not destroy plugins after forced socket close while an async handler remains active', async () => {
        jest.useFakeTimers();
        const tracker = createAsyncActivityTracker();
        tracker.wrap(async () => new Promise(() => {}))();
        const server = {
            close: jest.fn(),
            closeAllConnections: jest.fn()
        };
        const harness = createHarness({
            server,
            waitForInFlightHandlers: () => tracker.waitForIdle()
        });

        harness.shutdown({ trigger: 'SIGTERM' });
        await jest.advanceTimersByTimeAsync(50);

        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
        expect(harness.dependencies.stopBackgroundServices).not.toHaveBeenCalled();
        expect(harness.dependencies.destroyPlugins).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(450);

        expect(harness.dependencies.destroyPlugins).not.toHaveBeenCalled();
        expect(harness.dependencies.exit).toHaveBeenCalledWith(1);
    });

    test('exits with failure at the total deadline when later cleanup never settles', async () => {
        jest.useFakeTimers();
        const server = {
            close: jest.fn(callback => callback()),
            closeAllConnections: jest.fn()
        };
        const harness = createHarness({
            server,
            destroyPlugins: jest.fn(() => new Promise(() => {}))
        });

        harness.shutdown({ trigger: 'SIGTERM' });
        await jest.advanceTimersByTimeAsync(500);

        expect(harness.dependencies.exit).toHaveBeenCalledTimes(1);
        expect(harness.dependencies.exit).toHaveBeenCalledWith(1);
    });

    test('raises the final exit code when a fatal trigger arrives during graceful shutdown', async () => {
        const deferred = createDeferredServer();
        const harness = createHarness({ server: deferred.server });

        const graceful = harness.shutdown({ exitCode: 0, trigger: 'SIGTERM' });
        const fatal = harness.shutdown({ exitCode: 1, trigger: 'uncaughtException' });

        expect(fatal).toBe(graceful);
        deferred.finishClose();
        await graceful;

        expect(harness.dependencies.exit).toHaveBeenCalledTimes(1);
        expect(harness.dependencies.exit).toHaveBeenCalledWith(1);
    });

    test('wires API server terminal events through the coordinator without callback exits', () => {
        const source = readFileSync('src/services/api-server.js', 'utf8');

        expect(source).toContain("import { createAsyncActivityTracker, createStartupShutdownGate } from './async-activity-tracker.js';");
        expect(source).toContain("import { createShutdownCoordinator } from './shutdown-coordinator.js';");
        expect(source).toContain("import { registerWorkerShutdownHandlers } from './worker-shutdown-handlers.js';");
        expect(source).toContain('const requestActivityTracker = createAsyncActivityTracker();');
        expect(source).toContain('const heartbeatActivityTracker = createAsyncActivityTracker();');
        expect(source).toContain('const healthCheckActivityTracker = createAsyncActivityTracker();');
        expect(source).toMatch(/if \(!IS_EXECUTION_WORKER && poolManager\) \{\s*providerRefreshRecoveryService = startProviderRefreshRecoveryService\(poolManager\);/);
        expect(source.indexOf('providerRefreshRecoveryService = startProviderRefreshRecoveryService(poolManager)'))
            .toBeLessThan(source.indexOf('const scheduledConfig = CONFIG.SCHEDULED_HEALTH_CHECK;'));
        expect(source).toContain("await stopOne('provider refresh recovery'");
        expect(source.indexOf("await stopOne('provider refresh recovery'"))
            .toBeLessThan(source.indexOf("await stopOne('provider refresh queue'"));
        expect(source).toContain('const startupShutdownGate = createStartupShutdownGate({ logger });');
        expect(source).toContain('const requestShutdown = createShutdownCoordinator({');
        expect(source).toContain('onShutdownRequested: () => startupShutdownGate.requestShutdown(),');
        expect(source).toContain('waitForStartup: () => startupPromise,');
        expect(source).toContain('waitForInFlightHandlers: () => requestActivityTracker.waitForIdle(),');
        expect(source).toContain('requestActivityTracker.wrapHttpHandler(requestHandlerInstance)');
        expect(source).toContain('pluginManager.destroyAll({ operationTimeoutMs: null })');
        expect(source).toContain('await heartbeatActivityTracker.waitForIdle();');
        expect(source).toContain('await healthCheckActivityTracker.waitForIdle();');
        expect(source).toContain('await providerPoolManager?.shutdownRefreshQueue();');
        expect(source).toContain('heartbeatActivityTracker.run(heartbeatAndRefreshToken)');
        expect(source).toContain('healthCheckActivityTracker.run(() => poolManager.performHealthChecks())');
        expect(source).toContain('startupPromise = startServer();');
        expect(source).toContain('const shutdownHandlers = registerWorkerShutdownHandlers({');
        expect(source).toContain('startupPromise.catch(shutdownHandlers.onStartFailure);');
        expect(source.match(/startupShutdownGate\.shouldAbort\(/g)?.length).toBeGreaterThanOrEqual(8);
        expect(source).toMatch(/function gracefulShutdown\(exitCode = 0\)[\s\S]*requestShutdown\(\{ exitCode \}\)/);
        expect(source).not.toMatch(/serverInstance\.close\([\s\S]{0,300}process\.exit/);
    });
});
