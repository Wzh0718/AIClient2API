import {
    buildRecoveryKeys,
    decodeRecoveryEntries,
    parseRecoveryArgs,
    replayRuntimeStream
} from '../scripts/ops/replay-runtime-stream.js';

describe('runtime stream recovery tool', () => {
    test('defaults to a safe dry-run and requires distinct explicit epochs', () => {
        expect(parseRecoveryArgs([
            '--source-epoch', 'prod-old',
            '--target-epoch', 'prod-new'
        ])).toMatchObject({
            sourceEpoch: 'prod-old',
            targetEpoch: 'prod-new',
            apply: false,
            batchSize: 100,
            maxEvents: 0
        });
        expect(() => parseRecoveryArgs([
            '--source-epoch', 'same',
            '--target-epoch', 'same'
        ])).toThrow(/different/i);
        expect(() => parseRecoveryArgs([
            '--source-epoch', 'prod/unsafe',
            '--target-epoch', 'prod-new'
        ])).toThrow(/epoch/i);
    });

    test('builds isolated source, target, group, and marker keys', () => {
        expect(buildRecoveryKeys({ sourceEpoch: 'prod-old', targetEpoch: 'prod-new' })).toEqual({
            sourceStream: 'aiclient2api:prod-old:runtime-hooks',
            targetStream: 'aiclient2api:prod-new:runtime-hooks',
            markerKey: 'aiclient2api:recovery:prod-old:prod-new:migrated'
        });
    });

    test('decodes only well-formed entries while preserving payload fields', () => {
        expect(decodeRecoveryEntries([
            ['1-0', ['eventId', 'evt-1', 'sourceWorkerId', 'execution-1', 'createdAt', '2026-09-02T00:00:00.000Z', 'payload', '{"eventId":"evt-1"}']],
            ['2-0', ['payload', '{bad json']]
        ])).toEqual([{
            streamId: '1-0',
            eventId: 'evt-1',
            sourceWorkerId: 'execution-1',
            createdAt: '2026-09-02T00:00:00.000Z',
            payload: '{"eventId":"evt-1"}'
        }]);
    });

    test('writes target entries before acknowledging source entries', async () => {
        const order = [];
        let readCount = 0;
        const redis = {
            command: jest.fn(async parts => {
                if (parts[0] === 'XGROUP') return 'OK';
                if (parts[0] === 'XAUTOCLAIM') return ['0-0', [], []];
                if (parts[0] === 'XREADGROUP') {
                    readCount += 1;
                    if (readCount === 1) return [[
                        'aiclient2api:prod-old:runtime-hooks',
                        [['1-0', ['eventId', 'evt-1', 'sourceWorkerId', 'execution-1', 'createdAt', '2026-09-02T00:00:00.000Z', 'payload', '{"eventId":"evt-1"}']]]
                    ]];
                    return null;
                }
                if (parts[0] === 'SISMEMBER') return 0;
                if (parts[0] === 'XADD') { order.push('xadd'); return '9-0'; }
                if (parts[0] === 'SADD') { order.push('sadd'); return 1; }
                throw new Error(`unexpected command: ${parts[0]}`);
            }),
            evalScript: jest.fn(async () => { order.push('commit'); return 1; }),
            close: jest.fn()
        };

        await expect(replayRuntimeStream({
            redis,
            sourceEpoch: 'prod-old',
            targetEpoch: 'prod-new',
            apply: true,
            batchSize: 10,
            blockMs: 0,
            maxEvents: 1,
            checkpointPath: null
        })).resolves.toMatchObject({ moved: 1, failed: 0 });
        expect(order.indexOf('xadd')).toBeLessThan(order.indexOf('commit'));
        expect(order.indexOf('sadd')).toBeLessThan(order.indexOf('commit'));
    });

    test('dry-run does not create groups or write target streams', async () => {
        const redis = { command: jest.fn(), evalScript: jest.fn() };
        await expect(replayRuntimeStream({
            redis,
            sourceEpoch: 'prod-old',
            targetEpoch: 'prod-new',
            apply: false
        })).resolves.toMatchObject({ dryRun: true, moved: 0 });
        expect(redis.command).not.toHaveBeenCalled();
        expect(redis.evalScript).not.toHaveBeenCalled();
    });

    test('leaves the source pending when the target write fails', async () => {
        let readCount = 0;
        const redis = {
            command: jest.fn(async parts => {
                if (parts[0] === 'XGROUP') return 'OK';
                if (parts[0] === 'XAUTOCLAIM') return ['0-0', [], []];
                if (parts[0] === 'XREADGROUP') {
                    readCount += 1;
                    if (readCount !== 1) return null;
                    const entry = [
                        '1-0',
                        ['eventId', 'evt-fail', 'createdAt', '2026-09-02T00:00:00.000Z', 'payload', '{"eventId":"evt-fail"}']
                    ];
                    return [['source', [entry]]];
                }
                if (parts[0] === 'SISMEMBER') return 0;
                if (parts[0] === 'XADD') throw new Error('target unavailable');
                throw new Error(`unexpected command: ${parts[0]}`);
            }),
            evalScript: jest.fn(),
            close: jest.fn()
        };

        await expect(replayRuntimeStream({
            redis,
            sourceEpoch: 'prod-old',
            targetEpoch: 'prod-new',
            apply: true,
            blockMs: 0,
            maxEvents: 1,
            checkpointPath: null
        })).resolves.toMatchObject({ moved: 0, failed: 1 });
        expect(redis.evalScript).not.toHaveBeenCalled();
    });
});
