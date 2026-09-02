import fs from 'node:fs';
import path from 'node:path';

const read = file => fs.readFileSync(path.join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');

describe('Potluck Key concurrency UI source contract', () => {
    test('renders Edge Admission controls and submits edge-admission payload', () => {
        const html = read('static/potluck.html');

        expect(html).toContain('id="edgeAdmissionSection"');
        expect(html).toContain('id="edgeAdmissionMode"');
        expect(html).toContain('id="edgeAdmissionConcurrencyLimit"');
        expect(html).toContain('id="edgeAdmissionQueueLimit"');
        expect(html).toContain('id="edgeAdmissionQueueTimeoutSeconds"');
        expect(html).toContain('function updateEdgeAdmissionFields()');
        expect(html).toContain('PUT',);
        expect(html).toContain('/edge-admission');
        expect(html).toContain('edgeAdmissionMode');
        expect(html).toContain('edgeAdmissionQueueTimeoutMs');
        expect(html).not.toContain('id="concurrencyMode"');
        expect(html).not.toContain('id="concurrencyLimit"');
    });

    test('adds a compact concurrency badge without inventing live active counts', () => {
        const html = read('static/potluck.html');

        expect(html).toContain('function renderEdgeAdmissionSummary(key)');
        expect(html).toContain('Edge ·');
        expect(html).toContain('edgeAdmissionQueueLimit');
        expect(html).not.toContain('key.activeConcurrency');
    });
});

describe('Provider usage summary UI source contract', () => {
    test('uses an adaptive two-column summary and removes standalone model cooldown badge', () => {
        const css = read('static/components/section-usage.css');
        const source = read('static/app/usage-manager.js');

        expect(css).toContain('.usage-provider-summary-grid');
        expect(css).toContain('grid-template-columns: repeat(2');
        expect(source).toContain('function renderProviderUsageSummary');
        expect(source).toContain('最快恢复');
        expect(source).toContain('role="status"');
        expect(source).not.toContain('模型冷却：${activeModels.length}');
    });
});
