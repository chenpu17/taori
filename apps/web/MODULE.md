# apps/web · MODULE

## 定位

 Taori React Renderer，负责聊天、控制中心、模型中心、深度研究工作台、成本可视化与圆桌交互。

## 主要接口

- 通过 `src/api.ts` 调用 Sidecar REST/SSE。
- 通过 `roundtableStream.ts` 消费圆桌 SSE annotation。
- 通过 `sidecar.ts` 获取本地 Sidecar endpoint 与 bearer。

## 拥有状态

- UI 临时状态：当前会话、控制中心分区、模型编辑表单、MCP Server 表单、圆桌流式列状态。
- 不持久化 API Key、MCP env 或业务数据库。

## 依赖

- `packages/shared` 类型。
- `apps/sidecar` 本地 HTTP API。
- Tauri Renderer 环境或浏览器开发环境。

## 当前合同变化

- 控制中心工具页按“搜索 / 内置工具 / 高级 MCP”分区导航展示：搜索设置、其他内置工具、自定义 MCP 配置不再混排成长列表。
- 搜索区把“默认搜索来源”“内置网页搜索引擎”“搏查 API Key”收敛为一组设置；搏查共享凭据同时服务内置搏查搜索与可选的托管 Bridge，不再分别维护两套 Key。
- 模型编辑器新增 `pricing_meta` JSON 编辑。
- 圆桌参与者列新增 `rt.tool_trace` 可视化，并在刷新后保留本轮工具痕迹。
- 聊天消息的“续写”按钮改为调用 Sidecar `POST /v1/runs/:id/continue`，不再追加“请继续上文”这类合成用户消息；若 Sidecar 返回 `cost_confirmation_required`，复用成本确认弹窗并以 `confirmed_cost=true` 二次提交；完成后刷新消息、运行时间线、实时成本和侧边栏。
- 失败决策卡片的“重试 / 切换并重试 / 压缩上下文后重试 / 跳过失败工具继续”改为调用 Sidecar `POST /v1/runs/:id/recover`，前端只负责用户确认、传递目标模型或失败工具名，并刷新视图；恢复动作同样消费服务端成本确认门禁。
- 运行过程的上下文快照卡片消费 Sidecar `context_window` 增量字段，展示本次是否自动裁剪较早历史；聊天发送请求合同不变。
- 圆桌创建成功后会把新建 roundtable conversation 提升为当前会话，使 Run Timeline、会话工具策略和刷新恢复都绑定到同一个会话状态。
- 控制中心工具页消费 Sidecar `GET /v1/tools/health`，在每个工具旁展示最近 24h 调用数、失败数、平均耗时和最近失败分类。
- 控制中心概览页复用 `GET /v1/models/health` 与 `GET /v1/tools/health`，展示模型/工具最近 24h 调用、失败、受影响数量和最近失败分类；仅展示风险，不自动改变默认模型或工具启停。
- 成本看板最近调用日志消费 `GET /v1/costs/calls` 的 run/event 关联字段，展示 Cost ID、Run ID 和运行事件；Run Timeline 的 `cost.recorded` 事件可通过 `cost_record_id` 精确打开并高亮对应成本调用，形成双向反查。
- ModelCenter 打开时不再自动读取 Provider Keychain 状态；Provider 卡片只显示已保存 Key 引用，“检查钥匙串状态”会作为显式用户动作调用 `/v1/providers/key-status?confirm_keychain=1`；测试连接、模型同步或发送消息仍属于用户主动触发的真实 Provider 路径。显式检查后会标出 Key 缺失 Provider，并可直接进入重新填写 Key 的编辑流。
- Help Center 默认“运行自检”只做轻量本地诊断，不读取系统钥匙串；“检查钥匙串”是显式深度检查入口，并提示 macOS 可能弹授权。
- Help Center 新增“真实模型能力诊断”，消费 Sidecar `GET /v1/diagnostics/real-provider/latest`，只展示最近 `verify:real` 本地产物摘要，不主动读取 Keychain、不发起真实模型调用。
- Onboarding 供应商预设新增 PackyAPI / PackyCode 与硅基流动 SiliconFlow；默认 Base URL 来自 `packages/shared` 常量，前端只采集用户输入的 API Key，不持久化或日志输出明文。
- Onboarding 供应商预设新增 DeepSeek 官方；默认 Base URL 来自 `packages/shared` 的 `DEFAULT_DEEPSEEK_BASE_URL`，前端只采集用户输入的 API Key，不持久化或日志输出明文。
- 聊天头部的“模板市场”把内置工作流、已启用 Workflow Recipe 与用户自定义 Prompt 模板统一收敛为本地模板发现入口；支持搜索、预览、按来源筛选，并保持一键套用 / 填写变量后套用闭环。
- Settings 新增全局 thinking 开关（`thinking_enabled`）；ModelCenter 的模型编辑器新增“跟随全局 / 总是开启 / 总是关闭”三态覆盖，并通过 `PATCH /v1/models/:id` 持久化到单模型 `thinking_enabled`。
- standalone 浏览器模式下，Renderer 不再要求预先注入 Bearer 才能工作：`sidecar.ts` 可读取同源 bootstrap，所有普通 REST 与聊天流请求默认携带 `credentials: include`，由 Sidecar 的 HttpOnly cookie 会话完成鉴权；Tauri 与开发环境仍兼容 Bearer 模式。
- 聊天消息内的成本摘要不再只显示 `$`：Renderer 会在消息气泡中直接展示 `in / cache / out` token 指标，并继续保留详情卡与 Run Timeline 的成本明细。
- ModelCenter 的模型矩阵行操作区改为紧凑布局：默认/健康/Tools 使用短文案，编辑/删除改为 icon button，降低表格 padding 与操作区宽度，优先提升同屏信息密度。
- 深度研究 Renderer 改为更接近对话的单列研究流：启动页保留大输入框与最少控制项；进入研究后以“用户请求气泡 + 研究卡片 + 结果卡片”的方式推进，计划预览、执行进度、结果导出与继续追问都收敛在同一列中，证据与风险折叠到次级面板。
- 深度研究任务行会显式展示检索轮次、命中来源数与站点覆盖，帮助用户区分“只搜了一轮”的浅执行和“已经补充检索”的较深执行状态。
- 深度研究任务行会把单个检索分支的空结果展示为“未命中 / 待补证”，并带出已尝试的内置搜索引擎（如 DuckDuckGo / Exa / 搏查）；这类覆盖不足不再等同整场研究失败，报告概览会继续用覆盖成熟度和风险提示提醒用户。
- 当研究目标过宽时，Renderer 会先呈现对话式 scoping 回合，而不是空等计划：用户先补充市场 / 时间 / 重点维度，Taori 再生成计划，交互更接近竞品的计划审批流。
- 深度研究计划卡现在会显式展示方案来源：正常情况下只会出现 `AI 生成`；`fallback` 仅作为历史会话兼容标记展示，当前版本的 AI 规划失败会直接进入失败态并提示重试，不再生成模板计划。
- 深度研究启动栏新增"综合模型"下拉，可独立于聊天默认模型为研究综合 + 引用核查指定模型；空选表示沿用上方"模型"选择。研究执行进入 `stage='drafting'/'verifying'` 时 detail 轮询间隔自动从 2s 降到 1s，配合 Sidecar 流式综合让草稿肉眼可见地逐段出现。
- 深度研究报告区下方新增"引用核查"面板：当 Sidecar 的 CitationAgent 完成 grounding pass 时，逐条展示论断 + 信心评级 + 绑定的来源原文片段（30-300 字逐字摘录）；CitationAgent 不可用或来源不足时面板退化为"使用兜底校验"提示，仍能为用户标明当前结果未经过 span 级核查。
- 深度研究检索任务行会以 `💡 …` 前缀展示 LLM 规划的查询策略（如"先用宽广中文查清主要玩家，再针对前三家查官方定价"），recovery 阶段以 `↻ …` 前缀展示重写思路；这些字段来自 Sidecar `task.output.query_strategy / recovery_strategy`，模板兜底时不展示，让用户能区分"AI 想清楚再搜"vs"按规则套用 query"。subtitle 启用 `white-space: pre-line` 让多行策略 + 命中信息正确换行。
- 深度研究计划预览卡新增 wide→narrow 视觉化：每条 key_question 前缀展示 scope chip（`探查`/`对比`/`深挖`/`核实`，分色），让用户 5 秒看明白 AI 打算"先粗看再细抠"的阶梯；旧版无 scope 字段的计划优雅降级（不渲染 chip）。
- 深度研究计划预览卡新增"预估章节大纲"与"检索策略"两个板块，分别展示 Sidecar 新版 planner 输出的 `expected_outline` 和 `search_strategy`：用户在确认计划前就能看到最终报告会长什么样，以及 AI 打算从哪里入手检索；老 session 没有这两个字段时整块不渲染，无视觉空洞。
- 深度研究执行进度新增"研究叙事"timeline 面板（`<NarrativeTimeline>`）：渲染所有完成/失败任务的 `task.output.narrative`，按时间顺序排列，每条带 HH:MM:SS 时戳 + 按 kind 着色的标签（检索/反思/综合/核验/抓取）；运行中或叙事 ≤8 条时默认展开，老 session 无 narrative 字段时静默不渲染（不退化到 taskDetail，避免与下方"执行步骤"重复）。视觉上提供"AI 现在在做什么、刚发现了什么"的连续叙事，是关闭"执行黑盒感"的最后一块拼图。
- 深度研究报告区新增"段落级追问"affordance：鼠标悬停报告里任意 ≥30 字段落/标题/列表项时，弹出浮动"🔍 追问"按钮（事件委托实现，不修改 markdown DOM）；点击弹 mini composer，输入追问内容后调用 `POST /v1/research/sessions` 创建子研究，objective 自动预填「基于「父研究标题」中提到的"...段落摘录..."，进一步追问：[用户输入]」，并复用父研究的 output_kind/budget/约束/模型选择。让报告从"终点"变成"起点"，无需后端改造。
- 深度研究新增"导出 PDF"按钮：用浏览器原生 `window.print` + `@media print` 样式表（`body.taori-printing-research`），打印时隐藏侧栏/任务列表/计划/timeline/工具栏等，仅渲染报告卡 + 引用核查面板；打印前自动 force-open 报告卡内所有 `<details>`（让引用 span 完整出现在 PDF），打印结束后恢复用户原始展开状态。在 Tauri (Chromium WebView) 与浏览器 standalone 模式下都通过原生"另存为 PDF"对话框输出，避免引入 jsPDF/pdfkit 等重型依赖。
