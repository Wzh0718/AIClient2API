import { jest } from '@jest/globals';

import {
    EdgeAuthService,
    extractApiKey,
    hashKeyId,
    policiesFromPotluckStore
} from '../src/edge-auth/edge-auth-service.js';
import { createEdgeAuthServer, isMainModule } from '../src/edge-auth/server.js';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class FakeRedis {
    constructor() {
        this.values = new Map();
        this.hashes = new Map();
        this.fail = false;
        this.rateCounts = new Map();
        this.failEval = false;
    }

    async command(parts) {
        if (this.fail) throw new Error('redis unavailable');
        const [name, ...args] = parts;
        if (name === 'GET') return this.values.get(args[0]) ?? null;
        if (name === 'SET') {
            this.values.set(args[0], args[1]);
            return 'OK';
        }
        if (name === 'HSET') {
            const target = this.hashes.get(args[0]) || new Map();
            for (let index = 1; index < args.length; index += 2) target.set(args[index], args[index + 1]);
            this.hashes.set(args[0], target);
            return 1;
        }
        if (name === 'HGETALL') {
            const target = this.hashes.get(args[0]) || new Map();
            return [...target.entries()].flat();
        }
        if (name === 'DEL') {
            this.values.delete(args[0]);
            this.hashes.delete(args[0]);
            return 1;
        }
        throw new Error(`unsupported command ${name}`);
    }

    async evalScript(name, script, keys, args) {
        if (this.fail || this.failEval) throw new Error('redis unavailable');
        const counts = keys.map(key => {
            const next = (this.rateCounts.get(key) || 0) + 1;
            this.rateCounts.set(key, next);
            return next;
        });
        return [counts[0], Number(args[0]), counts[1], Number(args[1])];
    }
}

function activePolicy(apiKey, overrides = {}) {
    return {
        id: hashKeyId(apiKey),
        status: 'active',
        rpmLimit: 100000,
        ...overrides
    };
}

describe('edge auth service', () => {
    test('detects the executable module on Windows and POSIX paths', () => {
        expect(isMainModule('C:\\app\\src\\edge-auth\\server.js', 'file:///C:/app/src/edge-auth/server.js')).toBe(true);
        expect(isMainModule('/app/src/edge-auth/server.js', 'file:///app/src/edge-auth/server.js')).toBe(true);
    });

    test('loads production keyId and object-entry key schemas', () => {
        const policies = policiesFromPotluckStore({ keys: {
            maki_entry: { enabled: true },
            ignored_name: { keyId: 'maki_record', enabled: false }
        } });
        expect(policies).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: hashKeyId('maki_entry'), status: 'active' }),
            expect.objectContaining({ id: hashKeyId('maki_record'), status: 'disabled' })
        ]));
    });

    test('extracts supported API key headers without accepting arbitrary schemes', () => {
        expect(extractApiKey({ authorization: 'Bearer maki_demo' })).toBe('maki_demo');
        expect(extractApiKey({ 'x-api-key': 'maki_claude' })).toBe('maki_claude');
        expect(extractApiKey({ 'x-goog-api-key': 'maki_gemini' })).toBe('maki_gemini');
        expect(extractApiKey({ 'x-edge-query-key': 'maki_query' })).toBe('maki_query');
        expect(extractApiKey({ authorization: 'Basic abc' })).toBeNull();
    });

    test('extracts legacy query API keys from the original request URI', () => {
        expect(extractApiKey({}, '/gemini-antigravity/v1beta/models/foo:generateContent?key=maki_query')).toBe('maki_query');
        expect(extractApiKey({}, '/v1/chat/completions?api_key=maki_api_query')).toBe('maki_api_query');
        expect(extractApiKey({}, '/v1/models?key=')).toBeNull();
    });

    test('rejects missing, unknown, and disabled keys before admission', async () => {
        const redis = new FakeRedis();
        const service = new EdgeAuthService({ redis, ipEnforce: false });
        await service.replacePolicies([
            activePolicy('maki_disabled', { status: 'disabled' })
        ]);
        redis.values.set(`edge:key-status:${hashKeyId('maki_unknown')}`, 'active');

        await expect(service.authorize({ headers: {}, clientIp: '203.0.113.1' }))
            .resolves.toMatchObject({ allowed: false, statusCode: 401, reason: 'missing_key' });
        await expect(service.authorize({ headers: { authorization: 'Bearer maki_unknown' }, clientIp: '203.0.113.1' }))
            .resolves.toMatchObject({ allowed: false, statusCode: 401, reason: 'unknown_key' });
        await expect(service.authorize({ headers: { authorization: 'Bearer maki_disabled' }, clientIp: '203.0.113.1' }))
            .resolves.toMatchObject({ allowed: false, statusCode: 403, reason: 'disabled' });
    });

    test('local disabled state wins over a stale active Redis status', async () => {
        const redis = new FakeRedis();
        const service = new EdgeAuthService({ redis, ipEnforce: false });
        const apiKey = 'maki_disabled_stale';
        await service.replacePolicies([activePolicy(apiKey, { status: 'disabled' })]);
        redis.values.set(`edge:key-status:${hashKeyId(apiKey)}`, 'active');

        await expect(service.authorize({
            headers: { authorization: `Bearer ${apiKey}` },
            clientIp: '203.0.113.6'
        })).resolves.toMatchObject({ allowed: false, statusCode: 403, reason: 'disabled' });
    });

    test('Redis disabled state wins over a locally active policy', async () => {
        const redis = new FakeRedis();
        const service = new EdgeAuthService({ redis, ipEnforce: false });
        const apiKey = 'maki_redis_disabled';
        await service.replacePolicies([activePolicy(apiKey)]);
        redis.values.set(`edge:key-status:${hashKeyId(apiKey)}`, 'disabled');

        await expect(service.authorize({
            headers: { authorization: `Bearer ${apiKey}` },
            clientIp: '203.0.113.8'
        })).resolves.toMatchObject({ allowed: false, statusCode: 403, reason: 'disabled' });
    });

    test('allows active keys below the configured high RPM threshold', async () => {
        const redis = new FakeRedis();
        const service = new EdgeAuthService({ redis, defaultKeyRpm: 100000, ipEnforce: false });
        await service.replacePolicies([activePolicy('maki_active')]);

        await expect(service.authorize({
            headers: { authorization: 'Bearer maki_active' },
            clientIp: '203.0.113.2'
        })).resolves.toMatchObject({ allowed: true, statusCode: 204, failOpen: false, redisHealthy: true });
    });

    test('returns 429 when a key exceeds its RPM threshold', async () => {
        const redis = new FakeRedis();
        const service = new EdgeAuthService({ redis, ipEnforce: false });
        await service.replacePolicies([activePolicy('maki_limited', { rpmLimit: 1 })]);
        const request = { headers: { authorization: 'Bearer maki_limited' }, clientIp: '203.0.113.3' };

        await expect(service.authorize(request)).resolves.toMatchObject({ allowed: true });
        await expect(service.authorize(request)).resolves.toMatchObject({
            allowed: false,
            statusCode: 429,
            reason: 'key_rate_exceeded'
        });
    });

    test('observes IP rate without rejecting when IP enforcement is disabled', async () => {
        const redis = new FakeRedis();
        const service = new EdgeAuthService({ redis, ipRpm: 1, ipEnforce: false });
        await service.replacePolicies([activePolicy('maki_ip_shadow')]);
        const request = { headers: { authorization: 'Bearer maki_ip_shadow' }, clientIp: '203.0.113.4' };

        await expect(service.authorize(request)).resolves.toMatchObject({ allowed: true, ipWouldReject: false });
        await expect(service.authorize(request)).resolves.toMatchObject({ allowed: true, ipWouldReject: true });
    });

    test('uses a short local policy cache for limited fail-open when Redis is unavailable', async () => {
        const redis = new FakeRedis();
        const onFailOpen = jest.fn();
        const service = new EdgeAuthService({ redis, ipEnforce: false, onFailOpen });
        await service.replacePolicies([
            activePolicy('maki_cached'),
            activePolicy('maki_cached_disabled', { status: 'disabled' })
        ]);
        redis.fail = true;

        await expect(service.authorize({
            headers: { authorization: 'Bearer maki_cached' },
            clientIp: '203.0.113.5'
        })).resolves.toMatchObject({ allowed: true, failOpen: true });
        await expect(service.authorize({
            headers: { authorization: 'Bearer maki_cached_disabled' },
            clientIp: '203.0.113.5'
        })).resolves.toMatchObject({ allowed: false, statusCode: 403, reason: 'disabled' });
        expect(onFailOpen).toHaveBeenCalledTimes(1);
    });

    test('uses limited fail-open when Redis rate accounting fails after status lookup', async () => {
        const redis = new FakeRedis();
        const service = new EdgeAuthService({ redis, ipEnforce: false });
        await service.replacePolicies([activePolicy('maki_rate_failure')]);
        redis.failEval = true;

        await expect(service.authorize({
            headers: { authorization: 'Bearer maki_rate_failure' },
            clientIp: '203.0.113.7'
        })).resolves.toMatchObject({ allowed: true, statusCode: 204, failOpen: true });
    });

    test('uses limited fail-open when Redis is not configured', async () => {
        const service = new EdgeAuthService({ redis: null, failOpenLocalRpm: 1 });
        await service.replacePolicies([activePolicy('maki_no_redis')]);
        const request = { headers: { authorization: 'Bearer maki_no_redis' }, clientIp: '203.0.113.9' };

        await expect(service.authorize(request)).resolves.toMatchObject({ allowed: true, failOpen: true });
        await expect(service.authorize(request)).resolves.toMatchObject({
            allowed: false,
            statusCode: 429,
            reason: 'fail_open_ip_guard'
        });
    });

    test('bounds fail-open IP tracking memory', async () => {
        const redis = new FakeRedis();
        const service = new EdgeAuthService({ redis, maxLocalRateEntries: 2 });
        await service.replacePolicies([activePolicy('maki_memory')]);
        redis.fail = true;
        for (const clientIp of ['203.0.113.10', '203.0.113.11', '203.0.113.12']) {
            await service.authorize({ headers: { authorization: 'Bearer maki_memory' }, clientIp });
        }
        expect(service.localRate.size).toBeLessThanOrEqual(2);
    });

    test('serves NGINX auth_request-compatible 204, 401, and 403 responses', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-auth-'));
        const policyFile = path.join(tempDir, 'api-potluck-keys.json');
        fs.writeFileSync(policyFile, JSON.stringify({ keys: {
            maki_active: { id: 'maki_active', enabled: true },
            maki_disabled: { id: 'maki_disabled', enabled: false }
        } }));
        const instance = createEdgeAuthServer({ policyFile, redis: new FakeRedis() });
        await instance.reloadPolicies();
        await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
        const { port } = instance.server.address();
        const request = (headers = {}) => new Promise((resolve, reject) => {
            const req = http.request({ port, host: '127.0.0.1', path: '/authorize', headers }, res => {
                res.resume();
                res.on('end', () => resolve(res.statusCode));
            });
            req.on('error', reject);
            req.end();
        });
        await expect(request({ authorization: 'Bearer maki_active' })).resolves.toBe(204);
        await expect(request()).resolves.toBe(401);
        await expect(request({ authorization: 'Bearer maki_disabled' })).resolves.toBe(403);
        await instance.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('encodes rate-limit 429 for NGINX auth_request using a 403 subrequest response', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-auth-rate-'));
        const policyFile = path.join(tempDir, 'api-potluck-keys.json');
        fs.writeFileSync(policyFile, JSON.stringify({ keys: {
            maki_limited_http: { keyId: 'maki_limited_http', enabled: true, edgeAuthRpmLimit: 1 }
        } }));
        const instance = createEdgeAuthServer({ policyFile, redis: new FakeRedis(), policyPollMs: 0 });
        await instance.reloadPolicies();
        await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
        const { port } = instance.server.address();
        const request = () => new Promise((resolve, reject) => {
            const req = http.request({ port, host: '127.0.0.1', path: '/authorize', headers: {
                authorization: 'Bearer maki_limited_http'
            } }, res => {
                res.resume();
                res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers }));
            });
            req.on('error', reject);
            req.end();
        });
        await request();
        await expect(request()).resolves.toMatchObject({
            statusCode: 403,
            headers: { 'x-edge-response-status': '429' }
        });
        await instance.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
});
