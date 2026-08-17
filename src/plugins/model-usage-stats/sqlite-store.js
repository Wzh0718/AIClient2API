import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

let database = null;
let databasePath = null;
let modelEventStatements = null;
let modelEventBatchActive = false;

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
        CREATE TABLE IF NOT EXISTS model_usage_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            state_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS model_usage_applied_events (
            event_id TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS model_usage_meta (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            updated_at_value TEXT,
            summary_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_usage_providers (
            provider_name TEXT PRIMARY KEY,
            state_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_usage_accounts (
            account_key TEXT PRIMARY KEY,
            state_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_usage_daily (
            usage_date TEXT PRIMARY KEY,
            state_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_usage_account_events (
            account_key TEXT PRIMARY KEY,
            events_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS model_usage_account_event_rows (
            account_key TEXT NOT NULL,
            event_id TEXT NOT NULL,
            event_timestamp TEXT NOT NULL,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (account_key, event_id)
        );
        CREATE TABLE IF NOT EXISTS model_usage_write_metrics (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            event_writes INTEGER NOT NULL DEFAULT 0,
            event_bytes INTEGER NOT NULL DEFAULT 0,
            full_state_writes INTEGER NOT NULL DEFAULT 0,
            full_state_bytes INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO model_usage_write_metrics (singleton) VALUES (1);
    `);
    return database;
}

function getModelEventStatements() {
    const db = getDatabase();
    if (modelEventStatements?.db === db) return modelEventStatements;
    const statements = {
        db,
        hasApplied: db.prepare('SELECT 1 FROM model_usage_applied_events WHERE event_id = ?'),
        recordEvent: db.prepare('INSERT INTO model_usage_applied_events (event_id) VALUES (?)'),
        upsertMeta: db.prepare(`
            INSERT INTO model_usage_meta (singleton, updated_at_value, summary_json)
            VALUES (1, ?, ?)
            ON CONFLICT(singleton) DO UPDATE SET
                updated_at_value = excluded.updated_at_value,
                summary_json = excluded.summary_json
        `),
        upsertProvider: db.prepare(`
            INSERT INTO model_usage_providers (provider_name, state_json) VALUES (?, ?)
            ON CONFLICT(provider_name) DO UPDATE SET state_json = excluded.state_json
        `),
        upsertAccount: db.prepare(`
            INSERT INTO model_usage_accounts (account_key, state_json) VALUES (?, ?)
            ON CONFLICT(account_key) DO UPDATE SET state_json = excluded.state_json
        `),
        insertAccountEvent: db.prepare(`
            INSERT OR IGNORE INTO model_usage_account_event_rows (
                account_key, event_id, event_timestamp, total_tokens
            ) VALUES (?, ?, ?, ?)
        `),
        upsertDaily: db.prepare(`
            INSERT INTO model_usage_daily (usage_date, state_json) VALUES (?, ?)
            ON CONFLICT(usage_date) DO UPDATE SET state_json = excluded.state_json
        `),
        recordMetrics: db.prepare(`
            UPDATE model_usage_write_metrics
            SET event_writes = event_writes + 1,
                event_bytes = event_bytes + ?
            WHERE singleton = 1
        `)
    };
    statements.applyOne = ({ eventId, state, provider, accountKey, dateKey, accountEvent, parts, eventBytes }) => {
        statements.upsertMeta.run(state.updatedAt || null, parts[0]);
        if (provider) statements.upsertProvider.run(provider, parts[1]);
        if (accountKey) {
            statements.upsertAccount.run(accountKey, parts[2]);
            const latestEvent = accountEvent || (state.accountUsageEvents?.[accountKey] || []).at(-1);
            if (latestEvent) {
                statements.insertAccountEvent.run(
                    accountKey,
                    eventId,
                    latestEvent.timestamp,
                    Number(latestEvent.totalTokens || 0)
                );
            }
        }
        if (dateKey) statements.upsertDaily.run(dateKey, parts[3]);
        statements.recordEvent.run(eventId);
        statements.recordMetrics.run(eventBytes);
    };
    statements.apply = db.transaction(statements.applyOne);
    modelEventStatements = statements;
    return statements;
}

export function loadModelAccountUsageEvents(accountKey, { since = null, until = null } = {}) {
    if (!accountKey) return [];
    const clauses = ['account_key = ?'];
    const parameters = [accountKey];
    if (since) {
        clauses.push('event_timestamp >= ?');
        parameters.push(since instanceof Date ? since.toISOString() : String(since));
    }
    if (until) {
        clauses.push('event_timestamp <= ?');
        parameters.push(until instanceof Date ? until.toISOString() : String(until));
    }
    return getDatabase().prepare(`
        SELECT event_timestamp AS timestamp, total_tokens AS totalTokens
        FROM model_usage_account_event_rows
        WHERE ${clauses.join(' AND ')}
        ORDER BY event_timestamp
    `).all(...parameters).map(row => ({
        timestamp: row.timestamp,
        totalTokens: Number(row.totalTokens || 0)
    }));
}

export function loadModelUsageState() {
    const db = getDatabase();
    const meta = db.prepare('SELECT updated_at_value, summary_json FROM model_usage_meta WHERE singleton = 1').get();
    if (meta) {
        const legacyEvents = Object.fromEntries(db.prepare('SELECT account_key, events_json FROM model_usage_account_events').all()
            .map(row => [row.account_key, JSON.parse(row.events_json)]));
        return {
            updatedAt: meta.updated_at_value || null,
            summary: JSON.parse(meta.summary_json),
            providers: Object.fromEntries(db.prepare('SELECT provider_name, state_json FROM model_usage_providers').all()
                .map(row => [row.provider_name, JSON.parse(row.state_json)])),
            accounts: Object.fromEntries(db.prepare('SELECT account_key, state_json FROM model_usage_accounts').all()
                .map(row => [row.account_key, JSON.parse(row.state_json)])),
            daily: Object.fromEntries(db.prepare('SELECT usage_date, state_json FROM model_usage_daily').all()
                .map(row => [row.usage_date, JSON.parse(row.state_json)])),
            accountUsageEvents: legacyEvents
        };
    }
    const row = db.prepare('SELECT state_json FROM model_usage_state WHERE singleton = 1').get();
    if (!row) return null;
    const state = JSON.parse(row.state_json);
    persistModelUsageState(state);
    return state;
}

export function hasAppliedModelUsageEvent(eventId) {
    if (!eventId) return false;
    return Boolean(getModelEventStatements().hasApplied.get(eventId));
}

export function persistModelUsageState(state) {
    const db = getDatabase();
    const snapshot = JSON.stringify(state);
    const upsertMeta = db.prepare(`
        INSERT INTO model_usage_meta (singleton, updated_at_value, summary_json)
        VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
            updated_at_value = excluded.updated_at_value,
            summary_json = excluded.summary_json
    `);
    const replaceRows = (table, keyColumn, rows) => {
        db.prepare(`DELETE FROM ${table}`).run();
        const statement = db.prepare(`INSERT INTO ${table} (${keyColumn}, state_json) VALUES (?, ?)`);
        for (const [key, value] of Object.entries(rows || {})) statement.run(key, JSON.stringify(value));
    };
    db.transaction(() => {
        upsertMeta.run(state.updatedAt || null, JSON.stringify(state.summary || {}));
        replaceRows('model_usage_providers', 'provider_name', state.providers);
        replaceRows('model_usage_accounts', 'account_key', state.accounts);
        replaceRows('model_usage_daily', 'usage_date', state.daily);
        db.prepare('DELETE FROM model_usage_account_events').run();
        db.prepare('DELETE FROM model_usage_account_event_rows').run();
        const insertEvents = db.prepare('INSERT INTO model_usage_account_events (account_key, events_json) VALUES (?, ?)');
        const insertEventRow = db.prepare(`
            INSERT INTO model_usage_account_event_rows (account_key, event_id, event_timestamp, total_tokens)
            VALUES (?, ?, ?, ?)
        `);
        for (const [key, events] of Object.entries(state.accountUsageEvents || {})) {
            insertEvents.run(key, JSON.stringify(events));
            events.forEach((event, index) => insertEventRow.run(
                key,
                `snapshot:${index}:${event.timestamp || ''}`,
                event.timestamp || new Date(0).toISOString(),
                Number(event.totalTokens || 0)
            ));
        }
        db.prepare(`
            UPDATE model_usage_write_metrics
            SET full_state_writes = full_state_writes + 1,
                full_state_bytes = full_state_bytes + ?
            WHERE singleton = 1
        `).run(Buffer.byteLength(snapshot, 'utf8'));
    })();
}

export function persistModelUsageEvent(eventId, state, { provider, accountKey, dateKey, accountEvent = null } = {}) {
    if (!eventId) {
        persistModelUsageState(state);
        return { applied: true, duplicate: false };
    }
    const statements = getModelEventStatements();
    if (statements.hasApplied.get(eventId)) return { applied: false, duplicate: true };
    const parts = [
        JSON.stringify(state.summary || {}),
        provider ? JSON.stringify(state.providers?.[provider] || {}) : '',
        accountKey ? JSON.stringify(state.accounts?.[accountKey] || {}) : '',
        dateKey ? JSON.stringify(state.daily?.[dateKey] || {}) : '',
        accountKey ? JSON.stringify((state.accountUsageEvents?.[accountKey] || []).at(-1) || {}) : ''
    ];
    const event = {
        eventId,
        state,
        provider,
        accountKey,
        dateKey,
        accountEvent,
        parts,
        eventBytes: parts.reduce((total, part) => total + Buffer.byteLength(part, 'utf8'), 0)
    };
    if (modelEventBatchActive) statements.applyOne(event);
    else statements.apply(event);
    return { applied: true, duplicate: false };
}

export function beginModelUsageEventBatch() {
    if (modelEventBatchActive) throw new Error('Model usage event batch is already active');
    getDatabase().exec('BEGIN IMMEDIATE');
    modelEventBatchActive = true;
}

export function commitModelUsageEventBatch() {
    if (!modelEventBatchActive) return;
    try {
        getDatabase().exec('COMMIT');
        modelEventBatchActive = false;
    } catch (error) {
        try {
            getDatabase().exec('ROLLBACK');
        } finally {
            modelEventBatchActive = false;
        }
        throw error;
    }
}

export function rollbackModelUsageEventBatch() {
    if (!modelEventBatchActive) return;
    try {
        getDatabase().exec('ROLLBACK');
    } finally {
        modelEventBatchActive = false;
    }
}

export function closeModelUsageStore() {
    if (modelEventBatchActive) rollbackModelUsageEventBatch();
    database?.close();
    database = null;
    databasePath = null;
    modelEventStatements = null;
}
