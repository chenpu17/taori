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

## 7. 灰盒原则提醒

按 [my-spec 模块灰盒规范](file:///Users/chenpu/workspace/claude-code/my-spec/模块灰盒规范.md)：
- 维护**对外接口、依赖方向、状态归属、部署语义、协作关系**
- 不维护内部文件组织、函数实现细节
- 当公共 API / 状态归属 / 依赖方向 / 部署语义发生变化时，必须做变更提案并更新本清单
