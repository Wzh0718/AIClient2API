import http from 'node:http';
import { EdgeAuthService, loadPoliciesFromFile } from './edge-auth-service.js';
import { RedisRespClient } from '../runtime/redis-resp-client.js';

function redisFromUrl(value) {
    if (!value) return null;
    const url = new URL(value);
    return new RedisRespClient({
        host: url.hostname,
        port: Number(url.port || (url.protocol === 'rediss:' ? 6380 : 6379)),
        password: url.password ? decodeURIComponent(url.password) : null,
        database: Number(url.pathname.replace(/^\//, '') || 0),
        tls: url.protocol === 'rediss:'
    });
}

function json(res, statusCode, body) {
    res.writeHead(statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}

export function createEdgeAuthServer(options = {}) {
    const policyFile = options.policyFile || process.env.EDGE_AUTH_POLICY_FILE || 'configs/api-potluck-keys.json';
    const redis = options.redis || redisFromUrl(options.redisUrl || process.env.REDIS_URL);
    const service = options.service || new EdgeAuthService({
        redis,
        defaultKeyRpm: Number(process.env.EDGE_AUTH_DEFAULT_KEY_RPM || 100000),
        defaultKeyConcurrency: Number(process.env.EDGE_AUTH_DEFAULT_KEY_CONCURRENCY || 1000),
        ipRpm: Number(process.env.EDGE_AUTH_DEFAULT_IP_RPM || 100000),
        ipEnforce: process.env.EDGE_AUTH_IP_ENFORCE === 'true',
        failOpenLocalRpm: Number(process.env.EDGE_AUTH_FAIL_OPEN_LOCAL_RPM || 120),
        onFailOpen: event => console.error(JSON.stringify({ event: 'edge_auth_redis_fail_open', ...event, keyHash: event.keyHash }))
    });
    let loadedMtime = 0;
    let previousHashes = new Set();
    let reloadPromise = null;
    let policyPollTimer = null;

    async function reloadPolicies() {
        if (reloadPromise) return reloadPromise;
        reloadPromise = (async () => {
            const loaded = loadPoliciesFromFile(policyFile);
            if (loaded.mtimeMs === loadedMtime) return false;
            await service.replacePolicies(loaded.policies);
            if (redis) {
                try {
                    const nextHashes = new Set(loaded.policies.map(policy => policy.id));
                    for (const policy of loaded.policies) {
                        await redis.command(['SET', `edge:key-status:${policy.id}`, policy.status]);
                    }
                    for (const oldHash of previousHashes) {
                        if (!nextHashes.has(oldHash)) await redis.command(['DEL', `edge:key-status:${oldHash}`]);
                    }
                    previousHashes = nextHashes;
                } catch (error) {
                    console.error(JSON.stringify({ event: 'edge_auth_policy_redis_sync_failed', message: error.message }));
                }
            }
            loadedMtime = loaded.mtimeMs;
            return true;
        })().finally(() => { reloadPromise = null; });
        return reloadPromise;
    }

    const server = http.createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
        if (req.method === 'POST' && req.url === '/reload') {
            try {
                const changed = await reloadPolicies();
                return json(res, 200, { ok: true, changed });
            } catch (error) {
                return json(res, 500, { ok: false, error: 'policy_reload_failed' });
            }
        }
        if (req.method !== 'GET' || req.url !== '/authorize') return json(res, 404, { error: 'not_found' });
        try {
            const result = await service.authorize({
                headers: req.headers,
                clientIp: req.headers['x-edge-client-ip'] || req.socket.remoteAddress || 'unknown'
            });
            if (result.allowed) {
                res.writeHead(204, { 'x-edge-key-hash': result.keyHash || '' });
                return res.end();
            }
            if (result.statusCode === 429) {
                res.writeHead(403, {
                    'content-type': 'application/json',
                    'cache-control': 'no-store',
                    'x-edge-response-status': '429'
                });
                return res.end(JSON.stringify({ error: result.reason || 'rate_limited' }));
            }
            return json(res, result.statusCode || 401, { error: result.reason || 'unauthorized' });
        } catch (error) {
            return json(res, 503, { error: 'edge_auth_unavailable' });
        }
    });

    return {
        server,
        service,
        reloadPolicies,
        async close() {
            if (policyPollTimer) clearInterval(policyPollTimer);
            await new Promise(resolve => server.close(resolve));
            await redis?.close?.();
        },
        startPolicyWatcher(intervalMs = Number(process.env.EDGE_AUTH_POLICY_POLL_MS || 1000)) {
            if (policyPollTimer || !(intervalMs > 0)) return;
            policyPollTimer = setInterval(() => {
                reloadPolicies().catch(error => console.error(JSON.stringify({ event: 'edge_auth_policy_reload_failed', message: error.message })));
            }, intervalMs);
            policyPollTimer.unref?.();
        }
    };
}

export function isMainModule(executablePath, moduleUrl = import.meta.url) {
    if (!executablePath) return false;
    const modulePath = decodeURIComponent(new URL(moduleUrl).pathname).replace(/^\/([A-Za-z]:)/, '$1');
    const normalize = value => value.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
    return normalize(executablePath) === normalize(modulePath);
}

async function main() {
    const port = Number(process.env.EDGE_AUTH_PORT || 18081);
    const instance = createEdgeAuthServer();
    await instance.reloadPolicies();
    instance.startPolicyWatcher();
    instance.server.listen(port, process.env.EDGE_AUTH_HOST || '127.0.0.1', () => {
        console.log(`[edge-auth] listening on ${process.env.EDGE_AUTH_HOST || '127.0.0.1'}:${port}`);
    });
    const shutdown = async () => { await instance.close(); process.exit(0); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
}

if (isMainModule(process.argv[1])) {
    main().catch(error => {
        console.error('[edge-auth] startup failed:', error.message);
        process.exit(1);
    });
}
