# 34 · P7 工作流编排架构提案

Status: draft  
Owner: Taori  
Date: 2026-05-20  
Scope: workflow definition / workflow runtime / canvas UI / node execution / cost and recovery

## 1. 问题

Taori 当前只有 Workflow Recipe、固定 Deep Research 状态机和若干运行时能力。它们能覆盖“套用配方”和“特定任务工作台”，但无法让用户自定义一条可执行的多步骤流程。

P7 要新增一个通用但受控的工作流编排层，让用户能定义节点图、运行图、观察图，并把每次运行落到 Sidecar 状态中。

## 2. 影响范围

- 模块：
  - `packages/shared`
  - `apps/sidecar`
  - `apps/sidecar/capability-bus`
  - `apps/web`
  - `apps/desktop`（首版 smoke / 打包验证，不新增 API）
- Spec / 文档：
  - `docs/product/27-p7-workflow-orchestration.md`
  - `docs/modules/p7-workflow-orchestration-mapping.md`
  - `apps/web/MODULE.md`
  - `apps/sidecar/MODULE.md`
  - `packages/shared/MODULE.md`
- 接口：
  - 新增 `/v1/workflows*`
  - 新增 `/v1/workflow-runs*`
  - 扩展 `cost_records.source_type`
  - 扩展 `run_events` kind / payload
- 状态 / 存储：
  - 新增 workflow definition / version / run / node run / artifact 表。
- 部署 / 运维：
  - 不新增进程。
  - 后续若加入后台队列或定时触发，需要单独提案。

## 3. 当前合同

当前合同要点：

- `apps/sidecar` 拥有业务状态、LLM 调用、工具调度、成本记录和 run events。
- `apps/web` 只拥有 UI 临时状态，通过 REST/SSE 调用 Sidecar。
- `packages/shared` 定义跨端 schema 和类型。
- `Workflow Recipe` 只做配置套用和 prompt 填充，不自动执行多步骤。
- `Deep Research` 是专用研究状态机，不是通用工作流引擎。

P7 不应把工作流运行状态放到 Renderer，也不应让 Recipe 悄悄变成可执行流程。

## 4. 拟议变更

新增 `workflow-runtime`，归属 `apps/sidecar`，并以 `packages/shared` schema 作为公共合同。Renderer 提供可视化编辑和运行观察，实际校验、调度、暂停、恢复、成本门禁和工具调用都由 Sidecar 执行。

```text
apps/web Canvas
  -> apps/sidecar /v1/workflows*
  -> apps/sidecar /v1/workflow-runs*

apps/sidecar workflow-runtime
  -> packages/shared Workflow schemas
  -> SQLite workflow_* tables
  -> Capability Bus for Tool nodes
  -> Provider/chat helpers for LLM nodes
  -> cost_records / run_events
```

## 5. 数据模型

### 5.1 表结构

建议新增 5 组表：

```sql
CREATE TABLE workflow_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,                 -- draft/enabled/archived
  active_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  graph_json TEXT NOT NULL,
  validation_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(workflow_id, version)
);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_version_id TEXT NOT NULL,
  conversation_id TEXT,
  status TEXT NOT NULL,                 -- queued/running/waiting_approval/paused/completed/failed/cancelled
  trigger_kind TEXT NOT NULL,           -- manual/template/api
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_json TEXT,
  budget_limit_usd REAL,
  budget_spent_usd REAL NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workflow_run_nodes (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,                 -- queued/running/waiting_approval/completed/failed/skipped/cancelled
  attempt INTEGER NOT NULL DEFAULT 0,
  input_json TEXT,
  output_json TEXT,
  error_json TEXT,
  cost_estimate_json TEXT,
  cost_record_ids_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(workflow_run_id, node_id)
);

CREATE TABLE workflow_artifacts (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  node_run_id TEXT,
  kind TEXT NOT NULL,                   -- markdown/json/file_ref/image_ref/chat_message
  title TEXT,
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

### 5.2 状态归属

| 状态 | Owner | 说明 |
|---|---|---|
| workflow definition/version | `apps/sidecar` | Renderer 可编辑草稿，但保存后由 Sidecar 校验并持久化。 |
| graph validation | `apps/sidecar` + `packages/shared` | 前端可做即时提示，Sidecar 是最终裁决。 |
| workflow run status | `apps/sidecar` | 运行真相源。 |
| node run input/output/error | `apps/sidecar` | 用于恢复、审计和调试。 |
| canvas viewport/selection | `apps/web` | 纯 UI 状态，可丢失。 |
| cost records | `apps/sidecar` | 继续复用现有成本系统。 |

## 6. Shared 合同

建议新增：

```ts
WorkflowDefinitionSchema
WorkflowVersionSchema
WorkflowGraphSchema
WorkflowNodeSchema
WorkflowEdgeSchema
WorkflowRunSchema
WorkflowRunNodeSchema
WorkflowArtifactSchema
WorkflowCreateSchema
WorkflowUpdateSchema
WorkflowValidateRequestSchema
WorkflowRunCreateSchema
WorkflowRunActionSchema
```

### 6.1 Graph schema

```ts
type WorkflowGraph = {
  schema_version: 1;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables?: WorkflowVariable[];
  default_budget?: WorkflowBudget;
  metadata?: Record<string, unknown>;
};

type WorkflowNode = {
  id: string;
  type:
    | 'input'
    | 'llm'
    | 'tool'
    | 'transform'
    | 'condition'
    | 'approval'
    | 'output'
    | 'deep_research'
    | 'roundtable'
    | 'quick_compare';
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
};

type WorkflowEdge = {
  id: string;
  source_node_id: string;
  source_port: string;
  target_node_id: string;
  target_port: string;
  condition?: {
    kind: 'always' | 'expression_result';
    expression?: string;
  };
};
```

### 6.2 输入绑定

首版不引入任意表达式语言。使用受控 binding：

```json
{
  "prompt": {
    "kind": "template",
    "template": "请基于 {{nodes.search.output.summary}} 生成报告"
  },
  "topic": {
    "kind": "node_output",
    "node_id": "input_topic",
    "path": "$.topic"
  }
}
```

支持的 binding kind：

- `literal`
- `workflow_input`
- `node_output`
- `template`
- `artifact_ref`

## 7. API 合同

```http
GET    /v1/workflows
POST   /v1/workflows
GET    /v1/workflows/:id
PATCH  /v1/workflows/:id
DELETE /v1/workflows/:id

GET    /v1/workflows/:id/versions
POST   /v1/workflows/:id/versions
POST   /v1/workflows/:id/validate
POST   /v1/workflows/import
GET    /v1/workflows/:id/export

POST   /v1/workflows/:id/runs
GET    /v1/workflow-runs
GET    /v1/workflow-runs/:id
GET    /v1/workflow-runs/:id/nodes
GET    /v1/workflow-runs/:id/artifacts
POST   /v1/workflow-runs/:id/pause
POST   /v1/workflow-runs/:id/resume
POST   /v1/workflow-runs/:id/cancel
POST   /v1/workflow-runs/:id/retry-node
POST   /v1/workflow-runs/:id/approve-node
```

### 7.1 运行创建

`POST /v1/workflows/:id/runs`：

```json
{
  "conversation_id": "conv_xxx",
  "input": {
    "topic": "2026 年 AI 编程工具格局"
  },
  "confirmed_cost": false
}
```

响应：

```json
{
  "run": {
    "id": "wfrun_xxx",
    "status": "running",
    "workflow_id": "wf_xxx",
    "workflow_version_id": "wfv_xxx"
  }
}
```

如果预计成本触发确认：

```json
{
  "error": {
    "code": "cost_confirmation_required",
    "message": "Workflow run requires confirmation",
    "details": {
      "estimated_cost_usd": 0.42,
      "nodes": [
        { "node_id": "summarize", "estimated_cost_usd": 0.18 }
      ]
    }
  }
}
```

## 8. 执行器设计

建议新增：

```text
apps/sidecar/src/workflows/
  graph.ts
  validator.ts
  planner.ts
  runner.ts
  node-registry.ts
  nodes/
    input.ts
    llm.ts
    tool.ts
    transform.ts
    condition.ts
    approval.ts
    output.ts
    deep-research.ts
    roundtable.ts
  bindings.ts
  recovery.ts
  repos.ts
```

### 8.1 校验

保存 version 和运行前都必须校验：

- `node.id` 唯一。
- edge 引用存在。
- DAG 无环。
- 必需输入已绑定。
- Tool 节点引用的工具存在或标记为 currently unavailable。
- LLM 节点模型策略合法。
- Approval 节点有明确继续 / 取消输出。
- Output 节点不会写入未授权路径。

### 8.2 调度

MVP 使用单进程内受控调度：

- 同一 workflow run 默认串行执行。
- 后续可允许无依赖节点并发，但必须有 `max_concurrency` 默认上限。
- 每个节点执行前写 `workflow.node.started` run event。
- 每个节点完成后写 `workflow.node.completed` 或 `workflow.node.failed`。
- 任一节点进入 `waiting_approval` 时，run 状态同步变为 `waiting_approval`。

### 8.3 暂停与恢复

- Pause：当前节点若可中断则停止；不可中断则等节点完成后不调度后续节点。
- Resume：从已完成节点快照继续，不重跑成功节点。
- Retry Node：只允许失败节点或被取消节点；默认复用上游输出快照。
- Approval：记录用户确认、编辑后的 payload 和时间戳。

### 8.4 错误语义

节点错误分三层：

| 层级 | 示例 | 恢复 |
|---|---|---|
| validation_error | 缺输入、非法 binding | 回到编辑态，不启动 run |
| recoverable_runtime_error | 模型超时、工具失败、JSON parse 失败 | 重试节点、切换模型、跳过可选节点 |
| terminal_error | 硬预算阻断、权限拒绝、workflow version 不兼容 | 终止或等待用户修改配置 |

## 9. 节点适配

### 9.1 LLM 节点

- 复用现有 Provider registry 和 chat 上游构造能力。
- 支持输出格式：
  - `text`
  - `markdown`
  - `json_schema`
- JSON 输出必须做 schema parse；失败进入 recoverable error。
- 成本写 `cost_records.source_type='workflow_node'`，`source_id=node_run_id`。

### 9.2 Tool 节点

- 只通过 Capability Bus 调用。
- 工具未启用时返回 permission/availability error，不自动启用。
- MCP 工具 env 与启动参数不进入 workflow JSON。

### 9.3 Transform 节点

- 纯本地、无模型、无外部网络。
- 不允许任意代码。
- 输出必须可序列化为 JSON。

### 9.4 Approval 节点

- 进入节点后持久化 `waiting_approval`。
- Renderer 只是展示和提交用户决策。
- 决策记录写入 node output：

```json
{
  "decision": "approved",
  "edited_payload": {},
  "approved_at": 1790000000000
}
```

### 9.5 Deep Research / Roundtable 节点

复合节点不把内部状态摊平成普通节点。它们创建子 run 或引用现有专用资源：

- Deep Research 节点创建 `research_session_id`，输出 final markdown、sources、claims。
- Roundtable 节点创建 roundtable run，输出 summary 和 participant messages。
- workflow node run 保存 `child_run_ref`，便于 UI 跳转。

## 10. Renderer 设计

建议使用现有 React 技术栈，画布库可评估 React Flow 或同类轻量库。选择前需做 spike，验收点：

- 大约 50 个节点仍能平滑拖拽。
- 节点尺寸稳定，文字不溢出。
- 连线、缩放、mini map、键盘删除可控。
- Playwright 能稳定定位节点、连线和 Inspector。

页面建议：

```text
WorkflowCenter
  WorkflowList
  WorkflowCanvas
  NodePalette
  NodeInspector
  RunDrawer
  RunHistory
```

Renderer 不直接执行节点，也不直接决定后续节点是否可运行。

## 11. 与现有系统衔接

### 11.1 Workflow Recipe

Recipe 不升级为执行器。兼容策略：

- 旧 Recipe 保持现状。
- 新增“从 Recipe 创建 Workflow 草稿”转换入口。
- 转换后生成 workflow definition，后续由 workflow runtime 执行。

### 11.2 Run Timeline

新增 run event kind：

- `workflow.run.created`
- `workflow.run.started`
- `workflow.node.queued`
- `workflow.node.started`
- `workflow.node.completed`
- `workflow.node.failed`
- `workflow.node.waiting_approval`
- `workflow.node.approved`
- `workflow.run.completed`
- `workflow.run.failed`
- `workflow.run.cancelled`

### 11.3 Cost Dashboard

`GET /v1/costs/calls` 需要能展示：

- workflow run id
- workflow node id
- node label
- workflow name/version

## 12. 安全与权限

- 导入 workflow 时只校验 JSON，不启动任何工具或 MCP。
- workflow JSON 不允许包含 API Key、Bearer、MCP env 明文。
- Tool 节点只能引用已存在工具名。
- Output 节点不能写任意文件路径；首版只写聊天、artifact 或用户显式选择的导出位置。
- 没有代码节点。
- 没有远程触发入口。
- 每次运行都受全局预算、工具启停、模型启停、provider key 可用性约束。

## 13. 兼容性

- 向后兼容现有 Workflow Recipe、Prompt Template、Deep Research 和 Chat API。
- 新增表和路由，不改变 `/v1/chat` 必填字段。
- 新增 `cost_records.source_type` 枚举值需要 shared schema 和 UI 兼容。
- 若 workflow runtime 关闭或版本不兼容，不影响普通聊天和研究工作台。

## 14. 实施计划

1. `packages/shared`：定义 workflow graph、definition、run、node run schema。
2. `apps/sidecar`：新增表、repo、CRUD、validate API。
3. `apps/sidecar`：实现最小 runner，支持 Input → LLM → Output。
4. `apps/web`：新增 Workflow Center，支持列表、画布、Inspector、运行面板。
5. `apps/sidecar`：接入 Tool、Transform、Condition、Approval 节点。
6. `apps/web`：补运行观察、审批、失败重试、刷新恢复。
7. `apps/sidecar`：接入 cost_records、run_events、Cost Dashboard 映射。
8. `apps/web`：导入导出、模板库、Recipe 转 Workflow 草稿。
9. `apps/sidecar`：接入 Deep Research / Roundtable 复合节点。
10. 验证门禁：sidecar unit、web e2e、Playwright 真实观察、desktop smoke。

## 15. 验证计划

### L1 单元 / 模块测试

- `packages/shared`：graph schema、非法 edge、非法 binding、版本兼容。
- `apps/sidecar`：DAG validator、binding resolver、runner state machine、node retry、approval pause。
- `apps/sidecar`：cost confirmation、tool permission、hard budget block。

### L2 模块级验证

- Sidecar route tests：
  - CRUD workflow。
  - validate invalid graph。
  - run 3-node workflow。
  - pause/resume/cancel。
  - retry failed node。
  - import/export no secret leakage。

### L3 跨模块集成验证

- Web E2E mock：
  - 创建 Input → LLM → Output。
  - 创建 Tool → Condition → Approval → Output。
  - 运行失败后从节点重试。
  - 刷新后恢复运行状态。

### L4 用户路径真实观察

必须用 Playwright 打开真实 WebUI 观察：

- 桌面宽屏：画布、Inspector、运行面板无遮挡。
- 小屏：工作流列表、节点编辑、运行抽屉可用。
- 运行时节点状态真实变化，不是静态截图。
- Approval 弹窗能暂停并继续执行。
- 失败节点能显示错误并重试。

截图产物建议：

```text
/tmp/taori-workflow-p7/
  canvas-empty.png
  canvas-configured.png
  run-progress.png
  approval-paused.png
  retry-failed-node.png
  mobile-run-drawer.png
```

### L5 发布前验证

- `pnpm verify:web`
- `pnpm test:sidecar`
- `pnpm test:e2e`
- `pnpm verify:desktop-ui`
- 真实 Provider 路径只在用户明确提供凭据时跑 `pnpm verify:real` 的 workflow 子剧本。

## 16. 风险

- 画布复杂度吞噬产品价值：MVP 限制节点类型和运行语义，先服务高频 AI 工作流。
- Renderer 偷跑业务逻辑：Sidecar 必须是校验和执行真相源。
- 任意代码节点带来安全风险：首版不做。
- 工作流绕过成本/权限：所有节点执行前复用现有预算和工具权限守卫。
- 复合节点状态重复：Deep Research / Roundtable 保持自己的状态机，Workflow 只保存引用。
- 大图性能问题：画布库先 spike，50 节点是首个性能验收线。

## 17. 未决问题

- 是否允许 workflow run 在 Sidecar 重启后自动继续，还是只恢复到 paused 等用户确认？
- Transform 节点是否需要引入 JSONata/JQ 这类表达式语言，还是先保持自研白名单 binding？
- 工作流模板是否继续放在模板市场，还是新增 Workflow Center 内的模板页？
- 首版是否需要 workflow version diff 视图？
- 复合节点的成本是否展示为单节点汇总，还是可展开到子 run 明细？

## 18. 决策

- [ ] Approved
- [ ] Rejected
- [ ] Needs revision

Decision notes:

- 待产品、架构、安全和测试共同评审。

