# Codex Usage Cache and Cache Hit Investigation

更新时间：2026-06-16 23:25 +08:00

## 目标

在定制化分支中新增两类能力，并先验证“美国号池缓存命中率低导致额度消耗变快”的假设。

1. 官方 Codex usage 查询缓存默认 1 小时，避免频繁打官方 usage 接口。
2. 用量查询页支持手动刷新官方 usage，绕过缓存拉取最新值。
3. 排查美国号池近期额度消耗偏快是否和缓存命中率下降有关。

## 已确认口径

- 用户关心 token 和额度窗口，不把请求次数作为剩余额度判断依据。
- 官方 usage 缓存 TTL 默认使用 1 小时。
- 用量查询页已有手动刷新入口，后端已有 `refresh=true` 绕过缓存能力；定制分支需要补齐 TTL 过期判断，并明确刷新按钮会强制拉新。
- 排查对象是美国号池，验证阶段只做只读日志/统计检查，不持久化服务器凭据。

## 排查假设

### H1: prompt cache 命中率下降

现象：总 token 与之前相近甚至更少，但额度消耗更快。若 cached token 占比从 50% 以上明显下降，则同等 total token 下实际计费/额度消耗可能更高。

证据：

- 最近 24 小时 / 7 天的 `cachedTokens`、`promptTokens`、`totalTokens`。
- 按 Codex 账号、模型、入口和请求类型拆分的 cache hit ratio。
- 最近改动前后的 cache hit ratio 对比。

### H2: 请求形态变化导致缓存失效

可能来源：

- 转换后的 prompt、system、tools、metadata、image tool options 或 message 顺序变化。
- 每次请求注入了动态字段，导致上游无法命中缓存。
- 不同账号/节点/地区/模型路由分散，降低同一前缀复用。

证据：

- AI Monitor 日志中转换前后 payload 摘要。
- 最近变更中 `api-manager.js`、`codex-core.js`、converter、provider pool 的改动。
- 相同任务是否被路由到不同账号或不同模型别名。

### H3: 官方 usage 与本地 token 统计口径不一致

可能来源：

- 本地统计记录 total token，但官方 usage 按不同窗口、不同计费 token 或 uncached token 口径扣减。
- 官方 usage 刷新延迟或缓存导致短时间判断偏差。

证据：

- 官方 usage 接口字段和时间戳。
- 本地 model-usage-stats / API Potluck token 统计。
- 同一时间窗口内的官方 usage delta 与本地 token delta。

## 验证步骤

1. 本地代码检查
   - 查当前 token 捕获链路是否记录 `cachedTokens`。
   - 查 Codex 路由是否能透传 provider uuid。
   - 查最近图片、日志、请求体、provider weight 改动是否可能改变 Codex 文本请求 payload。

2. 美国号池只读检查
   - 查看运行服务版本、容器、配置和日志目录。
   - 抽取最近 24 小时和 7 天 usage 统计，不输出密钥或原始请求正文。
   - 聚合 cache hit ratio：`cachedTokens / promptTokens`，并按账号、模型、日期拆分。

3. 对比和判断
   - 若 cache hit ratio 明显低于历史 50% 基线，继续追 payload 变化或路由分散。
   - 若 cache hit ratio 正常，转查官方 usage 口径、账号窗口、模型变化或额度侧策略变化。
   - 若统计缺失 cached token，则先把“缓存命中率观测”加入定制分支方案。

## 方案更新条件

需要更新定制化分支方案的情况：

- 本地统计没有按 Codex 账号记录 cached token。
- 用量查询页需要展示 cache hit ratio。
- provider pool 需要按缓存命中率辅助诊断或过滤。
- AI Monitor 需要输出可比较的 payload 指纹，但不能泄露 prompt 或图片原文。

无需更新方案的情况：

- 缓存命中率正常，问题来自官方 usage 口径或外部额度策略。
- 问题只发生在远端部署配置，与定制分支代码无关。

## 人工确认门槛

验证完成后先给出证据表和判断，不直接改业务实现。需要用户确认后再进入实现：

- 是否把 cache hit ratio 加入 Codex 账号用量页。
- 是否把 payload 指纹诊断做成默认能力还是仅调试开关。
- 是否对美国号池做账号/模型/路由策略调整。

## 验证结果

时间：2026-06-16 20:12 +08:00

### 本地代码

- `model-usage-stats` 已能捕获 `cachedTokens`，覆盖 `cached_tokens`、`prompt_tokens_details.cached_tokens`、`input_tokens_details.cached_tokens`、`cache_read_input_tokens`、`cachedContentTokenCount` 等字段。
- 本地统计目前主要按 provider/model/date 聚合，缺 Codex provider uuid / 账号维度，因此不能直接回答“某个 Codex 账号缓存命中率是多少”。
- `usage-api` 已支持 `refresh=true`，前端用量页已有刷新按钮；当前缺陷是缓存没有 TTL，只要 `usage-cache.json` 存在就会一直返回缓存。

### 本地测试容器数据

- `docker-data/configs/model-usage-stats.json` 最后更新时间为 2026-06-09 00:53 左右，不能代表今天美国号池。
- 该本地统计总览：13 次请求，prompt token 49,235，cached token 34,944，cache hit ratio 70.97%。
- 按模型：`gpt-5.4` 命中率 73.88%，`gpt-5.5` 命中率 65.20%。
- 最近日志样本 8 条：prompt token 34,218，cached token 21,504，命中率 62.84%。

结论：本地旧数据没有复现“缓存命中率低”，并且命中率高于 50% 基线。要验证今天美国号池，需要远端只读统计。

### 美国号池远端验证

验证动作：

- 只读连接远端服务器。
- 只读检查运行容器、配置挂载、统计文件和容器日志。
- 不输出真实账号、OAuth 文件内容、API key、access token、cookie、原始 prompt 或原始响应正文。
- 账号只用 `accountHash` 脱敏展示。

远端服务状态：

- 运行 1 个 `aiclient2api` 容器。
- 容器镜像名显示为 `image2-log-sanitized-quality-20260612-remote`。
- 统计文件更新时间为 `2026-06-16T12:00:58.350Z`。

全量统计：

- 请求数：711,639。
- prompt tokens：22,311,393,230。
- cached tokens：7,922,513,493。
- total tokens：22,714,802,101。
- 全量 cache hit ratio：35.51%。

近期每日趋势：

| 日期 | prompt tokens | cached tokens | total tokens | cache hit ratio |
| --- | ---: | ---: | ---: | ---: |
| 2026-06-01 | 668,704,586 | 343,746,064 | 686,589,667 | 51.40% |
| 2026-06-02 | 801,137,157 | 440,523,726 | 822,457,170 | 54.99% |
| 2026-06-03 | 960,205,235 | 528,141,057 | 991,183,345 | 55.00% |
| 2026-06-04 | 862,928,995 | 439,032,732 | 895,934,219 | 50.88% |
| 2026-06-05 | 646,851,672 | 277,207,206 | 673,598,314 | 42.85% |
| 2026-06-06 | 603,147,891 | 331,283,712 | 685,677,832 | 54.93% |
| 2026-06-07 | 229,826,887 | 51,743,488 | 231,231,044 | 22.51% |
| 2026-06-08 | 705,249,180 | 228,370,177 | 712,567,431 | 32.38% |
| 2026-06-09 | 917,479,663 | 405,714,920 | 931,997,420 | 44.22% |
| 2026-06-10 | 1,119,087,833 | 472,969,337 | 1,136,104,597 | 42.26% |
| 2026-06-11 | 668,575,843 | 169,873,098 | 675,421,239 | 25.41% |
| 2026-06-12 | 691,700,177 | 126,340,787 | 696,784,720 | 18.27% |
| 2026-06-13 | 100,477,767 | 41,939,200 | 100,972,237 | 41.74% |
| 2026-06-14 | 125,859,540 | 39,933,824 | 129,562,394 | 31.73% |
| 2026-06-15 | 800,453,933 | 219,001,344 | 806,105,861 | 27.36% |
| 2026-06-16 | 530,247,782 | 80,505,728 | 534,093,518 | 15.18% |

结论：用户观察成立。2026-06-16 的 cache hit ratio 只有 15.18%，显著低于 2026-06-01 到 2026-06-06 多数日期的 50%+。

模型维度：

| 模型 | 请求数 | prompt tokens | cached tokens | total tokens | cache hit ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| gpt-5.5 | 353,533 | 18,206,508,962 | 5,870,847,232 | 18,337,200,278 | 32.25% |
| gpt-5.4-mini | 289,972 | 1,877,736,362 | 1,396,977,152 | 2,099,622,654 | 74.40% |
| codex-auto-review | 15,176 | 1,373,495,778 | 426,420,992 | 1,375,200,578 | 31.05% |
| gpt-5.4 | 12,029 | 637,415,950 | 144,965,504 | 643,704,236 | 22.74% |

当前容器日志样本（2026-06-16 10:00-12:00）：

| 维度 | 请求数 | prompt tokens | cached tokens | total tokens | cache hit ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10 点 | 203 | 9,287,597 | 3,265,792 | 9,361,246 | 35.16% |
| 11 点 | 158 | 17,006,230 | 2,449,536 | 17,103,546 | 14.40% |
| 12 点 | 4 | 619,383 | 46,592 | 624,874 | 7.52% |
| gpt-5.5 | 249 | 25,647,461 | 4,618,624 | 25,789,592 | 18.01% |
| gpt-5.4 | 116 | 1,265,749 | 1,143,296 | 1,300,074 | 90.33% |

账号维度（当前容器日志样本，账号已哈希）：

| accountHash | 请求数 | prompt tokens | cached tokens | total tokens | cache hit ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| `8dec7a3e` | 138 | 17,302,302 | 1,925,120 | 17,398,365 | 11.13% |
| `b4a54e62` | 219 | 10,705,231 | 3,931,648 | 10,793,379 | 36.73% |

账号 + 模型维度：

| accountHash | 模型 | 请求数 | prompt tokens | cached tokens | total tokens | cache hit ratio |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `8dec7a3e` | gpt-5.5 | 137 | 17,291,823 | 1,922,432 | 17,387,805 | 11.12% |
| `b4a54e62` | gpt-5.5 | 103 | 9,439,482 | 2,788,352 | 9,493,305 | 29.54% |
| `b4a54e62` | gpt-5.4 | 116 | 1,265,749 | 1,143,296 | 1,300,074 | 90.33% |

Provider pool 状态：

- Codex pool 有 3 个配置项。
- 其中当前日志样本只看到 2 个账号承担流量。
- 一个高权重账号在配置文件中显示不健康，当前样本未参与流量。
- 当前健康账号 `8dec7a3e` 承担的 `gpt-5.5` 大 prompt 流量命中率最低。

## 根因判断

已证实：

- 今天额度消耗偏快与 cache hit ratio 显著下降高度相关。
- 低命中主要由 `gpt-5.5` 和账号 `8dec7a3e` 拉低。
- 不是简单的“所有模型都低”：`gpt-5.4` 在同一时段仍可达到约 90% 命中。
- 也不是“几十个账号随机分散”导致：当前样本只有 2 个账号参与，且其中一个账号明显更差。

尚未证实：

- 是否由最近几次 AIClient2API 代码改动直接导致。
- 是否由上游 Codex / ChatGPT 侧缓存策略变化导致。
- 是否由 `gpt-5.5` 请求内容、tools、metadata、系统提示词或动态字段变化导致。
- 是否由健康账号切换、账号本身缓存状态、区域/IP、模型别名映射造成。

当前最强假设：

1. `gpt-5.5` 请求形态或上游缓存策略导致缓存命中明显低于 `gpt-5.4`。
2. 账号 `8dec7a3e` 的 `gpt-5.5` 命中率特别低，可能与账号缓存状态、路由切换或请求分布有关。
3. 当前统计缺少持久化的“账号 + 模型 + 日期”维度，导致只能用当前容器日志回推，必须补进定制分支。

## 更新后的实现建议

必须加入定制化分支：

- Codex 账号维度统计：按 provider uuid / account hash 记录 daily、weekly、total。
- 模型维度按日期保留：支持 `date + account + model` 聚合。
- Cache hit ratio：展示 `cachedTokens / promptTokens`，默认纳入 Codex 用量页。
- 低命中诊断：标记低于阈值的账号/模型，例如低于 30% 或低于近 7 日中位数。
- 官方 usage 1 小时 TTL：现有手动刷新继续强制绕过缓存。

建议先不要自动改路由：

- 不建议直接按 cache hit ratio 自动禁用账号或模型，因为命中率可能受任务类型影响。
- 可以先做“观测 + 告警 + 手动筛选”，等积累 1-2 天数据后再决定是否进入路由策略。

可选加入：

- Payload fingerprint 诊断：仅保存稳定哈希和结构摘要，不保存原文 prompt、图片、token、cookie 或 OAuth 内容。
- 针对 `gpt-5.5` 的模型回退/替换实验：需要用户确认后做小流量 A/B。

## 定制分支落地状态

时间：2026-06-16 23:25 +08:00

已完成：

- 官方 usage cache 默认 1 小时 TTL；`refresh=true` 继续绕过缓存。
- `model-usage-stats` 新增 Codex 账号/provider UUID、模型、日期维度，并返回 `cacheHitRatio`。
- `model-usage-stats` 新增账号 token 事件窗口，可用于 Codex rolling 5h token 和本周 token 统计。
- 文本请求与图片请求的插件 hook 已透传实际 provider uuid/name；图片接口 hook 顺序改为先记录 response usage 再 finalize。
- API Potluck 管理端 key 列表新增今日/本周/累计 token、cache hit ratio、最近 7 天每日 token，并默认按今日 Token 排序。
- 可选 Codex sticky provider affinity 已实现，默认关闭；开启后同一个 API Potluck key 的 Codex 请求固定到同一个健康账号，账号不可用时自动 fallback。
- provider weight 已作为本地定制能力实现，默认权重 1。
- Codex provider 新增 `codexMax5hTokens` 与 `codexMaxWeeklyTokens`，只按 token 过滤，所有可选 Codex 账号超额时返回 429。
- Codex prewarm 服务已实现，默认关闭；显式设置 `CODEX_PREWARM_ENABLED=true` 后，才会按 `06:30` 与 `11:30 Asia/Shanghai` 调度，每账号每窗口触发 2 次轻量请求，并按账号/日期/时间点去重。
- 官方 Codex `/usage` 格式化层已兼容 daily/weekly/total token 字段，并保留 1 小时缓存与手动刷新绕过。
- `model-usage-stats.html` 新增低 cache hit ratio 提醒，默认标出低于 30% 的 Codex 账号。

仍需验证/观察：

- 官方 `/usage` 实际字段可能随上游调整；当前解析是防御式兼容，仍需用启用账号的真实响应做只读 smoke。
- 低命中提醒先做观测，不自动按 cache hit ratio 改路由；需要积累 1-2 天样本后再决定是否做策略化调度。
- prewarm 会真实消耗少量请求/token；没有明确短窗口/5h quota 的账号会跳过，若已显式启用仍可通过 `CODEX_PREWARM_ENABLED=false` 关闭。
