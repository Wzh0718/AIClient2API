import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    attachCodexSubscriptionWindow,
    extractCodexSubscriptionWindow,
    mergeCodexSubscriptionWindow,
    readCodexSubscriptionWindow
} from '../src/utils/codex-utils.js';
import { normalizeCpaCodexCredentials } from '../src/auth/codex-import-normalizer.js';

function makeJwt(payload) {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${body}.sig`;
}

function makeAuthJwt(auth = {}, extra = {}) {
    return makeJwt({
        email: 'user@example.com',
        'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct-1',
            ...auth
        },
        ...extra
    });
}

describe('Codex subscription window', () => {
    test('extracts ISO dates from nested auth claims', () => {
        expect(extractCodexSubscriptionWindow({
            'https://api.openai.com/auth': {
                chatgpt_subscription_active_start: '2026-08-11T17:59:00.000Z',
                chatgpt_subscription_active_until: '2026-09-11T17:59:00.000Z'
            }
        })).toEqual({
            subscription_active_start: '2026-08-11T17:59:00.000Z',
            subscription_active_until: '2026-09-11T17:59:00.000Z'
        });
    });

    test('extracts unix seconds from a JWT string', () => {
        const jwt = makeAuthJwt({
            chatgpt_subscription_active_start: 1781341567,
            chatgpt_subscription_active_until: 1783933567
        });

        expect(extractCodexSubscriptionWindow(jwt)).toEqual({
            subscription_active_start: new Date(1781341567 * 1000).toISOString(),
            subscription_active_until: new Date(1783933567 * 1000).toISOString()
        });
    });

    test('extracts only until when start is missing', () => {
        expect(extractCodexSubscriptionWindow({
            'https://api.openai.com/auth': {
                chatgpt_subscription_active_until: '2026-09-18T12:37:00.000Z'
            }
        })).toEqual({
            subscription_active_start: null,
            subscription_active_until: '2026-09-18T12:37:00.000Z'
        });
    });

    test('returns empty window for missing or invalid dates', () => {
        expect(extractCodexSubscriptionWindow(null)).toEqual({
            subscription_active_start: null,
            subscription_active_until: null
        });
        expect(extractCodexSubscriptionWindow({
            'https://api.openai.com/auth': {
                chatgpt_subscription_active_until: 'not-a-date'
            }
        })).toEqual({
            subscription_active_start: null,
            subscription_active_until: null
        });
    });

    test('prefers persisted credential fields over JWT claims', () => {
        expect(extractCodexSubscriptionWindow({
            subscription_active_until: '2026-09-18T12:37:00.000Z',
            id_token: makeAuthJwt({
                chatgpt_subscription_active_until: '2026-12-07T12:33:55.442Z'
            })
        })).toEqual({
            subscription_active_start: null,
            subscription_active_until: '2026-09-18T12:37:00.000Z'
        });
    });

    test('keeps previous dates when refresh claims omit the window', () => {
        expect(mergeCodexSubscriptionWindow(
            {
                subscription_active_start: '2026-08-11T17:59:00.000Z',
                subscription_active_until: '2026-09-11T17:59:00.000Z'
            },
            extractCodexSubscriptionWindow(makeAuthJwt({ chatgpt_plan_type: 'pro' }))
        )).toEqual({
            subscription_active_start: '2026-08-11T17:59:00.000Z',
            subscription_active_until: '2026-09-11T17:59:00.000Z'
        });
    });

    test('replaces previous dates when refresh claims include a new window', () => {
        expect(mergeCodexSubscriptionWindow(
            {
                subscription_active_start: '2026-08-11T17:59:00.000Z',
                subscription_active_until: '2026-09-11T17:59:00.000Z'
            },
            extractCodexSubscriptionWindow(makeAuthJwt({
                chatgpt_subscription_active_until: '2026-10-11T17:59:00.000Z'
            }))
        )).toEqual({
            subscription_active_start: '2026-08-11T17:59:00.000Z',
            subscription_active_until: '2026-10-11T17:59:00.000Z'
        });
    });
});

describe('Codex subscription window persistence helpers', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-subscription-window-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('reads only persisted dates from a credential file and does not parse id_token', async () => {
        const filePath = path.join(tempDir, 'codex.json');
        fs.writeFileSync(filePath, JSON.stringify({
            subscription_active_until: '2026-09-18T12:37:00.000Z',
            id_token: makeAuthJwt({
                chatgpt_subscription_active_until: '2026-12-07T12:33:55.442Z'
            })
        }), 'utf8');

        await expect(readCodexSubscriptionWindow(filePath)).resolves.toEqual({
            subscription_active_start: null,
            subscription_active_until: '2026-09-18T12:37:00.000Z'
        });
    });

    test('returns empty window when credential file has no persisted dates', async () => {
        const filePath = path.join(tempDir, 'legacy.json');
        fs.writeFileSync(filePath, JSON.stringify({
            email: 'user@example.com',
            access_token: 'token'
        }), 'utf8');

        await expect(readCodexSubscriptionWindow(filePath)).resolves.toEqual({
            subscription_active_start: null,
            subscription_active_until: null
        });
    });
});

describe('Codex subscription window attach and source wiring', () => {
    test('attachCodexSubscriptionWindow writes dates and keeps previous when claims omit them', () => {
        const attached = attachCodexSubscriptionWindow(
            { email: 'user@example.com', type: 'codex' },
            makeAuthJwt({ chatgpt_plan_type: 'pro' }),
            {
                subscription_active_start: '2026-08-11T17:59:00.000Z',
                subscription_active_until: '2026-09-11T17:59:00.000Z'
            }
        );

        expect(attached).toMatchObject({
            email: 'user@example.com',
            type: 'codex',
            subscription_active_start: '2026-08-11T17:59:00.000Z',
            subscription_active_until: '2026-09-11T17:59:00.000Z'
        });
    });

    test('OAuth complete, refresh, and import write the subscription window', () => {
        const oauth = fs.readFileSync(path.join(process.cwd(), 'src/auth/codex-oauth.js'), 'utf8').replace(/\r\n/g, '\n');
        expect(oauth).toContain("import { attachCodexSubscriptionWindow, buildCodexRedirectUri } from '../utils/codex-utils.js'");
        expect(oauth).toContain('const credentials = attachCodexSubscriptionWindow({');
        expect(oauth).toContain('return attachCodexSubscriptionWindow({');
        expect(oauth).toContain('}, claims, tokenData);');
        expect((oauth.match(/attachCodexSubscriptionWindow\(/g) || []).length).toBeGreaterThanOrEqual(4);
    });

    test('Codex saveCredentials persists empty subscription dates by default and refresh keeps previous values', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/providers/openai/codex-core.js'), 'utf8').replace(/\r\n/g, '\n');
        expect(source).toContain('this.subscription_active_start = null;');
        expect(source).toContain('this.subscription_active_until = null;');
        expect(source).toContain('extractPersistedCodexSubscriptionWindow(creds)');
        expect(source).toContain('mergeCodexSubscriptionWindow(');
        expect(source).toContain('subscription_active_start: this.subscription_active_start || null');
        expect(source).toContain('subscription_active_until: this.subscription_active_until || null');
    });

    test('usage API reads persisted credential dates and keeps them across cache merges', () => {
        const usageApi = fs.readFileSync(path.join(process.cwd(), 'src/ui-modules/usage-api.js'), 'utf8').replace(/\r\n/g, '\n');
        const usageCache = fs.readFileSync(path.join(process.cwd(), 'src/ui-modules/usage-cache.js'), 'utf8').replace(/\r\n/g, '\n');
        expect(usageApi).toContain('readCodexSubscriptionWindowSync(getProviderConfigFilePath(provider, providerType))');
        expect(usageApi).toContain('...getProviderSubscriptionWindow(provider, providerType)');
        expect(usageApi).toContain('subscription_active_start: instance.subscription_active_start || cachedInstance.subscription_active_start || null');
        expect(usageApi).toContain("'subscription_active_start', 'subscription_active_until'");
        expect(usageCache).toContain('subscription_active_until: incomingInstance.subscription_active_until || cachedInstance.subscription_active_until || null');
    });
});

describe('Codex import subscription window', () => {
    test('CPA import writes subscription dates from id_token claims', () => {
        const [credential] = normalizeCpaCodexCredentials({
            access_token: makeJwt({ sub: 'acct-1' }),
            id_token: makeAuthJwt({
                chatgpt_account_id: 'acct-1',
                chatgpt_subscription_active_start: '2026-08-18T12:37:00.000Z',
                chatgpt_subscription_active_until: '2026-09-18T12:37:00.000Z'
            })
        });

        expect(credential.subscription_active_start).toBe('2026-08-18T12:37:00.000Z');
        expect(credential.subscription_active_until).toBe('2026-09-18T12:37:00.000Z');
    });

    test('CPA import defaults missing subscription dates to null', () => {
        const [credential] = normalizeCpaCodexCredentials({
            access_token: makeJwt({ sub: 'acct-1' }),
            id_token: makeAuthJwt({ chatgpt_account_id: 'acct-1' })
        });

        expect(credential.subscription_active_start).toBeNull();
        expect(credential.subscription_active_until).toBeNull();
    });
});

describe('Codex subscription until label', () => {
    beforeAll(() => {
        globalThis.window = { location: { origin: 'http://localhost' } };
        globalThis.localStorage = {
            getItem: jest.fn(() => 'zh-CN'),
            setItem: jest.fn(),
            removeItem: jest.fn()
        };
    });

    afterAll(() => {
        delete globalThis.window;
        delete globalThis.localStorage;
    });

    test('formats future, empty, and expired subscription dates', async () => {
        const { formatCodexSubscriptionUntilLabel } = await import('../static/app/usage-manager.js');
        const now = Date.parse('2026-09-08T12:37:00.000Z');

        expect(formatCodexSubscriptionUntilLabel(null, now)).toBe('');
        expect(formatCodexSubscriptionUntilLabel('2026-09-18T12:37:00.000Z', now)).toBe('09/18 20:37 · 10天后');
        expect(formatCodexSubscriptionUntilLabel('2026-09-08T16:37:00.000Z', now)).toBe('09/09 00:37 · 4小时后');
        expect(formatCodexSubscriptionUntilLabel('2026-09-01T12:37:00.000Z', now)).toBe('09/01 20:37 · 已到期');
    });
});
