# Ops: Config Backup and Image Build

This documents the two standing ops scripts under `scripts/ops/`. Both target the production Linux server. Do not commit generated backups, archives, or any credential files.

For ordinary releases use [the fast release workflow](ops-release-fast-path.md).
`backup-configs.sh --profile release` selects an explicit file allowlist and excludes databases;
the daily positional interface below intentionally remains unchanged.

## Daily Config Backup

`scripts/ops/backup-configs.sh` archives the config volume to a directory outside the volume and keeps the most recent N archives.

- Default source: `/root/ai_client_configs` (mounted at `/app/configs`)
- Default target: `/root/backups/aiclient2api-configs/configs-<timestamp>.tar.gz` (mode 600)
- Default retention: 14 archives
- Excluded by default: `logs/` and `request-audit/` (large, 35-day rolling; set `BACKUP_EXCLUDE_AUDIT=0` to include)
- Included: `provider_pools.json`, `api-potluck-keys.json`, `usage-cache.json`, `permanent-usage-ledger/`, codex creds, and everything else in the volume

Deploy: copy the script to the server (e.g. `/root/ai_client_configs/tools/`), `chmod 700`, then add cron:

```cron
50 0 * * * root /root/ai_client_configs/tools/backup-configs.sh >> /root/backups/aiclient2api-configs/backup.log 2>&1
```

The script verifies the archive with `gzip -t` and deletes it on corruption, so a silent bad backup cannot accumulate. Restore is a manual, deliberate operation: extract to a staging directory first, never directly over the live volume.

## Image Build From Git

`scripts/ops/build-image.sh` builds the production image from a clean `git archive` export of a commit, so the image always matches a commit exactly (no working-tree drift, no CRLF surprises). Hand-patching a running image is an emergency-only measure.

```bash
./scripts/ops/build-image.sh                 # HEAD -> aiclient2api:customized-branch-<sha>-<date>
./scripts/ops/build-image.sh v3.3.2          # build a tag
BUILD_HTTP_PROXY=http://192.168.4.242:7890 ./scripts/ops/build-image.sh   # project build proxy for Go/npm downloads
```

The build helper defaults to the project Docker build proxy `http://192.168.4.242:7890`; override it with `BUILD_HTTP_PROXY=` only when needed. The proxy is forwarded to Go and npm (`HTTP_PROXY`/`HTTPS_PROXY` plus npm's explicit proxy settings). `BUILD_RETRIES` (default `2`) and `BUILD_RETRY_DELAY_SEC` (default `5`) provide bounded retries, while each archive/build/verify phase prints elapsed seconds. Retries reuse BuildKit's cached layers, so a transient registry failure does not discard completed dependency work.

The Dockerfile mounts BuildKit caches for Go modules, Go compilation, and npm's cache. Keep BuildKit enabled. The first cold build can still spend several minutes downloading Alpine packages and compiling native modules; subsequent builds should reuse those layers unless the base image, package manifests, or native-tool layer changes. Do not hide dependency failures with `|| true`; a missing Go checksum or native module must fail the build.

The build helper now resolves and reuses a content-keyed internal **build-stage** base automatically.
Its key includes the cached parent image ID, platform and base Dockerfile; it is rebuilt only when missing or changed.
The final runtime uses the official Node parent and copies production dependencies from the build stage.
To prepare a base manually for diagnostics:

```bash
./scripts/ops/build-base-image.sh aiclient2api:node20-alpine-build-base
```

This preinstalls `git`, `tar`, `procps`, `python3`, `make`, and `g++` for compilation only.
Do not set NODE_BASE_IMAGE to the compiler image: NODE_BASE_IMAGE selects the runtime parent.
Review and deliberately update the parent security baseline separately from ordinary deployments.

Labels `yyn.base_commit`, `yyn.build_source=git-archive`, and `yyn.build_date` are stamped for container source verification. Rollout still follows the AGENTS.md remote ops protocol: record current image/health, rename the old container as a timestamped backup, start the new one, verify Docker health and `/health`.
