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

## 它更适合什么人

- 你已经在用 DeepSeek / OpenRouter / 硅基流动 / 火山方舟 / 华为 MaaS / Ollama 等多个来源
- 你不想把工作流绑死在单个模型、单个网关或单个“聊天壳子”里
- 你希望**知道每次调用花了多少钱、为什么失败、下一步该换什么模型**
- 你偶尔会遇到“重要问题想让多个模型一起给意见”的场景

## 形态

- **桌面应用**（macOS / Windows / Linux）—— Tauri + React + Node.js Sidecar
- **完全 BYOK**（Bring Your Own Key）—— 你的 Key、你的对话历史、你的成本，都在本机
- **OpenRouter 一键接入**：一个 Key 即可使用数百个模型
- **不依赖任何 Taori 自有云服务**

## 当前状态

✅ **Browser-first 发布候选** —— WebUI + Sidecar 主链路已实现并有回归验证；Desktop 壳与系统 Keychain 体验继续作为 follow-up 演进。

当前已可验证的能力：

- 多轮聊天、模型切换、停止与续写
- Model Center、成本看板、Run Timeline、Help Center
- Prompt 模板与 Persona（含会话级绑定与内置 `OpenClaw 行动派助手`）
- Quick Compare、失败恢复、多模型圆桌

发布证据与已知风险见 [`docs/product/15-browser-first-release-candidate.md`](./docs/product/15-browser-first-release-candidate.md)。

## 为什么有人会选 Taori，而不是别的 AI 客户端

| 你更在意什么 | Taori | Cherry Studio | LobeChat |
|---|---|---|---|
| **中文 BYOK + 国内 provider 直连** | **强**：火山 / 华为 / 硅基 / DeepSeek / PackyAPI / Ollama 等是一等公民 | 更偏全能聚合 hub | 更偏通用 Web 平台 / 自托管 |
| **成本透明** | **强**：调用前预估、调用中实时、调用后聚合，预算/阈值可见 | 有成本概念，但不是主轴 | 有使用能力，但不是主定位 |
| **模型挂了还能继续做事** | **强**：失败恢复、降权、重试、切模型都可见 | 侧重功能广度 | 侧重平台与插件扩展 |
| **多模型并行做决策** | **强**：Quick Compare + 圆桌 + Workflow Recipe | 有多模型能力 | 更强调插件/Agent 生态 |
| **生态/插件数量** | 还在早期 | **强** | **强** |

一句话：

- **如果你要的是“中文 BYOK 多模型工作台”**，Taori 更对路。
- **如果你要的是“成熟的大而全 AI hub / 插件生态”**，Cherry Studio / LobeChat 更成熟。

## 快速开始

### 推荐方式：直接体验完整 Taori（当前最完整）

如果你想体验当前最完整的 Taori 交互界面（模型中心、成本面板、Quick Compare、多模型圆桌、控制中心等），目前推荐使用 browser-first 方式：

```bash
git clone https://github.com/chenpu17/taori.git
cd taori
pnpm install
pnpm dev
```

启动后会同时拉起：

- WebUI：`http://127.0.0.1:5173`
- Sidecar：`http://127.0.0.1:17890`

第一次使用建议这样走：

1. 打开 `http://127.0.0.1:5173`
2. 按 Onboarding 添加你的 Provider / API Key
3. 选择一个默认聊天模型
4. 开始聊天，或直接试试 **Quick Compare / 圆桌 / 模板市场**

适合谁：

- 想直接体验 Taori 当前完整功能界面
- 想管理自己的 Provider / Model / Cost / Roundtable / Tool
- 想在本机用 BYOK 方式长期使用

### 进阶方式：通过 npm 安装本地运行时

如果你只想先在本机启动一个 **Taori standalone sidecar**，用于本地 API、自动化集成或自己的前端接入，可以直接安装 npm 包：

```bash
npm install -g @chenpu17/taori
```

启动：

```bash
taori --port 17890
```

启动后：

- Sidecar 默认监听 `http://127.0.0.1:17890`
- 默认数据库路径为 `~/.taori/taori.db`
- 可通过 `GET /health` 做探活检查

例如：

```bash
curl http://127.0.0.1:17890/health
```

常用参数：

```bash
taori --help
taori --port 18901
taori --db-path ~/.taori/my-taori.db
```

> 当前 npm 包提供的是 **Taori 本地 sidecar 运行时**。
> 如果你想体验完整产品界面，请优先使用上面的 **browser-first** 方式。

### 现在最适合怎么选

- **想体验当前最完整的产品界面**：用 **`pnpm dev` 启动 WebUI + Sidecar**
- **只想快速装起来一个本地运行时**：用 **npm 安装**

## 更多信息

- 📘 [产品设计](./docs/product/) — 定位、功能、差异化策略、路线演进
- 🛠 [技术架构](./docs/architecture/) — 三进程模型、IPC、数据与存储、安全、API 合同
- 📦 [模块清单](./docs/modules/inventory.md) — 灰盒治理视角
- 📚 [`docs/README.md`](./docs/README.md) — 文档总索引

## 开发者

如果你是来参与开发，而不是作为最终用户使用：

- `pnpm dev`：启动本地浏览器开发模式（WebUI + Sidecar）
- `pnpm verify:web`：跑通 typecheck、sidecar tests 与 Playwright E2E
- `pnpm verify:browser-rc`：Browser-first 发布前主门禁
- `pnpm verify:real:report`：只读取最近一次真实 Provider 验证产物，不发起 live 调用

## 命名

**Taori** /taːori/（"塔奥里"）—— 取自"weave"（织）的意象：把多个 AI 模型像丝线一样编织成一条不断的工作流。

## License

TBD（M1 发布前确定）
