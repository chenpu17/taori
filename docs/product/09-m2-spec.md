# 09 · M2 核心 MVP 规格（产品主线落地）

> **位置：** [产品文档总览](./README.md)（如有）→ M1 内测版（[08](./08-m1-spec.md)）已闭合 → **M2 规格**。  
> **目标读者：** 产品 / 设计 / 开发 / 测试。本文档是 **M2 进入开发** 的唯一入口规格。  
> **关系：** 上承 [04 失败兜底](./04-failure-resilience.md) / [03 成本透明](./03-cost-transparency.md) / [02 核心功能](./02-core-features.md) / [09 Agent 与工具体系](./09-agent-and-tools.md)；架构落点见 [架构 09](../architecture/09-agent-and-tools.md) / [架构 04](../architecture/04-data-and-storage.md)。

## M2 一句话目标

**模型挂了不卡住，跨能力调用顺畅，成本始终在视野里。**

具体说就是 4 件事：

1. **失败 = 决策机会**：弹决策提示让用户选「换模型 / 重试 / 改 prompt / 取消」，而不是只看错误横幅。
2. **聊天中跨能力调用**：用户说「画一张……」→ 自动识别图像意图 → 弹图像模型选择器 → 生成结果嵌入对话流。
3. **成本 L3 + L4**：流式过程轻量小标签 + 高成本前置确认 + 会话级成本仪表盘。
4. **Capability Bus 上线（用户无感）**：内置 `image_generate` / `file_read` 两个工具走统一调度，留好 M3 MCP 接入位置。

> M2 不引入"Agent"概念给用户。三级记忆只用 `memories` 表存"图像模型偏好"等键值。

---

## 0. 进入 M2 的前置条件（M1 已交付）

- ✅ M1 schema：`models.fallback_order` / `demoted` / `disabled_until` / `failure_count_24h` 全部在用
- ✅ `nextFallback(currentId, capability)` repo API 可用，按 `fallback_order asc` 跳过当前 + demoted
- ✅ `classifyProviderError` 输出 `quota` / `network` / `rate_limit` / `content_filter` / `unknown` / `auth`
- ✅ chat 流末端 `recordFailure` / `recordSuccess` 已写 24h 滚动窗口
- ✅ cost_records 已包含 `source_type='tool_call'` 枚举（M1 预留）
- ✅ 渲染端 ChatErrorBanner 接受 5 类 classification 文案

---

## 1. 失败兜底·决策型提示（产品主线 #1）

### 1.1 用户故事

| ID | 作为...我希望...以便... |
|---|---|
| FR-1 | 当模型 A 报 `quota` 时，看到一个**决策卡片**（不是 toast banner），上面列「换用模型 B（推荐）/ 手动选其他 / 重试 A / 编辑后重试 / 取消」，点一下就走下去 |
| FR-2 | 当系统已为我自动选了"推荐替代"，能看到为什么（"模型 B 价格相近、能力相近"），并能改主意 |
| FR-3 | 当我开启了"自动降级"开关，失败后系统按 `fallback_order` 自动尝试下一个，但**仍然在对话流里告知**已切换 |
| FR-4 | 当模型被降权（24h 内 ≥3 次失败），在模型选择器和决策卡片里能看到 ⚠️ 标识；当模型被禁用（≥5 次），看到 🚫 + 解禁时间 |
| FR-5 | 当 `content_filter` 失败，看到的提示是"内容被供应商安全策略拦截 — 不会计入失败次数，建议改写 prompt 后重试"，**不被推荐换模型**（这不是模型问题） |

### 1.2 决策卡片信息架构

```
┌──────────────────────────────────────────────────┐
│  ⚠️ 模型 GPT-4o 当前不可用（额度不足）            │
│                                                  │
│  推荐改用：Claude Haiku                          │
│    💰 ~$0.0003/次（与 GPT-4o 相当）              │
│    ⚡ 能力相近：擅长聊天、代码、长文本             │
│  [ 改用 Claude Haiku ]  ← 主按钮                 │
│                                                  │
│  其他选择：                                       │
│  [ 选其他模型 ]  [ 重试 GPT-4o ]                 │
│  [ 编辑后重试 ]  [ 取消 ]                        │
│                                                  │
│  ☐ 失败时自动切换（不再询问）                    │
└──────────────────────────────────────────────────┘
```

**关键 UX 决策：**

- 卡片**直接渲染在消息流位置**（取代失败那条 assistant 占位气泡），不是 modal、不是顶栏 banner。原因：失败本身就是对话上下文的一部分，不该被全局打断。
- "推荐改用 X" 的逻辑就是 `nextFallback(currentId, capability)`：M1 已实现的 API，M2 直接消费。
- 主按钮文案随分类变化：
  - `quota` → "改用 Claude Haiku"
  - `rate_limit` → "改用其他模型 / 30 秒后重试"（双主按钮）
  - `network` → "重试" 是主按钮，换模型是次选
  - `content_filter` → 没有"换模型"按钮（这不是模型问题），只有"编辑后重试 / 取消"
  - `unknown`/`auth` → 与 quota 相同
- 「自动切换」勾选框的 truth-source 是 `memories.scope='global', key='auto_fallback_enabled'`。下次失败时若 true，跳过卡片直接执行 fallback，但仍然在消息流里插一条 `[system]` 通知"已从 A 切换到 B（原因：quota）"。

### 1.3 sidecar 端协议增强

当 chat 流以 `provider_error/<class>` 结束（M1 已具备）时，**追加一条 SSE annotation**（AI SDK data stream 的 `8:` 帧 — 与 `meta` / `cost` 注解同一信道，绑定到正在生成的 assistant message）。

**帧顺序固化（解析端按此顺序消费）：**

```
... 流式正文 0:/9:/... 帧
2:[{"type":"failure_decision","classification":"quota","current_model_id":"mdl_xxx","recommended_model_id":"mdl_yyy","auto_fallback_enabled":false}]   ← 帧示意（实际信道为 `8:`，见正文）
3:"provider_error/quota: insufficient_quota"
[DONE]
```

`recommended_model_id` = `nextFallback(current, 'chat').id`，可能为 `null`（无可用替代）。

`recommended_model_id` 为 `null` 时，renderer 不渲染主"改用 X"按钮，只保留"重试 / 编辑后重试 / 取消"。"为什么推荐"文案完全在 renderer 端基于本地价位徽章 + capability 相近度生成，sidecar 不下发文案。

### 1.4 自动降级路径（一档开关）

- 偏好键：`memories(scope='global', key='auto_fallback_enabled', value='true'|'false')`
- 偏好入口（两处共用同一个 `memories` 键，UI 单向同步）：
  - settings → 失败兜底 → 自动降级开关
  - 决策卡片底部 ☐ 失败时自动切换（不再询问）
- chat.ts 在 `produceUpstreamStream` 抛错且开关 ON 时：
  1. **若 `classification === 'content_filter'` → 跳过自动降级**，直接发 `failure_decision` annotation（renderer 渲染卡片但**无**"换模型"按钮）。理由：内容审核不是模型问题，换模型大概率仍被拒，且会触发多次扣费
  2. 否则调用 `nextFallback(currentId, capability)`，若返回非空：写一条系统消息`[system] 已从 GPT-4o 切换到 Claude Haiku（原因：额度不足）` 并以新模型重发当前 user message（不写新 user message）
  3. 若 `nextFallback` 返回 null：照常发 `failure_decision` annotation，开关无效
- **重要：** 自动降级最多发生 1 次。第 2 次失败一律走决策卡片。防止级联失败陷入 N 次重试。

### 1.5 范围明确

- ✅ 决策卡片在消息流中渲染
- ✅ 推荐替代由 `nextFallback` 提供（M1 API）
- ✅ 自动降级开关（默认 OFF）
- ✅ 降权/禁用标识在选择器 + 决策卡片中可见
- ❌ 健康状态面板（独立栏目按模型看 24h 成功率/平均耗时） → 第二阶段
- ❌ 智能"为什么推荐这个模型"（基于历史用户行为）→ v2

---

## 2. 跨能力调用·图像生成（产品主线 #2）

### 2.1 用户故事

| ID | 作为...我希望...以便... |
|---|---|
| TC-1 | 在聊天中说"画一张赛博朋克咖啡店海报" → 系统识别为图像意图 → 弹图像模型选择器，列我配过的图像模型 + 价位徽章 |
| TC-2 | 选完后图像被生成、缩略图嵌入对话流（与上下文连续），点击可放大 |
| TC-3 | 选择器底部有「记忆此次选择」选项：仅本次 / 当前会话 / 以后类似图像任务默认 / 总是先询问。默认 = 总是先询问 |
| TC-4 | 没配过任何图像模型时，识别到图像意图就提示「请先在设置中添加图像模型」，给一个去设置的快捷按钮 |
| TC-5 | 图像生成失败（`provider_error/<class>`） → 复用第 1 节的决策卡片（推荐替代来自 `nextFallback(currentId, 'image')`） |

### 2.2 图像意图识别策略（M2 简化版）

**不引入意图分类器模型**。改用规则的或：

1. 用户当前消息**显式拖入** `image/*` 类型且当前模型不支持视觉 → M1 已有的 vision 自动切换或警告（保持不变）
2. 用户当前消息文本满足以下**任一**且**未命中否定上下文白名单**：
   - **命令式触发词**（必须位于句首或紧跟 `/`）：`/image`、`/draw`、`/img`、`画一张`、`生成图片`、`生成图像`、`绘制`、`generate image`
   - **句首关键词**：以 `画 ` / `画个 ` / `画张 ` / `draw ` 等开头
   - 否定上下文白名单（命中即跳过意图路由）：`已经`、`已`、`上次`、`那张`、`那个`、`参考`、`like the one`、`already`
   - 命中后 sidecar 的 chat handler 在 stream 启动**之前**完成检测
3. 协议时序（**重要：** 解决"消息归属"问题）：
   - 用户 message 照常通过 `POST /v1/chat` 写入 `messages` 表
   - sidecar 检测命中意图 → **不调用 LLM**，立即向 SSE 流写：
     ```
     2:[{"type":"capability_route","capability":"image","prompt":"赛博朋克咖啡店海报","user_message_id":"msg_xxx"}]
     [DONE]
     ```
   - Renderer 收到 `capability_route` 后弹图像选择器；后续 `/v1/tools/invoke` 调用 `image_generate` 时把 `user_message_id` 作为 `source_message_id` 传入
   - `image_generate.execute` 内部写一条 `messages(role='assistant', parent_message_id=<user_message_id>, attachments=[{file_id, type:'image', ...}])` —— 保证对话连续性
4. 用户视角逃生通道：图像选择器右上角 "我不是要画图" 按钮 → 写 `memories(scope='session', scope_id=<conv_id>, key='intent_route_disabled_until', value=<now+30min>)` → 30 分钟内同一会话跳过意图路由 → 重新走标准 chat 流
5. M2 不做 LLM 意图分类（成本 + 时延），第二阶段评估

### 2.3 图像模型选择器 UI

```
┌─────────────────────────────┐
│ 选择图像模型                  │
│ ● DALL-E 3      💰💰  $0.04/张 ← 推荐 │
│ ○ SD-XL local   💰    $0/张（本地）  │
│ ○ Flux Pro      💰💰💰 $0.08/张      │
│ ─────────────                │
│ 记住选择：                    │
│   ● 仅本次                   │
│   ○ 当前会话                  │
│   ○ 以后类似图像任务默认       │
│   ○ 总是先询问我              │
│ [ 生成 ]    [ 取消 ]         │
└─────────────────────────────┘
```

- 推荐 = 当前 capability='image' 模型中 `is_default_for='image'`，否则 `fallback_order asc` 第一个未禁用未降权的
- 「记住选择」落 `memories`：
  - `scope='session', scope_id=<conv_id>, key='image_model'` → 当前会话级
  - `scope='global', key='image_model_default'` → 全局
  - 「仅本次」不写 `memories`
  - 「总是先询问」清除上述两条
- 弹窗优先级查询顺序：session > global > 弹窗

### 2.4 图像生成执行链

通过 **Capability Bus**（详见 §4）调用 `builtin.image_generate`：

```
input: { prompt: string, model_id: string, conversation_id: string, source_message_id: string }
output: { file_id: string, width: number, height: number, content_type: string, assistant_message_id: string }
```

> 成本不在 output 里，由 Bus 统一写入 `cost_records`，UI 通过会话仪表盘读取（详见 §3.3、§4.3）。

- Bus 内部写一条 `messages(role='assistant', parent_message_id=<source_message_id>, content=<生成说明文字>, attachments=[{file_id, type:'image', ...}])` 并把生成的 message id 作为 `assistant_message_id` 返回，保证用户 user msg → assistant msg 链路连续
- Bus 写一条 `cost_records(source_type='tool_call', source_id=<assistant_message_id>, feature='image', model_id, model_name_snapshot, price_per_call_snapshot, actual_cost_usd, success)`
- 生成的图像文件 base64 落到 `files` 表 + 应用数据目录（与 M1 的 PDF/Image 拖入文件路径一致）

### 2.5 范围明确

- ✅ 关键词触发的图像意图识别（无 LLM 分类器）
- ✅ 图像模型选择器 + 三级记忆（仅本次 / 会话 / 全局）
- ✅ 通过 Capability Bus 走 `builtin.image_generate`
- ✅ 失败复用 §1 的决策卡片（capability='image' fallback）
- ❌ 视频生成（M3 起）
- ❌ 自然语言意图分类器（用 LLM 做意图判定，避免成本与时延）
- ❌ 图像生成中途的实时 progress（只在最终落库时插入，第二阶段评估）

---

## 3. 成本透明 L3 + L4（产品主线 #3）

### 3.1 L3 — 流式过程轻量显示

**关键约束：避免焦虑型 UI**（参考 [03-cost-transparency.md §3](./03-cost-transparency.md)）。

> 本节是对 **M1 现有 streaming cost badge 的视觉降权 + 交互升级**（不是新组件）。M1 在流式过程中显示高饱和实时跳动数字 → M2 替换为低饱和 throttled + 点击展开详情。组件标识 `cost-stream-badge` 在 M1 已存在，M2 重做其样式与交互行为。

UI 实现：

- 流式中（status='streaming'）：assistant 气泡右下角一个**低饱和小标签**（`opacity: 0.7, font-size: 11px, color: var(--text-muted)`），显示 `~$0.00X · NNN tok`。**不**实时跳动到 6 位小数；用 200ms throttle，最多两位有效数字。
- 用户**点击**该标签后展开成详情卡片：
  ```
  [实时计数 expanded]
  in:  1,234 tokens × $0.0003/1k = $0.000370
  out: 156 tokens × $0.0006/1k = $0.000094  ← 跳动
  total estimate: $0.000464
  ```
- 流式结束后小标签收敛为最终成本徽章（与 M1 的 per-message cost 行为一致）。

### 3.2 L4 — 高成本前置确认（柔性）

阈值与开关（`memories(scope='global', key='cost_confirm_*')`）：

| 偏好键 | 默认值 | 说明 |
|---|---|---|
| `cost_confirm_threshold_usd` | `0.20` | 单次预估超阈值触发确认 |
| `cost_confirm_image_always` | `true` | 图像生成无论金额都确认一次（防意外触发） |
| `cost_confirm_disabled_models` | `[]` | 用户勾"此模型不再提醒" 后追加 model_id 到这里 |
| `cost_confirm_disabled_conversations` | `[]` | 勾"本会话不再提醒" 后追加 conv_id |

UI：

```
⚠️ 此次调用预计 ~$0.45 · 单张图像生成
   [继续]  [改用低成本模型先出草稿]  [取消]
   ☐ 此模型不再提醒   ☐ 本会话不再提醒
```

逻辑：

- chat 发送前与 image 调用前**都**检查阈值；具体触发条件：
  ```
  shouldConfirm = (
    (model_id ∉ disabled_models) &&
    (conv_id ∉ disabled_conversations) &&
    (
      estimate(messages, model) > threshold ||
      (capability === 'image' && cost_confirm_image_always === true)
    )
  )
  ```
  即 **"此模型不再提醒" 或 "本会话不再提醒" 命中时直接跳过确认**，即便 `cost_confirm_image_always=true`。这一点对避免画图工作流被反复打断至关重要。
- 「改用低成本模型」按钮：调用 **`pickCheapestActive(capability, excludeId=currentId)`**（M2 新增 repo API，按 `price_per_call ?? price_input_per_1m` 升序，跳过 demoted/disabled），弹出新预估
  - 注意：此 API 与 `nextFallback`（按 `fallback_order asc`）语义不同，二者并存
- 「不再提醒」勾选写回偏好；下次跳过确认（仍写 cost_records 不影响透明度）
- 取消会**不**触发任何 LLM 调用，也不写 cost_records

### 3.3 L4 — 会话级成本仪表盘（常驻 + 详情）

底部状态栏（M1 已有）保留 `今日 / 本月 / 本会话` 三段。**新增**：

- 点击「本会话」打开会话详情侧边栏 `<aside data-testid="session-cost-panel">`：
  ```
  本会话总成本：$0.099（12 次调用，3 次失败）
  ──────────────────
  按模型拆分：
    GPT-4o     $0.061  (8 次)
    DALL-E 3   $0.040  (1 次图像)
    Haiku      $0.012  (3 次失败 ⚠️ 含 1 次 4xx 扣费)
  按 feature 拆分：
    chat       $0.061
    image      $0.040
  ──────────────────
  最近一次：刚才 · GPT-4o · $0.0123 ✓
  ```
- 失败行后若存在 `success=false AND actual_cost_usd>0` 的记录，追加红色徽章 "含 N 次 4xx 扣费"，避免侧边栏给用户"失败 = 0 成本"的错误印象
- 数据来源：`SELECT model_id, feature, SUM(actual_cost_usd), COUNT(*), SUM(CASE WHEN success THEN 1 ELSE 0 END) AS success_count, SUM(CASE WHEN NOT success AND actual_cost_usd > 0 THEN 1 ELSE 0 END) AS billed_failure_count FROM cost_records WHERE conversation_id=? GROUP BY model_id, feature` — 单次查询。
- 「今日」与「本月」也打开同样形态的侧边栏，作用域不同（按 `created_at` 范围）。

### 3.4 范围明确

- ✅ 流式小标签（throttled 200ms、点击展开）
- ✅ 高成本前置确认（带「不再提醒」三档：永久 / 此模型 / 本会话）
- ✅ 会话仪表盘侧边栏（按 model / feature 拆分）
- ✅ 价位徽章（💰 数量随 `price_per_call` 或 `price_input_per_1m` 分档）— M1 已有，M2 在选择器一致使用
- ❌ 月度预算告警（v2）
- ❌ 智能省钱建议（v2）
- ❌ CNY 切换（M3 后评估）

---

## 4. Capability Bus + 内置工具（产品主线 #4，用户无感）

### 4.1 设计目标

- 把 `image_generate` 与 `file_read` 这两个 M2 内置工具的调度统一到一个 Bus 里，**不要**在 chat.ts 里散写 if/else
- 给 M3 的 MCP 桥留好接入点：M3 只需注册一组 `mcp.<server_id>.<tool_name>` 工具就能复用同一调度
- **M2 不暴露给用户**：没有"工具中心 UI"、用户不感知工具概念

### 4.2 数据契约（落 `packages/shared/src/tools.ts`）

```ts
export const ToolSchema = z.object({
  name: z.string(),                          // 'builtin.image_generate'
  description: z.string(),
  capability: z.enum(['image', 'file', 'web', 'code', 'mcp']),
  source: z.enum(['builtin', 'mcp']),
  source_id: z.string(),                     // 'image_generate' / mcp server id
  enabled: z.boolean(),
});

export const ToolInvokeRequestSchema = z.object({
  name: z.string(),
  input: z.unknown(),                        // 工具自己 zod 校验
  conversation_id: z.string().optional(),
  source_message_id: z.string().optional(),  // 用于 cost_records.source_id
});

export const ToolInvokeResultSchema = z.object({
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.object({
    classification: z.enum(['validation_error', 'tool_timeout', 'mcp_crashed',
                            'permission_denied', 'rate_limit', 'quota',
                            'network', 'unknown']),
    message: z.string(),
  }).optional(),
  cost: z.object({
    estimated_usd: z.number().optional(),
    actual_usd: z.number().optional(),
    tokens_in: z.number().optional(),
    tokens_out: z.number().optional(),
  }).optional(),
});
```

### 4.3 Bus 接口（`apps/sidecar/src/bus/index.ts`）

```ts
class CapabilityBus {
  register(tool: ToolImpl): void;
  list(filter?: { capability?, source? }): Tool[];
  invoke(req: ToolInvokeRequest): Promise<ToolInvokeResult>; // 自动写 cost_records
  // 以下为完整目标形态接口，M2 暂不实现：
  // getToolsFor(model): VercelAITool[];   // M3 /v1/chat/with-tools 端点上线时再加
  // recordCost(in-stream usage)            // M3 加
}

interface ToolImpl extends Tool {
  inputSchema: ZodSchema;
  estimate?: (input: unknown, ctx: BusContext) => Promise<number>;
  execute(input: unknown, ctx: BusContext): Promise<{ output: unknown; cost?: ... }>;
}
```

> M2 仅实现 `register / list / invoke` 三个方法。架构 [09 §3](../architecture/09-agent-and-tools.md) 的 `getToolsFor` / `recordCost(in-stream)` 是完整目标形态，M2 子集见此处；M3 启用 `/v1/chat/with-tools` 时再补齐。

启动时注册：

```ts
bus.register(builtinImageGenerate);
bus.register(builtinFileRead);
```

### 4.4 M2 内置工具

#### `builtin.image_generate`

```
input: { prompt: string, model_id: string }
execute:
  1. 取 model 价格快照 + 失败计数
  2. 调用 provider 适配器 `generateImage(model, prompt)` → 返回 { url | base64, mime, w, h }
  3. 写 file 落盘 + files 表
  4. 返回 { file_id, width, height, content_type }
estimate: model.price_per_call ?? 0.05  // fallback 0.05
classify_error: 复用 classifyProviderError + 'mcp_crashed'/'tool_timeout' 不适用
```

适配范围（M2 最小集）：

- OpenAI Images（DALL-E 3 via `/v1/images/generations`）
- Replicate（任意 image model 通过 model_name `<owner>/<name>:version`）
- 本地 SD WebUI（`base_url + /sdapi/v1/txt2img`）

适配器策略：依据 `provider.type` 路由（与 chat 路由一致）。新增 `provider.type='replicate'` / `'sd_webui'` 类型常量，需在 `packages/shared/src/schemas.ts` 的 ProviderTypeEnum 里**预留**（M2 实施时实际加）。

#### `builtin.file_read`

```
input: { file_id: string }
execute:
  - 从 files 表读 extracted_text；若无则按 mime 现场抽取（pdf-parse for application/pdf；utf-8 read for text/*）
  - 写回 files.extracted_text
  - 返回 { text, mime, filename, truncated }
estimate: 0  // 本地无成本
```

**安全：** `file_read` 只能读 `files.storage_path` 内的文件，禁止任意路径。

### 4.5 暴露给 chat 流的 HTTP 端点

- `POST /v1/tools/invoke` — 直接调用工具（renderer 在图像生成场景使用）
- `GET /v1/tools` — 列出已注册工具，**M2 仅供 E2E 与本地诊断使用**（无 UI 消费方）；M3 工具中心 UI 上线后启用

**M2 不**改 `/v1/chat` 协议加 `tools` 入参（M3 起加 `/v1/chat/with-tools`）。

### 4.6 范围明确

- ✅ Bus 抽象 + 注册中心
- ✅ 两个内置工具（image_generate + file_read）
- ✅ Bus 自动写 `cost_records(source_type='tool_call')`
- ✅ Bus 错误走 `classifyToolError`（与 `classifyProviderError` 共用基类）
- ❌ MCP 桥（M3）
- ❌ chat 流中的 tool_call 自动循环（M3 的 `/v1/chat/with-tools`）
- ❌ 工具中心 UI（M3）

---

## 5. 数据迁移与 schema 变更

### 5.1 新增表（无）

M2 不新增表。所有 M2 状态都用现有表 + `memories` 键值。

### 5.2 现有表的字段补充（migration 必备）

```sql
-- providers 表无 schema 变更（type 是 text 字段，新枚举值仅靠 Zod 层校验生效）
-- 但 packages/shared/src/schemas.ts 的 ProviderTypeEnum 加：'replicate' | 'sd_webui'
-- 注意：providers.api_key_ref 在 type='sd_webui' 时允许 NULL（本地 WebUI 无需 key）
--       且 providers 层不区分 chat/image capability，由 models.capability 区分

-- memories 已有，不需要 migration，只需要约定的 key 命名空间：
--   global / cost_confirm_threshold_usd
--   global / cost_confirm_image_always
--   global / cost_confirm_disabled_models       (JSON array)
--   global / cost_confirm_disabled_conversations (JSON array)
--   global / auto_fallback_enabled
--   global / image_model_default                (model_id)
--   session/<conv_id> / image_model             (model_id)
--   session/<conv_id> / intent_route_disabled_until  (ISO timestamp)
```

### 5.3 cost_records 字段使用约定（已有字段，M2 启用）

- `source_type='tool_call'`：M2 起开始写入（M1 预留）
- `feature='image'`：M2 起开始写入
- `success=false` 时 `actual_cost_usd` 仍可有值（图像 API 即便返回 4xx 也可能扣费 → 诚实记录）

---

## 6. M2 主界面变更（在 M1 基础上的增量）

```
┌──────────┬─────────────────────────────────┬──────────────────┐
│ 会话列表  │ 当前对话                         │ （仅扩展时显示） │
│ + 新建    │  ┌────────────────────────────┐ │  会话成本侧边栏  │
│           │  │ user msg                   │ │                  │
│ ──────    │  └────────────────────────────┘ │                  │
│ 设置入口  │  ┌────────────────────────────┐ │                  │
│           │  │ assistant streaming        │ │                  │
│           │  │  ~$0.00X · 234 tok ⓘ      ←│─ M2 新增          │
│           │  └────────────────────────────┘ │                  │
│           │  ┌─ failure_decision card ──┐  │                  │
│           │  │ ⚠️ GPT-4o quota...        │  │                  │
│           │  │ [改用 Haiku]            ←│─ M2 新增           │
│           │  └─────────────────────────┘  │                  │
│           │  composer ↓                   │                  │
│           │  [估价 ~$0.001]   [发送]      │                  │
└──────────┴─────────────────────────────────┴──────────────────┘
底部状态栏（M1 已有，点击打开成本侧边栏）：
本会话: $0.087  |  今日: $1.42  |  本月: $18.30
```

新增 / 重做 testid（用于 E2E）：

| testid | 出现在 | M1/M2 |
|---|---|---|
| `failure-decision-card` | 失败决策卡片根容器 | M2 新增 |
| `failure-decision-primary` | 主按钮（"改用 X"或"重试"） | M2 新增 |
| `failure-decision-secondary` | 次按钮列表 | M2 新增 |
| `failure-decision-auto-fallback-toggle` | 卡片底部的自动切换勾选 | M2 新增 |
| `cost-stream-badge` | 流式小标签 | **M1 已有，M2 重做样式与交互** |
| `cost-stream-detail` | 点开后的详情面板 | M2 新增 |
| `cost-confirm-modal` | 高成本确认弹窗 | M2 新增 |
| `cost-confirm-primary` | 确认弹窗"继续"按钮 | M2 新增 |
| `cost-confirm-disable-this-model` | "此模型不再提醒" 勾选 | M2 新增 |
| `cost-confirm-disable-this-conversation` | "本会话不再提醒" 勾选 | M2 新增 |
| `session-cost-panel` | 会话级成本侧边栏 | M2 新增 |
| `image-picker-modal` | 图像模型选择器 | M2 新增 |
| `image-picker-memory` | 三级记忆 radio 组 | M2 新增 |
| `image-picker-escape` | "我不是要画图" 逃生按钮 | M2 新增 |

### 6.1 测试钩子（dev-only）

为支持 §7 DoD 的"故意制造失败 / 强制分类" 步骤，sidecar 在 `NODE_ENV !== 'production'` 时识别以下请求 header：

| Header | 取值 | 行为 |
|---|---|---|
| `X-Test-Force-Classification` | `quota` / `network` / `rate_limit` / `content_filter` / `auth` / `unknown` | chat 流上游请求**直接抛**对应分类的合成错误，不发出真实网络请求；走 `recordFailure` + `failure_decision` annotation 正常路径 |
| `X-Test-Force-Image-Result` | `success` / `quota` / `content_filter` / `billed_4xx` | `/v1/tools/invoke` 调用 `image_generate` 时绕过 provider，按指定语义返回（`billed_4xx` = `success=false` + `actual_cost_usd>0`） |

实现位置：`apps/sidecar/src/test-hooks.ts`（仅在非 production 注册）；E2E 与集成测试通过此机制可重复触发。生产构建（`pnpm build` + production env）时整个模块为空导出。

---

## 7. M2 总验收（Definition of Done）

> 一个连贯的 8 步用户旅程，覆盖 4 大支柱。这是 E2E 必须 100% 跑通的剧本。

1. 在 M1 之上启动 → 默认有 1 chat + 1 image 模型 → 主界面正常 + 状态栏在
2. 发一条简单消息 → 流式过程中**右下角看到 `~$0.00X · NNN tok` 小标签**，throttled 不抖动 → 流结束后小标签收敛为最终成本徽章
3. 通过 `X-Test-Force-Classification: network` header 重发 → 流以 `provider_error/network` 结束 → **失败决策卡片**渲染在消息流位置 → 主按钮"重试"，次按钮含"改用其他模型"
4. 在选择器里选另一个模型重发 → 成功 → 卡片消失，新 assistant bubble 出现
5. 在偏好里勾「自动降级」→ 用 `X-Test-Force-Classification: quota` → **不再弹卡片**，对话流里出现 `[system] 已从 X 切换到 Y` 系统消息 → 之后 assistant bubble 用新模型回复
   - 紧接着用 `X-Test-Force-Classification: content_filter` → **即便开关 ON 也走决策卡片**（卡片无"换模型"按钮）
6. 输入「画一张赛博朋克咖啡店」→ chat 流以 `capability_route` annotation 结束（不发 LLM）→ 弹**图像模型选择器**，选「DALL-E 3」+「当前会话」→ **高成本确认弹窗**因 `cost_confirm_image_always=true` 出现 → 点继续 → 图像嵌入 assistant bubble（与刚才那条 user msg 通过 `parent_message_id` 关联），per-message 徽章 `image · $0.04`
7. 在确认弹窗里勾「此模型不再提醒」继续 → 再输入「再画一张」→ **不再弹选择器**（会话级偏好生效），且**不弹高成本确认**（`disabled_models` 命中即跳过，即便 `image_always=true`）
8. 点底部状态栏「本会话」→ 弹**会话成本侧边栏**，看到按模型/feature 拆分 → 数字与各 message 徽章累加一致；若有 4xx 扣费失败，行尾显示红色 "含 X 次 4xx 扣费"

### 7.1 性能预算

| 指标 | 目标 |
|---|---|
| 失败决策卡片首次渲染 | 上游错误后 ≤ 200 ms（含一次 `nextFallback` 查询） |
| 流式小标签更新节流 | 200 ms throttle，0 抖动 |
| 图像意图识别（关键词扫描） | 用户按下发送后 ≤ 5 ms（同步 regex） |
| 图像生成端到端（DALL-E 3）| 上游 + 落盘 ≤ 10 s（受 provider 限制） |
| 会话成本侧边栏首屏 | 单次 SQL ≤ 50 ms |

### 7.2 错误兜底覆盖矩阵

| 场景 | 期望 |
|---|---|
| chat `quota` | 决策卡片，主按钮"改用 nextFallback"；勾自动降级后下次切跳过卡片 |
| chat `rate_limit` | 决策卡片含双主按钮"改用其他 / 30s 后重试" |
| chat `network` | 决策卡片主按钮"重试" |
| chat `content_filter` | 决策卡片**无**"换模型"按钮（不是模型问题），只有"编辑后重试 / 取消"；不计入 failure_count_24h；**即便自动降级开关 ON 也跳过自动切换** |
| chat `auth`/`unknown` | 与 quota 相同 |
| image `quota` | 决策卡片在 image capability 内 fallback；推荐按 `nextFallback(_, 'image')` |
| image `mcp_crashed`/`tool_timeout` | M2 用本地 builtin，分类一律 `tool_timeout` 或 `network`；无 mcp_crashed |
| 图像生成成功但 provider 4xx 扣费 | `success=false, actual_cost_usd>0` 写入；徽章红色显示 + 会话侧边栏行尾 "含 N 次 4xx 扣费" |
| 自动降级开启但无可用替代 | 走决策卡片，开关失效（不让它陷入无限重试） |
| 关键词识别误判（"我画了一张油画……"） | 否定上下文白名单跳过；用户也可点图像选择器右上角 "我不是要画图" 触发 30 分钟会话级跳过 |

### 7.3 测试策略

| 层 | 工具 | 范围 |
|---|---|---|
| 单元 | Vitest（sidecar / shared / web） | `classifyToolError`、Bus 注册去重、价格分档、确认阈值偏好读取、记忆三级查询、关键词识别正则 |
| 集成（sidecar 内）| Vitest + supertest | `/v1/tools/invoke` happy + 4 类 error；`/v1/chat` 末尾 `failure_decision` annotation；自动降级单跳一次后下次走卡片 |
| 组件 | Vitest + RTL | FailureDecisionCard、CostStreamBadge throttle、ImagePickerModal、SessionCostPanel、CostConfirmModal「不再提醒」三档落库 |
| E2E | Playwright + 真实 sidecar + mock providers | M2 §7 总验收 8 步剧本；外加：内容审核拒绝路径、自动降级 1 次后回到卡片、记忆三级生效优先级 |

### 7.4 关键测试用例（必须覆盖）

- **决策卡片渲染时机**：错误流末端 200ms 内出现，且 `failure_decision` annotation 中的 `recommended_model_id` = `nextFallback(currentId, 'chat').id`
- **annotation 帧顺序**：`8:[{failure_decision}]` 必须在 `3:"provider_error/<class>"` 之前，最后 `[DONE]`（§1.3）
- **自动降级单跳上限**：开启开关后第 1 次失败自动切，第 2 次失败仍走卡片（防级联）
- **content_filter 自动降级豁免**：开关 ON + 上游 content_filter → **不切**，走决策卡片（卡片无"换模型"按钮）；不增加 `failure_count_24h`
- **图像三级记忆优先级**：session > global > 弹窗。设全局 default=A，会话偏好=B，下次画图直接用 B 不弹窗
- **关键词意图否定上下文**：`已经画过的`、`上次那张` 命中否定白名单 → 不路由到图像
- **逃生通道生效**：图像选择器点 "我不是要画图" → 30 分钟内同一会话不再触发意图路由
- **高成本确认「不再提醒」三档**：永久 / 此模型 / 本会话 写回 `memories`，下次跳过确认
- **disabled 命中覆盖 image_always**：`cost_confirm_image_always=true` 但 model_id ∈ `disabled_models` → 跳过确认（防画图工作流被反复打断）
- **会话成本侧边栏一致性**：侧边栏数字 = `Σ` 所有消息徽额，且 == `SUM(actual_cost_usd) WHERE conversation_id=?`
- **会话侧边栏 4xx 扣费可见**：`success=false AND actual_cost_usd>0` 在按模型行尾显示红色 "含 N 次 4xx 扣费"
- **Bus 写 cost_records**：每次 `/v1/tools/invoke` 都生成一条 `source_type='tool_call'` 记录
- **图像生成 4xx 扣费**：`X-Test-Force-Image-Result: billed_4xx` 触发 → `success=false, actual_cost_usd>0`
- **跨能力调用消息归属**：用户发"画一张..." → user message 写入 → capability_route + `[DONE]` → invoke image → assistant message 的 `parent_message_id` 指向那条 user message

### 7.5 不做（推迟到 M3）

- 健康状态面板（独立栏目按模型看 24h 成功率/平均耗时）
- MCP 桥（stdio / 本地 HTTP）+ 工具中心 UI
- 圆桌（多模型协作 Agent）
- 视频生成
- 远程 MCP / 自定义脚本工具
- LLM 意图分类器（用 LLM 判定意图，避免成本与时延）

---

## 8. M2 不做的事（明确切走）

避免范围蔓延，以下功能**严禁**进入 M2：

- ❌ Roundtable / 多模型圆桌（M3 标志性）
- ❌ MCP 桥（M3）
- ❌ 工具中心 UI（M3）
- ❌ 视频生成（M3 后）
- ❌ 月度预算上限 + 告警（v2）
- ❌ 智能省钱建议 / 自动模型推荐学习（v2）
- ❌ 自定义工具脚本沙箱（v2）

---

## 9. 任务到模块映射（开发分工参考）

| 模块 | M2 关注点 |
|---|---|
| `apps/sidecar/src/routes/chat.ts` | 末端追加 `failure_decision` annotation；自动降级单跳逻辑（**content_filter 跳过**）；图像意图关键词识别 + 否定上下文白名单 + 逃生窗口检查 |
| `apps/sidecar/src/routes/tools.ts`（新建）| `POST /v1/tools/invoke`、`GET /v1/tools`；走 Bus |
| `apps/sidecar/src/bus/index.ts`（新建）| Bus 抽象 + 注册中心 + 自动写 cost_records |
| `apps/sidecar/src/bus/builtins/image_generate.ts`（新建）| OpenAI / Replicate / SD-WebUI 适配；写 assistant message + `parent_message_id` |
| `apps/sidecar/src/bus/builtins/file_read.ts`（新建）| files 表读取 + pdf-parse |
| `apps/sidecar/src/test-hooks.ts`（新建，dev-only）| `X-Test-Force-Classification` / `X-Test-Force-Image-Result` header 处理；production 构建空导出 |
| `apps/sidecar/src/providers/registry.ts` | `classifyToolError` 共用基类；新 provider type `replicate` / `sd_webui` |
| `apps/sidecar/src/db/repos/index.ts` | （已有）`nextFallback` 在 capability='image' 也能用；**新增 `pickCheapestActive(capability, excludeId?)`**；`memories` repo 支持三级查询 |
| `apps/sidecar/src/db/schema.ts` / `index.ts` | 无 schema 变更；`memories` key 命名空间约定（详见 §5.2） |
| `packages/shared/src/schemas.ts` | `ProviderTypeEnum` 加 replicate/sd_webui；`api_key_ref` 在 sd_webui 时允许 NULL；新增 ToolSchema/ToolInvokeRequestSchema/ToolInvokeResultSchema |
| `packages/shared/src/tools.ts`（新建）| 上面这些 Tool* schema 集中放这里 |
| `apps/web/src/App.tsx` | failure-decision-card 渲染；cost-stream-badge 改造（throttle + 低饱和 + 点击展开）；图像意图触发拦截；session-cost-panel 侧边栏 |
| `apps/web/src/components/`（新建若干）| FailureDecisionCard、ImagePickerModal、CostConfirmModal、SessionCostPanel、CostStreamDetail |
| `apps/web/src/pages/Settings/Failure.tsx`（新建）| 自动降级开关 UI（与决策卡片底部勾选共用 `memories(global/auto_fallback_enabled)`） |
| `apps/web/src/pages/Settings/Cost.tsx`（新建）| `cost_confirm_threshold_usd` / `cost_confirm_image_always` / "清除所有跨模型记忆" 按钮 |
| `apps/web/src/hooks/useMemory.ts`（新建）| 三级记忆查询封装 |
| `apps/web/e2e/` | 新增 `m2.1-failure-decision.spec.ts` / `m2.2-cost-l3l4.spec.ts` / `m2.3-image-gen.spec.ts` / `m2.4-bus.spec.ts` / `m2.5-dod-final.spec.ts` |

---

## 10. 评审与下一步

### 10.1 评审视角

- **用户视角：** 决策卡片是否真正减少"卡住感"？三级记忆是否符合用户对"它该记多久"的直觉？高成本确认是否在「不打扰」与「不被坑」之间平衡？
- **产品视角：** M2 输出能否独立成为一次"可发布的体验升级"？还是必须配合 M3 圆桌才有完整故事？(答：可以独立发；M3 是上层增量)
- **设计视角：** 失败决策卡片在消息流中的视觉权重是否过重，导致正常对话被打断节奏？流式小标签是否真的"不焦虑"？
- **开发视角：** Bus 抽象在只跑 2 个内置工具时是否过度设计？(答：M3 MCP 接入用同一接口，预先抽象总成本低)
- **测试视角：** mock providers 能否覆盖 image_generate 的 3 种适配器？关键词识别误判（用户真的在聊"画了一张油画"而非命令）如何避免？

### 10.2 进入开发的前置 checklist

- [x] M1 已闭合（R1–R5）
- [x] 本规格通过 subagent 二次评审（用户/产品/开发/测试视角，6 HIGH + 8 MEDIUM 全部修复）
- [x] schema migration 计划（仅 ProviderTypeEnum 扩展 + `api_key_ref` 在 sd_webui 时允许 NULL）确认
- [x] mock provider 端：通过 dev-only `X-Test-Force-Classification` / `X-Test-Force-Image-Result` headers 替代多套 mock provider（参见 §6.1）
- [x] Phase 切片：建议按 4 个支柱拆 4 个 phase，每 phase 独立 review + 测试 + 修复

### 10.3 Phase 切片建议

| Phase | 内容 | 依赖 |
|---|---|---|
| **M2.1** | Failure Decision UI + 自动降级单跳 + content_filter 区别处理 | M1 fault-tracking |
| **M2.2** | Cost L3 流式小标签 + L4 高成本确认 + 三档不再提醒 + 会话成本侧边栏 | M1 cost_records |
| **M2.3** | Capability Bus 抽象 + `builtin.file_read` + `/v1/tools` 端点 + cost_records `source_type='tool_call'` 落库 | M1 files 表 |
| **M2.4** | `builtin.image_generate`（DALL-E + Replicate + SD-WebUI）+ 关键词意图识别 + 图像选择器 + 三级记忆 | M2.3 Bus |
| **M2.5** | E2E 8 步剧本（DoD §7）+ 全面 audit + 按 R1..R5 模式收尾 | M2.1–M2.4 |
