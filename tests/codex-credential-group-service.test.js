import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    CredentialGroupService,
    calculateCredentialCapacity,
    calculateTargetGroupCount,
    diagnoseKeyRouting,
    generateCredentialGroupSuggestion,
    routeKeyToCredentialCandidates,
    summarizeKeyDemand,
    validateCredentialGroupSuggestion
} from '../src/services/codex-credential-group-service.js';

const tempDirs = [];
const NOW = new Date('2026-08-14T04:00:00.000Z');

function makeTempFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-codex-groups-'));
    tempDirs.push(dir);
    return path.join(dir, 'codex-credential-groups.json');
}

function day(summary = {}, models = null) {
    const normalizedSummary = {
        requestCount: summary.requestCount || 0,
        totalTokens: summary.totalTokens || 0,
        cost: summary.cost || undefined
    };
    return {
        summary: normalizedSummary,
        models: models || { 'gpt-5': { ...normalizedSummary } }
    };
}

function createCredentials(count) {
    return Array.from({ length: count }, (_, index) => ({
        providerType: 'openai-codex-oauth',
        uuid: `cred-${index + 1}`,
        customName: `Credential ${index + 1}`,
        providerWeight: 1,
        fiveHourRemainingRatio: 1,
        weeklyRemainingRatio: 1,
        isHealthy: true
    }));
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('Codex credential group sizing and capacity', () => {
    test.each([
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 2],
        [4, 2],
        [5, 3],
        [6, 3],
        [9, 5],
        [10, 5]
    ])('uses %i healthy credentials to create %i groups', (credentials, groups) => {
        expect(calculateTargetGroupCount(credentials)).toBe(groups);
    });

    test('uses providerWeight times the lower of 5-hour and weekly remaining ratios', () => {
        expect(calculateCredentialCapacity({
            providerWeight: 2,
            fiveHourRemainingRatio: 0.8,
            weeklyRemainingRatio: 0.4
        })).toMatchObject({
            providerWeight: 2,
            quotaFactor: 0.4,
            capacity: 0.8,
            confidence: 'high'
        });
    });

    test('keeps weight-only credentials eligible and uses a conservative default with no capacity data', () => {
        expect(calculateCredentialCapacity({ providerWeight: 3 })).toMatchObject({
            capacity: 3,
            confidence: 'low'
        });
        expect(calculateCredentialCapacity({})).toMatchObject({
            capacity: 0.5,
            confidence: 'low'
        });
    });

    test('creates balanced groups with no more than two credentials each', () => {
        const suggestion = generateCredentialGroupSuggestion({
            credentials: createCredentials(10),
            keys: [],
            now: NOW
        });

        expect(suggestion.applicable).toBe(true);
        expect(suggestion.groups.map(group => group.credentialUuids.length)).toEqual([2, 2, 2, 2, 2]);
        expect(suggestion.groups.every(group => group.credentialUuids.length <= 2)).toBe(true);
        expect(new Set(suggestion.groups.flatMap(group => group.credentialUuids)).size).toBe(10);
    });

    test('keeps a singleton final group for an odd credential count', () => {
        const suggestion = generateCredentialGroupSuggestion({
            credentials: createCredentials(5),
            keys: [],
            now: NOW
        });

        expect(suggestion.groups.map(group => group.credentialUuids.length)).toEqual([2, 2, 1]);
    });

    test('reports an oversized manually locked group instead of silently splitting it', () => {
        const suggestion = generateCredentialGroupSuggestion({
            credentials: createCredentials(3),
            keys: [],
            currentConfig: {
                groups: [{ id: 'group-1', manualLock: true, credentialUuids: ['cred-1', 'cred-2', 'cred-3'] }]
            },
            now: NOW
        });

        expect(suggestion.applicable).toBe(false);
        expect(suggestion.reason).toBe('MANUAL_GROUP_EXCEEDS_MAX_SIZE');
        expect(suggestion.anomalies).toEqual(expect.arrayContaining([
            expect.objectContaining({ reason: 'MANUAL_GROUP_EXCEEDS_MAX_SIZE' })
        ]));
    });

    test('excludes credentials with explicitly exhausted quota and returns a non-applicable suggestion when none remain', () => {
        const suggestion = generateCredentialGroupSuggestion({
            credentials: [
                { ...createCredentials(1)[0], fiveHourRemainingRatio: 0 },
                { ...createCredentials(1)[0], uuid: 'cred-2', quotaAvailable: false },
                { ...createCredentials(1)[0], uuid: 'cred-3', isHealthy: false }
            ],
            keys: [],
            now: NOW
        });

        expect(suggestion).toMatchObject({
            applicable: false,
            reason: 'NO_HEALTHY_CREDENTIALS',
            groupCount: 0,
            groups: [],
            keyAssignments: []
        });
    });
});

describe('Codex key demand and capacity-aware assignment', () => {
    test('only aggregates case-insensitive gpt-* models across the selected date range', () => {
        const demand = summarizeKeyDemand({
            usageHistory: {
                '2026-08-08': day({}, {
                    'gpt-5': { requestCount: 2, totalTokens: 200, cost: { actualUsd: 2 } },
                    'claude-sonnet-4': { requestCount: 200, totalTokens: 20000, cost: { actualUsd: 200 } }
                }),
                '2026-08-13': day({}, {
                    'GPT-5.1': { requestCount: 3, totalTokens: 300, cost: { estimatedUsd: 3, missingPriceTokens: 30, estimatedPriceTokens: 20 } },
                    'gemini-3-flash': { requestCount: 300, totalTokens: 30000, cost: { estimatedUsd: 300 } }
                }),
                '2026-08-14': day({}, {
                    'gpt-5-mini': { requestCount: 4, totalTokens: 400, cost: { actualUsd: 4 } }
                })
            }
        }, { now: NOW, timeZone: 'Asia/Shanghai' });

        expect(demand).toMatchObject({
            metric: 'usd',
            usd: 9,
            actualUsd: 6,
            estimatedUsd: 3,
            missingPriceTokens: 30,
            estimatedPriceTokens: 20,
            totalTokens: 900,
            requestCount: 9,
            totalDemand: 9,
            isNew: false
        });
    });

    test('treats missing or non-gpt model history as a new key without summary fallback', () => {
        const demand = summarizeKeyDemand({
            usageHistory: {
                '2026-08-13': {
                    summary: { requestCount: 999, totalTokens: 999999, cost: { actualUsd: 999 } }
                },
                '2026-08-14': day({}, {
                    gpt: { requestCount: 10, totalTokens: 1000 },
                    'gptish-5': { requestCount: 20, totalTokens: 2000 },
                    '': { requestCount: 30, totalTokens: 3000 },
                    'claude-sonnet-4': { requestCount: 40, totalTokens: 4000 }
                })
            }
        }, { now: NOW });

        expect(demand).toMatchObject({
            metric: 'newKey',
            usd: 0,
            totalTokens: 0,
            requestCount: 0,
            totalDemand: 0,
            isNew: true
        });
    });

    test('uses the current Asia/Shanghai day plus the previous six calendar days', () => {
        const demand = summarizeKeyDemand({
            id: 'key-1',
            usageHistory: {
                '2026-08-07': day({ totalTokens: 9999, requestCount: 99 }),
                '2026-08-08': day({ totalTokens: 100, requestCount: 1 }),
                '2026-08-13': day({ totalTokens: 700, requestCount: 7 }),
                '2026-08-14': day({ totalTokens: 8888, requestCount: 88 })
            }
        }, { now: NOW, timeZone: 'Asia/Shanghai' });

        expect(demand.startDate).toBe('2026-08-08');
        expect(demand.endDate).toBe('2026-08-14');
        expect(demand.totalTokens).toBe(9688);
        expect(demand.requestCount).toBe(96);
        expect(demand.metric).toBe('totalTokens');
    });

    test('uses total USD including estimates before falling back to tokens and request count', () => {
        const costDemand = summarizeKeyDemand({
            usageHistory: {
                '2026-08-13': day({
                    totalTokens: 1000,
                    requestCount: 10,
                    cost: { actualUsd: 2.5, estimatedUsd: 0.75, missingPriceTokens: 100 }
                })
            }
        }, { now: NOW });
        const tokenDemand = summarizeKeyDemand({
            usageHistory: { '2026-08-13': day({ totalTokens: 1000, requestCount: 10 }) }
        }, { now: NOW });
        const requestDemand = summarizeKeyDemand({
            usageHistory: { '2026-08-13': day({ requestCount: 10 }) }
        }, { now: NOW });

        expect(costDemand).toMatchObject({
            metric: 'usd',
            usd: 3.25,
            actualUsd: 2.5,
            estimatedUsd: 0.75,
            missingPriceTokens: 100,
            pricingCoverage: 0.9,
            totalDemand: 3.25
        });
        expect(tokenDemand).toMatchObject({ metric: 'totalTokens', totalDemand: 1000 });
        expect(requestDemand).toMatchObject({ metric: 'requestCount', totalDemand: 10 });
    });

    test('marks high-consumption keys by USD even when another key has more tokens', () => {
        const suggestion = generateCredentialGroupSuggestion({
            credentials: createCredentials(3),
            keys: [
                { id: 'key-expensive', usageHistory: { '2026-08-14': day({ totalTokens: 100, cost: { actualUsd: 100 } }) } },
                { id: 'key-token-heavy', usageHistory: { '2026-08-14': day({ totalTokens: 100000, cost: { actualUsd: 5 } }) } },
                { id: 'key-small', usageHistory: { '2026-08-14': day({ totalTokens: 50, cost: { actualUsd: 1 } }) } }
            ],
            now: NOW
        });

        expect(suggestion.keyAssignments.find(item => item.keyId === 'key-expensive').highConsumption).toBe(true);
        expect(suggestion.keyAssignments.find(item => item.keyId === 'key-token-heavy').highConsumption).toBe(false);
    });

    test('does not mix token counts with USD when only some keys have priced usage', () => {
        const suggestion = generateCredentialGroupSuggestion({
            credentials: createCredentials(3),
            keys: [
                { id: 'key-expensive', usageHistory: { '2026-08-14': day({ totalTokens: 100, cost: { actualUsd: 100 } }) } },
                { id: 'key-unpriced-huge', usageHistory: { '2026-08-14': day({ totalTokens: 1_000_000_000 }) } },
                { id: 'key-priced-small', usageHistory: { '2026-08-14': day({ totalTokens: 10, cost: { actualUsd: 1 } }) } }
            ],
            now: NOW
        });

        expect(suggestion.demandMetric).toBe('usd');
        expect(suggestion.keyAssignments.find(item => item.keyId === 'key-expensive').highConsumption).toBe(true);
        expect(suggestion.keyAssignments.find(item => item.keyId === 'key-unpriced-huge').highConsumption).toBe(false);
        expect(suggestion.groups.reduce((sum, group) => sum + group.predictedDemand, 0)).toBeCloseTo(101, 10);
        expect(suggestion.groups.reduce((sum, group) => sum + group.predictedDemandUsd, 0)).toBeCloseTo(101, 10);
    });

    test('does not let large non-gpt usage increase a key assignment demand', () => {
        const suggestion = generateCredentialGroupSuggestion({
            credentials: createCredentials(3),
            keys: [
                {
                    id: 'key-mixed',
                    usageHistory: {
                        '2026-08-14': day({}, {
                            'gpt-5': { totalTokens: 10, requestCount: 1 },
                            'claude-sonnet-4': { totalTokens: 1_000_000, requestCount: 10_000 }
                        })
                    }
                },
                { id: 'key-gpt', usageHistory: { '2026-08-14': day({ totalTokens: 100, requestCount: 2 }) } }
            ],
            now: NOW
        });

        expect(suggestion).toMatchObject({
            demandModelFilter: 'gpt-*',
            demandModelFilterCaseSensitive: false,
            demandMetric: 'totalTokens'
        });
        expect(suggestion.keyAssignments.find(item => item.keyId === 'key-mixed').demand).toMatchObject({
            totalTokens: 10,
            requestCount: 1
        });
    });

    test('reports group demand share, capacity share, and capacity load index', () => {
        const suggestion = generateCredentialGroupSuggestion({
            credentials: createCredentials(3),
            keys: [
                { id: 'key-a', usageHistory: { '2026-08-14': day({ totalTokens: 100, cost: { actualUsd: 90 } }) } },
                { id: 'key-b', usageHistory: { '2026-08-14': day({ totalTokens: 100, cost: { actualUsd: 10 } }) } }
            ],
            now: NOW
        });

        expect(suggestion.groups.reduce((sum, group) => sum + group.demandShare, 0)).toBeCloseTo(1, 10);
        expect(suggestion.groups.reduce((sum, group) => sum + group.capacityShare, 0)).toBeCloseTo(1, 10);
        for (const group of suggestion.groups) {
            expect(group.loadIndex).toBeCloseTo(
                group.capacityShare > 0 ? group.demandShare / group.capacityShare : 0,
                10
            );
        }
    });

    test('capacity-balances new keys with no history', () => {
        const suggestion = generateCredentialGroupSuggestion({
            credentials: createCredentials(6),
            keys: Array.from({ length: 6 }, (_, index) => ({ id: `key-${index + 1}` })),
            now: NOW
        });
        const counts = suggestion.groups
            .map(group => suggestion.keyAssignments.filter(item => item.primaryGroupId === group.id).length)
            .sort((a, b) => b - a);

        expect(counts).toEqual([2, 2, 2]);
        expect(suggestion.keyAssignments.every(item => item.demand.isNew)).toBe(true);
    });

    test('preserves pool keys without assigning demand to any credential group', () => {
        const suggestion = generateCredentialGroupSuggestion({
            credentials: createCredentials(3),
            keys: [
                { id: 'key-pool', routingMode: 'pool', usageHistory: { '2026-08-13': day({ totalTokens: 5000 }) } },
                { id: 'key-auto', routingMode: 'auto', primaryGroupId: 'group-1', usageHistory: { '2026-08-13': day({ totalTokens: 100 }) } }
            ],
            currentConfig: {
                groups: [{ id: 'group-1', credentialUuids: ['cred-1'] }],
                keyAssignments: [{ keyId: 'key-pool', routingMode: 'pool', primaryGroupId: null }]
            },
            now: NOW
        });

        expect(suggestion.keyAssignments.find(item => item.keyId === 'key-pool')).toMatchObject({
            routingMode: 'pool',
            primaryGroupId: null,
            fixedCredential: null
        });
        expect(suggestion.groups.reduce((sum, group) => sum + group.predictedDemand, 0)).toBe(100);
    });

    test('marks clearly high-consumption keys in the preview', () => {
        const suggestion = generateCredentialGroupSuggestion({
            credentials: createCredentials(3),
            keys: [
                { id: 'key-hot', usageHistory: { '2026-08-13': day({ totalTokens: 1000 }) } },
                { id: 'key-a', usageHistory: { '2026-08-13': day({ totalTokens: 100 }) } },
                { id: 'key-b', usageHistory: { '2026-08-13': day({ totalTokens: 100 }) } }
            ],
            now: NOW
        });

        expect(suggestion.keyAssignments.find(item => item.keyId === 'key-hot').highConsumption).toBe(true);
        expect(suggestion.keyAssignments.find(item => item.keyId === 'key-a').highConsumption).toBe(false);
    });

    test('does not move locked groups, credentials, or keys', () => {
        const credentials = createCredentials(4);
        credentials[1].manualLock = true;
        const currentConfig = {
            groups: [
                { id: 'group-a', manualLock: true, credentialUuids: ['cred-1'] },
                { id: 'group-b', credentialUuids: ['cred-2', 'cred-3'] },
                { id: 'group-c', credentialUuids: ['cred-4'] }
            ],
            keyAssignments: [
                { keyId: 'key-locked', routingMode: 'auto', primaryGroupId: 'group-c', manualLock: true }
            ]
        };

        const suggestion = generateCredentialGroupSuggestion({
            credentials,
            keys: [
                { id: 'key-locked', manualLock: true, primaryGroupId: 'group-c' },
                { id: 'key-free' }
            ],
            currentConfig,
            now: NOW
        });

        expect(suggestion.groups.find(group => group.id === 'group-a').credentialUuids).toEqual(['cred-1']);
        expect(suggestion.groups.find(group => group.id === 'group-b').credentialUuids).toContain('cred-2');
        expect(suggestion.keyAssignments.find(item => item.keyId === 'key-locked')).toMatchObject({
            primaryGroupId: 'group-c',
            manualLock: true
        });
    });
});

describe('Codex credential routing decisions', () => {
    const groups = [
        { id: 'group-1', credentialUuids: ['cred-1', 'cred-2'] },
        { id: 'group-2', credentialUuids: ['cred-3'] }
    ];

    test('fixed routing fails closed when the selected credential is unavailable', () => {
        const result = routeKeyToCredentialCandidates({
            keyRouting: {
                routingMode: 'fixed',
                fixedCredential: { providerType: 'openai-codex-oauth', uuid: 'cred-2' }
            },
            groups,
            credentials: [
                { uuid: 'cred-1', isHealthy: true },
                { uuid: 'cred-2', isHealthy: false },
                { uuid: 'cred-3', isHealthy: true }
            ]
        });

        expect(result).toMatchObject({
            errorCode: 'FIXED_CREDENTIAL_UNAVAILABLE',
            candidateProviderUuids: [],
            spillover: false
        });
    });

    test('fixed routing rejects a healthy credential that is not assigned to a credential group', () => {
        const result = routeKeyToCredentialCandidates({
            keyRouting: {
                routingMode: 'fixed',
                fixedCredential: { providerType: 'openai-codex-oauth', uuid: 'cred-4' }
            },
            groups,
            credentials: [
                { uuid: 'cred-4', providerType: 'openai-codex-oauth', isHealthy: true }
            ]
        });

        expect(result).toMatchObject({
            errorCode: 'ROUTE_MISMATCH',
            routeReason: 'FIXED_CREDENTIAL_NOT_IN_GROUP',
            candidateProviderUuids: [],
            selectedGroupId: null
        });
    });

    test('auto routing spills over to another healthy group when the primary group is unavailable', () => {
        const result = routeKeyToCredentialCandidates({
            keyRouting: { routingMode: 'auto', primaryGroupId: 'group-1' },
            groups,
            credentials: [
                { uuid: 'cred-1', isHealthy: false },
                { uuid: 'cred-2', isHealthy: false },
                { uuid: 'cred-3', isHealthy: true }
            ]
        });

        expect(result).toMatchObject({
            selectedGroupId: 'group-2',
            candidateProviderUuids: ['cred-3'],
            spillover: true,
            spilloverReason: 'PRIMARY_GROUP_UNAVAILABLE'
        });
    });

    test('pool routing returns all healthy credentials without selecting a group', () => {
        const result = routeKeyToCredentialCandidates({
            keyRouting: { routingMode: 'pool', primaryGroupId: null },
            groups,
            credentials: [
                { uuid: 'cred-1', isHealthy: true },
                { uuid: 'cred-2', isHealthy: false },
                { uuid: 'cred-3', isHealthy: true }
            ]
        });

        expect(result).toMatchObject({
            routingMode: 'pool',
            selectedGroupId: null,
            candidateProviderUuids: ['cred-1', 'cred-3'],
            fallbackProviderUuids: [],
            spillover: false,
            errorCode: null
        });
    });

    test('routing diagnostics use keyAssignments as canonical fixed config and stay credential-safe', () => {
        const result = diagnoseKeyRouting({
            keyData: {
                id: 'maki-secret-key',
                routingMode: 'fixed',
                fixedCredential: { providerType: 'openai-codex-oauth', uuid: 'stale-uuid' }
            },
            currentConfig: {
                revision: 12,
                groups: [{ id: 'group-1', credentialUuids: ['canonical-uuid'] }],
                keyAssignments: [{
                    keyId: 'maki-secret-key',
                    routingMode: 'fixed',
                    fixedCredential: { providerType: 'openai-codex-oauth', uuid: 'canonical-uuid' }
                }]
            },
            credentials: [{
                uuid: 'canonical-uuid',
                providerType: 'openai-codex-oauth',
                isHealthy: true,
                capacity: 1
            }]
        });

        expect(result).toMatchObject({
            routingConfigSource: 'credential-groups',
            routingMode: 'fixed',
            selectedGroupId: 'group-1',
            errorCode: null,
            fixedCredential: {
                providerType: 'openai-codex-oauth',
                configured: true,
                inGroup: true,
                candidateAvailable: true
            }
        });
        expect(result.fixedCredential.credentialUuid).toBe('canonical-uuid');
        expect(JSON.stringify(result)).not.toContain('stale-uuid');
    });

    test('routing diagnostics report fixed credential group mismatch without exposing secrets', () => {
        const result = diagnoseKeyRouting({
            keyData: {
                id: 'maki-secret-key',
                routingMode: 'fixed',
                fixedCredential: { providerType: 'openai-codex-oauth', uuid: 'stale-uuid' }
            },
            currentConfig: {
                revision: 13,
                groups: [{ id: 'group-1', credentialUuids: ['other-uuid'] }],
                keyAssignments: [{
                    keyId: 'maki-secret-key',
                    routingMode: 'fixed',
                    fixedCredential: { providerType: 'openai-codex-oauth', uuid: 'missing-uuid' }
                }]
            },
            credentials: [{
                uuid: 'missing-uuid',
                providerType: 'openai-codex-oauth',
                isHealthy: true,
                capacity: 1
            }]
        });

        expect(result).toMatchObject({
            errorCode: 'ROUTE_MISMATCH',
            routeReason: 'FIXED_CREDENTIAL_NOT_IN_GROUP',
            selectedGroupId: null,
            fixedCredential: { inGroup: false }
        });
        expect(JSON.stringify(result)).not.toContain('stale-uuid');
        expect(JSON.stringify(result)).not.toContain('token');
        expect(JSON.stringify(result)).not.toContain('proxy');
    });
});

describe('Codex credential group revisions', () => {
    test('applies revisions and rolls back to the previous configuration', async () => {
        const filePath = makeTempFile();
        const service = new CredentialGroupService({ filePath, now: () => NOW });
        const first = await service.apply({
            applicable: true,
            groups: [{ id: 'group-1', credentialUuids: ['cred-1'] }],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-1' }]
        });
        const second = await service.apply({
            applicable: true,
            groups: [{ id: 'group-2', credentialUuids: ['cred-2'] }],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-2' }]
        });
        const rolledBack = await service.rollback();

        expect(first.revision).toBe(1);
        expect(second.revision).toBe(2);
        expect(rolledBack).toMatchObject({ revision: 3, action: 'rollback', sourceRevision: 1 });
        expect((await service.getCurrentConfig()).groups[0].id).toBe('group-1');
        expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).currentRevision).toBe(3);
    });

    test('rejects stale base revisions for apply and rollback', async () => {
        const filePath = makeTempFile();
        const service = new CredentialGroupService({ filePath, now: () => NOW });
        await service.apply({
            applicable: true,
            groups: [{ id: 'group-1', credentialUuids: ['cred-1'] }],
            keyAssignments: []
        });

        await expect(service.apply({
            applicable: true,
            groups: [{ id: 'group-2', credentialUuids: ['cred-2'] }],
            keyAssignments: []
        }, { baseRevision: 0 })).rejects.toMatchObject({
            code: 'CREDENTIAL_GROUP_REVISION_CONFLICT'
        });
        await expect(service.rollback({ baseRevision: 0 })).rejects.toMatchObject({
            code: 'CREDENTIAL_GROUP_REVISION_CONFLICT'
        });
    });

    test('lists newest revision metadata only, defaulting to 50 and capping at 100 entries', async () => {
        const filePath = makeTempFile();
        const revisions = Array.from({ length: 120 }, (_, index) => ({
            revision: index + 1,
            action: index === 119 ? 'rollback' : 'apply',
            createdAt: new Date(NOW.getTime() + index * 1000).toISOString(),
            previousRevision: index || null,
            sourceRevision: index === 119 ? 80 : null,
            config: {
                groups: [{ id: `group-${index + 1}`, credentialUuids: [`secret-cred-${index + 1}`] }],
                keyAssignments: [{ keyId: `secret-key-${index + 1}`, routingMode: 'auto', primaryGroupId: `group-${index + 1}` }]
            }
        }));
        fs.writeFileSync(filePath, JSON.stringify({ version: 1, currentRevision: 120, revisions }));
        const service = new CredentialGroupService({ filePath, now: () => NOW });

        const defaultList = await service.listRevisions();
        const cappedList = await service.listRevisions({ limit: 500 });

        expect(defaultList).toHaveLength(50);
        expect(cappedList).toHaveLength(100);
        expect(defaultList[0]).toMatchObject({
            revision: 120,
            action: 'rollback',
            sourceRevision: 80,
            groupCount: 1,
            assignmentCount: 1,
            isCurrent: true
        });
        expect(defaultList.at(-1).revision).toBe(71);
        expect(defaultList[0]).not.toHaveProperty('config');
        expect(JSON.stringify(defaultList)).not.toContain('secret-cred');
        expect(JSON.stringify(defaultList)).not.toContain('secret-key');
    });
});

describe('Codex credential group suggestion validation', () => {
    const credentials = [
        { providerType: 'openai-codex-oauth', uuid: 'cred-1' },
        { providerType: 'openai-codex-oauth-work', uuid: 'cred-2' }
    ];
    const keys = [{ id: 'key-1' }, { id: 'key-2' }];

    test.each([
        [
            'duplicate group IDs',
            {
                applicable: true,
                groups: [
                    { id: 'group-1', credentialUuids: ['cred-1'] },
                    { id: 'group-1', credentialUuids: ['cred-2'] }
                ],
                keyAssignments: []
            },
            'DUPLICATE_GROUP_ID'
        ],
        [
            'credentials assigned to multiple groups',
            {
                applicable: true,
                groups: [
                    { id: 'group-1', credentialUuids: ['cred-1'] },
                    { id: 'group-2', credentialUuids: ['cred-1'] }
                ],
                keyAssignments: []
            },
            'CREDENTIAL_ASSIGNED_TO_MULTIPLE_GROUPS'
        ],
        [
            'automatic group exceeds the maximum size',
            {
                applicable: true,
                groups: [{ id: 'group-1', credentialUuids: ['cred-1', 'cred-2', 'cred-3'] }],
                keyAssignments: []
            },
            'GROUP_EXCEEDS_MAX_SIZE'
        ],
        [
            'unknown keys',
            {
                applicable: true,
                groups: [{ id: 'group-1', credentialUuids: ['cred-1'] }],
                keyAssignments: [{ keyId: 'missing-key', routingMode: 'auto', primaryGroupId: 'group-1' }]
            },
            'KEY_NOT_FOUND'
        ],
        [
            'unknown primary groups',
            {
                applicable: true,
                groups: [{ id: 'group-1', credentialUuids: ['cred-1'] }],
                keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'missing-group' }]
            },
            'GROUP_NOT_FOUND'
        ],
        [
            'duplicate key assignments',
            {
                applicable: true,
                groups: [{ id: 'group-1', credentialUuids: ['cred-1'] }],
                keyAssignments: [
                    { keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-1' },
                    { keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-1' }
                ]
            },
            'DUPLICATE_KEY_ASSIGNMENT'
        ]
    ])('rejects %s', (_label, suggestion, reason) => {
        expect(() => validateCredentialGroupSuggestion(suggestion, { credentials, keys })).toThrow(
            expect.objectContaining({
                code: 'INVALID_CREDENTIAL_GROUP_CONFIG',
                details: { reason }
            })
        );
    });

    test('requires fixed assignments to use the exact Codex provider type of the credential', () => {
        const suggestion = {
            applicable: true,
            groups: [{ id: 'group-1', credentialUuids: ['cred-2'] }],
            keyAssignments: [{
                keyId: 'key-1',
                routingMode: 'fixed',
                fixedCredential: {
                    providerType: 'openai-codex-oauth',
                    uuid: 'cred-2'
                }
            }]
        };

        expect(() => validateCredentialGroupSuggestion(suggestion, { credentials, keys })).toThrow(
            expect.objectContaining({
                code: 'INVALID_CREDENTIAL_GROUP_CONFIG',
                details: { reason: 'FIXED_CREDENTIAL_PROVIDER_TYPE_INVALID' }
            })
        );
    });

    test('returns normalized groups and assignments for valid input', () => {
        const validated = validateCredentialGroupSuggestion({
            applicable: true,
            groups: [{ id: 'group-1', credentialUuids: ['cred-1'] }],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-1' }]
        }, { credentials, keys });

        expect(validated.groups).toEqual([
            expect.objectContaining({ id: 'group-1', credentialUuids: ['cred-1'], manualLock: false })
        ]);
        expect(validated.keyAssignments).toEqual([
            expect.objectContaining({ keyId: 'key-1', routingMode: 'auto', primaryGroupId: 'group-1' })
        ]);
    });

    test('accepts explicit pool assignments without a primary group', () => {
        const validated = validateCredentialGroupSuggestion({
            applicable: true,
            groups: [{ id: 'group-1', credentialUuids: ['cred-1'] }],
            keyAssignments: [{ keyId: 'key-1', routingMode: 'pool', primaryGroupId: null }]
        }, { credentials, keys });

        expect(validated.keyAssignments).toEqual([
            expect.objectContaining({
                keyId: 'key-1',
                routingMode: 'pool',
                primaryGroupId: null,
                fixedCredential: null
            })
        ]);
    });
});
