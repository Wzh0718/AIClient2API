#!/bin/sh
set -eu

BUILD_HTTP_PROXY=${BUILD_HTTP_PROXY:-http://192.168.4.242:7890}
ALPINE_MIRROR=${ALPINE_MIRROR:-mirrors.aliyun.com}
IMAGE_TAG=${1:-aiclient2api:node20-alpine-build-base}

echo "building $IMAGE_TAG with proxy $BUILD_HTTP_PROXY"
DOCKER_BUILDKIT=1 docker build --progress=plain \
  --build-arg BUILD_HTTP_PROXY="$BUILD_HTTP_PROXY" \
  --build-arg HTTPS_PROXY="$BUILD_HTTP_PROXY" \
  --build-arg ALPINE_MIRROR="$ALPINE_MIRROR" \
  -t "$IMAGE_TAG" \
  -f docker/Dockerfile.build-base \
  docker

docker image inspect "$IMAGE_TAG" >/dev/null
echo "built $IMAGE_TAG"
