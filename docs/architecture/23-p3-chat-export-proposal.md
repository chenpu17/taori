# 23 · P3 普通会话导出架构提案

## 目标

为普通 chat 增加本地 Markdown 导出能力，复用现有 conversation/message/run-event/cost 数据，不引入云端服务，不改变聊天主链路。

## 当前基础

- `apps/web/src/RoundtablePanel.tsx` 已通过 `GET /v1/roundtable/:id/export` 下载 Markdown，可复用下载交互模式。
- `apps/sidecar/src/routes/conversations.ts` 已提供 conversation/messages 读取。
- `MessagesRepo.listByConversation`、`RunEventsRepo.listByConversation`、`CostRecordsRepo` 已覆盖导出所需大部分数据。
- `RunEventKind` 已包含 `memory.used`、`context.file_chunks`、`context.compacted`、`cost.recorded` 等可用于摘要的事件。

## API 合同

新增：

```http
GET /v1/conversations/:id/export?format=markdown&include_timeline=summary
```

首版参数：

| 参数 | 默认 | 说明 |
|---|---:|---|
| `format` | `markdown` | 首版仅接受 `markdown` |
| `include_timeline` | `summary` | `none` / `summary`，首版不输出完整事件 payload |

响应：

- `200 text/markdown; charset=utf-8`
- `Content-Disposition: attachment; filename="taori-chat-{safe-title-or-id}.md"`
- `404` conversation 不存在
- `400` 参数非法

## Sidecar 设计

新增内部 helper：

```ts
renderConversationMarkdown({
  conversation,
  messages,
  runEvents,
  costs,
  includeTimeline,
}): string
```

职责：

1. 按 `created_at` 排序消息。
2. 渲染 role、时间、模型/状态、正文。
3. 附件只渲染文件名、类型、大小、`file_id`。
4. Timeline 只渲染安全摘要：
   - `cost.recorded`：模型、估算/实际成本、token。
   - `memory.used` / `memory.extracted`：数量、类型，不导出完整隐藏上下文。
   - `context.file_chunks`：文件 id / chunk index / score / char range。
   - `context.compacted`：压缩模式、来源消息数、token 变化。
5. 对 Markdown 特殊字符不做破坏性转义，保留用户原始代码块；只对标题/文件名做安全清洗。

## Renderer 设计

- 在普通会话头部增加“导出”按钮。
- 复用圆桌导出下载模式：`authedFetch` → `Blob` → `URL.createObjectURL` → click download。
- 导出失败在当前 toast/error 区域展示，不阻塞聊天。
- 后续二期可加导出选项弹窗：是否包含 Timeline、是否包含成本、是否包含附件引用。

## 安全与隐私

- 不导出 API Key、Authorization、provider request headers。
- 不导出隐藏 system prompt、memory 注入全文、RAG 注入全文。
- 不读写任意本地路径；只返回浏览器下载流。
- 文件名用会话标题 slug + conversation id fallback，去除路径分隔符。

## 测试

- Sidecar route test：
  - 正常会话导出 Markdown。
  - 不存在 conversation 返回 404。
  - Timeline summary 包含 cost/memory/file chunk 摘要。
  - 导出不包含敏感 header/API key 样式字符串。
- Web E2E：
  - 点击会话导出按钮触发 Markdown 下载。
  - 导出按钮在无当前会话时不可用或隐藏。
