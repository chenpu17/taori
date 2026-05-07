# 19 · P3 普通会话导出

## 背景

圆桌已经有 Markdown 导出入口，但普通 chat 仍缺少可沉淀、可迁移、可分享的导出能力。对重度用户来说，一次高质量对话经常会变成会议纪要、方案草稿、代码排查记录或 Obsidian 笔记；如果只能复制单条消息，Taori 很难成为长期工作流的一部分。

## 用户价值

- **成果可带走**：用户可以把完整会话保存成 Markdown，进入 Git、Obsidian、Notion 或邮件。
- **证据可追溯**：导出内容保留模型、成本、文件引用、记忆引用与关键 Timeline 摘要，方便复盘。
- **分享不泄密**：默认导出不包含 API Key、系统内部 token、隐藏 system prompt、原始本地文件全文。
- **离线优先**：首版在本地 Sidecar 生成文本文件，不依赖云端转换服务。

## 首版范围

### 必须支持

1. 当前普通会话导出为 Markdown。
2. 导出包含会话标题、导出时间、消息列表、附件名、模型名、Quick Compare 采纳标记、成本摘要。
3. 可选包含 Run Timeline 摘要：成本记录、记忆使用、文件 chunk 引用、上下文压缩事件。
4. Web 在会话头部提供“导出”入口，并下载 `.md` 文件。
5. 导出端点只接受本地已存在 conversation id，不支持任意路径写文件。

### 暂不支持

- PDF 原生渲染：先把 Markdown 作为稳定合同；PDF 可在后续用浏览器 print 或本地转换补。
- 导出整个工作区/全部会话。
- 导出原始 provider 请求、隐藏 system prompt、API Key、完整文件二进制。
- 云端分享链接。

## 导出格式建议

```markdown
# 会话标题

- Conversation: `conv_xxx`
- Exported at: 2026-xx-xx xx:xx
- Messages: 12
- Cost: $0.1234

## Timeline 摘要

- cost.recorded · $0.0123 · gpt-4.1
- memory.used · 3 条记忆
- context.file_chunks · 4 个片段

## Messages

### User · 2026-xx-xx

...

### Assistant · 模型名 · 2026-xx-xx

...
```

## 体验原则

- 导出是“结果沉淀”而不是“备份恢复”；备份恢复继续使用设置页已有 JSON backup。
- 默认 Markdown 应保持干净，不把 Timeline 变成噪音；Timeline 作为折叠/可选项进入二期。
- 文件引用只导出片段引用和文件名，不默认导出源文件全文。
- 如果会话不存在或已删除，明确报错；不要生成空文件伪装成功。

## 验收

- 一个含普通 user/assistant 消息的会话能下载 Markdown。
- 一个含附件、记忆使用、文件 chunk Timeline 的会话能导出对应摘要。
- 导出内容不包含 API Key、Authorization header、provider base URL query。
- 空会话或不存在会话返回明确错误。
