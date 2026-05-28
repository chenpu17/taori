/**
 * Deep Research execution engine.
 *
 * After a session is /start?confirm=true, the runner is responsible for
 * draining the queued task list:
 *
 *   outline      — pre-completed by planner (seed).
 *   search       — calls builtin.web_search; each question can fan out into
 *                  multiple query rounds based on budget/depth until source
 *                  coverage is good enough. Results are deduped by locator and
 *                  top hits are hydrated with web_fetch snippets.
 *   summarize    — once all search tasks finish, rebuild draft_markdown
 *                  from collected sources, grouped by question.
 *   verify_citation — emit research_claims, one per output section, with
 *                  support_status decided by whether sources back them.
 *
 * Concurrency: one in-flight loop per session; subsequent /start or /resume
 * calls become no-ops while a loop is already alive. The loop polls the
 * session row each tick so /pause and /cancel take effect within ~50ms.
 *
 * Cost: each tool dispatch goes through CapabilityBus.invoke which writes
 * cost_records(source_type='tool_call'). The runner also updates the
 * session.budget_spent_usd cumulatively so the UI doesn't need to join.
 */

import type { ResearchSession, ResearchTask } from '@taori/shared';
import type { CapabilityBus } from '../bus/index.js';
import type { MemoriesRepo, ModelsRepo, ProvidersRepo, ResearchRepo } from '../db/repos/index.js';
import type { KeyStore } from '../keystore.js';
import { attachTaskNarrative, finalizeResearchSession } from './lifecycle.js';
import { pickPreferredSearchToolName } from '../search/tool-selection.js';
import type { SidecarTestHooksConfig } from '../config.js';
import { runSearch } from './search/run-search.js';
import type { SearchContext } from './search/types.js';
import { runFetch } from './handlers/fetch.js';
import { runSummarize } from './handlers/summarize.js';
import { runReflect } from './handlers/reflect.js';
import { runVerify } from './handlers/verify.js';

const TICK_DELAY_MS = 25;
const MAX_PARALLEL_SEARCHES = 3;

export interface ResearchRunnerDeps {
  repo: ResearchRepo;
  bus: CapabilityBus;
  memories?: MemoriesRepo;
  modelsRepo?: ModelsRepo;
  providersRepo?: ProvidersRepo;
  keystore?: KeyStore;
  testHooks?: Pick<SidecarTestHooksConfig, 'hermeticAiPlanner'>;
  log?: { info?: (msg: unknown, extra?: unknown) => void; warn?: (msg: unknown, extra?: unknown) => void; error?: (msg: unknown, extra?: unknown) => void };
}

type TaskOutcome = 'completed' | 'failed' | 'skipped';

export class ResearchRunner {
  private active = new Map<string, Promise<void>>();

  constructor(private deps: ResearchRunnerDeps) {}

  start(sessionId: string): Promise<void> {
    const existing = this.active.get(sessionId);
    if (existing) return existing;
    const loop = this.runLoop(sessionId).finally(() => {
      this.active.delete(sessionId);
    });
    this.active.set(sessionId, loop);
    return loop;
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  async drain(sessionId: string): Promise<void> {
    const loop = this.active.get(sessionId);
    if (loop) await loop;
  }

  private async runLoop(sessionId: string): Promise<void> {
    while (true) {
      const session = this.deps.repo.get(sessionId);
      if (!session) return;
      if (session.status !== 'running') return;
      const tasks = this.deps.repo.listTasks(sessionId);

      const queuedSearches = tasks.filter((t) => t.status === 'queued' && t.kind === 'search');
      if (queuedSearches.length > 1) {
        const batch = queuedSearches.slice(0, MAX_PARALLEL_SEARCHES);
        await Promise.allSettled(
          batch.map((t) => this.runTask(session, t)),
        );
        await sleep(TICK_DELAY_MS);
        continue;
      }

      const next = tasks.find((t) => t.status === 'queued');
      if (!next) {
        this.finalizeSession(this.deps.repo.get(sessionId) ?? session, this.deps.repo.listTasks(sessionId));
        return;
      }
      if (this.pauseIfNoSourcesForSynthesis(session, next)) return;
      const outcome = await this.runTask(session, next);
      if (outcome === 'failed' && (next.kind === 'summarize' || next.kind === 'verify_citation')) {
        this.finalizeSession(this.deps.repo.get(sessionId) ?? session, this.deps.repo.listTasks(sessionId));
        return;
      }
      await sleep(TICK_DELAY_MS);
    }
  }

  private pauseIfNoSourcesForSynthesis(session: ResearchSession, next: ResearchTask): boolean {
    if (next.kind !== 'summarize' && next.kind !== 'verify_citation') return false;
    const sources = this.deps.repo.listSources(session.id);
    if (sources.length > 0) return false;
    const reason =
      '没有收集到可用来源，已在生成草稿前暂停研究。请切换可用搜索源或调整研究方向后重试。';
    this.deps.repo.updateTask(next.id, {
      status: 'failed',
      finished_at: Date.now(),
      error: { message: reason },
    });
    for (const task of this.deps.repo.listTasks(session.id)) {
      if (task.id === next.id || task.status !== 'queued') continue;
      if (task.kind !== 'summarize' && task.kind !== 'verify_citation') continue;
      this.deps.repo.updateTask(task.id, {
        status: 'skipped',
        finished_at: Date.now(),
        output: { reason: 'missing_sources' },
      });
    }
    this.finalizeSession(this.deps.repo.get(session.id) ?? session, this.deps.repo.listTasks(session.id));
    return true;
  }

  private finalizeSession(session: ResearchSession, tasks: ResearchTask[]): void {
    finalizeResearchSession(this.deps.repo, session, tasks);
  }

  private async runTask(session: ResearchSession, task: ResearchTask): Promise<TaskOutcome> {
    const startedAt = Date.now();
    this.deps.repo.updateTask(task.id, { status: 'running', started_at: startedAt });
    try {
      switch (task.kind) {
        case 'search':
          this.deps.repo.update(session.id, { stage: 'searching' });
          await this.dispatchSearch(session, task);
          break;
        case 'fetch':
          await runFetch(
            { repo: this.deps.repo, bus: this.deps.bus, log: this.deps.log },
            session,
            task,
          );
          break;
        case 'summarize':
          this.deps.repo.update(session.id, { stage: 'drafting' });
          await runSummarize(
            { repo: this.deps.repo, modelsRepo: this.deps.modelsRepo, providersRepo: this.deps.providersRepo, keystore: this.deps.keystore, memories: this.deps.memories, log: this.deps.log },
            session,
          );
          break;
        case 'verify_citation':
          this.deps.repo.update(session.id, { stage: 'verifying' });
          await runVerify(
            { repo: this.deps.repo, modelsRepo: this.deps.modelsRepo, providersRepo: this.deps.providersRepo, keystore: this.deps.keystore, memories: this.deps.memories, log: this.deps.log },
            session,
          );
          break;
        case 'reflect':
          this.deps.repo.update(session.id, { stage: 'searching' });
          await runReflect(
            { repo: this.deps.repo, bus: this.deps.bus, modelsRepo: this.deps.modelsRepo, providersRepo: this.deps.providersRepo, keystore: this.deps.keystore, memories: this.deps.memories, log: this.deps.log },
            session,
            task,
          );
          break;
        case 'outline':
        case 'read_file':
          this.deps.repo.updateTask(task.id, {
            status: 'completed',
            finished_at: Date.now(),
            output: { skipped: true },
          });
          return 'completed';
        default:
          this.deps.repo.updateTask(task.id, {
            status: 'skipped',
            finished_at: Date.now(),
          });
          return 'skipped';
      }
      attachTaskNarrative(this.deps.repo, this.deps.log, session.id, task.id);
      this.deps.repo.updateTask(task.id, {
        status: 'completed',
        finished_at: Date.now(),
      });
      return 'completed';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log?.warn?.({ sessionId: session.id, taskId: task.id, err: message }, 'research task failed');
      this.deps.repo.updateTask(task.id, {
        status: 'failed',
        finished_at: Date.now(),
        error: { message },
      });
      return 'failed';
    }
  }

  private async dispatchSearch(session: ResearchSession, task: ResearchTask): Promise<void> {
    const question = String(task.input?.question ?? task.title ?? '').trim();
    const reason = String(task.input?.reason ?? '').trim();
    const questionId = typeof task.input?.question_id === 'string' ? task.input.question_id : undefined;
    const searchToolName = this.resolveSearchToolName(session, task);

    const ctx: SearchContext = {
      session,
      task,
      searchToolName,
      question,
      questionId,
      reason,
    };

    await runSearch(
      {
        repo: this.deps.repo,
        bus: this.deps.bus,
        modelsRepo: this.deps.modelsRepo,
        providersRepo: this.deps.providersRepo,
        keystore: this.deps.keystore,
        memories: this.deps.memories,
        testHooks: this.deps.testHooks,
        log: this.deps.log,
        bumpBudgetSpend: (sessionId, actualUsd) => this.bumpBudgetSpend(sessionId, actualUsd),
      },
      ctx,
    );
  }

  private resolveSearchToolName(session: ResearchSession, task: ResearchTask): string {
    const taskPreferredTool =
      typeof task.input?.search_tool === 'string' && task.input.search_tool.trim()
        ? task.input.search_tool.trim()
        : null;
    return pickPreferredSearchToolName(
      this.deps.bus,
      taskPreferredTool
        ?? session.preferred_search_tool
        ?? this.deps.memories?.getEffective(session.conversation_id ?? null, 'default_search_tool'),
      this.deps.bus.list().map((tool) => tool.name),
    ) ?? 'builtin.web_search';
  }

  private bumpBudgetSpend(sessionId: string, actualUsd: number | undefined): void {
    if (actualUsd == null || actualUsd === 0) return;
    try {
      const current = this.deps.repo.get(sessionId);
      if (!current) return;
      const next = (current.budget_spent_usd ?? 0) + actualUsd;
      this.deps.repo.update(sessionId, { budget_spent_usd: next });
    } catch {
      // Budget tracking is non-critical.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
