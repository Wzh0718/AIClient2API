# 可选内部 Node 基础镜像；默认保持官方镜像兼容。
ARG NODE_BASE_IMAGE=node:20-alpine

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
ARG APP_REVISION=unknown
ARG APP_BUILD_DATE=unknown

# 设置标签
LABEL maintainer="AIClient2API Team"
LABEL description="Docker image for AIClient2API server"
LABEL yyn.base_commit=$APP_REVISION
LABEL yyn.build_date=$APP_BUILD_DATE
LABEL yyn.build_source=git-archive

# 代理参数仅用于构建时，不持久化到最终镜像
ARG HTTP_PROXY
ARG HTTPS_PROXY

# 安装必要的系统工具（tar 用于更新功能，git 用于版本检查，procps 用于系统监控）
RUN missing=""; \
    sed -i "s#dl-cdn.alpinelinux.org#$ALPINE_MIRROR#g" /etc/apk/repositories; \
    for package in tar git procps; do \
      command -v "$package" >/dev/null 2>&1 || missing="$missing $package"; \
    done; \
    if [ -n "$missing" ]; then apk add --no-cache $missing; fi

# 设置工作目录
WORKDIR /app

RUN printf '%s\n' "$APP_REVISION" > /app/REVISION

# 复制package.json和package-lock.json（如果存在）
COPY package*.json ./

# 构建时代理（如果提供了的话）。better-sqlite3 在 Alpine 上可能需要本地编译，
# 安装失败时不能跳过 lifecycle scripts，否则镜像会构建成功但 control worker 无法启动。
RUN --mount=type=cache,target=/root/.npm \
    apk add --no-cache --virtual .native-build-deps python3 make g++ \
    && npm_config_proxy="$HTTP_PROXY" npm_config_https_proxy="$HTTPS_PROXY" npm ci \
    && node -e "require('better-sqlite3')(':memory:').close(); console.log('better-sqlite3 runtime ok')" \
    && node -e "import('sharp').then(() => console.log('sharp runtime ok'))" \
    && apk del .native-build-deps

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

# 暴露端口
EXPOSE 3000 8085 8086 19876-19880

# 添加健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js || exit 1

# 设置启动命令
# 使用默认配置启动服务器，支持通过环境变量配置
# 通过环境变量传递参数，例如：docker run -e ARGS="--api-key mykey --port 8080" ...
CMD ["sh", "-c", "node src/core/master.js $ARGS"]
