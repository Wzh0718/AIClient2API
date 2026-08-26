import { SmoothWeightedRoundRobin } from '../src/providers/smooth-weighted-round-robin.js';

describe('SmoothWeightedRoundRobin', () => {
    test.each([
        [[['a', 1], ['b', 1]], 4, { a: 2, b: 2 }],
        [[['a', 1], ['b', 2]], 6, { a: 2, b: 4 }],
        [[['a', 2], ['b', 3], ['c', 5]], 10, { a: 2, b: 3, c: 5 }]
    ])('approximates the configured ratio for %j', (weights, count, expected) => {
        const scheduler = new SmoothWeightedRoundRobin();
        const seen = {};
        for (const [id, weight] of weights) scheduler.setWeight(id, weight);
        for (let i = 0; i < count; i++) {
            const id = scheduler.select(weights.map(([key]) => key));
            seen[id] = (seen[id] || 0) + 1;
        }
        expect(seen).toEqual(expected);
    });

    test('skips unavailable candidates without losing their accumulated share', () => {
        const scheduler = new SmoothWeightedRoundRobin();
        scheduler.setWeight('a', 1);
        scheduler.setWeight('b', 1);
        expect(scheduler.select(['a'])).toBe('a');
        expect(scheduler.select(['b'])).toBe('b');
    });
});
