# GLM Coding Plan 会话分流

此功能在 `customized-branch` 中将部分 GPT 文本及函数工具会话路由到国内智谱 GLM Coding Plan。客户端仍请求 GPT 模型；管理端审计分别记录请求模型、实际 provider 和出站模型。

## 管理操作

1. 配置运行时 Redis；跨 worker 会话绑定依赖同一个 Redis 数据库。服务启动前设置 `REDIS_URL`。
2. 在“提供商管理”添加 `GLM Coding Plan` 节点，填写 Coding Plan API Key、权重、并发与代理。实际模型固定为 `glm-5.3-flash`，key 在管理 API 中脱敏。
3. 点击节点的“测试协议”。这会分别以非流式和流式请求 Chat、Responses 和函数工具接口，共六次轻量请求，消耗少量套餐额度。只有全部测试通过，节点才可参与 GLM 分流。
4. 在“配置管理”打开“GPT 会话分流到 GLM”。配置页展示可用节点、权重、绑定数和 worker 同步状态。调整节点权重只影响新会话。
5. 在 `request-audit.html#audit` 用 Provider=`glm-coding-plan` 或“GLM 分流”筛选查看实际路由；“用量查询”展示最近七天的 GLM 请求审计汇总。官方剩余额度暂不查询。

关闭开关只停止新会话进入 GLM。已绑定会话继续使用原节点，闲置七天后过期。停用一个仍有绑定的 GLM 节点会使这些会话返回错误；删除节点前必须等绑定数归零。

路由要求明确的 `thread_id`、`session_id` 或 `prompt_cache_key`，并按客户端身份隔离。没有可靠会话标识的新请求留在 Codex。GLM 不支持或未经验证的输入、工具与参数不会用于新会话；已绑定 GLM 后遇到这些请求会返回错误。额度、授权或节点故障不会自动将已绑定 GLM 会话转向 GPT。

显式指定 provider 的路径或请求头、固定凭据 Key 不参与分流。分组 Key 的 Codex 候选节点遵守其现有凭据组；GLM 节点由全局开关统一准入。

Chat Completions 使用 `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions`，Responses 使用 `https://open.bigmodel.cn/api/v1/responses`。协议实现参考 CLIProxyAPI `acdace93` 的 OpenAI-compatible executor；来源与 MIT 声明见 `src/providers/glm/NOTICE.md`。

本地测试只使用模拟 Redis 和 HTTP 响应。真实套餐可用性、多轮工具链与官方模型支持必须通过节点的显式协议测试确认；未完成真实验证时，管理页保留“未验证”状态。
