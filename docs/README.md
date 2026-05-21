# 文档索引

> **Taori** · 多模型桌面 AI 助手的设计文档总入口。
>
> *Taori weaves many models into one continuous flow.*
> 当前状态：**Browser-first 发布候选**（WebUI + Sidecar 主链路已实现并有回归 / 真实验证证据；Desktop 为 follow-up）

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
10. [v1.0 Agent Runtime 阶段计划](./product/14-agent-runtime-v1-plan.md) — Run Timeline / 状态机 / 恢复动作 / 真实模型验证
11. [Browser-first 发布候选摘要](./product/15-browser-first-release-candidate.md) — WebUI + Sidecar 发布证据与已知风险
12. [P1 Quick Compare 与断流续接](./product/16-p1-quick-compare-stream-resume.md) — 轻量多模型对比与 incomplete run 恢复体验
13. [P2 轻量 RAG 预备层](./product/17-p2-lightweight-rag-prep.md) — 本地文件 chunk、SQLite FTS/BM25 与引用片段
14. [P7 工作流编排](./product/27-p7-workflow-orchestration.md) — n8n-like 画布、节点运行、审批、恢复与成本守卫

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
10. [v1.0 Agent Runtime 变更提案](./architecture/19-agent-runtime-v1-proposal.md) — 运行状态归属、恢复策略与真实模型验收
11. [P1 Quick Compare / Stream Resume 变更提案](./architecture/20-p1-quick-compare-stream-resume-proposal.md) — 三模型轻量 fan-out 与断流续接状态归属
12. [P2 轻量 RAG 预备层变更提案](./architecture/21-p2-lightweight-rag-prep-proposal.md) — 文件 chunk、FTS/BM25、file_search 与 embedding 预留
13. [Standalone Sidecar Daemon 模式提案](./architecture/31-standalone-daemon-mode-proposal.md) — npm standalone 常驻后台、status/stop 与远程 host 绑定
14. [P7 工作流编排架构提案](./architecture/34-p7-workflow-orchestration-proposal.md) — workflow definition/run/node runtime、API、数据模型与验证门禁

### 我是模块作者
- [模块清单](./modules/inventory.md) — 系统所有模块的灰盒一览
- 单模块合同（M0 后）：`apps/<name>/MODULE.md` / `packages/<name>/MODULE.md`

## 发布验证入口

Browser-first 发布候选以 WebUI + Sidecar 为主线，不默认启动 Desktop，也不读取系统 Keychain。

- `pnpm dev`：本地开发者模式，先清理本仓库残留的 WebUI/Sidecar dev 进程和默认 Sidecar 端口，再启动浏览器 WebUI + Sidecar；不启动 Desktop，不读取系统 Keychain。
- `pnpm dev:clean`：只执行开发进程清理，用于处理 `127.0.0.1:17890` 被旧 sidecar/watch 占用的情况。
- `pnpm verify:browser-rc`：发布前主门禁，串行执行 `verify:web`、`verify:real:report`、`git diff --check`，并生成 `/tmp/taori-browser-rc-*` artifact、`summary.json` 和 `report.md`。
- `pnpm verify:browser-rc:report`：读取最近 Browser RC artifact，重建并打印 `report.md`，不重新跑 E2E。
- `pnpm verify:web`：WebUI + Sidecar 全量本地验证，包含 typecheck、sidecar tests、Playwright E2E。
- `pnpm verify:real:report`：读取最近真实 Provider artifact 做风险报告，不发起新的 live 调用。
- `pnpm verify:real`：真实模型 live 验证，可能读取 provider key status，需要明确授权后执行。
- `pnpm verify:desktop` / `pnpm verify:desktop-ui`：Desktop follow-up 验证；默认走 dev file keystore，真实 Keychain 路径需显式 opt-in。

## 文档治理

本项目遵循 [my-spec 灰盒治理框架](file:///Users/chenpu/workspace/claude-code/my-spec/AI开发操作规范.md)，详见仓库根 `AGENTS.md`。

- 产品文档（`docs/product/`）：用户与价值视角，保持高内聚、易读
- 架构文档（`docs/architecture/`）：跨模块决策，作为模块合同的上游约束
- 模块合同（`MODULE.md`）：跟代码走，避免脱节

## 文档基线

当前文档基线：**Browser-first RC**。发布证据与已知风险见 [`product/15-browser-first-release-candidate.md`](./product/15-browser-first-release-candidate.md)；较新的实现细节以对应 `MODULE.md`、测试与代码为准。
