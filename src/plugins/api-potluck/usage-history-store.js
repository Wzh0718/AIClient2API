import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

let database = null;
let databasePath = null;
let usageEventStatements = null;
let usageEventBatchActive = false;

function keyRef(apiKey) {
    return `sha256:${crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16)}`;
}

function getDatabase() {
    const target = process.env.USAGE_EVENT_DB_PATH
        || path.join(process.cwd(), 'configs', 'usage-events', 'usage-events.sqlite');
    if (database && databasePath === target) return database;
    database?.close();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    database = new Database(target);
    databasePath = target;
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.pragma('busy_timeout = 5000');
    database.exec(`
        CREATE TABLE IF NOT EXISTS potluck_usage_history (
            key_ref TEXT NOT NULL,
            usage_date TEXT NOT NULL,
            day_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (key_ref, usage_date)
        );
        CREATE TABLE IF NOT EXISTS potluck_usage_migrations (
            source_sha256 TEXT PRIMARY KEY,
            source_path TEXT NOT NULL,
            imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            key_count INTEGER NOT NULL,
            day_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS potluck_applied_events (
            event_id TEXT PRIMARY KEY,
            key_ref TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS potluck_usage_totals (
            key_ref TEXT PRIMARY KEY,
            total_models_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS potluck_usage_model_totals (
            key_ref TEXT NOT NULL,
            model_name TEXT NOT NULL,
            usage_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (key_ref, model_name)
        );
        CREATE TABLE IF NOT EXISTS potluck_usage_write_metrics (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            event_day_writes INTEGER NOT NULL DEFAULT 0,
            event_model_writes INTEGER NOT NULL DEFAULT 0,
            full_history_day_writes INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO potluck_usage_write_metrics (singleton) VALUES (1);
    `);
    return database;
}

function getUsageEventStatements() {
    const db = getDatabase();
    if (usageEventStatements?.db === db) return usageEventStatements;
    const statements = {
        db,
        hasApplied: db.prepare('SELECT 1 FROM potluck_applied_events WHERE event_id = ?'),
        upsertDay: db.prepare(`
            INSERT INTO potluck_usage_history (key_ref, usage_date, day_json, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key_ref, usage_date) DO UPDATE SET
                day_json = excluded.day_json,
                updated_at = CURRENT_TIMESTAMP
        `),
        recordEvent: db.prepare('INSERT INTO potluck_applied_events (event_id, key_ref) VALUES (?, ?)'),
        upsertModel: db.prepare(`
            INSERT INTO potluck_usage_model_totals (key_ref, model_name, usage_json, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key_ref, model_name) DO UPDATE SET
                usage_json = excluded.usage_json,
                updated_at = CURRENT_TIMESTAMP
        `),
        trimHistory: db.prepare(`
            DELETE FROM potluck_usage_history
            WHERE key_ref = ? AND usage_date NOT IN (
                SELECT usage_date FROM potluck_usage_history
                WHERE key_ref = ? ORDER BY usage_date DESC LIMIT ?
            )
        `),
        recordMetrics: db.prepare(`
            UPDATE potluck_usage_write_metrics
            SET event_day_writes = event_day_writes + 1,
                event_model_writes = event_model_writes + ?
            WHERE singleton = 1
        `)
    };
    statements.applyOne = (ref, change, eventId) => {
        statements.upsertDay.run(ref, change.usageDate, JSON.stringify(change.day));
        if (change.modelName) {
            statements.upsertModel.run(ref, change.modelName, JSON.stringify(change.modelUsage || {}));
        }
        statements.trimHistory.run(ref, ref, Math.max(1, Number(change.retentionDays || 35)));
        statements.recordEvent.run(eventId, ref);
        statements.recordMetrics.run(change.modelName ? 1 : 0);
    };
    statements.apply = db.transaction(statements.applyOne);
    usageEventStatements = statements;
    return statements;
}

export function loadUsageHistory(apiKey) {
    const rows = getDatabase().prepare(`
        SELECT usage_date, day_json FROM potluck_usage_history
        WHERE key_ref = ? ORDER BY usage_date
    `).all(keyRef(apiKey));
    const history = {};
    for (const row of rows) history[row.usage_date] = JSON.parse(row.day_json);
    return history;
}

export function loadUsageTotals(apiKey) {
    const db = getDatabase();
    const ref = keyRef(apiKey);
    const modelRows = db.prepare(`
        SELECT model_name, usage_json FROM potluck_usage_model_totals WHERE key_ref = ?
    `).all(ref);
    if (modelRows.length > 0) {
        return Object.fromEntries(modelRows.map(row => [row.model_name, JSON.parse(row.usage_json)]));
    }
    const row = db.prepare(`
        SELECT total_models_json FROM potluck_usage_totals WHERE key_ref = ?
    `).get(ref);
    return row ? JSON.parse(row.total_models_json) : {};
}

function persistUsageTotalsInDatabase(db, ref, totalModels = {}) {
    db.prepare(`
        INSERT INTO potluck_usage_totals (key_ref, total_models_json, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key_ref) DO UPDATE SET
            total_models_json = excluded.total_models_json,
            updated_at = CURRENT_TIMESTAMP
    `).run(ref, JSON.stringify(totalModels || {}));
    const upsertModel = db.prepare(`
        INSERT INTO potluck_usage_model_totals (key_ref, model_name, usage_json, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key_ref, model_name) DO UPDATE SET
            usage_json = excluded.usage_json,
            updated_at = CURRENT_TIMESTAMP
    `);
    const removeModels = db.prepare('DELETE FROM potluck_usage_model_totals WHERE key_ref = ?');
    removeModels.run(ref);
    for (const [modelName, usage] of Object.entries(totalModels || {})) {
        upsertModel.run(ref, modelName, JSON.stringify(usage));
    }
}

export function persistUsageHistory(apiKey, usageHistory = {}, totalModels = {}) {
    const db = getDatabase();
    const ref = keyRef(apiKey);
    const upsert = db.prepare(`
        INSERT INTO potluck_usage_history (key_ref, usage_date, day_json, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key_ref, usage_date) DO UPDATE SET
            day_json = excluded.day_json,
            updated_at = CURRENT_TIMESTAMP
    `);
    const remove = db.prepare('DELETE FROM potluck_usage_history WHERE key_ref = ? AND usage_date = ?');
    const existing = db.prepare('SELECT usage_date FROM potluck_usage_history WHERE key_ref = ?').all(ref)
        .map(row => row.usage_date);
    const dates = new Set(Object.keys(usageHistory || {}));
    db.transaction(() => {
        for (const [date, day] of Object.entries(usageHistory || {})) upsert.run(ref, date, JSON.stringify(day));
        for (const date of existing) if (!dates.has(date)) remove.run(ref, date);
        persistUsageTotalsInDatabase(db, ref, totalModels);
        db.prepare(`
            UPDATE potluck_usage_write_metrics
            SET full_history_day_writes = full_history_day_writes + ?
            WHERE singleton = 1
        `).run(Object.keys(usageHistory || {}).length);
    })();
    return true;
}

export function hasAppliedUsageEvent(eventId) {
    if (!eventId) return false;
    return Boolean(getUsageEventStatements().hasApplied.get(eventId));
}

export function persistUsageHistoryEvent(apiKey, change = {}, eventId) {
    if (!eventId) {
        return persistUsageHistory(apiKey, change.usageHistory || {}, change.totalModels || {});
    }
    const ref = keyRef(apiKey);
    const statements = getUsageEventStatements();
    const alreadyApplied = statements.hasApplied.get(eventId);
    if (alreadyApplied) return { applied: false, duplicate: true };
    if (usageEventBatchActive) statements.applyOne(ref, change, eventId);
    else statements.apply(ref, change, eventId);
    return { applied: true, duplicate: false };
}

export function beginUsageHistoryEventBatch() {
    if (usageEventBatchActive) throw new Error('Potluck usage event batch is already active');
    getDatabase().exec('BEGIN IMMEDIATE');
    usageEventBatchActive = true;
}

export function commitUsageHistoryEventBatch() {
    if (!usageEventBatchActive) return;
    try {
        getDatabase().exec('COMMIT');
        usageEventBatchActive = false;
    } catch (error) {
        try {
            getDatabase().exec('ROLLBACK');
        } finally {
            usageEventBatchActive = false;
        }
        throw error;
    }
}

export function rollbackUsageHistoryEventBatch() {
    if (!usageEventBatchActive) return;
    try {
        getDatabase().exec('ROLLBACK');
    } finally {
        usageEventBatchActive = false;
    }
}

export function importLegacyUsageHistories({ sourceSha256, sourcePath, histories = [] }) {
    const db = getDatabase();
    const alreadyImported = db.prepare(`
        SELECT 1 FROM potluck_usage_migrations WHERE source_sha256 = ?
    `).get(sourceSha256);
    if (alreadyImported) return { imported: false, sourceSha256 };

    const upsert = db.prepare(`
        INSERT INTO potluck_usage_history (key_ref, usage_date, day_json, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key_ref, usage_date) DO UPDATE SET
            day_json = excluded.day_json,
            updated_at = CURRENT_TIMESTAMP
    `);
    const recordMigration = db.prepare(`
        INSERT INTO potluck_usage_migrations (
            source_sha256, source_path, key_count, day_count
        ) VALUES (?, ?, ?, ?)
    `);
    let dayCount = 0;
    db.transaction(() => {
        for (const { apiKey, usageHistory = {}, totalModels = {} } of histories) {
            const ref = keyRef(apiKey);
            for (const [date, day] of Object.entries(usageHistory)) {
                upsert.run(ref, date, JSON.stringify(day));
                dayCount += 1;
            }
            persistUsageTotalsInDatabase(db, ref, totalModels);
        }
        recordMigration.run(sourceSha256, sourcePath, histories.length, dayCount);
    })();
    return { imported: true, sourceSha256, keyCount: histories.length, dayCount };
}

export function deleteUsageHistory(apiKey) {
    const db = getDatabase();
    const ref = keyRef(apiKey);
    db.transaction(() => {
        db.prepare('DELETE FROM potluck_usage_history WHERE key_ref = ?').run(ref);
        db.prepare('DELETE FROM potluck_usage_totals WHERE key_ref = ?').run(ref);
        db.prepare('DELETE FROM potluck_usage_model_totals WHERE key_ref = ?').run(ref);
    })();
}

export function closeUsageHistoryStore() {
    if (usageEventBatchActive) rollbackUsageHistoryEventBatch();
    database?.close();
    database = null;
    databasePath = null;
    usageEventStatements = null;
}
