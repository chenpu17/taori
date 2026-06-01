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

- 新增内部基础编排模块 `src/orchestration/context-router.ts`、`src/orchestration/web-context.ts` 与 annotation helper（架构提案：`docs/architecture/36-capability-orchestration-kernel-proposal.md`）：普通聊天、Quick Compare 主路径 / 重试、Roundtable 轮次会在组装上下文前生成结构化 `OrchestrationPlan`，统一判断是否需要外部信息、本地文件上下文、首选搜索工具、是否需要引用以及是否建议升级到深度研究。计划写入 `run_events(kind='orchestration.plan')`；普通聊天还会进入 `context.snapshot.context_sources[type='orchestration']`，并通过 `orchestration` Data Stream annotation 暴露给 Renderer；Quick Compare / Roundtable 分别通过 `qc.orchestration` / `rt.orchestration` 暴露同一决策摘要。
- 普通聊天的联网上下文从关键词补丁升级为编排驱动：高时效 / 需要证据的问题会先按首选搜索工具预搜索，再在需要时读取前几个网页正文片段（`builtin.web_fetch`），随后把搜索结果与正文片段作为 system context 注入上游模型；不支持原生 tools 的聊天模型也能受益。预搜索 / 预读取均通过 `tool.*` run events 与 `tool_trace` 暴露。
- Quick Compare 现在复用同一编排内核：高时效 / 需要证据的问题会在候选模型并发启动前、单候选重试前做共享预搜索 / 预读取，并把相同网页上下文注入候选，避免多模型对比结果取决于某个候选是否主动调用搜索工具；执行过程通过 `tool.*` run events 与 `qc.tool_trace` 暴露。
- Roundtable 轮次现在复用同一编排内核：每轮发言开始前按圆桌 topic 做一次共享预搜索 / 预读取，并把网页上下文注入所有参与者 prompt；执行过程通过 `tool.*` run events 与 `rt.tool_trace` 暴露。
- Provider `enabled=false` 现在是 Sidecar 真实模型调用的后端硬门禁：`/v1/chat` 会在创建会话/消息前拒绝停用服务商下的模型；`continue` / `recover` / Quick Compare 自动候选、显式选择和重试都会跳过或拒绝这类模型，避免前端过滤被旧本地状态、恢复路径或直接 API 绕过。
- 首轮标题仍默认使用本地 30 字截断，不再默认发起后台 LLM 标题生成；`src/chat/auto-title.ts` 的 LLM 标题升级仅在 `memories` 有效值 `auto_title_llm_enabled === 'true'` 时运行，且会跳过已停用服务商。该实验路径仍是 best-effort，不写 `cost_records`，因此默认关闭。
- 会话列表 `GET /v1/conversations`（含 `?q=` 搜索）默认只返回**至少有一条消息**的会话：首条消息失败 / 放弃的 `新对话` 留下的 0 消息孤儿会话不再出现在历史（活动会话由 Renderer 本地状态显示、不依赖列表，故无首条消息持久化竞态）。诊断 / 管理场景可传 `include_empty=1` 显式包含 0-message 会话；`ConversationsRepo.list()` 默认保留仓储真实语义，调用方用 `includeEmpty=false` 选择侧栏过滤。
- 首轮对话标题的 LLM 概括仍保留为可选实验能力：截断标题即时生效并作为永久兜底，首条助手回复完成后 `src/chat/auto-title.ts` 可在显式开关开启时以 `setImmediate` best-effort 用最便宜的可用 chat 模型生成 4-12 字标题并 `convRepo.rename`；gate 为「标题仍等于截断」，故只升级一次、绝不覆盖手动改名；失败/无可用模型时静默保留截断。仅接入主 `/v1/chat` 路径（continue/recover 不触发）。新增 `SidecarTestHooksConfig.automatedTest`（`normalizeSidecarConfig` 由 `NODE_ENV==='test' || VITEST` 派生），与 `hermeticWeb` 一起在 vitest / hermetic e2e 下抑制该后台 LLM 调用。
- MCP 管理从“仅本地 stdio server”扩展到“本地 stdio + 托管远程 bridge”：Sidecar 可把搏查远程 SSE 搜索解析为受控本地 proxy 进程，Renderer 只保存 API Key，不暴露底层 `mcp-remote` 命令细节。
- 新增 `POST /v1/models/:id/reset-health`：清除模型自动健康保护状态（`failure_count_24h=0`、`last_failure_at=null`、`demoted=false`、`disabled_until=null`），用于用户确认配置已修复后手动恢复模型候选资格；不改变 `enabled` 手动开关。
- 普通聊天链路会把会话有效且模型支持 tools 的 MCP 工具动态暴露给上游模型；MCP 工具调用复用长连接 stdio session，并把超时/崩溃归类为工具错误。
- 普通聊天成本 annotation 和历史消息回填都会透出 `first_token_ms` / `duration_ms`；字段来自已有 `cost_records`，用于 Renderer 展示 TTFT、总耗时与 TPOT。
- Sidecar 记忆新增 `default_search_tool` 约定键；普通聊天、Quick Compare 与 Roundtable 在暴露工具时会只保留一个首选搜索工具。若首选工具不可用，则自动回退到 `builtin.web_search` 或当前首个可用搜索工具。
- Quick Compare 在缺少 Provider、缺少 API Key 或读取 Keychain 失败时仍保留本地预览 fallback，但会在 `qc.participant_start` / `qc.participant_done` annotation 写入 `execution_mode='local_preview'` 与 `preview_reason`；真实上游调用写入 `execution_mode='live'`。数据库结构不变。
- 新增 `POST /v1/runs/:id/continue`：仅允许续写 `incomplete` 的助手消息，创建 `kind='continue'` 子 run，不插入新的 user message，并通过 `parent_run_id` / `continued_from_message_id` 保留恢复链路；高成本或超预算时会先返回 `cost_confirmation_required`，确认前不创建 assistant message、不启动上游调用。
- 新增 `POST /v1/runs/:id/recover`：Sidecar 执行 `retry_same_model` / `switch_model` / `compact_context` / `skip_tool` 恢复动作，创建 `kind='retry'` 子 run，写入 `recovery.started` 与 `recovery.completed/failed`；`compact_context` 当前使用确定性摘要压缩较早历史，`skip_tool` 会基于原 run 的最后一个失败工具临时禁用该工具并继续，`continue` 仍走专用 continue API；高成本或超预算时同样要求 `confirmed_cost` 二次提交。
- `run_events` 仍是运行生命周期 append-only 真相源；新增 `agent_runs` 物化 Header 表作为 `/v1/conversations/:id/runs` 查询索引，事件写入时同步更新，缺失时仍可从事件推导兜底。
- `/v1/chat`、`/v1/runs/:id/continue`、`/v1/runs/:id/recover` 会按模型 `context_length` 自动执行滑动窗口裁剪，保留系统提示和最近消息，并在 `context.snapshot.context_window` 中记录估算 token、预算和省略消息数量。
- `chat.ts` 的上下文窗口管理拆入 `src/chat/context-window.ts`；恢复/续写共用的 run 解析与 compact 纯逻辑在 `src/chat/recovery.ts`，continue/recover 的上下文组装与校验在 `src/chat/run-actions.ts`，AI SDK 工具构建与 image/web/MCP 工具说明在 `src/chat/upstream-tools.ts`；路由仍保持原 API 和流式协议。
- `chat.ts` 的运行支撑逻辑继续拆入 `src/chat/run-stream.ts`，包含 `ProduceCtx`、run event 降级写入、上下文快照、上游消息构造和 stream 结束持久化；路由仍保持原 API 和流式协议。
- DB repo 的 Provider/Model row mapper 与通用数组解析拆入 `src/db/repos/mappers.ts`；深度研究任务叙事写入与 session finalize helper 拆入 `src/research/lifecycle.ts`；均为内部结构收敛，数据库和 HTTP 合同不变。
- `RunEventsRepo` 新增 `appendSafe`，统一 chat / roundtable 写入 run event 时的 FK 降级策略；`server.ts` 的请求体大小提示、Standalone cookie 解码容错与 Bearer/Cookie 授权分支做了低风险收敛，HTTP 鉴权语义不变。
- Data Stream Protocol 写帧集中到 `src/chat/protocol.ts`，`chat`、`quick-compare` 与 chat stream producers 通过 helper 写 `0:` / `8:` / `e:` / `d:` part，减少裸 `stream.write()` 分散；协议格式与前端消费合同不变。
- Standalone 浏览器登录 / 未启用提示 HTML 拆入 `src/standalone/login-page.ts`；`server.ts` 只负责路由、cookie 与鉴权编排。Standalone 模式即使本地缺少 packaged `dist-web`，也会返回可解释 HTML，而不是把 `/` 当作普通 API 返回 401。
- 测试控制位集中到 `SidecarConfig.testHooks` / `loadTestHooksConfig()` / `normalizeSidecarConfig()`；chat failure classification、image tool forced result、research hermetic planner 与 hermetic web fetch 不再在业务路径分散读取 `TAORI_*` 环境变量。
- 新增 `GET /v1/tools/health`：按 Capability Bus 当前工具清单返回最近 24h 调用数、失败数、平均耗时和最近失败分类；Capability Bus 的 `cost_records(source_type='tool_call')` 失败记录会保留工具错误分类。
- `GET /v1/costs/calls` 返回最近模型/工具调用时会附带可反查的 `run_id`、`run_event_id`、`run_event_kind` 和 `run_event_label`；支持可选 `cost_record_id` 精确定位单条调用，普通聊天与圆桌 `cost.recorded` 事件 payload 会携带 `cost_record_id`，用于 Cost Dashboard 与 Run Timeline 对照。
- 新增 `GET /v1/diagnostics/real-provider/latest`：只读扫描最近一次 `pnpm verify:real` 本地产物，返回真实 Provider 旅程的步骤、结构化风险、运行事件和成本摘要；该接口不读取 Keychain、不发起真实模型调用。
- `GET /v1/personas` 首次发现 Persona 表为空时会自动创建一个“架构评审助手”示例 Persona，帮助首次使用者理解 Persona 名称、描述与 system prompt 的配置方式；用户删除后不会反复重建，返回结构仍为 `{ personas }`。
- `models` 支持 `pricing_meta` 复杂价格元数据。
- 圆桌参与者可调用 web/MCP 工具并通过 `rt.tool_trace` 流式通知 Renderer；圆桌分析、轮次、单人重试、总结和取消会写入 `run_events` 并物化为 `kind='roundtable'` 的 `agent_runs`。
- `/health` 对 Tauri Rust control channel 的诊断探测使用短超时，只影响 `control_channel` 诊断字段，不承担 Keychain 可用性深度验证；Keychain 深度检查仍由用户主动触发的 `/v1/selfcheck`、Provider 测试、同步或真实调用路径完成。
- `/v1/selfcheck` 默认不读写 Keychain，只把 keystore 项标为已跳过；只有 `?include_keychain=1` 才执行临时 Keychain probe。
- `/v1/providers/key-status` 在 Keychain 模式下默认拒绝隐式读取，必须带 `confirm_keychain=1` 才串行读取 Provider Keychain 状态；control channel 的 Keychain 读/写/删有显式超时，避免 macOS 授权阻塞导致请求长期挂起。
- `POST /v1/providers/test` 现同时支持两类请求：临时测试 `{ type, base_url, api_key? }` 与对已保存 Provider 直接测试 `{ provider_id }`。后者会在 Sidecar 内读取已保存配置和 Keychain/keystore 中的 key，避免 Renderer 因拿不到明文 key 而只能返回“未知错误”。
- Provider registry 新增 `deepseek`、`packyapi` 与 `siliconflow`：DeepSeek 官方走 OpenAI-compatible `/models` 发现 `deepseek-v4-flash` / `deepseek-v4-pro`；普通文本流仍复用通用 OpenAI-compatible chat path，但当 DeepSeek 官方聊天模型启用 tools 时，Sidecar 会切换到 provider-specific 的 Chat Completions tool loop，显式回传 `assistant.reasoning_content` 以兼容官方 thinking + tool calling 协议。PackyAPI 默认导入 `gpt-image-2` 并走 OpenAI-compatible `/images/generations`；SiliconFlow 使用 OpenAI-compatible `/models` 发现模型，图像生成走专用 `image_size` 请求并支持 URL 返回落地为本地文件。
- Sidecar 现支持模型 thinking 配置：全局默认值复用 `memories(scope='global', key='thinking_enabled')`，单模型 `models.thinking_enabled` 可覆盖全局；聊天、Quick Compare、Roundtable、自动记忆抽取与 `/v1/models/:id/test` 共用统一解析。当前已知适配：OpenRouter → `reasoning`，DeepSeek 官方 → `thinking`，OpenAI/custom 的 GPT-5 / o 系列 → `reasoning_effort`；未确认的 provider 保持不注入 thinking 参数。
- standalone npm CLI 新增 daemon 生命周期：`taori daemon start|status|stop`；默认仍前台监听 `127.0.0.1`，但 standalone 可通过 `--host 0.0.0.0` 进入远程 / Web 部署模式。desktop 托管语义不变，仍由 Rust 负责本地 sidecar 的 spawn / 守护。
- standalone npm 模式现可同源托管浏览器 Web UI：当 npm 包内存在 `dist-web` 资源时，Sidecar 会直接提供 `/` 登录页与 `/app` Web UI；浏览器用户通过 `--password` 设置的访问密码换取 HttpOnly cookie 会话，普通脚本与自动化仍可继续使用 Bearer Token 调 API。
- 聊天成本链路新增 `cache_input_tokens`：`/v1/chat` 流内 `cost` annotation、`cost.recorded` run event 与 `GET /v1/costs/calls` 会透出输入 / cache / 输出 token；OpenAI-compatible provider metadata 与 DeepSeek 官方原始 usage 中的 cached prompt tokens 会被尽力采集并落入 `cost_records`。
- 深度研究第一切片已落地：Sidecar 新增 `research_sessions / tasks / sources / claims` 四张表、`ResearchRepo`、确定性 planner 与 `/v1/research/sessions*` 资源路由；`start` 支持计划预览与确认启动，`pause/resume/cancel/export` 支持工作台基础状态流转与导出。
- 深度研究执行链路已从“每题单次搜索”提升为“按预算做多轮自适应检索”：同一研究问题会追加官方/第三方等补充 query，直到来源覆盖达到阈值后再进入综合；来源 metadata 也会保留 `question_ids`，允许同一证据支撑多个问题而不丢关联。
- 当深度研究使用 `builtin.web_search` 时，Runner 现在会显式做内置搜索引擎梯子：先跑当前配置引擎，再补试 Exa，并在有搏查 Key 时补试搏查；任务输出会记录 `engine_attempts`，避免用户误以为“库里有 Exa”就一定已经尝试过 Exa。
- 深度研究单个检索分支即使多轮补救后没有可用来源，也不再直接把任务标记为失败；Runner 会把 `coverage_status='no_usable_sources'`、`failure_reason`、尝试过的 query / engine 写入任务输出，并继续综合已有证据。只有整场研究完全没有来源时，才会在生成草稿前暂停。
- 深度研究现在会在广泛且欠约束的选题上先进入 `stage='scoping'`：Sidecar 先追问地区 / 时间范围 / 重点维度，再生成计划，避免在边界模糊时直接产出浅计划。
- 深度研究计划现在会显式记录 `plan_origin`（`pending` / `ai` / `fallback`）：当前版本只会写入 `pending / ai`；`fallback` 仅用于兼容历史会话，AI 规划会在有限重试后直接失败，而不是再生成模板计划。
- 深度研究综合阶段改为流式：`runSummarize` 改用 `streamText`，边生成边把累计草稿落进 `research_sessions.draft_markdown`（每 ~200 字或 1 秒 flush 一次），前端在 `stage='drafting'/'verifying'` 时把 detail 轮询间隔降到 1s，肉眼可见的草稿逐段出现而不是一次性瞬间显示。
- 深度研究 `runVerify` 改为调用独立 CitationAgent：drafting 完成后再起一次 LLM 调用，只在已收集来源池内为每条论断绑定具体的原文 span（30-300 字逐字摘录）+ 信心评级（high / medium / low / unverified）。`research_claims` 新增 `evidence_spans_json` / `confidence` / `verified_at` 字段；当 CitationAgent 不可用或来源为空时仍回退到原章节级模板，确保 claims 表不为空。
- 深度研究综合模型可独立配置：`research_sessions.synthesis_model_id` + memories `default_research_synthesis_model` + 现有 `preferred_model_id` 形成优先级链，未配置时仍 fallback 到默认 chat 模型；CitationAgent 与 Synthesis 共用同一个 picker，让用户能用同一个"研究级"模型同时跑综合和核查。
- 深度研究 query 生成改为 LLM 驱动：新模块 `research/query-planner.ts` 在 `runSearch` 进入前先让 LLM 按 wide→narrow 阶梯出 2-4 条 query（recovery 阶段最多 8 条，并显式告诉模型哪些 query 已失败），并产出一句话 `strategy` 写入 `research_tasks.output.query_strategy` 供 UI 展示；LLM 调用失败、无可用模型或 hermetic 模式时自动回退到旧的模板 `buildSearchQueries` / `buildSearchRecoveryQueries`。查询模型优先用 memories `default_research_query_model` → cheapest active chat → preferred → default，避免占用昂贵的综合模型。task output 同步记录 `query_source`（`'llm'|'template'`）、`query_plan`（带 intent 注释的 query 列表）、`recovery_strategy` 与 `recovery_source`。
- 深度研究计划升级为"wide → narrow + 章节大纲 + 检索策略"三件套：`ResearchPlan` 新增可选字段 `expected_outline`（3-8 个章节标题）、`search_strategy`（80-300 字检索叙述），`ResearchPlanQuestion` 新增可选 `scope`（`recon` / `comparative` / `deep_dive` / `verification`）；`ai-planner` 的 prompt 重写，显式要求 key_questions 按 wide→narrow 排序并附 scope 标签，并产出预期章节与检索策略叙述；确定性 `buildResearchPlan` 也兜底输出同款字段（基于 outputKind 与约束生成 deterministic strategy），让 hermetic / fallback 计划同样能被新版 UI 渲染。Schema 字段全部 optional，老 session 仍验证通过，无需 DB migration。
- 深度研究任务现在每个完成时会写入 `task.output.narrative`：新模块 `research/narrative.ts` 是纯函数模板（无 LLM 调用、零增量成本），按 kind（search / reflect / summarize / verify_citation / fetch）输出一句话总结，如「『主流大模型 API 价格』搜到 8 条来源、覆盖 5 个站点（2 轮官方 + 1 轮第三方）」、「CitationAgent 把 12 条论断绑回原文 span（5 强 · 4 中 · 3 弱）」；`runTask` 在每个任务完成前调用 `attachNarrative`，从 repo 读取最新状态（含 sources/claims/draft 长度）合并写回。不新建表、不发新事件流，复用现有 task 轮询，前端可直接消费。
