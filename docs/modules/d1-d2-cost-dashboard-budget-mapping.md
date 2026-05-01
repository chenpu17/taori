# D1 / D2 · 成本看板与月度预算 · 特性到模块映射

Status: draft
Owner: Codex
Date: 2026-04-30
Scope: D1 成本看板、D2 月度软预算/阈值告警/超预算门控

## 1. 目标行为

- 用户可打开独立的成本看板页面，按 `今日 / 本周 / 本月` 查看消费。
- 看板支持按 `模型 / 会话 / 特性` 三种维度切换，并展示 Top-N 与趋势小图。
- 用户可在设置中配置月度软预算（USD）。
- 月消费达到预算的 50% / 80% / 100% 时，底部状态栏出现不同等级提示，并且每个阈值每月只 toast 一次。
- 超过 100% 后，下一次继续产生消费的操作需要经过一次“超预算确认”门控。

## 2. 影响模块

| 模块 | 变化类型 | 本次承担的职责 |
|---|---|---|
| `apps/web` | `contract` + `internal` + `collaboration` | 新增成本看板 overlay / 页面入口、时间与维度切换、纯 SVG 趋势图、月预算设置、阈值 toast、状态栏颜色提示、超预算确认门控 |
| `apps/sidecar` | `contract` + `collaboration` | 扩展 `/v1/costs/breakdown` 聚合能力（`week` + `group_by` + 分桶趋势）；继续作为 `memories` 与 `cost_records` 的 truth source |

## 3. 协作关系变化

- `apps/web` → `apps/sidecar`
  - 继续使用 `GET /v1/costs/realtime`
  - 扩展使用 `GET /v1/costs/breakdown`
    - `scope`: `session | today | week | month`
    - `group_by`: `model_feature | model | conversation | feature`
- `apps/web` → `apps/sidecar /v1/memories`
  - 新增约定键：
    - `monthly_budget_usd`
    - `monthly_budget_alert_state`

## 4. 状态与存储变化

- 不新增新表。
- `cost_records` 继续作为成本聚合唯一账本来源。
- 月预算与告警去重状态复用 `memories(scope='global')`：
  - `monthly_budget_usd`: 字符串化数字，单位 USD
  - `monthly_budget_alert_state`: JSON，记录当前 `YYYY-MM` 与已触发阈值列表

## 5. 风险点

- 若成本看板趋势图直接在前端从旧 breakdown 数据“猜”，会造成会话/模型趋势与总额不一致；趋势必须由 sidecar 聚合返回。
- 月预算是软预算，不应阻断所有行为；只有真正继续花钱的发送/生成路径需要门控，浏览历史和切换页面不应受影响。
- 一次性 toast 若只存在内存态，刷新后会重复打扰；必须持久化当前月份的阈值触达状态。
- 会话维度聚合需要带标题快照或回退名，否则 dashboard 无法解释“钱花在哪个会话”。

## 6. 必须验收的模块

- `apps/sidecar`
  - 新 scope/group_by 聚合正确
  - 趋势分桶与金额总和一致
- `apps/web`
  - 成本看板可从顶栏与命令面板打开
  - 预算设置、状态栏颜色、toast、超预算确认链路闭合

## 7. 兼容性结论

- 无新增灰盒模块。
- `/v1/costs/breakdown` 为增量扩展：
  - 默认不传 `group_by` 时保持现有 `model_feature` 形态，兼容 M2 的会话成本面板。
  - 新增 `week` scope 为 additive。
- 不涉及部署语义变化，不新增环境变量。
