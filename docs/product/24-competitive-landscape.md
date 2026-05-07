# 竞品分析与下阶段战略

Status: draft
Owner: Chenpu
Date: 2026-05-07
Scope: 全产品定位 + 下阶段方向锚点
Sources: 产品 01–05、架构 01、产品 02 第二阶段扩展、本文 §3 联网调研结果

> 本文是**下阶段方向的正式锚点**。所有「短/中/长」backlog 的去留都要回到本文校验：是否服务于「中文 BYOK 用户的多模型决策助手」这条窄道，是否落在三支柱里。

## 1. Taori 自我画像

### 1.1 当前定位

来自 `docs/product/01-positioning.md`：

> BYOK 多模型重度用户的桌面工作编排助手；三主线 = **失败兜底 / 成本透明 / 多模型圆桌**。

### 1.2 已落地能力（截至 v0.0.5）

- **三进程架构**：Tauri Rust 外壳 + Node Sidecar 编排 + Web Renderer，浏览器/桌面双形态共用一份 Sidecar
- **Provider 矩阵**：DeepSeek、火山方舟、华为 MaaS、SiliconFlow、PackyAPI、Ollama 本地（7 个国内/本地 provider 直连，**不依赖 OpenRouter 类网关**）
- **失败兜底**：渐进式 demoted/disabled_until + content_filter 豁免；Quick Compare / 圆桌 / Chat 路径统一 skip demoted
- **成本透明**：`cost_records` 表（含 classification / first_token_ms / duration_ms）、月度预算 + soft/hard limit、单次调用阈值确认、阅读预算
- **多模型并行**：Quick Compare（已并行化、保留工具调用）、圆桌（结构化结论 + 模板）、Workflow Recipes
- **Capability Bus**：内置工具（file_read / file_search / web_fetch / web_search / image_generate）+ MCP 桥
- **UX 资产**：命令面板 / 控制中心 / 后端进程资源监控 / Help Center / Persona / Prompt 模板 / 主题切换 / 可发现 tip
- **分发**：`@chenpu17/taori` 已发到 npm（v0.0.5），`taori --port` 一行启动浏览器形态

### 1.3 当前体量信号

- 单 npm 包发布、单作者维护、零社区聚势
- 桌面 Tauri 打包尚未走通 / 公开下载链路待建
- 文档体系完整（产品 01–22、架构 01–09、my-spec 灰盒治理）

## 2. 业界竞品速览

按定位分群（联网调研 2025-05，引用见 §6）：

| 群体 | 代表 | 核心打法 | 与 Taori 的关系 |
|---|---|---|---|
| 全能桌面 Hub | **Cherry Studio**（39K★ AGPL）、**LobeChat**（60K★+ 自托管 Web，10000+ 插件） | 50+ provider、MCP、知识库 RAG、插件市场、agent group | 直接竞品，规模碾压；Cherry Studio 已是事实标准 |
| 本地优先 | **Jan**、**LM Studio**、**AnythingLLM**、**Open WebUI** | 本地模型一等公民、文档 RAG、隐私 air-gap | Taori 仅 Ollama 接入，本地能力相对薄 |
| 付费精品桌面 | **TypingMind**（$39–99 终身）、**BoltAI**（$59 Mac 原生）、**Msty**（split chat） | 一次买断 BYOK、UX 高完成度、个人/团队 | 商业化路径参考，但用户群偏海外 |
| Side-by-side 对比 | **ChatHub**（30 万用户浏览器扩展）、**Msty split chat**、**TypingMind multi-model** | 多模型同屏对比 | Taori Quick Compare 同类，但**带工具调用是少数** |
| 多模型 Roundtable / Council | **AISCouncil**、**LLM Council**（Karpathy）、**Consilium**、**Kraken Kouncil** | 投票 / 仲裁 / Mixture-of-Agents | Taori 圆桌方向已被多家盯上，但落地形态分散 |
| Provider 网关 | **OpenRouter**（300+ models 单一 API、自动 fallback、实时计费、失败不收费） | 一个 Key 通吃 + 路由 | Taori 走 BYOK 直连国内 provider，是差异路线 |
| 企业成本观测 | **Helicone / Binadox / Geekflare Connect / Oriveo / TokenRouter** | token 级 dashboard、预算告警、路由优化 | 主要面向 dev/ops，桌面端尚有空白 |

## 3. 差异化态势

### 3.1 我们已有、别人少有的

1. **国内 provider 直连一等公民**：火山方舟 / 华为 MaaS / SiliconFlow / DeepSeek / PackyAPI 全部独立适配。Cherry/LobeChat 多走 OpenAI 兼容端点，国内合规与计费精度上不如直连。**这是中文区天然护城河。**
2. **Quick Compare 并行 + 工具调用**：ChatHub / Msty / TypingMind 的 side-by-side 都是**纯文本对比**，不带 Tool / MCP；Taori 在并行链路里保留 Capability Bus，是真正可用的「多模型 + 多工具同屏比赛」。
3. **失败兜底 = 用户级状态机**：渐进降权 + content_filter 豁免 + UI 可见 demoted 标记。竞品要么"挂了就报错"，要么"网关静默切换"（OpenRouter）。Taori 把"为什么换 / 还能不能用"暴露给用户。
4. **三进程隔离 + Sidecar 浏览器复用**：`taori --port` 让同一份 Sidecar 既是桌面也是浏览器入口；Cherry/Msty 桌面专属，LobeChat 自托管偏服务器，**Taori 是"个人用户能随手起的本地服务"**。

### 3.2 我们落后的

1. **生态势能**：Cherry 39K★ / LobeChat 60K★+ / Open WebUI 100K★+，社区效应已经形成，Taori 0★ 起步。
2. **知识库 / RAG**：Cherry / LobeChat / AnythingLLM 都内置文档 RAG，Taori 还没有（文档 chunks/FTS 已就位但未上 vector）。
3. **插件 / 模板市场**：LobeChat 10000+ 插件，Cherry 300+ Persona；Taori 只有内置 Persona，无市场。
4. **本地模型深度**：Jan / LM Studio 把模型管理做成产品，Taori 只是接 Ollama。
5. **品牌识别度**：竞品都在做 YouTube 评测、SEO、博客；Taori 还没有任何对外内容。

## 4. 战略：找一条能防得住的窄道

> 全能聚合 hub 已经是红海（Cherry 占住），本地优先纯私域（Jan/LM Studio）也已成型。Taori 不该正面拼"模型最多 / 插件最多"。

### 4.1 推荐主定位

**「面向中文 BYOK 用户的多模型决策助手」**

一句话产品宣言：

> 国内多家 provider 一键并跑，看得见每一分钱、扛得住每一次挂、关键决策上多模型给你结论。

### 4.2 三支柱

#### 支柱 1 ── 中文 BYOK 操作系统级体验（短期）

- 国内 provider SDK 一等公民：把火山/华为/硅基/DeepSeek 的 quirks（限速、思考模型、合规返回码、配额回执）做到比官方控制台还顺
- 成本透明做到 Helicone 级别桌面化：实时 token 计费 / 月度+每日预算 / 项目维度归因 / 导出报表
- 失败兜底可视化：把 demoted/disabled_until 做成"模型健康仪表盘"，进一步把 retry / 换模型决策开放给用户配置
- **Why moat**：海外项目不会做国内 provider 深度接入；国内项目（如 OpenAssistant 类）通常是单 provider；Taori 三主线天然咬合这个场景

#### 支柱 2 ── 多模型决策工作流（中期）

- 把"圆桌"从一次性会议升级为可保存的 Decision Pipeline：模板化 → 可分享 → 可对比历史决策
- Quick Compare + Tool 是别人没有的：扩展成「同题多模型 + 同题多工具栈」对照实验台
- Mixture-of-Agents / 仲裁模式：参考 AISCouncil 的 council/debate/MoA，但比它们更聚焦"日常工作里的关键决策"
- **Why moat**：CrewAI/AutoGen 是开发者框架，不是用户产品；AISCouncil/LLM Council 是 demo 形态；Taori 把它做成"日常用的决策工具"

#### 支柱 3 ── MCP 一等公民 + 桌面 OS 集成（长期）

- MCP 工具市场的桌面入口：本地 stdio / 127.0.0.1 HTTP 全栈支持已在路线图，要做成"装一个 MCP 像装 Chrome 扩展那么自然"
- 桌面专属能力：全局快捷键、剪贴板自动捕获、文件拖拽、截图问答、菜单栏常驻
- 可审计 / 可离线 / 可自部署：留住未来的小团队/工作室客户，作为商业化口子

### 4.3 不做清单

- 不抄 LobeChat 插件市场（生态没追到，上来做市场是空集）
- 不再多接海外 provider（OpenAI/Claude 兼容但不深做，OpenRouter 一个集成顶 50 个）
- 不做团队/SSO/RBAC（个人用户先打透）

## 5. 落地 Backlog（按"差异化收益 ÷ 实现成本"排序）

> 每条都要能回答："这件事服务于哪个支柱？为什么是 P0/P1/P2？"

### P0 ─ 短期（当前批次）

| ID | 事项 | 支柱 | 说明 |
|---|---|---|---|
| P0-1 | **模型健康红绿灯墙** | 支柱 1 | 把 demoted / disabled_until 倒计时 / 24h 失败分类分布 / 平均首 token / 平均时长，集中成一面"红绿灯墙"。基础数据已具备（`/v1/models/health`），主要是 UI |
| P0-2 | **每日预算 + 70%/90% 阈值告警** | 支柱 1 | budget-guard 当前只有月度，扩 daily；前端在状态栏 + 控制中心成本卡呈现"日/月"双进度，并在 70% 黄、90% 红、100% 阻断处提示 |

### P1 ─ 近期（下一批次）

| ID | 事项 | 支柱 |
|---|---|---|
| P1-1 | Quick Compare 工具维度对照（每列可独立选 tool 集） | 支柱 2 |
| P1-2 | 圆桌结论可保存为模板 + 历史决策对比 | 支柱 2 |
| P1-3 | 项目（project/tag）维度的成本归因 + 报表导出 | 支柱 1 |
| P1-4 | 模型健康面板加"按 classification 失败趋势"折线 | 支柱 1 |

### P2 ─ 中期

| ID | 事项 | 支柱 |
|---|---|---|
| P2-1 | 文档 RAG 最小可用（追平基本盘） | 防守 |
| P2-2 | MCP 安装/管理 UI（本地 stdio 先行） | 支柱 3 |
| P2-3 | Mixture-of-Agents / 仲裁模式（圆桌进阶） | 支柱 2 |

### P3 ─ 长期

| ID | 事项 | 支柱 |
|---|---|---|
| P3-1 | 桌面打包 + 全局快捷键 + 菜单栏 | 支柱 3 |
| P3-2 | 截图/剪贴板自动捕获问答 | 支柱 3 |
| P3-3 | 决策模板市场（圆桌 / Workflow） | 支柱 2 |

### 内容/品牌（同样关键，零代码）

- README 加一张"为什么选 Taori：和 Cherry Studio / LobeChat 的关系"对比表（坦诚定位差异）
- 中文社区先行：少数派、即刻、知乎、V2EX 写"BYOK 国内 provider 实测"

## 6. 调研引用

- Cherry Studio：[GitHub](https://github.com/CherryHQ/cherry-studio) / [decisioncrafters review](https://www.decisioncrafters.com/cherry-studio-the-ultimate-desktop-client-for-multi-llm-development-and-ai-workflows/)
- LobeChat：[lobehub.com](https://lobehub.com/docs/usage/start) / [aicoolies review](https://aicoolies.com/reviews/lobechat-review)
- Msty / Jan / AnythingLLM：[DEV 2025 guide](https://dev.to/rosgluk/local-llm-hosting-complete-2025-guide-ollama-vllm-localai-jan-lm-studio-more-1dcl)
- TypingMind / BoltAI / Open WebUI：[perspectiveai 2026 alternatives](https://perspectiveai.xyz/typingmind-alternative-2026/)
- OpenRouter：[skywork review](https://skywork.ai/blog/openrouter-review-2025-api-gateway-latency-pricing/)、[deepreviewai](https://deepreviewai.com/reviews/2026-02-05_openrouter-review/)
- ChatHub：[chathub.gg](https://chathub.gg/)
- AISCouncil / LLM Council：[aiscouncil.com](https://www.aiscouncil.com/)、[karpathy/llm-council](https://github.com/karpathy/llm-council)、[Consilium @ HF](https://huggingface.co/blog/consilium-multi-llm)
- BYOK 成本观测：[Oriveo](https://oriveoai.com/) / [Geekflare Connect](https://geekflare.com/ai/connect/) / [Binadox](https://www.binadox.com/solutions/master-llm-costs-effortlessly-across-every-provider/)

## 7. 校验清单（每次新功能立项前问自己）

- [ ] 这件事归到三支柱中的哪一个？
- [ ] 是否落在「不做清单」里？如果是，是否有充分理由破例？
- [ ] 在国内 BYOK 中文用户场景下，比 Cherry Studio 更好的点是什么？说不出来就别做
- [ ] 是否同时给出可见性（让用户看见）？仅有后端逻辑的功能优先级永远低于"看得见"的功能
