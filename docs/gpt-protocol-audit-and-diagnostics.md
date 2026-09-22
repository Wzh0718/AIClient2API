# GPT protocol audit and diagnostics

This branch adds three related capabilities without storing business prompts or opaque turn-state values in the normal request ledger.

## Codex turn state

`X-Codex-Turn-State` is accepted from the client, forwarded upstream, captured from the upstream HTTP response, and returned to the client. Client values are forwarded even when server reuse is disabled.

Set `codexTurnStateReuseEnabled: true` on an individual `openai-codex-oauth` credential to enable server reuse. The cache key includes the caller key hash, credential identity and configuration revision, outbound model, original session, and original turn ID. Requests without both an original session and turn ID are pass-through only. Client and response values may be up to 8 KiB and are still relayed opaquely, but the server cache accepts a value only after a successful upstream response and only when its UTF-8 byte length is exactly 292. Cached values stay in bounded memory for 30 idle minutes and are shared between local workers through non-durable IPC. Their length is observable; their value is never written to request audit records or logs.

Credential configuration overrides client `Version`, `User-Agent`, `Originator`, and beta feature headers. Otherwise valid client values are retained before compatibility defaults are applied. Authorization and account identity always come from the selected credential.

## GPT request records

The request-audit plugin continues to write its JSONL ledger and also projects GPT request metadata into `configs/request-audit/gpt-requests.sqlite` when the native SQLite binding is available. The SQLite projection is retained for seven days and supports cursor pagination.

New schema v6 events persist the final billing model and the per-request USD estimate from the shared `api-potluck/pricing.json` catalog. They also distinguish upstream response-header timing from `clientFirstOutputMs`, the first actual downstream response payload. Legacy records are not repriced at read time.

- `GET /api/request-audit/requests`
- `GET /api/request-audit/requests/:requestId`

Filters include `since`, `until`, `keyHash`, `credential`, `provider`, `model`, `outcome`, and `modelMismatch=true`. A record distinguishes the client-requested, planned, final outbound, and upstream-reported models. Every real upstream attempt has an ID, credential hash, timing, effective reasoning effort and service tier, HTTP result, and upstream-reported model. Missing upstream model evidence remains `null`/unknown.

## Manual diagnostics

Open `gpt-diagnostics.html` as an authenticated administrator. Search and select up to ten GPT/OpenAI credentials, then select or enter a shared model ID. Individual rows can override the model or return to the shared value. Disabled credentials cannot be selected; unhealthy credentials remain available for diagnosis. Model suggestions come from configuration, not live availability checks. A run targets explicit credential UUID and model pairs, executes serially, and never invokes normal fallback routing. The page shows request/output upper bounds before a run, not actual usage.

- `POST /api/gpt-diagnostics/runs`
- `GET /api/gpt-diagnostics/runs`
- `GET /api/gpt-diagnostics/runs/:runId`
- `POST /api/gpt-diagnostics/runs/:runId/cancel`
- `GET /api/gpt-diagnostics/capabilities`

New runs use `gpt-diagnostics-v2`, with `knowledge` and `modeltrace` as the default tests. Knowledge uses one request capped at 2,048 output tokens; ModelTrace uses three capped at 8,192 each. The total per target is at most four requests and 26,624 output tokens. Capabilities expose `testVersion`, `maxTargets`, `defaultTests`, `tests` (ID, label, request count and per-request token limit), and `perTarget` budget. Execution and estimation use the same definitions. Explicit unsupported test IDs return 400; the former manual scoring POST endpoint returns 410. Completed legacy records remain readable without migration; the page no longer renders the retired test's preview or scores.

Knowledge-cutoff self-reporting is displayed separately from fixed dated checks. ModelTrace uses a SHA-256-verified candidate bank pinned to commit `3f0dd2f4b451ad424f3b165a108a468efe4d4d81`; its probability is labeled as closed-set attribution, not identity proof. Empty output, upstream model mismatch, and the community `518n-2` reasoning-token pattern are shown as separate passive signals and never change credential health.

Diagnostic outputs and legacy artifacts are retained for 35 days under `configs/gpt-diagnostics`. A restart marks queued or running jobs as interrupted; it does not resume them. Cancellation prevents subsequent requests; an in-flight request may still finish. The UI refreshes every five seconds while visible, retains expanded evidence and user input, and preserves existing results when refresh fails. New target results snapshot the credential name and channel; legacy or deleted credentials fall back to their UUID.
