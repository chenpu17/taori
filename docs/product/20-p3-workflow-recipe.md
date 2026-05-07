# 20 · P3 Workflow Recipe

## 背景

Taori 已有 Prompt 模板、Persona、工具策略、模型推荐、预算守卫和 Quick Compare，但它们仍是分散能力。用户想复用“网页调研报告”“代码审查”“竞品分析”“写作润色”这类完整工作流时，需要重复选择模型、工具、Persona、输出格式和预算策略。

Workflow Recipe 的目标是把“我怎么做这类任务”沉淀成可复用 JSON 配方，而不是只保存一段 prompt。

## 用户价值

- **一键启动高质量工作流**：选择 recipe 后自动填充 prompt 结构、Persona、工具策略和输出格式。
- **可解释、可编辑**：用户能看到 recipe 会改哪些设置，不做隐式接管。
- **可分享**：recipe 可导入导出为 JSON，适合团队或个人知识库复用。
- **可控成本**：recipe 可以声明预算策略，但必须受全局硬预算约束。

## 首版范围

### 必须支持

1. 新增 Workflow Recipe 资源：名称、描述、prompt 模板、变量、推荐任务类型、Persona、工具策略、输出格式、预算策略。
2. Web 提供 recipe 管理、套用、导入、导出。
3. 套用 recipe 时先展示将要应用的变化，用户确认后才写入 composer/会话设置。
4. recipe 可以建议模型或任务类型，但不绕过模型推荐与预算守卫。
5. recipe JSON schema 版本化，导入时校验并给出错误。

### 暂不支持

- DAG/多步骤自动 Agent 编排。
- 定时执行、批量执行。
- recipe 市场/云同步。
- recipe 自动安装第三方 MCP。
- recipe 绕过用户当前工具权限。

## Recipe 样例

```json
{
  "schema_version": 1,
  "name": "网页调研报告",
  "description": "搜索网页并输出可引用的调研报告",
  "prompt_template": "请围绕 {{topic}} 做调研，输出结论、证据、风险和下一步。",
  "variables": [
    { "name": "topic", "label": "调研主题", "required": true }
  ],
  "recommended_task": "long_context",
  "persona": {
    "mode": "inline",
    "prompt": "你是一名严谨的研究分析师，回答必须区分事实、推断和建议。"
  },
  "tools": {
    "required": ["builtin.web_search"],
    "optional": ["builtin.web_fetch", "builtin.file_search"]
  },
  "output_format": {
    "kind": "markdown",
    "sections": ["结论", "证据", "风险", "下一步"]
  },
  "budget": {
    "mode": "soft_cap",
    "max_estimated_usd": 0.2
  }
}
```

## 体验原则

- **Recipe 是建议，不是接管**：套用前展示“将使用 Persona / 推荐模型 / 建议工具 / 预算上限”。
- **显式权限**：如果 recipe 需要某个工具但当前未启用，提示用户去启用；不自动启用。
- **全局规则优先**：硬预算、工具禁用、模型禁用、隐私设置优先级高于 recipe。
- **可退回**：套用 recipe 后只是填充 composer 和会话设置；用户可以继续编辑。

## 验收

- 用户能创建、编辑、删除 recipe。
- 用户能导出 recipe JSON，并在另一份本地数据中导入。
- 套用 recipe 能填充变量后的 prompt，并应用 Persona/工具策略建议。
- 禁用工具或预算超限时，recipe 不会绕过既有限制。
