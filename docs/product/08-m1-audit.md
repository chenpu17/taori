# Taori M1 验收审计报告

> 只读审计 — 不修改任何代码  
> 基线规格：`docs/product/08-m1-spec.md` (321 行)  
> 审计范围：`apps/web/src/**`、`apps/sidecar/src/**`、`apps/desktop/src-tauri/src/**`、`packages/shared/src/**`、`apps/web/e2e/**`、`apps/sidecar/test/**`  
> 严重度：**HIGH**（阻塞 M1 验收 / 与规格语义不一致）／**MEDIUM**（功能上有缺口或测试空白）／**LOW**（文案 / 边角，建议）

---

## 总览

| 状态 | 计数 |
| --- | --- |
| ✅ 达标 | §1, §2(MC-1/2/4/5), §3(CHAT-1/2/4/5), §4(FILE-2/3), §5(L1/L2/Badge/状态条), §6 写入 / 读取 / 清空主路径, §7 DoD 1–8 |
| ⚠️ HIGH（阻塞） | §2 MC-3、§7.5.2 quota 降级 / 禁用、§7.5.2 错误分类矩阵、§7.5.2 `content_filter` 路径 |
| ⚠️ MEDIUM | §1.2 文案、§3 CHAT-3 流式估算、§4 FILE-1 自动切换、§7.5.2 abort + Keychain restart e2e、§6.2 服务级清理 |
| ⚠️ LOW | §2 MC-6 价格档划分、§3 CHAT-6 复制纯文本、§7 安装包尺寸预算未测 |

> 建议：发布 M1 前最少应修掉 4 项 HIGH。MEDIUM 可在 M1.x 补丁版本带掉。

---

## §1 Onboarding（首启 ≤ 60 秒）

### ✅ 达标项
- 启动时检测无 Provider → 引导卡（`apps/web/src/App.tsx:434–442`、`Onboarding.tsx`）
- 4 + 1 预设（OpenRouter / OpenAI / Anthropic / Ollama / 自定义）（`Onboarding.tsx:25–54`）
- Key 输入隐藏、Test & Save、Skip、自动注册 chat/vision 默认（`Onboarding.tsx:160–229`、`apps/sidecar/src/routes/providers.ts` discover + recommended）
- Skip 后可在 Settings → "添加 Provider" 重新打开（`Settings.tsx:107–116`）

### ⚠️ MEDIUM-1 验证失败时文案非中文
- **位置**：`apps/sidecar/src/providers/registry.ts:42–63` → 401 / 403 → `unknown`，message 为英文 `"Authentication failed"`；上抛后 `Onboarding.tsx:189–203` 直接展示 `error.message`。
- **Spec vs Code**：§1.2 line 36 要求 "Key 无效 → 出现 ⚠️ 'Key 无效' …中文带可点链接"。当前显示英文且无操作链接。
- **建议**：在 Onboarding/Settings 客户端把 `error.classification = 'unknown' | 'quota' | 'rate_limit'` 与 `code === 'unauthorized'` 都映射成中文文案；可复用 `App.tsx:945–966` 现有 `errorMessageMap`，把 `Test & Save` 路径接进来。

---

## §2 Model Configuration Center

### ✅ MC-1（多 Provider 并存）
- `Onboarding` 与 `Settings.tsx:107–145` 均允许 N 个 Provider；候选区按 capability 列出，自动勾选默认（`Settings.tsx:218–270`）。

### ✅ MC-2（单一默认 / 动态切换）
- `ModelsRepo.setDefaultFor`（`db/repos/index.ts:238–252`）事务清空旧默认 → 设新默认。
- 顶栏 `<select>` 切换在 `App.tsx:824–834` 即刻生效，仅作用于"下次请求"。

### ⚠️ HIGH-1 MC-3 优先级 / 回退链未接到任何接口或 UI
- **位置**：
  - DB 已有字段 `apps/sidecar/src/db/schema.ts:59` (`fallback_order`)、`apps/sidecar/src/db/index.ts:40`，`ModelsRepo.create` 写默认值 0（`db/repos/index.ts:198`）。
  - **但** `ModelsRepo.update`（`db/repos/index.ts:212–232`）**不接收** `fallback_order`；`packages/shared/src/schemas.ts:99–123` 的 `ModelCreateSchema` / `ModelUpdateSchema` 不暴露该字段。
  - `Settings.tsx:11` 自己注释："MC-3 fallback order — needs `priority` field on models + drag UI."（开发者认为字段缺失，实际 DB 有，但 zod 没透出）
  - 没有任何代码路径在 4xx/5xx 后真的"用下一条"，§2.1 line 81 的回退链事实上不存在。
- **Spec vs Code**：§2 MC-3、§2.1 line 81 要求 "默认 + 回退链 = 一组有序模型 ID"；当前回退链既不可写、也不可读、也不参与运行时调度。
- **建议**：
  1. 把 `fallback_order` 加进 `ModelUpdateSchema`（`z.number().int().nonnegative().optional()`）和 `ModelsRepo.update` 的 set 列表，使字段可被任何客户端写入。
  2. 在 `chat.ts` 的上游错误处理（注释中已规划 §2.1 line 81 的回退）至少为 `quota`/`rate_limit`/`network` 三类做一次"按 fallback_order 取下一条"的尝试，否则 §2.1 line 81 / §7.5.2 line 274 都无法满足。
  3. UI 拖拽虽然规格已声明"M2 再做"（line 96 已隐含），但**API 必须先就位**，否则 M2 无法拖完即生效。

### ✅ MC-4（连通性自检）
- `apps/sidecar/src/routes/models.ts:145–194` `POST /v1/models/:id/test`：用真实 `generateText({ maxTokens: 1 })` + 8s `AbortSignal.timeout`，错误经 `classifyUpstream` 映射，UI 在 `Settings.tsx:329–355` 渲染分类徽章。

### ✅ MC-5（启用 / 禁用）
- `Settings.tsx:281–285` toggle → `PATCH /v1/models/:id { enabled }`；下次顶栏 `<select>` 不再列出。

### ⚠️ LOW-1 MC-6 价格分档与规格不完全一致
- **位置**：`packages/shared/src/cost.ts:16–23` — 实现 3 档：`<$0.5 cheap`、`<$5 standard`、`≥$5 premium`（注释明示已合并）。
- **Spec vs Code**：§5.1 line 202 "按 input price < $0.5/$5/$15 per 1M" 暗示 **4 档**（< 0.5 / 0.5–5 / 5–15 / ≥15）。当前所有 ≥$5 都标 "premium"，看不出"超贵 ≥15"。
- **建议**：新增 `flagship`（≥15）档；或在 spec 中正式合并这两档（与开发者注释一致）。一行修复即可。

---

## §3 Chat（基础对话）

### ✅ CHAT-1 流式 + 中止
- 流式写出 `0:"…"` token-delta、`8:[…]` cost-meta、`d:`/`e:` finish（`apps/sidecar/src/routes/chat.ts:186–193`、`354–373`、`503–514`）。
- 中止：渲染端 `App.tsx:733–739` 调 `useChat.stop()`；服务端 `chat.ts:354–364` finalize 时 `status='incomplete'`，cost record `success=false`、`actual_cost_usd=null`。

### ✅ CHAT-2 中途切模型
- `App.tsx:249, 305` — `model_id` 仅作用于"下一次请求"，不回写历史消息行。

### ⚠️ LOW-2 CHAT-3 流式期间不显示 "≈$0.00X"
- **位置**：`chat.ts:503–514` cost annotation 仅在 `finalizeOnEnd` 中产出；`App.tsx:638–643` 的 `costMap` 也只有结束后才填。
- **Spec vs Code**：§3 CHAT-3 line 156 "流式时显示 ~$0.00X"；但 §5.2 line 213 "实时跳变估算（M2）" — **规格内部矛盾**。从 §5.2 的优先级看应理解为 M2 才做。
- **建议**：要么把这条从 §3 CHAT-3 删掉避免误导，要么在结束前临时把 EstimateBar 的"区间下限"用作流式占位（一行 UI 即可）。

### ✅ CHAT-4 历史 / 自动标题
- `chat.ts:101–109` 首条 user 截前 30 字符填 title；`App.tsx:489–515` 顶栏 ↔ Sidebar `loadConversation` 流畅。

### ✅ CHAT-5 多对话
- 侧栏 `App.tsx:278–303` 新建 / 切换 / 删除 / 重命名齐全。

### ⚠️ LOW-3 CHAT-6 复制未去 Markdown
- **位置**：`App.tsx:782–804` `copyToClipboard(m.content)` 直接写入原始 markdown 串。
- **Spec vs Code**：§3 CHAT-6 line 159 "复制 = 纯文本（去 markdown）"。当前用户复制粘贴到非 MD 编辑器会看到 `**bold**`、`# heading` 这类语法。
- **建议**：引入 `remark-strip-markdown` 或在 `copyToClipboard` 前用一个简单 regex（去掉 `[*_`#~>`]`、围栏代码、链接 `[](…)`）转纯文本。

---

## §4 File Drop（轻附件）

### ⚠️ MEDIUM-2 FILE-1 视觉模型未自动切换
- **位置**：`App.tsx:677, 743, 850–854` 仅渲染 ⚠️ "当前模型不支持视觉，发送将失败" 并禁用 Send；`chat.ts:111–118` 服务端把不支持视觉的模型 + image attachment → 422 `validation_error`。
- **Spec vs Code**：§4 FILE-1 line 181 "图（PNG/JPG/WebP）→ 自动切换到 vision 模型并附图发送"。**未实现自动切换**，仅兜底警告。
- **建议**：在 `App.tsx:677` 检测到不支持视觉 + 已附图时，调用 `ModelsApi` 找出 `is_default_for === 'vision'` 的模型并自动 `setActiveModelId`；保留警告作为 fallback（用户没配置 vision 默认时）。

### ✅ FILE-2 PDF 拒绝（已声明 deferred）
- `chat.ts:123–130` → `validation_error: PDF 解析尚未上线`。e2e `m1.7-r4-files-cost.spec.ts:31–49` 覆盖。规格 line 182 显式 deferred，符合。

### ✅ FILE-3 拖入失败有可见提示
- `App.tsx:701–705`、`classifyDropFile:868–877`、UI 在 `App.tsx:850–862` 渲染 `dropError`。

---

## §5 Cost Transparency

### ✅ L1 真实成本（消息行下方）
- `chat.ts:503–514` cost annotation；`App.tsx:638–643` `costMap`，渲染 `≈$X` 与 calls。

### ✅ L2 发送前预估
- 前端：`App.tsx:563–598`、`EstimateBar:915–946`，输入字符 → tokens → 区间 / 单点。
- 后端：`apps/sidecar/src/routes/costs.ts:38–45` `GET /v1/costs/avg-output-tokens`；`packages/shared/src/cost.ts:114–145` 样本 < 5 → 区间，≥ 5 → 单点。
- 单元测试：`apps/sidecar/test/costs.test.ts:36–105` 覆盖 realtime + actual cost 写入。

### ✅ Badge 与状态条
- 价格 Badge：`App.tsx:824–834` 顶栏每个模型项显示 "🟢 / 🟡 / 🔴" + 美元价位。
- 底部状态条：`App.tsx:879–907` `current / today / month` 三档。

### ✅ 报错 banner
- `App.tsx:945–966` `errorMessageMap` 覆盖 `provider_error/{quota,rate_limit,network,content_filter,unknown}` + `unauthorized` + `validation_error`。

> **唯一遗憾**：`content_filter` 文案虽已在 UI 端就位（`App.tsx:952`），后端从未真正产出这一分类（见 HIGH-3）。

---

## §6 Keychain（Keychain → Sidecar → Renderer）

### ✅ 写入 / 读取 / 删除
- 渲染端从不接触明文：Provider 创建走 `POST /v1/providers`，Sidecar 通过 control channel 调 Tauri Rust：
  - `apps/sidecar/src/control/client.ts:19, 72–101` — `service` 默认 `app.taori.desktop` 全局常量 ✅。
  - `apps/desktop/src-tauri/src/control.rs:96–117` — `keyring::Entry::new(service, account).set_password(secret)` 等。
- `keystore.ts:32, 47` 走 control channel；生产构建 `keystore.ts:66–74` 没 control channel 直接拒启动。
- 验证：`apps/sidecar/test/providers.test.ts:115–131, 200–202` 写读 + 删除-级联场景。

### ✅ 清空全部数据（Settings → "Reset App"）
- `apps/sidecar/src/routes/admin.ts:30–55`：先收集所有 `api_key_ref` → wipe SQLite → 逐个 `delete` Keychain 条目（best-effort）。

### ⚠️ MEDIUM-3 §6.2 line 227 "按 service 全量删除" 的边角缺失
- **位置**：`admin.ts:30–55` 仅按 DB 中存在的 `api_key_ref` 删；如果 DB 行先异常被删、Keychain 残留（"孤儿"），不会被清掉。
- **Spec vs Code**：§6.2 line 227 显式说"按 service=`app.taori.desktop` 全量删除"。
- **建议**：control channel 增加 `POST /v1/keychain/delete-by-service`；macOS 由 `Security.framework` `SecItemDelete(service)` 支持，Windows Credential Manager 用 `CredEnumerate("app.taori.desktop:*")`。可在 M1.1 补；当前留为已知限制即可。

### ⚠️ MEDIUM-4 §7.5.2 line 274 "Sidecar 重启 → 取 Key" 无 e2e 测试
- **位置**：`apps/sidecar/test/providers.test.ts` 只覆盖单进程内 write/read；没有"Sidecar 进程重启后第一次调用 chat 仍能从 Keychain 取出 Key"的端到端验证。
- **Spec vs Code**：§7.5.2 line 274 显式列入"必须验证"。
- **建议**：新增一个 vitest，buildServer → write → close → buildServer（同 `dbPath`）→ inject `/v1/chat`，断言 `keystore.read` 命中（用 MemoryStore 替身或 FakeControl）。

---

## §7 DoD（8 步演练）

### ✅ DoD 1–8 主路径覆盖
- `apps/web/e2e/m1.8-dod-final.spec.ts` 走完 8 步：Onboarding → 对话 → 切模型 → 视觉警告 → 错误 banner → 重启持久化 → 清空 → 重新走 onboarding。

### ⚠️ LOW-4 step 4 走的是"非视觉模型 + 警告"路径，非 spec 的"happy path"
- **位置**：`m1.8-dod-final.spec.ts:13` 注释"happy-path image-on-vision is m1.4b last test."
- **Spec vs Code**：spec line 239 step 4 = "拖入图片 → **看到自动切换视觉模型** + 得到图像描述" — 当前 happy-path 被拆到 `m1.4b-file-drop.spec.ts`，且因 HIGH-2（自动切换未实现），m1.4b 实际只验证"已选 vision 模型 → 附图发送成功"。
- **建议**：HIGH-2 修完后，把 m1.8 step 4 改成 happy path，更贴 spec 文字。

### ⚠️ 未测：安装包尺寸预算
- spec line 252 "应用启动 ≤ 3s; .dmg < 60MB; .msi < 50MB"。当前没有 CI 任务检查 bundle 尺寸（`tauri build` 产物不在 e2e 范围）。
- **建议**：M1 发布前手工执行一次 `pnpm tauri build` 并记录尺寸；M2 加入 CI gate。

---

## §7.5.2 关键路径专项（**最严苛**）

| # | 关键路径 | 状态 | 位置 / 备注 |
| --- | --- | --- | --- |
| 1 | Keychain 写 / 读 / 删 / 清空 / Sidecar 重启取 Key | ⚠️ MEDIUM-4 | 单进程已测，重启场景缺 e2e |
| 2 | 错误分类矩阵（401 / 402 / 429 / content_filter / 网络抖动） | ⚠️ HIGH-2 | 见下 |
| 3 | quota 重复 → 3 次降级 / 5 次禁用 24h | ⚠️ HIGH-3 | 见下 |
| 4 | 流式 abort → cost_records 仍 rollup | ✅ 后端逻辑正确（`chat.ts:354–364`），但缺 e2e |
| 5 | attachments 注入图（非视觉模型）→ validation_error | ✅ `apps/sidecar/test/chat.test.ts:198–227` |
| 6 | 重启后 SQLite 数据可恢复 | ✅ `m1.8-dod-final.spec.ts` step 6 |

### ⚠️ HIGH-2 错误分类矩阵 — `content_filter` 永远不会被产生 + 401/402/429 无单元测试
- **位置**：`apps/sidecar/src/providers/registry.ts:42–81` —
  - 401/403 → `unknown`（spec 期望，✅）
  - 402 → `quota`（✅）
  - 429 → `rate_limit`（✅）
  - 5xx / `cause.code` / `AbortError` → `network`（✅）
  - **未实现 `content_filter`**：上游通常在 200 响应 body 里以 `finish_reason="content_filter"` 或 4xx + 特定 message 返回，registry.ts 既不识别 finish_reason 也不识别"safety/filter"关键字。
- **测试缺口**：
  - `apps/sidecar/test/providers.test.ts:78–96` 只测 401 → `unknown`。
  - `apps/sidecar/test/chat.test.ts:157–196` 测了 401 上游，但只断言 "either 3: line or finishReason error"，**未断言 classification 字段**。
  - 402 / 429 / `content_filter` 的分类映射 **完全没有用例**。
- **Spec vs Code**：§7.5.2 line 273 "上游 401/402/429/content_filter / 网络抖动" 五类**全部**要在 banner 中显示对应分类。
- **建议**：
  1. 在 `registry.ts:classifyUpstream` 加 `content_filter` 分支（关键词或显式 status）。
  2. 在 `chat.ts` 流式分支里检测 OpenAI 兼容的 `choices[0].finish_reason === 'content_filter'`，把 finish 转为 `3:` 错误行 + classification。
  3. 在 `providers.test.ts` 新增 4 个用例（402, 429, content_filter, AbortError），断言 `body.error.classification` 字符串值。

### ⚠️ HIGH-3 quota 重复 → 降级 / 禁用 逻辑**完全缺失**
- **位置**：搜索 `failure_count_24h` / `demoted` / `disabled_until` 在 `apps/sidecar/src/`：
  ```
  apps/sidecar/src/db/schema.ts:61–63    ← 字段定义
  apps/sidecar/src/db/index.ts:42–44     ← raw DDL
  apps/sidecar/src/db/repos/index.ts:200–202   ← create 时只塞默认值
  ```
  **没有任何 update/读路径**：
  - `chat.ts` 上游错误时不递增 `failure_count_24h`；
  - `ModelsRepo` 没有 `incrementFailureCount` / `demote` / `disableUntil`；
  - `defaultFor()` 不过滤 `demoted=true` 或 `disabled_until > now`。
- **Spec vs Code**：§7.5.2 line 274 显式 "**3 次 quota → demoted, 5 次 → disabled_until 24h**"。是关键差错。
- **建议**：
  1. `ModelsRepo` 增加 `recordFailure(modelId, classification)`：滑窗（24h）累加；命中阈值时写 `demoted=true` 或 `disabled_until = now + 24h`。
  2. `chat.ts` 在 `finalizeOnEnd` failed 分支或 `3:` 错误行触发后调用之；只在 `classification ∈ {quota, rate_limit}` 计数。
  3. `defaultFor()` 与顶栏 `<select>` 列表过滤 `demoted = false AND (disabled_until IS NULL OR disabled_until < now)`。
  4. 加单元测试：连续 3 次 402 → row 的 `demoted` 变 true；第 5 次 → `disabled_until` 大致等于 now+24h。

> 📌 注：HIGH-3 与 HIGH-1（fallback_order 不可写）同根：M1 已经把 schema 字段都建好但**忘了把动作绑上**，MC-3 + 降级 / 禁用合起来就是 §2.1 自我修复路径。

---

## 推荐修复顺序

1. **HIGH-2 + HIGH-3**（错误分类与降级是 §2 的核心承诺，发布前必修）
2. **HIGH-1**（API 透出 `fallback_order` 字段；UI 拖拽允许 M2）
3. **MEDIUM-2**（视觉模型自动切换 — 用户体验显著）
4. **MEDIUM-1 + MEDIUM-4**（中文文案 + Keychain restart e2e）
5. **MEDIUM-3 / LOW-1 ~ LOW-4**（M1.x 补丁带掉）

完成 1–3 后再走一遍 `m1.8-dod-final.spec.ts` 即可达到规格 §7 的"心理验收线"。
