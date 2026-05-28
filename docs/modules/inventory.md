# 模块清单

Status: active（代码已启动，随模块合同持续维护）
Owner: Chenpu
Date: 2026-05-08
Scope: Taori 全系统

## 1. 系统总览

- **系统目标**：BYOK 多模型重度用户的桌面工作编排助手；三条主线：失败兜底 / 成本透明 / 多模型圆桌。
- **核心路径**：用户在 Renderer 输入 → Sidecar 编排 LLM 调用 → 结果流式回 Renderer，全程记录成本与状态到 SQLite。
- **当前阶段**：M0 骨架已落地，核心模块已进入功能迭代；当前真实状态以本文件最近变化、各模块 `MODULE.md`、任务相关 product / architecture spec 与 proposal 为准。

## 2. 模块目录

| 模块 | 一句话定位 | 层级 | 是否独立部署 | 主要接口 | 主要依赖 | 拥有状态 | 邻接模块 | 合同文档 |
|---|---|---|---|---|---|---|---|---|
| `apps/desktop` | Tauri 外壳，承担 OS 能力与 Sidecar 进程托管 | entry | 是（最终安装包入口） | Tauri 命令（`sidecar_endpoint` / `import_clipboard`）；托盘 / 全局快捷键；监听 OS 事件 | `apps/sidecar`（spawn）；OS Keychain；OS 文件系统；系统剪贴板 | Sidecar 进程句柄；Bearer Token（内存）；窗口状态；托盘与快捷键注册；剪贴板导入事件 | `apps/sidecar`（启动/守护）；`apps/web`（命令通道） | `apps/desktop/MODULE.md` |
| `apps/web` | React Renderer，UI 与流式渲染 | entry | 否（嵌在 Tauri 中） | 用户交互；通过 `invoke` 取 Sidecar endpoint | `apps/desktop`（Tauri 命令）；`apps/sidecar`（HTTP+SSE）；`@taori/shared` | UI 状态（Zustand）；会话临时缓存 | `apps/desktop`；`apps/sidecar` | `apps/web/MODULE.md` |
| `apps/sidecar` | 业务编排进程，LLM 调用 / 圆桌 / 数据持久化 | orchestrator | 是（独立 Node 进程，崩可重启） | HTTP REST + SSE on 可配置 `host:port`（desktop 默认 `127.0.0.1`；standalone npm 可显式设 `0.0.0.0`，详见架构 03 与提案 31） | LLM Providers（远程）；SQLite（本地文件）；`@taori/shared` | 全部业务状态：会话、消息、圆桌实例、成本记录、记忆、模型异常计数 | `apps/web`（HTTP 服务方）；`apps/desktop`（被托管） | `apps/sidecar/MODULE.md` |
| `packages/shared` | 前后端共享类型与 Zod schema | infra | 否（library） | 导出类型、schema、常量 | 无运行时依赖 | 无 | `apps/web`；`apps/sidecar` | `packages/shared/MODULE.md` |
| `apps/sidecar/capability-bus` 🔮 | Sidecar 内子模块：工具注册/调度/计费/兜底，承接 Builtin 与 MCP；M2 引入 | orchestrator-internal | 否（Sidecar 内） | `register/list/getToolsFor/invoke` | Vercel AI SDK；MCP SDK（M3） | 工具注册表；MCP 子进程句柄；健康状态 | `apps/sidecar`（宿主）；`packages/shared`（Tool schema） | M2 建立合同（设计见 [架构 09](../architecture/09-agent-and-tools.md)） |

## 3. 关键协作关系

- `apps/desktop` → `apps/sidecar`：Tauri 启动时 spawn Node 进程，通过 stdout 接收 `READY {port} {token}`，崩溃时重启
- `apps/desktop` ↔ `apps/web`：Tauri 命令通道，仅传递控制元信息（endpoint、文件 base64）；**绝不传 LLM 流**
- `apps/desktop` → `apps/web`：托盘菜单 / 全局快捷键通过 `taori:desktop-action` 事件桥接到 Renderer，驱动“新对话 / 打开设置 / 使用帮助 / 导入剪贴板”等 UI 动作
- `apps/web` → `apps/sidecar`：本地 HTTP + SSE，Bearer Token 鉴权；所有 LLM 流式数据走这条
- standalone npm CLI → `apps/sidecar`：支持前台启动与单用户单实例 daemon 生命周期（state/log 文件位于 `~/.taori/`）；远程 browser-first 部署可显式监听 `0.0.0.0`，并在 npm 包内直接同源托管登录页 + Web UI，浏览器侧通过访问密码换取 HttpOnly cookie 会话
- `apps/sidecar` → LLM Providers：通过 Vercel AI SDK 出站，带用户的 API Key（运行时从 Keychain 经 Tauri 命令拉取）
- `apps/sidecar` → SQLite：进程内同步访问（better-sqlite3）

## 4. 高风险模块

| 模块 | 风险点 |
|---|---|
| `apps/sidecar` | 拥有几乎全部业务状态；任何合同变化都会扩散到 web/desktop。公共 API、数据归属或运行语义变化必须同步更新 `apps/sidecar/MODULE.md` 与本清单 |
| `apps/desktop` | Sidecar 生命周期管理、Keychain 操作、CSP 配置；安全攻击面集中在此 |
| `apps/sidecar` prompt 相关子模块 | 元 Prompt 改动直接影响圆桌、研究、记忆抽取质量与成本；变更应有版本记录 |

## 5. 最近变化

- 2026-05-27 [模块合同收敛 / Web 主壳拆分]：
  - `docs/modules` / `docs/architecture`：移除当前不存在的 `packages/prompts` 活动模块记录，改为未来可拆分包说明；Sidecar 当前仅依赖 `@taori/shared`
  - `apps/web`：从 `App.tsx` 拆出 `Sidebar.tsx`、`Composer.tsx`、`attachments.ts`、`chatStream.ts`、`markdown.tsx`，并从 `surfaces.tsx` 拆出 `DrawerProviders.tsx`、`DrawerModels.tsx`、`providerDisplay.ts`，降低主壳与 Drawer 聚合文件职责密度；公共 HTTP/SSE 合同不变
  - `apps/sidecar`：从 `db/repos/index.ts` 抽出 Provider/Model mapper 到 `db/repos/mappers.ts`，从 deep research runner 抽出 lifecycle helper 到 `research/lifecycle.ts`；数据库、HTTP 与研究状态机合同不变
  - `apps/web/MODULE.md`：更新真实 Drawer 能力描述，Tools、Templates / Persona、Settings 不再标为“暂无 API”
- 2026-05-27 [审核修复批次]：
  - `apps/sidecar`：`RunEventsRepo.appendSafe` 统一 chat / roundtable run event FK 降级写入；`server.ts` 收敛请求体大小常量、Standalone cookie 解码容错与 Bearer/Cookie 授权分支；`ModelsRepo.update/patchPricing` 用 `pickDefined` 降低重复更新样板
  - `apps/sidecar`：新增 `chat/protocol.ts` 集中 Data Stream Protocol 写帧，新增 `standalone/login-page.ts` 抽离浏览器登录 HTML，并把测试控制位集中到 `config.testHooks`，减少业务路由直接读取测试环境变量
  - `packages/shared`：`ChatRequestSchema.messages` 增加 200 条消息与单条 200KB 上限，避免异常请求在 Sidecar 预算估算和上游消息组装阶段放大内存
  - `apps/sidecar/test`：补充聊天请求消息数量与单条长度超限回归用例
- 2026-05-23 [Provider 连接测试修复]：
  - `packages/shared`：`ProviderTestRequestSchema` 扩展为 union，允许 Renderer 用 `{ provider_id }` 直接测试已保存 Provider，也保留 `{ type, base_url, api_key? }` 的临时测试合同
  - `apps/sidecar`：`POST /v1/providers/test` 新增 `provider_id` 路径，会读取本地 provider 配置和 keystore 中的 key，再返回结构化 `classification + message`
  - `apps/web`：Provider 详情页“测试连接”改走 typed helper，并把失败 toast 从“未知错误”改为展示真实分类与消息
  - `apps/sidecar/test`：补充 saved provider 直测回归用例
- 2026-05-11 [聊天成本 / ModelCenter / 深度研究]：
  - `apps/sidecar`：聊天成本链路新增 `cache_input_tokens`，`cost_records`、`cost.recorded` 与 `/v1/costs/calls` 可透出输入 / cache / 输出 token 明细
  - `apps/web`：聊天消息把 token 指标直接显示在 `$` 附近；ModelCenter 模型矩阵操作区做紧凑化整理，缩短高频按钮文案并收敛编辑/删除为 icon button；Control Center 新增“深度研究”工作台入口
  - `apps/sidecar` / `packages/shared`：深度研究第一切片已落地，新增 `research_sessions / tasks / sources / claims` contract、SQLite 持久化、确定性 planner 与 `/v1/research/sessions*` 资源路由
  - `docs/product` / `docs/architecture`：新增深度研究方案，并完成首批实现收口，明确其与普通聊天 / Workflow Recipe / Roundtable / 轻量 RAG 的边界，以及状态机、持久化、预算与引用校验设计
- 2026-05-11 [深度研究交互再收敛]：
  - `apps/web`：深度研究 UI 从三栏工作台继续收敛为更接近 OpenAI 的单列对话式研究流：启动页保留大输入框；进入研究后用“用户请求气泡 + 研究卡片 + 结果卡片”推进，计划、进度、导出与继续追问集中在同一列，证据与风险折叠进次级面板
  - `apps/web/e2e`：`research-center.spec.ts` 改为覆盖“计划预览 → 确认执行 → 单列研究流 → 暂停/恢复/导出/取消”主路径
- 2026-05-12 [深度研究执行加深]：
  - `apps/sidecar`：Research runner 改为按预算进行多轮自适应检索；单题不再只打一条 query，而会补充官方/第三方视角，直到来源数与站点覆盖达标后再综合；source metadata 同步保留 `question_ids` 以支持一份证据服务多个研究问题
  - `apps/web`：研究任务行新增“检索轮次 / 站点覆盖 / 命中来源”显示，让用户能直接感知当前研究是否真的做了更深的搜索
  - `apps/sidecar/test`：新增对 deep budget 多轮检索的回归覆盖
- 2026-05-12 [深度研究 scoping 闭环]：
  - `apps/sidecar`：对“市场格局 / 主要玩家 / 行业趋势”这类宽泛选题，创建 session 后会先进入 `scoping` 阶段，主动追问地区、时间范围和重点维度，再基于补充信息生成计划
  - `apps/web`：reviewing 且无 plan 时不再只有“AI 正在规划中…”，而是可直接回复补充信息的对话式 scoping 卡片；计划卡指标也新增来源站点数和已验证主张数
  - `apps/web/e2e` / `apps/sidecar/test`：补充 scoping → 计划 → 执行主路径回归
- 2026-05-14 [深度研究计划来源透明化]：
  - `packages/shared`：`ResearchSessionSchema` 新增 `plan_origin`，显式区分 `pending / ai / fallback`
  - `apps/sidecar`：当前版本的研究计划生成只会写入 `pending / ai`；`fallback` 仅保留给历史会话兼容，AI 规划在有限重试后直接失败
  - `apps/web`：研究计划卡会明确显示 AI 生成状态；若读到历史 `fallback` 数据，也会按“旧版兜底计划”提示，避免误判
- 2026-05-14 [深度研究多引擎补救]：
  - `apps/sidecar`：deep research 使用 `builtin.web_search` 时不再只押单一引擎，而会显式尝试“当前配置引擎 → Exa → 搏查（有 Key 时）”的补救梯子，并把 `engine_attempts` 写入 task output
  - `apps/web`：研究任务失败文案会显示已尝试的引擎，用户可以直接判断 Exa / 搏查是否真的参与过本轮补搜
- 2026-05-18 [深度研究覆盖容错]：
  - `apps/sidecar`：单个检索分支多轮补救后仍没有可用来源时，不再直接失败整条任务；Runner 记录 `coverage_status='no_usable_sources'`、失败原因、query 与引擎尝试，并继续基于已有证据综合。只有整场研究没有任何来源时才在草稿前暂停
  - `apps/web`：研究任务行把这种空结果显示为“未命中 / 待补证”，报告概览继续通过覆盖成熟度、风险与弱证据提示表达不确定性
- 2026-05-10 [thinking 配置]：新增“全局默认 + 单模型覆盖”的模型 thinking 开关：
  - `packages/shared`：`Model*` / backup contract 新增 `thinking_enabled: boolean | null`
  - `apps/sidecar`：`models.thinking_enabled` 落库，并在聊天、Quick Compare、Roundtable、自动记忆抽取与模型探测中统一解析；当前按 provider 差异适配 OpenRouter `reasoning`、DeepSeek `thinking`、GPT-5/o 系列 `reasoning_effort`
  - `apps/web`：Settings 新增全局 thinking 开关；ModelCenter 编辑器新增“跟随全局 / 总是开启 / 总是关闭”
- 2026-04-27 [全系统]：完成 v0.5 产品设计 + 技术架构定稿；文档拆分为 `docs/product/` 与 `docs/architecture/`；引入 my-spec 灰盒治理框架
- 2026-04-27 [产品规则]：失败兜底从"24h 失败 3 次禁用"改为"渐进式降权（≥3 降权 / ≥5 禁用 / content_filter 不计入）"
- 2026-04-27 [合同修订]：根据外部评审修复 10 项一致性问题，开发团队可据此进入 M0：
  - SSE 协议统一为 Vercel AI SDK Data Stream Protocol（删除自定义 `event: chunk/meta/done/error`）
  - API Key 安全表述改为"Renderer 不持久化、不日志、不外发"（不再承诺"永远看不到"）
  - Sidecar↔Tauri Rust 控制通道列出三方案，**默认方案 A（127.0.0.1 + Bearer 的本地 HTTP）**，M0 第一周验收
  - 新增 `files` 表（数据库 8 → 9 表）；attachments JSON 改为 `{file_id, type, mime, filename, size_bytes}`
  - cost_records / messages / files 的 nullable 与级联策略写入 schema 与"删除/可空性策略汇总"
  - 模型 ID 全部 `mdl_` + nanoid(12)，新增 `alias` 字段；所有示例 ID 改为内部格式
  - cost_records 用 `source_type + source_id` 替代 `message_id` 单 FK
  - M1 价值闭环表述与 M1 spec 对齐："推荐换模型"明确归属 M2
  - 成本能力 L1-L6 标注引入版本，去除"MVP 必含"歧义
- 2026-04-27 [合同修订-补丁]：第二轮评审修复 5 项一致性问题：
  - `03-process-and-ipc` 流式实现要点改成 Data Stream Protocol（移除 `reply.raw.write(data:...\\n\\n)` 与 `:keepalive`）；新增 useChat 注入业务字段说明
  - `08-api-contracts` 错误流注释改为"M1 不渲染换模型按钮，仅展示分类+重试"，与 M1 spec 一致
  - Sidecar↔Tauri Rust 控制通道升级为 **M0 第一验收点**，明确 M1 不能在通路未验收前冻结
  - `05-security` 删除"暴露 Tauri 命令给 Sidecar"旧表述；攻击面表 API Key 表述与新口径对齐
  - `04-data-and-storage` 表编号顺延为 1-9（files 后顺延 roundtables/roundtable_messages/cost_records/memories）
- 2026-04-27 [v0.6 增量]：新增 `docs/product/09-agent-and-tools.md` 与 `docs/architecture/09-agent-and-tools.md`，定稿 Agent 与工具体系：
  - **不引入第三方 Agent 框架**（LangGraph / CrewAI / Mastra / OpenAI Agents SDK 全部排除）；Sidecar 自建轻量 **Capability Bus**，基于 Vercel AI SDK `streamText({ tools })`
  - 三类工具体系：**内置（M2）/ MCP 桥（M3 本地 stdio）/ 圆桌作为原生 Agent（M3）**
  - cost_records 的 `source_type` 预留 `'tool_call'`（M1 schema 已包含，M2 不需 migration）
  - MCP 仅支持本地 stdio / 127.0.0.1 HTTP，远程 MCP 留给 v2
  - 工具失败统一进 `classifyToolError`，与 LLM 兜底共用 UI 体验
  - 注册新模块 `apps/sidecar/capability-bus`（M2 建立合同，灰盒下钻）
- 2026-04-30 [C3]：实现 Prompt 模板与 Persona 预设：
  - Sidecar 新增资源路由：`/v1/prompt-templates`、`/v1/personas`
  - `/v1/chat` 扩展可选 `persona_id`，并在 sidecar 上游请求中注入 system prompt
  - SQLite 新增 `prompt_templates`、`personas` 两张表；会话绑定复用 `memories(scope='session', key='active_persona_id')`
  - Renderer 设置页新增模板/Persona 管理；聊天头部新增模板套用与 Persona 绑定入口
- 2026-05-08 [standalone]：npm standalone sidecar 新增 daemon 生命周期与可配置 bind host：
  - CLI 新增 `taori daemon start|status|stop`
  - standalone 仍默认监听 `127.0.0.1`，但远程 / browser-first 部署可显式传 `--host 0.0.0.0`
  - daemon 状态文件 / 日志位于 `~/.taori/taori-daemon.json`、`~/.taori/taori-daemon.log`
- 2026-05-11 [standalone browser]：npm standalone 新增浏览器登录页与同源 Web UI：
  - CLI 新增 `--password`，用于设置浏览器访问密码
  - Sidecar 在 standalone + `dist-web` 存在时直接提供 `/` 登录页与 `/app` Web UI
  - 浏览器登录成功后由 Sidecar 下发 HttpOnly cookie；脚本调用仍可继续使用 Bearer Token
- 2026-04-27 [评审 R3 微调]：通过第三轮评审，进入 M0 前的最后一批文字一致性修复：
  - `01-overview.md` 关键设计原则 1：Keychain 转写改为"通过 Sidecar↔Rust 控制通道"（不再写 Tauri 命令）
  - `02-tech-stack.md` 为什么业务跑在 Sidecar：去掉"API Key 不进入渲染进程"，改成与 05-security 一致的"短暂持有 / 不持久化 / 不日志 / 不外发"
  - `03-process-and-ipc.md` 反向调用场景修正为"三类"（Keychain 写、Keychain 读、本地文件读）
  - M2 已在 `07-mvp-roadmap.md` 显式引用 09-agent-and-tools.md（v0.6 增量时即已落地）
- 2026-04-27 [评审 R4 修订]：第四轮 5 视角评审（用户/产品/设计/开发/测试）+ subagent 二次确认，定稿后进入 M0 实施：
  - **[开发 P1]** Sidecar 打包：`bun build --compile` 与 better-sqlite3 兼容性风险被低估；改为 **Node SEA + esbuild bundle 首选**，bun compile 列为备选并标注 native 模块风险，M0 spike 必须验收（`docs/architecture/06-build-and-package.md`、`02-tech-stack.md`）
  - **[开发 P1]** Vercel AI SDK 协议表述软化：删除硬钉的 part code/响应方法名，改为"M0 spike 锁定主版本后回写"；只保留事件层逻辑契约（`docs/architecture/03-process-and-ipc.md`、`08-api-contracts.md` §7、§12）
  - **[开发 P2]** Sidecar↔Tauri Rust 控制通道方案 A 显式选 **axum** crate（5 端点）（`docs/architecture/03-process-and-ipc.md`）
  - **[开发 P2]** /v1/chat 中 `attachments[].file_id` → Sidecar 加载 `files` 表并组装 multimodal 的实现规则补完整（`docs/architecture/08-api-contracts.md` §7）
  - **[开发 P2]** 包名 scope 全部统一 **`@taori/*`**（不再混用 `@app/*` `@shared/*` `@prompts/*`）（`docs/architecture/07-repo-structure.md`、`06-build-and-package.md`、`docs/modules/inventory.md`）
  - **[测试 P2]** §11 错误码总表拆为两小节，明确 `code`（HTTP/系统）vs `classification`（业务 5 类）的关系（`docs/architecture/08-api-contracts.md` §11）
  - **[开发 P3]** `cost_records.actual_cost_usd` 显式 nullable；`models` 表加 `UNIQUE(provider_id, model_name)` 约束；schema 表头注明 TS/Drizzle 概念类型 vs SQLite storage class 的映射（`docs/architecture/04-data-and-storage.md`）
  - **[开发 P3]** §12 实现备忘新增 `classifyProviderError` 强制脱敏要求（剥离 Key/Authorization/URL query；message ≤200 字符）（`docs/architecture/08-api-contracts.md` §12）
  - **[用户/产品/设计/测试]** M1 spec 修订：清空数据按钮归属、image capability 范围、底部状态栏补"本月"、onboarding 步数定义、信息架构图脚注、测试金字塔与覆盖目标、性能预算注明 macOS arm64 基线、Linux 范围声明（`docs/product/08-m1-spec.md`、`docs/product/02-core-features.md`）

## 6. 待补充

- [x] 核心模块 `MODULE.md` 已建立：`apps/desktop` / `apps/web` / `apps/sidecar` / `packages/shared`
- [ ] `apps/sidecar` 详细的内部子模块（providers / orchestration / cost / db / memory / capability-bus / mcp / roundtable）—— 按任务需要灰盒下钻
- [ ] Prompt 模板若未来从 `apps/sidecar` 拆成独立 `packages/prompts`，再补建包、合同与本清单条目；当前 workspace 不存在该包
- [ ] 部署语义（自动更新机制激活后再补）

## 7. M2 完工记录

M2（失败兜底 / 成本透明 / 多模型协作 / 工具体系基础）已实现：

- `apps/sidecar/capability-bus`（builtin 工具注册 + 调用 + 计费 + 错误分类）落地：`src/bus/{registry,index}.ts`、`src/bus/builtins/image_generate.ts`
- 新增 Sidecar 路由：`/v1/tools/invoke`（POST，invoke 工具并写 cost_records）、`/v1/costs/breakdown`、`/v1/costs/realtime`、`/v1/memories/effective`（三级有效值解析）
- `/v1/chat` 支持 `failure_decision` annotation（`8:[{...}]` 在 `3:provider_error/<class>` 之前）+ `capability_route` annotation（图像意图 fast-path，含 `conversation_id`）
- 安全硬化：`packages/shared/src/tools.ts` 的 `ToolInvokeRequestSchema` 对 `conversation_id` / `source_message_id` 应用 `/^[A-Za-z0-9_-]+$/`+`.nullable().optional()`；`image_generate` 内做 conversation 存在性 defense-in-depth 校验
- Renderer：`apps/web/src/App.tsx` 接入 capability_route fast-path（`failureFetch` tee）、ImagePicker、CostConfirmDialog 在图像 picker submit 路径上的 gate（disabled_models / disabled_conversations / image_always）、session memory 命中时自动跳过 picker（spec §7 step 7）
- 测试覆盖：sidecar vitest 66 项；Playwright e2e 37 项（含 m2.1 / m2.2 / m2.4 / m2.5 DoD 跨步骤）

## 8. M2 合同变化

- `apps/sidecar`：新增 `/v1/tools/*`、`/v1/costs/*`、`/v1/memories/effective` 路由对外契约；新增内部子模块 `capability-bus`（合同将在 M3 灰盒下钻时建立 MODULE.md）
- `apps/web`：新增渲染路径（capability_route fast-path → image picker → cost-confirm gate → invokeTool）
- `packages/shared`：`ToolInvokeRequestSchema` 加入 id 格式约束；`FailureDecisionAnnotation`、`CapabilityRouteAnnotation` 类型定型
- 数据：复用 M1 schema，无 migration（`cost_records.source_type='tool_call'` 已在 M1 预留）

## 9. M2.5 完工记录（v0.7）

M2.5（Model Center / Price Catalog / Volcengine Ark）已实现：

- 新增 sidecar 子模块 `apps/sidecar/src/catalog`：`syncCatalog()` 调度 + diff，挂在路由 `POST /v1/catalog/sync`；启动时 async 同步一次，每 24h 周期；详见 [架构 10](../architecture/10-catalog-and-ark.md)
- 新增 sidecar Provider 适配器 `apps/sidecar/src/providers/volcengine_ark.ts`（doubao chat/vision、wan 图像、seedance 视频；内置 ARK_FAMILIES 价格表，CNY→USD）
- 新增 renderer 顶级页面 `apps/web/src/ModelCenter.tsx`：Provider chips + 能力 tab + 矩阵表 + ImportDrawer + sync diff 折叠面板（取代旧 Settings 中的模型管理 UI）
- `apps/web/src/Settings.tsx` 精简：仅保留 AutoFallback / "重新打开 Onboarding" / DangerZone
- `packages/shared`：`PROVIDER_TYPES` += `volcengine_ark`；`MODEL_CAPABILITIES` += `multimodal`；Model schema 增加 `modalities[] / price_per_call / price_per_image / price_per_video_second / price_synced_at`
- 价格同步不变量：`patchPricing` 始终刷新 `price_synced_at`（即便 patch 为空），用户字段（alias 等）始终保留，per-provider 错误隔离
- 测试：`apps/sidecar/test/m2-5-catalog-sync.test.ts`（2 用例：价格 diff 持久化 + 错误隔离），sidecar 105/105 passing
- E2E 覆盖：新增 `apps/web/e2e/m2.5-modelcenter.spec.ts` / `m2.5-volcengine-ark.spec.ts` / `m2.5-catalog-sync-ui.spec.ts`；既有 `m1.6-settings` / `m1.8-dod-final` / `r3.1-mc3-reorder` / `r5-user-journey` / `r5-demoted-badge` 全量迁移到 ModelCenter testid（model-row-* / provider-chip-test-* / model-center-tab-* 等）；Playwright 72/72 passing。详见 [架构 11 · QA 策略](../architecture/11-qa-strategy.md)
- ModelCenter 新增的可测能力：`provider-chip-test-{id}`（沿用 `/v1/models/:id/test` 探活）、`model-row-up/down-{id}`（fallback_order ▲/▼）、`model-row-default-{id}`（设为默认）、`model-demoted-{id}`（⚠️ 自动降级徽章）

## 10. M2.5 合同变化

- `apps/sidecar`：新增 `/v1/catalog/sync` 路由；`/v1/providers` 接受 `type=volcengine_ark`；`/v1/providers/:id/discover` 对 ARK Provider 返回 ARK_FAMILIES
- `apps/web`：信息架构变化 — Settings 不再承载模型管理；🧬 顶部按钮打开 ModelCenter overlay
- `packages/shared`：常量与 Model schema 扩展（向后兼容；旧字段不变）
- 数据：M2.5 期间未做新 SQL migration（依赖 M1/M2 已有列；Ark 价格在内存常量中）

## 10.1 v0.7 polish（用户验收第二轮）

- `packages/shared`：`ModelUpdateSchema` 扩展为可手动编辑全部字段（capability / supports_* / 5 类价格字段 / modalities / context_length / price_currency），`Model.alias` 仍可空但编辑器有 fallback；`ModelsRepo.update` 镜像同步落库
- `apps/web/src/Onboarding.tsx`：`finishWithModel` 不再硬编码 `capability='chat'`，按候选自身能力创建模型；非 chat/multimodal 候选不能被设为默认聊天；候选项 UI 加能力徽章 + 图像/视频价格提示。修复"火山方舟图像/视频模型被错误导入为 chat"
- `apps/web/src/ModelCenter.tsx`：每行新增"编辑"按钮（testid `model-edit-{id}`）打开 `EditModelDialog`：可改 alias / display_name / capability / supports_vision/tools / 5 类价格 / 币种；切换 capability 时自动清理 stale `is_default_for`，并显示警告
- 计费形态覆盖：chat/multimodal/embedding → 输入+输出/1M token；image → 每张；video → 每秒；asr/tts/其他 → 每次。复杂分级（按分辨率 / 时长档位）记入 v0.8 `pricing_meta` JSON
- E2E：新增 `apps/web/e2e/m2.5-model-editor.spec.ts`（chat→image 改能力 + 设 per-image 价 + 验证 is_default_for 清空），Playwright 73/73 passing

## 10.2 C3 完工记录（v0.8）

C3（Prompt 模板 & Persona 预设）已实现：

- `apps/sidecar`：新增 `src/routes/templates-personas.ts`；新增 repo `PromptTemplatesRepo` / `PersonasRepo`
- `packages/shared`：新增 `PromptTemplate*` / `Persona*` schema 与 `ChatRequest.persona_id`
- 数据：SQLite 新增 `prompt_templates` / `personas`，无破坏式迁移；会话 Persona 绑定复用 `memories`
- 首次读取 `/v1/personas` 且 Persona 表为空时，Sidecar 会自动创建一个“架构评审助手”示例 Persona，作为用户配置参考；用户删除后不会反复重建，接口返回结构不变
- `apps/web`：`Settings.tsx` 新增模板/Persona 管理；`App.tsx` 聊天头部新增模板选择器与 Persona 下拉；模板支持 `{{变量}}` 填空
- 验证：sidecar `c3-templates-personas.test.ts` 通过；Playwright `c3-templates-personas.spec.ts` 通过

## 10.3 C3 合同变化

- `apps/sidecar`
  - 新增 `/v1/prompt-templates`、`/v1/personas` 路由
  - `/v1/chat` 新增可选字段 `persona_id`
- `apps/web`
  - 新增聊天阶段的模板套用与会话 Persona 绑定交互
- `packages/shared`
  - 新增模板/Persona contract
- 数据
  - 新增两张业务表；`memories` 新增约定键 `active_persona_id`

## 10.12 Model 管理增强（v0.8 polish）

- `apps/web/src/ModelCenter.tsx`：模型中心拆成“已管理模型工作台 + 供应商模型库抽屉”。工作台支持按 Provider / 状态 / 特性 / 关键字筛选与按优先级 / 名称 / 价格 / 上下文排序，选择当前筛选结果后批量启用或停用；Provider chip 显示已管理 / 启用 / 停用数量，主操作保留模型库，编辑 / 同步 / 测试 / 删除收敛到更多菜单。
- `apps/web/src/ModelCenter.tsx`：供应商模型库支持刷新 discovery 清单，按未管理 / 已启用 / 已停用筛选；已管理模型可在抽屉内直接启停，未管理候选可选择“导入后立即启用”。
- `apps/web/src/ModelCenter.tsx`：Provider chip 新增编辑与单 Provider 同步入口。编辑弹窗复用既有 `PATCH /v1/providers/:id` 合同，支持改名称 / Base URL / API Key / 启停；单 Provider 同步复用 `POST /v1/catalog/sync { provider_id }`。
- `apps/web/src/ModelCenter.tsx`：供应商模型库刷新后会对比已管理模型与 discovery 清单，标记并预览价格 / 能力 / 上下文 / 工具视觉支持差异，并可一键同步已管理模型元数据。
- `packages/shared`：`ModelCreateSchema` 新增可选 `enabled`，支持导入模型但暂不启用。
- `apps/sidecar`：创建模型时 `enabled` 默认 `true`；停用默认模型会自动清理 `is_default_for`；停用模型不能被设为默认模型。
- 验证：`apps/web/e2e/m2.5-modelcenter.spec.ts` 覆盖模型库刷新、批量启用、停用导入、抽屉内启用、Provider 编辑与单 Provider 价格同步；`apps/sidecar/test/providers.test.ts` 覆盖停用默认绑定清理与停用默认拒绝。

## 10.13 MCP / Pricing Meta / 圆桌工具（v0.9）

- `packages/shared`：新增 `PricingMetaSchema`、`McpServer*` schema、`mcp_server` ID 前缀；`ModelCreate/Update/DiscoveredModel/BackupModel` 扩展 `pricing_meta`；`RoundtableAnnotation` 新增 `rt.tool_trace`。
- `apps/sidecar`：新增 `mcp_servers` 表、`src/mcp` stdio JSON-RPC 客户端、`/v1/mcp/servers*` 路由；Capability Bus 支持按 MCP Server 替换注册工具；admin clear 会清除 MCP 配置和 Bus 中的 MCP 工具。
- `apps/sidecar`：`models.pricing_meta` additive migration 落地；`ModelsRepo.create/update/patchPricing` 支持复杂价格元数据。

## 10.14 Agent Runtime D4 健康视图

- `apps/sidecar`：新增 `GET /v1/tools/health`，基于 `cost_records(source_type='tool_call')` 汇总 Capability Bus 当前工具最近 24h 调用数、失败数、平均耗时和最近失败分类；工具调用失败会把 `validation_error` / `permission_denied` / `tool_timeout` / `mcp_crashed` 等分类写入成本记录。
- `apps/web`：控制中心概览页展示模型/工具最近 24h 健康摘要；控制中心工具页在每个工具卡片内展示工具健康条；模型健康继续复用 ModelCenter 的 `/v1/models/health` 面板。
- `packages/shared`：新增 `ToolHealthRowSchema` / `ToolHealthRow`，作为 `/v1/tools/health` 前后端合同。
- `apps/sidecar`：圆桌 `round-runner` 为支持 tools 的参与者注入内置 web 工具和 MCP 工具，流式输出 `rt.tool_trace`。
- `apps/web`：控制中心工具页新增 MCP Server 添加/刷新/启停/删除；模型编辑器新增 `pricing_meta` JSON 编辑；圆桌列内展示工具调用痕迹并在回合刷新后保留。
- 合同文档：新增 `apps/sidecar/MODULE.md`、`apps/web/MODULE.md`、`packages/shared/MODULE.md`。
- 验证：`apps/sidecar/test/mcp-pricing-meta.test.ts` 覆盖 MCP stdio 刷新/调用和 `pricing_meta` 持久化；`apps/web/e2e/mcp-pricing-roundtable-tools.spec.ts` 覆盖真实 Web UI 的 MCP 添加、模型复杂价格编辑、圆桌 MCP 工具痕迹。

## 10.14 v1.0 Agent Runtime 计划

下一阶段聚焦 Run Timeline、Agent Run 状态机、恢复动作和真实模型验证：

- `packages/shared`：新增 run status / run event / recovery action 合同。
- `apps/sidecar`：拥有 run 生命周期真相，负责事件写入、停止/续写、retry/fallback/skip-tool 恢复策略、成本归因和 FK 降级。
- `apps/web`：新增运行过程侧栏、消息级续写/继续解决入口、恢复确认 UI、模型/工具健康展示。
- `apps/sidecar/capability-bus`：工具调用接收 `run_id`，写入工具生命周期事件，失败进入统一恢复候选。
- `scripts/verify-real-journey.mjs`：新增 agent-runtime 真实模型用户旅程；真实 Provider 失败需输出结构化 failure artifact。
- 模块映射详见 [v1-agent-runtime-mapping.md](./v1-agent-runtime-mapping.md)，架构提案详见 [19-agent-runtime-v1-proposal.md](../architecture/19-agent-runtime-v1-proposal.md)。

## 10.15 MCP 聊天链路修复

- `apps/sidecar`：Capability Bus 新增 AI SDK tools 转换入口，普通 `/v1/chat` 不再只暴露 image/web builtin；会话有效、全局启用且模型支持 tools 时，`mcp.*` 工具会动态注入上游模型。
- `apps/sidecar`：MCP stdio client 从每次调用临时 spawn 改为按 server 配置复用已初始化 session；server 更新、删除、进程崩溃或请求超时时会关闭并移除池内 session。
- `apps/sidecar`：MCP server 返回的基础 JSON Schema 会转换为 Zod schema，用于 Capability Bus 调用前校验；MCP 超时归类为 `tool_timeout`，进程退出/启动失败归类为 `mcp_crashed`。
- 验证：`pnpm --filter @taori/sidecar typecheck` 通过；`pnpm test:sidecar` 27 文件 / 186 测试通过。

## 10.16 托管搜索工具与默认搜索（v1.0）

- `apps/sidecar`
  - 新增托管远程搜索桥接语义：`mcp_servers` 中可保存“搏查搜索”这类受控配置，运行时由 sidecar 解析成内部 proxy 命令，不再要求 Renderer 暴露 `npx mcp-remote`。
  - 新增全局记忆键 `default_search_tool`；普通聊天、Quick Compare 与 Roundtable 在构建工具目录时只保留一个首选搜索工具，首选不可用时自动回退到 `builtin.web_search` 或当前首个可用搜索工具。
- `apps/web`
  - 控制中心工具页改为“搜索 / 内置工具 / 高级 MCP”分区导航，避免把搜索、普通工具与自定义 bridge 挤在同一长列表里。
  - 搜索区收敛“默认搜索来源 + 内置搜索引擎 + 搏查共享凭据”；搏查 API Key 同时服务内置搏查搜索与可选托管 Bridge，避免两套配置彼此打架。
- 架构提案
  - 详见 `docs/architecture/32-managed-search-tools-proposal.md`
- 验证
  - Sidecar：`managed-mcp.test.ts`、`upstream-tools.test.ts`
  - Web：`p2-mcp-management.spec.ts`

## 10.16 P3 桌面壳入口（v0.10）

- `apps/desktop/src-tauri`：新增托盘菜单、托盘点击切换窗口可见性、主窗口关闭时隐藏到托盘而非直接退出。
- `apps/desktop/src-tauri`：新增全局快捷键 `CmdOrCtrl+Shift+Space`（显示/隐藏 Taori）与 `CmdOrCtrl+Shift+N`（新对话）。
- `apps/web/src/App.tsx`：监听 `tauri:desktop-action`，把桌面动作转换为 Renderer 内的“新对话 / 打开设置 / 使用帮助”操作。
- `scripts/verify-desktop-ui.mjs`：通过 debug automation channel 触发 desktop action，验证桌面壳到 WebView 的事件桥接。

## 10.17 P3 剪贴板 / 截图入口（v0.10）

- `apps/desktop/src-tauri`：新增托盘菜单项与全局快捷键 `CmdOrCtrl+Shift+V`，读取系统剪贴板后通过 `taori:desktop-action` 把文本 / 图片载荷下发给 Renderer；同时暴露 `import_clipboard` Tauri command 供 WebView 主动触发。
- `apps/web/src/App.tsx`：聊天输入区新增“📋 剪贴板”入口；收到桌面事件后把文本追加到 composer，把截图 / 图片追加到附件栏，并沿用现有视觉模型自动切换逻辑。
- `apps/desktop/src-tauri/src/automation.rs`：debug automation channel 新增剪贴板写入能力，供桌面 UI smoke 在真实 WebView 中验证剪贴板导入链路。
- `scripts/verify-desktop-ui.mjs`：新增剪贴板导入校验，确认 desktop automation 写入的文本能通过桌面动作进入当前输入框。

## 10.18 P3 本地模板市场（v0.10）

- `apps/web/src/App.tsx`：聊天头部“模板”升级为“模板市场”，把内置工作流、已启用 Workflow Recipe、用户自定义 Prompt 模板聚合成统一发现入口；支持搜索、按来源筛选、右侧预览和一键套用。
- `apps/web/src/App.tsx`：保留既有变量填空 / Recipe preview → prompt 注入链路，因此模板市场只负责“发现与选择”，不引入新的状态真相。
- `apps/web/e2e/p3-template-market.spec.ts`：覆盖搜索、预览和通过市场入口套用本地 Recipe。

## 10.16 停止 / 续写闭环

- `apps/sidecar`：新增 `POST /v1/runs/:id/continue`。Sidecar 根据原 run event 找到 `assistant_message_id` 和上一条 user message，仅允许续写状态为 `incomplete` 的助手消息；新 run 使用 `kind='continue'`，通过 `parent_run_id` 指向原 run，并通过 `continued_from_message_id` 记录原助手消息。
- `apps/web`：消息级“续写”按钮从前端追加“请继续上文”改为查找对应 incomplete run 并调用 Sidecar continue API；续写完成后刷新消息列表、Run Timeline、实时成本和侧边栏，避免生成额外 user message。
- `scripts/verify-real-journey.mjs`：真实模型用户旅程增加普通聊天 MCP 工具调用验证，覆盖工具痕迹、上下文快照、Run Timeline 和 `tool_call` 成本记录。
- 合同影响：Sidecar 新增公共恢复 API；Renderer 消费该 API；`packages/shared` 继续复用既有 Agent Run / Event 类型，无新增 schema。
- 验证：定向 sidecar / web typecheck、Agent Run 单元测试、C2 停止续写 E2E 和真实模型 journey 需作为本阶段验收口径。

## 10.17 恢复策略 Sidecar 闭环

- `packages/shared`：新增 `RecoverRunRequestSchema`，`action` 支持 `continue / retry_same_model / switch_model / skip_tool / compact_context`；`skip_tool` 请求可携带 `tool_name`，失败决策 annotation 可携带 `tool_name` / `tool_label`。

## 10.18 DeepSeek 官方供应商

- `packages/shared`：`ProviderTypeSchema` 新增 `deepseek`，共享常量新增 `DEFAULT_DEEPSEEK_BASE_URL=https://api.deepseek.com`。
- `apps/sidecar`：Provider registry 新增 DeepSeek 官方 adapter，通过 OpenAI-compatible `/models` 测试与发现 `deepseek-v4-flash` / `deepseek-v4-pro`；普通文本继续走通用 OpenAI-compatible chat path，但当 DeepSeek 官方聊天模型启用 tools 时，Sidecar 改走 provider-specific 的 Chat Completions tool loop，并在 tool roundtrip 中显式回传 `assistant.reasoning_content`，以兼容官方 thinking mode 协议。
- `apps/web`：Onboarding / 模型管理供应商预设新增“DeepSeek 官方”，默认 Base URL 来自 shared 常量。
- `apps/sidecar`：新增 `POST /v1/runs/:id/recover`。Sidecar 根据原 run event 找到源 user message、原 assistant message 和模型，创建新的 assistant message 与 `kind='retry'` 子 run；恢复链写入 `recovery.started -> turn.started -> ... -> recovery.completed/failed`，`parent_run_id` 指向原 run。
- `apps/sidecar`：`compact_context` 使用确定性摘要压缩源用户消息之前的较早历史，不插入新 user message，并在 recovery event payload 中记录压缩消息数和摘要长度。
- `apps/sidecar`：`skip_tool` 从原 run events 中定位最后失败工具，创建新的 assistant message 与 `kind='retry'` 子 run，本轮恢复临时禁用该工具并注入恢复说明；找不到失败工具时返回 409，避免伪装成功。
- `apps/web`：失败决策卡片的“重试 / 切换并重试 / 压缩上下文后重试 / 跳过失败工具继续”改为调用 recover API；前端不再自行 `regenerate` 决定恢复语义，只负责确认动作、选择目标模型或失败工具、刷新消息 / Timeline / 成本。
- 当前边界：`continue` 仍走 `/v1/runs/:id/continue`；`skip_tool` 只在当前恢复 run 禁用目标工具，不永久修改用户工具配置。
- 验证：`agent-runs.test.ts` 覆盖 recover 不插入 user message、子 run、recovery event、compact_context 压缩元数据和 skip_tool 409/成功路径；`m2.1-failure-decision.spec.ts` 覆盖 UI 点击恢复按钮会调用 Sidecar recover API；`m2.1-skip-tool-recovery.spec.ts` 覆盖用户点击“跳过失败工具继续”后不新增 user message，且恢复请求不再暴露失败 MCP 工具。

## 10.17.1 高成本恢复确认闭环

- `packages/shared`：`RecoverRunRequestSchema` 新增 `confirmed_cost`；新增 `ContinueRunRequestSchema` 和 `CostConfirmationRequiredDetailsSchema`；错误码新增 `cost_confirmation_required`（HTTP 409）。
- `apps/sidecar`：`/v1/runs/:id/continue` 与 `/v1/runs/:id/recover` 在创建 assistant message 和启动上游前执行成本确认门禁，复用 `cost_confirm_threshold_usd`、`cost_confirm_disabled_models`、`cost_confirm_disabled_conversations`、`monthly_budget_usd` 与实时本月成本；未确认时返回结构化 details，确认后才继续创建子 run。
- `apps/web`：`api.continueRun/recoverRun` 保留结构化错误；消息级续写和失败恢复收到 `cost_confirmation_required` 时复用 `CostConfirmDialog`，用户点继续后以 `confirmed_cost=true` 重放原动作，确认前不新增助手消息。
- 验证：`agent-runs.test.ts` 覆盖 continue/recover 未确认阻断与确认放行；`m2.1-failure-decision.spec.ts` 覆盖恢复动作确认弹窗；`c2-stop-continue.spec.ts` 覆盖停止后续写确认弹窗；`m2.2-cost-l3-l4.spec.ts` 保持普通发送确认回归。

## 10.18 Agent Run Header 与上下文窗口管理

- `apps/sidecar`：新增 SQLite `agent_runs` Header 表，作为 `run_events` 的物化查询索引；`run_events` 仍是 append-only 真相源，事件 append 时同步 upsert Header，旧数据或 Header 缺失时继续从 events 推导兜底。
- `apps/sidecar`：聊天、续写、恢复三条生成路径按模型 `context_length` 自动做滑动窗口裁剪，保留系统提示和最近消息，避免长对话直接超过上游上下文窗口。
- `packages/shared`：`ContextSnapshotAnnotation` 增加可选 `context_window`，记录原始/送入消息数、估算输入 token、预算、模型窗口和裁剪策略。
- `apps/web`：运行过程上下文快照卡片展示自动裁剪数量；不改变聊天发送请求合同。
- 验证：`agent-runs.test.ts` 覆盖 Header 物化更新和小上下文模型触发裁剪快照；Sidecar/Web typecheck 作为合同兼容检查。

## 10.19 圆桌接入 Agent Run Timeline

- `apps/sidecar`：圆桌分析、轮次、单参与者重试、总结和取消均写入 `run_events`，并通过 `agent_runs` 物化为 `kind='roundtable'` 的 run；事件覆盖 `turn.started/context.snapshot/model.started/model.completed/model.failed/tool.* /cost.recorded/turn.completed/turn.failed/turn.cancelled`。
- `apps/sidecar`：圆桌参与者调用 web/MCP 工具时，除既有 `rt.tool_trace` SSE 外，同步写入工具生命周期事件，工具失败会进入统一 Timeline 可观测面。
- `apps/web`：圆桌 launch 成功后同步当前 conversation id，用户无需先发送普通聊天消息即可打开“运行过程”查看圆桌分析和参与者事件。
- `apps/sidecar`：`chat.ts` 首步拆分为 `src/chat/context-window.ts`、`src/chat/recovery.ts`、`src/chat/run-actions.ts` 与 `src/chat/upstream-tools.ts`，先把上下文窗口、恢复/续写 run 解析、compact 纯逻辑、continue/recover 上下文组装和 AI SDK 工具构建从主路由中移出；公共 HTTP/SSE 合同不变。
- 验证：`m3a-2-rounds.test.ts` 覆盖 roundtable round 的 run events 与 header；`m3a-3-summary-export.test.ts` 覆盖 summarize 的 run events 与 header；`run-timeline-user-journeys.spec.ts -g "roundtable discussion"` 覆盖用户从 UI 发起圆桌、跑一轮并打开 Run Timeline。

## 10.20 P1 语义压缩设计

- `docs/product/18-p1-semantic-compact.md`：定义语义压缩的用户目标、默认策略、可见性和不做范围。
- `docs/architecture/22-p1-semantic-compact-proposal.md`：定义 recover request 扩展、`context.compacted` 事件、语义压缩 Sidecar 流程、预算/成本/回退约束。
- `docs/modules/p1-semantic-compact-mapping.md`：记录 shared、sidecar chat/cost/run-events、web 恢复卡/设置/Timeline 的模块边界。
- 当前边界：首版默认仍是 deterministic compact；semantic compact 必须显式启用或用户确认，且必须走统一预算硬上限。

## 10.4 D1 / D2 完工记录（v0.8）

D1 / D2（成本看板 / 月度预算）已实现：

- `apps/sidecar`
  - 复用并扩展 `/v1/costs/breakdown`：`scope` 支持 `today / week / month / session`，`group_by` 支持 `model_feature / model / conversation / feature`
  - 新增 `/v1/costs/calls`：按时间倒序返回最近模型 / 工具调用流水，包含 provider、model、source、feature、成功状态、费用与耗时，用于核对真实外部消费
  - `CostsRepo.breakdownBy()` 新增按模型 / 会话 / 特性聚合，并返回 bucket 级 `trend[]`
  - `CostsRepo.breakdown()` 改为基于统一 window rows 聚合，保持 M2 session panel 向后兼容
- `apps/web`
  - 新增 `CostDashboard.tsx` 独立 overlay，看板支持 `今日 / 本周 / 本月` + `按模型 / 按会话 / 按特性`
  - 顶栏新增 💸 入口；`CommandPalette` 新增 `/costs` 导航
  - `Settings.tsx` 新增月预算设置区；状态栏 `cost-bar` 增加预算等级样式
  - 超预算提示采用一次性 toast；超预算发送门控复用 `CostConfirmDialog(reason='budget')`
  - 看板数据增加前端归一化兜底，旧 shape / 缺失 `trend` 时退化显示而不崩溃
- 状态与存储
  - 预算设置不新增业务表，复用 `memories(global, key)`：
    - `monthly_budget_usd`
    - `monthly_budget_alert_state`
- 测试
  - Sidecar：`m2-2-cost-l3-l4.test.ts` 覆盖 `week`、`group_by=model|conversation`
  - Web：`d1-d2-cost-dashboard-budget.spec.ts` 覆盖成本看板与预算门控
  - E2E 基础设施：Playwright global setup 改为直接启动当前 sidecar 源码，避免 `dist` 过期导致 renderer / sidecar 契约漂移

## 10.5 D1 / D2 合同变化

- `apps/sidecar`
  - `/v1/costs/breakdown` 查询契约扩展：新增 `group_by`，并允许 `scope=week`
  - 当 `group_by !== model_feature` 时，返回行增加 `key / label / conversation_* / feature? / trend[]`
  - 新增 `/v1/costs/calls?limit=` 查询契约：返回最近调用日志，默认 100 条，上限 200 条
- `apps/web`
  - 新增成本看板 overlay、顶栏入口、命令面板入口、预算 toast 与超预算确认门控
  - `Settings` 增加月预算配置入口

## 10.7 控制中心信息架构调整（v0.8）

- `apps/web`
  - 新增 `ControlCenter` 统一承载概览、模型与供应商、工具能力、成本与调用、模板与 Persona、通用与数据
  - 顶栏原 `设置 / 模型中心 / 成本看板` 入口保留，但统一打开控制中心的对应板块
  - `SettingsContent`、`ModelCenter`、`CostDashboard` 增加 embedded 使用形态，避免复杂配置继续分散为多个独立弹窗
  - 控制中心左侧导航保留旧关键 testid（如 `settings-tab-tools`），降低既有 E2E 迁移成本
- `apps/sidecar`
  - 无接口变化；继续复用现有 `/v1/models`、`/v1/tools`、`/v1/costs/*`、`/v1/memories/*`
- 合同影响
  - 仅 Renderer 信息架构变化；无数据迁移，无 Sidecar API 变更
- 数据
  - 无新表；新增两项全局 memory 约定键：`monthly_budget_usd`、`monthly_budget_alert_state`

## 10.8 保守引导与工具时间线（v0.8）

- `apps/web`
  - 能力预检栏新增保守建议：对搜索/抓网页、图片输入、图片生成工具关闭等场景给出提示，但不自动切换模型
  - 聊天消息新增工具执行时间线，渲染 `tool_trace` annotation，展示工具名、输入摘要、状态、耗时和结果摘要
  - 模板选择器新增“内置工作流”分组（网页调研报告 / 图片生成并复核 / 决策简报），模板只填充输入框，不改变当前模型
- `apps/sidecar`
  - `/v1/chat` 在内置工具调用前后追加 `tool_trace` annotation
  - 覆盖 `builtin.web_search`、`builtin.web_fetch`、`builtin.image_generate`
- 合同影响
  - Sidecar→Renderer Data Stream annotation 增量：`{ type: 'tool_trace', message_id, event, call_id, tool, label, input?, output?, ok?, duration_ms? }`
  - 无 REST 路由变化，无数据库迁移，无 `packages/shared` 导出变化
- 验证
  - 新增 Playwright：`apps/web/e2e/conservative-guidance-journeys.spec.ts`

## 10.6 E1 完工记录（v0.8）

E1（模型健康轻量面板）已实现：

- `apps/sidecar`
  - 新增 `GET /v1/models/health`，返回所有模型最近 24h 的健康行
  - `CostsRepo.modelHealth24h()` 基于 `cost_records` 聚合：
    - `calls_24h`
    - `failures_24h`
    - `avg_first_token_ms`
    - `avg_duration_ms`
    - `last_failure_at`
    - `last_failure_classification`
  - `chat.ts` 在 mock / upstream 两条流式路径统一产出 `first_token_ms`，并在落库时写入失败分类
- `packages/shared`
  - 新增 `ModelHealthRowSchema` / `ModelHealthRow`
- 数据
  - `cost_records` additive migration 新增：
    - `classification`
    - `first_token_ms`
- `apps/web`
  - `ModelCenter.tsx` 每行新增“健康/收起健康”展开按钮
  - 展开面板展示 4 个核心指标卡片 + 最近失败 footer 文案
  - 样式支持桌面与窄屏响应式
- 测试
  - Sidecar：`e1-model-health.test.ts`
  - Web：`e1-model-health-panel.spec.ts`

## 10.7 E1 合同变化

- `apps/sidecar`
  - 新增 `/v1/models/health`
  - `cost_records` 观测字段扩展：`classification`、`first_token_ms`
- `apps/web`
  - `ModelCenter` 新增模型健康展开交互与指标展示
- `packages/shared`
  - 新增 `ModelHealthRow` contract
- 数据
  - 无新表；对 `cost_records` 做 additive migration，不影响旧数据可读性

## 10.8 E2 完工记录（v0.8）

E2（数据备份 / 恢复）已实现：

- `packages/shared`
  - 新增 `BackupPackage` 及完整子 schema：
    - providers / models / conversations / messages / files / memories
    - prompt templates / personas
    - cost records / roundtables / roundtable messages
    - import/export response 与 counts
- `apps/sidecar`
  - `src/routes/admin.ts` 新增：
    - `GET /v1/admin/export-data`
    - `POST /v1/admin/import-data`
  - 备份格式版本固定为 `taori-backup-v1`
  - Provider 仅导出 `had_api_key`，不导出真实 key / key ref
  - 导出时尝试把本地文件字节编码为 `data_b64`
  - 导入支持 `overwrite / skip / rename`
  - 导入时维护 provider / model / conversation / message / file / memory / template / persona / cost / roundtable 的 ID remap，并修复跨表引用
  - `clear-all-data` 清理范围扩展至 files / memories / prompt_templates / personas / roundtables / roundtable_messages，并联动文件目录与 keystore 引用清理
- `apps/web`
  - `Settings.tsx` Danger Zone 新增：
    - 导出全部数据按钮
    - 导入策略选择器
    - 导入备份文件入口
  - 导出在本地生成 JSON 下载
  - 导入完成后整页刷新，确保 renderer 状态与 sidecar 恢复结果一致
- 测试
  - Sidecar：`e2-backup-restore.test.ts`
  - Web：`e2-backup-restore.spec.ts`

## 10.9 E2 合同变化

- `apps/sidecar`
  - 新增 `/v1/admin/export-data`
  - 新增 `/v1/admin/import-data`
  - `clear-all-data` 的清理语义扩展为“全业务数据 + 文件目录 + keystore 引用”
- `apps/web`
  - `Settings` Danger Zone 从“仅清空”扩展为“导出 / 导入 / 清空”
- `packages/shared`
  - 新增 `BackupConflictStrategy`、`BackupPackage`、`BackupImportResponse`、`BackupExportResponse` 等备份 contract
- 数据
  - 无新表；新增本地 JSON 备份格式 `taori-backup-v1`

## 10.10 Agent 运行时前三优先级（v0.8）

- `packages/shared`
  - 新增 `ConversationProfile`、`EffectiveTool`、`ContextSnapshotAnnotation`、`ContextSource` contract
- `apps/sidecar`
  - 新增 `/v1/conversations/:id/profile`：返回当前会话画像（最近模型、Persona、有效工具、上下文来源、会话成本）
  - 新增 `/v1/tools/effective?conversation_id=`：返回工具的全局启用、会话覆盖、最终有效状态
  - 新增 `/v1/tools/:name/session-enabled`：会话级工具策略覆盖；`enabled=null` 表示恢复继承全局
  - `/v1/chat` 新增 `context_snapshot` annotation，并在 LLM 工具注入时尊重会话级工具策略
- `apps/web`
  - 聊天页新增会话画像条，展示当前模型、Persona、有效工具数、会话成本
  - 会话画像条提供搜索 / 抓网页 / 生图的当前会话工具开关
  - assistant 消息新增“本次上下文”卡片，展示模型、Persona、附件、工具策略等来源
- 数据
  - 无新表；会话级工具策略复用 `memories(scope='session')`

## 10.11 P1 Run Timeline（v0.8）

- `packages/shared`
  - 新增 `RunEvent`、`RunEventKind`、`RunEventStatus`、`RunTimelineResponse` contract
  - ID 前缀新增 `run_`、`runev_`
- `apps/sidecar`
  - 新增 SQLite 表 `run_events`，由 Sidecar 持有运行观测状态
  - 新增 `RunEventsRepo`
  - 新增 `GET /v1/conversations/:id/run-events?limit=`：按会话返回最近运行事件
  - `/v1/chat` 在聊天回合中记录：turn/context/model/tool/cost/capability_route 事件
- `apps/web`
  - 会话画像条新增“运行过程”入口
  - 新增 Run Timeline 侧边面板，按 `run_id` 分组展示上下文、模型、工具、成本与回合结束状态
- 数据
  - 新增持久表 `run_events`；旧 DB 启动时幂等创建
- 设计
  - 见 [架构 17](../architecture/17-run-timeline-proposal.md) 与 [产品 12](../product/12-run-timeline.md)

## 11. 灰盒原则提醒

## 10.12 Keychain UX 与桌面验证默认降噪（v1.0）

- `apps/web`
  - ModelCenter 打开时不再自动调用 `/v1/providers/key-status`，避免仅浏览设置就触发系统钥匙串授权。
  - Provider 卡片只展示“已保存 Key 引用”；真实读取由“检查钥匙串状态”、测试连接、模型同步或发送消息等用户动作触发；显式检查后会标出 Key 缺失 Provider，并可直接重新填写 Key。
  - Help Center 默认“运行自检”不读取 Keychain；钥匙串深度检查拆成显式按钮。
- `apps/sidecar`
  - `/health` 的 Rust control channel 探测加短超时，只用于诊断 `control_channel` 状态，不让首屏健康检查被控制通道探测长期阻塞。
  - `/v1/selfcheck` 默认跳过 Keychain probe；只有 `?include_keychain=1` 才写读删临时探针。
  - `/v1/providers/key-status` 在 Keychain 模式下默认拒绝隐式读取，必须带 `confirm_keychain=1` 才串行读取 Provider Keychain 状态；control channel Keychain 读/写/删有显式超时，避免系统授权卡住时用户请求无限等待。
- `apps/desktop`
  - `pnpm dev:desktop` 默认设置 `TAORI_DESKTOP_DEV_KEYSTORE=dev_file`，桌面开发模式不把 Rust control channel 注入 Sidecar，因此不会使用系统 Keychain；需要真实 Keychain 时显式设置 `TAORI_DESKTOP_DEV_KEYSTORE=keychain`。
  - 新增 debug-only WebView automation channel；仅在 debug build 且 `TAORI_DESKTOP_AUTOMATION=1` 时启动，生产构建不暴露。
- `scripts`
  - 新增 `pnpm verify:browser-rc`，串行执行 `verify:web`、`verify:real:report` 和 `git diff --check`，输出 `/tmp/taori-browser-rc-*` 结构化 artifact。
  - `verify:desktop` 和 `verify:desktop-ui` 默认不读取 Keychain、不发真实模型。
  - 完整 Keychain / 真实模型桌面验证必须显式 opt-in，避免 macOS dev 二进制反复弹钥匙串授权；显式检查串行执行 Keychain probe 和 Provider key-status，并写结构化 artifact。

## 10.13 真实 Provider 风险诊断面板（v1.0）

- `apps/sidecar`
  - 新增只读公共接口 `GET /v1/diagnostics/real-provider/latest`。
  - 接口只扫描最近一次 `pnpm verify:real` 写入的本地 `/tmp/taori-real-journey-*` 产物，汇总步骤通过数、结构化风险、Agent Run 数、Run Event 数、成本调用数和选中模型能力。
  - 接口不读取系统 Keychain、不发起真实 Provider 调用，不替代执行 `pnpm verify:real`。
- `apps/web`
  - Help Center 新增“真实模型能力诊断”入口，展示最近真实验证 artifact 摘要、关键步骤、风险列表和产物目录。
  - 该入口只读本地诊断结果，不触发 macOS 钥匙串授权弹窗。
- 数据
  - 无新表；诊断来源是临时验证 artifact。
- 验证
  - Sidecar：`diagnostics.test.ts`
  - Web：`b3-help-center.spec.ts`

## 10.14 成本来源与运行过程关联（v1.0）

- `apps/sidecar`
  - 普通聊天与圆桌 `cost.recorded` 事件 payload 携带 `cost_record_id`。
  - `GET /v1/costs/calls` 在最近调用日志中附带 `run_id`、`run_event_id`、`run_event_kind` 和 `run_event_label`，读路径根据 `cost_record_id` 与 source 信息反查最近 run event；可选 `cost_record_id` 查询参数用于精确定位单条成本调用。
  - 无数据库迁移；`cost_records` 与 `run_events` 仍各自持有原状态。
- `apps/web`
  - 成本看板最近调用日志展示 Cost ID、Run ID 和运行事件标签。
  - Run Timeline 的 `cost.recorded` 事件展示同一 Cost ID，并可跳回 Cost Dashboard 高亮对应成本调用；用户能在两个视图之间核对普通聊天、恢复动作和圆桌参与者成本。
- 验证
  - Sidecar：`costs.test.ts`
  - Web：`d1-d2-cost-dashboard-budget.spec.ts`、`m2.1-failure-decision.spec.ts`、`run-timeline-user-journeys.spec.ts`

## 10.15 PackyAPI 与 SiliconFlow Provider 预设（v1.0）

- `packages/shared`
  - `ProviderTypeSchema` 新增 `packyapi`、`siliconflow`。
  - 新增默认接入点常量：`DEFAULT_PACKYAPI_BASE_URL`、`DEFAULT_SILICONFLOW_BASE_URL`。
- `apps/sidecar`
  - Provider registry 新增 PackyAPI / PackyCode 适配器：`/models` 可用时读取并推断能力，始终补充 `gpt-image-2`；`/models` 不可用时仍可导入 `gpt-image-2`。
  - Provider registry 新增 SiliconFlow 适配器：通过 `/models` 推断 chat / multimodal / image / embedding 能力；图像模型调用 `/images/generations` 时使用 SiliconFlow 的 `image_size` 参数。
  - `builtin.image_generate` 支持 OpenAI-compatible URL 返回、PackyAPI `gpt-image-2` 和 SiliconFlow URL 返回，并统一落地为本地 file/message attachment。
- `apps/web`
  - Onboarding 供应商预设新增 PackyAPI / PackyCode 与硅基流动 SiliconFlow，用户不再需要手动选择“自定义”并填写 Base URL。
- 验证
  - Sidecar：`providers.test.ts`、`m2-4-image-gen.test.ts`
  - Web：`provider-presets.spec.ts`

## 11. 灰盒原则提醒

按 [my-spec 模块灰盒规范](file:///Users/chenpu/workspace/claude-code/my-spec/模块灰盒规范.md)：
- 维护**对外接口、依赖方向、状态归属、部署语义、协作关系**
- 不维护内部文件组织、函数实现细节
- 当公共 API / 状态归属 / 依赖方向 / 部署语义发生变化时，必须做变更提案并更新本清单
