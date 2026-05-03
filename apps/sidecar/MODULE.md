# apps/sidecar · MODULE

## 定位

Taori 业务编排进程，负责 LLM 调用、工具调度、圆桌执行、SQLite 持久化与本地 HTTP/SSE API。

## 主要接口

- REST/SSE：`/v1/chat`、`/v1/tools/*`、`/v1/mcp/servers*`、`/v1/models*`、`/v1/roundtable*`、`/v1/costs*`
- 内部：Capability Bus、Provider registry、Roundtable runner、Catalog sync、DB repos

## 拥有状态

- SQLite 业务数据：providers、models、mcp_servers、conversations、messages、roundtables、cost_records、memories
- 运行态：Capability Bus 工具注册表、进行中的 chat/roundtable SSE 流

## 依赖

- `packages/shared` schema/type
- Provider HTTP API
- better-sqlite3 / Drizzle schema
- Tauri control channel keystore abstraction

## 当前合同变化

- 新增 MCP stdio Server 管理与工具注册。
- `models` 支持 `pricing_meta` 复杂价格元数据。
- 圆桌参与者可调用 web/MCP 工具并通过 `rt.tool_trace` 流式通知 Renderer。
