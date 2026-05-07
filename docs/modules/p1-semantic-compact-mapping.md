# P1 · Semantic Compact · 特性到模块映射

Status: draft  
Owner: Taori

## 1. 特性边界

- 语义压缩是当前会话上下文管理能力，不是长期记忆，也不是 RAG。
- 确定性压缩继续作为默认安全路径；语义压缩必须显式启用或用户确认。
- Sidecar 拥有压缩语义、预算、成本和 Timeline 真相；Renderer 不生成摘要。

## 2. 模块映射

| 模块 | 改动类型 | 职责 |
|---|---|---|
| `packages/shared` | contract | 扩展 recover request：`compact_mode`、`compact_model_id`、`compact_max_tokens`；新增 `context.compacted` event kind |
| `apps/sidecar/src/chat/recovery.ts` | behavior | 保留 deterministic compact 纯函数，输出 token/char metadata |
| `apps/sidecar/src/chat/semantic-compact.ts` | new collaboration | 选择摘要模型、构建摘要 prompt、预算守卫、调用模型、记录成本 |
| `apps/sidecar/src/chat/run-actions.ts` | orchestration | 在 recover compact path 中选择 deterministic/semantic，并处理 fallback |
| `apps/sidecar/src/cost/*` | guard | 语义压缩模型调用必须走统一预算硬上限 |
| `apps/sidecar/src/db/repos` | state | 复用 `cost_records` / `run_events`，不新增首版表 |
| `apps/web/src/App.tsx` | UX | 恢复卡增加语义压缩选项和成本确认 |
| `apps/web/src/Settings.tsx` | UX | 上下文压缩默认模式、本地优先、摘要模型、摘要 token 上限 |
| `apps/web` Timeline | UX | 展示 `context.compacted` 的压缩比例、模型、成本、回退 |

## 3. 状态归属

| 状态 | Owner | 说明 |
|---|---|---|
| compact mode | Sidecar request + settings | Renderer 可传入，Sidecar 校验并执行 |
| compact summary | Sidecar | 只作为本次上游 context，不写普通 user message |
| compact cost | Sidecar `cost_records` | 与原恢复生成成本分开记录 |
| compact visibility | Sidecar `run_events` | Timeline 从事件 payload 渲染 |

## 4. 验证责任

| 验证 | Owner | 通过标准 |
|---|---|---|
| Shared | `packages/shared` | schema/type build 通过 |
| Sidecar | `apps/sidecar` | compact 默认兼容、semantic 成本、硬预算、失败回退 |
| Web | `apps/web` | 恢复卡可选语义压缩，Timeline 可见压缩事件 |
