import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import readline from 'readline';
import { finished, pipeline } from 'stream/promises';
import { constants as zlibConstants, createGunzip, createGzip } from 'zlib';

function toDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function dateKeyFromTimestamp(value) {
    const date = toDate(value) || new Date();
    return date.toISOString().slice(0, 10);
}

const AUDIT_FILE_PATTERN = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl(?:\.(\d{8}T\d{9}Z)(?:\.(\d+))?)?(\.gz)?$/;

function parseAuditFileName(name) {
    const match = String(name || '').match(AUDIT_FILE_PATTERN);
    if (!match) return null;
    return {
        dateKey: match[1],
        archived: Boolean(match[2]),
        compressed: Boolean(match[4])
    };
}

function isAuditFile(name) {
    return Boolean(parseAuditFileName(name));
}

function auditFileTimeRange(filePath) {
    const parsed = parseAuditFileName(path.basename(filePath));
    if (!parsed) return null;
    const start = Date.parse(`${parsed.dateKey}T00:00:00.000Z`);
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
        eventIdTailBytes = DEFAULT_EVENT_ID_TAIL_BYTES,
        archiveCompressionAgeHours = 24,
        pipelineImpl = pipeline
    } = {}) {
        this.dir = dir;
        this.archiveDir = archiveDir || path.join(this.dir, 'archived-large');
        this.retentionHours = Number(retentionHours) || 24;
        this.maxFileBytes = Number(maxFileBytes) || 100 * 1024 * 1024;
        this.recentEventIdLimit = Math.max(1, Number(recentEventIdLimit) || DEFAULT_RECENT_EVENT_ID_LIMIT);
        this.eventIdTailBytes = Math.max(1024, Number(eventIdTailBytes) || DEFAULT_EVENT_ID_TAIL_BYTES);
        this.archiveCompressionAgeHours = Math.max(1, Number(archiveCompressionAgeHours) || 24);
        this.pipelineImpl = pipelineImpl;
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
        const seenEventIds = new Set();
        const limit = Math.min(Math.max(Number(filters.limit) || 2000, 0), 2000);
        let scannedBytes = 0;

        for (const filePath of files) {
            try {
                scannedBytes += Number((await fsp.stat(filePath)).size || 0);
                for await (const event of this.readEvents(filePath)) {
                    if (!this.matches(event, { ...filters, since, until })) continue;
                    if (event?.eventId && seenEventIds.has(event.eventId)) continue;
                    if (event?.eventId) seenEventIds.add(event.eventId);
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

    async readIncremental({ since, offsets = null, maxBytes = 32 * 1024 * 1024, onEvent = () => {} } = {}) {
        const files = (await this.listFiles({ since: toDate(since) }))
            .filter(filePath => !filePath.endsWith('.gz'));
        const snapshots = (await Promise.all(files.map(async filePath => {
            const stat = await fsp.stat(filePath).catch(() => null);
            return stat?.isFile() ? {
                filePath, size: stat.size, mtimeMs: stat.mtimeMs,
                identity: `${stat.dev}:${stat.ino}`
            } : null;
        }))).filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs || a.filePath.localeCompare(b.filePath));
        if (offsets === null) {
            return {
                offsets: Object.fromEntries(snapshots.map(file => [file.filePath, {
                    offset: file.size, identity: file.identity
                }])),
                scannedBytes: 0,
                remainingBytes: 0,
                initialized: true
            };
        }
        const nextOffsets = {};
        const offsetByIdentity = new Map(Object.values(offsets)
            .filter(item => item && typeof item === 'object' && item.identity)
            .map(item => [item.identity, Number(item.offset) || 0]));
        let scannedBytes = 0;
        let remainingBudget = Math.max(0, Number(maxBytes) || 0);
        for (const { filePath, size, identity } of snapshots) {
            const previous = offsets[filePath];
            const savedOffset = typeof previous === 'object' && previous !== null
                ? Number(previous.offset) : Number(previous);
            const matchingOffset = Number.isFinite(savedOffset)
                ? savedOffset : (offsetByIdentity.get(identity) || 0);
            let offset = Math.min(Math.max(0, matchingOffset), size);
            if (matchingOffset > size) offset = 0;
            if (remainingBudget > 0 && offset < size) {
                const handle = await fsp.open(filePath, 'r').catch(error => {
                    if (error.code === 'ENOENT') return null;
                    throw error;
                });
                if (handle) {
                    try {
                        let position = offset;
                        let pending = Buffer.alloc(0);
                        while (position < size && remainingBudget > 0) {
                            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - position, remainingBudget));
                            const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
                            if (!bytesRead) break;
                            position += bytesRead;
                            scannedBytes += bytesRead;
                            remainingBudget -= bytesRead;
                            pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
                            let newline;
                            while ((newline = pending.indexOf(10)) >= 0) {
                                const line = pending.subarray(0, newline).toString('utf8').trim();
                                pending = pending.subarray(newline + 1);
                                offset += newline + 1;
                                if (!line) continue;
                                try { onEvent(JSON.parse(line)); } catch (error) {
                                    if (!(error instanceof SyntaxError)) throw error;
                                }
                            }
                            if (pending.length > 4 * 1024 * 1024) {
                                throw new Error('Audit analyzer line exceeds 4 MiB');
                            }
                        }
                    } finally {
                        await handle.close();
                    }
                }
            }
            nextOffsets[filePath] = { offset, identity };
        }
        const remainingBytes = snapshots.reduce((total, file) => total + Math.max(0, file.size - (nextOffsets[file.filePath]?.offset || 0)), 0);
        return { offsets: nextOffsets, scannedBytes, remainingBytes, initialized: false };
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
        const source = fs.createReadStream(filePath);
        const input = filePath.endsWith('.gz') ? source.pipe(createGunzip()) : source;
        input.setEncoding('utf8');
        const lines = readline.createInterface({ input, crlfDelay: Infinity });
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
            input.destroy();
            source.destroy();
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
        if (filters.glmRouting && event?.routing?.glm?.result !== filters.glmRouting) return false;
        if (filters.outcome && event?.status?.outcome !== filters.outcome) return false;
        return true;
    }

    async listFiles({ since = null, until = null } = {}) {
        if (!fs.existsSync(this.dir)) return [];
        const files = [];
        for (const directory of [...new Set([this.dir, this.archiveDir])]) {
            const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(error => {
                if (error?.code === 'ENOENT') return [];
                throw error;
            });
            files.push(...entries
                .filter(entry => entry.isFile() && isAuditFile(entry.name))
                .map(entry => path.join(directory, entry.name)));
        }
        return files
            .filter(filePath => {
                const range = auditFileTimeRange(filePath);
                if (!range) return true;
                if (since && range.end <= since.getTime()) return false;
                if (until && range.start >= until.getTime()) return false;
                return true;
            })
            .sort((left, right) => {
                const leftDate = parseAuditFileName(path.basename(left))?.dateKey || '';
                const rightDate = parseAuditFileName(path.basename(right))?.dateKey || '';
                return leftDate.localeCompare(rightDate) || left.localeCompare(right);
            });
    }

    async cleanup(now = new Date()) {
        if (!fs.existsSync(this.dir)) return;
        const cutoff = toDate(now).getTime() - this.retentionHours * 60 * 60 * 1000;
        const files = await this.listFiles();
        let removed = 0;
        for (const filePath of files) {
            const parsed = parseAuditFileName(path.basename(filePath));
            const fileDate = parsed ? new Date(`${parsed.dateKey}T23:59:59.999Z`) : null;
            if (fileDate && fileDate.getTime() < cutoff) {
                await fsp.unlink(filePath).catch(() => {});
                this.eventIdsByFile.delete(filePath);
                removed += 1;
            }
        }
        const compressed = await this.compressClosedArchives(now);
        return { removed, compressed };
    }

    async compressClosedArchives(now = new Date()) {
        if (!fs.existsSync(this.archiveDir)) return 0;
        const cutoff = toDate(now).getTime() - this.archiveCompressionAgeHours * 60 * 60 * 1000;
        const entries = await fsp.readdir(this.archiveDir, { withFileTypes: true });
        let compressed = 0;
        for (const entry of entries) {
            const parsed = entry.isFile() ? parseAuditFileName(entry.name) : null;
            if (!parsed?.archived || parsed.compressed) continue;
            const sourcePath = path.join(this.archiveDir, entry.name);
            const stat = await fsp.stat(sourcePath).catch(() => null);
            if (!stat?.isFile() || stat.mtimeMs > cutoff) continue;
            if (await this.compressArchiveFile(sourcePath)) compressed += 1;
        }
        return compressed;
    }

    async compressArchiveFile(sourcePath) {
        const destination = `${sourcePath}.gz`;
        if (fs.existsSync(destination)) return false;
        const temporary = `${destination}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const source = fs.createReadStream(sourcePath);
        const compressor = createGzip({ level: zlibConstants.Z_BEST_SPEED });
        const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
        try {
            await this.pipelineImpl(source, compressor, output);
            const handle = await fsp.open(temporary, 'r+');
            try {
                await handle.sync();
            } finally {
                await handle.close();
            }
            await fsp.rename(temporary, destination);
            await fsp.unlink(sourcePath);
            this.eventIdsByFile.delete(sourcePath);
            return true;
        } catch (error) {
            source.destroy();
            compressor.destroy();
            output.destroy();
            await finished(output).catch(() => {});
            await fsp.unlink(temporary).catch(() => {});
            throw error;
        }
    }
}
