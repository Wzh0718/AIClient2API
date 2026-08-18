import fs from 'node:fs';

describe('multi-worker Redis memory safety configuration', () => {
    test.each(['docker/docker-compose.yml', 'docker/docker-compose.build.yml'])(
        '%s keeps coordination data noeviction with explicit headroom',
        file => {
            const source = fs.readFileSync(file, 'utf8');
            expect(source).toContain('--maxmemory", "768mb"');
            expect(source).toContain('--maxmemory-policy", "noeviction"');
            expect(source).toMatch(/mem_limit:\s*1g/);
            expect(source).toContain('RUNTIME_BIG_OBJECT_BUDGET_BYTES=2147483648');
        }
    );
});
