import '../core/security-hardening.js';
import logger from '../utils/logger.js';
import * as http from 'http';
import path from 'node:path';
import { initializeConfig, CONFIG } from '../core/config-manager.js';
import { initApiService, autoLinkProviderConfigs, getProviderPoolManager } from './service-manager.js';
import { initializeUIManagement } from './ui-manager.js';
import { initializeAPIManagement } from './api-manager.js';
import { createRequestHandler } from '../handlers/request-handler.js';
import { discoverPlugins, getPluginManager } from '../core/plugin-manager.js';
import { getTLSSidecar } from '../utils/tls-sidecar.js';
import { HEALTH_CHECK } from '../utils/constants.js';
import { startCodexPrewarmService } from './codex-prewarm-service.js';
import { startUsageCacheAutoRefreshService } from './usage-cache-auto-refresh-service.js';
import { createAsyncActivityTracker, createStartupShutdownGate } from './async-activity-tracker.js';
import { createShutdownCoordinator } from './shutdown-coordinator.js';
import { registerWorkerShutdownHandlers } from './worker-shutdown-handlers.js';
import { createRuntimeCoordination } from '../runtime/runtime-coordination.js';
import { waitForCoordinationReady } from '../runtime/runtime-coordination-readiness.js';
import { RuntimeEventConsumer, createDurableRuntimeHookApply } from '../runtime/runtime-event-consumer.js';
import { createRuntimeHookStreamFromEnv } from '../runtime/runtime-hook-stream.js';
import { createUsageEventStore } from '../runtime/usage-event-store.js';
import { RuntimeUsageProjector } from '../runtime/runtime-usage-projector.js';
import { migrateCodexFingerprintProviderPoolsFile } from '../utils/codex-fingerprint-migration.js';
import { invalidateServiceAdapter } from '../providers/adapter.js';
import { runtimeImageCapacity } from '../runtime/runtime-image-capacity.js';
import { buildKeyConfigSyncAck } from '../runtime/multi-worker-runtime.js';
import { getPricingDiagnostics } from '../plugins/api-potluck/cost-estimator.js';
import { getTemporaryRouteScheduleDiagnostics } from '../utils/temporary-key-model-routing.js';

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * 描述 / Description:
 * (最终生产就绪版本 / Final Production Ready Version)
 * 此脚本创建一个独立的 Node.js HTTP 服务器，作为 Google Cloud Code Assist API 的本地代理。
 * 此版本包含所有功能和错误修复，设计为健壮、灵活且易于通过全面可控的日志系统进行监控。
 * 
 * This script creates a standalone Node.js HTTP server that acts as a local proxy for the Google Cloud Code Assist API.
 * This version includes all features and bug fixes, designed to be robust, flexible, and easy to monitor through a comprehensive and controllable logging system.
 *
 * 主要功能 / Key Features:
 * - OpenAI & Gemini & Claude 多重兼容性：无缝桥接使用 OpenAI API 格式的客户端与 Google Gemini API。支持原生 Gemini API (`/v1beta`) 和 OpenAI 兼容 (`/v1`) 端点。
 *   OpenAI & Gemini & Claude Dual Compatibility: Seamlessly bridges clients using the OpenAI API format with the Google Gemini API. Supports both native Gemini API (`/v1beta`) and OpenAI-compatible (`/v1`) endpoints.
 * 
 * - 强大的身份验证管理：支持多种身份验证方法，包括通过 Base64 字符串、文件路径或自动发现本地凭据的 OAuth 2.0 配置。能够自动刷新过期令牌以确保服务持续运行。
 *   Robust Authentication Management: Supports multiple authentication methods, including OAuth 2.0 configuration via Base64 strings, file paths, or automatic discovery of local credentials. Capable of automatically refreshing expired tokens to ensure continuous service operation.
 * 
 * - 灵活的 API 密钥验证：支持三种 API 密钥验证方法：`Authorization: Bearer <key>` 请求头、`x-goog-api-key` 请求头和 `?key=` URL 查询参数，可通过 `--api-key` 启动参数配置。
 *   Flexible API Key Validation: Supports three API key validation methods: `Authorization: Bearer <key>` request header, `x-goog-api-key` request header, and `?key=` URL query parameter, configurable via the `--api-key` startup parameter.
 * 
 * - 动态系统提示管理 / Dynamic System Prompt Management:
 *   - 文件注入：通过 `--system-prompt-file` 从外部文件加载系统提示，并通过 `--system-prompt-mode` 控制其行为（覆盖或追加）。
 *     File Injection: Loads system prompts from external files via `--system-prompt-file` and controls their behavior (overwrite or append) with `--system-prompt-mode`.
 *   - 实时同步：能够将请求中包含的系统提示实时写入 `configs/fetch_system_prompt.txt` 文件，便于开发者观察和调试。
 *     Real-time Synchronization: Capable of writing system prompts included in requests to the `fetch_system_prompt.txt` file in real-time, facilitating developer observation and debugging.
 * 
 * - 智能请求转换和修复：自动将 OpenAI 格式的请求转换为 Gemini 格式，包括角色映射（`assistant` -> `model`）、合并来自同一角色的连续消息以及修复缺失的 `role` 字段。
 *   Intelligent Request Conversion and Repair: Automatically converts OpenAI-formatted requests to Gemini format, including role mapping (`assistant` -> `model`), merging consecutive messages from the same role, and fixing missing `role` fields.
 * 
 * - 全面可控的日志系统：提供两种日志模式（控制台或文件），详细记录每个请求的输入和输出、剩余令牌有效性等信息，用于监控和调试。
 *   Comprehensive and Controllable Logging System: Provides two logging modes (console or file), detailing input and output of each request, remaining token validity, and other information for monitoring and debugging.
 * 
 * - 高度可配置的启动：支持通过命令行参数配置服务监听地址、端口、项目 ID、API 密钥和日志模式。
 *   Highly Configurable Startup: Supports configuring service listening address, port, project ID, API key, and logging mode via command-line parameters.
 *
 * 使用示例 / Usage Examples:
 * 
 * 基本用法 / Basic Usage:
 * node src/api-server.js
 * 
 * 服务器配置 / Server Configuration:
 * node src/api-server.js --host 0.0.0.0 --port 8080 --api-key your-secret-key
 * 
 * OpenAI 提供商 / OpenAI Provider:
 * node src/api-server.js --model-provider openai-custom --openai-api-key sk-xxx --openai-base-url https://api.openai.com/v1
 * 
 * Claude 提供商 / Claude Provider:
 * node src/api-server.js --model-provider claude-custom --claude-api-key sk-ant-xxx --claude-base-url https://api.anthropic.com
 * 
 * Gemini 提供商（使用 Base64 凭据的 OAuth）/ Gemini Provider (OAuth with Base64 credentials):
 * node src/api-server.js --model-provider gemini-cli --gemini-oauth-creds-base64 eyJ0eXBlIjoi... --project-id your-project-id
 * 
 * Gemini 提供商（使用凭据文件的 OAuth）/ Gemini Provider (OAuth with credentials file):
 * node src/api-server.js --model-provider gemini-cli --gemini-oauth-creds-file /path/to/credentials.json --project-id your-project-id
 * 
 * 系统提示管理 / System Prompt Management:
 * node src/api-server.js --system-prompt-file custom-prompt.txt --system-prompt-mode append
 * 
 * 日志配置 / Logging Configuration:
 * node src/api-server.js --log-prompts console
 * node src/api-server.js --log-prompts file --prompt-log-base-name my-logs
 * 
 * 完整示例 / Complete Example:
 * node src/api-server.js \
 *   --host 0.0.0.0 \
 *   --port 3000 \
 *   --api-key my-secret-key \
 *   --model-provider gemini-cli-oauth \
 *   --project-id my-gcp-project \
 *   --gemini-oauth-creds-file ./credentials.json \
 *   --system-prompt-file ./custom-system-prompt.txt \
 *   --system-prompt-mode overwrite \
 *   --log-prompts file \
 *   --prompt-log-base-name api-logs
 * 
 * 命令行参数 / Command Line Parameters:
 * --host <address>                    服务器监听地址 / Server listening address (default: 0.0.0.0)
 * --port <number>                     服务器监听端口 / Server listening port (default: 3000)
 * --api-key <key>                     身份验证所需的 API 密钥 / Required API key for authentication (default: 123456)
 * --model-provider <provider[,provider...]> AI 模型提供商 / AI model provider: openai-custom, claude-custom, gemini-cli-oauth, claude-kiro-oauth
 * --openai-api-key <key>             OpenAI API 密钥 / OpenAI API key (for openai-custom provider)
 * --openai-base-url <url>            OpenAI API 基础 URL / OpenAI API base URL (for openai-custom provider)
 * --claude-api-key <key>             Claude API 密钥 / Claude API key (for claude-custom provider)
 * --claude-base-url <url>            Claude API 基础 URL / Claude API base URL (for claude-custom provider)
 * --gemini-oauth-creds-base64 <b64>  Gemini OAuth 凭据的 Base64 字符串 / Gemini OAuth credentials as Base64 string
 * --gemini-oauth-creds-file <path>   Gemini OAuth 凭据 JSON 文件路径 / Path to Gemini OAuth credentials JSON file
 * --kiro-oauth-creds-base64 <b64>    Kiro OAuth 凭据的 Base64 字符串 / Kiro OAuth credentials as Base64 string
 * --kiro-oauth-creds-file <path>     Kiro OAuth 凭据 JSON 文件路径 / Path to Kiro OAuth credentials JSON file
 * --qwen-oauth-creds-file <path>     Qwen OAuth 凭据 JSON 文件路径 / Path to Qwen OAuth credentials JSON file
 * --project-id <id>                  Google Cloud 项目 ID / Google Cloud Project ID (for gemini-cli provider)
 * --system-prompt-file <path>        系统提示文件路径 / Path to system prompt file (default: configs/input_system_prompt.txt)
 * --system-prompt-mode <mode>        系统提示模式 / System prompt mode: overwrite or append (default: overwrite)
 * --log-prompts <mode>               提示日志模式 / Prompt logging mode: console, file, or none (default: none)
 * --prompt-log-base-name <name>      提示日志文件基础名称 / Base name for prompt log files (default: prompt_log)
 * --request-max-retries <number>     API 请求失败时，自动重试的最大次数。 / Max retries for API requests on failure (default: 3)
 * --request-base-delay <number>      自动重试之间的基础延迟时间（毫秒）。每次重试后延迟会增加。 / Base delay in milliseconds between retries, increases with each retry (default: 1000)
 * --cron-near-minutes <number>       OAuth 令牌刷新任务计划的间隔时间（分钟）。 / Interval for OAuth token refresh task in minutes (default: 15)
 * --cron-refresh-token <boolean>     是否开启 OAuth 令牌自动刷新任务 / Whether to enable automatic OAuth token refresh task (default: true)
 * --provider-pools-file <path>       提供商号池配置文件路径 / Path to provider pools configuration file (default: null)
 * --no-ui                           禁用前端管理界面 / Disable frontend management UI
 *
 */

import 'dotenv/config'; // Import dotenv and configure it
import '../converters/register-converters.js'; // 注册所有转换器
import { isRetryableNetworkError } from '../utils/common.js';
import { runtimeMetrics } from '../runtime/runtime-metrics.js';
import { applyRawCaptureRuntimeConfig, drainAuditQueue } from '../plugins/request-audit/index.js';

// 检测是否作为子进程运行
const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === 'true';
const RUNTIME_WORKER_ROLE = process.env.RUNTIME_WORKER_ROLE || 'standalone';
const IS_EXECUTION_WORKER = RUNTIME_WORKER_ROLE === 'execution';
const runtimeCoordination = createRuntimeCoordination();

// 存储服务器实例，用于优雅关闭
let serverInstance = null;
let codexPrewarmService = null;
let usageCacheAutoRefreshService = null;
let heartbeatTimerId = null;
let runtimeMetricsTimerId = null;
let runtimeHookRetryTimerId = null;
let runtimeHookStream = null;
let usageEventStore = null;
let usageEventStoreSnapshot = null;
let runtimeUsageProjector = null;
let usageProjectionRefreshPromise = null;
let usageProjectionRefreshRequested = false;
let usageEventMaintenanceTimerId = null;
let runtimeHookPollPromise = null;
let runtimeHookPollStopped = false;
let runtimeHookStreamStatus = { pending: 0, consumerLag: 0, available: true, error: null };
let startupPromise = Promise.resolve();
const requestActivityTracker = createAsyncActivityTracker();
const heartbeatActivityTracker = createAsyncActivityTracker();
const healthCheckActivityTracker = createAsyncActivityTracker();
const startupShutdownGate = createStartupShutdownGate({ logger });

function scheduleUsageProjectionRefresh() {
    usageProjectionRefreshRequested = true;
    if (usageProjectionRefreshPromise) return usageProjectionRefreshPromise;

    usageProjectionRefreshPromise = (async () => {
        do {
            usageProjectionRefreshRequested = false;
            await runtimeUsageProjector?.schedule?.();
            if (usageEventStore) usageEventStoreSnapshot = await usageEventStore.snapshot();
        } while (usageProjectionRefreshRequested);
    })().finally(() => {
        usageProjectionRefreshPromise = null;
    });
    return usageProjectionRefreshPromise;
}

const runtimeHookConsumer = new RuntimeEventConsumer({
    apply: createDurableRuntimeHookApply({
        executeHook: (hookName, ...args) => getPluginManager()?.executeHook?.(hookName, ...args)
    }),
    ack: message => sendToMaster({ type: 'runtime_hook_ack', sourceWorkerId: message.sourceWorkerId, eventId: message.eventId }),
    appendBatch: async messages => {
        if (!usageEventStore) throw new Error('Usage event store is not initialized');
        const result = await usageEventStore.appendBatch(messages);
        usageEventStoreSnapshot = await usageEventStore.snapshot();
        return result;
    },
    markProjectedBatch: async messages => {
        if (!usageEventStore) throw new Error('Usage event store is not initialized');
        await usageEventStore.markProjected(messages.map(message => message.eventId));
        usageEventStoreSnapshot = await usageEventStore.snapshot();
    },
    ackBatch: async messages => {
        await runtimeHookStream?.commitBatch?.(messages);
        for (const message of messages) {
            sendToMaster({ type: 'runtime_hook_ack', sourceWorkerId: message.sourceWorkerId, eventId: message.eventId });
        }
    },
    scheduleProjections: scheduleUsageProjectionRefresh,
    durableState: {
        hasApplied: message => runtimeHookStream?.hasApplied?.(message) || false,
        commit: message => runtimeHookStream?.commit?.(message)
    }
});

function getRuntimeHookSnapshot() {
    const bridgeSnapshot = getPluginManager()?.runtimeHookBridge?.snapshot?.() || {};
    const streamSnapshot = runtimeHookStream?.snapshot?.() || {};
    return {
        pending: Number(bridgeSnapshot.pending || runtimeHookStreamStatus.pending || 0),
        dropped: Number(bridgeSnapshot.dropped || 0),
        backpressured: Number(bridgeSnapshot.backpressured || 0),
        spooled: Number(bridgeSnapshot.spooled || streamSnapshot.spooled || 0),
        spoolBytes: Number(bridgeSnapshot.spoolBytes || streamSnapshot.spoolBytes || 0),
        spoolMaxBytes: Number(bridgeSnapshot.spoolMaxBytes || streamSnapshot.spoolMaxBytes || 0),
        spoolFull: bridgeSnapshot.spoolFull === true || streamSnapshot.spoolFull === true,
        consumerLag: Number(runtimeHookStreamStatus.consumerLag || 0),
        streamLength: Number(runtimeHookStreamStatus.streamLength || 0),
        redisMemory: runtimeHookStreamStatus.memory || null,
        redisDegraded: runtimeHookStreamStatus.degraded === true,
        redisOomCommandErrors: Number(runtimeHookStreamStatus.oomCommandErrors || streamSnapshot.oomCommandErrors || 0),
        redisTotalErrorReplies: Number(runtimeHookStreamStatus.totalErrorReplies || 0),
        available: runtimeHookStreamStatus.available !== false
            && bridgeSnapshot.spoolFull !== true
            && streamSnapshot.spoolFull !== true,
        error: runtimeHookStreamStatus.error || null,
        oldestPendingAgeMs: Math.max(
            Number(bridgeSnapshot.oldestPendingAgeMs || 0),
            Number(streamSnapshot.oldestPendingAgeMs || 0)
        ),
        lastPublishedAt: streamSnapshot.lastPublishedAt || null,
        lastCommittedAt: streamSnapshot.lastCommittedAt || null,
        lastError: streamSnapshot.lastError || null,
        usageLedger: usageEventStoreSnapshot,
        ack: runtimeHookConsumer.snapshot()
    };
}

function getRequestAuditMetrics() {
    const plugin = getPluginManager()?.getEnabledPlugins?.()
        .find(candidate => candidate.name === 'request-audit');
    return plugin?.getRuntimeMetrics?.() || null;
}

function buildRuntimeMetricsSnapshot() {
    return {
        ...runtimeMetrics.snapshot(),
        workerId: process.env.RUNTIME_WORKER_ID || RUNTIME_WORKER_ROLE,
        imageCapacity: runtimeImageCapacity.snapshot(),
        pricingDiagnostics: getPricingDiagnostics(),
        temporaryRouting: getTemporaryRouteScheduleDiagnostics(),
        providerCoordination: getProviderPoolManager()?.coordination?.getStatus?.() || null,
        requestAudit: getRequestAuditMetrics(),
        hooks: getRuntimeHookSnapshot()
    };
}

function startRuntimeHookPolling() {
    if (!runtimeHookStream || RUNTIME_WORKER_ROLE !== 'control' || runtimeHookPollPromise) return;
    runtimeHookPollStopped = false;
    runtimeHookPollPromise = (async () => {
        while (!runtimeHookPollStopped) {
            try {
                const events = await runtimeHookStream.readBatch({
                    count: Math.max(1, Number(CONFIG.USAGE_EVENT_BATCH_SIZE || process.env.USAGE_EVENT_BATCH_SIZE || 100)),
                    blockMs: Math.max(1, Number(CONFIG.USAGE_EVENT_BATCH_WAIT_MS || process.env.USAGE_EVENT_BATCH_WAIT_MS || 20))
                });
                await runtimeHookConsumer.consumeBatch(events);
                runtimeHookStreamStatus = await runtimeHookStream.pendingSnapshot();
            } catch (error) {
                if (!runtimeHookPollStopped) {
                    runtimeHookStreamStatus = { pending: 0, consumerLag: 0, available: false, error: error.message };
                    logger.error('[Runtime Hook] Redis stream poll failed:', error.message);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }
    })().finally(() => { runtimeHookPollPromise = null; });
}

async function stopRuntimeHookTransport() {
    if (runtimeHookRetryTimerId) {
        clearInterval(runtimeHookRetryTimerId);
        runtimeHookRetryTimerId = null;
    }
    if (usageEventMaintenanceTimerId) {
        clearInterval(usageEventMaintenanceTimerId);
        usageEventMaintenanceTimerId = null;
    }
    runtimeHookPollStopped = true;
    await runtimeHookPollPromise;
    await getPluginManager()?.runtimeHookBridge?.drain?.({ timeoutMs: 20000 });
    await runtimeHookStream?.flushSpool?.();
    await runtimeUsageProjector?.drain?.();
    runtimeUsageProjector = null;
    if (usageEventStore) {
        usageEventStoreSnapshot = await usageEventStore.checkpoint();
        await usageEventStore.close();
        usageEventStore = null;
    }
    await runtimeHookStream?.close?.();
}

/**
 * 发送消息给主进程
 * @param {Object} message - 消息对象
 */
function sendToMaster(message) {
    if (IS_WORKER_PROCESS && process.send) {
        process.send(message);
    }
}

async function stopBackgroundServices() {
    const failures = [];
    const stopOne = async (name, operation) => {
        try {
            await operation();
        } catch (reason) {
            const message = reason instanceof Error ? reason.message : String(reason);
            const failure = new Error(`${name}: ${message}`);
            failure.cause = reason;
            failures.push(failure);
        }
    };

    await stopOne('Codex prewarm', async () => {
        const service = codexPrewarmService;
        codexPrewarmService = null;
        await service?.stop();
    });

    await stopOne('usage cache auto refresh', async () => {
        const service = usageCacheAutoRefreshService;
        usageCacheAutoRefreshService = null;
        await service?.stop();
    });

    await stopOne('heartbeat and token refresh', async () => {
        if (heartbeatTimerId) {
            clearInterval(heartbeatTimerId);
            heartbeatTimerId = null;
        }
        await heartbeatActivityTracker.waitForIdle();
    });

    await stopOne('runtime metrics reporting', async () => {
        if (runtimeMetricsTimerId) {
            clearInterval(runtimeMetricsTimerId);
            runtimeMetricsTimerId = null;
        }
    });

    await stopOne('runtime hook transport', stopRuntimeHookTransport);

    await stopOne('provider refresh queue', async () => {
        const providerPoolManager = getProviderPoolManager();
        await providerPoolManager?.shutdownRefreshQueue();
        await providerPoolManager?.flushPendingSaves?.();
    });

    await stopOne('scheduled health check', async () => {
        if (typeof globalThis.stopHealthCheckTimer === 'function') {
            await globalThis.stopHealthCheckTimer();
        }
    });

    if (failures.length > 0) {
        throw new AggregateError(failures, 'Failed to stop one or more background services');
    }
}

const requestShutdown = createShutdownCoordinator({
    getServer: () => serverInstance,
    onShutdownRequested: () => startupShutdownGate.requestShutdown(),
    waitForStartup: () => startupPromise,
    waitForInFlightHandlers: () => requestActivityTracker.waitForIdle(),
    stopBackgroundServices,
    destroyPlugins: async () => {
        const pluginManager = getPluginManager();
        if (pluginManager) {
            await pluginManager.destroyAll({ operationTimeoutMs: null });
        }
    },
    stopTlsSidecar: async () => {
        await getTLSSidecar().stop();
    },
    exit: code => process.exit(code),
    logger
});

/**
 * 优雅关闭服务器
 * @param {number} exitCode - 0 for normal shutdown, non-zero for fatal shutdown
 * @returns {Promise<number>} shared shutdown completion promise
 */
function gracefulShutdown(exitCode = 0) {
    return requestShutdown({ exitCode });
}

// --- Server Initialization ---
async function startServer() {
    // Initialize configuration
    await initializeConfig(process.argv.slice(2), 'configs/config.json');
    runtimeMetrics.configure({
        sampleRate: process.env.REQUEST_PERF_SAMPLE_RATE ?? CONFIG.REQUEST_PERF_SAMPLE_RATE,
        slowRequestMs: process.env.REQUEST_PERF_SLOW_MS ?? CONFIG.REQUEST_PERF_SLOW_MS
    });
    if (startupShutdownGate.shouldAbort('TLS sidecar startup')) return null;

    if (!IS_EXECUTION_WORKER) {
        const migration = await migrateCodexFingerprintProviderPoolsFile({
            config: CONFIG,
            persistenceEnabled: true,
            logger
        });
        if (migration.changed) {
            logger.info(`[Codex Fingerprint] Provider migration applied: modes=${migration.migratedCount}, versioned=${migration.versionedCount}, invalid=${migration.invalidCount}, backup=${migration.backupPath ? 'created' : 'unavailable'}`);
        }
    }
    
    // 自动关联 configs 目录中的配置文件到对应的提供商
    // logger.info('[Initialization] Checking for unlinked provider configs...');
    // await autoLinkProviderConfigs(CONFIG);

    // Start TLS sidecar if enabled
    if (CONFIG.TLS_SIDECAR_ENABLED && !IS_EXECUTION_WORKER) {
        const sidecar = getTLSSidecar();
        const started = await sidecar.start({
            port: CONFIG.TLS_SIDECAR_PORT,
            binaryPath: CONFIG.TLS_SIDECAR_BINARY_PATH || undefined,
        });
        if (startupShutdownGate.shouldAbort('plugin discovery')) return null;
        if (started) {
            logger.info('[Initialization] TLS sidecar started successfully');
        } else {
            logger.warn('[Initialization] TLS sidecar failed to start, falling back to Node.js TLS');
        }
    }

    // Initialize plugin system
    if (startupShutdownGate.shouldAbort('plugin discovery')) return null;
    logger.info('[Initialization] Discovering and initializing plugins...');
    await discoverPlugins();
    if (startupShutdownGate.shouldAbort('plugin initialization')) return null;
    const pluginManager = getPluginManager();
    if (!IS_EXECUTION_WORKER && IS_WORKER_PROCESS && process.send) {
        CONFIG._requestAuditRawCaptureEventSink = event => sendToMaster(event);
        CONFIG._potluckKeyConfigEpoch = `${process.env.RUNTIME_DEPLOYMENT_EPOCH || 'default'}:${process.pid}:${Date.now()}`;
        CONFIG._potluckKeyConfigEventSink = event => sendToMaster(event);
    }
    await pluginManager.initAll(CONFIG);
    if (IS_WORKER_PROCESS && ['execution', 'control'].includes(RUNTIME_WORKER_ROLE)) {
        runtimeHookStream = createRuntimeHookStreamFromEnv({
            workerId: process.env.RUNTIME_WORKER_ID,
            env: {
                ...process.env,
                RUNTIME_HOOK_SPOOL_MAX_BYTES: CONFIG.RUNTIME_HOOK_SPOOL_MAX_BYTES
                    || process.env.RUNTIME_HOOK_SPOOL_MAX_BYTES
            }
        });
        if (IS_EXECUTION_WORKER) {
            pluginManager.configureRuntimeHookBridge({ durableTransport: runtimeHookStream });
            runtimeHookRetryTimerId = setInterval(() => {
                pluginManager.runtimeHookBridge?.retryUnacked?.();
                runtimeHookStream?.flushSpool?.().catch(error => {
                    logger.error('[Runtime Hook] Spool flush failed:', error.message);
                });
            }, Number(process.env.RUNTIME_HOOK_RETRY_MS || 5000));
            runtimeHookRetryTimerId.unref?.();
        } else {
            usageEventStore = createUsageEventStore({
                dbPath: process.env.USAGE_EVENT_DB_PATH || path.join(process.cwd(), 'configs', 'usage-events', 'usage-events.sqlite')
            });
            runtimeUsageProjector = new RuntimeUsageProjector({
                store: usageEventStore,
                batchSize: Math.max(1, Number(CONFIG.USAGE_EVENT_BATCH_SIZE || process.env.USAGE_EVENT_BATCH_SIZE || 100)),
                executeProjectionBatch: (projectionName, items) => getPluginManager()?.executeUsageProjectionBatch?.(
                    projectionName,
                    items
                ),
                onFatalProjectionError: error => {
                    logger.error('[Usage Projection] Fatal batch failure; restarting control worker:', error.message);
                    setImmediate(() => process.exit(1));
                },
                onProgress: async () => {
                    usageEventStoreSnapshot = await usageEventStore?.snapshot?.();
                },
                executeProjection: async (projectionName, hookName, ...argsAndEventId) => {
                    const eventId = argsAndEventId.pop();
                    return getPluginManager()?.executeUsageProjection?.(
                        projectionName,
                        hookName,
                        argsAndEventId,
                        eventId
                    );
                }
            });
            usageEventStoreSnapshot = await usageEventStore.snapshot();
            const pruneUsageEvents = async () => {
                const retentionDays = Math.max(1, Number(CONFIG.USAGE_EVENT_RETENTION_DAYS || process.env.USAGE_EVENT_RETENTION_DAYS || 45));
                const before = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
                await usageEventStore?.prune({ before });
                usageEventStoreSnapshot = await usageEventStore?.snapshot();
            };
            await pruneUsageEvents();
            scheduleUsageProjectionRefresh().catch(error => logger.error('[Usage Projection] Startup drain failed:', error.message));
            usageEventMaintenanceTimerId = setInterval(() => {
                pruneUsageEvents()
                    .then(() => scheduleUsageProjectionRefresh())
                    .catch(error => logger.error('[Usage Ledger] Retention cleanup failed:', error.message));
            }, 24 * 60 * 60 * 1000);
            usageEventMaintenanceTimerId.unref?.();
            startRuntimeHookPolling();
        }
    } else if (!IS_WORKER_PROCESS) {
        usageEventStore = createUsageEventStore({
            dbPath: process.env.USAGE_EVENT_DB_PATH || path.join(process.cwd(), 'configs', 'usage-events', 'usage-events.sqlite')
        });
        runtimeUsageProjector = new RuntimeUsageProjector({
            store: usageEventStore,
            batchSize: Math.max(1, Number(CONFIG.USAGE_EVENT_BATCH_SIZE || process.env.USAGE_EVENT_BATCH_SIZE || 100)),
            executeProjectionBatch: (projectionName, items) => getPluginManager()?.executeUsageProjectionBatch?.(
                projectionName,
                items
            ),
            onFatalProjectionError: error => {
                logger.error('[Usage Projection] Fatal batch failure; restarting standalone worker:', error.message);
                setImmediate(() => process.exit(1));
            },
            onProgress: async () => {
                usageEventStoreSnapshot = await usageEventStore?.snapshot?.();
            },
            executeProjection: async (projectionName, hookName, ...argsAndEventId) => {
                const eventId = argsAndEventId.pop();
                return getPluginManager()?.executeUsageProjection?.(projectionName, hookName, argsAndEventId, eventId);
            }
        });
        usageEventStoreSnapshot = await usageEventStore.snapshot();
        pluginManager.configureRuntimeHookBridge({
            durableTransport: {
                publish: async event => {
                    const result = await runtimeHookConsumer.consumeBatch([event]);
                    usageEventStoreSnapshot = await usageEventStore.snapshot();
                    return { streamId: `local:${event.eventId}`, ...result };
                },
                acknowledge: async () => true,
                snapshot: () => ({
                    pending: Number(usageEventStoreSnapshot?.pending || 0),
                    consumerLag: Object.values(usageEventStoreSnapshot?.projections || {})
                        .reduce((total, projection) => total + Number(projection.lag || 0), 0)
                })
            }
        });
        scheduleUsageProjectionRefresh().catch(error => logger.error('[Usage Projection] Startup drain failed:', error.message));
        usageEventMaintenanceTimerId = setInterval(() => {
            const retentionDays = Math.max(1, Number(CONFIG.USAGE_EVENT_RETENTION_DAYS || process.env.USAGE_EVENT_RETENTION_DAYS || 45));
            const before = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
            usageEventStore?.prune({ before })
                .then(() => usageEventStore?.snapshot?.())
                .then(snapshot => { usageEventStoreSnapshot = snapshot; })
                .then(() => scheduleUsageProjectionRefresh())
                .catch(error => logger.error('[Usage Ledger] Standalone retention cleanup failed:', error.message));
        }, 24 * 60 * 60 * 1000);
        usageEventMaintenanceTimerId.unref?.();
    }
    if (startupShutdownGate.shouldAbort('plugin status logging')) return null;
    
    // Log loaded plugins
    const pluginList = pluginManager.getPluginList();
    if (pluginList.length > 0) {
        logger.info(`[Plugins] Loaded ${pluginList.length} plugin(s):`);
        pluginList.forEach(p => {
            const status = p.enabled ? '✓' : '✗';
            logger.info(`  ${status} ${p.name} v${p.version} - ${p.description}`);
        });
    }

    // Initialize API services
    const services = await initApiService(CONFIG, !IS_EXECUTION_WORKER, {
        coordination: runtimeCoordination,
        persistenceEnabled: !IS_EXECUTION_WORKER,
        stateEventSink: IS_WORKER_PROCESS && process.send
            ? event => process.send({ type: 'provider_state', event })
            : null,
        configEventSink: !IS_EXECUTION_WORKER && process.send
            ? event => process.send(event)
            : null,
        identityEventSink: IS_EXECUTION_WORKER && process.send
            ? event => process.send(event)
            : null
    });
    if (startupShutdownGate.shouldAbort('Codex prewarm service startup')) return null;
    codexPrewarmService = IS_EXECUTION_WORKER ? null : startCodexPrewarmService(CONFIG, getProviderPoolManager());
    if (startupShutdownGate.shouldAbort('usage cache auto refresh startup')) return null;
    usageCacheAutoRefreshService = IS_EXECUTION_WORKER ? null : startUsageCacheAutoRefreshService(CONFIG, getProviderPoolManager());
    if (startupShutdownGate.shouldAbort('UI management initialization')) return null;
    
    // Initialize UI management features
    if (!IS_EXECUTION_WORKER) initializeUIManagement(CONFIG);
    
    // Initialize API management and get heartbeat function
    const heartbeatAndRefreshToken = IS_EXECUTION_WORKER ? async () => {} : initializeAPIManagement(services);
    if (startupShutdownGate.shouldAbort('request handler creation')) return null;
    
    // Create request handler
    const requestHandlerInstance = createRequestHandler(CONFIG, getProviderPoolManager());
    if (startupShutdownGate.shouldAbort('HTTP server creation')) return null;

    serverInstance = http.createServer({
        // 设置服务器级别的超时
        requestTimeout: 0, // 禁用请求超时（流式响应需要）
        headersTimeout: 60000, // 头部超时 60 秒
        keepAliveTimeout: 65000 // Keep-alive 超时
    }, requestActivityTracker.wrapHttpHandler(requestHandlerInstance));

    // 设置服务器的最大连接数
    serverInstance.maxConnections = 1000;
    if (startupShutdownGate.shouldAbort('HTTP listen')) return null;
    const listeningServer = serverInstance;
    await new Promise((resolve, reject) => {
        let settled = false;
        let listeningCallbackStarted = false;
        const cleanupStartupListeners = () => {
            listeningServer.off('error', onListenError);
            listeningServer.off('close', onCloseBeforeReady);
        };
        const finishStartup = (error = null) => {
            if (settled) return;
            settled = true;
            cleanupStartupListeners();
            if (error) reject(error);
            else resolve();
        };
        const onListenError = error => finishStartup(error);
        const onCloseBeforeReady = () => {
            if (!listeningCallbackStarted && startupShutdownGate.isShutdownRequested()) {
                finishStartup();
            }
        };

        listeningServer.once('error', onListenError);
        listeningServer.once('close', onCloseBeforeReady);
        listeningServer.listen(CONFIG.SERVER_PORT, CONFIG.HOST, async () => {
            listeningCallbackStarted = true;
            try {
                if (startupShutdownGate.shouldAbort('listen callback')) {
                    finishStartup();
                    return;
                }
        logger.info(`--- Unified API Server Configuration ---`);
        const configuredProviders = Array.isArray(CONFIG.DEFAULT_MODEL_PROVIDERS) && CONFIG.DEFAULT_MODEL_PROVIDERS.length > 0
            ? CONFIG.DEFAULT_MODEL_PROVIDERS
            : [CONFIG.MODEL_PROVIDER];
        const uniqueProviders = [...new Set(configuredProviders)];
        logger.info(`  Primary Model Provider: ${CONFIG.MODEL_PROVIDER}`);
        if (uniqueProviders.length > 1) {
            logger.info(`  Additional Model Providers: ${uniqueProviders.slice(1).join(', ')}`);
        }
        logger.info(`  System Prompt File: ${CONFIG.SYSTEM_PROMPT_FILE_PATH || 'Default'}`);
        logger.info(`  System Prompt Mode: ${CONFIG.SYSTEM_PROMPT_MODE}`);
        logger.info(`  Host: ${CONFIG.HOST}`);
        logger.info(`  Port: ${CONFIG.SERVER_PORT}`);
        logger.info(`  Required API Key: ${CONFIG.REQUIRED_API_KEY ? CONFIG.REQUIRED_API_KEY.slice(0, 4) + '****' : '(none)'}`);
        logger.info(`  Prompt Logging: ${CONFIG.PROMPT_LOG_MODE}${CONFIG.PROMPT_LOG_FILENAME ? ` (to ${CONFIG.PROMPT_LOG_FILENAME})` : ''}`);
        logger.info(`------------------------------------------`);
        logger.info(`\nUnified API Server running on http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}`);
        logger.info(`Supports multiple API formats:`);
        logger.info(`  • OpenAI-compatible: /v1/chat/completions, /v1/responses, /v1/models`);
        logger.info(`  • Gemini-compatible: /v1beta/models, /v1beta/models/{model}:generateContent`);
        logger.info(`  • Claude-compatible: /v1/messages`);
        logger.info(`  • Health check: /health`);
        logger.info(`  • UI Management Console: http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/`);

        // Auto-open browser to UI (only if host is 0.0.0.0 or 127.0.0.1 and UI_ENABLED is true)
        if (CONFIG.UI_ENABLED) {
            try {
                const open = (await import('open')).default;
                if (startupShutdownGate.shouldAbort('UI launch timer')) {
                    finishStartup();
                    return;
                }
                // 作为子进程启动时，需要更长的延迟确保服务完全就绪
                const openDelay = IS_WORKER_PROCESS ? 3000 : 1000;
                setTimeout(() => {
                    if (startupShutdownGate.isShutdownRequested()) return;
                    let openUrl = `http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/login.html`;
                    if(CONFIG.HOST === '0.0.0.0'){
                        openUrl = `http://localhost:${CONFIG.SERVER_PORT}/login.html`;
                    }
                    open(openUrl)
                        .then(() => {
                            logger.info('[UI] Opened login page in default browser');
                        })
                        .catch(err => {
                            logger.info('[UI] Please open manually: http://' + CONFIG.HOST + ':' + CONFIG.SERVER_PORT + '/login.html');
                        });
                }, openDelay);
            } catch (err) {
                logger.info(`[UI] Login page available at: http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/login.html`);
            }
        } else {
            logger.info(`[UI] UI is disabled.`);
        }

        if (startupShutdownGate.shouldAbort('background timer setup')) {
            finishStartup();
            return;
        }

        if (!IS_EXECUTION_WORKER && CONFIG.CRON_REFRESH_TOKEN) {
            logger.info(`  • Cron Near Minutes: ${CONFIG.CRON_NEAR_MINUTES}`);
            logger.info(`  • Cron Refresh Token: ${CONFIG.CRON_REFRESH_TOKEN}`);
            // 每 CRON_NEAR_MINUTES 分钟执行一次心跳日志和令牌刷新
            heartbeatTimerId = setInterval(() => {
                heartbeatActivityTracker.run(heartbeatAndRefreshToken).catch(error => {
                    logger.error('[Heartbeat] Scheduled refresh failed:', error);
                });
            }, CONFIG.CRON_NEAR_MINUTES * 60 * 1000);
        }
        // 服务器完全启动后,执行初始健康检查
        const poolManager = getProviderPoolManager();
        if (!IS_EXECUTION_WORKER && poolManager) {
            logger.info('[Initialization] Performing initial health checks for provider pools...');
            healthCheckActivityTracker.run(async () => poolManager.performInitialHealthChecks()).catch(error => {
                logger.error('[Initialization] Initial health checks failed:', error);
            });
        }

        // 定时健康检查
        // 注意：无论初始 enabled 状态如何，都注册 reloadHealthCheckTimer，
        // 使得热更新时（从 disabled→enabled）config-api 能调用它启动 timer。
        const scheduledConfig = CONFIG.SCHEDULED_HEALTH_CHECK;
        if (!IS_EXECUTION_WORKER) {
            const DEFAULT_INTERVAL = CONFIG.CRON_NEAR_MINUTES * 60 * 1000;

            let isHealthCheckRunning = false;
            let healthCheckTimerId = null;
            let healthCheckStartupTimerId = null;

            // 定时健康检查函数（始终注册，无论初始 enabled 状态）
            const runHealthCheckTimer = (interval) => {
                // 清除旧的 timer
                if (healthCheckTimerId) {
                    clearInterval(healthCheckTimerId);
                    healthCheckTimerId = null;
                }
                // 重置运行状态，允许新的 timer 立即触发
                // 否则如果 reload 时正在运行，新 timer 的第一次触发会被跳过
                isHealthCheckRunning = false;

                // 设置定时任务
                // 设计决策：只验证最小值，不设最大值。
                // 前端有 max=3600000 (1小时) 的 UI 限制，但后端允许更大值以支持特殊需求。
                const safeInterval = (typeof interval === 'number' && interval >= HEALTH_CHECK.MIN_INTERVAL_MS) ? interval : DEFAULT_INTERVAL;
                healthCheckTimerId = setInterval(() => {
                    if (isHealthCheckRunning) {
                        logger.debug('[ScheduledHealthCheck] Skipping - previous run still in progress');
                        return;
                    }
                    isHealthCheckRunning = true;
                    healthCheckActivityTracker.run(() => poolManager.performHealthChecks())
                        .catch(error => {
                            logger.error('[ScheduledHealthCheck] Error:', error);
                        })
                        .finally(() => {
                            isHealthCheckRunning = false;
                        });
                }, safeInterval);
                logger.info(`[ScheduledHealthCheck] Scheduled every ${safeInterval}ms`);
                return safeInterval;
            };

            // 注册重载/停止函数到 globalThis（供 config-api 热更新使用）
            // 必须在 enabled 检查外注册，保证热更新时可访问
            globalThis.reloadHealthCheckTimer = runHealthCheckTimer;
            globalThis.stopHealthCheckTimer = async () => {
                if (healthCheckTimerId) {
                    clearInterval(healthCheckTimerId);
                    healthCheckTimerId = null;
                    logger.info('[ScheduledHealthCheck] Timer stopped');
                }
                if (healthCheckStartupTimerId) {
                    clearTimeout(healthCheckStartupTimerId);
                    healthCheckStartupTimerId = null;
                }
                await healthCheckActivityTracker.waitForIdle();
            };

            if (scheduledConfig?.enabled) {
                let interval = scheduledConfig.interval;
                if (typeof interval !== 'number' || interval < HEALTH_CHECK.MIN_INTERVAL_MS) {
                    logger.warn(`[ScheduledHealthCheck] Invalid interval ${interval}, using default ${DEFAULT_INTERVAL}`);
                    interval = DEFAULT_INTERVAL;
                }

                // 启动时运行健康检查
                if (scheduledConfig.startupRun !== false) {
                    logger.info('[ScheduledHealthCheck] Running scheduled health check on startup...');
                    healthCheckStartupTimerId = setTimeout(() => {
                        healthCheckStartupTimerId = null;
                        if (startupShutdownGate.isShutdownRequested()) return;
                        healthCheckActivityTracker.run(() => poolManager.performHealthChecks()).catch(error => {
                            logger.error('[ScheduledHealthCheck] Startup run error:', error);
                        });
                    }, 100);
                }

                // 设置定时任务
                const activeInterval = runHealthCheckTimer(interval);
                globalThis._activeHealthCheckInterval = activeInterval;
            }
        }

        // 如果是子进程，通知主进程已就绪
        if (startupShutdownGate.shouldAbort('worker ready notification')) {
            finishStartup();
            return;
        }
        if (IS_EXECUTION_WORKER && runtimeCoordination?.synchronize) {
            const coordinationStatus = await waitForCoordinationReady(runtimeCoordination);
            logger.info(`[Runtime] Coordination recovery barrier ready: ${coordinationStatus.readyWorkers}/${runtimeCoordination.expectedWorkers}`);
        }
        if (IS_WORKER_PROCESS) {
            const potluckPlugin = getPluginManager()?.getEnabledPlugins?.().find(plugin => plugin.name === 'api-potluck');
            const potluckKeyConfigState = potluckPlugin?.getKeyConfigSyncState?.() || {
                epoch: null,
                revision: potluckPlugin?.getKeyRoutingRevision?.() || 0
            };
            sendToMaster({ type: 'runtime_metrics', snapshot: buildRuntimeMetricsSnapshot() });
            runtimeMetricsTimerId = setInterval(() => {
                sendToMaster({ type: 'runtime_metrics', snapshot: buildRuntimeMetricsSnapshot() });
            }, 5000);
            runtimeMetricsTimerId.unref?.();
            sendToMaster({
                type: 'ready',
                pid: process.pid,
                providerConfigRevision: getProviderPoolManager()?.providerConfigRevision || 0,
                potluckKeyConfigEpoch: potluckKeyConfigState.epoch,
                potluckKeyConfigRevision: potluckKeyConfigState.revision,
                potluckKeyRoutingRevision: potluckKeyConfigState.revision
            });
        }
                finishStartup();
            } catch (error) {
                finishStartup(error);
            }
        });
    });
    return serverInstance; // Return the server instance for testing purposes
}

const shutdownHandlers = registerWorkerShutdownHandlers({
    processRef: process,
    isWorkerProcess: IS_WORKER_PROCESS,
    requestShutdown: gracefulShutdown,
    isRetryableNetworkError,
    logger,
    onRuntimeMessage: message => {
        if (message.type === 'provider_state' && message.event) {
            getProviderPoolManager()?.applyRemoteProviderState?.(message.event);
            return true;
        }
        if (message.type === 'provider_config_sync' && IS_EXECUTION_WORKER) {
            const manager = getProviderPoolManager();
            const result = manager?.applyProviderConfigSync?.(message);
            if (result?.applied) {
                CONFIG.providerPools = manager.providerPools;
                for (const uuid of result.changedUuids) invalidateServiceAdapter(message.providerType, uuid);
                sendToMaster({ type: 'provider_config_sync_ack', revision: result.revision });
            }
            return true;
        }
        if (message.type === 'provider_config_sync_status' && RUNTIME_WORKER_ROLE === 'control') {
            globalThis.providerConfigSyncStatus = message;
            return true;
        }
        if (message.type === 'potluck_key_config_sync' && IS_EXECUTION_WORKER) {
            const plugin = getPluginManager()?.getEnabledPlugins?.().find(candidate => candidate.name === 'api-potluck');
            const result = plugin?.applyKeyConfigSync?.(message);
            const ack = buildKeyConfigSyncAck(result);
            sendToMaster({
                type: 'potluck_key_config_sync_ack',
                ...ack
            });
            return true;
        }
        if (message.type === 'potluck_key_config_sync_status' && RUNTIME_WORKER_ROLE === 'control') {
            globalThis.potluckKeyConfigSyncStatus = message;
            globalThis.potluckKeyRoutingSyncStatus = message;
            return true;
        }
        if (message.type === 'provider_identity_discovered' && RUNTIME_WORKER_ROLE === 'control') {
            getProviderPoolManager()?.reconcileProviderIdentity?.(
                message.providerType,
                message.providerUuid,
                message.identity
            ).catch(error => logger.error('[Provider Identity] Failed to reconcile discovered identity:', error.message));
            return true;
        }
        if (message.type === 'request_audit_raw_capture_sync' && IS_EXECUTION_WORKER) {
            const result = applyRawCaptureRuntimeConfig(message);
            sendToMaster({ type: 'request_audit_raw_capture_sync_ack', revision: result.revision });
            return true;
        }
        if (message.type === 'request_audit_raw_capture_sync_status' && RUNTIME_WORKER_ROLE === 'control') {
            globalThis.rawCaptureConfigSyncStatus = message;
            return true;
        }
        if (message.type === 'runtime_hook' && RUNTIME_WORKER_ROLE === 'control') {
            runtimeHookConsumer.consumeBatch([message]).catch(error => {
                logger.error('[Runtime Hook] Failed to apply remote hook:', error.message);
            });
            return true;
        }
        if (message.type === 'runtime_hook_ack' && IS_EXECUTION_WORKER) {
            getPluginManager()?.runtimeHookBridge?.ack?.(message.eventId).catch?.(error => {
                logger.error('[Runtime Hook] Failed to acknowledge local event:', error.message);
            });
            return true;
        }
        if (message.type === 'runtime_hook_retry' && IS_EXECUTION_WORKER) {
            getPluginManager()?.runtimeHookBridge?.retryUnacked?.();
            return true;
        }
        return false;
    },
    sendStatus: data => sendToMaster({ type: 'status', data }),
    getStatus: () => ({
        pid: process.pid,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage()
    })
});

startupPromise = startServer();
startupPromise.catch(shutdownHandlers.onStartFailure);

// 导出用于外部调用
export { gracefulShutdown, sendToMaster };
