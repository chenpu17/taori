# 变更提案：E1 模型健康轻量面板

Status: draft
Owner: Codex
Date: 2026-04-30
Scope: `apps/web` + `apps/sidecar` + `packages/shared`

## 1. 问题

当前 ModelCenter 只展示“模型配置态”和“是否被自动降级”，但没有解释降级原因，也无法回答：

- 这个模型最近是不是经常失败？
- 延迟是否明显偏高？
- 最近一次失败到底是限流、鉴权还是网络问题？

目标行为：

- 在 `ModelCenter` 每个模型行下增加可展开的轻量健康面板。
- 展示最近 24h 的调用量、失败量、平均首字延迟、平均总耗时、最近失败分类。
- 不引入独立页面，不做复杂图表，优先把“为什么被降级”解释清楚。

## 2. 影响范围

- 模块：
  - `apps/web`
  - `apps/sidecar`
  - `packages/shared`
- Spec / 文档：
  - `docs/modules/e1-model-health-panel-mapping.md`
  - `docs/modules/inventory.md`
  - `docs/architecture/14-e1-model-health-panel-proposal.md`
- 接口：
  - 新增 `GET /v1/models/health`
- 状态 / 存储：
  - `cost_records.classification`
  - `cost_records.first_token_ms`
- 部署 / 运维：
  - 无新增 env
  - SQLite additive migration 两列

## 3. 当前合同

- `ModelCenter` 现有接口主要是 `/v1/models`、`/v1/providers`、`/v1/catalog/sync`。
- `cost_records` 已有 `success`、`duration_ms`、`model_id`，但缺少：
  - 最近失败分类的结构化字段
  - 首字延迟字段
- chat 路由已经能在错误路径判定 `ErrorClassification`，但此前没有统一沉淀到成本账本。

## 4. 拟议变更

- 公共行为变化
  - sidecar 新增 `GET /v1/models/health`，一次返回全部模型的 24h 健康行。
  - renderer 打开 ModelCenter 时并行加载模型列表与健康行。
  - 每个模型行新增“健康/收起健康”按钮。
- 内部实现方式
  - `chat.ts` 在 cost annotation 和 `CostsRepo.insert()` 中补写：
    - `classification`
    - `first_token_ms`
    - `duration_ms` 继续保留
  - `CostsRepo.modelHealth24h()` 以 24h 窗口扫描 `cost_records` 并做内存聚合。
  - `models route` 用 `ModelsRepo.list()` 补齐“零调用模型”的默认空值行。
- 状态归属
  - 观测真相仍归 `apps/sidecar`
  - 展开状态、格式化文案归 `apps/web`
  - 共享载荷结构归 `packages/shared`

## 5. 兼容性

- 向后兼容：
  - 新接口为 additive；旧版前端不受影响。
  - `cost_records` 新列均为 nullable；旧数据可直接读，不要求回填。
- 合同变更：
  - 新增 `ModelHealthRow` shared schema
  - 新增 `/v1/models/health`
  - `cost_records` additive migration
- 回滚路径：
  - web 可以隐藏健康按钮，ModelCenter 退回旧版
  - sidecar 保留新增列和接口，不影响既有模型管理路径

## 6. 实施计划

1. 新增共享 schema `ModelHealthRow`
2. 扩展 `cost_records` schema / DDL / additive migration
3. 在 chat mock + upstream 路径写入首字延迟和失败分类
4. 实现 `CostsRepo.modelHealth24h()` 与 `/v1/models/health`
5. 在 ModelCenter 增加健康面板 UI
6. 补 sidecar 单测、Playwright e2e、inventory 更新

## 7. 验证计划

- 单元 / 模块测试：
  - `pnpm --filter @taori/sidecar test -- e1-model-health.test.ts`
- 集成 / smoke：
  - `pnpm --filter @taori/sidecar typecheck`
  - `pnpm --filter @taori/web typecheck`
  - `pnpm --filter @taori/web test:e2e -- e1-model-health-panel.spec.ts m2.5-modelcenter.spec.ts`
- 手工检查：
  - 打开 ModelCenter，展开已调用模型与零调用模型
  - 验证失败分类、相对时间、平均延迟展示

## 8. 风险

- 24h 聚合若走 SQL 复杂窗口函数，会提高维护成本
  - 缓解：当前调用量规模较小，先做窗口筛选 + 内存聚合
- mock 路径与真实上游路径健康字段不一致
  - 缓解：两条路径统一写 `8:type=cost` annotation，再由 `finalizeOnEnd()` 落库
- `ModelCenter` 列表行内展开若写坏 JSX 结构，会影响整页渲染
  - 缓解：用独立 e2e 锁住行展开能力

## 9. 未决问题

- 本次不做 provider 级健康概览，也不做历史趋势图。
- 本次不做“按分类筛选模型”或“根据健康自动排序”。

## 10. 决策

- [ ] Approved
- [ ] Rejected
- [ ] Needs revision

Decision notes:

- 当前方案保持 additive contract，把健康解释能力嵌入现有 ModelCenter，不引入新的全局入口。
