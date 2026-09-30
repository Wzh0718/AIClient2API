import { GptDiagnosticsRunner, FIXED_MODELS } from '../src/plugins/request-audit/gpt-diagnostics.js';
import { MODELTRACE_BANK_VERSION, parseModelTraceNumbers, modelTraceChallenges } from '../src/plugins/request-audit/modeltrace.js';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const diagnosticsPage = readFileSync(new URL('../static/gpt-diagnostics.html', import.meta.url), 'utf8');

jest.mock('../src/plugins/request-audit/modeltrace.js', () => ({
  ...jest.requireActual('../src/plugins/request-audit/modeltrace.js'),
  loadModelTraceBank: jest.fn(async () => ({})),
  analyzeModelTraceOutputs: jest.fn(() => ({ valid: true, prediction: 'gpt-5.6-luna', predictionName: 'gpt-5.6-luna', closedSetProbability: 0.9, usedOutputs: 3 }))
}));

async function waitForRun(runner, runId) {
  for (let index = 0; index < 500; index += 1) {
    const run = runner.get(runId);
    if (!['queued', 'running'].includes(run?.status) && !runner.active) return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('run did not settle');
}

describe('GPT diagnostics safety and fingerprint inputs', () => {
  test('advertises the fixed-model fingerprint budget and rejects removed tests without creating runs', async () => {
    const runner = new GptDiagnosticsRunner();
    expect(runner.capabilities()).toMatchObject({ testVersion: 'gpt-diagnostics-v4', maxTargets: 10,
      models: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'],
      defaultTests: ['modeltrace'], perCredential: { requestCount: 9, maxOutputTokens: 73728 } });
    expect(runner.estimate({ targets: [{}, {}] })).toEqual({ credentialCount: 2, targetCount: 6, requestCount: 18, maxOutputTokens: 147456 });
    await expect(runner.create({ targets: [{ providerUuid: 'p' }], tests: ['knowledge'] }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('knowledge') });
    expect(runner.list()).toEqual([]);
  });

  test('extracts the longest valid numeric run and ships three fixed-version challenges', () => {
    expect(parseModelTraceNumbers('note 999 words 1, 2, 355, 0, 44')).toEqual([1, 2, 355, 44]);
    expect(parseModelTraceNumbers('12 34中文56 78')).toEqual([12, 34]);
    expect(MODELTRACE_BANK_VERSION).toBe('df3a0f9d3e054c0dc02d6d586686db8daf8fa7c8');
    const challenges = modelTraceChallenges();
    expect(challenges.map(item => item.expectedCount)).toEqual([294, 311, 329]);
    expect(challenges.every(item => item.prompt.includes('禁止使用工具'))).toBe(true);
  });

  test('page removes legacy preview, scoring and knowledge surfaces', () => {
    expect(diagnosticsPage).not.toMatch(/pelican|鹈鹕|iframe|\/score|知识时间/);
    expect(diagnosticsPage).toContain('检测历史');
    expect(diagnosticsPage).toContain('固定模型组');
  });

  test('expands each credential into the fixed model set and matches the advertised budget', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-diag-v3-'));
    const generateContent = jest.fn(async () => ({ output_text: '{}' }));
    const runner = await new GptDiagnosticsRunner({ dir,
      providerManager: { globalConfig: {}, findProviderByUuid: () => ({ MODEL_PROVIDER: 'openai-codex-oauth', customName: 'Test credential' }) },
      adapterFactory: () => ({ generateContent })
    }).init();
    try {
      const created = await runner.create({ targets: [{ providerUuid: 'p' }, { providerUuid: 'p' }] });
      expect(created.targets.map(target => target.model)).toEqual([...FIXED_MODELS]);
      expect(created.estimate).toEqual({ credentialCount: 1, targetCount: 3, requestCount: 9, maxOutputTokens: 73728 });
      const run = await waitForRun(runner, created.runId);
      expect(run.testVersion).toBe('gpt-diagnostics-v4');
      expect(run.status).toBe('completed');
      expect(generateContent).toHaveBeenCalledTimes(9);
      expect(generateContent.mock.calls.reduce((sum, [, body]) => sum + body.max_output_tokens, 0)).toBe(73728);
      expect(run.results[0]).toMatchObject({ providerName: 'Test credential', providerUuid: 'p' });
      expect(run.results.map(result => result.model)).toEqual([...FIXED_MODELS]);
      expect(run.results[0].probes.map(probe => probe.test)).toEqual(['modeltrace', 'modeltrace', 'modeltrace']);
    } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
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
    } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });

  test('rejects malformed targets and more than ten credentials before queueing', async () => {
    const runner = new GptDiagnosticsRunner();
    for (const targets of [[], [{ providerUuid: '  ' }], [{ model: 'gpt-5.5' }], Array(11).fill({ providerUuid: 'p' })]) {
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
      const created = await runner.create({ targets: [{ providerUuid: 'p' }] });
      for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(release).toBeDefined();
      await runner.cancel(created.runId);
      release({ choices: [{ message: { content: '{}' } }] });
      const run = await waitForRun(runner, created.runId);
      expect(run.status).toBe('cancelled');
      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(generateContent.mock.calls[0][1].max_tokens).toBe(8192);
    } finally { release?.({}); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });

  test('failure records retain credential name and channel without fallback', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-diag-fail-'));
    const generateContent = jest.fn(async () => { throw new Error('upstream unavailable'); });
    const runner = await new GptDiagnosticsRunner({ dir,
      providerManager: { findProviderByUuid: () => ({ MODEL_PROVIDER: 'openai-custom', customName: 'Failing account' }) },
      adapterFactory: () => ({ generateContent })
    }).init();
    try {
      const created = await runner.create({ targets: [{ providerUuid: 'p' }] });
      const run = await waitForRun(runner, created.runId);
      expect(run.results).toHaveLength(FIXED_MODELS.length);
      for (const result of run.results) {
        expect(result).toMatchObject({ status: 'failed', providerName: 'Failing account', providerType: 'openai-custom', error: 'upstream unavailable' });
      }
      expect(generateContent).toHaveBeenCalledTimes(FIXED_MODELS.length);
    } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });

  test('extracts assistant text from the Codex/Responses SSE completed envelope', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-diag-envelope-'));
    const generateContent = jest.fn(async () => ({
      type: 'response.completed',
      response: {
        id: 'resp_test', status: 'completed', object: 'response', model: 'gpt-5.6-luna',
        output: [{ type: 'message', role: 'assistant', content: [
          { type: 'output_text', text: '17 42 355 128 301 84 256 199 60 333 12 288 155 47 220 96 312 23 178 140 65 267 8 344 118 52 305 76 231 161 35 296 103 19 249 132 58 214 87 340 26 173 306 70 226 145 39 281 111 4 337 167 93 253 30 198 122 7 314 151 84 240 63 189 106 275 15 329 137 51 221 98 308 44 182 116 263 21 347 159 74 291 129 55 235 12 203 66 318 101 36 258 143 82 310 27 170 95 246 60 335 123 48 284 156 33 217 90 301 108 19 264 139 77 326 45 195 113 250 68 313 148 6 229 165 88 298 130 57 210 100 24 342 175 79 320 152 41 286 117 10 255 183 94 316 62 200 134 29 271 160 71 243 105 38 307 126 16 233 168 85 294 146 53 219 97 3 339 181 110 259 121 46 288 154 73 224 143 67 312 91 31 202 165 59 331 128 49 279 150 86 245 107 22 296 172 64 323 141 56 285 118 13 257 190 80 315 102 43 268 186 69 330 153 37 218 130 75 303 169 92 241 111 25 346 178 95 292 158 66 209 136 54 287 165 83 260 124 32 299 171 61 316 145 99 226 188 78 328 159 40 281 120 9 254 176 87 247 138 58 304 166 72 239 129 18 293 157 63 320 146 51 282 133 47 275 114 28 266 180 89 252 147 96 310 161 42 230 191 76 324 148 60 289 127 11 240 179 84 301 162 50 227 155 65 286 137 55 298 168 90 244 149 98 236 192 81 333 156 67 309 170 59 291 140 39 273 126 20 262 187 93 318 163 44 231 174 82 305 152 64 283 141 48 277 131 17 259 183 94 322 167 68 311 158 49 284 135 45 280 121 14 268 193 88 336 164 77 313 172 62 295 154 57 288 147 96 245 138 56 303 175 85 319 165 70 308 159 61 297 150 52 286 142 46 279 132 36 271 184 99 335 173 78 314 166 69 307 160 59 299 151 53 290 143 47 282 144 58 285 139 43 278 134 54 276 125 34 269 185 89 334 177 86 321 171 74 304 153 66 292 146 50 275 136 40 267 189 92 338 179 91 325 169 79 302 157 71 294 148 62 287 156 63 289 162 67 293 171 80 300 168 76 306 175 87 315 183 97 327 190 100 339 186 101 341 194 102 342 195 103 343 196 104 344 197 105 345 198 106 346 199 107 347 200 108 348 201 109 349 202 110 350 203 111 351 204 112 352 205 113 353 206 114 354 207 115 355 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16' }
        ] }],
        usage: { output_tokens: 120, output_tokens_details: { reasoning_tokens: 42 } }
      }
    }));
    try {
      const runner = await new GptDiagnosticsRunner({ dir,
        providerManager: { globalConfig: {}, findProviderByUuid: () => ({ MODEL_PROVIDER: 'openai-codex-oauth' }) },
        adapterFactory: () => ({ generateContent })
      }).init();
      const created = await runner.create({ targets: [{ providerUuid: 'p' }] });
      const run = await waitForRun(runner, created.runId);
      expect(run.results[0].status).toBe('completed');
      const probe = run.results[0].probes[0];
      expect(probe).toMatchObject({ responseModel: 'gpt-5.6-luna', reasoningTokens: 42, emptyOutput: false });
      // 修复前 extractText 会把终结事件名当成回答文本（长度为 0 的数字序列）。
      expect(probe.text).not.toBe('response.completed');
      expect((probe.text.match(/\d+/g) || []).length).toBeGreaterThan(80);
      expect(run.results[0].modelTrace.valid).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });

  test('runs a fixed credential without fallback and links every probe to a request record', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-diag-test-'));
    const recordProbe = jest.fn(async () => {});
    const manager = {
      globalConfig: {},
      providerStatus: { 'openai-codex-oauth': [{ uuid: 'provider-a' }] },
      findProviderByUuid: jest.fn(() => ({ uuid: 'provider-a', MODEL_PROVIDER: 'openai-codex-oauth' }))
    };
    const generateContent = jest.fn(async () => ({ model: 'gpt-5.5', output_text: '{}' }));
    try {
      const runner = await new GptDiagnosticsRunner({
        dir, providerManager: manager, adapterFactory: () => ({ generateContent }), recordProbe
      }).init();
      const created = await runner.create({ targets: [{ providerUuid: 'provider-a' }] });
      const run = await waitForRun(runner, created.runId);
      expect(run.status).toBe('completed');
      expect(generateContent).toHaveBeenCalledTimes(9);
      expect(recordProbe).toHaveBeenCalledTimes(9);
      expect(recordProbe).toHaveBeenCalledWith(expect.objectContaining({ requestId: expect.stringMatching(/^diag_/), providerUuid: 'provider-a' }));
      expect(run.results[0].modelTrace.valid).toBe(true);
      expect(run.results[0]).not.toHaveProperty('knowledge');
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
