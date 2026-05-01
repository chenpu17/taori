# 变更提案：E2 数据备份 / 恢复

Status: draft
Owner: Codex
Date: 2026-04-30
Scope: `apps/web` + `apps/sidecar` + `packages/shared`

## 1. 问题

当前产品已经积累了多类本地状态：

- 会话 / 消息 / 文件
- 模型与 Provider 配置
- 成本账本与记忆
- Prompt 模板 / Persona
- 圆桌记录

但用户没有一个“把这些数据带走 / 迁回”的正式出口。这与 BYOK 用户对“数据归我”的预期不一致，也使升级、迁机、清空重装前缺乏安全网。

目标行为：

- 在设置页提供导出全部数据的单文件 JSON 备份。
- 提供导入入口，并支持 `overwrite / skip / rename` 三种冲突策略。
- 真实 API Key 不进入备份包；恢复后用户需自行重新填写 Key。

## 2. 影响范围

- 模块：
  - `apps/web`
  - `apps/sidecar`
  - `packages/shared`
- Spec / 文档：
  - `docs/modules/e2-backup-restore-mapping.md`
  - `docs/modules/inventory.md`
  - `docs/architecture/15-e2-backup-restore-proposal.md`
- 接口：
  - 新增 `GET /v1/admin/export-data`
  - 新增 `POST /v1/admin/import-data`
- 状态 / 存储：
  - 无新表
  - 新增 JSON 备份包格式 `taori-backup-v1`

## 3. 当前合同

- `Settings` 目前只有清空数据能力，没有备份 / 恢复能力。
- `admin.ts` 原先只覆盖“清空 SQLite + Keychain”的局部危险操作。
- 现有共享 contract 不包含备份包、导入策略、导入结果统计等结构。

## 4. 拟议变更

- 公共行为变化
  - `Settings` Danger Zone 新增：
    - `导出全部数据`
    - `导入策略` 选择器
    - `导入备份文件`
  - Sidecar 对外新增导出 / 导入接口。
- 内部实现方式
  - `packages/shared` 新增备份相关 schema/type：
    - records
    - counts
    - package
    - import/export response
  - `apps/sidecar` 以统一 `BackupPackage` 收集并恢复多表数据。
  - 导入时建立 ID 映射，统一 remap 下列引用：
    - `messages.parent_message_id`
    - `messages.attachments[].file_id`
    - `roundtables.participants[].model_id`
    - `roundtables.summarizer_model_id`
    - `roundtables.origin_conversation_id`
    - `roundtable_messages.roundtable_id / model_id`
    - `cost_records.source_id / conversation_id / model_id`
    - `memories(scope=session).scope_id`
  - `rename` 策略在必要时同时处理 ID 与显示名 / alias，避免唯一约束冲突。
- 状态归属
  - 备份真相与冲突决策实现归 `apps/sidecar`
  - 文件下载、文件读取、结果提示归 `apps/web`
  - 载荷定义归 `packages/shared`

## 5. 兼容性

- 向后兼容：
  - 新接口为 additive；旧版前端不调用时不受影响。
  - 导入 / 导出不要求任何 migration。
- 合同变更：
  - 新增 `BackupPackage` 及其关联 schema
  - 新增 `/v1/admin/export-data`、`/v1/admin/import-data`
  - `clear-all-data` 的清理范围扩展到 templates / personas / files / memories / roundtables
- 回滚路径：
  - web 可以隐藏备份入口
  - sidecar 保留接口不会破坏既有主路径

## 6. 实施计划

1. 在 `packages/shared` 定义备份 contract
2. 扩展 renderer API client
3. 在 `Settings` Danger Zone 增加导入导出入口
4. 在 `admin.ts` 实现导出 / 导入 / 扩展清空逻辑
5. 补 sidecar 单测与 Playwright e2e
6. 更新 inventory 与 feature mapping

## 7. 验证计划

- 单元 / 模块测试：
  - `pnpm --filter @taori/sidecar test -- e2-backup-restore.test.ts`
- 集成 / smoke：
  - `pnpm --filter @taori/shared build`
  - `pnpm --filter @taori/sidecar typecheck`
  - `pnpm --filter @taori/web typecheck`
  - `pnpm --filter @taori/web test:e2e -- e2-backup-restore.spec.ts`
- 手工检查：
  - 设置页点击导出并验证 JSON 下载
  - 导入后刷新，确认会话 / 模板 / Persona / 模型等恢复
  - 校验 API Key 仍需手工补填

## 8. 风险

- 多表导入若只靠单表 upsert，无法解决跨表引用迁移
  - 缓解：先构建全局 ID 映射，再按依赖顺序写入
- 备份包可能包含已丢失的文件路径
  - 缓解：字节缺失时导出 warning，不中断整包导出；导入时允许仅恢复元数据
- 真实 Key 不在备份包里，部分用户会误以为“恢复不完整”
  - 缓解：设置页导出成功文案明确提示“API Key 不包含在备份中”

## 9. 未决问题

- 本次不做增量备份、不做云同步、不做加密备份包。
- 本次导入单位为整包，不支持选择性恢复某一类资源。

## 10. 决策

- [ ] Approved
- [ ] Rejected
- [ ] Needs revision

Decision notes:

- 当前方案保持本地优先、JSON 可审计、Key 脱敏三条原则，在不引入新依赖的前提下补齐用户的数据主权闭环。
