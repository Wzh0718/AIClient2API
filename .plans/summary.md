[step-1 | 2026-06-16T20:42:00+08:00] ✓ 建立项目级工作流骨架并记录定制分支边界
keep: 定制分支默认观测优先；sticky provider 做可配置能力且默认关闭。
[step-2 | 2026-06-16T20:55:00+08:00] ✓ 为 official usage cache 增加 1 小时 TTL 失败测试
[step-3 | 2026-06-16T20:57:00+08:00] ✓ 实现 usage cache 1 小时 TTL，并保留内部无 TTL 读取路径
keep: `refresh=true` 继续绕过缓存；`readUsageCache({ maxAgeMs: null })` 仅用于缓存内部更新。
[step-4 | 2026-06-16T21:02:00+08:00] ✓ 为 Codex 账号、模型、日期统计和 cache hit ratio 增加失败测试
[step-5 | 2026-06-16T21:08:00+08:00] ✓ 实现 model-usage-stats 账号维度、日期模型维度与 provider 元信息透传
keep: stats 新增 `accounts` 与 `daily[date].models/accounts`；usage block 返回 `cacheHitRatio`，不保存原始 prompt。
[step-6 | 2026-06-16T21:17:00+08:00] ✓ 为 API Potluck key usage summary 和 Codex sticky provider 增加失败测试
[step-7 | 2026-06-16T21:24:00+08:00] ✓ 实现 Potluck token-first 管理视图摘要与可选 Codex sticky provider
keep: `CODEX_POTLUCK_STICKY_PROVIDER_ENABLED=false` 为默认；开启后仅 Codex provider 使用同 key affinity。
[step-8 | 2026-06-16T21:45:00+08:00] ✓ 更新文档，完成集中测试和本地容器 smoke
keep: 原始需求中的 Codex token 配额过滤、早晨预热和官方 `/usage` 字段展示留作下一批。

[credential-groups | 2026-08-14T00:00:00+08:00] ⏳ 开始执行 Codex OAuth 凭据组与 Potluck Key 路由计划
[credential-groups-step-3 | 2026-08-13T21:05:00+08:00] ✓ 完成 Service Manager 路由诊断及审计链路白名单透传
keep: 审计只保存 selectedProviderUuidHash；routingMode、组 ID、spillover 和 assignmentMissing 可诊断，但不保存原始凭据 UUID、affinity key、Token、Cookie、原始 Key 或请求正文。
[credential-groups-step-2 | 2026-08-14T09:33:06+08:00] ✓ 完成凭据组管理 API、preview/apply/revision/rollback 与 Key 路由同步
keep: apply 必须基于未过期 preview 和匹配的 baseRevision；rollback 只恢复直接上一版本并生成新 revision。
[credential-groups-step-4 | 2026-08-14T09:33:06+08:00] ✓ 完成 OAuth/Provider 管理页与 Potluck Key ↔ 凭据组关系摘要 UI
keep: UI 和管理输出只使用脱敏凭据引用，不显示 Token、Cookie、原始 API Key 或原始凭据 UUID。
[credential-groups-final | 2026-08-14T09:33:06+08:00] ✓ 完成最终验证：6 个 suite、65 个测试及语法/diff 检查通过
keep: 未执行真实浏览器截图或页面 smoke；未执行 git push。
[quota-fingerprint-diagnosis | 2026-08-17T11:40:00+08:00] ✓ 完成额度/指纹只读诊断，并另开隐含周限快照观测计划
keep: 13/13 账号 session+migrated；部分号隐含周限从约 8B 落到 1–2B，部分号没有；不改指纹默认。
[ops-memory | 2026-08-27] Docker 构建代理固定使用 `http://192.168.4.242:7890`；不要再使用旧地址或 `http://host.docker.internal:7890`。该规则仅适用于 AIClient-2-API 项目的镜像构建，不改变应用运行时代理配置。
[ops-memory | 2026-08-27-build-latency] 最近一周镜像打包/本地容器更新复盘：超过 3 分钟的主要耗时来自依赖阶段而非容器切换。`build-image.sh` 每次从 `git archive` 创建全新上下文，Dockerfile 随后重复执行 Go sidecar 的 `go mod download/tidy`、Node 原生依赖编译和 `npm install`；构建代理未显式传入或 registry/上游网络抖动时，会出现 Go 下载失败、npm install 长时间无输出。此前多次会话还把在线 SQLite/日志备份混入发布链路，导致额外分钟级延迟和失败重试；蓝绿候选预检本身通常不是主要瓶颈。
keep: 构建与发布分层计时；依赖下载失败不得静默放行；候选预检只复制必要配置并排除 `request-audit/`、`app-logs/`、`runtime-hook-spool/` 和活跃历史数据库；生产切换前完成备份策略确认，避免在线大库复制阻塞发布。
next: 评估新增项目级 `scripts/ops/reliable-build-image.sh`（或增强现有 `build-image.sh`）：固定/校验构建代理，启用 BuildKit cache mount，记录 export/dependency/build/load 各阶段耗时，依赖下载设置有限重试与超时，失败时保留诊断摘要；脚本只负责可追溯镜像构建，不自动替换容器。目标是把正常增量构建控制在 1–2 分钟，并让网络失败快速、可解释地退出。
[ops-memory | 2026-08-27-build-stability-implemented] 已增强现有 `build-image.sh` 与 Dockerfile：默认项目构建代理、BuildKit Go/npm cache、有限重试、阶段耗时输出；保留 `go mod tidy` 以兼容 clean archive 的缺失 checksum，并移除会触发 Docker Hub frontend 拉取的 syntax 声明。冷构建仍可能受 Alpine 包下载影响，后续构建依赖层可复用。
[ops-memory | 2026-08-27-build-base] 构建代理已切换为 `http://192.168.4.242:7890`。新增可选 `docker/Dockerfile.build-base` 与 `scripts/ops/build-base-image.sh`，可预装 `git/tar/procps/python3/make/g++` 并通过 `NODE_BASE_IMAGE` 接入应用构建；默认仍使用 `node:20-alpine`，避免新机器因缺少内部镜像无法构建。内部基础镜像主要优化冷构建/缓存丢失场景，需在 Node/Alpine 安全更新时定期重建。
[ops-memory | 2026-08-27-build-base-attempt] Windows Docker Desktop 冷构建内部基础镜像时，代理连通性正常，但 Alpine 编译工具包下载在约 5 分钟内无足够进展，已停止，当前未生成 `aiclient2api:node20-alpine-build-base`。小写/大写代理环境变量均已加入 Dockerfile，后续可在网络更稳定时重试。
[ops-memory | 2026-08-27-build-base-resolved] 切换 Alpine 镜像源到 `mirrors.aliyun.com` 后，Windows Docker Desktop 内部基础镜像成功构建，耗时约 92.9 秒；镜像不再持久化构建代理环境变量。使用该基础镜像构建最新 custom 提交耗时约 105 秒，npm 约 5 秒、Go sidecar 约 1 秒。
[ops-memory | 2026-08-27-custom-local-verify] 使用本地 `customized-branch` 最新提交 `1b6cc69` 完成真实构建与容器更新：镜像构建约 105 秒，候选健康约 6.8 秒，正式切换约 15.5 秒；新容器 healthy，health/runtime 均 200，旧容器保留回滚。
[ops-memory | 2026-08-27-prod-release-blocked] 生产发布执行到 SSH 只读预检阶段被阻断：`47.77.184.27` TCP/SSH 握手正常，但 root 密码提交后连续两次被服务器主动关闭连接；未执行生产构建、备份、停容器或切换。恢复 SSH 后从只读预检续接。
[ops-memory | 2026-08-27-potluck-range-data-fix] 本机 Potluck Key 列表问题已定位并修复：列表摘要遗漏 weekly/cache ratio/cost 字段；无 ledger 时 7d/today/total 范围错误依赖缺失摘要字段；custom 范围无 ledger 时未遍历 usageHistory。修复后所有非 ledger 范围统一回退 usageHistory，Key summary 生成 weekly/cache/cost 字段。历史已被旧 reset-token 逻辑清零的 Token 不恢复。
[ops-memory | 2026-08-27-prod-backup] 生产一次性只读备份已完成，路径 `/root/backups/aiclient2api-configs/full-readonly-20260827-234151`；包含配置、凭据、账本和 SQLite，排除日志/request-audit。SQLite 主库约 1.8G，`quick_check=ok`，生产容器保持 `running|healthy`、restartCount=0。早先被中断的坏备份保留为 `.incomplete` 审计证据，不作为恢复源。
[ops-memory | 2026-08-27-local-cutover-speed] 使用现有健康镜像完成一次真实本地更新流程：候选容器健康预检约 7 秒，停旧/重建同名容器/health/runtime 验证总计约 46.2 秒；新容器 healthy、`/health=200`、`/runtime/health=200`、重启次数 0，旧容器保留为时间戳备份。该耗时不包含镜像冷构建。
[ops-memory | 2026-08-28-candidate-is-not-cutover]
明确要求“更新本地/生产容器”时，候选容器启动与健康检查只是中间预检，不能作为最终完成条件；必须继续切换正式容器/正式 upstream，并验证 active container 的镜像 commit。只有用户明确要求“只验证/只预检/候选 smoke”时才允许停在候选。此前将本地更新误停在候选容器，原因是把生产 blue-green 安全规则过度套用到本地；以后按本地与生产分别执行最终切换。
