# 可选内部 Node 基础镜像；默认保持官方镜像兼容。
ARG NODE_BASE_IMAGE=node:20-alpine
ARG NODE_BUILD_IMAGE=node:20-alpine

# Stable native dependency stage. An internal build base supplies the toolchain;
# the official image remains a supported cold-build fallback.
FROM ${NODE_BUILD_IMAGE} AS node-dependencies
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALPINE_MIRROR=mirrors.aliyun.com
WORKDIR /app
RUN missing=""; \
    sed -i "s#dl-cdn.alpinelinux.org#$ALPINE_MIRROR#g" /etc/apk/repositories; \
    for pair in python3:python3 make:make g++:g++; do \
      command -v "${pair%%:*}" >/dev/null 2>&1 || missing="$missing ${pair#*:}"; \
    done; \
    if [ -n "$missing" ]; then apk add --no-cache $missing; fi
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm_config_proxy="$HTTP_PROXY" npm_config_https_proxy="$HTTPS_PROXY" npm ci --omit=dev \
    && node -e "require('better-sqlite3')(':memory:').close(); console.log('better-sqlite3 runtime ok')" \
    && node -e "import('sharp').then(() => console.log('sharp runtime ok'))"

# ── Stage 1: 编译 Go TLS sidecar ──
FROM golang:1.22-alpine AS sidecar-builder

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALPINE_MIRROR=mirrors.aliyun.com
ARG GOPROXY=https://proxy.golang.org,direct
ENV HTTP_PROXY=$HTTP_PROXY
ENV HTTPS_PROXY=$HTTPS_PROXY
ENV http_proxy=$HTTP_PROXY
ENV https_proxy=$HTTPS_PROXY
ENV GOPROXY=$GOPROXY

RUN sed -i "s#dl-cdn.alpinelinux.org#$ALPINE_MIRROR#g" /etc/apk/repositories \
    && apk add --no-cache git

WORKDIR /build
COPY tls-sidecar/go.mod tls-sidecar/go.sum* ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

COPY tls-sidecar/ ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod tidy \
    && CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o tls-sidecar .

# ── Stage 2: Node.js 应用 ──
# 使用官方Node.js运行时作为基础镜像
# 选择20-alpine版本以满足undici包的要求（需要Node.js >=20.18.1）
FROM ${NODE_BASE_IMAGE}

ARG ALPINE_MIRROR=mirrors.aliyun.com

# 设置标签
LABEL maintainer="AIClient2API Team"
LABEL description="Docker image for AIClient2API server"

# 代理参数仅用于构建时，不持久化到最终镜像
ARG HTTP_PROXY
ARG HTTPS_PROXY

# 安装必要的系统工具（tar 用于更新功能，git 用于版本检查，procps 用于系统监控）
RUN missing=""; \
    sed -i "s#dl-cdn.alpinelinux.org#$ALPINE_MIRROR#g" /etc/apk/repositories; \
    command -v tar >/dev/null 2>&1 || missing="$missing tar"; \
    command -v git >/dev/null 2>&1 || missing="$missing git"; \
    command -v ps >/dev/null 2>&1 || missing="$missing procps"; \
    if [ -n "$missing" ]; then apk add --no-cache $missing; fi

# 设置工作目录
WORKDIR /app

# 复制package.json和package-lock.json（如果存在）
COPY package*.json ./

# 构建时代理（如果提供了的话）。better-sqlite3 在 Alpine 上可能需要本地编译，
# 安装失败时不能跳过 lifecycle scripts，否则镜像会构建成功但 control worker 无法启动。
COPY --from=node-dependencies /app/node_modules ./node_modules

# 构建代理只用于依赖下载，不得进入运行时环境。
ENV HTTP_PROXY="" HTTPS_PROXY="" http_proxy="" https_proxy=""

# 复制源代码
COPY . .

# 从 sidecar 构建阶段复制二进制
# 放在 COPY . . 之后是为了确保不会被本地的空目录或旧二进制文件覆盖
COPY --from=sidecar-builder /build/tls-sidecar /app/tls-sidecar/tls-sidecar
RUN chmod +x /app/tls-sidecar/tls-sidecar

USER root

# 创建目录用于存储日志和系统提示文件
RUN mkdir -p /app/logs

# Release metadata is deliberately last: changing a commit/date must not evict
# system packages, npm dependencies or the sidecar build from the cache.
ARG APP_REVISION=unknown
ARG APP_BUILD_DATE=unknown
LABEL yyn.base_commit=$APP_REVISION
LABEL yyn.build_date=$APP_BUILD_DATE
LABEL yyn.build_source=git-archive
RUN printf '%s\n' "$APP_REVISION" > /app/REVISION

# 暴露端口
EXPOSE 3000 8085 8086 19876-19880

# 添加健康检查
# 多 worker 启动期间 /health 会先返回 503 等待 provider 配置收敛，实测需要 35s 以上，
# 5s 的 start-period 会让正常的滚动切换被误判成 unhealthy。
HEALTHCHECK --interval=30s --timeout=3s --start-period=180s --retries=3 \
  CMD node healthcheck.js || exit 1

# 设置启动命令
# 使用默认配置启动服务器，支持通过环境变量配置
# 通过环境变量传递参数，例如：docker run -e ARGS="--api-key mykey --port 8080" ...
CMD ["sh", "-c", "node src/core/master.js $ARGS"]
