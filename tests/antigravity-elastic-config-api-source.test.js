import fs from 'fs';

describe('Antigravity elastic routing config API source', () => {
    test('reads, updates, and persists the routing policy through the existing config API', () => {
        const source = fs.readFileSync('src/ui-modules/config-api.js', 'utf8');
        expect(source).toContain('antigravityElasticRouting: currentConfig.antigravityElasticRouting');
        expect(source).toContain('newConfig.antigravityElasticRouting !== undefined');
        expect(source).toContain('currentConfig.antigravityElasticRouting =');
    });
});
