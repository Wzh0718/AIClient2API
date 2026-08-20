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
