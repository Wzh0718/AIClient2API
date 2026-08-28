import { describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

jest.mock('google-auth-library', () => ({
    OAuth2Client: jest.fn().mockImplementation(function OAuth2Client() {
        this.on = jest.fn();
        this.setCredentials = jest.fn();
    })
}));
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../src/auth/oauth-handlers.js', () => ({ handleGeminiAntigravityOAuth: jest.fn() }));
jest.mock('../src/services/service-manager.js', () => ({ getProviderPoolManager: jest.fn(() => null) }));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(options => options),
    getRequiredProxyConfigForProvider: jest.fn(() => null),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

import { cleanJsonSchemaProperties } from '../src/converters/utils.js';
import { AntigravityApiService } from '../src/providers/gemini/antigravity-core.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

describe('selective upstream compatibility fixes', () => {
    test('sanitizes Gemini enum values to strings and removes empty enum', () => {
        expect(cleanJsonSchemaProperties({
            type: 'OBJECT',
            properties: {
                status: { type: 'string', enum: ['ready', 1, false] },
                empty: { type: 'string', enum: [1, false] }
            }
        })).toEqual({
            type: 'OBJECT',
            properties: {
                status: { type: 'STRING', enum: ['ready'] },
                empty: { type: 'STRING' }
            }
        });
    });

    test('uses the upstream Antigravity 2.8.1 user agent', () => {
        const service = new AntigravityApiService({
            MODEL_PROVIDER: 'gemini-antigravity',
            ANTIGRAVITY_BASE_URL: 'http://127.0.0.1:1',
            PROJECT_ID: 'test-project'
        });

        expect(service.userAgent).toBe('antigravity/2.8.1 darwin/arm64');
    });

    test('filters SSE comments and normalizes prefixes in Grok Web and Codex parsers', () => {
        const grokSource = readSource('src/providers/grok/grok-core.js');
        const codexSource = readSource('src/providers/openai/codex-core.js');

        expect(grokSource).toContain("if (!trimmed || trimmed.startsWith(':')) continue;");
        expect(grokSource).toContain("trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed");
        expect(codexSource).toContain("trimmedLine.startsWith(':') || trimmedLine.startsWith('event:')");
    });

    test('keeps Responses termination separate while always ending ordinary OpenAI streams', () => {
        const commonSource = readSource('src/utils/common.js');
        expect(commonSource).toContain("await writeWithBackpressure(res, 'data: [DONE]\\n\\n');");
        expect(commonSource).toContain('OpenAI Responses 以 response.completed/response.incomplete');
        expect(commonSource).not.toContain("event: done\\n");
    });
});
