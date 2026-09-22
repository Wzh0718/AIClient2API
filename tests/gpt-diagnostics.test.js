import { GptDiagnosticsRunner } from '../src/plugins/request-audit/gpt-diagnostics.js';
import { parseModelTraceNumbers, modelTraceChallenges } from '../src/plugins/request-audit/modeltrace.js';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const diagnosticsPage = readFileSync(new URL('../static/gpt-diagnostics.html', import.meta.url), 'utf8');

jest.mock('../src/plugins/request-audit/modeltrace.js', () => ({
  ...jest.requireActual('../src/plugins/request-audit/modeltrace.js'),
  loadModelTraceBank: jest.fn(async () => ({}))
}));

describe('GPT diagnostics safety and fingerprint inputs', () => {
  test('advertises the actual request limits and rejects removed tests without creating runs', async () => {
    const runner = new GptDiagnosticsRunner();
    expect(runner.capabilities()).toMatchObject({ testVersion: 'gpt-diagnostics-v2', maxTargets: 10,
      defaultTests: ['knowledge', 'modeltrace'], perTarget: { requestCount: 4, maxOutputTokens: 26624 } });
    expect(runner.estimate({ targets: [{}, {}] })).toEqual({ targetCount: 2, requestCount: 8, maxOutputTokens: 53248 });
    expect(runner.estimate({ targets: [{}], tests: ['knowledge'] }).maxOutputTokens).toBe(2048);
    await expect(runner.create({ targets: [{ providerUuid: 'p', model: 'm' }], tests: ['knowledge', 'pelican_svg'] }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('pelican_svg') });
    expect(runner.list()).toEqual([]);
  });

  test('extracts the longest valid numeric run and ships three fixed-version challenges', () => {
    expect(parseModelTraceNumbers('note 999 words 1, 2, 355, 0, 44')).toEqual([1, 2, 355, 44]);
    const challenges = modelTraceChallenges();
    expect(challenges.map(item => item.expectedCount)).toEqual([294, 311, 329]);
    expect(challenges.every(item => item.prompt.includes('禁止使用工具'))).toBe(true);
  });

  test('page removes legacy preview and scoring surfaces', () => {
    expect(diagnosticsPage).not.toMatch(/pelican|鹈鹕|iframe|\/score/);
    expect(diagnosticsPage).toContain('检测历史');
  });

  test('default v2 requests match the budget and snapshot credential identity', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-diag-v2-'));
    const generateContent = jest.fn(async () => ({ output_text: '{}' }));
    const runner = await new GptDiagnosticsRunner({ dir,
      providerManager: { globalConfig: {}, findProviderByUuid: () => ({ MODEL_PROVIDER: 'openai-codex-oauth', customName: 'Test credential' }) },
      adapterFactory: () => ({ generateContent })
    }).init();
    try {
      const run = await runner.create({ targets: [{ providerUuid: 'p', model: 'gpt-test' }] });
      while (runner.active || run.status === 'queued') await new Promise(resolve => setTimeout(resolve, 5));
      expect(run.testVersion).toBe('gpt-diagnostics-v2');
      expect(generateContent).toHaveBeenCalledTimes(run.estimate.requestCount);
      expect(generateContent.mock.calls.reduce((sum, [, body]) => sum + body.max_output_tokens, 0)).toBe(run.estimate.maxOutputTokens);
      expect(run.results[0]).toMatchObject({ providerName: 'Test credential', providerUuid: 'p' });
      expect(run.results[0]).not.toHaveProperty('pelican');
      expect(run.results[0].probes.map(p => p.test)).toEqual(['knowledge', 'modeltrace', 'modeltrace', 'modeltrace']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('reads completed legacy records without rewriting or dropping historical fields', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-diag-legacy-'));
    const file = path.join(dir, 'run-legacy.json');
    const legacy = JSON.stringify({ runId: 'legacy', createdAt: new Date().toISOString(), status: 'completed',
      testVersion: 'gpt-diagnostics-v1', results: [{ pelican: { valid: true, manualScore: 3 } }] });
    try {
      await writeFile(file, legacy);
      const runner = await new GptDiagnosticsRunner({ dir }).init();
      expect(runner.get('legacy').results[0].pelican.manualScore).toBe(3);
      expect(await readFile(file, 'utf8')).toBe(legacy);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('rejects empty models and more than ten targets before queueing', async () => {
    const runner = new GptDiagnosticsRunner();
    for (const targets of [[], [{ providerUuid: 'p', model: '  ' }], Array(11).fill({ providerUuid: 'p', model: 'gpt-test' })]) {
      await expect(runner.create({ targets })).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(runner.list()).toEqual([]);
  });

  test('cancel allows an in-flight request to finish and starts no subsequent request', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-diag-cancel-'));
    let release;
    const generateContent = jest.fn(() => new Promise(resolve => { release = resolve; }));
    const runner = await new GptDiagnosticsRunner({ dir,
      providerManager: { findProviderByUuid: () => ({ MODEL_PROVIDER: 'openai-custom' }) },
      adapterFactory: () => ({ generateContent })
    }).init();
    try {
      const run = await runner.create({ targets: [{ providerUuid: 'p', model: 'gpt-test' }] });
      for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(release).toBeDefined();
      await runner.cancel(run.runId);
      release({ choices: [{ message: { content: '{}' } }] });
      while (runner.active) await new Promise(resolve => setTimeout(resolve, 5));
      expect(run.status).toBe('cancelled');
      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(generateContent.mock.calls[0][1].max_tokens).toBe(2048);
    } finally { release?.({}); await rm(dir, { recursive: true, force: true }); }
  });

  test('failure records retain credential name and channel without fallback', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-diag-fail-'));
    const generateContent = jest.fn(async () => { throw new Error('upstream unavailable'); });
    const runner = await new GptDiagnosticsRunner({ dir,
      providerManager: { findProviderByUuid: () => ({ MODEL_PROVIDER: 'openai-custom', customName: 'Failing account' }) },
      adapterFactory: () => ({ generateContent })
    }).init();
    try {
      const run = await runner.create({ targets: [{ providerUuid: 'p', model: 'gpt-test' }], tests: ['knowledge'] });
      while (runner.active || run.status === 'queued') await new Promise(resolve => setTimeout(resolve, 5));
      expect(run.results[0]).toMatchObject({ status: 'failed', providerName: 'Failing account', providerType: 'openai-custom', error: 'upstream unavailable' });
      expect(generateContent).toHaveBeenCalledTimes(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('extracts assistant text from the Codex/Responses SSE completed envelope', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-diag-envelope-'));
    const generateContent = jest.fn(async () => ({
      type: 'response.completed',
      response: {
        id: 'resp_test', status: 'completed', object: 'response', model: 'gpt-5.6-luna',
        output: [{ type: 'message', role: 'assistant', content: [
          { type: 'output_text', text: '{"claimed_knowledge_cutoff":"2025-06","answers":{"gpt_4_1_announcement":"2025-04-14","python_3_13_0_release":"2024-10-07"}}' }
        ] }],
        usage: { output_tokens: 120, output_tokens_details: { reasoning_tokens: 42 } }
      }
    }));
    try {
      const runner = await new GptDiagnosticsRunner({ dir,
        providerManager: { globalConfig: {}, findProviderByUuid: () => ({ MODEL_PROVIDER: 'openai-codex-oauth' }) },
        adapterFactory: () => ({ generateContent })
      }).init();
      const created = await runner.create({ targets: [{ providerUuid: 'p', model: 'gpt-test' }], tests: ['knowledge'] });
      while (runner.active || runner.get(created.runId)?.status === 'queued') await new Promise(resolve => setTimeout(resolve, 5));
      const run = runner.get(created.runId);
      expect(run.results[0].status).toBe('completed');
      expect(run.results[0].knowledge).toMatchObject({ correct: 2, total: 2, claimedKnowledgeCutoff: '2025-06' });
      expect(run.results[0].probes[0]).toMatchObject({ responseModel: 'gpt-5.6-luna', reasoningTokens: 42, emptyOutput: false });
      expect(run.results[0].passiveSignals).not.toContainEqual(expect.objectContaining({ code: 'empty_output' }));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('runs a fixed credential without fallback and links every probe to a request record', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-diag-test-'));
    const recordProbe = jest.fn(async () => {});
    const manager = {
      globalConfig: {},
      providerStatus: { 'openai-codex-oauth': [{ uuid: 'provider-a' }] },
      findProviderByUuid: jest.fn(() => ({ uuid: 'provider-a', MODEL_PROVIDER: 'openai-codex-oauth' }))
    };
    const generateContent = jest.fn(async () => ({
      model: 'gpt-5.5',
      output_text: '{"claimed_knowledge_cutoff":"2024-06","answers":{"gpt_4_1_announcement":"2025-04-14","python_3_13_0_release":"2024-10-07"}}'
    }));
    try {
      const runner = await new GptDiagnosticsRunner({
        dir, providerManager: manager, adapterFactory: () => ({ generateContent }), recordProbe
      }).init();
      const created = await runner.create({ targets: [{ providerUuid: 'provider-a', model: 'gpt-5.5' }], tests: ['knowledge'] });
      for (let index = 0; index < 100 && (!['completed', 'partial', 'failed'].includes(runner.get(created.runId)?.status) || runner.active); index += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const run = runner.get(created.runId);
      expect(run.status).toBe('completed');
      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(recordProbe).toHaveBeenCalledWith(expect.objectContaining({ requestId: expect.stringMatching(/^diag_/), providerUuid: 'provider-a' }));
      expect(run.results[0].knowledge).toMatchObject({ correct: 2, total: 2, selfReportedCutoffOnly: true });
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
