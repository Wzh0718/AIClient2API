import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeConfig } from '../src/core/config-manager.js';

describe('Antigravity elastic routing config', () => {
    test('fills safe defaults while preserving an explicitly supplied override', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-elastic-'));
        const configPath = path.join(dir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({
            antigravityElasticRouting: { maxQueueWaitMs: 12000 }
        }));

        const config = await initializeConfig([], configPath);

        expect(config.antigravityElasticRouting).toEqual(expect.objectContaining({
            enabled: true,
            maxQueueWaitMs: 12000,
            preferOriginalWaitMs: 10000,
            fallbackModels: [
                'gemini-2.5-flash-lite',
                'gemini-2.5-flash',
                'gemini-3.1-flash-lite',
                'gemini-3-flash',
                'gemini-3.6-flash-medium',
                'gemini-3.7-flash-medium'
            ],
            globalQueueLimit: 512,
            perKeyModelQueueLimit: 256,
            globalQueuedBytesLimit: 64 * 1024 * 1024
        }));
    });
});
