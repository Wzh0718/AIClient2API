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
        output: { bytes: 0, backpressureMs: 0 },
        inFlight: 0,
        process: { rss: 0, heapUsed: 0, maxEventLoopUtilization: 0, eventLoopDelay: { p95: 0, p99: 0, max: 0 } }
    };
    for (const snapshot of workerSnapshots.values()) {
        result.requests.total += Number(snapshot?.requests?.total || 0);
        result.requests.success += Number(snapshot?.requests?.success || 0);
        result.requests.failed += Number(snapshot?.requests?.failed || 0);
        addMapValues(result.requests.byWorker, snapshot?.requests?.byWorker);
        addMapValues(result.requests.byKind, snapshot?.requests?.byKind);
        result.output.bytes += Number(snapshot?.output?.bytes || 0);
        result.output.backpressureMs += Number(snapshot?.output?.backpressureMs || 0);
        result.inFlight += Number(snapshot?.inFlight || 0);
        result.process.rss += Number(snapshot?.process?.rss || 0);
        result.process.heapUsed += Number(snapshot?.process?.heapUsed || 0);
        result.process.maxEventLoopUtilization = Math.max(result.process.maxEventLoopUtilization, Number(snapshot?.process?.eventLoopUtilization || 0));
        result.process.eventLoopDelay.p95 = Math.max(result.process.eventLoopDelay.p95, Number(snapshot?.process?.eventLoopDelay?.p95 || 0));
        result.process.eventLoopDelay.p99 = Math.max(result.process.eventLoopDelay.p99, Number(snapshot?.process?.eventLoopDelay?.p99 || 0));
        result.process.eventLoopDelay.max = Math.max(result.process.eventLoopDelay.max, Number(snapshot?.process?.eventLoopDelay?.max || 0));
    }
    return result;
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
    const latestProviderConfigEvents = new Map();
    let latestRawCaptureConfigEvent = null;
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
                    const replayEvents = [...latestProviderConfigEvents.values()].sort((left, right) => left.revision - right.revision);
                    for (const event of replayEvents) {
                        if (child.connected) child.send({ ...event, targetWorkerId: id });
                    }
                    if (latestRawCaptureConfigEvent && child.connected) {
                        rawCaptureConfigAcks.notePublished(latestRawCaptureConfigEvent.revision, [id]);
                        child.send({ ...latestRawCaptureConfigEvent, targetWorkerId: id });
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
            if (message?.type === 'runtime_metrics' && message.snapshot) {
                workerMetrics.set(id, message.snapshot);
            }
        });
        child.on('exit', (code, signal) => {
            ready.delete(id);
            workers.delete(id);
            workerMetrics.delete(id);
            providerConfigAcks.remove(id);
            rawCaptureConfigAcks.remove(id);
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

    const proxy = http.createServer(createRuntimeProxyHandler({
        controlTarget: { host: '127.0.0.1', port: controlPort },
        executionTargets,
        onProxyError: (error, detail) => logger.error?.(`[Runtime Proxy] ${detail.role} ${detail.target.port}: ${error.message}`),
        getRuntimeStatus: () => ({
            status: ready.size === topology.executionWorkers + 1 ? 'healthy' : 'starting',
            epoch,
            controlWorkers: [...workers.values()].filter(worker => worker.role === 'control').length,
            executionWorkers: [...workers.values()].filter(worker => worker.role === 'execution').length,
            readyWorkers: ready.size,
            coordination: 'redis',
            leaseRecovery: 'ready',
            persistenceBacklog: 0,
            providerConfig: providerConfigAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id)),
            rawCapture: rawCaptureConfigAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id)),
            metrics: aggregateWorkerMetrics(workerMetrics)
        })
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
        await new Promise(resolve => proxy.close(resolve));
        const exits = [];
        for (const worker of workers.values()) {
            exits.push(new Promise(resolve => {
                const timeout = setTimeout(() => { worker.child.kill('SIGKILL'); resolve(); }, 30000);
                worker.child.once('exit', () => { clearTimeout(timeout); resolve(); });
                if (worker.child.connected) worker.child.send({ type: 'shutdown' });
                else worker.child.kill('SIGTERM');
            }));
        }
        await Promise.allSettled(exits);
        process.exit(exitCode);
    };
    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));

    return {
        proxy,
        workers,
        ready,
        topology,
        getStatus: () => ({
            status: ready.size === topology.executionWorkers + 1 ? 'healthy' : 'starting',
            epoch,
            controlWorkers: [...workers.values()].filter(worker => worker.role === 'control').length,
            executionWorkers: [...workers.values()].filter(worker => worker.role === 'execution').length,
            readyWorkers: ready.size,
            providerConfig: providerConfigAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id)),
            rawCapture: rawCaptureConfigAcks.snapshot([...workers.values()].filter(worker => worker.role === 'execution').map(worker => worker.id))
        }),
        shutdown
    };
}
