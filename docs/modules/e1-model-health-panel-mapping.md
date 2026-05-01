# E1 · 模型健康轻量面板 · 特性到模块映射

Status: draft
Owner: Codex
Date: 2026-04-30
Scope: ModelCenter 内嵌模型健康展开面板（24h 调用 / 失败 / 延迟 / 最近失败分类）

## 1. 目标行为

- 用户可在 `ModelCenter` 中按模型展开“健康”面板。
- 每个面板展示最近 24 小时：
  - 调用次数
  - 失败次数
  - 平均首字延迟
  - 平均总耗时
  - 最近失败分类与发生时间
- 没有调用数据的模型仍应展示零值/空值，不隐藏行。

## 2. 影响模块

| 模块 | 变化类型 | 本次承担的职责 |
|---|---|---|
| `apps/web` | `contract` + `internal` + `collaboration` | 在 `ModelCenter` 新增健康展开按钮与面板；请求新健康接口；把分类与时间格式化为可读文案 |
| `apps/sidecar` | `contract` + `collaboration` | 在 chat 成本落库时补采样健康字段；提供 `/v1/models/health` 聚合接口；保证无数据模型也返回零值行 |
| `packages/shared` | `contract` | 新增 `ModelHealthRow` 共享 schema/type，统一前后端载荷结构 |

## 3. 协作关系变化

- `apps/web` → `apps/sidecar`
  - 新增 `GET /v1/models/health`
- `apps/sidecar` 内部
  - `chat route` 在 cost annotation 与 `cost_records` 中写入 `classification`、`first_token_ms`、`duration_ms`
  - `models route` 组合 `ModelsRepo.list()` 与 `CostsRepo.modelHealth24h()`

## 4. 状态与存储变化

- 不新增新表。
- `cost_records` 新增两个观测字段：
  - `classification`
  - `first_token_ms`
- `duration_ms` 继续复用既有字段作为总耗时来源。
- 旧库通过 additive migration 补列，不做回填。

## 5. 风险点

- 如果只按失败记录聚合，调用次数与平均延迟会失真；必须按全部 24h 调用聚合，再从失败子集提取最近失败。
- 如果 `ModelCenter` 只渲染“有数据的模型”，用户会误判“没显示 = 没配置”；因此必须对所有模型补零值行。
- 首字延迟来自流式第一 token，mock 路径与真实上游路径都必须写 annotation，否则测试环境与线上表现会分叉。
- 失败分类需要沿用既有 `ErrorClassification`，不能新造前端私有枚举，否则降级逻辑与健康面板文案会漂移。

## 6. 必须验收的模块

- `apps/sidecar`
  - `/v1/models/health` 24h 聚合正确
  - `cost_records` additive migration 生效
  - chat mock / upstream 路径都能写入首字延迟
- `apps/web`
  - ModelCenter 行展开/收起正确
  - 失败分类、相对时间、空值展示稳定
- `packages/shared`
  - schema 与真实返回结构一致

## 7. 兼容性结论

- 新接口 `GET /v1/models/health` 为 additive contract。
- `cost_records` 仅新增可空观测列，不破坏既有读写路径。
- 旧版 renderer 不调用该接口时，现有模型管理能力不受影响。
