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
for index = 2, #ARGV do
    local acknowledged = redis.call('XACK', KEYS[1], ARGV[1], ARGV[index])
    if acknowledged > 0 then
        redis.call('XDEL', KEYS[1], ARGV[index])
        committed = committed + acknowledged
    end
end
return { committed, #ARGV - 1 }
`;

function safeFileName(eventId) {
    return `${createHash('sha256').update(String(eventId)).digest('hex')}.json`;
}

function decodeSpoolRecord(raw) {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.wal === 1 && parsed.event && typeof parsed.event === 'object') {
        return {
            event: parsed.event,
            streamId: parsed.streamId || null,
            publishedAt: parsed.publishedAt || null
        };
    }
    return { event: parsed, streamId: null, publishedAt: null };
}

function encodeSpoolRecord(event, streamId = null, publishedAt = null) {
    return `${JSON.stringify({
        wal: 1,
        streamId,
        publishedAt,
        event
    })}\n`;
}

function fieldsToObject(fields = []) {
    const result = {};
    for (let index = 0; index < fields.length; index += 2) result[fields[index]] = fields[index + 1];
    return result;
}

const REDIS_MEMORY_SNAPSHOT_TTL_MS = 5000;
const REDIS_MEMORY_FORCE_TTL_MS = 1000;

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
                const payload = JSON.parse(fields.payload);
                if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
                if (!fields.eventId || payload.eventId !== fields.eventId) continue;
                events.push({ ...payload, streamId });
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
        publishedSpoolTtlMs = 60_000,
        retentionSeconds = 45 * 24 * 60 * 60,
        redisCommandTimeoutMs = 10000,
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
        this.publishedSpoolTtlMs = Math.max(1, Number(publishedSpoolTtlMs) || 60_000);
        this.spoolFull = false;
        this.retentionSeconds = retentionSeconds;
        this.redisCommandTimeoutMs = redisCommandTimeoutMs;
        this.pendingClaimIdleMs = pendingClaimIdleMs;
        this.claimCursor = '0-0';
        this.inFlightStreamIds = new Set();
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
            const file = path.join(this.spoolDir, name);
            const stat = fs.statSync(file);
            let streamId = null;
            try {
                streamId = decodeSpoolRecord(fs.readFileSync(file, 'utf8')).streamId;
            } catch {
                // Keep the file indexed so a later flush/ack can drop or repair it.
            }
            if (streamId) {
                try { fs.rmSync(file, { force: true }); } catch {
                    // Best-effort reclaim of a previous process's published WAL.
                }
                continue;
            }
            this.spoolEntries.set(name, { size: stat.size, mtimeMs: stat.mtimeMs, streamId: null });
            this.spoolBytes += stat.size;
        }
    }

    _forgetSpoolEntry(name) {
        const existing = this.spoolEntries?.get(name);
        if (!existing) return;
        this.spoolEntries.delete(name);
        this.spoolBytes = Math.max(0, this.spoolBytes - existing.size);
    }

    async _removeSpoolEntry(name) {
        await fsp.rm(path.join(this.spoolDir, name), { force: true });
        this._forgetSpoolEntry(name);
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
        const serialized = encodeSpoolRecord(event);
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
        this.spoolEntries.set(name, { size: serializedBytes, mtimeMs: Date.now(), streamId: null });
        this.spoolBytes = nextBytes;
        this.spoolFull = false;
        return target;
    }

    async publish(event) {
        const [result] = await this.publishBatch([event]);
        return result;
    }

    async publishBatch(events = []) {
        if (!Array.isArray(events) || events.length === 0) return [];
        const prepared = [];
        for (const event of events) {
            await this._writeSpool(event);
            prepared.push({
                event,
                payload: JSON.stringify(event),
                createdAt: event.createdAt || new Date().toISOString()
            });
        }
        try {
            const memory = await this._getRedisMemorySnapshot();
            if (memory.critical) {
                const error = new Error(`Redis memory pressure is critical (${Math.round(memory.ratio * 100)}%)`);
                error.code = 'REDIS_MEMORY_CRITICAL';
                throw error;
            }
            const commands = prepared.map(item => ([
                'XADD', this.streamKey, '*',
                'eventId', item.event.eventId,
                'sourceWorkerId', item.event.sourceWorkerId || this.workerId,
                'createdAt', item.createdAt,
                'payload', item.payload
            ]));
            const streamIds = typeof this.redis.commandPipeline === 'function'
                ? await this.redis.commandPipeline(commands, { timeoutMs: this.redisCommandTimeoutMs })
                : await Promise.all(commands.map(parts => this.redis.command(parts, { timeoutMs: this.redisCommandTimeoutMs })));
            this.lastPublishedAt = new Date().toISOString();
            this.lastError = null;
            const publishedAt = this.lastPublishedAt;
            await Promise.all(prepared.map((item, index) => (
                streamIds[index]
                    ? this._markPublished(item.event.eventId, streamIds[index], publishedAt)
                    : Promise.resolve()
            )));
            return prepared.map((item, index) => ({
                persisted: true,
                spooled: false,
                streamId: streamIds[index]
            }));
        } catch (error) {
            if (/\bOOM\b|maxmemory/i.test(error.message || '')) this.oomCommandErrors++;
            this.lastError = error.message;
            return prepared.map(() => ({ persisted: true, spooled: true, streamId: null }));
        }
    }

    async _markPublished(eventId, streamId, publishedAt) {
        if (!eventId || !streamId) return;
        await this._enqueueSpoolMutation(() => this._markPublishedNow(eventId, streamId, publishedAt));
    }

    async _markPublishedNow(eventId, streamId, publishedAt) {
        this._initializeSpoolIndex();
        const name = safeFileName(eventId);
        const existing = this.spoolEntries.get(name);
        const file = path.join(this.spoolDir, name);
        let record;
        try {
            record = decodeSpoolRecord(await fsp.readFile(file, 'utf8'));
        } catch (error) {
            if (error?.code === 'ENOENT') {
                this._forgetSpoolEntry(name);
                return;
            }
            throw error;
        }
        const serialized = encodeSpoolRecord(record.event, streamId, publishedAt);
        const serializedBytes = Buffer.byteLength(serialized, 'utf8');
        const temp = `${file}.${process.pid}.tmp`;
        await fsp.writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600 });
        await fsp.rename(temp, file);
        const previousBytes = existing?.size || 0;
        this.spoolBytes = Math.max(0, this.spoolBytes - previousBytes + serializedBytes);
        this.spoolEntries.set(name, {
            size: serializedBytes,
            mtimeMs: Date.now(),
            streamId
        });
    }

    async acknowledge(eventId) {
        if (!eventId) return;
        await this._enqueueSpoolMutation(async () => {
            this._initializeSpoolIndex();
            await this._removeSpoolEntry(safeFileName(eventId));
        });
    }

    async flushSpool() {
        this._initializeSpoolIndex();
        await this._enqueueSpoolMutation(async () => {
            const now = Date.now();
            for (const [name, meta] of [...this.spoolEntries.entries()]) {
                if (meta?.streamId && now - Number(meta.mtimeMs || 0) >= this.publishedSpoolTtlMs) {
                    await this._removeSpoolEntry(name);
                }
            }
        });
        const unpublished = [...this.spoolEntries.entries()]
            .filter(([, meta]) => !meta?.streamId)
            .map(([name]) => name);
        if (unpublished.length === 0) return 0;
        const prepared = [];
        for (const name of unpublished) {
            const file = path.join(this.spoolDir, name);
            try {
                const record = decodeSpoolRecord(await fsp.readFile(file, 'utf8'));
                if (record.streamId) {
                    const existing = this.spoolEntries.get(name);
                    if (existing) this.spoolEntries.set(name, { ...existing, streamId: record.streamId });
                    continue;
                }
                prepared.push({
                    name,
                    event: record.event,
                    payload: JSON.stringify(record.event),
                    createdAt: record.event?.createdAt || new Date().toISOString()
                });
            } catch (error) {
                if (error?.code === 'ENOENT') {
                    const existing = this.spoolEntries.get(name);
                    this.spoolEntries.delete(name);
                    if (existing) this.spoolBytes = Math.max(0, this.spoolBytes - existing.size);
                    continue;
                }
                this.lastError = error.message;
                break;
            }
        }
        if (prepared.length === 0) return 0;
        try {
            const memory = await this._getRedisMemorySnapshot();
            if (memory.critical) {
                const error = new Error(`Redis memory pressure is critical (${Math.round(memory.ratio * 100)}%)`);
                error.code = 'REDIS_MEMORY_CRITICAL';
                throw error;
            }
            const commands = prepared.map(item => ([
                'XADD', this.streamKey, '*',
                'eventId', item.event.eventId,
                'sourceWorkerId', item.event.sourceWorkerId || this.workerId,
                'createdAt', item.createdAt,
                'payload', item.payload
            ]));
            const streamIds = typeof this.redis.commandPipeline === 'function'
                ? await this.redis.commandPipeline(commands, { timeoutMs: this.redisCommandTimeoutMs })
                : await Promise.all(commands.map(parts => this.redis.command(parts, { timeoutMs: this.redisCommandTimeoutMs })));
            this.lastPublishedAt = new Date().toISOString();
            this.lastError = null;
            const publishedAt = this.lastPublishedAt;
            await Promise.all(prepared.map((item, index) => (
                streamIds[index]
                    ? this._markPublished(item.event.eventId, streamIds[index], publishedAt)
                    : Promise.resolve()
            )));
            return prepared.filter((_, index) => streamIds[index]).length;
        } catch (error) {
            if (/\bOOM\b|maxmemory/i.test(error.message || '')) this.oomCommandErrors++;
            this.lastError = error.message;
            return 0;
        }
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
                String(this.pendingClaimIdleMs), this.claimCursor, 'COUNT', count
            ];
            let claimed;
            try {
                claimed = await this._blockingCommand(claimCommand, { timeoutMs: this.redisCommandTimeoutMs });
            } catch (error) {
                if (!isMissingConsumerGroup(error)) throw error;
                this.groupReady = false;
                this.claimCursor = '0-0';
                await this.ensureGroup();
                claimCommand[5] = '0-0';
                claimed = await this._blockingCommand(claimCommand, { timeoutMs: this.redisCommandTimeoutMs });
            }
            this.claimCursor = claimed?.[0] || '0-0';
            const claimedEvents = decodeRuntimeHookStreamResponse([[
                this.streamKey,
                claimed?.[1] || []
            ]]).filter(event => !this.inFlightStreamIds.has(event.streamId));
            if (claimedEvents.length > 0) return claimedEvents;
        }
        const command = [
            'XREADGROUP', 'GROUP', this.group, this.workerId,
            'COUNT', count, 'BLOCK', blockMs,
            'STREAMS', this.streamKey, '>'
        ];
        let response;
        try {
            response = await this._blockingCommand(command, { timeoutMs: Math.max(this.redisCommandTimeoutMs, blockMs + 5000, 10000) });
        } catch (error) {
            if (!isMissingConsumerGroup(error)) throw error;
            this.groupReady = false;
            await this.ensureGroup();
            response = await this._blockingCommand(command, { timeoutMs: Math.max(this.redisCommandTimeoutMs, blockMs + 5000, 10000) });
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
        const args = [this.group, ...committed.map(event => event.streamId)];
        const commitResult = await this.redis.evalScript(
            'commit-runtime-hook-batch',
            COMMIT_BATCH_SCRIPT,
            [this.streamKey],
            args
        );
        const acknowledged = Array.isArray(commitResult)
            ? Number(commitResult[0] || 0)
            : Number(commitResult || 0);
        const requested = Array.isArray(commitResult)
            ? Number(commitResult[1] || 0)
            : committed.length;
        if (requested !== committed.length) {
            const error = new Error(`Runtime hook commit mismatch: expected=${committed.length} requested=${requested}`);
            error.code = 'RUNTIME_HOOK_COMMIT_MISMATCH';
            throw error;
        }
        this.lastCommittedAt = new Date().toISOString();
        return committed.length;
    }

    markInFlight(events = []) {
        for (const event of events) {
            if (event?.streamId) this.inFlightStreamIds.add(event.streamId);
        }
    }

    unmarkInFlight(events = []) {
        for (const event of events) {
            if (event?.streamId) this.inFlightStreamIds.delete(event.streamId);
        }
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
        // Every publish consulted this snapshot, which turned INFO MEMORY into one
        // of the busiest Redis commands in production. Memory pressure moves slowly
        // enough that a 5s view is still a usable guard.
        const ttlMs = force ? REDIS_MEMORY_FORCE_TTL_MS : REDIS_MEMORY_SNAPSHOT_TTL_MS;
        if (this.memorySnapshot && now - this.memorySnapshotAt < ttlMs) return this.memorySnapshot;
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
        spoolMaxBytes: Number(env.RUNTIME_HOOK_SPOOL_MAX_BYTES || 256 * 1024 * 1024),
        redisCommandTimeoutMs: Number(env.RUNTIME_HOOK_REDIS_COMMAND_TIMEOUT_MS || 10000)
    });
}
