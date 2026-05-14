import { useEffect, useMemo, useRef, type MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { renderMarkdown } from './markdown.js';
import 'katex/dist/katex.min.css';

let mermaidInitialized = false;

export function MarkdownView({
  content,
  className,
}: {
  content: string;
  className?: string;
}): JSX.Element {
  const html = useMemo(() => renderMarkdown(content), [content]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const root = rootRef.current;
    if (!root) return;
    const blocks = [...root.querySelectorAll<HTMLElement>('[data-mermaid-block="true"]')];
    if (blocks.length === 0) return;

    void (async () => {
      const { default: mermaid } = await import('mermaid');
      if (!mermaidInitialized) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'default',
        });
        mermaidInitialized = true;
      }
      await Promise.all(blocks.map(async (block, index) => {
        if (cancelled || block.dataset.mermaidRendered === 'true') return;
        const source = block.querySelector('pre code')?.textContent?.trim();
        const output = block.querySelector<HTMLElement>('[data-mermaid-output="true"]');
        if (!source || !output) return;
        block.dataset.mermaidRendered = 'true';
        output.textContent = '正在渲染 Mermaid…';
        try {
          const id = `taori-mermaid-${Date.now()}-${index}`;
          const result = await mermaid.render(id, source);
          if (cancelled) return;
          output.innerHTML = DOMPurify.sanitize(result.svg);
          block.classList.add('markdown-code-block--mermaid-rendered');
        } catch (err) {
          if (cancelled) return;
          output.textContent = err instanceof Error
            ? `Mermaid 渲染失败：${err.message}`
            : 'Mermaid 渲染失败';
          block.classList.add('markdown-code-block--mermaid-failed');
        }
      }));
    })();

    return () => {
      cancelled = true;
    };
  }, [html]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    wrapMathTextNodes(root);
    let cancelled = false;
    const mathNodes = [...root.querySelectorAll<HTMLElement>('[data-katex-source]')];
    if (mathNodes.length > 0) {
      void (async () => {
        const katex = await import('katex');
        for (const node of mathNodes) {
          if (cancelled || node.dataset.katexRendered === 'true') continue;
          const source = node.dataset.katexSource ?? '';
          try {
            katex.render(source, node, {
              displayMode: node.dataset.katexDisplay === 'true',
              throwOnError: false,
              trust: false,
              strict: 'warn',
            });
            node.dataset.katexRendered = 'true';
          } catch {
            node.textContent = node.dataset.katexDisplay === 'true' ? `$$${source}$$` : `$${source}$`;
          }
        }
      })();
    }
    enhanceLongBlockquotes(root);
    return () => {
      cancelled = true;
    };
  }, [html]);

  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    // Open external links in new tab (also works around Tauri webview ignoring target=_blank).
    const anchor = event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>('a[href]')
      : null;
    if (anchor) {
      const href = anchor.getAttribute('href') ?? '';
      if (/^https?:\/\//.test(href)) {
        event.preventDefault();
        window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
    }

    const quoteToggle = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('button[data-quote-toggle]')
      : null;
    if (quoteToggle) {
      const quote = quoteToggle.previousElementSibling;
      if (quote instanceof HTMLElement && quote.matches('blockquote[data-collapsible-quote]')) {
        const expanded = quote.dataset.quoteExpanded === 'true';
        quote.dataset.quoteExpanded = expanded ? 'false' : 'true';
        quoteToggle.textContent = expanded ? '展开引用' : '收起引用';
      }
      return;
    }

    const collapseToggle = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('button[data-markdown-collapse]')
      : null;
    if (collapseToggle) {
      const block = collapseToggle.closest<HTMLElement>('[data-code-block="true"]');
      if (!block) return;
      const collapsed = block.dataset.codeCollapsed !== 'false';
      block.dataset.codeCollapsed = collapsed ? 'false' : 'true';
      collapseToggle.textContent = collapsed ? '收起' : '展开';
      return;
    }

    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('button[data-markdown-copy]')
      : null;
    if (!target) return;
    const block = target.closest<HTMLElement>('[data-code-block="true"]');
    const code = block?.querySelector('pre code');
    if (!code) return;
    void copyText(code.textContent ?? '').then(() => {
      target.textContent = '已复制';
      window.setTimeout(() => {
        if (target.isConnected) target.textContent = '复制';
      }, 1200);
    });
  };

  return (
    <div
      ref={rootRef}
      className={className ?? 'msg-content msg-md'}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function wrapMathTextNodes(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.includes('$')) return NodeFilter.FILTER_REJECT;
      if (parent.closest('pre, code, button, a, [data-katex-source], [data-mermaid-output]')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const fragment = mathFragmentFromText(node.textContent ?? '');
    if (fragment) node.replaceWith(fragment);
  }
}

function mathFragmentFromText(text: string): DocumentFragment | null {
  const re = /\$\$([\s\S]+?)\$\$|\$([^\n$]+?)\$/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let changed = false;
  const fragment = document.createDocumentFragment();
  while ((match = re.exec(text))) {
    const raw = match[0] ?? '';
    const source = (match[1] ?? match[2] ?? '').trim();
    const display = raw.startsWith('$$');
    const before = text[match.index - 1] ?? '';
    const after = text[match.index + raw.length] ?? '';
    if (!display && !shouldRenderInlineMath(source, before, after)) continue;
    if (match.index > lastIndex) fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
    const span = document.createElement(display ? 'div' : 'span');
    span.className = display ? 'markdown-math markdown-math--block' : 'markdown-math';
    span.dataset.katexSource = source;
    span.dataset.katexDisplay = display ? 'true' : 'false';
    span.textContent = raw;
    fragment.append(span);
    lastIndex = match.index + raw.length;
    changed = true;
  }
  if (!changed) return null;
  if (lastIndex < text.length) fragment.append(document.createTextNode(text.slice(lastIndex)));
  return fragment;
}

function shouldRenderInlineMath(source: string, before: string, after: string): boolean {
  if (!source || /^\s|\s$/.test(source)) return false;
  if (/^\d+(?:[.,]\d+)?$/.test(source)) return false;
  if (/[A-Za-z0-9)]/.test(before) || /[A-Za-z0-9(]/.test(after)) return false;
  return /\\|[=^_{}<>±×÷√∑∫∞]|[A-Za-z]\s*[+\-*/]\s*[A-Za-z0-9]/.test(source);
}

function enhanceLongBlockquotes(root: HTMLElement): void {
  const quotes = [...root.querySelectorAll<HTMLElement>('blockquote')];
  for (const quote of quotes) {
    if (quote.dataset.collapsibleQuote === 'true') continue;
    const text = quote.textContent ?? '';
    const lineCount = text.split('\n').length;
    if (text.length < 360 && lineCount < 5) continue;
    quote.dataset.collapsibleQuote = 'true';
    quote.dataset.quoteExpanded = 'false';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'markdown-quote-toggle';
    button.setAttribute('data-quote-toggle', 'true');
    button.textContent = '展开引用';
    quote.after(button);
  }
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', 'true');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
}
