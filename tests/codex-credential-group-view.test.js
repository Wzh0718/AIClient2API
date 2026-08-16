import fs from 'fs';

const helperPath = 'static/app/credential-group-view.js';

describe('credential-group focused management view', () => {
    test('ships a pure view helper module', () => {
        expect(fs.existsSync(helperPath)).toBe(true);
    });

    test('sorts active used keys by USD before token, request count, and stable reference', async () => {
        const { sortCredentialGroupKeys } = await import('../static/app/credential-group-view.js');
        const sorted = sortCredentialGroupKeys([
            { keyRef: 'key-c', enabled: true, demand: { usd: 1, totalTokens: 10, requestCount: 1 } },
            { keyRef: 'key-b', enabled: true, demand: { usd: 2, totalTokens: 20, requestCount: 1 } },
            { keyRef: 'key-a', enabled: true, demand: { usd: 3, totalTokens: 10, requestCount: 2 } },
            { keyRef: 'key-disabled', enabled: false, demand: { totalTokens: 999, requestCount: 9 } },
            { keyRef: 'key-new', enabled: true, demand: { totalTokens: 0, requestCount: 0, isNew: true } }
        ]);

        expect(sorted.map(key => key.keyRef)).toEqual([
            'key-a', 'key-b', 'key-c', 'key-new', 'key-disabled'
        ]);
    });

    test.each([
        ['one key exceeds the target', [90, 10], ['key-1']],
        ['one key exactly reaches the target', [80, 20], ['key-1']],
        ['multiple keys are needed to reach the target', [50, 20, 10, 10, 10], ['key-1', 'key-2', 'key-3']]
    ])('selects the smallest enabled key set covering 80%% of USD: %s', async (_name, amounts, expected) => {
        const { getFocusedCredentialGroupKeys } = await import('../static/app/credential-group-view.js');
        const keys = amounts.map((usd, index) => ({
            keyRef: `key-${index + 1}`,
            enabled: true,
            routingMode: 'auto',
            manualLock: false,
            demand: { usd, totalTokens: usd * 10, requestCount: usd }
        }));

        expect(getFocusedCredentialGroupKeys(keys).visible.map(key => key.keyRef)).toEqual(expected);
    });

    test('resolves credential group member labels as email, custom name, then masked reference', async () => {
        const { resolveCredentialGroupMemberLabel } = await import('../static/app/credential-group-view.js');
        const credentials = [
            { credentialRef: 'ref-email', accountEmail: 'owner@example.com', customName: 'Owner' },
            { credentialRef: 'ref-name', accountEmail: '', customName: 'Named credential' }
        ];

        expect(resolveCredentialGroupMemberLabel('ref-email', credentials)).toMatchObject({
            primary: 'owner@example.com',
            secondary: 'ref-email'
        });
        expect(resolveCredentialGroupMemberLabel('ref-name', credentials)).toMatchObject({
            primary: 'Named credential',
            secondary: 'ref-name'
        });
        expect(resolveCredentialGroupMemberLabel('ref-missing', credentials)).toMatchObject({
            primary: 'ref-missing',
            secondary: ''
        });
    });

    test('does not compare unpriced token counts against USD when priced keys exist', async () => {
        const { getFocusedCredentialGroupKeys, sortCredentialGroupKeys } = await import('../static/app/credential-group-view.js');
        const keys = [
            { keyRef: 'key-unpriced-huge', enabled: true, demand: { usd: 0, totalTokens: 1_000_000_000, requestCount: 10 } },
            { keyRef: 'key-expensive', enabled: true, demand: { usd: 100, totalTokens: 100, requestCount: 1 } },
            { keyRef: 'key-small', enabled: true, demand: { usd: 1, totalTokens: 10, requestCount: 1 } }
        ];

        expect(sortCredentialGroupKeys(keys).map(key => key.keyRef)).toEqual([
            'key-expensive', 'key-small', 'key-unpriced-huge'
        ]);
        const focused = getFocusedCredentialGroupKeys(keys);
        expect(focused.metric).toBe('usd');
        expect(focused.totalDemand).toBe(101);
        expect(focused.visible.map(key => key.keyRef)).toEqual(['key-expensive']);
    });

    test('always keeps fixed and manually locked keys while hiding disabled and zero-usage keys', async () => {
        const { getFocusedCredentialGroupKeys } = await import('../static/app/credential-group-view.js');
        const result = getFocusedCredentialGroupKeys([
            { keyRef: 'heavy', enabled: true, routingMode: 'auto', demand: { totalTokens: 100, requestCount: 1 } },
            { keyRef: 'fixed', enabled: true, routingMode: 'fixed', demand: { totalTokens: 0, requestCount: 0 } },
            { keyRef: 'locked', enabled: true, routingMode: 'auto', manualLock: true, demand: { totalTokens: 0, requestCount: 0 } },
            { keyRef: 'new', enabled: true, routingMode: 'auto', demand: { totalTokens: 0, requestCount: 0, isNew: true } },
            { keyRef: 'disabled', enabled: false, routingMode: 'fixed', demand: { totalTokens: 500, requestCount: 5 } }
        ]);

        expect(result.visible.map(key => key.keyRef)).toEqual(['heavy', 'fixed', 'locked']);
        expect(result.hiddenCount).toBe(2);
    });

    test('shows only healthy routeable credentials with positive capacity by default', async () => {
        const { getFocusedCredentials } = await import('../static/app/credential-group-view.js');
        const result = getFocusedCredentials([
            { credentialRef: 'healthy', available: true, isHealthy: true, isDisabled: false, needsRefresh: false, capacity: 0.6 },
            { credentialRef: 'empty', available: false, isHealthy: false, isDisabled: false, needsRefresh: false, capacity: 0 },
            { credentialRef: 'disabled', available: true, isHealthy: true, isDisabled: true, needsRefresh: false, capacity: 1 },
            { credentialRef: 'stale', available: true, isHealthy: true, isDisabled: false, needsRefresh: true, capacity: 1 }
        ]);

        expect(result.visible.map(item => item.credentialRef)).toEqual(['healthy']);
        expect(result.hiddenCount).toBe(3);
    });
});
