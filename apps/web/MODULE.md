# apps/web · MODULE

## 定位

 Taori React Renderer，负责聊天、控制中心、模型中心、深度研究工作台、成本可视化与圆桌交互。

## 主要接口

- 通过 `src/api.ts` 调用 Sidecar REST/SSE。
- 通过 `roundtableStream.ts` 消费圆桌 SSE annotation。
- 通过 `sidecar.ts` 获取本地 Sidecar endpoint 与 bearer。

## 拥有状态

- UI 临时状态：当前会话、控制中心分区、模型编辑表单、MCP Server 表单、圆桌流式列状态。
- 不持久化 API Key、MCP env 或业务数据库。

## 依赖

- `packages/shared` 类型。
- `apps/sidecar` 本地 HTTP API。
- Tauri Renderer 环境或浏览器开发环境。

## 当前合同变化

- 控制中心工具页按“搜索工具 / 其他内置工具 / 高级 MCP Bridge”三段重排：搏查搜索改为托管远程 SSE 接入卡片，不再向普通用户暴露 `npx mcp-remote` 细节；自定义 stdio/bridge 仍保留在高级区。
- 控制中心工具页新增“默认搜索工具”全局设置，用户选择会同时影响普通聊天、Quick Compare 与 Roundtable 的联网搜索入口；未配置时回退到内置网页搜索。
- 模型编辑器新增 `pricing_meta` JSON 编辑。
- 圆桌参与者列新增 `rt.tool_trace` 可视化，并在刷新后保留本轮工具痕迹。
- 聊天消息的“续写”按钮改为调用 Sidecar `POST /v1/runs/:id/continue`，不再追加“请继续上文”这类合成用户消息；若 Sidecar 返回 `cost_confirmation_required`，复用成本确认弹窗并以 `confirmed_cost=true` 二次提交；完成后刷新消息、运行时间线、实时成本和侧边栏。
- 失败决策卡片的“重试 / 切换并重试 / 压缩上下文后重试 / 跳过失败工具继续”改为调用 Sidecar `POST /v1/runs/:id/recover`，前端只负责用户确认、传递目标模型或失败工具名，并刷新视图；恢复动作同样消费服务端成本确认门禁。
- 运行过程的上下文快照卡片消费 Sidecar `context_window` 增量字段，展示本次是否自动裁剪较早历史；聊天发送请求合同不变。
- 圆桌创建成功后会把新建 roundtable conversation 提升为当前会话，使 Run Timeline、会话工具策略和刷新恢复都绑定到同一个会话状态。
- 控制中心工具页消费 Sidecar `GET /v1/tools/health`，在每个工具旁展示最近 24h 调用数、失败数、平均耗时和最近失败分类。
- 控制中心概览页复用 `GET /v1/models/health` 与 `GET /v1/tools/health`，展示模型/工具最近 24h 调用、失败、受影响数量和最近失败分类；仅展示风险，不自动改变默认模型或工具启停。
- 成本看板最近调用日志消费 `GET /v1/costs/calls` 的 run/event 关联字段，展示 Cost ID、Run ID 和运行事件；Run Timeline 的 `cost.recorded` 事件可通过 `cost_record_id` 精确打开并高亮对应成本调用，形成双向反查。
- ModelCenter 打开时不再自动读取 Provider Keychain 状态；Provider 卡片只显示已保存 Key 引用，“检查钥匙串状态”会作为显式用户动作调用 `/v1/providers/key-status?confirm_keychain=1`；测试连接、模型同步或发送消息仍属于用户主动触发的真实 Provider 路径。显式检查后会标出 Key 缺失 Provider，并可直接进入重新填写 Key 的编辑流。
- Help Center 默认“运行自检”只做轻量本地诊断，不读取系统钥匙串；“检查钥匙串”是显式深度检查入口，并提示 macOS 可能弹授权。
- Help Center 新增“真实模型能力诊断”，消费 Sidecar `GET /v1/diagnostics/real-provider/latest`，只展示最近 `verify:real` 本地产物摘要，不主动读取 Keychain、不发起真实模型调用。
- Onboarding 供应商预设新增 PackyAPI / PackyCode 与硅基流动 SiliconFlow；默认 Base URL 来自 `packages/shared` 常量，前端只采集用户输入的 API Key，不持久化或日志输出明文。
- Onboarding 供应商预设新增 DeepSeek 官方；默认 Base URL 来自 `packages/shared` 的 `DEFAULT_DEEPSEEK_BASE_URL`，前端只采集用户输入的 API Key，不持久化或日志输出明文。
- 聊天头部的“模板市场”把内置工作流、已启用 Workflow Recipe 与用户自定义 Prompt 模板统一收敛为本地模板发现入口；支持搜索、预览、按来源筛选，并保持一键套用 / 填写变量后套用闭环。
- Settings 新增全局 thinking 开关（`thinking_enabled`）；ModelCenter 的模型编辑器新增“跟随全局 / 总是开启 / 总是关闭”三态覆盖，并通过 `PATCH /v1/models/:id` 持久化到单模型 `thinking_enabled`。
- standalone 浏览器模式下，Renderer 不再要求预先注入 Bearer 才能工作：`sidecar.ts` 可读取同源 bootstrap，所有普通 REST 与聊天流请求默认携带 `credentials: include`，由 Sidecar 的 HttpOnly cookie 会话完成鉴权；Tauri 与开发环境仍兼容 Bearer 模式。
- 聊天消息内的成本摘要不再只显示 `$`：Renderer 会在消息气泡中直接展示 `in / cache / out` token 指标，并继续保留详情卡与 Run Timeline 的成本明细。
- ModelCenter 的模型矩阵行操作区改为紧凑布局：默认/健康/Tools 使用短文案，编辑/删除改为 icon button，降低表格 padding 与操作区宽度，优先提升同屏信息密度。
- Control Center 新增“深度研究”分区与顶部快捷入口：Renderer 可创建 research session、预览计划、确认启动、暂停/恢复/取消，并查看任务 / 来源 / 结论占位与 Markdown 草稿。
