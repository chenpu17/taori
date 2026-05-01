# 变更提案：D1 / D2 成本看板与月度预算

Status: draft
Owner: Codex
Date: 2026-04-30
Scope: `apps/web` + `apps/sidecar`

## 1. 问题

当前成本透明只做到“底栏累计 + 会话面板 + 单次调用确认”，仍然缺少两个关键能力：

- 用户看不到“钱花在哪”：只能看到总额，无法按模型/会话/特性复盘。
- 用户缺少预算安全感：没有月预算、阈值提示、超预算前的最后一道门。

目标行为：

- 增加独立成本看板，支持 `今日 / 本周 / 本月` 与 `按模型 / 按会话 / 按特性` 的多维度聚合，并附带趋势小图。
- 在设置中配置月度软预算；命中 50% / 80% / 100% 时给出颜色提示与每月一次 toast；100% 后继续发起会花钱的请求前必须确认。

## 2. 影响范围

- 模块：
  - `apps/web`
  - `apps/sidecar`
- Spec / 文档：
  - `docs/modules/inventory.md`
  - `docs/modules/d1-d2-cost-dashboard-budget-mapping.md`
  - `docs/architecture/13-d1-d2-cost-dashboard-budget-proposal.md`
- 接口：
  - `GET /v1/costs/breakdown`
    - `scope` 新增 `week`
    - `group_by` 新增 `model | conversation | feature | model_feature`
    - 返回值扩展为聚合行 + 每行趋势分桶
- 状态 / 存储：
  - `memories(global, monthly_budget_usd)`
  - `memories(global, monthly_budget_alert_state)`
- 部署 / 运维：
  - 无新增 env
  - 无 DB migration

## 3. 当前合同

- `cost_records` 已记录 `conversation_id / feature / model_id / created_at / actual_cost_usd`，足够支持新的聚合。
- `GET /v1/costs/realtime` 只返回底栏总额。
- `GET /v1/costs/breakdown` 仅支持 `session | today | month`，且固定按 `(model, feature)` 聚合，不带趋势。
- `memories` 已可承载全局偏好与一次性状态，但当前没有预算相关键。

## 4. 拟议变更

- 公共行为变化
  - 成本看板升级为独立 overlay，与 ModelCenter 同层。
  - `/v1/costs/breakdown` 改为可表达 dashboard 所需的时间与分组维度。
  - 月预算在 renderer 配置，sidecar 继续只做持久化与聚合 truth source。
- 内部实现方式
  - sidecar 基于 `cost_records` 做时间窗过滤、分组聚合、分桶趋势生成。
  - renderer 负责 Top-N 截断、SVG sparkline 渲染、toast 生命周期与门控弹窗。
  - 超预算门控复用现有 `CostConfirmDialog`，只扩一类 `reason='budget'`。
- 状态归属
  - 聚合与账本仍归 `apps/sidecar`
  - UI 临时状态（当前 scope / group_by / toast 可见性）归 `apps/web`
  - “本月已提示过哪些阈值”归 `apps/sidecar` 的 `memories`

## 5. 兼容性

- 向后兼容：
  - 旧调用方不传 `group_by` 时，仍收到旧的 `(model, feature)` 列表。
  - `session` scope 行为保持不变。
- 合同变更：
  - `/v1/costs/breakdown` query/response 扩展
  - 不新增新表，不改已有表结构
- 回滚路径：
  - web 不打开成本看板即可退回现有 M2 行为
  - sidecar 可保留扩展字段，不影响旧面板

## 6. 实施计划

1. 补齐 D1/D2 模块映射与本提案
2. 扩展 sidecar `CostsRepo.breakdown()` 与路由 query/response
3. 实现 web 成本看板 overlay、头部入口、命令面板导航
4. 增加预算设置、阈值提示、超预算确认门控
5. 补 sidecar 测试与 Playwright e2e
6. 更新 `docs/modules/inventory.md`

## 7. 验证计划

- 单元 / 模块测试：
  - `pnpm --filter @taori/sidecar test -- m2-2-cost-l3-l4.test.ts`
  - 新增 D1/D2 sidecar 用例：`week` / `group_by` / trend
- 集成 / smoke：
  - `pnpm --filter @taori/web typecheck`
  - 新增成本看板 / 预算告警 e2e
- 手工检查：
  - 顶栏打开成本看板，切换 3 个时间维度与 3 个聚合维度
  - 配预算并伪造达到 50/80/100% 的月消费，验证状态栏和 toast
  - 超预算后发送一条新消息，验证确认门控

## 8. 风险

- 趋势分桶与本地时区边界
  - 缓解：统一按 sidecar 本地时间计算今日/本周/本月窗口与 bucket label
- 预算提醒重复弹出
  - 缓解：`monthly_budget_alert_state` 持久化 `month + seenThresholds`
- 看板和旧 session panel 共用 breakdown 后发生回归
  - 缓解：保持默认 `group_by=model_feature`，并以既有 M2 测试做回归保护

## 9. 未决问题

- 本次不引入币种切换；预算与看板统一显示 USD。
- 本次不做自动硬拦截；100% 后仍允许用户确认后继续。

## 10. 决策

- [ ] Approved
- [ ] Rejected
- [ ] Needs revision

Decision notes:

- 当前方案保持 additive contract，不新增 migration；预算逻辑优先放 renderer，sidecar 只做持久化与聚合来源。
