import { EventEmitter } from 'node:events';
import { writeWithBackpressure } from '../src/runtime/runtime-backpressure.js';

test('waits for drain when a response applies backpressure', async () => {
    let drained = false;
    const response = { write: () => false, once: (event, cb) => { if (event === 'drain') setTimeout(() => { drained = true; cb(); }, 1); } };
    await writeWithBackpressure(response, 'chunk');
    expect(drained).toBe(true);
});

test('does not accumulate error listeners across backpressured writes', async () => {
    const response = new EventEmitter();
    response.write = () => false;

    for (let index = 0; index < 20; index += 1) {
        const pending = writeWithBackpressure(response, 'chunk');
        response.emit('drain');
        await pending;
    }

    expect(response.listenerCount('error')).toBe(0);
    expect(response.listenerCount('drain')).toBe(0);
});

test('removes the drain listener when the response errors', async () => {
    const response = new EventEmitter();
    response.write = () => false;

    const pending = writeWithBackpressure(response, 'chunk');
    response.emit('error', new Error('socket hang up'));

    await expect(pending).rejects.toThrow('socket hang up');
    expect(response.listenerCount('drain')).toBe(0);
    expect(response.listenerCount('error')).toBe(0);
});
