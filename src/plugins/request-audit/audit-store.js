import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import readline from 'readline';

function toDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function dateKeyFromTimestamp(value) {
    const date = toDate(value) || new Date();
    return date.toISOString().slice(0, 10);
}

function isAuditFile(name) {
    return /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name);
}

function auditFileTimeRange(filePath) {
    const match = path.basename(filePath).match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!match) return null;
    const start = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (!Number.isFinite(start)) return null;
    return { start, end: start + 24 * 60 * 60 * 1000 };
}

function archiveTimestamp(value = new Date()) {
    return value.toISOString().replace(/[-:]/g, '').replace('.', '');
}

const DEFAULT_RECENT_EVENT_ID_LIMIT = 20_000;
const DEFAULT_EVENT_ID_TAIL_BYTES = 8 * 1024 * 1024;

export class RequestAuditStore {
    constructor({
        dir = path.join(process.cwd(), 'configs', 'request-audit'),
        archiveDir,
        retentionHours = 24,
        maxFileBytes = 100 * 1024 * 1024,
        recentEventIdLimit = DEFAULT_RECENT_EVENT_ID_LIMIT,
        eventIdTailBytes = DEFAULT_EVENT_ID_TAIL_BYTES
    } = {}) {
        this.dir = dir;
        this.archiveDir = archiveDir || path.join(this.dir, 'archived-large');
        this.retentionHours = Number(retentionHours) || 24;
        this.maxFileBytes = Number(maxFileBytes) || 100 * 1024 * 1024;
        this.recentEventIdLimit = Math.max(1, Number(recentEventIdLimit) || DEFAULT_RECENT_EVENT_ID_LIMIT);
        this.eventIdTailBytes = Math.max(1024, Number(eventIdTailBytes) || DEFAULT_EVENT_ID_TAIL_BYTES);
        this.eventIdsByFile = new Map();
        this.lastQueryStats = { scannedFiles: 0, scannedBytes: 0 };
    }

    getFilePath(timestamp = new Date()) {
        return path.join(this.dir, `audit-${dateKeyFromTimestamp(timestamp)}.jsonl`);
    }

    async append(event) {
        const result = await this.appendBatch([event]);
        return result.results[0] || { appended: false, duplicate: false };
    }

    async appendBatch(events = []) {
        await fsp.mkdir(this.dir, { recursive: true });
        const grouped = new Map();
        const results = new Array(events.length);
        for (const [index, event] of events.entries()) {
            const filePath = this.getFilePath(event?.timestamp);
            if (!grouped.has(filePath)) grouped.set(filePath, []);
            grouped.get(filePath).push({ event, index });
        }

        for (const [filePath, entries] of grouped.entries()) {
            const eventIds = await this.loadEventIds(filePath);
            const accepted = [];
            const batchIds = new Set();
            for (const entry of entries) {
                const eventId = entry.event?.eventId || null;
                if (eventId && (eventIds.has(eventId) || batchIds.has(eventId))) {
                    results[entry.index] = { appended: false, duplicate: true };
                    continue;
                }
                accepted.push(entry);
                if (eventId) batchIds.add(eventId);
            }
            if (accepted.length === 0) continue;
            const content = accepted.map(({ event }) => JSON.stringify(event)).join('\n') + '\n';
            await this.rotateIfNeeded(filePath, Buffer.byteLength(content, 'utf8'));
            await fsp.appendFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
            for (const { event, index } of accepted) {
                if (event?.eventId) this.rememberEventId(eventIds, event.eventId);
                results[index] = { appended: true, duplicate: false };
            }
        }
        return {
            appended: results.filter(result => result?.appended).length,
            duplicates: results.filter(result => result?.duplicate).length,
            results
        };
    }

    async loadEventIds(filePath) {
        if (this.eventIdsByFile.has(filePath)) return this.eventIdsByFile.get(filePath);
        const eventIds = new Set();
        if (fs.existsSync(filePath)) {
            const handle = await fsp.open(filePath, 'r');
            try {
                const stat = await handle.stat();
                const readBytes = Math.min(stat.size, this.eventIdTailBytes);
                const buffer = Buffer.alloc(readBytes);
                await handle.read(buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
                const lines = buffer.toString('utf8').split('\n');
                if (stat.size > readBytes) lines.shift();
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const event = JSON.parse(line);
                        if (event?.eventId) this.rememberEventId(eventIds, event.eventId);
                    } catch {}
                }
            } finally {
                await handle.close();
            }
        }
        this.eventIdsByFile.set(filePath, eventIds);
        return eventIds;
    }

    rememberEventId(eventIds, eventId) {
        if (!eventId) return;
        if (eventIds.has(eventId)) eventIds.delete(eventId);
        eventIds.add(eventId);
        while (eventIds.size > this.recentEventIdLimit) {
            eventIds.delete(eventIds.values().next().value);
        }
    }

    async query(filters = {}) {
        const since = toDate(filters.since);
        const until = toDate(filters.until);
        const files = await this.listFiles({ since, until });
        const rows = [];
        const limit = Math.min(Math.max(Number(filters.limit) || 2000, 0), 2000);
        let scannedBytes = 0;

        for (const filePath of files) {
            try {
                scannedBytes += Number((await fsp.stat(filePath)).size || 0);
                for await (const event of this.readEvents(filePath)) {
                    if (!this.matches(event, { ...filters, since, until })) continue;
                    rows.push(event);
                    if (limit && rows.length >= limit) break;
                }
            } catch (_error) {
                continue;
            }
            if (limit && rows.length >= limit) break;
        }
        this.lastQueryStats = { scannedFiles: files.length, scannedBytes };

        rows.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
        return limit ? rows.slice(0, limit) : rows;
    }

    getLastQueryStats() {
        return { ...this.lastQueryStats };
    }

    async rotateIfNeeded(filePath, incomingBytes = 0) {
        const maxFileBytes = Number(this.maxFileBytes);
        if (!Number.isFinite(maxFileBytes) || maxFileBytes <= 0) return;

        const stat = await fsp.stat(filePath).catch(error => {
            if (error?.code === 'ENOENT') return null;
            throw error;
        });
        if (!stat?.isFile() || stat.size + incomingBytes <= maxFileBytes) return;

        await fsp.mkdir(this.archiveDir, { recursive: true, mode: 0o700 });
        const destination = await this.getArchivePath(filePath);
        await fsp.rename(filePath, destination).catch(error => {
            if (error?.code !== 'ENOENT') throw error;
        });
        this.eventIdsByFile.delete(filePath);
    }

    async getArchivePath(filePath) {
        const baseName = `${path.basename(filePath)}.${archiveTimestamp()}`;
        let destination = path.join(this.archiveDir, baseName);
        for (let index = 1; index < 1000; index += 1) {
            if (!fs.existsSync(destination)) return destination;
            destination = path.join(this.archiveDir, `${baseName}.${index}`);
        }
        return destination;
    }

    async *readEvents(filePath) {
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
        const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
        try {
            for await (const line of lines) {
                if (!line.trim()) continue;
                try {
                    yield JSON.parse(line);
                } catch (_error) {
                    // Ignore corrupted partial lines instead of failing the whole query.
                }
            }
        } finally {
            lines.close();
            stream.destroy();
        }
    }

    matches(event, filters) {
        const timestamp = toDate(event?.timestamp);
        if (filters.since && timestamp && timestamp < filters.since) return false;
        if (filters.until && timestamp && timestamp >= filters.until) return false;
        if (filters.keyHash && event?.potluckKey?.hash !== filters.keyHash) return false;
        if (filters.keyPrefix && event?.potluckKey?.prefix !== filters.keyPrefix) return false;
        if (filters.requestId && event?.requestId !== filters.requestId) return false;
        if (filters.clientIp && event?.network?.clientIp !== filters.clientIp) return false;
        if (filters.path && event?.request?.path !== filters.path) return false;
        if (filters.model && event?.request?.model !== filters.model) return false;
        if (filters.provider && event?.request?.toProvider !== filters.provider) return false;
        if (filters.outcome && event?.status?.outcome !== filters.outcome) return false;
        return true;
    }

    async listFiles({ since = null, until = null } = {}) {
        if (!fs.existsSync(this.dir)) return [];
        const entries = await fsp.readdir(this.dir, { withFileTypes: true });
        return entries
            .filter(entry => entry.isFile() && isAuditFile(entry.name))
            .map(entry => path.join(this.dir, entry.name))
            .filter(filePath => {
                const range = auditFileTimeRange(filePath);
                if (!range) return true;
                if (since && range.end <= since.getTime()) return false;
                if (until && range.start >= until.getTime()) return false;
                return true;
            })
            .sort();
    }

    async cleanup(now = new Date()) {
        if (!fs.existsSync(this.dir)) return;
        const cutoff = toDate(now).getTime() - this.retentionHours * 60 * 60 * 1000;
        const files = await this.listFiles();
        for (const filePath of files) {
            const match = path.basename(filePath).match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);
            const fileDate = match ? new Date(`${match[1]}T23:59:59.999Z`) : null;
            if (fileDate && fileDate.getTime() < cutoff) {
                await fsp.unlink(filePath).catch(() => {});
                this.eventIdsByFile.delete(filePath);
            }
        }
    }
}
