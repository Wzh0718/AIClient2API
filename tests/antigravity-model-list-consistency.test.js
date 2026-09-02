import fs from 'fs';
import path from 'path';
import { ANTIGRAVITY_ELASTIC_MODEL_ORDER } from '../src/providers/antigravity-model-order.js';
import { PROVIDER_MODELS } from '../src/providers/provider-models.js';

function readSource(relativePath) {
    return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('Antigravity model list consistency', () => {
    test('every elastic fallback model is an advertised Antigravity model', () => {
        const advertised = new Set(PROVIDER_MODELS['gemini-antigravity']);
        const missing = ANTIGRAVITY_ELASTIC_MODEL_ORDER.filter(model => !advertised.has(model));
        expect(missing).toEqual([]);
    });

    test('the chain has a single definition instead of per-module copies', () => {
        for (const file of [
            'src/core/config-manager.js',
            'src/ui-modules/config-api.js',
            'src/providers/provider-pool-manager.js'
        ]) {
            const source = readSource(file);
            expect(source).toContain('antigravity-model-order.js');
            expect(source).not.toContain("'gemini-3.6-flash-medium',");
        }
    });
});
