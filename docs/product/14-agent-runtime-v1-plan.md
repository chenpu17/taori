# 14 · v1.0 Agent Runtime 阶段计划

Status: implementation checkpoint
Owner: Taori
Date: 2026-05-04

## 1. 阶段目标

v1.0 的目标不是把 Taori 改造成通用自治 Agent，而是把现有多模型聊天、工具调用、圆桌和成本能力收束成一个可连续推进的运行时。

一句话：用户交给 Taori 一个真实问题后，系统能在停止、失败、工具不可用、成本门槛和上下文变化后继续推进，并让用户看清每一步。

## 2. 用户价值

| 用户问题 | v1.0 目标体验 |
|---|---|
| 回答中途停止后不知道怎么继续 | 截断消息保留“续写/继续解决”入口，切换会话和刷新后仍存在 |
| 模型或工具失败后只看到错误 | 显示失败分类、已尝试步骤和下一步可选动作 |
| 多模型/多工具之后不知道系统做了什么 | Run Timeline 按轮次展示模型、工具、上下文和成本 |
| 真实模型工具调用不稳定 | 真实 Provider 验证覆盖工具遵循度、失败恢复和成本入账 |
| 成本和重试不透明 | 每次 retry/failover/tool call 都写入运行事件和成本记录 |

## 3. 交付切片

### D0 · 回归稳定化

状态：已实现，需继续纳入回归必跑。

- 固化刚修复的 ModelCenter、停止流、备份导入、run_events FK、消息头和续写回归。
- 将目标 Playwright 集合加入 v1.0 必跑清单。
- 不新增用户功能，只确保现有主路径可继续迭代。

验收：

- `pnpm typecheck`
- `pnpm test:sidecar`
- 目标 Playwright：ModelCenter / stop-continue / backup-restore / sidebar actions / command palette rerun

### D1 · Run Timeline 完整化

状态：核心链路已落地，圆桌 Timeline 已接入；真实模型主线验证已通过。

- 基于 `run_id` 持久化每轮事件。
- 覆盖 turn、context、model、tool、cost、stop、continue、failure。
- Web 增加运行过程侧栏，可从当前会话打开，刷新后仍可查询。

验收：

- 普通聊天能看到 `turn.started → model.completed → cost.recorded → turn.completed`。
- 工具调用能看到 tool start/completed/failed。
- 用户停止能看到 `turn.stopped`，续写后产生新 run 并关联上一条 incomplete message。
- 圆桌 analyzer、participant、summarizer 也能在 Run Timeline 中按 `kind='roundtable'` 复盘。

### D2 · Agent Run 状态机

状态：Sidecar 已拥有 run events 与 `agent_runs` Header；后续继续收敛 route 内编排代码。

- Sidecar 拥有 run 状态真相，不再由 Renderer 临时推断。
- 状态集合：
  - `created`
  - `context_ready`
  - `streaming`
  - `tool_calling`
  - `waiting_user_confirm`
  - `stopped`
  - `incomplete`
  - `retrying`
  - `failed`
  - `completed`
- Renderer 只渲染状态和触发用户动作。

验收：

- 切换会话、刷新页面后，停止/续写/失败状态不丢。
- 同一 run 的事件顺序稳定，可用于 UI 复盘。
- Abort、provider error、tool error、高成本确认都能落到明确状态。

### D3 · 继续解决与恢复动作

状态：已实现用户确认后的 continue、retry/switch、skip-tool、compact-context 主路径；真实 Provider 主线已覆盖 compact-context，后续补更细成本确认。

- 对失败或截断回合提供“继续解决”入口。
- 首版只做用户确认后的恢复，不做无人值守自治循环。
- 恢复策略按风险递增：
  1. 原模型续写
  2. 原模型重试
  3. 推荐备用模型
  4. 跳过失败工具继续
  5. 缩短上下文后继续

验收：

- 用户可从错误卡片或运行过程面板触发继续。
- 每次恢复写入 timeline，说明原因、策略和结果。
- 高成本恢复必须经过确认，不静默发起昂贵调用。
- `skip_tool` 只在当前恢复 run 禁用失败工具，不改变全局工具配置。
- `compact_context` 必须在 recovery event 中记录压缩消息数和摘要长度。

### D4 · 模型与工具健康

状态：已实现工具健康视图；模型健康复用既有 ModelCenter 健康面板。

- ModelCenter 展示模型最近 24h 健康。
- 工具中心展示 MCP/builtin 工具最近失败和可用状态。
- 健康数据只辅助用户判断，不自动改默认模型。

验收：

- 无调用数据的模型显示零值，不隐藏。
- 最近失败能按 `quota/network/rate_limit/content_filter/tool_timeout/mcp_crashed` 分类。
- 工具失败后，工具中心和 Run Timeline 都能解释失败原因。

### D5 · 真实模型端到端验证

状态：真实 Provider 主线已跑通并保存 artifact；真实圆桌 Timeline、工具健康、成本来源追踪已纳入 `pnpm verify:real`。

- 扩展 `pnpm verify:real`，加入 v1.0 agent-runtime 剧本。
- 真实浏览器操作前端，不 mock LLM，不清库，不输出 API Key。
- 真实模型验证失败不能简单归因测试不稳定，必须产出 failure artifact。

验收：

- 至少一个真实 chat/multimodal 模型完成多轮对话。
- 至少一个 supports_tools 模型触发真实工具调用或明确记录“模型未遵循工具调用”。
- 至少一个真实图像/视觉链路完成生成、持久化、回流理解。
- 停止、续写、失败恢复和 Run Timeline 均通过前端可见路径验证。

## 4. 明确暂缓

- 全自动智能路由。
- 长时间无人值守任务队列。
- 用户可编辑 DAG / Pipeline。
- RAG 知识库。
- 更换底层 Agent 框架。

## 5. 发布门槛

v1.0 的主发布门槛先以浏览器 WebUI + Sidecar 的完整产品逻辑为准；Tauri 桌面壳和 Keychain 深度验证延后到桌面封装门槛，不阻塞 Web 产品主线收敛。

Browser-first 必须满足：

1. Sidecar unit 全绿。
2. Web mock E2E 全绿，已知 flaky 必须重跑通过并记录。
3. `pnpm verify:web` 作为默认发布前主入口通过。
4. `pnpm verify:real` 的 agent-runtime 剧本通过，或产出明确的真实 Provider 风险报告。

Desktop follow-up：

- `pnpm verify:desktop` / `pnpm verify:desktop-ui` 证明桌面壳不阻塞 Web 产品逻辑。
- 显式 Keychain / real desktop smoke 只在准备桌面包发布时执行；它可能触发 macOS 钥匙串授权弹窗，不作为浏览器 WebUI + Sidecar 主线的默认门槛。

## 6. 后续 Todo Queue

执行约定：

- 按顺序推进；除非前一项被阻塞，否则不跳项扩大范围。
- 每项完成后更新状态、验证命令和剩余风险。
- 涉及 `apps/sidecar` + `apps/web` + `packages/shared` 的合同变化时，同步更新 `MODULE.md` 和 `docs/modules/inventory.md`。

### T1 · `/v1/chat` 主链路继续拆分

状态：done · 2026-05-05

目标：把 provider / mock / key-missing streaming lifecycle 从 `apps/sidecar/src/routes/chat.ts` 抽出，使 route 只保留 HTTP 参数解析、鉴权和响应绑定。

范围：

- `apps/sidecar/src/chat/*`
- `apps/sidecar/src/routes/chat.ts`
- 定向 sidecar 测试

验收：

- `/v1/chat` SSE / data stream 协议不变。
- mock、真实 provider、key missing、工具失败、停止和 finalize 事件顺序不变。
- `chat.ts` 继续下降，目标先低于 1000 行。

验证：

- `pnpm --filter @taori/sidecar typecheck` · passed
- `pnpm --filter @taori/sidecar test -- chat.test.ts agent-runs.test.ts m2-1-failure-decision.test.ts` · 3 files / 28 tests passed
- `pnpm --filter @taori/web test:e2e -- c2-stop-continue.spec.ts m2.1-failure-decision.spec.ts --workers=1` · 8 tests passed

结果：

- 新增 `apps/sidecar/src/chat/stream-producers.ts`，承接真实 provider、key missing 和 mock streaming producer。
- `apps/sidecar/src/routes/chat.ts` 从 1468 行降至 959 行，外部 SSE / data stream 协议不变。

### T2 · 高成本恢复确认闭环

状态：done · 2026-05-05

目标：恢复动作不能绕过成本确认；`continue/recover` 在高成本模型、图像模型或高预算风险下必须先给用户确认。

范围：

- `apps/sidecar/src/chat/run-actions.ts`
- `apps/sidecar/src/routes/chat.ts` 或拆分后的 run action route
- `apps/web/src/App.tsx`
- 成本确认相关 E2E

验收：

- `retry_same_model` / `switch_model` / `compact_context` / `skip_tool` 复用既有成本估算与确认策略。
- 用户确认前不创建昂贵上游调用。
- 确认后写入 `recovery.started` / `cost.recorded` / `recovery.completed`。

验证：

- `pnpm --filter @taori/sidecar test -- agent-runs.test.ts m2-2-cost-l3-l4.test.ts`
- `pnpm --filter @taori/web test:e2e -- m2.1-failure-decision.spec.ts m2.2-cost-l3-l4.spec.ts --workers=1`

验证结果：

- `pnpm --filter @taori/shared build` · passed
- `pnpm --filter @taori/sidecar typecheck` · passed
- `pnpm --filter @taori/web typecheck` · passed
- `pnpm --filter @taori/sidecar test -- agent-runs.test.ts m2-2-cost-l3-l4.test.ts` · 2 files / 18 tests passed
- `pnpm --filter @taori/web test:e2e -- m2.1-failure-decision.spec.ts m2.2-cost-l3-l4.spec.ts c2-stop-continue.spec.ts --workers=1` · 14 tests passed

结果：

- 新增服务端成本确认硬门禁：`continue/recover` 未确认且超过阈值或月预算时返回 `cost_confirmation_required`，确认前不创建 assistant message、不启动上游调用。
- Renderer 复用既有 `CostConfirmDialog`，对续写和失败恢复动作执行 `confirmed_cost=true` 二次提交。
- 已覆盖恢复 retry 与停止续写两条用户视角 E2E；`switch_model`、`compact_context`、`skip_tool` 共用同一 recover gate，单元测试覆盖 recover gate 的公共路径。

剩余风险：

- 恢复动作成本估算仍为启发式：使用上游消息字符 token 估算 + 模型历史平均输出，不等同真实 tokenizer。

### T3 · 控制中心健康概览

状态：done · 2026-05-05

目标：把模型 24h 健康和工具 24h 健康从深层卡片提升到控制中心概览，方便用户先看到风险。

范围：

- `apps/web/src/Settings.tsx`
- `apps/web/src/ModelCenter.tsx`
- `apps/web/src/styles.css`
- 如需要，补充 sidecar 聚合 API，但优先复用 `/v1/models/health` 与 `/v1/tools/health`

验收：

- 概览能显示模型失败数、工具失败数、最近失败分类和可用性提示。
- 无调用数据时显示零值，不隐藏。
- 不自动改变默认模型或工具启停状态。

验证：

- `pnpm --filter @taori/web typecheck`
- `pnpm --filter @taori/web test:e2e -- m1.6-settings.spec.ts control-center.spec.ts --workers=1`

验证结果：

- `pnpm --filter @taori/shared build` · passed
- `pnpm --filter @taori/web typecheck` · passed
- `pnpm --filter @taori/web test:e2e -- control-center.spec.ts --workers=1` · 2 tests passed
- `pnpm --filter @taori/web test:e2e -- m1.6-settings.spec.ts control-center.spec.ts --workers=1` · 9 tests passed

结果：

- 控制中心概览新增模型 24h 健康和工具 24h 健康摘要，显示调用数、失败数、受影响模型/工具数和最近失败分类。
- 无调用数据时摘要显示 `0` 与“无”，不隐藏模型/工具健康入口。
- 未新增 Sidecar API，复用 `/v1/models/health` 与 `/v1/tools/health`；不改变默认模型、工具启停或健康判定策略。

### T4 · 真实模型恢复验证扩展

状态：已接入；真实 Provider 验证完成到结构化风险报告。

目标：`pnpm verify:real` 覆盖真实 Provider 下的 `skip_tool` 失败恢复、高成本恢复确认和备份导入后的真实聊天。

范围：

- `scripts/verify-real-journey.mjs`
- 未新增 Sidecar 诊断 API；复用现有 conversations / runs / run-events / costs / tools / health API。
- 不引入生产测试后门。高成本恢复确认通过临时 patch 当前模型价格与会话阈值触发，并在 finally 恢复。

验收：

- 真实失败 artifact 包含 run events、cost calls、最后截图、Provider/Model 能力摘要。已接入：
  - `capability-summary.json`
  - `runs.json`
  - `run-events.json`
  - `cost-calls.json`
  - `99-final-state.png`
  - `99_final_state-diagnostics.json`
- 如果真实模型不触发工具调用，脚本结构化记录“模型未遵循工具调用”，不误报系统通过。已接入 `structured_risks[]`，最终以非 0 退出报告风险。
- 备份导入后侧边栏显示导入会话，并能继续真实聊天。已接入 UI 导入 JSON、侧边栏点击导入会话、真实模型续聊、Run Timeline 与诊断 artifact。

验证：

- `node --check scripts/verify-real-journey.mjs` · passed
- `pnpm verify:real` · 真实 Provider 跑完整旅程后失败于结构化模型风险（符合本阶段语义：不把模型未调用工具误报为通过）：
  - 通过：首轮真实聊天、image_generate、生成图视觉理解、会话工具策略、web_fetch、web_search、普通聊天 MCP、上下文滑窗、compact_context 恢复、高成本恢复确认、第二模型综合、圆桌 Timeline、停止、备份导入后真实续聊、模型中心/工具设置/成本看板。
  - 结构化风险：`deepseek-v3.2` 未按提示调用临时失败 MCP 工具，因此无法自然触发 `skip_tool` failure card；artifact 写入 `skip_tool_model_did_not_call_tool-diagnostics.json` 与 `09h-skip-tool-model-did-not-call-tool.png`。
  - 最近 artifact：`/tmp/taori-real-journey-real-20260505005931`

### T5 · 全量 Web E2E 回归

状态：done · 2026-05-05

目标：在 Agent Runtime 主路径稳定后跑全量 Playwright，记录并处理 flaky。

范围：

- `apps/web/e2e/*`
- 只修复与当前变更相关的失败；无关历史 flaky 单独记录。

验收：

- 全量 E2E 通过，或失败项有明确分类：真实 bug / flaky / 环境前置。
- flaky 至少重跑一次，并记录绝对时间、命令和结果。

验证：

- `pnpm --filter @taori/web exec playwright test --workers=1`

验证结果：

- 首次全量回归：`pnpm --filter @taori/web exec playwright test --workers=1` · 187 tests / 185 passed / 2 failed。
  - `m3a.5-roundtable-panel.spec.ts` 2 个稳定失败，均为圆桌面板启动后恢复/渲染问题。
  - 失败根因：圆桌启动后父组件立即设置 `activeRoundtableId`，同时会话检测 effect 在 `conversationType` 尚未随侧边栏刷新出来时把 active roundtable 清空，导致面板退回聊天视图；mock 圆桌详情测试稳定放大了这个真实竞态。
- 修复：`apps/web/src/App.tsx` 中圆桌会话检测只在 `conversationType === 'roundtable'` 时设置 active roundtable；只在 `conversationType != null` 且非圆桌时清空，避免未知类型过早覆盖刚启动的圆桌面板。
- 定向复验：`pnpm --filter @taori/web exec playwright test apps/web/e2e/m3a.5-roundtable-panel.spec.ts --workers=1` · 5 tests passed。
- 相邻回归：`pnpm --filter @taori/web exec playwright test apps/web/e2e/m3a.6-dod.spec.ts apps/web/e2e/web-visual-layout.spec.ts apps/web/e2e/run-timeline-user-journeys.spec.ts --workers=1` · 26 tests passed。
- 最终全量：`pnpm --filter @taori/web exec playwright test --workers=1` · 187 tests passed / 4.5m。
- 静态检查：`pnpm --filter @taori/web exec tsc --noEmit` · passed。
- 端口清理：`5174` / `17900` 无残留监听。

剩余风险：

- 本轮没有发现新的 flaky；但全量 E2E 仍依赖共享测试端口和单进程锁，后续不要并行启动多个 Playwright 进程。

### T6 · Tauri Manual Smoke

状态：done · 2026-05-05

目标：补齐桌面层人工验收，确认 Tauri 壳、Rust control channel、Keychain 和真实聊天入口可用。

范围：

- `apps/desktop`
- 用户本机 Keychain
- 当前真实 Provider 配置

验收：

- 桌面壳启动并拉起 sidecar，control 显示 configured。
- API Key 写入、读取、删除通过系统 Keychain。
- 刷新后 renderer 仍能拿到 sidecar endpoint。
- 备份导入后侧边栏显示导入对话。
- 桌面内完成一轮真实聊天，Run Timeline 和成本记录可见。

验证：

- `pnpm build:sidecar`
- `TAORI_DEV_SIDECAR_CMD="node $(pwd)/apps/sidecar/dist/index.js" pnpm dev:desktop`

验证结果：

- `pnpm build:sidecar` · passed。
- 桌面 dev 启动：`SIDECAR_BEARER=taori_t6_smoke_bearer TAORI_DEV_SIDECAR_CMD="node $(pwd)/apps/sidecar/dist/index.js" pnpm dev:desktop`。
  - Rust control channel 启动：日志显示 `control channel up at http://127.0.0.1:<port>`。
  - Sidecar READY：日志显示 `sidecar ready at http://127.0.0.1:17890`。
  - Renderer endpoint：桌面窗口启动后通过 Tauri endpoint 发起 `/health`、`/v1/providers`、`/v1/models`、`/v1/tools` 等请求。
  - `/health` 返回 `control_channel: "connected"`。
- 发现并修复桌面 Keychain 配置问题：
  - 现象：`/health` 为 connected，但 `/v1/selfcheck` 的 keystore 探针写入后读回 `null`，Provider `key_available=false`。
  - 根因：`keyring = "3"` 未启用任何平台原生 credential store feature，macOS 下退回进程内 mock store。
  - 修复：`apps/desktop/src-tauri/Cargo.toml` 显式启用 `apple-native`、`windows-native`、`sync-secret-service`；`Cargo.lock` 已更新。
  - 复验：`/v1/selfcheck` 返回 `overall: "ok"`，keystore / database / default_model 均为 ok。
  - 用本地 `apps/sidecar/data/dev.keys.json` 将旧 dev key 迁回系统 Keychain；`/v1/providers/key-status` 两个真实 Provider 均为 `key_available=true`。
- 备份导入：
  - 通过由桌面进程拉起的 sidecar 调用 `/v1/admin/import-data` 导入 1 个 conversation + 1 条 message。
  - 随后 `/v1/conversations` 立即可见 `T6 Imported Conversation <timestamp>`。
- 真实模型聊天：
  - 模型：`deepseek-v3.2` / `mdl_VtxPsVa8aHGt`。
  - 结果：assistant message `status=complete`，回复内容为“桌面真实模型 smoke 通过。”。
  - Run Timeline：`/v1/conversations/:id/runs` 返回 1 个 `kind=chat`、`status=completed`、`event_count=6` 的 run。
  - Run Events：事件链包含 `turn.started → context.snapshot → model.started → model.completed → cost.recorded → turn.completed`。
  - 成本：`/v1/costs/realtime?conversation_id=...` 返回 `current_conversation_calls=1`；本次极短回复按当前价格四舍五入显示 `current_conversation_usd=0`，但 `cost.recorded` 与 breakdown 行已落库。
- 端口清理：验证结束后检查 `17890` / `5173` 无残留监听。

剩余风险：

- 当前环境未配置 Tauri WebView 远程调试端口，Playwright 不能直接接管桌面窗口点击；本轮用桌面进程真实拉起的 sidecar + renderer 请求日志 + HTTP 诊断覆盖核心链路。纯窗口内“用户点击导入文件/发送消息”的可视化验证仍建议作为发布前人工 smoke 项保留。

### T7 · Desktop Smoke Automation

状态：done · 2026-05-05

目标：把 T6 中可自动化的桌面验收沉淀为脚本，避免后续 Keychain / control channel / real chat 回归只能靠人工观察。

范围：

- `scripts/verify-desktop-smoke.mjs` 或等价脚本
- `apps/desktop` dev 启动参数
- `docs/architecture/11-qa-strategy.md`

验收：

- 脚本能启动 `pnpm dev:desktop`，等待 READY 与 renderer 初始请求，执行 `/health`、`/v1/selfcheck`、provider key-status、备份导入、真实聊天、runs/events/costs 检查。
- 验证结束必定关闭 Tauri/Vite/sidecar 并检查端口。
- 输出 artifact 到 `/tmp/taori-desktop-smoke-<timestamp>/`，包含日志、JSON 诊断和失败原因。
- 默认脚本只验证桌面启动、control channel、sidecar 与备份导入 API；Keychain 和真实聊天需显式 opt-in。

验证：

- `node --check scripts/verify-desktop-smoke.mjs` · passed。
- `pnpm verify:desktop` · passed。

结果：

- 新增 `scripts/verify-desktop-smoke.mjs`，并在根 `package.json` 接入 `verify:desktop`。
- 脚本会：
  - 检查 `17890` / `5173` 端口前置空闲。
  - 执行 `pnpm build:sidecar`。
  - 启动真实 `pnpm dev:desktop`，等待 Vite、Rust control channel、sidecar READY、`control=configured` 和 renderer 初始 `/health`、providers、models、tools 请求。
  - 默认调用 `/health` 验证桌面 control channel，并通过 `/v1/admin/import-data` 验证桌面 sidecar。
  - 只有 `TAORI_DESKTOP_SMOKE_KEYCHAIN=1` 时才调用 `/v1/selfcheck?include_keychain=1` 和 `/v1/providers/key-status` 验证系统 Keychain。
  - 通过 `/v1/admin/import-data` 导入 probe conversation，并确认 `/v1/conversations` 可见。
  - 只有 `TAORI_DESKTOP_SMOKE_REAL_CHAT=1` 时才使用真实模型发送一轮聊天，验证 assistant message complete、AgentRun completed、Run Events 包含 `turn.started` / `context.snapshot` / `model.started` / `model.completed` / `cost.recorded` / `turn.completed`，并检查成本 calls/breakdown。
  - 无论成功失败都写 `/tmp/taori-desktop-smoke-<timestamp>/` artifact，并关闭 Tauri/Vite/sidecar。
- 首次脚本试跑功能链路通过，但发现 cleanup 只杀父 `pnpm`，Tauri binary 和 Node sidecar 孙进程会残留监听 `17890`。已修复为 detached 进程组关闭，并增加按端口 PID 兜底清理。
- 最近通过 artifact：`/tmp/taori-desktop-smoke-desktop-20260505014622`。
  - `summary.json`：`ok=true`，真实模型 `deepseek-v3.2`，run `kind=chat` / `status=completed` / `event_count=6`。
  - `port-cleanup.json`：`17890` / `5173` 均无残留监听。

剩余风险：

- T7 仍不是 WebView 点击自动化；它证明桌面壳、control channel、Keychain、桌面 sidecar 和真实模型后端链路。窗口内点击路径放入 T8。

### T8 · Desktop WebView UI Control

状态：done · 2026-05-05

目标：补齐真正“桌面窗口内点击”的自动化能力，让备份导入、模型中心、真实聊天和 Timeline 可以从用户视角回归。

范围：

- `apps/desktop/src-tauri/src/automation.rs`
- `scripts/verify-desktop-ui.mjs`
- `scripts/verify-desktop-smoke.mjs`
- `docs/architecture/11-qa-strategy.md`

验收：

- dev smoke 可通过 debug-only localhost automation channel 驱动真实 Tauri WebView。
- 默认 `pnpm verify:desktop-ui` 不读取系统 Keychain、不发真实模型，覆盖窗口内：打开设置、导入备份文件、侧边栏可见导入会话、导入消息可见。
- 真实模型桌面 UI 路径需显式 `TAORI_DESKTOP_UI_REAL_CHAT=1 pnpm verify:desktop-ui`，用于覆盖发送真实消息、打开 Timeline、查看成本记录。
- 默认生产构建不启动 automation channel；只有 debug build 且 `TAORI_DESKTOP_AUTOMATION=1` 时启动。

验证：

- `node --check scripts/verify-desktop-ui.mjs` · passed
- `pnpm build:sidecar` · passed（由 `pnpm verify:desktop-ui` 内部执行）
- `pnpm verify:desktop-ui` · passed

结果：

- 新增 debug-only `apps/desktop/src-tauri/src/automation.rs`，使用随机 localhost 端口 + bearer，生产构建不启动。
- `pnpm verify:desktop` 默认改为不读 Keychain、不发真实模型；Keychain + real chat 需显式 `TAORI_DESKTOP_SMOKE_KEYCHAIN=1 TAORI_DESKTOP_SMOKE_REAL_CHAT=1`。
- `pnpm verify:desktop-ui` 默认 UI-only，真实聊天需显式 `TAORI_DESKTOP_UI_REAL_CHAT=1`。
- 发现并修复 `/health` control channel probe 可能长时间阻塞首屏的问题：control health 探测加 1.5s timeout。
- 默认 UI-only smoke 通过，artifact：`/tmp/taori-desktop-ui-desktop-ui-20260505040119`。
  - `summary.json`：`ok=true`，`mode=ui_only`，Vite / Rust control channel / automation channel / Sidecar / renderer health 全部 ready。
  - WebView 内完成：打开设置 → 导入备份 JSON → 侧边栏可见导入会话 → 导入助手消息可见。
  - `port-cleanup.json`：`17890` / `5173` 均无残留监听。

剩余风险：

- macOS Tauri 官方 WebDriver 不支持 WKWebView，当前方案不是 Playwright attach，而是 debug-only WebView eval automation。
- Tauri dev 二进制重编译后 macOS Keychain 可能反复授权；默认验证已避免触发，完整 Keychain/真实模型验证必须人工确认后运行。

### T9 · Help Center Keychain 自检降噪

状态：done · 2026-05-05

目标：普通“运行自检”不再读写系统钥匙串，避免用户只是查看帮助诊断就遇到 macOS Keychain 授权弹窗；Keychain 深度检查保留为显式动作。

范围：

- `apps/sidecar/src/routes/selfcheck.ts`
- `apps/web/src/HelpCenter.tsx`
- `apps/web/src/api.ts`
- `apps/sidecar/test/b3-selfcheck.test.ts`
- `apps/web/e2e/b3-help-center.spec.ts`

验收：

- 默认 `GET /v1/selfcheck` 返回 sidecar / database / default_model，并把 keystore 标为跳过，不调用 `args.keystore.write/read/delete`。
- 只有 `GET /v1/selfcheck?include_keychain=1` 执行临时 Keychain probe。
- Help Center 默认按钮只跑轻量自检；“检查钥匙串”按钮明确提示可能触发系统授权。

验证：

- `pnpm --filter @taori/sidecar typecheck` · passed
- `pnpm --filter @taori/web typecheck` · passed
- `pnpm --filter @taori/sidecar test -- b3-selfcheck.test.ts` · 4 tests passed
- `pnpm --filter @taori/web test:e2e -- b3-help-center.spec.ts --workers=1` · 1 test passed

结果：

- `/v1/selfcheck` 默认返回 keystore `warn` + “已跳过系统钥匙串深度检查”，不读写 Keychain。
- `/v1/selfcheck?include_keychain=1` 保留临时 probe，用于用户明确点击“检查钥匙串”或显式桌面 Keychain smoke。
- Help Center 增加“检查钥匙串”按钮，默认“运行自检”只走轻量诊断。

### T10 · 发布前剩余验证队列

状态：completed with explicit Keychain blocker documented · 2026-05-05

目标：在不默认触发 Keychain 的前提下，给 v1.0 Agent Runtime 收尾一轮可重复的发布前证据。

结果：

1. `pnpm --filter @taori/shared build` · passed
2. `pnpm --filter @taori/sidecar typecheck` · passed
3. `pnpm --filter @taori/web typecheck` · passed
4. `pnpm test:sidecar` · 27 files / 196 tests passed
5. `pnpm --filter @taori/web exec playwright test --workers=1` · 187 tests passed / 4.4m
6. `pnpm verify:desktop-ui`（默认 UI-only）· passed
   - artifact：`/tmp/taori-desktop-ui-desktop-ui-20260505042232`
   - `summary.json`：`ok=true`，`mode=ui_only`
   - `port-cleanup.json`：`17890` / `5173` 无残留监听
7. `pnpm verify:desktop`（默认无 Keychain、无真实模型）· passed
   - artifact：`/tmp/taori-desktop-smoke-desktop-20260505050007`
   - `summary.json`：`ok=true`，Vite / Rust control channel / Sidecar / renderer health 全部 ready，备份导入会话可见
   - `port-cleanup.json`：`17890` / `5173` 无残留监听
8. `TAORI_DESKTOP_SMOKE_KEYCHAIN=1 TAORI_DESKTOP_SMOKE_REAL_CHAT=1 pnpm verify:desktop` · executed, blocked by local Keychain state
   - artifact：`/tmp/taori-desktop-smoke-desktop-20260505044720`
   - 已通过：桌面壳、Rust control channel、Sidecar、renderer 初始请求、`/v1/selfcheck?include_keychain=1` 临时 Keychain probe
   - 阻塞：`/v1/providers/key-status` 返回两个启用 Provider `key_available=false`（火山方舟、华为云 MaaS），因此未进入真实桌面模型调用
   - 追加修复：Provider key-status 改为串行读取；control channel Keychain 读/写/删增加超时，显式 smoke 的 Keychain 检查串行执行并写清晰失败 artifact
9. `pnpm verify:real` · 完成真实 Provider 旅程，但按结构化模型风险以非 0 退出
   - artifact：`/tmp/taori-real-journey-real-20260505042507`
   - 已通过路径：真实首轮聊天、Persona/Prompt、image_generate、生成图视觉理解、会话工具策略、web_fetch、web_search、普通聊天 MCP、上下文滑窗、compact_context 恢复、高成本恢复确认、第二聊天模型综合、圆桌 Timeline、停止/完成稳定性、备份导入后真实续聊、模型中心/工具设置/成本监控。
   - 结构化风险：`real_skip_tool_model_did_not_follow_tool_call`，真实模型 `deepseek-v3.2` 未按提示调用失败 MCP 工具 `mcp.mcp_3EoOJe7I8Hvc.evidence`，因此无法自然触发 `skip_tool` failure card；诊断：`skip_tool_model_did_not_call_tool-diagnostics.json`，截图：`09h-skip-tool-model-did-not-call-tool.png`。

### T11 · Provider Keychain 缺失可操作化

状态：done · 2026-05-05

目标：显式 Keychain smoke 发现 Provider Key 缺失时，用户不需要看日志；ModelCenter 能主动检查并指出哪些 Provider 需要重新填写 Key，同时继续避免打开页面就触发系统授权弹窗。

范围：

- `apps/web/src/ModelCenter.tsx`
- `apps/web/src/styles.css`
- `apps/web/e2e/m2.5-key-missing.spec.ts`
- 模块合同文档

验收：

- 打开 ModelCenter 不自动调用 `/v1/providers/key-status`。
- 用户点击“检查钥匙串状态”后才读取 Keychain 状态。
- Key 缺失 Provider 显示明确“Key 缺失”状态，并可直接打开重新填写 Key 的 Provider 编辑弹窗。
- 已保存引用但未检查时仍显示中性 Key 引用，不误导为已验证可用。

验证：

- `pnpm --filter @taori/web typecheck` · passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/m2.5-key-missing.spec.ts --workers=1` · 3 tests passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/m2.5-modelcenter.spec.ts --workers=1` · 7 tests passed

结果：

- ModelCenter Provider 区新增“检查钥匙串状态”显式入口，按钮文案说明这是主动读取系统钥匙串。
- 检查后展示缺失数量；缺失 Provider 的 chip 显示“Key 缺失”，点击即可进入重填 Key 流。
- 保存 Provider 新 Key 后清空旧 key-status 缓存，避免 UI 继续显示过期缺失状态。

### T12 · 发布前静态与 Sidecar 回归收敛

状态：done · 2026-05-05

目标：T11 改动触及 ModelCenter 与 Provider Keychain 状态后，补一轮不触发系统 Keychain、不调用真实模型的发布前回归，确认 shared / sidecar / web 合同仍一致。

范围：

- `packages/shared`
- `apps/sidecar`
- `apps/web`

验收：

- shared build 通过。
- sidecar typecheck 与全量 unit 通过。
- web typecheck 通过。
- 不启动显式 Keychain / 真实模型验证，避免重复触发 macOS 授权弹窗。

验证：

- `pnpm --filter @taori/shared build` · passed
- `pnpm --filter @taori/sidecar typecheck` · passed
- `pnpm --filter @taori/web typecheck` · passed
- `pnpm test:sidecar` · 27 files / 196 tests passed

结果：

- Provider key-status 显式检查、Key 缺失重填入口、control channel Keychain 超时保护与已有 Agent Runtime 合同兼容。
- 本轮没有发现新的 sidecar 回归。

### T13 · Web E2E 全量收敛与 hermetic web 工具

状态：done · 2026-05-05

目标：修复 T12 后全量 Web E2E 暴露的尾部失败，保证发布前 mock 用户旅程不依赖真实外网、不卡在系统 Keychain 授权弹窗。

范围：

- `apps/sidecar` 内置 `web_search` / `web_fetch`
- `apps/web` Help Center、备份导入刷新
- `apps/web/e2e`

结果：

- Help Center FAQ 点击稳定性修复，FAQ summary 增加稳定 test id，Help Center 弹层不再使用会导致 Playwright 点击判定不稳定的 spring 位移动画。
- Web E2E sidecar 增加 `TAORI_E2E_HERMETIC_WEB=1`，只在测试环境为 `web_search` / `web_fetch` 注入可控网络响应；生产路径仍走真实 DuckDuckGo / URL fetch。
- 备份导入完成后等待 `onChanged()` 刷新链路完成，减少导入后侧边栏读取竞态。

验证：

- `pnpm --filter @taori/web typecheck` · passed
- `pnpm --filter @taori/sidecar typecheck` · passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/b3-help-center.spec.ts apps/web/e2e/conservative-guidance-journeys.spec.ts apps/web/e2e/expanded-user-journeys.spec.ts --workers=1` · 9 tests passed
- `pnpm --filter @taori/web exec playwright test --workers=1` · 187 tests passed / 4.6m
- 端口清理：`17900` / `5174` / `17890` / `5173` 无残留监听。

### T14 · 恢复门禁细分覆盖与真实 skip_tool 诊断增强

状态：done · 2026-05-05

目标：补齐 T2/T4 的尾部验证口径，证明不同恢复策略都不能绕过成本确认，并让真实 `skip_tool` 验证失败时能区分“模型未调用工具”和“工具失败但恢复卡未出现”。

范围：

- `apps/sidecar/test/agent-runs.test.ts`
- `apps/sidecar/src/chat/tool-policy.ts`
- `apps/sidecar/src/routes/chat.ts`
- `scripts/verify-real-journey.mjs`

结果：

- Sidecar 新增恢复门禁细分单测：
  - `switch_model` 使用目标模型估算成本，未确认时返回 `cost_confirmation_required`，确认后创建子 run。
  - `compact_context` 未确认时不创建 streaming assistant，确认后写入压缩恢复 metadata。
  - `skip_tool` 在月预算达到上限时返回 `cost_confirmation_required`，确认后只在当前恢复 run 禁用失败工具。
- 真实 `skip_tool` 剧本增强：
  - 提示中写入精确 MCP 工具名，要求模型必须调用该工具并原样传 marker。
  - 失败 artifact 增加 `attempt_summary`，包含最新 context 中可见工具名、effective tool、预期工具事件、最近 run header、最后助手文本。
  - 如果预期工具已有 `tool.failed` 但恢复卡未出现，记录为 `tool_failure_did_not_surface_recovery_card`；如果没有工具事件，记录为 `model_did_not_follow_tool_call`。
  - 成功路径额外校验 failure card 确实来自预期失败 MCP 工具，避免误把其他失败当成 `skip_tool` 通过。
- `chat.ts` 继续低风险收敛：
  - 新增 `apps/sidecar/src/chat/tool-policy.ts`，抽出会话工具策略和图像工具模型选择。
  - `/v1/chat`、`/v1/runs/:id/continue`、`/v1/runs/:id/recover` 的工具可见性构建复用同一 helper。
  - `apps/sidecar/src/routes/chat.ts` 从 986 行降至 937 行。

验证：

- `pnpm --filter @taori/sidecar typecheck` · passed
- `pnpm --filter @taori/sidecar test -- agent-runs.test.ts` · 14 tests passed
- `pnpm --filter @taori/sidecar test -- agent-runs.test.ts chat.test.ts m2-3-bus.test.ts` · 3 files / 32 tests passed
- `node --check scripts/verify-real-journey.mjs` · passed

剩余风险：

- 本轮未重跑 `pnpm verify:real`，因为上次真实 Provider 仍阻塞在 `deepseek-v3.2` 不自然调用失败 MCP 工具；脚本现在会产出更明确诊断，但不能保证模型一定遵循工具调用。
- 本轮未跑显式 Keychain / 真实桌面聊天 smoke，避免再次触发 macOS Keychain 授权弹窗；完整发布前仍需用户明确授权后执行。

### T15 · 无 Keychain 发布前静态与 Sidecar 全量回归

状态：done · 2026-05-05

目标：在不触发系统钥匙串、不调用真实模型的前提下，对 T14 之后的 shared / sidecar / web 合同和 Sidecar 全量单测再收敛一轮。

范围：

- `packages/shared`
- `apps/sidecar`
- `apps/web`
- `scripts/verify-real-journey.mjs`
- `scripts/verify-desktop-smoke.mjs`
- `scripts/verify-desktop-ui.mjs`

发现与修复：

- `web-tools.test.ts` 暴露外网依赖：测试在 `buildServer()` 后才 stub `global.fetch`，而 `web_fetch` 工具创建时已捕获原始 fetch，导致全量回归可能访问公共网页并超时。
  - 修复：测试在重新创建 server 前安装 fetch stub，确保 `web_fetch` 单测 hermetic。
- `agent-runs.test.ts` 的 `skip_tool` 恢复测试依赖内置 `builtin.web_fetch`，全量并发时会与 web 工具测试和内置工具状态耦合。
  - 修复：`agent-runs.test.ts` 注入测试专用 `mcp.test.evidence` CapabilityBus 工具，`skip_tool` 测试只验证恢复 run 禁用失败工具，不再接触外网工具。

验证：

- `pnpm --filter @taori/shared build` · passed
- `pnpm --filter @taori/sidecar typecheck` · passed
- `pnpm --filter @taori/web typecheck` · passed
- `node --check scripts/verify-real-journey.mjs && node --check scripts/verify-desktop-smoke.mjs && node --check scripts/verify-desktop-ui.mjs` · passed
- `pnpm --filter @taori/sidecar test -- web-tools.test.ts` · 4 tests passed
- `pnpm --filter @taori/sidecar test -- agent-runs.test.ts` · 14 tests passed
- `pnpm test:sidecar` · 27 files / 199 tests passed

剩余风险：

- 本轮未跑 Web Playwright 全量；上一轮 T13 已有 187 tests passed，T15 改动集中在 Sidecar 单测和测试脚本。
- 本轮继续不跑显式 Keychain / 真实桌面聊天 smoke，避免 macOS 授权弹窗；完整发布前仍需用户明确授权后执行。

### T16 · Web E2E 全量复验与消息操作稳定性

状态：done · 2026-05-05

目标：补齐 T15 后的 Web Playwright 全量用户旅程验证，并修复全量运行中暴露的消息操作按钮 hover 点击脆弱点。

范围：

- `apps/web/src/styles.css`
- `apps/web/e2e/c1-message-actions.spec.ts`
- `apps/web/e2e/c2-stop-continue.spec.ts`

发现与修复：

- 首次 Web 全量复验结果为 `186 passed / 1 failed`。
- 唯一失败为 `c1-message-actions.spec.ts` 的“从指定消息创建分支会话”路径：Playwright 能定位到 `msg-branch`，但 hover 后按钮在显隐过渡中被判定为 not visible / not stable，最终点击超时。
- 根因归入消息操作区交互稳定性：
  - T9/T12 已将 `.msg-actions` 从 opacity-only 改为 `visibility + pointer-events`，避免隐藏按钮进入 `innerText` 和屏幕阅读器。
  - 操作区可见状态仍保留 opacity transition，全量高负载下点击可能落入显隐过渡判定窗口。
- 修复：`.msg:hover .msg-actions`、`.msg:focus-within .msg-actions`、`.msg-actions--visible` 进入可见态时取消 transition，保持真实 hover / focus 可见、可点，同时不回退隐藏态的可访问性处理。

验证：

- `pnpm --filter @taori/web exec playwright test apps/web/e2e/c1-message-actions.spec.ts --workers=1` · 2 tests passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/c1-message-actions.spec.ts apps/web/e2e/c2-stop-continue.spec.ts --workers=1` · 4 tests passed
- `pnpm --filter @taori/web exec playwright test --workers=1` · 187 tests passed / 4.6m
- 端口清理：`17900` / `5174` 无残留监听。

剩余风险：

- 本轮仍未跑显式 Keychain / 真实桌面聊天 smoke，避免 macOS 授权弹窗；完整发布前需在用户明确接受弹窗成本后单独执行。
- 本轮 Web E2E 使用隔离 sidecar、Vite renderer 和测试模型/mock Provider，不覆盖真实模型链路。

### T17 · 无 Keychain 发布就绪收口

状态：done · 2026-05-05

目标：在 T16 全量 Web E2E 通过后，再用 workspace 顶层入口确认跨包类型合同与补丁健康，不触发系统钥匙串、不调用真实模型。

范围：

- workspace scripts
- `docs/product/14-agent-runtime-v1-plan.md`
- `apps/*/MODULE.md`
- `packages/*/MODULE.md`
- `docs/modules/inventory.md`

结果：

- 根级静态入口覆盖 `packages/shared`、`apps/sidecar`、`apps/web` 的 TypeScript 合同。
- 模块合同已记录本阶段关键变更：
  - `apps/sidecar`：`run_events` + `agent_runs`、圆桌 Timeline、Keychain 默认降噪与 key-status 串行读取。
  - `apps/web`：ModelCenter 显式检查钥匙串状态、Help Center 默认轻量自检。
  - `apps/desktop`：桌面验证脚本默认不主动读 Keychain。
  - `packages/shared`：Agent Runtime / recovery / tool metadata 共享 schema。
- 当前剩余发布门槛明确收束为两类：
  - `pnpm verify:real`：真实 Provider 远端链路，可能受模型工具遵循度影响。
  - 显式 Keychain / real desktop smoke：会触发 macOS 钥匙串授权弹窗，需用户明确接受后执行。

验证：

- `pnpm typecheck` · passed
- `pnpm --filter @taori/shared build && pnpm --filter @taori/sidecar build && pnpm --filter @taori/web build` · passed（Vite 仅提示单 chunk 超 500 kB）
- `git diff --check` · passed

剩余风险：

- 本轮不覆盖真实模型、不覆盖系统 Keychain 弹窗路径。
- 当前 worktree 仍包含多轮未提交改动；发布前建议先做一次人工 review 或拆分提交。

### T18 · Browser-first 发布门槛重排

状态：done · 2026-05-05

目标：把后续推进重心明确改为浏览器 WebUI + Sidecar 的完整产品逻辑，避免 Tauri / Keychain 验证反复打断 Web 主线。

范围：

- `package.json`
- `docs/product/14-agent-runtime-v1-plan.md`
- `docs/architecture/11-qa-strategy.md`

结果：

- 新增根级 `pnpm verify:web`，作为默认 Web 产品主线验证入口：
  - `pnpm typecheck`
  - `pnpm test:sidecar`
  - `pnpm --filter @taori/web exec playwright test --workers=1`
- v1.0 发布门槛改为 Browser-first：
  - Sidecar unit
  - Web mock E2E
  - `pnpm verify:web`
  - `pnpm verify:real` 或真实 Provider 风险报告
- Tauri / Keychain 降级为 Desktop follow-up：只验证桌面壳不阻塞产品主线；显式 Keychain / real desktop smoke 不再作为浏览器 WebUI + Sidecar 的默认门槛。

验证：

- 文档与脚本更新为静态变更；T18 不重复跑全量，沿用 T15-T17 的 `typecheck`、Sidecar 199、Web 187、build 通过证据。

剩余风险：

- `verify:web` 串行执行时间约为 Sidecar 全量 + Web 全量之和，适合发布前跑；日常开发仍可跑定向 spec。

### T19 · Browser-first gate 首次执行与消息操作栏命中修复

状态：done · 2026-05-05

目标：按新的 Browser-first 发布门槛实际执行 `pnpm verify:web`，先把浏览器 WebUI + Sidecar 主产品逻辑跑稳；桌面 / Keychain 继续作为后续 opt-in 验证，不阻塞 Web 主线。

范围：

- `apps/web/src/styles.css`
- `docs/product/14-agent-runtime-v1-plan.md`

发现与修复：

- 首次 `pnpm verify:web` 结果为 `typecheck passed`、`Sidecar tests passed`、`Web E2E 186 passed / 1 failed`。
- 唯一失败仍在 `c1-message-actions.spec.ts` 的消息分支路径，但根因比 T16 更具体：`msg-branch` 按钮已可见，真实点击落点被同一条消息里的 `.msg-role` 拦截，随后 hover 状态丢失，按钮回到 hidden。
- 修复：
  - `.msg-role` 增加 `pointer-events: none`，角色 / 模型标签不再抢占操作按钮点击。
  - `.msg-actions` 增加 `position: relative; z-index: 1`，激活后的操作栏稳定浮在消息文本之上。
  - 保留隐藏态的 `visibility: hidden + pointer-events: none`，不回退 T9/T12 解决的 `innerText` 与无障碍污染问题。

验证：

- `pnpm --filter @taori/web exec playwright test apps/web/e2e/c1-message-actions.spec.ts --workers=1` · 2 tests passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/c1-message-actions.spec.ts apps/web/e2e/c2-stop-continue.spec.ts --workers=1` · 4 tests passed
- `pnpm verify:web` · passed
  - `pnpm typecheck` · passed
  - `pnpm test:sidecar` · passed
  - Web Playwright · 187 tests passed / 4.7m

剩余风险：

- 本轮按用户最新优先级不跑 Tauri / Keychain / real desktop smoke，避免 macOS 钥匙串授权弹窗打断。
- `verify:web` 使用 mock provider 和隔离 DB，不证明真实 Provider 工具遵循度；真实模型浏览器旅程仍由后续 `pnpm verify:real` 覆盖。

### T20 · 真实图像工具与 Browser gate 收口

状态：done · 2026-05-06

目标：补齐真实 Provider 下图像工具调用的尾部完成语义，并确认工具失败但模型完成时仍能给用户可恢复路径；继续以 Browser WebUI + Sidecar 作为主发布门槛。

范围：

- `apps/sidecar/src/chat/upstream-tools.ts`
- `apps/sidecar/src/chat/stream-producers.ts`
- `apps/sidecar/test/m2-4-image-gen.test.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`
- `package.json`

发现与修复：

- 部分真实图像模型成功完成 `builtin.image_generate` 后不再输出最终文本，导致前端一直等待流结束语义。
  - 修复：在 runtime state 记录 image generation completed；若图像工具成功后 1.5s 内模型没有 final text，Sidecar 发送短文本 `图片已生成。`，写入 `model.completed` 并完成 `turn.completed`。
- 工具失败后如果模型仍给出最终答复，原链路会把回合视为完成，前端缺少 `skip_tool` 恢复入口。
  - 修复：在 completed turn 中检测 `tool.failed`，补发 `failure_decision` annotation，并设置 `can_skip_tool=true`，让用户能选择跳过失败工具继续。
- 消息操作按钮从文字按钮收敛为稳定 icon button，保留 `aria-label` / `title`。
  - 修复：操作栏始终可见、尺寸固定、点击稳定，避免 hover 竞态，也避免隐藏文字污染 `.innerText()`。

验证：

- `pnpm --filter @taori/sidecar test -- m2-4-image-gen.test.ts` · passed
- `pnpm --filter @taori/sidecar test -- chat.test.ts agent-runs.test.ts web-tools.test.ts` · passed
- `pnpm --filter @taori/sidecar test -- m2-4-image-gen.test.ts agent-runs.test.ts` · passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/c1-message-actions.spec.ts apps/web/e2e/c2-stop-continue.spec.ts --workers=1` · passed
- `pnpm verify:real` · passed
  - artifact：`/tmp/taori-real-journey-real-20260506000254`
  - 覆盖：真实聊天、图像生成、生成图视觉理解、web tools、MCP、compact recovery、高成本确认、skip_tool 恢复、第二模型综合、圆桌 Timeline、停止、备份导入、设置 / 模型 / 成本表面。
- `pnpm verify:web` · passed
  - `pnpm typecheck` · passed
  - `pnpm test:sidecar` · passed
  - Web Playwright · 187 tests passed / 4.2m

剩余风险：

- `verify:real` 证明当前真实 Provider / 模型组合通过，但远端模型工具遵循度仍可能随模型版本变化；后续继续保留 failure artifact 和结构化风险报告。
- 本轮继续不跑显式 Tauri Keychain / real desktop smoke，避免系统钥匙串授权弹窗打断浏览器主线。

## 7. 下一阶段 Todo Queue（Browser-first）

执行原则：

- 先做浏览器 WebUI + Sidecar 的产品完整逻辑；Tauri / Keychain 只保留 opt-in 验证。
- 每个任务完成后必须补：影响模块、验证命令、artifact 或失败风险。
- 不把真实 Provider 不稳定归因成“测试波动”；必须留下可读的 failure artifact。

### T21 · `/v1/chat` 编排层二次拆分

状态：done · 2026-05-06

目标：在不改变 SSE / data stream 协议的前提下，把 `routes/chat.ts` 中剩余的 run action、tool exposure、failure decision、cost gate 继续拆进 `apps/sidecar/src/chat/*`，降低主链路修改风险。

验收：

- `routes/chat.ts` 只保留 HTTP schema、权限、响应绑定和路由注册。
- `continue/recover/chat` 共用同一套上下文准备、工具构建、成本确认和 finalize helper。
- `pnpm --filter @taori/sidecar test -- chat.test.ts agent-runs.test.ts m2-4-image-gen.test.ts web-tools.test.ts` 通过。

当前结果：

- 新增 `apps/sidecar/src/chat/stream-dispatch.ts`，集中处理：
  - data-stream response header / CORS / noDelay 准备。
  - `provider api key → real upstream`、`key missing`、`mock fallback` 三分支。
  - `finalizeOnEnd` 注册和 recover terminal event 回调。
- 新增 `apps/sidecar/src/chat/run-context.ts`，集中处理：
  - 模型价格 / context length / capability 快照。
  - Persona system message 注入。
  - 会话级工具策略与 skip-tool 覆盖。
  - image tool candidate 选择。
- 新增 `apps/sidecar/src/chat/request-prep.ts`，集中处理：
  - 附件总量和文本附件大小校验。
  - PDF 解析与错误语义。
  - Persona 会话绑定和缺失清理。
  - 会话 auto-title。
  - image intent explicit route 与 user/assistant message 预创建。
- `openDataStream()` 统一 data stream lifecycle：header、abort、client close、force finalize。
- `/v1/chat`、`/v1/runs/:id/continue`、`/v1/runs/:id/recover` 已共用 `dispatchChatProducer()`。
- `/v1/chat`、`/v1/runs/:id/continue`、`/v1/runs/:id/recover` 已共用 `buildProduceCtx()`。
- `apps/sidecar/src/routes/chat.ts` 从 937 行降至 558 行；stream wire format 未改变。

验证：

- `pnpm --filter @taori/sidecar typecheck` · passed
- `pnpm --filter @taori/sidecar test -- chat.test.ts agent-runs.test.ts m2-4-image-gen.test.ts web-tools.test.ts` · 4 files / 50 tests passed
- 抽取 `run-context.ts` 后复跑同一命令 · 4 files / 50 tests passed
- 抽取 `request-prep.ts` 与 `openDataStream()` 后：
  - `pnpm --filter @taori/sidecar typecheck` · passed
  - `pnpm --filter @taori/sidecar test -- chat.test.ts agent-runs.test.ts m2-4-image-gen.test.ts web-tools.test.ts c3-templates-personas.test.ts` · 5 files / 52 tests passed
  - `pnpm --filter @taori/web exec playwright test apps/web/e2e/r4.1-pdf-parse.spec.ts --workers=1` · 2 tests passed

剩余风险：

- `routes/chat.ts` 已降至 600 行以下，但 recovery terminal event 构造仍在 route 内；后续如果继续压缩，可单独抽 `recovery-events.ts`。
- 本任务未重复跑 `pnpm verify:web`，放入 T25 发布候选回归统一执行。

### T22 · 上下文窗口管理可视化与边界测试

状态：done · 2026-05-06

目标：把已落库的 context window metadata 做成用户可见解释，并补长对话边界测试，避免长历史导致上游 400 或隐式截断。

验收：

- Run Timeline 能展示原消息数、发送消息数、省略消息数、估算 token 和策略。
- Sidecar 覆盖长历史滑窗、系统提示保留、最近轮次保留、compact_context 后继续。
- Web E2E 覆盖长对话后用户能看到“上下文已压缩/截断”的解释。

结果：

- Run Timeline 的 `context.snapshot` 事件现在展示：
  - 上下文策略：完整上下文 / 滑动窗口。
  - 原消息数、实际发送消息数。
  - 省略消息数。
  - 估算 input tokens 与预算 tokens。
- 长对话 E2E 使用小 context model 稳定触发 sliding window，并从真实 UI 断言“滑动窗口 / 裁剪 N 条 / 统计卡”可见。
- 既有消息内 `context-snapshot-card` 保持不变，继续显示本轮工具可见数量和裁剪摘要。

验证：

- `pnpm --filter @taori/web typecheck` · passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/run-timeline-user-journeys.spec.ts -g "long multi-turn" --workers=1` · 1 test passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/run-timeline-user-journeys.spec.ts --workers=1` · 5 tests passed

剩余风险：

- token 统计仍是启发式估算，不等同各 Provider 的真实 tokenizer；UI 文案用“估算”避免误导。
- 本轮不跑全量 `verify:web`，放入 T25 发布候选回归统一执行。

### T23 · 真实 Provider 风险面板

状态：done · 2026-05-06

目标：把 `pnpm verify:real` 中的结构化风险沉淀为 Web 可读诊断，而不是只在 `/tmp` artifact 中查看。

验收：

- Help Center 或 Control Center 增加“真实模型能力诊断”入口。
- 能显示：工具遵循度、MCP 调用状态、图像生成状态、成本入账状态、最后一次真实 smoke artifact 摘要。
- 不自动发起真实调用；只读取已有诊断或由用户显式触发。

结果：

- 新增 Sidecar 只读诊断接口 `GET /v1/diagnostics/real-provider/latest`：
  - 扫描最近一次 `/tmp/taori-real-journey-*` artifact。
  - 汇总 `events.json` 与 `capability-summary.json` 中的步骤、结构化风险、Agent Run、Run Event、成本调用和选中模型能力。
  - 不读取系统 Keychain、不调用真实模型，只反映最近一次 `pnpm verify:real` 的产物。
- Help Center 新增“真实模型能力诊断”区：
  - 用户显式点击后读取最近真实验证结果。
  - 展示通过步骤、风险数、Runs、成本记录、模型能力、关键步骤状态、结构化风险和 artifact 目录。
  - clean machine 无 artifact 时显示空状态，不误报通过或失败。
- 模块合同同步：
  - `apps/sidecar/MODULE.md` 记录新增诊断 API。
  - `apps/web/MODULE.md` 记录 Help Center 消费诊断 API。
  - `docs/modules/inventory.md` 记录该接口只读 artifact、不触发 Keychain、不替代 `verify:real`。

验证：

- `pnpm --filter @taori/sidecar typecheck` · passed
- `pnpm --filter @taori/web typecheck` · passed
- `pnpm --filter @taori/sidecar test -- diagnostics.test.ts` · 1 file / 2 tests passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/b3-help-center.spec.ts --workers=1` · 1 test passed

剩余风险：

- 诊断面板只读取最近本地产物；它能降低真实 Provider 风险的可见性成本，但不能替代重新执行 `pnpm verify:real`。
- 本轮不跑全量 `verify:web`，放入 T25 发布候选回归统一执行。

### T24 · Cost / Run Timeline 关联细化

状态：done · 2026-05-06

目标：让成本看板从“按会话统计”进一步下钻到 run / event / tool source，方便用户理解每次恢复、工具和圆桌的成本来源。

验收：

- Cost Dashboard 支持按 run 查看模型调用与工具调用。
- Run Timeline 中 `cost.recorded` 可跳转或展开对应成本记录。
- mock E2E 覆盖普通 chat、recover、roundtable 三类成本来源。

结果：

- Sidecar：
  - 普通聊天 `cost.recorded` 事件 payload 增加 `cost_record_id`，并兼容 `actual_usd` / `actual_cost_usd` 展示。
  - 既有圆桌 analyzer / participant / summarizer 成本事件继续携带 `cost_record_id`。
  - `/v1/costs/calls` 返回最近调用日志时附加 `run_id`、`run_event_id`、`run_event_kind`、`run_event_label`，读路径通过 `cost_record_id` 和 source 信息反查最近 `cost.recorded` run event。
  - 不新增表、不迁移 DB；`cost_records` 仍是成本流水，`run_events` 仍是运行观测真相源。
- Web：
  - Cost Dashboard 最近调用日志展示 Cost ID、Run ID、运行事件标签。
  - Run Timeline 的 `cost.recorded` meta 展示同一 Cost ID，用户可在两个视图之间对照普通聊天、恢复动作和圆桌参与者成本。

验证：

- `pnpm --filter @taori/sidecar typecheck` · passed
- `pnpm --filter @taori/web typecheck` · passed
- `pnpm --filter @taori/sidecar test -- costs.test.ts` · 1 file / 2 tests passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/d1-d2-cost-dashboard-budget.spec.ts -g "D1 cost dashboard" --workers=1` · 1 test passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/m2.1-failure-decision.spec.ts -g "compact context" --workers=1` · 1 test passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/run-timeline-user-journeys.spec.ts -g "roundtable discussion" --workers=1` · 1 test passed

剩余风险：

- 当前是“可对照”而非真正跨面板跳转；Cost Dashboard 展示 Run/Event ID，Run Timeline 展示 Cost ID。完整点击联动可作为后续 UI polish。
- 曾尝试并行启动多个 Playwright 进程，被项目锁拒绝；后续仍必须单 Playwright 进程串行跑 E2E。

### T25 · Browser-first 发布候选回归

状态：done · 2026-05-06

目标：在 T21-T24 完成后生成一次 Web 产品主线发布候选证据，不触发系统 Keychain。

验收：

- `pnpm verify:web` 通过。
- `pnpm verify:real` 通过，或输出真实 Provider 风险报告并确认不是本地逻辑 regression。
- `git diff --check` 通过。
- 文档记录最终 artifact、剩余风险和桌面 follow-up 边界。

验证结果：

- `pnpm verify:web` · passed，187 个 Chromium 浏览器 E2E 全部通过，耗时约 4.3 分钟。
  - 覆盖：Help Center、ModelCenter、Run Timeline、Cost Dashboard、backup import、stop/continue、recover、roundtable、command palette、错误矩阵、长历史、视觉布局等 WebUI + Sidecar 主路径。
  - 本命令包含 `pnpm typecheck` 与 `pnpm test:sidecar`，二者均已通过。
- `git diff --check` · passed。
- 本轮未重新执行 `pnpm verify:real`，因为脚本会读取 `/v1/providers/key-status`，在桌面/Keychain 模式下可能触发 macOS 钥匙串授权弹窗；按 Browser-first 决策，改用最近真实 Provider artifact 做风险报告。
- 最近真实 Provider artifact：`/tmp/taori-real-journey-real-20260506000254`
  - `events.json`：27 个步骤，`structured_risks=[]`。
  - `capability-summary.json`：覆盖真实 tool chat、image、vision 模型选择。
  - `run-events.json` / `cost-calls.json`：包含真实聊天、工具、恢复、圆桌、备份导入后续聊的运行与成本证据。

剩余风险：

- `verify:web` 证明浏览器 WebUI + Sidecar mock/隔离 DB 主线稳定，不证明远端模型持续遵循工具调用。
- 真实 Provider 风险通过最近 artifact 覆盖；下次需要 live 真实模型验收时，应优先使用不读取 Keychain 的 artifact/report 模式，或明确 opt-in 触发 Keychain。
- Desktop / Keychain deep smoke 继续作为桌面封装 follow-up，不阻塞 Web 产品主线。

### T26 · 浏览器主线缺陷清单复扫

状态：done · 2026-05-06

目标：把当前长周期 worktree 中浏览器 WebUI + Sidecar 的用户旅程风险再扫一遍，只处理会影响 Web 产品闭环的问题，继续暂缓 Tauri / Keychain 深度验证。

验收：

- 复扫 Help Center、ModelCenter、Run Timeline、Cost Dashboard、backup import、stop/continue、recover、roundtable 的测试覆盖。
- 每个发现归类为：必须修复 / 可延后 / 已由 T21-T25 覆盖。
- 输出下一轮 ordered todo，不把桌面弹窗问题重新混入 Web 主线。

复扫结论：

| 路径 | 覆盖结论 | 分类 |
|---|---|---|
| Help Center | `b3-help-center.spec.ts` + diagnostics API 单测已覆盖轻量自检与真实能力诊断入口 | 已由 T21-T25 覆盖 |
| ModelCenter | `m1.8-dod-final`、`r3.1-mc3-reorder`、`r5-user-journey`、`r5-demoted-badge`、模型健康面板等已在 `verify:web` 通过 | 已由 T21-T25 覆盖 |
| Run Timeline | `run-timeline-user-journeys.spec.ts` 覆盖普通 chat、recover、roundtable；真实 artifact 含 run-events | 已由 T21-T25 覆盖 |
| Cost Dashboard | `d1-d2-cost-dashboard-budget.spec.ts` 与真实 artifact 覆盖成本看板、确认、最近调用日志 | 已由 T21-T25 覆盖 |
| Backup import | `e2-backup-restore.spec.ts` 与真实 artifact `backup_import_real_chat` 覆盖导入后侧栏与续聊 | 已由 T21-T25 覆盖 |
| Stop / continue | `c2-stop-continue.spec.ts` 覆盖停止、持久续写、高成本续写确认 | 已由 T21-T25 覆盖 |
| Recover | `m2.1-failure-decision.spec.ts`、`m2.1-skip-tool-recovery.spec.ts`、sidecar `agent-runs.test.ts` 覆盖 retry/switch/skip/compact 主路径 | 已由 T21-T25 覆盖 |
| Roundtable | `m3a.*`、`r5-user-journey`、`run-timeline-user-journeys` 覆盖启动、轮次、总结、Timeline、成本 | 已由 T21-T25 覆盖 |

下一轮 ordered todo：

1. T27 · Keychain-free 真实 Provider 风险报告：给 `verify:real` 增加只读 artifact/report 模式，用于 Browser-first 发布门槛，不读取 `/v1/providers/key-status`。
2. T28 · Cost ↔ Run Timeline 跨面板联动：从 Cost Dashboard 最近调用日志定位到对应 run/event，从 Timeline `cost.recorded` 定位 Cost ID。
3. T29 · 浏览器主线 release note / known risks：生成面向发布的 WebUI + Sidecar 验收摘要，列出 Desktop follow-up 边界。
4. T30 · Desktop / Keychain opt-in 阶段：只在 Web 主线稳定后再处理桌面壳、Keychain 授权频率和 macOS 弹窗体验。

### T27 · Keychain-free 真实 Provider 风险报告

状态：done · 2026-05-06

目标：让 Browser-first 发布门槛可以复用最近 `verify:real` artifact 生成风险报告，不启动浏览器、不请求 Sidecar、不读取 `/v1/providers/key-status`，从而避免 macOS Keychain 授权弹窗。

结果：

- `package.json` 新增 `pnpm verify:real:report`。
- `scripts/verify-real-journey.mjs --report` 只扫描 `/tmp` 与系统 temp 下最近的 `taori-real-journey-*` 目录，读取 `events.json`、`capability-summary.json`、`runs.json`、`run-events.json`、`cost-calls.json`。
- 生成 `real-provider-report.json`，输出：
  - required steps 是否齐全；
  - structured risks；
  - run / run event / cost call 数量；
  - 真实模型选择与最终截图路径。
- report 模式失败时不再创建新的空 artifact 目录。

验证：

- `pnpm verify:real:report` · passed，读取 `/tmp/taori-real-journey-real-20260506000254`，生成 `/tmp/taori-real-journey-real-20260506000254/real-provider-report.json`。
  - `passed_steps=27`
  - `failed_steps=0`
  - `risk_count=0`
  - required steps 全部 `ok=true`
- `node --check scripts/verify-real-journey.mjs` · passed
- `git diff --check` · passed

剩余风险：

- 该模式只证明最近 artifact 的风险状态，不会重新验证远端 Provider 当前可用性。
- live 真实模型验证仍使用 `pnpm verify:real`，需要明确接受可能触发 Keychain 的前置检查，或后续继续把 live 模式也改成 dev-file/env key 优先。

### T28 · Cost ↔ Run Timeline 跨面板联动

状态：done · 2026-05-06

目标：用户在 Cost Dashboard 看到一条模型/工具调用成本后，可以直接定位到对应会话的 Run Timeline 事件，解释这笔成本来自哪一次运行。

结果：

- Cost Dashboard 最近调用日志新增“查看运行”动作。
- 点击后通过浏览器内事件 `taori:focus-run-event`：
  - 关闭 Control Center；
  - 切换到对应 conversation；
  - 打开 Run Timeline；
  - 高亮对应 `run_event_id`，优先定位 `cost.recorded` 事件。
- Run Timeline 为 run group / run event 增加稳定定位属性与高亮样式：
  - `data-run-id`
  - `data-event-id`
  - `data-focused`
- 不新增 Sidecar API；继续复用 `/v1/costs/calls` 中已有的 `run_id` / `run_event_id` / `cost_record_id`。

验证：

- `pnpm --filter @taori/web typecheck` · passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/d1-d2-cost-dashboard-budget.spec.ts -g "D1 cost dashboard" --workers=1` · 1 test passed

剩余风险：

- T31 已补齐 Timeline → Cost Dashboard 反向跳转；T28 的单向风险关闭。
- 跨面板联动使用浏览器内事件，避免新增全局状态依赖；如果后续引入 URL 路由，可迁移为 query/hash 深链。

### T29 · 浏览器主线 release note / known risks

状态：done · 2026-05-06

目标：把 WebUI + Sidecar 发布候选证据沉淀成可读摘要，避免后续反复追问“哪些已验证、哪些仍是风险、桌面是否阻塞”。

结果：

- 新增 `docs/product/15-browser-first-release-candidate.md`：
  - 明确发布边界：Browser WebUI + Sidecar；
  - 汇总已验证能力；
  - 记录 `verify:web`、`verify:real:report`、定向 T28 验证；
  - 列出 Known Risks；
  - 把 Desktop / Keychain opt-in 放入后续 T30。
- 更新 `docs/README.md` 文档索引。

验证：

- 文档为产品层变更，不触发代码编译。
- T29 依赖的验证证据来自 T25-T28：
  - `pnpm verify:web` · 187 passed
  - `pnpm verify:real:report` · passed
  - `pnpm --filter @taori/web typecheck` · passed
  - T28 定向 E2E · 1 passed

### T30 · Desktop / Keychain opt-in 阶段

状态：done · 2026-05-06

目标：减少 macOS “Taori 想要使用钥匙串机密信息”弹窗，把 Keychain 读取收敛到明确的用户动作或显式 opt-in 验证脚本。WebUI + Sidecar 默认浏览、诊断和 release report 不应隐式读取系统 Keychain。

结果：

- Sidecar `GET /v1/providers/key-status` 在 `keystore.kind === 'keychain'` 且缺少 `confirm_keychain=1` 时返回 `validation_error`，并带 `details.requires_keychain_confirmation=true`；该路径不会调用 `keystore.read`。
- ModelCenter 的“检查钥匙串状态”按钮改为调用 `/v1/providers/key-status?confirm_keychain=1`，保持用户显式检查语义。
- `verify:desktop` 的 Keychain 深度分支继续只在 `TAORI_DESKTOP_SMOKE_KEYCHAIN=1` 时执行，并改用确认参数读取 provider key-status。
- live `verify:real` 若执行前置能力扫描，会显式带 `confirm_keychain=1`；Browser-first 门槛仍优先使用 `verify:real:report`，该模式不请求 Sidecar、不读取 Keychain。
- 更新 `apps/web/MODULE.md`、`apps/sidecar/MODULE.md` 与 `docs/modules/inventory.md`，把 key-status 合同改为 Keychain 模式默认拒绝隐式读取。

验证：

- `pnpm --filter @taori/sidecar test -- providers.test.ts` · passed
- `pnpm --filter @taori/web typecheck` · passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/m2.5-key-missing.spec.ts --workers=1` · passed
- `node --check scripts/verify-real-journey.mjs` · passed
- `node --check scripts/verify-desktop-smoke.mjs` · passed
- `git diff --check` · passed

剩余风险：

- 发送消息、测试连接、模型同步仍可能读取 Provider Key，这是产品必须的真实调用路径；需要通过文案和交互让用户知道这些动作会访问已保存机密。
- Desktop 端仍需后续做持久授权体验优化，例如减少 dev binary 签名变化导致的重复系统授权。

### T32 · Browser release checklist 自动化

状态：done · 2026-05-06

目标：把 Browser-first 发布门槛合并为一个命令，减少人工漏跑验证项，并保留每一步日志 artifact。

结果：

- 新增 `scripts/verify-browser-rc.mjs`。
- 新增 root scripts：
  - `pnpm verify:browser-rc`
  - `pnpm verify:browser-rc:report`
- 脚本串行执行：
  - `pnpm verify:web`
  - `pnpm verify:real:report`
  - `git diff --check`
- 每步写入 `/tmp/taori-browser-rc-*/*.log`，并持续刷新 `summary.json`；任何步骤失败立即停止并保留失败上下文。
- 同步写入 `/tmp/taori-browser-rc-*/report.md`，把门禁状态、耗时、命令、日志路径、Playwright passed 数和真实 Provider `risk_count` 摘成可直接阅读的发布报告。
- `pnpm verify:browser-rc:report` 只读最近 artifact 的 `summary.json`，重建并打印 `report.md`，不重新跑 E2E。
- 该命令不启动 Desktop、不发 live 真实模型调用、不读取系统 Keychain；真实 Provider 风险只来自最近 artifact report。

验证：

- `node --check scripts/verify-browser-rc.mjs` · passed
- `pnpm verify:browser-rc` · passed
  - artifact：`/tmp/taori-browser-rc-browser-rc-20260506020212`
  - summary：`/tmp/taori-browser-rc-browser-rc-20260506020212/summary.json`
  - report：`/tmp/taori-browser-rc-browser-rc-20260506020212/report.md`
  - duration：269516ms
  - `verify_web`：passed，`verify:web` 内部 187 passed
  - `verify_real_report`：passed，最近真实 Provider artifact `risk_count=0`
  - `diff_check`：passed
- `TAORI_BROWSER_RC_REPORT_DIR=/tmp/taori-browser-rc-browser-rc-20260506020212 pnpm verify:browser-rc:report` · passed
  - 只读输出 `report.md`，未重新执行 E2E。

回归安排：

- Browser RC 再回归已沉淀为 `docs/product/15-browser-first-release-candidate.md` 第 6 节 Playbook。
- 触发条件：WebUI 主旅程、Sidecar 主链路、shared schema/API contract/E2E fixtures 或发布前证据刷新。
- 失败策略：先读 artifact 日志并跑最小定向验证，不直接重复全量。

### T33 · Desktop dev Keychain 降噪

状态：done · 2026-05-06

目标：降低日常桌面开发打开 Taori 时的 macOS Keychain 弹窗频率，保留真实 Keychain 路径为显式 opt-in。

结果：

- 新增 `scripts/dev-desktop.mjs`，root `pnpm dev:desktop` 改为走该包装脚本。
- `pnpm dev:desktop` 默认设置 `TAORI_DESKTOP_DEV_KEYSTORE=dev_file`。
- Rust sidecar launcher 在 `TAORI_DESKTOP_DEV_KEYSTORE=dev_file` 时不向 Sidecar 注入 `CONTROL_URL` / `CONTROL_BEARER`，Sidecar 因此使用 dev_file keystore，不触发系统 Keychain。
- 显式设置 `TAORI_DESKTOP_DEV_KEYSTORE=keychain pnpm dev:desktop` 时继续使用真实 OS Keychain。
- `verify:desktop` / `verify:desktop-ui` 默认使用 dev_file；只有 Keychain 或真实聊天 opt-in 时才切回 keychain。

验证：

- `node --check scripts/dev-desktop.mjs` · passed
- `node --check scripts/verify-desktop-smoke.mjs` · passed
- `node --check scripts/verify-desktop-ui.mjs` · passed
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml sidecar::tests::dev_file_keystore_is_explicit_opt_in` · passed
- `pnpm --filter @taori/desktop tauri help` · passed

剩余风险：

- 本轮未执行真实 Desktop Keychain smoke，避免再次触发系统授权弹窗。
- release build 的签名、bundle id 和 Keychain 持久授权频率仍需要单独验证；作为 T34 跟进。

### T31 · Timeline → Cost Dashboard 反向跳转

状态：done · 2026-05-06

目标：用户在 Run Timeline 看到 `cost.recorded` 事件后，可以直接回到 Cost Dashboard 最近调用日志中对应的成本记录，完成 Cost ↔ Timeline 双向解释闭环。

结果：

- Run Timeline 的 `cost.recorded` 事件新增“查看成本”动作。
- 点击后通过浏览器内事件 `taori:focus-cost-call`：
  - 打开 Control Center 的成本页；
  - 收起 Run Timeline，避免两个面板互相遮挡；
  - 刷新最近调用日志；
  - 按 `cost_record_id` 滚动并高亮对应 `cost-call-log-row`。
- Cost Dashboard 调用日志新增稳定定位属性：
  - `data-cost-record-id`
  - `data-run-id`
  - `data-run-event-id`
  - `data-focused`
- 不新增 Sidecar API；继续复用 `run_events.payload.cost_record_id` 与 `/v1/costs/calls`。
- T31.1 补充：`/v1/costs/calls` 支持 `cost_record_id` 精确查询，Cost Dashboard 聚焦时会把目标记录插入最近调用日志顶部，避免受最近 50 条窗口限制。

验证：

- `pnpm --filter @taori/web typecheck` · passed
- `pnpm --filter @taori/sidecar typecheck` · passed
- `pnpm --filter @taori/sidecar test -- costs.test.ts` · 1 file / 2 tests passed
- `pnpm --filter @taori/web exec playwright test apps/web/e2e/d1-d2-cost-dashboard-budget.spec.ts --workers=1` · 2 tests passed
- `git diff --check` · passed
- `pnpm verify:browser-rc` · passed，artifact：`/tmp/taori-browser-rc-browser-rc-20260506020212`

剩余风险：

- 当前是浏览器内事件联动；未来如果引入 URL 路由或深链，可以迁移为可复制链接。
- 已通过 `cost_record_id` 精确查询关闭“极旧调用不在最近列表中”的定位风险。
