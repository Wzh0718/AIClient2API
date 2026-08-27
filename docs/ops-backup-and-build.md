# Ops: Config Backup and Image Build

This documents the two standing ops scripts under `scripts/ops/`. Both target the production Linux server. Do not commit generated backups, archives, or any credential files.

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

`BUILD_HTTP_PROXY` is also forwarded to npm in the Node build stage (`HTTP_PROXY`/`HTTPS_PROXY` plus npm's explicit proxy settings), so the same command covers both Go and npm dependency downloads. A proxy can improve reliability and sometimes throughput for large dependency downloads; a small registry ping may show little difference. Keep the default registry unless an approved mirror is available, and never place proxy credentials in the repository or build logs.

Labels `yyn.base_commit`, `yyn.build_source=git-archive`, and `yyn.build_date` are stamped for container source verification. Rollout still follows the AGENTS.md remote ops protocol: record current image/health, rename the old container as a timestamped backup, start the new one, verify Docker health and `/health`.
