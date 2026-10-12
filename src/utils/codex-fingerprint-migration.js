import {
    CODEX_FINGERPRINT_MODES,
    CODEX_FINGERPRINT_VERSION,
    DEFAULT_CODEX_FINGERPRINT_MODE
} from '../providers/openai/codex-fingerprint.js';
import { promises as fs } from 'fs';
import path from 'path';
import { withFileLock, atomicWriteFile } from './file-lock.js';

function safeMigrationLog(logger, message, details = {}) {
    logger?.warn?.(`[Codex Fingerprint] ${message}`, details);
}

export function normalizeCodexFingerprintProviderConfig(providerType, providerConfig = {}) {
    const normalized = { ...providerConfig };
    const isCodexOAuth = providerType === 'openai-codex-oauth'
        || String(providerType || '').startsWith('openai-codex-oauth-');
    if (!isCodexOAuth) return normalized;

    const rawMode = String(normalized.codexFingerprintMode || '').trim().toLowerCase();
    normalized.codexFingerprintMode = CODEX_FINGERPRINT_MODES.includes(rawMode)
        ? rawMode
        : DEFAULT_CODEX_FINGERPRINT_MODE;
    normalized.codexFingerprintVersion = CODEX_FINGERPRINT_VERSION;
    return normalized;
}

export function migrateCodexFingerprintProviderPools(providerPools = {}) {
    const nextPools = structuredClone(providerPools || {});
    const providers = Array.isArray(nextPools['openai-codex-oauth'])
        ? nextPools['openai-codex-oauth']
        : [];
    let migratedCount = 0;
    let versionedCount = 0;
    let invalidCount = 0;

    for (const provider of providers) {
        if (!provider || typeof provider !== 'object') continue;
        const rawMode = String(provider.codexFingerprintMode || '').trim().toLowerCase();
        const validMode = CODEX_FINGERPRINT_MODES.includes(rawMode);
        const needsMode = !validMode;
        const needsVersion = provider.codexFingerprintVersion !== CODEX_FINGERPRINT_VERSION;
        if (!needsMode && !needsVersion) continue;
        if (rawMode && !validMode) invalidCount += 1;
        if (needsMode) {
            provider.codexFingerprintMode = DEFAULT_CODEX_FINGERPRINT_MODE;
            provider.codexFingerprintMigrated = true;
            migratedCount += 1;
        }
        if (needsVersion) {
            provider.codexFingerprintVersion = CODEX_FINGERPRINT_VERSION;
            versionedCount += 1;
        }
    }

    return {
        changed: migratedCount > 0 || versionedCount > 0,
        migratedCount,
        versionedCount,
        invalidCount,
        providerPools: nextPools
    };
}

export async function migrateCodexFingerprintProviderPoolsFile({
    config,
    persistenceEnabled = true,
    logger = null
} = {}) {
    const filePath = config?.PROVIDER_POOLS_FILE_PATH;
    if (!persistenceEnabled || !filePath) {
        return { changed: false, persisted: false, skipped: true, providerPools: config?.providerPools || {} };
    }

    return withFileLock(filePath, async () => {
        let currentPools = config.providerPools || {};
        try {
            currentPools = JSON.parse(await fs.readFile(filePath, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') {
                safeMigrationLog(logger, '读取 provider pool 失败，运行时对缺失模式回落到默认 session', { error: error.message });
            }
        }

        const result = migrateCodexFingerprintProviderPools(currentPools);
        config.providerPools = result.providerPools;
        if (!result.changed) {
            return { ...result, persisted: false, skipped: false };
        }

        let backupPath = null;
        try {
            const candidateBackupPath = `${path.resolve(filePath)}.before-codex-fingerprint-${Date.now()}.bak`;
            await fs.copyFile(filePath, candidateBackupPath);
            backupPath = candidateBackupPath;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                safeMigrationLog(logger, '创建 provider pool 迁移备份失败，跳过持久化', { error: error.message });
                return { ...result, persisted: false, backupPath, skipped: false };
            }
        }

        await atomicWriteFile(filePath, JSON.stringify(result.providerPools, null, 2), { encoding: 'utf8', mode: 0o600 });
        return { ...result, persisted: true, backupPath, skipped: false };
    });
}
