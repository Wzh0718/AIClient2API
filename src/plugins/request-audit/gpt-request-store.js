import path from 'node:path';
import { promises as fs } from 'node:fs';

function encodeCursor(row) {
    return Buffer.from(JSON.stringify([row.timestamp, row.requestId]), 'utf8').toString('base64url');
}

function decodeCursor(value) {
    if (!value) return null;
    try {
        const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
        return Array.isArray(parsed) && parsed.length === 2 ? parsed : null;
    } catch {
        return null;
    }
}

export class GptRequestStore {
    constructor({ dbPath = path.join(process.cwd(), 'configs', 'request-audit', 'gpt-requests.sqlite'), retentionDays = 7 } = {}) {
        this.dbPath = dbPath;
        this.retentionDays = Math.max(1, Number(retentionDays) || 7);
        this.db = null;
        this.statements = null;
    }

    async init() {
        await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
        const imported = await import('better-sqlite3');
        const Database = imported.default || imported;
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS gpt_requests (
                event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, timestamp TEXT NOT NULL,
                key_hash TEXT, credential_hash TEXT, provider TEXT, requested_model TEXT,
                planned_model TEXT, outbound_model TEXT, upstream_response_model TEXT,
                model_mismatch INTEGER NOT NULL DEFAULT 0, outcome TEXT, http_status INTEGER,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_gpt_requests_time ON gpt_requests(timestamp DESC, request_id DESC);
            CREATE INDEX IF NOT EXISTS idx_gpt_requests_request ON gpt_requests(request_id);
            CREATE INDEX IF NOT EXISTS idx_gpt_requests_filters ON gpt_requests(key_hash, credential_hash, provider, outcome);
            CREATE TABLE IF NOT EXISTS gpt_request_attempts (
                attempt_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, sequence INTEGER NOT NULL,
                timestamp TEXT, provider TEXT, credential_hash TEXT, planned_model TEXT,
                outbound_model TEXT, upstream_response_model TEXT, status TEXT, http_status INTEGER,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_gpt_attempts_request ON gpt_request_attempts(request_id, sequence);
        `);
        this.statements = {
            request: this.db.prepare(`INSERT OR REPLACE INTO gpt_requests (
                event_id, request_id, timestamp, key_hash, credential_hash, provider,
                requested_model, planned_model, outbound_model, upstream_response_model,
                model_mismatch, outcome, http_status, payload_json
            ) VALUES (@eventId, @requestId, @timestamp, @keyHash, @credentialHash, @provider,
                @requestedModel, @plannedModel, @outboundModel, @upstreamResponseModel,
                @modelMismatch, @outcome, @httpStatus, @payloadJson)`),
            attempt: this.db.prepare(`INSERT OR REPLACE INTO gpt_request_attempts (
                attempt_id, request_id, sequence, timestamp, provider, credential_hash,
                planned_model, outbound_model, upstream_response_model, status, http_status, payload_json
            ) VALUES (@attemptId, @requestId, @sequence, @timestamp, @provider, @credentialHash,
                @plannedModel, @outboundModel, @upstreamResponseModel, @status, @httpStatus, @payloadJson)`),
            detail: this.db.prepare('SELECT payload_json FROM gpt_requests WHERE request_id = ? ORDER BY timestamp DESC LIMIT 1'),
            attempts: this.db.prepare('SELECT payload_json FROM gpt_request_attempts WHERE request_id = ? ORDER BY sequence ASC'),
            deleteAttempts: this.db.prepare('DELETE FROM gpt_request_attempts WHERE request_id = ?'),
            pruneAttempts: this.db.prepare('DELETE FROM gpt_request_attempts WHERE request_id IN (SELECT request_id FROM gpt_requests WHERE timestamp < ?)'),
            pruneRequests: this.db.prepare('DELETE FROM gpt_requests WHERE timestamp < ?')
        };
        this.writeTransaction = this.db.transaction(events => {
            for (const event of events) this._append(event);
        });
        return this;
    }

    _append(event) {
        if (!event?.requestId || !event?.timestamp) return;
        const provider = String(event.request?.toProvider || '');
        const models = [event.request?.requestedModel, event.request?.plannedModel, event.request?.outboundModel, event.request?.upstreamResponseModel];
        if (!/openai|codex/i.test(provider) && !models.some(model => /^gpt[-_]/i.test(String(model || '')))) return;
        this.statements.request.run({
            eventId: event.eventId || `request:${event.requestId}`,
            requestId: event.requestId,
            timestamp: event.timestamp,
            keyHash: event.potluckKey?.hash || null,
            credentialHash: event.account?.providerUuidHash || null,
            provider: provider || null,
            requestedModel: event.request?.requestedModel || null,
            plannedModel: event.request?.plannedModel || null,
            outboundModel: event.request?.outboundModel || null,
            upstreamResponseModel: event.request?.upstreamResponseModel || null,
            modelMismatch: event.request?.modelMismatch ? 1 : 0,
            outcome: event.status?.outcome || null,
            httpStatus: event.status?.httpStatus ?? null,
            payloadJson: JSON.stringify(event)
        });
        this.statements.deleteAttempts.run(event.requestId);
        for (const attempt of event.attempts || []) {
            this.statements.attempt.run({
                attemptId: attempt.attemptId, requestId: event.requestId, sequence: attempt.sequence,
                timestamp: attempt.startedAt, provider: attempt.providerType,
                credentialHash: attempt.providerUuidHash, plannedModel: attempt.plannedModel,
                outboundModel: attempt.outboundModel, upstreamResponseModel: attempt.upstreamResponseModel,
                status: attempt.status, httpStatus: attempt.httpStatus, payloadJson: JSON.stringify(attempt)
            });
        }
    }

    append(event) { if (!this.db) return false; this.writeTransaction([event]); return true; }
    appendBatch(events = []) { if (!this.db || events.length === 0) return false; this.writeTransaction(events); return true; }

    query(filters = {}) {
        const clauses = [];
        const params = {};
        const bind = (name, value, sql) => {
            if (value === undefined || value === null || value === '') return;
            clauses.push(sql); params[name] = value;
        };
        bind('since', filters.since, 'timestamp >= @since');
        bind('until', filters.until, 'timestamp < @until');
        bind('keyHash', filters.keyHash, 'key_hash = @keyHash');
        bind('credentialHash', filters.credential, 'credential_hash = @credentialHash');
        bind('provider', filters.provider, 'provider = @provider');
        bind('model', filters.model, '(requested_model = @model OR planned_model = @model OR outbound_model = @model OR upstream_response_model = @model)');
        bind('outcome', filters.outcome, 'outcome = @outcome');
        if (['true', '1', true].includes(filters.modelMismatch)) clauses.push('model_mismatch = 1');
        const cursor = decodeCursor(filters.cursor);
        if (cursor) {
            clauses.push('(timestamp < @cursorTime OR (timestamp = @cursorTime AND request_id < @cursorRequestId))');
            params.cursorTime = cursor[0]; params.cursorRequestId = cursor[1];
        }
        const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
        const sql = `SELECT payload_json FROM gpt_requests${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY timestamp DESC, request_id DESC LIMIT @limit`;
        const rows = this.db.prepare(sql).all({ ...params, limit: limit + 1 });
        const hasMore = rows.length > limit;
        const requests = rows.slice(0, limit).map(row => JSON.parse(row.payload_json));
        return { requests, nextCursor: hasMore && requests.length ? encodeCursor(requests.at(-1)) : null };
    }

    get(requestId) {
        const row = this.statements.detail.get(requestId);
        if (!row) return null;
        const request = JSON.parse(row.payload_json);
        request.attempts = this.statements.attempts.all(requestId).map(item => JSON.parse(item.payload_json));
        return request;
    }

    cleanup(now = new Date()) {
        const cutoff = new Date(now.getTime() - this.retentionDays * 86400_000).toISOString();
        this.db.transaction(() => { this.statements.pruneAttempts.run(cutoff); this.statements.pruneRequests.run(cutoff); })();
    }

    close() { this.db?.close(); this.db = null; }
}
