# 08 · M1 详细规格（开发就绪）

> **目标读者：** 即将动手开发 M1 的工程师与设计师。
> **本文目的：** 把 [07-mvp-roadmap.md](./07-mvp-roadmap.md) 中 M1 的功能项展开为**可估时、可验收、可演示**的最小单元。

## M1 一句话目标

> 用户配好至少一个模型 → 能稳定聊天 → 能看到本次对话花了多少钱 → 能拖入图片让支持视觉的模型读图 → 关闭重启后数据与配置都还在。

**成功指标：** 一位 BYOK 用户从下载安装到完成第一次有意义的对话，**< 5 分钟**。

---

## 1. 首启动与上手流程（Onboarding）

> M1 的"第一印象"。糟糕的 onboarding 会让 BYOK 用户直接关闭。

### 1.1 首启动流程图

```
[安装并启动]
    ↓
[欢迎页]                                    ← Step 1
    "Taori · 把多个模型织成一条不断的工作流"
    [开始配置]
    ↓
[选择接入方式]                              ← Step 2
    ● OpenRouter（推荐 · 一个 Key 接入数百模型）
    ○ 直连 OpenAI
    ○ 直连 Anthropic
    ○ 自定义 OpenAI 兼容端点（providers.type='custom'）
    ○ 暂不配置（仅浏览）
    ↓
[填入 API Key]                              ← Step 3
    输入框（密码态显示，可粘贴）
    [验证连接]  → 后端调用 provider 列表接口
    ↓
[选择默认模型]                              ← Step 4
    展示 provider 返回的可用模型列表
    用户至少勾选 1 个聊天模型作为默认
    （OpenRouter 场景下推荐：默认勾选 3 个性价比模型）
    [完成]
    ↓
[进入主界面]                                ← 用户立刻可以发第一条消息
    顶部友好提示："试试发一句话，或拖入一张图片"
```

### 1.2 验收标准

- [ ] 用户在欢迎页看到品牌名 + slogan + 一个明确 CTA
- [ ] OpenRouter 路径下用户操作 ≤ 3 步（① 选接入方式 ② 输 Key 并通过验证 ③ 确认默认模型）
- [ ] 验证 Key 失败时，提示**具体原因**（401 = "Key 无效"；网络 = "网络异常，请检查代理"），而不是笼统报错
- [ ] "暂不配置" 路径允许用户进入主界面浏览，但发送框置灰并提示"请先配置至少一个模型"
- [ ] Onboarding 在用户主动跳过或完成后，不再自动出现
- [ ] 用户可在设置中重新打开 Onboarding（用于二次配置）

### 1.3 非功能要求

- 整个流程纯本地 + 单个 provider 调用，**不依赖任何 Taori 自有服务**
- API Key 输入后立即写入 OS Keychain；内存中不长期持有

---

## 2. 模型配置中心（轻量版）

### 2.1 信息架构

```
设置 / 模型
├─ Providers 列表
│  ├─ OpenRouter (已连接 ✓)
│  ├─ OpenAI (未连接)
│  └─ [+ 添加 Provider]
│
├─ Models 列表（按 capability 分组）
│  ├─ 💬 聊天
│  │  ├─ ⭐ Haiku 3.5 (默认)              [↕] [⋯]
│  │  ├─    GPT-4o                       [↕] [⋯]
│  │  └─    Claude Sonnet 4              [↕] [⋯]
│  ├─ 🎨 图像（M1 仅可配置，不会被消费 — 图像生成将在 M2 启用）
│  │  └─ ⭐ DALL·E 3 (默认)               [↕] [⋯]
│  └─ [+ 添加模型]
│
└─ 其他设置（货币 / 高成本阈值 / 自动降级 等）
```

### 2.2 用户故事

| ID | 作为...我希望...以便... | 验收标准 |
|---|---|---|
| MC-1 | 作为新用户，添加一个 OpenRouter Provider 并自动拉取所有可用模型 | (a) 输入 Key + Base URL → 测试通过 (b) 自动拉取 ≥ 100 个模型供勾选 (c) 单价信息自动填入 |
| MC-2 | 作为用户，给一个聊天模型设置为该 capability 的"默认" | 默认标识同步反映在主界面模型选择器；同 capability 内只能有一个默认 |
| MC-3 | 作为用户，调整同 capability 内的"备援顺序" | 拖拽排序立即生效；顺序持久化 |
| MC-4 | 作为用户，对一个模型执行"可用性检测" | 后端发出最小 ping（如 1-token 调用或 list 接口），返回成功/失败 + 延迟 |
| MC-5 | 作为用户，临时禁用某模型而不删除 | 禁用后该模型从选择器隐藏，但配置保留 |
| MC-6 | 作为用户，看到每个模型的**价位徽章** | 💰 / 💰💰 / 💰💰💰 三档，按 input price 阈值自动归类 |

### 2.3 OpenRouter "一键导入" 具体实现

1. 用户输入 OpenRouter API Key
2. Sidecar 调 `GET https://openrouter.ai/api/v1/models` 获取完整列表
3. UI 弹出多选框，按"性价比"排序，**默认勾选** 3 个：
   - 一个低价快速（Haiku 3.5 / GPT-4o-mini）
   - 一个高质量（Claude Sonnet / GPT-4o）
   - 一个开源（DeepSeek / Llama 3.x）
4. 用户确认后批量写入 `models` 表，单价信息直接来自接口返回

### 2.4 范围明确

**M1 必含：**
- Provider CRUD
- 模型 CRUD（含 capability、单价、上下文长度、vision 支持位）
- 默认模型 + 备援顺序
- 可用性检测（一键 ping）
- OpenRouter 一键导入

**M1 不做（移到 M2/v2）：**
- 完整能力卡（擅长/不擅长描述、稳定性评分、用户评分）
- 配置模板市场
- 健康状态面板（24h 成功率/平均耗时图）
- 模型组（fallback group）—— M2 引入

---

## 3. 单模型聊天（流式）

### 3.1 主界面布局（M1）

```
┌────────────────┬──────────────────────────────────────────┐
│ 会话列表        │ 当前对话                                   │
│                │                                            │
│ 🆕 新对话       │ ┌──────────────────────────────────────┐  │
│                │ │ User: 帮我总结这段文字                 │  │
│ ─ 今天 ─       │ └──────────────────────────────────────┘  │
│ • 周报草稿      │ ┌──────────────────────────────────────┐  │
│ • PDF 解读      │ │ Assistant (Haiku · ~$0.0003): ...    │  │
│                │ │ [■流式输出中]                         │  │
│ ─ 昨天 ─       │ └──────────────────────────────────────┘  │
│ • 旅行计划      │                                            │
│                │                                            │
│                │ ┌──────────────────────────────────────┐  │
│                │ │ [💬 Haiku ▼] [📎] 输入消息...    [↑] │  │
│                │ └──────────────────────────────────────┘  │
│ ⚙ 设置         │ 本会话: $0.012 (4次) │ 今日: $0.34 │ 本月: $5.62  │
│ 📊 成本看板    │                                            │
└────────────────┴──────────────────────────────────────────┘
```

### 3.2 用户故事

| ID | 作为...我希望...以便... | 验收标准 |
|---|---|---|
| CHAT-1 | 发一条消息，看到流式回复 | 首字节 < 2s；流式无明显卡顿；abort 按钮可中断 |
| CHAT-2 | 在选择器切换当前对话使用的模型 | 切换立即生效，**仅作用于下一条**消息；当前已发出的消息归属不变 |
| CHAT-3 | 看到当前消息的成本徽章 | 流式时显示"~$0.00X"；完成后显示精确成本 |
| CHAT-4 | 创建新对话 / 切换历史对话 | 切换瞬间加载历史消息（< 200ms）；标题自动从首条消息生成 |
| CHAT-5 | 删除 / 重命名对话 | 删除二次确认；重命名 inline 编辑 |
| CHAT-6 | 复制消息内容 / 重新生成 | 复制 = 纯文本（去 markdown）；重新生成 = 用相同 prompt 再调一次（计入新成本记录） |

### 3.3 范围明确

**M1 必含：** 单模型聊天、流式、abort、历史会话、自动标题、复制、重新生成、消息级成本徽章。

**M1 不做：**
- 跨模型工具调用（聊天中弹出图像模型选择）→ M2
- **失败兜底"决策型推荐换模型"按钮 → M2**（M1 错误流已携带 `suggestions`，但 UI 仅展示"重试" + 错误分类文案，不渲染换模型按钮）
- 圆桌入口 → M3
- 编辑已发消息 → v2

> **价值闭环说明：** M1 不交付"推荐换模型"，与 [07-mvp-roadmap.md](./07-mvp-roadmap.md) 的描述一致——首个完整价值闭环（含"失败时换模型"）由 M1+M2 合并交付。

---

## 4. 文件拖入聊天（图片优先）

### 4.1 用户故事

| ID | 作为...我希望...以便... | 验收标准 |
|---|---|---|
| FILE-1 | 拖一张本地图片到对话区，发送给视觉模型 | 拖入后显示缩略图；自动切换到 vision 模型；如当前模型不支持视觉，提示并建议切换 |
| FILE-2 | 拖入 PDF / 纯文本，作为附件发送 | PDF 用 `pdf-parse` 抽取文本；> 长上下文容量时提示"内容过长，请改用支持长上下文的模型" |
| FILE-3 | 拖入不支持的文件类型 | 明确提示"暂不支持 .xxx 类型"，不静默失败 |

### 4.2 范围明确

**M1 必含：** 拖入 PNG/JPG/WebP/PDF/纯文本；自动切视觉模型；附件缩略图。

**M1 不做：** 批量拖入、文件夹拖入、剪贴板粘贴图片（M2）、Office 文档解析（v2）。

---

## 5. 成本透明 L1 + L2

> 详细哲学见 [03-cost-transparency.md](./03-cost-transparency.md)。本节是 M1 必交付清单。

### 5.1 必交付项

| 项 | 位置 | 验收 |
|---|---|---|
| 价位徽章 💰 | 模型选择器、模型管理列表 | 三档分类规则在文档中固化（按 input price < $0.5/$5/$15 per 1M） |
| 发送前预估 | 输入框上方或发送按钮副文 | 预估 = 编码 input tokens × input 单价 + 历史平均 output tokens × output 单价；样本 < 5 时显示区间 |
| 调用后实际成本 | 每条 assistant 消息底部小字 | 显示精确金额 + 模型名 |
| 会话/今日/本月累计 | 主界面底部状态栏（常驻） | 切换会话立即更新；今日/本月跨会话累加；与合同 [08-api-contracts.md `/v1/costs/realtime`](../architecture/08-api-contracts.md#get-v1costsrealtime) 一致 |

### 5.2 不做

- 流式过程实时跳动金额 → M2（保留为"展开后才看明细"）
- 高成本前置确认 → M2
- 月度聚合 / 按功能聚合 → M2 仪表盘

---

## 6. OS Keychain 存 API Key

### 6.1 必交付项

- macOS：Keychain Access 中可见条目，service = `app.taori.desktop`，account = `provider:<id>`
- Windows：Credential Manager 中可见
- Linux：通过 Secret Service (libsecret) 写入；**M1 不实现加密文件 fallback** —— 系统未运行 Secret Service 时直接报 `keychain_error` 并提示"请安装/启动 GNOME Keyring 或 KWallet"。Linux 在 M1 列为"尽力支持"，主测试矩阵为 macOS arm64 + Windows x64
- Sidecar 启动时**不主动**预加载所有 Key；按需在调用时通过 Sidecar↔Rust 控制通道拉取
- 删除 Provider 时**同步删除**对应 Keychain 条目（避免残留）

### 6.2 验收

- [ ] 完全卸载 Taori 后，重新安装能否读到上次保存的 Key？应**能**（Keychain 条目不随卸载清理 —— 这是符合预期的）
- [ ] 用户主动"清空所有数据"按钮（设置页"危险区"，二次确认）→ 同步清理 SQLite 数据 + 与本应用相关的 Keychain 条目（按 service=`app.taori.desktop` 全量删除）
- [ ] Sidecar 进程崩溃重启后，下次调用仍能正确取到 Key

---

## 7. M1 总验收（Definition of Done）

一个新用户从零开始，能完成下面这条链路且不报错、不卡死、不丢数据：

1. 下载安装 Taori
2. 通过 onboarding 用 OpenRouter Key 配好默认模型
3. 在主界面发一条普通消息 → 看到流式回复 + 实际成本
4. 拖入一张图片 → 看到自动切换视觉模型 + 得到图像描述
5. 在模型选择器切换到另一个模型 → 发下一条消息
6. 关闭应用 → 重启 → 历史会话与配置仍在
7. 在底部状态栏始终能看到本会话与今日累计成本
8. 进入设置可以新增/删除模型，调整默认与备援顺序

**性能预算（基线平台：macOS arm64；Windows x64 不超过 1.3×）：**
- 应用冷启动到主界面可用 < 3s（Tauri + Sidecar 都在内）
- 聊天首字节 < 2s（不计 LLM 响应延迟；含 Sidecar 通过控制通道从 Keychain 拉取 Key 的耗时）
- 切换会话渲染 < 200ms（≤ 1000 条历史消息）

**包大小预算：** macOS universal `.dmg` < 60 MB；Windows `.msi` < 50 MB。

---

## 7.5 M1 测试策略

> 与 [08-api-contracts.md §11](../architecture/08-api-contracts.md#11-错误码总表m1-范围) 中错误体系联动；测试金字塔总览。

### 7.5.1 测试金字塔与工具

| 层 | 工具 | 范围 | 覆盖目标 |
|---|---|---|---|
| 单元 | Vitest（sidecar / shared / web） | 纯函数：成本计算、`classifyProviderError` 脱敏、Zod schema、价格徽章分档、prompt 拼接 | sidecar 关键模块行覆盖 ≥ **80%**；shared schema 100% |
| 组件 | Vitest + @testing-library/react | 关键 UI：Onboarding、模型选择器、消息气泡、价位徽章、底部成本栏、错误提示 | 关键交互组件 ≥ **70%** |
| 集成（sidecar 内） | Vitest + supertest（绕开 Tauri，直接打 sidecar HTTP） | `/v1/providers`/`/v1/models`/`/v1/chat`（mock provider）/`/v1/files`/`/v1/costs`；含错误码与 classification 矩阵 | 全 HTTP 端点 happy + error path 至少各一条 |
| E2E | **Playwright** + 真实 Renderer（vite dev）+ 真实 Sidecar + 真实 OpenRouter Key | M1 §7 总验收的 8 步用户路径，外加：拖图、abort、关闭重启 | 100% 通过 §7 DoD |

### 7.5.2 关键测试用例（必须覆盖）

- **Keychain 链路：** Renderer 输入 Key → Sidecar 写 Keychain → Sidecar 重启后调用时按需取 Key 成功（控制通道首字节延迟 ≤ 50ms，否则视作回归）
- **错误分类映射：** 401 → `provider_error/unknown` 不是 `unauthorized`（unauthorized 是 sidecar 自己的鉴权失败）；额度 → `provider_error/quota`；网络超时 → `provider_error/network`；上游内容拦截 → `provider_error/content_filter`（不计入 failure_count_24h）。线协议帧格式固定为 `3:"provider_error/<class>: <msg>"\n`（冒号后含一个空格，便于人眼阅读，解析端按 `^provider_error\/([a-z_]+)` 取 class 即可，对空格不敏感）
- **降权与禁用：** 同一模型在 24h 窗口内连续 3 次 `provider_error/quota` → `demoted=true`；连续 5 次 → `disabled_until` 设置
- **流式 abort：** 用户 abort → sidecar 上游 fetch 收到 cancel → 已有 chunks 写库为 `status='incomplete'`，cost_records `success=false, actual_cost_usd=NULL`
- **attachments 注入：** 拖图 + 不支持视觉的模型 → 返回 `validation_error`；拖 PDF 超长 → 返回 `validation_error` 不静默截断
- **数据持久化：** §7 步 6 关闭重启后，会话/消息/模型配置/Keychain 全部能复现

### 7.5.3 不做（推迟到 M2/M3）

- 视觉回归（截图比对）
- 性能基准回归（仅靠人工评估 §7 性能预算）
- 多语言 / a11y 自动化测试

---

## 8. M1 不做的事（明确切走）

避免范围蔓延，以下功能**严禁**进入 M1：

- ❌ 失败时弹决策框（M1 仅"重试 + 分类文案"，不做 fallback）
- ❌ 聊天中跨能力调用（如 LLM 中识别"画图"意图弹出图像模型选择器）
- ❌ 圆桌
- ❌ 三级记忆（M1 没有"以后默认"这个选项；选模型即用即走）
- ❌ 高成本前置确认
- ❌ 月度成本聚合 / 按模型聚合视图
- ❌ 全局快捷键 / 托盘 / 通知中心集成
- ❌ 国际化（中文为唯一语言；英文 i18n 在 M3 后再做）
- ❌ 自动更新（M1 手动下载新版即可）

---

## 9. 任务到模块映射（开发分工参考）

| M1 任务 | 主要承载模块 | 协作模块 |
|---|---|---|
| Onboarding UI | `apps/web` | `apps/sidecar`（Provider 校验接口）；`apps/desktop`（Keychain 写入命令） |
| 模型配置中心 UI | `apps/web` | `apps/sidecar`（`/v1/models` CRUD） |
| OpenRouter 导入 | `apps/sidecar` | `apps/web`（多选框 UI） |
| 聊天流 | `apps/web`（useChat） + `apps/sidecar`（`/v1/chat` SSE） | — |
| 文件拖入 | `apps/desktop`（Tauri 拖拽 + `read_file_for_upload`） | `apps/web`（缩略图）；`apps/sidecar`（PDF 解析） |
| 成本预估/记录 | `apps/sidecar`（cost/） | `packages/shared`（金额格式化） |
| Keychain | `apps/desktop`（Rust 封装） | `apps/sidecar`（运行时按需取） |
| 数据持久化 | `apps/sidecar`（db/） | — |

各模块的 `MODULE.md` 在 M0 完成代码骨架时建立，依据 [my-spec 模块合同模板](file:///Users/chenpu/workspace/claude-code/my-spec/模板/模块合同模板.md)。

---

## 10. 评审与下一步

本规格在 M0 骨架搭建完成后**冻结**，M1 开发期间任何范围变更需走变更提案（按 my-spec §7）。

M0 验收完成 → 本规格冻结 → M1 拆 ticket 开发 → M1 验收（按 §7 全部 8 步全部通过） → 启动 M2 设计细化。
