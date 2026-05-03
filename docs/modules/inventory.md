# 模块清单

Status: draft（M0 前）
Owner: Chenpu
Date: 2026-04-27
Scope: Taori 全系统

## 1. 系统总览

- **系统目标**：BYOK 多模型重度用户的桌面工作编排助手；三条主线：失败兜底 / 成本透明 / 多模型圆桌。
- **核心路径**：用户在 Renderer 输入 → Sidecar 编排 LLM 调用 → 结果流式回 Renderer，全程记录成本与状态到 SQLite。
- **当前阶段**：M0 前（设计完成，代码未启动）。下一步是 M0 骨架。

## 2. 模块目录

| 模块 | 一句话定位 | 层级 | 是否独立部署 | 主要接口 | 主要依赖 | 拥有状态 | 邻接模块 | 合同文档 |
|---|---|---|---|---|---|---|---|---|
| `apps/desktop` | Tauri 外壳，承担 OS 能力与 Sidecar 进程托管 | entry | 是（最终安装包入口） | Tauri 命令（`sidecar_endpoint` / `read_file_for_upload` 等）；监听 OS 事件 | `apps/sidecar`（spawn）；OS Keychain；OS 文件系统 | Sidecar 进程句柄；Bearer Token（内存）；窗口状态 | `apps/sidecar`（启动/守护）；`apps/web`（命令通道） | `apps/desktop/MODULE.md`（M0 建立） |
| `apps/web` | React Renderer，UI 与流式渲染 | entry | 否（嵌在 Tauri 中） | 用户交互；通过 `invoke` 取 Sidecar endpoint | `apps/desktop`（Tauri 命令）；`apps/sidecar`（HTTP+SSE）；`@taori/shared` | UI 状态（Zustand）；会话临时缓存 | `apps/desktop`；`apps/sidecar` | `apps/web/MODULE.md`（M0 建立） |
| `apps/sidecar` | 业务编排进程，LLM 调用 / 圆桌 / 数据持久化 | orchestrator | 是（独立 Node 进程，崩可重启） | HTTP REST + SSE on `127.0.0.1:port`（详见架构 03） | LLM Providers（远程）；SQLite（本地文件）；`@taori/shared`；`@taori/prompts` | 全部业务状态：会话、消息、圆桌实例、成本记录、记忆、模型异常计数 | `apps/web`（HTTP 服务方）；`apps/desktop`（被托管） | `apps/sidecar/MODULE.md`（M0 建立） |
| `packages/shared` | 前后端共享类型与 Zod schema | infra | 否（library） | 导出类型、schema、常量 | 无运行时依赖 | 无 | `apps/web`；`apps/sidecar` | `packages/shared/MODULE.md`（M1 建立） |
| `packages/prompts` | 元 Prompt 模板（圆桌角色/总结/意图识别） | infra | 否（library） | 导出 prompt 函数 | 无运行时依赖 | 无 | `apps/sidecar` | `packages/prompts/MODULE.md`（M3 建立） |
| `apps/sidecar/capability-bus` 🔮 | Sidecar 内子模块：工具注册/调度/计费/兜底，承接 Builtin 与 MCP；M2 引入 | orchestrator-internal | 否（Sidecar 内） | `register/list/getToolsFor/invoke` | Vercel AI SDK；MCP SDK（M3） | 工具注册表；MCP 子进程句柄；健康状态 | `apps/sidecar`（宿主）；`packages/shared`（Tool schema） | M2 建立合同（设计见 [架构 09](../architecture/09-agent-and-tools.md)） |

## 3. 关键协作关系

- `apps/desktop` → `apps/sidecar`：Tauri 启动时 spawn Node 进程，通过 stdout 接收 `READY {port} {token}`，崩溃时重启
- `apps/desktop` ↔ `apps/web`：Tauri 命令通道，仅传递控制元信息（endpoint、文件 base64）；**绝不传 LLM 流**
- `apps/web` → `apps/sidecar`：本地 HTTP + SSE，Bearer Token 鉴权；所有 LLM 流式数据走这条
- `apps/sidecar` → LLM Providers：通过 Vercel AI SDK 出站，带用户的 API Key（运行时从 Keychain 经 Tauri 命令拉取）
- `apps/sidecar` → SQLite：进程内同步访问（better-sqlite3）

## 4. 高风险模块

| 模块 | 风险点 |
|---|---|
| `apps/sidecar` | 拥有几乎全部业务状态；任何合同变化都会扩散到 web/desktop。M0 后必须最先建立 MODULE.md |
| `apps/desktop` | Sidecar 生命周期管理、Keychain 操作、CSP 配置；安全攻击面集中在此 |
| `packages/prompts` | 元 Prompt 改动直接影响圆桌质量与成本；变更应有版本记录 |

## 5. 最近变化

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

M0 完成时需补充：

- [ ] 各模块的 `MODULE.md`（按 my-spec 最小 5 字段起步）
- [ ] `apps/sidecar` 详细的内部子模块（providers / orchestration / cost / db / memory）—— 灰盒不下钻
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
- ModelCenter 新增的可测能力：`provider-chip-test-{id}`（沿用 `/v1/models/:id/test` 探活）、`model-row-up/down-{id}`（fallback_order ▲/▼）、`model-row-default-{id}`（设为默认）、`model-row-demoted-{id}`（⚠️ 自动降级徽章）

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

按 [my-spec 模块灰盒规范](file:///Users/chenpu/workspace/claude-code/my-spec/模块灰盒规范.md)：
- 维护**对外接口、依赖方向、状态归属、部署语义、协作关系**
- 不维护内部文件组织、函数实现细节
- 当公共 API / 状态归属 / 依赖方向 / 部署语义发生变化时，必须做变更提案并更新本清单
