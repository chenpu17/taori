# P1 · Quick Compare / Stream Resume · 特性到模块映射

Status: draft  
Owner: Taori  
Date: 2026-05-06

## 1. 特性边界

- Quick Compare 是轻量三模型并行回答，不进入完整 roundtable analyzer/round/summarizer 生命周期。
- Stream Resume 是 incomplete run 的恢复体验增强，不做字节级 SSE replay。
- Sidecar 拥有业务状态真相；Renderer 只展示和触发动作。

## 2. 模块映射

| 模块 | 改动类型 | 职责 |
|---|---|---|
| `packages/shared` | contract | Quick Compare request/annotation/result schema；resume-state schema；`RunEventKind` 增加 quick_compare 与 resume 相关事件；chat meta 增加 `run_id` |
| `apps/sidecar/src/routes/chat.ts` | contract + state | `/v1/chat` meta 输出 `run_id`；新增 `/v1/runs/:id/resume-state`；continue 保持预算守卫与 run linkage |
| `apps/sidecar/src/chat/*` | collaboration | 抽出可复用 stream producer/finalizer/fan-out helper；保持 persona、memory、context-window、tool policy 一致 |
| `apps/sidecar/src/routes/quick-compare.ts` | new capability | 创建 compare run，选择模型，并行调用，输出 data-stream annotations，处理采纳/重试 |
| `apps/sidecar/src/db/*` | state | 新增 quick compare runs/outputs 表与 repo；不把未采纳输出写入普通 messages |
| `apps/sidecar/src/cost/*` | guard | fan-out 前做总成本预算判断；每个 output 写独立 cost record |
| `apps/web/src/App.tsx` | UX | Composer 对比入口、stream 异常检测、resume banner、QuickCompareCard、采纳动作 |
| `apps/web/src/api.ts` | contract consumer | Quick Compare / resume-state API client |
| `apps/web/e2e/*` | verification | 覆盖 Quick Compare、单列失败、采纳、断流后续接、硬预算阻断 |
| `docs/product` / `docs/architecture` | governance | 记录产品行为、接口、状态归属、暂缓范围和验收标准 |

## 3. 状态归属

| 状态 | Owner | 说明 |
|---|---|---|
| compare run status | `apps/sidecar` | `running/completed/partial_failed/failed/cancelled` |
| compare output status | `apps/sidecar` | 每个 participant 独立完成、失败、重试 |
| adopted output | `apps/sidecar` | 至多一个 output 被提升为普通 assistant message |
| incomplete message | `apps/sidecar` | `messages.status='incomplete'` 是续接入口真相 |
| auto-resume preference | `apps/sidecar` KV | Renderer 读取并展示，不硬编码默认 |
| visible compare panel state | `apps/web` | 展示状态，可由 Sidecar 查询恢复 |

## 4. 依赖方向

- `apps/web` → `apps/sidecar`：发起 compare、采纳、查询 resume-state、触发 continue。
- `apps/sidecar` → `packages/shared`：使用共享 schema 校验请求和 annotation 类型。
- `apps/sidecar/routes/quick-compare` → `apps/sidecar/chat`：复用聊天上下文构建和流式 producer，不反向依赖 roundtable UI。
- `apps/sidecar/cost` → `apps/sidecar/db`：预算读取和成本记录继续集中在 sidecar。

## 5. 验证责任

| 验证 | Owner | 通过标准 |
|---|---|---|
| Shared build | `packages/shared` | 新 schema/type 编译通过 |
| Sidecar unit | `apps/sidecar` | compare 模型选择、预算阻断、resume-state 状态机、采纳写消息 |
| Web E2E | `apps/web` | 用户可启动对比、采纳、断流续接；失败和预算提示可见 |
| Browser RC | scripts | 较大实现后执行 `pnpm verify:browser-rc` 刷新证据 |

