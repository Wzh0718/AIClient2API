import {
    buildKeyConfigSyncAck,
    createKeyConfigAckTracker,
    isCurrentWorkerInstance
} from '../src/runtime/multi-worker-runtime.js';

describe('API Potluck key config synchronization acknowledgements', () => {
    test('tracks worker acknowledgements by control epoch and revision', () => {
        const tracker = createKeyConfigAckTracker();

        tracker.notePublished('epoch-a', 7, ['execution-1', 'execution-2']);
        tracker.acknowledge('execution-1', 'epoch-a', 7);

        expect(tracker.snapshot(['execution-1', 'execution-2'])).toEqual({
            currentEpoch: 'epoch-a',
            currentRevision: 7,
            pendingWorkerCount: 1,
            pendingWorkers: ['execution-2'],
            workerStates: {
                'execution-1': { epoch: 'epoch-a', revision: 7 },
                'execution-2': { epoch: null, revision: 0 }
            }
        });

        tracker.notePublished('epoch-b', 1, ['execution-1', 'execution-2']);
        expect(tracker.snapshot(['execution-1', 'execution-2'])).toMatchObject({
            currentEpoch: 'epoch-b',
            currentRevision: 1,
            pendingWorkerCount: 2
        });
        tracker.acknowledge('execution-2', 'epoch-a', 99);
        expect(tracker.snapshot(['execution-1', 'execution-2']).pendingWorkerCount).toBe(2);
        tracker.acknowledge('execution-1', 'epoch-b', 1);
        tracker.acknowledge('execution-2', 'epoch-b', 1);
        expect(tracker.snapshot(['execution-1', 'execution-2']).pendingWorkerCount).toBe(0);
    });

    test('acknowledges only the state actually reported by the execution plugin', () => {
        expect(buildKeyConfigSyncAck(undefined)).toEqual({ epoch: null, revision: 0, applied: false });
        expect(buildKeyConfigSyncAck({
            applied: false,
            malformed: true,
            epoch: 'epoch-a',
            revision: 4
        })).toEqual({ epoch: 'epoch-a', revision: 4, applied: false });
        expect(buildKeyConfigSyncAck({
            applied: true,
            epoch: 'epoch-b',
            revision: 1
        })).toEqual({ epoch: 'epoch-b', revision: 1, applied: true });
    });

    test('rejects delayed messages from a replaced control or execution process', () => {
        const currentChild = {};
        const replacedChild = {};
        const workers = new Map([['control-1', { child: currentChild }]]);

        expect(isCurrentWorkerInstance(workers, 'control-1', currentChild)).toBe(true);
        expect(isCurrentWorkerInstance(workers, 'control-1', replacedChild)).toBe(false);
        expect(isCurrentWorkerInstance(workers, 'missing', currentChild)).toBe(false);
    });
});
