# 16 · Agent 运行时前三优先级变更提案

Status: accepted
Date: 2026-05-03

## 1. 变更摘要

围绕 Taori“多模型工作编排助手”的定位，先落地三项 OpenClaw 可借鉴但保持用户可控的运行时能力：

1. 会话画像：用户可见当前会话的模型、Persona、工具、上下文来源和成本。
2. 会话级工具策略：用户可只在当前会话关闭某个工具，避免影响全局工具配置。
3. 上下文透明：每次回答通过 stream annotation 告诉前端本次用了哪些上下文来源。

## 2. API 合同

新增：

- `GET /v1/conversations/:id/profile`
- `GET /v1/tools/effective?conversation_id=<id>`
- `PUT /v1/tools/:name/session-enabled`

扩展：

- `/v1/chat` SSE annotation 新增：
  - `8:[{ "type": "context_snapshot", ... }]`

## 3. 状态归属

- 会话级工具策略归 `apps/sidecar`，复用 `memories(scope='session', scope_id=<conversation_id>)`。
- Renderer 只负责展示与发起设置，不持有最终策略真相。
- `CapabilityBus` 仍保持全局工具注册与全局启用状态；会话策略在 route/chat 注入层叠加。

## 4. 模块影响

| 模块 | 影响 |
|---|---|
| `packages/shared` | 新增 agent runtime contracts |
| `apps/sidecar` | 新增会话画像与有效工具 API；chat 工具注入尊重会话策略 |
| `apps/web` | 新增会话画像条、会话工具策略开关、上下文快照卡片 |

## 5. 验证

- Sidecar 单测覆盖会话工具策略对 `/v1/tools/invoke` 的阻断。
- Playwright 覆盖从 Web UI 创建会话、关闭本会话 `web_fetch`、发送多轮对话、观察上下文卡片、恢复工具后再次调用。
