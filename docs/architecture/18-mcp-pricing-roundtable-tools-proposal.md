# 18 · MCP / Pricing Meta / Roundtable Tools 变更提案

Status: implemented v0.9 draft  
Date: 2026-05-04

## 特性到模块映射

| 特性 | `packages/shared` | `apps/sidecar` | `apps/web` | 数据 |
|---|---|---|---|---|
| MCP 本地 stdio | 新增 `McpServer*` schema / `mcp_server` id 前缀 | 新增 MCP stdio client、`/v1/mcp/servers*` 路由、Bus MCP tool 注册 | 控制中心工具页新增 MCP Server 管理 | 新增 `mcp_servers` |
| 复杂价格 | `PricingMetaSchema`，Model create/update/discovery 扩展 | `models.pricing_meta` 持久化，catalog sync 可刷新 | 模型编辑器新增 pricing_meta JSON textarea | `models` 新增 `pricing_meta TEXT` |
| 圆桌工具调用 | `RoundtableAnnotation` 新增 `rt.tool_trace` | `round-runner` 为 tools-capable participant 注入 web/MCP tools | 圆桌列内展示工具调用痕迹 | 首版不新增 roundtable tool event 表 |

## API 变化

新增 REST：

- `GET /v1/mcp/servers`
- `POST /v1/mcp/servers`
- `PATCH /v1/mcp/servers/:id`
- `DELETE /v1/mcp/servers/:id`
- `POST /v1/mcp/servers/:id/refresh`

扩展：

- `Model.pricing_meta?: PricingMeta | null`
- `ModelCreate.pricing_meta`
- `ModelUpdate.pricing_meta`
- `DiscoveredModel.pricing_meta`
- Roundtable SSE annotation: `rt.tool_trace`

## 状态归属

- MCP Server 配置归属 Sidecar SQLite；Renderer 不保存 command/env。
- MCP 子进程不长期驻留，首版 refresh/call 按需启动 stdio session，降低崩溃残留风险。
- MCP 工具注册归属 Capability Bus；刷新某 Server 会先替换该 Server 的旧工具。
- `pricing_meta` 归属模型行，作为价格元数据，不改变现有成本计算来源。

## 兼容性

- 数据库迁移均为 additive：`models.pricing_meta`、`mcp_servers`。
- 旧模型 `pricing_meta=null`，旧价格字段继续工作。
- 未配置 MCP Server 时 `/v1/tools` 仍只返回内置工具。
- 不支持 tools 的模型不会收到 MCP / web tool 定义。

## 验证

- Sidecar：MCP stdio mock server 刷新/调用、`pricing_meta` create/update 持久化。
- Web：真实 Playwright 用户旅程覆盖控制中心 MCP 添加、模型编辑器 JSON、圆桌工具痕迹显示。
- 类型：shared build、sidecar typecheck、web typecheck。
