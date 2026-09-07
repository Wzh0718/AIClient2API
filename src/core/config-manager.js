import * as fs from 'fs';
import { promises as pfs } from 'fs';
import { DEFAULT_REQUEST_BODY_MAX_BYTES, INPUT_SYSTEM_PROMPT_FILE } from '../utils/common.js';
import { MODEL_PROVIDER } from '../utils/constants.js';
import { normalizeAspectMismatchThreshold } from '../utils/image-size-normalizer.js';
import { ANTIGRAVITY_ELASTIC_MODEL_ORDER } from '../providers/antigravity-model-order.js';
import logger from '../utils/logger.js';

export let CONFIG = {}; // Make CONFIG exportable
export let PROMPT_LOG_FILENAME = ''; // Make PROMPT_LOG_FILENAME exportable

const ALL_MODEL_PROVIDERS = Object.values(MODEL_PROVIDER);
const BYTES_PER_MB = 1024 * 1024;
const ANTIGRAVITY_ELASTIC_ROUTING_DEFAULTS = Object.freeze({
    enabled: true,
    maxQueueWaitMs: 30_000,
    preferOriginalWaitMs: 5_000,
    fallbackModels: [...ANTIGRAVITY_ELASTIC_MODEL_ORDER],
    globalQueueLimit: 512,
    perKeyModelQueueLimit: 256,
    globalQueuedBytesLimit: 64 * BYTES_PER_MB,
    recoveryJitterMinMs: 50,
    recoveryJitterMaxMs: 250
});

function parsePositiveInteger(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }

    return Math.floor(parsed);
}

function normalizeRequestBodyMaxBytes(config) {
    const envBytes = parsePositiveInteger(process.env.REQUEST_BODY_MAX_BYTES);
    if (envBytes !== null) {
        config.REQUEST_BODY_MAX_BYTES = envBytes;
        return;
    }

    const envMb = parsePositiveInteger(process.env.REQUEST_BODY_MAX_MB);
    if (envMb !== null) {
        config.REQUEST_BODY_MAX_BYTES = envMb * BYTES_PER_MB;
        return;
    }

    const configuredBytes = parsePositiveInteger(config.REQUEST_BODY_MAX_BYTES);
    config.REQUEST_BODY_MAX_BYTES = configuredBytes ?? DEFAULT_REQUEST_BODY_MAX_BYTES;
}

function normalizeLogRetentionDays(config) {
    const envDays = parsePositiveInteger(process.env.LOG_RETENTION_DAYS);
    if (envDays !== null) {
        config.LOG_RETENTION_DAYS = envDays;
        return;
    }

    const configuredDays = parsePositiveInteger(config.LOG_RETENTION_DAYS);
    config.LOG_RETENTION_DAYS = configuredDays ?? 7;
}

function normalizeCodexFingerprintEnabled(config) {
    const envValue = process.env.CODEX_FINGERPRINT_ENABLED;
    if (envValue !== undefined) {
        const normalized = String(envValue).trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) config.CODEX_FINGERPRINT_ENABLED = true;
        else if (['false', '0', 'no', 'off'].includes(normalized)) config.CODEX_FINGERPRINT_ENABLED = false;
    }
    if (config.CODEX_FINGERPRINT_ENABLED === undefined || config.CODEX_FINGERPRINT_ENABLED === null) {
        config.CODEX_FINGERPRINT_ENABLED = false;
    }
}

function normalizeAntigravityElasticRouting(config) {
    const incoming = config.antigravityElasticRouting;
    config.antigravityElasticRouting = {
        ...ANTIGRAVITY_ELASTIC_ROUTING_DEFAULTS,
        ...(incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {})
    };
}

function normalizeConfiguredProviders(config) {
    const fallbackProvider = MODEL_PROVIDER.GEMINI_CLI;
    const dedupedProviders = [];

    const addProvider = (value) => {
        if (typeof value !== 'string') {
            return;
        }
        const trimmed = value.trim();
        if (!trimmed) {
            return;
        }

        // 1. 优先尝试精确匹配基础类型
        const matched = ALL_MODEL_PROVIDERS.find((provider) => provider.toLowerCase() === trimmed.toLowerCase());
        if (matched) {
            if (!dedupedProviders.includes(matched)) {
                dedupedProviders.push(matched);
            }
            return;
        }

        // 2. 尝试前缀匹配 (支持带后缀的自定义分组，例如 openai-custom-1)
        const prefixMatch = ALL_MODEL_PROVIDERS.find((provider) => 
            provider !== 'auto' && trimmed.toLowerCase().startsWith(provider.toLowerCase() + '-')
        );
        
        if (prefixMatch) {
            if (!dedupedProviders.includes(trimmed)) {
                dedupedProviders.push(trimmed);
            }
            return;
        }

        logger.warn(`[Config Warning] Unknown model provider '${trimmed}'. This entry will be ignored.`);
    };

    const rawValue = config.MODEL_PROVIDER;
    if (Array.isArray(rawValue)) {
        rawValue.forEach((entry) => addProvider(typeof entry === 'string' ? entry : String(entry)));
    } else if (typeof rawValue === 'string') {
        rawValue.split(',').forEach(addProvider);
    } else if (rawValue != null) {
        addProvider(String(rawValue));
    }

    if (dedupedProviders.length === 0) {
        dedupedProviders.push(fallbackProvider);
    }

    config.DEFAULT_MODEL_PROVIDERS = dedupedProviders;
    config.MODEL_PROVIDER = dedupedProviders[0];
}

/**
 * Initializes the server configuration from config.json and command-line arguments.
 * @param {string[]} args - Command-line arguments.
 * @param {string} [configFilePath='configs/config.json'] - Path to the configuration file.
 * @returns {Object} The initialized configuration object.
 */
export async function initializeConfig(args = process.argv.slice(2), configFilePath = 'configs/config.json') {
    const defaultConfig = {
        REQUIRED_API_KEY: "123456",
        SERVER_PORT: 3000,
        HOST: '0.0.0.0',
        MODEL_PROVIDER: MODEL_PROVIDER.GEMINI_CLI,
        SYSTEM_PROMPT_FILE_PATH: INPUT_SYSTEM_PROMPT_FILE, // Default value
        SYSTEM_PROMPT_MODE: 'append',
        PROXY_URL: null, // HTTP/HTTPS/SOCKS5 代理地址，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
        PROXY_ENABLED_PROVIDERS: [], // 启用代理的提供商列表，如 ['gemini-cli-oauth', 'claude-kiro-oauth']
        PROMPT_LOG_BASE_NAME: "prompt_log",
        PROMPT_LOG_MODE: "none",
        REQUEST_MAX_RETRIES: 3,
        REQUEST_BASE_DELAY: 1000,
        CODEX_RATE_LIMIT_RETRY_DELAY_MS: 800,
        CODEX_RATE_LIMIT_RETRY_MAX_DELAY_MS: 30000,
        CODEX_OVERLOAD_RETRY_MAX_ATTEMPTS: 3,
        CODEX_OVERLOAD_RETRY_DELAY_MS: 800,
        CODEX_OVERLOAD_RETRY_MAX_DELAY_MS: 5000,
        CODEX_GROUP_RATE_LIMIT_WAIT_MS: 30000,
        CODEX_RETRY_MAX_DURATION_MS: 300000,
        CODEX_POOL_SNAPSHOT_TTL_MS: 3000,
        MODEL_LIST_CACHE_TTL_MS: 300000,
        API_POTLUCK_PERSIST_INTERVAL: 30_000,
        API_POTLUCK_MAX_DIRTY_AGE: 60_000,
        API_POTLUCK_DEFAULT_DAILY_LIMIT: 500,
        MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS: 30_000,
        USAGE_EVENT_BATCH_SIZE: 100,
        USAGE_EVENT_STREAM_READ_BATCH_SIZE: null,
        USAGE_EVENT_BATCH_WAIT_MS: 1000,
        USAGE_EVENT_BATCH_FLUSH_MS: 1000,
        USAGE_EVENT_PROJECTION_BATCH_SIZE: 100,
        USAGE_EVENT_INGEST_QUEUE_MAX: null,
        USAGE_EVENT_STATUS_POLL_MS: 1000,
        USAGE_EVENT_CLAIM_INTERVAL_MS: 5000,
        REQUEST_SUCCESS_LOG_MODE: 'compact',
        REQUEST_SUCCESS_LOG_SAMPLE_RATE: 1,
        USAGE_EVENT_RETENTION_DAYS: 45,
        USAGE_HOURLY_RETENTION_DAYS: 90,
        USAGE_DAILY_RETENTION_DAYS: 400,
        USAGE_SQLITE_WAL_CHECKPOINT_BYTES: 64 * 1024 * 1024,
        RUNTIME_HOOK_SPOOL_MAX_BYTES: 256 * 1024 * 1024,
        MODEL_USAGE_STATS_MAX_DIRTY_AGE_MS: 60_000,
        MODEL_FALLBACK_ENABLED: true, // 模型不存在时是否自动 fallback 到默认/映射模型
        REQUEST_BODY_MAX_BYTES: DEFAULT_REQUEST_BODY_MAX_BYTES,
        CREDENTIAL_SWITCH_MAX_RETRIES: 5, // 坏凭证切换最大重试次数（用于认证错误后切换凭证）
        RATE_LIMIT_COOLDOWN_ENABLED: false, // 429 限流后是否短暂冷却账号
        RATE_LIMIT_COOLDOWN_MS: 30000, // 429 限流默认冷却时间（毫秒）
        RATE_LIMIT_COOLDOWN_JITTER_MS: 5000, // 429 限流冷却随机抖动（毫秒）
        RATE_LIMIT_COOLDOWN_MAX_MS: 300000, // Retry-After 允许的最大冷却时间（毫秒）
        IMAGE_PROVIDER_ROUND_ROBIN_ENABLED: true, // 生图请求是否在同类型健康账号池内严格轮询
        IMAGE_SIZE_NORMALIZATION_ENABLED: true, // Codex Images 接口是否将返回图片缩放到请求尺寸
        IMAGE_PROMPT_ASPECT_CONSTRAINT_ENABLED: true, // Codex 生图提示词是否追加最小画幅比例约束
        IMAGE_ASPECT_MISMATCH_THRESHOLD: 0.10, // 原图与目标长宽比偏差超过此值时拒绝拉伸
        CODEX_FINGERPRINT_ENABLED: false, // Codex OAuth 出站设备指纹收敛总开关，默认关闭；需全局和凭据双重显式启用
        IMAGE_SIZE_MAX_PIXELS: 8388608, // 后处理允许的最大目标总像素（约 4K UHD）
        CODEX_POTLUCK_STICKY_PROVIDER_ENABLED: false, // API Potluck 分发 Key 是否固定到同一个 Codex 账号
        CODEX_STICKY_HOT_SHARD_ENABLED: true, // Codex sticky 热 key 是否自动拆分到多个账号
        CODEX_STICKY_HOT_SHARD_WINDOW_MS: 3600000, // 热 key 统计窗口，默认60分钟
        CODEX_STICKY_HOT_SHARD_MIN_REQUESTS: 100, // 窗口内达到多少次请求后开始分片
        CODEX_STICKY_HOT_SHARD_MAX_SHARDS: 5, // 单个热 key 最多拆到几个账号
        CODEX_PROVIDER_SELECTION_SLOW_WARN_MS: 50, // provider 选择耗时超过该阈值时记录 warn
        CODEX_PREWARM_ENABLED: false, // 是否按固定时间对所有启用的 Codex 账号做轻量预热请求；默认关闭，需显式 opt-in
        CODEX_PREWARM_TIMES: ['06:30', '11:30'], // Asia/Shanghai 每日预热时间
        CODEX_PREWARM_ATTEMPTS: 2, // 每个账号在每个预热时间点触发次数
        CODEX_PREWARM_TIMEZONE: 'Asia/Shanghai',
        CODEX_PREWARM_DUE_WINDOW_MS: 600000,
        CODEX_PREWARM_POLL_INTERVAL_MS: 60000,
        CODEX_PREWARM_STATE_FILE: 'configs/codex-prewarm-state.json',
        CODEX_PREWARM_MODEL: 'gpt-5-codex-mini',
        CRON_NEAR_MINUTES: 15,
        CRON_REFRESH_TOKEN: false,
        LOGIN_EXPIRY: 3600, // 登录过期时间（秒），默认1小时
        LOGIN_MAX_ATTEMPTS: 5, // 最大失败重试次数
        LOGIN_LOCKOUT_DURATION: 1800, // 锁定持续时间（秒），默认30分钟
        LOGIN_MIN_INTERVAL: 5000, // 两次尝试之间的最小间隔（毫秒），默认1秒
        TRUST_PROXY: false, // 是否信任反向代理传入的 x-forwarded-for
        TRUSTED_PROXY_IPS: ['127.0.0.1', '::1'], // 允许提供 x-forwarded-for 的反向代理 IP 列表
        REQUEST_AUDIT_NETWORK_METADATA_ENABLED: false, // 是否将请求网络元数据写入审计事件
        PROVIDER_POOLS_FILE_PATH: null, // 新增号池配置文件路径
        PROXY_POOLS_FILE_PATH: null, // 集中代理池配置文件路径
        MAX_ERROR_COUNT: 10, // 提供商最大错误次数
        CUSTOM_MODELS_FILE_PATH: null, // 自定义模型配置文件路径
        SYSTEM_PROMPT_REPLACEMENTS: [], // 系统提示词内容替换规则，例如: [{"old": "AI", "new": "Bot"}, {"old": "OpenAI", "new": "Gemini"}]
        SCHEDULED_HEALTH_CHECK: {
            enabled: false,
            interval: 600000,
            startupRun: false
        },
        USAGE_CACHE_AUTO_REFRESH: {
            enabled: true,
            interval: 600000,
            startupRun: true
        },
        providerFallbackChain: {}, // 跨类型 Fallback 链配置
        antigravityElasticRouting: { ...ANTIGRAVITY_ELASTIC_ROUTING_DEFAULTS },
        temporaryKeyModelRoutes: [], // 临时按 Key 哈希、入口和模型进行跨 Provider 路由；默认关闭
        workdayCalendars: {}, // 可选的法定工作日历；缺失年份时路由层按周一至周五保护性降级
        LOG_ENABLED: true,
        LOG_OUTPUT_MODE: "all",
        LOG_LEVEL: "info",
        LOG_DIR: "logs",
        LOG_INCLUDE_REQUEST_ID: true,
        REQUEST_PERF_SAMPLE_RATE: 0,
        REQUEST_PERF_SLOW_MS: 0,
        LOG_INCLUDE_TIMESTAMP: true,
        LOG_MAX_FILE_SIZE: 10485760,
        LOG_MAX_FILES: 10,
        LOG_RETENTION_DAYS: 7,
        CODEX_RETRY_AUDIT_ENABLED: true,
        CODEX_RETRY_AUDIT_DIR: 'configs/retry-audit',
        CODEX_RETRY_AUDIT_MAX_FILE_SIZE: 25 * 1024 * 1024,
        CODEX_RETRY_AUDIT_MAX_FILES: 7,
        CODEX_RETRY_AUDIT_RETENTION_DAYS: 7,
        TLS_SIDECAR_ENABLED: false, // 启用 Go uTLS sidecar（需要编译 tls-sidecar 二进制）
        TLS_SIDECAR_ENABLED_PROVIDERS: [], // 启用 TLS Sidecar 的提供商列表
        TLS_SIDECAR_PORT: 9090,     // sidecar 监听端口
        TLS_SIDECAR_BINARY_PATH: null, // 自定义二进制路径（默认自动搜索）
        TLS_SIDECAR_PROXY_URL: null,    // TLS Sidecar 专用的上游代理地址
        UI_ENABLED: true           // 是否启用前端管理界面
    };

    let currentConfig = { ...defaultConfig };

    try {
        const configData = fs.readFileSync(configFilePath, 'utf8');
        const loadedConfig = JSON.parse(configData);
        Object.assign(currentConfig, loadedConfig);
        if (
            loadedConfig.MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS === undefined
            && loadedConfig.MODEL_USAGE_STATS_PERSIST_INTERVAL !== undefined
        ) {
            currentConfig.MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS = loadedConfig.MODEL_USAGE_STATS_PERSIST_INTERVAL;
        }
        logger.info('[Config] Loaded configuration from configs/config.json');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.error('[Config Error] Failed to load configs/config.json:', error.message);
        } else {
            logger.info('[Config] configs/config.json not found, using default configuration.');
        }
    }


    // CLI argument definitions: { flag, configKey, type, validValues? }
    // type: 'string' | 'int' | 'bool' | 'enum'
    const cliArgDefs = [
        { flag: '--api-key',              configKey: 'REQUIRED_API_KEY',       type: 'string' },
        { flag: '--log-prompts',          configKey: 'PROMPT_LOG_MODE',        type: 'enum', validValues: ['console', 'file'] },
        { flag: '--port',                 configKey: 'SERVER_PORT',            type: 'int' },
        { flag: '--model-provider',       configKey: 'MODEL_PROVIDER',         type: 'string' },
        { flag: '--system-prompt-file',   configKey: 'SYSTEM_PROMPT_FILE_PATH', type: 'string' },
        { flag: '--system-prompt-mode',   configKey: 'SYSTEM_PROMPT_MODE',     type: 'enum', validValues: ['overwrite', 'append'] },
        { flag: '--host',                 configKey: 'HOST',                   type: 'string' },
        { flag: '--prompt-log-base-name', configKey: 'PROMPT_LOG_BASE_NAME',   type: 'string' },
        { flag: '--request-max-retries',  configKey: 'REQUEST_MAX_RETRIES',    type: 'int' },
        { flag: '--model-fallback-enabled', configKey: 'MODEL_FALLBACK_ENABLED', type: 'bool' },
        { flag: '--request-body-max-bytes', configKey: 'REQUEST_BODY_MAX_BYTES', type: 'int' },
        { flag: '--rate-limit-cooldown-enabled', configKey: 'RATE_LIMIT_COOLDOWN_ENABLED', type: 'bool' },
        { flag: '--rate-limit-cooldown-ms', configKey: 'RATE_LIMIT_COOLDOWN_MS', type: 'int' },
        { flag: '--rate-limit-cooldown-jitter-ms', configKey: 'RATE_LIMIT_COOLDOWN_JITTER_MS', type: 'int' },
        { flag: '--rate-limit-cooldown-max-ms', configKey: 'RATE_LIMIT_COOLDOWN_MAX_MS', type: 'int' },
        { flag: '--image-provider-round-robin-enabled', configKey: 'IMAGE_PROVIDER_ROUND_ROBIN_ENABLED', type: 'bool' },
        { flag: '--image-size-normalization-enabled', configKey: 'IMAGE_SIZE_NORMALIZATION_ENABLED', type: 'bool' },
        { flag: '--image-prompt-aspect-constraint-enabled', configKey: 'IMAGE_PROMPT_ASPECT_CONSTRAINT_ENABLED', type: 'bool' },
        { flag: '--image-aspect-mismatch-threshold', configKey: 'IMAGE_ASPECT_MISMATCH_THRESHOLD', type: 'float' },
        { flag: '--image-size-max-pixels', configKey: 'IMAGE_SIZE_MAX_PIXELS', type: 'int' },
        { flag: '--codex-fingerprint-enabled', configKey: 'CODEX_FINGERPRINT_ENABLED', type: 'bool' },
        { flag: '--codex-potluck-sticky-provider-enabled', configKey: 'CODEX_POTLUCK_STICKY_PROVIDER_ENABLED', type: 'bool' },
        { flag: '--codex-sticky-hot-shard-enabled', configKey: 'CODEX_STICKY_HOT_SHARD_ENABLED', type: 'bool' },
        { flag: '--codex-sticky-hot-shard-window-ms', configKey: 'CODEX_STICKY_HOT_SHARD_WINDOW_MS', type: 'int' },
        { flag: '--codex-sticky-hot-shard-min-requests', configKey: 'CODEX_STICKY_HOT_SHARD_MIN_REQUESTS', type: 'int' },
        { flag: '--codex-sticky-hot-shard-max-shards', configKey: 'CODEX_STICKY_HOT_SHARD_MAX_SHARDS', type: 'int' },
        { flag: '--codex-provider-selection-slow-warn-ms', configKey: 'CODEX_PROVIDER_SELECTION_SLOW_WARN_MS', type: 'int' },
        { flag: '--codex-group-rate-limit-wait-ms', configKey: 'CODEX_GROUP_RATE_LIMIT_WAIT_MS', type: 'int' },
        { flag: '--codex-prewarm-enabled', configKey: 'CODEX_PREWARM_ENABLED', type: 'bool' },
        { flag: '--codex-prewarm-times', configKey: 'CODEX_PREWARM_TIMES', type: 'stringList' },
        { flag: '--codex-prewarm-attempts', configKey: 'CODEX_PREWARM_ATTEMPTS', type: 'int' },
        { flag: '--codex-prewarm-timezone', configKey: 'CODEX_PREWARM_TIMEZONE', type: 'string' },
        { flag: '--codex-prewarm-due-window-ms', configKey: 'CODEX_PREWARM_DUE_WINDOW_MS', type: 'int' },
        { flag: '--codex-prewarm-poll-interval-ms', configKey: 'CODEX_PREWARM_POLL_INTERVAL_MS', type: 'int' },
        { flag: '--codex-prewarm-state-file', configKey: 'CODEX_PREWARM_STATE_FILE', type: 'string' },
        { flag: '--codex-prewarm-model', configKey: 'CODEX_PREWARM_MODEL', type: 'string' },
        { flag: '--cron-near-minutes',    configKey: 'CRON_NEAR_MINUTES',      type: 'int' },
        { flag: '--cron-refresh-token',   configKey: 'CRON_REFRESH_TOKEN',     type: 'bool' },
        { flag: '--provider-pools-file',  configKey: 'PROVIDER_POOLS_FILE_PATH', type: 'string' },
        { flag: '--custom-models-file',   configKey: 'CUSTOM_MODELS_FILE_PATH', type: 'string' },
        { flag: '--max-error-count',      configKey: 'MAX_ERROR_COUNT',        type: 'int' },
        { flag: '--login-max-attempts',   configKey: 'LOGIN_MAX_ATTEMPTS',     type: 'int' },
        { flag: '--login-lockout-duration', configKey: 'LOGIN_LOCKOUT_DURATION', type: 'int' },
        { flag: '--login-min-interval',   configKey: 'LOGIN_MIN_INTERVAL',     type: 'int' },
        { flag: '--trust-proxy',          configKey: 'TRUST_PROXY',            type: 'bool' },
        { flag: '--trusted-proxy-ips',    configKey: 'TRUSTED_PROXY_IPS',      type: 'stringList' },
        { flag: '--log-retention-days',   configKey: 'LOG_RETENTION_DAYS',     type: 'int' },
        { flag: '--scheduled-health-check-enabled', configKey: 'SCHEDULE_HEALTH_CHECK_ENABLED', type: 'bool' },
        { flag: '--scheduled-health-check-interval', configKey: 'SCHEDULE_HEALTH_CHECK_INTERVAL', type: 'int' },
        { flag: '--no-ui',                configKey: 'UI_ENABLED',            type: 'flag', value: false },
        { flag: '--ui',                   configKey: 'UI_ENABLED',            type: 'bool' }
    ];

    // Parse command-line arguments using definitions
    const flagMap = new Map(cliArgDefs.map(def => [def.flag, def]));
    for (let i = 0; i < args.length; i++) {
        const def = flagMap.get(args[i]);
        if (!def) continue;

        if (def.type !== 'flag' && i + 1 >= args.length) {
            logger.warn(`[Config Warning] ${def.flag} flag requires a value.`);
            continue;
        }

        const rawValue = def.type === 'flag' ? null : args[++i];
        switch (def.type) {
            case 'flag':
                currentConfig[def.configKey] = def.value;
                break;
            case 'string':
                currentConfig[def.configKey] = rawValue;
                break;
            case 'stringList':
                currentConfig[def.configKey] = rawValue.split(',').map(item => item.trim()).filter(Boolean);
                break;
            case 'int':
                currentConfig[def.configKey] = parseInt(rawValue, 10);
                break;
            case 'float':
                currentConfig[def.configKey] = parseFloat(rawValue);
                break;
            case 'bool':
                currentConfig[def.configKey] = rawValue.toLowerCase() === 'true';
                break;
            case 'enum':
                if (def.validValues.includes(rawValue)) {
                    currentConfig[def.configKey] = rawValue;
                } else {
                    logger.warn(`[Config Warning] Invalid value for ${def.flag}. Expected one of: ${def.validValues.join(', ')}.`);
                }
                break;
        }
    }

    // 合并定时健康检查的 CLI 配置
    if (currentConfig.SCHEDULE_HEALTH_CHECK_ENABLED !== undefined) {
        currentConfig.SCHEDULED_HEALTH_CHECK.enabled = currentConfig.SCHEDULE_HEALTH_CHECK_ENABLED;
    }
    if (currentConfig.SCHEDULE_HEALTH_CHECK_INTERVAL !== undefined) {
        currentConfig.SCHEDULED_HEALTH_CHECK.interval = currentConfig.SCHEDULE_HEALTH_CHECK_INTERVAL;
    }

    normalizeRequestBodyMaxBytes(currentConfig);
    normalizeLogRetentionDays(currentConfig);
    normalizeCodexFingerprintEnabled(currentConfig);
    normalizeAntigravityElasticRouting(currentConfig);
    normalizeConfiguredProviders(currentConfig);
    currentConfig.IMAGE_ASPECT_MISMATCH_THRESHOLD = normalizeAspectMismatchThreshold(
        currentConfig.IMAGE_ASPECT_MISMATCH_THRESHOLD
    );

    if (!currentConfig.SYSTEM_PROMPT_FILE_PATH) {
        currentConfig.SYSTEM_PROMPT_FILE_PATH = INPUT_SYSTEM_PROMPT_FILE;
    }
    currentConfig.SYSTEM_PROMPT_CONTENT = await getSystemPromptFileContent(currentConfig.SYSTEM_PROMPT_FILE_PATH);

    // 加载号池配置
    if (!currentConfig.PROVIDER_POOLS_FILE_PATH) {
        currentConfig.PROVIDER_POOLS_FILE_PATH = 'configs/provider_pools.json';
    }
    if (!currentConfig.PROXY_POOLS_FILE_PATH) {
        currentConfig.PROXY_POOLS_FILE_PATH = 'configs/proxy-pools.json';
    }
    if (currentConfig.PROVIDER_POOLS_FILE_PATH) {
        try {
            const poolsData = await pfs.readFile(currentConfig.PROVIDER_POOLS_FILE_PATH, 'utf8');
            currentConfig.providerPools = JSON.parse(poolsData);
            logger.info(`[Config] Loaded provider pools from ${currentConfig.PROVIDER_POOLS_FILE_PATH}`);
        } catch (error) {
            logger.error(`[Config Error] Failed to load provider pools from ${currentConfig.PROVIDER_POOLS_FILE_PATH}: ${error.message}`);
            currentConfig.providerPools = {};
        }
    } else {
        currentConfig.providerPools = {};
    }

    // 加载自定义模型配置
    if (!currentConfig.CUSTOM_MODELS_FILE_PATH) {
        currentConfig.CUSTOM_MODELS_FILE_PATH = 'configs/custom_models.json';
    }
    try {
        if (fs.existsSync(currentConfig.CUSTOM_MODELS_FILE_PATH)) {
            const customModelsData = fs.readFileSync(currentConfig.CUSTOM_MODELS_FILE_PATH, 'utf8');
            currentConfig.customModels = JSON.parse(customModelsData);
            logger.info(`[Config] Loaded custom models from ${currentConfig.CUSTOM_MODELS_FILE_PATH}`);
        } else {
            currentConfig.customModels = [];
        }
    } catch (error) {
        logger.error(`[Config Error] Failed to load custom models from ${currentConfig.CUSTOM_MODELS_FILE_PATH}: ${error.message}`);
        currentConfig.customModels = [];
    }

    // Set PROMPT_LOG_FILENAME based on the determined config
    if (currentConfig.PROMPT_LOG_MODE === 'file') {
        const now = new Date();
        const pad = (num) => String(num).padStart(2, '0');
        const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        PROMPT_LOG_FILENAME = `${currentConfig.PROMPT_LOG_BASE_NAME}-${timestamp}.log`;
    } else {
        PROMPT_LOG_FILENAME = ''; // Clear if not logging to file
    }

    // Assign to the exported CONFIG
    Object.assign(CONFIG, currentConfig);

    // Initialize logger
    logger.initialize({
        enabled: CONFIG.LOG_ENABLED ?? true,
        outputMode: CONFIG.LOG_OUTPUT_MODE || "all",
        logLevel: CONFIG.LOG_LEVEL || "info",
        logDir: CONFIG.LOG_DIR || "logs",
        includeRequestId: CONFIG.LOG_INCLUDE_REQUEST_ID ?? true,
        includeTimestamp: CONFIG.LOG_INCLUDE_TIMESTAMP ?? true,
        maxFileSize: CONFIG.LOG_MAX_FILE_SIZE || 10485760,
        maxFiles: CONFIG.LOG_MAX_FILES || 10,
        retentionDays: CONFIG.LOG_RETENTION_DAYS || 7
    });

    // Cleanup old logs periodically
    logger.cleanupOldLogs();

    return CONFIG;
}

/**
 * Gets system prompt content from the specified file path.
 * @param {string} filePath - Path to the system prompt file.
 * @returns {Promise<string|null>} File content, or null if the file does not exist, is empty, or an error occurs.
 */
export async function getSystemPromptFileContent(filePath) {
    try {
        await pfs.access(filePath, pfs.constants.F_OK);
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.warn(`[System Prompt] Specified system prompt file not found: ${filePath}`);
        } else {
            logger.error(`[System Prompt] Error accessing system prompt file ${filePath}: ${error.message}`);
        }
        return null;
    }

    try {
        const content = await pfs.readFile(filePath, 'utf8');
        if (!content.trim()) {
            return null;
        }
        logger.info(`[System Prompt] Loaded system prompt from ${filePath}`);
        return content;
    } catch (error) {
        logger.error(`[System Prompt] Error reading system prompt file ${filePath}: ${error.message}`);
        return null;
    }
}

export { ALL_MODEL_PROVIDERS };
