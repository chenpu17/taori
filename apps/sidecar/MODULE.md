# apps/sidecar · MODULE

## 定位

Taori 业务编排进程，负责 LLM 调用、工具调度、圆桌执行、SQLite 持久化与本地 HTTP/SSE API。

## 主要接口

- REST/SSE：`/v1/chat`、`/v1/runs/:id/continue`、`/v1/runs/:id/recover`、`/v1/tools/*`、`/v1/mcp/servers*`、`/v1/models*`、`/v1/roundtable*`、`/v1/costs*`、`/v1/research/sessions*`
- 内部：Capability Bus、Provider registry、Roundtable runner、Catalog sync、DB repos

## 拥有状态

- SQLite 业务数据：providers、models、mcp_servers、conversations、messages、roundtables、cost_records、memories、run_events、agent_runs、research_sessions、research_tasks、research_sources、research_claims
- 运行态：Capability Bus 工具注册表、进行中的 chat/roundtable SSE 流

## 依赖

- `packages/shared` schema/type
- Provider HTTP API
- better-sqlite3 / Drizzle schema
- Tauri control channel keystore abstraction

## 当前合同变化

- MCP 管理从“仅本地 stdio server”扩展到“本地 stdio + 托管远程 bridge”：Sidecar 可把搏查远程 SSE 搜索解析为受控本地 proxy 进程，Renderer 只保存 API Key，不暴露底层 `mcp-remote` 命令细节。
- 普通聊天链路会把会话有效且模型支持 tools 的 MCP 工具动态暴露给上游模型；MCP 工具调用复用长连接 stdio session，并把超时/崩溃归类为工具错误。
- Sidecar 记忆新增 `default_search_tool` 约定键；普通聊天、Quick Compare 与 Roundtable 在暴露工具时会只保留一个首选搜索工具。若首选工具不可用，则自动回退到 `builtin.web_search` 或当前首个可用搜索工具。
- 新增 `POST /v1/runs/:id/continue`：仅允许续写 `incomplete` 的助手消息，创建 `kind='continue'` 子 run，不插入新的 user message，并通过 `parent_run_id` / `continued_from_message_id` 保留恢复链路；高成本或超预算时会先返回 `cost_confirmation_required`，确认前不创建 assistant message、不启动上游调用。
- 新增 `POST /v1/runs/:id/recover`：Sidecar 执行 `retry_same_model` / `switch_model` / `compact_context` / `skip_tool` 恢复动作，创建 `kind='retry'` 子 run，写入 `recovery.started` 与 `recovery.completed/failed`；`compact_context` 当前使用确定性摘要压缩较早历史，`skip_tool` 会基于原 run 的最后一个失败工具临时禁用该工具并继续，`continue` 仍走专用 continue API；高成本或超预算时同样要求 `confirmed_cost` 二次提交。
- `run_events` 仍是运行生命周期 append-only 真相源；新增 `agent_runs` 物化 Header 表作为 `/v1/conversations/:id/runs` 查询索引，事件写入时同步更新，缺失时仍可从事件推导兜底。
- `/v1/chat`、`/v1/runs/:id/continue`、`/v1/runs/:id/recover` 会按模型 `context_length` 自动执行滑动窗口裁剪，保留系统提示和最近消息，并在 `context.snapshot.context_window` 中记录估算 token、预算和省略消息数量。
- `chat.ts` 的上下文窗口管理拆入 `src/chat/context-window.ts`；恢复/续写共用的 run 解析与 compact 纯逻辑在 `src/chat/recovery.ts`，continue/recover 的上下文组装与校验在 `src/chat/run-actions.ts`，AI SDK 工具构建与 image/web/MCP 工具说明在 `src/chat/upstream-tools.ts`；路由仍保持原 API 和流式协议。
- `chat.ts` 的运行支撑逻辑继续拆入 `src/chat/run-stream.ts`，包含 `ProduceCtx`、run event 降级写入、上下文快照、上游消息构造和 stream 结束持久化；路由仍保持原 API 和流式协议。
- 新增 `GET /v1/tools/health`：按 Capability Bus 当前工具清单返回最近 24h 调用数、失败数、平均耗时和最近失败分类；Capability Bus 的 `cost_records(source_type='tool_call')` 失败记录会保留工具错误分类。
- `GET /v1/costs/calls` 返回最近模型/工具调用时会附带可反查的 `run_id`、`run_event_id`、`run_event_kind` 和 `run_event_label`；支持可选 `cost_record_id` 精确定位单条调用，普通聊天与圆桌 `cost.recorded` 事件 payload 会携带 `cost_record_id`，用于 Cost Dashboard 与 Run Timeline 对照。
- 新增 `GET /v1/diagnostics/real-provider/latest`：只读扫描最近一次 `pnpm verify:real` 本地产物，返回真实 Provider 旅程的步骤、结构化风险、运行事件和成本摘要；该接口不读取 Keychain、不发起真实模型调用。
- `GET /v1/personas` 首次发现 Persona 表为空时会自动创建一个“架构评审助手”示例 Persona，帮助首次使用者理解 Persona 名称、描述与 system prompt 的配置方式；用户删除后不会反复重建，返回结构仍为 `{ personas }`。
- `models` 支持 `pricing_meta` 复杂价格元数据。
- 圆桌参与者可调用 web/MCP 工具并通过 `rt.tool_trace` 流式通知 Renderer；圆桌分析、轮次、单人重试、总结和取消会写入 `run_events` 并物化为 `kind='roundtable'` 的 `agent_runs`。
- `/health` 对 Tauri Rust control channel 的诊断探测使用短超时，只影响 `control_channel` 诊断字段，不承担 Keychain 可用性深度验证；Keychain 深度检查仍由用户主动触发的 `/v1/selfcheck`、Provider 测试、同步或真实调用路径完成。
- `/v1/selfcheck` 默认不读写 Keychain，只把 keystore 项标为已跳过；只有 `?include_keychain=1` 才执行临时 Keychain probe。
- `/v1/providers/key-status` 在 Keychain 模式下默认拒绝隐式读取，必须带 `confirm_keychain=1` 才串行读取 Provider Keychain 状态；control channel 的 Keychain 读/写/删有显式超时，避免 macOS 授权阻塞导致请求长期挂起。
- Provider registry 新增 `deepseek`、`packyapi` 与 `siliconflow`：DeepSeek 官方走 OpenAI-compatible `/models` 发现 `deepseek-v4-flash` / `deepseek-v4-pro`；普通文本流仍复用通用 OpenAI-compatible chat path，但当 DeepSeek 官方聊天模型启用 tools 时，Sidecar 会切换到 provider-specific 的 Chat Completions tool loop，显式回传 `assistant.reasoning_content` 以兼容官方 thinking + tool calling 协议。PackyAPI 默认导入 `gpt-image-2` 并走 OpenAI-compatible `/images/generations`；SiliconFlow 使用 OpenAI-compatible `/models` 发现模型，图像生成走专用 `image_size` 请求并支持 URL 返回落地为本地文件。
- Sidecar 现支持模型 thinking 配置：全局默认值复用 `memories(scope='global', key='thinking_enabled')`，单模型 `models.thinking_enabled` 可覆盖全局；聊天、Quick Compare、Roundtable、自动记忆抽取与 `/v1/models/:id/test` 共用统一解析。当前已知适配：OpenRouter → `reasoning`，DeepSeek 官方 → `thinking`，OpenAI/custom 的 GPT-5 / o 系列 → `reasoning_effort`；未确认的 provider 保持不注入 thinking 参数。
- standalone npm CLI 新增 daemon 生命周期：`taori daemon start|status|stop`；默认仍前台监听 `127.0.0.1`，但 standalone 可通过 `--host 0.0.0.0` 进入远程 / Web 部署模式。desktop 托管语义不变，仍由 Rust 负责本地 sidecar 的 spawn / 守护。
- standalone npm 模式现可同源托管浏览器 Web UI：当 npm 包内存在 `dist-web` 资源时，Sidecar 会直接提供 `/` 登录页与 `/app` Web UI；浏览器用户通过 `--password` 设置的访问密码换取 HttpOnly cookie 会话，普通脚本与自动化仍可继续使用 Bearer Token 调 API。
- 聊天成本链路新增 `cache_input_tokens`：`/v1/chat` 流内 `cost` annotation、`cost.recorded` run event 与 `GET /v1/costs/calls` 会透出输入 / cache / 输出 token；OpenAI-compatible provider metadata 与 DeepSeek 官方原始 usage 中的 cached prompt tokens 会被尽力采集并落入 `cost_records`。
- 深度研究第一切片已落地：Sidecar 新增 `research_sessions / tasks / sources / claims` 四张表、`ResearchRepo`、确定性 planner 与 `/v1/research/sessions*` 资源路由；`start` 支持计划预览与确认启动，`pause/resume/cancel/export` 支持工作台基础状态流转与导出。
