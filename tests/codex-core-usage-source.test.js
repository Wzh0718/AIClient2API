import fs from 'fs';
import path from 'path';

describe('Codex usage source regressions', () => {
    test('Codex usage limits also fetch the CLI token usage profile endpoint', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/providers/openai/codex-core.js'), 'utf8');

        expect(source).toContain('https://chatgpt.com/backend-api/wham/usage');
        expect(source).toContain('https://chatgpt.com/backend-api/wham/profiles/me');
        expect(source).toContain('token_usage_profile');
    });

    test('Codex usage limits fetch rate limit reset credit details without consuming a credit', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/providers/openai/codex-core.js'), 'utf8');

        expect(source).toContain('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
        expect(source).toContain('rate_limit_reset_credits');
        expect(source).not.toContain('rate_limit_reset_credits: await this.postCodexUsageJson');
    });

    test('Codex priority service tier is tracked as a fast model in usage hooks', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/utils/common.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('function getUsageTrackingModel(model, requestBody, toProvider)');
        expect(source).toContain("['priority', 'fast'].includes(requestBody?.service_tier)");
        expect(source).toContain('return `${baseModel}-fast`;');
        expect(source).toContain('const usageTrackingModel = getUsageTrackingModel(model, requestBody, toProvider);');
        expect(source).toContain('const finalUsageModel = getUsageTrackingModel(model, processedRequestBody, toProvider);');
        expect(source).toContain('model: usageTrackingModel');
        expect(source).toContain('model: finalUsageModel');
    });

    test('Codex ultrafast service tier is tracked with a distinct model label', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/utils/common.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain("requestBody?.service_tier === 'ultrafast'");
        expect(source).toContain('return `${baseModel}-ultrafast`;');
    });

    test('Codex service tiers keep fast and ultrafast distinct in the request path', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/providers/openai/codex-core.js'), 'utf8').replace(/\r\n/g, '\n');

        expect(source).toContain('["default", "priority", "fast", "ultrafast"].includes(result.service_tier)');
    });
});
