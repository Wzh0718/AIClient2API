import { performance } from 'node:perf_hooks';

const apiKey = process.env.RUNTIME_TEST_API_KEY;
const baseUrl = new URL(process.env.RUNTIME_TEST_BASE_URL || 'http://127.0.0.1:13001');
const durationSeconds = Number(process.env.RUNTIME_TEST_DURATION_SECONDS || 300);
const rate = Number(process.env.RUNTIME_TEST_RATE || 25);
if (!apiKey || !['127.0.0.1', 'localhost'].includes(baseUrl.hostname)
    || !Number.isInteger(durationSeconds) || durationSeconds < 1
    || !Number.isInteger(rate) || rate < 1) {
    throw new Error('Local API key, loopback URL, positive duration and rate are required');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const responses = new Map();
const samples = [];
const active = new Set();
let errors = 0;
let stopped = false;
let scheduled = 0;
const requestBody = JSON.stringify({ model: 'grok-4.6', input: 'local audit load', stream: false });

async function sampleHealth() {
    try {
        const response = await fetch(new URL('/runtime/health', baseUrl), { signal: AbortSignal.timeout(5000) });
        const health = await response.json();
        samples.push({
            at: new Date().toISOString(),
            status: health.status,
            readyWorkers: health.readyWorkers,
            backlog: Number(health.persistenceBacklog || 0),
            dropped: Number(health.runtimeHooks?.dropped || 0),
            captureFailures: Number(health.metrics?.requestAudit?.captureFailures || 0),
            workers: Object.fromEntries(Object.entries(health.metrics?.process?.byWorker || {}).map(([id, value]) => [id, {
                heapUsed: Number(value.heapUsed || 0),
                heapLimit: Number(value.heapLimit || 0),
                rss: Number(value.rss || 0)
            }]))
        });
        if (samples.length % 12 === 0) {
            console.error(`[audit-load] seconds=${Math.round((performance.now() - startedAt) / 1000)} sent=${scheduled} status429=${responses.get(429) || 0} backlog=${samples.at(-1).backlog}`);
        }
    } catch {
        errors += 1;
    }
}

async function sendOne() {
    try {
        const response = await fetch(new URL('/openai-codex-oauth/v1/responses', baseUrl), {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: requestBody,
            signal: AbortSignal.timeout(5000)
        });
        responses.set(response.status, (responses.get(response.status) || 0) + 1);
        await response.arrayBuffer();
        if (response.status !== 429) stopped = true;
    } catch {
        errors += 1;
        if (errors > 5) stopped = true;
    }
}

const startedAt = performance.now();
const healthTimer = setInterval(() => { void sampleHealth(); }, 5000);
await sampleHealth();
for (let index = 0; index < durationSeconds * rate && !stopped; index += 1) {
    await sleep(startedAt + index * (1000 / rate) - performance.now());
    if (active.size >= 100) { stopped = true; break; }
    const task = sendOne().finally(() => active.delete(task));
    active.add(task);
    scheduled += 1;
}
await Promise.allSettled(active);
clearInterval(healthTimer);
await sampleHealth();
const report = {
    durationSeconds: (performance.now() - startedAt) / 1000,
    scheduled,
    responses: Object.fromEntries(responses),
    errors,
    stopped,
    maxBacklog: Math.max(0, ...samples.map(sample => sample.backlog)),
    maxDropped: Math.max(0, ...samples.map(sample => sample.dropped)),
    maxHeapUsedByWorker: Object.fromEntries([...new Set(samples.flatMap(sample => Object.keys(sample.workers)))].map(id => [id,
        Math.max(0, ...samples.map(sample => sample.workers[id]?.heapUsed || 0))])),
    firstSample: samples[0] || null,
    lastSample: samples.at(-1) || null
};
console.log(JSON.stringify(report));
if (stopped || errors || responses.size !== 1 || responses.get(429) !== scheduled) process.exitCode = 2;
