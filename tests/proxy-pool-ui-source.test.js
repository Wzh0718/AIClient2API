import { readFileSync } from 'fs';
import { describe, expect, test } from '@jest/globals';

describe('provider proxy pool UI source', () => {
    test('provider fields render PROXY_ID as proxy pool select instead of free text', () => {
        const utilsSource = readFileSync('static/app/utils.js', 'utf8');
        const modalSource = readFileSync('static/app/modal.js', 'utf8');

        expect(utilsSource).toContain("id: 'PROXY_ID'");
        expect(utilsSource).toContain("type: 'proxy-select'");
        expect(modalSource).toContain('loadProxyPools');
        expect(modalSource).toContain('renderProxySelectOptions');
        expect(modalSource).toContain('/proxy-pools');
    });

    test('provider manager exposes a proxy pool management entry', () => {
        const modalSource = readFileSync('static/app/modal.js', 'utf8');
        const i18nSource = readFileSync('static/app/i18n.js', 'utf8');

        expect(modalSource).toContain('showProxyPoolManager');
        expect(modalSource).toContain('saveProxyPools');
        expect(i18nSource).toContain('modal.proxyPool.title');
    });

    test('proxy pool manager stores expected exit IP for preflight checks', () => {
        const modalSource = readFileSync('static/app/modal.js', 'utf8');

        expect(modalSource).toContain('expectedIp');
        expect(modalSource).toContain('data-proxy-field="expectedIp"');
    });

    test('provider cards surface assigned proxy node and proxy pool rows list bound accounts', () => {
        const modalSource = readFileSync('static/app/modal.js', 'utf8');
        const cssSource = readFileSync('static/components/section-providers.css', 'utf8');

        expect(modalSource).toContain('function buildProxyPoolIndex');
        expect(modalSource).toContain('function getProviderProxyBadgeHtml');
        expect(modalSource).toContain('renderProxyPoolAssignments(proxyId, proxyPoolProviderFilter)');
        expect(modalSource).toContain('data-proxy-account');
        expect(cssSource).toContain('.provider-proxy-badge');
        expect(cssSource).toContain('.proxy-pool-assignments');
    });

    test('proxy pool defaults to the current provider and exposes provider filter controls', () => {
        const modalSource = readFileSync('static/app/modal.js', 'utf8');
        const i18nSource = readFileSync('static/app/i18n.js', 'utf8');

        expect(modalSource).toContain("proxyPoolProviderFilter = currentProviderType || 'all'");
        expect(modalSource).toContain('renderProxyPoolProviderFilters');
        expect(modalSource).toContain('data-proxy-provider-filter');
        expect(modalSource).toContain('modal.proxyPool.allProviders');
        expect(i18nSource).toContain("'modal.proxyPool.globalScope'");
    });

    test('provider filter updates assignment slots without rebuilding editable proxy rows', () => {
        const modalSource = readFileSync('static/app/modal.js', 'utf8');

        expect(modalSource).toContain('function updateProxyPoolAssignmentViews');
        expect(modalSource).toContain("querySelectorAll('.proxy-pool-assignment-slot')");
        expect(modalSource).toContain('renderProxyPoolAssignments(proxyId, proxyPoolProviderFilter)');
        expect(modalSource).toContain('data-proxy-assignment-id');
        expect(modalSource).not.toContain("document.querySelector('.proxy-pool-list').innerHTML = cachedProxyPools");
    });

    test('assignment chips keep provider identity and filtered empty state visible', () => {
        const modalSource = readFileSync('static/app/modal.js', 'utf8');
        const cssSource = readFileSync('static/components/section-providers.css', 'utf8');

        expect(modalSource).toContain('proxy-pool-account-provider');
        expect(modalSource).toContain('modal.proxyPool.noAccountsForProvider');
        expect(modalSource).toContain('modal.proxyPool.accountCount');
        expect(cssSource).toContain('.proxy-pool-provider-filters');
        expect(cssSource).toContain('.proxy-pool-account-provider');
    });
});
