# 29 · WebUI 功能目标清单（非设计约束版）

> **目标读者：** Claude Design / 前端设计与实现者  
> **目的：** 说明 Taori 新 WebUI 希望覆盖哪些用户能力。本文只定义功能目标与验收意图，**不规定布局、组件、视觉风格、交互形态或信息架构**。  
> **后端接口索引：** `docs/architecture/35-current-backend-api-inventory.md`

## 0. 设计自由边界

本文不要求：

- 沿用旧 WebUI 的页面、组件、配色、布局或交互。
- 使用侧边栏 / 顶栏 / 底栏 / Drawer / 卡片等任何固定结构。
- 按后端接口分页面。
- 一次性暴露所有高级功能。

本文只要求最终产品让用户能自然完成下列能力，并能清楚感知 Taori 的三条主线：失败兜底、成本透明、多模型协作。

## P0 · 可用主线

### 1. 进入与连接

用户应该能：

- 在 Desktop 托管、Vite dev、standalone browser 三类环境中进入前端。
- 在未配置 Sidecar 或未登录 standalone 时看到可恢复状态，而不是空白页。
- 在需要时完成最小连接 / 登录 / API Key 配置。
- 看到 Sidecar 是否在线，以及关键自检问题。

相关后端能力：

- `/health`
- `/v1/selfcheck`
- `/api/standalone-auth/session`
- `/api/standalone-auth/login`
- `/api/standalone-auth/logout`

### 2. 普通聊天

用户应该能：

- 创建新会话。
- 输入文本并发送给选定模型。
- 接收流式回复。
- 中止、重试或从异常状态恢复。
- 查看历史消息。
- 编辑用户消息并重新生成后续内容。
- 从某条消息分支出新会话。

相关后端能力：

- `/v1/chat`
- `/v1/runs/:id/continue`
- `/v1/runs/:id/resume-state`
- `/v1/runs/:id/recover`
- `/v1/conversations`
- `/v1/conversations/:id/messages`
- `/v1/conversations/:id/messages/:msgId`
- `/v1/conversations/:id/messages/:msgId/branch`

### 3. 会话管理

用户应该能：

- 找到、搜索、切换会话。
- 重命名、删除、归档、置顶、打标签。
- 导出会话。
- 理解当前会话正在使用的模型、Persona、工具、附件和成本上下文。

相关后端能力：

- `/v1/conversations`
- `/v1/conversations/:id/profile`
- `/v1/conversations/:id/export`
- `/v1/conversations/:id/run-events`
- `/v1/conversations/:id/runs`

### 4. 模型与 Provider 基础配置

用户应该能：

- 添加、编辑、删除 Provider。
- 保存、测试、撤销 API Key。
- 发现 Provider 支持的模型。
- 添加、编辑、删除模型。
- 设置默认模型。
- 设置 fallback 顺序。
- 测试模型可用性。
- 看到模型健康状态。

相关后端能力：

- `/v1/providers`
- `/v1/providers/test`
- `/v1/providers/key-status`
- `/v1/providers/:id/discover`
- `/v1/providers/:id/key`
- `/v1/models`
- `/v1/models/:id/default`
- `/v1/models/reorder`
- `/v1/models/:id/test`
- `/v1/models/health`
- `/v1/catalog/sync`

### 5. 成本透明

用户应该能：

- 在发起任务前或任务中感知可能成本。
- 查看当前会话、今日/周期、模型/功能维度的实际成本。
- 查看最近调用记录。
- 导出成本数据。
- 在高成本调用前得到确认机会。

相关后端能力：

- `/v1/costs/realtime`
- `/v1/costs/calls`
- `/v1/costs/avg-output`
- `/v1/costs/breakdown`
- `/v1/costs/export`
- 聊天 / 圆桌 / 对比流中的 cost annotations

### 6. 失败兜底与恢复可见性

用户应该能：

- 看懂失败类型：额度、限流、网络、鉴权、内容过滤、未知错误等。
- 在模型失败时看到下一步建议，而不是只有错误提示。
- 对未完成回复继续生成。
- 对失败 run 选择同模型重试、换模型、压缩上下文、跳过工具等恢复动作。
- 知道系统是否自动切换了模型或工具。

相关后端能力：

- `/v1/runs/:id/resume-state`
- `/v1/runs/:id/recover`
- `/v1/models/recommendations`
- `/v1/conversations/:id/run-events`

## P1 · Taori 标志能力

### 7. Quick Compare

用户应该能：

- 把同一个问题交给多个模型并行回答。
- 同时看到多个候选输出的状态、耗时、成本和失败情况。
- 采纳某个候选为正式会话回复。
- 重试失败或不满意的候选。

相关后端能力：

- `/v1/quick-compare`
- `/v1/quick-compare/:id`
- `/v1/quick-compare/:id/outputs/:outputId/adopt`
- `/v1/quick-compare/:id/retry`

### 8. 多模型圆桌

用户应该能：

- 针对重要问题发起圆桌。
- 让系统选择或辅助选择多个参与模型和角色。
- 查看每轮参与者观点。
- 单独重试某个参与者。
- 生成总结、共识、分歧、风险和建议。
- 将圆桌结论回填到普通会话。
- 导出圆桌结果。

相关后端能力：

- `/v1/roundtable`
- `/v1/roundtable/:id`
- `/v1/roundtable/:id/round`
- `/v1/roundtable/:id/summarize`
- `/v1/roundtable/:id/participants`
- `/v1/roundtable/:id/participant/:index/retry-candidates`
- `/v1/roundtable/:id/round/:round/participant/:index/retry`
- `/v1/roundtable/:id/loopback`
- `/v1/roundtable/:id/export`

### 9. 深度研究

用户应该能：

- 发起研究任务。
- 在题目边界不清时补充范围。
- 预览并修订研究计划。
- 启动、暂停、恢复、取消研究。
- 看到研究进度、任务、来源、论断和引用验证状态。
- 逐步看到草稿或最终报告。
- 导出研究结果。

相关后端能力：

- `/v1/research/sessions`
- `/v1/research/sessions/:id`
- `/v1/research/sessions/:id/tasks`
- `/v1/research/sessions/:id/sources`
- `/v1/research/sessions/:id/claims`
- `/v1/research/sessions/:id/plan/revise`
- `/v1/research/sessions/:id/start`
- `/v1/research/sessions/:id/pause`
- `/v1/research/sessions/:id/resume`
- `/v1/research/sessions/:id/cancel`
- `/v1/research/sessions/:id/export`

### 10. 文件与本地上下文

用户应该能：

- 把图片或文件作为上下文交给模型。
- 查看生成图片或附件预览。
- 对会话内文件执行搜索。
- 明白哪些上下文来自当前输入、历史附件、文件搜索或工具调用。

相关后端能力：

- `/v1/files/:id/data`
- `/v1/files/search`
- `/v1/chat` attachments
- `/v1/conversations/:id/profile`

### 11. 工具与 MCP

用户应该能：

- 查看系统当前有哪些内置工具和 MCP 工具。
- 开关全局工具。
- 对单个会话覆盖工具启用状态。
- 查看工具健康状态。
- 配置、刷新、重启、删除 MCP server。
- 在模型调用工具时理解发生了什么。

相关后端能力：

- `/v1/tools`
- `/v1/tools/health`
- `/v1/tools/effective`
- `/v1/tools/:name/enabled`
- `/v1/tools/:name/session-enabled`
- `/v1/tools/invoke`
- `/v1/mcp/servers`
- `/v1/mcp/servers/:id/refresh`
- `/v1/mcp/servers/:id/runtime`
- `/v1/mcp/servers/:id/restart`

## P2 · 管理与个性化

### 12. Persona 与 Prompt 模板

用户应该能：

- 创建、编辑、删除 Persona。
- 创建、编辑、删除 Prompt 模板。
- 在会话或任务中应用 Persona / 模板。
- 理解当前 Persona 是否影响模型输出。

相关后端能力：

- `/v1/personas`
- `/v1/prompt-templates`
- `/v1/memories`
- `/v1/memories/effective`

### 13. 记忆与偏好

用户应该能：

- 查看全局或会话级偏好。
- 明确设置、覆盖或删除偏好。
- 查看结构化记忆。
- 启用、禁用、删除结构化记忆。
- 避免系统静默保存重要长期偏好。

相关后端能力：

- `/v1/memories`
- `/v1/memories/effective`
- `/v1/structured-memories`
- `/v1/structured-memories/:id`

### 14. Workflow Recipe

用户应该能：

- 查看、创建、编辑、删除常用工作流模板。
- 导入、导出 recipe。
- 在执行前预览变量渲染、工具可用性、Persona、预算和输出格式。

相关后端能力：

- `/v1/workflow-recipes`
- `/v1/workflow-recipes/import`
- `/v1/workflow-recipes/:id/export`
- `/v1/workflow-recipes/:id/apply-preview`

### 15. 数据管理与诊断

用户应该能：

- 导出本地数据备份。
- 导入备份并处理冲突。
- 清空本地数据。
- 查看运行时诊断。
- 查看真实 Provider 旅程诊断结果。

相关后端能力：

- `/v1/admin/export-data`
- `/v1/admin/import-data`
- `/v1/admin/clear-all-data`
- `/v1/diagnostics/runtime`
- `/v1/diagnostics/real-provider/latest`
- `/v1/selfcheck`

## 验收建议

设计与实现可自由选择形态，但至少应能用用户旅程验证：

1. 新用户无 Key 进入后，能理解下一步并完成最小配置。
2. 用户能完成一轮普通聊天，并看到模型身份与成本线索。
3. 模型失败时，用户能看到原因和可执行恢复动作。
4. 用户能发起一次 Quick Compare，并采纳一个回答。
5. 用户能发起一次圆桌，并把总结回到会话。
6. 用户能发起一次深度研究，从计划到导出走通。
7. 用户能找到模型 / Provider / 成本 / 工具 / 记忆 / 数据管理入口，但这些入口不应压过主工作流。

本文不要求这些旅程采用任何固定页面结构；实现者可按新的设计心智重新组织。
