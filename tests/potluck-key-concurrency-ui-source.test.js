import fs from 'node:fs';
import path from 'node:path';

const read = file => fs.readFileSync(path.join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n');

describe('Potluck Key concurrency UI source contract', () => {
    test('renders pool-only concurrency controls inside routing modal and submits concurrency payload', () => {
        const html = read('static/potluck.html');

        expect(html).toContain('id="poolConcurrencySection"');
        expect(html).toContain('id="concurrencyMode"');
        expect(html).toContain('id="concurrencyLimit"');
        expect(html).toContain('id="queueLimit"');
        expect(html).toContain('id="queueTimeoutSeconds"');
        expect(html).toContain('function updateConcurrencyFields()');
        expect(html).toContain('PUT',);
        expect(html).toContain('/concurrency');
        expect(html).toContain('concurrencyMode');
        expect(html).toContain('queueTimeoutMs');
    });

    test('adds a compact concurrency badge without inventing live active counts', () => {
        const html = read('static/potluck.html');

        expect(html).toContain('function renderKeyConcurrencySummary(key)');
        expect(html).toContain('Pool · Shadow');
        expect(html).toContain('Pool · Enforce');
        expect(html).toContain('key.queueLimit');
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
