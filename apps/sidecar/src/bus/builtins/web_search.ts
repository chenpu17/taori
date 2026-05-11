import { z } from 'zod';
import type { ToolDescriptor } from '../index.js';
import { cleanText, networkError, stripHtml } from './web_common.js';

const InputSchema = z.object({
  query: z.string().min(1).max(500),
  num_results: z.number().int().min(1).max(10).optional(),
});

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutput {
  query: string;
  engine: 'duckduckgo';
  results: WebSearchResult[];
}

export interface WebSearchDeps {
  fetch?: typeof fetch;
}

const SEARCH_ENDPOINTS = [
  'https://html.duckduckgo.com/html/?q=',
  'https://duckduckgo.com/html/?q=',
] as const;

export function createWebSearchTool(): ToolDescriptor<
  z.infer<typeof InputSchema>,
  WebSearchOutput
> {
  return createWebSearchToolWithDeps({});
}

export function createWebSearchToolWithDeps(
  deps: WebSearchDeps = {},
): ToolDescriptor<z.infer<typeof InputSchema>, WebSearchOutput> {
  const fetchImpl = deps.fetch ?? fetch;
  return {
    name: 'builtin.web_search',
    description:
      'Search the public web for current information. Returns titles, URLs, and snippets; use web_fetch for a chosen result.',
    capability: 'web',
    source: 'builtin',
    source_id: 'builtin',
    enabled: true,
    inputSchema: InputSchema,
    async execute(input) {
      const numResults = input.num_results ?? 5;
      const headers = {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      };
      let lastError: unknown = null;
      for (const [index, endpoint] of SEARCH_ENDPOINTS.entries()) {
        try {
          const res = await fetchWithTimeout(
            fetchImpl,
            `${endpoint}${encodeURIComponent(input.query)}`,
            10_000,
            headers,
          );
          if (!res.ok) {
            lastError = networkError(`DuckDuckGo search failed: ${res.status} ${res.statusText}`);
            continue;
          }
          const html = await res.text();
          const results = parseDuckDuckGo(html, numResults);
          if (results.length > 0 || index === SEARCH_ENDPOINTS.length - 1) {
            return {
              output: {
                query: input.query,
                engine: 'duckduckgo',
                results,
              },
            };
          }
          lastError = networkError('DuckDuckGo search returned no parsable results');
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : networkError('DuckDuckGo search failed');
    },
  };
}

function parseDuckDuckGo(html: string, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const resultRegex = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let snippetMatch: RegExpExecArray | null;
  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(snippetMatch[1] ?? ''));
  }

  let match: RegExpExecArray | null;
  while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
    const rawUrl = match[1] ?? '';
    const title = stripHtml(match[2] ?? '');
    const url = extractDuckDuckGoUrl(rawUrl);
    if (!url || !title) continue;
    results.push({
      title: cleanText(title),
      url,
      snippet: snippets[results.length] ?? '',
    });
  }
  return results;
}

function extractDuckDuckGoUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw, 'https://duckduckgo.com');
    if (parsed.hostname === 'duckduckgo.com' && parsed.pathname === '/l/') {
      const uddg = parsed.searchParams.get('uddg');
      return uddg ? decodeURIComponent(uddg) : null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { headers, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw networkError(`web_search timeout after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export const __test__ = { parseDuckDuckGo };
