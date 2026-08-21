import http from 'http';
import { classifyRuntimeRequest } from './worker-topology.js';

export function createRuntimeProxyHandler({ controlTarget, executionTargets, onProxyError, getRuntimeStatus, isTargetReady, onTargetRequest } = {}) {
    let executionIndex = 0;
    return (req, res) => {
        if (req.method === 'GET' && req.url.split('?')[0] === '/runtime/health' && getRuntimeStatus) {
            const status = getRuntimeStatus();
            res.writeHead(status.status === 'healthy' ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(status));
            return;
        }
        const role = classifyRuntimeRequest(req.method, req.url);
        const targetIndex = role === 'execution'
            ? executionIndex++ % executionTargets.length
            : null;
        const target = role === 'execution' ? executionTargets[targetIndex] : controlTarget;
        if (isTargetReady && !isTargetReady(role, targetIndex)) {
            res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '1' });
            res.end(JSON.stringify({ error: { code: 'RUNTIME_WORKER_STARTING', message: 'Runtime worker is still starting' } }));
            return;
        }
        onTargetRequest?.(role, targetIndex, target);
        const upstream = http.request({
            host: target.host,
            port: target.port,
            method: req.method,
            path: req.url,
            headers: { ...req.headers, 'x-aiclient-runtime-role': role },
            agent: false
        }, upstreamResponse => {
            res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
            upstreamResponse.pipe(res);
        });
        upstream.on('error', error => {
            onProxyError?.(error, { role, target });
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
            if (!res.writableEnded) res.end(JSON.stringify({ error: { code: 'RUNTIME_WORKER_UNAVAILABLE', message: 'Runtime worker unavailable' } }));
        });
        req.on('aborted', () => upstream.destroy());
        res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
        req.pipe(upstream);
    };
}
