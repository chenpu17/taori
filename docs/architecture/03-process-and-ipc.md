# 03 · 进程模型与 IPC

## IPC 架构：本地 HTTP + SSE

**最终选择：Sidecar 启动本地 HTTP 服务，Renderer 通过 fetch + SSE 直连。**

```
┌─────────────────────┐         ┌─────────────────────────┐
│ Renderer (React)    │         │ Sidecar (Node.js)        │
│                     │         │                          │
│ Vercel AI SDK hooks │ HTTP    │ Fastify on 127.0.0.1:port│
│   useChat()         ├────────▶│ /v1/chat (SSE stream)    │
│   useCompletion()   │ + SSE   │ /v1/roundtable (SSE)     │
│                     │ + Bearer│ /v1/models  (REST)       │
│                     │  Token  │ /v1/costs   (REST)       │
└─────────────────────┘         └────┬────────────────────┘
         ▲                            │
         │ Tauri Command              │
         │ (启动时获取 port + token)   │
         ▼                            ▼
   ┌─────────────────────────────────────┐
   │ Tauri Rust Core                      │
   │  - 启动/守护 Node Sidecar            │
   │  - OS Keychain (API Key 存取)        │
   │  - 文件拖拽、托盘、快捷键              │
   │  - 给 Renderer 提供 init() 命令      │
   │    返回 { port, token }              │
   └──────────────────────────────────────┘
```

## 为什么这样选

| 备选方案 | 否决原因 |
|---|---|
| Renderer ↔ Rust ↔ Node 全程透传 | Rust 要中转流，复杂且无收益 |
| Tauri Event 通道传流式 chunk | 序列化开销大，背压控制差 |
| WebSocket 双向 | 单向流足够，SSE 更简单更标准 |
| 业务直接跑在 Renderer | API Key 暴露在前端进程，违背安全设计 |

## 安全要点

- Sidecar 启动时绑定 `127.0.0.1:0`（系统分配空闲端口），仅本机可达
- 启动时生成随机 32 字节 Bearer Token，通过 stdout 传给 Rust，Rust 通过 Tauri 命令暴露给 Renderer
- 每次请求验证 `Authorization: Bearer <token>` 头
- Renderer 启动时调用 `invoke('sidecar_endpoint')` 一次性获取 endpoint，缓存到 React Context
- Token 仅内存持有，进程退出即销毁；不写盘

## 流式实现要点

- Sidecar 用 Fastify + Vercel AI SDK 的 `streamText(...)` 输出流式响应。**具体的"把流挂回 HTTP response"的 API 名（如 `toDataStreamResponse` / `toUIMessageStreamResponse`）随 AI SDK 主版本演进，本文不硬钉**——以 [02-tech-stack.md](./02-tech-stack.md) 中 **M0 spike 锁定的 SDK 主版本**为准；锁定后回写本节与 [08-api-contracts.md](./08-api-contracts.md) §7 的伪代码。
- 输出的协议遵循 AI SDK 的"数据流协议"（part-code 行格式，如 `0:"text"\n` 文本 / `8:[...]\n` annotation / 结束帧 / 错误帧）；**M0 spike 验收点**包含：跑通 `useChat` ↔ Sidecar 联调、注入业务字段（meta/cost）、错误流分类、abort 链路。
- 心跳：使用空 Data Part（保活但不污染前端消息流）。
- 业务字段（`conversation_id`、`model_id`、`attachments`）通过 `useChat` 的 `body` 选项或自定义 `fetch` 注入到请求体。
- 客户端断开时清理上游 LLM 调用（AbortController 链路：Renderer abort → Sidecar 收到 close 事件 → 取消上游 fetch）。
- **明确不再保留旧版的 `event: chunk/meta/done/error` 自定义事件名**——前后端唯一契约就是锁定后的 AI SDK 数据流协议。

> **M0 spike：** 必须先做一个最小 `useChat` ↔ Sidecar 联调（注入自定义字段 + 渲染 annotation + 错误流 + abort），把这条主线打通**并锁定 AI SDK 主版本**后再展开 M1 其他功能。

## 生命周期

| 阶段 | 行为 |
|---|---|
| 启动 | Tauri 启动 → spawn Sidecar → 等待 stdout 输出 `READY {port} {token}` → Renderer 可连接 |
| 退出 | Tauri 退出 → 优雅关闭 Sidecar（SIGTERM，5 秒后强 SIGKILL）|
| 崩溃 | Sidecar 崩溃 → Rust 自动重启 + 重生 token + 通过 Tauri 事件推给 Renderer 重连 |
| 健康检查 | 启动后 Renderer 周期性 GET `/health`，连续 3 次失败触发重启 |

## API 端点（M0–M3）

| 端点 | 方法 | 用途 | 鉴权 | 引入版本 |
|---|---|---|---|---|
| `/health` | GET | 健康检查（无 `/v1` 前缀，免鉴权） | ❌ | M0 |
| `/v1/providers` | GET/POST/DELETE | Provider CRUD | ✅ | M1 |
| `/v1/providers/:id/test` | POST | Provider 连通性 | ✅ | M1 |
| `/v1/providers/:id/discover-models` | GET | 拉取 provider 侧模型列表（OpenRouter 一键导入） | ✅ | M1 |
| `/v1/models` | GET/POST/PATCH/DELETE | 模型 CRUD | ✅ | M1 |
| `/v1/models/batch` | POST | 批量导入 | ✅ | M1 |
| `/v1/models/:id/test` | POST | 单模型可用性检测 | ✅ | M1 |
| `/v1/conversations` | GET/POST/PATCH/DELETE | 会话 CRUD | ✅ | M1 |
| `/v1/messages` | GET | 历史消息 | ✅ | M1 |
| `/v1/chat` | POST + SSE | 聊天流式（AI SDK Data Stream Protocol） | ✅ | M1 |
| `/v1/costs/summary` | GET | 会话/今日/本月聚合 | ✅ | M1 |
| `/v1/costs/realtime` | GET | 状态栏实时数字 | ✅ | M1 |
| `/v1/costs/records` | GET | 明细查询 | ✅ | M1 |
| `/v1/files` | POST | 文件上传（multipart） | ✅ | M1 |
| `/v1/memories` | GET/PUT | 偏好读写 | ✅ | M2 |
| `/v1/chat/with-tools` | POST + SSE | 跨能力工具调用 | ✅ | M2 |
| `/v1/roundtable` | POST + SSE | 圆桌会话 | ✅ | M3 |
| `/v1/roundtable/:id/round` | POST | 触发下一轮 | ✅ | M3 |
| `/v1/roundtable/:id/summarize` | POST | 触发总结 | ✅ | M3 |
| `/v1/roundtable/:id/export` | GET | Markdown 导出 | ✅ | M3 |

> **健康检查不带 `/v1` 前缀**：因为它是基础设施级的探活，不属于业务 API；同时**免鉴权**便于 Tauri Rust 轮询。所有业务 API 在 `/v1/` 下，且必须带 Bearer Token。

## Sidecar ↔ Tauri Rust 控制通道（**M0 第一验收点**）

Sidecar 在三类场景需要**反向**调用 Tauri Rust：

1. 写 OS Keychain（保存新 Provider 的 API Key）
2. 读 OS Keychain（运行时按需取 Key 给 LLM 调用使用）
3. 读取本地文件（拖入路径 → 读 base64 / 文本）

> **Tauri 标准 command 通道是 Renderer → Rust，不能直接被 Sidecar 调用。** 这条通路是 **M0 必须最先打通的关键路径**——Provider CRUD、Keychain、文件读取全部依赖它。**M1 不能在通路未验收前冻结**。候选方案：

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A. Rust 暴露本地 HTTP**（推荐） | Rust 起一个仅监听 `127.0.0.1` + 独立 Bearer Token 的极小 HTTP 服务，Sidecar 调用。**实现选 [`axum`](https://github.com/tokio-rs/axum)**（Tauri 已含 tokio 运行时，axum 增量很小；社区主流，5 端点足够轻量） | 与 Sidecar↔Renderer 通道同构；易测试 | 多一个端口 |
| B. stdio JSON-RPC | Tauri spawn Sidecar 时同时用 stdin/stdout 双工通信 | 无网络面 | 序列化复杂；混在日志里难调试 |
| C. Rust 直管 Provider Key 写入 | onboarding/编辑 Provider 的 Key 写入由 Renderer→Rust（不经 Sidecar），Sidecar 启动时一次性加载 | 简单 | Provider CRUD 路径分裂；新增 Provider 必须重启 Sidecar |

**M0 默认按方案 A 实现**；若实测有阻塞再考虑切换。该决策一旦在 M0 落地，会反向更新本文件与 [08-api-contracts.md](./08-api-contracts.md) §12。
