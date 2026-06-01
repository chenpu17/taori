# packages/shared · MODULE

## 定位

前后端共享类型、Zod schema、ID 前缀与轻量纯函数。

## 主要接口

- `src/schemas.ts`：Provider、Model、MCP Server、Backup 等 REST 合同。
- `src/tools.ts`：Capability Bus 工具合同。
- `src/roundtable.ts`：圆桌数据模型与 SSE annotation。
- `src/quick-compare.ts`：Quick Compare 数据模型与 Data Stream annotation。
- `src/ids.ts`：跨模块 ID 前缀。

## 拥有状态

无运行时状态；仅导出类型、schema 与纯函数。

## 依赖

- `zod`
- `nanoid`

## 当前合同变化

- `RunEventKindSchema` 新增 `orchestration.plan`，用于 Sidecar 在普通聊天和后续编排型任务中记录结构化能力编排计划；这是 additive run timeline 合同，旧事件读取不受影响。
- 新增 `OrchestrationAnnotationSchema` / `OrchestrationAnnotation`，并把同一摘要挂到普通聊天 `orchestration`、Quick Compare `qc.orchestration`、Roundtable `rt.orchestration` 流事件中，用于 Renderer 展示“为什么自动联网 / 是否要求引用 / 使用哪个搜索工具”。字段全部 additive，旧客户端可忽略。
- 新增 `PricingMetaSchema` 与 `Model.pricing_meta`。
- 新增 `McpServer*` schema 与 `mcp_server` ID 前缀。
- `RoundtableAnnotation` 新增 `rt.tool_trace`。
- 新增 `RecoverRunRequestSchema`，定义 run recovery 的跨进程请求合同；`skip_tool` 恢复动作可携带 `tool_name`，恢复建议可携带 `tool_name` / `tool_label` 供前端展示和确认；恢复请求可携带 `confirmed_cost` 作为用户已确认成本的二次提交标记。
- 新增 `ContinueRunRequestSchema` 与 `CostConfirmationRequiredDetailsSchema`，用于 `/v1/runs/:id/continue|recover` 高成本恢复确认闭环。
- `ContextSnapshotAnnotationSchema` 新增可选 `context_window`，用于展示本次上游上下文窗口策略、估算 token、模型窗口预算和省略消息数量。
- `ToolHealthRowSchema` 定义工具健康视图合同：最近 24h 调用、失败、平均耗时和最近失败分类。
- `ProviderTypeSchema` 新增 `deepseek`、`packyapi` 与 `siliconflow`；共享常量新增 `DEFAULT_DEEPSEEK_BASE_URL`、`DEFAULT_PACKYAPI_BASE_URL`、`DEFAULT_SILICONFLOW_BASE_URL`，用于 Web onboarding 与 Sidecar provider adapter 保持默认接入点一致。
- `ModelSchema` / `ModelCreateSchema` / `ModelUpdateSchema` / `BackupModelRecordSchema` 新增 `thinking_enabled: boolean | null`，用于“跟随全局 / 单模型覆盖”的思考开关合同。
- `ResearchSessionSchema` 新增 `plan_origin: 'pending' | 'ai' | 'fallback'`；当前版本正常只会写入 `pending / ai`，`fallback` 仅用于读取历史会话，避免旧数据被误判成 AI 生成计划。
- `ProviderTestRequestSchema` 扩展为 union：既支持临时连通性测试 `{ type, base_url, api_key? }`，也支持对已保存 Provider 的直接测试 `{ provider_id }`。
- `ChatRequestSchema.messages` 新增上限：单次请求最多 200 条消息，单条 `content` 最多 200KB，防止超长历史在 Sidecar 预算估算和上游组装阶段造成不必要的内存放大。
- `QuickCompareAnnotationSchema` 的 `qc.participant_start` / `qc.participant_done` 新增可选 `execution_mode`（`live` / `local_preview`）与 `preview_reason`，用于把“未联网的本地预览”明确暴露给 Renderer，避免 fallback 被误认为真实 Provider 调用。
