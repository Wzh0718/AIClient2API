import { getProviderMappingByDirName } from '../src/utils/provider-utils.js';
import { readFile } from 'node:fs/promises';

describe('Codex health-check defaults', () => {
    test('new Codex credentials default to gpt-6-luna', () => {
        expect(getProviderMappingByDirName('codex').defaultCheckModel).toBe('gpt-6-luna');
    });

    test('scheduled Codex health checks fall back to gpt-6-luna', async () => {
        const source = await readFile(new URL('../src/providers/provider-pool-manager.js', import.meta.url), 'utf8');
        expect(source).toContain("'openai-codex-oauth': 'gpt-6-luna'");
    });
});
