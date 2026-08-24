import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';

describe('Docker native dependencies', () => {
    test('builds and verifies the better-sqlite3 binding instead of silently skipping install scripts', () => {
        const dockerfile = readFileSync('Dockerfile', 'utf8');

        expect(dockerfile).toContain('python3 make g++');
        expect(dockerfile).not.toContain('npm install --ignore-scripts');
        expect(dockerfile).toContain("require('better-sqlite3')(':memory:').close()");
    });
});
