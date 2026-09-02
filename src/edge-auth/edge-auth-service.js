import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { EdgeAdmissionCoordinator } from './edge-admission.js';

const RATE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return {count, tonumber(ARGV[1])}
`;

const KEY_PREFIX = 'maki_';

export function hashKeyId(keyId) {
    return crypto.createHash('sha256').update(String(keyId)).digest('hex').slice(0, 32);
}

export function extractApiKey(headers = {}, originalUri = '') {
    const authorization = headers.authorization || headers.Authorization;
    if (typeof authorization === 'string' && /^Bearer\s+\S+$/i.test(authorization.trim())) {
        return authorization.trim().replace(/^Bearer\s+/i, '');
    }
    for (const name of ['x-api-key', 'x-goog-api-key']) {
        const value = headers[name] || headers[name.toLowerCase()];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    for (const name of ['x-edge-query-key', 'x-edge-query-api-key']) {
        const value = headers[name] || headers[name.toLowerCase()];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    if (typeof originalUri === 'string' && originalUri) {
        try {
            const parsed = new URL(originalUri, 'http://edge-auth.invalid');
            for (const name of ['key', 'api_key']) {
                const value = parsed.searchParams.get(name);
                if (value && value.trim()) return value.trim();
            }
        } catch {}
    }
    return null;
}

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizePolicy(policy = {}) {
    return {
        id: typeof policy.id === 'string' ? policy.id : '',
        status: policy.status || (policy.enabled === false ? 'disabled' : 'active'),
        rpmLimit: positiveNumber(policy.rpmLimit, 100000),
        concurrencyLimit: positiveNumber(policy.concurrencyLimit, 1000),
        edgeAdmissionMode: policy.edgeAdmissionMode === 'enforce' ? 'enforce' : 'disabled',
        edgeAdmissionConcurrencyLimit: Math.max(0, Number(policy.edgeAdmissionConcurrencyLimit ?? policy.concurrencyLimit ?? 0)),
        edgeAdmissionQueueLimit: Math.max(0, Number(policy.edgeAdmissionQueueLimit ?? policy.queueLimit ?? 0)),
        edgeAdmissionQueueTimeoutMs: Math.max(1, Number(policy.edgeAdmissionQueueTimeoutMs ?? policy.queueTimeoutMs ?? 300000))
    };
}

export function policiesFromPotluckStore(store = {}) {
    const keys = store.keys && typeof store.keys === 'object' ? store.keys : store;
    return Object.entries(keys || {}).flatMap(([entryId, record]) => {
        const id = record?.keyId || record?.id || record?.key || record?.apiKey || entryId;
        if (typeof id !== 'string' || !id.startsWith(KEY_PREFIX)) return [];
        return [normalizePolicy({
            id: hashKeyId(id),
            status: record.enabled === false ? 'disabled' : 'active',
            rpmLimit: record.edgeAuthRpmLimit || record.rpmLimit,
            concurrencyLimit: record.edgeAuthConcurrencyLimit || record.concurrencyLimit,
            edgeAdmissionMode: record.edgeAdmissionMode,
            edgeAdmissionConcurrencyLimit: record.edgeAdmissionConcurrencyLimit,
            edgeAdmissionQueueLimit: record.edgeAdmissionQueueLimit,
            edgeAdmissionQueueTimeoutMs: record.edgeAdmissionQueueTimeoutMs,
            queueLimit: record.queueLimit,
            queueTimeoutMs: record.queueTimeoutMs
        })];
    });
}

export function loadPoliciesFromFile(filePath) {
    const absolute = path.resolve(filePath);
    const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
    return { absolute, mtimeMs: fs.statSync(absolute).mtimeMs, policies: policiesFromPotluckStore(parsed) };
}

export class EdgeAuthService {
    constructor(options = {}) {
        this.redis = options.redis || null;
        this.defaultKeyRpm = positiveNumber(options.defaultKeyRpm, 100000);
        this.defaultKeyConcurrency = positiveNumber(options.defaultKeyConcurrency, 1000);
        this.ipRpm = positiveNumber(options.ipRpm, 100000);
        this.ipEnforce = options.ipEnforce === true;
        this.redisTimeoutMs = positiveNumber(options.redisTimeoutMs, 250);
        this.failOpenLocalRpm = positiveNumber(options.failOpenLocalRpm, 120);
        this.maxLocalRateEntries = Math.max(1, Number(options.maxLocalRateEntries || 10000));
        this.onFailOpen = typeof options.onFailOpen === 'function' ? options.onFailOpen : () => {};
        this.policies = new Map();
        this.localRate = new Map();
        this.redisFailureNotified = false;
        this.admission = options.admission || (this.redis ? new EdgeAdmissionCoordinator({ redis: this.redis, leaseTtlMs: options.leaseTtlMs }) : null);
        this.failOpenMaxInFlight = Math.max(1, Number(options.failOpenMaxInFlight || 1));
        this.failOpenInFlight = new Map();
        this.failOpenLeases = new Map();
        this.metrics = {
            authorize: 0, denied: 0, leaseAcquired: 0, queueRejected: 0,
            queueTimeouts: 0, failOpen: 0, releaseFailures: 0, renewFailures: 0
        };
    }

    async replacePolicies(policies = []) {
        this.policies = new Map(policies.map(policy => {
            const normalized = normalizePolicy({
                ...policy,
                rpmLimit: policy.rpmLimit || this.defaultKeyRpm,
                concurrencyLimit: policy.concurrencyLimit || this.defaultKeyConcurrency
            });
            return [normalized.id, normalized];
        }).filter(([id]) => id));
    }

    async _redisStatus(keyHash) {
        if (!this.redis) return null;
        const value = await this.redis.command(['GET', `edge:key-status:${keyHash}`], { timeoutMs: this.redisTimeoutMs });
        return value || null;
    }

    async _redisRate(bucket, keyHash, limit) {
        if (!this.redis) return { count: 0, limit };
        const result = await this.redis.evalScript(
            `edge-auth-rate:${bucket}`,
            RATE_SCRIPT,
            [`edge:${bucket}:${keyHash}:${Math.floor(Date.now() / 60000)}`],
            [limit, 60]
        );
        return { count: Number(result?.[0] || 0), limit: Number(result?.[1] || limit) };
    }

    _localFailOpen(ip) {
        const now = Date.now();
        const entry = this.localRate.get(ip) || { startedAt: now, count: 0 };
        if (now - entry.startedAt >= 60_000) {
            entry.startedAt = now;
            entry.count = 0;
        }
        entry.count += 1;
        this.localRate.set(ip, entry);
        if (this.localRate.size > this.maxLocalRateEntries) {
            const oldest = [...this.localRate.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
            if (oldest) this.localRate.delete(oldest[0]);
        }
        return entry.count <= this.failOpenLocalRpm;
    }

    _failOpenDecision(error, clientIp, keyHash, localPolicy, requestId = null) {
        const allowed = this._localFailOpen(clientIp);
        this.metrics.failOpen += 1;
        if (!this.redisFailureNotified) {
            this.redisFailureNotified = true;
            this.onFailOpen({ error, clientIp, keyHash });
        }
        if (!allowed) return { allowed: false, statusCode: 429, reason: 'fail_open_ip_guard', failOpen: true };
        if (['disabled', 'revoked', 'expired'].includes(localPolicy?.status)) {
            return { allowed: false, statusCode: 403, reason: localPolicy.status, failOpen: true };
        }
        const inFlight = Number(this.failOpenInFlight.get(keyHash) || 0);
        if (inFlight >= this.failOpenMaxInFlight) return { allowed: false, statusCode: 429, reason: 'fail_open_concurrency_guard', failOpen: true };
        this.failOpenInFlight.set(keyHash, inFlight + 1);
        const leaseId = `fail-open:${keyHash}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        this.failOpenLeases.set(leaseId, { keyHash, requestId });
        return { allowed: true, statusCode: 204, failOpen: true, keyHash, failOpenLease: true, leaseId, leaseMode: 'fail-open', requestId };
    }

    async authorize({ headers = {}, clientIp = 'unknown', requestId = null, signal = null } = {}) {
        this.metrics.authorize += 1;
        requestId ||= `edge-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const apiKey = extractApiKey(headers, headers['x-edge-original-uri'] || headers['X-Edge-Original-URI']);
        if (!apiKey) return { allowed: false, statusCode: 401, reason: 'missing_key' };
        if (!apiKey.startsWith(KEY_PREFIX)) return { allowed: false, statusCode: 401, reason: 'invalid_format' };

        const keyHash = hashKeyId(apiKey);
        const localPolicy = this.policies.get(keyHash);
        if (!localPolicy) return { allowed: false, statusCode: 401, reason: 'unknown_key' };
        if (!this.redis) {
            return this._failOpenDecision(new Error('Redis is not configured'), clientIp, keyHash, localPolicy, requestId);
        }
        let redisHealthy = true;
        let status = null;
        try {
            status = await this._redisStatus(keyHash);
            this.redisFailureNotified = false;
        } catch (error) {
            redisHealthy = false;
            return this._failOpenDecision(error, clientIp, keyHash, localPolicy, requestId);
        }

        const localDisabled = ['disabled', 'revoked', 'expired'].includes(localPolicy?.status);
        const redisDisabled = ['disabled', 'revoked', 'expired'].includes(status);
        status = localDisabled ? localPolicy.status : (redisDisabled ? status : (localPolicy?.status || status || null));
        if (['disabled', 'revoked', 'expired'].includes(status)) {
            return { allowed: false, statusCode: 403, reason: status };
        }

        const policy = localPolicy || normalizePolicy({ id: keyHash });
        let keyRate;
        let ipRate;
        try {
            keyRate = await this._redisRate('key-rate', keyHash, policy.rpmLimit);
            ipRate = await this._redisRate('ip-rate', clientIp, this.ipRpm);
            this.redisFailureNotified = false;
        } catch (error) {
            return this._failOpenDecision(error, clientIp, keyHash, localPolicy, requestId);
        }
        const ipWouldReject = ipRate.count > ipRate.limit;
        if (keyRate.count > keyRate.limit) {
            return { allowed: false, statusCode: 429, reason: 'key_rate_exceeded', keyHash, ipWouldReject };
        }
        if (this.ipEnforce && ipWouldReject) {
            return { allowed: false, statusCode: 429, reason: 'ip_rate_exceeded', keyHash };
        }
        let lease = null;
        if (policy.edgeAdmissionMode === 'enforce' && policy.edgeAdmissionConcurrencyLimit > 0) {
            try {
                lease = await this.admission.acquire(keyHash, policy, requestId, { signal });
                this.metrics.leaseAcquired += 1;
            } catch (error) {
                if (error.code === 'EDGE_ADMISSION_QUEUE_TIMEOUT') this.metrics.queueTimeouts += 1;
                if (error.code === 'EDGE_ADMISSION_CAPACITY_EXHAUSTED') this.metrics.queueRejected += 1;
                if (/redis|socket|coordination|unavailable|timeout/i.test(String(error.message || error.code || ''))) {
                    return this._failOpenDecision(error, clientIp, keyHash, localPolicy, requestId);
                }
                return { allowed: false, statusCode: error.status || 429, reason: error.code || 'edge_admission_rejected', keyHash, ipWouldReject };
            }
        }
        return { allowed: true, statusCode: 204, keyHash, ipWouldReject, redisHealthy, failOpen: false, leaseId: lease?.leaseId || null, leaseMode: lease ? 'enforce' : 'disabled', requestId };
    }

    async release({ keyHash, leaseId, requestId } = {}) {
        if (leaseId && this.admission) {
            try { return await this.admission.release(keyHash, leaseId, requestId); }
            catch { this.metrics.releaseFailures += 1; return false; }
        }
        if (leaseId && this.failOpenLeases.has(leaseId)) {
            this.failOpenLeases.delete(leaseId);
            const value = Math.max(0, Number(this.failOpenInFlight.get(keyHash) || 1) - 1);
            if (value) this.failOpenInFlight.set(keyHash, value); else this.failOpenInFlight.delete(keyHash);
            return true;
        }
        if (keyHash && this.failOpenInFlight.has(keyHash)) {
            const value = Math.max(0, Number(this.failOpenInFlight.get(keyHash)) - 1);
            if (value) this.failOpenInFlight.set(keyHash, value); else this.failOpenInFlight.delete(keyHash);
            return true;
        }
        return false;
    }

    async renew({ keyHash, leaseId } = {}) {
        try { return await (this.admission?.renew(keyHash, leaseId) || false); }
        catch { this.metrics.renewFailures += 1; return false; }
    }

    async status(keyHash, leaseId) {
        if (leaseId && this.failOpenLeases.has(leaseId)) return { redis: false, status: 'active', failOpen: true, keyHash };
        return { ...(await (this.admission?.status(keyHash, leaseId) || { redis: false })), metrics: this.metrics };
    }

    getMetrics() { return { ...this.metrics, failOpenInFlight: this.failOpenInFlight.size }; }
}
