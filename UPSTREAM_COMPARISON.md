# 上游仓库对比与可参考优化项

## 结论摘要

本次对比基于以下固定快照：

- 本项目 `customized-branch`：`c3f83bc9ee09c884d49a6dbf4ebd7a9108e8a4ba`
- 本项目 `origin/main`：`c03d106ce6f68c3d0264373bc635e3506a9e6316`
- CLIProxyAPI：`1f53b2eb03b9e963bac647e5566ca2b304239116`
- AIClient2API upstream：`c03d106ce6f68c3d0264373bc635e3506a9e6316`
- sub2api：`7634e3c23b5b9afc588c37b170820f63f1d41bbb`

当前 `customized-branch` 已经明显覆盖或超出 3 个上游在“多协议转换、账号池、故障转移、Codex/Gemini 配额观测、请求审计、用量账本、图片接口、Redis 多 worker 协调、蓝绿部署和测试”方面的基础能力。因此最有价值的参考方向不是整仓迁移，而是吸收边界清晰、可独立验证的设计。

## 一、架构对比

### CLIProxyAPI：插件化 Go 内核

证据：[`go.mod`](./_research/upstreams/cliproxyapi/go.mod)、[`internal/pluginhost/`](./_research/upstreams/cliproxyapi/internal/pluginhost/)、[`examples/plugin/`](./_research/upstreams/cliproxyapi/examples/plugin/)、[`docs/sdk-usage.md`](./_research/upstreams/cliproxyapi/docs/sdk-usage.md)。

- 采用 Go 单体服务，内部按 auth、executor、translator、pluginhost、management API 等边界组织。
- 插件样例覆盖认证、请求/响应转换、生命周期、调度、usage、管理 API 等扩展点。
- 同时提供可复用 SDK，而不只提供一个固定启动入口。

判断：**值得参考，但不建议直接迁移运行时。** 当前项目已经有 provider adapter、plugin manager、service manager、runtime hook 和多 worker 协调；可借鉴的是“扩展点契约”和“插件生命周期/销毁语义”的文档化，而不是改写为 Go。

建议：

- 本项目落点：`src/core/plugin-manager.js`、`src/runtime/runtime-hook-bridge.js`、`docs/PROVIDER_ADAPTER_GUIDE.md`。
- 收益：降低新增 provider、审计、usage 插件时对核心服务的耦合。
- 复杂度：中。
- 风险：如果把插件扩展面扩大到请求热路径，可能破坏现有性能和隐私边界。
- 下一步验证：为插件注册、初始化失败、运行时 hook、销毁和重复加载补一组契约测试；不改变现有公开 API。

### sub2api：后台业务与网关运行时分层

证据：[`backend/`](./_research/upstreams/sub2api/backend/)、[`frontend/`](./_research/upstreams/sub2api/frontend/)、[`deploy/docker-compose.yml`](./_research/upstreams/sub2api/deploy/docker-compose.yml)、[`backend/ent/`](./_research/upstreams/sub2api/backend/ent/)。

- Go 后端、Vue 前端、PostgreSQL 持久化和 Redis 缓存/队列边界明确。
- 领域模型通过 Ent schema 生成，API Key、用户、凭据、支付和用量数据分离。
- Docker Compose 对数据库、缓存、应用和持久化卷有清晰拓扑。

判断：**部分值得参考，当前分支暂不适合整体引入。** 本项目目前是 Node.js + SQLite/文件账本/Redis 协调，已有多 worker 运行时；引入 PostgreSQL/Ent 会扩大部署和迁移面。

建议：

- 本项目可先参考领域边界和数据生命周期文档，不立即迁移数据库。
- 重点观察 API Key、usage ledger、reconciliation 和 provider state 是否需要更明确的存储接口。
- 下一步验证：为现有 `usage-event-store`、`usage-ledger`、`api-potluck` 抽象出存储契约，并以现有 SQLite/JSON 实现跑完整测试。

## 二、功能对比

### 协议、provider 与多模态

- CLIProxyAPI：OpenAI/Gemini/Claude/Codex/Grok 兼容接口、工具调用、多模态、WebSocket、多个 OAuth 账号。
- AIClient2API upstream：OpenAI/Claude/Gemini 三协议互转，覆盖 Gemini、Antigravity、Codex、Grok、Kiro，并提供图片生成与编辑接口。
- sub2api：更偏向 OpenAI/Anthropic 网关、订阅 Key、上游账号和计费；README 还明确说明 Antigravity 专用端点及上下文隔离。
- 本项目：已有多协议 converter/provider、账号池、模型 fallback、图片 generations/edits、多图片输入、Codex Responses 和 Antigravity/Gemini 图片能力。

判断：**本项目已覆盖主要能力。** 值得继续参考的是 provider 能力声明和不兼容条件的显式化，例如 sub2api 对 Anthropic 与 Antigravity 会话不能混用的警告，以及 CLIProxyAPI 的 provider compatibility / model capability 测试。

建议：

- 本项目落点：`src/providers/provider-models.js`、`src/providers/adapter.js`、`src/converters/strategies/`。
- 收益：让模型能力、协议限制、工具/图片兼容性和 fallback 条件从散落逻辑集中为可测试声明。
- 复杂度：中。
- 风险：能力声明与真实上游漂移时会误过滤模型。
- 下一步验证：新增 provider capability matrix 测试，覆盖工具、图片、stream、Responses、quota/fallback 组合。

### 账号池、路由和配额

- CLIProxyAPI：多账户轮询、OAuth 管理 API、配额查看、凭据并发保护和候选过滤后的公平轮换。
- AIClient2API upstream：provider pool、异步刷新、缓冲队列去重、全局并发控制、节点预热和自动过期检测。
- sub2api：API Key 分发、粘性会话、用户/账号并发限制、请求/Token 速率限制、计费熔断。
- 本项目：已有 provider pool、健康状态、quota cooldown、Codex credential group、sticky provider、prewarm、Redis lease、usage cache、usage ledger 和 Potluck key 路由。

判断：**本项目已覆盖核心调度能力；可参考两项细化。**

1. **候选过滤后的公平轮换**（CLIProxyAPI）
   - 状态：值得参考。
   - 本项目落点：`src/providers/provider-pool-manager.js`、Codex 路由/credential group 逻辑。
   - 收益：避免模型过滤、健康筛选或 quota 排除后轮询指针偏斜。
   - 复杂度：中。
   - 验证：构造候选集动态缩小、恢复和多 worker 并发场景，检查选择分布与 cooldown 语义。

2. **用户级并发与 Token 速率限制契约**（sub2api）
   - 状态：需要单独验证。
   - 本项目当前重点是 provider/credential 容量和 Potluck 用量，而不是完整的用户级限流产品。
   - 本项目落点：`src/plugins/api-potluck/`、`src/runtime/runtime-backpressure.js`。
   - 风险：直接引入会影响现有 key 路由、流式请求和 usage 记账语义。
   - 验证：先做只读容量估算与拒绝原因指标，不改变默认限流行为。

### 用量、计费和后台

- CLIProxyAPI 当前 README 明确表示内置 usage statistics 已移出核心，依赖外部 usage 工具。
- sub2api 把 Token 级计费、支付、订阅、用户余额和管理后台作为核心产品能力。
- 本项目已经有 request-audit、model usage stats、API Potluck、usage ledger、成本估算、reconciliation 和缓存命中率。

判断：**本项目在观测和审计上更贴合当前目标；不建议引入支付/订阅域。** sub2api 的余额、支付和用户产品模型仅在未来明确运营化时再评估。

## 三、运维对比

### 部署与健康检查

- CLIProxyAPI：单 Go 镜像，带版本/commit/build date 注入；Compose 挂载配置、认证、日志和插件，另有 cluster 模式。
- AIClient2API upstream：Node 20 + TLS sidecar，多端口 OAuth 回调，Docker healthcheck 直接访问 `/health`。
- sub2api：前端构建、Go 后端构建和最终镜像分层，Compose 内置 PostgreSQL/Redis、持久化卷、`no-new-privileges` 和高文件句柄限制。
- 本项目：已有 Docker healthcheck、TLS sidecar、多 worker、Redis 协调、构建脚本、备份、蓝绿部署和容器 smoke。

判断：**值得参考两项运维细节。**

- CLIProxyAPI 的构建元数据注入可用于强化本项目镜像可追溯性；本项目落点为 `Dockerfile` 和 `scripts/ops/build-image.sh`。
- sub2api 的 Compose 安全默认值（`no-new-privileges`、显式连接池参数、持久卷）可作为部署清单审查项；不直接复制其数据库拓扑。

### 配置和初始化

- CLIProxyAPI 使用集中式 YAML，显式区分 API key、认证目录、插件、日志、usage 和 routing 配置。
- AIClient2API 使用 `configs/` 目录和 Web UI 动态配置。
- sub2api 支持首次启动自动生成配置，并把数据库、Redis、管理员、JWT 和支付配置分区。
- 本项目已经有 config manager、配置同步、provider pool 配置、UI 管理和多 worker 持久化确认。

判断：**本项目已具备主要能力；可参考“配置分区 + 启动前校验”的表达方式。** 建议将数据库/Redis/运行时协调/敏感凭据/业务 Key 的启动前检查集中到部署文档和 preflight，而不是新增自动改配置行为。

## 四、工程质量与安全

### 测试结构

- CLIProxyAPI 快照包含大量 Go 单元/集成测试，尤其覆盖 auth、quota、router、pluginhost、credential concurrency 和 management API。
- sub2api 同时维护 Go 后端测试和 Vue/Vitest/typecheck/lint 测试，并列出关键前端回归集合。
- AIClient2API upstream 的测试数量明显少于当前定制分支；其价值更多在功能演进和文档，不在测试体系迁移。
- 本项目当前已有大量 provider、runtime、audit、ledger、UI source contract 和图片接口测试。

判断：**值得参考测试分类与关键回归清单，不需要替换 Jest 体系。**

建议：

- 为 provider pool、credential group、runtime coordination、usage ledger 建立“关键回归集合”入口，类似 sub2api 的 critical frontend tests。
- 参考 CLIProxyAPI 的 concurrency fixture，把候选过滤、凭据锁、worker refresh fencing 纳入固定回归集。
- 复杂度：低到中；风险低。

### 敏感信息扫描

本次只读扫描结果：3 个镜像均未发现常见 `sk-*`、GitHub token、AWS access key、JWT 三段式或私钥头等明显模式。文件名扫描命中了大量 OAuth、token、api key 和示例配置路径，这是代码领域命名，不等同于泄露。

边界：本扫描不替代依赖漏洞扫描，也不读取当前项目真实配置、Cookie、OAuth state 或未跟踪凭据。

## 五、建议优先级

### P1：先做低风险、可独立验证

1. provider capability matrix：集中表达协议、工具、图片、stream、Responses、quota/fallback 兼容性。
2. provider pool 公平轮换回归：覆盖候选过滤、恢复、cooldown、sticky 和多 worker。
3. 插件生命周期契约测试：初始化失败、重复加载、热卸载、销毁和运行时 hook。
4. 构建元数据与 Compose 安全默认值检查：增强镜像追溯和部署前审查。

### P2：需要产品/运行时决策

1. 用户级并发和 Token 速率限制：先做观测和 dry-run，再决定是否改变默认拒绝行为。
2. 更强的持久化存储抽象：先为现有 SQLite/JSON/Redis 实现统一接口，再评估 PostgreSQL。

### 暂不建议

- 将 sub2api 的支付、余额、订阅和完整用户后台引入当前分支。
- 将 CLIProxyAPI 的 Go 运行时整体迁移到本项目。
- 直接复制上游配置或认证文件。

## 研究限制

- 本报告是基于默认分支单次浅克隆的静态比较，不包含真实上游请求压测、浏览器 OAuth 流程、支付流程或生产部署验证。
- 上游默认分支会继续变化；如进入实现阶段，应先重新读取 HEAD，并针对选中的候选项做最小复现测试。

## 六、近期 Codex 风控/稳定性复核（2026-08-11 至 2026-08-25）

本节以本项目 `customized-branch` 的固定基线 `c3f83bc9ee09c884d49a6dbf4ebd7a9108e8a4ba` 复核上游近期变化，不推断 OpenAI 内部风控规则，也不包含身份改写或配额规避行为。

### 已覆盖，不重复移植

| 上游语义 | 本项目证据 | 结论 |
| --- | --- | --- |
| 5h/7d 窗口按语义识别并在 100% 时过滤 | `src/utils/codex-rate-limit.js`、`src/providers/provider-pool-manager.js`、`tests/codex-rate-limit-normalizer.test.js`、`tests/provider-pool-codex-quota.test.js` | 已覆盖；按窗口 duration/语义识别，默认上限为 100%。 |
| `session-id` 优先、兼容 `session_id`，出站只保留 canonical `Session-Id` | `src/providers/openai/codex-core.js`、`tests/codex-quality-gates.test.js`、`tests/codex-fingerprint-request.test.js` | 已覆盖；保持当前转发行为，不新增身份改写。 |
| quota observation 与 scheduler/rate-limit cooldown 分离 | `src/providers/provider-pool-manager.js` 中的 `codexQuotaHealth` 与 `codexRateLimitCooldown` 两套状态 | 已覆盖；本轮没有直接移植 CLIProxyAPI WebSocket 事件。 |
| Codex HTTP/SSE stream bootstrap 与 terminal error 解析 | `src/providers/openai/codex-core.js`、`tests/codex-terminal-errors.test.js` | 已覆盖；CLIProxyAPI 的 WebSocket 实现不适用于当前主路径。 |

### 已发现缺口并修复

#### Codex 配额耗尽的 reset 驱动暂停

- 上游参考：CLIProxyAPI `ca601db0` 的 quota observation/retry header 隔离；sub2api `f1aadd48` 的 5h/7d quota exhausted 与 transient 429 分离。
- 缺口：原实现只有在 `RATE_LIMIT_COOLDOWN_ENABLED=true` 时才把 `usage_limit_reached` 写入 Codex quota bucket；默认配置下，带 reset 的配额耗尽可能只触发本次请求换凭证，账号不会持续暂停到 reset。
- 修复：`src/providers/openai/codex-core.js` 将 `insufficient_quota` 归入可重试 quota 错误；`src/utils/common.js` 在识别到 Codex quota exhaustion 且存在 reset 证据时，即使通用 429 cooldown 关闭，也写入对应 `codexQuotaHealth` 直到 upstream reset。没有 quota/reset 证据的普通 429 仍走原有瞬时 cooldown/重试策略。
- 回归：`tests/codex-terminal-errors.test.js`、`tests/codex-rate-limit-cooldown.test.js`。

#### Prewarm 默认行为

- 决策：`CODEX_PREWARM_ENABLED` 默认改为 `false`，只有显式 opt-in 才调度；weekly-only/无明确短窗口账号继续跳过。
- 落点：`src/core/config-manager.js`、`src/services/codex-prewarm-service.js`、`tests/codex-prewarm-service.test.js`。
- 文档：`docs/yyn-customized-branch-features.md`、`docs/yyn-codex-usage-cache-hit-investigation.md`。

### 仅需观察，不新增复杂机制

- **每次重试的响应头隔离**：当前 Codex 请求循环中每次 axios attempt 都在局部创建 request/response 变量，路由状态不读取上一 attempt 的响应头；没有发现共享 response-header holder 导致的污染证据，因此本轮只保留测试与审计，不引入额外 holder 抽象。
- **候选过滤后的公平轮换**：现有 provider pool 已按候选集、last-used/selection sequence 和 sticky/cooldown 状态选择；后续可继续补多 worker 分布回归，但不属于本轮 Codex 风控必需修复。
- **session/fingerprint 审计**：保留脱敏 fingerprint audit 和 canonical 出站 header，暂不改变身份来源或覆盖顺序。

### 不适用于当前架构

- CLIProxyAPI 的 `codex.rate_limits` WebSocket 事件接收与 WebSocket transport failover：当前项目 Codex 主路径为 HTTP/SSE，直接移植会扩大协议面，暂不实施。
- sub2api 的订阅、支付、余额和完整用户级计费限流域：与本轮防御性兼容目标无关，暂不实施。
