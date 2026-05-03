# apps/web · MODULE

## 定位

Taori React Renderer，负责聊天、控制中心、模型中心、工具配置、成本可视化与圆桌交互。

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

- 控制中心工具页新增 MCP Server 添加、刷新、启停、删除入口。
- 模型编辑器新增 `pricing_meta` JSON 编辑。
- 圆桌参与者列新增 `rt.tool_trace` 可视化，并在刷新后保留本轮工具痕迹。
