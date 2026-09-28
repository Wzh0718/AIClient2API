import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import { atomicWriteFile } from '../../utils/file-lock.js';

function dateKeyFromTimestamp(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function isAnalysisFile(name) {
    return /^analysis-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name);
}

export class RequestAuditAnalysisStore {
    constructor({
        dir = path.join(process.cwd(), 'configs', 'request-audit-analysis'),
        freshSeconds = 5 * 60,
        cacheMaxFiles = 32,
        cacheMaxBytes = 32 * 1024 * 1024
    } = {}) {
        this.dir = dir;
        this.freshSeconds = Number(freshSeconds) || 300;
        this.cacheMaxFiles = cacheMaxFiles;
        this.cacheMaxBytes = cacheMaxBytes;
        this.fileCache = new Map();
        this.cacheBytes = 0;
    }

    getFilePath(timestamp = new Date()) {
        return path.join(this.dir, `analysis-${dateKeyFromTimestamp(timestamp)}.jsonl`);
    }

    getLatestPath() {
        return path.join(this.dir, 'latest.json');
    }

    getCheckpointPath() {
        return path.join(this.dir, 'incremental-checkpoint.json');
    }

    async readCheckpoint() {
        try {
            const state = JSON.parse(await fsp.readFile(this.getCheckpointPath(), 'utf8'));
            return state?.version === 1 && state.offsets && Array.isArray(state.recent) ? state : null;
        } catch {
            return null;
        }
    }

    async writeCheckpoint(state) {
        await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
        await atomicWriteFile(this.getCheckpointPath(), JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    }

    async appendDiagnostics(diagnostics = [], { generatedAt = new Date().toISOString(), complete = true, backlogBytes = 0 } = {}) {
        await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
        if (diagnostics.length) {
            const filePath = this.getFilePath(generatedAt);
            const content = diagnostics.filter(item => item?.requestId)
                .map(item => JSON.stringify({ ...item, generatedAt })).join('\n');
            if (content) await fsp.appendFile(filePath, `${content}\n`, { encoding: 'utf8', mode: 0o600 });
            this.evictFile(filePath);
        }
        await atomicWriteFile(this.getLatestPath(), JSON.stringify({
            generatedAt, count: diagnostics.length, complete, backlogBytes
        }), { encoding: 'utf8', mode: 0o600 });
    }

    async writeDiagnostics(diagnostics = [], { generatedAt = new Date().toISOString() } = {}) {
        await fsp.mkdir(this.dir, { recursive: true });
        const filePath = this.getFilePath(generatedAt);
        const content = diagnostics
            .filter(item => item?.requestId)
            .map(item => JSON.stringify({ ...item, generatedAt }))
            .join('\n');
        await fsp.writeFile(filePath, content ? `${content}\n` : '', { encoding: 'utf8', mode: 0o600 });
        this.evictFile(filePath);
        await fsp.writeFile(this.getLatestPath(), JSON.stringify({
            generatedAt,
            count: diagnostics.length
        }, null, 2), { encoding: 'utf8', mode: 0o600 });
    }

    evictFile(filePath) {
        this.cacheBytes -= this.fileCache.get(filePath)?.bytes || 0;
        this.fileCache.delete(filePath);
    }

    async readAnalysisFile(filePath) {
        const stat = await fsp.stat(filePath).catch(() => null);
        if (!stat) { this.evictFile(filePath); return new Map(); }
        const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        const cached = this.fileCache.get(filePath);
        if (cached?.signature === signature) {
            this.fileCache.delete(filePath);
            this.fileCache.set(filePath, cached);
            return cached.items;
        }
        this.evictFile(filePath);
        const content = await fsp.readFile(filePath, 'utf8').catch(() => null);
        const items = new Map();
        if (content === null) return items;
        for (const line of content.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const item = JSON.parse(line);
                if (item.requestId) items.set(item.requestId, item);
            } catch { /* Incomplete or malformed analysis rows are ignored. */ }
        }
        // Account for parsed objects as well as source text; never retain an oversized file.
        const bytes = Buffer.byteLength(content) * 4 + items.size * 128;
        const after = await fsp.stat(filePath).catch(() => null);
        if (after && signature === `${after.size}:${after.mtimeMs}:${after.ctimeMs}` && bytes <= this.cacheMaxBytes && this.cacheMaxFiles > 0) {
            while (this.fileCache.size && (this.fileCache.size >= this.cacheMaxFiles || this.cacheBytes + bytes > this.cacheMaxBytes)) {
                this.evictFile(this.fileCache.keys().next().value);
            }
            // A concurrent reader may have populated the same entry while we awaited IO.
            this.evictFile(filePath);
            this.fileCache.set(filePath, { signature, bytes, items });
            this.cacheBytes += bytes;
        }
        return items;
    }

    async readDiagnostics({ requestIds = [], all = false } = {}) {
        if (!all && requestIds.length === 0) return {};
        const wanted = new Set(requestIds.filter(Boolean));
        if (!all && wanted.size === 0) return {};
        const files = await this.listFiles();
        const present = new Set(files);
        for (const filePath of this.fileCache.keys()) if (!present.has(filePath)) this.evictFile(filePath);
        const result = {};
        for (const filePath of files) {
            const items = await this.readAnalysisFile(filePath);
            if (all) {
                for (const [id, item] of items) Object.defineProperty(result, id, { value: item, enumerable: true, configurable: true });
            } else {
                for (const id of wanted) if (items.has(id)) Object.defineProperty(result, id, { value: items.get(id), enumerable: true, configurable: true });
            }
        }
        return result;
    }

    async readFreshness(now = new Date()) {
        const latestPath = this.getLatestPath();
        if (!fs.existsSync(latestPath)) {
            return { status: 'missing', generatedAt: null, staleSeconds: null };
        }
        try {
            const latest = JSON.parse(await fsp.readFile(latestPath, 'utf8'));
            const generatedAt = latest.generatedAt || null;
            const generatedTime = generatedAt ? new Date(generatedAt).getTime() : NaN;
            if (!Number.isFinite(generatedTime)) {
                return { status: 'missing', generatedAt: null, staleSeconds: null };
            }
            const staleSeconds = Math.max(0, Math.floor((now.getTime() - generatedTime) / 1000));
            return {
                generatedAt,
                staleSeconds,
                status: latest.complete === false || staleSeconds > this.freshSeconds ? 'stale' : 'fresh',
                backlogBytes: Number(latest.backlogBytes || 0)
            };
        } catch (_error) {
            return { status: 'missing', generatedAt: null, staleSeconds: null };
        }
    }

    async listFiles() {
        if (!fs.existsSync(this.dir)) return [];
        const entries = await fsp.readdir(this.dir, { withFileTypes: true });
        return entries
            .filter(entry => entry.isFile() && isAnalysisFile(entry.name))
            .map(entry => path.join(this.dir, entry.name))
            .sort();
    }
}
