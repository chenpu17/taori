# 27 · P7 工作流编排

Status: proposal  
Owner: Taori  
Date: 2026-05-20

## 1. 产品目标

P7 的目标是把 Taori 从“聊天 + 固定工作台 + 工作流配方”推进到**可执行的 AI 工作流编排器**：用户可以把模型、工具、文件、研究、圆桌、人工确认和输出动作编成一条可观察、可暂停、可恢复的流程。

这里的“类似 n8n”指的是：

- 用户能用画布组织节点与连线。
- 节点可以读取上游输出并产出结构化结果。
- 工作流可以被保存、运行、暂停、恢复、重试和导出。
- 每次运行都有节点级状态、成本、错误和产物。

但 Taori 不应做成通用自动化平台。P7 的核心仍是本地优先、多模型、成本透明和失败兜底的 AI 工作编排，而不是替代 Zapier / n8n 的所有 SaaS 集成。

## 2. 当前差距

当前已有能力：

- Workflow Recipe：保存任务配方，套用后填充 prompt / Persona / 工具建议，但不自动执行多步骤。
- Capability Bus：模型可调用内置工具与 MCP 工具。
- Run Timeline：记录聊天、工具、圆桌等运行过程。
- Deep Research：一条特定研究状态机，已经证明“可持久化、可恢复、可审计”的路线可行。

缺口：

- 没有用户可编辑的节点图。
- 没有通用 workflow definition / version / run 状态。
- 没有节点级输入输出绑定、条件分支、人工审批、失败恢复策略。
- 没有面向工作流的画布 UI、运行面板和历史记录。

## 3. 用户故事

| ID | 用户故事 |
|---|---|
| WF-1 | 作为重度 AI 用户，我希望把“收集资料 → 多模型分析 → 生成报告 → 人工确认 → 导出”保存成一条流程，下次直接运行。 |
| WF-2 | 作为产品/运营用户，我希望从网页、文件或剪贴板输入素材，经过不同模型处理后产出邮件、文案、表格或报告。 |
| WF-3 | 作为成本敏感用户，我希望每个节点执行前都能看到预计成本，超预算时暂停等待确认。 |
| WF-4 | 作为团队负责人，我希望把稳定流程导出给别人导入，但不会自动带走我的 API Key 或 MCP 凭据。 |
| WF-5 | 作为调试者，我希望看到每个节点的输入、输出、耗时、成本和失败原因，并能从失败节点重试。 |

## 4. 范围定义

### 4.1 MVP 必须支持

1. **手动触发工作流**：用户点击运行，不做定时器、Webhook、后台无人值守。
2. **DAG 画布**：节点 + 连线；首版禁止环，执行前做拓扑校验。
3. **核心节点类型**：
   - Input：用户输入、文本常量、文件引用、当前会话上下文。
   - LLM：选择模型 / 使用默认模型 / 推荐任务类型，输入 prompt，输出文本或 JSON。
   - Tool：调用 Capability Bus 中已启用的内置工具或 MCP 工具。
   - Transform：模板渲染、字段选择、列表合并、Markdown 拼接等无代码转换。
   - Condition：基于结构化字段做条件分支。
   - Approval：人工确认、编辑中间结果、批准继续或终止。
   - Output：写回聊天、生成 Markdown、导出文件。
4. **运行状态**：workflow run、node run、节点输入输出、错误、耗时、成本持久化。
5. **暂停 / 恢复 / 取消 / 从失败节点重试**。
6. **预算与权限守卫**：工具禁用、模型禁用、MCP 权限、全局硬预算必须优先于工作流配置。
7. **导入 / 导出**：导出 workflow JSON，不包含 API Key、Bearer、MCP env 明文。
8. **Playwright 用户路径验收**：真实打开画布、创建流程、运行、观察节点状态、处理失败和审批。

### 4.2 MVP 暂不支持

- 定时执行、Webhook 触发、外部事件触发。
- 任意 JS/Python 代码节点。
- 云端协作、多人编辑、权限系统。
- 远程工作流市场、评分、同步。
- 大规模后台队列和多租户调度。
- 循环节点、长时自治 Agent、无限重试。

## 5. 节点设计原则

### 5.1 节点是能力边界，不是脚本容器

首版节点必须是受控类型，不能让用户粘贴任意代码。Transform 节点只提供白名单能力：

- 模板渲染：`{{node.output.field}}`
- 字段选择：从上游 JSON 取值
- 文本拼接：Markdown / 分隔符 / 列表
- 简单数组处理：map 字段、join、limit

复杂自定义代码留到 v2，并且必须有沙箱、安全审计和显式权限。

### 5.2 用户看到的是任务进度，不是技术堆栈

运行视图优先展示：

- 正在执行哪个阶段
- 已完成 / 失败 / 等待确认的节点
- 已花费多少
- 当前输出是什么
- 下一步会做什么

节点日志和原始 JSON 放在调试面板，不占据普通用户主视图。

### 5.3 成本与权限先于自动化

工作流不能绕过现有规则：

- 全局硬预算永远优先。
- 工具或 MCP 未启用时，工作流只能提示，不能自动启用。
- 高成本节点必须复用成本确认。
- Approval 节点必须作为真实暂停点持久化，不只是前端弹窗。

## 6. 典型模板

### 6.1 竞品调研简报

```text
Input(topic)
  -> Tool(web_search)
  -> LLM(extract_competitors_json)
  -> LLM(compare_strengths)
  -> Approval(review_claims)
  -> Output(markdown_report)
```

### 6.2 内容生产流水线

```text
Input(brief)
  -> LLM(write_draft)
  -> LLM(polish_title_options)
  -> Tool(image_generate)
  -> Approval(select_image_and_title)
  -> Output(chat_and_markdown)
```

### 6.3 多模型决策

```text
Input(decision_question)
  -> LLM(model_a_analysis)
  -> LLM(model_b_risks)
  -> LLM(model_c_counterargument)
  -> LLM(synthesize_decision)
  -> Output(decision_brief)
```

## 7. 与现有能力关系

| 能力 | P7 中的位置 |
|---|---|
| Workflow Recipe | 可升级为“工作流模板”的轻量入口；旧 Recipe 继续只做 prompt/config 套用。 |
| Deep Research | 首版作为专用节点或子流程调用，不把研究内部状态机摊平成普通节点。 |
| Roundtable | 可作为一个节点：输入议题，输出总结与参与者观点。 |
| Capability Bus | Tool 节点的唯一工具调用入口。 |
| Run Timeline | Workflow Run 继续写 run events，供成本、调试和恢复统一查看。 |
| Prompt Template / Persona | LLM 节点可引用它们，但 workflow definition 只保存引用和快照策略。 |

## 8. 画布体验要求

### 8.1 工作台布局

- 左侧：工作流列表 / 模板库。
- 中间：画布，支持拖拽节点、连线、缩放、框选。
- 右侧：节点 Inspector，编辑输入、模型、工具、预算、重试策略。
- 底部或右侧抽屉：运行面板，展示节点状态、输出、成本和错误。

### 8.2 节点状态

节点至少有以下状态：

- draft：未配置完整
- ready：可运行
- queued：等待执行
- running：执行中
- waiting_approval：等待人工确认
- completed：完成
- failed：失败
- skipped：条件分支跳过
- cancelled：被取消

### 8.3 运行观察

运行时必须能看到：

- 当前执行路径高亮。
- 每个节点耗时和成本。
- 每个节点的输入快照和输出快照。
- 失败节点的错误分类与恢复动作。
- Approval 节点的用户决策记录。

## 9. 验收标准

### 9.1 MVP 验收

- 用户能从空白画布创建一条 3 节点工作流：Input → LLM → Output。
- 用户能创建包含 Tool、Condition、Approval 的 5-7 节点工作流。
- 工作流运行后，Sidecar 能持久化 run 与 node run；刷新页面后仍能看到状态和输出。
- 任一节点失败时，用户能从失败节点重试或取消整条运行。
- Approval 节点能暂停运行；用户确认后继续，取消后后续节点不会执行。
- 成本超出软预算时暂停等待确认；硬预算阻断时不能继续。
- 导出的 workflow JSON 不包含 API Key、MCP env、Bearer token 或本地绝对敏感路径。
- Playwright 真实打开页面验证画布、连线、运行状态、审批弹窗、失败恢复和刷新恢复。

### 9.2 非目标验收

- 首版不出现“定时任务”“Webhook URL”“代码节点”“远程市场”等入口。
- 工作流不能自动启用工具、自动安装 MCP、自动读取 Keychain。

## 10. 分阶段交付

| 阶段 | 目标 | 主要产物 |
|---|---|---|
| P7.1 Runtime Foundation | 建立 workflow definition/run/node run 合同与执行器骨架 | schema、repo、API、线性 DAG 执行 |
| P7.2 Canvas MVP | 可视化创建、编辑、运行和观察 | 画布、节点 Inspector、运行面板、Playwright 主路径 |
| P7.3 Control Nodes | 条件分支、审批、预算暂停、失败重试 | Condition、Approval、recover API、节点级成本门禁 |
| P7.4 AI-native Nodes | Deep Research、Roundtable、Quick Compare 作为复合节点 | 专用节点适配器、子运行关联、结果引用 |
| P7.5 Packaging | 模板库、导入导出、版本管理、迁移策略 | workflow templates、versioning、兼容检查 |

