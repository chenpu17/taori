# P3 普通会话导出 · 特性到模块映射

## 涉及模块

| 模块 | 变化 | 责任边界 |
|---|---|---|
| `packages/shared` | 可选新增导出参数 schema | 只定义合同，不生成导出内容 |
| `apps/sidecar` | 新增 conversation export route 与 Markdown renderer | 读取 SQLite、聚合安全摘要、返回下载内容 |
| `apps/web` | 新增普通会话导出入口 | 只触发下载和展示错误，不拼装业务数据 |
| `apps/desktop` | 无首版变化 | 不参与导出内容生成 |

## 依赖方向

```text
apps/web
  -> apps/sidecar /v1/conversations/:id/export
apps/sidecar
  -> SQLite conversations/messages/run_events/cost_records/files
  -> packages/shared optional export schema
```

## 状态归属

- 导出内容的事实来源：Sidecar SQLite。
- 导出 UI 状态：Renderer 临时状态。
- 下载文件：浏览器/Tauri WebView 处理，不落 Sidecar 固定路径。

## 合同变化

- 新增 `GET /v1/conversations/:id/export`。
- 不改变 `/v1/conversations/:id/messages` 返回结构。
- 不新增数据库表。

## 风险

- Markdown 中用户原始代码块可能嵌套 fence；renderer helper 需要处理 fence 长度。
- Timeline payload 可能包含未来新增字段；导出必须白名单摘要字段，不直接 dump JSON。
- 长会话导出文件可能较大；首版直接返回文本，后续再考虑分页/压缩。
