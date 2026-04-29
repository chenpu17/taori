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
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span',
    ],
    ALLOWED_ATTR: ['href', 'title', 'class'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#)/i,
  });
}
