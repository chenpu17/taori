import { z } from 'zod';
import type { ToolContext, ToolDescriptor } from '../index.js';
import { cleanText, networkError, stripHtml, validationError } from './web_common.js';

export const BUILTIN_WEB_SEARCH_ENGINE_KEY = 'builtin_web_search_engine';
export const BUILTIN_WEB_SEARCH_BOCHA_API_KEY_KEY = 'builtin_web_search_bocha_api_key';

const InputSchema = z.object({
  query: z.string().min(1).max(500),
  num_results: z.number().int().min(1).max(10).optional(),
  engine: z.enum(['duckduckgo', 'exa', 'bocha']).optional(),
});

export type WebSearchEngine = 'duckduckgo' | 'exa' | 'bocha';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutput {
  query: string;
  engine: WebSearchEngine;
  fallback_from?: WebSearchEngine;
  results: WebSearchResult[];
}

export interface WebSearchDeps {
  fetch?: typeof fetch;
  resolveConfig?: (ctx: ToolContext) => {
    engine?: WebSearchEngine | null;
    bochaApiKey?: string | null;
  };
}

const SEARCH_ENDPOINTS = [
  'https://html.duckduckgo.com/html/?q=',
  'https://duckduckgo.com/html/?q=',
] as const;

const DEFAULT_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
} as const;

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
      'Search the public web for current information. Supports DuckDuckGo, Exa, and Bocha based on current settings. Returns titles, URLs, and snippets; use web_fetch for a chosen result.',
    capability: 'web',
    source: 'builtin',
    source_id: 'builtin',
    enabled: true,
    inputSchema: InputSchema,
    async execute(input, ctx) {
      const numResults = input.num_results ?? 5;
      const config = normalizeConfig(deps.resolveConfig?.(ctx));
      const explicitEngine = input.engine ?? null;
      const selectedEngine = explicitEngine ?? config.engine;
      if (selectedEngine === 'exa') {
        return {
          output: {
            query: input.query,
            engine: 'exa',
            results: await searchExa(fetchImpl, input.query, numResults),
          },
        };
      }
      if (selectedEngine === 'bocha') {
        if (!config.bochaApiKey) {
          throw validationError('搏查搜索缺少 API Key，请先在工具设置中保存。');
        }
        try {
          const bochaResults = await searchBocha(fetchImpl, input.query, numResults, config.bochaApiKey);
          if (bochaResults.length > 0) {
            return {
              output: {
                query: input.query,
                engine: 'bocha',
                results: bochaResults,
              },
            };
          }
          if (explicitEngine) {
            return {
              output: {
                query: input.query,
                engine: 'bocha',
                results: [],
              },
            };
          }
          throw networkError('Bocha search returned no usable results');
        } catch (bochaError) {
          if (explicitEngine) throw bochaError;
          try {
            const fallbackResults = await searchExa(fetchImpl, input.query, numResults);
            if (fallbackResults.length === 0) throw bochaError;
            return {
              output: {
                query: input.query,
                engine: 'exa',
                fallback_from: 'bocha',
                results: fallbackResults,
              },
            };
          } catch {
            throw bochaError;
          }
        }
      }
      try {
        const duckResults = await searchDuckDuckGo(fetchImpl, input.query, numResults);
        if (duckResults.length > 0 || explicitEngine) {
          return {
            output: {
              query: input.query,
              engine: 'duckduckgo',
              results: duckResults,
            },
          };
        }
        const fallbackResults = await searchExa(fetchImpl, input.query, numResults);
        if (fallbackResults.length > 0) {
          return {
            output: {
              query: input.query,
              engine: 'exa',
              fallback_from: 'duckduckgo',
              results: fallbackResults,
            },
          };
        }
        return {
          output: {
            query: input.query,
            engine: 'duckduckgo',
            results: duckResults,
          },
        };
      } catch (duckError) {
        if (explicitEngine) throw duckError;
        try {
          const fallbackResults = await searchExa(fetchImpl, input.query, numResults);
          if (fallbackResults.length === 0) throw duckError;
          return {
            output: {
              query: input.query,
              engine: 'exa',
              fallback_from: 'duckduckgo',
              results: fallbackResults,
            },
          };
        } catch {
          throw duckError;
        }
      }
    },
  };
}

function normalizeConfig(input?: {
  engine?: WebSearchEngine | null;
  bochaApiKey?: string | null;
}): { engine: WebSearchEngine; bochaApiKey: string | null } {
  const engine = input?.engine === 'exa' || input?.engine === 'bocha' ? input.engine : 'duckduckgo';
  return {
    engine,
    bochaApiKey: input?.bochaApiKey?.trim() || null,
  };
}

async function searchDuckDuckGo(
  fetchImpl: typeof fetch,
  query: string,
  numResults: number,
): Promise<WebSearchResult[]> {
  let lastError: unknown = null;
  for (const [index, endpoint] of SEARCH_ENDPOINTS.entries()) {
    try {
      const res = await fetchWithTimeout(
        fetchImpl,
        `${endpoint}${encodeURIComponent(query)}`,
        10_000,
        { headers: DEFAULT_HEADERS },
      );
      if (!res.ok) {
        lastError = networkError(`DuckDuckGo search failed: ${res.status} ${res.statusText}`);
        continue;
      }
      const html = await res.text();
      if (looksLikeDuckDuckGoAnomaly(html)) {
        throw networkError(
          'DuckDuckGo blocked the automated search with an anti-bot challenge. Please switch builtin web search to Exa or Bocha, or retry later.',
        );
      }
      const results = parseDuckDuckGo(html, numResults);
      if (results.length > 0 || index === SEARCH_ENDPOINTS.length - 1) {
        return results;
      }
      lastError = networkError('DuckDuckGo search returned no parsable results');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : networkError('DuckDuckGo search failed');
}

function looksLikeDuckDuckGoAnomaly(html: string): boolean {
  return /Unfortunately,\s*bots use DuckDuckGo too\./i.test(html) ||
    /anomaly-modal/i.test(html) ||
    /anomaly\.js\?/i.test(html);
}

async function searchExa(
  fetchImpl: typeof fetch,
  query: string,
  numResults: number,
): Promise<WebSearchResult[]> {
  const response = await fetchWithTimeout(fetchImpl, 'https://mcp.exa.ai/mcp', 20_000, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'web_search_exa',
        arguments: {
          query,
          type: 'auto',
          numResults,
          livecrawl: 'fallback',
          contextMaxCharacters: 10_000,
        },
      },
    }),
  });
  if (!response.ok) {
    throw networkError(`Exa search failed: ${response.status} ${response.statusText}`);
  }
  return parseExaResponse(await response.text());
}

async function searchBocha(
  fetchImpl: typeof fetch,
  query: string,
  numResults: number,
  apiKey: string,
): Promise<WebSearchResult[]> {
  const sessionId = await initializeBochaSession(fetchImpl, apiKey);
  const response = await fetchWithTimeout(fetchImpl, 'https://mcp.bochaai.com/mcp', 20_000, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'bocha_web_search',
        arguments: {
          query,
          count: numResults,
        },
      },
    }),
  });
  if (!response.ok) {
    throw networkError(`Bocha search failed: ${response.status} ${response.statusText}`);
  }
  return parseBochaResponse(await response.text());
}

async function initializeBochaSession(fetchImpl: typeof fetch, apiKey: string): Promise<string> {
  const response = await fetchWithTimeout(fetchImpl, 'https://mcp.bochaai.com/mcp', 20_000, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'taori', version: '1.0.0' },
      },
    }),
  });
  if (!response.ok) {
    throw networkError(`Bocha initialize failed: ${response.status} ${response.statusText}`);
  }
  const sessionId = response.headers.get('mcp-session-id');
  if (!sessionId) {
    throw networkError('Bocha initialize failed: missing session id');
  }
  return sessionId;
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

function parseExaResponse(responseText: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  for (const line of responseText.split('\n')) {
    if (!line.trim() || line.startsWith('event:')) continue;
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (parsed?.error) {
      throw networkError(`Exa search error: ${parsed.error.message ?? 'unknown'}`);
    }
    const text = parsed?.result?.content?.[0]?.text;
    if (typeof text === 'string' && text.trim()) {
      return parseStructuredTextResults(text);
    }
  }
  return results;
}

function parseBochaResponse(responseText: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  for (const line of responseText.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (parsed?.error) {
      throw networkError(`Bocha search error: ${parsed.error.message ?? 'unknown'}`);
    }
    const text = parsed?.result?.content?.[0]?.text;
    if (typeof text === 'string' && text.trim()) {
      if (looksLikeBochaErrorText(text)) {
        throw networkError(cleanText(text));
      }
      return parseStructuredTextResults(text);
    }
    if (Array.isArray(parsed?.results)) {
      return parsed.results.map((item: any) => ({
        title: cleanText(String(item?.title ?? item?.name ?? '')),
        url: String(item?.url ?? item?.link ?? ''),
        snippet: cleanText(String(item?.snippet ?? item?.description ?? item?.content ?? '')),
      })).filter((item: WebSearchResult) => item.url);
    }
  }
  return results;
}

function looksLikeBochaErrorText(text: string): boolean {
  return /invalid api key|http error occurred|401\b|403\b|unauthorized|forbidden/i.test(text);
}

function parseStructuredTextResults(text: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blocks = text.split(/(?=^Title:\s)/m);
  for (const block of blocks) {
    const titleMatch = block.match(/^Title:\s*(.+?)(?:\n|$)/m);
    const urlMatch = block.match(/URL:\s*(https?:\/\/[^\s\n]+)/im);
    const publishedMatch = block.match(/Published:\s*(.+?)(?:\n|$)/im);
    const descMatch = block.match(
      /(?:Description|Text|Content):\s*([\s\S]+?)(?=\n(?:Title|URL|Description|Text|Content|Published|Site|Author):|$)/i,
    );
    const title = cleanText(titleMatch?.[1] ?? '');
    const url = urlMatch?.[1]?.trim() ?? '';
    const published = cleanText(publishedMatch?.[1] ?? '');
    const snippet = cleanText([published, descMatch?.[1] ?? ''].filter(Boolean).join(' — '));
    if (title || url) {
      results.push({ title, url, snippet });
    }
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
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw networkError(`web_search timeout after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export const __test__ = {
  parseDuckDuckGo,
  parseExaResponse,
  parseBochaResponse,
  parseStructuredTextResults,
  looksLikeDuckDuckGoAnomaly,
};
