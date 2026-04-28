# 08 · API 合同（M1）

> **目标读者：** Sidecar 后端工程师 + Web 前端工程师。
> **来源约束：** [03-process-and-ipc.md](./03-process-and-ipc.md) 的端点表 + [04-data-and-storage.md](./04-data-and-storage.md) 的 Schema。
> **实现位置：** 所有请求/响应的 Zod schema 落在 `packages/shared/src/schemas/`，前后端共用。

## 通用约定

### 端点前缀
所有**业务**端点位于 `http://127.0.0.1:{port}/v1/`。  
**唯一例外：** `/health` 不带 `/v1` 前缀，且**免鉴权**（运维探活）。

### 鉴权
所有 `/v1/` 下请求必须带 `Authorization: Bearer <token>`，token 在 Sidecar 启动时通过 stdout 输出，由 Tauri 转发给 Renderer。无效 token 返回 `401`。

### 响应包装

**成功（非 SSE）：**
```json
{ "ok": true, "data": <T> }
```

**失败：**
```json
{
  "ok": false,
  "error": {
    "code": "validation_error" | "not_found" | "provider_error" | "internal" | "unauthorized",
    "message": "human readable",
    "details": { ... }
  }
}
```

### 流式响应（SSE）

**唯一协议：** Vercel AI SDK 的 **数据流协议**（"part-code 行格式"）。**具体协议形态、part code 字典与 `streamText()` 的响应方法名（`toDataStreamResponse` / `toUIMessageStreamResponse` 等）取决于 [02-tech-stack.md](./02-tech-stack.md) 中 M0 spike 锁定的 AI SDK 主版本**。本节仅描述对前端可见的契约骨架；具体 part code 与字段在 M0 spike 完成后回写本节。

- `Content-Type: text/event-stream; charset=utf-8`
- 每帧一行的 part-code 协议（**不是裸 `data:` 前缀**）
- 心跳：周期发送空 Data Part 帧（前端忽略）

**M1 范围内必须承载的逻辑事件类型**（与具体 part code 无关）：

| 事件 | 含义 | 落点 |
|---|---|---|
| 业务元数据 | `conversation_id` / `message_id` / `model_id` / `cost_estimate_usd` | 流首部一次 |
| 文本片段 | LLM 流式输出 | 多次 |
| 单步/整次结束 | `finishReason` + `usage`（`promptTokens`/`completionTokens`） | 流尾部 |
| 实际成本 | `input_tokens` / `output_tokens` / `actual_usd` / `duration_ms` | 流尾部，紧接结束帧 |
| 错误（结构化） | `code` / `classification` / `model_id` / `can_retry` / `suggestions[]` + 文本错误信息 | 失败时

### 时间戳
所有 `created_at` / `updated_at` 字段为 **Unix 毫秒**（integer）。

### ID 规则
所有内部 ID = `<前缀>_` + `nanoid(12)`，**不可变**：

| 资源 | 前缀 | 示例 |
|---|---|---|
| Provider | `prov_` | `prov_V1StGXR8_Z5j` |
| Model | `mdl_` | `mdl_kPx7T9aQbZc4` |
| Conversation | `conv_` | `conv_8cZQ_4mY3xpN` |
| Message | `msg_` | `msg_a7Hg2_kLm9pq` |
| File | `file_` | `file_3vK9aBpL_mxs` |
| Roundtable | `rt_` | `rt_9XzL3v_KqT8aB` |
| Cost record | `cost_` | `cost_qP_3aL9zXkM2` |

**用户可见的别名**（如 `haiku-fast`）落 `models.alias` 字段，可重命名，唯一约束。所有 API 入参/出参的 `model_id` / `provider_id` 等字段都是上面的内部 ID，不接受 alias。前端展示时按需 join `alias` / `display_name`。

---

## 1. `/health`

### `GET /health`

**Request:** 无 body，**无需 `/v1` 前缀，无需鉴权**（运维端点）。

**Response 200:**
```json
{
  "ok": true,
  "data": {
    "status": "ready",
    "version": "0.1.0",
    "uptime_ms": 12345
  }
}
```

**用途：** Renderer 周期心跳；3 次连续失败触发 Tauri 端 Sidecar 重启。

---

## 2. `/v1/providers`

### `GET /v1/providers`

**Response 200:**
```json
{
  "ok": true,
  "data": {
    "providers": [
      {
        "id": "prov_xxx",
        "name": "OpenRouter",
        "type": "openrouter",
        "base_url": "https://openrouter.ai/api/v1",
        "has_api_key": true,
        "enabled": true,
        "created_at": 1714200000000
      }
    ]
  }
}
```

> ⚠️ 任何接口**永不**返回明文 API Key；只返回 `has_api_key: boolean`。

### `POST /v1/providers`

**Request:**
```json
{
  "name": "OpenRouter",
  "type": "openrouter" | "openai" | "anthropic" | "ollama" | "custom",
  "base_url": "https://openrouter.ai/api/v1",
  "api_key": "sk-or-..."     // 仅在请求时存在；落到 Sidecar 后立即转写到 OS Keychain，Sidecar 内存中不持久化
}
```

> **API Key 流转：** Renderer 在用户输入 Key 时**短暂持有明文**，但承诺**不持久化、不写日志、不发送到非本机端点**；POST 到 Sidecar 后，Sidecar 通过 Tauri Rust（[控制通道方案](./03-process-and-ipc.md#sidecar--tauri-rust-控制通道m0-待决但范围已收敛)）写入 OS Keychain，并保留运行期内存副本以供后续 LLM 调用使用；进程重启后从 Keychain 重新加载。

**Response 200:** 返回创建的 provider（无 api_key）。

**Errors:**
- `validation_error`（缺字段、URL 不合法）
- `provider_error`（验证 Key 失败时，附带 provider 原始错误）

### `POST /v1/providers/:id/test`

**Request:** 无 body。
**Response 200:**
```json
{
  "ok": true,
  "data": {
    "success": true,
    "latency_ms": 234,
    "models_count": 187    // 部分 provider 返回（如 OpenRouter）
  }
}
```

### `DELETE /v1/providers/:id`

**Side effects:**
- 同步删除 OS Keychain 条目（经控制通道转 Rust）
- 该 provider 下的 models：`provider_id` 设 NULL + `enabled=false`（**不物理删除**，保留 cost_records 归因）
- cost_records 不动（其 provider 关联是通过 model_name_snapshot 间接保留的）

---

## 3. `/v1/providers/:id/discover-models`

> OpenRouter "一键导入" 等场景使用。

**Response 200:**
```json
{
  "ok": true,
  "data": {
    "models": [
      {
        "model_name": "anthropic/claude-3-5-haiku",
        "display_name": "Claude 3.5 Haiku",
        "capability": "chat",
        "context_length": 200000,
        "supports_vision": true,
        "supports_tools": true,
        "supports_json": true,
        "price_input_per_1m": 0.80,
        "price_output_per_1m": 4.00,
        "price_currency": "USD"
      }
      // ...
    ]
  }
}
```

**实现注意：** 不直接写入 DB；前端展示多选后再调 `POST /v1/models/batch`。

---

## 4. `/v1/models`

### `GET /v1/models`

**Query params:**
- `capability?` — `chat` | `image` | ...
- `enabled_only?` — `true` 只返回启用的

**Response 200:**
```json
{
  "ok": true,
  "data": {
    "models": [
      {
        "id": "mdl_kPx7T9aQbZc4",
        "alias": "haiku-fast",
        "provider_id": "prov_V1StGXR8_Z5j",
        "model_name": "anthropic/claude-3-5-haiku",
        "display_name": "Claude 3.5 Haiku",
        "capability": "chat",
        "price_input_per_1m": 0.80,
        "price_output_per_1m": 4.00,
        "price_per_call": null,
        "price_currency": "USD",
        "context_length": 200000,
        "supports_vision": true,
        "supports_tools": true,
        "supports_json": true,
        "is_default_for": "chat",
        "fallback_order": 1,
        "user_rating": null,
        "failure_count_24h": 0,
        "demoted": false,
        "disabled_until": null,
        "enabled": true
      }
    ]
  }
}
```

### `POST /v1/models`

**Request:**
```json
{
  "alias": "haiku-fast",                // 可选；用户可见短名，未填留空（id 后端必生成 nanoid，不接受用户传 id）
  "provider_id": "prov_V1StGXR8_Z5j",
  "model_name": "anthropic/claude-3-5-haiku",
  "display_name": "Claude 3.5 Haiku",
  "capability": "chat",
  "price_input_per_1m": 0.80,
  "price_output_per_1m": 4.00,
  "context_length": 200000,
  "supports_vision": true,
  "supports_tools": true,
  "supports_json": true,
  "is_default_for": "chat",
  "fallback_order": 1
}
```

> **id 永远由后端生成**（`mdl_` + nanoid(12)），用户只能改 `alias`。这样 alias 改名不会影响历史 cost_records / messages 的引用。

### `POST /v1/models/batch`

批量导入（OpenRouter 多选确认后）。Request body 是 `{ models: [<上面的对象>] }`。

### `PATCH /v1/models/:id`

**Request:** 上述任意字段的子集。

**特殊副作用：**
- 改 `is_default_for` → 同 capability 内取消旧默认
- 改 `enabled=false` → 不影响历史 cost_records

### `DELETE /v1/models/:id`

**M1 物理删除**。下游影响（外键策略详见 [04-data-and-storage.md §删除/可空性策略汇总](./04-data-and-storage.md#删除可空性策略汇总)）：

- `cost_records.model_id` → **SET NULL**（保留 `model_name_snapshot` 用于账单归因）
- `messages.model_id` → **SET NULL**（assistant 消息保留，但模型徽章显示为"已删除模型"）

### `POST /v1/models/:id/test`

**Response 200:**
```json
{
  "ok": true,
  "data": {
    "success": true,
    "latency_ms": 432,
    "tokens_used": 1     // 用一个最小 prompt 验证
  }
}
```

---

## 5. `/v1/conversations`

### `GET /v1/conversations`

**Query params:** `archived?: boolean`, `limit?: number`, `cursor?: string`（按 updated_at 倒序）

**Response 200:**
```json
{
  "ok": true,
  "data": {
    "conversations": [
      {
        "id": "conv_xxx",
        "type": "chat",
        "title": "周报草稿",
        "created_at": 1714200000000,
        "updated_at": 1714286400000,
        "archived": false,
        "message_count": 12,
        "total_cost_usd": 0.0237
      }
    ],
    "next_cursor": "..."
  }
}
```

### `POST /v1/conversations`

**Request:**
```json
{ "type": "chat", "title": null }    // title 为空则首条消息后自动生成
```

### `PATCH /v1/conversations/:id`

可改 `title`、`archived`。

### `DELETE /v1/conversations/:id`

下游影响：
- `messages` → **CASCADE 删除**
- `files.conversation_id` → **SET NULL**（保留盘上文件，避免误删；用户可在"孤儿文件"中手动清理，M2 引入）
- `cost_records.conversation_id` → **SET NULL**（保留账单历史）

---

## 6. `/v1/messages`

### `GET /v1/messages?conversation_id=<id>`

**Query params:** `limit?: number`, `before?: string`（消息 id，向前翻页）

**Response 200:**
```json
{
  "ok": true,
  "data": {
    "messages": [
      {
        "id": "msg_a7Hg2_kLm9pq",
        "conversation_id": "conv_8cZQ_4mY3xpN",
        "role": "user" | "assistant" | "system" | "tool",
        "content": "...",
        "model_id": "mdl_kPx7T9aQbZc4",       // assistant only；已删除模型时为 null
        "parent_message_id": null,
        "attachments": [
          {
            "file_id": "file_3vK9aBpL_mxs",   // 引用 files 表，由 POST /v1/files 上传后获得
            "type": "image",                   // 'image' | 'pdf' | 'text' | 'other'
            "mime": "image/png",
            "filename": "screenshot.png",
            "size_bytes": 123456
          }
        ],
        "status": "completed",                 // 'pending' | 'streaming' | 'completed' | 'incomplete' | 'failed'
        "error": null,
        "cost": {
          "estimated_usd": 0.0008,
          "actual_usd": 0.00076,
          "input_tokens": 532,
          "output_tokens": 128
        },
        "created_at": 1714200000000
      }
    ],
    "has_more": true
  }
}
```

---

## 7. `/v1/chat` (SSE)

### `POST /v1/chat`

> M1 核心端点。Renderer 通过 Vercel AI SDK `useChat({ api: '/v1/chat' })` 直接消费，无需自定义 parser。

**Request:**
```json
{
  "conversation_id": "conv_8cZQ_4mY3xpN",   // null 时后端创建新会话
  "model_id": "mdl_kPx7T9aQbZc4",
  "messages": [
    {
      "role": "user",
      "content": "总结这张图",
      "attachments": [
        { "file_id": "file_3vK9aBpL_mxs", "type": "image", "mime": "image/png", "filename": "x.png", "size_bytes": 12345 }
      ]
    }
  ],
  "options": {
    "temperature": 0.7,
    "max_tokens": null
  }
}
```

> attachment schema 与 `/v1/messages` 返回一致；`file_id` 必须是事先通过 `POST /v1/files` 上传得到的有效 ID，且 `conversation_id` 必须匹配。

**Response:** `Content-Type: text/event-stream; charset=utf-8`，遵循 Vercel AI SDK 数据流协议（具体 part code 与帧格式以 M0 spike 锁定版本为准；下面示例**仅说明承载的逻辑信息**，并非保证的字符级输出）。

**事件序列示意（标准成功流）：**

```
[业务元数据]   conversation_id, message_id, model_id, cost_estimate_usd
[文本片段]*    "Hello"  " world"  ...
[单步结束]    finishReason="stop", usage={promptTokens, completionTokens}
[成本元数据]  message_id, input_tokens, output_tokens, actual_usd, duration_ms
[整次结束]    finishReason, usage
```

> 所有"业务元数据/成本元数据"通过 AI SDK 的 annotation 机制承载；annotation 对象用 `type` 字段区分子类型：`meta` / `cost` / `error_detail`。前端在 `useChat` 的消息对象上读到（具体读取字段名以锁定的 SDK 版本为准）。

**Sidecar 注入 attachments 的实现规则（M1）：**
- 请求体中 `messages[].attachments[].file_id` 必须是事先通过 `POST /v1/files` 上传得到的有效 ID，且对应记录的 `conversation_id` 必须等于本次请求的 `conversation_id`（防越权）
- Sidecar 在调 LLM 之前，按 `file_id` 从 `files` 表加载实际内容并组装 multimodal 消息：
  - `type=image` → 读 `storage_path` 文件 → 转 base64（或 provider 支持的形式）→ 注入为 image part
  - `type=pdf` / `type=text` → 直接使用 `files.extracted_text` 注入为 text part；超长时按"内容过长"错误返回（不静默截断）
- 当前会话模型不支持视觉而 attachment 含 image → 返回 `validation_error` 并提示用户切换支持视觉的模型

**错误流（结构化分类 + 文本错误信息）：**

承载的逻辑信息：
- `code`：HTTP/服务端错误码（与 §11 错误码总表一致，如 `provider_error`）
- `classification`：业务级 5 类（`quota` / `network` / `rate_limit` / `content_filter` / `unknown`）
- `model_id` / `can_retry` / `suggestions[]`
- 简短的文本错误信息（已由 `classifyProviderError` 脱敏，**不含 API Key、URL query、Authorization header 内容**）

> **`code` 与 `classification` 的关系：** `code` 描述 HTTP/系统层错误（用于决定 HTTP 状态、是否可重试 RPC），`classification` 描述业务层失败原因（用于 UI 文案与降权计数）。失败时通常 `code=provider_error` + `classification=quota|network|rate_limit|content_filter|unknown`；其他 `code`（`unauthorized`/`validation_error`/`internal` 等）是 sidecar 自身错误，不计入模型失败次数。

> **M1 前端展示规则：** 仅展示 `classification` 文案 + "重试"按钮。**`suggestions` 字段虽然在协议中携带，但 M1 UI 不渲染换模型按钮**——避免与 M2 决策型兜底框设计冲突。M2 才统一接入 suggestions 渲染。
> 详见 [产品 M1 规格 §3.3 范围明确](../product/08-m1-spec.md#33-范围明确)。

**Abort：** 客户端关闭连接 → Sidecar 收到 close → AbortController 链路取消上游 fetch；已生成 chunks 保留并写库为 `status='incomplete'`。

### 与 Vercel AI SDK 的实现映射

> 具体伪代码以 M0 spike 锁定的 AI SDK 主版本为准；锁定后回写本节。共同要点：
> - 用 `streamText({ model, messages })` 创建流
> - 把流挂回 Fastify HTTP response（响应方法名以 SDK 版本为准）
> - 业务 annotation（meta/cost/error_detail）通过 SDK 提供的 metadata/data 通道注入
> - 错误统一过 `classifyProviderError(err)` → 输出 `{ code, classification, can_retry, suggestions[], message }`，message 已脱敏

---

## 8. `/v1/costs`

### `GET /v1/costs/summary`

**Query params:** `conversation_id?`, `since?` (毫秒时间戳), `group_by?` = `model` | `feature`

**Response 200:**
```json
{
  "ok": true,
  "data": {
    "total_usd": 1.234,
    "by_model": [
      { "model_id": "mdl_kPx7T9aQbZc4", "cost_usd": 0.456, "calls": 89 }
    ],
    "by_feature": [
      { "feature": "chat", "cost_usd": 1.123, "calls": 154 },
      { "feature": "image", "cost_usd": 0.111, "calls": 3 }
    ]
  }
}
```

### `GET /v1/costs/realtime`

底部状态栏轮询用。

**Response 200:**
```json
{
  "ok": true,
  "data": {
    "current_conversation_usd": 0.012,
    "current_conversation_calls": 4,
    "today_usd": 0.34,
    "month_usd": 5.67,
    "currency_display": "USD"      // 用户偏好
  }
}
```

### `GET /v1/costs/records`

明细查询，支持分页。

---

## 9. `/v1/files`

> 文件拖入路径：Tauri 拿到本地路径 → 通过 Tauri Rust 读取 → 上传到 Sidecar；Sidecar 落到应用数据目录并写 `files` 表。

### `POST /v1/files`

**Content-Type:** `multipart/form-data`

**Form fields:**
- `file` — binary
- `conversation_id` — 关联会话（必填，便于 GC 与权限范围）

**Response 200:**
```json
{
  "ok": true,
  "data": {
    "file_id": "file_3vK9aBpL_mxs",
    "conversation_id": "conv_8cZQ_4mY3xpN",
    "mime": "image/png",
    "filename": "screenshot.png",
    "size_bytes": 123456,
    "preview_url": "data:image/png;base64,...",   // 仅图像；text/pdf 为 null
    "extracted_text": null,                         // PDF/纯文本时含值，最长截断 64KB
    "created_at": 1714200000000
  }
}
```

**Sidecar 处理：**
- 图像：保留原文件 + 生成 ≤ 256x256 缩略图 base64
- PDF：调 `pdf-parse` 抽文本，存 `files.extracted_text`
- 不支持类型：返回 `validation_error`，details 中明示 mime

> `file_id` 是 SQLite `files` 表主键（持久化），不是临时内存对象。删除会话时设 NULL（不删盘上文件，避免误删）；M2 引入"孤儿文件清理"。

---

## 10. M2 / M3 端点（占位说明，M1 不实现）

### M2

| 端点 | 用途 |
|---|---|
| `/v1/memories` GET/PUT | 三级记忆读写 |
| `/v1/chat/with-tools` POST + SSE | 跨能力工具调用版聊天（M1 走简单 `/v1/chat`） |

### M3

| 端点 | 用途 |
|---|---|
| `/v1/roundtable` POST + SSE | 启动圆桌（含话题分析阶段） |
| `/v1/roundtable/:id/round` POST | 触发下一轮 |
| `/v1/roundtable/:id/summarize` POST | 触发总结 |
| `/v1/roundtable/:id/export` GET | Markdown 导出 |

---

## 11. 错误码总表（M1 范围）

### 11.1 HTTP/系统错误码（`code` 字段）

| code | HTTP | 含义 |
|---|---|---|
| `unauthorized` | 401 | Bearer token 无效 |
| `validation_error` | 400 | 请求体不合法（Zod 校验失败） |
| `not_found` | 404 | 资源不存在 |
| `conflict` | 409 | 唯一性冲突（如 model id 重复） |
| `provider_error` | 502 | 上游 LLM/Provider 报错（含分类信息） |
| `keychain_error` | 500 | OS Keychain 读写失败 |
| `internal` | 500 | 兜底 |

### 11.2 业务失败分类（`classification` 字段，仅当 `code=provider_error` 时携带）

| classification | UI 文案/语义 | 是否计入"模型失败次数" |
|---|---|---|
| `quota` | 额度耗尽/欠费 | 是 |
| `rate_limit` | 限流；建议稍后重试 | 是（仅短窗口降权） |
| `network` | 网络/超时 | 是 |
| `content_filter` | 内容被上游策略拦截 | 否（不视作模型失败） |
| `unknown` | 其他未识别错误 | 是 |

> **关系：** `code` 决定 HTTP 状态与系统级处理（鉴权/Zod/找不到资源等）；`classification` 仅在 `code=provider_error` 时有意义，描述 Provider 调用失败的业务原因，驱动前端文案 + 模型失败计数（用于 §M2 兜底）。其他 `code`（`unauthorized`/`validation_error`/`internal` 等）属于 sidecar 自身错误，不计入模型失败次数。

---

## 12. 实现备忘

- **所有 schema 定义集中在 `packages/shared/src/schemas/`**，使用 Zod。Sidecar 用 `fastify-type-provider-zod`，前端 `useChat`/`fetch` 直接 import 类型。
- **API Key 安全语义（精确表述）：**
  - Renderer 在 onboarding/编辑 Provider 时**会短暂持有用户输入的 Key 明文**。
  - 承诺：**不持久化、不写入日志、不发送到任何非 `127.0.0.1` 端点**。
  - 一旦 POST 到 Sidecar，明文立即转写到 OS Keychain；Sidecar 内存仅保留运行期最小副本，进程退出即清。
- **Keychain 通路（M0 第一周决定，影响本合同）：**
  - Sidecar 反向调用 Tauri Rust 的具体方式（写/读 Keychain、读本地文件）由 [03-process-and-ipc.md §Sidecar↔Tauri Rust 控制通道](./03-process-and-ipc.md#sidecar--tauri-rust-控制通道m0-待决但范围已收敛) 定义。
  - **当前合同假设方案 A**（Rust 暴露仅 127.0.0.1 + Bearer Token 的本地 HTTP，crate 选 axum）。若 M0 改用方案 B/C，本文件相应章节会更新，但**对外 HTTP 合同（前端可见部分）不变**。
  - **Renderer 永远不直接接触 Keychain**——所有 Key 落地路径必须经 Sidecar 或 Rust。
- **AI SDK 版本锁定（M0 spike）：** 本文件 §7 中所有"具体 API 名/part code/帧格式"在 M0 spike 锁定版本前**仅作示意**；spike 完成后必须回写本节、§7、[03-process-and-ipc.md §流式实现要点](./03-process-and-ipc.md#流式实现要点)，并把版本写进 `apps/sidecar/package.json` 与 `apps/web/package.json`。
- **`classifyProviderError(err)` 工具：** 在 Sidecar 端集中处理上游错误，输出 `{ code, classification, can_retry, suggestions[], message }` 五元组，注入到错误 annotation。**强制脱敏**：剥离 API Key、Authorization header、URL 中的 query string；message 不超过 200 字符；原始错误仅写入 sidecar 调试日志（也需脱敏，见 [05-security.md](./05-security.md) 日志规则）。
