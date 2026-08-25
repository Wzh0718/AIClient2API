import fs from 'fs';
import path from 'path';

describe('provider modal source regressions', () => {
    test('OAuth file path field rendering does not reference the next field definition', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/modal.js'), 'utf8').replace(/\r\n/g, '\n');
        const branchStart = source.indexOf('} else if (field1IsOAuthFilePath) {');
        expect(branchStart).toBeGreaterThanOrEqual(0);

        const branchEnd = source.indexOf('        } else {\n            html += `', branchStart);
        expect(branchEnd).toBeGreaterThan(branchStart);

        const field1OAuthBranch = source.slice(branchStart, branchEnd);
        expect(field1OAuthBranch).not.toContain('field2Def');
    });

    test('Codex legacy quota fields are hidden from provider detail rendering', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/modal.js'), 'utf8').replace(/\r\n/g, '\n');
        const excludedStart = source.indexOf('const hiddenProviderConfigFields = [');
        expect(excludedStart).toBeGreaterThanOrEqual(0);

        const excludedEnd = source.indexOf('];', excludedStart);
        expect(excludedEnd).toBeGreaterThan(excludedStart);

        const hiddenFieldsBlock = source.slice(excludedStart, excludedEnd);
        expect(hiddenFieldsBlock).toContain("'codexMax5hTokens'");
        expect(hiddenFieldsBlock).toContain("'codexMaxWeeklyTokens'");
        expect(hiddenFieldsBlock).toContain("'codexMax5hPercent'");
        expect(hiddenFieldsBlock).toContain("'codexMaxWeeklyPercent'");
    });

    test('Codex provider detail includes a redacted fingerprint status summary', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/modal.js'), 'utf8').replace(/\r\n/g, '\n');
        expect(source).toContain("currentProviderType === 'openai-codex-oauth'");
        expect(source).toContain('data-codex-fingerprint-status="true"');
        expect(source).toContain('provider.codexFingerprintAudit');
        expect(source).toContain('window.currentSafeConfig?.CODEX_FINGERPRINT_ENABLED');
        expect(source).not.toContain('installationId');
        expect(source).not.toContain('sessionId');
    });

    test('provider cards do not expose the internal needsRefresh flag as a persistent loading state', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/modal.js'), 'utf8').replace(/\r\n/g, '\n');
        const detailStart = source.indexOf('function renderProviderDetailList(providers)');
        const detailEnd = source.indexOf('function renderProviderCardList(providers)', detailStart);
        const cardEnd = source.indexOf('function renderProviderConfig(provider)', detailEnd);
        const providerListRendering = source.slice(detailStart, cardEnd);

        expect(providerListRendering).not.toContain('provider.needsRefresh');
        expect(providerListRendering).not.toContain('providers.status.needsRefresh');
        expect(providerListRendering).not.toContain('card-refresh-icon');
    });

    test('provider detail prefers the last successful request completion time', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/modal.js'), 'utf8').replace(/\r\n/g, '\n');
        expect(source).toContain('provider.lastSuccessTime || provider.lastUsed');
    });
});
