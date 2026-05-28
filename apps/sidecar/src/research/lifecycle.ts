import type { ResearchSession, ResearchTask } from '@taori/shared';
import type { ResearchRepo } from '../db/repos/index.js';
import { buildTaskNarrative } from './narrative.js';

export interface ResearchLifecycleLog {
  warn?: (msg: unknown, extra?: unknown) => void;
}

/**
 * Compute a one-sentence task narrative and merge it into `output.narrative`.
 * Safe to call on tasks with no useful narrative.
 */
export function attachTaskNarrative(
  repo: ResearchRepo,
  log: ResearchLifecycleLog | undefined,
  sessionId: string,
  taskId: string,
): void {
  try {
    const fresh = repo.getTask(taskId);
    if (!fresh) return;
    const sources = (fresh.kind === 'summarize' || fresh.kind === 'verify_citation')
      ? repo.listSources(sessionId)
      : undefined;
    const claims = fresh.kind === 'verify_citation'
      ? repo.listClaims(sessionId)
      : undefined;
    const session = (fresh.kind === 'summarize')
      ? repo.get(sessionId)
      : null;
    const draftCharCount = session?.draft_markdown?.length ?? undefined;
    const narrative = buildTaskNarrative(fresh, { sources, claims, draftCharCount });
    if (!narrative) return;
    const nextOutput = { ...(fresh.output ?? {}), narrative };
    repo.updateTask(taskId, { output: nextOutput });
  } catch (err) {
    log?.warn?.({ err, sessionId, taskId }, 'research.narrative_failed');
  }
}

export function finalizeResearchSession(
  repo: ResearchRepo,
  session: ResearchSession,
  tasks: ResearchTask[],
): void {
  const hasFailed = tasks.some((t) => t.status === 'failed');
  const current = repo.get(session.id) ?? session;
  repo.update(session.id, {
    status: hasFailed ? 'paused' : 'completed',
    stage: hasFailed ? session.stage : 'finalized',
    completed_at: hasFailed ? null : Date.now(),
    ...(hasFailed || current.final_markdown != null || current.draft_markdown == null
      ? {}
      : { final_markdown: current.draft_markdown }),
  });
}
