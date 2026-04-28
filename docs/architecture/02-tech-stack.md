# 02 · 技术选型

## 各层选型

| 层 | 选型 | 备注 |
|---|---|---|
| 桌面外壳 | **Tauri 2** | 体积小、内存低、安全好 |
| OS 能力语言 | **Rust** | 仅写文件 / 快捷键 / 托盘 / Keychain |
| 业务后端 | **Node.js + TypeScript（Sidecar）** | 与 Renderer 隔离，API Key 不暴露在前端进程 |
| 前端框架 | **React + TypeScript** | 生态最大，AI SDK hooks 开箱即用 |
| 前端构建 | **Vite** | Tauri 默认推荐，最快 |
| 状态管理 | **Zustand** | 比 Redux 轻、比 Context 快 |
| UI 组件 | **shadcn/ui + Tailwind** | 桌面应用主流，可定制 |
| 流式 hooks | **`ai/react`（Vercel AI SDK）** | 自动处理 SSE |
| Sidecar HTTP | **Fastify** | 比 Express 快、TS 友好、SSE 简单 |
| LLM 客户端层 | **Vercel AI SDK** + provider packages | 多 provider 统一抽象 + 流式 + 工具调用 |
| Agent 编排 | **MVP 自研轻量编排**（基于 AI SDK） | 第二阶段评估 Mastra |
| 数据存储 | **SQLite**（better-sqlite3） | Sidecar 进程内访问 |
| ORM | **Drizzle ORM** | TS 一流、轻量、迁移友好 |
| 校验 | **Zod** | 跨进程类型安全 |
| Token 计数 | **`tiktoken`（WASM）+ `@anthropic-ai/tokenizer`** | 调用前估算 |
| 进程管理 | **Tauri sidecar API** | 官方支持 |
| 日志 | **Pino**（sidecar） | 结构化日志 |
| API Key 存储 | **OS Keychain**（通过 Rust） | Tauri 的 keyring crate |
| Sidecar 打包 | **Node SEA + esbuild bundle**（首选）/ `bun build --compile`（备选） | M0 spike 验收点：better-sqlite3 在 macOS arm64+x64、Windows x64 上启动可用；详见 [06-build-and-package.md](./06-build-and-package.md) |
| Provider 接入 | **OpenRouter 优先**，并保留直连各家 | 用户一键导入即得海量模型 |
| AI SDK 版本锁定 | **M0 spike 期锁定主版本（Vercel AI SDK + ai/react）** | SDK 演进快，`streamText` / `useChat` / SSE 协议在主版本间有破坏性变更；M0 spike 通过后把版本写进 `apps/sidecar/package.json` 与 `apps/web/package.json`，并在合同 [08-api-contracts.md](./08-api-contracts.md) §12 回写实际 API 形态 |

## 选型理由要点

### 为什么 TS 不是 Rust 做主语言
Rust LLM 生态薄弱，没有成熟的 Agent 框架，provider 适配全要自研。TS 阵营的 Vercel AI SDK / LangGraph.js / Mastra 已经把这些事做完了。Rust 只承担 OS 层不可替代的工作。

### 为什么业务跑在 Sidecar 而不是 Renderer
- API Key 仅在 Renderer 的输入阶段短暂持有明文，**不持久化、不日志、不外发到非本机端点**；Sidecar 才是真正握有运行期 Key 的地方，安全性更好
- 崩溃隔离（业务挂了不影响窗口）
- 将来切换前端框架不影响业务
- 可独立给业务进程做日志/性能 profiling

### 为什么 MVP 不上 Agent 框架
圆桌本质是 `Promise.all + 状态机`，几百行代码搞定，比强行套框架更可控。Pipeline 工作流上线时再评估 Mastra（轻量、TS 原生）。

### 为什么用 Vercel AI SDK 而不是 LangChain.js
- API 稳定、社区活跃、文档齐全
- `useChat` / `streamText` 原生支持 SSE，省去手写 SSE 解析
- LangChain.js 抽象重、API 不稳定，不适合作为长期底座

### 为什么 Drizzle 而不是 Prisma
- Drizzle 在 TS 类型推断上更直接，不用代码生成
- Prisma 引擎是 Rust 二进制，分发到桌面端打包复杂
- better-sqlite3 + Drizzle 在 Sidecar 进程里同步调用最简

## 不采用的方案

| 否决 | 理由 |
|---|---|
| ❌ **Rust 主语言** | 迭代慢、生态不匹配 |
| ❌ **Electron** | 体积大、内存高（虽开发更快，但桌面 AI 助手长期产品化体验更看重轻量）|
| ❌ **LangChain.js 主框架** | 抽象重、API 不稳定 |
| ❌ **OpenCode** | 那是产品不是框架，不适合作为依赖底座 |
| ❌ **Prisma** | 引擎是 Rust 二进制，桌面分发打包复杂 |
| ❌ **WebSocket 通信** | 单向流足够，SSE 更简单更标准 |
| ❌ **Tauri Event 通道传流式** | 序列化开销大，背压控制差 |
