import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { RedisRespClient } from '../../src/runtime/redis-resp-client.js';

const SAFE_EPOCH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT_SOURCE_BATCH_SCRIPT = `
local committed = 0
for index = 2, #ARGV do
    local acknowledged = redis.call('XACK', KEYS[1], ARGV[1], ARGV[index])
    if acknowledged > 0 then
        redis.call('XDEL', KEYS[1], ARGV[index])
        committed = committed + acknowledged
    end
end
return committed
`;

const WRITE_TARGET_ENTRY_SCRIPT = `
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then
    return 0
end
redis.call('XADD', KEYS[1], '*',
    'eventId', ARGV[1],
    'sourceWorkerId', ARGV[2],
    'createdAt', ARGV[3],
    'payload', ARGV[4]
)
redis.call('SADD', KEYS[2], ARGV[1])
return 1
`;

const RELEASE_RECOVERY_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
`;

function fieldsToObject(fields = []) {
    const result = {};
    for (let index = 0; index < fields.length; index += 2) result[fields[index]] = fields[index + 1];
    return result;
}

function readArgValue(argv, index, flag) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
}

function positiveInteger(value, fallback, label, { allowZero = false, maximum = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number(value);
    const minimum = allowZero ? 0 : 1;
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        if (value === undefined || value === null) return fallback;
        throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
    }
    return parsed;
}

function validateEpoch(value, label) {
    if (!value || !SAFE_EPOCH.test(value)) throw new Error(`${label} must contain only letters, numbers, '.', '_' or '-'`);
    return value;
}

function defaultCheckpointPath(sourceEpoch, targetEpoch) {
    const directory = process.env.RUNTIME_RECOVERY_CHECKPOINT_DIR
        || path.join(os.tmpdir(), 'aiclient2api-runtime-recovery');
    return path.join(directory, `${sourceEpoch}--${targetEpoch}.json`);
}

export function parseRecoveryArgs(argv = []) {
    const options = {
        sourceEpoch: null,
        targetEpoch: null,
        redisUrl: process.env.REDIS_URL || null,
        apply: false,
        batchSize: 100,
        maxEvents: 0,
        blockMs: 1000,
        claimIdleMs: 0,
        group: null,
        consumer: `recovery-${process.pid}`,
        checkpointPath: null
        ,checkpointDisabled: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        switch (flag) {
            case '--source-epoch': options.sourceEpoch = readArgValue(argv, index, flag); index += 1; break;
            case '--target-epoch': options.targetEpoch = readArgValue(argv, index, flag); index += 1; break;
            case '--redis-url': options.redisUrl = readArgValue(argv, index, flag); index += 1; break;
            case '--batch-size': options.batchSize = positiveInteger(readArgValue(argv, index, flag), 100, flag, { maximum: 10_000 }); index += 1; break;
            case '--max-events': options.maxEvents = positiveInteger(readArgValue(argv, index, flag), 0, flag, { allowZero: true }); index += 1; break;
            case '--block-ms': options.blockMs = Math.max(1, positiveInteger(readArgValue(argv, index, flag), 1000, flag, { allowZero: true, maximum: 60_000 })); index += 1; break;
            case '--claim-idle-ms': options.claimIdleMs = positiveInteger(readArgValue(argv, index, flag), 0, flag, { allowZero: true, maximum: 86_400_000 }); index += 1; break;
            case '--group': options.group = readArgValue(argv, index, flag); index += 1; break;
            case '--consumer': options.consumer = readArgValue(argv, index, flag); index += 1; break;
            case '--checkpoint': options.checkpointPath = readArgValue(argv, index, flag); index += 1; break;
            case '--no-checkpoint': options.checkpointPath = null; options.checkpointDisabled = true; break;
            case '--apply': options.apply = true; break;
            case '--dry-run': options.apply = false; break;
            case '--help':
            case '-h': options.help = true; break;
            default: throw new Error(`unknown option: ${flag}`);
        }
    }
    if (options.help) return options;
    validateEpoch(options.sourceEpoch, 'source epoch');
    validateEpoch(options.targetEpoch, 'target epoch');
    if (options.sourceEpoch === options.targetEpoch) throw new Error('source and target epochs must be different');
    if (!options.redisUrl && options.apply) throw new Error('--redis-url or REDIS_URL is required when --apply is used');
    options.group = options.group || `recovery-${options.sourceEpoch}-${options.targetEpoch}`;
    options.checkpointPath = options.checkpointDisabled
        ? null
        : options.checkpointPath === null
        ? defaultCheckpointPath(options.sourceEpoch, options.targetEpoch)
        : options.checkpointPath;
    return options;
}

export function buildRecoveryKeys({ sourceEpoch, targetEpoch } = {}) {
    validateEpoch(sourceEpoch, 'source epoch');
    validateEpoch(targetEpoch, 'target epoch');
    if (sourceEpoch === targetEpoch) throw new Error('source and target epochs must be different');
    return {
        sourceStream: `aiclient2api:${sourceEpoch}:runtime-hooks`,
        targetStream: `aiclient2api:${targetEpoch}:runtime-hooks`,
        markerKey: `aiclient2api:recovery:${sourceEpoch}:${targetEpoch}:migrated`
    };
}

export function decodeRecoveryEntries(entries = []) {
    const decoded = [];
    for (const entry of entries) {
        const streamId = entry?.[0];
        const fields = fieldsToObject(entry?.[1]);
        if (!streamId || !fields.eventId || !fields.payload) continue;
        try {
            const payload = JSON.parse(fields.payload);
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
            if (payload.eventId !== fields.eventId) continue;
        } catch {
            continue;
        }
        decoded.push({
            streamId,
            eventId: fields.eventId,
            sourceWorkerId: fields.sourceWorkerId || null,
            createdAt: fields.createdAt || null,
            payload: fields.payload
        });
    }
    return decoded;
}

function redisOptionsFromUrl(redisUrl) {
    const url = new URL(redisUrl);
    return {
        host: url.hostname,
        port: Number(url.port || (url.protocol === 'rediss:' ? 6380 : 6379)),
        password: url.password ? decodeURIComponent(url.password) : null,
        database: Number(url.pathname.replace(/^\//, '') || 0),
        tls: url.protocol === 'rediss:'
    };
}

async function loadCheckpoint(checkpointPath, sourceEpoch, targetEpoch) {
    if (!checkpointPath || !fs.existsSync(checkpointPath)) return null;
    try {
        const checkpoint = JSON.parse(await fsp.readFile(checkpointPath, 'utf8'));
        if (checkpoint.sourceEpoch !== sourceEpoch || checkpoint.targetEpoch !== targetEpoch) {
            throw new Error('checkpoint source/target epoch mismatch');
        }
        return checkpoint;
    } catch (error) {
        throw new Error(`failed to load recovery checkpoint: ${error.message}`);
    }
}

async function saveCheckpoint(checkpointPath, checkpoint) {
    if (!checkpointPath) return;
    await fsp.mkdir(path.dirname(checkpointPath), { recursive: true, mode: 0o700 });
    try { await fsp.chmod(path.dirname(checkpointPath), 0o700); } catch {}
    const temporaryPath = `${checkpointPath}.${process.pid}.tmp`;
    await fsp.writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { await fsp.chmod(temporaryPath, 0o600); } catch {}
    await fsp.rename(temporaryPath, checkpointPath);
}

async function ensureRecoveryGroup(redis, streamKey, group) {
    try {
        // The source stream is checked before this call. Omitting MKSTREAM
        // also prevents a race from creating an empty recovery source.
        await redis.command(['XGROUP', 'CREATE', streamKey, group, '0']);
    } catch (error) {
        if (!/BUSYGROUP/i.test(error?.message || '')) throw error;
    }
}

async function acquireRecoveryLock(redis, lockKey, token, ttlMs) {
    const result = await redis.command(['SET', lockKey, token, 'PX', ttlMs, 'NX']);
    if (String(result).toUpperCase() === 'OK' || Number(result) === 1) return;
    const error = new Error(`runtime stream recovery is already running for ${lockKey}`);
    error.code = 'RUNTIME_RECOVERY_LOCKED';
    throw error;
}

async function releaseRecoveryLock(redis, lockKey, token) {
    await redis.evalScript('replay-runtime-stream-release-lock', RELEASE_RECOVERY_LOCK_SCRIPT, [lockKey], [token]);
}

async function commitSourceBatch(redis, sourceStream, group, sourceIds) {
    if (sourceIds.length === 0) return 0;
    return redis.evalScript(
        'replay-runtime-stream-commit',
        COMMIT_SOURCE_BATCH_SCRIPT,
        [sourceStream],
        [group, ...sourceIds]
    );
}

async function writeTargetEntry(redis, targetStream, markerKey, event) {
    return Number(await redis.evalScript(
        'replay-runtime-stream-write',
        WRITE_TARGET_ENTRY_SCRIPT,
        [targetStream, markerKey],
        [event.eventId, event.sourceWorkerId || '', event.createdAt || new Date().toISOString(), event.payload]
    ) || 0);
}

async function readRecoveryBatch(redis, {
    sourceStream,
    group,
    consumer,
    count,
    blockMs,
    claimIdleMs
}) {
    const safeBlockMs = Math.max(1, Number(blockMs) || 1);
    try {
        const claimed = await redis.command([
            'XAUTOCLAIM', sourceStream, group, consumer,
            claimIdleMs, '0-0', 'COUNT', count
        ], { timeoutMs: Math.max(5000, safeBlockMs + 2000) });
        const claimedEntries = claimed?.[1] || [];
        if (claimedEntries.length > 0) return claimedEntries;
    } catch (error) {
        // Redis < 6.2 has no XAUTOCLAIM. The dedicated recovery group can
        // still consume new entries, while the error is surfaced only if the
        // normal read also fails.
        if (!/unknown command|unsupported command|syntax error/i.test(error?.message || '')) throw error;
    }
    const response = await redis.command([
        'XREADGROUP', 'GROUP', group, consumer,
        'COUNT', count, 'BLOCK', safeBlockMs,
        'STREAMS', sourceStream, '>'
    ], { timeoutMs: Math.max(5000, safeBlockMs + 2000) });
    return response?.[0]?.[1] || [];
}

export async function replayRuntimeStream({
    redis,
    sourceEpoch,
    targetEpoch,
    apply = false,
    batchSize = 100,
    maxEvents = 0,
    blockMs = 1000,
    claimIdleMs = 0,
    group = null,
    consumer = `recovery-${process.pid}`,
    checkpointPath = null,
    lock = true,
    lockTtlMs = 300_000,
    now = () => new Date().toISOString()
} = {}) {
    const keys = buildRecoveryKeys({ sourceEpoch, targetEpoch });
    if (!apply) {
        return {
            dryRun: true,
            moved: 0,
            skipped: 0,
            failed: 0,
            sourceStream: keys.sourceStream,
            targetStream: keys.targetStream,
            markerKey: keys.markerKey
        };
    }
    if (!redis?.command) throw new TypeError('Redis client with command() is required');
    const sourceExists = await redis.command(['EXISTS', keys.sourceStream]);
    if (Number(sourceExists) !== 1) {
        return {
            dryRun: false,
            sourceMissing: true,
            moved: 0,
            skipped: 0,
            failed: 0,
            processed: 0,
            sourceStream: keys.sourceStream,
            targetStream: keys.targetStream,
            markerKey: keys.markerKey
        };
    }
    if (!redis?.evalScript) throw new TypeError('Redis client with command() and evalScript() is required');
    const resolvedGroup = group || `recovery-${sourceEpoch}-${targetEpoch}`;
    const safeBatchSize = Math.min(10_000, Math.max(1, Math.floor(Number(batchSize) || 1)));
    const safeMaxEvents = Math.max(0, Math.floor(Number(maxEvents) || 0));
    const safeBlockMs = Math.min(60_000, Math.max(1, Number(blockMs) || 1));
    const safeClaimIdleMs = Math.min(86_400_000, Math.max(0, Number(claimIdleMs) || 0));
    const lockKey = `${keys.markerKey}:lock`;
    const lockToken = `${process.pid}:${Date.now()}:${randomUUID()}`;
    let lockAcquired = false;
    if (lock !== false) {
        await acquireRecoveryLock(redis, lockKey, lockToken, Math.max(1, Number(lockTtlMs) || 300_000));
        lockAcquired = true;
    }
    try {
        const checkpoint = await loadCheckpoint(checkpointPath, sourceEpoch, targetEpoch);
        let moved = Number(checkpoint?.moved || 0);
        let skipped = Number(checkpoint?.skipped || 0);
        let failed = Number(checkpoint?.failed || 0);
        let processed = moved + skipped;
        let lastSourceId = checkpoint?.lastSourceId || null;
        await ensureRecoveryGroup(redis, keys.sourceStream, resolvedGroup);

        while (safeMaxEvents === 0 || processed < safeMaxEvents) {
            const remaining = safeMaxEvents === 0 ? safeBatchSize : Math.min(safeBatchSize, safeMaxEvents - processed);
            const rawEntries = await readRecoveryBatch(redis, {
                sourceStream: keys.sourceStream,
                group: resolvedGroup,
                consumer,
                count: remaining,
                blockMs: safeBlockMs,
                claimIdleMs: safeClaimIdleMs
            });
            if (rawEntries.length === 0) break;
            const entries = decodeRecoveryEntries(rawEntries);
            const invalidEntries = rawEntries.length - entries.length;
            failed += invalidEntries;
            const sourceIds = [];
            let failedInBatch = invalidEntries;
            for (const event of entries) {
                if (safeMaxEvents > 0 && processed >= safeMaxEvents) break;
                try {
                    const inserted = await writeTargetEntry(redis, keys.targetStream, keys.markerKey, event);
                    sourceIds.push(event.streamId);
                    if (inserted === 1) moved += 1;
                    else skipped += 1;
                    processed += 1;
                    lastSourceId = event.streamId;
                } catch (error) {
                    failed += 1;
                    failedInBatch += 1;
                    // Leave this source entry pending. The next invocation can retry it;
                    // no source ACK/XDEL is attempted after a failed target write.
                }
            }
            const committed = Number(await commitSourceBatch(redis, keys.sourceStream, resolvedGroup, sourceIds) || 0);
            if (committed !== sourceIds.length) {
                throw new Error(`source commit mismatch: expected=${sourceIds.length} committed=${committed}`);
            }
            await saveCheckpoint(checkpointPath, {
                sourceEpoch,
                targetEpoch,
                group: resolvedGroup,
                consumer,
                markerKey: keys.markerKey,
                lastSourceId,
                moved,
                skipped,
                failed,
                updatedAt: now()
            });
            if (failedInBatch > 0 || rawEntries.length < remaining) break;
        }
        return {
            dryRun: false,
            moved,
            skipped,
            failed,
            processed,
            lastSourceId,
            sourceStream: keys.sourceStream,
            targetStream: keys.targetStream,
            markerKey: keys.markerKey,
            group: resolvedGroup
        };
    } finally {
        if (lockAcquired) await releaseRecoveryLock(redis, lockKey, lockToken).catch(() => {});
    }
}

function printHelp() {
    process.stdout.write([
        '用法：node scripts/ops/replay-runtime-stream.js --source-epoch OLD --target-epoch NEW [--apply]',
        '',
        '默认 dry-run；--apply 才会创建 recovery group、写目标 stream，并在目标写入成功后 ACK/XDEL 源事件。',
        '--batch-size N       每批读取数量（默认 100）',
        '--max-events N       最多迁移数量，0 表示直到源 stream 读空',
        '--checkpoint PATH    断点文件；默认写入系统临时目录',
        '--no-checkpoint      不写断点文件',
        '--redis-url URL      覆盖 REDIS_URL（仅 --apply 需要）'
    ].join('\n') + '\n');
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseRecoveryArgs(argv);
    if (options.help) {
        printHelp();
        return 0;
    }
    if (!options.apply) {
        process.stdout.write(`${JSON.stringify(await replayRuntimeStream(options), null, 2)}\n`);
        return 0;
    }
    const redis = new RedisRespClient(redisOptionsFromUrl(options.redisUrl));
    try {
        const result = await replayRuntimeStream({ ...options, redis });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result.failed > 0 ? 1 : 0;
    } finally {
        await redis.close().catch(() => {});
    }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && import.meta.url === invokedPath) {
    main().then(code => { if (code) process.exitCode = code; })
        .catch(error => {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
        });
}
