import http from 'http';
import path from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { createRuntimeProxyHandler } from './runtime-proxy.js';
import { resolveWorkerTopology } from './worker-topology.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerScript = path.join(__dirname, '../services/api-server.js');

function addMapValues(target, source = {}) {
    for (const [key, value] of Object.entries(source)) target[key] = (target[key] || 0) + Number(value || 0);
}

export function aggregateWorkerMetrics(workerSnapshots = new Map()) {
    const result = {
        requests: { total: 0, success: 0, failed: 0, byWorker: {}, byKind: {} },
        stages: { byWorker: {} },
        output: { bytes: 0, backpressureMs: 0 },
        hooks: { pending: 0, spooled: 0, spoolBytes: 0, dropped: 0, backpressured: 0, consumerLag: 0, oldestPendingAgeMs: 0, available: true, unavailableWorkers: [], byWorker: {} },
        imageCapacity: {
            activeBytes: 0,
            queued: 0,
            globalUsedBytes: 0,
            globalBudgetBytes: 0,
            overcommitted: 0,
            coordinationFailures: 0,
            redisDegraded: false,
            byWorker: {}
        },
        pricingDiagnostics: {
            estimatedAverageCount: 0,
            estimatedAverageTokens: 0,
            estimatedAverageUsd: 0,
            missingPriceCount: 0,
            missingPriceTokens: 0,
            lastEstimatedAt: null,
            lastMissingAt: null,
            byWorker: {}
        },
        temporaryRouting: {
            scheduledBypasses: 0,
            calendarDegraded: false,
            missingCalendarYears: [],
            byWorker: {}
        },
        inFlight: 0,
        process: { rss: 0, heapUsed: 0, maxEventLoopUtilization: 0, eventLoopDelay: { p95: 0, p99: 0, max: 0 } },
        providerCoordination: {
            byWorker: {},
            geminiScheduling: {
                cooldownWrites: 0,
                probeAcquired: 0,
                probeRejected: 0,
                rateLimited: 0,
                retryAttempts: 0,
                fallbacks: 0,
                byModel: {}
            }
        }
    };
    for (const [workerId, snapshot] of workerSnapshots.entries()) {
        result.requests.total += Number(snapshot?.requests?.total || 0);
        result.requests.success += Number(snapshot?.requests?.success || 0);
        result.requests.failed += Number(snapshot?.requests?.failed || 0);
        addMapValues(result.requests.byWorker, snapshot?.requests?.byWorker);
        addMapValues(result.requests.byKind, snapshot?.requests?.byKind);
        if (snapshot?.stages) {
            result.stages.byWorker[workerId] = snapshot.stages;
            for (const [stageName, stage] of Object.entries(snapshot.stages)) {
                const aggregate = result.stages[stageName] || {
                    count: 0,
                    p50: 0,
                    p95: 0,
                    p99: 0,
                    max: 0
                };
                aggregate.count += Number(stage?.count || 0);
                for (const field of ['p50', 'p95', 'p99', 'max']) {
                    aggregate[field] = Math.max(aggregate[field], Number(stage?.[field] || 0));
                }
                result.stages[stageName] = aggregate;
            }
        }
        result.output.bytes += Number(snapshot?.output?.bytes || 0);
        result.output.backpressureMs += Number(snapshot?.output?.backpressureMs || 0);
        result.inFlight += Number(snapshot?.inFlight || 0);
        if (snapshot?.hooks) {
            result.hooks.byWorker[workerId] = snapshot.hooks;
            if (snapshot.hooks.available === false) {
                result.hooks.available = false;
                result.hooks.unavailableWorkers.push(workerId);
            }
            for (const field of ['pending', 'spooled', 'spoolBytes', 'dropped', 'backpressured', 'consumerLag']) {
                result.hooks[field] += Number(snapshot.hooks[field] || 0);
            }
            result.hooks.oldestPendingAgeMs = Math.max(result.hooks.oldestPendingAgeMs, Number(snapshot.hooks.oldestPendingAgeMs || 0));
        }
        result.process.rss += Number(snapshot?.process?.rss || 0);
        result.process.heapUsed += Number(snapshot?.process?.heapUsed || 0);
        result.process.maxEventLoopUtilization = Math.max(result.process.maxEventLoopUtilization, Number(snapshot?.process?.eventLoopUtilization || 0));
        result.process.eventLoopDelay.p95 = Math.max(result.process.eventLoopDelay.p95, Number(snapshot?.process?.eventLoopDelay?.p95 || 0));
        result.process.eventLoopDelay.p99 = Math.max(result.process.eventLoopDelay.p99, Number(snapshot?.process?.eventLoopDelay?.p99 || 0));
        result.process.eventLoopDelay.max = Math.max(result.process.eventLoopDelay.max, Number(snapshot?.process?.eventLoopDelay?.max || 0));
        if (snapshot?.imageCapacity) {
            result.imageCapacity.byWorker[workerId] = snapshot.imageCapacity;
            result.imageCapacity.activeBytes += Number(snapshot.imageCapacity.activeBytes || 0);
            result.imageCapacity.queued += Number(snapshot.imageCapacity.queued || 0);
            result.imageCapacity.globalUsedBytes = Math.max(result.imageCapacity.globalUsedBytes, Number(snapshot.imageCapacity.globalUsedBytes || 0));
            result.imageCapacity.globalBudgetBytes = Math.max(result.imageCapacity.globalBudgetBytes, Number(snapshot.imageCapacity.globalBudgetBytes || 0));
            result.imageCapacity.overcommitted += Number(snapshot.imageCapacity.overcommitted || 0);
            result.imageCapacity.coordinationFailures += Number(snapshot.imageCapacity.coordinationFailures || 0);
            result.imageCapacity.redisDegraded ||= snapshot.imageCapacity.redisDegraded === true;
        }
        if (snapshot?.pricingDiagnostics) {
            result.pricingDiagnostics.byWorker[workerId] = snapshot.pricingDiagnostics;
            for (const field of ['estimatedAverageCount', 'estimatedAverageTokens', 'estimatedAverageUsd', 'missingPriceCount', 'missingPriceTokens']) {
                result.pricingDiagnostics[field] += Number(snapshot.pricingDiagnostics[field] || 0);
            }
            for (const field of ['lastEstimatedAt', 'lastMissingAt']) {
                const current = result.pricingDiagnostics[field];
                const candidate = snapshot.pricingDiagnostics[field];
                if (candidate && (!current || candidate > current)) result.pricingDiagnostics[field] = candidate;
            }
        }
        if (snapshot?.temporaryRouting) {
            result.temporaryRouting.byWorker[workerId] = snapshot.temporaryRouting;
            result.temporaryRouting.scheduledBypasses += Number(snapshot.temporaryRouting.scheduledBypasses || 0);
            result.temporaryRouting.calendarDegraded ||= snapshot.temporaryRouting.calendarDegraded === true;
            result.temporaryRouting.missingCalendarYears.push(
                ...(Array.isArray(snapshot.temporaryRouting.missingCalendarYears)
                    ? snapshot.temporaryRouting.missingCalendarYears.map(Number).filter(Number.isInteger)
                    : [])
            );
        }
        if (snapshot?.providerCoordination) {
            result.providerCoordination.byWorker[workerId] = snapshot.providerCoordination;
            for (const field of ['cooldownWrites', 'probeAcquired', 'probeRejected', 'rateLimited', 'retryAttempts', 'fallbacks']) {
                result.providerCoordination.geminiScheduling[field] += Number(snapshot.providerCoordination?.geminiScheduling?.[field] || 0);
            }
            for (const [model, modelSnapshot] of Object.entries(snapshot.providerCoordination?.geminiScheduling?.byModel || {})) {
                const aggregate = result.providerCoordination.geminiScheduling.byModel[model] || {
                    schedulable: 0,
                    cooling: 0,
                    quotaUnknown: 0
                };
                for (const field of ['schedulable', 'cooling', 'quotaUnknown']) {
                    aggregate[field] = Math.max(aggregate[field], Number(modelSnapshot?.[field] || 0));
                }
                result.providerCoordination.geminiScheduling.byModel[model] = aggregate;
            }
        }
    }
    result.temporaryRouting.missingCalendarYears = [...new Set(result.temporaryRouting.missingCalendarYears)]
        .sort((a, b) => a - b);
    return result;
}

export function resolveRuntimeHealthStatus({ topologyReady, metrics } = {}) {
    if (!topologyReady) return 'starting';
    if (metrics?.hooks?.available === false || metrics?.temporaryRouting?.calendarDegraded === true) {
        return 'degraded';
    }
    return 'healthy';
}

export async function shutdownWorkerStages({
    closeProxy,
    stopRole,
    getBacklog,
    wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
    drainTimeoutMs = 30000
} = {}) {
    await closeProxy();
    await stopRole('execution');
    const deadline = Date.now() + drainTimeoutMs;
    while (Number(getBacklog?.() || 0) > 0 && Date.now() < deadline) await wait(50);
    const remainingBacklog = Number(getBacklog?.() || 0);
    await stopRole('control');
    return { drained: remainingBacklog === 0, remainingBacklog };
}

export function createProviderConfigAckTracker() {
    let currentRevision = 0;
    const appliedRevisions = new Map();
    return {
        notePublished(revision, workerIds = []) {
            currentRevision = Math.max(currentRevision, Number(revision || 0));
            for (const workerId of workerIds) {
                if (!appliedRevisions.has(workerId)) appliedRevisions.set(workerId, 0);
            }
        },
        acknowledge(workerId, revision) {
            if (!workerId) return;
            appliedRevisions.set(workerId, Math.max(Number(revision || 0), appliedRevisions.get(workerId) || 0));
        },
        remove(workerId) {
            appliedRevisions.delete(workerId);
        },
        snapshot(workerIds = []) {
            const revisions = Object.fromEntries(workerIds.map(workerId => [workerId, appliedRevisions.get(workerId) || 0]));
            const pendingWorkers = workerIds.filter(workerId => (revisions[workerId] || 0) < currentRevision);
            return {
                currentRevision,
                pendingWorkerCount: pendingWorkers.length,
                workerRevisions: revisions
            };
        }
    };
}

export function startMultiWorkerRuntime({ env = process.env, args = process.argv.slice(2), logger = console } = {}) {
    const topology = resolveWorkerTopology(env);
    const publicPort = Number(env.RUNTIME_PUBLIC_PORT || 3000);
    const internalBasePort = Number(env.RUNTIME_INTERNAL_BASE_PORT || 3200);
    const epoch = env.RUNTIME_DEPLOYMENT_EPOCH || `local-${Date.now()}`;
    const workers = new Map();
    const workerMetrics = new Map();
    const providerConfigAcks = createProviderConfigAckTracker();
    const rawCaptureConfigAcks = createProviderConfigAckTracker();
    const potluckRoutingAcks = createProviderConfigAckTracker();
    const latestProviderConfigEvents = new Map();
    let latestRawCaptureConfigEvent = null;
    let latestPotluckRoutingEvent = null;
    const ready = new Set();
    let shuttingDown = false;

    const spawnWorker = (role, index, port) => {
        const id = role === 'control' ? 'control-1' : `execution-${index + 1}`;
        const child = fork(workerScript, [...args, '--host', '127.0.0.1', '--port', String(port)], {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            env: {
                ...env,
                IS_WORKER_PROCESS: 'true',
                RUNTIME_WORKER_ROLE: role,
                RUNTIME_WORKER_ID: id,
                RUNTIME_DEPLOYMENT_EPOCH: epoch
            }
        });
        workers.set(id, { id, role, port, child });
        child.on('message', message => {
            if (message?.type === 'ready') {
                ready.add(id);
                if (role === 'execution') {
                    providerConfigAcks.acknowledge(id, Number(message.providerConfigRevision || 0));
                    potluckRoutingAcks.acknowledge(id, Number(message.potluckKeyRoutingRevision || 0));
                    const replayEvents = [...latestProviderConfigEvents.values()].sort((left, right) => left.revision - right.revision);
                    for (const event of replayEvents) {
                        if (child.connected) child.send({ ...event, targetWorkerId: id });
                    }
                    if (latestRawCaptureConfigEvent && child.connected) {
                        rawCaptureConfigAcks.notePublished(latestRawCaptureConfigEvent.revision, [id]);
                        child.send({ ...latestRawCaptureConfigEvent, targetWorkerId: id });
                    }
                    if (latestPotluckRoutingEvent && child.connected) {
                        potluckRoutingAcks.notePublished(latestPotluckRoutingEvent.revision, [id]);
                        child.send({ ...latestPotluckRoutingEvent, targetWorkerId: id });
                    }
                }
                if (role === 'control') {
                    for (const worker of workers.values()) {
                        if (worker.role === 'execution' && worker.child.connected) worker.child.send({ type: 'runtime_hook_retry' });
                    }
                }
            }
            if (message?.type === 'runtime_hook') {
                workers.get('control-1')?.child.send({ ...message, sourceWorkerId: id });
            }
            if (message?.type === 'runtime_hook_ack') {
                const target = workers.get(message.sourceWorkerId);
                if (target?.child.connected) target.child.send(message);
            }
            if (message?.type === 'provider_state') {
                for (const worker of workers.values()) {
                    if (worker.child !== child && worker.child.connected) worker.child.send(message);
                }
            }
            if (message?.type === 'provider_identity_discovered' && role === 'execution') {
                const control = workers.get('control-1');
                if (control?.child.connected) control.child.send(message);
            }
            if (message?.type === 'provider_config_sync' && role === 'control') {
                latestProviderConfigEvents.set(message.providerType, { ...message });
                const executionIds = [...workers.values()]
                    .filter(worker => worker.role === 'execution' && (!message.targetWorkerId || message.targetWorkerId === worker.id))
                    .map(worker => worker.id);
                providerConfigAcks.notePublished(message.revision, executionIds);
                for (const worker of workers.values()) {
                    if (worker.role === 'execution' && worker.child.connected && (!message.targetWorkerId || message.targetWorkerId === worker.id)) worker.child.send(message);
                }
            }
            if (message?.type === 'provider_config_sync_ack' && role === 'execution') {
                providerConfigAcks.acknowledge(id, message.revision);
                const control = workers.get('control-1');
                if (control?.child.connected) control.child.send({
                    type: 'provider_config_sync_status',
                    ...providerConfigAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id))
                });
            }
            if (message?.type === 'request_audit_raw_capture_sync' && role === 'control') {
                latestRawCaptureConfigEvent = { ...message };
                const executionIds = [...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id);
                rawCaptureConfigAcks.notePublished(message.revision, executionIds);
                for (const worker of workers.values()) {
                    if (worker.role === 'execution' && worker.child.connected) worker.child.send(message);
                }
            }
            if (message?.type === 'request_audit_raw_capture_sync_ack' && role === 'execution') {
                rawCaptureConfigAcks.acknowledge(id, message.revision);
                const control = workers.get('control-1');
                if (control?.child.connected) control.child.send({
                    type: 'request_audit_raw_capture_sync_status',
                    ...rawCaptureConfigAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id))
                });
            }
            if (message?.type === 'potluck_key_routing_sync' && role === 'control') {
                latestPotluckRoutingEvent = { ...message };
                const executionIds = [...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id);
                potluckRoutingAcks.notePublished(message.revision, executionIds);
                for (const worker of workers.values()) {
                    if (worker.role === 'execution' && worker.child.connected) worker.child.send(message);
                }
            }
            if (message?.type === 'potluck_key_routing_sync_ack' && role === 'execution') {
                potluckRoutingAcks.acknowledge(id, message.revision);
                const control = workers.get('control-1');
                if (control?.child.connected) control.child.send({
                    type: 'potluck_key_routing_sync_status',
                    ...potluckRoutingAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id))
                });
            }
            if (message?.type === 'runtime_metrics' && message.snapshot) {
                workerMetrics.set(id, message.snapshot);
                // A metrics snapshot is emitted immediately before the explicit ready message.
                // Treat it as equivalent readiness evidence so a lost IPC ready frame cannot
                // leave a successfully restarted worker stuck in "starting" forever.
                ready.add(id);
            }
        });
        child.on('exit', (code, signal) => {
            ready.delete(id);
            workers.delete(id);
            workerMetrics.delete(id);
            providerConfigAcks.remove(id);
            rawCaptureConfigAcks.remove(id);
            potluckRoutingAcks.remove(id);
            if (!shuttingDown) {
                logger.error?.(`[Runtime] ${id} exited code=${code} signal=${signal}; restarting`);
                setTimeout(() => spawnWorker(role, index, port), 1000).unref?.();
            }
        });
        return child;
    };

    const controlPort = internalBasePort + 1;
    spawnWorker('control', 0, controlPort);
    const executionTargets = [];
    for (let index = 0; index < topology.executionWorkers; index++) {
        const port = internalBasePort + 11 + index;
        executionTargets.push({ host: '127.0.0.1', port });
        spawnWorker('execution', index, port);
    }

    const buildRuntimeStatus = () => {
        const metrics = aggregateWorkerMetrics(workerMetrics);
        const topologyReady = ready.size === topology.executionWorkers + 1;
        return {
            status: resolveRuntimeHealthStatus({ topologyReady, metrics }),
            epoch,
            controlWorkers: [...workers.values()].filter(worker => worker.role === 'control').length,
            executionWorkers: [...workers.values()].filter(worker => worker.role === 'execution').length,
            readyWorkers: ready.size,
            coordination: 'redis',
            leaseRecovery: 'ready',
            persistenceBacklog: metrics.hooks.pending + metrics.hooks.spooled + metrics.hooks.consumerLag,
            providerConfig: providerConfigAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id)),
            rawCapture: rawCaptureConfigAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id)),
            potluckRouting: potluckRoutingAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id)),
            runtimeHooks: metrics.hooks,
            metrics
        };
    };

    const proxy = http.createServer(createRuntimeProxyHandler({
        controlTarget: { host: '127.0.0.1', port: controlPort },
        executionTargets,
        isTargetReady: (role, index) => role === 'control'
            ? ready.has('control-1')
            : ready.has(`execution-${Number(index) + 1}`),
        onProxyError: (error, detail) => logger.error?.(`[Runtime Proxy] ${detail.role} ${detail.target.port}: ${error.message}`),
        getRuntimeStatus: buildRuntimeStatus
    }));
    proxy.requestTimeout = 0;
    proxy.headersTimeout = 60000;
    proxy.keepAliveTimeout = 65000;
    proxy.listen(publicPort, env.RUNTIME_PUBLIC_HOST || '0.0.0.0', () => {
        logger.info?.(`[Runtime] Public proxy listening on ${publicPort}; control=1 execution=${topology.executionWorkers} epoch=${epoch}`);
    });

    const shutdown = async exitCode => {
        if (shuttingDown) return;
        shuttingDown = true;
        const stopRole = async role => {
            const exits = [...workers.values()].filter(worker => worker.role === role).map(worker => new Promise(resolve => {
                const timeout = setTimeout(() => { worker.child.kill('SIGKILL'); resolve(); }, 30000);
                worker.child.once('exit', () => { clearTimeout(timeout); resolve(); });
                if (worker.child.connected) worker.child.send({ type: 'shutdown', phase: role === 'execution' ? 'drain' : 'persist' });
                else worker.child.kill('SIGTERM');
            }));
            await Promise.allSettled(exits);
        };
        const result = await shutdownWorkerStages({
            closeProxy: () => new Promise(resolve => proxy.close(resolve)),
            stopRole,
            getBacklog: () => {
                const hooks = aggregateWorkerMetrics(workerMetrics).hooks;
                return hooks.pending + hooks.spooled + hooks.consumerLag;
            }
        });
        if (!result.drained) logger.error?.(`[Runtime] Hook drain timed out with backlog=${result.remainingBacklog}`);
        process.exit(exitCode);
    };
    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));

    return {
        proxy,
        workers,
        ready,
        topology,
        getStatus: buildRuntimeStatus,
        shutdown
    };
}
