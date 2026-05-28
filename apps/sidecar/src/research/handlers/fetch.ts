/**
 * Research task handler: fetch a URL and upsert the source.
 *
 * Extracted from ResearchRunner.runFetch so the handler can be tested and
 * composed independently of the runner class.
 */

import type { ResearchSession, ResearchTask } from '@taori/shared';
import type { CapabilityBus } from '../../bus/index.js';
import type { ResearchRepo } from '../../db/repos/index.js';

export interface FetchHandlerDeps {
  repo: ResearchRepo;
  bus: CapabilityBus;
  log?: { info?: (msg: unknown, extra?: unknown) => void; warn?: (msg: unknown, extra?: unknown) => void; error?: (msg: unknown, extra?: unknown) => void };
}

const FETCH_MAX_CHARS = 5000;

export async function runFetch(
  deps: FetchHandlerDeps,
  session: ResearchSession,
  task: ResearchTask,
): Promise<void> {
  const url = String(task.input?.url ?? '');
  if (!url) {
    deps.repo.updateTask(task.id, { output: { reason: 'no_url' } });
    return;
  }
  const res = await deps.bus.invoke(
    'builtin.web_fetch',
    { url, format: 'markdown', max_chars: FETCH_MAX_CHARS },
    { conversationId: session.conversation_id ?? null },
  );
  if (!res.ok) throw new Error(`web_fetch failed: ${res.error?.message ?? 'unknown'}`);
  if (typeof res.cost?.actual_usd === 'number' && res.cost.actual_usd > 0) {
    deps.repo.incrementBudgetSpent(session.id, res.cost.actual_usd);
  }
  const out = res.output as { title?: string | null; content?: string };
  const existing = deps.repo.findSourceByLocator(session.id, url);
  const { classifySourceKind, scoreCredibility } = await import('../search/execute-round.js');
  const sourceKind = classifySourceKind(url, typeof existing?.metadata?.query === 'string' ? existing.metadata.query : '');
  if (existing) {
    deps.repo.updateSource(existing.id, {
      title: out.title ?? existing.title,
      snippet: out.content?.slice(0, 3_900) ?? existing.snippet,
      metadata: { ...(existing.metadata ?? {}), source_kind: sourceKind, fetched: true },
    });
  } else {
    deps.repo.appendSource(session.id, {
      source_type: 'web_page',
      title: out.title?.slice(0, 240) ?? null,
      locator: url,
      snippet: out.content?.slice(0, 3_900) ?? null,
      credibility_score: scoreCredibility(url, sourceKind),
      included: true,
      metadata: { fetched: true, source_kind: sourceKind },
    });
  }
}
