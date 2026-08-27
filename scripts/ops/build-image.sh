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
# 可选代理（Go sidecar 依赖下载失败时）:
#   BUILD_HTTP_PROXY=http://192.168.4.242:7890 build-image.sh
set -eu

GIT_REF=${1:-HEAD}
COMMIT=$(git rev-parse "$GIT_REF")
SHORT_COMMIT=$(git rev-parse --short "$GIT_REF")
BUILD_DATE=$(date -Iseconds)
IMAGE_TAG=${2:-aiclient2api:customized-branch-$SHORT_COMMIT-$(date +%Y%m%d)}

BUILD_ARGS=""
if [ -n "${BUILD_HTTP_PROXY:-}" ]; then
  BUILD_ARGS="--build-arg HTTP_PROXY=$BUILD_HTTP_PROXY --build-arg HTTPS_PROXY=$BUILD_HTTP_PROXY"
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "exporting $GIT_REF ($COMMIT) to $TMP_DIR"
git archive "$GIT_REF" | tar -x -C "$TMP_DIR"

echo "building $IMAGE_TAG"
# shellcheck disable=SC2086
docker build \
  $BUILD_ARGS \
  --build-arg APP_REVISION="$COMMIT" \
  --build-arg APP_BUILD_DATE="$BUILD_DATE" \
  --label "yyn.base_commit=$COMMIT" \
  --label "yyn.build_source=git-archive" \
  --label "yyn.build_date=$BUILD_DATE" \
  -t "$IMAGE_TAG" \
  "$TMP_DIR"

ACTUAL_COMMIT=$(docker image inspect --format '{{ index .Config.Labels "yyn.base_commit" }}' "$IMAGE_TAG")
[ "$ACTUAL_COMMIT" = "$COMMIT" ] || {
  echo "image revision mismatch: expected=$COMMIT actual=$ACTUAL_COMMIT" >&2
  exit 1
}

echo "built $IMAGE_TAG from commit $COMMIT"
echo "next: docker save/scp/load, rename old container as timestamped backup, start new, verify /health"
