#!/usr/bin/env bash
# 从干净的 git 提交构建生产镜像，替代手工 patch 镜像。
# 通过 `git archive` 导出指定提交到临时目录再 build，
# 保证镜像内容与提交一致，不受工作树未提交改动和 CRLF 影响。
#
# 用法:
#   build-image.sh [GIT_REF] [IMAGE_TAG]
# 默认:
#   GIT_REF=HEAD
#   IMAGE_TAG=aiclient2api:customized-branch-<shortsha>-<yyyymmdd>
#
# 构建代理默认使用项目约定的宿主代理；如需覆盖请显式传入 BUILD_HTTP_PROXY。
#   BUILD_HTTP_PROXY=http://192.168.4.242:7890 build-image.sh
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
LOCK_DIR=$(git rev-parse --git-common-dir)/yyn-build.lock
mkdir "$LOCK_DIR" 2>/dev/null || { echo "another image build holds $LOCK_DIR" >&2; exit 1; }
TMP_DIR=""
trap 'if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi; rmdir "$LOCK_DIR"' EXIT

GIT_REF=${1:-HEAD}
COMMIT=$(git rev-parse "$GIT_REF")
SHORT_COMMIT=$(git rev-parse --short "$GIT_REF")
BUILD_DATE=$(date -Iseconds)
IMAGE_TAG=${2:-aiclient2api:customized-branch-$SHORT_COMMIT-$(date +%Y%m%d)}
BUILD_HTTP_PROXY=${BUILD_HTTP_PROXY-http://192.168.4.242:7890}
BUILD_RETRIES=${BUILD_RETRIES:-2}
BUILD_RETRY_DELAY_SEC=${BUILD_RETRY_DELAY_SEC:-5}
NODE_BASE_IMAGE=${NODE_BASE_IMAGE:-node:20-alpine}
ALPINE_MIRROR=${ALPINE_MIRROR:-mirrors.aliyun.com}

BUILD_ARGS=(--build-arg "HTTP_PROXY=$BUILD_HTTP_PROXY" --build-arg "HTTPS_PROXY=$BUILD_HTTP_PROXY")

stage_start() { date +%s; }
stage_done() {
  stage_name=$1
  stage_started=$2
  stage_finished=$(date +%s)
  echo "stage=$stage_name elapsed=$((stage_finished - stage_started))s"
}

TMP_DIR=$(mktemp -d)
SOURCE_DIR="$TMP_DIR/source"
TEST_DIR="$TMP_DIR/test-source"
mkdir "$SOURCE_DIR" "$TEST_DIR"
export_started=$(stage_start)
git archive "$COMMIT" | tar -x -C "$SOURCE_DIR"
git archive "$COMMIT" | tar -x -C "$TEST_DIR"
stage_done export "$export_started"
TEST_CACHE_DIR=${RELEASE_BUILD_DIR:-$TMP_DIR/test-results}
mkdir -p "$TEST_CACHE_DIR"
TEST_KEY=$(printf '%s\n' "$COMMIT" "$(node --version)" "$(node -p 'process.platform + process.arch')" \
  "$(git hash-object --path=package-lock.json package-lock.json)" "$(sha256sum node_modules/.package-lock.json | cut -d' ' -f1)" \
  'provider-pool-,antigravity-,runtime-;runInBand;exclude-runtime-usage-event-store;v2' | sha256sum | cut -d' ' -f1)

# Commit cec016f shipped two failing suites straight to production, so routing
# and runtime regressions now gate the build. Set SKIP_TEST_GATE=1 only for an
# emergency rebuild of an already-verified commit.
if [ "${SKIP_TEST_GATE:-0}" != "1" ]; then
  test_started=$(stage_start)
  echo "running required regression suites"
  # Several pool suites share the real configs/usage-cache.json fixture, so they
  # race against each other when Jest runs them in parallel workers.
  # runtime-usage-event-store needs a compiled better-sqlite3 binding, which is
  # absent on the Windows build host; it is covered inside the image instead.
  if [ ! -f "$TEST_CACHE_DIR/$TEST_KEY.ok" ]; then
  # Run the exported commit, not a concurrently changing working tree. Dependencies
  # must match the export; Jest/Babel resolve them through the explicit module path.
  [ "$(git hash-object --path=package-lock.json package-lock.json)" = "$(git rev-parse "$COMMIT:package-lock.json")" ] || { echo "install dependencies matching the requested commit first" >&2; exit 1; }
  MODULE_PATH=$(node -p "process.cwd() + '/node_modules'")
  (cd "$TEST_DIR" && NODE_PATH="$MODULE_PATH" node "$ROOT/node_modules/jest/bin/jest.js" \
    tests/provider-pool- tests/antigravity- tests/runtime- --runInBand \
    --modulePaths "$MODULE_PATH" --testPathIgnorePatterns 'tests/runtime-usage-event-store.test.js' --silent) || {
    echo "regression suites failed; refusing to build $IMAGE_TAG" >&2
    exit 1
  }
  printf '%s\n' "$COMMIT" > "$TEST_CACHE_DIR/$TEST_KEY.ok"
  else
    echo "reusing successful test gate for this release and exact source/environment"
  fi
  stage_done test-gate "$test_started"
else
  echo "WARNING: test gate skipped via SKIP_TEST_GATE=1" >&2
fi

base_started=$(stage_start)
# Resolve the cached parent ID without pulling. A deliberate parent update changes
# the content key. Build definitions come from the same exported commit.
PARENT_ID=$(docker image inspect --format '{{.Id}}' "$NODE_BASE_IMAGE")
PLATFORM=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$NODE_BASE_IMAGE")
BASE_KEY=$( { printf '%s\n' "$PARENT_ID" "$PLATFORM" "$ALPINE_MIRROR"; cat "$SOURCE_DIR/docker/Dockerfile.build-base"; } | sha256sum | cut -c1-20)
NODE_BUILD_IMAGE="aiclient2api:node20-alpine-build-base-$BASE_KEY"
if ! docker image inspect "$NODE_BUILD_IMAGE" >/dev/null 2>&1; then
  (cd "$SOURCE_DIR" && NODE_BASE_IMAGE="$NODE_BASE_IMAGE" BUILD_HTTP_PROXY="$BUILD_HTTP_PROXY" \
    sh scripts/ops/build-base-image.sh "$NODE_BUILD_IMAGE")
fi
[ "$(docker image inspect --format '{{.Id}}' "$NODE_BASE_IMAGE")" = "$PARENT_ID" ] || { echo "parent tag moved during build" >&2; exit 1; }
stage_done build-base "$base_started"

echo "building $IMAGE_TAG"
build_started=$(stage_start)
attempt=1
while :; do
  echo "build attempt $attempt/$((BUILD_RETRIES + 1))"
  # shellcheck disable=SC2086
  if DOCKER_BUILDKIT=1 docker build --progress=plain \
      "${BUILD_ARGS[@]}" \
      --build-arg APP_REVISION="$COMMIT" \
      --build-arg APP_BUILD_DATE="$BUILD_DATE" \
      --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" \
      --build-arg NODE_BUILD_IMAGE="$NODE_BUILD_IMAGE" \
      --build-arg ALPINE_MIRROR="$ALPINE_MIRROR" \
      --label "yyn.base_commit=$COMMIT" \
      --label "yyn.build_source=git-archive" \
      --label "yyn.build_date=$BUILD_DATE" \
      -t "$IMAGE_TAG" \
      "$SOURCE_DIR"; then
    break
  fi
  if [ "$attempt" -gt "$BUILD_RETRIES" ]; then
    echo "build failed after $attempt attempts" >&2
    exit 1
  fi
  echo "build attempt $attempt failed; retrying in ${BUILD_RETRY_DELAY_SEC}s" >&2
  sleep "$BUILD_RETRY_DELAY_SEC"
  attempt=$((attempt + 1))
done
stage_done docker-build "$build_started"
[ "$(docker image inspect --format '{{.Id}}' "$NODE_BASE_IMAGE")" = "$PARENT_ID" ] || { echo "parent tag moved during build" >&2; exit 1; }

verify_started=$(stage_start)
ACTUAL_COMMIT=$(docker image inspect --format '{{ index .Config.Labels "yyn.base_commit" }}' "$IMAGE_TAG")
[ "$ACTUAL_COMMIT" = "$COMMIT" ] || {
  echo "image revision mismatch: expected=$COMMIT actual=$ACTUAL_COMMIT" >&2
  exit 1
}
stage_done verify "$verify_started"
printf 'commit=%s\nimage=%s\nbase=%s\n' "$COMMIT" "$IMAGE_TAG" "$NODE_BUILD_IMAGE" > "$TEST_CACHE_DIR/build-result.txt"

echo "built $IMAGE_TAG from commit $COMMIT"
echo "next: docker save/scp/load, rename old container as timestamped backup, start new, verify /health"
