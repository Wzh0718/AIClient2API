# Codex 隐含周限快照观测计划

> 状态：待实现（诊断已完成，本计划只覆盖观测，不改指纹默认）

## 背景

2026-08-17 诊断确认：同一 `pro` 套餐下，部分 Codex OAuth 号的「当周 token / 周百分比」从约 8B 落到 1–2B，另一部分仍在 6–11B。现有 usage cache 只存最新一次刷新，历史对照要靠偶然留下的 `candidate-configs-*` 和 backup。

## 目标

持久化每个 Codex OAuth 账号的官方周窗快照，用来发现「百分比没变但折合容量变了」。

## 非目标

- 不改 `codexFingerprintMode` 默认值，不自动把 `codexFingerprintMigrated` 号改回 `off`
- 不实现 IP 轮换、指纹伪造或其它对抗上游风控的逻辑
- 不把邮箱、Token、Cookie、原始 API Key 写入快照或日志

## 建议字段（每账号每次刷新一行）

- `capturedAt`、`providerUuid`（可只存 uuid，或单向短哈希）
- `plan`
- `weeklyPercent`、`weeklyResetAt`
- `weeklyTokens`、`lifetimeTokens`（来自已有 tokenUsage，不是新打官方接口）
- `impliedWeeklyTokenCeiling = weeklyTokens / (weeklyPercent/100)`，百分比为 0 时留空
- `fingerprintMode`、`fingerprintMigrated`（当时配置，不是改写后的上游 ID）
- `disabled`

只在官方 usage 刷新成功时追加。保留至少 2 个完整周窗。百分比对美元如果本地算不出来就不要编。

## 告警条件（实现时再写测试）

同一账号、同一 `plan`，隐含周限在 24 小时内下降超过 40%，且当周 token 增加不足以解释百分比跳变。

## 验收

- 用 08-11 与 08-14 的真实快照能复现 `420a8594` 隐含周限从约 7.7B 落到约 2.0B
- 用同一对快照不会把 `82aacbd4` 误报成上限塌缩
- 快照文件不含邮箱、Token、Cookie、原始 Key

## 不在本计划

按号把指纹改成 `off` 的 A/B。那是运维试验，见诊断文档，不写成自动迁移。
