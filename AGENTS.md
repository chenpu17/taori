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
- 单模块合同 → 跟代码走，放 `apps/<name>/MODULE.md` 或 `packages/<name>/MODULE.md`（M0 初始化时建立）

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

- 状态：**M0 前**（仅产品 + 架构设计已完成，代码未启动）
- 下一步：M0 骨架（pnpm workspace + Tauri + Sidecar + Renderer 三方互通）
- 详见 `docs/product/07-mvp-roadmap.md`

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
