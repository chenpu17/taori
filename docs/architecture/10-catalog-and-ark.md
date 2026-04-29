# Catalog & Volcengine Ark — 架构

> 配套产品规格：`docs/product/11-m2.5-spec.md`
> 上游：`08-api-contracts.md`（HTTP 合同）、`09-agent-and-tools.md`（capability bus）

---

## 1. Catalog 子模块

### 1.1 模块边界

```
apps/sidecar/src/catalog/
└── index.ts        — syncCatalog(): 调度 + diff
```

**输入**：`provider.enabled = true` 且 `type ∈ {openrouter, volcengine_ark}` 的 Provider 列表。
**输出**：`{ ok, synced_at, total_*, diffs[], errors[] }`，并副作用写库。
**依赖**：
- 上：HTTP route `/v1/catalog/sync`（routes/catalog.ts）、定时器（`bootstrap` 启动时 + 24h 轮询）
- 下：`providers/registry.ts`（discover 函数）、`db/repos/index.ts`（ModelsRepo）

### 1.2 数据流

```
User click "🔄 同步价格"
   │
   ▼
POST /v1/catalog/sync
   │
   ▼
catalog.syncCatalog()
   │
   ├── for each enabled provider:
   │     │
   │     ├── try discover(provider) → DiscoveredModel[]
   │     │     ├── openrouter → fetch /models  → openRouterToDiscovered()
   │     │     └── volcengine_ark → ARK_FAMILIES (内置)
   │     │
   │     ├── for each discovered:
   │     │     ├── exists in DB? 
   │     │     │     ├── no  → diff{change:'new'}（仅记录，不自动 createModel）
   │     │     │     └── yes → 比对价格字段
   │     │     │           ├── 变化 → diff{change:'price_changed'} + ModelsRepo.patchPricing()
   │     │     │           └── 未变 → ModelsRepo.patchPricing({}) （触发 price_synced_at 刷新）
   │     │     │
   │     │     └── 用户字段（display_name 别名等）始终保留
   │     │
   │     └── catch err → errors.push({provider_id, error})
   │
   └── return aggregate
```

### 1.3 关键不变量

- **价格同步只 PATCH，不 INSERT**：用户必须显式"导入"模型，避免 376 个 OR 模型一次性涌入。
- **`price_synced_at` 永远在 patchPricing 中刷新**，即便 patch object 为空 — 这给 UI 提供了"上次同步时间"。
- **per-Provider 错误隔离**：单个 Provider 失败不阻断其他；失败信息收集到 `errors[]`。
- **用户覆写不丢**：`alias`、`enabled`、`tags`、`display_name`（用户编辑过的）不被价格同步覆盖。

---

## 2. Volcengine Ark Provider Adapter

### 2.1 为什么不用云端 API 列举

火山方舟的 endpoint 是用户在控制台手动开通后获得的自定义 ID（如 `ep-20240819-xxx`），云端 SDK 没有"列出我所有 endpoint"的开放接口。强行抓取会：
1. 需要主账号 AK/SK，违背 BYOK + endpoint API Key 的设计。
2. endpoint 名称无意义，无法回推到模型 family / 价格。

因此 M2.5 采取**内置 ARK_FAMILIES**策略：以模型家族（doubao-1-5-pro、doubao-1-5-vision、wan-2-1、seedance）为 first-class 实体，用户在 ModelCenter 导入家族后，再在 `alias` 字段写入自己的 endpoint ID 作为实际调用 ID。

### 2.2 ARK_FAMILIES 表（节选）

| family | capability | modalities | input ¥/1M | output ¥/1M | per_image $ | context |
|---|---|---|---|---|---|---|
| doubao-1-5-pro-32k | chat | text | 0.8 | 2.0 | — | 32768 |
| doubao-1-5-pro-256k | chat | text | 5.0 | 9.0 | — | 262144 |
| doubao-1-5-vision-pro-32k | multimodal | text+image | 3.0 | 9.0 | — | 32768 |
| wan-2-1 | image | text | — | — | 0.04 | — |
| seedance-1-0-pro | video | text | — | — | per-second | — |

CNY → USD 用常量 `CNY_TO_USD = 1 / 7.0`，UI 上标注"价格估算"。

### 2.3 何时升级表

- 火山官网价格调整 → 升 ARK_FAMILIES 常量 → 用户下次同步即生效（`price_changed` diff）。
- 新增家族 → 加表 + 加 capability 推断 → 同步后呈现为 `new`。

---

## 3. Capability Routing v2 与 Tools 集成

```
User message
   │
   ▼
detectImageIntent()  ──── hit ───→ fast-path: image picker → image_generate.invoke
   │
   miss
   ▼
chooseChatModel() → if hasImageModel: attach tools=[image_generate]
   │
   ▼
provider.streamChat()
   │
   ├── tool_call → bus.invoke('image_generate', args)
   └── plain → text stream
```

互斥保证：fast-path 命中后**不再**走 chat 链路（`return earlyResolved`），所以 LLM 不会同时收到工具描述。

---

## 4. 风险与权衡

| 风险 | 缓解 |
|---|---|
| Ark 价格表过时 | UI 显示"价格估算" + 文档注明升级流程；用户可手动 PATCH `price_*` 字段覆盖 |
| OR 376 个模型 diff 太大 | UI 折叠展示；只显示 `new` + `price_changed`，相同价格不进 diff |
| 用户误删 Provider 后价格残留 | 模型不会被级联删除（避免误删历史会话引用），但价格同步会忽略其 model |
| Ark family 增量需要硬编码 | 接受成本（更新频率低，且每次都是显式 PR）；后续可改为远程 catalog JSON |

---

## 5. 测试矩阵

| 测试 | 位置 | 验证 |
|---|---|---|
| `m2-5-catalog-sync.test.ts > persists price diffs and refreshes price_synced_at on subsequent sync` | sidecar | 价格 diff + `price_synced_at` 始终刷新 + 用户字段保留 |
| `m2-5-catalog-sync.test.ts > reports per-provider errors without aborting other providers` | sidecar | 错误隔离 + 部分成功 |
| 手动 Playbook（M2.5 spec §3） | 用户 | 端到端 UI 流程 |
