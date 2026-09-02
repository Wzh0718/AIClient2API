import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RedisRespClient } from './redis-resp-client.js';

const COMMIT_SCRIPT = `
local acknowledged = redis.call('XACK', KEYS[1], ARGV[2], ARGV[1])
if acknowledged > 0 then
    redis.call('XDEL', KEYS[1], ARGV[1])
end
return acknowledged
`;

const COMMIT_BATCH_SCRIPT = `
local committed = 0
for index = 1, #ARGV do
    local acknowledged = redis.call('XACK', KEYS[1], ARGV[1], ARGV[index])
    if acknowledged > 0 then
        redis.call('XDEL', KEYS[1], ARGV[index])
        committed = committed + acknowledged
    end
end
return committed
`;

function safeFileName(eventId) {
    return `${createHash('sha256').update(String(eventId)).digest('hex')}.json`;
}

function fieldsToObject(fields = []) {
    const result = {};
    for (let index = 0; index < fields.length; index += 2) result[fields[index]] = fields[index + 1];
    return result;
}

function isMissingConsumerGroup(error) {
    return /NOGROUP/i.test(error?.message || '');
}

function parseRedisInfo(value = '') {
    const result = {};
    for (const line of String(value || '').split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue;
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        result[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return result;
}

export function decodeRuntimeHookStreamResponse(response) {
    const events = [];
    for (const stream of response || []) {
        for (const entry of stream?.[1] || []) {
            const streamId = entry?.[0];
            const fields = fieldsToObject(entry?.[1]);
            if (!streamId || !fields.payload) continue;
            try {
                events.push({ ...JSON.parse(fields.payload), streamId });
            } catch {
                // Corrupt stream entries are left pending for diagnostics.
            }
        }
    }
    return events;
}

export class RuntimeHookStream {
    constructor({
        redis,
        blockingRedis = redis,
        createBlockingRedis = null,
        epoch = 'default',
        workerId = `worker-${process.pid}`,
        group = 'control',
        spoolDir = path.join(process.cwd(), 'configs', 'runtime-hook-spool', workerId),
        spoolMaxBytes = 256 * 1024 * 1024,
        retentionSeconds = 45 * 24 * 60 * 60,
        redisCommandTimeoutMs = 3000,
        pendingClaimIdleMs = 30_000
    } = {}) {
        if (!redis?.command) throw new TypeError('Redis executor with command() is required');
        if (!blockingRedis?.command) throw new TypeError('Blocking Redis executor with command() is required');
        this.redis = redis;
        this.blockingRedis = blockingRedis;
        this.createBlockingRedis = createBlockingRedis;
        this.workerId = workerId;
        this.group = group;
        this.streamKey = `aiclient2api:${epoch}:runtime-hooks`;
        this.processedKey = `${this.streamKey}:processed`;
        this.spoolDir = spoolDir;
        this.spoolMaxBytes = Math.max(1, Number(spoolMaxBytes) || 1);
        this.spoolFull = false;
        this.retentionSeconds = retentionSeconds;
        this.redisCommandTimeoutMs = redisCommandTimeoutMs;
        this.pendingClaimIdleMs = pendingClaimIdleMs;
        this.groupReady = false;
        this.closed = false;
        this.inFlight = 0;
        this.lastPublishedAt = null;
        this.lastCommittedAt = null;
        this.lastError = null;
        this.oomCommandErrors = 0;
        this.memorySnapshot = null;
        this.memorySnapshotAt = 0;
        this.spoolEntries = null;
        this.spoolBytes = 0;
        this.spoolMutationTail = Promise.resolve();
    }

    _initializeSpoolIndex() {
        if (this.spoolEntries) return;
        this.spoolEntries = new Map();
        this.spoolBytes = 0;
        if (!fs.existsSync(this.spoolDir)) return;
        for (const name of fs.readdirSync(this.spoolDir).filter(item => item.endsWith('.json'))) {
            const stat = fs.statSync(path.join(this.spoolDir, name));
            this.spoolEntries.set(name, { size: stat.size, mtimeMs: stat.mtimeMs });
            this.spoolBytes += stat.size;
        }
    }

    _enqueueSpoolMutation(operation) {
        const result = this.spoolMutationTail.then(operation);
        this.spoolMutationTail = result.catch(() => {});
        return result;
    }

    _writeSpool(event) {
        return this._enqueueSpoolMutation(() => this._writeSpoolNow(event));
    }

    async _writeSpoolNow(event) {
        await fsp.mkdir(this.spoolDir, { recursive: true });
        this._initializeSpoolIndex();
        const serialized = `${JSON.stringify(event)}\n`;
        const target = path.join(this.spoolDir, safeFileName(event.eventId));
        const name = path.basename(target);
        const existingBytes = this.spoolEntries.get(name)?.size || 0;
        const serializedBytes = Buffer.byteLength(serialized, 'utf8');
        const nextBytes = this.spoolBytes - existingBytes + serializedBytes;
        if (nextBytes > this.spoolMaxBytes) {
            this.spoolFull = true;
            const error = new Error(`Runtime hook spool limit exceeded (${this.spoolMaxBytes} bytes)`);
            error.code = 'RUNTIME_HOOK_SPOOL_FULL';
            throw error;
        }
        const temp = `${target}.${process.pid}.tmp`;
        await fsp.writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600 });
        await fsp.rename(temp, target);
        this.spoolEntries.set(name, { size: serializedBytes, mtimeMs: Date.now() });
        this.spoolBytes = nextBytes;
        this.spoolFull = false;
        return target;
    }

    async publish(event) {
        await this._writeSpool(event);
        const payload = JSON.stringify(event);
        try {
            const memory = await this._getRedisMemorySnapshot();
            if (memory.critical) {
                const error = new Error(`Redis memory pressure is critical (${Math.round(memory.ratio * 100)}%)`);
                error.code = 'REDIS_MEMORY_CRITICAL';
                throw error;
            }
            const streamId = await this.redis.command([
                'XADD', this.streamKey, '*',
                'eventId', event.eventId,
                'sourceWorkerId', event.sourceWorkerId || this.workerId,
                'createdAt', event.createdAt || new Date().toISOString(),
                'payload', payload
            ], { timeoutMs: this.redisCommandTimeoutMs });
            this.lastPublishedAt = new Date().toISOString();
            this.lastError = null;
            return { persisted: true, spooled: false, streamId };
        } catch (error) {
            if (/\bOOM\b|maxmemory/i.test(error.message || '')) this.oomCommandErrors++;
            this.lastError = error.message;
            return { persisted: true, spooled: true, streamId: null };
        }
    }

    async acknowledge(eventId) {
        if (!eventId) return;
        await this._enqueueSpoolMutation(async () => {
            this._initializeSpoolIndex();
            const name = safeFileName(eventId);
            const existing = this.spoolEntries.get(name);
            await fsp.rm(path.join(this.spoolDir, name), { force: true });
            if (existing) {
                this.spoolEntries.delete(name);
                this.spoolBytes = Math.max(0, this.spoolBytes - existing.size);
            }
        });
    }

    async flushSpool() {
        await this.spoolMutationTail;
        this._initializeSpoolIndex();
        if (this.spoolEntries.size === 0) return 0;
        let flushed = 0;
        const files = [...this.spoolEntries.keys()];
        for (const name of files) {
            const file = path.join(this.spoolDir, name);
            let event;
            try {
                event = JSON.parse(await fsp.readFile(file, 'utf8'));
                const result = await this.publish(event);
                if (result.spooled) break;
                flushed += 1;
            } catch (error) {
                this.lastError = error.message;
                break;
            }
        }
        return flushed;
    }

    async ensureGroup() {
        if (this.groupReady) return;
        try {
            await this.redis.command(['XGROUP', 'CREATE', this.streamKey, this.group, '0', 'MKSTREAM'], { timeoutMs: this.redisCommandTimeoutMs });
        } catch (error) {
            if (!/BUSYGROUP/i.test(error.message)) throw error;
        }
        this.groupReady = true;
    }

    async _blockingCommand(parts, options) {
        try {
            return await this.blockingRedis.command(parts, options);
        } catch (error) {
            if (!isMissingConsumerGroup(error)) {
                await this.blockingRedis.close?.().catch(() => {});
                if (this.createBlockingRedis) this.blockingRedis = this.createBlockingRedis();
            }
            throw error;
        }
    }

    async readBatch({ count = 100, blockMs = 1000, claim = true } = {}) {
        await this.ensureGroup();
        if (claim !== false) {
            const claimCommand = [
                'XAUTOCLAIM', this.streamKey, this.group, this.workerId,
                String(this.pendingClaimIdleMs), '0-0', 'COUNT', count
            ];
            let claimed;
            try {
                claimed = await this._blockingCommand(claimCommand, { timeoutMs: this.redisCommandTimeoutMs });
            } catch (error) {
                if (!isMissingConsumerGroup(error)) throw error;
                this.groupReady = false;
                await this.ensureGroup();
                claimed = await this._blockingCommand(claimCommand, { timeoutMs: this.redisCommandTimeoutMs });
            }
            const claimedEvents = decodeRuntimeHookStreamResponse([[
                this.streamKey,
                claimed?.[1] || []
            ]]);
            if (claimedEvents.length > 0) return claimedEvents;
        }
        const command = [
            'XREADGROUP', 'GROUP', this.group, this.workerId,
            'COUNT', count, 'BLOCK', blockMs,
            'STREAMS', this.streamKey, '>'
        ];
        let response;
        try {
            response = await this._blockingCommand(command, { timeoutMs: Math.max(this.redisCommandTimeoutMs, blockMs + 1000) });
        } catch (error) {
            if (!isMissingConsumerGroup(error)) throw error;
            this.groupReady = false;
            await this.ensureGroup();
            response = await this._blockingCommand(command, { timeoutMs: Math.max(this.redisCommandTimeoutMs, blockMs + 1000) });
        }
        return decodeRuntimeHookStreamResponse(response);
    }

    async hasApplied(event) {
        return false;
    }

    async commit(event) {
        if (!event?.eventId || !event?.streamId) return;
        await this.redis.evalScript('commit-runtime-hook', COMMIT_SCRIPT, [this.streamKey], [
            event.streamId,
            this.group
        ]);
        this.lastCommittedAt = new Date().toISOString();
    }

    async commitBatch(events = []) {
        const committed = events.filter(event => event?.eventId && event?.streamId);
        if (committed.length === 0) return 0;
        const args = committed.map(event => event.streamId);
        const script = COMMIT_BATCH_SCRIPT.replace('ARGV[1]', `'${this.group}'`);
        await this.redis.evalScript('commit-runtime-hook-batch', script, [this.streamKey], args);
        this.lastCommittedAt = new Date().toISOString();
        return committed.length;
    }

    async pendingSnapshot() {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await this.ensureGroup();
                const pending = await this.redis.command(['XPENDING', this.streamKey, this.group], { timeoutMs: this.redisCommandTimeoutMs });
                const pendingCount = Number(pending?.[0] || 0);
                let consumerLag = pendingCount;
                try {
                    const groups = await this.redis.command(['XINFO', 'GROUPS', this.streamKey], { timeoutMs: this.redisCommandTimeoutMs });
                    const group = (groups || [])
                        .map(fieldsToObject)
                        .find(item => item.name === this.group);
                    if (group && Number.isFinite(Number(group.lag))) consumerLag = Number(group.lag);
                } catch (error) {
                    if (isMissingConsumerGroup(error)) throw error;
                }
                const [streamLength, memory, statsText] = await Promise.all([
                    this.redis.command(['XLEN', this.streamKey], { timeoutMs: this.redisCommandTimeoutMs }),
                    this._getRedisMemorySnapshot(true),
                    this.redis.command(['INFO', 'STATS'], { timeoutMs: this.redisCommandTimeoutMs })
                ]);
                const stats = parseRedisInfo(statsText);
                this.lastError = null;
                return {
                    pending: pendingCount,
                    consumerLag,
                    streamLength: Number(streamLength || 0),
                    memory,
                    totalErrorReplies: Number(stats.total_error_replies || 0),
                    oomCommandErrors: this.oomCommandErrors,
                    available: memory.critical !== true,
                    degraded: memory.degraded === true,
                    error: null
                };
            } catch (error) {
                if (attempt === 0 && isMissingConsumerGroup(error)) {
                    this.groupReady = false;
                    continue;
                }
                this.lastError = error.message;
                return {
                    pending: 0,
                    consumerLag: 0,
                    available: false,
                    error: error.message
                };
            }
        }
    }

    async _getRedisMemorySnapshot(force = false) {
        const now = Date.now();
        if (!force && this.memorySnapshot && now - this.memorySnapshotAt < 1000) return this.memorySnapshot;
        const info = parseRedisInfo(await this.redis.command(['INFO', 'MEMORY'], { timeoutMs: this.redisCommandTimeoutMs }));
        const usedBytes = Number(info.used_memory || 0);
        const peakBytes = Number(info.used_memory_peak || 0);
        const maxBytes = Number(info.maxmemory || 0);
        const ratio = maxBytes > 0 ? usedBytes / maxBytes : 0;
        this.memorySnapshot = {
            usedBytes,
            peakBytes,
            maxBytes,
            ratio,
            fragmentationRatio: Number(info.mem_fragmentation_ratio || 0),
            degraded: ratio >= 0.8,
            critical: ratio >= 0.9
        };
        this.memorySnapshotAt = now;
        return this.memorySnapshot;
    }

    snapshot() {
        this._initializeSpoolIndex();
        let oldestPendingAgeMs = 0;
        const now = Date.now();
        for (const entry of this.spoolEntries.values()) {
            oldestPendingAgeMs = Math.max(oldestPendingAgeMs, now - entry.mtimeMs);
        }
        return {
            spooled: this.spoolEntries.size,
            spoolBytes: this.spoolBytes,
            oldestPendingAgeMs,
            lastPublishedAt: this.lastPublishedAt,
            lastCommittedAt: this.lastCommittedAt,
            lastError: this.lastError,
            spoolMaxBytes: this.spoolMaxBytes,
            spoolFull: this.spoolFull
            ,oomCommandErrors: this.oomCommandErrors
        };
    }

    async close() {
        this.closed = true;
        await this.flushSpool().catch(() => {});
        await this.redis.close?.();
        if (this.blockingRedis !== this.redis) await this.blockingRedis.close?.();
    }
}

export function createRuntimeHookStreamFromEnv({ env = process.env, workerId } = {}) {
    if (!env.REDIS_URL) return null;
    const url = new URL(env.REDIS_URL);
    const redisOptions = {
        host: url.hostname,
        port: Number(url.port || (url.protocol === 'rediss:' ? 6380 : 6379)),
        password: url.password ? decodeURIComponent(url.password) : null,
        database: Number(url.pathname.replace(/^\//, '') || 0),
        tls: url.protocol === 'rediss:'
    };
    const redis = new RedisRespClient(redisOptions);
    const createBlockingRedis = () => new RedisRespClient(redisOptions);
    const blockingRedis = createBlockingRedis();
    return new RuntimeHookStream({
        redis,
        blockingRedis,
        createBlockingRedis,
        epoch: env.RUNTIME_DEPLOYMENT_EPOCH || 'default',
        workerId: workerId || env.RUNTIME_WORKER_ID || `worker-${process.pid}`,
        spoolDir: env.RUNTIME_HOOK_SPOOL_DIR || path.join(process.cwd(), 'configs', 'runtime-hook-spool', workerId || env.RUNTIME_WORKER_ID || `worker-${process.pid}`),
        spoolMaxBytes: Number(env.RUNTIME_HOOK_SPOOL_MAX_BYTES || 256 * 1024 * 1024)
    });
}
