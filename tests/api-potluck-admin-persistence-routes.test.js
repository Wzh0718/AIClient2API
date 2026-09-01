import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';

const mockUpdateKeyName = jest.fn();
const PUBLIC_KEY_ID = `sha256:${crypto.createHash('sha256').update('key-1').digest('hex').slice(0, 16)}`;

jest.mock('../src/plugins/api-potluck/key-manager.js', () => ({
    createKey: jest.fn(),
    listKeys: jest.fn(),
    getKey: jest.fn(),
    deleteKey: jest.fn(),
    updateKeyLimit: jest.fn(),
    resetKeyUsage: jest.fn(),
    resetKeyTokenStats: jest.fn(),
    toggleKey: jest.fn(),
    updateKeyName: mockUpdateKeyName,
    updateKeyRouting: jest.fn(),
    regenerateKey: jest.fn(),
    getStats: jest.fn(),
    getAccountUsageSummary: jest.fn(),
    validateKey: jest.fn(),
    KEY_PREFIX: 'maki_',
    applyDailyLimitToAllKeys: jest.fn(),
    getAllKeyIds: jest.fn(),
    resetAllTokenStats: jest.fn()
}));

const originalCwd = process.cwd();
let tempDir;
let consoleSpies = [];

function writeAdminToken(token = 'admin-token') {
    fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'configs', 'token-store.json'), JSON.stringify({
        tokens: {
            [token]: { expiryTime: Date.now() + 60_000 }
        }
    }));
    return token;
}

async function callUpdateName(result) {
    mockUpdateKeyName.mockResolvedValueOnce(result);
    const token = writeAdminToken();
    const body = JSON.stringify({ name: 'Updated Name' });
    const req = Readable.from([body]);
    req.url = '/api/potluck/keys/key-1/name';
    req.headers = {
        authorization: `Bearer ${token}`,
        'content-length': String(Buffer.byteLength(body))
    };
    const res = {
        statusCode: null,
        body: null,
        writeHead(statusCode) {
            this.statusCode = statusCode;
        },
        end(value) {
            this.body = JSON.parse(value);
        }
    };
    const { handlePotluckApiRoutes } = await import('../src/plugins/api-potluck/api-routes.js');

    const handled = await handlePotluckApiRoutes('PUT', req.url, req, res);

    expect(handled).toBe(true);
    expect(mockUpdateKeyName).toHaveBeenCalledWith('key-1', 'Updated Name');
    return res;
}

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-potluck-route-'));
    process.chdir(tempDir);
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('api potluck administration persistence responses', () => {
    test('returns 202 and a Chinese pending message when update-name is accepted in memory', async () => {
        const res = await callUpdateName({
            id: 'key-1',
            name: 'Updated Name',
            persistencePending: true
        });

        expect(res.statusCode).toBe(202);
        expect(res.body).toMatchObject({
            success: true,
            persistencePending: true,
            data: {
                id: PUBLIC_KEY_ID,
                name: 'Updated Name'
            }
        });
        expect(res.body.data).not.toHaveProperty('persistencePending');
        expect(res.body.message).toContain('变更已在内存生效');
        expect(res.body.message).toContain('后台重试');
    });

    test('keeps the normal 200 response when update-name is persisted', async () => {
        const res = await callUpdateName({
            id: 'key-1',
            name: 'Updated Name',
            usageHistory: { '2026-08-27': { models: { 'gpt-5': { totalTokens: 999999 } } } },
            persistencePending: false
        });

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            persistencePending: false,
            message: '名称更新成功',
            data: {
                id: PUBLIC_KEY_ID,
                name: 'Updated Name'
            }
        });
        expect(res.body.data).not.toHaveProperty('persistencePending');
        expect(res.body.data).not.toHaveProperty('usageHistory');
    });
});
