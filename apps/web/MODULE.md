# apps/web · MODULE

## 定位

Taori Web UI — React 18 + TypeScript + Vite SPA，渲染聊天、侧边栏、模型选择、成本可视化与 Drawer 设置面板。

## 架构

```
src/
  main.tsx             入口：cookie auth bootstrap + React 挂载
  App.tsx              主壳：会话状态、发送/重试流、Header / Footer / Chat 编排
  Sidebar.tsx          会话列表、搜索、标签、右键菜单
  Composer.tsx         输入框、附件 chip、slash 模式菜单、发送/停止按钮
  api.ts               Sidecar HTTP 客户端（REST + SSE streaming）
  sidecar.ts           Endpoint 解析 + authedFetch（Tauri / browser dev / cookie 三模式）
  useLiveData.ts       React hooks：useLive<T> 轮询基座 + useFooterHealth / useModels / useConversations 等
  attachments.ts       Composer 附件类型识别与 base64 准备
  chatStream.ts        Chat Data Stream annotation 合并与历史消息构造
  markdown.tsx         聊天消息 Markdown 渲染与代码块复制
  DrawerProviders.tsx  Provider 抽屉列表 / 新增 / 编辑 / 测试连接
  DrawerModels.tsx     模型抽屉 live/mock 列表与启停
  providerDisplay.ts   Provider 颜色等展示纯函数
  primitives.tsx       基础原子：MODELS 配色/价格、BrandMark SVG、Icon（35+ inline SVG）、ThreadNode
  scenarios.tsx        Mock 数据：MODES、Message discriminated union、6 个 SCENARIOS、SIDEBAR_GROUPS
  cards.tsx            消息卡片：UserMsg / AssistantMsg / RoundtableCard / ResearchInProgress / ResearchDone / CompareCard / ImageCard
  surfaces.tsx         Overlay & Drawer：ModelPicker / HealthPopup / CostTodayPopup / CostSessionPopup / ModeMenu / OverMenu / ModelToolsDrawer / SettingsDrawer / Banner / NoKeyCard
  styles/
    tokens.css         CSS 自定义属性：表面层级、边框、文字、accent、模型身份色、状态色、圆角、阴影、字体、布局尺寸
    app.css            全量组件 CSS + grain 纹理 + responsive 断点
```

## 主要接口

- `api.ts` → Sidecar REST（`/v1/providers`, `/v1/models`, `/v1/conversations`, `/v1/costs/*`, `/v1/chat` SSE）
- Provider 连接测试复用 `POST /v1/providers/test`：对已保存 Provider 发送 `{ provider_id }`，由 Sidecar 读取本地 keystore 中的 key；错误 toast 直接展示 `classification + message`，不再把结构化错误吞成“未知错误”。
- `sidecar.ts` → `getSidecarEndpoint()` 三模式解析（Tauri runtime → `VITE_SIDECAR_URL` → 同源 cookie）
- `useLiveData.ts` → 轮询 hooks，每 5-60 秒刷新，`isSidecarConfigured()` 为 false 时静默

## 拥有状态

- **Mock 模式**（无 Sidecar）：`scenarioId` 选择 8 个预设场景，sidebar 展示 `SIDEBAR_GROUPS`，chat 区渲染 mock 消息卡片
- **Live 模式**（Sidecar 可达）：`convId` 选择真实会话，sidebar 按日期分组真实 conversations，chat 区渲染 `ConversationMessage`，composer 通过 SSE streaming 发送消息
- UI 临时状态：overlay 开关、model picker 选择、drawer 打开、composer 文本、sidebar 移动端展开
- 不持久化 API Key、业务数据

## 依赖

- `packages/shared` — Model / Provider 类型与 Zod schema
- `apps/sidecar` — 本地 HTTP API（Bearer 或 cookie 鉴权）
- Tauri Renderer 环境或独立浏览器

## 数据流

```
用户输入 → Composer → POST /v1/chat (SSE) → onChunk 拼接 assistant message
                                    → onDone 标记完成 → 下次 poll 同步真实数据

useConversations() ──→ sidebar 真实会话列表（按 updated_at 分组）
useMessages(convId) ──→ chat 区消息（liveMsgs 本地状态，streaming 结束后 sync）
useFooterHealth()   ──→ footer 状态 pill + provider/key 健康
useRealtimeCost()   ──→ footer 今日/本会话费用
useModels()         ──→ model picker + drawer models tab
```

## Responsive

| 断点 | 行为 |
|---|---|
| ≥1280px (desktop) | 双栏 grid（sidebar 264px + main） |
| 768–1279px (tablet) | sidebar 缩至 216px |
| <768px (mobile) | 单栏；sidebar 变 fixed overlay + backdrop；header 显示 hamburger；footer 隐藏版本号 |

## E2E 测试

- `e2e/app-shell.spec.ts` — 页面加载、header/sidebar/footer 渲染、无 JS 错误
- `e2e/chat-flow.spec.ts` — Sidecar 真实聊天：发送消息、用户气泡出现、新建对话
- `e2e/responsive.spec.ts` — 移动端 viewport：hamburger 菜单、sidebar overlay、backdrop 关闭

## Drawer 实时数据

- **Providers tab** → `useFooterHealth()` 真实 provider + key status，无数据时 fallback mock
- **Models tab** → `useModels()` 真实模型列表（按 capability 分组），无数据时 fallback mock
- **Tools tab** → 已接入工具启停、托管搜索与 MCP 管理；无 Sidecar 时退化为本地展示
- **Templates / Persona** → 已接入 prompt templates / personas API；无 Sidecar 时退化为本地展示
- **Settings Drawer** → 混合 live 与本地 UI 状态：预算、thinking、数据导入导出、自检/诊断等走 Sidecar；纯外观项保留前端状态
