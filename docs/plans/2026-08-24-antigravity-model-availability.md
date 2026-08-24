# Antigravity Model Availability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为单个 Antigravity 凭据提供受控的全模型状态探测，并在用量页只展示不可用模型、模型级状态和恢复时间。

**Architecture:** 新增纯服务模块负责模型列表规范化、串行最小请求、错误分类和结果汇总；usage API 负责解析凭据、调用探测服务并把结果写入现有 usage cache；前端只手动触发并渲染服务端结果。现有 `antigravityQuotaHealth.models` 继续作为模型冷却的权威持久状态。

**Tech Stack:** Node.js ES modules、现有 provider adapter、Jest、原生浏览器 JavaScript。

---

**Project Progress Doc:** `.plans/summary.md`（当前历史计划已 done，本临时分支不修改其状态机文件）
**Test Overview Doc:** 现有 `tests/` Jest 测试集合

### Task 1: 定义模型探测服务

**Files:**
- Create: `src/services/antigravity-model-availability.js`
- Create: `tests/antigravity-model-availability.test.js`

**Steps:**
1. 写失败测试：模型列表规范化、有效冷却跳过、串行探测、429/503/unsupported 分类，并确保结果只保留不可用模型。
2. 运行 `npm.cmd test -- --runInBand tests/antigravity-model-availability.test.js`，确认失败。
3. 实现最小服务函数；默认并发 1，模型间短延迟，不保存响应正文。
4. 重跑测试确认通过。
5. 提交 `test/feat(usage): add antigravity model availability probe`。

### Task 2: 接入 usage API 与缓存

**Files:**
- Modify: `src/ui-modules/usage-api.js`
- Modify: `src/ui-modules/usage-cache.js`
- Modify: `src/services/ui-manager.js`
- Create: `tests/antigravity-model-availability-api.test.js`

**Steps:**
1. 写失败测试：仅允许 `gemini-antigravity`、通过 UUID 解析 adapter、返回汇总、写入单实例缓存。
2. 新增 `POST /api/usage/gemini-antigravity/:uuid/model-status-check`。
3. 将 `antigravityModelStatus` 加入 fresh/cache/stale merge 路径。
4. 运行 API 与 cache 聚焦测试。
5. 提交 `feat(usage): expose antigravity model availability endpoint`。

### Task 3: 用量卡片展示与手动触发

**Files:**
- Modify: `static/app/usage-manager.js`
- Modify: `static/app/i18n.js`
- Modify: `tests/antigravity-quota-ui-source.test.js`

**Steps:**
1. 写失败 source test：不可用模型详情、恢复时间和手动检测按钮。
2. 在 Antigravity 卡片加入“检测全部模型”按钮；请求期间禁用并显示 loading。
3. 仅在存在不可用模型时逐行显示 `cooldown/capacity/unsupported/error` 及恢复时间。
4. 未探测时继续渲染现有模型冷却；不展示价格、可用率、N/M 或百分比。
5. 运行 UI source test 并提交 `feat(ui): show antigravity model availability and cooldowns`。

### Task 4: 回归验证

**Files:**
- Modify: `docs/plans/2026-08-24-antigravity-model-availability-design.md`（仅在实现偏差需要记录时）

**Steps:**
1. 运行新增测试和 `tests/antigravity-quota-ui-source.test.js`、`tests/antigravity-quota-summary.test.js`、`tests/antigravity-rate-limit-cooldown.test.js`。
2. 运行 `node --check` 检查新增/修改 JavaScript。
3. 检查 `git diff --check`、`git status --short`，确认无凭据和生产配置进入提交。
4. 提交文档与最终修正；不 push、不部署。
