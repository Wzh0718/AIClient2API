import { promises as fs, readFileSync } from 'fs';

const DEFAULT_CODEX_REDIRECT_PORT = 1455;

export function buildCodexRedirectUri(hostHeader, callbackPort = DEFAULT_CODEX_REDIRECT_PORT) {
    return `http://localhost:${callbackPort}/auth/callback`;
}

function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function emptySubscriptionWindow() {
    return {
        subscription_active_start: null,
        subscription_active_until: null
    };
}

function hasOwn(object, key) {
    return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

export function normalizeCodexSubscriptionTimestamp(value) {
    if (value === undefined || value === null || value === '') return null;

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        const milliseconds = value > 1000000000000 ? value : value * 1000;
        const date = new Date(milliseconds);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    const text = cleanString(value);
    if (!text) return null;

    if (/^\d+(\.\d+)?$/.test(text)) {
        return normalizeCodexSubscriptionTimestamp(Number(text));
    }

    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseJwtPayload(token) {
    const tokenValue = cleanString(token);
    if (!tokenValue) return null;

    const parts = tokenValue.split('.');
    if (parts.length !== 3) return null;

    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

function getAuthClaims(source) {
    if (!source || typeof source !== 'object') return {};
    return source['https://api.openai.com/auth']
        || source.claims?.['https://api.openai.com/auth']
        || source.id_token_claims?.['https://api.openai.com/auth']
        || source.auth?.['https://api.openai.com/auth']
        || source.auth
        || {};
}

function windowFromAuthClaims(authClaims = {}) {
    return {
        subscription_active_start: normalizeCodexSubscriptionTimestamp(
            authClaims.chatgpt_subscription_active_start
            || authClaims.subscription_active_start
        ),
        subscription_active_until: normalizeCodexSubscriptionTimestamp(
            authClaims.chatgpt_subscription_active_until
            || authClaims.subscription_active_until
        )
    };
}

export function extractPersistedCodexSubscriptionWindow(credentialData) {
    if (!credentialData || typeof credentialData !== 'object') {
        return emptySubscriptionWindow();
    }

    return {
        subscription_active_start: normalizeCodexSubscriptionTimestamp(credentialData.subscription_active_start),
        subscription_active_until: normalizeCodexSubscriptionTimestamp(credentialData.subscription_active_until)
    };
}

export function extractCodexSubscriptionWindow(source) {
    if (!source) return emptySubscriptionWindow();

    if (typeof source === 'string') {
        return windowFromAuthClaims(getAuthClaims(parseJwtPayload(source)));
    }

    if (typeof source !== 'object') return emptySubscriptionWindow();

    if (hasOwn(source, 'subscription_active_start') || hasOwn(source, 'subscription_active_until')) {
        return extractPersistedCodexSubscriptionWindow(source);
    }

    const fromClaims = windowFromAuthClaims(getAuthClaims(source));
    if (fromClaims.subscription_active_start || fromClaims.subscription_active_until) {
        return fromClaims;
    }

    for (const token of [source.id_token, source.access_token]) {
        const fromToken = extractCodexSubscriptionWindow(token);
        if (fromToken.subscription_active_start || fromToken.subscription_active_until) {
            return fromToken;
        }
    }

    return emptySubscriptionWindow();
}

export function mergeCodexSubscriptionWindow(previous = {}, next = {}) {
    return {
        subscription_active_start: next?.subscription_active_start
            || previous?.subscription_active_start
            || null,
        subscription_active_until: next?.subscription_active_until
            || previous?.subscription_active_until
            || null
    };
}

export function attachCodexSubscriptionWindow(credentials = {}, source = credentials, previous = {}) {
    return {
        ...credentials,
        ...mergeCodexSubscriptionWindow(previous, extractCodexSubscriptionWindow(source))
    };
}

export function readCodexSubscriptionWindowSync(filePath) {
    const resolvedPath = cleanString(filePath);
    if (!resolvedPath) return emptySubscriptionWindow();

    try {
        return extractPersistedCodexSubscriptionWindow(JSON.parse(readFileSync(resolvedPath, 'utf8')));
    } catch {
        return emptySubscriptionWindow();
    }
}

export async function readCodexSubscriptionWindow(filePath) {
    const resolvedPath = cleanString(filePath);
    if (!resolvedPath) return emptySubscriptionWindow();

    try {
        const content = await fs.readFile(resolvedPath, 'utf8');
        return extractPersistedCodexSubscriptionWindow(JSON.parse(content));
    } catch {
        return emptySubscriptionWindow();
    }
}

export function extractCodexCredentialDisplayName(credentialData, fallback = '') {
    if (!credentialData || typeof credentialData !== 'object') {
        return cleanString(fallback);
    }

    const candidates = [
        credentialData.customName,
        credentialData.email,
        credentialData.name,
        credentialData?.profile?.email,
        credentialData?.extra?.email,
        credentialData?.user?.email
    ];

    for (const candidate of candidates) {
        const value = cleanString(candidate);
        if (value) return value;
    }

    return cleanString(fallback);
}

export function extractCodexCredentialIdentity(credentialData) {
    if (!credentialData || typeof credentialData !== 'object') {
        return {
            codexAccountKey: '',
            codexAccountId: '',
            codexEmail: ''
        };
    }

    const authClaims = credentialData?.claims?.['https://api.openai.com/auth']
        || credentialData?.id_token_claims?.['https://api.openai.com/auth']
        || credentialData?.auth?.['https://api.openai.com/auth']
        || {};
    const codexAccountId = cleanString(
        credentialData.account_id
        || credentialData.chatgpt_account_id
        || authClaims.chatgpt_account_id
        || credentialData?.profile?.account_id
        || credentialData?.user?.account_id
    );
    const codexEmail = cleanString(
        credentialData.email
        || credentialData?.profile?.email
        || credentialData?.extra?.email
        || credentialData?.user?.email
        || credentialData.name
    ).toLowerCase();

    return {
        codexAccountKey: codexAccountId || codexEmail,
        codexAccountId,
        codexEmail
    };
}

export async function readCodexCredentialDisplayName(filePath, fallback = '') {
    const resolvedPath = cleanString(filePath);
    if (!resolvedPath) {
        return cleanString(fallback);
    }

    try {
        const content = await fs.readFile(resolvedPath, 'utf8');
        const data = JSON.parse(content);
        return extractCodexCredentialDisplayName(data, fallback);
    } catch {
        return cleanString(fallback);
    }
}

export async function readCodexCredentialIdentity(filePath) {
    const resolvedPath = cleanString(filePath);
    if (!resolvedPath) {
        return extractCodexCredentialIdentity(null);
    }

    try {
        const content = await fs.readFile(resolvedPath, 'utf8');
        const data = JSON.parse(content);
        return extractCodexCredentialIdentity(data);
    } catch {
        return extractCodexCredentialIdentity(null);
    }
}
