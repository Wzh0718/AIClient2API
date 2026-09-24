#!/bin/sh
# 每日备份 AIClient-2-API 配置卷（provider_pools.json、api-potluck-keys.json、
# permanent-usage-ledger 等）到卷外目录，并按份数保留。
#
# 用法（生产服务器 root cron）:
#   backup-configs.sh [CONFIG_DIR] [BACKUP_DIR] [KEEP]
# 默认:
#   CONFIG_DIR=/root/ai_client_configs
#   BACKUP_DIR=/root/backups/aiclient2api-configs
#   KEEP=14
#
# 排除项（可通过 BACKUP_EXCLUDE_AUDIT=0 关闭）:
#   request-audit/  体积大且有 35 天滚动保留，默认不进备份
#   logs/           可再生
set -eu

# Explicit release profile; the positional daily/cron interface stays unchanged.
if [ "${1:-}" = "--profile" ]; then
  [ "${2:-}" = "release" ] || { echo "unknown backup profile" >&2; exit 2; }
  shift 2
  exec python3 "$(dirname "$0")/release_backup.py" "$@"
fi

CONFIG_DIR=${1:-/root/ai_client_configs}
BACKUP_DIR=${2:-/root/backups/aiclient2api-configs}
KEEP=${3:-14}
BACKUP_EXCLUDE_AUDIT=${BACKUP_EXCLUDE_AUDIT:-1}

[ -d "$CONFIG_DIR" ] || { echo "config dir not found: $CONFIG_DIR" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
ARCHIVE="$BACKUP_DIR/configs-$STAMP.tar.gz"

EXCLUDES="--exclude=./logs"
if [ "$BACKUP_EXCLUDE_AUDIT" = "1" ]; then
  EXCLUDES="$EXCLUDES --exclude=./request-audit"
fi

# shellcheck disable=SC2086
tar -czf "$ARCHIVE" -C "$CONFIG_DIR" $EXCLUDES .
chmod 600 "$ARCHIVE"

# 校验归档可读，损坏则立即失败并删除，避免留下假备份
gzip -t "$ARCHIVE" || { rm -f "$ARCHIVE"; echo "backup archive corrupted: $ARCHIVE" >&2; exit 1; }

# 保留最近 KEEP 份，其余删除
ls -1t "$BACKUP_DIR"/configs-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r old; do
  rm -f "$old"
done

COUNT=$(ls -1 "$BACKUP_DIR"/configs-*.tar.gz 2>/dev/null | wc -l)
SIZE=$(du -h "$ARCHIVE" | cut -f1)
echo "backup ok: $ARCHIVE ($SIZE), retained $COUNT/$KEEP"
