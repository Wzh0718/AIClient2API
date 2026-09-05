import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CONVERSION_MODEL = 'gemini-2.5-flash';

// Single pricing source shared with scripts/usage-ledger/daily-usage-ledger.mjs.
const PRICING_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pricing.json');
const PRICING = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8'));

export const PRICING_VERSION = PRICING.pricingVersion;

const PRICE_PER_MILLION = PRICING.pricePerMillion;
const LONG_CONTEXT_PRICING = PRICING.longContext || {};

const MODEL_PRICE_ALIASES = PRICING.modelPriceAliases;
const MODEL_PRICE_MULTIPLIERS = PRICING.modelPriceMultipliers || {};

const GEMINI_CONVERSION_MODELS = [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-3-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash'
];

const pricingDiagnostics = {
    estimatedAverageCount: 0,
    estimatedAverageTokens: 0,
    estimatedAverageUsd: 0,
    missingPriceCount: 0,
    missingPriceTokens: 0,
    lastEstimatedAt: null,
    lastMissingAt: null
};

export function getPricingDiagnostics() {
    return { ...pricingDiagnostics };
}

export function resetPricingDiagnostics() {
    for (const key of Object.keys(pricingDiagnostics)) {
        pricingDiagnostics[key] = key.startsWith('last') ? null : 0;
    }
}

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function normalizeModelName(model) {
    return String(model || '').trim().toLowerCase();
}

function normalizePricedModelName(model) {
    const normalized = normalizeModelName(model);
    return MODEL_PRICE_ALIASES[normalized] || normalized;
}

function isTextPricingModel(model) {
    const normalized = normalizeModelName(model);
    return normalized !== '' && !/(?:image|audio|tts|transcrib|whisper)/.test(normalized);
}

function normalizeUsageParts(usage = {}) {
    const promptTokens = toNumber(usage.promptTokens);
    const cachedTokens = Math.min(promptTokens, toNumber(usage.cachedTokens));
    const cacheWriteTokens = toNumber(
        usage.cacheWriteTokens ?? usage.cache_write_tokens ??
        usage.cache_creation_input_tokens ?? usage.cache_creation_tokens ??
        usage.input_tokens_details?.cache_write_tokens ?? usage.input_tokens_details?.cache_creation_tokens
    );
    const billableInputTokens = Math.max(0, promptTokens - cachedTokens);
    const outputTokens = toNumber(usage.completionTokens);
    const classifiedTokens = billableInputTokens + cachedTokens + outputTokens;
    const totalTokens = toNumber(usage.totalTokens) || (promptTokens + outputTokens);
    return { promptTokens, cachedTokens, cacheWriteTokens, billableInputTokens, outputTokens, classifiedTokens, totalTokens };
}

function getLongContextRates(parts) {
    const threshold = toNumber(LONG_CONTEXT_PRICING.threshold);
    const isLongContext = threshold > 0 && parts.promptTokens > threshold;
    return {
        inputMultiplier: isLongContext ? (toNumber(LONG_CONTEXT_PRICING.inputMultiplier) || 1) : 1,
        cachedInputMultiplier: isLongContext ? (toNumber(LONG_CONTEXT_PRICING.cachedInputMultiplier) || 1) : 1,
        outputMultiplier: isLongContext ? (toNumber(LONG_CONTEXT_PRICING.outputMultiplier) || 1) : 1
    };
}

function resolvePricedModel(model) {
    const normalized = normalizeModelName(model);
    const multiplierConfig = MODEL_PRICE_MULTIPLIERS[normalized];
    if (multiplierConfig?.baseModel) {
        return {
            displayModel: normalized,
            pricedModel: normalizePricedModelName(multiplierConfig.baseModel),
            multiplier: toNumber(multiplierConfig.multiplier) || 1,
            multiplierSource: multiplierConfig.source || ''
        };
    }

    const pricedModel = normalizePricedModelName(normalized);
    return {
        displayModel: pricedModel,
        pricedModel,
        multiplier: 1,
        multiplierSource: ''
    };
}

export function getConversionModels() {
    return GEMINI_CONVERSION_MODELS.map(model => ({
        model,
        pricing: PRICE_PER_MILLION[model]
    }));
}

export function normalizeConversionModel(model) {
    const normalized = normalizeModelName(model);
    return GEMINI_CONVERSION_MODELS.includes(normalized) ? normalized : DEFAULT_CONVERSION_MODEL;
}

export function getModelPricing(model) {
    return PRICE_PER_MILLION[resolvePricedModel(model).pricedModel] || null;
}

export function buildAveragePricingProfile(models = {}) {
    const totals = {
        billableInputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputUsd: 0,
        cachedInputUsd: 0,
        outputUsd: 0,
        usd: 0
    };
    let sampleModelCount = 0;

    for (const [model, usage] of Object.entries(models || {})) {
        if (!isTextPricingModel(model)) continue;
        const resolvedModel = resolvePricedModel(model);
        const pricing = getModelPricing(resolvedModel.pricedModel);
        if (!pricing) continue;
        const parts = normalizeUsageParts(usage);
        if (parts.totalTokens <= 0) continue;
        const multiplier = resolvedModel.multiplier;
        const longContextRates = getLongContextRates(parts);
        const inputUsd = parts.billableInputTokens * pricing.input * multiplier * longContextRates.inputMultiplier / 1_000_000;
        const cachedInputUsd = parts.cachedTokens * pricing.cachedInput * multiplier * longContextRates.cachedInputMultiplier / 1_000_000;
        const outputUsd = parts.outputTokens * pricing.output * multiplier * longContextRates.outputMultiplier / 1_000_000;
        totals.billableInputTokens += parts.billableInputTokens;
        totals.cachedTokens += parts.cachedTokens;
        totals.outputTokens += parts.outputTokens;
        totals.totalTokens += parts.totalTokens;
        totals.inputUsd += inputUsd;
        totals.cachedInputUsd += cachedInputUsd;
        totals.outputUsd += outputUsd;
        totals.usd += inputUsd + cachedInputUsd + outputUsd;
        sampleModelCount += 1;
    }

    if (sampleModelCount === 0 || totals.totalTokens <= 0 || totals.usd <= 0) return null;
    return {
        input: totals.billableInputTokens > 0 ? totals.inputUsd * 1_000_000 / totals.billableInputTokens : null,
        cachedInput: totals.cachedTokens > 0 ? totals.cachedInputUsd * 1_000_000 / totals.cachedTokens : null,
        output: totals.outputTokens > 0 ? totals.outputUsd * 1_000_000 / totals.outputTokens : null,
        effective: totals.usd * 1_000_000 / totals.totalTokens,
        sampleTokens: totals.totalTokens,
        sampleUsd: totals.usd,
        sampleModelCount,
        pricingVersion: PRICING_VERSION
    };
}

function estimateFromAverageProfile(usage, profile) {
    const parts = normalizeUsageParts(usage);
    if (!profile || parts.totalTokens <= 0) return null;
    const fallback = toNumber(profile.effective);
    if (fallback <= 0) return null;
    const cacheWriteTokens = Math.max(0, parts.cacheWriteTokens);
    const fallbackTokens = Math.max(0, parts.totalTokens - cacheWriteTokens);
    let usd;
    if (parts.classifiedTokens > 0) {
        usd = (
            parts.billableInputTokens * (toNumber(profile.input) || fallback) +
            parts.cachedTokens * (toNumber(profile.cachedInput) || fallback) +
            parts.outputTokens * (toNumber(profile.output) || fallback)
        ) / 1_000_000;
        const unclassifiedTokens = Math.max(0, fallbackTokens - parts.classifiedTokens);
        usd += unclassifiedTokens * fallback / 1_000_000;
    } else {
        usd = fallbackTokens * fallback / 1_000_000;
    }
    return { usd, totalTokens: parts.totalTokens };
}

export function estimateUsageCost(usage = {}, model = DEFAULT_CONVERSION_MODEL, options = {}) {
    const resolvedModel = resolvePricedModel(model);
    const pricing = getModelPricing(resolvedModel.pricedModel);
    const parts = normalizeUsageParts(usage);

    if (!pricing) {
        const average = estimateFromAverageProfile(usage, options.averageProfile);
        if (average) {
            const averageScope = options.averageScope || 'global-day';
            pricingDiagnostics.estimatedAverageCount += 1;
            pricingDiagnostics.estimatedAverageTokens += average.totalTokens;
            pricingDiagnostics.estimatedAverageUsd += average.usd;
            pricingDiagnostics.lastEstimatedAt = new Date().toISOString();
            return {
                usd: average.usd,
                actualUsd: 0,
                estimatedUsd: average.usd,
                estimatedPriceTokens: average.totalTokens,
                missingPriceTokens: 0,
                model: resolvedModel.displayModel || null,
                pricingVersion: PRICING_VERSION,
                pricingSource: 'estimated-average',
                estimationMethod: `${averageScope}-weighted-average`,
                estimationScope: averageScope,
                averageSampleTokens: toNumber(options.averageProfile?.sampleTokens),
                averageSampleModelCount: toNumber(options.averageProfile?.sampleModelCount)
            };
        }
        pricingDiagnostics.missingPriceCount += 1;
        pricingDiagnostics.missingPriceTokens += parts.totalTokens;
        pricingDiagnostics.lastMissingAt = new Date().toISOString();
        return {
            usd: 0,
            actualUsd: 0,
            estimatedUsd: 0,
            estimatedPriceTokens: 0,
            missingPriceTokens: parts.totalTokens,
            model: resolvedModel.displayModel || null,
            pricingVersion: PRICING_VERSION,
            pricingSource: 'missing'
        };
    }

    const longContextRates = getLongContextRates(parts);
    const standardUsd = (
        (parts.billableInputTokens * pricing.input * longContextRates.inputMultiplier) +
        (parts.cachedTokens * pricing.cachedInput * longContextRates.cachedInputMultiplier) +
        (parts.outputTokens * pricing.output * longContextRates.outputMultiplier)
    ) / 1_000_000;
    const usd = standardUsd * resolvedModel.multiplier;

    return {
        usd,
        actualUsd: usd,
        estimatedUsd: 0,
        estimatedPriceTokens: 0,
        missingPriceTokens: 0,
        model: resolvedModel.displayModel,
        pricingVersion: PRICING_VERSION,
        pricingSource: resolvedModel.multiplierSource || pricing.source,
        priceMultiplier: resolvedModel.multiplier
    };
}

export function estimateActualCostFromModels(models = {}) {
    let usd = 0;
    let actualUsd = 0;
    let estimatedUsd = 0;
    let estimatedPriceTokens = 0;
    let missingPriceTokens = 0;
    const byModel = {};
    const averageProfile = buildAveragePricingProfile(models);

    for (const [model, usage] of Object.entries(models || {})) {
        const estimate = estimateUsageCost(usage, model, {
            averageProfile,
            averageScope: 'global-day'
        });
        usd += estimate.usd;
        actualUsd += estimate.actualUsd;
        estimatedUsd += estimate.estimatedUsd;
        estimatedPriceTokens += estimate.estimatedPriceTokens;
        missingPriceTokens += estimate.missingPriceTokens;
        byModel[model] = estimate;
    }

    return {
        usd,
        actualUsd,
        estimatedUsd,
        estimatedPriceTokens,
        missingPriceTokens,
        byModel,
        averageProfile,
        pricingVersion: PRICING_VERSION
    };
}

export function buildCost(usage = {}, models = {}, conversionModel = DEFAULT_CONVERSION_MODEL) {
    const normalizedConversionModel = normalizeConversionModel(conversionModel);
    const actual = estimateActualCostFromModels(models);
    const converted = estimateUsageCost(usage, normalizedConversionModel);

    return {
        usd: actual.usd,
        actualUsd: actual.actualUsd,
        estimatedUsd: actual.estimatedUsd,
        convertedUsd: converted.usd,
        conversionModel: normalizedConversionModel,
        pricingVersion: PRICING_VERSION,
        missingPriceTokens: actual.missingPriceTokens,
        estimatedPriceTokens: actual.estimatedPriceTokens,
        byModel: actual.byModel
    };
}
