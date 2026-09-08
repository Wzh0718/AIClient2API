import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import zlib from 'zlib';
import { promisify } from 'util';
import { createHash } from 'crypto';

const gzip = promisify(zlib.gzip);

function toDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : new Date();
}

function dateKey(value) {
    return toDate(value).toISOString().slice(0, 10);
}

function safeRequestId(value) {
    return String(value || `request-${Date.now()}`).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
}

function normalizeKeyHashes(value) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string') {
        return value.split(',').map(item => item.trim()).filter(Boolean);
    }
    return [];
}

function truncateUtf8(value, maxBytes) {
    const text = String(value);
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

    const marker = '...[truncated]';
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    if (maxBytes <= markerBytes) {
        return Buffer.from(text, 'utf8').subarray(0, Math.max(0, maxBytes)).toString('utf8');
    }

    let low = 0;
    let high = Math.min(text.length, maxBytes - markerBytes);
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= maxBytes - markerBytes) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return `${text.slice(0, low)}${marker}`;
}

function createTraversalBudget(maxBytes) {
    const normalizedBytes = Math.max(0, Number(maxBytes) || 0);
    return {
        remainingBytes: normalizedBytes,
        remainingNodes: Math.max(16, Math.min(256, Math.ceil(normalizedBytes / 4))),
        remainingPropertyReads: Math.max(16, Math.min(128, Math.ceil(normalizedBytes / 8))),
        exhausted: normalizedBytes === 0
    };
}

function consumeEstimatedBytes(budget, bytes) {
    const normalizedBytes = Math.max(0, Number(bytes) || 0);
    if (normalizedBytes > budget.remainingBytes) {
        budget.remainingBytes = 0;
        budget.exhausted = true;
        return false;
    }
    budget.remainingBytes -= normalizedBytes;
    if (budget.remainingBytes === 0) budget.exhausted = true;
    return true;
}

function isSecretField(fieldName) {
    const normalized = String(fieldName || '').trim().toLowerCase().replace(/-/g, '_');
    if (!normalized) return false;
    if (['authorization', 'proxy_authorization', 'header', 'headers', 'cookie', 'set_cookie', 'password', 'secret', 'private_key'].includes(normalized)) return true;
    return normalized === 'api_key' || normalized.endsWith('_api_key') ||
        normalized === 'token' || normalized.endsWith('_token') ||
        normalized.endsWith('_secret');
}

function redactBinaryString(value) {
    const text = String(value);
    const looksLikeBase64 = text.length >= 16 * 1024 && text.length % 4 === 0 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(text) &&
        /[a-z]/.test(text) && /[A-Z]/.test(text) && /[0-9]/.test(text) &&
        new Set(text.slice(0, 4096)).size >= 24;
    const isBinary = /^data:(?:image|audio|video|application)\//i.test(text) ||
        looksLikeBase64;
    if (!isBinary) return null;
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
    return `[binary-redacted bytes=${Buffer.byteLength(text, 'utf8')} sha256=${hash}]`;
}

function cloneBoundedValue(value, budget, depth = 0, seen = new WeakSet(), fieldName = '') {
    if (budget.exhausted || budget.remainingNodes <= 0) return null;
    budget.remainingNodes -= 1;
    if (value === null || value === undefined) return value ?? null;
    if (isSecretField(fieldName)) {
        consumeEstimatedBytes(budget, 10);
        return '[REDACTED]';
    }
    if (typeof value === 'string') {
        const text = redactBinaryString(value) || truncateUtf8(value, budget.remainingBytes);
        consumeEstimatedBytes(budget, Buffer.byteLength(text, 'utf8'));
        return text;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        consumeEstimatedBytes(budget, Buffer.byteLength(String(value), 'utf8'));
        return value;
    }
    if (typeof value === 'bigint') {
        const text = String(value);
        consumeEstimatedBytes(budget, Buffer.byteLength(text, 'utf8'));
        return text;
    }
    if (Buffer.isBuffer(value)) {
        const text = `[Buffer ${value.length} bytes]`;
        consumeEstimatedBytes(budget, Buffer.byteLength(text, 'utf8'));
        return text;
    }
    if (typeof value !== 'object') {
        const text = String(value);
        consumeEstimatedBytes(budget, Buffer.byteLength(text, 'utf8'));
        return text;
    }
    if (depth >= 8) return null;
    if (seen.has(value)) return null;
    seen.add(value);

    const maxEntries = 50;
    const result = Array.isArray(value) ? [] : {};
    let propertyReads = 0;
    if (Array.isArray(value)) {
        const limit = Math.min(value.length, maxEntries);
        for (let index = 0; index < limit; index += 1) {
            if (budget.exhausted || budget.remainingPropertyReads <= 0 || budget.remainingNodes <= 0) break;
            budget.remainingPropertyReads -= 1;
            propertyReads += 1;
            if (!consumeEstimatedBytes(budget, 2)) break;
            result.push(cloneBoundedValue(value[index], budget, depth + 1, seen));
        }
    } else {
        for (const key in value) {
            if (budget.exhausted || budget.remainingPropertyReads <= 0 || budget.remainingNodes <= 0 || propertyReads >= maxEntries) break;
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            const keyBytes = Buffer.byteLength(key, 'utf8') + 4;
            if (!consumeEstimatedBytes(budget, keyBytes)) break;
            budget.remainingPropertyReads -= 1;
            propertyReads += 1;
            result[key] = cloneBoundedValue(value[key], budget, depth + 1, seen, key);
        }
    }
    return result;
}

export function buildBoundedRawCaptureEvent(event = {}, context = {}, maxBytes = 1024 * 1024) {
    const totalBudget = Math.max(1024, Number(maxBytes) || 1024 * 1024);
    const base = {
        schemaVersion: event.schemaVersion || 1,
        requestId: event.requestId || null,
        timestamp: event.timestamp || new Date().toISOString(),
        potluckKey: event.potluckKey ? { hash: event.potluckKey.hash || null } : null,
        request: null,
        originalRequestBody: null,
        processedRequestBody: null
    };
    const baseBytes = Buffer.byteLength(JSON.stringify(base), 'utf8');
    const serializationReserve = Math.min(4096, Math.max(64, Math.floor(totalBudget / 16)));
    const traversalBudget = createTraversalBudget(Math.max(0, totalBudget - baseBytes - serializationReserve));
    const result = {
        ...base,
        request: cloneBoundedValue(event.request, traversalBudget),
        originalRequestBody: context.originalRequestBody == null || traversalBudget.exhausted
            ? null
            : cloneBoundedValue(context.originalRequestBody, traversalBudget),
        processedRequestBody: context.processedRequestBody == null || traversalBudget.exhausted
            ? null
            : cloneBoundedValue(context.processedRequestBody, traversalBudget)
    };
    return Buffer.byteLength(JSON.stringify(result), 'utf8') <= totalBudget ? result : base;
}

export function shouldCaptureRawRequest(options = {}, event = {}) {
    if (options.enabled !== true && options.enabled !== 'true') return false;
    if (options.expiresAt && Date.now() >= new Date(options.expiresAt).getTime()) return false;
    const keyHashes = normalizeKeyHashes(options.keyHashes);
    if (keyHashes.length === 0) return false;
    return keyHashes.includes(event?.potluckKey?.hash);
}

export class RequestAuditRawCaptureStore {
    constructor({
        dir = path.join(process.cwd(), 'configs', 'request-audit-raw'),
        ttlMinutes = 60,
        maxBytes = 1024 * 1024,
        expiresAt = null,
        maxFiles = 100,
        maxTotalBytes = 100 * 1024 * 1024
    } = {}) {
        this.dir = path.resolve(dir);
        this.ttlMinutes = Number(ttlMinutes) || 60;
        this.maxBytes = Number(maxBytes) || 1024 * 1024;
        this.expiresAt = expiresAt || null;
        this.maxFiles = Math.max(1, Number(maxFiles) || 100);
        this.maxTotalBytes = Math.max(1024, Number(maxTotalBytes) || 100 * 1024 * 1024);
    }

    updateOptions({ ttlMinutes, maxBytes, expiresAt, maxFiles, maxTotalBytes } = {}) {
        if (Number(ttlMinutes) > 0) this.ttlMinutes = Number(ttlMinutes);
        if (Number(maxBytes) > 0) this.maxBytes = Number(maxBytes);
        if (expiresAt !== undefined) this.expiresAt = expiresAt || null;
        if (Number(maxFiles) > 0) this.maxFiles = Number(maxFiles);
        if (Number(maxTotalBytes) > 0) this.maxTotalBytes = Number(maxTotalBytes);
    }

    getFilePath(event = {}) {
        const filePath = path.resolve(this.dir, dateKey(event.timestamp), `${safeRequestId(event.requestId)}.json.gz`);
        if (!filePath.startsWith(this.dir)) {
            throw new Error('Raw capture path escaped configured directory');
        }
        return filePath;
    }

    async withCapacityLock(callback) {
        await fsp.mkdir(this.dir, { recursive: true });
        const lockPath = path.join(this.dir, '.capture-capacity.lock');
        const deadline = Date.now() + 5000;
        let handle = null;
        while (!handle) {
            try {
                handle = await fsp.open(lockPath, 'wx', 0o600);
                await handle.writeFile(`${process.pid} ${Date.now()}\n`, 'utf8');
            } catch (error) {
                if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
                const stat = await fsp.stat(lockPath).catch(() => null);
                if (stat && Date.now() - stat.mtimeMs > 30_000) {
                    await fsp.unlink(lockPath).catch(() => {});
                    continue;
                }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
        try {
            return await callback();
        } finally {
            await handle.close().catch(() => {});
            await fsp.unlink(lockPath).catch(() => {});
        }
    }

    async capture(event = {}, { now = new Date() } = {}) {
        if (this.expiresAt && toDate(now).getTime() >= toDate(this.expiresAt).getTime()) {
            return { captured: false, stopReason: 'expired' };
        }
        return this.withCapacityLock(async () => {
            const stats = await this.getStats();
            if (stats.fileCount >= this.maxFiles) return { captured: false, stopReason: 'max_files' };
            if (stats.totalBytes >= this.maxTotalBytes) return { captured: false, stopReason: 'max_total_bytes' };
            const filePath = this.getFilePath(event);
            await fsp.mkdir(path.dirname(filePath), { recursive: true });
            if (fs.existsSync(filePath)) {
                return { captured: false, skipped: 'already_exists', path: filePath };
            }
            const boundedEvent = buildBoundedRawCaptureEvent(event, {
                originalRequestBody: event.originalRequestBody,
                processedRequestBody: event.processedRequestBody
            }, this.maxBytes);
            const payload = {
                schemaVersion: boundedEvent.schemaVersion || 1,
                requestId: boundedEvent.requestId || null,
                timestamp: boundedEvent.timestamp || new Date().toISOString(),
                potluckKeyHash: boundedEvent.potluckKey?.hash || null,
                request: boundedEvent.request || null,
                originalRequestBody: boundedEvent.originalRequestBody || null,
                processedRequestBody: boundedEvent.processedRequestBody || null
            };
            let serialized = JSON.stringify(payload);
            let truncated = false;
            if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
                serialized = serialized.slice(0, this.maxBytes);
                truncated = true;
            }
            const wrapped = JSON.stringify({ truncated, payload: serialized });
            const compressed = await gzip(wrapped);
            if (stats.totalBytes + compressed.length > this.maxTotalBytes) {
                return { captured: false, stopReason: 'max_total_bytes' };
            }
            await fsp.writeFile(filePath, compressed, { mode: 0o600 });
            const eventDate = toDate(event.timestamp);
            await fsp.utimes(filePath, eventDate, eventDate).catch(() => {});
            const stopReason = stats.fileCount + 1 >= this.maxFiles
                ? 'max_files'
                : stats.totalBytes + compressed.length >= this.maxTotalBytes ? 'max_total_bytes' : null;
            return { captured: true, path: filePath, truncated, stopReason };
        });
    }

    async cleanup(now = new Date()) {
        if (!fs.existsSync(this.dir)) return;
        const cutoff = toDate(now).getTime() - this.ttlMinutes * 60 * 1000;
        const removeExpired = async dir => {
            const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await removeExpired(fullPath);
                    await fsp.rmdir(fullPath).catch(() => {});
                    continue;
                }
                if (!entry.isFile() || !entry.name.endsWith('.json.gz')) continue;
                const stat = await fsp.stat(fullPath).catch(() => null);
                if (stat && stat.mtime.getTime() < cutoff) {
                    await fsp.unlink(fullPath).catch(() => {});
                }
            }
        };
        await removeExpired(this.dir);
    }

    async countFiles() {
        return (await this.getStats()).fileCount;
    }

    async getStats() {
        if (!fs.existsSync(this.dir)) return { fileCount: 0, totalBytes: 0 };
        let count = 0;
        let totalBytes = 0;
        const walk = async dir => {
            const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(fullPath);
                } else if (entry.isFile() && entry.name.endsWith('.json.gz')) {
                    count += 1;
                    const stat = await fsp.stat(fullPath).catch(() => null);
                    totalBytes += stat?.size || 0;
                }
            }
        };
        await walk(this.dir);
        return { fileCount: count, totalBytes };
    }
}
