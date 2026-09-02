import { describe, expect, test } from '@jest/globals';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getProviderModels } from '../src/providers/provider-models.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnsureToolCallIds() {
    const source = fs.readFileSync(
        path.join(repoRoot, 'src', 'providers', 'gemini', 'antigravity-core.js'),
        'utf8'
    );
    const helperSource = source.match(
        /const TOOL_ID_ALPHABET[\s\S]*?\/\/ --- \[FIX tool_use\.id\] end ---/
    )?.[0];
    expect(helperSource).toBeDefined();
    return Function('crypto', `${helperSource}\nreturn ensureToolCallIds;`)(crypto);
}

describe('upstream model registrations', () => {
    test('no longer advertises Gemini 3.5 Flash for Antigravity', () => {
        // Antigravity does not host these; advertising them produced tens of
        // thousands of upstream 404s before the list was converged.
        expect(getProviderModels('gemini-antigravity')).toEqual(expect.not.arrayContaining([
            'gemini-3.5-flash',
            'gemini-3.5-flash-lite'
        ]));
    });

    test('registers current Grok CLI OAuth models', () => {
        expect(getProviderModels('grok-cli-oauth')).toEqual(expect.arrayContaining([
            'grok-4.5',
            'grok-4.6',
            'grok-build-latest'
        ]));
    });

    test('registers Gemini 3.6 Flash aliases for Gemini and Antigravity providers', () => {
        expect(getProviderModels('gemini-cli-oauth')).toEqual(expect.arrayContaining([
            'gemini-3.6-flash'
        ]));
        // Antigravity only serves the explicit effort tiers, not the bare alias.
        expect(getProviderModels('gemini-antigravity')).toEqual(expect.arrayContaining([
            'gemini-3.6-flash-low',
            'gemini-3.6-flash-medium',
            'gemini-3.6-flash-high',
            'gemini-3.6-flash-tiered'
        ]));
    });

    test('registers Gemini 3.7 Flash aliases for Gemini and Antigravity providers', () => {
        expect(getProviderModels('gemini-cli-oauth')).toContain('gemini-3.7-flash');
        expect(getProviderModels('gemini-antigravity')).toEqual(expect.arrayContaining([
            'gemini-3.7-flash-medium',
            'gemini-3.7-flash-tiered'
        ]));
    });

    test('registers Claude Opus 5 for Kiro', () => {
        expect(getProviderModels('claude-kiro-oauth')).toContain('claude-opus-5');
    });
});

describe('Antigravity model identity mappings', () => {
    test('keeps canonical Flash model names unchanged upstream', () => {
        const source = fs.readFileSync(
            path.join(repoRoot, 'src', 'providers', 'gemini', 'antigravity-core.js'),
            'utf8'
        );
        expect(source).not.toMatch(/'gemini-3\.5-flash':\s*'[^']+'/);
        expect(source).not.toMatch(/'gemini-3\.5-flash-lite':\s*'[^']+'/);
        expect(source).not.toMatch(/'gemini-3\.6-flash':\s*'gemini-3\.6-flash-low'/);
        expect(source).not.toMatch(/'gemini-3\.7-flash':\s*'gemini-3\.7-flash-low'/);
        expect(source).not.toMatch(/'gemini-3\.5-flash-high':\s*'gemini-3\.5-flash-low'/);
        expect(source).not.toMatch(/'gemini-3\.6-flash-high':\s*'gemini-3\.6-flash-low'/);
        expect(source).not.toMatch(/'gemini-3\.7-flash-high':\s*'gemini-3\.7-flash-low'/);
        expect(source).not.toMatch(/'gemini-3\.1-pro-high':\s*'gemini-pro-agent'/);
        expect(source).not.toMatch(/'gemini-3\.1-pro-preview':\s*'gemini-pro-agent'/);
        expect(source).toContain('.map(modelId => normalizeAntigravityModelId(modelId))');
        expect(source).not.toContain('.flatMap(modelId => expandAntigravityClientModels(modelId))');
    });
});

describe('Antigravity tool call id normalization', () => {
    test('generates ids and pairs function responses FIFO by tool name', () => {
        const ensureToolCallIds = loadEnsureToolCallIds();

        const contents = [
            { parts: [{ functionCall: { name: 'lookup', args: { value: 1 } } }] },
            { parts: [{ functionCall: { name: 'lookup', args: { value: 2 } } }] },
            { parts: [{ functionResponse: { name: 'lookup', response: { value: 1 } } }] },
            { parts: [{ functionResponse: { name: 'lookup', response: { value: 2 } } }] }
        ];

        ensureToolCallIds(contents);

        const firstCallId = contents[0].parts[0].functionCall.id;
        const secondCallId = contents[1].parts[0].functionCall.id;
        expect(firstCallId).toMatch(/^toolu_vrtx_[A-Za-z0-9]{26}$/);
        expect(secondCallId).toMatch(/^toolu_vrtx_[A-Za-z0-9]{26}$/);
        expect(secondCallId).not.toBe(firstCallId);
        expect(contents[2].parts[0].functionResponse.id).toBe(firstCallId);
        expect(contents[3].parts[0].functionResponse.id).toBe(secondCallId);
    });

    test('preserves an existing response id while consuming its pending call id', () => {
        const ensureToolCallIds = loadEnsureToolCallIds();

        const contents = [
            { parts: [{ functionCall: { name: 'lookup', id: 'generated-call-1' } }] },
            { parts: [{ functionCall: { name: 'lookup', id: 'generated-call-2' } }] },
            { parts: [{ functionResponse: { name: 'lookup', id: 'client-response-id' } }] },
            { parts: [{ functionResponse: { name: 'lookup' } }] }
        ];

        ensureToolCallIds(contents);

        expect(contents[2].parts[0].functionResponse.id).toBe('client-response-id');
        expect(contents[3].parts[0].functionResponse.id).toBe('generated-call-2');
    });
});
