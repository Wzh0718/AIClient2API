import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RATE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return {count, tonumber(ARGV[1])}
`;

const KEY_PREFIX = 'maki_';

export function hashKeyId(keyId) {
    return crypto.createHash('sha256').update(String(keyId)).digest('hex').slice(0, 32);
}

export function extractApiKey(headers = {}) {
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
        concurrencyLimit: positiveNumber(policy.concurrencyLimit, 1000)
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
            concurrencyLimit: record.edgeAuthConcurrencyLimit || record.concurrencyLimit
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

    _failOpenDecision(error, clientIp, keyHash, localPolicy) {
        const allowed = this._localFailOpen(clientIp);
        if (!this.redisFailureNotified) {
            this.redisFailureNotified = true;
            this.onFailOpen({ error, clientIp, keyHash });
        }
        if (!allowed) return { allowed: false, statusCode: 429, reason: 'fail_open_ip_guard', failOpen: true };
        if (['disabled', 'revoked', 'expired'].includes(localPolicy?.status)) {
            return { allowed: false, statusCode: 403, reason: localPolicy.status, failOpen: true };
        }
        return { allowed: true, statusCode: 204, failOpen: true, keyHash };
    }

    async authorize({ headers = {}, clientIp = 'unknown' } = {}) {
        const apiKey = extractApiKey(headers);
        if (!apiKey) return { allowed: false, statusCode: 401, reason: 'missing_key' };
        if (!apiKey.startsWith(KEY_PREFIX)) return { allowed: false, statusCode: 401, reason: 'invalid_format' };

        const keyHash = hashKeyId(apiKey);
        const localPolicy = this.policies.get(keyHash);
        if (!localPolicy) return { allowed: false, statusCode: 401, reason: 'unknown_key' };
        if (!this.redis) {
            return this._failOpenDecision(new Error('Redis is not configured'), clientIp, keyHash, localPolicy);
        }
        let redisHealthy = true;
        let status = null;
        try {
            status = await this._redisStatus(keyHash);
            this.redisFailureNotified = false;
        } catch (error) {
            redisHealthy = false;
            return this._failOpenDecision(error, clientIp, keyHash, localPolicy);
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
            return this._failOpenDecision(error, clientIp, keyHash, localPolicy);
        }
        const ipWouldReject = ipRate.count > ipRate.limit;
        if (keyRate.count > keyRate.limit) {
            return { allowed: false, statusCode: 429, reason: 'key_rate_exceeded', keyHash, ipWouldReject };
        }
        if (this.ipEnforce && ipWouldReject) {
            return { allowed: false, statusCode: 429, reason: 'ip_rate_exceeded', keyHash };
        }
        return { allowed: true, statusCode: 204, keyHash, ipWouldReject, redisHealthy, failOpen: false };
    }
}
