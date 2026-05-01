# 变更提案：C3 Prompt 模板与 Persona 预设

Status: draft
Owner: Codex
Date: 2026-04-30
Scope: `apps/web` + `apps/sidecar` + `packages/shared`

## 1. 问题

当前聊天链路只支持用户手工输入 prompt，不支持可复用模板，也没有稳定的会话级 persona 绑定。

- 当前行为
  - Prompt 只能临时输入，重复任务需要反复复制粘贴
  - 用户无法在新会话开始前声明“以某种角色回答”
  - 圆桌已有 persona 概念，但普通聊天没有对应能力
- 目标行为
  - 全局维护可保存的 Prompt 模板，支持 `{{变量}}` 占位，发送前填空
  - 会话级绑定一个 Persona，并在后续聊天中稳定生效
  - Persona 只影响上游 system prompt，不污染可见消息历史
- 为什么现在做
  - B2 已完成，下一步价值密度最高的是提升聊天复用效率
  - C3 是 D/E 阶段预算与导出的前置数据项之一
- 影响
  - 用户：减少重复输入，提升“新会话即带上下文”的启动效率
  - 研发：新增一组稳定的共享 contract；后续导出/导入可复用

## 2. 影响范围

- 模块：
  - `apps/web`
  - `apps/sidecar`
  - `packages/shared`
- Spec / 文档：
  - `docs/modules/inventory.md`
  - `docs/modules/c3-prompt-templates-personas-mapping.md`
  - `docs/architecture/12-c3-templates-personas-proposal.md`
- 接口：
  - `GET/POST /v1/prompt-templates`
  - `PATCH/DELETE /v1/prompt-templates/:id`
  - `GET/POST /v1/personas`
  - `PATCH/DELETE /v1/personas/:id`
  - `POST /v1/chat` 新增可选字段 `persona_id`
- 状态 / 存储：
  - SQLite 新增 `prompt_templates`、`personas`
  - `memories(session, active_persona_id)` 持久化会话 Persona 绑定
- 部署 / 运维：
  - 无新增环境变量
  - 需要本地 SQLite additive migration

## 3. 当前合同

- 状态归属
  - 业务持久化由 `apps/sidecar` + SQLite 持有
  - renderer 只持有 UI 临时状态
- 当前公共行为
  - `/v1/chat` 只接受 `model_id`、`messages`、`attachments`
  - `memories` 可存全局/会话级轻量 KV
  - 没有模板与 Persona 资源路由
- 当前 fallback / 兼容路径
  - 无 persona 时，聊天仅发送显式消息历史
  - renderer 中 `system` 角色只用于本地可见提示，发送前会被剥离

## 4. 拟议变更

- 公共行为变化
  - 新增模板与 Persona 两组 CRUD 资源
  - `/v1/chat` 支持可选 `persona_id`
- 内部实现方式
  - 模板变量填空放在 renderer 侧完成，sidecar 只接收最终 prompt
  - 会话级 Persona 绑定复用 `memories`，不新增第三张绑定表
  - sidecar 在调用上游模型前，将 Persona `prompt` prepend 为 `system` 消息
- 状态归属
  - `prompt_templates` / `personas` 的所有权归 `apps/sidecar`
  - 会话 Persona 绑定的所有权仍归 `apps/sidecar` 的 `memories`
- 配置变化
  - 无新增 env / CLI / deploy 参数
- 文档同步
  - 更新 `docs/modules/inventory.md` 的最近变化与合同变化

## 5. 兼容性

- 是否向后兼容
  - 是。旧版 `/v1/chat` body 不带 `persona_id` 继续可用。
- 是否改变 route / field / event / env / schema
  - 新增路由
  - `/v1/chat` 新增 `persona_id` 字段
  - SQLite 新增两张表
  - 不新增 env / event
- 是否需要迁移
  - 需要 additive migration / bootstrap 建表
- 回滚路径
  - renderer 不调用新路由即可退回旧行为
  - sidecar 可忽略 `persona_id`
  - 新表即使保留也不会影响旧链路

## 6. 实施计划

1. 补齐共享 schema 与 ID 前缀，定义模板/Persona contract
2. 在 sidecar 加表、repo、路由，并扩展 `/v1/chat` persona 注入
3. 在 web 增加设置管理面板、模板套用入口、Persona 绑定入口
4. 补 sidecar 单测与 web e2e，验证模板填空和 Persona 持久化
5. 更新模块清单与阶段进度

## 7. 验证计划

- 单元 / 模块测试：
  - `pnpm --filter @taori/sidecar test -- c3-templates-personas.test.ts`
  - `pnpm --filter @taori/sidecar test -- chat.test.ts`
- 集成 / smoke：
  - `pnpm --filter @taori/web typecheck`
  - `pnpm --filter @taori/web test:e2e -- c3-templates-personas.spec.ts`
- 手工检查：
  - 在设置页创建模板与 Persona
  - 在空会话里一键套模板并选择 Persona 后发起首轮聊天
  - 刷新后确认会话 Persona 仍然选中
- 文档 / spec 检查：
  - `docs/modules/inventory.md` 与本提案一致

## 8. 风险

- Persona 注入顺序错误：如果加在用户消息后或与附件拼接混用，可能失去 system 语义
  - 缓解：在 sidecar 统一 prepend 到 upstream messages
- 会话 Persona 解绑不彻底：UI 清空但 memory 还在，后续请求继续生效
  - 缓解：提供显式 delete memory 路径
- Settings 面板复杂度上升
  - 缓解：模板与 Persona 保持轻量列表 + 编辑表单，不做复杂拖拽/分页

## 9. 未决问题

- 本次不做模板分类、收藏、共享与导入导出；后续若需要，走 D/E 阶段继续扩展
- 本次不把 Persona 泛化到 roundtable 参与者模板；两者先保持独立

## 10. 决策

- [ ] Approved
- [ ] Rejected
- [ ] Needs revision

Decision notes:

- 当前按 additive contract 方案实施；若后续发现 Persona 需要更强的会话元数据表达，再评估独立绑定表。
