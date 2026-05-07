# 22 · P1 Semantic Compact 变更提案

Status: draft  
Owner: Taori  
Scope: chat recovery / context window / budget guard / Run Timeline / settings

## 1. 当前基线

已有 `compact_context` 路径：

- `packages/shared`：`RecoverRunRequestSchema.action` 支持 `compact_context`。
- `apps/sidecar/src/chat/recovery.ts`：`buildCompactedRecoveryMessages` 做确定性摘要，保留源用户消息之后的最近上下文。
- `apps/sidecar/src/chat/run-actions.ts`：恢复动作中选择 deterministic compact 后再进入普通 chat producer。
- `run_events`：恢复事件 payload 已记录压缩消息数与摘要长度。

问题：

- 摘要是按消息截断拼接，信息密度有限。
- 没有区分确定性压缩和模型语义压缩。
- 没有摘要模型、预算、成本、压缩比例、回退状态的完整 Timeline 表达。

## 2. 新接口

扩展 recover request：

```ts
type RecoverRunRequest = {
  action:
    | 'continue'
    | 'retry_same_model'
    | 'switch_model'
    | 'skip_tool'
    | 'compact_context';
  model_id?: string;
  skip_tool_name?: string;
  compact_mode?: 'deterministic' | 'semantic';
  compact_model_id?: string;
  compact_max_tokens?: number;
  confirmed_cost?: boolean;
};
```

默认：

- `compact_mode` 缺省为 `deterministic`。
- `compact_model_id` 缺省由 Sidecar 自动选择低成本 chat 模型；本地优先设置开启时只在本地 provider 中选。
- `compact_max_tokens` 默认 800，上限 2000。

## 3. Sidecar 流程

1. `prepareRecoverRun` 识别 `compact_context`。
2. 若 `compact_mode='deterministic'`，继续走 `buildCompactedRecoveryMessages`。
3. 若 `compact_mode='semantic'`：
   - 收集 source user message 之前的较早历史。
   - 估算待压缩 tokens 与摘要 tokens。
   - 对 `compact_model_id` 执行统一预算守卫。
   - 调用低成本/本地 chat model 生成摘要。
   - 将摘要作为 system message 注入 recovery upstream context。
   - 写独立 cost record，`feature='semantic_compact'`，`source_type='run_event'`。
4. 如果语义压缩失败：
   - 不静默成功。
   - 若请求允许 fallback，则执行 deterministic compact，并在 Timeline 标记 `fallback_used=true`。
   - 否则返回可见错误。

## 4. 数据与事件

不新增首版业务表；压缩结果作为 run event payload 持久化。

新增/扩展 Run Event：

```ts
kind: 'context.compacted'
payload: {
  mode: 'deterministic' | 'semantic';
  source_message_count: number;
  source_token_estimate: number;
  summary_token_estimate: number;
  compression_ratio: number;
  summary_chars: number;
  compact_model_id?: string;
  compact_cost_record_id?: string;
  local_only: boolean;
  fallback_used: boolean;
  fallback_reason?: string;
}
```

恢复终态事件继续携带 compact metadata，但 Timeline 以 `context.compacted` 为主展示。

## 5. Web 改动

- 失败恢复卡：
  - “压缩上下文后重试”默认仍用确定性压缩。
  - 增加“语义压缩后重试”入口，触发前展示成本确认。
- 设置页：
  - 新增上下文压缩设置：默认模式、摘要模型、本地优先、最大摘要 token。
- Run Timeline：
  - `context.compacted` 显示模式、压缩比例、摘要模型、成本、回退原因。

## 6. 模块边界

- `packages/shared` 拥有请求 schema 与 run event kind。
- `apps/sidecar/src/chat/recovery.ts` 拥有确定性 compact 纯函数。
- `apps/sidecar/src/chat/semantic-compact.ts` 拥有模型摘要 prompt、预算守卫、生成与 cost record。
- `apps/web` 只展示选项与事件，不在前端生成摘要。

## 7. 验证

- Shared build：新 schema/event kind 编译通过。
- Sidecar unit：
  - deterministic 默认路径兼容。
  - semantic compact 写 cost record 与 `context.compacted`。
  - 硬预算阻断语义压缩。
  - 语义失败可见或按配置回退 deterministic。
- Web E2E：
  - 用户从失败卡选择语义压缩，看到确认与 Timeline 压缩事件。
