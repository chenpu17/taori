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
- 新增 `RecoverRunRequestSchema`，定义 run recovery 的跨进程请求合同；`skip_tool` 恢复动作可携带 `tool_name`，恢复建议可携带 `tool_name` / `tool_label` 供前端展示和确认；恢复请求可携带 `confirmed_cost` 作为用户已确认成本的二次提交标记。
- 新增 `ContinueRunRequestSchema` 与 `CostConfirmationRequiredDetailsSchema`，用于 `/v1/runs/:id/continue|recover` 高成本恢复确认闭环。
- `ContextSnapshotAnnotationSchema` 新增可选 `context_window`，用于展示本次上游上下文窗口策略、估算 token、模型窗口预算和省略消息数量。
- `ToolHealthRowSchema` 定义工具健康视图合同：最近 24h 调用、失败、平均耗时和最近失败分类。
- `ProviderTypeSchema` 新增 `deepseek`、`packyapi` 与 `siliconflow`；共享常量新增 `DEFAULT_DEEPSEEK_BASE_URL`、`DEFAULT_PACKYAPI_BASE_URL`、`DEFAULT_SILICONFLOW_BASE_URL`，用于 Web onboarding 与 Sidecar provider adapter 保持默认接入点一致。
