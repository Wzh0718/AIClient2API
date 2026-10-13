import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    getCodexModelIds
} from '../src/providers/openai/codex-model-capabilities.js';
import {
    getProviderModels
} from '../src/providers/provider-models.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('codex 5.6 model registration', () => {
    test('lists current Codex models without retired GPT-5.4 models', () => {
        const models = getProviderModels('openai-codex-oauth');
        const codexModels = getCodexModelIds(models);

        expect(models).toEqual(expect.arrayContaining([
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.6-luna'
        ]));
        expect(models).not.toContain('gpt-5.5');
        expect(models).not.toContain('gpt-5.3-codex-spark');
        expect(models).not.toContain('gpt-5.4');
        expect(models).not.toContain('gpt-5.4-mini');
        expect(codexModels).not.toContain('gpt-5.4-mini-fast');
        expect(models).toEqual(expect.arrayContaining([
            'gpt-image-2',
            'gpt-image-2.5-flare',
            'gpt-image-2.5-sunburst'
        ]));
        expect(models).toContain('gpt-image-2.5');
        expect(codexModels).toContain('gpt-image-2.5');
        expect(codexModels).not.toContain('gpt-image-2.5-fast');
        expect(codexModels).not.toContain('gpt-image-2.5-ultrafast');
        expect(models).not.toContain('gpt-image-2.5-flare-2026-09-08');
    });

    test('keeps bare GPT-5.6 invalid and reports unsupported models instead of silently falling back', () => {
        const routingSource = fs.readFileSync(path.join(repoRoot, 'src', 'services', 'service-manager.js'), 'utf8');
        const modelRoutingSource = fs.readFileSync(path.join(repoRoot, 'src', 'providers', 'openai', 'codex-model-routing.js'), 'utf8');
        const codexSource = fs.readFileSync(path.join(repoRoot, 'src', 'providers', 'openai', 'codex-core.js'), 'utf8');

        expect(routingSource).not.toContain("'openai-codex-oauth:gpt-5.6': 'gpt-5.6-sol'");
        expect(routingSource).toContain('resolveCodexEntryModel');
        expect(modelRoutingSource).toContain('DEFAULT_CODEX_FALLBACK_MODEL = null');
        expect(modelRoutingSource).toContain('不支持的模型');
        expect(codexSource).toContain('createUnsupportedCodexModelError(model)');
        expect(codexSource).not.toContain('selectedModel = DEFAULT_CODEX_FALLBACK_MODEL;');
    });
});
