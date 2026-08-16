import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const dbPath = workerData.dbPath;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_usage_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        stream_id TEXT,
        hook_name TEXT NOT NULL,
        source_worker_id TEXT,
        created_at TEXT NOT NULL,
        billing_date TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        projected_at TEXT
    );
    CREATE INDEX IF NOT EXISTS runtime_usage_events_billing_date_idx
        ON runtime_usage_events (billing_date, sequence);
    CREATE TABLE IF NOT EXISTS usage_projection_checkpoints (
        projection_name TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
`);
const runtimeEventColumns = new Set(db.prepare('PRAGMA table_info(runtime_usage_events)').all().map(row => row.name));
if (!runtimeEventColumns.has('projected_at')) {
    db.exec('ALTER TABLE runtime_usage_events ADD COLUMN projected_at TEXT');
}

const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO runtime_usage_events (
        event_id, stream_id, hook_name, source_worker_id, created_at, billing_date, payload_json
    ) VALUES (
        @eventId, @streamId, @hookName, @sourceWorkerId, @createdAt, @billingDate, @payloadJson
    )
`);
const countEvents = db.prepare('SELECT COUNT(*) AS count FROM runtime_usage_events');
const countPendingEvents = db.prepare('SELECT COUNT(*) AS count FROM runtime_usage_events WHERE projected_at IS NULL');
const oldestPendingEvent = db.prepare(`
    SELECT created_at FROM runtime_usage_events
    WHERE projected_at IS NULL ORDER BY sequence LIMIT 1
`);
const pruneEvents = db.prepare('DELETE FROM runtime_usage_events WHERE created_at < ?');
const markProjectedEvent = db.prepare(`
    UPDATE runtime_usage_events
    SET projected_at = COALESCE(projected_at, CURRENT_TIMESTAMP)
    WHERE event_id = ?
`);
const markProjectedTransaction = db.transaction(eventIds => {
    let updated = 0;
    for (const eventId of eventIds) updated += markProjectedEvent.run(eventId).changes;
    return updated;
});
const appendTransaction = db.transaction(events => {
    const insertedEventIds = [];
    let payloadBytes = 0;
    for (const event of events) {
        const payloadJson = JSON.stringify(event);
        const createdAt = event.createdAt || new Date().toISOString();
        const result = insertEvent.run({
            eventId: event.eventId,
            streamId: event.streamId || null,
            hookName: event.hookName || 'unknown',
            sourceWorkerId: event.sourceWorkerId || null,
            createdAt,
            billingDate: getBeijingDateKey(createdAt),
            payloadJson
        });
        if (result.changes > 0) {
            insertedEventIds.push(event.eventId);
            payloadBytes += Buffer.byteLength(payloadJson, 'utf8');
        }
    }
    return { insertedEventIds, payloadBytes };
});

const metrics = {
    commits: 0,
    bytesWritten: 0,
    lastBatchSize: 0,
    lastCommitMs: 0,
    lastCommittedAt: null
};

function getBeijingDateKey(value) {
    const date = new Date(value);
    const timestamp = Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
    return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function appendBatch(events = []) {
    const normalized = events.filter(event => event?.eventId);
    const startedAt = performance.now();
    const { insertedEventIds, payloadBytes } = appendTransaction(normalized);
    const pendingEventIds = normalized
        .filter(event => db.prepare(`
            SELECT 1 FROM runtime_usage_events WHERE event_id = ? AND projected_at IS NULL
        `).get(event.eventId))
        .map(event => event.eventId);
    metrics.commits += 1;
    metrics.bytesWritten += payloadBytes;
    metrics.lastBatchSize = normalized.length;
    metrics.lastCommitMs = performance.now() - startedAt;
    metrics.lastCommittedAt = new Date().toISOString();
    return {
        inserted: insertedEventIds.length,
        duplicates: normalized.length - insertedEventIds.length,
        insertedEventIds,
        pendingEventIds,
        commitMs: metrics.lastCommitMs,
        bytesWritten: payloadBytes
    };
}

function snapshot() {
    const events = Number(countEvents.get()?.count || 0);
    const pending = Number(countPendingEvents.get()?.count || 0);
    const oldestPendingAt = oldestPendingEvent.get()?.created_at || null;
    let databaseBytes = 0;
    for (const suffix of ['', '-wal', '-shm']) {
        try {
            databaseBytes += fs.statSync(`${dbPath}${suffix}`).size;
        } catch {}
    }
    return { ...metrics, events, pending, oldestPendingAt, databaseBytes, dbPath };
}

parentPort.on('message', message => {
    const { id, action, payload } = message || {};
    try {
        let result;
        if (action === 'appendBatch') result = appendBatch(payload?.events);
        else if (action === 'markProjected') {
            const eventIds = [...new Set((payload?.eventIds || []).filter(Boolean))];
            result = { updated: markProjectedTransaction(eventIds) };
        }
        else if (action === 'countEvents') result = Number(countEvents.get()?.count || 0);
        else if (action === 'snapshot') result = snapshot();
        else if (action === 'prune') result = { deleted: pruneEvents.run(payload.before).changes };
        else if (action === 'checkpoint') {
            db.pragma('wal_checkpoint(TRUNCATE)');
            result = snapshot();
        } else if (action === 'close') {
            db.pragma('wal_checkpoint(TRUNCATE)');
            db.close();
            result = true;
        } else {
            throw new Error(`Unknown usage event store action: ${action}`);
        }
        parentPort.postMessage({ id, result });
        if (action === 'close') process.nextTick(() => process.exit(0));
    } catch (error) {
        parentPort.postMessage({ id, error: { message: error.message, stack: error.stack } });
    }
});
