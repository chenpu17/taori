# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

**Taori** — 面向"多模型重度用户"的 BYOK 桌面 AI 助手。三条产品主线：失败兜底、成本透明、多模型圆桌。

形态：Tauri 桌面壳 + 浏览器 Web UI（同一份 React 代码），全部数据本地 SQLite。

## 协作约定（强制）

- **Git 提交备注不得包含 Claude / AI 工具相关字样**（用户偏好，见 `AGENTS.md` §2.3）。
- 涉及模块合同变化必须同步更新对应 `MODULE.md` 与 `docs/modules/inventory.md`。
- 个人 AI 开发规范主入口：`/Users/chenpu/workspace/claude-code/my-spec/AI开发操作规范.md`（按需阅读）。
- 优先级：用户明确指令 > 本文件 > `docs/` spec > 个人规范 > AI 默认行为。
- 文档与产品文案中文，代码 / commit message 英文，AI 回复中文。

## 仓库结构（pnpm workspace monorepo）

```
apps/desktop      Tauri 外壳（Rust）：仅 OS 能力 + Sidecar 进程托管 + Keychain
apps/sidecar      Node.js 业务进程：Fastify + better-sqlite3 + AI SDK，全部业务逻辑在此
apps/web          React Renderer：Vite + AI SDK React hooks，通过 fetch + SSE 调 Sidecar
packages/shared   前后端共享类型 + Zod schema + ID 前缀；运行时无状态
packages/npm      standalone npm 发布产物（@chenpu17/taori），自带 dist-web 同源托管 Web UI
docs/             product/ + architecture/ + modules/inventory.md
scripts/          dev / verify 入口脚本
```

详细模块边界看 `docs/modules/inventory.md`，每个模块各自的 `MODULE.md` 是该模块的**合同**（接口 / 拥有状态 / 依赖 / 最近合同变化）。**修改模块时先读对应 MODULE.md**。

## 三进程模型与数据流

```
Renderer (React) ──HTTP+SSE+Bearer──▶ Sidecar (Node.js) ──┬──▶ LLM Providers (远程)
                                              │           └──▶ SQLite (本地文件)
                                              ▲
                                              │ localhost control channel (Bearer)
                                     Tauri Rust (Keychain / 进程托管)
```

- **API Key 不落 Renderer**：用户输入 Key → 短暂内存 → 立刻通过 Sidecar↔Rust 控制通道写入 OS Keychain。
- Sidecar 启动 `127.0.0.1:0`（或 standalone 模式 `0.0.0.0:<port>`），生成 32 字节 Bearer Token，stdout 打印 `READY <port> <bearer>` 一行供 Tauri 父进程读取。
- 流式协议：AI SDK v4 data-stream protocol，帧头 `x-vercel-ai-data-stream: v1`，部位 `0:` text / `8:[…]` annotation / `e:{}` step finish / `d:{}` message finish / `3:` error。所有 SSE 帧通过 `apps/sidecar/src/chat/protocol.ts` 的 `writeTextPart` / `writeAnnotationPart` / `writeErrorPart` / `writeFinishPart` 写出，**禁止在路由内手写 `stream.write(\`8:...\`)`**。

详见 `docs/architecture/01-overview.md`、`docs/architecture/03-process-and-ipc.md`、`docs/architecture/08-api-contracts.md`。

## Sidecar 内部架构（最重要）

Sidecar 是绝大多数业务逻辑的所在，以下约定是近几轮重构后已稳定的设计：

```
apps/sidecar/src/
  index.ts              进程入口：startSidecar() → stdout 打印 READY 行
  runtime.ts            一次性 buildRepos(db)、buildServer({ config, db, repos, ... })
  server.ts             Fastify bootstrap + CORS + Bearer/Cookie 鉴权 + 路由注册
  config.ts             loadConfig() + testHooks 集中化（无 process.env.X 散落在业务代码）

  db/
    index.ts            openDb()：DDL + 版本化 migration（schema_migrations 表，事务化）
    schema.ts           Drizzle table 定义
    repos/              每个 Repo 一个文件 + barrel index.ts；buildRepos(db): Repos
                        RunEventsRepo.appendSafe(input, log) 是唯一允许的 run_event 写入入口（带 FK 回退）

  routes/               只做 Zod 校验 + 调 service / repo + 错误→HTTP；禁止业务逻辑
  services/chat/        chat 编排：continue-run / recover-run / handle-capability-route / run-events helper
  chat/                 chat 流式底层：protocol / stream-dispatch / stream-producers / run-stream / context-window
  bus/                  Capability Bus（统一工具调度 + cost_records 自动写入）
  bus/builtins/         builtin.web_search / web_fetch / image_generate / file_search / file_read
  providers/            ProviderAdapter map（test / listModels / recommendedChat / apiKeyRequired）
  research/             Deep Research 引擎：task-runner（dispatch）+ handlers/* + search/*
  roundtable/           圆桌 analyzer / round-runner / summarizer / cost-estimate
  cost/                 budget-guard（throwIfBudgetBlockedOrNeedsConfirmation）
  mcp/                  MCP server 进程管理（stdio + 托管远程 bridge）
  memory/               记忆抽取与 provider 抽象
```

**已稳定的核心模式（修改时遵循）：**

1. **Repo DI**：永远 `deps.repos.X`，**禁止** `new XRepo(db)`。Repo 只在 `buildRepos()` 一处构造。
2. **Run event 写入**：业务层走 `runEventsRepo.appendSafe(insert, log)`；route 层若仍用 `appendRunEvent`，它本身只是 `appendSafe` 的薄 wrapper。FK 失败时会自动回退 message_id / conversation_id。
3. **Capability Bus**：所有工具（builtin + MCP）走 `bus.invoke(name, input, ctx)`；成功失败都自动写 `cost_records(source_type='tool_call')`。LLM 侧工具暴露走 `bus.toAISDKTools({ names, context, callIdPrefix, ... })`。
4. **Provider 适配**：新增 provider 只需在 `providers/registry.ts` 的 `adapters` map 加一条；`pickRecommendations` 也从 adapter 取推荐模型。
5. **Migration**：新加列 → 在 `db/index.ts` 的 `migrations` 数组追加版本，`up(db)` 函数 + `safeAddColumn`，事务化执行。**禁止再写 `if (!cols.some(...)) ALTER`**。
6. **Test hooks**：所有 `TAORI_E2E_HERMETIC_WEB` / `NODE_ENV` 等环境位都从 `config.testHooks.*` 读，不直接 `process.env`。

## 常用命令

```bash
# 开发：一键启动 WebUI + Sidecar (browser-first 模式)
pnpm dev                  # http://127.0.0.1:5173 (web) + 127.0.0.1:17890 (sidecar)
pnpm dev:clean            # 清理 stale 进程 + 端口后再起
pnpm dev:sidecar          # 仅 sidecar (tsx watch)
pnpm dev:web              # 仅 web (vite)
pnpm dev:desktop          # Tauri 桌面壳

# 类型检查 / 测试
pnpm typecheck            # 并行 tsc -p --noEmit
pnpm test                 # 所有包并行测试
pnpm test:sidecar         # vitest run (apps/sidecar)
pnpm --filter @taori/sidecar test:watch    # vitest 单仓 watch 模式
pnpm test:e2e             # Playwright (apps/web)，workers=1 必需

# 单测过滤
pnpm --filter @taori/sidecar exec vitest run test/budget-guard.test.ts
pnpm --filter @taori/sidecar exec vitest run -t "compact context"
pnpm --filter @taori/web exec playwright test e2e/chat-flow.spec.ts
pnpm --filter @taori/web exec playwright test --grep "quick compare"

# 综合验证（CI / 提交前）
pnpm verify:web           # typecheck + sidecar test + Playwright (workers=1)
pnpm verify:browser-rc    # Browser-first 发布主门禁
pnpm verify:real          # 真实 Provider live 调用（需本地凭据，谨慎）
pnpm verify:real:report   # 只读最近一次 verify:real 产物，不发起 live 调用
pnpm verify:desktop       # 桌面壳 smoke
pnpm verify:desktop-ui    # 桌面 WebView 自动化

# 构建 / 发布
pnpm build:shared         # 先 build shared，sidecar / web 依赖它
pnpm build:sidecar
pnpm build:npm            # shared → sidecar → @chenpu17/taori npm 包
```

## 测试约定

- **Sidecar 单测**：`apps/sidecar/test/*.test.ts`，Vitest，55+ 文件覆盖 budget / agent-runs / templates / quick-compare / roundtable / research 等。多数测试用内存 SQLite + mock provider；改动 chat / roundtable / research 流程必须更新对应 spec。
- **Web E2E**：`apps/web/e2e/*.spec.ts`，Playwright，**必须 `workers=1`**（共享 test Vite + mock OpenAI server）。`global-setup.ts` 拉起独立 5174 端口的 test stack，`_mock-openai-server.ts` 提供确定性 SSE 响应。
- 集成断言：`docs/architecture/11-qa-strategy.md`。

## 验证 / 文档驱动

提交前自检（按 my-spec §7 触发条件）：

- 涉及 ≥2 个模块 → 写"特性到模块映射"（`docs/modules/<feature>-mapping.md` 已有 14 份样本可参考）。
- 改公共接口 / 状态归属 / 依赖方向 / 部署语义 → 写"变更提案"（`docs/architecture/*-proposal.md` 已有 30+ 份）。
- 改动触及模块合同 → 同步 `MODULE.md` + `docs/modules/inventory.md`。
- 准备声称"已完成" → 按 L0–L5 验证层级证明（最低 typecheck + sidecar test + 至少一条 e2e）。

## 已知架构特征 / 不要踩的坑

- **Sidecar 单进程假设**：roundtable / research / chat 都用 in-memory Map 跟踪在飞流（`inFlightStreams`, `ResearchRunner.active`）。如果将来横向扩展，要改成 SQLite advisory flag。当前启动时会扫表把 stuck 状态标 `interrupted`（roundtable）/ 不重启（research，需用户手动 resume）。
- **AI SDK 版本锁定**：`ai@4.0.27` + `@ai-sdk/openai@1.0.20`。升级前先验证 data-stream protocol 的 `0:` / `8:` / `e:` / `d:` 帧格式是否兼容。
- **DeepSeek 官方 + tools 走专门 loop**：见 `chat/deepseek-tools-loop.ts` + `chat/deepseek-tool-loop-policy.ts`，因为官方协议要求显式回传 `assistant.reasoning_content`。其他 OpenAI-compatible provider 走通用 `streamText`。
- **thinking 配置**：OpenRouter → `reasoning`，DeepSeek 官方 → `thinking`，OpenAI/GPT-5/o 系列 → `reasoning_effort`，其他 provider 不注入。统一在 `providers/chat-model.ts` 的 `resolveThinkingConfig`。
- **Standalone vs Desktop**：`config.standalone` true 时绑 `0.0.0.0` 可选、同源托管 `dist-web`、支持 `--password` 浏览器登录 cookie；Desktop 仍只绑 `127.0.0.1`，Bearer Token 通过 Tauri command `sidecar_endpoint` 暴露给 Renderer。
- **Hermetic test 路径**：`config.testHooks.hermeticWeb` → `bus/builtins/web_search` 用注入的 fetch 返回固定 DuckDuckGo / example.com 页面；`config.testHooks.hermeticAiPlanner` → research/query-planner 强制走 template fallback。
- **MCP Server 启停**：长连接 stdio session 在 `mcp/client.ts` 维护，崩溃 / 超时按工具错误分类记录。Sidecar `onClose` 钩子会 `closeAllMcpSessions()`。

## 数据模型要点（SQLite）

- `messages.status`: `pending` / `streaming` / `complete` / `incomplete` / `failed` — `incomplete` 是 continue/recover 入口；`failed` 走 retry/switch_model。
- `run_events` 是 append-only 真相源；`agent_runs` 是 Header 物化视图（事件写入时同步刷新）。`/v1/conversations/:id/runs` 直接查 `agent_runs`，丢失时可从事件推导兜底。
- `cost_records.source_type`: `message` / `tool_call` / `quick_compare_output` / `roundtable_message` 等；`feature` 列细分（`chat` / `image` / `tool_call` / `quick_compare`）。
- `memories(scope, scope_id, key, value)` 是全局 / 会话级 KV；`MemoriesRepo.getEffective(conversationId, key)` 先 session 后 global。
- 见 `docs/architecture/04-data-and-storage.md`。

## 关键 API 入口（Sidecar HTTP）

聊天 / 编排：
- `POST /v1/chat` (SSE) · `POST /v1/runs/:id/continue` · `POST /v1/runs/:id/recover` · `GET /v1/runs/:id/resume-state`
- `POST /v1/quick-compare` · `POST /v1/quick-compare/:id/adopt` · `PUT /v1/quick-compare/:id/retry`
- `POST /v1/roundtable` · `/round` · `/retry` · `/summarize` · `/cancel` · `/export`
- `POST /v1/research/sessions` + lifecycle endpoints

配置 / 治理：
- `/v1/providers*` `/v1/models*` `/v1/mcp/servers*` `/v1/tools*` `/v1/memories*`
- `/v1/templates*` `/v1/personas*` `/v1/workflow-recipes*`
- `/v1/costs/realtime` `/v1/costs/calls` `/v1/costs/trend` · `/v1/tools/health`
- `/v1/admin/{clear-all-data,export-data,import-data}` · `/v1/selfcheck` · `/v1/diagnostics/*`

合同细节看 `docs/architecture/08-api-contracts.md` + `packages/shared/src/schemas.ts`。
