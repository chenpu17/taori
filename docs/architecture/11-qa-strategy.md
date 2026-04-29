# QA & 测试策略（v0.7 + M2.5）

> 我（Tauri 桌面壳）目前无法在自动化里直接驱动，所以本仓库的质量保证依赖三层金字塔：sidecar 单元测试 / web 端 Playwright 端到端 / 用户手动 Tauri 烟测。本文是入口与"覆盖什么 / 没覆盖什么 / 怎么补"的索引。

## 1. 测试金字塔

```
                ┌──────────────────────────────┐
                │  Tauri smoke (人工 Playbook)  │  ← apps/desktop / 多窗口 / 系统集成
                ├──────────────────────────────┤
                │   Web E2E (Playwright, 72/72) │  ← apps/web/e2e/*.spec.ts
                ├──────────────────────────────┤
                │  Sidecar unit (vitest, 105+) │  ← apps/sidecar/test/*.test.ts
                └──────────────────────────────┘
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

## 5. 何时新增哪一层

| 改动类型 | 必加测试 |
|---|---|
| 新 capability / provider 适配器 | sidecar unit + （可选）e2e mock |
| 新 HTTP 路由 | sidecar unit |
| 新 UI 表面 / 新 testid | Playwright e2e |
| 新工具（capability-bus builtin） | sidecar unit + 至少一个 e2e 触发链路 |
| 修 bug | 复现的回归用例（sidecar 或 e2e） |

## 6. 限制与已知盲区

- Tauri IPC / 单实例 / 系统托盘 / 托盘菜单等能力**未自动化**，依赖人工 Playbook
- 真正的远端 LLM provider（OpenRouter / Ark）的连通性以**真 API key + sidecar smoke**验证（`pnpm test:sidecar` 中的 catalog-sync 部分会在 `OPENROUTER_API_KEY` 存在时拉真 catalog）
- 视觉回归未引入；UI 改样式时手动比对
