import fs from 'fs';
import path from 'path';

describe('Potluck distributed quota rejection response', () => {
    test('sends a 429 response before returning handled when distributed quota is exhausted', () => {
        const source = fs.readFileSync(
            path.join(process.cwd(), 'src/plugins/api-potluck/index.js'),
            'utf8'
        );
        const branchStart = source.indexOf('if (!quota.acquired) {');
        const branchEnd = source.indexOf('\n            }', branchStart);
        const branch = source.slice(branchStart, branchEnd);

        expect(branch).toContain('sendPotluckError(res, error);');
        expect(branch).toContain('statusCode: 429');
        expect(branch).toContain("code: 'quota_exceeded'");
    });
});
