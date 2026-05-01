# E2 · 数据备份 / 恢复 · 特性到模块映射

Status: draft
Owner: Codex
Date: 2026-04-30
Scope: 设置页导出 / 导入全部本地业务数据（脱敏 Key，支持 overwrite / skip / rename）

## 1. 目标行为

- 用户可在 `Settings` 的 Danger Zone 中导出单个 JSON 备份包。
- 备份覆盖：
  - Provider（仅导出 `had_api_key`，不导出真实 Key）
  - 模型配置
  - 会话 / 消息 / 文件元数据与可读取文件字节
  - memories
  - Prompt 模板 / Persona
  - 圆桌 / 圆桌消息
  - 成本记录
- 用户可选择导入冲突策略：
  - `overwrite`
  - `skip`
  - `rename`
- 导入后，跨表引用必须保持可达，不产生悬空外键式引用。

## 2. 影响模块

| 模块 | 变化类型 | 本次承担的职责 |
|---|---|---|
| `apps/web` | `contract` + `internal` + `collaboration` | 设置页新增导出 / 导入入口、冲突策略选择、文件读取与下载、导入结果反馈 |
| `apps/sidecar` | `contract` + `collaboration` | 提供导出 / 导入 / 清空接口；收集多表数据；处理冲突策略、ID 重映射、文件落盘与引用修复 |
| `packages/shared` | `contract` | 新增备份包 schema / type，统一 renderer 与 sidecar 之间的载荷结构 |

## 3. 协作关系变化

- `apps/web` → `apps/sidecar`
  - 新增 `GET /v1/admin/export-data`
  - 新增 `POST /v1/admin/import-data`
- `apps/sidecar` 内部
  - `admin route` 需同时访问 db、文件目录、keystore 清理能力
  - 导入阶段负责跨资源 ID remap，而不是把该复杂度泄漏到 renderer

## 4. 状态与存储变化

- 不新增新表。
- 备份 JSON 作为一次性导入导出格式，版本固定为 `taori-backup-v1`。
- `files.original_path` 指向的本地文件若可读取，则导出为 `data_b64` 内联字节。
- Provider secret 继续只存于 keystore / key ref；备份不包含真实 Key。

## 5. 风险点

- 如果导入只处理主表，不处理关联字段 remap，会导致消息附件、圆桌参与者、session memory 等引用失效。
- `rename` 不仅要换 ID，还要处理可见名称 / alias 唯一性，否则模型与模板类记录仍会撞唯一约束。
- 导出真实 API Key 会违反本地安全边界；因此只能导出“曾配置过 Key”的事实，不能导出密钥值。
- 文件元数据恢复但字节丢失时，系统必须允许“元数据恢复 + warning”，而不是整包导入失败。

## 6. 必须验收的模块

- `apps/sidecar`
  - 导出包结构稳定，且 Provider 已脱敏
  - `clear-all-data` 清理 SQLite、文件目录、keystore 引用
  - 导入时 `overwrite / skip / rename` 三种策略行为正确
  - 跨表引用 remap 完整
- `apps/web`
  - 设置页可完成 JSON 下载与 JSON 文件导入
  - 导入后页面刷新，列表状态与后端恢复结果一致
- `packages/shared`
  - 备份 schema 与真实接口载荷一致

## 7. 兼容性结论

- 新增接口均为 additive contract。
- 不改动既有业务表结构，只扩展 admin 侧能力。
- 旧版 renderer 不使用备份能力时，现有聊天 / 圆桌 / 成本 / 模型能力不受影响。
