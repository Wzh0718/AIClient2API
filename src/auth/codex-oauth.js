import http from 'http';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import open from 'open';
import axios from 'axios';
import { broadcastEvent } from '../services/ui-manager.js';
import { autoLinkProviderConfigs, replaceProviderCredentialPath } from '../services/service-manager.js';
import { CONFIG } from '../core/config-manager.js';
import { configureAxiosProxy, parseProxyUrl } from '../utils/proxy-utils.js';
import { resolveProxyPoolEntry } from '../utils/proxy-pool-store.js';
import { attachCodexSubscriptionWindow, buildCodexRedirectUri } from '../utils/codex-utils.js';
import { generateCodexCallbackPage } from './codex-oauth-response-page.js';

/**
 * Codex OAuth 配置
 */
const CODEX_OAUTH_CONFIG = {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    redirectUri: buildCodexRedirectUri('localhost'),
    port: 1455,
    scopes: 'openid email profile offline_access',
    logPrefix: '[Codex Auth]'
};

/**
 * 活动的服务器实例管理（与 gemini-oauth 一致）
 */
const activeServers = new Map();
let codexOAuthTransition = Promise.resolve();

function withCodexOAuthTransitionLock(operation) {
    const run = codexOAuthTransition.then(operation, operation);
    codexOAuthTransition = run.then(() => undefined, () => undefined);
    return run;
}

function setLatestCodexOAuthSession(sessionId) {
    global.codexOAuthLatestSessionId = sessionId;
}

function clearLatestCodexOAuthSession(sessionId) {
    if (global.codexOAuthLatestSessionId === sessionId) {
        delete global.codexOAuthLatestSessionId;
    }
}

function assertLatestCodexOAuthSession(sessionId) {
    const latestSessionId = global.codexOAuthLatestSessionId;
    if (latestSessionId && latestSessionId !== sessionId) {
        throw new Error('OAuth authorization was replaced by a newer request');
    }
}

function sanitizeCodexCredentialFilenamePart(value) {
    const sanitized = String(value || 'default')
        .trim()
        .replace(/[^a-zA-Z0-9@._+-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 120);

    return sanitized || 'default';
}

/**
 * 关闭指定端口的活动服务器
 */
async function closeActiveServer(provider, port = null) {
    const existing = activeServers.get(provider);
    
    if (existing) {
        try {
            // 1. 使用 Promise.race() 添加 2 秒超时
            const closePromise = new Promise((resolve, reject) => {
                existing.server.close((err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Server close timeout after 2s')), 2000);
            });

            await Promise.race([closePromise, timeoutPromise]);
            logger.info(`[Codex Auth] ${provider} server closed successfully`);
        } catch (error) {
            // 2. try-catch 捕获错误
            logger.warn(`[Codex Auth] Server close failed or timed out: ${error.message}`);
        } finally {
            // 3. finally 块强制清理，防止阻塞
            activeServers.delete(provider);
        }
    }

    if (port) {
        for (const [p, info] of activeServers.entries()) {
            if (info.port === port) {
                // 递归调用处理端口冲突的情况
                await closeActiveServer(p);
            }
        }
    }
}

function closeCodexOAuthServer(server) {
    if (!server) return;

    const activeServer = activeServers.get('openai-codex-oauth');
    if (activeServer?.server === server) {
        activeServers.delete('openai-codex-oauth');
    }

    if (!server.listening) return;

    try {
        server.close(error => {
            if (error) {
                logger.warn(`[Codex Auth] Failed to close callback server: ${error.message}`);
            }
        });
    } catch (error) {
        logger.warn(`[Codex Auth] Failed to close callback server: ${error.message}`);
    }
}

function claimCodexOAuthSession(sessionId) {
    if (!global.codexOAuthSessions || !global.codexOAuthSessions.has(sessionId)) {
        return null;
    }

    const session = global.codexOAuthSessions.get(sessionId);
    global.codexOAuthSessions.delete(sessionId);
    if (session?.pollTimer) {
        clearInterval(session.pollTimer);
        session.pollTimer = null;
    }
    if (!global.codexOAuthLatestSessionId) {
        setLatestCodexOAuthSession(sessionId);
    }
    return session;
}

/**
 * Codex OAuth 认证类
 * 实现 OAuth2 + PKCE 流程
 */
export function createCodexOAuthAxiosConfig(config = {}, options = {}) {
    const axiosConfig = { timeout: 30000 };
    if (options.forceDirect) {
        axiosConfig.proxy = false;
        return axiosConfig;
    }

    if (options.selectedProxyUrl) {
        const selectedProxyConfig = parseProxyUrl(options.selectedProxyUrl);
        if (!selectedProxyConfig) {
            throw new Error('Selected proxy URL is invalid or unsupported');
        }
        axiosConfig.proxy = false;
        axiosConfig.httpAgent = selectedProxyConfig.httpAgent;
        axiosConfig.httpsAgent = selectedProxyConfig.httpsAgent;
        return axiosConfig;
    }

    return configureAxiosProxy(axiosConfig, config, 'openai-codex-oauth');
}

export async function postCodexOAuthRefreshRequest(httpClient, url, data, headers, timeoutMs = 30000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    timeoutId.unref?.();
    try {
        return await httpClient.post(url, data, {
            headers,
            timeout: timeoutMs,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeoutId);
    }
}

class CodexAuth {
    constructor(config, proxyOptions = {}) {
        this.config = config;
        this.redirectUri = null;
        
        // 配置代理支持
        const axiosConfig = createCodexOAuthAxiosConfig(config, proxyOptions);
        if (!proxyOptions.forceDirect && (axiosConfig.httpAgent || axiosConfig.httpsAgent)) {
            logger.info('[Codex Auth] Proxy enabled for OAuth requests');
        }
        
        this.httpClient = axios.create(axiosConfig);
        this.server = null; // 存储服务器实例
    }

    getRedirectUri() {
        if (!this.redirectUri) {
            const configuredHost = typeof this.config?.HOST === 'string' && this.config.HOST && !['0.0.0.0', '::', '::0'].includes(this.config.HOST)
                ? this.config.HOST
                : null;
            this.redirectUri = buildCodexRedirectUri(
                this.config?.requestHost || configuredHost || null,
                CODEX_OAUTH_CONFIG.port
            );
        }
        return this.redirectUri;
    }

    /**
     * 生成 PKCE 代码
     * @returns {{verifier: string, challenge: string}}
     */
    generatePKCECodes() {
        // 生成 code verifier (96 随机字节 → 128 base64url 字符)
        const verifier = crypto.randomBytes(96)
            .toString('base64url');

        // 生成 code challenge (SHA256 of verifier)
        const challenge = crypto.createHash('sha256')
            .update(verifier)
            .digest('base64url');

        return { verifier, challenge };
    }

    /**
     * 生成授权 URL（不启动完整流程）
     * @returns {{authUrl: string, state: string, pkce: Object, server: Object}}
     */
    async generateAuthUrl() {
        const pkce = this.generatePKCECodes();
        const state = crypto.randomBytes(16).toString('hex');
        const redirectUri = this.getRedirectUri();

        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Generating auth URL...`);

        // 启动本地回调服务器
        const server = await this.startCallbackServer();
        this.server = server;

        // 构建授权 URL
        const authUrl = new URL(CODEX_OAUTH_CONFIG.authUrl);
        authUrl.searchParams.set('client_id', CODEX_OAUTH_CONFIG.clientId);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('scope', CODEX_OAUTH_CONFIG.scopes);
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('code_challenge', pkce.challenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('prompt', 'login');
        authUrl.searchParams.set('id_token_add_organizations', 'true');
        authUrl.searchParams.set('codex_cli_simplified_flow', 'true');

        return {
            authUrl: authUrl.toString(),
            state,
            pkce,
            server,
            redirectUri
        };
    }

    /**
     * 完成 OAuth 流程（在收到回调后调用）
     * @param {string} code - 授权码
     * @param {string} state - 状态参数
     * @param {string} expectedState - 期望的状态参数
     * @param {Object} pkce - PKCE 代码
     * @returns {Promise<Object>} tokens 和凭据路径
     */
    async completeOAuthFlow(code, state, expectedState, pkce) {
        // 验证 state
        if (state !== expectedState) {
            throw new Error('State mismatch - possible CSRF attack');
        }

        // 用 code 换取 tokens
        const tokens = await this.exchangeCodeForTokens(code, pkce.verifier);

        // 解析 JWT 提取账户信息
        const claims = this.parseJWT(tokens.id_token);

        // 保存凭据（遵循 CLIProxyAPI 格式）
        const credentials = attachCodexSubscriptionWindow({
            id_token: tokens.id_token,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            account_id: claims['https://api.openai.com/auth']?.chatgpt_account_id || claims.sub,
            last_refresh: new Date().toISOString(),
            email: claims.email,
            type: 'codex',
            expired: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()
        }, claims);

        // 保存凭据并获取路径
        const saveResult = await this.saveCredentials(credentials);
        const credPath = saveResult.credsPath;
        const relativePath = saveResult.relativePath;

        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Authentication successful!`);
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Email: ${credentials.email}`);
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Account ID: ${credentials.account_id}`);

        // 关闭服务器
        if (this.server) {
            closeCodexOAuthServer(this.server);
            this.server = null;
        }

        return {
            ...credentials,
            credPath,
            relativePath
        };
    }

    /**
     * 启动 OAuth 流程
     * @returns {Promise<Object>} 返回 tokens
     */
    async startOAuthFlow() {
        const pkce = this.generatePKCECodes();
        const state = crypto.randomBytes(16).toString('hex');
        const redirectUri = this.getRedirectUri();

        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Starting OAuth flow...`);

        // 启动本地回调服务器
        const server = await this.startCallbackServer();

        // 构建授权 URL
        const authUrl = new URL(CODEX_OAUTH_CONFIG.authUrl);
        authUrl.searchParams.set('client_id', CODEX_OAUTH_CONFIG.clientId);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('scope', CODEX_OAUTH_CONFIG.scopes);
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('code_challenge', pkce.challenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        authUrl.searchParams.set('prompt', 'login');
        authUrl.searchParams.set('id_token_add_organizations', 'true');
        authUrl.searchParams.set('codex_cli_simplified_flow', 'true');

        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Opening browser for authentication...`);

        try {
            await open(authUrl.toString());
        } catch (error) {
            logger.warn(`${CODEX_OAUTH_CONFIG.logPrefix} Failed to open browser automatically:`, error.message);
        }

        // 等待回调
        const result = await this.waitForCallback(server, state);

        // 用 code 换取 tokens
        const tokens = await this.exchangeCodeForTokens(result.code, pkce.verifier);

        // 解析 JWT 提取账户信息
        const claims = this.parseJWT(tokens.id_token);

        // 保存凭据（遵循 CLIProxyAPI 格式）
        const credentials = attachCodexSubscriptionWindow({
            id_token: tokens.id_token,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            account_id: claims['https://api.openai.com/auth']?.chatgpt_account_id || claims.sub,
            last_refresh: new Date().toISOString(),
            email: claims.email,
            type: 'codex',
            expired: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()
        }, claims);

        await this.saveCredentials(credentials);

        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Authentication successful!`);
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Email: ${credentials.email}`);
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Account ID: ${credentials.account_id}`);

        return credentials;
    }

    /**
     * 启动回调服务器
     * @returns {Promise<http.Server>}
     */
    async startCallbackServer() {
        // 先清理该提供商或该端口的旧服务器
        await closeActiveServer('openai-codex-oauth', CODEX_OAUTH_CONFIG.port);

        return new Promise((resolve, reject) => {
            const server = http.createServer();

            server.on('request', (req, res) => {
                if (req.url.startsWith('/auth/callback')) {
                    const url = new URL(req.url, this.getRedirectUri());
                    const callbackLocale = req.headers?.['accept-language'] || 'zh-CN';
                    const code = url.searchParams.get('code');
                    const state = url.searchParams.get('state');
                    const error = url.searchParams.get('error');
                    const errorDescription = url.searchParams.get('error_description');

                    if (error) {
                        const callbackError = new Error(errorDescription || error);
                        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateCodexCallbackPage({
                            isSuccess: false,
                            message: errorDescription || error,
                            sessionId: state || '',
                            locale: callbackLocale
                        }));
                        server.emit('auth-error', {
                            error: callbackError,
                            state
                        });
                    } else if (code && state) {
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(generateCodexCallbackPage({
                            isSuccess: true,
                            sessionId: state,
                            locale: callbackLocale
                        }));
                        server.emit('auth-success', { code, state });
                    }
                } else if (req.url === '/success') {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end('<h1>Success!</h1>');
                }
            });

            server.listen(CODEX_OAUTH_CONFIG.port, () => {
                logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Callback server listening on port ${CODEX_OAUTH_CONFIG.port}`);
                activeServers.set('openai-codex-oauth', { server, port: CODEX_OAUTH_CONFIG.port });
                resolve(server);
            });

            server.on('error', (error) => {
                if (error.code === 'EADDRINUSE') {
                    reject(new Error(`Port ${CODEX_OAUTH_CONFIG.port} is already in use. Please close other applications using this port.`));
                } else {
                    reject(error);
                }
            });
        });
    }

    /**
     * 等待 OAuth 回调
     * @param {http.Server} server
     * @param {string} expectedState
     * @returns {Promise<{code: string, state: string}>}
     */
    async waitForCallback(server, expectedState) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                server.close();
                reject(new Error('Authentication timeout (10 minutes)'));
            }, 10 * 60 * 1000); // 10 分钟

            server.once('auth-success', (result) => {
                clearTimeout(timeout);
                server.close();

                if (result.state !== expectedState) {
                    reject(new Error('State mismatch - possible CSRF attack'));
                } else {
                    resolve(result);
                }
            });

            server.once('auth-error', (callbackError) => {
                clearTimeout(timeout);
                server.close();
                reject(callbackError?.error || callbackError);
            });
        });
    }

    /**
     * 用授权码换取 tokens
     * @param {string} code
     * @param {string} codeVerifier
     * @returns {Promise<Object>}
     */
    async exchangeCodeForTokens(code, codeVerifier) {
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Exchanging authorization code for tokens...`);
        const redirectUri = this.getRedirectUri();

        try {
            const response = await this.httpClient.post(
                CODEX_OAUTH_CONFIG.tokenUrl,
                new URLSearchParams({
                    grant_type: 'authorization_code',
                    client_id: CODEX_OAUTH_CONFIG.clientId,
                    code: code,
                    redirect_uri: redirectUri,
                    code_verifier: codeVerifier
                }).toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json'
                    }
                }
            );

            return response.data;
        } catch (error) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Token exchange failed:`, error.response?.data || error.message);
            throw new Error(`Failed to exchange code for tokens: ${error.response?.data?.error_description || error.message}`);
        }
    }

    /**
     * 刷新 tokens
     * @param {string} refreshToken
     * @returns {Promise<Object>}
     */
    async refreshTokens(refreshToken) {
        logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Refreshing access token...`);

        try {
            const response = await postCodexOAuthRefreshRequest(
                this.httpClient,
                CODEX_OAUTH_CONFIG.tokenUrl,
                new URLSearchParams({
                    grant_type: 'refresh_token',
                    client_id: CODEX_OAUTH_CONFIG.clientId,
                    refresh_token: refreshToken
                }).toString(),
                {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                }
            );

            const tokens = response.data;
            const claims = this.parseJWT(tokens.id_token);

            return attachCodexSubscriptionWindow({
                id_token: tokens.id_token,
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token || refreshToken,
                account_id: claims['https://api.openai.com/auth']?.chatgpt_account_id || claims.sub,
                last_refresh: new Date().toISOString(),
                email: claims.email,
                type: 'codex',
                expired: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()
            }, claims);
        } catch (error) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Token refresh failed:`, error.response?.data || error.message);
            throw new Error(`Failed to refresh tokens: ${error.response?.data?.error_description || error.message}`);
        }
    }

    /**
     * 解析 JWT token
     * @param {string} token
     * @returns {Object}
     */
    parseJWT(token) {
        try {
            const parts = token.split('.');
            if (parts.length !== 3) {
                throw new Error('Invalid JWT token format');
            }

            // 解码 payload (base64url)
            const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
            return JSON.parse(payload);
        } catch (error) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Failed to parse JWT:`, error.message);
            throw new Error(`Failed to parse JWT token: ${error.message}`);
        }
    }

    /**
     * 保存凭据到文件
     * @param {Object} creds
     * @returns {Promise<Object>}
     */
    async saveCredentials(creds) {
        const email = creds.email || this.config.CODEX_EMAIL || 'default';
        const safeEmail = sanitizeCodexCredentialFilenamePart(email);
        const normalizedCreds = {
            ...creds,
            name: creds.name || email
        };

        // 优先使用配置中指定的路径，否则保存到 configs/codex 目录
        let credsPath;
        if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
            credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
        } else {
            // 保存到 configs/codex 目录（与其他供应商一致）
            const projectDir = process.cwd();
            const targetDir = path.join(projectDir, 'configs', 'codex');
            await fs.promises.mkdir(targetDir, { recursive: true });
            const timestamp = Date.now();
            const filename = `${timestamp}_codex-${safeEmail}_oauth_creds.json`;
            credsPath = path.join(targetDir, filename);
        }

        try {
            const credsDir = path.dirname(credsPath);
            await fs.promises.mkdir(credsDir, { recursive: true });
            await fs.promises.writeFile(credsPath, JSON.stringify(normalizedCreds, null, 2), { mode: 0o600 });

            const relativePath = path.relative(process.cwd(), credsPath);
            logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Credentials saved to ${relativePath}`);

            // 返回保存路径供后续使用
            return { credsPath, relativePath };
        } catch (error) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Failed to save credentials:`, error.message);
            throw new Error(`Failed to save credentials: ${error.message}`);
        }
    }

    /**
     * 加载凭据
     * @param {string} email
     * @returns {Promise<Object|null>}
     */
    async loadCredentials(email) {
        // 优先使用配置中指定的路径，否则从 configs/codex 目录加载
        let credsPath;
        if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
            credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
        } else {
            // 从 configs/codex 目录加载（与其他供应商一致）
            const projectDir = process.cwd();
            const targetDir = path.join(projectDir, 'configs', 'codex');

            // 扫描目录找到匹配的凭据文件
            try {
                const files = await fs.promises.readdir(targetDir);
                const emailPattern = email || 'default';
                const matchingFile = files
                    .filter(f => f.includes(`codex-${emailPattern}`) && f.endsWith('.json'))
                    .sort()
                    .pop(); // 获取最新的文件

                if (matchingFile) {
                    credsPath = path.join(targetDir, matchingFile);
                } else {
                    return null;
                }
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return null;
                }
                throw error;
            }
        }

        try {
            const data = await fs.promises.readFile(credsPath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null; // 文件不存在
            }
            throw error;
        }
    }

    /**
     * 检查凭据文件是否存在
     * @param {string} email
     * @returns {Promise<boolean>}
     */
    async credentialsExist(email) {
        // 优先使用配置中指定的路径，否则从 configs/codex 目录检查
        let credsPath;
        if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
            credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
        } else {
            const projectDir = process.cwd();
            const targetDir = path.join(projectDir, 'configs', 'codex');

            try {
                const files = await fs.promises.readdir(targetDir);
                const emailPattern = email || 'default';
                const hasMatch = files.some(f =>
                    f.includes(`codex-${emailPattern}`) && f.endsWith('.json')
                );
                return hasMatch;
            } catch (error) {
                return false;
            }
        }

        try {
            await fs.promises.access(credsPath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 检查凭据是否已存在（基于 account_id 或 refresh_token）
     * @param {string} accountId 
     * @param {string} refreshToken 
     * @returns {Promise<{isDuplicate: boolean, existingPath?: string}>}
     */
    async checkDuplicate(accountId, refreshToken, email = null) {
        const projectDir = process.cwd();
        const targetDir = path.join(projectDir, 'configs', 'codex');

        try {
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

                        if (refreshToken && credentials.refresh_token === refreshToken) {
                            const relativePath = path.relative(process.cwd(), fullPath);
                            return {
                                isDuplicate: true,
                                existingPath: relativePath
                            };
                        }

                        if (accountId && credentials.account_id === accountId) {
                            if (email && credentials.email && credentials.email.toLowerCase() !== email.toLowerCase()) {
                                continue;
                            }
                            const relativePath = path.relative(process.cwd(), fullPath);
                            return {
                                isDuplicate: true,
                                existingPath: relativePath
                            };
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
            return { isDuplicate: false };
        } catch (error) {
            logger.warn(`${CODEX_OAUTH_CONFIG.logPrefix} Error checking duplicates:`, error.message);
            return { isDuplicate: false };
        }
    }
}

/**
 * 批量导入 Codex Token 并生成凭据文件（流式版本）
 * @param {Object[]} tokens - Token 对象数组
 * @param {Function} onProgress - 进度回调函数
 * @param {boolean} skipDuplicateCheck - 是否跳过重复检查
 * @returns {Promise<Object>} 批量处理结果
 */
export async function batchImportCodexTokensStream(tokens, onProgress = null, skipDuplicateCheck = false) {
    const auth = new CodexAuth({});
    const results = {
        total: tokens.length,
        success: 0,
        failed: 0,
        details: []
    };

    for (let i = 0; i < tokens.length; i++) {
        const tokenData = tokens[i];
        const progressData = {
            index: i + 1,
            total: tokens.length,
            current: null
        };

        try {
            if (!tokenData || typeof tokenData !== 'object') {
                throw new Error('Token 数据必须是 JSON 对象');
            }

            if (tokenData.skipped || tokenData.error) {
                throw new Error(tokenData.reason || tokenData.error || 'skipped');
            }

            // 验证 token 数据：access_token 是唯一必需字段，id_token/refresh_token 可为空。
            if (!tokenData.access_token) {
                throw new Error('Token 缺少必需字段 access_token');
            }

            // 解析 JWT 提取账户信息。外部导入格式可能没有 id_token，因此回退解析 access_token。
            let claims = {};
            for (const candidate of [tokenData.id_token, tokenData.access_token]) {
                if (!candidate) continue;
                try {
                    claims = auth.parseJWT(candidate);
                    break;
                } catch {
                    // access_token-only 导入允许无法解析 JWT，只要外部字段提供了账号信息。
                }
            }

            const authClaims = claims['https://api.openai.com/auth'] || {};
            const profileClaims = claims['https://api.openai.com/profile'] || {};
            const accountId = tokenData.account_id || tokenData.chatgpt_account_id || authClaims.chatgpt_account_id || claims.sub;
            const email = tokenData.email || tokenData.name || profileClaims.email || claims.email || (accountId ? `codex-${accountId}` : null);

            if (!accountId) {
                throw new Error('Token 缺少 account_id/chatgpt_account_id，且无法从 JWT 中解析账号 ID');
            }

            const refreshToken = tokenData.refresh_token || '';

            // 检查重复
            if (!skipDuplicateCheck) {
                const duplicateCheck = await auth.checkDuplicate(accountId, refreshToken, email);
                if (duplicateCheck.isDuplicate) {
                    progressData.current = {
                        index: i + 1,
                        success: false,
                        error: 'duplicate',
                        email,
                        accountId,
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

            const expiredValue = tokenData.expired || tokenData.expiresAt || tokenData.expire || tokenData.expires_at;
            let expired;
            if (expiredValue) {
                const parsed = typeof expiredValue === 'number'
                    ? new Date(expiredValue > 1000000000000 ? expiredValue : expiredValue * 1000)
                    : new Date(expiredValue);
                expired = Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
            }
            if (!expired && tokenData.expires_in) {
                const seconds = Number(tokenData.expires_in);
                if (Number.isFinite(seconds) && seconds > 0) {
                    expired = new Date(Date.now() + seconds * 1000).toISOString();
                }
            }
            if (!expired && claims.exp) {
                const claimExp = Number(claims.exp);
                if (Number.isFinite(claimExp)) {
                    const parsed = new Date(claimExp * 1000);
                    if (!Number.isNaN(parsed.getTime())) {
                        expired = parsed.toISOString();
                    }
                }
            }
            if (!expired) {
                expired = new Date(Date.now() + 3600 * 1000).toISOString();
            }

            // 构建凭据对象
            const credentials = attachCodexSubscriptionWindow({
                id_token: tokenData.id_token || '',
                access_token: tokenData.access_token,
                refresh_token: refreshToken,
                account_id: accountId,
                last_refresh: tokenData.last_refresh || new Date().toISOString(),
                email: email,
                type: 'codex',
                expired,
                access_token_only: !refreshToken
            }, claims, tokenData);

            // 保存凭据
            const saveResult = await auth.saveCredentials(credentials);
            const relativePath = saveResult.relativePath;

            logger.info(`${CODEX_OAUTH_CONFIG.logPrefix} Token ${i + 1} imported: ${relativePath}`);

            progressData.current = {
                index: i + 1,
                success: true,
                email,
                accountId,
                accessTokenOnly: !refreshToken,
                path: relativePath
            };
            results.success++;

        } catch (error) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Token ${i + 1} import failed:`, error.message);

            progressData.current = {
                index: i + 1,
                success: false,
                email: tokenData?.email || tokenData?.name,
                accountId: tokenData?.account_id || tokenData?.chatgpt_account_id,
                error: error.message
            };
            results.failed++;
        }

        results.details.push(progressData.current);

        if (onProgress) {
            onProgress({
                ...progressData,
                successCount: results.success,
                failedCount: results.failed
            });
        }
    }

    if (results.success > 0) {
        try {
            await autoLinkProviderConfigs(CONFIG);
        } catch (linkError) {
            logger.error(`${CODEX_OAUTH_CONFIG.logPrefix} Failed to auto-link imported tokens:`, linkError.message);
        }

        broadcastEvent('oauth_batch_success', {
            provider: 'openai-codex-oauth',
            count: results.success,
            timestamp: new Date().toISOString()
        });
    }

    return results;
}

/**
 * 带重试的 Codex token 刷新
 * @param {string} refreshToken
 * @param {Object} config
 * @param {number} maxRetries
 * @returns {Promise<Object>}
 */
export async function refreshCodexTokensWithRetry(refreshToken, config = {}, maxRetries = 3) {
    const auth = new CodexAuth(config);
    let lastError;

    for (let i = 0; i < maxRetries; i++) {
        try {
            return await auth.refreshTokens(refreshToken);
        } catch (error) {
            lastError = error;
            logger.warn(`${CODEX_OAUTH_CONFIG.logPrefix} Retry ${i + 1}/${maxRetries} failed:`, error.message);

            if (i < maxRetries - 1) {
                // 指数退避
                const delay = Math.min(1000 * Math.pow(2, i), 10000);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
}

async function persistCodexOAuthCredentials(credentials, targetProviderUuid = null, proxySelection = {}) {
    const proxyId = typeof proxySelection.proxyId === 'string'
        ? proxySelection.proxyId.trim()
        : '';
    const proxyOverrideProvided = proxySelection.proxyOverrideProvided === true;

    if (targetProviderUuid) {
        try {
            return await replaceProviderCredentialPath(CONFIG, {
                providerType: 'openai-codex-oauth',
                providerUuid: targetProviderUuid,
                credPath: credentials.relativePath,
                ...(proxyOverrideProvided ? { proxyId } : {})
            });
        } catch (error) {
            await removeCodexOAuthCredentialFile(credentials.credPath);
            throw error;
        }
    }

    try {
        return await autoLinkProviderConfigs(CONFIG, {
            onlyCurrentCred: true,
            credPath: credentials.relativePath,
            providerDefaults: proxyId ? { PROXY_ID: proxyId } : {},
            throwOnPersistError: true
        });
    } catch (error) {
        await removeCodexOAuthCredentialFile(credentials.credPath);
        throw error;
    }
}

async function removeCodexOAuthCredentialFile(credPath) {
    if (!credPath) return;

    const codexCredentialDir = path.resolve(process.cwd(), 'configs', 'codex');
    const absoluteCredPath = path.resolve(String(credPath));
    const relativeToCredentialDir = path.relative(codexCredentialDir, absoluteCredPath);
    const isGeneratedCodexCredential = relativeToCredentialDir
        && !path.isAbsolute(relativeToCredentialDir)
        && !relativeToCredentialDir.startsWith('..');
    if (!isGeneratedCodexCredential) {
        logger.warn(`[Codex Auth] Refusing to remove credential outside generated directory: ${absoluteCredPath}`);
        return;
    }

    try {
        await fs.promises.unlink(absoluteCredPath);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.warn(`[Codex Auth] Failed to remove unlinked credential file: ${error.message}`);
        }
    }
}

function resolveTargetProviderConfig(currentConfig, targetProviderUuid) {
    if (!targetProviderUuid) {
        return {};
    }

    const providers = currentConfig.providerPools?.['openai-codex-oauth'];
    if (!Array.isArray(providers)) {
        return {};
    }

    return providers.find(provider => provider?.uuid === targetProviderUuid) || {};
}

export function assertCodexOAuthProxyAvailable(config = {}, proxyId = '') {
    const normalizedProxyId = String(proxyId || '').trim();
    if (!normalizedProxyId) {
        return null;
    }

    const proxyEntry = resolveProxyPoolEntry({
        ...config,
        PROXY_ID: normalizedProxyId
    });
    if (!proxyEntry) {
        throw new Error(`Selected proxy node is unavailable: ${normalizedProxyId}`);
    }
    if (!parseProxyUrl(proxyEntry.url)) {
        throw new Error(`Selected proxy node is unavailable: ${normalizedProxyId}`);
    }

    return proxyEntry;
}

/**
 * 处理 Codex OAuth 认证
 * @param {Object} currentConfig - 当前配置
 * @param {Object} options - 选项
 * @returns {Promise<Object>} 返回认证结果
 */
export async function handleCodexOAuth(currentConfig, options = {}) {
    const targetProviderUuid = typeof options.targetProviderUuid === 'string'
        ? options.targetProviderUuid.trim()
        : null;
    const targetProviderConfig = resolveTargetProviderConfig(currentConfig, targetProviderUuid);
    const hasProxyOverride = Object.prototype.hasOwnProperty.call(options, 'proxyId');
    if (hasProxyOverride && typeof options.proxyId !== 'string') {
        return {
            success: false,
            error: 'proxyId must be a string when provided',
            authInfo: {
                provider: 'openai-codex-oauth',
                method: 'oauth2-pkce'
            }
        };
    }
    const selectedProxyId = targetProviderUuid
        ? (hasProxyOverride ? String(options.proxyId || '').trim() : String(targetProviderConfig.PROXY_ID || '').trim())
        : String(options.proxyId || options.PROXY_ID || '').trim();
    const authConfig = {
        ...currentConfig,
        ...targetProviderConfig,
        requestHost: options.requestHost || null
    };
    if (targetProviderUuid) {
        delete authConfig.CODEX_OAUTH_CREDS_FILE_PATH;
    }
    if (selectedProxyId) {
        authConfig.PROXY_ID = selectedProxyId;
    } else if (hasProxyOverride) {
        delete authConfig.PROXY_ID;
    }
    let auth = null;
    try {
        const selectedProxyEntry = assertCodexOAuthProxyAvailable(authConfig, selectedProxyId);
        auth = new CodexAuth(authConfig, {
            forceDirect: hasProxyOverride && !selectedProxyId,
            selectedProxyUrl: selectedProxyEntry?.url || null
        });
        logger.info('[Codex Auth] Generating OAuth URL...');

        let authUrl;
        let state;
        let pkce;
        let server;
        let sessionId;
        let session;

        // 清理旧会话、生成新回调服务器并发布新 generation，共用同一线性化锁。
        await withCodexOAuthTransitionLock(async () => {
            if (global.codexOAuthSessions && global.codexOAuthSessions.size > 0) {
                logger.info('[Codex Auth] Cleaning up old OAuth sessions...');
                for (const [sessionId] of global.codexOAuthSessions.entries()) {
                    try {
                        const staleSession = claimCodexOAuthSession(sessionId);
                        clearLatestCodexOAuthSession(sessionId);
                        closeCodexOAuthServer(staleSession?.server);
                        if (staleSession) {
                            broadcastEvent('oauth_error', {
                                provider: 'openai-codex-oauth',
                                sessionId,
                                targetProviderUuid: staleSession.targetProviderUuid,
                                error: 'OAuth authorization was replaced by a newer request',
                                timestamp: new Date().toISOString()
                            });
                        }
                    } catch (error) {
                        logger.warn('[Codex Auth] Failed to clean up a previous OAuth session:', error.message);
                    }
                }
            }

            const generatedAuth = await auth.generateAuthUrl();
            authUrl = generatedAuth.authUrl;
            state = generatedAuth.state;
            pkce = generatedAuth.pkce;
            server = generatedAuth.server;

            if (!global.codexOAuthSessions) {
                global.codexOAuthSessions = new Map();
            }

            sessionId = state;
            session = {
                auth,
                state,
                pkce,
                server,
                targetProviderUuid,
                proxyId: selectedProxyId,
                proxyOverrideProvided: hasProxyOverride,
                pollTimer: null,
                createdAt: Date.now()
            };

            setLatestCodexOAuthSession(sessionId);
            global.codexOAuthSessions.set(sessionId, session);
        });

        logger.info('[Codex Auth] OAuth URL generated successfully');
        
        // 轮询计数器
        let pollCount = 0;
        const maxPollCount = 100; // 增加到约 5 分钟 (100 * 3s = 300s)
        const pollInterval = 3000; // 轮询间隔（毫秒）
        let pollTimer = null;
        let isCompleted = false;
        
        // 启动轮询日志
        pollTimer = setInterval(() => {
            pollCount++;
            if (pollCount <= maxPollCount && !isCompleted) {
                logger.info(`[Codex Auth] Waiting for callback... (${pollCount}/${maxPollCount})`);
            }
            
            if (pollCount >= maxPollCount && !isCompleted) {
                isCompleted = true;
                const totalSeconds = (maxPollCount * pollInterval) / 1000;
                logger.info(`[Codex Auth] Polling timeout (${totalSeconds}s), releasing session for next authorization`);

                const expiredSession = claimCodexOAuthSession(sessionId);
                if (expiredSession) {
                    clearLatestCodexOAuthSession(sessionId);
                    detachCallbackListeners();
                    closeCodexOAuthServer(expiredSession.server);
                    broadcastEvent('oauth_error', {
                        provider: 'openai-codex-oauth',
                        sessionId,
                        targetProviderUuid,
                        error: 'OAuth authorization timed out',
                        timestamp: new Date().toISOString()
                    });
                }
            }
        }, pollInterval);
        
        // 将 pollTimer 存储到会话中
        session.pollTimer = pollTimer;

        // 监听回调服务器的 auth-success 事件，自动完成 OAuth 流程
        const detachCallbackListeners = () => {
            server.removeListener('auth-success', handleAuthSuccess);
            server.removeListener('auth-error', handleAuthError);
        };
        const handleAuthSuccess = async (result) => {
            if (!result || result.state !== sessionId) {
                logger.warn('[Codex Auth] Ignoring callback with mismatched OAuth state');
                return;
            }

            detachCallbackListeners();
            isCompleted = true;
            const claimedSession = claimCodexOAuthSession(sessionId);
            if (!claimedSession) {
                logger.warn('[Codex Auth] OAuth session was already completed or expired');
                closeCodexOAuthServer(server);
                return;
            }

            try {
                logger.info('[Codex Auth] Received auth callback, completing OAuth flow...');

                // 完成 OAuth 流程
                const credentials = await claimedSession.auth.completeOAuthFlow(
                    result.code,
                    result.state,
                    claimedSession.state,
                    claimedSession.pkce
                );

                await withCodexOAuthTransitionLock(async () => {
                    try {
                        try {
                            assertLatestCodexOAuthSession(sessionId);
                        } catch (error) {
                            await removeCodexOAuthCredentialFile(credentials.credPath);
                            throw error;
                        }

                        await persistCodexOAuthCredentials(credentials, claimedSession.targetProviderUuid, {
                            proxyId: claimedSession.proxyId,
                            proxyOverrideProvided: claimedSession.proxyOverrideProvided
                        });

                        // 仅在凭据和代理配置持久化完成后广播认证成功事件
                        broadcastEvent('oauth_success', {
                            provider: 'openai-codex-oauth',
                            sessionId,
                            credPath: credentials.credPath,
                            relativePath: credentials.relativePath,
                            timestamp: new Date().toISOString(),
                            email: credentials.email,
                            accountId: credentials.account_id,
                            targetProviderUuid: claimedSession.targetProviderUuid
                        });
                    } finally {
                        clearLatestCodexOAuthSession(sessionId);
                    }
                });

                logger.info('[Codex Auth] OAuth flow completed successfully');
            } catch (error) {
                clearLatestCodexOAuthSession(sessionId);
                logger.error('[Codex Auth] Failed to complete OAuth flow:', error.message);
                
                // 广播认证失败事件
                broadcastEvent('oauth_error', {
                    provider: 'openai-codex-oauth',
                    sessionId,
                    targetProviderUuid: claimedSession.targetProviderUuid,
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            } finally {
                closeCodexOAuthServer(claimedSession.server);
            }
        };

        // 监听 auth-error 事件
        const handleAuthError = (callbackError) => {
            if (!callbackError || callbackError.state !== sessionId) {
                logger.warn('[Codex Auth] Ignoring OAuth error with mismatched state');
                return;
            }

            detachCallbackListeners();
            isCompleted = true;
            const claimedSession = claimCodexOAuthSession(sessionId);
            if (!claimedSession) {
                closeCodexOAuthServer(server);
                return;
            }
            clearLatestCodexOAuthSession(sessionId);

            const error = callbackError.error instanceof Error
                ? callbackError.error
                : new Error(String(callbackError.error || 'OAuth authorization failed'));
            logger.error('[Codex Auth] Auth error:', error.message);
            closeCodexOAuthServer(claimedSession.server);

            broadcastEvent('oauth_error', {
                provider: 'openai-codex-oauth',
                sessionId,
                targetProviderUuid: claimedSession.targetProviderUuid,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        };

        server.on('auth-success', handleAuthSuccess);
        server.on('auth-error', handleAuthError);

        return {
            success: true,
            authUrl: authUrl,
            authInfo: {
                provider: 'openai-codex-oauth',
                method: 'oauth2-pkce',
                sessionId: sessionId,
                redirectUri: auth.redirectUri || auth.getRedirectUri(),
                port: CODEX_OAUTH_CONFIG.port,
                targetProviderUuid,
                proxyId: selectedProxyId || null,
                proxyOverrideProvided: hasProxyOverride,
                instructions: [
                    '1. 点击下方按钮在浏览器中打开授权链接',
                    '2. 使用您的 OpenAI 账户登录',
                    '3. 授权应用访问您的 Codex API',
                    '4. 授权成功后会自动保存凭据',
                    '5. 如果浏览器未自动跳转，请手动复制回调 URL'
                ]
            }
        };
    } catch (error) {
        closeCodexOAuthServer(auth?.server);
        logger.error('[Codex Auth] Failed to generate OAuth URL:', error.message);

        return {
            success: false,
            error: error.message,
            authInfo: {
                provider: 'openai-codex-oauth',
                method: 'oauth2-pkce',
                instructions: [
                    `1. 确保端口 ${CODEX_OAUTH_CONFIG.port} 未被占用`,
                    '2. 确保可以访问 auth.openai.com',
                    '3. 确保浏览器可以正常打开',
                    '4. 如果问题持续，请检查网络连接'
                ]
            }
        };
    }
}

/**
 * 处理 Codex OAuth 回调
 * @param {string} code - 授权码
 * @param {string} state - 状态参数
 * @returns {Promise<Object>} 返回认证结果
 */
export async function handleCodexOAuthCallback(code, state) {
    let callbackTargetProviderUuid = null;
    let claimedSession = null;
    try {
        claimedSession = claimCodexOAuthSession(state);
        if (!claimedSession) {
            throw new Error('Invalid or expired OAuth session');
        }

        callbackTargetProviderUuid = claimedSession.targetProviderUuid || null;
        const {
            auth,
            state: expectedState,
            pkce,
            proxyId = '',
            proxyOverrideProvided = false
        } = claimedSession;
        const targetProviderUuid = callbackTargetProviderUuid;

        logger.info('[Codex Auth] Processing OAuth callback...');

        // 完成 OAuth 流程
        const result = await auth.completeOAuthFlow(code, state, expectedState, pkce);

        await withCodexOAuthTransitionLock(async () => {
            try {
                try {
                    assertLatestCodexOAuthSession(state);
                } catch (error) {
                    await removeCodexOAuthCredentialFile(result.credPath);
                    throw error;
                }

                await persistCodexOAuthCredentials(result, targetProviderUuid, {
                    proxyId,
                    proxyOverrideProvided
                });

                // 仅在凭据和代理配置持久化完成后广播认证成功事件
                broadcastEvent('oauth_success', {
                    provider: 'openai-codex-oauth',
                    sessionId: state,
                    credPath: result.credPath,
                    relativePath: result.relativePath,
                    timestamp: new Date().toISOString(),
                    email: result.email,
                    accountId: result.account_id,
                    targetProviderUuid
                });
            } finally {
                clearLatestCodexOAuthSession(state);
            }
        });

        logger.info('[Codex Auth] OAuth callback processed successfully');

        return {
            success: true,
            message: 'Codex authentication successful',
            credentials: result,
            email: result.email,
            accountId: result.account_id,
            credPath: result.credPath,
            relativePath: result.relativePath,
            targetProviderUuid,
            proxyId
        };
    } catch (error) {
        clearLatestCodexOAuthSession(state);
        logger.error('[Codex Auth] OAuth callback failed:', error.message);

        // 只有实际领取到会话的处理失败才广播终态；重复/过期回调仅返回请求错误。
        if (claimedSession) {
            broadcastEvent('oauth_error', {
                provider: 'openai-codex-oauth',
                sessionId: state,
                targetProviderUuid: callbackTargetProviderUuid,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }

        return {
            success: false,
            error: error.message
        };
    } finally {
        closeCodexOAuthServer(claimedSession?.server);
    }
}
