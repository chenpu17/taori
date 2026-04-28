# 文档索引

> **Taori** · 多模型桌面 AI 助手的设计文档总入口。
>
> *Taori weaves many models into one continuous flow.*
> 当前状态：**M0 前**（产品与架构设计已定稿，代码未启动）

## 阅读路径

### 我是产品 / 用户视角的读者
1. [产品定位](./product/01-positioning.md) — 一句话定位 + 三条产品主线
2. [核心功能](./product/02-core-features.md) — MVP 功能清单与交互
3. [成本透明专题](./product/03-cost-transparency.md) ⭐ — 产品主线之一
4. [失败兜底专题](./product/04-failure-resilience.md) ⭐ — 产品主线之一
5. [多模型圆桌](./product/05-roundtable.md) ⭐ — 产品主线之一（标志性功能）
6. [关键决策](./product/06-key-decisions.md) — 已确认的产品决策
7. [MVP 路线图](./product/07-mvp-roadmap.md) — M0 / M1 / M2 / M3 分版本
8. [M1 详细规格](./product/08-m1-spec.md) 🛠 — 开发就绪：用户故事 + 验收标准 + Onboarding
9. [Agent 与工具体系](./product/09-agent-and-tools.md) — 内置工具 / MCP / 圆桌作为原生 Agent

### 我是技术 / 工程视角的读者
1. [架构总览](./architecture/01-overview.md) — Tauri + Renderer + Sidecar 三进程模型
2. [技术选型](./architecture/02-tech-stack.md) — 选型理由 + 不采纳方案
3. [进程模型与 IPC](./architecture/03-process-and-ipc.md) — HTTP + SSE + Bearer Token
4. [数据与存储](./architecture/04-data-and-storage.md) — SQLite Schema + 元 Prompt + 成本算法
5. [安全设计](./architecture/05-security.md) — Keychain / 本地加密
6. [构建与打包](./architecture/06-build-and-package.md) — bun compile + Tauri externalBin
7. [仓库结构](./architecture/07-repo-structure.md) — pnpm monorepo 目录约定
8. [API 合同（M1）](./architecture/08-api-contracts.md) 🛠 — 开发就绪：每个端点请求/响应/错误码
9. [Agent 内核与工具体系](./architecture/09-agent-and-tools.md) — Capability Bus / MCP 桥 / 圆桌编排器

### 我是模块作者
- [模块清单](./modules/inventory.md) — 系统所有模块的灰盒一览
- 单模块合同（M0 后）：`apps/<name>/MODULE.md` / `packages/<name>/MODULE.md`

## 文档治理

本项目遵循 [my-spec 灰盒治理框架](file:///Users/chenpu/workspace/claude-code/my-spec/AI开发操作规范.md)，详见仓库根 `AGENTS.md`。

- 产品文档（`docs/product/`）：用户与价值视角，保持高内聚、易读
- 架构文档（`docs/architecture/`）：跨模块决策，作为模块合同的上游约束
- 模块合同（`MODULE.md`）：跟代码走，避免脱节

## 版本

当前设计版本：**v0.6**（采纳五轮评审意见 + Agent/工具体系定稿）。变更历史见 git 历史。
