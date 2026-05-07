# 26 · P5 Markdown 渲染增强架构提案

## 当前状态

`apps/web/src/markdown.ts` 当前同步调用：

- `marked.parse(src, { async: false })`
- `DOMPurify.sanitize(...)`

`App.tsx` 用 `dangerouslySetInnerHTML` 渲染 assistant 内容和 Quick Compare 输出。这条路径简单稳定，但不适合代码块按钮、Mermaid、KaTeX 这类需要组件生命周期的增强。

## 目标架构

将 Markdown 渲染从“纯 HTML 字符串”升级为“安全 HTML + 渐进增强”：

1. 继续保留 `marked + DOMPurify` 的安全基线。
2. `marked` renderer 给 code block 添加结构化 data 属性。
3. React 渲染后用组件层事件委托处理复制按钮。
4. Mermaid/KaTeX 作为可选依赖按需渲染，不影响基础 Markdown。

## 建议拆分

```text
apps/web/src/markdown/
  render.ts          # marked + DOMPurify 安全渲染
  codeBlocks.ts      # code fence renderer / copy helpers
  mermaid.ts         # lazy render mermaid blocks
  math.ts            # KaTeX render helpers
  MarkdownView.tsx   # React wrapper, 统一增强入口
```

`App.tsx` 不再直接调用 `dangerouslySetInnerHTML={{ __html: renderMarkdown(...) }}`，而是：

```tsx
<MarkdownView content={m.content} />
```

Quick Compare 输出也复用同一组件。

## 安全策略

- DOMPurify 白名单继续是最后防线。
- 允许新增属性仅限：
  - `data-code-block`
  - `data-language`
  - `data-copy-target`
  - `aria-*`
  - `class`
- 禁止 `style`、`on*`、`iframe`、`script`。
- Mermaid 使用 `securityLevel: 'strict'`。
- KaTeX 使用 `throwOnError: false`，并禁用 trust。

## 依赖建议

- Mermaid：`mermaid`
- KaTeX：`katex`

引入时机：

1. 先做代码块复制，无新增依赖。
2. 再分别引入 Mermaid/KaTeX，避免一次改动影响太大。

## 流式渲染

- 未闭合 fence 时继续按普通 code/pre 渲染。
- `MarkdownView` 的增强逻辑必须可重复执行，并能清理上一次渲染状态。
- Mermaid 渲染应 debounce 或只对稳定 block 渲染，避免每个 token 都重绘。

## 测试

- `markdown.ts`/新 render helper 单测：
  - XSS 清理。
  - code block data 属性。
  - `javascript:` 链接清理。
- Web E2E：
  - assistant 消息代码块复制。
  - Mermaid 渲染失败回退。
  - KaTeX 基础公式渲染。
- 回归：
  - 普通 Markdown 表格/列表/链接保持可用。
  - Quick Compare 输出使用同一渲染能力。

## 风险

- `dangerouslySetInnerHTML` 仍存在；必须保证唯一入口是经过 DOMPurify 的 `MarkdownView`。
- Mermaid 体积较大；建议 lazy import。
- 数学语法容易误伤美元金额；KaTeX 解析规则要保守。
