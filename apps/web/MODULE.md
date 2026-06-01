# apps/web · MODULE

## 定位

Taori Renderer / Web UI。负责桌面端与 standalone browser 的用户界面、流式渲染和交互编排，通过本地 HTTP + Vercel AI SDK Data Stream Protocol 调用 Sidecar。

## 当前状态（2026-05-28 起）

按 `taori-4` 设计稿（织 · 暖纸感 / 衬线主调 / 单列对话）重建 UI：

- 信息架构：左侧 `Sidebar`（按今天 / 昨天 / 本周 / 更早分组的会话列表 + 能力中心 + 设置入口） + 主区域（`EmptyState` / `ChatView` / `FeatureHub` / `SettingsView`）。
- 主流程：流式聊天（`POST /v1/chat`，AI SDK v4 data-stream protocol）、会话列表与历史消息加载。
- ChatView 会在生成中显示“等待首字 / 正在流式输出”，完成后在消息元信息里展示 token、成本、TTFT、总耗时与 TPOT；实时流与历史消息回填都消费同一组 cost annotation 字段。
- P0 对话能力：会话重命名 / 置顶 / 归档 / 删除 / Markdown 导出，用户消息编辑后截断并重跑，按消息创建分支，附件发送（image / pdf / text base64），Composer 内轻量切换下一条消息使用的模型，run timeline 与工具 trace 展示，失败 / 中断 assistant 消息可继续、重试或 compact recovery。
- 模型管理（生产可用，2026-05-29 体验收敛）：以「模型」为中心组织，入口统一为 `AddModelWizard`（已有服务商 / 预设服务商 / 自定义 OpenAI 兼容端口 → 自动发现 → 手动 fallback）。服务商 tab 更名为「服务商」，卡片只保留发现模型 / 测试连接 / 更多菜单；模型列表按服务商分组，行内显示默认 / 可用 / 停用 / 降级 / 临时停用 / 连续失败等状态，重命名、排序、启停、恢复可用状态、删除收纳到菜单。
- P0 设置中心补齐：模型健康刷新、模型探测、默认 / 快速 / 低成本 / 编码推荐（收纳到推荐菜单）、fallback 顺序调整、Provider Key 状态检查与撤销。
- P1 能力中心：在当前单列设计上恢复快速对比、多模型圆桌、深度研究、文件 / 本地上下文搜索、工具管理（内置工具 / MCP）入口；快速对比从模型 checkbox 墙收敛为“选择模型”弹窗（搜索 + 最多勾选 3 个 + 默认 / 跨服务商 / 同名模型快捷组合）+ 2-3 个模型槽位 + 工具开关 + 结果摘要，结果卡会显示模型来源，并区分真实调用与本地预览 fallback。
- 能力编排可见性（2026-05-30）：普通对话消费 `orchestration` annotation，在 assistant 消息下方展示自动联网原因、搜索工具、查询数、预读数和引用要求；当编排判断为 `deep_research_suggest` 时提供「转为深度研究」入口并带入原用户问题。对话顶栏「运行记录」面板读取 `/v1/conversations/:id/run-events`，突出展示 `orchestration.plan`，用于审计“为什么自动联网 / 为什么建议深度研究”。Quick Compare / Roundtable 消费 `qc.orchestration` / `rt.orchestration`，在工具调用列表前展示同款摘要，避免用户只看到搜索结果却不知道为什么触发。
- 偏好：主题（温暖 / 夜色 / 跟随系统）+ 密度（紧凑 / 常规 / 宽松）写入 `localStorage`，无后端依赖。
- 系统原语（2026-05-29 新增）：`Dialog`（替代 `window.prompt` / `confirm`，含 prompt / confirm / alert + Esc 关闭 + 危险态色）、`Toast`（多 toast 队列 + 严重程度 + 自动消失）。`App.tsx` / `SettingsView · 通用` / 三个新面板都已切换。
- 键盘与导航（2026-05-29 新增）：全局快捷键 `⌘/Ctrl+K` 命令面板（`CommandPalette`：搜索命令 / 切换模型 / 跳转对话，↑↓ 选择 · ↵ 执行 · esc 关闭）、`⌘/Ctrl+N` 新对话、`⌘/Ctrl+\` 收起 / 展开侧栏、`Esc` 停止流式输出（无弹层时）；侧栏搜索行内含可点击的 `⌘K` 入口提升可发现性。`App.tsx` 挂全局 keydown，桌面壳内 `⌘N` 可拦截，浏览器内以 `⌘K → 新对话` 兜底。
- 流式跟随（2026-05-29 调整）：`ChatView` 自动滚动从「每次消息变更强制贴底」改为「仅当读者已在底部时跟随」，离开底部即浮出「回到最新」按钮（`jump-to-latest`），切换会话时重置回底部，避免向上回读时被打断。
- 成本表达人性化（2026-05-29）：消息成本从常驻一行工程化串（`input/cache/TTFT/TPOT/price`）改为 `MessageCost` 组件——默认只显示平静主行（成本 · 耗时 · tokens，估算值带「约」），完整明细（输入 / 缓存 / 输出 / 首字 / 每字 / 单价）点击 `message-cost-toggle` 才展开。`.msg-meta` 现仅承载流式实时状态。对应 e2e（chat-flow / visual-verify / visual-journey）已改为断言 `.msg-cost-lead` / 展开后的 `.msg-cost-details`。
- 失败兜底高光（2026-05-29）：失败 / 中断的 assistant 消息从「红框 + 三个并列按钮」改为温和的 `recovery-card`（图标 + 友好标题「这条回复没能完成 / 已停止生成」+ 原因 + 主操作「继续生成」+ 次要「重试 / 精简上下文重试」）。`failure_decision` 注解的 classification 经 `friendlyFailure()`（`chatStream.ts`）映射为人话再 toast。recovery 按钮 testid 保持不变。
- 成本常驻安心感（2026-05-29）：侧栏页脚 `本地工作台` 升级为可点击的「今天 ${today_usd} · 本地」（无数据时回退「本地 · 数据不出端」），旁边保留带文字的「设置」快速入口；消费 `/v1/costs/realtime`，bootstrap 与每次对话 / 恢复完成后刷新，点击成本直达能力中心「成本」tab（`openFeatures('cost')` → `FeatureHub.initialTab`）。
- 操作显隐一致化（2026-05-29）：用户消息的「编辑 / 分支」从常驻改为悬停 / 聚焦浮现（与 AI 消息一致）；触屏设备（`@media (hover: none)`）下两侧操作常驻；空状态建议卡正文限两行省略，避免移动端换行过碎。
- 下拉菜单收起（2026-05-29）：设置页 `.menu-pop`（推荐 ▾ / 模型行 ⋯ / 服务商行 ⋯）选完某项后自动关闭 `<details>`（`closeMenuPopOnSelect`），修复"开着的菜单再点 summary 反被关上"；模型行 `data-testid="model-row-*"` 从 `.name` 子节点上移到 `.model-row-card` 容器，使健康/价格列可被同一行定位，且别名编辑态下 testid 不再丢失。
- 离线与无模型态去硌脚（2026-05-30）：bootstrap 失败页标题由「Sidecar 未连接」改为「本地服务未连接」，副文案不再直出原始 `Failed to fetch`——`describeError()`（`App.tsx`）对网络类错误（Failed to fetch / Load failed / NetworkError 等）统一兜底为「无法连接到本地服务，请确认 Taori 后台进程已启动后重试。」，同时惠及所有走 `describeError` 的 toast。`EmptyState` 在 `noModel` 时把 6 张建议卡灰显（`.suggestions-dimmed`：opacity 0.4 + pointer-events none）并 `disabled` + `aria-hidden`，让「30 秒接入第一个」CTA 成为唯一焦点（输入框在 `noModel` 下本就 disabled）。
- 能力中心新增三个面板（2026-05-29）：
  - **成本（Cost）** — 消费 `/v1/costs/{realtime,breakdown,calls}`，覆盖产品「成本透明」支柱：本月 / 今天 / 本会话三卡 + 按模型 / 特性 / 会话维度柱状分布 + 最近调用 timeline。
  - **模板与人格（Templates & Personas）** — 消费 `/v1/prompt-templates` 与 `/v1/personas`：新建 / 删除 / 查看正文，模板支持 → Composer 注入。
  - **记忆（Memory）** — 消费 `/v1/memories` + `/v1/structured-memories`：global / session KV 写入、结构化记忆启停 / 归档。
- 设置 · 通用页填充：Sidecar 在线状态 / 版本 / Self-check（`/v1/selfcheck`）/ 数据备份导出 + 导入 + 清空（`/v1/admin/*`）。
- ChatView：AI 消息悬浮快捷条（复制 / 重生成 / 分支）。
- EmptyState：续接最近对话入口 + 6 类建议卡（含多模型对比 / 深度研究）。

## 主要接口

已使用的 Sidecar HTTP / SSE API：

- `GET  /health`
- `GET  /v1/conversations`、`GET /v1/conversations/:id/messages`、`PATCH /v1/conversations/:id`、`DELETE /v1/conversations/:id`
- `PATCH /v1/conversations/:id/messages/:messageId`、`POST /v1/conversations/:id/branch`、`GET /v1/conversations/:id/export`、`GET /v1/conversations/:id/run-events`
- `POST /v1/chat`（SSE）
- `GET /v1/runs/:runId/resume-state`、`POST /v1/runs/:runId/continue`（SSE）、`POST /v1/runs/:runId/recover`（SSE）
- `GET  /v1/providers`、`POST /v1/providers`、`PATCH /v1/providers/:id`、`DELETE /v1/providers/:id`
- `POST /v1/providers/test`、`GET /v1/providers/:id/discover`
- `GET /v1/providers/key-status`、`DELETE /v1/providers/:id/key`
- `GET  /v1/models`、`POST /v1/models`、`PATCH /v1/models/:id`、`DELETE /v1/models/:id`、`POST /v1/models/:id/default`、`POST /v1/models/:id/reset-health`
- `GET /v1/models/health`、`POST /v1/models/:id/test`、`POST /v1/models/recommend`、`POST /v1/models/reorder`
- `POST /v1/catalog/sync`（按 Provider 触发价格目录同步）
- `POST /v1/quick-compare`（SSE）、`GET /v1/quick-compare/:id`、`POST /v1/quick-compare/:id/outputs/:outputId/adopt`、`POST /v1/quick-compare/:id/retry`（SSE）
- `POST /v1/roundtable`、`GET /v1/roundtable/:id`、`POST /v1/roundtable/:id/round`（SSE）、`POST /v1/roundtable/:id/summarize`（SSE）、`POST /v1/roundtable/:id/loopback`、`GET /v1/roundtable/:id/export`
- `GET /v1/research/sessions`、`POST /v1/research/sessions`、`GET /v1/research/sessions/:id`、`POST /v1/research/sessions/:id/plan/revise`、`POST /v1/research/sessions/:id/start|pause|resume|cancel|export`
- `POST /v1/files/search`、`GET /v1/files/:id/data`
- `GET /v1/tools`、`GET /v1/tools/health`、`GET /v1/tools/effective`、`PUT /v1/tools/:name/enabled`、`PUT /v1/tools/:name/session-enabled`、`POST /v1/tools/invoke`
- `GET /v1/mcp/servers`、`POST /v1/mcp/servers`、`DELETE /v1/mcp/servers/:id`、`POST /v1/mcp/servers/:id/refresh|restart`、`GET /v1/mcp/servers/:id/runtime`
- `GET /v1/costs/realtime`、`GET /v1/costs/breakdown`、`GET /v1/costs/calls`（新成本面板）
- `GET /v1/prompt-templates`、`POST /v1/prompt-templates`、`DELETE /v1/prompt-templates/:id`（新模板面板）
- `GET /v1/personas`、`POST /v1/personas`、`DELETE /v1/personas/:id`（新人格面板）
- `GET /v1/memories`、`PUT /v1/memories`、`DELETE /v1/memories`、`GET /v1/structured-memories`、`PATCH /v1/structured-memories/:id`、`DELETE /v1/structured-memories/:id`（新记忆面板）
- `GET /v1/selfcheck`（设置 · 通用）
- `GET /v1/admin/export-data`、`POST /v1/admin/import-data`、`POST /v1/admin/clear-all-data`（设置 · 通用「数据」区）

接口合同细节看 `docs/architecture/08-api-contracts.md` + `packages/shared/src/schemas.ts`。

## 拥有状态

Renderer 持有以下临时 UI 状态：

- 当前视图（`empty` / `chat` / `features` / `settings`）、选中会话、当前消息列表、流式输出缓冲、停止流引用。
- Composer 草稿、待发送附件、下一轮编辑重跑的 `skip_user_persist` 标记、最近 run id / conversation id 引用。
- 默认模型选择 / 主题 / 密度（持久化到 `localStorage` 的 `taori.web.prefs.v1`）。
- 设置页草稿（添加模型 wizard、Provider 编辑 dialog、模型别名编辑）。
- FeatureHub 内部草稿与流式状态：Quick Compare 输出缓存、圆桌消息 / 总结缓存、研究计划详情、文件搜索结果、工具与 MCP 列表。
- Provider / Model / Conversation 列表只读缓存。

仍必须遵守：

- 不持久化 API Key（Key 仅在添加模型 wizard / Provider 编辑 dialog 中短暂存活，提交后由 Sidecar 写入本机 Keystore）。
- 业务真相源归属 `apps/sidecar`，Renderer 只持有必要的 UI 临时状态与流式渲染状态。

## 依赖

- `packages/shared` — 复用 `Provider` / `Model` / `HealthResponse` 等类型与枚举。
- `apps/sidecar` — 通过本地 HTTP / SSE 访问业务 API。
- `apps/desktop` — 桌面环境下通过 Tauri 命令 `sidecar_endpoint` 获取 Sidecar URL + Bearer。

## 验收口径

- `pnpm --filter @taori/web typecheck`
- `pnpm --filter @taori/web build`
- `pnpm --filter @taori/web test:e2e`（Playwright，`workers=1`，使用 `e2e/global-setup.ts` 拉起的隔离 Sidecar + 临时 SQLite）

E2E 当前覆盖：
- `e2e/webui-smoke.spec.ts` — 空状态渲染 → 进入设置 → 服务商空 CTA / wizard 入口 → 主题切换闭环
- `e2e/model-management.spec.ts` — 真实模型管理闭环：empty CTA → 添加模型 wizard（Ollama 预设）→ 自动发现失败后手动 fallback → 设为默认 → 别名重命名；覆盖 multimodal 模型作为默认聊天模型时写入 `is_default_for='chat'`
- `e2e/chat-flow.spec.ts` — 真实 `/v1/chat` hermetic 流式闭环：发送消息 → 渲染回复 → 展示成本元信息 → 侧边栏历史加载；覆盖 Composer 模型选择器直接切换下一条消息模型且不跳转设置页
- `e2e/p0-backend-capabilities.spec.ts` — P0 端到端旅程：多轮对话、run timeline、会话重命名 / 置顶、消息编辑截断重跑、分支、附件、Markdown 导出、失败恢复按钮，以及设置中心健康 / 推荐 / 探测 / 排序 / Key 状态。
- `e2e/p1-feature-hub.spec.ts` — P1 多用户旅程：Quick Compare 对比 / 重试 / 采纳，圆桌创建 / 轮次 / 总结 / 回填 / 导出，深度研究创建 / 修订 / 启动 / 暂停 / 恢复 / 取消 / 导出，文件搜索 / 读取，工具调用 / 会话覆盖，MCP 添加 / 运行时 / 刷新 / 删除；另生成能力中心桌面与移动端视觉截图。
- `e2e/visual-verify.spec.ts` — 覆盖 empty、sidebar collapsed、设置三 tab、Provider 编辑 dialog、完成态聊天、capability route、tool trace、编排提示 / 运行记录、暗色主题、密度 comfy 等截图，写入 `test-results/visual/`
- `e2e/visual-journey.spec.ts`（2026-05-29 新增 / 当日扩展）— 29 张端到端用户旅程截图，三个 spec 分工：
  - **journey: bootstrap → configure → chat → … → dark**：单 Provider 配置全链路（01-20）
  - **journey: 多 toast 队列 + dialog 键盘可达**（21-22）
  - **journey: 多 Provider · 多模型 已配置状态**（23-29）— 通过 `seedMultiProviderStack()` 写入 3 个 Provider（OpenAI 兼容 / OpenRouter 聚合 / 本地 Ollama）+ 4 个模型（GPT-4o mini / Claude 3.5 Sonnet / DeepSeek V3 / Qwen 2.5 14B），截图覆盖：composer 默认模型胶囊、设置·模型多卡布局、设置·Provider 三家并列、切换默认模型、快速对比模型槽位、Cost 面板多模型分布、Sidebar 折叠态品牌字。证明多模型路径真的能呈现，而不只是单 Mock Provider 的浅验证。
- 品牌识别字一律 **「织」**（zhī，对应多模型如多线交织）：favicon.svg / `<title>` / Sidebar brand-mark · brand-name / EmptyState greeting-glyph / ChatView avatar-mark。Sidebar 展开态显示「织 Taori / 多模型本地 AI 助手」完整品牌。`apps/web/public/favicon.svg` 是暖纸感 ink 底 + paper 字 + terracotta 描边角点。
