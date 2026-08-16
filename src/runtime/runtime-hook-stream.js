import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RedisRespClient } from './redis-resp-client.js';

const COMMIT_SCRIPT = `
local added = redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
redis.call('XACK', KEYS[2], ARGV[4], ARGV[2])
return added
`;

const COMMIT_BATCH_SCRIPT = `
local committed = 0
for index = 1, #ARGV, 2 do
    redis.call('SADD', KEYS[1], ARGV[index])
    redis.call('XACK', KEYS[2], ARGV[2], ARGV[index + 1])
    committed = committed + 1
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
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
    }

    async _writeSpool(event) {
        await fsp.mkdir(this.spoolDir, { recursive: true });
        const serialized = `${JSON.stringify(event)}\n`;
        const currentBytes = this.snapshot().spoolBytes;
        if (currentBytes + Buffer.byteLength(serialized, 'utf8') > this.spoolMaxBytes) {
            this.spoolFull = true;
            const error = new Error(`Runtime hook spool limit exceeded (${this.spoolMaxBytes} bytes)`);
            error.code = 'RUNTIME_HOOK_SPOOL_FULL';
            throw error;
        }
        const target = path.join(this.spoolDir, safeFileName(event.eventId));
        const temp = `${target}.${process.pid}.tmp`;
        await fsp.writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600 });
        await fsp.rename(temp, target);
        this.spoolFull = false;
        return target;
    }

    async publish(event) {
        const payload = JSON.stringify(event);
        try {
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
            await this._writeSpool(event);
            this.lastError = error.message;
            return { persisted: true, spooled: true, streamId: null };
        }
    }

    async acknowledge(eventId) {
        if (!eventId || !fs.existsSync(this.spoolDir)) return;
        await fsp.rm(path.join(this.spoolDir, safeFileName(eventId)), { force: true });
    }

    async flushSpool() {
        if (!fs.existsSync(this.spoolDir)) return 0;
        let flushed = 0;
        const files = (await fsp.readdir(this.spoolDir)).filter(name => name.endsWith('.json'));
        for (const name of files) {
            const file = path.join(this.spoolDir, name);
            let event;
            try {
                event = JSON.parse(await fsp.readFile(file, 'utf8'));
                const result = await this.publish(event);
                if (result.spooled) break;
                await fsp.rm(file, { force: true });
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

    async readBatch({ count = 100, blockMs = 1000 } = {}) {
        await this.ensureGroup();
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
        if (!event?.eventId) return false;
        return Number(await this.redis.command(['SISMEMBER', this.processedKey, event.eventId], { timeoutMs: this.redisCommandTimeoutMs })) === 1;
    }

    async commit(event) {
        if (!event?.eventId || !event?.streamId) return;
        await this.redis.evalScript('commit-runtime-hook', COMMIT_SCRIPT, [this.processedKey, this.streamKey], [
            event.eventId,
            event.streamId,
            String(this.retentionSeconds),
            this.group
        ]);
        this.lastCommittedAt = new Date().toISOString();
    }

    async commitBatch(events = []) {
        const committed = events.filter(event => event?.eventId && event?.streamId);
        if (committed.length === 0) return 0;
        const args = committed.flatMap(event => [event.eventId, event.streamId]);
        const script = COMMIT_BATCH_SCRIPT
            .replace('tonumber(ARGV[1])', `tonumber('${this.retentionSeconds}')`)
            .replace('ARGV[2]', `'${this.group}'`);
        await this.redis.evalScript('commit-runtime-hook-batch', script, [this.processedKey, this.streamKey], args);
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
                this.lastError = null;
                return { pending: pendingCount, consumerLag, available: true, error: null };
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

    snapshot() {
        let spooled = 0;
        let spoolBytes = 0;
        let oldestPendingAgeMs = 0;
        if (fs.existsSync(this.spoolDir)) {
            const now = Date.now();
            for (const name of fs.readdirSync(this.spoolDir).filter(item => item.endsWith('.json'))) {
                const stat = fs.statSync(path.join(this.spoolDir, name));
                spooled += 1;
                spoolBytes += stat.size;
                oldestPendingAgeMs = Math.max(oldestPendingAgeMs, now - stat.mtimeMs);
            }
        }
        return {
            spooled,
            spoolBytes,
            oldestPendingAgeMs,
            lastPublishedAt: this.lastPublishedAt,
            lastCommittedAt: this.lastCommittedAt,
            lastError: this.lastError,
            spoolMaxBytes: this.spoolMaxBytes,
            spoolFull: this.spoolFull
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
