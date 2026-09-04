## Step 1 - START - 2026-06-16T20:40:00+08:00
建立项目级 AGENTS 与 .plans 骨架，记录定制分支范围和用户已批准的实现口径。

## Step 1 - DONE - 2026-06-16T20:42:00+08:00
产物：AGENTS.md、.plans/current.md、.plans/status.json、.plans/summary.md、.plans/runlog.md、.plans/questions.md。
关键决策：sticky provider 支持会作为可配置能力加入，默认关闭，不改变观测优先策略。
验证：确认项目根此前没有 AGENTS.md / .plans，新文件创建成功。

## Step 2 - START - 2026-06-16T20:48:00+08:00
为 official usage 缓存 TTL 和刷新语义补 focused Jest 测试，先只写测试不改生产代码。

## Step 2 - DONE - 2026-06-16T20:55:00+08:00
产物：tests/usage-cache.test.js。
关键决策：默认 TTL 固定为 1 小时，测试使用可注入 now 保持稳定。
验证：首次运行 `npx.cmd jest tests/usage-cache.test.js --runInBand` 按预期失败在过期缓存仍被返回。

## Step 3 - START - 2026-06-16T20:55:00+08:00
实现 usage cache TTL 的最小代码，并调整内部缓存更新路径避免被 TTL 误拦截。

## Step 3 - DONE - 2026-06-16T20:57:00+08:00
产物：src/ui-modules/usage-cache.js、src/ui-modules/usage-api.js、tests/usage-cache.test.js。
关键决策：公开读取默认启用 TTL；内部需要修改缓存文件时显式传 `maxAgeMs: null`。
验证：`npx.cmd jest tests/usage-cache.test.js --runInBand` 通过，3 个测试全部通过。

## Step 4 - START - 2026-06-16T20:57:00+08:00
为 model-usage-stats 的账号、模型、日期维度和 cache hit ratio 写 focused 测试。

## Step 4 - DONE - 2026-06-16T21:02:00+08:00
产物：tests/model-usage-account-stats.test.js。
关键决策：账号元数据放在 account 对象顶层，summary 仅保留用量字段。
验证：首次运行 `npx.cmd jest tests/model-usage-account-stats.test.js --runInBand` 按预期失败，缺少 `cacheHitRatio` 和账号结构。

## Step 5 - START - 2026-06-16T21:02:00+08:00
扩展 model-usage-stats 存储结构，并把实际 provider uuid/name 从请求链路透传到插件 hook。

## Step 5 - DONE - 2026-06-16T21:08:00+08:00
产物：src/plugins/model-usage-stats/stats-manager.js、src/plugins/model-usage-stats/index.js、src/utils/common.js、src/services/api-manager.js。
关键决策：新增 `accounts`、`daily[date].models`、`daily[date].accounts`；图片接口 hook 顺序改为先记录 response usage 再 finalize。
验证：`npx.cmd jest tests/model-usage-account-stats.test.js --runInBand` 与 `npx.cmd jest tests/usage-cache.test.js --runInBand` 均通过。

## Step 6 - START - 2026-06-16T21:08:00+08:00
为 API Potluck 管理端 key 用量摘要和可选 Codex sticky provider affinity 写 focused 测试。

## Step 6 - DONE - 2026-06-16T21:17:00+08:00
产物：tests/provider-pool-affinity.test.js、tests/api-potluck-key-usage-summary.test.js。
关键决策：sticky provider 测试只覆盖 provider pool 选择逻辑；API Potluck 摘要测试聚焦 key 级 token/ratio 字段。
验证：两组测试首次运行均按预期失败，分别暴露没有固定 provider 和缺少 weekly/ratio 字段。

## Step 7 - START - 2026-06-16T21:17:00+08:00
实现 API Potluck key token-first 摘要、管理端排序/每日展示，以及 Codex sticky provider 可配置选择。

## Step 7 - DONE - 2026-06-16T21:24:00+08:00
产物：src/providers/provider-pool-manager.js、src/services/service-manager.js、src/plugins/api-potluck/key-manager.js、static/potluck.html、src/core/config-manager.js、configs/config.json.example。
关键决策：sticky provider 默认关闭，只有 `CODEX_POTLUCK_STICKY_PROVIDER_ENABLED` 开启且请求来自 API Potluck key 时才传入 affinity key；管理端默认按今日 Token 排序。
验证：`npx.cmd jest tests/provider-pool-affinity.test.js --runInBand`、`tests/api-potluck-key-usage-summary.test.js`、`tests/model-usage-account-stats.test.js`、`tests/usage-cache.test.js` 均通过。

## Step 8 - START - 2026-06-16T21:24:00+08:00
更新决策 HTML/docs，运行更广的测试与本地容器验证。

## Step 8 - PROGRESS - 2026-06-16T21:45:00+08:00
补齐 provider weight 本地能力并提交；更新决策 HTML 和缓存命中率调查文档，明确已完成/待完成范围。
验证：集中运行 9 个 Jest suite，共 23 个测试通过。

## Step 8 - DONE - 2026-06-16T21:45:00+08:00
产物：docs/yyn-customized-branch-plan.html、docs/yyn-codex-usage-cache-hit-investigation.md、测试镜像 aiclient2api:customized-branch-20260616、本地容器 aiclient2api-image2-test。
关键决策：普通日志邮箱脱敏作为本地定制能力补充提交；原始需求中更改路由/窗口的能力保留到下一批，不混入观测优先批次。
验证：集中运行 9 个 Jest suite，共 24 个测试通过；Docker 镜像构建成功；测试容器重启后 healthy；/health 返回 healthy；potluck.html 返回 200；启动日志邮箱已脱敏。

DECISION: 2026-07-22 OOM 止血继续复用现有 atomicWriteFile 与 usage ledger；现有工具只保证单文件原子替换，不能处理 dirty 版本、批量调度和优雅退出，因此新增最小持久化协调逻辑，而不引入数据库或第二套权威存储。
DECISION: 2026-07-29 Codex 容量/过载重试仅通过既有 ProviderPoolManager 重新选择；全部已尝试后解除 UUID 排除但不直接指定凭证，继续执行健康、模型、额度、冷却与并发筛选。
DECISION: 2026-08-06 Antigravity 继续复用现有 usage cache 与用量页；`fetchAvailableModels` 只能提供模型 5h quotaInfo，无法复用为 weekly 数据，因此新增 best-effort `retrieveUserQuotaSummary`，不引入第二套存储或改变账号路由。

## Potluck cache statistics repair - 2026-08-13T11:27:05.4931936+08:00
DECISION: Reuse the existing multi-worker control-process single-writer architecture and usage-ledger repair-report/apply framework; add one shared usage normalizer because the prior duplicated parsers caused the Responses cached-token field to be lost at the worker bridge.


## Codex Credential Groups - START - 2026-08-14T00:00:00+08:00
开始执行独立凭据组路由计划；先实现纯领域服务和 focused tests，再逐层接入 Key、Provider Pool 与 UI。

## Codex Credential Groups - Step 1 - START - 2026-08-13T19:46:09.1479758Z
先建立领域层行为测试；测试覆盖组数、容量、完整自然日需求、锁定项和路由决策，随后按红绿循环实现。

## Codex Credential Groups - Step 3 Audit Diagnostics - START - 2026-08-13T20:45:00+08:00
补齐 Service Manager 路由诊断到 runtime hook 与 request-audit 的严格白名单；持久化事件仅保存选中凭据 UUID 的单向哈希，不透传 affinity key、Token 或请求正文。

## Codex Credential Groups - Step 3 Audit Diagnostics - DONE - 2026-08-13T21:05:00+08:00
产物：src/services/service-manager.js、src/providers/openai/codex-credential-group-affinity.js、src/runtime/runtime-hook-bridge.js、src/plugins/request-audit/audit-event.js 及对应 focused tests。
关键决策：runtime hook 只传递固定路由诊断白名单；request-audit 对 selectedProviderUuid 使用单向哈希，并继续禁止 affinity key、Token、Cookie、原始 Key 与请求正文进入审计事件。
验证：4 个路由相关 suite 共 37 个测试通过；runtime-hook-bridge 5/5、request-audit-event 12/12 通过；node --check 与 git diff --check 通过。

## Codex Credential Groups - Step 2 Management API - START - 2026-08-14T08:30:00+08:00
继续实现凭据组管理 API；先覆盖 revision 元数据、preview/apply/rollback、脱敏视图和 Key 路由同步，再接入 OAuth/Provider 与 Potluck UI。

## Codex Credential Groups - Step 2 Management API - DONE - 2026-08-14T09:33:06+08:00
产物：src/plugins/api-potluck/api-routes.js、src/services/codex-credential-group-service.js、tests/api-potluck-credential-groups.test.js、tests/codex-credential-group-service.test.js。
关键决策：管理接口采用 preview → admin apply；以 baseRevision 做并发冲突保护，rollback 仅恢复当前 revision 的直接上一版本并生成新 revision；所有管理视图使用脱敏引用。
验证：管理 API 与领域服务测试通过；fixed/auto 路由及锁定项约束已覆盖。

## Codex Credential Groups - Step 4 OAuth/Provider UI and Potluck - DONE - 2026-08-14T09:33:06+08:00
产物：static/app/provider-manager.js、static/app/i18n.js、static/components/section-providers.css、static/components/section-providers.html、static/potluck.html、tests/codex-credential-group-ui-source.test.js。
关键决策：UI 展示 Key ↔ 凭据组 ↔ 脱敏凭据关系、路由模式、锁定状态、聚合用量和临时 spillover；apply/rollback 均需要管理员确认；前端 API 路径遵循 window.apiClient 的无 `/api` 约定。
验证：UI 源码测试 6/6 通过，内嵌脚本 vm.Script 检查通过。

## Codex Credential Groups - Final Verification - DONE - 2026-08-14T09:33:06+08:00
产物：docs/plans/2026-08-14-codex-credential-groups-routing-plan.md 及本次白名单范围内的实现与测试文件。
验证：6 个 Jest suite、65 个测试通过；4 个 JS 文件 node --check 通过；Potluck 内嵌脚本检查通过；git diff --check 通过。未执行真实浏览器截图或页面 smoke，未执行 git push。
环境记录：一次 PowerShell 传递正则的 node -e 命令因双重转义失败，改用单引号包裹的内存 vm.Script 检查成功；此前临时文件语法检查方式受本机策略拦截，未改用写盘绕过。
RETROSPECTIVE: No high-signal memory updates.

## Build stability optimization - 2026-08-27
产物：scripts/ops/build-image.sh、Dockerfile、docs/ops-backup-and-build.md、tests/ops-build-image-stability-source.test.js。
关键决策：增强现有构建入口，不新增重复脚本；构建失败只有限重试，不自动替换容器；保留 go mod tidy，避免 clean archive 缺少 go.sum 导致 sidecar 编译失败。
验证：构建稳定性与蓝绿源码测试 7/7 通过；`wsl sh -n scripts/ops/build-image.sh` 通过；`docker build --check AIClient-2-API` 通过。一次冷构建在约 5 分钟时仍卡在 Alpine 编译工具下载，已主动停止，未修改运行中容器。

## Build base image extension - 2026-08-27
产物：docker/Dockerfile.build-base、scripts/ops/build-base-image.sh、Dockerfile、docs/ops-backup-and-build.md。
关键决策：内部基础镜像作为可选路径，不强制替换官方基础镜像；应用 Dockerfile 通过 `NODE_BASE_IMAGE` 显式接入。
验证：构建源码测试 8/8 通过；两个 shell 脚本 `sh -n` 通过；`docker build --check .` 通过且无警告。

## Local Docker Desktop speed run - 2026-08-27
产物：outputs/local-container-speed-test-20260827.ps1（测速审计脚本）。
关键决策：本次使用现有镜像测量容器更新切换，不把未完成的冷基础镜像构建误算为成功；旧容器保留作回滚。
验证：候选健康预检 7 秒；完整切换 46.2 秒；新容器 healthy，`/health=200`，`/runtime/health=200`，restartCount=0；旧容器 `aiclient2api-speed-backup-20260827-181129` 保留。

## Potluck range data diagnosis and local fix - 2026-08-27
产物：src/plugins/api-potluck/api-routes.js、src/plugins/api-potluck/key-manager.js、static/potluck.html、tests/api-potluck-keys-compact-source.test.js。
关键决策：所有没有真实 ledger 覆盖的范围统一使用 usageHistory；列表摘要显式返回 weekly/cache ratio/cost；不恢复历史 reset-token 已清零数据。
验证：4 个相关 Jest 套件 58/58 通过；源码测试 7/7 通过；本地修复镜像 `aiclient2api:local-usage-range-fix-20260827` 已切换，health/runtime 均 200，容器 healthy。

## Production readonly backup - 2026-08-27
产物：`/root/backups/aiclient2api-configs/full-readonly-20260827-234151`。
关键决策：只备份一次；静态配置排除日志/request-audit；SQLite 先中止高写放大在线 backup，再短暂 pause 复制主库/WAL/SHM；坏的中断备份保留并标记 `.incomplete`。
验证：生产容器仍 running/healthy、restartCount=0；备份 SQLite `quick_check=ok`、history_rows=1700，目录约 2.3G、513 个文件。

## gpt-image-2 Capacity Hotfix - 2026-08-14T19:06:29+08:00
DECISION: 复用现有 BigObjectCapacity、RuntimeMetrics 与分块响应机制，不新增第二套限流器；累计 backpressureMs 仅保留观测用途，图片准入继续由 active byte budget、单 worker RSS 与 event-loop p95 控制，避免累计指标形成永久熔断。

## Codex quota fingerprint diagnosis - DONE - 2026-08-17T11:40:00+08:00
产物：docs/2026-08-17-codex-quota-fingerprint-diagnosis.md、docs/plans/2026-08-17-codex-usage-ceiling-snapshot-plan.md。
DECISION: 本轮只写诊断和观测计划，不改指纹默认、不改生产配置；观测计划另开是因为已确认部分号隐含周限塌缩，现有 usage cache 留不住历史。
验证：对照 prod-sync 2026-08-11、e2e 2026-08-14、live 2026-08-17 三份 usage-cache，以及 provider_pools / credential-groups；未跑 Jest，因为没有改代码。
## Step 9 - START - 2026-08-31T18:05:00+08:00
执行用户批准的 Codex quota filter 缓存优化计划：先补回归测试，再实现本地/共享快照、分层 TTL 与运行时指标。

## Step 9 - DONE - 2026-08-31T18:06:00+08:00
产物：src/providers/provider-pool-manager.js、src/services/api-server.js、tests/provider-pool-codex-quota.test.js。
关键决策：本地快照按候选 UUID、bucket、状态指纹和 usage timestamp 复用；共享快照作为跨 worker best-effort hydration；不缓存最终 provider 选择。
验证：5 个相关 Jest suite、65 个测试通过；Node 语法检查和 git diff --check 通过；全量 Jest 运行超过 90 秒无输出后停止，未计为通过。
边界修正：全池耗尽时不写普通空候选快照，继续保持 exhausted snapshot 的 429/fallback 语义。

## Antigravity selection p50 - DONE - 2026-09-04T11:45:00+08:00
产物：src/utils/context.js、src/providers/provider-pool-manager.js、src/services/service-manager.js、src/runtime/runtime-metrics.js、src/runtime/runtime-hook-bridge.js，以及对应 Jest。
DECISION: 不能复用 Codex hydrate 到 Antigravity，acquireSlot 每次 Redis GET/锁等待才是 p50≈667ms 的未计量残差；分段计时后跳过该路径，冷却未到期的模型不再每秒 lease。
验证：`npx.cmd jest tests/provider-pool- tests/antigravity- tests/runtime- --runInBand` 56 suites / 393 tests 通过。
