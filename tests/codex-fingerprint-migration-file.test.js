import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { migrateCodexFingerprintProviderPoolsFile } from '../src/utils/codex-fingerprint-migration.js';

const tempDirs = [];

afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Codex fingerprint provider pool file migration', () => {
    test('writes an atomic migration and creates a pre-migration backup', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-codex-fp-'));
        tempDirs.push(dir);
        const filePath = path.join(dir, 'provider_pools.json');
        fs.writeFileSync(filePath, JSON.stringify({
            'openai-codex-oauth': [{ uuid: 'legacy-account' }],
            'openai-custom': [{ uuid: 'custom-account' }]
        }), 'utf8');
        const config = { PROVIDER_POOLS_FILE_PATH: filePath, providerPools: {} };

        const result = await migrateCodexFingerprintProviderPoolsFile({ config, persistenceEnabled: true });
        const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const backups = fs.readdirSync(dir).filter(name => name.includes('.before-codex-fingerprint-') && name.endsWith('.bak'));

        expect(result.persisted).toBe(true);
        expect(result.backupPath).toBeTruthy();
        expect(backups).toHaveLength(1);
        expect(persisted['openai-codex-oauth'][0]).toEqual(expect.objectContaining({
            codexFingerprintMode: 'session',
            codexFingerprintVersion: 1,
            codexFingerprintMigrated: true
        }));
        expect(config.providerPools).toEqual(persisted);

        const second = await migrateCodexFingerprintProviderPoolsFile({ config, persistenceEnabled: true });
        expect(second.changed).toBe(false);
        expect(fs.readdirSync(dir).filter(name => name.includes('.before-codex-fingerprint-') && name.endsWith('.bak'))).toHaveLength(1);
    });

    test('does not persist from an execution worker', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-codex-fp-worker-'));
        tempDirs.push(dir);
        const filePath = path.join(dir, 'provider_pools.json');
        fs.writeFileSync(filePath, JSON.stringify({ 'openai-codex-oauth': [{ uuid: 'legacy-account' }] }), 'utf8');
        const config = { PROVIDER_POOLS_FILE_PATH: filePath, providerPools: {} };

        const result = await migrateCodexFingerprintProviderPoolsFile({ config, persistenceEnabled: false });
        expect(result.skipped).toBe(true);
        expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))['openai-codex-oauth'][0].codexFingerprintMode).toBeUndefined();
    });
});
