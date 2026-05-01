import { z } from 'zod';
import type { ToolDescriptor } from '../index.js';
import {
  assertPublicHttpUrl,
  extractTitle,
  htmlToMarkdown,
  networkError,
  stripHtml,
  validationError,
} from './web_common.js';

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const InputSchema = z.object({
  url: z.string().min(1).max(4096),
  format: z.enum(['markdown', 'text', 'html']).optional(),
  max_chars: z.number().int().min(500).max(50_000).optional(),
});

export interface WebFetchOutput {
  url: string;
  title: string | null;
  content_type: string;
  content: string;
  truncated: boolean;
}

export function createWebFetchTool(): ToolDescriptor<
  z.infer<typeof InputSchema>,
  WebFetchOutput
> {
  return {
    name: 'builtin.web_fetch',
    description:
      'Fetch a public URL and return readable page content as markdown, text, or html. Blocks localhost/private-network URLs.',
    capability: 'web',
    source: 'builtin',
    source_id: 'builtin',
    enabled: true,
    inputSchema: InputSchema,
    async execute(input) {
      const format = input.format ?? 'markdown';
      const maxChars = input.max_chars ?? 12_000;
      let target = normalizeUrl(input.url);
      await assertPublicHttpUrl(target);

      let response = await fetchOnce(target);
      for (let i = 0; i < MAX_REDIRECTS && isRedirect(response); i++) {
        const location = response.headers.get('location');
        if (!location) break;
        target = new URL(location, target).href;
        await assertPublicHttpUrl(target);
        response = await fetchOnce(target);
      }
      if (isRedirect(response)) throw networkError('Too many redirects');
      if (!response.ok) {
        throw networkError(`Request failed: ${response.status} ${response.statusText}`);
      }

      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (contentLength > MAX_RESPONSE_BYTES) {
        throw networkError('Response too large (exceeds 5MB limit)');
      }
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.byteLength > MAX_RESPONSE_BYTES) {
        throw networkError('Response too large (exceeds 5MB limit)');
      }

      const contentType = response.headers.get('content-type') ?? 'text/plain';
      const raw = new TextDecoder().decode(buf);
      const title = contentType.includes('html') ? extractTitle(raw) : null;
      let content: string;
      if (format === 'html') {
        content = raw;
      } else if (format === 'text') {
        content = contentType.includes('html') ? stripHtml(raw) : raw.trim();
      } else {
        content = contentType.includes('html') ? htmlToMarkdown(raw) : raw.trim();
      }

      const truncated = content.length > maxChars;
      if (truncated) content = `${content.slice(0, maxChars)}\n\n[内容已截断]`;

      return {
        output: {
          url: target,
          title,
          content_type: contentType,
          content,
          truncated,
        },
      };
    },
  };
}

function normalizeUrl(raw: string): string {
  try {
    return new URL(raw).href;
  } catch {
    throw validationError('URL must be a fully-formed http(s) URL');
  }
}

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400 && response.headers.has('location');
}

async function fetchOnce(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        accept:
          'text/markdown;q=1.0,text/plain;q=0.9,text/html;q=0.8,application/xhtml+xml;q=0.7,*/*;q=0.1',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw networkError('web_fetch timeout after 20000ms');
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
