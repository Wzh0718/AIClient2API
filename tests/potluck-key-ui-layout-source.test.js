import fs from 'node:fs';
import path from 'node:path';

const read = file => fs.readFileSync(path.join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');

describe('Potluck Key list UI layout source contract', () => {
    test('defines semantic layout hooks for the reordered card and toolbar', () => {
        const html = read('static/potluck.html');

        expect(html).toContain('.key-card-header');
        expect(html).toContain('.key-primary-stats');
        expect(html).toContain('.key-secondary-stats');
        expect(html).toContain('class="toolbar-group toolbar-filters"');
        expect(html).toContain('class="toolbar-group toolbar-bulk-actions"');
        expect(html).toContain('aria-label="搜索 Key 名称或内容"');
        expect(html).toContain('aria-label="Key 排序方式"');
    });

    test('provides accessible state and interaction styling hooks', () => {
        const html = read('static/potluck.html');

        expect(html).toContain('key-status-badge');
        expect(html).toContain('key-action-secondary');
        expect(html).toContain('key-action-danger');
        expect(html).toContain('@media (prefers-reduced-motion: reduce)');
    });
});
