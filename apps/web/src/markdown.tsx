import { useState, type ReactNode } from 'react';

function CodeBlockWithCopy({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="md-codeblock">
      <div className="md-codeblock-head">
        <span>{lang || ''}</span>
        <button type="button" className="md-codeblock-copy" onClick={handleCopy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

export function renderMarkdown(raw: string): ReactNode[] {
  try {
    return renderMarkdownInner(raw);
  } catch {
    return [raw];
  }
}

function renderMarkdownInner(raw: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = raw.split('\n');
  let i = 0;
  let key = 0;
  const nk = () => `md${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    const fenceMatch = line.match(/^(`{3,})(\w*)/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      nodes.push(<CodeBlockWithCopy key={nk()} code={codeLines.join('\n')} lang={lang} />);
      continue;
    }

    const hdrMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (hdrMatch) {
      const level = Math.min(hdrMatch[1].length + 1, 4);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      nodes.push(<Tag key={nk()}>{parseInline(hdrMatch[2], nk)}</Tag>);
      i++;
      continue;
    }

    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        quoteLines.push(lines[i].replace(/^> ?/, ''));
        i++;
      }
      nodes.push(<blockquote key={nk()}>{renderMarkdown(quoteLines.join('\n'))}</blockquote>);
      continue;
    }

    if (line.match(/^\s*[-*]\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\s*[-*]\s+/)) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      nodes.push(<ul key={nk()}>{items.map((item, idx) => <li key={idx}>{parseInline(item, nk)}</li>)}</ul>);
      continue;
    }

    if (line.match(/^\s*\d+\.\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\s*\d+\.\s+/)) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      nodes.push(<ol key={nk()}>{items.map((item, idx) => <li key={idx}>{parseInline(item, nk)}</li>)}</ol>);
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].match(/^(`{3,})/) &&
      !lines[i].match(/^#{1,4}\s/) &&
      !lines[i].startsWith('> ') &&
      !lines[i].match(/^\s*[-*]\s+/) &&
      !lines[i].match(/^\s*\d+\.\s+/)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    nodes.push(<p key={nk()}>{parseInline(paraLines.join('\n'), nk)}</p>);
  }

  return nodes;
}

function parseInline(text: string, nk: () => string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = /(`[^`\n]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      nodes.push(...handleLineBreaks(plain));
    }

    const full = match[0];
    if (full.startsWith('`') && full.endsWith('`')) {
      nodes.push(<code key={nk()}>{full.slice(1, -1)}</code>);
    } else if (full.startsWith('**') && full.endsWith('**')) {
      nodes.push(<strong key={nk()}>{parseInline(full.slice(2, -2), nk)}</strong>);
    } else if (full.startsWith('*') && full.endsWith('*')) {
      nodes.push(<em key={nk()}>{parseInline(full.slice(1, -1), nk)}</em>);
    } else if (full.startsWith('[') && full.includes('](')) {
      const linkMatch = full.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        nodes.push(
          <a key={nk()} href={linkMatch[2]} target="_blank" rel="noopener noreferrer">
            {linkMatch[1]}
          </a>,
        );
      } else {
        nodes.push(full);
      }
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(...handleLineBreaks(text.slice(lastIndex)));
  }

  return nodes;
}

function handleLineBreaks(text: string): ReactNode[] {
  const parts = text.split('\n');
  const result: ReactNode[] = [];
  let k = 0;
  for (let j = 0; j < parts.length; j++) {
    if (parts[j]) result.push(parts[j]);
    if (j < parts.length - 1) result.push(<br key={`br${k++}`} />);
  }
  return result;
}
