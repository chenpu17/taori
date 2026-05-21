# P7 工作流编排 · 特性到模块映射

Status: draft  
Owner: Taori  
Date: 2026-05-20  
Scope: n8n-like workflow orchestration / canvas / runtime / node execution

## 1. 目标行为

- 当前行为：
  - Workflow Recipe 只能套用配置和填充输入，不执行多步骤。
  - Deep Research / Roundtable 是专用运行时，不是用户可编辑 DAG。
  - Renderer 没有画布式工作流编辑器。
- 目标行为：
  - 用户可创建节点图、保存版本、手动运行、观察节点状态、暂停审批、失败重试、导入导出。
  - Sidecar 拥有 workflow run 和 node run 真相。
  - 成本、工具权限、模型可用性和 run events 与现有系统统一。
- 为什么现在做：
  - Taori 已具备模型、工具、成本、运行时间线和深度研究状态机基础，可以进入用户自定义编排层。

## 2. 模块影响总览

| 模块 | 变化类型 | 变化摘要 | 是否改合同 | 是否改部署 | 验收重点 |
|---|---|---|---|---|---|
| `packages/shared` | contract | 新增 Workflow graph/definition/run/node schema 和 API payload 类型 | 是 | 否 | schema 兼容、非法图拒绝、导入导出无敏感字段 |
| `apps/sidecar` | contract + state + collaboration | 新增 workflow 表、repo、runtime、CRUD/run/action API；写 cost_records/run_events | 是 | 否 | DAG 执行、暂停恢复、审批、失败重试、预算阻断 |
| `apps/sidecar/capability-bus` | collaboration | Tool 节点通过 Bus 调用现有工具；工具健康和权限继续由 Bus 管理 | 是（内部合同） | 否 | 未启用工具不能被 workflow 自动启用 |
| `apps/web` | contract consumer + UX | 新增 Workflow Center、Canvas、Node Inspector、Run Drawer、Run History | 是 | 否 | Playwright 真实观察画布、运行、审批、失败恢复 |
| `apps/desktop` | verification | 首版不新增桌面 API；只验证桌面壳中 Workflow Center 可打开与运行 | 否 | 否 | `verify:desktop-ui` smoke |
| `docs/product` / `docs/architecture` | governance | 新增 P7 产品规格与架构提案 | 是 | 否 | 文档评审通过 |

## 3. 跨模块协作变化

- 是否新增调用方向：
  - `apps/web` 新增调用 `apps/sidecar /v1/workflows*` 和 `/v1/workflow-runs*`。
  - `apps/sidecar workflow-runtime` 调用 Capability Bus、Provider/chat helper、Deep Research、Roundtable。
- 是否新增共享事实 / ID：
  - `workflow_id`
  - `workflow_version_id`
  - `workflow_run_id`
  - `workflow_node_run_id`
  - `workflow_artifact_id`
- 是否改变责任边界：
  - Sidecar 新增 workflow 状态真相源。
  - Renderer 只负责编辑体验和展示，不拥有运行语义。
  - Recipe 继续不是执行器。
- 是否有新的失败恢复要求：
  - 节点级 retry。
  - run 级 pause/resume/cancel。
  - Approval 持久化暂停点。
  - 成本确认和硬预算阻断。

## 4. 接口 / 状态 / 部署影响

### 4.1 接口

新增：

- `GET /v1/workflows`
- `POST /v1/workflows`
- `GET /v1/workflows/:id`
- `PATCH /v1/workflows/:id`
- `DELETE /v1/workflows/:id`
- `GET /v1/workflows/:id/versions`
- `POST /v1/workflows/:id/versions`
- `POST /v1/workflows/:id/validate`
- `POST /v1/workflows/import`
- `GET /v1/workflows/:id/export`
- `POST /v1/workflows/:id/runs`
- `GET /v1/workflow-runs`
- `GET /v1/workflow-runs/:id`
- `GET /v1/workflow-runs/:id/nodes`
- `GET /v1/workflow-runs/:id/artifacts`
- `POST /v1/workflow-runs/:id/pause`
- `POST /v1/workflow-runs/:id/resume`
- `POST /v1/workflow-runs/:id/cancel`
- `POST /v1/workflow-runs/:id/retry-node`
- `POST /v1/workflow-runs/:id/approve-node`

扩展：

- `cost_records.source_type` 增加 `workflow_run` / `workflow_node`。
- `run_events.kind` 增加 `workflow.*` 事件。
- `GET /v1/costs/calls` 增加 workflow run/node 关联字段。

### 4.2 状态 / 存储

新增：

- `workflow_definitions`
- `workflow_versions`
- `workflow_runs`
- `workflow_run_nodes`
- `workflow_artifacts`

状态归属：

- Workflow definition/version/run/node/artifact 全部归 Sidecar SQLite。
- Canvas viewport、节点选择、Inspector 展开状态归 Renderer 临时状态。

### 4.3 部署 / 运维

- 首版不新增进程、不新增外部服务。
- 不引入后台常驻队列。
- 不引入定时器/Webhook，因此不改变 standalone host 暴露语义。

## 5. 研发拆解建议

### P7.1 Runtime Foundation

Owner：`packages/shared` + `apps/sidecar`

- 定义 schema/type。
- 新增 SQLite schema 与 repo。
- 实现 graph validator。
- 实现最小 runner：Input → LLM → Output。
- Route tests 覆盖 create/validate/run/detail。

验收：

- Sidecar 可通过 API 创建 workflow 并跑通 3 节点。
- 刷新或重查 API 后 run/node 状态仍存在。

### P7.2 Canvas MVP

Owner：`apps/web`

- Workflow Center 页面。
- 工作流列表。
- Node Palette。
- Canvas 拖拽与连线。
- Node Inspector。
- Run Drawer。

验收：

- Playwright 创建 3 节点流程并运行。
- 桌面和移动视口无遮挡、无文本溢出。

### P7.3 Control Nodes

Owner：`apps/sidecar` + `apps/web`

- Transform 节点。
- Condition 节点。
- Approval 节点。
- Pause/resume/cancel/retry-node API。
- 成本确认与硬预算阻断。

验收：

- Approval 能真实暂停 run，刷新后仍等待确认。
- Retry node 不重跑已完成上游。

### P7.4 AI-native Nodes

Owner：`apps/sidecar` + `apps/web`

- Tool 节点接 Capability Bus。
- Deep Research 复合节点。
- Roundtable 复合节点。
- 子 run 关联和跳转。

验收：

- 未启用工具不能被 workflow 自动启用。
- Deep Research 节点能输出研究报告 artifact。

### P7.5 Packaging

Owner：`apps/web` + `apps/sidecar`

- Workflow 导入导出。
- 从 Workflow Recipe 创建 workflow 草稿。
- 本地模板库。
- Version 列表与 active version 管理。

验收：

- 导出的 JSON 不包含敏感字段。
- 导入旧版本能给出兼容错误或自动迁移提示。

## 6. 风险

- 画布过早复杂化：先限制节点类型和运行语义，首版只做手动触发 DAG。
- 状态分裂：Sidecar 是唯一运行真相源，Renderer 不执行节点。
- 权限绕过：Tool 节点必须走 Capability Bus，不能直接调用 MCP。
- 成本失控：每个高成本节点复用成本确认，run 有预算上限。
- 复合节点重复造状态机：Deep Research / Roundtable 保持原状态，workflow 只保存引用和结果。
- 导入安全：workflow JSON 不是脚本，不允许任意命令、任意代码或凭据字段。

## 7. 验证计划

### 模块级验证

- `pnpm --filter @taori/shared test` 或等价 schema 单测。
- `pnpm test:sidecar`：validator、runner、routes、budget、approval、retry。
- `pnpm --filter @taori/web typecheck`。

### 跨模块验证

- `pnpm test:e2e` 增加 workflow 用户路径：
  - 空白画布创建并运行。
  - Tool/Condition/Approval 工作流。
  - 失败重试。
  - 刷新恢复。
  - 导入导出。

### 上线前检查

- `pnpm verify:web`
- `pnpm verify:desktop-ui`
- `git diff --check`
- 使用 Playwright 真实观察并保存截图：
  - desktop canvas
  - desktop running state
  - approval paused state
  - failed node retry
  - mobile run drawer

## 8. 需要同步更新的文档

实施时必须同步：

- `packages/shared/MODULE.md`
- `apps/sidecar/MODULE.md`
- `apps/web/MODULE.md`
- `docs/modules/inventory.md`
- `docs/architecture/08-api-contracts.md`
- `docs/architecture/04-data-and-storage.md`
- `docs/architecture/09-agent-and-tools.md`
- `docs/architecture/11-qa-strategy.md`

规划阶段已新增：

- `docs/product/27-p7-workflow-orchestration.md`
- `docs/architecture/34-p7-workflow-orchestration-proposal.md`
- `docs/modules/p7-workflow-orchestration-mapping.md`

