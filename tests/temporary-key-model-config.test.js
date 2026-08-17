import { describe, expect, test } from '@jest/globals';
import fs from 'fs';

describe('temporary key model route configuration', () => {
    test('ships disabled by default and documents the operations-only rule shape', () => {
        const managerSource = fs.readFileSync('src/core/config-manager.js', 'utf8');
        const example = JSON.parse(fs.readFileSync('configs/config.json.example', 'utf8'));

        expect(managerSource).toContain('temporaryKeyModelRoutes: []');
        expect(example.temporaryKeyModelRoutes).toEqual([
            {
                id: 'temporary-antigravity-flash',
                enabled: false,
                keyHash: 'sha256:<full-64-character-hex-digest>',
                paths: ['/openai-codex-oauth/v1/responses'],
                modelFamilies: ['gpt-5.3', 'gpt-5.4'],
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                fallbackToOriginal: true,
                preserveResponseModel: true
            }
        ]);
        expect(JSON.stringify(example.temporaryKeyModelRoutes)).not.toContain('maki_');
    });
});
