import crypto from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const VALUE_MIN = 1;
const VALUE_MAX = 355;
const DIMENSION = 355;
const ALPHA = 0.5;
export const MODELTRACE_BANK_VERSION = '3f0dd2f4b451ad424f3b165a108a468efe4d4d81';
const BANK_SHA256 = '6a3f7e4d703990a2322cf535020309380ca858654345d8fe5db278578568bad3';
const BANK_URL = `https://raw.githubusercontent.com/xqy2006/ModelTrace/${MODELTRACE_BANK_VERSION}/data/unified_bank.json`;

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function norm(values) { return Math.max(Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)), 1e-12); }
function dot(left, right) { return left.reduce((sum, value, index) => sum + value * right[index], 0); }
function standardize(values) {
    const average = mean(values);
    const scale = Math.max(Math.sqrt(mean(values.map(value => (value - average) ** 2))), 1e-12);
    return values.map(value => (value - average) / scale);
}
function projectNuisance(values, basis = []) {
    const projected = [...values];
    for (const vector of basis) {
        const coefficient = dot(projected, vector);
        for (let index = 0; index < projected.length; index += 1) projected[index] -= coefficient * vector[index];
    }
    return projected;
}

export function parseModelTraceNumbers(text) {
    const runs = [];
    let current = [];
    let previousEnd = 0;
    for (const match of String(text || '').matchAll(/\d+/g)) {
        const separator = String(text).slice(previousEnd, match.index);
        const value = Number(match[0]);
        if (current.length && /[a-z]/i.test(separator)) { runs.push(current); current = []; }
        if (value >= VALUE_MIN && value <= VALUE_MAX) current.push(value);
        previousEnd = match.index + match[0].length;
    }
    if (current.length) runs.push(current);
    return runs.sort((left, right) => right.length - left.length)[0] || [];
}

function counts(numbers) {
    const result = Array(DIMENSION).fill(0);
    for (const number of numbers) result[number - 1] += 1;
    return result;
}

function hellingerFeature(numberCounts) {
    const values = numberCounts.map(value => value + ALPHA);
    const total = values.reduce((sum, value) => sum + value, 0);
    return values.map(value => Math.sqrt(value / total));
}

function histogram(values, bins, min, max) {
    const result = Array(bins).fill(0);
    const width = (max - min) / bins;
    for (const value of values) result[Math.min(bins - 1, Math.max(0, Math.floor((value - min) / width)))] += 1;
    return result;
}

function orderedFeature(numbers) {
    const pieces = [];
    for (let block = 0; block < 4; block += 1) {
        const start = Math.floor(numbers.length * block / 4);
        const end = Math.floor(numbers.length * (block + 1) / 4);
        const smoothed = histogram(numbers.slice(start, end), 16, 1, 356).map(value => value + 0.5);
        const total = smoothed.reduce((sum, value) => sum + value, 0);
        pieces.push(...smoothed.map(value => Math.sqrt(value / total)));
    }
    const lastDigits = Array(10).fill(0.5);
    for (const number of numbers) lastDigits[number % 10] += 1;
    const total = lastDigits.reduce((sum, value) => sum + value, 0);
    pieces.push(...lastDigits.map(value => Math.sqrt(value / total)));
    return pieces;
}

function modelScores(numbers, bank) {
    const robust = bank.robust;
    const h = robust.hellinger;
    const feature = hellingerFeature(counts(numbers));
    let projected = feature.map((value, index) => (value - h.feature_mean[index]) / h.feature_scale[index]);
    projected = projectNuisance(projected, h.nuisance_basis || []);
    const hScores = standardize(h.centroids.map(centroid => dot(projected, centroid) / norm(projected)));
    const ordered = robust.ordered_blocks;
    if (!ordered || !Number(ordered.weight)) return hScores;
    const rawOrdered = orderedFeature(numbers);
    const standardized = rawOrdered.map((value, index) => (value - ordered.feature_mean[index]) / ordered.feature_scale[index]);
    const normalized = standardized.map(value => value / norm(standardized));
    const template = standardize(ordered.environment_centroids[0].map((_, modelIndex) =>
        Math.max(...ordered.environment_centroids.map(environment => dot(normalized, environment[modelIndex])))
    ));
    const orderedProjected = projectNuisance(standardized, ordered.nuisance_basis || []);
    const nuisance = standardize(ordered.centroids.map(centroid => dot(orderedProjected, centroid) / norm(orderedProjected)));
    const orderedScores = standardize(template.map((value, index) => 0.5 * value + 0.5 * nuisance[index]));
    return hScores.map((value, index) => (1 - ordered.weight) * value + ordered.weight * orderedScores[index]);
}

function softmax(values) {
    const maximum = Math.max(...values);
    const weights = values.map(value => Math.exp(value - maximum));
    const total = weights.reduce((sum, value) => sum + value, 0);
    return weights.map(value => value / total);
}

export function analyzeModelTraceOutputs(outputs, bank) {
    const valid = [];
    const diagnostics = outputs.map(item => {
        const numbers = parseModelTraceNumbers(item.text);
        const minimum = Math.max(80, Math.ceil(Number(item.expectedCount || 0) * 0.55));
        const accepted = numbers.length >= minimum;
        if (accepted) valid.push({ numbers, scores: modelScores(numbers, bank) });
        return { parsedNumbers: numbers.length, minimumNumbers: minimum, accepted };
    });
    if (!valid.length) return { valid: false, diagnostics, reason: 'no_valid_outputs', bankVersion: MODELTRACE_BANK_VERSION };
    const combined = bank.models.map((_, index) => mean(valid.map(item => item.scores[index])));
    const calibrationKey = String(Math.min(valid.length, 3));
    const beta = Number(bank.calibration[calibrationKey].beta);
    const probabilities = softmax(combined.map(value => beta * value));
    const results = bank.models.map((model, index) => ({
        model: model.id,
        displayName: model.display_name,
        family: model.family || 'models',
        probability: probabilities[index],
        score: combined[index]
    })).sort((left, right) => right.probability - left.probability);
    return {
        valid: true,
        prediction: results[0].model,
        predictionName: results[0].displayName,
        closedSetProbability: results[0].probability,
        usedOutputs: valid.length,
        results: results.slice(0, 12),
        diagnostics,
        bankVersion: MODELTRACE_BANK_VERSION,
        caveat: 'closed_set_attribution_not_identity_proof'
    };
}

function download(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 3) {
                response.resume();
                download(new URL(response.headers.location, url), redirects + 1).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) { response.resume(); reject(new Error(`ModelTrace bank HTTP ${response.statusCode}`)); return; }
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve(Buffer.concat(chunks)));
        });
        request.setTimeout(30_000, () => request.destroy(new Error('ModelTrace bank download timed out')));
        request.on('error', reject);
    });
}

export async function loadModelTraceBank({ cachePath = path.join(process.cwd(), 'configs', 'gpt-diagnostics', `modeltrace-bank-${MODELTRACE_BANK_VERSION}.json`) } = {}) {
    let bytes = await fs.readFile(cachePath).catch(() => null);
    if (!bytes) bytes = await download(BANK_URL);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== BANK_SHA256) throw new Error('ModelTrace bank checksum mismatch');
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, bytes, { mode: 0o600 });
    return JSON.parse(bytes.toString('utf8'));
}

export function modelTraceChallenges() {
    return [294, 311, 329].map((count, index) => ({
        id: `modeltrace-${index + 1}`,
        expectedCount: count,
        prompt: `这是一次无语义数值选择。请为 ${count} 个位置分别凭第一反应选择一个 1 到 355（含端点）的整数。禁止使用工具、代码、计算器、搜索、API 或外部随机数生成器。不要计数，不要使用等差、循环或重复区块。偶然重复有效。直接输出完整数字序列，不要解释。`
    }));
}
