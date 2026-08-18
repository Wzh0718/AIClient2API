import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeHookStream } from '../src/runtime/runtime-hook-stream.js';

describe('RuntimeHookStream', () => {
    test('uses a dedicated Redis connection for blocking reads', async () => {
        const redis = {
            command: jest.fn(async parts => parts[0] === 'SISMEMBER' ? 0 : 'OK')
        };
        const blockingRedis = {
            command: jest.fn(async parts => {
                if (parts[0] === 'XGROUP') return 'OK';
                if (parts[0] === 'XAUTOCLAIM') return ['0-0', [], []];
                if (parts[0] === 'XREADGROUP') return null;
                throw new Error(`unexpected blocking command: ${parts[0]}`);
            })
        };
        const stream = new RuntimeHookStream({
            redis,
            blockingRedis,
            epoch: 'test',
            workerId: 'control-1'
        });

        await expect(stream.readBatch({ blockMs: 0 })).resolves.toEqual([]);
        await expect(stream.hasApplied({ eventId: 'evt-isolated' })).resolves.toBe(false);

        expect(blockingRedis.command).toHaveBeenCalledWith(
            expect.arrayContaining(['XREADGROUP']),
            expect.any(Object)
        );
        expect(redis.command.mock.calls.some(([parts]) => parts[0] === 'SISMEMBER')).toBe(false);
        expect(redis.command.mock.calls.some(([parts]) => parts[0] === 'XREADGROUP')).toBe(false);
    });

    test('closes a failed blocking connection so the next poll can reconnect', async () => {
        const redis = { command: jest.fn().mockResolvedValue('OK') };
        const blockingRedis = {
            command: jest.fn().mockRejectedValue(new Error('Redis connection timeout')),
            close: jest.fn().mockResolvedValue(undefined)
        };
        const replacement = {
            command: jest.fn(async parts => {
                if (parts[0] === 'XAUTOCLAIM') return ['0-0', [], []];
                if (parts[0] === 'XREADGROUP') return null;
                return 'OK';
            }),
            close: jest.fn().mockResolvedValue(undefined)
        };
        const createBlockingRedis = jest.fn(() => replacement);
        const stream = new RuntimeHookStream({
            redis,
            blockingRedis,
            createBlockingRedis,
            epoch: 'test',
            workerId: 'control-1'
        });

        await expect(stream.readBatch({ blockMs: 0 })).rejects.toThrow('Redis connection timeout');
        await expect(stream.readBatch({ blockMs: 0 })).resolves.toEqual([]);

        expect(blockingRedis.close).toHaveBeenCalledTimes(1);
        expect(createBlockingRedis).toHaveBeenCalledTimes(1);
        expect(replacement.command).toHaveBeenCalled();
    });

    test('spools failed Redis publishes and flushes them after recovery', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-hook-spool-'));
        let available = false;
        const commands = [];
        const redis = {
            command: jest.fn(async parts => {
                commands.push(parts);
                if (!available) throw new Error('redis unavailable');
                return '1-0';
            })
        };
        const stream = new RuntimeHookStream({ redis, epoch: 'test', workerId: 'execution-1', spoolDir: dir });
        const event = { eventId: 'evt-1', type: 'runtime_hook', args: [{ potluckKeyHash: 'sha256:test' }] };

        await expect(stream.publish(event)).resolves.toMatchObject({ spooled: true });
        expect(stream.snapshot()).toMatchObject({ spooled: 1 });
        available = true;
        await stream.flushSpool();
        expect(stream.snapshot()).toMatchObject({ spooled: 0 });
        expect(commands.some(parts => parts[0] === 'XADD')).toBe(true);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('atomically acknowledges and deletes a committed stream entry', async () => {
        const redis = {
            command: jest.fn().mockResolvedValue(0),
            evalScript: jest.fn().mockResolvedValue(1)
        };
        const stream = new RuntimeHookStream({ redis, epoch: 'test', workerId: 'control-1' });
        await stream.commit({ eventId: 'evt-2', streamId: '2-0' });
        const singleCall = redis.evalScript.mock.calls[0];
        expect(singleCall).toEqual(['commit-runtime-hook', expect.any(String), [stream.streamKey], ['2-0', 'control']]);
        expect(singleCall[1]).toContain("redis.call('XACK'");
        expect(singleCall[1]).toContain("redis.call('XDEL'");
        expect(singleCall[1]).not.toContain('SADD');
    });

    test('commits a batch of stream entries after the local ledger transaction', async () => {
        const redis = {
            command: jest.fn().mockResolvedValue(0),
            evalScript: jest.fn().mockResolvedValue(2)
        };
        const stream = new RuntimeHookStream({ redis, epoch: 'test', workerId: 'control-1' });
        await stream.commitBatch([
            { eventId: 'evt-a', streamId: '10-0' },
            { eventId: 'evt-b', streamId: '11-0' }
        ]);
        const batchCall = redis.evalScript.mock.calls[0];
        expect(batchCall).toEqual(['commit-runtime-hook-batch', expect.any(String), [stream.streamKey], ['10-0', '11-0']]);
        expect(batchCall[1]).toContain("redis.call('XACK'");
        expect(batchCall[1]).toContain("redis.call('XDEL'");
        expect(batchCall[1]).not.toContain('SADD');
    });

    test('reports Redis memory and stream length without retaining acknowledged entries', async () => {
        const redis = {
            command: jest.fn(async parts => {
                if (parts[0] === 'XGROUP') return 'OK';
                if (parts[0] === 'XPENDING') return [2, null, null, []];
                if (parts[0] === 'XINFO') return [['name', 'control', 'lag', 3]];
                if (parts[0] === 'XLEN') return 5;
                if (parts[0] === 'INFO' && parts[1] === 'MEMORY') {
                    return 'used_memory:629145600\r\nused_memory_peak:700000000\r\nmaxmemory:805306368\r\nmem_fragmentation_ratio:1.25\r\n';
                }
                if (parts[0] === 'INFO' && parts[1] === 'STATS') return 'total_error_replies:4\r\n';
                return 0;
            })
        };
        const stream = new RuntimeHookStream({ redis, epoch: 'test', workerId: 'control-1' });

        await expect(stream.pendingSnapshot()).resolves.toMatchObject({
            pending: 2,
            consumerLag: 3,
            streamLength: 5,
            memory: {
                usedBytes: 629145600,
                peakBytes: 700000000,
                maxBytes: 805306368,
                ratio: expect.any(Number),
                fragmentationRatio: 1.25,
                degraded: false,
                critical: false
            },
            totalErrorReplies: 4
        });
    });

    test('closes the underlying Redis connection', async () => {
        const redis = {
            command: jest.fn().mockResolvedValue(0),
            close: jest.fn().mockResolvedValue(undefined)
        };
        const stream = new RuntimeHookStream({ redis, epoch: 'test', workerId: 'control-1' });

        await stream.close();

        expect(redis.close).toHaveBeenCalledTimes(1);
    });

    test('recreates the consumer group when Redis loses it after restart', async () => {
        let readAttempts = 0;
        const redis = {
            command: jest.fn(async parts => {
                if (parts[0] === 'XGROUP') return 'OK';
                if (parts[0] === 'XREADGROUP') {
                    readAttempts += 1;
                    if (readAttempts === 1) throw new Error('NOGROUP No such key or consumer group');
                    return [[
                        'aiclient2api:test:runtime-hooks',
                        [['3-0', ['payload', JSON.stringify({ eventId: 'evt-recovered' })]]]
                    ]];
                }
                return 0;
            })
        };
        const stream = new RuntimeHookStream({ redis, epoch: 'test', workerId: 'control-1' });

        await expect(stream.readBatch({ blockMs: 0 })).resolves.toEqual([
            expect.objectContaining({ eventId: 'evt-recovered', streamId: '3-0' })
        ]);
        expect(redis.command.mock.calls.filter(([parts]) => parts[0] === 'XGROUP')).toHaveLength(2);
    });

    test('reclaims stale pending entries before waiting for new stream events', async () => {
        const redis = {
            command: jest.fn(async parts => {
                if (parts[0] === 'XGROUP') return 'OK';
                if (parts[0] === 'XAUTOCLAIM') {
                    return ['0-0', [[
                        '4-0',
                        ['payload', JSON.stringify({ eventId: 'evt-stale' })]
                    ]], []];
                }
                if (parts[0] === 'XREADGROUP') return null;
                return 0;
            })
        };
        const stream = new RuntimeHookStream({
            redis,
            epoch: 'test',
            workerId: 'control-1',
            pendingClaimIdleMs: 30_000
        });

        await expect(stream.readBatch({ blockMs: 0 })).resolves.toEqual([
            expect.objectContaining({ eventId: 'evt-stale', streamId: '4-0' })
        ]);
        expect(redis.command).toHaveBeenCalledWith(
            expect.arrayContaining(['XAUTOCLAIM', expect.any(String), 'control', 'control-1', '30000']),
            expect.any(Object)
        );
        expect(redis.command.mock.calls.some(([parts]) => parts[0] === 'XREADGROUP')).toBe(false);
    });

    test('recreates the consumer group when pending reclaim sees NOGROUP', async () => {
        let claimAttempts = 0;
        const redis = {
            command: jest.fn(async parts => {
                if (parts[0] === 'XGROUP') return 'OK';
                if (parts[0] === 'XAUTOCLAIM') {
                    claimAttempts += 1;
                    if (claimAttempts === 1) throw new Error('NOGROUP No such key or consumer group');
                    return ['0-0', [], []];
                }
                if (parts[0] === 'XREADGROUP') return null;
                return 0;
            })
        };
        const stream = new RuntimeHookStream({ redis, epoch: 'test', workerId: 'control-1' });

        await expect(stream.readBatch({ blockMs: 0 })).resolves.toEqual([]);
        expect(redis.command.mock.calls.filter(([parts]) => parts[0] === 'XGROUP')).toHaveLength(2);
        expect(claimAttempts).toBe(2);
    });

    test('pending snapshot reports a Redis group error instead of a false zero backlog', async () => {
        const redis = {
            command: jest.fn(async parts => {
                if (parts[0] === 'XGROUP') return 'OK';
                throw new Error('NOGROUP No such key or consumer group');
            })
        };
        const stream = new RuntimeHookStream({ redis, epoch: 'test', workerId: 'control-1' });

        await expect(stream.pendingSnapshot()).resolves.toMatchObject({
            pending: 0,
            consumerLag: 0,
            available: false,
            error: expect.stringMatching(/NOGROUP/)
        });
    });

    test('uses bounded Redis commands so an outage can fall back to spool', async () => {
        const redis = {
            command: jest.fn().mockRejectedValue(new Error('Redis command timeout'))
        };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-hook-timeout-'));
        const stream = new RuntimeHookStream({ redis, epoch: 'test', workerId: 'execution-1', spoolDir: dir });

        await expect(stream.publish({ eventId: 'evt-timeout' })).resolves.toMatchObject({ spooled: true });
        expect(redis.command).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ timeoutMs: expect.any(Number) }));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('rejects new spool writes after the configured disk bound without growing memory', async () => {
        const redis = { command: jest.fn().mockRejectedValue(new Error('redis unavailable')) };
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-hook-spool-bound-'));
        const stream = new RuntimeHookStream({
            redis,
            epoch: 'test',
            workerId: 'execution-1',
            spoolDir: dir,
            spoolMaxBytes: 128
        });
        await stream.publish({ eventId: 'small', args: [{ value: 'x'.repeat(16) }] });
        await expect(stream.publish({ eventId: 'too-large', args: [{ value: 'x'.repeat(256) }] }))
            .rejects.toMatchObject({ code: 'RUNTIME_HOOK_SPOOL_FULL' });
        expect(stream.snapshot()).toMatchObject({ spoolFull: true });
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
