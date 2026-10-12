# Codex 上游协议对齐（CPA / 原生 Codex / 本机抓包）

日期：2026-10-12。

依据：
- CLIProxyAPI（CPA）main `091ff27f31285ec4fd1dd5823b44f7f51fb8f48b`（2026-10-11）的 Codex executor/translator 源码。
- openai/codex `rust-v0.162.1` 源码。
- 本机 Codex Desktop `26.1007.2314.0`（内置 `codex-cli 0.162.0-alpha.17.2`）经自定义 provider 发出的 4 个 `/v1/responses` 请求的脱敏抓包。

优先级：本机原生抓包 > 原生源码 > CPA。与 CPA 不同的地方在下表注明。

## 本机抓包摘要（脱敏）

只记录了头名、身份类头的原值、ID 的形状和请求体结构；没有记录 token、账号 ID 和对话内容。

| 项 | 观察值 |
| --- | --- |
| 传输 | HTTP/1.1 + SSE，未见 WebSocket（自定义 provider） |
| `user-agent` | `Codex Desktop/0.162.0-alpha.17.2 (Windows 10.0.19045; x86_64) unknown (Codex Desktop; 26.1007.21434)` |
| `originator` | `Codex Desktop` |
| `x-oai-attestation` | 主对话请求带（194 字符）；标题等辅助请求不带 |
| `x-codex-beta-features` | 主对话请求为 `remote_compaction_v2`；辅助请求不带 |
| 会话头 | `session-id`、`thread-id`、`x-client-request-id`（UUID），`x-codex-window-id`（`<uuid>:0`），`x-codex-turn-metadata`（JSON） |
| 未出现 | `version`、`Connection`、`Conversation_id`、`x-oai-web-search-eligible`、`x-codex-installation-id` 头、`OpenAI-Beta` |
| body 顶层 | `model, stream, input, tools, tool_choice, parallel_tool_calls, reasoning, store, include, prompt_cache_key, text, client_metadata`；没有 `instructions`，没有 `service_tier` |
| `client_metadata` | `x-codex-installation-id, session_id, thread_id, turn_id, root_turn_id, x-codex-window-id, x-codex-turn-metadata` |
| `tools` | 函数工具 + 命名空间（`image_gen.imagegen` 等）；主对话含 `{"type":"web_search","external_web_access":true}`（本机 `web_search = "live"`）；无托管 `image_generation` |
| 其它 | `tool_choice: "auto"`、`store: false`、`include: ["reasoning.encrypted_content"]`；主对话 `reasoning.summary: "detailed"` |

注意：Desktop 走的是自定义 provider，所以只在官方 Codex 后端才发的头（`x-codex-routing-hint`、`chatgpt-account-id`、`version`）抓不到。这几项按 0.162.1 源码补齐。

## 当前实现

| 项 | 实现 | 来源 / 与 CPA 的差异 |
| --- | --- | --- |
| 默认身份 | `originator: codex_cli_rs`，UA `codex_cli_rs/0.162.1 (Windows 10.0.19045; x86_64) unknown`，`version: 0.162.1`，`x-codex-beta-features: remote_compaction_v2` | Desktop 主请求带 attestation，无法生成，因此不冒充 Desktop，改用同平台的原生 CLI 形态；版本取 CLI 稳定版 0.162.1。CPA 强制 `codex-tui/0.154.0` Mac UA |
| Cloaking | `CODEX_CLOAKING_ENABLED` 默认开启，所有请求使用同一身份组 | 机制同 CPA；关闭时可识别的 Codex 身份整组透传，originator 不一致、UA 不可识别或版本过低时回落默认组 |
| 会话头 | `session-id`（入站值，否则 `prompt_cache_key`）、`thread-id`、`x-client-request-id`、`x-codex-window-id`、`x-codex-turn-metadata` 透传 | 头名用原生小写连字符形式 |
| `x-codex-routing-hint` | `model=<上游模型>[;tier=priority/ultrafast]` | 原生源码 + CPA |
| 已移除 | `host`、`Connection`、`Conversation_id`、`x-oai-web-search-eligible`、`x-codex-installation-id` 头 | 本机抓包；installation id 只放在 `client_metadata` |
| 托管 `image_generation` | 不再默认注入，客户端自带的原样透传 | 原生 0.145+ 已不发；CPA 仍默认注入 |
| `web_search` | 非图像请求默认注入 `{"type":"web_search","external_web_access":true}`，客户端自带的保留 | 对齐本机；同时避免历史中有 `web_search_call` 但未声明工具时上游返回 502。CPA 不注入 |
| `tool_choice` | 缺省补 `auto`（非图像请求） | 本机抓包 |
| `service_tier` | 出站不发送 `default`；`priority`/`fast`/`ultrafast` 保留 | 本机抓包（配置为 default 时请求中无该字段）；计费只区分非 default 档位 |
| 删除字段 | `truncation`、`user`、`max_output_tokens`、`max_completion_tokens`、`prompt_cache_breakpoint`、`generate`（另加原有的 `metadata`、`previous_response_id`、`prompt_cache_retention`、`safety_identifier`、`stream_options`） | CPA。`temperature`/`top_p` 按模型有条件保留；`prompt_cache_options` 由质量门禁要求原样透传 |
| 输入 ID | 超过 64 字符的 `id`/`call_id` 做确定性缩短（调用与返回仍配对）；reasoning `id` 删除 | CPA `SanitizeCodexInputItemIDs` |
| Chat 注入 | 删除 `"EXECUTE ACCORDING TO THE FOLLOWING INSTRUCTIONS!!!"` | 原生与 CPA 都不发 |
| 403 分类 | Cloudflare/HTML 页面和裸 `forbidden` 不判凭据失效；`account_deactivated`/`deactivated_workspace` 判失效 | 部分对齐 CPA（未实现 30 分钟冷却） |
| OAuth 刷新 | 带 `scope=openid profile email`；`invalid_grant`/`refresh_token_reused`/`refresh_token_expired`/`refresh_token_invalidated` 不重试 | CPA |

## Responses 转换（2026-10-12 补齐）

| 项 | 修复前 | 现在 | 来源 |
| --- | --- | --- | --- |
| 非流式 Responses 输出 | 重建输出：`function_call` 丢 `call_id`（回传结果 400），丢弃 `web_search_call`/`compaction`/`custom_tool_call`，reasoning 改成假 message 且丢 `encrypted_content`，清空 `annotations` | 原样透传上游 `response`，仅还原缩短的工具名并补齐 usage 字段，与流式一致 | CPA |
| 流式 Responses 输出 | 原样透传，但超过 64 字符被缩短的函数名不还原 | 透传并还原 `function_call` 名称（含 `response.completed` 的 output） | CPA |
| 请求工具 | 所有带 `name` 的工具都改写成 `function`，`namespace`/`custom` 等被破坏 | 只改写 `function` 工具；`namespace`、`custom`、`local_shell`、`web_search`、`file_search`、`mcp`、`tool_search` 等原样透传 | CPA / 原生抓包 |
| input 中的 `function_call` 名称 | 不随工具定义缩短，多轮回放名称不一致 | 与缩短后的工具定义保持一致 | CPA |
| `include` | 强制覆盖为 `["reasoning.encrypted_content"]` | 保留客户端请求的 `web_search_call.action.sources` | CPA |
| 图像 `-fast` 变体 | `/v1/models` 列出但生图/改图接口返回 400 | `gpt-image-2-fast`、`gpt-image-2.5-flare-fast`、`gpt-image-2.5-sunburst-fast` 可用 | 本项目 |

## 真实验证（2026-10-12，单 Codex OAuth 账号，多 worker 验证容器）

全部通过：
- 7 个文本模型与 8 个 `-fast`/`-ultrafast` 变体（Responses 非流式）；
- Chat 流式/非流式，Responses 流式；
- 工具调用往返：Chat、Responses 非流式与流式、`namespace` 工具、`custom` 工具、Claude Messages `tool_use`；
- 联网搜索（非流式含 `web_search_call` 与 sources，流式）；
- 非流式 reasoning `encrypted_content` 回传多轮；
- 远程压缩 v2（流式与非流式各自压缩 + 回放）；
- Claude Messages 流式/非流式文本；
- 文生图（`gpt-image-2`、`gpt-image-2.5`、`sunburst`、两个 `-fast` 变体）与改图（单图、两图、`-fast`）。

## 刻意保留的差异

- `reasoning.summary` 缺省仍为 `auto`：原生主对话也会发送 summary。
- `instructions` 缺省为空字符串（原生不发该字段，CPA 同本项目）。
- 远程压缩：原生 Codex 0.162 的 remote compaction v2 不调用 `/responses/compact`，而是在普通 `/responses` 流式请求的 input 末尾追加 `{"type":"compaction_trigger"}`，上游返回 `compaction` 输出项，下一轮再把该项放回 input。本项目 `/v1/responses` 已原样透传这两类项（2026-10-12 用真实账号验证：压缩返回 `compaction` 项，带回后模型能正确引用压缩前上下文）。CPA 实现的 v1 `/responses/compact` 对 ChatGPT Codex 后端已返回 404，故不提供该路由。
- 未实现：WebSocket 出站、`x-oai-attestation`、TLS 指纹仿真。
