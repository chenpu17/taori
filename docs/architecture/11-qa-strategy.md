# QA & 测试策略（v1.0 Agent Runtime）

当前优先级是 **Browser WebUI + Sidecar first**：先把浏览器访问下的完整产品逻辑做稳，再把 Tauri 桌面壳作为封装层验证。默认发布前主入口是 `pnpm verify:web`；桌面和显式 Keychain 验证不再阻塞 Web 产品主线。

## 1. 测试金字塔

```
                ┌──────────────────────────────────────┐
                │  Desktop packaging follow-up          │  ← opt-in，不阻塞 Web 主线
                ├──────────────────────────────────────┤
                │  Real provider browser smoke          │  ← pnpm verify:real，不 mock
                ├──────────────────────────────────────┤
                │  Web E2E (Playwright + Mock LLM)      │  ← apps/web/e2e/*.spec.ts
                ├──────────────────────────────────────┤
                │  Sidecar unit / integration (vitest)  │  ← apps/sidecar/test/*.test.ts
                └──────────────────────────────────────┘
```

## 2. Sidecar 单元（vitest）

- 位置：`apps/sidecar/test/`
- 目的：覆盖 capability-bus、provider 适配器、catalog 同步、定价归一、错误分类、fallback、降级阈值
- 跑法：`pnpm test:sidecar`
- 当前状态：2026-05-05 发布前回归中 **27 个测试文件 / 199 用例全绿**
- 关键样例：
  - `m2-5-catalog-sync.test.ts` — OpenRouter `/models` → DB 写回 + diff
  - `providers-registry.test.ts` — testProvider/discover/probe
  - `bus-tools.test.ts` — image_generate / video_generate（builtin tools）
  - `fallback-chain.test.ts` — 错误分类 → 自动降级

## 3. Web 端 E2E（Playwright + Mock LLM）

- 位置：`apps/web/e2e/`
- 启动方式：`pnpm dev:browser`（同时起 sidecar:17890 + vite:5173）后跑 `pnpm --filter @taori/web exec playwright test`
- Bearer 鉴权：`apps/web/.env.local` 的 `VITE_SIDECAR_BEARER`
- 共享设施：
  - `_helpers.ts` — `resetSidecar`/`seedDefaultModel`/`authedFetch`
  - `_mock-openai-server.ts` — 三角色智能 Mock OpenAI（监听 17891），按 system prompt 切换"圆桌主持/总结/工程负责人"等回复
- 当前状态：2026-05-05 全量 Web E2E **187 tests passed / 4.7m**；测试 sidecar 使用隔离 DB，web 工具在 E2E 中走 hermetic 响应，避免外网波动。
- 发布前主入口：`pnpm verify:web`，串行执行 `typecheck → test:sidecar → Web Playwright 全量`。

### 3.1 覆盖矩阵

| 关注点 | 主要 spec | 备注 |
|---|---|---|
| 启动 / 路由 / Onboarding | `m0-smoke`、`m1.6-settings`、`m2.5-volcengine-ark` | 含火山方舟 preset 可见 |
| 模型中心 (M2.5) | `m2.5-modelcenter`、`m1.6-settings`（model-center 段）、`r3.1-mc3-reorder`、`m1.8-dod-final` | tabs / 测试 / 删除 / 排序 / 默认切换 |
| 价格目录同步 | `m2.5-catalog-sync-ui`（UI）+ sidecar `m2-5-catalog-sync`（数据） | UI 烟测，diff 摘要 |
| 工具 / 图像 fast-path | `m2.4-image-gen` | 含意图正则、image picker |
| 圆桌（M3） | `m3a.4-roundtable-launch`、`m3a.5-roundtable-panel` | 三角色 mock LLM |
| Agent Runtime / Run Timeline | `run-timeline-user-journeys`、`c2-stop-continue` | chat/continue/recovery/roundtable 的用户可见运行过程 |
| 恢复动作 | `m2.1-failure-decision`、`m2.1-skip-tool-recovery` | `retry_same_model` / `switch_model` / `compact_context` / `skip_tool` 确认链路 |
| 错误 / fallback / 降级 | `r5-demoted-badge`、`r5-user-journey`、`r6-error-matrix`、`r6-fallback-persist` | 5 strikes → demoted |
| 成本 | `r6-model-combo`、`r7-rapid-switch` | per-model cost rows |
| 中断 / 流控 | `r7-abort-resume`、`r7-rapid-switch` | 切流 / 重试 |

### 3.2 Mock LLM 策略

Roundtable + chat 测试统一用 `_mock-openai-server.ts`：按 system prompt 关键词路由，支持 `streamDelayMs` / `fixedReply` 注入。**新增功能时优先复用此 mock**，避免再造网络层。

## 4. Tauri 桌面端（封装层 follow-up）

桌面层延后到 WebUI + Sidecar 主线稳定后验证。它证明桌面壳、control channel 和 WebView 封装不破坏主产品逻辑，但不作为浏览器 Web 产品的默认发布门槛。

- `pnpm verify:desktop`：默认只验证 Tauri 壳启动、Rust control channel、桌面 sidecar 和备份导入 API；不读取系统 Keychain、不发真实模型。
- `pnpm verify:desktop-ui`：通过 debug-only localhost automation channel 驱动真实 Tauri WebView，覆盖设置导入、侧边栏刷新、导入消息可见；默认不读取系统 Keychain、不发真实模型。

完整 Keychain / 真实桌面模型 smoke 必须显式 opt-in：

```bash
TAORI_DESKTOP_SMOKE_KEYCHAIN=1 TAORI_DESKTOP_SMOKE_REAL_CHAT=1 pnpm verify:desktop
```

该命令可能触发 macOS 钥匙串授权弹窗。系统菜单、托盘、多窗口等 OS 级交互仍依赖人工 Playbook。

## 5. 真实 Provider 用户旅程 smoke

- 跑法：先启动 `pnpm dev`，确认 `apps/web/.env.local` 已写入当前 Sidecar endpoint，然后执行 `pnpm verify:real`。
- 输出：截图与事件 JSON 写入 `/tmp/taori-real-journey-<run_id>/`；失败时写 `failure.json`，包含缺失 Provider / Model / Tool 能力。
- 数据边界：脚本只使用真实浏览器操作前端；不会调用 `clear-all-data`、不会删除 Provider / Model / Conversation，也不会输出 API Key。
- 前置能力：至少需要一个启用且 Key 可用的 `supports_tools=true` 聊天/多模态模型，一个启用的 image 模型，一个启用的视觉聊天/多模态模型，并启用 `builtin.image_generate`、`builtin.web_fetch`、`builtin.web_search`。
- 覆盖旅程：多供应商模型标签可见 → 自然语言画图走 LLM tool call 而非 picker → 生成图持久化 → 生成图回流视觉理解 → 连续对话中触发 `web_fetch` / `web_search` → 普通聊天 MCP 工具调用 → 上下文窗口 / compact_context 恢复 → 圆桌 Timeline → 工具健康 → 成本来源追踪 → 流式停止 smoke → 刷新后图像仍可见。
- 失败解释：该层用于发现真实供应商、真实网络与 UI 组合问题；远端模型不按工具调用、API 额度不足、DuckDuckGo 网络失败都应作为真实验收风险记录，而不是 mock 通过。

### 5.1 v1.0 Agent Runtime 真实模型剧本

v1.0 起，`pnpm verify:real` 必须增加 agent-runtime 覆盖项，不能只验证“能聊天”：

| 步骤 | 用户视角动作 | 必须证明 |
|---|---|---|
| 1 | 真实模型发送普通多轮问题 | 前端消息、成本栏、Run Timeline 同步更新 |
| 2 | 打开运行过程面板 | 能看到 `turn/model/cost` 事件，并按 run 分组 |
| 3 | 发送长回复并点击停止 | 消息标记为 incomplete，运行事件包含 `turn.stopped` |
| 4 | 刷新页面后回到会话 | 续写/继续解决入口仍存在，不依赖 Renderer 内存 |
| 5 | 点击续写 | 新 run 关联旧 incomplete run，timeline 可复盘 |
| 6 | 发送需要工具的问题 | 真实工具调用成功，或结构化记录“模型未遵循工具调用” |
| 7 | 从失败决策卡片触发恢复 | `skip_tool` 不新增 user message，`compact_context` 记录压缩摘要和省略消息 |
| 8 | 发起圆桌讨论并打开运行过程 | analyzer、participant、summarizer 事件按 `kind=roundtable` 可见 |
| 9 | 图像生成并回流视觉理解 | 生成文件持久化，视觉模型能读取并回答 |
| 10 | 打开成本看板 | 本次真实调用的模型/工具成本可追踪到 run |

失败时必须写入 `/tmp/taori-real-journey-<run_id>/failure.json`，至少包含：前置能力检查、当前 Provider/Model 摘要、最后可见 UI 状态、run events、cost calls 和截图路径。

## 6. 验证矩阵

| 层级 | 命令 / 入口 | 主要价值 | 不能证明 |
|---|---|---|---|
| L1 Sidecar unit | `pnpm test:sidecar` | 路由、repo、provider adapter、工具实现、错误分类 | 前端交互、真实远端模型行为 |
| L2 Web E2E mock | `pnpm test:e2e` | UI 状态机、回归路径、可控错误/慢流/圆桌流程 | 真 API key、真实模型工具遵循度、外网连通性 |
| L3 Browser release gate | `pnpm verify:web` | Browser WebUI + Sidecar 默认发布前主线 | 真实远端模型行为、Tauri OS 集成 |
| L4 Real provider browser smoke | `pnpm verify:real` | 多供应商、多模型、多工具连续用户旅程 | Tauri OS 集成、全量视觉回归 |
| L5 Desktop smoke | `pnpm verify:desktop` | 桌面壳启动、Rust control channel、桌面 sidecar、备份导入 API | 默认不读 Keychain、不发真实模型 |
| L6 Desktop UI smoke | `pnpm verify:desktop-ui` | 真实 Tauri WebView 点击、设置导入、侧边栏刷新、导入消息可见 | 默认不读 Keychain、不发真实模型 |
| L7 Keychain / real desktop smoke | `TAORI_DESKTOP_SMOKE_KEYCHAIN=1 TAORI_DESKTOP_SMOKE_REAL_CHAT=1 pnpm verify:desktop` | 系统 Keychain、真实桌面模型调用、Run Events 和成本入账 | 会触发系统钥匙串授权弹窗，需显式执行 |
| L8 Tauri manual | `docs/product/11-m2.5-spec.md §9.2` | 桌面窗口内人工验收、系统菜单/托盘等 OS 交互 | 可重复自动回归 |

### 6.1 v1.0 Agent Runtime 必跑子集

| 能力 | 最小验证 | 真实用户视角验证 |
|---|---|---|
| `agent_runs` Header / Timeline | `pnpm --filter @taori/sidecar test -- agent-runs.test.ts` | `run-timeline-user-journeys.spec.ts` |
| 停止 / 续写 | `agent-runs.test.ts` 的 continue 断言 | `c2-stop-continue.spec.ts` + `pnpm verify:real` 停止续写步骤 |
| 恢复动作 | `agent-runs.test.ts` 的 recover / compact / skip-tool 断言 | `m2.1-failure-decision.spec.ts`、`m2.1-skip-tool-recovery.spec.ts` |
| 圆桌 Timeline | `m3a-2-rounds.test.ts`、`m3a-3-summary-export.test.ts` | `run-timeline-user-journeys.spec.ts -g "roundtable discussion"` |
| 真实模型工具遵循度 | 不适用 mock 判定 | `pnpm verify:real`，失败时写 `failure.json` |
| 桌面 control channel | `pnpm verify:desktop` 的 `/health` | `pnpm verify:desktop-ui` 覆盖窗口点击 |
| 桌面 Keychain / 真实模型 | `TAORI_DESKTOP_SMOKE_KEYCHAIN=1 TAORI_DESKTOP_SMOKE_REAL_CHAT=1 pnpm verify:desktop` | 可能触发系统钥匙串弹窗，默认回归不执行 |

## 7. 何时新增哪一层

| 改动类型 | 必加测试 |
|---|---|
| 新 capability / provider 适配器 | sidecar unit + （可选）e2e mock |
| 新 HTTP 路由 | sidecar unit |
| 新 UI 表面 / 新 testid | Playwright e2e |
| 新工具（capability-bus builtin） | sidecar unit + 至少一个 e2e 触发链路；若依赖远端或外网，补 `verify:real` 场景 |
| 多供应商 / 多模型协同 | Web E2E mock + `verify:real` |
| 修 bug | 复现的回归用例（sidecar 或 e2e） |

## 8. 限制与已知盲区

- Tauri IPC / 单实例 / 系统托盘 / 托盘菜单等能力**未自动化**，依赖人工 Playbook
- `pnpm verify:desktop` 默认不读取系统钥匙串，避免 macOS 在 dev 二进制重编译后反复弹授权；Keychain / 真实模型验证必须显式 opt-in。
- `pnpm verify:desktop-ui` 使用 debug-only localhost automation channel 驱动真实 Tauri WebView；默认只验证 UI 路径，不读取 Keychain。
- Help Center 默认“运行自检”不读取系统钥匙串；只有用户显式点击“检查钥匙串”或请求 `GET /v1/selfcheck?include_keychain=1` 才执行 Keychain probe。
- Keychain 显式验证若卡在系统授权或条目缺失，应产出 artifact 并自动清理端口；control channel 的 Keychain 读/写/删有超时保护，不能让用户操作无限等待。
- 真正的远端 LLM provider 连通性与工具遵循度以**真 API key + `pnpm verify:real`**验证；mock E2E 不能替代这一层
- 视觉回归未引入；`verify:real` 会留截图，但仍需要人工判断复杂配色 / 滚动 / 遮挡问题
