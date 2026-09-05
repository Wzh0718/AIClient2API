import fs from 'fs';
import path from 'path';

function readSource(relativePath) {
    return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('Codex split quota UI source', () => {
    test('Codex provider fields expose general percentage quota limits', () => {
        const source = readSource('static/app/utils.js');
        const codexStart = source.indexOf("'openai-codex-oauth': [");
        expect(codexStart).toBeGreaterThanOrEqual(0);
        const codexEnd = source.indexOf("'grok-cli-oauth': [", codexStart);
        expect(codexEnd).toBeGreaterThan(codexStart);
        const codexFields = source.slice(codexStart, codexEnd);

        expect(codexFields).toContain("id: 'codexGeneralMax5hPercent'");
        expect(codexFields).toContain("id: 'codexGeneralMaxWeeklyPercent'");
        expect(codexFields).not.toContain("id: 'codex53Max5hPercent'");
        expect(codexFields).not.toContain("id: 'codex53MaxWeeklyPercent'");
        expect(codexFields).not.toContain('Codex 5.3');
        expect(codexFields).not.toContain('codexMax5hTokens');
        expect(codexFields).not.toContain('codexMaxWeeklyTokens');
        expect(codexFields).not.toContain("id: 'codexMax5hPercent'");
        expect(codexFields).not.toContain("id: 'codexMaxWeeklyPercent'");
    });

    test('Codex add and edit forms parse general quota percentage fields as numbers', () => {
        const source = readSource('static/app/modal.js');

        expect(source).toContain('const CODEX_QUOTA_PERCENT_FIELDS = new Set([');
        expect(source).toContain("'codexGeneralMax5hPercent'");
        expect(source).toContain("'codexGeneralMaxWeeklyPercent'");
        expect(source).not.toContain("'codex53Max5hPercent'");
        expect(source).not.toContain("'codex53MaxWeeklyPercent'");
        expect(source).toContain('CODEX_QUOTA_PERCENT_FIELDS.has(key)');
        expect(source).toContain('CODEX_QUOTA_PERCENT_FIELDS.has(field.id)');
        expect(source).not.toContain("field.id === 'codexMax5hTokens'");
        expect(source).not.toContain("field.id === 'codexMaxWeeklyTokens'");
    });
});
