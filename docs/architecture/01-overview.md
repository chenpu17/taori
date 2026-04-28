# 01 · 架构总览

## 三进程模型

```
┌──────────────────────────────────────────────────────┐
│ 桌面外壳：Tauri 2                                     │
│   └─ Rust：仅承担 OS 能力（文件 / 快捷键 / 托盘 / Keychain）│
│                                                      │
│ 业务进程：Tauri Sidecar（Node.js 子进程）             │
│   ├─ LLM 调用与编排                                   │
│   ├─ 圆桌状态机                                       │
│   ├─ 数据持久化（SQLite）                             │
│   └─ 与 Renderer 通过本地 HTTP+SSE 通信               │
│                                                      │
│ 渲染层：React + TypeScript                            │
│   ├─ UI 组件                                          │
│   ├─ Vercel AI SDK 的 React hooks（流式渲染）         │
│   └─ 通过 fetch + SSE 调用 Sidecar                    │
└──────────────────────────────────────────────────────┘
```

## 三个进程的职责边界

| 进程 | 职责 | 不该做什么 |
|---|---|---|
| **Tauri Rust** | 启动/守护 Sidecar / OS Keychain 写入与读取 / 文件拖拽 / 托盘 / 全局快捷键 | LLM 调用、业务逻辑、数据库读写 |
| **Sidecar (Node.js)** | LLM 调用、provider 适配、圆桌编排、SQLite 读写、成本计算 | UI 渲染、直接读写 OS Keychain |
| **Renderer (React)** | UI、流式渲染、用户交互 | 持久化 API Key、直接调远程 LLM、直连数据库 |

## 关键设计原则

1. **API Key 不落 Renderer**——Renderer 在 onboarding/编辑 Provider 时**会短暂持有用户输入的 Key 明文**，但承诺：**不持久化、不写入日志、不发送到任何非本机 127.0.0.1 端点**。Key 一旦落到 Sidecar，立即通过 **Sidecar↔Rust 控制通道**（详见 [03 · 进程与 IPC](./03-process-and-ipc.md#sidecar--tauri-rust-控制通道m0-第一验收点)）转写到 OS Keychain；Sidecar 内存中也仅保留运行期所需的最小副本。
2. **业务进程独立可崩可重启** —— Sidecar 崩溃不影响窗口，Rust 自动重启
3. **流式优先** —— 所有长耗时操作（LLM、圆桌）都走 SSE，背压由 HTTP 层负责
4. **本地优先** —— 所有数据落 SQLite，无云端依赖

## 数据流（典型聊天）

```
用户输入消息
  → Renderer (useChat hook) 通过 fetch 发到 Sidecar /v1/chat
  → Sidecar 从 Rust 取 API Key（启动时加载到内存）
  → Sidecar 通过 Vercel AI SDK 调 provider，开 SSE
  → Sidecar 把 AI SDK 流转发给 Renderer（SSE）
  → 同时 Sidecar 异步写 cost_records 到 SQLite
  → Renderer 实时渲染
  → 调用结束，Sidecar 推送 'done' 事件含实际成本
```

## 跨模块依赖图（顶层）

```
                      ┌─────────────┐
                      │   Renderer  │
                      └──────┬──────┘
                             │ HTTP+SSE
                             ▼
                      ┌─────────────┐
                      │   Sidecar   │──── SQLite (本地文件)
                      └──┬───────┬──┘
                         │       │
              ┌──────────┘       └──────────┐
              ▼                              ▼
       ┌──────────────┐              ┌──────────────┐
       │ LLM Providers│              │  Tauri Rust  │
       │  (远程 HTTP) │              │ (OS / 进程)  │
       └──────────────┘              └──────────────┘
```

## 后续章节导览

- [02 技术选型](./02-tech-stack.md)
- [03 进程模型与 IPC](./03-process-and-ipc.md)
- [04 数据与存储](./04-data-and-storage.md)
- [05 安全设计](./05-security.md)
- [06 构建与打包](./06-build-and-package.md)
- [07 仓库结构](./07-repo-structure.md)
- 模块清单：[../modules/inventory.md](../modules/inventory.md)
