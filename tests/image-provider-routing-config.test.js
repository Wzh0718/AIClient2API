import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';
import { initializeConfig } from '../src/core/config-manager.js';

describe('image provider round-robin configuration', () => {
    test('defaults to enabled and exposes a CLI flag', () => {
        const source = readFileSync('src/core/config-manager.js', 'utf8');

        expect(source).toContain('IMAGE_PROVIDER_ROUND_ROBIN_ENABLED: true');
        expect(source).toContain("--image-provider-round-robin-enabled");
    });

    test('round-trip exposes the setting through the config API and admin UI', () => {
        const configApi = readFileSync('src/ui-modules/config-api.js', 'utf8');
        const html = readFileSync('static/components/section-config.html', 'utf8');
        const manager = readFileSync('static/app/config-manager.js', 'utf8');

        expect(configApi).toContain('IMAGE_PROVIDER_ROUND_ROBIN_ENABLED');
        expect(html).toContain('imageProviderRoundRobinEnabled');
        expect(manager).toContain('IMAGE_PROVIDER_ROUND_ROBIN_ENABLED');
    });
});

describe('Codex image size normalization configuration', () => {
    test('defaults to enabled with conservative limits and exposes CLI flags', () => {
        const source = readFileSync('src/core/config-manager.js', 'utf8');

        expect(source).toContain('IMAGE_SIZE_NORMALIZATION_ENABLED: true');
        expect(source).toContain('IMAGE_PROMPT_ASPECT_CONSTRAINT_ENABLED: true');
        expect(source).toContain('IMAGE_ASPECT_MISMATCH_THRESHOLD: 0.10');
        expect(source).toContain('IMAGE_SIZE_MAX_PIXELS: 8388608');
        expect(source).toContain("--image-size-normalization-enabled");
        expect(source).toContain("--image-prompt-aspect-constraint-enabled");
        expect(source).toContain("--image-aspect-mismatch-threshold");
        expect(source).toContain("--image-size-max-pixels");
        expect(source).toContain("case 'float'");
    });

    test('round-trips all image normalization settings through the config API and admin UI', () => {
        const configApi = readFileSync('src/ui-modules/config-api.js', 'utf8');
        const html = readFileSync('static/components/section-config.html', 'utf8');
        const manager = readFileSync('static/app/config-manager.js', 'utf8');

        for (const key of [
            'IMAGE_SIZE_NORMALIZATION_ENABLED',
            'IMAGE_PROMPT_ASPECT_CONSTRAINT_ENABLED',
            'IMAGE_ASPECT_MISMATCH_THRESHOLD',
            'IMAGE_SIZE_MAX_PIXELS'
        ]) {
            expect(configApi).toContain(key);
            expect(manager).toContain(key);
        }

        expect(html).toContain('imageSizeNormalizationEnabled');
        expect(html).toContain('imagePromptAspectConstraintEnabled');
        expect(html).toContain('imageAspectMismatchThreshold');
        expect(html).toContain('imageSizeMaxPixels');
    });

    test('verifies sharp can load during the Alpine Docker build', () => {
        const dockerfile = readFileSync('Dockerfile', 'utf8');
        expect(dockerfile).toContain("import('sharp')");
    });

    test('falls back to 0.10 when CLI aspect threshold is outside 0..1', async () => {
        const config = await initializeConfig(
            ['--image-aspect-mismatch-threshold', '10'],
            'configs/missing-image-normalization-test-config.json'
        );

        expect(config.IMAGE_ASPECT_MISMATCH_THRESHOLD).toBe(0.10);
    });
});

describe('Codex OAuth fingerprint configuration', () => {
    test('defaults to enabled and round-trips through the admin config API and UI', () => {
        const source = readFileSync('src/core/config-manager.js', 'utf8');
        const configApi = readFileSync('src/ui-modules/config-api.js', 'utf8');
        const html = readFileSync('static/components/section-config.html', 'utf8');
        const manager = readFileSync('static/app/config-manager.js', 'utf8');

        expect(source).toContain('CODEX_FINGERPRINT_ENABLED: true');
        expect(configApi).toContain('currentConfig.CODEX_FINGERPRINT_ENABLED === true');
        expect(source).toContain('--codex-fingerprint-enabled');
        expect(configApi).toContain('CODEX_FINGERPRINT_ENABLED');
        expect(manager).toContain('CODEX_FINGERPRINT_ENABLED');
        expect(html).toContain('codexFingerprintEnabled');
    });
});

describe('Codex cloaking configuration', () => {
    test('defaults to enabled and round-trips through the admin config API, UI and runtime sync', () => {
        const source = readFileSync('src/core/config-manager.js', 'utf8');
        const configApi = readFileSync('src/ui-modules/config-api.js', 'utf8');
        const html = readFileSync('static/components/section-config.html', 'utf8');
        const manager = readFileSync('static/app/config-manager.js', 'utf8');
        const sync = readFileSync('src/runtime/codex-runtime-config-sync.js', 'utf8');

        expect(source).toContain('CODEX_CLOAKING_ENABLED: true');
        expect(source).toContain('--codex-cloaking-enabled');
        expect(configApi).toContain('CODEX_CLOAKING_ENABLED_SOURCE');
        expect(configApi).toContain('currentConfig.CODEX_CLOAKING_ENABLED = parseBooleanConfig');
        expect(html).toContain('id="codexCloakingEnabled"');
        expect(manager).toContain("getElementById('codexCloakingEnabled')");
        expect(sync).toContain("'CODEX_CLOAKING_ENABLED'");
    });
});
