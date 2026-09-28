import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanConfigFiles } from '../src/ui-modules/config-scanner.js';

describe('config scanner runtime artifact boundary', () => {
    test('lists credential files without reading transient runtime JSON', async () => {
        const configsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'config-scanner-'));
        try {
            const credentialDir = path.join(configsPath, 'codex');
            const spoolDir = path.join(configsPath, 'runtime-hook-spool', 'execution-1');
            fs.mkdirSync(credentialDir, { recursive: true });
            fs.mkdirSync(spoolDir, { recursive: true });
            fs.writeFileSync(path.join(credentialDir, 'credential.json'), '{}');
            fs.writeFileSync(path.join(spoolDir, 'transient.json'), '{broken');

            const files = await scanConfigFiles({}, null, { configsPath });
            expect(files.map(file => file.name)).toContain('credential.json');
            expect(files.map(file => file.name)).not.toContain('transient.json');
        } finally {
            fs.rmSync(configsPath, { recursive: true });
        }
    });
});
