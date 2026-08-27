#!/bin/sh
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
set -eu

GIT_REF=${1:-HEAD}
COMMIT=$(git rev-parse "$GIT_REF")
SHORT_COMMIT=$(git rev-parse --short "$GIT_REF")
BUILD_DATE=$(date -Iseconds)
IMAGE_TAG=${2:-aiclient2api:customized-branch-$SHORT_COMMIT-$(date +%Y%m%d)}
BUILD_HTTP_PROXY=${BUILD_HTTP_PROXY:-http://192.168.4.242:7890}
BUILD_RETRIES=${BUILD_RETRIES:-2}
BUILD_RETRY_DELAY_SEC=${BUILD_RETRY_DELAY_SEC:-5}
NODE_BASE_IMAGE=${NODE_BASE_IMAGE:-node:20-alpine}
ALPINE_MIRROR=${ALPINE_MIRROR:-mirrors.aliyun.com}

BUILD_ARGS="--build-arg HTTP_PROXY=$BUILD_HTTP_PROXY --build-arg HTTPS_PROXY=$BUILD_HTTP_PROXY"

stage_start() { date +%s; }
stage_done() {
  stage_name=$1
  stage_started=$2
  stage_finished=$(date +%s)
  echo "stage=$stage_name elapsed=$((stage_finished - stage_started))s"
}

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

export_started=$(stage_start)
echo "exporting $GIT_REF ($COMMIT) to $TMP_DIR"
git archive "$GIT_REF" | tar -x -C "$TMP_DIR"
stage_done export "$export_started"

echo "building $IMAGE_TAG with proxy $BUILD_HTTP_PROXY"
build_started=$(stage_start)
attempt=1
while :; do
  echo "build attempt $attempt/$((BUILD_RETRIES + 1))"
  # shellcheck disable=SC2086
  if DOCKER_BUILDKIT=1 docker build --progress=plain \
      $BUILD_ARGS \
      --build-arg APP_REVISION="$COMMIT" \
      --build-arg APP_BUILD_DATE="$BUILD_DATE" \
      --build-arg NODE_BASE_IMAGE="$NODE_BASE_IMAGE" \
      --build-arg ALPINE_MIRROR="$ALPINE_MIRROR" \
      --label "yyn.base_commit=$COMMIT" \
      --label "yyn.build_source=git-archive" \
      --label "yyn.build_date=$BUILD_DATE" \
      -t "$IMAGE_TAG" \
      "$TMP_DIR"; then
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

verify_started=$(stage_start)
ACTUAL_COMMIT=$(docker image inspect --format '{{ index .Config.Labels "yyn.base_commit" }}' "$IMAGE_TAG")
[ "$ACTUAL_COMMIT" = "$COMMIT" ] || {
  echo "image revision mismatch: expected=$COMMIT actual=$ACTUAL_COMMIT" >&2
  exit 1
}
stage_done verify "$verify_started"

echo "built $IMAGE_TAG from commit $COMMIT"
echo "next: docker save/scp/load, rename old container as timestamped backup, start new, verify /health"
