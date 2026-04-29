# 04 · 数据与存储

> **R5 实现对齐说明。** 以代码 + 测试为准，本文与实际 schema 已知偏差：
> - **`files`：** `mime_type`（不是 `mime`）；`original_path`（不是 `storage_path`）；多了 `message_id` 外键；`filename` 字段不存在。
> - **`memories.scope`：** 实际枚举包含 `user`（除 `global` / `conversation`）。
> - **`messages.source_type`：** 实际枚举包含 `tool_call`（除 `chat` / `image_gen`）。
> - **`failure_kind`：** 实际枚举包含 `auth`（凭据/鉴权失败独立分类）。
> - **`conversations.archived`：** 默认 `false`；通过 `PATCH /v1/conversations/:id` 切换。
> - **`roundtables` / `roundtable_messages`（M3.A 实现新增字段）：** 见下方表定义；
>   `summarizer_model_id` / `analyzer_fallback` / `estimated_cost_usd_*` / `updated_at` 等
>   M3.A 阶段补齐的列已内联在本文 schema，与代码同步。

## SQLite Schema（Drizzle ORM，核心 9 张表）

> **类型层级说明：** 下表使用 **TypeScript/Drizzle 概念类型**（`text` / `integer` / `real` / `boolean`）描述。映射到 SQLite 实际存储类型（[storage classes](https://www.sqlite.org/datatype3.html)）时：`boolean` → `INTEGER`（0/1），`text` → `TEXT`，`integer` → `INTEGER`，`real` → `REAL`。所有时间戳为 Unix epoch 毫秒（`INTEGER`）。

```typescript
// 1. providers — Provider 配置（OpenRouter / OpenAI / 本地 Ollama 等）
providers {
  id: text PK
  name: text                    // "OpenRouter", "OpenAI Direct"
  type: text                    // 'openrouter' | 'openai' | 'anthropic' | 'ollama' | 'custom'
  base_url: text
  api_key_ref: text             // OS Keychain 中的引用键（不存明文）
  enabled: boolean
  created_at: integer
  updated_at: integer
}

// 2. models — 用户配置的可用模型
models {
  id: text PK NOT NULL                 // 不可变的内部 ID（nanoid 12，加前缀 'mdl_'）
  alias: text UNIQUE                   // 用户可见的短别名（如 'haiku-fast'），可改名
  provider_id: text FK NULL            // provider 删除时设 NULL（保留给 cost_records 归因）
  model_name: text NOT NULL            // provider 侧真实名，如 "openai/gpt-4o"
  capability: text NOT NULL            // 'chat' | 'image' | 'video' | 'embedding' | 'asr' | 'tts'
  display_name: text NOT NULL          // UI 展示名
  // 价格（USD per 1M tokens 或 per call）
  price_input_per_1m: real
  price_output_per_1m: real
  price_per_call: real                 // 图像/视频按次计费时使用
  price_currency: text                 // 'USD'
  // 元信息
  context_length: integer
  supports_vision: boolean
  supports_tools: boolean
  supports_json: boolean
  // 使用与状态
  is_default_for: text                 // 'chat' | 'image' | null
  fallback_order: integer              // 同 capability 内的备援顺序
  user_rating: integer                 // 1-5
  failure_count_24h: integer           // 滚动计数（content_filter 不计入）
  demoted: boolean                     // 失败 ≥3 次降权（UI 下移标灰）
  disabled_until: integer              // 失败 ≥5 次临时禁用截止时间
  enabled: boolean
  created_at: integer
  updated_at: integer
  // 唯一约束：UNIQUE(provider_id, model_name) — 同一 provider 不允许重复添加同一 model_name；
  // 但允许 provider_id IS NULL 时重名（被解绑的历史模型）。
}

// 3. conversations — 会话
conversations {
  id: text PK
  type: text                    // 'chat' | 'roundtable'
  title: text                   // 自动生成或用户命名
  created_at: integer
  updated_at: integer
  archived: boolean
}

// 4. messages — 普通聊天消息
messages {
  id: text PK NOT NULL                 // 'msg_' + nanoid(12)
  conversation_id: text FK NOT NULL    // 会话删除时级联删除消息
  role: text NOT NULL                  // 'user' | 'assistant' | 'system' | 'tool'
  content: text                        // 富文本/Markdown/JSON
  model_id: text FK NULL               // 模型物理删除时设 NULL
  parent_message_id: text NULL         // 用于工具调用关联
  attachments: text                    // JSON: Attachment[]，结构见下
  status: text NOT NULL                // 'pending' | 'streaming' | 'completed' | 'incomplete' | 'failed'
  error: text                          // 失败原因 JSON: { code, classification, message }
  created_at: integer NOT NULL
}

// Attachment JSON 形态（落 messages.attachments 字段）：
// {
//   file_id: string,        // 引用 files 表
//   type: 'image' | 'pdf' | 'text' | 'other',
//   mime: string,
//   filename: string,
//   size_bytes: integer
// }

// 5. files — 拖入文件的元数据（M1 引入）
files {
  id: text PK NOT NULL                 // 'file_' + nanoid(12)
  conversation_id: text FK NULL        // 关联会话；会话删除时设 NULL（避免误删盘上文件）
  storage_path: text NOT NULL          // 本地落盘绝对路径（应用数据目录下）
  mime: text NOT NULL
  filename: text NOT NULL              // 原始文件名（仅展示）
  size_bytes: integer NOT NULL
  preview_data: text NULL              // 可选：小图缩略图 base64（≤ 16KB）
  extracted_text: text NULL            // PDF/纯文本：抽取的文本内容
  created_at: integer NOT NULL
}

// 6. roundtables — 圆桌实例
roundtables {
  id: text PK
  conversation_id: text FK
  topic: text                          // 用户输入的话题
  mode: text                           // 'fast' | 'deep'
  participants: text                   // JSON: [{model_id, persona, role_label}]
  summarizer_model_id: text FK NULL    // 总结模型；模型删除 → SET NULL
  analyzer_fallback: integer           // boolean — 主题分析降级开关
  status: text                         // 'round1' | 'round2' | 'summarizing' | 'completed' | 'cancelled'
  current_round: integer
  summary: text NULL                   // 最终总结 JSON
  estimated_cost_usd_low: real NULL    // 启动前估价区间下界
  estimated_cost_usd_high: real NULL   // 启动前估价区间上界
  created_at: integer
  updated_at: integer
  completed_at: integer NULL
}
  // index: roundtables_conv_idx (conversation_id, created_at)

// 7. roundtable_messages — 圆桌每轮发言
roundtable_messages {
  id: text PK
  roundtable_id: text FK
  round: integer                       // 1, 2, ...
  participant_index: integer           // 第几列
  model_id: text FK NULL               // 模型删除 → SET NULL
  content: text NOT NULL DEFAULT ''
  status: text NOT NULL DEFAULT 'pending'  // 'pending' | 'streaming' | 'completed' | 'failed'
  classification: text NULL            // 失败分类（与 chat 共用枚举）
  error_message: text NULL
  visible_to_others: boolean
  created_at: integer
  updated_at: integer
}
  // index: roundtable_messages_rt_idx (roundtable_id, round, participant_index)
  // unique: roundtable_messages_uniq (roundtable_id, round, participant_index)

// 8. cost_records — 成本记录（每次 LLM 调用都写一条）
cost_records {
  id: text PK NOT NULL                 // 'cost_' + nanoid(12)
  conversation_id: text FK NULL        // 会话删除时设 NULL（保留账单历史）
  // 来源：用 type+id 替代单一 FK，避免无法同时关联两类消息表
  source_type: text NOT NULL           // 'message' | 'roundtable_message' | 'topic_analyzer' | 'summarizer'
  source_id: text                      // 对应表的主键；可为空（如系统级调度调用）
  feature: text NOT NULL               // 'chat' | 'roundtable' | 'image' | 'tool_call'
  model_id: text FK NULL               // 模型删除时设 NULL，但仍保留 model_name 快照
  model_name_snapshot: text NOT NULL   // 模型物理标识快照，便于事后归因
  // 用量
  input_tokens: integer
  output_tokens: integer
  call_count: integer                  // 通常为 1，图像生成可能 N
  // 价格快照（防止后续价格调整失真）
  price_input_per_1m_snapshot: real
  price_output_per_1m_snapshot: real
  price_per_call_snapshot: real
  // 金额
  estimated_cost_usd: real             // 调用前的预估
  actual_cost_usd: real NULL           // 调用后的实际；失败/上游未返回 usage 时为空
  // 状态
  success: boolean NOT NULL
  duration_ms: integer
  created_at: integer NOT NULL
}

// 9. memories — 用户偏好与记忆
memories {
  id: text PK
  scope: text                   // 'session' | 'global'
  scope_id: text                // session_id 或 null（global）
  key: text                     // 如 'image_model_default', 'roundtable_summarizer'
  value: text                   // JSON
  created_at: integer
  updated_at: integer
}
```

## 索引策略

- `messages.conversation_id` + `created_at`（会话翻页）
- `cost_records.created_at`（时段聚合）
- `cost_records.conversation_id`（会话级聚合）
- `cost_records.model_id` + `created_at`（按模型聚合）
- `cost_records.source_type` + `source_id`（按来源回溯）
- `files.conversation_id`（会话内文件查询）
- `memories.scope` + `scope_id` + `key`（偏好查找）

## 删除/可空性策略汇总

| 表 | FK 字段 | 删除上游时行为 |
|---|---|---|
| `messages.conversation_id` | conversations | **CASCADE** —— 会话删除则消息删除 |
| `messages.model_id` | models | **SET NULL** —— 保留消息内容，模型归因丢失 |
| `cost_records.conversation_id` | conversations | **SET NULL** —— 保留账单 |
| `cost_records.model_id` | models | **SET NULL** —— 同上；model_name_snapshot 保住归因 |
| `cost_records.source_type/source_id` | messages / roundtable_messages | **不级联**——逻辑外键，应用层维护 |
| `files.conversation_id` | conversations | **SET NULL** —— 避免误删盘上文件 |
| `roundtables.conversation_id` | conversations | **CASCADE** |
| `roundtable_messages.roundtable_id` | roundtables | **CASCADE** |
| `models.provider_id` | providers | **SET NULL** + `enabled=false`（保留模型定义供历史归因） |

## 关键聚合查询（成本仪表盘用）

```sql
-- 本会话总成本
SELECT SUM(actual_cost_usd) FROM cost_records WHERE conversation_id = ?;

-- 今日总成本 + 按模型分组
SELECT model_id, SUM(actual_cost_usd) FROM cost_records
WHERE created_at >= ?  -- 今日 0 点
GROUP BY model_id;

-- 本月按功能聚合
SELECT feature, SUM(actual_cost_usd) FROM cost_records
WHERE created_at >= ?  -- 本月 1 号
GROUP BY feature;
```

---

## 圆桌"自动角色生成"元 Prompt

两阶段实现，让"谁参与、什么角色"成为一次显式 LLM 调用，可观测、可审计、可缓存。

### 阶段 A：话题分析（Topic Analyzer）

调用一次便宜模型（如 Haiku / GPT-4o-mini），用结构化输出（Zod schema）：

```
你是一个"圆桌主持人"。用户提出了一个话题，请分析它：

【话题】{user_topic}

【可用聊天模型】
- {model_id_1}: {display_name_1}, 擅长 {strengths_1}
- {model_id_2}: {display_name_2}, 擅长 {strengths_2}
- ...

请输出 JSON：
{
  "topic_type": "business" | "technical" | "creative" | "decision" | "research" | "other",
  "complexity": "low" | "medium" | "high",
  "suggested_mode": "fast" | "deep",          // 简单话题快速模式即可
  "participant_count": 2 | 3 | 4,             // 通常 3
  "participants": [
    {
      "model_id": "...",
      "role_label": "战略视角",                 // 显示在列头
      "persona_prompt": "你是一位战略专家，关注..."  // 注入到该模型的 system
    },
    ...
  ],
  "summarizer_model_id": "..."                 // 推荐由谁做总结
}

要求：
- 角色之间视角差异化（避免同质化）
- 选模型时考虑能力匹配（技术话题优先选擅长推理的）
- 至少包含一个"风险/反对"视角
```

### 阶段 B：每轮调用（注入 persona_prompt 作为 system）

```
[system]
{persona_prompt}

你正在参与一场圆桌讨论，话题是：{topic}

{如果第二轮:}
以下是其他专家在第一轮的观点，你可以补充、反驳或修正：
---
【{role_label_1}】({model_display_1})：
{round1_content_1}

【{role_label_2}】({model_display_2})：
{round1_content_2}
---

请基于你的视角发表观点。控制在 300 字以内，结构清晰。

[user]
{topic}
```

### 阶段 C：总结模型

```
你是一个圆桌总结员。下面是 {N} 位专家的讨论：

{完整对话历史}

请输出严格 JSON：
{
  "consensus": ["所有人都同意的要点 1", ...],
  "divergence": [
    { "topic": "分歧主题", "positions": [{"role": "...", "stance": "..."}] }
  ],
  "risks": ["被识别的风险 1", ...],
  "recommended_decision": "综合建议（一段话）",
  "next_steps": ["可执行步骤 1", "步骤 2", ...]
}
```

### 降级策略

- 角色生成失败 → 退回固定 3 角色（综合 / 批判 / 实践）
- 总结失败 → 退回简单拼接 + 提示用户手动总结

---

## 成本预估算法

### 调用前预估

```
estimated_input_tokens =
   tiktoken/anthropic-tokenizer 对完整 messages 编码

estimated_output_tokens =
   该模型历史平均输出 tokens（按用户 × 模型 滚动统计，初始 fallback = 500）

estimated_cost =
   estimated_input_tokens * price_input_per_1m / 1_000_000
 + estimated_output_tokens * price_output_per_1m / 1_000_000
 + price_per_call (若适用)
```

### 显示策略

- 若历史样本 < 5 次 → 显示"~$0.001–0.01" 区间（取低估和高估两端）
- 若历史样本 >= 5 次 → 显示精确单值
- 图像/视频按次计费 → 直接显示固定单价

### 圆桌预估

```
roundtable_estimate = sum over (participant, round) of estimate(model, prompt_size)
                   + estimate(summarizer, full_history_size)
```

---

## 失败兜底实现要点

```
try {
  result = await call(primary_model)
  if (was_marked_anomaly(primary_model)) clear_anomaly(primary_model)  // 成功则清除异常
} catch (err) {
  classified = classify(err)  // quota / network / rate_limit / content_filter / unknown

  if (classified !== 'content_filter') {
    increment_failure_count(primary_model)  // content_filter 不计入
  }

  if (auto_fallback_enabled && classified !== 'content_filter') {
    next_model = pick_next_in_fallback_order()
    notify_renderer({ type: 'fallback', from, to, reason: classified })
    result = await call(next_model)
  } else {
    notify_renderer({ type: 'failure_decision', reason: classified, suggestions: [...] })
    return
  }

  // 渐进式降权（用户透明可见）
  const fc = failure_count_24h(primary_model)
  if (fc >= 5) mark_disabled_until(primary_model, +24h)
  else if (fc >= 3) mark_demoted(primary_model)  // UI 中下移、标灰但仍可选
}
```

错误分类直接决定提示文案（"额度不足"vs"网络异常"vs"内容审核拒绝"），避免笼统 "失败了"。

---

## 文件拖入聊天的处理

### Renderer
- Tauri `onDragDrop` 事件接收路径
- 通过 Tauri 命令 `read_file_for_upload(path)` → 返回 base64 + mime
- 附加到下一条 message 的 `attachments` 字段

### Sidecar
根据 mime 自动路由：
- `image/*` → 注入 vision 模型（自动切换到支持视觉的当前 chat 模型）
- `application/pdf, text/*` → 走文档解析（MVP 简单方案：直接读文本送入；PDF 用 `pdf-parse`）
- 其他 → 提示用户该类型尚不支持
