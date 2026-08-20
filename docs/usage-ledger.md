# Usage Ledger Retention and Recompute

This document records the production usage-statistics ledger design used for API Potluck and request-audit based recompute. It intentionally documents the mechanism only. Do not commit production ledger files, `api-potluck-keys.json`, request-audit JSONL files, backups, API keys, OAuth tokens, cookies, or server credentials.

## Retention Policy

- Daily API key usage ledger: permanent JSONL.
- Hourly API key usage ledger: 35 days.
- Request-audit requestId detail: 35 days when `REQUEST_AUDIT_RETENTION_HOURS=840`.
- Recompute output: candidate JSONL files only. Review totals first, then replace the affected daily/hourly ledger files deliberately.

The default request-audit retention remains 24 hours in code. Production can extend it with:

```json
{
  "REQUEST_AUDIT_RETENTION_HOURS": 840
}
```

## Files

Production paths when the config volume is mounted at `/app/configs`:

```text
/app/configs/permanent-usage-ledger/daily/usage-YYYY-MM-DD.jsonl
/app/configs/permanent-usage-ledger/hourly/usage-YYYY-MM-DD.jsonl
/app/configs/permanent-usage-ledger/recompute-candidates/<timestamp>/
/app/configs/request-audit/audit-YYYY-MM-DD.jsonl
```

Repository tooling:

```text
scripts/usage-ledger/daily-usage-ledger.mjs
tests/usage-ledger/daily-usage-ledger.test.mjs
tests/usage-ledger/usage-repair.test.mjs
```

## Row Semantics

Daily ledger rows are keyed by date, provider/account, API key, and model.

- Prefer account/model details from `api-potluck-keys.json`.
- If old history has model/provider summary but no account detail, emit `source=api-potluck-keys-summary` with `accountKey=<provider>:unknown`.
- If account detail is partial, emit account rows plus `source=api-potluck-keys-summary-delta` rows for the positive model-level difference only. This preserves totals without double-counting account rows.
- Normalize historical model aliases before pricing and before computing summary deltas.
- Store `pricingVersion` on every row. The current version is `official-2026-07-09`.
- Pricing and model aliases live in the shared single source `src/plugins/api-potluck/pricing.json`, loaded by both `cost-estimator.js` and the ledger script. When running the ledger script standalone from the config volume (e.g. `/app/configs/tools/`), copy `pricing.json` next to the script or set `USAGE_LEDGER_PRICING_FILE`; inside the app container it falls back to `/app/src/plugins/api-potluck/pricing.json` automatically.

Key fields:

- `key`: original API Potluck key value, for the current production requirement that stats can be traced back to the original key.
- `keyHash`: truncated SHA-256 reference for matching request-audit events.
- `keyPrefix`: short display prefix.
- `keyName`: configured key name when available.

Because rows include `key`, the generated ledger is sensitive production config data. Keep ledger directories on the server/config volume only and out of git.

## Commands

Run tests:

```powershell
node --test .\tests\usage-ledger\daily-usage-ledger.test.mjs
```

Generate or replace ledgers from current API Potluck stats:

```bash
node /app/configs/tools/daily-usage-ledger.mjs write --base /app/configs --from 2026-04-24 --to 2026-07-06
```

Generate requestId-based recompute candidates without overwriting canonical ledgers:

```bash
node /app/configs/tools/daily-usage-ledger.mjs recompute-audit --base /app/configs --from 2026-07-05 --to 2026-07-05
```

Clean hourly ledger files older than 35 days:

```bash
node /app/configs/tools/daily-usage-ledger.mjs cleanup-hourly --base /app/configs --days 35
```

Reconcile daily totals across ledger, request-audit, and potluck stats:

```bash
node /app/configs/tools/daily-usage-ledger.mjs reconcile --base /app/configs --from 2026-07-05 [--to 2026-07-05] [--threshold 0.005]
```

The `reconcile` command writes `permanent-usage-ledger/reconciliation/reconcile-<date>.json` plus `latest.json`, prints a sanitized summary (no key material), and exits with code `2` when any comparison deviates beyond the threshold. The admin UI reads `latest.json` through `GET /api/potluck/reconciliation` and shows a status chip: green `ok`, amber `partial` (a source is missing), red `deviation`.

Generate a read-only, synchronized Potluck/model-stats/ledger repair bundle:

```bash
node /app/scripts/usage-ledger/daily-usage-ledger.mjs repair-report \
  --base /app/configs \
  --from 2026-07-20 \
  --to 2026-07-22 \
  --out-dir /repair-output/incident-20260723
```

`repair-report` streams the active request-audit files and `request-audit/archived-large`, scans one UTC file day around the requested Beijing range, excludes `.tmp`, and writes a mode-`0600` bundle containing `report.json`, `manifest.json`, `patch.json`, and candidate daily/hourly ledgers. The printed manifest and report SHA-256 values are the approval identifiers. `report.json` is sanitized; `patch.json` and candidate ledgers are sensitive server-only artifacts and must not be copied into git or chat.

After reviewing the report, stop the application, take a second config backup, and apply the exact approved bundle from a one-shot container:

```bash
node /app/scripts/usage-ledger/daily-usage-ledger.mjs repair-apply \
  --base /app/configs \
  --bundle /repair-output/incident-20260723 \
  --approved-manifest-sha256 '<approved manifest sha256>' \
  --approved-report-sha256 '<approved report sha256>' \
  --backup-dir /repair-backups/incident-20260723
```

The apply command revalidates artifact hashes, request-audit event and file digests, and the approved historical slices before creating its backup or writing. It replaces only eligible closed dates, adjusts cumulative values by delta, preserves live-day fields and unrecoverable rate peaks, atomically replaces complete daily/hourly files, and records an idempotency marker. Any commit failure restores every target from the just-created backup.

## Admin Range Stats From Ledger

`GET /api/potluck/range-stats?range=<total|30d|7d|today|custom>&from=YYYY-MM-DD&to=YYYY-MM-DD&includeKeys=1&conversionModel=<model>` streams the daily ledger files for the requested Beijing-time date range. `from` / `to` are required only for `custom`; both endpoints are included, so `2026-01-01` through `2026-01-15` means Beijing time `[2026-01-01 00:00:00, 2026-01-16 00:00:00)`. The response includes global `summary/providers/models/providerModels/accounts/daily` buckets, where `providerModels` is keyed by provider and then model, and may include lightweight current-Key summaries when `includeKeys=1`; raw ledger keys, hashes, and prefixes are never returned. `GET /api/potluck/keys/:keyId/range-stats?from=...&to=...` provides the selected Key's full provider/model/daily detail on demand. Dates missing from the ledger are supplemented from the retained live history when available and otherwise reported as missing.

Permanent ledger files remain historical facts. The Potluck "reset Token" actions clear the current Key store counters and retained 35-day Token history, but do not delete or rewrite permanent ledger history; custom historical queries can therefore still show records from before a reset.

Example production cron wrapper:

```sh
#!/bin/sh
set -eu
LOG_DIR=/root/ai_client_configs/permanent-usage-ledger/logs
mkdir -p "$LOG_DIR"
DAY=$(TZ=Asia/Shanghai date -d 'yesterday' +%F)
{
  echo "[$(date -Is)] write day=$DAY"
  docker exec aiclient2api node /app/configs/tools/daily-usage-ledger.mjs write --base /app/configs --from "$DAY" --to "$DAY"
  docker exec aiclient2api node /app/configs/tools/daily-usage-ledger.mjs cleanup-hourly --base /app/configs --days 35
  docker exec aiclient2api node /app/configs/tools/daily-usage-ledger.mjs reconcile --base /app/configs --from "$DAY" --to "$DAY" || echo "[$(date -Is)] reconcile deviation day=$DAY"
} >> "$LOG_DIR/usage-ledger-cron.log" 2>&1
```

Cron entry:

```cron
30 0 * * * root /root/ai_client_configs/tools/run-usage-ledger.sh
```

## Recompute Workflow

1. Confirm `REQUEST_AUDIT_RETENTION_HOURS=840` is active and the target dates still have request-audit files.
2. Run `recompute-audit` for the affected date range.
3. Compare candidate request/token/cost totals with the current ledger and expected incident scope.
4. Replace only the affected date files after review. Do not append candidate rows into canonical files.
5. Keep the candidate directory as short-lived investigation output or archive it outside git if needed.

`recompute-audit` deduplicates by `requestId` per key reference. When audit events only contain `keyHash/keyPrefix`, the tool loads current `api-potluck-keys.json` and enriches the original `key` if it can match the hash or prefix.

## Controlled Historical Repair Workflow

1. Generate `repair-report` while the application is online, with the config volume mounted read-only and a separate writable output directory.
2. Review only `report.json`. A date is eligible only when it is closed in Beijing time, both required UTC source dates exist, required source files contain no corrupt JSON lines, every Potluck key hash maps uniquely, and totals plus existing key/model/account/ledger dimensions do not decrease.
3. Record the printed manifest and report hashes as the approval pair. Do not edit the bundle after approval.
4. Gracefully stop the application and verify persistence flush completion.
5. Back up the complete config directory, then run `repair-apply` with the config volume read-write, the approved bundle read-only, and a new empty backup directory.
6. Restart the application and reconcile the repaired dates. If apply or startup verification fails, restore the repair backup before accepting traffic.

The repair path is intentionally undercount-only. Potential overcounts, missing UTC boundary files, corrupt lines, unknown/ambiguous Potluck keys, or dimension-level decreases remain report-only and require separate manual investigation.

## Production Snapshot

On 2026-07-06, production `47.77.184.27` was backfilled and verified with:

- daily files: 68, `usage-2026-04-24.jsonl` through `usage-2026-07-06.jsonl`
- hourly files: 15, `usage-2026-06-22.jsonl` through `usage-2026-07-06.jsonl`
- closed-date verification: `2026-04-24..2026-07-05`
- verified closed-date totals: `2,470,521` requests and `39,104,441,202` tokens
- request-audit retention: `840` hours
- latest recompute candidate key enrichment: all daily candidate rows had original key populated
