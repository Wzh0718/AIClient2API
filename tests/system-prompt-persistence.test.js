import { createSystemPromptPersistenceQueue } from '../src/utils/system-prompt-persistence.js';

describe('system prompt background persistence', () => {
    test('repeated identical prompts are coalesced and never block the caller', async () => {
        const writes = [];
        const queue = createSystemPromptPersistenceQueue({
            debounceMs: 25,
            read: jest.fn(async () => ''),
            write: jest.fn(async value => writes.push(value))
        });

        const schedules = Array.from({ length: 1000 }, () => queue.schedule('same prompt', 'openai'));
        await Promise.all(schedules);
        expect(writes).toHaveLength(0);

        await queue.flush();
        expect(writes).toEqual(['same prompt']);
    });

    test('concurrent changes use last-write-wins and write complete content once', async () => {
        const writes = [];
        const queue = createSystemPromptPersistenceQueue({
            debounceMs: 25,
            read: jest.fn(async () => 'old'),
            write: jest.fn(async value => writes.push(value))
        });

        await Promise.all(['one', 'two', 'three'].map(value => queue.schedule(value, 'openai')));
        await queue.flush();

        expect(writes).toEqual(['three']);
        expect(queue.snapshot()).toMatchObject({ writes: 1, pending: false });
    });
});
