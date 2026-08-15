import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RuntimeHookStream } from '../src/runtime/runtime-hook-stream.js';

describe('RuntimeHookStream', () => {
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

    test('commits the durable dedupe marker and stream ack in one Redis script', async () => {
        const redis = {
            command: jest.fn().mockResolvedValue(0),
            evalScript: jest.fn().mockResolvedValue(1)
        };
        const stream = new RuntimeHookStream({ redis, epoch: 'test', workerId: 'control-1' });
        await stream.commit({ eventId: 'evt-2', streamId: '2-0' });
        expect(redis.evalScript).toHaveBeenCalledWith(
            'commit-runtime-hook',
            expect.stringContaining("redis.call('XACK'"),
            expect.any(Array),
            expect.arrayContaining(['evt-2', '2-0'])
        );
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
});
