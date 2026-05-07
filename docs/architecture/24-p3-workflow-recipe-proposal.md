# 24 · P3 Workflow Recipe 架构提案

## 目标

在现有 Prompt 模板/Persona 基础上新增 Workflow Recipe：一种版本化 JSON 配方，用于复用模型建议、工具策略、Persona、输出格式和预算约束。首版只做“套用配置 + 填充输入”，不做自动多步骤执行。

## 数据模型

新增 SQLite 表：

```sql
CREATE TABLE workflow_recipes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  spec_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`spec_json` 存储通过 shared schema 校验后的 JSON。首版不把 spec 拆成多列，避免早期 schema 高频变化导致 migration 成本上升。

## Shared contract

建议新增：

```ts
WorkflowRecipeSpecSchema
WorkflowRecipeSchema
WorkflowRecipeCreateSchema
WorkflowRecipeUpdateSchema
WorkflowRecipeImportSchema
WorkflowRecipeApplyPreviewSchema
```

关键字段：

- `schema_version`
- `prompt_template`
- `variables`
- `recommended_task`
- `model_strategy`
- `persona`
- `tools.required`
- `tools.optional`
- `output_format`
- `budget`
- `metadata`

## API 合同

```http
GET    /v1/workflow-recipes
POST   /v1/workflow-recipes
PATCH  /v1/workflow-recipes/:id
DELETE /v1/workflow-recipes/:id
POST   /v1/workflow-recipes/import
GET    /v1/workflow-recipes/:id/export
POST   /v1/workflow-recipes/:id/apply-preview
```

`apply-preview` 不产生消息、不调用模型，只返回：

- 填充变量后的 prompt。
- 建议 Persona 来源。
- 建议工具列表及当前启用状态。
- 推荐模型任务类型，可直接复用 `/v1/models/recommendations`。
- 预算估算与是否会触发确认/阻断。

## Sidecar 设计

- 新增 `WorkflowRecipesRepo` 负责 CRUD 与 JSON schema 校验。
- 新增 `routes/workflow-recipes.ts`。
- 导入 JSON 时：
  1. 校验 schema_version。
  2. 校验 name/content 长度。
  3. 不执行任何外部命令。
  4. 不自动启用工具或 MCP。
- 套用预览时：
  1. 解析变量并渲染 prompt。
  2. 查询当前工具策略与模型可用性。
  3. 调用模型推荐 helper 生成建议。
  4. 调用预算 guard 的 estimate/preview，不写 cost_records。

## Renderer 设计

- Control Center 增加“Workflow Recipe”管理入口。
- Chat header 模板入口增加 Recipe 分组。
- 套用流程：
  1. 选择 recipe。
  2. 填写变量。
  3. 展示 apply preview。
  4. 用户确认后填入 composer，并可选择应用 Persona/工具策略。
- 导入/导出：
  - 导出为 `.taori-recipe.json`。
  - 导入只展示校验后的摘要，用户确认后保存。

## 兼容性

- 不改变现有 PromptTemplate/Persona schema。
- 不改变 `/v1/chat` 必填字段。
- Recipe 套用后仍走普通 chat 请求；预算、工具、模型可用性继续由现有路径判断。

## 安全

- Recipe JSON 不是脚本，禁止任意代码。
- 工具列表只是声明，不能自动启用用户已禁用的工具。
- MCP server 只能引用已存在工具名，不能通过 recipe 安装。
- budget 只能收紧或提示，不能放宽全局硬预算。

## 测试

- shared schema：合法/非法 recipe。
- sidecar route：CRUD、导入导出、apply-preview 不产生模型调用。
- web e2e：创建 recipe → 套用变量 → 预览 → 填入 composer。
- 安全回归：包含未知工具、超大 prompt、非法 schema_version、脚本字段的导入被拒绝或忽略。
