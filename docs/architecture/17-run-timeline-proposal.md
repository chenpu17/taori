# 变更提案：P1 Run Timeline 运行过程可观测

Status: accepted
Owner: Taori
Date: 2026-05-03
Scope: agent-runtime / sidecar / renderer

## 1. 问题

Taori 已支持多轮对话、Persona、会话级工具策略、上下文快照、工具调用和成本记录，但这些信息主要分散在流式 annotation、消息卡片和成本面板中。用户在真实多模型、多工具组合使用后，很难复盘某一轮到底用了什么模型、哪些工具、何时失败、成本如何产生。

目标行为：

- 每个聊天回合形成持久化运行事件。
- Web UI 可从会话视角查看最近运行过程。
- 该能力只做可观测和解释，不做自动模型路由决策。

## 2. 影响范围

- 模块：
  - `packages/shared`: 新增 RunEvent/RunTimeline 合同类型。
  - `apps/sidecar`: 新增 `run_events` 存储、repo、conversation 查询接口，并在 `/v1/chat` 记录事件。
  - `apps/web`: 新增运行过程入口与侧边面板。
- Spec / 文档：
  - `docs/product/12-run-timeline.md`
  - `docs/modules/inventory.md`
- 接口：
  - 新增 `GET /v1/conversations/:id/run-events?limit=120`
- 状态 / 存储：
  - 新增 SQLite 表 `run_events`
- 部署 / 运维：
  - 无新增环境变量；DB 初始化使用幂等 `CREATE TABLE IF NOT EXISTS`。

## 3. 当前合同

- `/v1/chat` 负责聊天回合持久化、流式输出、工具调用、成本记录。
- Renderer 通过流式 annotation 展示 context/tool/cost，但 annotation 不是独立可查询状态。
- `cost_records` 只记录成本结果，不表达运行步骤。

## 4. 拟议变更

- 新增 `RunEvent` 合同：`run_id/conversation_id/message_id/kind/status/label/summary/payload/created_at`。
- `/v1/chat` 在关键节点写入事件：
  - `turn.started`
  - `context.snapshot`
  - `model.started/completed/failed`
  - `tool.started/completed/failed`
  - `cost.recorded`
  - `capability.routed`
  - `turn.completed/cancelled/failed`
- Web 会话条新增“运行过程”按钮，打开最近事件面板，按 `run_id` 分组展示。

## 5. 兼容性

- 向后兼容：不改变既有 `/v1/chat` 请求体和流式协议。
- 新 route 是增量能力。
- 新表是增量存储；旧 DB 启动时自动创建。
- 回滚路径：保留新表不影响旧链路；关闭前端入口后聊天仍可正常运行。

## 6. 实施计划

1. 定义 shared schema 与 ID 前缀。
2. 新增 sidecar `run_events` table/repo/query API。
3. 在 chat producer/finalizer/tool trace/cost write 插入事件记录。
4. Web 新增 API client 与运行过程面板。
5. 补 sidecar 单测和 Web 用户路径测试。

## 7. 验证计划

- L1 定向测试：
  - `pnpm --filter @taori/sidecar test -- chat.test.ts`
- L2 类型/模块验证：
  - `pnpm --filter @taori/shared build`
  - `pnpm --filter @taori/sidecar typecheck`
  - `pnpm --filter @taori/web typecheck`
- L4 Web 用户路径验证：
  - 使用 Playwright 从前端发送消息，打开运行过程面板，检查 context/tool/cost 事件显示。
- L4 live 验证：
  - 在真实模型验证脚本中加入运行过程面板检查，覆盖多轮、多工具、多模型组合场景。

## 8. 风险

- 事件过多导致会话查询变慢：首版默认 limit 120，repo 限制最大 500。
- 观测写入失败影响主链路：事件写入失败只打 warn，不中断聊天。
- payload 膨胀：首版只写摘要和结构化小字段，不存附件原文或图片 base64。

## 9. 未决问题

- 是否将 roundtable、手动工具调用、未来 workflow 也纳入同一 run timeline。
- 是否增加按 message/run 的详情页与导出能力。

## 10. 决策

- [x] Approved
- [ ] Rejected
- [ ] Needs revision

Decision notes:

- 先实现可观测层，不引入自动模型动态路由。
