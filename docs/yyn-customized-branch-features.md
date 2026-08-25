# AIClient2API 定制化分支额外功能清单

最后更新：2026-06-17

本文记录 `yyn/customized-branch` 相较于 `origin/main` 的额外功能、配置项和部署注意事项。这个分支是长期定制分支，后续本地或云端特殊功能默认继续合入这里，再按需从 `main` 合并上游更新。

## 分支边界

- 基线分支：`origin/main`
- 定制分支：`yyn/customized-branch`
- 当前用途：保留上游主分支能力，并叠加 Codex 用量观测、额度预热、API Potluck token 统计、provider 调度、代理配置、日志脱敏和图片接口增强等本地定制能力。
- 不包含：真实密钥、OAuth token、cookie、生产配置原文、账号密码或云端私有挂载内容。

## 额外功能

### Codex 用量与 token 观测

- 官方 Codex usage 查询支持 1 小时默认缓存，前端手动刷新或 `refresh=true` 会绕过缓存。
- 用量查询页可查看 Codex 账号的通用 5h/周额度，以及 `GPT-5.3-Codex-Spark` 的 5h/周额度。
- 接入 Codex CLI 同源 usage profile，展示 daily、weekly、lifetime token 统计。
- token 展示统一按数量动态换算：小于 1000 显示原始整数，达到 1000 显示 `k`，达到 100 万显示 `M`，达到 10 亿显示 `B`，带单位保留 2 位小数。
- 已确认官方 `daily_usage_buckets` 可能滞后，查询当天 token 为 0 不一定代表账号当天没有使用。

### Codex 额度控制与预热

- provider 配置中支持 Codex 5h/周用量百分比阈值，用官方剩余额度判断是否跳过账号。
- 移除了前端绝对 token 上限输入，后端保留旧字段兼容历史配置。
- 新增 Codex 预热服务：默认关闭；只有显式设置 `CODEX_PREWARM_ENABLED=true` 后，才会在 `06:30` 和 `11:30` 对符合条件的 Codex 账号触发轻量请求，每个窗口默认 2 次。
- 预热用于提前启动 5 小时额度窗口，会消耗少量请求和 token；没有明确短窗口/5h quota 的账号会被跳过。

### API Potluck 分发 key 统计

- API Potluck 管理页支持查看分发 key 的今日、本周、累计 token。
- 支持最近 7 天每日 token 和缓存命中率展示。
- 排序逻辑偏向 token 用量，不再只按请求次数判断使用规模。
- `potluck.html` 和 `potluck-user.html` 的 token 数字展示使用同一套动态单位。
- 可选启用 sticky provider：同一个 API Potluck 分发 key 的后续 Codex 请求尽量走同一个健康 provider，以提高同账号缓存复用概率。

### Provider 调度与健康状态

- Provider pool 支持 provider weight，用于影响账号或 provider 的调度权重。
- Codex provider 认证失败时会被标记为不健康，避免继续分发到明显不可用账号。
- Provider 维度 usage block 会带出 cache hit ratio、provider UUID 等统计信息。

### 模型用量统计插件

- `model-usage-stats` 增加账号、provider UUID、模型、日期维度。
- 统计中包含 cache hit ratio，方便排查 token 相近但额度消耗变快的问题。
- 统计只保存必要聚合信息，不保存原始 prompt。

### 代理配置管理

- 配置管理页支持维护代理相关配置，不需要写死到代码。
- 代理可按 provider 类型启用，当前主要用于 `openai-codex-oauth` 访问 OpenAI。
- 本地容器可使用宿主机代理；云端部署时必须按云服务器实际网络重新配置，不能直接复用本机局域网代理地址。

### 日志脱敏与保留

- 新增日志脱敏工具，避免日志中直接输出敏感 token、Authorization、Cookie 等内容。
- 日志保留策略有测试覆盖，降低长期运行时日志无限增长风险。
- AI Monitor 相关日志统计和脱敏能力在该分支保留。

### 图片接口增强

- 保留图片接口增强能力，包括多图片输入、multipart image edits 和 Codex 图片质量相关处理。
- 图片增强相关路径有独立测试覆盖。

### 请求体限制与上游能力保留

- 定制分支已经合并过较新的 `main`，主分支已有的请求体限制等能力应继续保留。
- 后续从 `main` 合并时，需要确认定制分支里的配置管理、provider pool、usage 展示和 potluck 页面没有被覆盖回退。

## 关键配置项

- `CODEX_PREWARM_ENABLED`：是否启用 Codex 预热，默认 `false`，显式设置为 `true` 才会发送预热请求。
- `CODEX_PREWARM_TIMES`：预热时间列表，例如 `06:30,11:30`。
- `CODEX_PREWARM_ATTEMPTS`：每个预热窗口触发次数。
- `CODEX_PREWARM_TIMEZONE`：预热时区。
- `CODEX_PREWARM_MODEL`：预热请求使用的模型。
- `CODEX_POTLUCK_STICKY_PROVIDER_ENABLED`：是否启用 API Potluck 同 key 固定 Codex provider。
- `PROXY_URL`：出站代理地址。
- `PROXY_ENABLED_PROVIDERS`：启用代理的 provider 类型列表。
- `WARMUP_TARGET`：系统预热目标节点数。
- `REFRESH_CONCURRENCY_PER_PROVIDER`：提供商内刷新并发数。
- `providerWeight`：provider 调度权重。
- `codexMax5hPercent`：Codex 5h 用量百分比阈值。
- `codexMaxWeeklyPercent`：Codex 周用量百分比阈值。

## 云端部署注意事项

- 不要覆盖云端真实 `configs/`、`logs/`、`plugins/` 挂载目录。
- 更新容器前先备份云端配置文件，尤其是 `configs/config.json` 和环境变量。
- 云服务器代理必须单独确认。不要直接使用本机的 `127.0.0.1:7890` 或局域网代理地址，除非云端确实能访问。
- 预热默认关闭；显式启用前确认所有符合条件的 Codex 账号都接受该行为，因为它会消耗少量请求和 token。
- sticky provider 默认应按配置决定是否启用；如果更关注缓存命中率，可以开启并观察 provider 健康状态。
- 真实 smoke 时不要打印完整 API key、OAuth token、cookie、Authorization 头或原始请求体。

### 多 worker 配置同步与蓝绿运维

- 生产默认是 1 个 control worker + 3 个 execution worker；control worker 是 `provider_pools.json` 的唯一写入者。
- Provider 编辑、启用/禁用、删除、刷新 UUID、Codex 重新授权和配置重载必须通过 revisioned `provider_config_sync` 广播，不能直接给 manager 赋值后返回成功。
- 候选发布使用 `scripts/ops/build-image.sh` 构建可追溯镜像，再用 `scripts/ops/blue-green-deploy.sh` 做 dry-run/prepare/render 预检。
- 现有脚本是“候选预热 + 单写者人工交接”，不是自动严格双活；正式切换仍需暂停管理写操作和 OAuth，并人工执行 Nginx upstream 切换/回滚。
- 切换前必须确认 `/runtime/health` 的 provider config revision 已在所有 execution worker 收敛，`pendingWorkerCount=0`；不要直接重启正在写挂载配置的 active 容器。

## 验证记录

最近一次本地验证：

- `npx.cmd jest --runInBand --testPathIgnorePatterns=tests/api-integration.test.js`
- `git diff --check origin/main..HEAD`
- 本地测试容器 `aiclient2api-image2-test` 已运行并通过 health smoke。

已知例外：

- `tests/api-integration.test.js` 依赖真实服务和有效测试 key，本地默认 `TEST_API_KEY=123456` 会返回 401，因此集中测试时需要排除或显式提供有效测试环境。
