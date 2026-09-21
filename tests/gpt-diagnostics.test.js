import { GptDiagnosticsRunner, sanitizePelicanSvg } from '../src/plugins/request-audit/gpt-diagnostics.js';
import { parseModelTraceNumbers, modelTraceChallenges } from '../src/plugins/request-audit/modeltrace.js';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const diagnosticsPage = readFileSync(new URL('../static/gpt-diagnostics.html', import.meta.url), 'utf8');

describe('GPT diagnostics safety and fingerprint inputs', () => {
  test('accepts self-contained SVG and rejects active or external content', () => {
    expect(sanitizePelicanSvg('<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1"/></svg>').valid).toBe(true);
    expect(sanitizePelicanSvg('<svg><script>alert(1)</script></svg>')).toMatchObject({ valid: false, reason: 'unsafe_element' });
    expect(sanitizePelicanSvg('<svg><image href="https://example.com/a.png"/></svg>')).toMatchObject({ valid: false, reason: 'unsafe_reference' });
  });

  test('extracts the longest valid numeric run and ships three fixed-version challenges', () => {
    expect(parseModelTraceNumbers('note 999 words 1, 2, 355, 0, 44')).toEqual([1, 2, 355, 44]);
    const challenges = modelTraceChallenges();
    expect(challenges.map(item => item.expectedCount)).toEqual([294, 311, 329]);
    expect(challenges.every(item => item.prompt.includes('禁止使用工具'))).toBe(true);
  });

  test('diagnostics page exposes budget, cancellation, sandboxed SVG preview and manual scoring', () => {
    expect(diagnosticsPage).toContain('5 个真实请求');
    expect(diagnosticsPage).toContain('data-cancel');
    expect(diagnosticsPage).toContain('<iframe sandbox');
    expect(diagnosticsPage).toContain('/score');
    expect(diagnosticsPage).toContain('闭集概率');
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
