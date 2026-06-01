# 36 · 基础能力编排内核提案

Status: draft  
Owner: Taori  
Date: 2026-05-30  
Scope: sidecar orchestration / chat, quick compare, and roundtable context routing / run timeline / shared event contract

## 1. 问题

普通聊天、Quick Compare、Roundtable、Deep Research 都会遇到同一类运行时判断：

- 用户问题是否需要最新外部信息。
- 是否需要搜索后继续读取网页正文。
- 是否需要本地文件上下文。
- 应该使用哪个默认搜索工具。
- 是否需要把执行过程暴露到 Run Timeline。

此前这些判断分散在不同链路中，容易出现普通聊天未主动搜索、模型不支持 tools 时无法受益、默认搜索工具不一致、前端看不到清晰执行状态等问题。

## 2. 影响范围

- 模块：
  - `apps/sidecar`
  - `packages/shared`
  - `apps/web`（消费 run timeline / data stream，不改 HTTP 调用方式）
- Spec / 文档：
  - `docs/architecture/36-capability-orchestration-kernel-proposal.md`
  - `apps/sidecar/MODULE.md`
  - `packages/shared/MODULE.md`
  - `docs/modules/inventory.md`
- 接口：
  - `RunEventKindSchema` additive 新增 `orchestration.plan`
  - Data Stream annotation additive 新增 `orchestration` / `qc.orchestration` / `rt.orchestration`
  - `/v1/chat` 请求 shape 不变
- 状态 / 存储：
  - 不新增 SQL 表，不新增 migration
  - 复用 `run_events`、`cost_records`、`memories(default_search_tool)`、文件索引状态
- 部署 / 运维：
  - 不新增进程、环境变量或外部服务依赖

## 3. 当前合同

- `apps/sidecar` 拥有 LLM 调用、工具调度、上下文组装、成本记录与运行事件。
- `Capability Bus` 是工具调用统一入口，内置工具和 MCP 工具都应通过 `bus.invoke()` 执行。
- `packages/shared` 定义跨端 run event schema，Renderer 通过 Data Stream annotation 与 Run Timeline 展示过程。
- `apps/web` 不拥有业务编排状态，只消费 Sidecar 暴露的事件与快照。
- P7 工作流编排是用户可编辑、多节点、可暂停恢复的长期 DAG 能力，不等同于单次聊天请求内的能力路由。

## 4. 拟议变更

新增 Sidecar 内部基础能力编排内核：

- `src/orchestration/context-router.ts`：生成结构化 `OrchestrationPlan`。
- `src/orchestration/web-context.ts`：复用 Capability Bus 执行预搜索 / 预读取，并生成可注入上游模型的 system context。

计划输出结构化 `OrchestrationPlan`：

- `externalInfo`: `none | web_search | web_search_fetch | deep_research_suggest`
- `localContext`: `none | file_search`
- `reason`: 本轮路由原因，例如 `freshness_required`、`high_stakes_current`、`evidence_required`
- `queries`: 预搜索查询
- `searchToolName`: 当前会话有效的首选搜索工具
- `fetchTopK`: 是否需要预读取网页正文
- `citeRequired`: 是否要求回答给出来源
- `allowModelToolUse`: 是否仍允许模型在后续生成中自行调用 tools

普通聊天在调用上游模型前执行该计划：

1. 写入 `run_events(kind='orchestration.plan')`。
2. 将计划放入 `context.snapshot.context_sources[type='orchestration']`。
3. 通过 `orchestration` annotation 把计划摘要推给 Renderer。
3.1 Renderer 的对话顶栏「运行记录」面板读取 `/v1/conversations/:id/run-events`，将 `orchestration.plan` 作为审计事件高亮展示，让用户能回看“为什么自动联网 / 为什么建议深度研究”。
4. 对需要时效或证据的问题，按首选搜索工具执行预搜索。
5. 对高时效 / 高风险 / 需要证据的问题，继续调用 `builtin.web_fetch` 读取前几个结果。
6. 将搜索结果和网页正文片段作为 system context 注入模型，使不支持原生 tools 的模型也能使用外部信息。
7. 将预搜索 / 预读取步骤通过 `tool.*` run events 和 `tool_trace` 暴露给前端。

Quick Compare 主路径同样执行该计划：

1. 在创建 compare run 后写入 `run_events(kind='orchestration.plan')`，payload 带 `run_kind='quick_compare'` 与 `compare_id`。
2. 通过 `qc.orchestration` annotation 把计划摘要推给 Renderer。
3. 候选模型并发启动前做一次共享预搜索 / 预读取。
4. 将相同网页上下文注入所有候选模型，避免候选差异来自“是否主动调用搜索工具”。
5. 通过 `tool.*` run events 和 `qc.tool_trace` 暴露预搜索 / 预读取过程。

Quick Compare retry 复用同一计划，但 payload 标记 `run_kind='quick_compare_retry'` 与目标 `output_id`，只把预搜索上下文注入被重试的候选。

Roundtable 轮次同样执行该计划：

1. 每轮 `runRound()` 在参与者模型并发启动前，按圆桌 `topic` 生成 `OrchestrationPlan`。
2. 通过 `rt.orchestration` annotation 把计划摘要推给 Renderer。
3. 做一次共享预搜索 / 预读取。
4. 将相同网页上下文追加进每个参与者 prompt，保证不同角色基于同一外部证据讨论。
5. 通过 `tool.*` run events 和 `rt.tool_trace` 暴露预搜索 / 预读取过程。

## 5. 兼容性

- 向后兼容。
- 不改变 `/v1/chat`、`/v1/quick-compare` 或 `/v1/roundtable*` 请求 shape；Data Stream annotation 仅 additive 增加可忽略事件。
- 不新增数据库 migration。
- `orchestration.plan` 是 additive run event kind；旧客户端若忽略未知事件，行为不受影响。
- 预搜索失败不阻断主模型回答，只记录 `tool.failed` 并继续执行。
- 回滚路径：移除普通聊天对 `buildChatOrchestrationPlan()` 的调用，并保留共享事件枚举的 additive 字段即可兼容旧数据。

## 6. 实施计划

1. 在 `apps/sidecar` 新增 context router，统一判断外部信息、本地上下文、默认搜索工具和引用需求。
2. 抽出共享 web context helper，统一执行预搜索 / 预读取和 system context 构建。
3. 在普通聊天上下文构建阶段接入编排计划。
4. 在 Quick Compare 主路径和 retry 接入同一编排计划，共享预搜索结果给候选。
5. 在 Roundtable 轮次接入同一编排计划，共享预搜索结果给所有参与者。
6. 复用 Capability Bus 调用搜索与网页读取，并把结果注入 system context / prompt。
7. 通过 run events、context snapshot、tool trace 暴露执行过程。
8. 在 `packages/shared` 增加 `orchestration.plan` 事件枚举与 `OrchestrationAnnotation` 流事件合同。
9. 在 Web 展示普通聊天、Quick Compare、Roundtable 的编排摘要。
10. 增加 Sidecar 回归测试覆盖高时效搜索、无工具模型预搜索、Quick Compare 预搜索 / 重试、Roundtable 预搜索、默认搜索工具选择、流式编排 annotation 和文件上下文共存。

## 7. 验证计划

- 单元 / 模块测试：
  - `pnpm --filter @taori/shared build`
  - `pnpm --filter @taori/shared typecheck`
  - `pnpm --filter @taori/sidecar typecheck`
  - `pnpm --filter @taori/sidecar test -- chat.test.ts -t "pre-searches current|preferred search|injects matching file"`
  - `pnpm --filter @taori/sidecar test -- quick-compare-route.test.ts -t "pre-searches current|DeepSeek official|persists per-participant"`
  - `pnpm --filter @taori/sidecar test -- orchestration-context-router.test.ts m3a-2-rounds.test.ts -t "orchestration context router|pre-searches current roundtable"`
  - `pnpm test:sidecar`
- 集成 / smoke：
  - 本阶段不改 Renderer 调用方式，Web E2E 可沿用既有 smoke。
- 文档 / spec 检查：
  - `apps/sidecar/MODULE.md`
  - `packages/shared/MODULE.md`
  - `docs/modules/inventory.md`

## 8. 风险

- 关键词路由可能误判：第一阶段保持规则显式、可测试，后续可引入可配置策略或轻量分类器。
- 预搜索增加延迟：只在明确时效 / 证据 / 高风险场景触发，失败不阻断主回答。
- 搜索结果质量依赖工具：优先使用用户配置的默认搜索工具，失败时保留主模型回答路径。
- 与 P7 工作流概念混淆：本提案限定为请求内上下文路由，不提供用户可编辑 DAG、节点状态或后台队列。

## 9. 未决问题

- Deep Research 继续迁移到同一 router 时，是否需要增加独立 policy profile。
- 是否需要在设置中暴露“自动联网强度”。
- 已把面向 UI 的 `OrchestrationAnnotation` 提升到 `packages/shared`；Sidecar 内部完整 `OrchestrationPlan` 暂不外泄，避免把内部策略字段固化成产品合同。

## 10. 决策

- [ ] Approved
- [ ] Rejected
- [x] Needs revision

Decision notes:

- 先落地普通聊天第一阶段，验证用户最痛的“应该联网但没有联网”问题；第二阶段接入 Quick Compare 主路径 / retry；第三阶段接入 Roundtable 轮次；Deep Research 后续复用同一基础能力逐步迁移。
