import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalCwd = process.cwd();
let tempDir;
let consoleSpies = [];

async function loadPrewarmService() {
    jest.resetModules();
    return await import('../src/services/codex-prewarm-service.js');
}

function createPoolManager() {
    return {
        providerStatus: {
            'openai-codex-oauth': [
                { uuid: 'codex-a', type: 'openai-codex-oauth', config: { uuid: 'codex-a', customName: 'US A', isDisabled: false, isHealthy: true } },
                { uuid: 'codex-b', type: 'openai-codex-oauth', config: { uuid: 'codex-b', customName: 'US B', isDisabled: false, isHealthy: false } },
                { uuid: 'codex-disabled', type: 'openai-codex-oauth', config: { uuid: 'codex-disabled', isDisabled: true, isHealthy: true } }
            ],
            'openai-custom': [
                { uuid: 'openai-a', type: 'openai-custom', config: { uuid: 'openai-a', isDisabled: false, isHealthy: true } }
            ]
        }
    };
}

function writeUsageCache(instances) {
    fs.mkdirSync(path.join(tempDir, 'configs'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'configs', 'usage-cache.json'), JSON.stringify({
        timestamp: new Date().toISOString(),
        providers: {
            'openai-codex-oauth': {
                instances
            }
        }
    }, null, 2), 'utf8');
}

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient2api-codex-prewarm-'));
    process.chdir(tempDir);
    consoleSpies = ['log', 'warn', 'error'].map((method) => jest.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
    consoleSpies.forEach((spy) => spy.mockRestore());
    consoleSpies = [];
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('codex prewarm service', () => {
    test('defaults Codex prewarm to explicit opt-in', async () => {
        const { normalizePrewarmConfig } = await loadPrewarmService();

        expect(normalizePrewarmConfig({}).enabled).toBe(false);
        expect(normalizePrewarmConfig({ CODEX_PREWARM_ENABLED: 'true' }).enabled).toBe(true);
    });

    test('stop clears scheduling and waits for an active prewarm job to settle', async () => {
        writeUsageCache([
            { uuid: 'codex-a', success: true, usage: { summary: { plan: 'Pro' } } },
            { uuid: 'codex-b', success: true, usage: { summary: { plan: 'FREE' } } }
        ]);
        const { CodexPrewarmService, normalizePrewarmConfig } = await loadPrewarmService();
        let releasePrewarm;
        const prewarmBarrier = new Promise(resolve => {
            releasePrewarm = resolve;
        });
        const service = new CodexPrewarmService({
            config: normalizePrewarmConfig({ CODEX_PREWARM_ENABLED: true }),
            providerPoolManager: createPoolManager(),
            prewarmAccount: jest.fn(() => prewarmBarrier)
        });
        service.timer = setInterval(() => {}, 60_000);
        const runPromise = service.runDuePrewarm(new Date('2026-06-15T22:31:00.000Z'));
        await new Promise(resolve => setImmediate(resolve));

        let stopped = false;
        const stopPromise = service.stop().then(() => { stopped = true; });
        await new Promise(resolve => setImmediate(resolve));

        expect(service.timer).toBeNull();
        expect(stopped).toBe(false);

        releasePrewarm({ ok: true });
        await runPromise;
        await stopPromise;
        expect(stopped).toBe(true);
    });

    test('defaults to 06:30 and 11:30 Asia/Shanghai with two attempts per enabled Codex account', async () => {
        writeUsageCache([
            { uuid: 'codex-a', success: true, usage: { summary: { plan: 'Pro' } } },
            { uuid: 'codex-b', success: true, usage: { summary: { plan: 'Plus' } } }
        ]);
        const { CodexPrewarmService, normalizePrewarmConfig } = await loadPrewarmService();
        const prewarmAccount = jest.fn().mockResolvedValue({ ok: true });
        const service = new CodexPrewarmService({
            config: normalizePrewarmConfig({ CODEX_PREWARM_ENABLED: true }),
            providerPoolManager: createPoolManager(),
            prewarmAccount
        });

        await service.runDuePrewarm(new Date('2026-06-15T22:31:00.000Z')); // 2026-06-16 06:31 +08

        expect(prewarmAccount).toHaveBeenCalledTimes(4);
        expect(prewarmAccount.mock.calls.map(([job]) => [job.providerType, job.provider.uuid, job.attempt])).toEqual([
            ['openai-codex-oauth', 'codex-a', 1],
            ['openai-codex-oauth', 'codex-a', 2],
            ['openai-codex-oauth', 'codex-b', 1],
            ['openai-codex-oauth', 'codex-b', 2]
        ]);
    });

    test('deduplicates the same account schedule slot after restart', async () => {
        writeUsageCache([
            { uuid: 'codex-a', success: true, usage: { summary: { plan: 'Pro' } } },
            { uuid: 'codex-b', success: true, usage: { summary: { plan: 'Plus' } } }
        ]);
        const { CodexPrewarmService, normalizePrewarmConfig } = await loadPrewarmService();
        const firstPrewarm = jest.fn().mockResolvedValue({ ok: true });
        const config = normalizePrewarmConfig({ CODEX_PREWARM_ENABLED: true });

        const first = new CodexPrewarmService({
            config,
            providerPoolManager: createPoolManager(),
            prewarmAccount: firstPrewarm
        });
        await first.runDuePrewarm(new Date('2026-06-16T03:30:05.000Z')); // 2026-06-16 11:30 +08
        expect(firstPrewarm).toHaveBeenCalledTimes(4);

        const secondPrewarm = jest.fn().mockResolvedValue({ ok: true });
        const second = new CodexPrewarmService({
            config,
            providerPoolManager: createPoolManager(),
            prewarmAccount: secondPrewarm
        });
        await second.runDuePrewarm(new Date('2026-06-16T03:31:00.000Z')); // same local slot

        expect(secondPrewarm).not.toHaveBeenCalled();
    });

    test('builds Codex prewarm request without max_output_tokens unsupported by codex oauth', async () => {
        const { buildPrewarmRequest } = await loadPrewarmService();
        const requestBody = buildPrewarmRequest({ date: '2026-06-16', time: '06:30' }, 1);

        expect(requestBody).not.toHaveProperty('max_output_tokens');
        expect(requestBody).toMatchObject({
            input: [{ role: 'user', content: 'ok' }],
            instructions: 'Reply with ok.',
            metadata: {
                session_id: 'aiclient2api-codex-prewarm-2026-06-16-06:30',
                prewarm_attempt: 1
            },
            reasoning: { effort: 'low' },
            store: false
        });
    });

    test('prewarms only Codex accounts with Pro or Plus plan from usage cache', async () => {
        writeUsageCache([
            {
                uuid: 'codex-a',
                success: true,
                usage: { summary: { plan: 'Pro' } }
            },
            {
                uuid: 'codex-b',
                success: true,
                usage: { summary: { plan: 'FREE' } }
            }
        ]);
        const { CodexPrewarmService, normalizePrewarmConfig } = await loadPrewarmService();
        const prewarmAccount = jest.fn().mockResolvedValue({ ok: true });
        const service = new CodexPrewarmService({
            config: normalizePrewarmConfig({ CODEX_PREWARM_ENABLED: true }),
            providerPoolManager: createPoolManager(),
            prewarmAccount
        });

        await service.runDuePrewarm(new Date('2026-06-15T22:31:00.000Z'));

        expect(prewarmAccount).toHaveBeenCalledTimes(2);
        expect(prewarmAccount.mock.calls.map(([job]) => job.provider.uuid)).toEqual(['codex-a', 'codex-a']);
    });

    test('skips accounts whose live usage schema has only a weekly window', async () => {
        writeUsageCache([
            {
                uuid: 'codex-a',
                success: true,
                usage: {
                    summary: { plan: 'Pro' },
                    items: [{
                        id: 'primary_window',
                        windowKind: 'weekly',
                        durationSeconds: 604800,
                        percent: 3,
                        unit: 'percent'
                    }]
                }
            }
        ]);
        const { CodexPrewarmService, normalizePrewarmConfig } = await loadPrewarmService();
        const prewarmAccount = jest.fn().mockResolvedValue({ ok: true });
        const service = new CodexPrewarmService({
            config: normalizePrewarmConfig({ CODEX_PREWARM_ENABLED: true }),
            providerPoolManager: createPoolManager(),
            prewarmAccount
        });

        const result = await service.runDuePrewarm(new Date('2026-06-15T22:31:00.000Z'));

        expect(prewarmAccount).not.toHaveBeenCalled();
        expect(result.jobs).toBe(0);
    });
});
