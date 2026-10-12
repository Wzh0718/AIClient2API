/**
 * 共享常量定义
 * 集中管理各处使用的硬编码值
 */

// 定时健康检查相关常量
export const HEALTH_CHECK = {
    // 最小检查间隔：60秒（60000毫秒）
    MIN_INTERVAL_MS: 60000,
    // 默认检查间隔：10分钟（600000毫秒）
    DEFAULT_INTERVAL_MS: 600000,
    // 最大检查间隔：1小时（3600000毫秒）- 仅用于前端UI限制
    MAX_INTERVAL_MS: 3600000
};

// 密码安全相关常量
export const PASSWORD = {
    // 最小密码长度（最少12位，与现代安全实践一致）
    MIN_LENGTH: 12,
    // PBKDF2迭代次数（OWASP 2023建议 SHA-512 ≥310,000次）
    PBKDF2_ITERATIONS: 310000,
    // PBKDF2密钥长度（字节）
    PBKDF2_KEYLEN: 64,
    // PBKDF2哈希算法
    PBKDF2_DIGEST: 'sha512'
};

// 网络相关常量
export const NETWORK = {
    // 最小端口号
    MIN_PORT: 1,
    // 最大端口号
    MAX_PORT: 65535,
    // 默认服务器端口
    DEFAULT_PORT: 3000,
    // 默认超时时间（毫秒）
    DEFAULT_TIMEOUT: 120000
};

// 请求重试相关常量
export const RETRY = {
    // 最大重试次数
    MAX_RETRIES: 100
};

// 协议前缀常量
export const MODEL_PROTOCOL_PREFIX = {
    GEMINI: 'gemini',
    OPENAI: 'openai',
    OPENAI_RESPONSES: 'openaiResponses',
    CLAUDE: 'claude',
    CODEX: 'codex',
    FORWARD: 'forward',
    GROK: 'grok',
};

// 提供商标识符常量
export const MODEL_PROVIDER = {
    GEMINI_CLI: 'gemini-cli-oauth',
    ANTIGRAVITY: 'gemini-antigravity',
    OPENAI_CUSTOM: 'openai-custom',
    ATLASCLOUD: 'atlascloud',
    OPENAI_CUSTOM_RESPONSES: 'openaiResponses-custom',
    CLAUDE_CUSTOM: 'claude-custom',
    KIRO_API: 'claude-kiro-oauth',
    QWEN_API: 'openai-qwen-oauth',
    IFLOW_API: 'openai-iflow',
    CODEX_API: 'openai-codex-oauth',
    FORWARD_API: 'forward-api',
    GROK_WEB: 'grok-web',
    GROK_CLI: 'grok-cli-oauth',
    AUTO: 'auto',
};

// 图像生成模型常量
export const SUPPORTED_IMAGE_MODELS = new Set([
    'gpt-image-2',
    'gpt-image-2.5',
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst',
    'grok-imagine-image-quality',
    'grok-imagine-image',
    'grok-imagine-image-pro',
    'grok-imagine-1.0',
    'grok-imagine-1.0-edit',
    'gemini-3.1-flash-image'
]);

const GPT_IMAGE_25_SNAPSHOT = /^(gpt-image-2\.5-(?:flare|sunburst))(?:-\d{4}-\d{2}-\d{2})?$/;

export function resolveGptImageModelAlias(model) {
    const normalized = String(model || '').trim();
    return normalized === 'gpt-image-2.5' ? 'gpt-image-2.5-flare' : normalized;
}

export function isSupportedGptImageModel(model) {
    const normalized = resolveGptImageModelAlias(model);
    return normalized === 'gpt-image-2' || GPT_IMAGE_25_SNAPSHOT.test(normalized);
}

export function isSupportedImageApiModel(model) {
    const normalized = String(model || '').trim();
    if (SUPPORTED_IMAGE_MODELS.has(normalized) || isSupportedGptImageModel(normalized)) return true;
    // /v1/models 暴露的 Codex 图像 -fast 变体（priority 档位）；gpt-image-2.5 别名没有 -fast 变体。
    const base = normalized.replace(/-fast$/i, '');
    return base !== normalized && base !== 'gpt-image-2.5' && isSupportedGptImageModel(base);
}

// 视频生成模型常量
export const SUPPORTED_VIDEO_MODELS = new Set([
    'grok-imagine-video',
    'grok-imagine-video-1.5-preview',
    'grok-imagine-video-1.5-2026-05-30'
]);

// UI 相关的路径常量
export const UI_PATHS = {
    // 静态文件和基础路径前缀
    STATIC_PREFIXES: ['/static/', '/app/', '/components/'],
    // 静态文件精确匹配路径
    STATIC_EXACT: ['/', '/favicon.ico', '/index.html', '/login.html'],
    // API 路径前缀
    API_PREFIX: '/api/',
    // API 白名单（即使在禁用 UI 时也允许访问）
    API_WHITELIST: ['/api/health', '/api/grok/assets', '/api/login', '/api/help', '/api/example']
};
