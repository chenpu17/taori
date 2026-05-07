# P3 Workflow Recipe · 特性到模块映射

## 涉及模块

| 模块 | 变化 | 责任边界 |
|---|---|---|
| `packages/shared` | 新增 WorkflowRecipe schema / types | 定义 JSON 合同、导入/导出/预览载荷 |
| `apps/sidecar` | 新增 recipe 表、repo、CRUD/import/export/apply-preview 路由 | 持久化、校验、预览，不执行模型调用 |
| `apps/web` | 新增 recipe 管理、变量填写、套用预览、导入导出 UI | 用户确认与交互，不绕过 Sidecar 校验 |
| `apps/desktop` | 无首版变化 | 不参与 recipe 解析或执行 |

## 依赖方向

```text
apps/web
  -> apps/sidecar /v1/workflow-recipes/*
apps/sidecar
  -> packages/shared WorkflowRecipe schemas
  -> SQLite workflow_recipes
  -> existing model recommendation / tool policy / budget preview helpers
```

## 状态归属

- Recipe 持久化归 Sidecar SQLite。
- 套用中的变量输入、预览弹窗归 Renderer 临时状态。
- 会话 Persona/工具策略是否真正变更，继续走现有会话设置或 memory 路径。

## 合同变化

- 新增 `/v1/workflow-recipes*` 路由组。
- 新增 `workflow_recipes` 表。
- 不改变 `/v1/chat`；recipe 不是新的 chat run kind。

## 风险

- Recipe 如果直接自动启用工具，会破坏用户信任；首版只能提示。
- Recipe 如果和 PromptTemplate 重叠，会造成入口混乱；UI 应区分“单段 Prompt 模板”和“完整工作流配方”。
- `spec_json` 灵活但难查询；首版接受该折中，待 schema 稳定后再考虑列化常用字段。
