import http from 'http';
import { createRuntimeProxyHandler } from '../src/runtime/runtime-proxy.js';

async function listen(server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
}

describe('runtime proxy', () => {
    let control;
    let execution;
    let proxy;
    let proxyPort;

    beforeAll(async () => {
        control = http.createServer((req, res) => res.end(`control:${req.url}`));
        execution = http.createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            req.pipe(res);
        });
        const controlPort = await listen(control);
        const executionPort = await listen(execution);
        proxy = http.createServer(createRuntimeProxyHandler({
            controlTarget: { host: '127.0.0.1', port: controlPort },
            executionTargets: [{ host: '127.0.0.1', port: executionPort }],
            getRuntimeStatus: () => ({ status: 'healthy', executionWorkers: 3, persistenceBacklog: 0, metrics: { inFlight: 2 } })
        }));
        proxyPort = await listen(proxy);
    });

    afterAll(async () => Promise.all([control, execution, proxy].map(server => new Promise(resolve => server.close(resolve)))));

    test('routes control paths and streams model request bodies without buffering', async () => {
        const controlResponse = await fetch(`http://127.0.0.1:${proxyPort}/api/usage`);
        expect(await controlResponse.text()).toBe('control:/api/usage');

        const body = 'stream-me';
        const modelResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, { method: 'POST', body });
        expect(await modelResponse.text()).toBe(body);
    });

    test('serves runtime topology health from the master without involving a worker', async () => {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/runtime/health`);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ status: 'healthy', executionWorkers: 3, persistenceBacklog: 0, metrics: { inFlight: 2 } });
    });

    test('returns startup 503 instead of connecting to an unready worker', async () => {
        let upstreamCalls = 0;
        const unreadyProxy = http.createServer(createRuntimeProxyHandler({
            controlTarget: { host: '127.0.0.1', port: 1 },
            executionTargets: [{ host: '127.0.0.1', port: 1 }],
            isTargetReady: () => false,
            onProxyError: () => { throw new Error('unready proxy attempted an upstream connection'); },
            onTargetRequest: () => { upstreamCalls += 1; }
        }));
        const unreadyPort = await listen(unreadyProxy);
        try {
            const response = await fetch(`http://127.0.0.1:${unreadyPort}/api/usage`);
            expect(response.status).toBe(503);
            await expect(response.json()).resolves.toMatchObject({
                error: { code: 'RUNTIME_WORKER_STARTING' }
            });
            expect(upstreamCalls).toBe(0);
        } finally {
            await new Promise(resolve => unreadyProxy.close(resolve));
        }
    });
});
