# Taori

> *Taori weaves many models into one continuous flow.*
> 把多个模型，织成一条不断的工作流。

**Taori** 是一个面向"多模型重度用户"的桌面 AI 助手。

它不是又一个 ChatGPT 壳子——它的核心价值是：**当你同时使用多个 AI 模型时，让你的工作不再因为某个模型挂掉、变慢、太贵或不合适而中断。**

## 三条产品主线

| 主线 | 一句话 |
|---|---|
| 🛟 **失败兜底** | 模型挂了、慢了、限流了、效果差了，助手帮你换路继续干 |
| 💰 **成本透明** | 调用前预估、调用中实时、调用后聚合，BYOK 用户的"安全感" |
| 🎭 **多模型圆桌** | 重要决策时，多个模型帮你形成共识 / 分歧 / 决策 |

## 目标用户

已经同时使用多个 AI 模型、愿意自带 Key、经常切模型、对成本/质量/稳定性敏感的**多模型重度用户**。

## 形态

- **桌面应用**（macOS / Windows / Linux）—— Tauri + React + Node.js Sidecar
- **完全 BYOK**（Bring Your Own Key）—— 你的 Key、你的对话历史、你的成本，都在本机
- **OpenRouter 一键接入**：一个 Key 即可使用数百个模型
- **不依赖任何 Taori 自有云服务**

## 当前状态

🚧 **设计阶段（M0 前）** —— 产品与技术架构设计已定稿，代码尚未启动。

文档体系：
- 📘 [产品设计](./docs/product/) — 定位、功能、三主线专题、关键决策、M1 详细规格
- 🛠 [技术架构](./docs/architecture/) — 三进程模型、IPC、数据与存储、安全、构建、API 合同
- 📦 [模块清单](./docs/modules/inventory.md) — 灰盒治理视角

完整索引见 [`docs/README.md`](./docs/README.md)。

## 路线图

| 版本 | 一句话目标 |
|---|---|
| **M0** | 三进程互通骨架（Tauri + Sidecar + Renderer，hello-world 级 SSE 跑通） |
| **M1** | 配好模型就能稳定聊天，看得见花了多少钱（[详细规格](./docs/product/08-m1-spec.md)） |
| **M2** | 模型挂了/不合适时不卡住，跨能力调用顺畅，成本始终在视野里（含内置工具） |
| **M3** | 重要决策时，多个模型帮你形成结构化结论（圆桌）+ 接入用户自有 MCP 工具 |

## 协作与治理

本项目遵循 [my-spec 灰盒治理框架](file:///Users/chenpu/workspace/claude-code/my-spec/AI开发操作规范.md)。AI 协作约定见 [`AGENTS.md`](./AGENTS.md)。

## 命名

**Taori** /taːori/（"塔奥里"）—— 取自"weave"（织）的意象：把多个 AI 模型像丝线一样编织成一条不断的工作流。

## License

TBD（M1 发布前确定）
