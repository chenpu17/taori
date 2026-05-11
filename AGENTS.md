# AGENTS.md

本项目（**Taori** · 多模型桌面 AI 助手）的 AI 协作入口。

> Taori weaves many models into one continuous flow.

## 1. 个人 AI 开发规范（治理层）

本项目遵循用户的个人 AI 开发规范：

- 入口文件：`/Users/chenpu/workspace/claude-code/my-spec/AI开发操作规范.md`
- 默认随之加载：`模块灰盒规范.md` / `任务生命周期规范.md` / `模板与参考索引.md`

按需读取的知识库与模板见 my-spec 仓库本身。

## 2. 项目特定补充

### 2.1 文档结构

- `docs/product/` — 产品视角（用户、场景、价值、决策、Roadmap）
- `docs/architecture/` — 技术架构视角（跨模块、系统级设计）
- `docs/modules/inventory.md` — 模块清单（灰盒一览）
- 单模块合同 → 跟代码走，核心模块已建立 `apps/<name>/MODULE.md` / `packages/<name>/MODULE.md`；新增模块或合同变化必须同步更新对应 `MODULE.md` 与 `docs/modules/inventory.md`

阅读顺序（首次接入）：
1. `docs/product/01-positioning.md` → 理解产品三主线
2. `docs/architecture/01-overview.md` → 理解三进程模型
3. `docs/modules/inventory.md` → 理解模块边界
4. 任务相关的 product / architecture 章节

### 2.2 优先级

按 my-spec §3：用户明确指令 > 项目内指令（本文件）> 项目 spec/contract（docs/）> 个人规范 > AI 默认行为。

### 2.3 提交约定

- Git 提交备注信息**不包含 Claude / AI 工具相关字样**（用户偏好）
- 涉及模块合同变化的提交，应在 commit message 引用受影响的 `MODULE.md` 路径

### 2.4 当前阶段

- 状态：代码已启动，M0 骨架已落地；后续版本功能持续迭代中。
- 当前真实阶段以 `docs/modules/inventory.md` 的最近变化、各模块 `MODULE.md`、任务相关 product / architecture spec 与 proposal 为准。
- 路线图仍参考 `docs/product/07-mvp-roadmap.md`，但执行判断必须结合已落地代码与最新模块清单。

### 2.5 常用验证入口

- 全量 Web 侧验证：`pnpm verify:web`
- 类型检查：`pnpm typecheck`
- Sidecar 单测：`pnpm test:sidecar`
- Web E2E：`pnpm test:e2e`
- 桌面壳 smoke：`pnpm verify:desktop` / `pnpm verify:desktop-ui`
- 真实 Provider 旅程：`pnpm verify:real`（需要本地凭据与网络条件）

## 3. 触发条件提醒

按 my-spec §7，下列场景**必须**执行对应动作：

- 任务涉及 ≥2 个模块 → 做特性到模块映射
- 改公共接口/状态归属/依赖方向/部署语义 → 写变更提案
- 改动触及模块合同 → 同步更新 MODULE.md + `docs/modules/inventory.md`
- 准备声称"已完成" → 按 L0–L5 验证层级证明

## 4. 语言

- 文档与产品文案：中文
- 代码、commit message、变量命名：英文
- AI 回复：中文（与用户语言一致）
