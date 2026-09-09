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

    test('provider cards and details show needsRefresh as a scheduling-blocking refreshing state', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/modal.js'), 'utf8').replace(/\r\n/g, '\n');
        const detailStart = source.indexOf('function renderProviderDetailList(providers)');
        const detailEnd = source.indexOf('function renderProviderCardList(providers)', detailStart);
        const cardEnd = source.indexOf('function renderProviderConfig(provider)', detailEnd);
        const providerListRendering = source.slice(detailStart, cardEnd);

        expect(providerListRendering).toContain('provider.needsRefresh');
        expect(providerListRendering).toContain('providers.status.needsRefresh');
        expect(source).toContain('refreshProviderToken');
        expect(source).toContain('/refresh-token');
        expect(source).toContain('modal.provider.refreshToken');
        expect(source).not.toContain("onclick=\"window.refreshProviderUuid('${provider.uuid}', event)\" title=\"${t('modal.provider.refreshToken");
        expect(providerListRendering).not.toContain('modal.provider.usageCount');
        expect(providerListRendering).not.toContain('modal.provider.errorCount');
        expect(providerListRendering).not.toContain('disabled-status');
    });

    test('refresh-token API is registered before the generic provider uuid route', () => {
        const uiManager = fs.readFileSync(path.join(process.cwd(), 'src/services/ui-manager.js'), 'utf8').replace(/\r\n/g, '\n');
        const providerApi = fs.readFileSync(path.join(process.cwd(), 'src/ui-modules/provider-api.js'), 'utf8').replace(/\r\n/g, '\n');
        const refreshTokenIndex = uiManager.indexOf('/refresh-token');
        const genericRouteIndex = uiManager.indexOf('This generic route must be after all specific routes');

        expect(refreshTokenIndex).toBeGreaterThan(0);
        expect(genericRouteIndex).toBeGreaterThan(refreshTokenIndex);
        expect(uiManager).toContain('handleRefreshProviderToken');
        expect(providerApi).toContain('export async function handleRefreshProviderToken');
        expect(providerApi).toContain('refreshNode(providerType, providerUuid, true)');
    });

    test('provider detail prefers the last successful request completion time', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/modal.js'), 'utf8').replace(/\r\n/g, '\n');
        expect(source).toContain('provider.lastSuccessTime || provider.lastUsed');
    });
});
