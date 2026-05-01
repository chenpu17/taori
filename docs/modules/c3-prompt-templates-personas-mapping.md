# C3 · Prompt 模板 & Persona 预设 · 特性到模块映射

Status: draft
Owner: Codex
Date: 2026-04-30
Scope: C3 Prompt 模板、变量填空、会话级 Persona 绑定

## 1. 目标行为

- 用户可在全局维护一组可复用的 Prompt 模板。
- 模板支持 `{{变量}}` 占位，套用到 composer 前先填空。
- 用户可维护一组 Persona 预设。
- 每个会话最多绑定一个 Persona；新建会话时可一键套用。
- Persona 作为 sidecar 上游请求的 system prompt 注入，不进入可见消息历史。

## 2. 影响模块

| 模块 | 变化类型 | 本次承担的职责 |
|---|---|---|
| `apps/web` | `internal` + `collaboration` | 新增模板/Persona 管理 UI；在聊天头部提供模板套用与 Persona 绑定入口；把 `persona_id` 透传给 `/v1/chat`；用现有 memories 接口管理会话绑定 |
| `apps/sidecar` | `contract` + `collaboration` | 新增 `prompt_templates` / `personas` 存储与 CRUD 路由；扩展 `/v1/chat` 接口；在上游 payload 注入 persona system prompt；把会话绑定持久化到 `memories` |
| `packages/shared` | `contract` | 增加跨端共享 schema / type：模板、Persona、CRUD payload、`ChatRequest.persona_id` |

## 3. 协作关系变化

- `apps/web` → `apps/sidecar`：新增两组资源路由调用：
  - `/v1/prompt-templates`
  - `/v1/personas`
- `apps/web` → `apps/sidecar` `/v1/chat`：新增可选字段 `persona_id`
- `apps/sidecar` 内部：`chat route` 读取 `personas` + `memories`，把会话 Persona 绑定转换为上游 system prompt

## 4. 状态与存储变化

- `apps/sidecar` SQLite 新增两张表：
  - `prompt_templates`
  - `personas`
- 会话级 Persona 绑定不新增新表，复用 `memories`：
  - `scope='session'`
  - `key='active_persona_id'`
  - `scope_id=<conversation_id>`

## 5. 风险点

- `/v1/chat` 的 `persona_id` 如果设计成覆盖式而不是增量式，容易误清空会话 Persona 绑定。
- Persona 若写入可见消息历史，会污染分支、回放、导出与重试行为；必须只做 sidecar 注入。
- 模板变量填空若直接在服务端做，会引入额外 schema；本次应保持 renderer 侧预处理，sidecar 只接收最终文本。
- Settings 已承载多轮功能，UI 复杂度上升；需要控制为可维护的局部面板，而不是把聊天逻辑搬进设置页。

## 6. 必须验收的模块

- `apps/sidecar`
  - CRUD 路由
  - SQLite migration / additive bootstrap
  - chat persona 注入与持久化
- `apps/web`
  - 模板套用
  - 新会话 Persona 一键套用
  - 已有会话 Persona 绑定/解绑与 reload 恢复
- `packages/shared`
  - schema 与实际路由载荷一致

## 7. 兼容性结论

- 本次没有新增灰盒模块。
- 对现有调用方为增量兼容：
  - 旧版 `/v1/chat` 请求体不带 `persona_id` 仍可工作。
  - 新增路由均为 additive。
- 需要本地 SQLite additive migration，但不要求数据搬迁。
