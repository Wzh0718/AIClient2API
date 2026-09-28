import path from 'node:path';
import { promises as fs } from 'node:fs';
import { captureStatus } from './capture-status.js';

const GLM_HISTORY_DAYS = 35;
const GLM_USAGE_FIELDS = ['promptTokens', 'completionTokens', 'cachedTokens', 'totalTokens'];

function beijingDate(value) {
    return new Date(new Date(value).getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

function dateBefore(date, days) {
    return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86400_000).toISOString().slice(0, 10);
}

function glmUsageProjection(event) {
    if (event?.request?.toProvider !== 'glm-coding-plan' || !event.requestId || !event.timestamp) return null;
    const usage = event.usage || {};
    const known = Number(usage.totalTokens) > 0;
    return {
        eventId: event.eventId || `request:${event.requestId}`,
        date: event.beijingDate || beijingDate(event.timestamp),
        credentialHash: event.account?.providerUuidHash || '',
        outcome: event.status?.outcome === 'success' ? 'success' : 'failure',
        known: known ? 1 : 0,
        ...Object.fromEntries(GLM_USAGE_FIELDS.map(field => [field, known ? Number(usage[field] || 0) : 0]))
    };
}

const CAPTURE_FAILURE_SQL = `COALESCE((
    json_extract(payload_json, '$.capture.status') = 'failed'
    OR (outcome = 'success'
        AND (provider = 'openai-codex-oauth'
            OR json_extract(payload_json, '$.request.path') LIKE '/openai-codex-oauth/v1/%')
        AND (json_extract(payload_json, '$.request.path') LIKE '%/v1/responses'
            OR json_extract(payload_json, '$.request.path') LIKE '%/v1/chat/completions')
        AND (requested_model IS NULL OR requested_model = 'unknown'
            OR NULLIF(json_extract(payload_json, '$.account.accountEmail'), '') IS NULL
            OR COALESCE(json_extract(payload_json, '$.usage.totalTokens'), 0) <= 0))
), 0)`;

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
        this.db.function('audit_number', { deterministic: true }, value => {
            const number = Number(value);
            return Number.isFinite(number) ? number : 0;
        });
        this.db.function('audit_duration', { deterministic: true }, value => {
            if (value == null || (typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
            const number = Number(value);
            return Number.isFinite(number) && number >= 0 ? number : null;
        });
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
            CREATE INDEX IF NOT EXISTS idx_gpt_requests_key_time ON gpt_requests(key_hash, timestamp DESC, request_id DESC);
            CREATE INDEX IF NOT EXISTS idx_gpt_requests_credential_time ON gpt_requests(credential_hash, timestamp DESC, request_id DESC);
            CREATE INDEX IF NOT EXISTS idx_gpt_requests_provider_time ON gpt_requests(provider, timestamp DESC, request_id DESC);
            CREATE INDEX IF NOT EXISTS idx_gpt_requests_outcome_time ON gpt_requests(outcome, timestamp DESC, request_id DESC);
            CREATE TABLE IF NOT EXISTS gpt_request_attempts (
                attempt_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, sequence INTEGER NOT NULL,
                timestamp TEXT, provider TEXT, credential_hash TEXT, planned_model TEXT,
                outbound_model TEXT, upstream_response_model TEXT, status TEXT, http_status INTEGER,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_gpt_attempts_request ON gpt_request_attempts(request_id, sequence);
            CREATE TABLE IF NOT EXISTS glm_usage_events (
                event_id TEXT PRIMARY KEY, date TEXT NOT NULL, credential_hash TEXT NOT NULL,
                outcome TEXT NOT NULL, known INTEGER NOT NULL,
                prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL,
                cached_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_glm_usage_events_day ON glm_usage_events(date, credential_hash);
            CREATE TABLE IF NOT EXISTS glm_usage_daily (
                date TEXT NOT NULL, credential_hash TEXT NOT NULL,
                request_count INTEGER NOT NULL, success_count INTEGER NOT NULL,
                failure_count INTEGER NOT NULL, unknown_token_requests INTEGER NOT NULL,
                prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL,
                cached_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
                PRIMARY KEY(date, credential_hash)
            );
            CREATE TABLE IF NOT EXISTS glm_usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
        this.glmStatements = {
            getEvent: this.db.prepare(`SELECT date, credential_hash credentialHash, outcome, known,
                prompt_tokens promptTokens, completion_tokens completionTokens,
                cached_tokens cachedTokens, total_tokens totalTokens FROM glm_usage_events WHERE event_id = ?`),
            upsertEvent: this.db.prepare(`INSERT OR REPLACE INTO glm_usage_events
                (event_id, date, credential_hash, outcome, known, prompt_tokens, completion_tokens, cached_tokens, total_tokens)
                VALUES (@eventId, @date, @credentialHash, @outcome, @known, @promptTokens, @completionTokens, @cachedTokens, @totalTokens)`),
            addDay: this.db.prepare(`INSERT INTO glm_usage_daily
                (date, credential_hash, request_count, success_count, failure_count,
                    unknown_token_requests, prompt_tokens, completion_tokens, cached_tokens, total_tokens)
                VALUES (@date, @credentialHash, @requestCount, @successCount, @failureCount,
                    @unknownTokenRequests, @promptTokens, @completionTokens, @cachedTokens, @totalTokens)
                ON CONFLICT(date, credential_hash) DO UPDATE SET
                    request_count = request_count + excluded.request_count,
                    success_count = success_count + excluded.success_count,
                    failure_count = failure_count + excluded.failure_count,
                    unknown_token_requests = unknown_token_requests + excluded.unknown_token_requests,
                    prompt_tokens = prompt_tokens + excluded.prompt_tokens,
                    completion_tokens = completion_tokens + excluded.completion_tokens,
                    cached_tokens = cached_tokens + excluded.cached_tokens,
                    total_tokens = total_tokens + excluded.total_tokens`),
            deleteEmptyDay: this.db.prepare('DELETE FROM glm_usage_daily WHERE date = ? AND credential_hash = ? AND request_count <= 0'),
            coverage: this.db.prepare("SELECT value FROM glm_usage_meta WHERE key = 'coverage_start'"),
            setCoverage: this.db.prepare("INSERT OR IGNORE INTO glm_usage_meta(key, value) VALUES ('coverage_start', ?)")
        };
        this.writeTransaction = this.db.transaction(events => {
            for (const event of events) this._append(event);
        });
        const existingCount = this.db.prepare('SELECT COUNT(*) AS count FROM gpt_requests').get().count;
        const coverageStart = existingCount ? new Date(Date.now() - this.retentionDays * 86400_000).toISOString() : new Date().toISOString();
        this.glmStatements.setCoverage.run(coverageStart);
        if (this.db.prepare('SELECT COUNT(*) AS count FROM glm_usage_events').get().count === 0) {
            const backfillPage = this.db.prepare("SELECT payload_json FROM gpt_requests WHERE provider = 'glm-coding-plan' ORDER BY timestamp, event_id LIMIT 500 OFFSET ?");
            this.db.transaction(() => {
                for (let offset = 0; ; offset += 500) {
                    const rows = backfillPage.all(offset);
                    for (const row of rows) this._upsertGlmUsage(JSON.parse(row.payload_json));
                    if (rows.length < 500) break;
                }
            })();
        }
        return this;
    }

    _upsertGlmUsage(event) {
        const next = glmUsageProjection(event);
        if (!next) return;
        const previous = this.glmStatements.getEvent.get(next.eventId);
        if (previous && ['date', 'credentialHash', 'outcome', 'known', ...GLM_USAGE_FIELDS]
            .every(field => previous[field] === next[field])) return;
        if (previous) this._addGlmDay(previous, -1);
        this.glmStatements.upsertEvent.run(next);
        this._addGlmDay(next, 1);
    }

    _addGlmDay(row, sign) {
        this.glmStatements.addDay.run({
            date: row.date, credentialHash: row.credentialHash,
            requestCount: sign,
            successCount: sign * Number(row.outcome === 'success'),
            failureCount: sign * Number(row.outcome !== 'success'),
            unknownTokenRequests: sign * Number(row.known === 0),
            ...Object.fromEntries(GLM_USAGE_FIELDS.map(field => [field, sign * row[field]]))
        });
        if (sign < 0) this.glmStatements.deleteEmptyDay.run(row.date, row.credentialHash);
    }

    _append(event) {
        if (!event?.requestId || !event?.timestamp) return;
        const provider = String(event.request?.toProvider || '');
        const models = [event.request?.requestedModel, event.request?.plannedModel, event.request?.outboundModel, event.request?.upstreamResponseModel];
        const codexPath = /^\/openai-codex-oauth\/v1\/(?:responses|chat\/completions)$/.test(String(event.request?.path || ''));
        if (!codexPath && provider !== 'glm-coding-plan' && !/openai|codex/i.test(provider) && !models.some(model => /^gpt[-_]/i.test(String(model || '')))) return;
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
        this._upsertGlmUsage(event);
    }

    queryGlmUsage(now = new Date()) {
        const today = beijingDate(now);
        const starts = { today, week: dateBefore(today, 6), month: dateBefore(today, 29) };
        const coverageStart = this.glmStatements.coverage.get()?.value || now.toISOString();
        const rows = this.db.prepare('SELECT * FROM glm_usage_daily WHERE date >= ? AND date <= ? ORDER BY date, credential_hash').all(starts.month, today);
        const empty = () => ({ requestCount: 0, successCount: 0, failureCount: 0, unknownTokenRequests: 0,
            promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 });
        const credentials = {};
        const total = { today: empty(), week: empty(), month: empty() };
        for (const row of rows) {
            const periods = credentials[row.credential_hash] ||= { today: empty(), week: empty(), month: empty() };
            for (const [period, start] of Object.entries(starts)) {
                if (row.date < start) continue;
                for (const bucket of [periods[period], total[period]]) {
                    for (const [target, source] of [['requestCount', 'request_count'], ['successCount', 'success_count'],
                        ['failureCount', 'failure_count'], ['unknownTokenRequests', 'unknown_token_requests'],
                        ['promptTokens', 'prompt_tokens'], ['completionTokens', 'completion_tokens'],
                        ['cachedTokens', 'cached_tokens'], ['totalTokens', 'total_tokens']]) bucket[target] += row[source];
                }
            }
        }
        const coverage = Object.fromEntries(Object.entries(starts).map(([period, start]) =>
            [period, Date.parse(coverageStart) > Date.parse(`${start}T00:00:00+08:00`)]));
        return { today, coverage, total, credentials };
    }

    append(event) { if (!this.db) return false; this.writeTransaction([event]); return true; }
    appendBatch(events = []) { if (!this.db || events.length === 0) return false; this.writeTransaction(events); return true; }

    buildFilter(filters = {}, { includeCursor = true, includeCaptureFailures = false } = {}) {
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
        bind('glmRouting', filters.glmRouting, "json_extract(payload_json, '$.routing.glm.result') = @glmRouting");
        bind('model', filters.model, '(requested_model = @model OR planned_model = @model OR outbound_model = @model OR upstream_response_model = @model)');
        bind('outcome', filters.outcome, 'outcome = @outcome');
        bind('requestId', filters.requestId, 'request_id = @requestId');
        bind('clientIp', filters.clientIp, "json_extract(payload_json, '$.network.clientIp') = @clientIp");
        bind('path', filters.path, "json_extract(payload_json, '$.request.path') = @path");
        bind('keyPrefix', filters.keyPrefix, "json_extract(payload_json, '$.potluckKey.prefix') = @keyPrefix");
        if (!includeCaptureFailures) clauses.push(`NOT ${CAPTURE_FAILURE_SQL}`);
        if (['true', '1', true].includes(filters.modelMismatch)) clauses.push('model_mismatch = 1');
        const cursor = includeCursor ? decodeCursor(filters.cursor) : null;
        if (includeCursor && cursor) {
            clauses.push('(timestamp, request_id) < (@cursorTime, @cursorRequestId)');
            params.cursorTime = cursor[0]; params.cursorRequestId = cursor[1];
        }
        return { clauses, params };
    }

    query(filters = {}) {
        const { clauses, params } = this.buildFilter(filters);
        const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
        const sql = `SELECT payload_json FROM gpt_requests${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY timestamp DESC, request_id DESC LIMIT @limit`;
        const rows = this.db.prepare(sql).all({ ...params, limit: limit + 1 });
        const hasMore = rows.length > limit;
        const requests = rows.slice(0, limit).map(row => JSON.parse(row.payload_json));
        return { requests, nextCursor: hasMore && requests.length ? encodeCursor(requests.at(-1)) : null };
    }

    queryAll(filters = {}) {
        const { clauses, params } = this.buildFilter(filters, { includeCursor: false });
        const sql = `SELECT payload_json FROM gpt_requests${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY timestamp ASC, request_id ASC`;
        return this.db.prepare(sql).all(params).map(row => JSON.parse(row.payload_json));
    }

    querySummary(filters = {}) {
        const { clauses, params } = this.buildFilter(filters, { includeCursor: false });
        const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
        const number = expression => `CASE WHEN typeof(${expression}) = 'text' THEN audit_number(${expression}) ELSE COALESCE(${expression},0) END`;
        const usageFields = ['promptTokens', 'cachedTokens', 'completionTokens', 'reasoningTokens', 'totalTokens'];
        const costFields = ['usd', 'actualUsd', 'estimatedUsd', 'estimatedPriceTokens', 'missingPriceTokens'];
        const columns = [...usageFields.map(key => `${number(`json_extract(usage, '$.${key}')`)} AS ${key}`),
            ...costFields.map(key => `${number(`json_extract(cost, '$.${key}')`)} AS ${key}`)];
        const usageAggregate = `COUNT(*) AS requestCount, ${usageFields.map(key => `COALESCE(SUM(${key}),0) AS ${key}`).join(', ')}`;
        const usageJson = `json_object('requestCount',requestCount,${usageFields.map(key => `'${key}',${key}`).join(',')})`;
        // Materialize only scalar projections. Full payloads never cross the SQLite/JS boundary.
        const cte = `WITH raw AS MATERIALIZED (
            SELECT jsonb_extract(payload_json,'$.usage') usage, jsonb_extract(payload_json,'$.cost') cost,
                COALESCE(NULLIF(json_extract(payload_json,'$.request.model'),''),'unknown') AS model,
                COALESCE(NULLIF(json_extract(payload_json,'$.account.accountEmail'),''),NULLIF(json_extract(payload_json,'$.account.providerNameDisplay'),''),
                    NULLIF(json_extract(payload_json,'$.account.providerUuidHash'),''),NULLIF(json_extract(payload_json,'$.account.providerUuid'),''),'unknown') AS account,
                COALESCE(NULLIF(outcome,''),'unknown') AS outcome,
                jsonb_extract(payload_json,'$.contextBreakdown.sections') AS sections,
                CASE WHEN json_type(payload_json,'$.response.durationMs') IN ('integer','real')
                    THEN CASE WHEN json_extract(payload_json,'$.response.durationMs') >= 0 THEN json_extract(payload_json,'$.response.durationMs') END
                    WHEN json_type(payload_json,'$.response.durationMs') = 'text' THEN audit_duration(json_extract(payload_json,'$.response.durationMs')) END AS duration,
                json_type(payload_json,'$.cost') IN ('object','array') AS hasCost,
                json_extract(payload_json,'$.cost.pricingSource') = 'missing' AS missingPrice
            FROM gpt_requests${where}),
            projected AS MATERIALIZED (SELECT ${columns.join(',')}, model, account, outcome, sections, duration, hasCost, missingPrice FROM raw),
            ranked AS MATERIALIZED (SELECT duration, ROW_NUMBER() OVER (ORDER BY duration) rank FROM projected WHERE duration IS NOT NULL),
            timing AS (SELECT COUNT(*) count, AVG(duration) average, MAX(duration) max FROM ranked)`;
        const rows = this.db.prepare(`${cte}
            SELECT 'summary' kind, '' bucket, ${usageJson} value FROM (SELECT ${usageAggregate} FROM projected)
            UNION ALL SELECT 'models', model, ${usageJson} FROM (SELECT model, ${usageAggregate} FROM projected GROUP BY model)
            UNION ALL SELECT 'accounts', account, ${usageJson} FROM (SELECT account, ${usageAggregate} FROM projected GROUP BY account)
            UNION ALL SELECT 'outcomeCounts', outcome, COUNT(*) FROM projected GROUP BY outcome
            UNION ALL SELECT 'cost','',json_object(
                ${costFields.map(key => `'${key}',COALESCE(SUM(${key}),0)`).join(',')},
                'missingPriceRequestCount',COALESCE(SUM(CASE WHEN hasCost AND (missingPrice OR missingPriceTokens > 0) THEN 1 ELSE 0 END),0),
                'estimatedRequestCount',COALESCE(SUM(CASE WHEN hasCost AND NOT COALESCE(missingPrice,0) AND missingPriceTokens <= 0 AND estimatedUsd > 0 THEN 1 ELSE 0 END),0),
                'pricedRequestCount',COALESCE(SUM(CASE WHEN hasCost AND NOT COALESCE(missingPrice,0) AND missingPriceTokens <= 0 AND estimatedUsd <= 0 THEN 1 ELSE 0 END),0)) FROM projected
            UNION ALL SELECT 'contextSections', COALESCE(NULLIF(json_extract(section.value,'$.id'),''),'unknown') section_id,
                json_object('tokens', SUM(${number("COALESCE(json_extract(section.value,'$.calibratedTokens'),json_extract(section.value,'$.tokens'))")}))
                FROM projected, json_each(projected.sections) section GROUP BY section_id
            UNION ALL SELECT 'timing','',json_object('count',count,'average',average,'max',max,
                'p50',(SELECT duration FROM ranked WHERE rank = MAX(1, (count * 50 + 99) / 100)),
                'p95',(SELECT duration FROM ranked WHERE rank = MAX(1, (count * 95 + 99) / 100)),
                'p99',(SELECT duration FROM ranked WHERE rank = MAX(1, (count * 99 + 99) / 100))) FROM timing
        `).all(params);
        const result = { summary: {}, models: {}, accounts: {}, outcomeCounts: {}, cost: {}, contextSections: {}, captureFailureCount: 0 };
        for (const row of rows) {
            const value = row.kind === 'outcomeCounts' ? row.value : JSON.parse(row.value);
            if (row.kind === 'summary' || row.kind === 'models' || row.kind === 'accounts') {
                value.cacheHitRatio = value.promptTokens > 0 ? value.cachedTokens / value.promptTokens : 0;
            }
            if (row.kind === 'summary' || row.kind === 'cost' || row.kind === 'timing') result[row.kind] = value;
            else Object.defineProperty(result[row.kind], row.bucket, { value, enumerable: true });
        }
        for (const section of Object.values(result.contextSections)) section.percentOfPrompt = result.summary.promptTokens > 0 ? section.tokens / result.summary.promptTokens : 0;
        return result;
    }

    queryRequestIds(filters = {}) {
        const { clauses, params } = this.buildFilter(filters, { includeCursor: false });
        return this.db.prepare(`SELECT request_id FROM gpt_requests${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`).pluck().all(params);
    }

    queryCaptureFailures(filters = {}) {
        const { clauses, params } = this.buildFilter(filters, { includeCursor: false, includeCaptureFailures: true });
        clauses.push(CAPTURE_FAILURE_SQL);
        const where = ` WHERE ${clauses.join(' AND ')}`;
        const count = this.db.prepare(`SELECT COUNT(*) count FROM gpt_requests${where}`).get(params).count;
        const rows = this.db.prepare(`SELECT payload_json FROM gpt_requests${where} ORDER BY timestamp DESC, request_id DESC LIMIT 25`).all(params);
        return {
            count,
            requests: rows.map(row => {
                const event = JSON.parse(row.payload_json);
                return {
                    requestId: event.requestId,
                    timestamp: event.timestamp,
                    keyName: event.potluckKey?.name || null,
                    model: event.request?.outboundModel || event.request?.plannedModel || null,
                    missingFields: captureStatus(event).missingFields
                };
            })
        };
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
        const glmCutoff = dateBefore(beijingDate(now), GLM_HISTORY_DAYS);
        this.db.transaction(() => {
            this.statements.pruneAttempts.run(cutoff);
            this.statements.pruneRequests.run(cutoff);
            this.db.prepare('DELETE FROM glm_usage_events WHERE date < ?').run(glmCutoff);
            this.db.prepare('DELETE FROM glm_usage_daily WHERE date < ?').run(glmCutoff);
        })();
    }

    close() { this.db?.close(); this.db = null; }
}
