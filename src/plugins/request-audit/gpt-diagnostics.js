import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { analyzeModelTraceOutputs, loadModelTraceBank, modelTraceChallenges, MODELTRACE_BANK_VERSION } from './modeltrace.js';
import { getRequestAttempts } from '../../utils/request-attempts.js';

const TEST_VERSION = 'gpt-diagnostics-v1';
const DEFAULT_TESTS = ['pelican_svg', 'knowledge', 'modeltrace'];

function safeId(value) { return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120); }
function extractText(value, seen = new Set()) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    if (typeof value.output_text === 'string') return value.output_text;
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return value.content.map(item => extractText(item, seen)).join('');
    if (Array.isArray(value.output)) return value.output.map(item => extractText(item, seen)).join('');
    if (Array.isArray(value.choices)) return value.choices.map(item => extractText(item?.message || item?.delta || item, seen)).join('');
    for (const item of Object.values(value)) {
        const text = extractText(item, seen);
        if (text) return text;
    }
    return '';
}

function responseModel(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    if (typeof value.model === 'string' && value.model.trim()) return value.model.trim();
    for (const item of Object.values(value)) {
        const model = responseModel(item, seen);
        if (model) return model;
    }
    return null;
}

function reasoningTokens(value) {
    const usage = value?.usage || value?.response?.usage || {};
    return Number(usage.output_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? usage.reasoningTokens ?? 0) || 0;
}

function scoreKnowledgeOutput(text) {
    const expected = {
        gpt_4_1_announcement: '2025-04-14',
        python_3_13_0_release: '2024-10-07'
    };
    let parsed = null;
    try { parsed = JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] || ''); } catch {}
    const answers = parsed?.answers && typeof parsed.answers === 'object' ? parsed.answers : {};
    const checks = Object.entries(expected).map(([id, date]) => ({ id, expected: date, answer: answers[id] ?? null, correct: answers[id] === date }));
    return {
        claimedKnowledgeCutoff: parsed?.claimed_knowledge_cutoff ?? null,
        checks,
        correct: checks.filter(item => item.correct).length,
        total: checks.length,
        references: {
            gpt_4_1_announcement: 'https://openai.com/index/gpt-4-1/',
            python_3_13_0_release: 'https://www.python.org/downloads/release/python-3130/'
        }
    };
}

export function sanitizePelicanSvg(text) {
    const match = String(text || '').match(/<svg\b[\s\S]*?<\/svg>/i);
    if (!match) return { valid: false, reason: 'missing_svg', svg: null };
    const svg = match[0];
    if (Buffer.byteLength(svg, 'utf8') > 512 * 1024) return { valid: false, reason: 'svg_too_large', svg: null };
    if (/<(?:script|foreignObject|iframe|object|embed)\b/i.test(svg)) return { valid: false, reason: 'unsafe_element', svg: null };
    if (/\son[a-z]+\s*=|javascript:|(?:href|src)\s*=\s*["'](?:https?:|\/\/|data:)/i.test(svg)) return { valid: false, reason: 'unsafe_reference', svg: null };
    return { valid: true, reason: null, svg };
}

function buildRequest(providerType, model, prompt, maxOutputTokens = 4096) {
    if (String(providerType).includes('codex') || String(providerType).includes('responses')) {
        return {
            model,
            stream: false,
            store: false,
            max_output_tokens: maxOutputTokens,
            input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }]
        };
    }
    return { model, stream: false, max_tokens: maxOutputTokens, messages: [{ role: 'user', content: prompt }] };
}

function findProviderType(manager, uuid, providerConfig) {
    if (providerConfig?.MODEL_PROVIDER || providerConfig?.providerType || providerConfig?.type) {
        return providerConfig.MODEL_PROVIDER || providerConfig.providerType || providerConfig.type;
    }
    for (const [type, entries] of Object.entries(manager?.providerStatus || {})) {
        if (entries.some(item => item.uuid === uuid)) return type;
    }
    return null;
}

class DiagnosticStore {
    constructor({ dir = path.join(process.cwd(), 'configs', 'gpt-diagnostics'), retentionDays = 35 } = {}) {
        this.dir = dir;
        this.retentionDays = Math.max(1, Number(retentionDays) || 35);
        this.runs = new Map();
    }
    async init() {
        await fs.mkdir(this.dir, { recursive: true });
        for (const name of await fs.readdir(this.dir).catch(() => [])) {
            if (!/^run-.*\.json$/.test(name)) continue;
            try {
                const run = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8'));
                if (['queued', 'running'].includes(run.status)) {
                    run.status = 'interrupted'; run.completedAt = new Date().toISOString();
                    await this.save(run);
                }
                this.runs.set(run.runId, run);
            } catch {}
        }
        await this.cleanup();
        return this;
    }
    async save(run) {
        this.runs.set(run.runId, run);
        const target = path.join(this.dir, `run-${safeId(run.runId)}.json`);
        const temp = `${target}.${process.pid}.tmp`;
        await fs.writeFile(temp, JSON.stringify(run, null, 2), { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temp, target);
    }
    list() { return [...this.runs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }
    get(id) { return this.runs.get(id) || null; }
    async cleanup(now = new Date()) {
        const cutoff = now.getTime() - this.retentionDays * 86400_000;
        for (const [id, run] of this.runs) {
            if (Date.parse(run.createdAt) >= cutoff) continue;
            await fs.rm(path.join(this.dir, `run-${safeId(id)}.json`), { force: true });
            if (run.artifactDir) await fs.rm(run.artifactDir, { recursive: true, force: true });
            this.runs.delete(id);
        }
    }
}

export class GptDiagnosticsRunner {
    constructor({ dir, retentionDays = 35, providerManager = null, adapterFactory = null, recordProbe = null } = {}) {
        this.store = new DiagnosticStore({ dir, retentionDays });
        this.providerManager = providerManager;
        this.adapterFactory = adapterFactory;
        this.recordProbe = recordProbe;
        this.queue = [];
        this.active = null;
        this.cancelled = new Set();
    }
    async init() { await this.store.init(); return this; }
    estimate({ targets = [], tests = DEFAULT_TESTS } = {}) {
        const perTarget = tests.reduce((sum, test) => sum + (test === 'modeltrace' ? 3 : 1), 0);
        return { targetCount: targets.length, requestCount: targets.length * perTarget, maxOutputTokens: targets.length * (tests.includes('modeltrace') ? 18_000 : 0) + targets.length * (tests.length - (tests.includes('modeltrace') ? 1 : 0)) * 4096 };
    }
    async create(input = {}) {
        const targets = Array.isArray(input.targets) ? input.targets.filter(item => item?.providerUuid && item?.model) : [];
        if (!targets.length || targets.length > 10) throw Object.assign(new Error('targets must contain 1-10 providerUuid/model pairs'), { statusCode: 400 });
        const tests = Array.isArray(input.tests) ? input.tests.filter(test => DEFAULT_TESTS.includes(test)) : DEFAULT_TESTS;
        if (!tests.length) throw Object.assign(new Error('No supported diagnostic tests selected'), { statusCode: 400 });
        const run = {
            runId: crypto.randomUUID(), testVersion: TEST_VERSION, status: 'queued', createdAt: new Date().toISOString(),
            targets: targets.map(item => ({ providerUuid: item.providerUuid, model: item.model })), tests,
            estimate: this.estimate({ targets, tests }), results: [], bankVersion: tests.includes('modeltrace') ? MODELTRACE_BANK_VERSION : null
        };
        run.artifactDir = path.join(this.store.dir, 'artifacts', safeId(run.runId));
        await this.store.save(run);
        this.queue.push(run.runId);
        void this.pump();
        return run;
    }
    list() { return this.store.list(); }
    get(id) { return this.store.get(id); }
    async cancel(id) {
        const run = this.store.get(id);
        if (!run) return null;
        this.cancelled.add(id);
        if (run.status === 'queued') { run.status = 'cancelled'; run.completedAt = new Date().toISOString(); await this.store.save(run); }
        return run;
    }
    async score(id, { providerUuid, model, score } = {}) {
        const run = this.store.get(id);
        if (!run) return null;
        const target = run.results.find(item => item.providerUuid === providerUuid && item.model === model);
        const normalized = Number(score);
        if (!target?.pelican || !Number.isFinite(normalized) || normalized < 0 || normalized > 5) {
            throw Object.assign(new Error('Pelican score must be between 0 and 5 for an existing target'), { statusCode: 400 });
        }
        target.pelican.manualScore = normalized;
        await this.store.save(run);
        return run;
    }
    async pump() {
        if (this.active) return;
        const id = this.queue.shift();
        if (!id) return;
        const run = this.store.get(id);
        if (!run || run.status !== 'queued') { void this.pump(); return; }
        this.active = id;
        try {
            await this.execute(run);
        } catch (error) {
            run.status = 'failed'; run.error = error.message; run.completedAt = new Date().toISOString();
            await this.store.save(run).catch(() => {});
        } finally { this.active = null; void this.pump(); }
    }
    async execute(run) {
        run.status = 'running'; run.startedAt = new Date().toISOString(); await this.store.save(run);
        await fs.mkdir(run.artifactDir, { recursive: true });
        let bank = null;
        if (run.tests.includes('modeltrace')) {
            try {
                bank = await loadModelTraceBank({ cachePath: path.join(this.store.dir, `modeltrace-bank-${MODELTRACE_BANK_VERSION}.json`) });
            } catch (error) {
                run.bankError = error.message;
            }
        }
        for (const target of run.targets) {
            if (this.cancelled.has(run.runId)) break;
            const result = await this.executeTarget(run, target, bank).catch(error => ({ ...target, status: 'failed', error: error.message }));
            run.results.push(result); await this.store.save(run);
        }
        run.status = this.cancelled.has(run.runId)
            ? 'cancelled'
            : (run.results.some(item => ['failed', 'partial'].includes(item.status)) ? 'partial' : 'completed');
        run.completedAt = new Date().toISOString(); await this.store.save(run);
    }
    async executeTarget(run, target, bank) {
        const manager = this.providerManager || (await import('../../services/service-manager.js')).getProviderPoolManager();
        const providerConfig = manager?.findProviderByUuid?.(target.providerUuid);
        if (!providerConfig) throw new Error('Credential not found');
        const providerType = findProviderType(manager, target.providerUuid, providerConfig);
        if (!providerType || !/openai|codex/i.test(providerType)) throw new Error('Only GPT/OpenAI credentials are supported');
        const adapterFactory = this.adapterFactory || (await import('../../providers/adapter.js')).getServiceAdapter;
        const adapter = adapterFactory({ ...manager.globalConfig, ...providerConfig, MODEL_PROVIDER: providerType });
        const probes = [];
        const call = async (test, prompt, maxTokens) => {
            if (this.cancelled.has(run.runId)) throw new Error('cancelled');
            const startedAt = new Date().toISOString();
            const requestId = `diag_${crypto.randomUUID()}`;
            const requestBody = buildRequest(providerType, target.model, prompt, maxTokens);
            Object.defineProperty(requestBody, '_monitorRequestId', { value: requestId, writable: true, configurable: true, enumerable: false });
            let timeout;
            let response;
            try {
                response = await Promise.race([
                    adapter.generateContent(target.model, requestBody),
                    new Promise((_, reject) => {
                        timeout = setTimeout(() => reject(new Error(`Diagnostic ${test} timed out after 180 seconds`)), 180_000);
                        timeout.unref?.();
                    })
                ]).finally(() => clearTimeout(timeout));
            } catch (error) {
                const completedAt = new Date().toISOString();
                const probe = { requestId, test, startedAt, completedAt, failed: true, error: error.code || error.name || 'Error' };
                probes.push(probe);
                await this.recordProbe?.({
                    requestId, timestamp: completedAt, path: '/internal/gpt-diagnostics', normalizedPath: '/internal/gpt-diagnostics',
                    fromProvider: 'gpt-diagnostics', toProvider: providerType, providerUuid: target.providerUuid,
                    providerName: providerConfig.customName || null, model: target.model,
                    originalRequestBody: { model: target.model }, processedRequestBody: requestBody,
                    requestAttempts: getRequestAttempts(requestBody),
                    response: { httpStatus: Number(error?.response?.status || 500), completed: false, durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)), errorCode: error.code || error.name },
                    errorClass: error.code || error.name || 'diagnostic_failure', usage: {}
                });
                throw error;
            }
            const text = extractText(response);
            const model = responseModel(response);
            const reasoning = reasoningTokens(response);
            const probe = {
                requestId, test, startedAt, completedAt: new Date().toISOString(), responseModel: model,
                emptyOutput: !text.trim(), reasoningTokens: reasoning,
                reasoningTruncationHeuristic: reasoning > 0 && (reasoning + 2) % 518 === 0,
                modelMismatch: Boolean(model && model !== target.model), text
            };
            probes.push(probe);
            await this.recordProbe?.({
                requestId,
                timestamp: probe.completedAt,
                path: '/internal/gpt-diagnostics',
                normalizedPath: '/internal/gpt-diagnostics',
                fromProvider: 'gpt-diagnostics',
                toProvider: providerType,
                providerUuid: target.providerUuid,
                providerName: providerConfig.customName || null,
                model: target.model,
                originalRequestBody: { model: target.model },
                processedRequestBody: requestBody,
                requestAttempts: getRequestAttempts(requestBody),
                response: { httpStatus: 200, completed: true, durationMs: Math.max(0, Date.parse(probe.completedAt) - Date.parse(startedAt)) },
                usage: response?.usage || response?.response?.usage || {}
            });
            return { response, text, probe };
        };
        const output = { ...target, providerType, status: 'completed', probes, passiveSignals: [] };
        if (run.tests.includes('pelican_svg')) {
            const value = await call('pelican_svg', 'Create a single self-contained SVG illustration of a pelican riding a bicycle. Return only SVG. Include visible wheels, pedals, pelican body, beak and wings. Do not use scripts, external URLs, data URLs or foreignObject.', 8192);
            const sanitized = sanitizePelicanSvg(value.text);
            output.pelican = { valid: sanitized.valid, reason: sanitized.reason, manualScore: null };
            if (sanitized.valid) {
                const file = path.join(run.artifactDir, `${safeId(target.providerUuid)}-${safeId(target.model)}-pelican.svg`);
                await fs.writeFile(file, sanitized.svg, { encoding: 'utf8', mode: 0o600 });
                output.pelican.artifact = file;
                output.pelican.previewSvg = sanitized.svg;
            }
        }
        if (run.tests.includes('knowledge')) {
            const value = await call('knowledge', 'Return compact JSON with fields claimed_knowledge_cutoff and answers. The answers object must contain gpt_4_1_announcement and python_3_13_0_release as YYYY-MM-DD dates. Answer without browsing and use null if unsure. Do not claim the cutoff proves model identity.', 2048);
            output.knowledge = { raw: value.text.slice(0, 32_000), selfReportedCutoffOnly: true, ...scoreKnowledgeOutput(value.text) };
        }
        if (run.tests.includes('modeltrace') && bank) {
            const values = [];
            for (const challenge of modelTraceChallenges()) {
                const value = await call('modeltrace', challenge.prompt, 8192);
                values.push({ text: value.text, expectedCount: challenge.expectedCount });
            }
            output.modelTrace = analyzeModelTraceOutputs(values, bank);
        } else if (run.tests.includes('modeltrace')) {
            output.modelTrace = { valid: false, reason: 'candidate_bank_unavailable', bankVersion: MODELTRACE_BANK_VERSION };
            output.status = 'partial';
        }
        for (const probe of probes) {
            if (probe.emptyOutput) output.passiveSignals.push({ code: 'empty_output', test: probe.test });
            if (probe.modelMismatch) output.passiveSignals.push({ code: 'response_model_mismatch', test: probe.test, responseModel: probe.responseModel });
            if (probe.reasoningTruncationHeuristic) output.passiveSignals.push({ code: 'reasoning_518n_minus_2', test: probe.test, heuristicOnly: true });
        }
        return output;
    }
}
