import fs from 'fs';
import path from 'path';

function readSource(relativePath) {
    return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('Codex credential-group UI source', () => {
    const providersHtml = readSource('static/components/section-providers.html');
    const providerManager = readSource('static/app/provider-manager.js');
    const potluckHtml = readSource('static/potluck.html');

    test('keeps the original Providers view as the default and exposes an accessible advanced-view toggle', () => {
        expect(providersHtml).toContain('id="providersViewToggleBtn"');
        expect(providersHtml).toContain('aria-expanded="false"');
        expect(providersHtml).toContain('aria-controls="credentialGroupsPanel"');
        expect(providersHtml).toContain('id="providersDefaultView"');
        expect(providersHtml).toMatch(/id="credentialGroupsPanel"[^>]*hidden/);
        expect(providerManager).toContain('setProvidersAdvancedView');
        expect(providerManager).not.toMatch(/Promise\.all\(\[\s*loadProviders\(forceRefreshSupported\),\s*loadCredentialGroupManagement\(\)/);
    });

    test('Providers page exposes the relationship-management panel and its primary containers', () => {
        [
            'credentialGroupsPanel',
            'credentialGroupsRefreshBtn',
            'credentialGroupsRollbackBtn',
            'credentialGroupsPreviewBtn',
            'credentialGroupsStatus',
            'credentialGroupsContent',
            'credentialGroupsPreview',
            'credentialGroupsCurrentGroups',
            'credentialGroupsUngroupedCredentials',
            'credentialGroupsKeys',
            'credentialGroupsRevisions'
        ].forEach(id => expect(providersHtml).toContain(`id="${id}"`));
    });

    test('merges credential details into collapsible group cards instead of a permanent credential table', () => {
        expect(providersHtml).not.toContain('id="credentialGroupsCredentials"');
        expect(providerManager).toContain('buildCredentialGroupCredentialSections');
        expect(providerManager).toContain('aria-expanded=');
        expect(providerManager).toContain('credential-group-credential-details');
        expect(providerManager).toContain('credentialGroupsUngroupedCredentials');
        expect(providersHtml).toContain('data-credential-group-ungrouped-toggle');
        expect(providersHtml).toContain('aria-controls="credentialGroupsUngroupedCredentials"');
        expect(providerManager).toContain('credentialGroupUngroupedExpanded');
    });

    test('uses the apiClient relative paths so the client adds the /api prefix exactly once', () => {
        [
            '/potluck/credential-groups',
            '/potluck/credential-groups/preview',
            '/potluck/credential-groups/apply',
            '/potluck/credential-groups/revisions',
            '/potluck/credential-groups/rollback'
        ].forEach(endpoint => expect(providerManager).toContain(endpoint));

        expect(providerManager).not.toContain("'/api/potluck/credential-groups");
    });

    test('does not render unavailable demand as a fake zero-dollar amount', () => {
        expect(providerManager).toContain('predictedDemandUsdAvailable');
        expect(providerManager).toContain('暂无价格');
        expect(providerManager).toContain('formatCredentialGroupGroupDemand(group)');
    });

    test('requires confirmation for apply and rollback and sends the current revision for rollback', () => {
        expect(providerManager).toContain("window.confirm(t('providers.credentialGroups.applyConfirm'))");
        expect(providerManager).toContain("window.confirm(t('providers.credentialGroups.rollbackConfirm'))");
        expect(providerManager).toContain('options.allowWhileBusy !== true');
        expect(providerManager).toContain("statusKey: 'refreshing', allowWhileBusy: true");
        expect(providerManager).toMatch(
            /post\('\/potluck\/credential-groups\/rollback',\s*\{\s*baseRevision:\s*credentialGroupView\.revision\s*\}\)/
        );
    });

    test('clears an old preview when the preview is missing, expired, or based on a stale revision', () => {
        expect(providerManager).toContain(
            "['PREVIEW_NOT_FOUND', 'PREVIEW_EXPIRED', 'CREDENTIAL_GROUP_REVISION_CONFLICT'].includes(code)"
        );
        expect(providerManager).toContain("if (code === 'CREDENTIAL_GROUP_REVISION_CONFLICT') {");
        expect(providerManager).toContain('clearCredentialGroupPreview();');
    });

    test('renders only public credential references and escapes dynamic management data', () => {
        expect(providerManager).toContain('credential.credentialRef');
        expect(providerManager).toContain('key?.maskedKey || key?.keyRef');
        expect(providerManager).toContain('escapeHtml(label.secondary)');
        expect(providerManager).toContain('escapeHtml(primaryGroup)');
        expect(providerManager).not.toContain('fixedCredential.uuid');
        expect(providerManager).not.toContain('credential.uuid');
    });

    test('shows credential emails on group cards and labels the normalized capacity load index', () => {
        expect(providerManager).toContain('resolveCredentialGroupMemberLabel');
        expect(providerManager).toContain('credentialGroupView?.credentials');
        expect(providerManager).toContain('group?.loadIndex');
        expect(providerManager).toContain("t('providers.credentialGroups.label.loadIndex')");
        expect(providerManager).not.toContain("t('providers.credentialGroups.label.utilization')");
    });

    test('explains that allocation demand only includes gpt-* model usage', () => {
        expect(providerManager).toContain("t('providers.credentialGroups.demandFilterNotice'");
        expect(providerManager).toContain('demandModelFilter');
    });

    test('shows a compact safe Potluck routing badge beside the key-name editor', () => {
        const helperStart = potluckHtml.indexOf('function renderKeyRoutingSummary');
        const helperEnd = potluckHtml.indexOf('function renderKeys', helperStart);
        expect(helperStart).toBeGreaterThanOrEqual(0);
        expect(helperEnd).toBeGreaterThan(helperStart);

        const helper = potluckHtml.slice(helperStart, helperEnd);
        expect(helper).toContain('key?.routingMode');
        expect(helper).toContain('key?.primaryGroupId');
        expect(helper).toContain('key?.manualLock');
        expect(helper).toContain("replace(/^group-/i, '')");
        expect(helper).toContain("compactGroup ? `${compactGroup} · auto` : 'auto'");
        expect(helper).not.toContain("compactGroup = primaryGroupId ? primaryGroupId.replace(/^group-/i, '') : '?'");
        expect(helper).toContain('fixed');
        expect(helper).toContain('auto');
        expect(helper).toContain('pool');
        expect(helper).toContain('全池加权');
        expect(helper).toContain('固定凭据 · 禁止降级');
        expect(helper).toContain('不可用时跨组降级');
        expect(helper).toContain('手工锁定');
        expect(helper).toContain('aria-label=');
        expect(helper).toContain('title=');
        expect(helper).not.toContain('fixedCredential.uuid');
        expect(helper).not.toContain('key.id');

        const keyNameLine = potluckHtml.match(/<div class="key-name">[^\n]+/u)?.[0] || '';
        expect(keyNameLine).toContain('renderKeyRoutingSummary(key)');
        expect(potluckHtml).not.toMatch(/<div class="key-id">[^\n]+<\/div>\s*\$\{renderKeyRoutingSummary\(key\)\}/u);
    });

    test('lets administrators switch a Key between pool, auto, and fixed routing', () => {
        expect(potluckHtml).toContain('id="editRoutingModal"');
        expect(potluckHtml).toContain('id="routingMode"');
        expect(potluckHtml).toContain('<option value="pool">全池加权</option>');
        expect(potluckHtml).toContain('<option value="auto">主组优先</option>');
        expect(potluckHtml).toContain('<option value="fixed">固定凭据</option>');
        expect(potluckHtml).toContain('function openEditRouting');
        expect(potluckHtml).toContain('function updateRouting');
        expect(potluckHtml).toContain("/routing`");
    });

    test('prefers account email labels and preselects the current fixed credential reference', () => {
        expect(potluckHtml).toContain('credential.accountEmail || credential.customName || credential.credentialRef');
        expect(potluckHtml).toContain('function openEditRouting(keyId)');
        expect(potluckHtml).toContain('allKeys.find(key => key.id === keyId)');
        expect(potluckHtml).toContain('currentKey?.fixedCredential?.credentialRef');
        expect(potluckHtml).toContain('credentialSelect.value = currentFixedCredentialRef');
        expect(potluckHtml).not.toMatch(/openEditRouting\('\$\{key\.id\}', '\$\{key\.routingMode/u);
    });

    test('shows deterministic routing-save progress and handles request failures without duplicate PUTs', () => {
        expect(potluckHtml).toContain('id="saveRoutingButton"');
        expect(potluckHtml).toContain("saveButton.setAttribute('aria-busy', String(saving))");
        expect(potluckHtml).toContain("saving ? '保存中…' : '保存路由'");
        expect(potluckHtml).toContain('if (routingSaveInFlight) return;');
        expect(potluckHtml).toContain('routingSaveInFlight = true;');
        expect(potluckHtml).toContain('finally {');
        expect(potluckHtml).toContain('routingSaveInFlight = false;');
        expect(potluckHtml).toContain("error?.code === 'REQUEST_TIMEOUT'");
        expect(potluckHtml).toContain('保存结果未知，请刷新确认');
    });

    test('wraps management requests with timeout and non-JSON/network error handling', () => {
        expect(potluckHtml).toContain('const API_REQUEST_TIMEOUT_MS = 120_000;');
        expect(potluckHtml).toContain('new AbortController()');
        expect(potluckHtml).toContain("code: 'REQUEST_TIMEOUT'");
        expect(potluckHtml).toContain("code: 'INVALID_RESPONSE'");
        expect(potluckHtml).toContain("code: 'NETWORK_ERROR'");
        expect(potluckHtml).toContain('clearTimeout(timeoutId);');
    });
});
