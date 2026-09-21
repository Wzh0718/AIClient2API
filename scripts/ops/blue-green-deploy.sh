#!/bin/sh
# AIClient2API 轻量蓝绿候选预检工具。
# 默认仅输出计划；只有同时指定 --apply 与明确 phase 才会修改本机 Docker 状态。
# 本工具不自动执行有状态切换，也不发布 OAuth 固定端口。
set -eu

APPLY=0
PHASE=plan
IMAGE=""
REVISION=""
CANDIDATE_PORT=${CANDIDATE_PORT:-13001}
CANDIDATE_CONTAINER=${CANDIDATE_CONTAINER:-aiclient2api-green-candidate}
CANDIDATE_EXECUTION_WORKERS=${CANDIDATE_EXECUTION_WORKERS:-3}
CANDIDATE_NETWORK=${CANDIDATE_NETWORK:-aiclient2api-prod-net}
CANDIDATE_CPUS=${CANDIDATE_CPUS:-2}
CANDIDATE_MEMORY=${CANDIDATE_MEMORY:-2g}
CANDIDATE_NODE_OPTIONS=${CANDIDATE_NODE_OPTIONS:---max-old-space-size=3072}
CANDIDATE_LOG_MAX_SIZE=${CANDIDATE_LOG_MAX_SIZE:-50m}
CANDIDATE_LOG_MAX_FILE=${CANDIDATE_LOG_MAX_FILE:-5}
DEPLOYMENT_EPOCH=${DEPLOYMENT_EPOCH:-green-${REVISION:-candidate}}
CONFIG_DIR=${CONFIG_DIR:-/root/ai_client_configs}
STATE_DIR=${STATE_DIR:-/root/aiclient2api-blue-green}
SNAPSHOT_DIR=${SNAPSHOT_DIR:-$STATE_DIR/candidate-configs}
UPSTREAM_PREVIEW=${UPSTREAM_PREVIEW:-$STATE_DIR/aiclient2api-upstream.candidate.conf}

usage() {
  cat <<'EOF'
用法：
  blue-green-deploy.sh --image IMAGE --revision COMMIT [--phase plan|prepare|render|cleanup] [--apply]

phase：
  plan     仅显示将执行的检查，默认值
  prepare  复制配置快照并启动只绑定备用主 API 端口的候选容器
  render   生成候选 Nginx upstream 预览并执行 nginx -t，不安装配置
  cleanup  删除带候选标签的容器；配置快照保留供审计
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --phase) PHASE=${2:?missing phase}; shift ;;
    --image) IMAGE=${2:?missing image}; shift ;;
    --revision) REVISION=${2:?missing revision}; shift ;;
    --candidate-port) CANDIDATE_PORT=${2:?missing port}; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[ -n "$IMAGE" ] || { echo "--image is required" >&2; exit 2; }
[ -n "$REVISION" ] || { echo "--revision is required" >&2; exit 2; }

STATE_DIR=$(realpath -m "$STATE_DIR")
SNAPSHOT_DIR=$(realpath -m "$SNAPSHOT_DIR")
UPSTREAM_PREVIEW=$(realpath -m "$UPSTREAM_PREVIEW")

log() { printf '%s\n' "$*"; }

run() {
  if [ "$APPLY" = "1" ]; then
    "$@"
  else
    printf '[dry-run]'
    printf ' %s' "$@"
    printf '\n'
  fi
}

verify_safe_paths() {
  case "$STATE_DIR" in
    ""|/) echo "refusing unsafe state dir: $STATE_DIR" >&2; exit 1 ;;
  esac
  case "$SNAPSHOT_DIR" in
    "$STATE_DIR"/*) ;;
    *) echo "refusing unsafe snapshot path: $SNAPSHOT_DIR is outside $STATE_DIR" >&2; exit 1 ;;
  esac
  [ "$SNAPSHOT_DIR" != "$STATE_DIR" ] || {
    echo "refusing unsafe snapshot path: snapshot equals state dir" >&2
    exit 1
  }
}

verify_image_revision() {
  actual=$(docker image inspect --format '{{ index .Config.Labels "yyn.base_commit" }}' "$IMAGE")
  [ "$actual" = "$REVISION" ] || {
    echo "image revision mismatch: expected=$REVISION actual=$actual" >&2
    exit 1
  }
}

verify_candidate_owner() {
  if ! docker container inspect "$CANDIDATE_CONTAINER" >/dev/null 2>&1; then
    return 1
  fi
  role=$(docker container inspect --format '{{ index .Config.Labels "yyn.deployment_role" }}' "$CANDIDATE_CONTAINER")
  [ "$role" = "candidate" ] || {
    echo "refusing to touch unowned container: $CANDIDATE_CONTAINER" >&2
    exit 1
  }
}

wait_for_health() {
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    status=$(docker inspect --format '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}none{{ end }}' "$CANDIDATE_CONTAINER")
    [ "$status" = "healthy" ] && return 0
    [ "$status" = "unhealthy" ] && return 1
    attempts=$((attempts + 1))
    sleep 2
  done
  return 1
}

verify_candidate_log_config() {
  actual=$(docker inspect --format '{{index .HostConfig.LogConfig.Config "max-size"}} {{index .HostConfig.LogConfig.Config "max-file"}}' "$CANDIDATE_CONTAINER")
  expected="$CANDIDATE_LOG_MAX_SIZE $CANDIDATE_LOG_MAX_FILE"
  [ "$actual" = "$expected" ] || {
    echo "candidate log configuration mismatch: expected=$expected actual=$actual" >&2
    return 1
  }
}

prepare_candidate() {
  verify_image_revision
  verify_safe_paths
  [ -d "$CONFIG_DIR" ] || { echo "config dir not found: $CONFIG_DIR" >&2; exit 1; }
  [ -n "${REDIS_URL:-}" ] || { echo "REDIS_URL is required for multi-worker candidate preflight" >&2; exit 1; }
  docker network inspect "$CANDIDATE_NETWORK" >/dev/null 2>&1 || {
    echo "candidate network not found: $CANDIDATE_NETWORK" >&2
    exit 1
  }

  # usage-events holds a multi-GB SQLite file that the active container keeps
  # writing, so copying it both wastes disk and yields a torn database: the
  # candidate then dies at startup with SQLITE_CORRUPT. The candidate creates a
  # fresh store instead; durable usage data stays with the active container.
  SNAPSHOT_EXCLUDES="--exclude=request-audit --exclude=app-logs --exclude=usage-events"
  # shellcheck disable=SC2086
  SNAPSHOT_REQUIRED_BYTES=$(du -sb $SNAPSHOT_EXCLUDES "$CONFIG_DIR" | awk '{print $1}')
  snapshot_available_bytes=$(df -B1 --output=avail "$STATE_DIR" 2>/dev/null | tail -1 | tr -d ' ')
  if [ -z "$snapshot_available_bytes" ]; then
    snapshot_available_bytes=$(df -B1 --output=avail "$(dirname "$STATE_DIR")" | tail -1 | tr -d ' ')
  fi
  snapshot_margin_bytes=$((512 * 1024 * 1024))
  [ "$snapshot_available_bytes" -ge $((SNAPSHOT_REQUIRED_BYTES + snapshot_margin_bytes)) ] || {
    echo "insufficient disk space for candidate snapshot: required=$SNAPSHOT_REQUIRED_BYTES available=$snapshot_available_bytes" >&2
    exit 1
  }

  if [ "$APPLY" = "1" ]; then
    mkdir -p "$STATE_DIR"
    chmod 700 "$STATE_DIR"
    rm -rf "$SNAPSHOT_DIR"
    mkdir -p "$SNAPSHOT_DIR"
    chmod 700 "$SNAPSHOT_DIR"
    # shellcheck disable=SC2086
    tar -C "$CONFIG_DIR" $SNAPSHOT_EXCLUDES -cf - . | tar -C "$SNAPSHOT_DIR" -xf -
    if verify_candidate_owner; then docker rm -f "$CANDIDATE_CONTAINER" >/dev/null; fi
  else
    log "[dry-run] create protected config snapshot: $CONFIG_DIR -> $SNAPSHOT_DIR"
  fi

  run docker run -d \
    --name "$CANDIDATE_CONTAINER" \
    --label yyn.deployment_role=candidate \
    --label "yyn.expected_revision=$REVISION" \
    --network "$CANDIDATE_NETWORK" \
    --env RUNTIME_MULTI_WORKER_ENABLED=true \
    --env "RUNTIME_EXECUTION_WORKERS=$CANDIDATE_EXECUTION_WORKERS" \
    --env REDIS_URL \
    --env "RUNTIME_DEPLOYMENT_EPOCH=$DEPLOYMENT_EPOCH" \
    --env "NODE_OPTIONS=$CANDIDATE_NODE_OPTIONS" \
    --log-driver json-file \
    --log-opt "max-size=$CANDIDATE_LOG_MAX_SIZE" \
    --log-opt "max-file=$CANDIDATE_LOG_MAX_FILE" \
    --cpus "$CANDIDATE_CPUS" \
    --memory "$CANDIDATE_MEMORY" \
    -p "127.0.0.1:${CANDIDATE_PORT}:3000" \
    -v "$SNAPSHOT_DIR:/app/configs" \
    "$IMAGE"

  if [ "$APPLY" = "1" ]; then
    wait_for_health || { docker logs --tail 100 "$CANDIDATE_CONTAINER" >&2; exit 1; }
    verify_candidate_log_config || exit 1
    # The container healthcheck flips before the HTTP surface is warm, so a
    # single 5s probe here reported a false failure on a candidate that was fine.
    probe=0
    until curl -fsS --max-time 10 "http://127.0.0.1:${CANDIDATE_PORT}/api/health" >/dev/null; do
      probe=$((probe + 1))
      [ "$probe" -lt 12 ] || { echo "candidate did not answer /api/health" >&2; exit 1; }
      sleep 5
    done
    runtime_health=$(curl -fsS --max-time 5 "http://127.0.0.1:${CANDIDATE_PORT}/runtime/health")
    printf '%s' "$runtime_health" | grep -Eq '"pendingWorkerCount"[[:space:]]*:[[:space:]]*0' || {
      echo "candidate provider config propagation is still pending" >&2
      exit 1
    }
    log "candidate healthy: container=$CANDIDATE_CONTAINER port=$CANDIDATE_PORT revision=$REVISION epoch=$DEPLOYMENT_EPOCH"
  fi
}

render_upstream_preview() {
  verify_safe_paths
  content="upstream aiclient2api_active { server 127.0.0.1:${CANDIDATE_PORT}; keepalive 32; }"
  if [ "$APPLY" = "1" ]; then
    mkdir -p "$STATE_DIR"
    printf '%s\n' "$content" > "$UPSTREAM_PREVIEW.tmp"
    mv "$UPSTREAM_PREVIEW.tmp" "$UPSTREAM_PREVIEW"
    nginx -t
  else
    log "[dry-run] write upstream preview: $UPSTREAM_PREVIEW"
    log "$content"
    log "[dry-run] nginx -t"
  fi
  log "preview only; do not install until OAuth/management writes are paused and the single-writer handoff is approved"
}

cleanup_candidate() {
  verify_safe_paths
  if verify_candidate_owner; then
    run docker rm -f "$CANDIDATE_CONTAINER"
  else
    log "candidate container not found: $CANDIDATE_CONTAINER"
  fi
  log "config snapshot retained: $SNAPSHOT_DIR"
}

case "$PHASE" in
  plan)
    verify_image_revision
    log "plan: prepare candidate on 127.0.0.1:${CANDIDATE_PORT}, validate health, render upstream preview"
    log "plan: no OAuth ports, no Nginx install, no active-container stop"
    ;;
  prepare) prepare_candidate ;;
  render) render_upstream_preview ;;
  cleanup) cleanup_candidate ;;
  *) echo "invalid phase: $PHASE" >&2; exit 2 ;;
esac
