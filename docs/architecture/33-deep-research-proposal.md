# 33 · 深度研究架构提案

## 目标

在现有聊天、工具、Run Timeline、轻量 RAG 与 Workflow Recipe 之上，新增一个**可持久化、可恢复、可审计**的深度研究运行时。

它不是新的通用 Agent 框架，而是一条受控状态机：计划 → 检索 → 证据整理 → 草稿 → 校验 → 定稿。

## 核心原则

1. **研究任务是显式资源**，不是一串临时聊天消息。
2. **阶段状态归 Sidecar**，Renderer 只消费与触发动作。
3. **证据与草稿分开存**，避免“最后答案覆盖中间依据”。
4. **预算与暂停点内建**，不允许隐式长跑。
5. **复用现有基础设施**：run events、cost_records、tools、file chunks、workflow recipe。

## 数据模型

建议新增 4 组表：

```sql
CREATE TABLE research_sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,            -- draft/running/paused/reviewing/completed/failed/cancelled
  stage TEXT NOT NULL,             -- scoping/planning/searching/synthesizing/drafting/verifying/finalized
  budget_mode TEXT NOT NULL,       -- fast/balanced/deep/custom
  budget_limit_usd REAL,
  budget_spent_usd REAL NOT NULL DEFAULT 0,
  plan_json TEXT,
  draft_markdown TEXT,
  final_markdown TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE research_tasks (
  id TEXT PRIMARY KEY,
  research_session_id TEXT NOT NULL,
  parent_task_id TEXT,
  kind TEXT NOT NULL,              -- search/fetch/read_file/summarize/outline/verify_citation
  status TEXT NOT NULL,            -- queued/running/completed/failed/skipped
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_json TEXT,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE research_sources (
  id TEXT PRIMARY KEY,
  research_session_id TEXT NOT NULL,
  source_type TEXT NOT NULL,       -- web_page/file_chunk/manual_note
  title TEXT,
  locator TEXT NOT NULL,           -- url / file_id:chunk_id / note id
  snippet TEXT,
  credibility_score REAL,
  included INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE research_claims (
  id TEXT PRIMARY KEY,
  research_session_id TEXT NOT NULL,
  section_key TEXT NOT NULL,
  claim_text TEXT NOT NULL,
  claim_kind TEXT NOT NULL,        -- fact/inference/recommendation
  support_status TEXT NOT NULL,    -- supported/weak/conflicted/unverified
  citations_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

说明：

- `research_sessions` 是任务头部真相源。
- `research_tasks` 是细粒度执行单元，便于暂停、失败恢复和重试。
- `research_sources` 保存来源卡片与去重后的引用定位。
- `research_claims` 用于把“结论”与“证据充分性”绑定起来。

## 与现有系统的衔接

### 1. Conversation / Run Timeline

- 每个 `research_session` 绑定一个 `conversation_id`，让用户能在同一会话里看到研究输出。
- 但研究状态不依赖消息列表本身；真正状态落在 `research_sessions`。
- 研究过程继续写 `run_events`：
  - `research.created`
  - `research.plan.ready`
  - `research.stage.started`
  - `research.task.completed`
  - `research.citation.flagged`
  - `research.completed`

### 2. Cost records

- 所有模型调用、工具调用继续复用现有 `cost_records`。
- `source_type` 建议新增：
  - `research_plan`
  - `research_task`
  - `research_verification`
- `research_sessions.budget_spent_usd` 通过聚合相关 `cost_records` 更新，不额外复制成本明细。

### 3. Tools / Capability Bus

研究阶段优先复用：

- `builtin.web_search`
- `builtin.web_fetch`
- `builtin.file_search`
- `builtin.file_read`

后续若引入 MCP 数据源，也只作为额外 source adapter，不改变研究状态机。

### 4. Workflow Recipe

- 可新增“深度研究” recipe 作为启动入口。
- 但 recipe 只负责预填任务目标、结构和预算偏好；真正执行仍进入 `research_sessions`。

## Sidecar 设计

建议新增 `src/research/` 子模块：

```text
src/research/
  planner.ts
  state-machine.ts
  task-runner.ts
  source-dedup.ts
  citation-checker.ts
  repos.ts
  prompts.ts
```

职责划分：

- `planner.ts`：把用户目标转成研究计划与任务队列
- `state-machine.ts`：推进阶段、暂停、恢复、取消
- `task-runner.ts`：串行/限流执行 search/fetch/read/summarize/verify
- `source-dedup.ts`：URL/标题/正文摘要去重
- `citation-checker.ts`：把 claim 与 source 建立引用关系，并标记 unsupported/conflicted

## API 合同

```http
POST   /v1/research/sessions
GET    /v1/research/sessions
GET    /v1/research/sessions/:id
POST   /v1/research/sessions/:id/start
POST   /v1/research/sessions/:id/pause
POST   /v1/research/sessions/:id/resume
POST   /v1/research/sessions/:id/cancel
GET    /v1/research/sessions/:id/sources
GET    /v1/research/sessions/:id/tasks
GET    /v1/research/sessions/:id/claims
POST   /v1/research/sessions/:id/export
```

创建请求建议包含：

- `title`
- `objective`
- `output_kind`
- `budget_mode`
- `budget_limit_usd`
- `constraints`（时间范围、语言、必须覆盖维度）

`POST /start` 的响应应先返回计划预览；只有用户确认后才真正转入 `running`。

## Renderer 设计

建议首版采用独立侧栏/面板，而不是塞进普通消息气泡：

1. 聊天页新增“深度研究”入口
2. 打开后是一个研究工作台，包含：
   - 任务头部（标题、阶段、预算、运行状态）
   - 左侧阶段列表
   - 中部草稿/结果区
   - 右侧来源与引用面板
3. Run Timeline 继续展示底层事件，但不替代研究工作台

关键 UI 元素：

- 阶段进度条
- 来源列表（已纳入 / 已剔除 / 冲突）
- 事实卡 / 推断卡 / 建议卡
- “继续检索”“重新校验引用”“收紧范围后重跑”动作

## 执行策略

首版建议**单主模型 + 受控子任务**，不要直接多模型自治：

1. 主模型负责计划、提炼与写作
2. 工具负责搜索/抓取/检索
3. 引用校验是单独子阶段
4. 只有在“观点对照”或“结论争议”阶段，才可选接入 Roundtable 做补充

这样做的好处：

- 状态机更稳定
- 成本更可控
- 更容易解释“为什么得到这个结论”

## 预算与恢复

- 每个阶段开始前都做预算检查。
- 超过软预算：进入 `paused`，展示“继续 / 收窄范围 / 直接出阶段性报告”。
- 超过硬预算：停止新任务，只允许导出当前草稿。
- `research_tasks` 要记录最近成功检查点，恢复时只重跑失败或未完成任务，不重跑全部抓取。

## 质量控制

至少做 4 类质量门：

1. **来源去重**：同 URL、同标题近似、同正文摘要近似只保留一个主来源
2. **引用充分性**：每条 fact 至少绑定一个来源；关键结论建议要求多个来源
3. **事实/推断分层**：草稿结构中显式标记
4. **冲突标记**：同一子问题出现相反证据时不自动抹平，而是进入 `conflicted`

## 分期建议

### MVP

- 单研究任务
- 网页 + 本地文件两类来源
- 计划预览、阶段执行、暂停恢复
- Markdown 报告 + 引用列表

### v2

- Roundtable 作为“争议议题复核器”
- 更细粒度引用质量评分
- 导出为 briefing / 表格 / 幻灯片大纲
- MCP 数据源扩展（学术搜索、内部知识库）

### v3

- 多任务队列
- 定时更新研究
- 共享模板与团队协作批注

## 测试建议

- shared/schema：研究 session/task/source/claim 合同校验
- sidecar：状态机、暂停恢复、预算门禁、引用校验、失败重试
- web：创建研究 → 确认计划 → 运行阶段 → 暂停恢复 → 导出结果
- 回归：研究过程必须继续写 run_events 与 cost_records，且不破坏普通聊天
