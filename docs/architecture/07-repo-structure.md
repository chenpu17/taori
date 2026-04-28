# 07 · 仓库结构

## 顶层布局（pnpm workspace monorepo）

```
taori/
├─ AGENTS.md                      # AI 协作入口
├─ README.md                      # 项目门面
├─ docs/                          # 设计文档（本目录）
│  ├─ README.md
│  ├─ product/                    # 产品视角
│  ├─ architecture/               # 架构视角（本目录）
│  └─ modules/                    # 模块清单
│
├─ apps/                          # 应用层
│  ├─ desktop/                    # Tauri 外壳
│  ├─ web/                        # React Renderer
│  └─ sidecar/                    # Node.js 业务进程
│
├─ packages/                      # 共享包
│  ├─ shared/                     # 前后端共享类型与 schema
│  └─ prompts/                    # 元 Prompt 模板
│
├─ pnpm-workspace.yaml
├─ package.json
├─ tsconfig.base.json
└─ .changeset/                    # 版本管理（可选）
```

## apps/desktop（Tauri 外壳）

```
apps/desktop/
├─ src-tauri/                     # Rust 代码
│  ├─ src/
│  │  ├─ main.rs                  # 入口
│  │  ├─ sidecar.rs               # Node 进程管理
│  │  ├─ keychain.rs              # OS Keychain 封装
│  │  └─ commands.rs              # Tauri 命令（暴露给 Renderer）
│  ├─ Cargo.toml
│  └─ tauri.conf.json
└─ package.json                   # 仅写 tauri-cli 等开发依赖
```

## apps/web（React Renderer）

```
apps/web/
├─ src/
│  ├─ components/                 # UI 组件
│  │  ├─ chat/
│  │  ├─ roundtable/
│  │  ├─ models/                  # 模型配置中心
│  │  └─ cost/                    # 成本仪表盘 / 徽章
│  ├─ hooks/                      # 业务 hooks（封装 AI SDK）
│  ├─ contexts/                   # SidecarContext (port + token)
│  ├─ pages/
│  └─ main.tsx
├─ vite.config.ts
└─ package.json
```

## apps/sidecar（Node.js 业务进程）

```
apps/sidecar/
├─ src/
│  ├─ server.ts                   # Fastify 入口
│  ├─ routes/
│  │  ├─ chat.ts                  # /v1/chat (SSE)
│  │  ├─ roundtable.ts            # /v1/roundtable (SSE)
│  │  ├─ models.ts                # /v1/models (REST)
│  │  └─ costs.ts                 # /v1/costs (REST)
│  ├─ providers/                  # 各 provider 适配（基于 AI SDK）
│  │  ├─ index.ts                 # 统一注册
│  │  ├─ openrouter.ts
│  │  ├─ openai.ts
│  │  ├─ anthropic.ts
│  │  └─ ollama.ts
│  ├─ orchestration/              # 业务编排
│  │  ├─ chat-with-tools.ts       # 聊天中跨模型调用
│  │  ├─ roundtable.ts            # 圆桌状态机
│  │  └─ fallback.ts              # 失败兜底逻辑
│  ├─ cost/                       # 成本计算
│  │  ├─ estimator.ts             # 调用前预估
│  │  ├─ recorder.ts              # 调用后记录
│  │  └─ pricing.ts               # 各 provider 价格表
│  ├─ db/                         # SQLite
│  │  ├─ schema.ts                # Drizzle schema
│  │  ├─ migrations/
│  │  └─ client.ts
│  └─ memory/                     # 偏好与记忆
└─ package.json
```

## packages/shared

前后端共享：
```
packages/shared/
└─ src/
   ├─ types/                      # API 请求/响应类型
   ├─ schemas/                    # Zod schema
   └─ constants/
```

## packages/prompts

元 Prompt 模板（独立包，方便迭代和回滚）：
```
packages/prompts/
└─ src/
   ├─ roundtable-roles.ts         # 圆桌角色生成元 Prompt
   ├─ roundtable-summary.ts       # 圆桌总结模板
   └─ intent-router.ts            # 聊天中意图识别
```

## 模块合同位置

每个 `apps/*` / `packages/*` 在 M0 之后建立 `MODULE.md`，遵循 [my-spec 模块合同模板](file:///Users/chenpu/workspace/claude-code/my-spec/模板/模块合同模板.md)。

```
apps/sidecar/MODULE.md
apps/desktop/MODULE.md
apps/web/MODULE.md
packages/shared/MODULE.md
packages/prompts/MODULE.md
```

模块清单总览：[../modules/inventory.md](../modules/inventory.md)

## 命名约定

| 项 | 规则 |
|---|---|
| 包名 | 全部使用统一 scope `@taori/*`：`@taori/desktop` / `@taori/web` / `@taori/sidecar` / `@taori/shared` / `@taori/prompts` / `@taori/llm-providers` / `@taori/cost-engine` / `@taori/storage` / `@taori/ui-kit`（如启用） |
| 文件 | kebab-case（如 `chat-with-tools.ts`）|
| TypeScript 类型 | PascalCase |
| 函数/变量 | camelCase |
| 常量 | SCREAMING_SNAKE_CASE |
| Rust | 标准 Rust 风格 |
| commit message | 中文或英文均可，**不含 Claude / AI 工具相关字样** |
