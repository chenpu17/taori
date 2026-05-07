# 19 · v1.0 Agent Runtime 变更提案

Status: implementation checkpoint
Owner: Taori
Date: 2026-05-04
Scope: `apps/sidecar` + `apps/web` + `packages/shared` + QA

## 1. 背景

Taori 已经具备聊天、模型中心、Capability Bus、MCP、圆桌、成本看板和 Run Timeline 的基础设计。当前短板不是缺少更多入口，而是运行过程的状态真相分散在 `/v1/chat` 流、消息状态、成本记录、工具 annotation 和 Renderer 内存状态里。

v1.0 需要把“一轮用户请求”提升为一等运行实体：可持久化、可恢复、可解释、可验证。

## 2. 设计原则

- Sidecar 拥有 run 状态真相，Renderer 不自行推断业务状态。
- 所有恢复行为必须可解释，写入 Run Timeline。
- 首版保持用户可控：建议、确认、继续，不做静默自治循环。
- 真实模型行为是验收对象，mock E2E 只覆盖确定性回归。
- Vercel AI SDK 继续作为 provider streaming/tool transport；Agent Runtime 是 Taori 自己的状态机与恢复策略层。

## 3. 核心模型

```ts
type AgentRunStatus =
  | 'created'
  | 'context_ready'
  | 'streaming'
  | 'tool_calling'
  | 'waiting_user_confirm'
  | 'stopped'
  | 'incomplete'
  | 'retrying'
  | 'failed'
  | 'completed';

type AgentRunKind =
  | 'chat'
  | 'continue'
  | 'retry'
  | 'tool_recovery'
  | 'roundtable';

interface AgentRun {
  id: string;
  conversation_id: string;
  parent_run_id?: string | null;
  user_message_id?: string | null;
  assistant_message_id?: string | null;
  kind: AgentRunKind;
  status: AgentRunStatus;
  model_id?: string | null;
  recovery_policy?: string | null;
  created_at: number;
  updated_at: number;
}
```

实现决策：新增 `agent_runs` 作为物化 Header 表，服务 `/v1/conversations/:id/runs` 的低成本查询；`run_events` 仍是 append-only 真相源。事件写入时同步 upsert Header，旧数据或 Header 缺失时继续从 events 推导兜底。

## 4. Run Event 合同

`run_events` 必须覆盖：

| kind | 说明 |
|---|---|
| `turn.started` | 用户请求进入 Sidecar |
| `context.snapshot` | 本轮实际使用的 Persona、附件、工具策略、历史窗口摘要 |
| `model.started` / `model.completed` / `model.failed` | Provider 调用生命周期 |
| `tool.started` / `tool.completed` / `tool.failed` | Capability Bus / MCP 工具生命周期 |
| `cost.recorded` / `cost.failed` | 成本入账结果 |
| `turn.stopped` | 用户主动停止 |
| `turn.incomplete` | 已产生部分 assistant 内容，可续写 |
| `recovery.suggested` | Sidecar 给出的恢复动作 |
| `recovery.started` / `recovery.completed` / `recovery.failed` | 用户确认后的恢复 |
| `turn.completed` / `turn.failed` | 回合终态 |

事件写入失败不阻断主链路，但必须 warn，并尽量降级写入不带 FK 的事件，避免成本和运行解释静默丢失。

## 5. API 变更

新增或固化：

- `GET /v1/conversations/:id/run-events?limit=120`
- `GET /v1/conversations/:id/runs?limit=20`
- `POST /v1/runs/:id/continue`
- `POST /v1/runs/:id/retry`
- `POST /v1/runs/:id/recover`

扩展：

- `/v1/chat` 返回或 annotation 携带 `run_id`。
- `/v1/tools/invoke` 接受可选 `run_id`，用于归因手动工具调用。
- `/v1/costs/calls` 返回 `run_id`，便于从成本流水跳回运行过程。

## 6. Sidecar 开发任务

1. Shared schema：新增 `AgentRunStatus`、`RunEventKind`、恢复动作 schema。
2. DB/repo：完善 `run_events`，新增 `agent_runs` Header 表。
3. Chat orchestration：已拆出上下文窗口、恢复解析、continue/recover 上下文组装、上游工具构建和 run-stream 支撑逻辑；后续继续把 provider/mock/key-missing streaming lifecycle 从 route 中分离。
4. Abort/continue：停止时写 `turn.stopped` 和 `turn.incomplete`；续写通过 run API 关联原 run。
5. Recovery policy：实现用户确认后的 retry/switch-model/skip-tool/compact-context；其中 `skip_tool` 只对当前恢复 run 临时禁用最后失败工具，不修改用户全局工具配置。
6. Roundtable lifecycle：analyzer、participant round、participant retry、summarizer、cancel 写入 `kind='roundtable'` run events。
7. Cost/event FK hardening：所有事件和成本写入都能在消息或会话被删除时降级记录。
8. Real verification hooks：提供只读能力检查接口，不引入生产外行为。

## 7. Renderer 开发任务

1. 运行过程侧栏：按 run 分组展示事件、状态、模型、工具、成本。
2. 消息操作：截断消息和失败消息显示“续写/继续解决/重试”。
3. 恢复确认：展示 Sidecar 建议、预估成本、风险和候选模型，由用户确认。
4. 控制中心：模型健康和工具健康入口。模型健康复用 ModelCenter；工具健康通过 `/v1/tools/health` 展示最近 24h 调用、失败、耗时和最近失败分类。
5. E2E testid：为 run panel、recovery action、status chip、event row 提供稳定 testid。

## 8. 真实模型验证设计

`pnpm verify:real` 增加 agent-runtime 剧本：

1. 读取当前本地 Sidecar endpoint 和 bearer。
2. 检查真实 Provider / Model / Tool 前置条件：
   - 一个启用且 Key 可用的 chat/multimodal 模型。
   - 一个支持 tools 的 chat/multimodal 模型。
   - 一个 image 模型。
   - 一个 vision-capable 模型。
   - `builtin.web_fetch`、`builtin.web_search`、`builtin.image_generate` 启用。
3. 通过真实浏览器执行：
   - 普通多轮聊天。
   - 打开 Run Timeline 并确认 run 事件。
   - 停止长回复，再刷新页面，确认续写入口仍在。
   - 点击续写，确认新 run 关联旧 incomplete run。
   - 发起需要工具的请求，确认工具事件或记录“模型未调用工具”的真实风险。
   - 构造工具失败路径，确认失败决策展示跳过工具动作，用户确认后恢复 run 不再暴露该失败工具。
   - 图像生成后回流视觉模型解释图片。
   - 打开成本看板，确认 run 成本入账。
4. 产物写入 `/tmp/taori-real-journey-<run_id>/`：
   - screenshots
   - events.json
   - costs.json
   - models.json
   - failure.json（失败时）

真实模型验证允许因为供应商额度、模型工具遵循度、外网失败而失败，但失败必须结构化记录，不能当作 mock E2E 通过的替代。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| run 状态机改动影响聊天主链路 | 先做 append-only event，不改变流式协议；状态 API 逐步接入 UI |
| AI SDK tool behavior 在真实模型上不稳定 | `verify:real` 区分“系统 bug”和“模型未遵循工具调用” |
| 事件量过大 | 默认 limit 120，payload 只存摘要，不存完整 prompt/附件 |
| 恢复动作产生额外成本 | 所有恢复动作先估算，超过阈值必须确认 |
| FK 竞争导致事件丢失 | 写入 FK 失败时降级为 `message_id=null`，再降级为 `conversation_id=null` |

## 10. 验证矩阵

| 层级 | 命令/入口 | 必须覆盖 |
|---|---|---|
| L1 | `pnpm test:sidecar` | run repo、状态机、FK 降级、恢复策略 |
| L2 | `pnpm typecheck` | shared/web/sidecar 合同一致 |
| L3 | `pnpm test:e2e` | Run Timeline、停止续写、恢复 UI、模型/工具健康 |
| L4 | `pnpm verify:real` | 真实模型多轮、工具、图像/视觉、停止续写、成本入账 |
| L5 | Tauri manual smoke | 桌面启动、Keychain、刷新、导入备份后真实聊天 |

当前定向验收清单：

- `pnpm --filter @taori/sidecar test -- agent-runs.test.ts m2-1-failure-decision.test.ts`
- `pnpm --filter @taori/sidecar test -- m3a-2-rounds.test.ts m3a-3-summary-export.test.ts`
- `pnpm --filter @taori/web test:e2e -- m2.1-skip-tool-recovery.spec.ts`
- `pnpm --dir apps/web exec playwright test run-timeline-user-journeys.spec.ts -g "roundtable discussion"`

## 11. 决策

- [ ] Approved
- [ ] Rejected
- [x] Needs implementation review

Decision notes:

- 已采用 `agent_runs` Header 表，保留 `run_events` 推导兜底。
- D4 工具健康视图、真实圆桌 Timeline 和成本来源追踪已落地并纳入真实模型验证。
- 下一步重点不再扩大恢复动作种类，而是继续拆分 chat 主链路、补高成本恢复确认和 Tauri manual smoke。
