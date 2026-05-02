# QA & 测试策略（v0.8 + 真实用户旅程）

> 我（Tauri 桌面壳）目前无法在自动化里直接驱动，所以本仓库的质量保证依赖四层：sidecar 单元测试 / web 端 Playwright 端到端 / 真实 Provider 用户旅程 smoke / 用户手动 Tauri 烟测。本文是入口与"覆盖什么 / 没覆盖什么 / 怎么补"的索引。

## 1. 测试金字塔

```
                ┌──────────────────────────────────────┐
                │  Tauri smoke (人工 Playbook)          │  ← apps/desktop / 多窗口 / 系统集成
                ├──────────────────────────────────────┤
                │  Real provider journey smoke          │  ← pnpm verify:real，不 mock、不清库
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
- 当前状态：**105 用例全绿**
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
- 当前状态：**72/72 全绿**

### 3.1 覆盖矩阵

| 关注点 | 主要 spec | 备注 |
|---|---|---|
| 启动 / 路由 / Onboarding | `m0-smoke`、`m1.6-settings`、`m2.5-volcengine-ark` | 含火山方舟 preset 可见 |
| 模型中心 (M2.5) | `m2.5-modelcenter`、`m1.6-settings`（model-center 段）、`r3.1-mc3-reorder`、`m1.8-dod-final` | tabs / 测试 / 删除 / 排序 / 默认切换 |
| 价格目录同步 | `m2.5-catalog-sync-ui`（UI）+ sidecar `m2-5-catalog-sync`（数据） | UI 烟测，diff 摘要 |
| 工具 / 图像 fast-path | `m2.4-image-gen` | 含意图正则、image picker |
| 圆桌（M3） | `m3a.4-roundtable-launch`、`m3a.5-roundtable-panel` | 三角色 mock LLM |
| 错误 / fallback / 降级 | `r5-demoted-badge`、`r5-user-journey`、`r6-error-matrix`、`r6-fallback-persist` | 5 strikes → demoted |
| 成本 | `r6-model-combo`、`r7-rapid-switch` | per-model cost rows |
| 中断 / 流控 | `r7-abort-resume`、`r7-rapid-switch` | 切流 / 重试 |

### 3.2 Mock LLM 策略

Roundtable + chat 测试统一用 `_mock-openai-server.ts`：按 system prompt 关键词路由，支持 `streamDelayMs` / `fixedReply` 注入。**新增功能时优先复用此 mock**，避免再造网络层。

## 4. Tauri 桌面端（人工 Playbook）

仍未自动化。改动后请按 `docs/product/11-m2.5-spec.md §9.2` Playbook 跑一遍：ModelCenter 打开 → 添加 Provider → 火山方舟可见 → 导入模型 → 同步价格 → 画机器人 fast-path → 普通 chat 看 CostBadge → Settings 仅剩 AutoFallback / Reopen / Danger Zone。

## 5. 真实 Provider 用户旅程 smoke

- 跑法：先启动 `pnpm dev`，确认 `apps/web/.env.local` 已写入当前 Sidecar endpoint，然后执行 `pnpm verify:real`。
- 输出：截图与事件 JSON 写入 `/tmp/taori-real-journey-<run_id>/`；失败时写 `failure.json`，包含缺失 Provider / Model / Tool 能力。
- 数据边界：脚本只使用真实浏览器操作前端；不会调用 `clear-all-data`、不会删除 Provider / Model / Conversation，也不会输出 API Key。
- 前置能力：至少需要一个启用且 Key 可用的 `supports_tools=true` 聊天/多模态模型，一个启用的 image 模型，一个启用的视觉聊天/多模态模型，并启用 `builtin.image_generate`、`builtin.web_fetch`、`builtin.web_search`。
- 覆盖旅程：多供应商模型标签可见 → 自然语言画图走 LLM tool call 而非 picker → 生成图持久化 → 生成图回流视觉理解 → 连续对话中触发 `web_fetch` / `web_search` → 流式停止 smoke → 刷新后图像仍可见。
- 失败解释：该层用于发现真实供应商、真实网络与 UI 组合问题；远端模型不按工具调用、API 额度不足、DuckDuckGo 网络失败都应作为真实验收风险记录，而不是 mock 通过。

## 6. 验证矩阵

| 层级 | 命令 / 入口 | 主要价值 | 不能证明 |
|---|---|---|---|
| L1 Sidecar unit | `pnpm test:sidecar` | 路由、repo、provider adapter、工具实现、错误分类 | 前端交互、真实远端模型行为 |
| L2 Web E2E mock | `pnpm test:e2e` | UI 状态机、回归路径、可控错误/慢流/圆桌流程 | 真 API key、真实模型工具遵循度、外网连通性 |
| L3 Real provider smoke | `pnpm verify:real` | 多供应商、多模型、多工具连续用户旅程 | Tauri OS 集成、全量视觉回归 |
| L4 Tauri manual | `docs/product/11-m2.5-spec.md §9.2` | 桌面壳、进程托管、系统集成 | 可重复自动回归 |

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
- 真正的远端 LLM provider 连通性与工具遵循度以**真 API key + `pnpm verify:real`**验证；mock E2E 不能替代这一层
- 视觉回归未引入；`verify:real` 会留截图，但仍需要人工判断复杂配色 / 滚动 / 遮挡问题
