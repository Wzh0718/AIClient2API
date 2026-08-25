# 上游仓库清单

本文件记录本次对比使用的 3 个公开上游仓库。代码镜像位于 [`_research/upstreams/`](./_research/upstreams/)，仅用于只读研究，不作为 Git submodule，也不参与运行时依赖。

采集日期：2026-08-25（执行时重新读取默认分支 HEAD）
本项目对比基线：`customized-branch`，HEAD `c3f83bc9ee09c884d49a6dbf4ebd7a9108e8a4ba`
本项目 `origin/main`：`c03d106ce6f68c3d0264373bc635e3506a9e6316`

## 1. CLIProxyAPI

- 地址：https://github.com/router-for-me/CLIProxyAPI
- 默认分支：`main`
- 本地镜像：[`_research/upstreams/cliproxyapi/`](./_research/upstreams/cliproxyapi/)
- 采集 HEAD：`1f53b2eb03b9e963bac647e5566ca2b304239116`
- HEAD 提交：`fix(auth): keep credential rotation fair when candidates are filtered`
- 项目说明：Go 实现的 CLI 模型代理，提供 OpenAI、Gemini、Claude、Codex、Grok 等兼容接口，支持 OAuth、多个账号轮询、工具调用、多模态、WebSocket、管理 API、插件/SDK 及可选 Redis 使用量队列。
- 主要证据：[`README.md`](./_research/upstreams/cliproxyapi/README.md)、[`internal/`](./_research/upstreams/cliproxyapi/internal/)、[`sdk/`](./_research/upstreams/cliproxyapi/sdk/)、[`config.example.yaml`](./_research/upstreams/cliproxyapi/config.example.yaml)。

## 2. AIClient2API upstream

- 地址：https://github.com/justlovemaki/AIClient2API
- 默认分支：`main`
- 本地镜像：[`_research/upstreams/aiclient2api/`](./_research/upstreams/aiclient2api/)
- 采集 HEAD：`c03d106ce6f68c3d0264373bc635e3506a9e6316`
- HEAD 提交：`docs: 更新赞助商链接并将版本升级至3.4.2.1`
- 项目说明：Node.js 实现的多协议 AI API 代理，将 Gemini、Antigravity、Codex、Grok、Kiro 等客户端能力转换为 OpenAI/Claude/Gemini 兼容接口，包含 provider adapter、账号池、故障转移、Web UI、图片接口和 Docker 部署。
- 主要证据：[`README-ZH.md`](./_research/upstreams/aiclient2api/README-ZH.md)、[`src/`](./_research/upstreams/aiclient2api/src/)、[`static/`](./_research/upstreams/aiclient2api/static/)、[`docker/`](./_research/upstreams/aiclient2api/docker/)。

## 3. sub2api

- 地址：https://github.com/Wei-Shaw/sub2api
- 默认分支：`main`
- 本地镜像：[`_research/upstreams/sub2api/`](./_research/upstreams/sub2api/)
- 采集 HEAD：`7634e3c23b5b9afc588c37b170820f63f1d41bbb`
- HEAD 提交：`chore: sync VERSION to 0.1.183 [skip ci]`
- 项目说明：面向订阅分发的 AI API 网关平台，负责 API Key、用户订阅、Token 级计费、账号调度、粘性会话、并发/速率限制、支付和管理后台；后端使用 Go，前端使用 Vue，数据层使用 PostgreSQL 与 Redis。
- 主要证据：[`README_CN.md`](./_research/upstreams/sub2api/README_CN.md)、[`backend/`](./_research/upstreams/sub2api/backend/)、[`frontend/`](./_research/upstreams/sub2api/frontend/)、[`deploy/`](./_research/upstreams/sub2api/deploy/)。

## 研究边界

- 上游仓库按执行时默认分支 HEAD 浅克隆；不会把上游代码合并进当前分支。
- 报告只引用源码、README、部署文件和测试结构，不把上游凭据、Cookie、Token 或生产配置复制到本项目。
- 当前分支已有大量定制能力，比较时以 `customized-branch` 的实际代码为准，而不是只以 README 判断缺口。
