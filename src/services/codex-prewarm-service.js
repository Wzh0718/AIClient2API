import { existsSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { MODEL_PROVIDER } from '../utils/common.js';
import { atomicWriteFile } from '../utils/file-lock.js';
import {
    getCachedCodexUsageInstance,
    getCodexPlanStatusForProvider,
    readFreshUsageCacheSync
} from '../utils/codex-plan.js';
import { normalizeCodexRateLimitWindows } from '../utils/codex-rate-limit.js';
import logger from '../utils/logger.js';

const DEFAULT_PREWARM_TIMES = ['06:30', '11:30'];
const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_DUE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_STATE_FILE = path.join('configs', 'codex-prewarm-state.json');
const DEFAULT_MODEL = 'gpt-5-codex-mini';

function toBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const text = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'off'].includes(text)) return false;
    return fallback;
}

function toPositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parsePrewarmTimes(value) {
    const values = Array.isArray(value)
        ? value
        : String(value || '').split(',');
    const times = values
        .map(item => String(item).trim())
        .filter(item => /^([01]\d|2[0-3]):[0-5]\d$/.test(item));
    return [...new Set(times)].sort();
}

export function normalizePrewarmConfig(config = {}) {
    const times = parsePrewarmTimes(config.CODEX_PREWARM_TIMES || DEFAULT_PREWARM_TIMES);
    return {
        enabled: toBoolean(config.CODEX_PREWARM_ENABLED, config.enabled ?? false),
        times: times.length > 0 ? times : DEFAULT_PREWARM_TIMES,
        attempts: toPositiveInteger(config.CODEX_PREWARM_ATTEMPTS, DEFAULT_ATTEMPTS),
        timezone: config.CODEX_PREWARM_TIMEZONE || DEFAULT_TIMEZONE,
        dueWindowMs: toPositiveInteger(config.CODEX_PREWARM_DUE_WINDOW_MS, DEFAULT_DUE_WINDOW_MS),
        pollIntervalMs: toPositiveInteger(config.CODEX_PREWARM_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
        stateFile: config.CODEX_PREWARM_STATE_FILE || DEFAULT_STATE_FILE,
        model: config.CODEX_PREWARM_MODEL || DEFAULT_MODEL
    };
}

function getLocalParts(date, timezone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
    return {
        dateKey: `${parts.year}-${parts.month}-${parts.day}`,
        minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute)
    };
}

function timeToMinuteOfDay(time) {
    const [hour, minute] = time.split(':').map(Number);
    return hour * 60 + minute;
}

export function getDuePrewarmTimes(now, config) {
    const local = getLocalParts(now, config.timezone);
    return config.times
        .filter(time => {
            const diffMs = (local.minuteOfDay - timeToMinuteOfDay(time)) * 60 * 1000;
            return diffMs >= 0 && diffMs <= config.dueWindowMs;
        })
        .map(time => ({ date: local.dateKey, time }));
}

function isCodexProviderType(providerType) {
    return providerType === MODEL_PROVIDER.CODEX_API || providerType?.startsWith(`${MODEL_PROVIDER.CODEX_API}-`);
}

function buildRunKey(slot, providerType, provider) {
    return `${slot.date}|${slot.time}|${providerType}|${provider.uuid || 'unknown'}`;
}

function normalizeState(state) {
    return {
        version: 1,
        updatedAt: state?.updatedAt || null,
        runs: state?.runs && typeof state.runs === 'object' ? state.runs : {}
    };
}

export function buildPrewarmRequest(slot, attempt) {
    return {
        input: [
            {
                role: 'user',
                content: 'ok'
            }
        ],
        instructions: 'Reply with ok.',
        metadata: {
            session_id: `aiclient2api-codex-prewarm-${slot.date}-${slot.time}`,
            prewarm_attempt: attempt
        },
        reasoning: {
            effort: 'low'
        },
        store: false
    };
}

async function defaultPrewarmAccount(job) {
    const { getServiceAdapter } = await import('../providers/adapter.js');
    const serviceConfig = {
        ...job.appConfig,
        ...job.provider,
        MODEL_PROVIDER: job.providerType
    };
    delete serviceConfig.providerPools;
    const adapter = getServiceAdapter(serviceConfig);
    return adapter.generateContent(job.model, buildPrewarmRequest(job.slot, job.attempt));
}

export class CodexPrewarmService {
    constructor({ config = {}, appConfig = config, providerPoolManager, prewarmAccount = defaultPrewarmAccount, log = logger } = {}) {
        this.config = normalizePrewarmConfig(config);
        this.appConfig = appConfig;
        this.providerPoolManager = providerPoolManager;
        this.prewarmAccount = prewarmAccount;
        this.log = log;
        this.state = null;
        this.timer = null;
        this.isRunning = false;
        this.idleWaiters = new Set();
    }

    async loadState() {
        if (this.state) return this.state;
        try {
            if (existsSync(this.config.stateFile)) {
                const content = await fs.readFile(this.config.stateFile, 'utf8');
                this.state = normalizeState(JSON.parse(content));
            } else {
                this.state = normalizeState();
            }
        } catch (error) {
            this.log.warn(`[CodexPrewarm] Failed to load state, starting fresh: ${error.message}`);
            this.state = normalizeState();
        }
        return this.state;
    }

    async saveState() {
        const dir = path.dirname(this.config.stateFile);
        await fs.mkdir(dir, { recursive: true });
        this.state.updatedAt = new Date().toISOString();
        await atomicWriteFile(this.config.stateFile, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
    }

    getEnabledCodexProviders() {
        const providerStatus = this.providerPoolManager?.providerStatus || {};
        const usageCache = readFreshUsageCacheSync();
        const providers = [];
        for (const [providerType, pool] of Object.entries(providerStatus)) {
            if (!isCodexProviderType(providerType) || !Array.isArray(pool)) continue;
            for (const providerStatusItem of pool) {
                const provider = providerStatusItem.config || providerStatusItem;
                if (!provider || provider.isDisabled === true) continue;
                const planStatus = getCodexPlanStatusForProvider(providerType, provider.uuid, usageCache, provider);
                if (!planStatus.allowed) {
                    this.log.info(`[CodexPrewarm] Skipping ${provider.customName || provider.uuid || 'unknown'}: plan ${planStatus.plan} is not eligible`);
                    continue;
                }
                const cachedInstance = getCachedCodexUsageInstance(providerType, provider.uuid, usageCache);
                const usage = cachedInstance?.usage || null;
                const semanticItems = (Array.isArray(usage?.items) ? usage.items : []).filter(item => item?.windowKind);
                const rawWindows = normalizeCodexRateLimitWindows(usage?.raw || {});
                const semanticWindows = semanticItems.length > 0 ? semanticItems : rawWindows.filter(window => window.windowKind !== 'unknown');
                if (semanticWindows.length > 0 && !semanticWindows.some(window =>
                    window.windowKind === 'short' &&
                    (window.scope === 'general' || window.id === 'primary_window' || window.id === 'secondary_window')
                )) {
                    this.log.info(`[CodexPrewarm] Skipping ${provider.customName || provider.uuid || 'unknown'}: no short quota window`);
                    continue;
                }
                providers.push({
                    providerType,
                    provider
                });
            }
        }
        return providers;
    }

    async runDuePrewarm(now = new Date()) {
        if (!this.config.enabled) {
            return { skipped: true, reason: 'disabled', jobs: 0, attempts: 0 };
        }
        if (this.isRunning) {
            return { skipped: true, reason: 'already_running', jobs: 0, attempts: 0 };
        }

        const dueSlots = getDuePrewarmTimes(now, this.config);
        if (dueSlots.length === 0) {
            return { skipped: true, reason: 'not_due', jobs: 0, attempts: 0 };
        }

        this.isRunning = true;
        const summary = {
            skipped: false,
            slots: dueSlots,
            jobs: 0,
            attempts: 0,
            successCount: 0,
            errorCount: 0
        };

        try {
            const state = await this.loadState();
            const providers = this.getEnabledCodexProviders();
            for (const slot of dueSlots) {
                for (const { providerType, provider } of providers) {
                    const runKey = buildRunKey(slot, providerType, provider);
                    if (state.runs[runKey]?.completedAt) {
                        continue;
                    }

                    const errors = [];
                    let successCount = 0;
                    for (let attempt = 1; attempt <= this.config.attempts; attempt++) {
                        summary.attempts += 1;
                        try {
                            await this.prewarmAccount({
                                appConfig: this.appConfig,
                                config: this.config,
                                providerType,
                                provider,
                                slot,
                                attempt,
                                model: this.config.model
                            });
                            successCount += 1;
                            summary.successCount += 1;
                        } catch (error) {
                            errors.push(error.message);
                            summary.errorCount += 1;
                            this.log.warn(`[CodexPrewarm] Attempt failed for ${provider.customName || provider.uuid || 'unknown'} ${slot.date} ${slot.time} #${attempt}: ${error.message}`);
                        }
                    }

                    summary.jobs += 1;
                    state.runs[runKey] = {
                        providerType,
                        uuid: provider.uuid || null,
                        name: provider.customName || null,
                        date: slot.date,
                        time: slot.time,
                        attempts: this.config.attempts,
                        successCount,
                        errorCount: errors.length,
                        errors: errors.slice(-3),
                        completedAt: new Date().toISOString()
                    };
                    await this.saveState();
                }
            }

            if (summary.jobs > 0) {
                this.log.info(`[CodexPrewarm] Completed ${summary.jobs} account slot(s), attempts=${summary.attempts}, success=${summary.successCount}, errors=${summary.errorCount}`);
            }
            return summary;
        } finally {
            this.isRunning = false;
            for (const resolve of this.idleWaiters) {
                resolve();
            }
            this.idleWaiters.clear();
        }
    }

    start() {
        if (!this.config.enabled) {
            this.log.info('[CodexPrewarm] Disabled');
            return false;
        }
        if (this.timer) return true;

        this.runDuePrewarm().catch(error => {
            this.log.error(`[CodexPrewarm] Startup run failed: ${error.message}`);
        });
        this.timer = setInterval(() => {
            this.runDuePrewarm().catch(error => {
                this.log.error(`[CodexPrewarm] Scheduled run failed: ${error.message}`);
            });
        }, this.config.pollIntervalMs);
        if (this.timer.unref) {
            this.timer.unref();
        }
        this.log.info(`[CodexPrewarm] Scheduled for ${this.config.times.join(', ')} ${this.config.timezone}, attempts=${this.config.attempts}`);
        return true;
    }

    async stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.isRunning) {
            await new Promise(resolve => {
                this.idleWaiters.add(resolve);
            });
        }
    }
}

export function startCodexPrewarmService(config, providerPoolManager) {
    const service = new CodexPrewarmService({
        config,
        appConfig: config,
        providerPoolManager
    });
    service.start();
    return service;
}
