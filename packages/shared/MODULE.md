# packages/shared · MODULE

## 定位

前后端共享类型、Zod schema、ID 前缀与轻量纯函数。

## 主要接口

- `src/schemas.ts`：Provider、Model、MCP Server、Backup 等 REST 合同。
- `src/tools.ts`：Capability Bus 工具合同。
- `src/roundtable.ts`：圆桌数据模型与 SSE annotation。
- `src/ids.ts`：跨模块 ID 前缀。

## 拥有状态

无运行时状态；仅导出类型、schema 与纯函数。

## 依赖

- `zod`
- `nanoid`

## 当前合同变化

- 新增 `PricingMetaSchema` 与 `Model.pricing_meta`。
- 新增 `McpServer*` schema 与 `mcp_server` ID 前缀。
- `RoundtableAnnotation` 新增 `rt.tool_trace`。
