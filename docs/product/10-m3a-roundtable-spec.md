# 10 · M3.A 多模型圆桌实施 Spec

> 配套：[05 · 多模型圆桌](./05-roundtable.md)、[架构 04](../architecture/04-data-and-storage.md#圆桌自动角色生成元-prompt)、[架构 08](../architecture/08-api-contracts.md) §10 M3、[架构 09](../architecture/09-agent-and-tools.md) §8。
> 本文档为 M3 第一条线（圆桌）的可落地施工清单；M3.B（MCP 桥）见后续 spec。

## 1. 范围与不做

### 范围

- 圆桌实例的生命周期：启动 → 角色生成 → 一/多轮发言 → 总结 → 完成
- 两种模式：**快速（fast）** = 一轮独立观点 + 自动总结；**深度（deep）** = 第一轮盲审 + 第二轮互见反驳 + 总结
- 自动角色生成（Topic Analyzer）+ 降级到固定 3 角色
- 结构化总结（共识 / 分歧 / 风险 / 决策 / 下一步）+ Markdown 导出
- 成本：每次调用写 `cost_records`（`feature='roundtable'`，`source_type ∈ {topic_analyzer, roundtable_message, summarizer}`），UI 显示运行中累积金额与最终明细
- 失败：复用 M2 的 `classifyProviderError` + 失败决策（圆桌内单参与者失败 → 该列降级提示，不阻塞其他列；连续失败的参与者按 M2 兜底进入降权/禁用）
- 单 participant 重试：`PUT /v1/roundtable/:id/round/:round/participant/:index/retry`，仅替换该列的 `roundtable_messages` 内容（不允许换模型）

### 不做

- 圆桌内工具调用（架构 09 §8 描述的"participants 调用 Bus 工具"为 M3 全集；**M3.A 显式不接入** participant 工具调用，待 M3.B 完成 MCP 后统一开启）
- 流式互见（深度模式第二轮在第一轮**完成后**触发，不做边生成边互见）
- 用户手动调整参与模型 / 单列换模型重试（高级选项推迟到 v2）
- 三轮及以上（仅快速 1 轮 / 深度 2 轮）
- 全轮原地重试（>=2/3 失败时只提示用户重新启动新圆桌）

## 2. 数据模型增量（基于 M1 已建表）

无新表（schema 在 M1 已 `roundtables` / `roundtable_messages`）。补充约束与默认：

- `roundtables.status` 取值收敛为 `'analyzing' | 'round1' | 'round2' | 'summarizing' | 'completed' | 'failed'`
- `roundtables.participants` JSON 形状：
  ```ts
  Array<{ model_id: string; role_label: string; persona_prompt: string; display_name: string }>
  ```
- `roundtables.summary` JSON 形状（成功）：
  ```ts
  {
    consensus: string[];
    divergence: Array<{ topic: string; positions: Array<{ role: string; stance: string }> }>;
    risks: string[];
    recommended_decision: string;
    next_steps: string[];
  }
  ```
  失败/降级时 `summary = { fallback: true, raw_text: string }`
- `roundtable_messages.visible_to_others`：M3.A 简化 = round 1 全部 `true`（深度模式第二轮要看到）；round 2 不参与下一轮，置 `true` 即可（无下一轮）
- `cost_records.source_type` 新增**实际写入**：`'topic_analyzer'` / `'roundtable_message'` / `'summarizer'`（schema 已预留，M3.A 起开始写）

## 3. Sidecar 路由（M3 §10）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/v1/roundtable` | POST | 创建圆桌；body: `{ conversation_id, topic, mode?: 'fast'|'deep'|'auto' }`；同步执行**阶段 A**（topic analyzer）；返回 `{ id, mode, participants, estimated_cost_usd_range }` |
| `/v1/roundtable/:id/round` | POST + SSE | 触发第 N 轮（N = `current_round + 1`）；并行 fan-out 到所有 participants，SSE 多路复用 |
| `/v1/roundtable/:id/summarize` | POST + SSE | 触发总结；非流式，但用 SSE 是为了与 round 路径一致（最终一条 `summary_done`） |
| `/v1/roundtable/:id/export` | GET | 返回 `text/markdown`；模板见 §3.4 |
| `/v1/roundtable/:id` | GET | 读详情（恢复 UI 用） |

### 3.4 Export Markdown 模板（解决 R0-Issue#7）

```markdown
# 圆桌讨论：{topic}

**模式：** {fast/深度} | **创建时间：** {ISO local} | **总成本：** ${total_usd}

## 参与者

1. **{role_label_1}** - {display_name_1} (`{model_id_1}`)
2. **{role_label_2}** - {display_name_2} (`{model_id_2}`)
...

---

## 第一轮发言

### {role_label_1} ({display_name_1})
{round1_content_1}

### {role_label_2} ({display_name_2})
{round1_content_2}

{若 round 2 存在:}
---

## 第二轮发言（互见反驳）

### ...

---

## 总结

### ✅ 共识
- {consensus_1}
- {consensus_2}

### ⚠️ 分歧
- **{divergence[0].topic}**
  - {role}: {stance}

### 🚨 风险
- {risk_1}

### 🎯 推荐决策
{recommended_decision}

### 📋 下一步
1. {next_step_1}
2. {next_step_2}

---

## 成本明细

| 阶段 | 模型 | 调用 | 成本 |
|---|---|---|---|
| 话题分析 | {analyzer_model} | 1 | ${...} |
| 第 1 轮 | {p1_model} | 1 | ${...} |
| ... | ... | ... | ... |
| 总结 | {summarizer_model} | 1 | ${...} |
| **总计** | | {N} | **${total_usd}** |
```

> 失败/降级总结：`summary.fallback=true` 时只输出 `## 总结（自动总结失败）` + `fallback_text`，省略结构化小节。

### 3.1 SSE 事件（统一走 Vercel AI SDK annotation 通道）

**决策（解决 R0-Issue#1）**：圆桌的所有事件**不使用自定义 SSE 事件名**，而是统一通过 Vercel AI SDK data-stream 的 **annotation 帧**（`8:[{...}]`）承载，与 M2 的 `failure_decision` / `capability_route` 注解完全一致。理由：
- Renderer 复用 useChat / `failureFetch` 的 tee 逻辑，无需额外 EventSource
- Sidecar 端可继续用 `streamText({ ... })`；多 participant 并行时**每路一个 streamText**，把各自 part 帧前缀混入同一 SSE 响应（按 `participant_index` 区分）
- 与现有 cost-confirm / failure_decision 流统一调试体验

`/v1/roundtable/:id/round` 与 `/summarize` 流出的 annotation 类型：

```ts
type RoundtableAnnotation =
  | { type: 'rt.round_start'; round: number; participants_total: number }
  | { type: 'rt.participant_delta'; participant_index: number; model_id: string; text_chunk: string }
  | { type: 'rt.participant_done'; participant_index: number; model_id: string; content: string; cost_record_id: string }
  | { type: 'rt.participant_failed'; participant_index: number; model_id: string; classification: string; message: string }
  | { type: 'rt.round_done'; round: number; completed_indices: number[]; failed_indices: number[] }
  | { type: 'rt.summary_delta'; text_chunk: string }
  | { type: 'rt.summary_done'; summary: object; cost_record_id: string }
  | { type: 'rt.summary_failed'; classification: string; message: string; fallback_text: string };
```

> **注意**：annotation 帧的 `text_chunk` 是为了让 UI 流式渲染；Renderer 在收到 `rt.participant_done` 后用其 `content` 字段作为该列的最终值（`text_chunk` 累计可能因网络重连不完整）。

### 3.2 错误约定

- 单 participant 失败：发 `rt.participant_failed`；该列在 UI 上展示分类徽章 + 重试按钮；其他列继续
- 全员失败（>=2/3 或 >=3/4）：圆桌 `status='failed'`，UI 提示"参与者全部失败，建议换模型重新启动"（不提供原地全轮重试）
- analyzer 失败 → 自动降级固定 3 角色（见 §4.1.1）；记录 `roundtables.summary` 留空，`participants` 直接写降级结果
- summarizer 失败 → `rt.summary_failed`；UI 提示，提供"重试 / 用 fallback_text 兜底"
- 失败计数：圆桌内每个参与者的 provider_error 与单聊天一样累计 `failure_count_24h`（content_filter 不计入），与 M2 兜底机制一致

### 3.3 单列重试路由

```
PUT /v1/roundtable/:id/round/:round/participant/:index/retry
```

行为：
- 仅重新执行该 participant（其他列保持不变）
- 数据：`UPDATE roundtable_messages SET content=<新>, created_at=<新> WHERE id=<原记录id>`（不新增行，避免历史里有两条同 round/index）
- 成本：仍写一条新的 `cost_records`（feature='roundtable', source_type='roundtable_message', source_id=该消息 id）
- 失败计数：仍 +=1（与首次调用同等对待）
- UI：不允许换模型；连续失败 ≥3 次则该列禁用重试按钮，建议用户重新启动圆桌

## 4. 核心算法

### 4.1 Topic Analyzer（阶段 A）

调用便宜调度模型（用户在 settings 配 `roundtable_analyzer_model`；默认 = 第一个标记 `family='haiku'|'gpt-4o-mini'|'gemini-flash'` 的可用模型；都没有则回退到第一个 enabled chat 模型）。

输入 prompt 严格用架构 04 §"圆桌自动角色生成元 Prompt"模板。

**校验**：返回必须用 Zod schema 强校验（structured output 或 JSON repair 兜底）。校验失败 → 走降级（§4.1.1）。

**成本**：写一条 `cost_records.source_type='topic_analyzer'`、`source_id=roundtable.id`、`feature='roundtable'`。

#### 4.1.1 降级路径（固定 3 角色）

固定 persona 文本以独立模块 `apps/sidecar/src/roundtable/fallback-personas.ts` 维护：

```ts
export const FALLBACK_PERSONAS = [
  { role_label: '综合视角', persona_prompt: '你是一位全局分析专家，关注整体平衡、可行性与价值取舍。请从大局出发，给出综合建议。' },
  { role_label: '批判视角', persona_prompt: '你是一位风险识别专家，专注找出潜在问题、漏洞与反对意见。请直接指出方案中的风险。' },
  { role_label: '实践视角', persona_prompt: '你是一位执行专家，关注具体可落地的步骤、资源与时间。请给出可执行的下一步。' },
];
```

模型选择逻辑（伪代码）：

```ts
function buildFallbackParticipants(enabledChatModels: Model[]): Participant[] {
  const available = enabledChatModels
    .filter(m => !m.disabled_until && !isDemoted(m))
    .sort((a, b) => (a.fallback_order ?? 0) - (b.fallback_order ?? 0));
  if (available.length === 0) throw httpError(409, 'no_available_chat_models');
  return FALLBACK_PERSONAS.map((p, i) => {
    const m = available[i % available.length];  // 不足 3 个时复用，允许同模型扮演多角色
    return { model_id: m.id, display_name: m.display_name, ...p };
  });
}
```

降级时的 summarizer 选择：取用户默认 chat 模型（或 available[0]）。降级路径下 `roundtables.participants` 直接写入降级结果，UI 不区分（用户视角无感知）。

### 4.2 轮发言（阶段 B）

- **快速模式**：仅 round 1，每个 participant 独立调用（不互见）；round 1 完成后**自动**触发 summarize
- **深度模式**：round 1 完成后等待用户点"再来一轮"或"总结结束"；round 2 时把 round 1 的所有发言拼入 system prompt（按架构 04 §阶段 B）
- 单条发言 max_tokens 约束：300 字 ≈ 600 tokens；用 `maxTokens: 800` 兜底
- 每条 `roundtable_messages` 写一条；每条调用写一条 `cost_records.source_type='roundtable_message'`、`source_id=roundtable_messages.id`
- 并行：同一轮的所有 participant **并行 fan-out**；SSE 通过 `participant_index` 区分

### 4.3 总结（阶段 C）

调用 `summarizer_model_id`（来自 analyzer 推荐，或用户默认）；prompt 严格用架构 04 §阶段 C 模板，要求 JSON 输出。

**Zod 强校验**；失败 → 一次重试（temperature=0.3 → 0.1）；仍失败 → `summary_failed` + `fallback_text = 拼接所有发言 + "请用户手动总结"`。

写 `cost_records.source_type='summarizer'`、`source_id=roundtable.id`。

### 4.4 成本预估

`POST /v1/roundtable` 返回的 `estimated_cost_usd_range`：

```
low  = estimate(analyzer, ~600 input) + sum(estimate(participant, 800 input, 600 output)) + estimate(summarizer, fullhist_input, 800 output)
high = low * 1.6
```

UI 在 mode picker 上展示 `~$low–$high`。

## 5. Renderer UI

### 5.1 入口

- 聊天界面输入框旁加 "🔍 圆桌" 按钮（M3.A 上线后才显示；M2 隐藏）
- 点击 → 弹出**圆桌启动对话框**：
  - 话题（必填，从输入框预填）
  - 模式选择（快速 / 深度 / 自动；默认自动 = 让 analyzer 决定）
  - 显示 analyzer 推荐的参与者预览（在用户点"开始"后才调用 analyzer，先显示 loading）
  - **预估成本范围**（analyzer 完成后展示）
  - 阈值确认（圆桌专用偏好，见下）

#### 5.1.1 圆桌专用 cost-confirm 偏好（解决 R0-Issue#3）

圆桌不复用 M2 的 `cost_confirm_disabled_models`（圆桌组合动态变化，model 维度命中无意义）。新增**圆桌专用偏好键**（写入 `memories(scope='global')`）：

| key | 默认值 | 含义 |
|---|---|---|
| `cost_confirm_roundtable_threshold_usd` | `0.10` | 预估成本超过此值则弹 confirm |
| `cost_confirm_roundtable_always` | `'true'` | 始终弹 confirm（与阈值取或） |
| `cost_confirm_disabled_conversations` | （沿用 M2） | 用户在某 conversation 勾选"本会话不再提醒"时写入 |

圆桌 cost-confirm 决策（`shouldConfirmRoundtable(estimated_cost_usd_low)`）：

```
1. 若 estimated_cost_usd_low > threshold OR roundtable_always=true → 候选 = true
2. 若 conversation_id ∈ disabled_conversations → false
3. 否则按候选返回
```

"不再提醒"勾选框**只影响** `cost_confirm_roundtable_always`（设为 false）；不污染 `disabled_models`。

### 5.2 圆桌主面板（替换聊天主区，conversation 内嵌）

```
┌─ 话题：xxx · 模式：🔍 深度 · 已花 $0.04 ─────────────┐
│ 参与者：[战略 GPT-4o] [用户 Claude] [技术 Gemini]      │
├──────────┬──────────┬──────────────────────────┤
│ 战略     │ 用户     │ 技术                      │
│ R1: ...  │ R1: ...  │ R1: ⚠️ rate_limit [重试]  │
│ R2: ...  │ R2: ...  │ R2: ...                   │
└──────────┴──────────┴──────────────────────────┘
[再来一轮 / 总结结束 / 取消]
```

完成后底部出现**结论卡**（共识 / 分歧 / 风险 / 推荐决策 / 下一步）+ 成本明细 + [📋 导出 Markdown]。

#### 5.2.1 交互状态机（解决 R0-Issue#4）

```
快速模式：
  round_done(1) → 自动触发 summarize（无按钮，无用户决策点）

深度模式：
  round_done(1) → 显示 [📝 总结结束] [➕ 再来一轮] [取消] 三按钮
    - "总结结束" → 基于仅 round 1 触发 summarizer（无 round 2）
    - "再来一轮" → 触发 round 2（自动注入 round 1 内容到 prompt，相当于"互见"）
    - "取消" → 圆桌 status='cancelled'（不再可继续，但已生成内容保留）
  round_done(2) → 自动触发 summarize（基于 round 1+2，无按钮）
```

> 产品 05-roundtable.md 提到的 "👁 已开互见" 按钮在 M3.A 不实现：深度模式 round 2 本质就是"互见"，独立按钮会让用户困惑（"互见之后还要不要点再来一轮"）。

#### 5.2.2 单列重试 UI

- 失败列展示 `分类徽章 + 错误简述 + [重试] 按钮`
- 点击 [重试] → `PUT /v1/roundtable/:id/round/:round/participant/:index/retry` → SSE 流回 `rt.participant_delta` / `rt.participant_done` / `rt.participant_failed`（`participant_index` 即该列）
- 该列连续失败 ≥3 次：[重试] 按钮置灰 + 文案 "建议重新启动圆桌"

### 5.3 状态恢复

- 进入 conversation 时，若末尾消息有 `roundtable_id` 关联，加载圆桌面板而非聊天气泡
- 刷新页面后调用 `GET /v1/roundtable/:id` 恢复

## 6. 测试清单

### 6.1 sidecar vitest

- analyzer Zod 严格校验：JSON 不合法 → 走降级（固定 3 角色，从 fallback-personas.ts 取）
- analyzer 模型选择：用户未配 → 取 family=haiku|mini|flash 中第一个 enabled；都不存在 → 第一个 enabled chat 模型
- 降级时 enabled chat 模型不足 3 个 → 同模型轮流分配（`available[i % len]`）
- 降级时 enabled chat 模型为 0 → 抛 `409 no_available_chat_models`
- 快速模式 round 1 完成自动触发 summarize（annotation 序列断言：`rt.round_done(1)` 后立即出现 `rt.summary_*`）
- 深度模式 round 2 prompt 注入 round 1 内容（断言 messages 数组包含 round1 全部 participant 的内容）
- 深度模式仅 round 1 后调用 `/summarize`：summarizer 输入只含 round 1（不含 round 2）
- 单 participant 失败：其他 participant 仍 `rt.participant_done`；roundtable 不进 failed
- 全员失败：roundtable.status='failed'
- summarizer Zod 校验失败 + 一次重试（temperature 降为 0.1）+ fallback_text
- 三个 cost_records.source_type 都被写入（analyzer / roundtable_message / summarizer），`feature='roundtable'`
- `cost_records` 圆桌相关行 `source_type='roundtable_message'` 时 `source_id` 指向 `roundtable_messages.id`（FK 一致性，应用层校验）
- export markdown 包含话题/参与者/全部 round/summary/成本明细表（按 §3.4 模板逐节断言）
- export 在 `summary.fallback=true` 时退化到 fallback 输出
- 单列重试路由：原 `roundtable_messages` 行被 update（不新增），新 cost_records 写入
- failure_count_24h：rate_limit 计入；content_filter 不计入（与 M2 兜底一致）
- 圆桌成本预估 `estimated_cost_usd_range`：low/high 区间正确（high = low * 1.6）

### 6.2 Playwright e2e

- 端到端快速模式：输入话题 → 启动 → 看到 3 列 → 自动总结 → 看到结论卡 → 导出
- 端到端深度模式（完整 2 轮）：round 1 → 点"再来一轮" → round 2 → 自动总结
- 深度模式 early exit：round 1 完成 → 点"总结结束"（不点"再来一轮"）→ 看到基于 round 1 的结论卡
- 单参与者失败重试：mock 一个 model 在 round 1 返 rate_limit → 重试按钮 → 成功
- cost-confirm 阈值触发：预估 > 0.10 → 弹 confirm；勾"不再提醒" → 下次同 conversation 不弹
- `disabled_conversations` 命中：圆桌跳过 confirm
- 预估成本展示：启动对话框 → 等待 analyzer → 断言 "~$x.xx–$y.yy" 文案出现
- 状态恢复：刷新后圆桌面板正确还原（含已结束的结论卡 + 进行中的 round）

## 7. DoD（用户视角 8 步）

1. 用户在聊天输入"如何选 SaaS 计费模型？" → 点 🔍 圆桌
2. 启动对话框：话题预填，模式默认"自动"，loading 状态调用 analyzer
3. analyzer 返回：3 个参与者（战略/用户/技术）+ 推荐"深度"+ 预估 `~$0.06–0.12`
4. 用户点"开始"→ confirm 阈值未触发 → round 1 三列并行流式
5. round 1 完成 → 用户点"再来一轮"→ round 2 三列流式（注入 round 1 内容）
6. 用户点"总结结束"→ summary 流出 → 显示结论卡 + 成本明细 `$0.0834`
7. 用户点"导出 Markdown"→ 下载 `roundtable_<id>.md`
8. 刷新页面 → 圆桌面板原样恢复

## 8. 实施分阶段

| Phase | 内容 | 主要交付 |
|---|---|---|
| M3.A.0 | spec R0（subagent 评审 + 修复） | 本文档定稿 |
| M3.A.1 | sidecar：analyzer + roundtable 创建 + GET 详情 | `/v1/roundtable` POST/GET、参与者降级路径 |
| M3.A.2 | sidecar：round 执行（fan-out + SSE） | `/v1/roundtable/:id/round`、单失败隔离 |
| M3.A.3 | sidecar：summarizer + export | `/v1/roundtable/:id/{summarize,export}` |
| M3.A.4 | renderer：启动对话框 + cost confirm | UI 入口 + analyzer 预览 + 阈值 |
| M3.A.5 | renderer：圆桌面板 + 流式渲染 + 状态恢复 | 多列 UI、重试、导出按钮 |
| M3.A.6 | DoD e2e + 用户视角全链路审核 | 全部 vitest + Playwright 绿、subagent 二次评审 |
