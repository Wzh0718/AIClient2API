# Potluck 管理变更响应轻量化实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Potluck Key 的路由和并发配置变更接口只返回必要配置结果，不再把完整用量历史序列化到响应中。

**Architecture:** 保留 `key-manager` 内部完整 Key 状态和持久化逻辑不变，在 API 管理变更响应边界增加统一的轻量化投影。`/routing` 与 `/concurrency` 继续完成原有内存更新、持久化、凭据组同步和 `persistencePending` 语义；只有对外 JSON 的 `data` 改为配置摘要。完整用量历史继续由现有详情/统计接口提供。

**Tech Stack:** Node.js ESM、原生 HTTP 路由、Jest。

---

### Task 1: 固化当前响应问题的失败测试

**Files:**
- Modify: `tests/api-potluck-key-routing.test.js`
- Modify: `tests/api-potluck-persistence.test.js`
- Test: `tests/api-potluck-key-routing.test.js`

**Step 1: 添加路由变更响应体断言**

构造带有较大 `usageHistory`（包含 `summary/providers/models/providerModels/accounts/hours`）的 Key，调用 `PUT /api/potluck/keys/:keyId/routing`，断言响应仍包含路由配置，但 `response.body.data.usageHistory` 不存在。

**Step 2: 添加并发变更响应体断言**

调用 `PUT /api/potluck/keys/:keyId/concurrency`，断言返回并发配置字段，且不包含 `usageHistory`、`totalModels`、统计总量和诊断历史字段。

**Step 3: 添加响应大小回归断言**

使用可重复生成的历史数据，断言变更响应 JSON 大小处于轻量级范围，并明显小于包含完整历史的对象；测试不得依赖固定字节数。

**Step 4: 运行失败测试**

Run: `npm test -- --runInBand tests/api-potluck-key-routing.test.js tests/api-potluck-persistence.test.js`

Expected: 新增断言在当前实现下失败，证明两个接口确实返回了不必要的历史数据。

---

### Task 2: 新增统一的 Key 管理响应投影

**Files:**
- Modify: `src/plugins/api-potluck/api-routes.js`
- Test: `tests/api-potluck-key-routing.test.js`

**Step 1: 定义轻量投影字段**

新增内部 helper，例如 `compactKeyManagementMutationData(keyData)`，只保留管理页面保存后需要同步的字段：

```js
{
  id,
  name,
  enabled,
  routingMode,
  primaryGroupId,
  fixedCredential,
  manualLock,
  concurrencyLimit,
  queueLimit,
  queueTimeoutMs,
  concurrencyMode,
  configSyncEpoch,
  configSyncRevision,
  routingConfigRevision
}
```

固定凭据继续只返回现有脱敏引用/必要标识，不返回 token、邮箱或完整用量历史。若现有前端依赖其它明确字段，以测试和调用点为准补入，但禁止通过展开 `...keyData` 重新带回统计字段。

**Step 2: 接入 `/routing`**

保留 `updateKeyRouting()` 的完整内部返回值供 `CredentialGroupService.updateKeyAssignment()` 使用；调用 `sendManagementMutationResponse()` 时，将 `data` 改为轻量投影。

**Step 3: 接入 `/concurrency`**

同样只投影管理配置字段，保留 `persistencePending` 顶层状态和现有 HTTP 200/202 语义。

**Step 4: 运行 focused 测试**

Run: `npm test -- --runInBand tests/api-potluck-key-routing.test.js tests/api-potluck-persistence.test.js`

Expected: 新增响应轻量化断言通过，现有持久化、路由、固定凭据和并发字段断言不回归。

---

### Task 3: 检查同类管理接口，避免继续产生大响应

**Files:**
- Inspect/Modify: `src/plugins/api-potluck/api-routes.js`
- Test: `tests/api-potluck-admin-persistence-routes.test.js`

**Step 1: 盘点所有 `sendManagementMutationResponse` 调用**

确认 `/limit`、`/name`、`/toggle`、`/reset`、`/reset-tokens`、`/regenerate` 等接口是否也把完整 Key 对象返回。对只修改配置的接口统一使用轻量投影；删除/重置等非 Key 对象结果保持原契约。

**Step 2: 保持详情接口不变**

不得修改 `GET /keys/:keyId`、统计接口和全模型用量数据结构；这些接口仍按原设计提供详细历史。

**Step 3: 增加公共管理响应回归测试**

断言所有被纳入投影的管理变更接口都不返回 `usageHistory`，并保留 `persistencePending` 顶层字段。

---

### Task 4: 前端兼容与网络观测

**Files:**
- Inspect: `static/potluck.html`
- Modify if needed: `static/potluck.html`
- Test: `tests/persistence-pending-ui-source.test.js`

**Step 1: 检查保存成功后的字段使用**

确认 `handleManagementMutationResult()` 和 `loadData()` 不依赖变更响应中的 `usageHistory` 或完整统计字段；若依赖，改为使用轻量字段并按现有流程重新加载列表。

**Step 2: 增加可诊断的响应大小日志/指标（可选最小实现）**

仅在服务端管理接口统一记录响应字节数和接口路径，不记录 Key、凭据或用量内容；若项目已有 HTTP 观测机制则复用，不新增高频日志。

**Step 3: 运行源码测试**

Run: `npm test -- --runInBand tests/persistence-pending-ui-source.test.js tests/potluck-key-concurrency-ui-source.test.js`

Expected: 保存、持久化待完成提示和并发配置 UI 测试通过。

---

### Task 5: 完整验证与发布前检查

**Files:**
- Verify: `src/plugins/api-potluck/api-routes.js`
- Verify: `tests/api-potluck-key-routing.test.js`
- Verify: `tests/api-potluck-persistence.test.js`

**Step 1: 运行 focused Jest**

Run: `npm test -- --runInBand tests/api-potluck-key-routing.test.js tests/api-potluck-persistence.test.js tests/api-potluck-admin-persistence-routes.test.js tests/persistence-pending-ui-source.test.js tests/potluck-key-concurrency-ui-source.test.js`

Expected: 全部通过。

**Step 2: 运行语法和 diff 检查**

Run: `node --check src/plugins/api-potluck/api-routes.js; git diff --check`

Expected: 无语法错误、无空白错误。

**Step 3: 手工验证响应契约**

使用本地容器或测试 HTTP harness 分别调用 `/routing` 和 `/concurrency`，记录 HTTP 状态、响应字节数和字段集合；确认响应不含 `usageHistory`，并确认保存后 GET 详情仍能读取完整历史。

**Step 4: 更新项目测试记录**

在项目既有进度/测试文档中记录响应轻量化变更和验证结果，不记录生产 Key、凭据或完整响应内容。

**Step 5: 提交边界**

只提交本计划涉及的源码、测试和文档；不提交生产配置、日志、凭据或现有无关工作区改动。

---

## 风险与边界

- 本计划不删除或压缩历史数据，只改变管理变更接口的返回投影。
- 本计划不改变路由分配、并发限制、队列行为、持久化版本或多 worker 同步逻辑。
- `persistencePending` 必须继续保留在顶层，避免前端误判保存结果。
- 如果其它客户端依赖变更接口返回完整 Key，需要先通过调用点和测试确认，再提供兼容字段，而不是恢复完整历史。
