#!/usr/bin/env bash
# One-time consistent backup for the Codex email archive repair.
set -euo pipefail

[[ $# == 3 ]] || { echo 'usage: codex-email-archive-backup.sh CONFIG_DIR WORK_DIR WRITER_CONTAINER' >&2; exit 1; }
config_dir=$(realpath -e -- "$1")
work_dir=$(realpath -e -- "$2")
writer_container=$3
[[ "$work_dir" != "$config_dir" && "$work_dir" != "$config_dir/"* ]] || {
  echo 'backup directory must be outside the config volume' >&2; exit 1;
}
archive="$work_dir/production-before.tar.gz"
temporary="$archive.tmp"

[[ -d "$config_dir" && -d "$work_dir" ]] || { echo 'expected directories are missing' >&2; exit 1; }
[[ ! -e "$archive" && ! -e "$temporary" ]] || { echo 'backup already exists' >&2; exit 1; }
[[ $(docker inspect --format '{{.State.Running}}' "$writer_container") == false ]] || {
  echo 'active writer is still running' >&2; exit 1;
}

umask 077
tar -C "$config_dir" -cf - \
  model-usage-stats.json \
  api-potluck-keys.json \
  provider_pools.json \
  usage-cache.json \
  usage-display-cache.json \
  codex-weekly-estimate-snapshots.json \
  usage-events \
  permanent-usage-ledger/daily \
  permanent-usage-ledger/hourly | gzip -1 > "$temporary"
gzip -t "$temporary"
mv "$temporary" "$archive"
sha256sum "$archive" > "$archive.sha256"
tar -tzf "$archive" > "$archive.list"
printf 'backup=%s bytes=%s entries=%s\n' "$archive" "$(stat -c %s "$archive")" "$(wc -l < "$archive.list")"
