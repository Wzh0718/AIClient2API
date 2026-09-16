import { OAuth2Client } from 'google-auth-library';
import logger from '../utils/logger.js';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { broadcastEvent } from '../services/ui-manager.js';
import { autoLinkProviderConfigs, replaceProviderCredentialPath } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';
import { getGoogleAuthProxyConfig, parseProxyUrl } from '../utils/proxy-utils.js';
import { resolveProxyPoolEntry } from '../utils/proxy-pool-store.js';
import { extractGeminiCredentialEmail, extractGeminiCredentialSub, extractGeminiIdTokenClaims } from '../utils/gemini-account.js';

/**
 * OAuth 提供商配置
 */
const OAUTH_PROVIDERS = {
    'gemini-cli-oauth': {
        clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
        clientSecret: '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',
        port: 8085,
        credentialsDir: '.gemini',
        credentialsFile: 'oauth_creds.json',
        scope: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email'],
        logPrefix: '[Gemini Auth]'
    },
    'gemini-antigravity': {
        clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
        clientSecret: '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',
        port: 8086,
        credentialsDir: '.antigravity',
        credentialsFile: 'oauth_creds.json',
        scope: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email'],
        logPrefix: '[Antigravity Auth]'
    }
};

/**
 * 活动的服务器实例管理
 */
const activeServers = new Map();
const oauthSessions = new Map();
const latestSessions = new Map();
const transitionLocks = new Map();

async function withProviderTransitionLock(provider, operation) {
    const previous = transitionLocks.get(provider) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    transitionLocks.set(provider, current);
    await previous;
    try {
        return await operation();
    } finally {
        release();
        if (transitionLocks.get(provider) === current) transitionLocks.delete(provider);
    }
}

export function createGeminiPkce() {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

export function assertGeminiOAuthProxyAvailable(config = {}, proxyId = '') {
    const normalizedProxyId = String(proxyId || '').trim();
    if (!normalizedProxyId) return null;

    const proxyEntry = resolveProxyPoolEntry({ ...config, PROXY_ID: normalizedProxyId });
    if (!proxyEntry || !parseProxyUrl(proxyEntry.url)) {
        throw new Error(`Selected proxy node is unavailable: ${normalizedProxyId}`);
    }
    return proxyEntry;
}

export function createGeminiOAuthTransporterOptions(config = {}, providerKey, options = {}) {
    if (options.forceDirect) return { proxy: false };
    if (options.selectedProxyUrl) {
        const selected = parseProxyUrl(options.selectedProxyUrl);
        if (!selected) throw new Error('Selected proxy URL is invalid or unsupported');
        return { proxy: false, agent: selected.httpsAgent };
    }

    const configured = getGoogleAuthProxyConfig(config, providerKey);
    return configured ? { ...configured, proxy: false } : { proxy: false };
}

/**
 * 生成 HTML 响应页面
 * @param {boolean} isSuccess - 是否成功
 * @param {string} message - 显示消息
 * @param {string|null} provider - 提供商标识
 * @returns {string} HTML 内容
 */
function generateResponsePage(isSuccess, message, provider = null) {
    const title = isSuccess ? '授权成功！' : '授权失败';
    const countdownHtml = isSuccess ? `
        <p>此窗口将在 <span id="countdown" style="font-weight: bold; color: #2196f3;">10</span> 秒后自动关闭。</p>
        <script>
            const notifyOpener = () => {
                try {
                    if (window.opener && !window.opener.closed) {
                        window.opener.postMessage({
                            type: 'oauth-popup-complete',
                            provider: ${JSON.stringify(provider)},
                            success: true
                        }, window.location.origin);
                    }
                } catch (e) {}
            };
            notifyOpener();
            setTimeout(() => {
                try {
                    window.close();
                } catch (e) {}
            }, 300);
            let countdown = 10;
            const timer = setInterval(() => {
                countdown--;
                const el = document.getElementById('countdown');
                if (el) el.textContent = countdown;
                if (countdown <= 0) {
                    clearInterval(timer);
                    window.close();
                }
            }, 1000);
        </script>` : '';
    
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background-color: #f5f5f5;
        }
        .container {
            text-align: center;
            padding: 2rem;
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            max-width: 400px;
            width: 90%;
        }
        h1 { color: ${isSuccess ? '#4caf50' : '#f44336'}; margin-top: 0; }
        p { color: #666; line-height: 1.6; }
    </style>
</head>
<body>
    <div class="container">
        <h1>${isSuccess ? '✅' : '❌'} ${title}</h1>
        <p>${message}</p>
        ${countdownHtml}
    </div>
</body>
</html>`;
}

/**
 * 关闭指定端口的活动服务器
 * @param {number} port - 端口号
 * @returns {Promise<void>}
 */
async function closeActiveServer(provider, port = null) {
    const existing = activeServers.get(provider);
    if (existing) {
        if (existing.pollTimer) {
            clearInterval(existing.pollTimer);
            existing.pollTimer = null;
        }
        try {
            if (existing.server?.listening) {
                await Promise.race([
                    new Promise(resolve => existing.server.close(() => resolve())),
                    new Promise(resolve => setTimeout(resolve, 2000))
                ]);
            }
        } catch (error) {
            logger.warn(`[OAuth] Failed to close ${provider} callback server: ${error.message}`);
        } finally {
            activeServers.delete(provider);
        }
    }
    if (port) {
        for (const [p, info] of activeServers.entries()) {
            if (info.port === port) await closeActiveServer(p);
        }
    }
}

/**
 * 创建 OAuth 回调服务器
 * @param {Object} config - OAuth 提供商配置
 * @param {string} redirectUri - 重定向 URI
 * @param {OAuth2Client} authClient - OAuth2 客户端
 * @param {string} credPath - 凭据保存路径
 * @param {string} provider - 提供商标识
 * @returns {Promise<http.Server>} HTTP 服务器实例
 */
async function createOAuthCallbackServer(config, session) {
    const { provider, port, redirectUri } = session;
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            const callbackUrl = new URL(req.url, redirectUri);
            const state = callbackUrl.searchParams.get('state');
            const code = callbackUrl.searchParams.get('code');
            const errorParam = callbackUrl.searchParams.get('error');

            if (state !== session.sessionId) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(false, 'OAuth state 无效或已过期', provider));
                return;
            }

            try {
                if (errorParam) {
                    const errorMessage = `授权失败。Google 返回错误: ${errorParam}`;
                    finishGeminiSession(session, errorMessage);
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(generateResponsePage(false, errorMessage, provider));
                    return;
                }
                if (!code) {
                    res.writeHead(204);
                    res.end();
                    return;
                }

                await completeGeminiOAuthSession(session, code);
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(true, '您可以关闭此页面', provider));
            } catch (error) {
                logger.error(`${config.logPrefix} OAuth callback failed:`, error);
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateResponsePage(false, `服务器错误: ${error.message}`, provider));
            } finally {
                if (server.listening) server.close(() => activeServers.delete(provider));
            }
        });
        server.on('error', (err) => {
            reject(err.code === 'EADDRINUSE' ? new Error(`端口 ${port} 已被占用`) : err);
        });
        server.listen(port, '0.0.0.0', () => {
            session.server = server;
            session.pollTimer = setTimeout(() => {
                finishGeminiSession(session, 'OAuth authorization timed out');
                if (server.listening) server.close(() => activeServers.delete(provider));
            }, 5 * 60 * 1000);
            activeServers.set(provider, session);
            resolve(server);
        });
    });
}

function resolveTargetProviderConfig(currentConfig, providerKey, targetProviderUuid) {
    if (!targetProviderUuid) return {};
    const providers = currentConfig.providerPools?.[providerKey];
    return Array.isArray(providers)
        ? (providers.find(provider => provider?.uuid === targetProviderUuid) || {})
        : {};
}

async function removeGeneratedCredential(credPath) {
    if (!credPath) return;
    const root = path.resolve(process.cwd(), 'configs');
    const absolute = path.resolve(credPath);
    const relative = path.relative(root, absolute);
    if (!relative || path.isAbsolute(relative) || relative.startsWith('..')) return;
    try { await fs.promises.unlink(absolute); } catch (error) {
        if (error.code !== 'ENOENT') logger.warn(`[Gemini Auth] Failed to remove credential: ${error.message}`);
    }
}

async function resolveGeminiOAuthAccountEmail(session, tokens) {
    if (tokens?.access_token && typeof session.authClient.getTokenInfo === 'function') {
        try {
            const tokenInfo = await session.authClient.getTokenInfo(tokens.access_token);
            if (typeof tokenInfo?.email === 'string' && tokenInfo.email.trim()) {
                return tokenInfo.email.trim();
            }
        } catch (error) {
            logger.warn(`${session.config.logPrefix} Account email lookup failed, falling back to id_token: ${error.message}`);
        }
    }
    return extractGeminiCredentialEmail(tokens);
}

function getGeminiTokenIdentity(tokens = {}) {
    const claims = extractGeminiIdTokenClaims(tokens.id_token);
    return {
        sub: claims.sub || extractGeminiCredentialSub(tokens),
        email: claims.email || (typeof tokens.email === 'string' ? tokens.email.trim() : '')
    };
}

function matchGeminiIdentity(a = {}, b = {}) {
    if (a.sub && b.sub) return a.sub === b.sub;
    if (a.email && b.email) return a.email.toLowerCase() === b.email.toLowerCase();
    return false;
}

/**
 * 按账号唯一标识（id_token sub，fallback email）检查同账号凭据是否已存在。
 * @returns {Promise<{isDuplicate: boolean, existingPath?: string, existingEmail?: string, poolUuid?: string, customName?: string}>}
 */
export async function findGeminiAccountDuplicate(providerType, tokens) {
    const config = OAUTH_PROVIDERS[providerType];
    if (!config) return { isDuplicate: false };

    const identity = getGeminiTokenIdentity(tokens);
    if (!identity.sub && !identity.email) return { isDuplicate: false };

    const providerDir = config.credentialsDir.replace('.', '');
    const targetDir = path.join(process.cwd(), 'configs', providerDir);
    let existingPath = '';
    let existingEmail = '';

    try {
        if (fs.existsSync(targetDir)) {
            const files = await fs.promises.readdir(targetDir);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                const fullPath = path.join(targetDir, file);
                try {
                    const credentials = JSON.parse(await fs.promises.readFile(fullPath, 'utf8'));
                    const candidate = {
                        sub: extractGeminiCredentialSub(credentials),
                        email: extractGeminiCredentialEmail(credentials)
                    };
                    if (matchGeminiIdentity(identity, candidate)) {
                        existingPath = path.relative(process.cwd(), fullPath);
                        existingEmail = candidate.email || identity.email;
                        break;
                    }
                } catch {
                    // 忽略无法解析的凭据文件
                }
            }
        }
    } catch (error) {
        logger.warn(`[Gemini Auth] Error finding account duplicate for ${providerType}:`, error.message);
        return { isDuplicate: false };
    }

    if (!existingPath) return { isDuplicate: false };

    let poolUuid = '';
    let customName = '';
    try {
        const providers = CONFIG.providerPools?.[providerType] || [];
        const matched = providers.find(provider => {
            const credPath = provider?.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH || provider?.GEMINI_OAUTH_CREDS_FILE_PATH || '';
            return credPath && path.resolve(credPath) === path.resolve(existingPath);
        });
        if (matched) {
            poolUuid = matched.uuid || '';
            customName = matched.customName || '';
        }
    } catch (error) {
        logger.warn(`[Gemini Auth] Failed to locate pool entry for duplicate credential: ${error.message}`);
    }

    return { isDuplicate: true, existingPath, existingEmail, poolUuid, customName };
}

async function persistGeminiCredentials(session, tokens, accountEmail = '') {
    const providerDir = session.options.providerDir || session.config.credentialsDir.replace('.', '');
    const finalCredPath = session.options.saveToConfigs
        ? path.join(process.cwd(), 'configs', providerDir, `${Date.now()}_oauth_creds.json`)
        : path.join(os.homedir(), session.config.credentialsDir, session.config.credentialsFile);
    await fs.promises.mkdir(path.dirname(finalCredPath), { recursive: true });
    const storedTokens = accountEmail ? { ...tokens, email: accountEmail } : tokens;
    await fs.promises.writeFile(finalCredPath, JSON.stringify(storedTokens, null, 2), { mode: 0o600 });
    const relativePath = path.relative(process.cwd(), finalCredPath);
    let customName = accountEmail;

    try {
        if (session.targetProviderUuid) {
            const result = await replaceProviderCredentialPath(CONFIG, {
                providerType: session.provider,
                providerUuid: session.targetProviderUuid,
                credPath: relativePath,
                accountEmail,
                ...(session.proxyOverrideProvided ? { proxyId: session.proxyId } : {})
            });
            customName = result?.provider?.customName || session.targetProviderConfig?.customName || accountEmail;
        } else {
            await autoLinkProviderConfigs(CONFIG, {
                onlyCurrentCred: true,
                credPath: relativePath,
                providerDefaults: {
                    ...(session.proxyId ? { PROXY_ID: session.proxyId } : {}),
                    ...(accountEmail ? { accountEmail, customName: accountEmail } : {})
                },
                throwOnPersistError: true
            });
        }
    } catch (error) {
        await removeGeneratedCredential(finalCredPath);
        throw error;
    }
    return { credPath: finalCredPath, relativePath, accountEmail, customName: customName || '' };
}

function finishGeminiSession(session, errorMessage = '') {
    if (!session) return;
    oauthSessions.delete(session.sessionId);
    if (latestSessions.get(session.provider) === session.sessionId) latestSessions.delete(session.provider);
    if (session.pollTimer) clearTimeout(session.pollTimer);
    if (errorMessage) {
        broadcastEvent('oauth_error', {
            provider: session.provider,
            sessionId: session.sessionId,
            targetProviderUuid: session.targetProviderUuid,
            error: errorMessage,
            timestamp: new Date().toISOString()
        });
    }
}

async function completeGeminiOAuthSession(session, code) {
    if (!oauthSessions.has(session.sessionId)) throw new Error('Invalid or expired OAuth session');
    oauthSessions.delete(session.sessionId);
    try {
        const { tokens } = await session.authClient.getToken({
            code,
            codeVerifier: session.pkce.verifier,
            redirect_uri: session.redirectUri
        });
        const accountEmail = await resolveGeminiOAuthAccountEmail(session, tokens);
        if (!accountEmail) {
            throw new Error('无法解析 Google 账号邮箱（tokenInfo 与 id_token 均失败），已取消保存。请重新授权或检查网络/代理后重试。');
        }
        await withProviderTransitionLock(session.provider, async () => {
            if (latestSessions.get(session.provider) !== session.sessionId) {
                throw new Error('OAuth authorization was replaced by a newer request');
            }
            if (!session.targetProviderUuid) {
                const duplicate = await findGeminiAccountDuplicate(session.provider, tokens);
                if (duplicate.isDuplicate) {
                    const target = duplicate.poolUuid
                        ? `现有条目 uuid=${duplicate.poolUuid}${duplicate.customName ? `（${duplicate.customName}）` : ''}`
                        : `现有凭据 ${duplicate.existingPath}`;
                    throw new Error(`该账号（${duplicate.existingEmail || accountEmail}）已存在：${target}。请对现有条目使用刷新/替换功能，而非重新授权。`);
                }
            }
            const credentials = await persistGeminiCredentials(session, tokens, accountEmail);
            broadcastEvent('oauth_success', {
                provider: session.provider,
                sessionId: session.sessionId,
                targetProviderUuid: session.targetProviderUuid,
                ...credentials,
                timestamp: new Date().toISOString()
            });
            latestSessions.delete(session.provider);
        });
    } catch (error) {
        finishGeminiSession(session, error.message);
        throw error;
    } finally {
        if (session.pollTimer) clearTimeout(session.pollTimer);
    }
}

/**
 * 处理 Google OAuth 授权（通用函数）
 * @param {string} providerKey - 提供商键名
 * @param {Object} currentConfig - 当前配置对象
 * @param {Object} options - 额外选项
 * @returns {Promise<Object>} 返回授权URL和相关信息
 */
async function handleGoogleOAuth(providerKey, currentConfig, options = {}) {
    const config = OAUTH_PROVIDERS[providerKey];
    if (!config) {
        throw new Error(`未知的提供商: ${providerKey}`);
    }
    
    const targetProviderUuid = typeof options.targetProviderUuid === 'string' ? options.targetProviderUuid.trim() : null;
    const hasProxyOverride = Object.prototype.hasOwnProperty.call(options, 'proxyId');
    if (hasProxyOverride && typeof options.proxyId !== 'string') throw new Error('proxyId must be a string when provided');
    const targetProviderConfig = resolveTargetProviderConfig(currentConfig, providerKey, targetProviderUuid);
    const selectedProxyId = targetProviderUuid
        ? (hasProxyOverride ? options.proxyId.trim() : String(targetProviderConfig.PROXY_ID || '').trim())
        : String(options.proxyId || options.PROXY_ID || '').trim();
    const authConfig = { ...currentConfig, ...targetProviderConfig };
    if (selectedProxyId) authConfig.PROXY_ID = selectedProxyId;
    else if (hasProxyOverride) delete authConfig.PROXY_ID;

    const selectedProxy = assertGeminiOAuthProxyAvailable(authConfig, selectedProxyId);
    const port = parseInt(options.port) || config.port;
    const host = 'localhost';
    const redirectUri = `http://${host}:${port}`;

    const oauth2Options = {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        transporterOptions: createGeminiOAuthTransporterOptions(authConfig, providerKey, {
            forceDirect: hasProxyOverride && !selectedProxyId,
            selectedProxyUrl: selectedProxy?.url || null
        })
    };
    const authClient = new OAuth2Client(oauth2Options);
    authClient.redirectUri = redirectUri;
    const state = crypto.randomBytes(32).toString('base64url');
    const pkce = createGeminiPkce();
    const authUrl = authClient.generateAuthUrl({
        access_type: 'offline',
        prompt: 'select_account',
        scope: config.scope,
        state,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256'
    });

    await withProviderTransitionLock(providerKey, async () => {
        const previousId = latestSessions.get(providerKey);
        const previous = previousId ? oauthSessions.get(previousId) : null;
        if (previous) finishGeminiSession(previous, 'OAuth authorization was replaced by a newer request');
        await closeActiveServer(providerKey, port);
        const session = {
            provider: providerKey,
            config,
            authClient,
            redirectUri,
            port,
            sessionId: state,
            pkce,
            targetProviderUuid,
            targetProviderConfig,
            proxyId: selectedProxyId,
            proxyOverrideProvided: hasProxyOverride,
            options,
            server: null,
            pollTimer: null
        };
        latestSessions.set(providerKey, state);
        oauthSessions.set(state, session);
        try {
            await createOAuthCallbackServer(config, session);
        } catch (error) {
            finishGeminiSession(session);
            throw new Error(`启动回调服务器失败: ${error.message}`);
        }
    });

    return {
        success: true,
        authUrl,
        authInfo: {
            provider: providerKey,
            method: 'oauth2-pkce',
            sessionId: state,
            redirectUri,
            port,
            targetProviderUuid,
            proxyId: selectedProxyId || null,
            proxyOverrideProvided: hasProxyOverride
        }
    };
}

/**
 * 处理 Gemini CLI OAuth 授权
 * @param {Object} currentConfig - 当前配置对象
 * @param {Object} options - 额外选项
 * @returns {Promise<Object>} 返回授权URL和相关信息
 */
export async function handleGeminiCliOAuth(currentConfig, options = {}) {
    return handleGoogleOAuth('gemini-cli-oauth', currentConfig, options);
}

/**
 * 处理 Gemini Antigravity OAuth 授权
 * @param {Object} currentConfig - 当前配置对象
 * @param {Object} options - 额外选项
 * @returns {Promise<Object>} 返回授权URL和相关信息
 */
export async function handleGeminiAntigravityOAuth(currentConfig, options = {}) {
    return handleGoogleOAuth('gemini-antigravity', currentConfig, options);
}

/**
 * 检查 Gemini 凭据是否已存在（基于 refresh_token）
 * @param {string} providerType - 提供商类型
 * @param {string} refreshToken - 要检查的 refreshToken
 * @returns {Promise<{isDuplicate: boolean, existingPath?: string}>} 检查结果
 */
export async function checkGeminiCredentialsDuplicate(providerType, refreshToken, tokens = null) {
    const config = OAUTH_PROVIDERS[providerType];
    if (!config) return { isDuplicate: false };

    const providerDir = config.credentialsDir.replace('.', '');
    const targetDir = path.join(process.cwd(), 'configs', providerDir);
    
    try {
        const identity = tokens ? getGeminiTokenIdentity(tokens) : null;
        if (!fs.existsSync(targetDir)) {
            return { isDuplicate: false };
        }

        const files = await fs.promises.readdir(targetDir);
        for (const file of files) {
            if (file.endsWith('.json')) {
                try {
                    const fullPath = path.join(targetDir, file);
                    const content = await fs.promises.readFile(fullPath, 'utf8');
                    const credentials = JSON.parse(content);

                    if (credentials.refresh_token === refreshToken) {
                        const relativePath = path.relative(process.cwd(), fullPath);
                        return {
                            isDuplicate: true,
                            existingPath: relativePath
                        };
                    }
                    if (identity) {
                        const candidate = {
                            sub: extractGeminiCredentialSub(credentials),
                            email: extractGeminiCredentialEmail(credentials)
                        };
                        if (matchGeminiIdentity(identity, candidate)) {
                            const relativePath = path.relative(process.cwd(), fullPath);
                            return {
                                isDuplicate: true,
                                existingPath: relativePath
                            };
                        }
                    }
                } catch (e) {
                    // 忽略解析错误
                }
            }
        }
        return { isDuplicate: false };
    } catch (error) {
        logger.warn(`[Gemini Auth] Error checking duplicates for ${providerType}:`, error.message);
        return { isDuplicate: false };
    }
}

/**
 * 批量导入 Gemini Token 并生成凭据文件（流式版本，支持实时进度回调）
 * @param {string} providerType - 提供商类型 ('gemini-cli-oauth' 或 'gemini-antigravity')
 * @param {Object[]} tokens - Token 对象数组
 * @param {Function} onProgress - 进度回调函数
 * @param {boolean} skipDuplicateCheck - 是否跳过重复检查 (默认: false)
 * @returns {Promise<Object>} 批量处理结果
 */
export async function batchImportGeminiTokensStream(providerType, tokens, onProgress = null, skipDuplicateCheck = false) {
    const config = OAUTH_PROVIDERS[providerType];
    if (!config) {
        throw new Error(`未知的提供商: ${providerType}`);
    }

    const results = {
        total: tokens.length,
        success: 0,
        failed: 0,
        details: []
    };
    
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const progressData = {
            index: i + 1,
            total: tokens.length,
            current: null
        };
        
        try {
            // 验证 token 是否包含必需字段 (通常是 access_token 和 refresh_token)
            if (!token.access_token || !token.refresh_token) {
                throw new Error('Token 缺少必需字段 (access_token 或 refresh_token)');
            }

            // 检查重复
            if (!skipDuplicateCheck) {
                const duplicateCheck = await checkGeminiCredentialsDuplicate(providerType, token.refresh_token, token);
                if (duplicateCheck.isDuplicate) {
                    progressData.current = {
                        index: i + 1,
                        success: false,
                        error: 'duplicate',
                        existingPath: duplicateCheck.existingPath
                    };
                    results.failed++;
                    results.details.push(progressData.current);
                    if (onProgress) {
                        onProgress({
                            ...progressData,
                            successCount: results.success,
                            failedCount: results.failed
                        });
                    }
                    continue;
                }
            }

            // 生成文件路径
            const timestamp = Date.now();
            const providerDir = config.credentialsDir.replace('.', ''); // 去掉开头的点
            const targetDir = path.join(process.cwd(), 'configs', providerDir);
            await fs.promises.mkdir(targetDir, { recursive: true });
            
            const filename = `${timestamp}_${i}_oauth_creds.json`;
            const credPath = path.join(targetDir, filename);
            
            await fs.promises.writeFile(credPath, JSON.stringify(token, null, 2));
            
            const relativePath = path.relative(process.cwd(), credPath);
            
            logger.info(`${config.logPrefix} Token ${i + 1} 已导入并保存: ${relativePath}`);
            
            progressData.current = {
                index: i + 1,
                success: true,
                path: relativePath
            };
            results.success++;

            // 自动关联新生成的凭据到 Pools
            await autoLinkProviderConfigs(CONFIG, {
                onlyCurrentCred: true,
                credPath: relativePath
            });
            
        } catch (error) {
            logger.error(`${config.logPrefix} Token ${i + 1} 导入失败:`, error.message);
            
            progressData.current = {
                index: i + 1,
                success: false,
                error: error.message
            };
            results.failed++;
        }
        
        results.details.push(progressData.current);

        // 发送进度更新
        if (onProgress) {
            onProgress({
                ...progressData,
                successCount: results.success,
                failedCount: results.failed
            });
        }
    }
    
    // 如果有成功的，广播事件
    if (results.success > 0) {
        broadcastEvent('oauth_batch_success', {
            provider: providerType,
            count: results.success,
            timestamp: new Date().toISOString()
        });
    }
    
    return results;
}
