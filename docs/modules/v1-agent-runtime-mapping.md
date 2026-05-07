# v1.0 · Agent Runtime · 特性到模块映射

Status: draft
Owner: Taori
Date: 2026-05-04
Scope: Run Timeline / Agent Run 状态机 / 恢复动作 / 真实模型验证

## 1. 特性边界

- 把每次用户请求建模为可查询的 run。
- 将停止、续写、失败、重试、工具恢复和成本入账统一到 Sidecar 运行状态。
- Renderer 只展示状态、发起动作和呈现确认，不拥有业务状态真相。
- 真实模型端到端验证纳入发布门槛。

## 2. 模块映射

| 模块 | 改动类型 | 职责 |
|---|---|---|
| `packages/shared` | contract | 新增 `AgentRunStatus`、`RunEventKind`、`RecoveryAction`、`RunTimeline` schema/type；`skip_tool` 恢复请求可携带目标工具名 |
| `apps/sidecar` | contract + collaboration + state | 拥有 chat/continue/recover/roundtable run 生命周期、事件写入、恢复策略、成本归因和查询 API；执行 retry/switch/compact/skip-tool |
| `apps/sidecar/capability-bus` | collaboration | 工具调用接收 `run_id`，写 tool lifecycle event，失败进入统一恢复候选 |
| `apps/web` | contract consumer + UX | 渲染运行过程侧栏、消息恢复入口、恢复确认、模型/工具健康视图；圆桌会话可直接打开 Timeline |
| `apps/desktop` | verification only | Tauri smoke 覆盖 Sidecar 重启、Keychain、真实聊天；首版不新增 API |
| `scripts/verify-real-journey.mjs` | QA executable | 新增 agent-runtime 真实模型用户旅程 |
| `docs/architecture` / `docs/product` | governance | 记录状态归属、接口、验收和暂缓范围 |

## 3. 依赖方向

- `apps/web` → `apps/sidecar`
  - 查询 run/rimeline。
  - 发起 continue/retry/recover，不自行决定恢复语义。
  - 不直接写 run 状态。
- `apps/sidecar` → `packages/shared`
  - 使用共享 schema 校验 API 输入/输出。
- `apps/sidecar/capability-bus` → `apps/sidecar` run context
  - 工具调用只接收上下文，不拥有 run repo。
- `scripts/verify-real-journey.mjs` → Web UI + Sidecar read API
  - 用浏览器驱动用户路径，用 Sidecar 只读 API 做能力检查和产物收集。

## 4. 状态归属

| 状态 | Owner | 说明 |
|---|---|---|
| run status | `apps/sidecar` | 由聊天、工具、恢复和 finalize 路径推进 |
| run events | `apps/sidecar` | append-only；写入失败不阻断主链路 |
| incomplete assistant message | `apps/sidecar` | 消息 `status='incomplete'` 是续写真相 |
| recovery suggestion | `apps/sidecar` | 基于错误分类、模型健康、失败工具、上下文窗口和成本阈值生成 |
| recovery confirmation UI | `apps/web` | 展示建议并收集用户确认 |
| visible timeline panel state | `apps/web` | 纯 UI 状态，可丢失 |
| real provider prerequisites | `scripts/verify-real-journey.mjs` | 只读检查，不修改用户配置 |

## 5. 接口变化

新增：

- `GET /v1/conversations/:id/runs?limit=20`
- `GET /v1/conversations/:id/run-events?limit=120`
- `POST /v1/runs/:id/continue`
- `POST /v1/runs/:id/retry`
- `POST /v1/runs/:id/recover`

扩展：

- `/v1/chat` annotation 增加 `run_id`。
- `/v1/tools/invoke` request 可选 `run_id`。
- `/v1/costs/calls` response 增加 `run_id`。

## 6. 开发顺序

1. `packages/shared` 合同先行。
2. `apps/sidecar` run repo + append-only event 写入。
3. `/v1/chat` lifecycle 接入，不改变前端表现。
4. Web Run Timeline panel 接入。
5. 圆桌 analyzer/round/summarizer/cancel 接入 `run_events` / `agent_runs`。
6. 停止/续写持久化动作接入。
7. recovery API + UI 确认，包括 `retry_same_model` / `switch_model` / `compact_context` / `skip_tool`。
8. 模型/工具健康补齐。
9. `verify:real` agent-runtime 剧本。

## 7. 验证责任

| 验证 | Owner | 通过标准 |
|---|---|---|
| Sidecar unit | `apps/sidecar` | run 状态机、FK 降级、恢复策略、成本归因通过 |
| Web E2E mock | `apps/web` | 用户可见路径稳定，不依赖真实 Provider；覆盖 chat、recovery、roundtable Timeline |
| Real provider E2E | `scripts/verify-real-journey.mjs` | 真实模型完成多轮、工具/图像/视觉、停止续写、compact/skip-tool、timeline、成本 |
| Tauri smoke | `apps/desktop` + manual | 桌面壳、Keychain、刷新和真实聊天可用 |

## 8. 主要风险

- `/v1/chat` 过大：应抽出 `runLifecycle` helper，而不是继续堆在 route 文件。
- Renderer 重新引入内存真相：所有可恢复业务状态必须由 Sidecar 查询。
- 真实模型工具调用不稳定：验证脚本必须区分系统失败与模型不遵循工具。
- 成本确认被恢复动作绕过：恢复 API 必须复用现有成本确认策略。
