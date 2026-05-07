# P5 Markdown 渲染增强 · 特性到模块映射

## 涉及模块

| 模块 | 变化 | 责任边界 |
|---|---|---|
| `apps/web` | 新增 MarkdownView 与渲染增强 helpers | 安全渲染、复制、Mermaid/KaTeX、样式 |
| `apps/sidecar` | 无首版变化 | 不渲染 Markdown |
| `packages/shared` | 无首版变化 | 不定义 UI 渲染合同 |
| `apps/desktop` | 无首版变化 | 不参与渲染 |

## 依赖方向

```text
apps/web MarkdownView
  -> marked
  -> DOMPurify
  -> optional lazy mermaid/katex
```

## 状态归属

- Markdown 内容来自消息数据。
- 渲染状态、复制反馈、折叠展开状态归 Renderer。
- 不新增数据库状态。

## 合同变化

- 无 HTTP/DB/shared contract 变化。
- App 内部渲染入口从 `renderMarkdown()` 字符串函数迁移到 React 组件。

## 风险

- 渲染增强可能引入 XSS；所有新增 HTML/属性必须通过白名单。
- Mermaid/KaTeX 增大 bundle；应 lazy load。
- 如果只改 assistant 消息，不改 Quick Compare，会造成体验不一致；两处必须复用同一 MarkdownView。
