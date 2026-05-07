# 22 · P5 Markdown 渲染增强

## 背景

当前 Web 端 Markdown 渲染使用 `marked + DOMPurify`，能满足基础段落、表格、代码块和链接，但还缺少现代 AI Chat 的高频体验：代码块复制、Mermaid、KaTeX、引用折叠、流式渲染稳定性提示。

这不是“美化”，而是影响用户是否愿意把 Taori 用在代码、研究、数学和长文场景里的基础体验。

## 用户价值

- **代码更好用**：每个代码块可一键复制，保留语言标识。
- **图示可读**：Mermaid 让模型输出的流程图、架构图直接可视化。
- **公式可读**：KaTeX 支持数学、成本公式和模型评估表达。
- **长引用不压屏**：blockquote / citations 可折叠，长回答更易扫读。
- **安全可信**：所有增强仍经过白名单和 DOMPurify，不执行任意 HTML/JS。

## 分阶段范围

### P5a：代码块复制

- 识别 fenced code block。
- 渲染语言标签和“复制”按钮。
- 点击复制原始 code 文本，不复制行号或按钮。
- 流式中未闭合代码块仍能稳定显示。

### P5b：Mermaid

- 仅对 fenced block 语言为 `mermaid` 的内容渲染图。
- 渲染失败时回退为代码块并展示错误摘要。
- 禁止 Mermaid 外部资源加载。

### P5c：KaTeX

- 支持 `$inline$`、`$$block$$`。
- 渲染失败时保留原文本。
- 不把普通美元金额误判为公式。

### P5d：引用折叠

- 对超长 blockquote 或 citation group 提供展开/收起。
- 默认折叠阈值按高度/行数，而不是按字符数。

## 非目标

- 不允许任意 HTML 透传。
- 不支持远程插件加载。
- 不在首版引入完整 MDX。
- 不把 Markdown renderer 迁移到 Sidecar。

## 验收

- 代码块复制按钮可用，复制内容与原代码一致。
- Mermaid/KaTeX 正常渲染，错误输入可安全回退。
- 恶意 HTML、事件处理器、`javascript:` 链接仍被清理。
- 流式半截 Markdown 不导致 React 报错或整条消息消失。
