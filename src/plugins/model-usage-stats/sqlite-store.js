import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

let database = null;
let databasePath = null;

function getDatabase() {
    const target = process.env.USAGE_EVENT_DB_PATH
        || path.join(process.cwd(), 'configs', 'usage-events', 'usage-events.sqlite');
    if (database && databasePath === target) return database;
    database?.close();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    database = new Database(target);
    databasePath = target;
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
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

export function loadModelUsageState() {
    const db = getDatabase();
    const meta = db.prepare('SELECT updated_at_value, summary_json FROM model_usage_meta WHERE singleton = 1').get();
    if (meta) {
        const rowEvents = {};
        for (const row of db.prepare(`
            SELECT account_key, event_timestamp, total_tokens
            FROM model_usage_account_event_rows
            ORDER BY account_key, event_timestamp
        `).all()) {
            if (!rowEvents[row.account_key]) rowEvents[row.account_key] = [];
            rowEvents[row.account_key].push({ timestamp: row.event_timestamp, totalTokens: row.total_tokens });
        }
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
            accountUsageEvents: Object.keys(rowEvents).length > 0 ? rowEvents : legacyEvents
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
    return Boolean(getDatabase().prepare('SELECT 1 FROM model_usage_applied_events WHERE event_id = ?').get(eventId));
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

export function persistModelUsageEvent(eventId, state, { provider, accountKey, dateKey } = {}) {
    if (!eventId) {
        persistModelUsageState(state);
        return { applied: true, duplicate: false };
    }
    const db = getDatabase();
    if (hasAppliedModelUsageEvent(eventId)) return { applied: false, duplicate: true };
    const recordEvent = db.prepare('INSERT INTO model_usage_applied_events (event_id) VALUES (?)');
    const parts = [
        JSON.stringify(state.summary || {}),
        provider ? JSON.stringify(state.providers?.[provider] || {}) : '',
        accountKey ? JSON.stringify(state.accounts?.[accountKey] || {}) : '',
        dateKey ? JSON.stringify(state.daily?.[dateKey] || {}) : '',
        accountKey ? JSON.stringify((state.accountUsageEvents?.[accountKey] || []).at(-1) || {}) : ''
    ];
    db.transaction(() => {
        db.prepare(`
            INSERT INTO model_usage_meta (singleton, updated_at_value, summary_json)
            VALUES (1, ?, ?)
            ON CONFLICT(singleton) DO UPDATE SET
                updated_at_value = excluded.updated_at_value,
                summary_json = excluded.summary_json
        `).run(state.updatedAt || null, parts[0]);
        if (provider) db.prepare(`
            INSERT INTO model_usage_providers (provider_name, state_json) VALUES (?, ?)
            ON CONFLICT(provider_name) DO UPDATE SET state_json = excluded.state_json
        `).run(provider, parts[1]);
        if (accountKey) {
            db.prepare(`
                INSERT INTO model_usage_accounts (account_key, state_json) VALUES (?, ?)
                ON CONFLICT(account_key) DO UPDATE SET state_json = excluded.state_json
            `).run(accountKey, parts[2]);
            const latestEvent = (state.accountUsageEvents?.[accountKey] || []).at(-1);
            if (latestEvent) db.prepare(`
                INSERT OR IGNORE INTO model_usage_account_event_rows (
                    account_key, event_id, event_timestamp, total_tokens
                ) VALUES (?, ?, ?, ?)
            `).run(accountKey, eventId, latestEvent.timestamp, Number(latestEvent.totalTokens || 0));
        }
        if (dateKey) db.prepare(`
            INSERT INTO model_usage_daily (usage_date, state_json) VALUES (?, ?)
            ON CONFLICT(usage_date) DO UPDATE SET state_json = excluded.state_json
        `).run(dateKey, parts[3]);
        recordEvent.run(eventId);
        db.prepare(`
            UPDATE model_usage_write_metrics
            SET event_writes = event_writes + 1,
                event_bytes = event_bytes + ?
            WHERE singleton = 1
        `).run(parts.reduce((total, part) => total + Buffer.byteLength(part, 'utf8'), 0));
    })();
    return { applied: true, duplicate: false };
}

export function closeModelUsageStore() {
    database?.close();
    database = null;
    databasePath = null;
}
