# 09 · Agent 内核与工具体系（架构视角）

> **目标读者：** Sidecar 内核 / Provider 适配层工程师。  
> **决策原则：** 不引入第三方 Agent 框架（LangGraph / CrewAI / Mastra）；基于 Vercel AI SDK 的 `streamText({ tools })` 自建一套**轻 Capability Bus**。

## 1. 三层结构

```
┌────────────────────────────────────────────────────────────┐
│ Renderer                                                    │
│  - 聊天 UI / 工具中心 UI / 圆桌 UI                          │
│  - 不感知工具实现，仅渲染 tool_call 与 tool_result          │
└────────────────────────────────────────────────────────────┘
                          ↕ HTTP / SSE
┌────────────────────────────────────────────────────────────┐
│ Sidecar 内核                                                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Capability Bus（M2 起）                               │   │
│  │  - 注册中心：从 Builtin / MCP 加载 tool 定义          │   │
│  │  - 调度：按 capability 过滤、按模型 supports_tools 注入│   │
│  │  - 路由：tool_call → 具体执行器                       │   │
│  │  - 计费：每次执行写 cost_records (source_type='tool_call')│   │
│  │  - 兜底：超时/崩溃走 classifyProviderError           │   │
│  └──────────────────────────────────────────────────────┘   │
│         ↓                    ↓                    ↓          │
│   Builtin Executors    MCP Bridge (M3)     Roundtable (M3)   │
└────────────────────────────────────────────────────────────┘
```

## 2. 为什么不用 LangGraph / CrewAI / Mastra

| 候选 | 否决理由 |
|---|---|
| **LangGraph** | 强 DAG 抽象，与"用户不写流程图"产品定位不符；Python/JS 双生态、Sidecar 用 JS 时维护成本高 |
| **CrewAI** | 强 multi-agent 抽象，圆桌已是我们自研对应物；引入会出现两套语义打架 |
| **Mastra / Inngest Agent** | 设计在云原生工作流上，与本地 Sidecar 形态错位；引入大量调度/状态机概念 |
| **OpenAI Agents SDK** | 强绑 OpenAI；BYOK 多 provider 场景下不合适 |

**结论：** 直接基于 Vercel AI SDK：
```ts
const result = streamText({
  model: providerSDK(modelName),
  messages,
  tools: capabilityBus.getToolsFor(modelMeta), // Bus 提供 tools
  toolChoice: 'auto',
  onStepFinish: ({ toolCalls, toolResults, usage }) => {
    capabilityBus.recordCost({ toolCalls, toolResults, usage, ... });
  },
});
```

## 3. Capability Bus 接口（M2）

```ts
interface Tool {
  name: string;                          // 唯一名（namespace.fn 形式，如 'builtin.image_generate'）
  description: string;
  inputSchema: ZodSchema;                // Vercel AI SDK 标准
  capability: 'image' | 'file' | 'web' | 'code' | 'mcp';
  source: 'builtin' | 'mcp';
  source_id: string;                     // builtin 名 / MCP server id
  costEstimator?: (input) => number;     // 调用前预估
  enabled: boolean;
}

interface CapabilityBus {
  register(tool: Tool): void;
  unregister(name: string): void;
  list(filter?: { capability?, source? }): Tool[];
  getToolsFor(model: ModelMeta): Record<string, AISDKTool>;  // 给 streamText 用
  invoke(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult>;
  recordCost(entry: CostEntry): void;
}
```

## 4. 内置工具实现（M2）

| 工具 | 名 | 实现 |
|---|---|---|
| 图像生成 | `builtin.image_generate` | 调用用户配置的图像 capability 模型；走 provider 适配层（Replicate / OpenAI Image / SD WebUI 等） |
| 文件读取 | `builtin.file_read` | 从 `files` 表按 file_id 读取，返回 extracted_text / preview |
| 网页抓取（M3） | `builtin.web_fetch` | Sidecar fetch + readability 提取正文，**仅 http(s)，不跟随重定向到内网** |
| 剪贴板送达（M2） | `builtin.clipboard_send` | 由 Tauri Rust 经控制通道转发剪贴板内容到当前会话 |

## 5. MCP 桥（M3）

### 5.1 协议
遵循 [Model Context Protocol](https://modelcontextprotocol.io) 1.0。

### 5.2 启动模型
- **stdio**（M3 默认）：Sidecar 用 `child_process.spawn(command, args)` 启动 MCP server，stdin/stdout 走 JSON-RPC 2.0
- **本地 HTTP**（M3 可选）：Sidecar 作为 MCP client 通过 fetch 连本地 server

### 5.3 配置 schema（落 SQLite，新表 `mcp_servers`，M3 引入）

```ts
mcp_servers {
  id: text PK NOT NULL                 // 'mcp_' + nanoid(12)
  name: text NOT NULL                  // 用户给的名字
  transport: text NOT NULL             // 'stdio' | 'http'
  command: text                        // stdio 启动命令（含 args，JSON 数组）
  url: text                            // http transport 的本地 URL
  env: text                            // JSON 环境变量（敏感值经 Keychain 引用）
  enabled: boolean NOT NULL
  health_status: text                  // 'healthy' | 'unhealthy' | 'starting' | 'crashed'
  last_error: text
  created_at: integer NOT NULL
  updated_at: integer NOT NULL
}
```

### 5.4 工具发现 → 注册流程

```
用户 添加 MCP server
  → Sidecar 启动子进程
  → 发送 initialize → 收到 server capabilities
  → 调用 tools/list → 收到工具数组
  → 转换为 Bus 的 Tool 格式（namespace = `mcp.${server.id}`）
  → 注册到 Bus
  → 心跳监控：失活 3 次标记 unhealthy
```

### 5.5 安全

- **仅本地 MCP**——M3 拒绝远程 URL（`url` 必须是 `127.0.0.1` / `localhost` / Unix socket）
- **MCP server 有自己的 Key**：放 OS Keychain，运行时通过环境变量注入子进程
- **可观测**：所有 MCP 工具调用记日志（脱敏）
- **沙箱（v2）**：考虑用容器/Wasmtime 隔离，M3 先信任用户配置

## 6. 工具调用的成本归因

每次 tool_call 写一条 cost_records：

```ts
{
  source_type: 'tool_call',
  source_id: '<message_id of the assistant message that triggered the tool>',
  feature: 'tool_call',
  // 如果工具内部调了 LLM（如 image_generate），价格快照取被调模型的价
  model_id: '<被调用的模型 id>' | null,
  model_name_snapshot: '<provider/model 或 'mcp:server_id:tool_name'>',
  estimated_cost_usd, actual_cost_usd, ...
}
```

会话累计成本 = `Σ(LLM 调用) + Σ(工具调用)`，用户在状态栏始终能看到"这次任务总开销"。

## 7. 失败兜底

`Tool.invoke` 抛出的错误统一进 `classifyToolError(err)` → 输出与 `classifyProviderError` 同形态的 `{ classification, can_retry, suggestions }`，注入 SSE 流的 `error_detail` annotation：

| classification | 处理建议 |
|---|---|
| `mcp_crashed` | 重启 server / 跳过 / 告知用户 |
| `tool_timeout` | 重试 / 用其他工具 |
| `validation_error` | 工具输入不合法（不重试） |
| `permission_denied` | 提示用户授权 |
| `rate_limit` / `quota` / `network` | 复用 LLM 错误分类逻辑 |

## 8. 圆桌作为"原生 Agent"

圆桌**不是 Capability Bus 的客户**，而是与 Bus 并列的**编排器**：

```
RoundtableOrchestrator
  ├── 选择参与模型（按用户配置 + 能力）
  ├── 自动生成角色（M3 用一个 topic_analyzer 调用）
  ├── 多轮调度（round1 盲审 / round2 互见 / summarizer）
  ├── 每轮 streamText({ tools: bus.getToolsFor(model) })  ← 工具池仍可用
  └── 写 roundtable_messages / cost_records (source_type='roundtable_message')
```

> 圆桌内的每个模型仍然可以**调用工具**——比如让 GPT-4o 在第一轮发言时顺便 web_fetch 一下；这是圆桌与传统多模型对比的关键差异。

## 9. 路线图与依赖

| 里程碑 | 交付 | 依赖 |
|---|---|---|
| **M2** | Capability Bus + 内置工具（image_generate / file_read）+ `/v1/chat/with-tools` | Vercel AI SDK tools；图像 provider 适配 |
| **M3** | MCP 桥（stdio）+ 工具中心 UI + 圆桌 | Capability Bus；MCP SDK；orchestration 子模块 |
| **v2** | 远程 MCP + 自定义脚本工具（沙箱） | 沙箱方案选型 |

## 10. M0/M1 不做但需要预留

- **不要**在 M1 schema 引入 `mcp_servers` 表（M3 才加）
- **不要**在 M1 的 `/v1/chat` 引入 `tools` 入参（M2 用 `/v1/chat/with-tools` 独立端点）
- **但要**在 cost_records 的 `source_type` 枚举里**预留** `'tool_call'`（M1 schema 已包含，避免后续 migration）
- **但要**在 `classifyProviderError` 设计时考虑可扩展为 `classifyToolError`（共用基类）
