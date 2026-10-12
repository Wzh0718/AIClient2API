# GPT protocol audit and diagnostics

This branch adds three related capabilities without storing business prompts or opaque turn-state values in the normal request ledger.

## Codex turn state

> **[turn-state-disabled 2026-09-23]** The same-turn Turn-State cache reuse feature has been disabled in source (commented out in place, greppable via `[turn-state-disabled 2026-09-23]`). The `codexTurnStateReuseEnabled` credential flag no longer has any effect. Only transparent relaying remains active: a client-supplied `X-Codex-Turn-State` header is forwarded upstream unchanged, and the upstream response's `X-Codex-Turn-State` header is returned to the client unchanged. Nothing is captured, cached, injected, or audited. The description below is kept for historical reference and recovery.

`X-Codex-Turn-State` is accepted from the client, forwarded upstream, captured from the upstream HTTP response, and returned to the client. Client values are forwarded even when server reuse is disabled.

Set `codexTurnStateReuseEnabled: true` on an individual `openai-codex-oauth` credential to enable server reuse. The cache key includes the caller key hash, credential identity and configuration revision, outbound model, original session, and original turn ID. Requests without both an original session and turn ID are pass-through only. Client and response values may be up to 8 KiB and are still relayed opaquely, but the server cache accepts a value only after a successful upstream response and only when its UTF-8 byte length is exactly 292. Cached values stay in bounded memory for 30 idle minutes and are shared between local workers through non-durable IPC. Their length is observable; their value is never written to request audit records or logs.

Codex client identity (`User-Agent`, `originator`, `version`, `x-codex-beta-features`) is decided as one group. With `CODEX_CLOAKING_ENABLED` (default on) every request uses the configured values or the default `codex_cli_rs/0.162.1 (Windows 10.0.19045; x86_64) unknown` identity. With cloaking off, a recognised Codex client identity is passed through as a whole; a mismatched originator, an unrecognised UA, or a version too old for GPT-6 Sol/Luna falls back to the default group instead of mixing values. Authorization and account identity always come from the selected credential. See `docs/cpa-codex-protocol-alignment.md`.

## GPT request records

The request-audit plugin continues to write its JSONL ledger and also projects GPT request metadata into `configs/request-audit/gpt-requests.sqlite` when the native SQLite binding is available. The SQLite projection is retained for seven days and supports cursor pagination.

New schema v6 events persist the final billing model and the per-request USD estimate from the shared `api-potluck/pricing.json` catalog. They also distinguish upstream response-header timing from `clientFirstOutputMs`, the first actual downstream response payload. Legacy records are not repriced at read time.

- `GET /api/request-audit/requests`
- `GET /api/request-audit/requests/:requestId`

Filters include `since`, `until`, `keyHash`, `credential`, `provider`, `model`, `outcome`, and `modelMismatch=true`. A record distinguishes the client-requested, planned, final outbound, and upstream-reported models. Every real upstream attempt has an ID, credential hash, timing, effective reasoning effort and service tier, HTTP result, and upstream-reported model. Missing upstream model evidence remains `null`/unknown.

## GPT diagnostics

Open `gpt-diagnostics.html` as an authenticated administrator. Search and select up to ten GPT/OpenAI credentials. Each selected credential is tested serially against the fixed model group `gpt-6-astra`, `gpt-6-sol`, and `gpt-6-luna`; disabled credentials cannot be selected, and the run never invokes normal fallback routing. The page shows request/output upper bounds before a run, not actual usage.

- `POST /api/gpt-diagnostics/runs`
- `GET /api/gpt-diagnostics/runs`
- `GET /api/gpt-diagnostics/runs/:runId`
- `POST /api/gpt-diagnostics/runs/:runId/cancel`
- `GET /api/gpt-diagnostics/capabilities`

New runs use `gpt-diagnostics-v4` and ModelTrace only. Each model receives three challenges capped at 8,192 output tokens each, for a maximum of nine requests and 73,728 output tokens per credential. Capabilities expose `testVersion`, `maxTargets`, `models`, `defaultTests`, `tests` (ID, label, request count and per-request token limit), and `perCredential` budget; execution and estimation use the same definitions. Completed legacy records remain readable without migration.

ModelTrace uses a bundled, SHA-256-verified candidate bank pinned to commit `df3a0f9d3e054c0dc02d6d586686db8daf8fa7c8`, which includes GPT-6 Sol and Luna. A valid versioned cache is reused; a missing or invalid cache falls back to the bundled bank, with the pinned upstream URL as a final fallback. Its probability is labeled as closed-set attribution, not identity proof. Empty output, upstream model mismatch, and the community `518n-2` reasoning-token pattern are shown as separate passive signals and never change credential health.

Diagnostic outputs and legacy artifacts are retained for 35 days under `configs/gpt-diagnostics`. A restart marks queued or running jobs as interrupted; it does not resume them. Cancellation prevents subsequent requests; an in-flight request may still finish. The UI refreshes every five seconds while visible, retains expanded evidence and user input, and preserves existing results when refresh fails. New target results snapshot the credential name and channel; legacy or deleted credentials fall back to their UUID.
