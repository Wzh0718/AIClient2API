import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const dbPath = workerData.dbPath;
const PROJECTION_NAMES = ['api-potluck', 'model-usage-stats', 'request-audit'];
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
    CREATE TABLE IF NOT EXISTS runtime_usage_projections (
        event_id TEXT NOT NULL,
        projection_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_success_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (event_id, projection_name),
        FOREIGN KEY (event_id) REFERENCES runtime_usage_events(event_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS runtime_usage_projections_pending_idx
        ON runtime_usage_projections (status, next_attempt_at, projection_name);
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
const insertProjection = db.prepare(`
    INSERT OR IGNORE INTO runtime_usage_projections (event_id, projection_name)
    VALUES (?, ?)
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
    const completeAll = db.prepare(`
        UPDATE runtime_usage_projections
        SET status = 'completed', last_error = NULL, last_success_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE event_id = ?
    `);
    for (const eventId of eventIds) {
        completeAll.run(eventId);
        updated += markProjectedEvent.run(eventId).changes;
    }
    return updated;
});
const selectProjectionPending = db.prepare(`
    SELECT p.event_id, p.projection_name, p.attempts, e.payload_json
    FROM runtime_usage_projections p
    JOIN runtime_usage_events e ON e.event_id = p.event_id
    WHERE p.status != 'completed' AND p.next_attempt_at <= ?
    ORDER BY e.sequence, p.projection_name
    LIMIT ?
`);
const completeProjectionStatement = db.prepare(`
    UPDATE runtime_usage_projections
    SET status = 'completed', last_error = NULL, last_success_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE event_id = ? AND projection_name = ?
`);
const failProjectionStatement = db.prepare(`
    UPDATE runtime_usage_projections
    SET status = 'pending', attempts = attempts + 1, next_attempt_at = ?, last_error = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE event_id = ? AND projection_name = ?
`);
const countProjectionLag = db.prepare(`
    SELECT COUNT(*) AS count FROM runtime_usage_projections
    WHERE projection_name = ? AND status != 'completed'
`);
const projectionLastState = db.prepare(`
    SELECT last_error, last_success_at FROM runtime_usage_projections
    WHERE projection_name = ?
    ORDER BY updated_at DESC LIMIT 1
`);
const projectionRetryState = db.prepare(`
    SELECT COALESCE(MAX(attempts), 0) AS attempts, MIN(updated_at) AS oldest_pending_at
    FROM runtime_usage_projections
    WHERE projection_name = ? AND status != 'completed'
`);
const countEventProjectionLag = db.prepare(`
    SELECT COUNT(*) AS count FROM runtime_usage_projections
    WHERE event_id = ? AND status != 'completed'
`);
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
        for (const projectionName of PROJECTION_NAMES) insertProjection.run(event.eventId, projectionName);
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
    const projections = {};
    for (const projectionName of PROJECTION_NAMES) {
        const state = projectionLastState.get(projectionName) || {};
        const retryState = projectionRetryState.get(projectionName) || {};
        projections[projectionName] = {
            lag: Number(countProjectionLag.get(projectionName)?.count || 0),
            attempts: Number(retryState.attempts || 0),
            lastError: state.last_error || null,
            lastSuccessAt: state.last_success_at || null,
            oldestPendingAgeMs: retryState.oldest_pending_at
                ? Math.max(0, Date.now() - Date.parse(`${retryState.oldest_pending_at}Z`))
                : 0
        };
    }
    return { ...metrics, events, pending, oldestPendingAt, projections, databaseBytes, dbPath };
}

function refreshProjectedAt(eventId) {
    if (Number(countEventProjectionLag.get(eventId)?.count || 0) === 0) markProjectedEvent.run(eventId);
}

parentPort.on('message', message => {
    const { id, action, payload } = message || {};
    try {
        let result;
        if (action === 'appendBatch') result = appendBatch(payload?.events);
        else if (action === 'listPendingProjections') {
            result = selectProjectionPending.all(Date.now(), Math.max(1, Number(payload?.limit || 100)))
                .map(row => {
                    const event = JSON.parse(row.payload_json);
                    return {
                        eventId: row.event_id,
                        projectionName: row.projection_name,
                        attempts: Number(row.attempts || 0),
                        hookName: event.hookName,
                        args: event.args || []
                    };
                });
        }
        else if (action === 'completeProjection') {
            completeProjectionStatement.run(payload.eventId, payload.projectionName);
            refreshProjectedAt(payload.eventId);
            result = true;
        }
        else if (action === 'failProjection') {
            failProjectionStatement.run(
                Date.now() + Math.max(0, Number(payload.retryDelayMs || 0)),
                String(payload.error || 'projection failed').slice(0, 1000),
                payload.eventId,
                payload.projectionName
            );
            result = true;
        }
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
