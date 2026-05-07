/**
 * Lightweight markdown renderer for assistant messages.
 *
 * - `marked` parses the markdown synchronously
 * - `DOMPurify` strips any untrusted HTML / event handlers
 * - We disable `marked`'s default linkify-images behavior; only http(s)
 *   links are kept by DOMPurify config
 *
 * Streaming-safe: called every render with the partial content; both
 * libraries handle truncated markdown gracefully (e.g. an unclosed
 * code fence renders as inline code rather than failing).
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function renderMarkdown(src: string): string {
  if (!src) return '';
  const html = marked.parse(src, { async: false }) as string;
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span',
    ],
    ALLOWED_ATTR: ['href', 'title', 'class'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#)/i,
  });
  return enhanceTables(enhanceCodeBlocks(sanitized));
}

function enhanceCodeBlocks(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const blocks = template.content.querySelectorAll('pre > code');
  blocks.forEach((code, index) => {
    const pre = code.parentElement;
    if (!pre) return;
    const language = languageFromClass(code.getAttribute('class') ?? '');
    const wrapper = document.createElement('div');
    wrapper.className = 'markdown-code-block';
    wrapper.setAttribute('data-code-block', 'true');
    wrapper.setAttribute('data-language', language);
    const lineCount = (code.textContent ?? '').split('\n').length;
    const shouldCollapse = lineCount >= 18;
    wrapper.setAttribute('data-line-count', String(lineCount));
    if (language.toLowerCase() === 'mermaid') {
      wrapper.setAttribute('data-mermaid-block', 'true');
    }
    if (shouldCollapse) {
      wrapper.setAttribute('data-code-collapsible', 'true');
      wrapper.setAttribute('data-code-collapsed', 'true');
    }

    const head = document.createElement('div');
    head.className = 'markdown-code-block__head';

    const meta = document.createElement('span');
    meta.className = 'markdown-code-block__meta';
    meta.textContent = `${lineCount} 行`;

    const headMain = document.createElement('div');
    headMain.className = 'markdown-code-block__head-main';

    const label = document.createElement('span');
    label.className = 'markdown-code-block__lang';
    label.textContent = language || 'text';
    headMain.append(label, meta);

    const actions = document.createElement('div');
    actions.className = 'markdown-code-block__actions';

    if (shouldCollapse) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'markdown-code-block__toggle';
      toggle.setAttribute('data-markdown-collapse', 'true');
      toggle.textContent = '展开';
      actions.append(toggle);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'markdown-code-block__copy';
    button.setAttribute('data-markdown-copy', String(index));
    button.textContent = '复制';
    actions.append(button);

    head.append(headMain, actions);
    pre.replaceWith(wrapper);
    wrapper.append(head);
    if (language.toLowerCase() === 'mermaid') {
      const mermaidOutput = document.createElement('div');
      mermaidOutput.className = 'markdown-mermaid-output';
      mermaidOutput.setAttribute('data-mermaid-output', 'true');
      wrapper.append(mermaidOutput);
    }
    wrapper.append(pre);
  });
  return DOMPurify.sanitize(template.innerHTML, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span',
      'div', 'button',
    ],
    ALLOWED_ATTR: [
      'href', 'title', 'class', 'type',
      'data-code-block', 'data-language', 'data-markdown-copy',
      'data-mermaid-block', 'data-mermaid-output',
      'data-code-collapsible', 'data-code-collapsed', 'data-line-count',
      'data-markdown-collapse',
    ],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#)/i,
  });
}

function enhanceTables(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const tables = template.content.querySelectorAll('table');
  tables.forEach((table) => {
    if (table.parentElement?.classList.contains('markdown-table-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'markdown-table-wrap';
    wrap.setAttribute('data-table-wrap', 'true');
    table.replaceWith(wrap);
    wrap.append(table);
  });
  return DOMPurify.sanitize(template.innerHTML, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span',
      'div', 'button',
    ],
    ALLOWED_ATTR: [
      'href', 'title', 'class', 'type',
      'data-code-block', 'data-language', 'data-markdown-copy',
      'data-mermaid-block', 'data-mermaid-output',
      'data-code-collapsible', 'data-code-collapsed', 'data-line-count',
      'data-markdown-collapse', 'data-table-wrap',
    ],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#)/i,
  });
}

function languageFromClass(className: string): string {
  const match = /\blanguage-([A-Za-z0-9_+#.-]+)\b/.exec(className);
  return match?.[1] ?? '';
}
