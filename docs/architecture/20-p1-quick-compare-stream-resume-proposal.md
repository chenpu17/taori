# 20 · P1 Quick Compare / Stream Resume 变更提案

Status: draft  
Owner: Taori  
Date: 2026-05-06  
Scope: Quick Compare / incomplete run resume / sidecar orchestration / renderer UX

## 1. 特性到模块映射

| 特性 | `packages/shared` | `apps/sidecar` | `apps/web` | 数据 |
|---|---|---|---|---|
| Quick Compare | 新增 request/annotation/result schema | 新增 compare route、模型选择、并行 chat fan-out、成本与 run event | Composer 对比入口、三列结果卡、采纳/重试/升级圆桌 | 新增 `quick_compare_runs` / `quick_compare_outputs` |
| 断流续接 | 扩展 run meta / resume policy schema | 明确 incomplete 查询、continue 复用、预算守卫、run linkage | stream 异常检测、自动/手动续接 UI、刷新后恢复入口 | 复用 `messages` / `run_events` / `cost_records`，可选新增 resume preference KV |

## 2. Quick Compare 架构

### 2.1 接口

新增：

```http
POST /v1/quick-compare
```

请求：

```ts
{
  conversation_id?: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  model_ids?: string[];        // 可选；不传则 Sidecar 自动选
  attachments?: ChatAttachment[];
  persona_id?: string | null;
  confirmed_cost?: boolean;
}
```

响应：AI SDK data-stream annotation 帧，承载 compare 事件。

```ts
type QuickCompareAnnotation =
  | { type: 'qc.meta'; compare_id: string; conversation_id: string; run_id: string; model_ids: string[] }
  | { type: 'qc.participant_start'; output_id: string; index: number; model_id: string }
  | { type: 'qc.participant_delta'; output_id: string; index: number; model_id: string; text_chunk: string }
  | { type: 'qc.participant_done'; output_id: string; index: number; model_id: string; content: string; cost_record_id: string }
  | { type: 'qc.participant_failed'; output_id: string; index: number; model_id: string; classification: string; message: string }
  | { type: 'qc.done'; compare_id: string; completed_output_ids: string[]; failed_output_ids: string[] };
```

新增：

```http
POST /v1/quick-compare/:id/outputs/:output_id/adopt
POST /v1/quick-compare/:id/outputs/:output_id/retry
GET  /v1/quick-compare/:id
```

采纳响应返回被创建或更新的 assistant message，并写 `quick_compare.adopted` run event。

### 2.2 数据模型

新增表：

```ts
quick_compare_runs {
  id: string;
  conversation_id: string;
  source_user_message_id: string | null;
  run_id: string;
  status: 'running' | 'completed' | 'partial_failed' | 'failed' | 'cancelled';
  model_ids: string;              // JSON string[]
  adopted_output_id: string | null;
  created_at: number;
  updated_at: number;
}

quick_compare_outputs {
  id: string;
  compare_id: string;
  participant_index: number;
  model_id: string;
  provider_id: string | null;
  content: string;
  status: 'streaming' | 'complete' | 'failed' | 'cancelled';
  error_classification: string | null;
  cost_record_id: string | null;
  first_token_ms: number | null;
  duration_ms: number | null;
  created_at: number;
  updated_at: number;
}
```

约束：

- `quick_compare_outputs(compare_id, participant_index)` 唯一。
- `adopted_output_id` 最多一个；再次采纳会替换当前正式 assistant message 或要求用户确认。
- 未采纳 output 不进入普通 `messages` 上下文。

### 2.3 Sidecar 编排

Quick Compare 不复用 roundtable 生命周期表，但复用以下能力：

- 模型过滤与健康状态：`ModelsRepo`、provider key status、failure classification。
- 成本：`budget-guard` 先估算 2-3 次调用总成本；每个 output 完成后写 `cost_records(feature='quick_compare', source_type='quick_compare_output')`。
- 上下文：复用 `prepareChatRequest` / `buildProduceCtx` 的 persona、memory、attachment、context-window 逻辑。
- 流式：抽一个通用 `fanOutChatStreams` helper，让 roundtable participant 与 quick compare 都能并行消费 OpenAI-compatible stream，但各自持久化到不同 repo。

失败策略：

- 单 participant 失败只标记该 output failed。
- 全部失败时 compare run failed，并给出 recovery suggestion。
- quota/rate_limit/network 计入模型健康；content_filter 不计入。

### 2.4 Run Timeline

新增 event kind：

- `quick_compare.started`
- `quick_compare.participant_started`
- `quick_compare.participant_completed`
- `quick_compare.participant_failed`
- `quick_compare.adopted`
- `quick_compare.completed`

payload 只保存 ids、模型、耗时、成本 id，不保存重复长文本。

## 3. Stream Resume 架构

### 3.1 当前基础

现有基础已经具备：

- `messages.status='incomplete'` 可表达中断 assistant。
- `/v1/runs/:id/continue` 可从 incomplete message 续写。
- `run_events` 已记录 `parent_run_id`、`continued_from_message_id`。
- `budget-guard` 已覆盖 continue/recover。

缺口：

- `/v1/chat` meta annotation 当前未携带 `run_id`，Renderer 很难可靠绑定当前 stream 与 continue target。
- Renderer 对 fetch/SSE 异常结束后的自动确认、轮询和续接策略还不完整。
- 历史加载后缺少统一的 incomplete resume banner。

### 3.2 接口与合同

扩展 `/v1/chat` meta annotation：

```ts
{ type: 'meta'; conversation_id: string; message_id: string | null; model_id: string | null; run_id: string }
```

新增只读查询：

```http
GET /v1/runs/:id/resume-state
```

返回：

```ts
{
  ok: true;
  data: {
    run_id: string;
    conversation_id: string;
    assistant_message_id: string | null;
    message_status: 'streaming' | 'incomplete' | 'complete' | 'failed' | null;
    can_continue: boolean;
    recommended_action: 'continue' | 'retry' | 'switch_model' | 'none';
    reason: string | null;
  };
}
```

说明：

- Renderer 在 stream 异常结束后先查 `resume-state`，不直接猜测。
- 历史会话加载时可根据 `messages.status='incomplete'` 和 run events 反查最近 run。

### 3.3 自动续接策略

新增 KV preference：

- `stream_auto_resume_enabled`: `'true' | 'false'`，默认 `'false'`。

前端状态机：

1. 收到 `meta.run_id` 后记录当前 in-flight run。
2. 如果 fetch rejected、连接 close 且未收到 finish frame，进入 `checking_resume`。
3. 调用 `/v1/runs/:id/resume-state`。
4. 若 `can_continue=false`，显示失败/已完成状态。
5. 若 `can_continue=true`：
   - 自动续接开启：调用 `/v1/runs/:id/continue`。
   - 自动续接关闭：显示“继续生成 / 换模型续接 / 保留当前内容”。
6. 如果 continue 返回 `cost_confirmation_required` 且 hard budget blocked，停止自动续接并打开预算提示。

### 3.4 成本与状态

- 原 run 如果 abort，cost record 写 `success=false` 或 actual null；保留已生成文本。
- 续接 run 写独立 cost record，payload 包含 `parent_run_id`。
- UI 以“同一回复链”呈现 parent/child assistant message，避免用户看到两条割裂回复。
- 续接成功不修改原 incomplete message 的 status；它作为历史事实保留。最终链路状态由 child message 完成来表达。

## 4. 开发顺序

1. Shared：补 Quick Compare schema、meta.run_id、resume-state schema、RunEventKind。
2. Sidecar：扩展 chat meta `run_id`，新增 `/v1/runs/:id/resume-state`。
3. Web：stream 异常检测 + 手动续接 banner + 历史 incomplete banner。
4. Sidecar：新增 quick compare repo/table、route 和 fan-out helper。
5. Web：Composer 对比入口、QuickCompareCard、采纳动作。
6. Cost/Timeline：quick compare 成本聚合、Timeline 展示。
7. E2E：覆盖断流后手动续接、自动续接被硬预算阻断、Quick Compare 单列失败不阻断。

## 5. 风险与约束

- Quick Compare 会放大成本，必须在 fan-out 前做总预算估算，并在 UI 明确展示预计成本。
- 多路流式并行不能共享一个 `ProduceCtx` 的可变状态；需要 per participant ctx。
- 自动续接不能无限循环；同一 parent run 最多自动续接一次，后续改为手动提示。
- SSE 断开不等于上游失败；Sidecar 状态是唯一真相。
- 采纳前不要污染普通 chat context，否则 Quick Compare 会降低后续回答稳定性。

## 6. 验证计划

- Sidecar unit:
  - model picking 不足 3 个模型时可降级。
  - hard budget 超限时 Quick Compare 不发起任何 participant 调用。
  - resume-state 对 streaming/incomplete/complete/failed 返回正确建议。
- Web E2E:
  - Composer 对比入口生成 3 列，单列失败不影响其他列。
  - 采纳某列后后续普通聊天只携带采纳内容。
  - 中断后刷新页面仍显示续接入口。
  - 自动续接遇到硬预算阻断不会绕过。
- Type gates:
  - `pnpm build:shared`
  - `pnpm --filter @taori/sidecar typecheck`
  - `pnpm --filter @taori/web typecheck`

