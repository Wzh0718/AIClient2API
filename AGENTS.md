# AIClient-2-API Custom Branch Notes

## Branch Scope

- Custom/private work lives on `yyn/customized-branch`.
- Upstream strategy is soft hard-fork (decided 2026-07-06): do NOT spend effort keeping `origin/main` mergeable. Review the upstream log roughly quarterly and only cherry-pick protocol/security fixes that matter to the Codex-only production deployment. Re-evaluate a one-time merge only if upstream ships a needed major feature (new provider support, Codex protocol change).
- Do not push or merge PRs without explicit user approval.
- Treat request body limit from upstream `main` as baseline. Keep local-only features here: log stats/sanitization, image interface enhancements, provider weight, usage/cache observability, and future private customizations.

## Safety

- Do not persist server credentials, API keys, OAuth tokens, cookies, raw prompts, raw images, or browser auth state in docs, tests, logs, commits, or `.plans`.
- Usage and diagnostics may store hashes, aggregate token counts, provider UUIDs, model names, dates, and cache hit ratios.

## Production Blue-Green Deployment

- Build traceable images with `scripts/ops/build-image.sh`; verify the `yyn.base_commit` label before rollout.
- Use `scripts/ops/blue-green-deploy.sh` for dry-run, protected candidate snapshot, health checks, and Nginx upstream preview. It is a lightweight candidate-preflight tool, not automatic active-active blue-green.
- Candidate `prepare` requires a reachable `REDIS_URL` and explicitly enables multi-worker mode; never validate a production candidate in fallback single-worker mode.
- Production uses a single-writer handoff: the control worker writes provider configuration, execution workers receive revisioned `provider_config_sync`, and stale provider-state events are rejected.
- Before traffic switch, verify `/runtime/health` shows complete worker topology and provider config convergence with `pendingWorkerCount=0`.
- Do not directly restart or replace the active container while writing mounted config. Pause management/OAuth writes, perform the documented manual Nginx handoff, retain rollback state, and obtain explicit production authorization.

## Testing

- Prefer focused Jest tests before implementation changes.
- Run targeted tests for touched modules, then broader tests when feasible.

## Docker Build Notes

- The Dockerfile builds the Go TLS sidecar in a builder container.
- On this Windows Docker Desktop environment, `proxy.golang.org` was confirmed unreachable while `goproxy.cn` was reachable on 2026-08-11. For local builds, default to:
  `docker build --build-arg GOPROXY=https://goproxy.cn,direct -t <tag> .`
- If `goproxy.cn` is also unavailable, retry through the host proxy. Do not pass `127.0.0.1:7890` as `HTTP_PROXY`/`HTTPS_PROXY`; inside the build container that address points to the container itself.
- If the Windows host proxy is listening on local port `7890`, pass it as `http://host.docker.internal:7890`, for example:
  `docker build --build-arg HTTP_PROXY=http://host.docker.internal:7890 --build-arg HTTPS_PROXY=http://host.docker.internal:7890 -t <tag> .`
- The Node stage forwards those build arguments to npm explicitly. For local Docker Desktop builds, use the same proxy for npm dependency downloads when direct registry access is slow or unreliable:
  `BUILD_HTTP_PROXY=http://host.docker.internal:7890 ./scripts/ops/build-image.sh`
- A proxy may improve reliability or large-download throughput, but do not assume it is always faster. Keep the registry unchanged unless a project-approved mirror is available; never commit proxy credentials or authenticated proxy URLs.
- On remote Linux servers, especially overseas hosts such as `47.77.196.94`, use direct build by default and verify connectivity from the host/container before adding any proxy or alternate `GOPROXY`. Do not reuse Windows-only `127.0.0.1:7890` or `host.docker.internal:7890` settings on remote servers.

## Remote Ops Notes

- When running remote Linux commands from Windows PowerShell, avoid inlining complex Bash snippets that contain `$(...)`, pipes, regexes, nested quotes, or here-docs. PowerShell may parse them locally before SSH sends them.
- For complex remote operations, prefer writing a temporary script locally, uploading it with `scp`, executing it remotely, then deleting it. This is the default for production data repair or multi-step Docker operations.
- Before replacing the 94 container, record the current image and health, build from `git archive HEAD` rather than the working tree, rename the old container as a timestamped backup, then verify Docker health and `/health`.
- Container source verification should account for Docker build context and Windows CRLF versus Linux LF differences. Prefer comparing targeted runtime files or building from the current commit tag instead of relying on raw file hashes alone.

## Usage Data Repair

- Treat `/app/configs/usage-cache.json` as official usage/quota cache data and `/app/configs/model-usage-stats.json` as local potluck token statistics. Do not present potluck statistics as official OpenAI quota.
- Production data repairs must follow: read-only scan, sanitized summary, backup target file, single-target patch, TTL/timestamp check, then container health verification.
- Permanent API Potluck usage ledgers are maintained by `scripts/usage-ledger/daily-usage-ledger.mjs` and documented in `docs/usage-ledger.md`. Daily JSONL is permanent; hourly JSONL and request-audit requestId detail are retained for 35 days in production. Generated ledgers and request-audit JSONL are sensitive production data and must not be committed.
- Pricing and model aliases live only in `src/plugins/api-potluck/pricing.json`, shared by `cost-estimator.js` and the ledger script. Never re-introduce a second inline pricing table.
- The ledger script's daily `reconcile` command cross-checks ledger vs request-audit vs potluck stats and writes `permanent-usage-ledger/reconciliation/latest.json`; the admin UI surfaces it via `GET /api/potluck/reconciliation`. Deviation handling is page-flag plus logs only - no IM alert push by user decision (2026-07-06).
- Config volume backups (`scripts/ops/backup-configs.sh`) and clean git-archive image builds (`scripts/ops/build-image.sh`) are documented in `docs/ops-backup-and-build.md`. Hand-patching a running image is emergency-only.
- If using potluck data to restore a usage card, mark the data as local/stale rather than healthy official quota. Preserve the original refresh failure in `lastRefreshError` and use `staleUsage=true`.
- After editing `usage-cache.json`, check its `timestamp`. If it is stale, the UI may ignore the cache and trigger a fresh upstream refresh that overwrites the repair.
- Duplicate emails in provider-level weekly stats can be legitimate when the same account appears under multiple provider types such as `openai-codex-oauth` and `openaiResponses-custom`, or after provider UUID migration. Account-level UI should prefer email/account identity aggregation and keep provider UUIDs as drill-down detail.
