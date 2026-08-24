import fs from 'fs';
import path from 'path';

function readSource(relativePath) {
    return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('Antigravity quota UI source', () => {
    test('provider editor exposes four family quota thresholds', () => {
        const source = readSource('static/app/utils.js');
        const start = source.indexOf("'gemini-antigravity': [");
        const end = source.indexOf("'openai-iflow': [", start);
        const fields = source.slice(start, end);

        expect(fields).toContain("id: 'antigravityGeminiMax5hPercent'");
        expect(fields).toContain("id: 'antigravityGeminiMaxWeeklyPercent'");
        expect(fields).toContain("id: 'antigravityThirdPartyMax5hPercent'");
        expect(fields).toContain("id: 'antigravityThirdPartyMaxWeeklyPercent'");
    });

    test('usage cards render automatic family health and active model cooldowns without manual probes', () => {
        const source = readSource('static/app/usage-manager.js');
        const css = readSource('static/components/section-usage.css');
        const i18n = readSource('static/app/i18n.js');

        expect(source).toContain('function renderAntigravityQuotaHealthBadges(instance, providerType)');
        expect(source).toContain("renderBadge('Gemini', quotaHealth.families?.gemini)");
        expect(source).toContain("renderBadge('Claude+GPT', quotaHealth.families?.thirdParty)");
        expect(source).toContain('Object.entries(quotaHealth.models || {})');
        expect(source).toContain('renderAntigravityQuotaHealthBadges(instance, providerType)');
        expect(source).toContain('renderAntigravityUnavailableModels(instance, providerType)');
        expect(source).toContain("Object.entries(instance.antigravityQuotaHealth?.models || {})");
        expect(source).toContain('getAntigravityPoolUnavailableModels(providerType, instances)');
        expect(source).toContain('antigravity-pool-alert');
        expect(source).toContain('antigravity-pool-alert-tooltip');
        expect(source).toContain('antigravity-model-status-toggle');
        expect(source).toContain('slice(0, ANTIGRAVITY_VISIBLE_MODEL_LIMIT)');
        expect(css).toContain('.antigravity-pool-alert');
        expect(css).toContain('.antigravity-pool-alert:focus-visible');
        expect(css).toContain('.antigravity-model-status-row.is-extra');
        expect(css).toMatch(/@media \(max-width: 520px\)[\s\S]*\.antigravity-model-recovery\s*\{[^}]*grid-column:\s*2 \/ -1;/s);
        expect(i18n).toContain("'usage.antigravity.poolUnavailable': '{count} 个模型全池冷却'");
        expect(i18n).toContain("'usage.antigravity.moreModels': '另 {count} 个'");
        expect(source).not.toContain('availability.availabilityPercent');
        expect(source).toContain('scheduledRecoveryTime');
        expect(source).not.toContain('antigravityModelStatus');
        expect(source).not.toContain('btn-check-model-status');
        expect(source).not.toContain('checkAntigravityModelStatus');
        expect(source).not.toContain('/model-status-check');
    });

    test('usage API and cache preserve Antigravity quota health', () => {
        const usageApi = readSource('src/ui-modules/usage-api.js');
        const usageCache = readSource('src/ui-modules/usage-cache.js');

        expect(usageApi).toContain('antigravityQuotaHealth: provider.antigravityQuotaHealth || null');
        expect(usageApi).toContain('deriveAntigravityQuotaHealthFromUsage');
        expect(usageApi).toContain('syncAntigravityQuotaHealth');
        expect(usageCache).toContain('antigravityQuotaHealth: incomingInstance.antigravityQuotaHealth || cachedInstance.antigravityQuotaHealth || null');
    });

    test('usage backend no longer exposes or caches manual Antigravity model scans', () => {
        const uiManager = readSource('src/services/ui-manager.js');
        const usageApi = readSource('src/ui-modules/usage-api.js');
        const usageCache = readSource('src/ui-modules/usage-cache.js');

        expect(uiManager).not.toContain('/model-status-check');
        expect(uiManager).not.toContain('handlePostAntigravityModelStatusCheck');
        expect(usageApi).not.toContain('probeAntigravityModelAvailability');
        expect(usageApi).not.toContain('antigravityModelStatus');
        expect(usageCache).not.toContain('antigravityModelStatus');
    });
});
