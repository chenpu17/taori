import type { ResearchSource } from '@taori/shared';
import type { CapabilityBus } from '../../bus/index.js';
import type { ResearchRepo } from '../../db/repos/index.js';
import type { SearchEngine, SourceKind, WebSearchHit } from './types.js';
import { SEARCH_RESULTS_PER_TASK, FETCH_TOP_N, FETCH_MAX_CHARS } from './types.js';

export interface ExecuteRoundDeps {
  repo: ResearchRepo;
  bus: CapabilityBus;
  log?: { info?: (msg: unknown, extra?: unknown) => void; warn?: (msg: unknown, extra?: unknown) => void; error?: (msg: unknown, extra?: unknown) => void };
  bumpBudgetSpend: (sessionId: string, actualUsd: number | undefined) => void;
}

export interface ExecuteRoundParams {
  sessionId: string;
  conversationId: string | null;
  searchToolName: string;
  query: string;
  questionId?: string;
  requestedEngine?: SearchEngine;
}

export async function executeSearchRound(
  deps: ExecuteRoundDeps,
  params: ExecuteRoundParams,
): Promise<{ recorded: ResearchSource[]; engine: string | null; fallbackFrom: string | null; track: SourceKind }> {
  const { repo, bus, bumpBudgetSpend } = deps;
  const { sessionId, conversationId, searchToolName, query, questionId, requestedEngine } = params;

  const searchTrack = inferSearchTrack(query);
  const res = await bus.invoke(
    searchToolName,
    { query, num_results: SEARCH_RESULTS_PER_TASK, ...(requestedEngine ? { engine: requestedEngine } : {}) },
    { conversationId },
  );
  if (!res.ok) {
    throw new Error(`${searchToolName} failed: ${res.error?.message ?? 'unknown'}`);
  }
  bumpBudgetSpend(sessionId, res.cost?.actual_usd);
  const output = res.output as { results?: WebSearchHit[]; engine?: string; fallback_from?: string };
  const hits = output?.results ?? [];
  const recorded: ResearchSource[] = [];
  for (const hit of hits.slice(0, SEARCH_RESULTS_PER_TASK)) {
    if (!hit?.url) continue;
    const sourceKind = classifySourceKind(hit.url, query);
    const existing = repo.findSourceByLocator(sessionId, hit.url);
    if (existing) {
      const nextMetadata = mergeQuestionMetadata(existing.metadata, questionId, {
        query,
        search_tool: searchToolName,
        search_engine: output?.engine ?? null,
        search_fallback_from: output?.fallback_from ?? null,
        search_track: searchTrack,
        source_kind: sourceKind,
      });
      if (JSON.stringify(nextMetadata) !== JSON.stringify(existing.metadata ?? {})) {
        repo.updateSource(existing.id, { metadata: nextMetadata });
      }
      continue;
    }
    const inserted = repo.appendSource(sessionId, {
      source_type: 'web_page',
      title: hit.title?.slice(0, 240) ?? null,
      locator: hit.url,
      snippet: hit.snippet?.slice(0, 3_900) ?? null,
      credibility_score: scoreCredibility(hit.url, sourceKind),
      included: true,
      metadata: mergeQuestionMetadata({}, questionId, {
        query,
        search_tool: searchToolName,
        search_engine: output?.engine ?? null,
        search_fallback_from: output?.fallback_from ?? null,
        search_track: searchTrack,
        source_kind: sourceKind,
      }),
    });
    recorded.push(inserted);
  }
  // Fetch top pages in parallel for better throughput.
  await Promise.allSettled(
    recorded.slice(0, FETCH_TOP_N).map(async (source) => {
      try {
        const fetched = await bus.invoke(
          'builtin.web_fetch',
          { url: source.locator, format: 'markdown', max_chars: FETCH_MAX_CHARS },
          { conversationId },
        );
        bumpBudgetSpend(sessionId, fetched.cost?.actual_usd);
        if (fetched.ok) {
          const out = fetched.output as { title?: string | null; content?: string };
          const snippet = (out.content ?? '').slice(0, 3_900) || source.snippet;
          repo.updateSource(source.id, {
            title: out.title ?? source.title,
            snippet,
            metadata: { ...source.metadata, fetched: true },
          });
        }
      } catch {
        // ignore individual fetch failures; search hits are still recorded.
      }
    }),
  );
  return {
    recorded,
    engine: output?.engine ?? null,
    fallbackFrom: output?.fallback_from ?? null,
    track: searchTrack,
  };
}

// ─── Helper functions ────────────────────────────────────────────────────────

export function scoreCredibility(url: string, sourceKind: SourceKind = classifySourceKind(url)): number {
  try {
    const host = new URL(url).hostname;
    if (sourceKind === 'official') return 0.92;
    if (/(status|docs|developer|developers|support|help)\./.test(host)) return 0.9;
    if (/(\.gov|\.edu)(\.|$)/.test(host)) return 0.9;
    if (/(arxiv|nature|nih|who|imf|worldbank)\./.test(host)) return 0.85;
    if (/(wikipedia|britannica)\./.test(host)) return 0.75;
    if (/(github|stackoverflow)\./.test(host)) return 0.7;
    if (/(medium|substack|zhihu|csdn)\./.test(host)) return 0.55;
    return 0.6;
  } catch {
    return 0.5;
  }
}

export function inferSearchTrack(query: string): SourceKind {
  if (/(官方|官网|文档|公告|状态页|status|docs?|developer|api)/i.test(query)) return 'official';
  if (/(论坛|社区|博客|实战|经验|github|stackoverflow|reddit|hacker news|用户反馈)/i.test(query)) {
    return 'community';
  }
  return 'third_party';
}

export function classifySourceKind(url: string, query = ''): SourceKind {
  const fallback = inferSearchTrack(query);
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (
      /(docs|developer|developers|support|help|status)\./.test(host)
      || /^\/(docs|documentation|api|developer|developers|help|support|status)(\/|$)/.test(pathname)
    ) {
      return 'official';
    }
    if (/(github|stackoverflow|reddit|lobste|news\.ycombinator|medium|substack|zhihu|csdn)\./.test(host)) {
      return 'community';
    }
    if (fallback === 'official') return 'official';
  } catch {
    return fallback;
  }
  return fallback;
}

export function mergeQuestionMetadata(
  metadata: Record<string, unknown> | null | undefined,
  questionId: string | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  if (questionId) {
    next.question_id = next.question_id ?? questionId;
    const ids = new Set<string>(
      Array.isArray(next.question_ids)
        ? next.question_ids.filter((value): value is string => typeof value === 'string')
        : typeof next.question_id === 'string'
          ? [next.question_id]
          : [],
    );
    ids.add(questionId);
    next.question_ids = Array.from(ids);
  }
  return { ...next, ...patch };
}

export function collectSourcesForQuestion(
  sources: ResearchSource[],
  question: string,
  questionId?: string,
): ResearchSource[] {
  return sources.filter((source) => matchesQuestion(source, question, questionId));
}

function matchesQuestion(source: ResearchSource, question: string, questionId?: string): boolean {
  if (questionId && source.metadata?.question_id === questionId) return true;
  if (
    questionId &&
    Array.isArray(source.metadata?.question_ids) &&
    source.metadata.question_ids.some((value) => value === questionId)
  ) {
    return true;
  }
  if (!question) return true;
  const hay = `${source.title ?? ''} ${source.snippet ?? ''}`.toLowerCase();
  if (!hay.trim()) return false;
  const tokens = meaningfulQuestionTokens(question);
  if (tokens.length === 0) return true;
  return tokens.some((t) => hay.includes(t));
}

function meaningfulQuestionTokens(question: string): string[] {
  const generic = new Set([
    'api',
    'apis',
    '模型',
    '大模型',
    '主流',
    '中国',
    '国产',
    '官方',
    '对比',
    '比较',
    '信息',
    '指标',
    '数据',
    '最新',
    '当前',
    'token',
    'tokens',
  ]);
  return question
    .toLowerCase()
    .split(/[\s,，。、？?!！:：;；()\[\]【】"'`]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !generic.has(token))
    .slice(0, 8);
}
