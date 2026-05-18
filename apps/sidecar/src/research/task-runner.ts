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

import { generateText, streamText } from 'ai';
import type {
  ResearchClaim,
  ResearchPlan,
  ResearchSession,
  ResearchSource,
  ResearchTask,
} from '@taori/shared';
import type { CapabilityBus } from '../bus/index.js';
import type { MemoriesRepo, ModelsRepo, ProvidersRepo } from '../db/repos/index.js';
import type { ResearchRepo } from '../db/repos/index.js';
import type { KeyStore } from '../keystore.js';
import { createChatModel } from '../providers/chat-model.js';
import { buildSearchQueries, buildSearchRecoveryQueries, classifySearchFailureReason } from './planner.js';
import { pickPreferredSearchToolName } from '../search/tool-selection.js';
import { runCitationVerification, confidenceToSupportStatus } from './citation-agent.js';
import { generateLLMQueries } from './query-planner.js';
import { buildTaskNarrative } from './narrative.js';

const SEARCH_RESULTS_PER_TASK = 8;
const FETCH_TOP_N = 4;
const FETCH_MAX_CHARS = 5000;
const TICK_DELAY_MS = 25;

export interface ResearchRunnerDeps {
  repo: ResearchRepo;
  bus: CapabilityBus;
  memories?: MemoriesRepo;
  modelsRepo?: ModelsRepo;
  providersRepo?: ProvidersRepo;
  keystore?: KeyStore;
  log?: { info?: (msg: unknown, extra?: unknown) => void; warn?: (msg: unknown, extra?: unknown) => void; error?: (msg: unknown, extra?: unknown) => void };
}

interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

interface SearchRoundSummary {
  query: string;
  hits: number;
  total_sources: number;
  unique_hosts: number;
  requested_engine?: SearchEngine | null;
  search_engine: string | null;
  search_fallback_from: string | null;
  search_track: SourceKind;
  phase: 'primary' | 'recovery';
  error?: string | null;
}

type TaskOutcome = 'completed' | 'failed' | 'skipped';
type SourceKind = 'official' | 'third_party' | 'community';
type SearchEngine = 'duckduckgo' | 'exa' | 'bocha';

export class ResearchRunner {
  private active = new Map<string, Promise<void>>();

  constructor(private deps: ResearchRunnerDeps) {}

  /**
   * Idempotently start the loop for a session. If a loop is already running
   * (or scheduled), returns the existing promise so callers can await it
   * (mostly useful in tests).
   */
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

  /** Test helper: await any running loop for the session. */
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

      // Batch-execute all queued search tasks in parallel for speed and depth.
      const queuedSearches = tasks.filter((t) => t.status === 'queued' && t.kind === 'search');
      if (queuedSearches.length > 1) {
        await Promise.allSettled(
          queuedSearches.map((t) => this.runTask(session, t)),
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

  /**
   * After a task's inner work has finished (and any business outputs are
   * already in the repo), compute a one-sentence narrative and merge it into
   * `output.narrative`. The frontend renders these as a timeline so users see
   * a continuous "what just happened" thread instead of a static task list.
   *
   * Safe to call on tasks with no useful narrative — we silently skip those.
   */
  private attachNarrative(sessionId: string, taskId: string): void {
    try {
      const fresh = this.deps.repo.getTask(taskId);
      if (!fresh) return;
      const sources = (fresh.kind === 'summarize' || fresh.kind === 'verify_citation')
        ? this.deps.repo.listSources(sessionId)
        : undefined;
      const claims = fresh.kind === 'verify_citation'
        ? this.deps.repo.listClaims(sessionId)
        : undefined;
      const session = (fresh.kind === 'summarize')
        ? this.deps.repo.get(sessionId)
        : null;
      const draftCharCount = session?.draft_markdown?.length ?? undefined;
      const narrative = buildTaskNarrative(fresh, { sources, claims, draftCharCount });
      if (!narrative) return;
      const nextOutput = { ...(fresh.output ?? {}), narrative };
      this.deps.repo.updateTask(taskId, { output: nextOutput });
    } catch (err) {
      this.deps.log?.warn?.({ err, sessionId, taskId }, 'research.narrative_failed');
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
    const hasFailed = tasks.some((t) => t.status === 'failed');
    const current = this.deps.repo.get(session.id) ?? session;
    this.deps.repo.update(session.id, {
      status: hasFailed ? 'paused' : 'completed',
      stage: hasFailed ? session.stage : 'finalized',
      completed_at: hasFailed ? null : Date.now(),
      ...(hasFailed || current.final_markdown != null || current.draft_markdown == null
        ? {}
        : { final_markdown: current.draft_markdown }),
    });
  }

  private async runTask(session: ResearchSession, task: ResearchTask): Promise<TaskOutcome> {
    const startedAt = Date.now();
    this.deps.repo.updateTask(task.id, { status: 'running', started_at: startedAt });
    try {
      switch (task.kind) {
        case 'search':
          this.deps.repo.update(session.id, { stage: 'searching' });
          await this.runSearch(session, task);
          break;
        case 'fetch':
          await this.runFetch(session, task);
          break;
        case 'summarize':
          this.deps.repo.update(session.id, { stage: 'drafting' });
          await this.runSummarize(session);
          break;
        case 'verify_citation':
          this.deps.repo.update(session.id, { stage: 'verifying' });
          await this.runVerify(session);
          break;
        case 'reflect':
          this.deps.repo.update(session.id, { stage: 'searching' });
          await this.runReflect(session, task);
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
      this.attachNarrative(session.id, task.id);
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

  private async runSearch(session: ResearchSession, task: ResearchTask): Promise<void> {
    const question = String(task.input?.question ?? task.title ?? '').trim();
    const reason = String(task.input?.reason ?? '').trim();
    const questionId = typeof task.input?.question_id === 'string' ? task.input.question_id : undefined;

    // Try LLM-driven query planning first ("wide → narrow"). Falls back to
    // the deterministic template when no model is configured, in hermetic
    // mode, or when parsing the LLM response fails. The template fallback
    // is what we had before — the only behavior change for users without a
    // configured model is "no change at all".
    const llmPlan = (this.deps.modelsRepo && this.deps.providersRepo)
      ? await generateLLMQueries(
          {
            session,
            question: { question, reason: reason || '研究需要' },
            budgetMode: session.budget_mode,
          },
          {
            modelsRepo: this.deps.modelsRepo,
            providersRepo: this.deps.providersRepo,
            keystore: this.deps.keystore ?? null,
            memories: this.deps.memories ?? null,
            log: this.deps.log,
          },
        )
      : null;

    const configured = (llmPlan && llmPlan.ok)
      ? llmPlan.queries
      : buildSearchQueries({
          title: session.title,
          objective: session.objective,
          question: { question, reason: reason || '研究需要' },
          budgetMode: session.budget_mode,
          constraints: session.constraints,
        });
    const queries = uniqueSearchQueries([
      String(task.input?.query ?? '').trim(),
      ...configured,
      question,
    ]);
    if (queries.length === 0) {
      this.deps.repo.updateTask(task.id, { output: { reason: 'empty_query' } });
      return;
    }
    const querySource: 'llm' | 'template' = llmPlan?.ok ? 'llm' : 'template';
    const queryStrategy = llmPlan?.ok ? llmPlan.strategy : null;
    const annotatedQueries = llmPlan?.ok ? llmPlan.annotated : null;
    const searchToolName = this.resolveSearchToolName(session, task);
    const rounds: SearchRoundSummary[] = [];
    const attemptedEngines = new Set<string>();
    let attemptedQueries = [...queries];
    let matchedSources = collectSourcesForQuestion(
      this.deps.repo.listSources(session.id),
      question,
      questionId,
    );
    for (const query of queries) {
      const result = await this.executeSearchAttemptsForQuery(
        session,
        task,
        searchToolName,
        query,
        question,
        questionId,
        'primary',
      );
      matchedSources = result.matchedSources;
      result.rounds.forEach((round) => {
        if (round.search_engine) attemptedEngines.add(round.search_engine);
        if (round.requested_engine) attemptedEngines.add(round.requested_engine);
      });
      rounds.push(...result.rounds);
      if (hasEnoughSearchCoverage(matchedSources, session.budget_mode)) break;
    }
    // Recovery: prefer LLM-generated alternatives that know which queries
    // already failed; fall back to the deterministic recovery generator.
    let recoveryQueries: string[] = [];
    let recoveryStrategy: string | null = null;
    let recoverySource: 'llm' | 'template' | null = null;
    if (matchedSources.length === 0) {
      const llmRecovery = (this.deps.modelsRepo && this.deps.providersRepo)
        ? await generateLLMQueries(
            {
              session,
              question: { question, reason: reason || '研究需要' },
              budgetMode: session.budget_mode,
              attemptedQueries: queries,
              isRecovery: true,
            },
            {
              modelsRepo: this.deps.modelsRepo,
              providersRepo: this.deps.providersRepo,
              keystore: this.deps.keystore ?? null,
              memories: this.deps.memories ?? null,
              log: this.deps.log,
            },
          )
        : null;
      if (llmRecovery?.ok) {
        recoveryQueries = llmRecovery.queries;
        recoveryStrategy = llmRecovery.strategy;
        recoverySource = 'llm';
      } else {
        recoveryQueries = buildSearchRecoveryQueries({
          title: session.title,
          objective: session.objective,
          question: { question, reason: reason || '研究需要' },
          budgetMode: session.budget_mode,
          constraints: session.constraints,
          originalQueries: queries,
        });
        recoverySource = recoveryQueries.length > 0 ? 'template' : null;
      }
    }
    if (matchedSources.length === 0 && recoveryQueries.length > 0) {
      attemptedQueries = uniqueSearchQueries([...attemptedQueries, ...recoveryQueries]);
      for (const query of recoveryQueries) {
        const result = await this.executeSearchAttemptsForQuery(
          session,
          task,
          searchToolName,
          query,
          question,
          questionId,
          'recovery',
        );
        matchedSources = result.matchedSources;
        result.rounds.forEach((round) => {
          if (round.search_engine) attemptedEngines.add(round.search_engine);
          if (round.requested_engine) attemptedEngines.add(round.requested_engine);
        });
        rounds.push(...result.rounds);
        if (hasEnoughSearchCoverage(matchedSources, session.budget_mode)) break;
      }
    }
    if (matchedSources.length === 0) {
      const failureReason = classifySearchFailureReason({
        title: session.title,
        objective: session.objective,
        question,
        reason: reason || '研究需要',
        attemptedRecovery: recoveryQueries.length > 0,
      });
      this.deps.repo.updateTask(task.id, {
        output: {
          hits: 0,
          query: queries[0],
          queries: attemptedQueries,
          rounds,
          rounds_completed: rounds.length,
          unique_hosts: 0,
          search_tool: searchToolName,
          engine_attempts: Array.from(attemptedEngines),
          search_engine: rounds.at(-1)?.search_engine ?? null,
          search_fallback_from: rounds.find((round) => round.search_fallback_from)?.search_fallback_from ?? null,
          recovery_attempted: recoveryQueries.length > 0,
          recovery_queries: recoveryQueries,
          recovery_strategy: recoveryStrategy,
          recovery_source: recoverySource,
          query_source: querySource,
          query_strategy: queryStrategy,
          query_plan: annotatedQueries,
          failure_reason: failureReason,
          coverage_status: 'no_usable_sources',
        },
      });
      return;
    }
    const lastRound = rounds.at(-1) ?? null;
    this.deps.repo.updateTask(task.id, {
      output: {
        hits: matchedSources.length,
        query: queries[0],
        queries: rounds.map((round) => round.query),
        rounds,
        rounds_completed: rounds.length,
        unique_hosts: countUniqueHosts(matchedSources),
        search_tool: searchToolName,
        engine_attempts: Array.from(attemptedEngines),
        search_engine: lastRound?.search_engine ?? null,
        search_fallback_from: rounds.find((round) => round.search_fallback_from)?.search_fallback_from ?? null,
        recovery_attempted: recoveryQueries.length > 0,
        recovery_queries: recoveryQueries,
        recovery_strategy: recoveryStrategy,
        recovery_source: recoverySource,
        recovery_successful: recoveryQueries.length > 0 && rounds.some((round) => round.phase === 'recovery' && round.hits > 0),
        query_source: querySource,
        query_strategy: queryStrategy,
        query_plan: annotatedQueries,
      },
    });
    // Snapshot session budget from cost_records sum is expensive; defer to
    // verify step which aggregates once.
  }

  private async executeSearchRound(
    session: ResearchSession,
    task: ResearchTask,
    searchToolName: string,
    query: string,
    questionId?: string,
    requestedEngine?: SearchEngine,
  ): Promise<{ recorded: ResearchSource[]; engine: string | null; fallbackFrom: string | null; track: SourceKind }> {
    const searchTrack = inferSearchTrack(query);
    const res = await this.deps.bus.invoke(
      searchToolName,
      { query, num_results: SEARCH_RESULTS_PER_TASK, ...(requestedEngine ? { engine: requestedEngine } : {}) },
      { conversationId: session.conversation_id ?? null },
    );
    if (!res.ok) {
      throw new Error(`${searchToolName} failed: ${res.error?.message ?? 'unknown'}`);
    }
    this.bumpBudgetSpend(session.id, res.cost?.actual_usd);
    const output = res.output as { results?: WebSearchHit[]; engine?: string; fallback_from?: string };
    const hits = output?.results ?? [];
    const recorded: ResearchSource[] = [];
    for (const hit of hits.slice(0, SEARCH_RESULTS_PER_TASK)) {
      if (!hit?.url) continue;
      const sourceKind = classifySourceKind(hit.url, query);
      const existing = this.deps.repo.findSourceByLocator(session.id, hit.url);
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
          this.deps.repo.updateSource(existing.id, { metadata: nextMetadata });
        }
        continue;
      }
      const inserted = this.deps.repo.appendSource(session.id, {
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
          const fetched = await this.deps.bus.invoke(
            'builtin.web_fetch',
            { url: source.locator, format: 'markdown', max_chars: FETCH_MAX_CHARS },
            { conversationId: session.conversation_id ?? null },
          );
          this.bumpBudgetSpend(session.id, fetched.cost?.actual_usd);
          if (fetched.ok) {
            const out = fetched.output as { title?: string | null; content?: string };
            const snippet = (out.content ?? '').slice(0, 3_900) || source.snippet;
            this.deps.repo.updateSource(source.id, {
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

  private resolveBuiltinSearchEngineCandidates(session: ResearchSession): SearchEngine[] {
    const configured = this.deps.memories?.getEffective(session.conversation_id ?? null, 'builtin_web_search_engine');
    const current: SearchEngine =
      configured === 'exa' || configured === 'bocha' ? configured : 'duckduckgo';
    const bochaApiKey =
      String(this.deps.memories?.getEffective(session.conversation_id ?? null, 'builtin_web_search_bocha_api_key') ?? '')
        .trim();
    const candidates: SearchEngine[] = [current];
    if (current !== 'exa') candidates.push('exa');
    if (bochaApiKey && current !== 'bocha') candidates.push('bocha');
    if (current !== 'duckduckgo') candidates.push('duckduckgo');
    return candidates.filter((engine, index, arr) => arr.indexOf(engine) === index);
  }

  private async executeSearchAttemptsForQuery(
    session: ResearchSession,
    task: ResearchTask,
    searchToolName: string,
    query: string,
    question: string,
    questionId: string | undefined,
    phase: 'primary' | 'recovery',
  ): Promise<{ rounds: SearchRoundSummary[]; matchedSources: ResearchSource[] }> {
    const rounds: SearchRoundSummary[] = [];
    let matchedSources = collectSourcesForQuestion(
      this.deps.repo.listSources(session.id),
      question,
      questionId,
    );
    const candidates: Array<SearchEngine | undefined> =
      searchToolName === 'builtin.web_search'
        ? this.resolveBuiltinSearchEngineCandidates(session)
        : [undefined];

    for (const requestedEngine of candidates) {
      const beforeCount = matchedSources.length;
      try {
        const round = await this.executeSearchRound(
          session,
          task,
          searchToolName,
          query,
          questionId,
          requestedEngine,
        );
        matchedSources = collectSourcesForQuestion(
          this.deps.repo.listSources(session.id),
          question,
          questionId,
        );
        rounds.push({
          query,
          hits: round.recorded.length,
          total_sources: matchedSources.length,
          unique_hosts: countUniqueHosts(matchedSources),
          requested_engine: requestedEngine ?? null,
          search_engine: round.engine,
          search_fallback_from: round.fallbackFrom,
          search_track: round.track,
          phase,
        });
        if (matchedSources.length > beforeCount || round.recorded.length > 0) break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rounds.push({
          query,
          hits: 0,
          total_sources: matchedSources.length,
          unique_hosts: countUniqueHosts(matchedSources),
          requested_engine: requestedEngine ?? null,
          search_engine: requestedEngine ?? null,
          search_fallback_from: null,
          search_track: inferSearchTrack(query),
          phase,
          error: message,
        });
        if (searchToolName !== 'builtin.web_search') throw error;
      }
    }
    return { rounds, matchedSources };
  }

  private async runReflect(session: ResearchSession, task: ResearchTask): Promise<void> {
    if (!this.deps.modelsRepo || !this.deps.providersRepo) {
      this.deps.repo.updateTask(task.id, { output: { skipped: true, reason: 'no_model_deps' } });
      return;
    }
    const sources = this.deps.repo.listSources(session.id);
    if (sources.length === 0) {
      this.deps.repo.updateTask(task.id, { output: { skipped: true, reason: 'no_sources' } });
      return;
    }

    const rawQuestions = Array.isArray(task.input?.questions) ? task.input.questions as Array<{ id: string; question: string; reason: string }> : [];
    const maxFollowUps = typeof task.input?.max_follow_ups === 'number' ? task.input.max_follow_ups : 2;
    const currentRound = typeof task.input?.reflect_round === 'number' ? task.input.reflect_round : 1;
    const maxRounds = session.budget_mode === 'deep' ? 3 : 2;

    let chatModel: ReturnType<typeof createChatModel>['model'] | null = null;
    try {
      const picked = await pickSynthesisModel(
        session,
        this.deps.modelsRepo,
        this.deps.providersRepo,
        this.deps.keystore ?? null,
        this.deps.memories ?? null,
      );
      if (picked) {
        chatModel = createChatModel({ provider: picked.provider, model: picked.model, apiKey: picked.apiKey }).model;
      }
    } catch {
      // ignore model errors; just skip reflect
    }

    if (!chatModel) {
      this.deps.repo.updateTask(task.id, { output: { skipped: true, reason: 'no_usable_model' } });
      return;
    }

    const prompt = buildReflectPrompt(session, rawQuestions, sources);
    let reflectResult: ReflectResult | null = null;
    try {
      const { text } = await generateText({
        model: chatModel,
        prompt,
        maxTokens: 1500,
        abortSignal: AbortSignal.timeout(25_000),
      });
      reflectResult = parseReflectResponse(text);
    } catch (err) {
      this.deps.log?.warn?.({ err, sessionId: session.id }, 'research.reflect_failed');
    }

    if (!reflectResult || reflectResult.follow_up_searches.length === 0) {
      this.deps.repo.updateTask(task.id, { output: { skipped: true, reason: 'no_gaps_identified', raw: reflectResult } });
      return;
    }

    // Insert targeted follow-up search tasks before the summarize task.
    // They will be picked up by the main loop (batch-parallel) in the next tick.
    const searchToolName = pickPreferredSearchToolName(
      this.deps.bus,
      session.preferred_search_tool ?? this.deps.memories?.getEffective(session.conversation_id ?? null, 'default_search_tool'),
      this.deps.bus.list().map((tool) => tool.name),
    ) ?? 'builtin.web_search';

    const followUps = reflectResult.follow_up_searches.slice(0, maxFollowUps);
    const addedTasks: string[] = [];
    for (const gap of followUps) {
      if (!gap.query?.trim()) continue;
      const inserted = this.deps.repo.insertTask(session.id, {
        kind: 'search',
        status: 'queued',
        title: `补充检索（第${currentRound}轮）：${gap.topic ?? gap.query}`,
        input: {
          question: gap.topic ?? gap.query,
          reason: '信息空白补充',
          query: gap.query,
          is_follow_up: true,
          reflect_round: currentRound,
          search_tool: searchToolName,
        },
      });
      addedTasks.push(inserted.id);
    }

    // If there are gaps and we haven't hit the reflect round cap, schedule another reflect pass
    // after the follow-up searches complete. This creates an organic multi-round loop.
    const hasPartialOrMissing = reflectResult.coverage.some((c) => c.level !== 'good');
    if (hasPartialOrMissing && currentRound < maxRounds && followUps.length > 0) {
      this.deps.repo.insertTask(session.id, {
        kind: 'reflect',
        status: 'queued',
        title: `深度反思（第${currentRound + 1}轮）`,
        input: {
          questions: rawQuestions,
          max_follow_ups: maxFollowUps,
          reflect_round: currentRound + 1,
        },
      });
    }

    this.deps.repo.updateTask(task.id, {
      output: {
        coverage: reflectResult.coverage,
        follow_up_searches: followUps,
        added_tasks: addedTasks,
        reflect_round: currentRound,
        next_round_scheduled: hasPartialOrMissing && currentRound < maxRounds && followUps.length > 0,
      },
    });
  }

  private async runFetch(session: ResearchSession, task: ResearchTask): Promise<void> {
    const url = String(task.input?.url ?? '');
    if (!url) {
      this.deps.repo.updateTask(task.id, { output: { reason: 'no_url' } });
      return;
    }
    const res = await this.deps.bus.invoke(
      'builtin.web_fetch',
      { url, format: 'markdown', max_chars: FETCH_MAX_CHARS },
      { conversationId: session.conversation_id ?? null },
    );
    if (!res.ok) throw new Error(`web_fetch failed: ${res.error?.message ?? 'unknown'}`);
    this.bumpBudgetSpend(session.id, res.cost?.actual_usd);
    const out = res.output as { title?: string | null; content?: string };
    const existing = this.deps.repo.findSourceByLocator(session.id, url);
    const sourceKind = classifySourceKind(url, typeof existing?.metadata?.query === 'string' ? existing.metadata.query : '');
    if (existing) {
      this.deps.repo.updateSource(existing.id, {
        title: out.title ?? existing.title,
        snippet: out.content?.slice(0, 3_900) ?? existing.snippet,
        metadata: { ...(existing.metadata ?? {}), source_kind: sourceKind, fetched: true },
      });
    } else {
      this.deps.repo.appendSource(session.id, {
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

  private async runSummarize(session: ResearchSession): Promise<void> {
    const plan = session.plan;
    if (!plan) return;
    const sources = this.deps.repo.listSources(session.id);

    // Attempt streaming LLM synthesis when model deps are available. Streaming
    // matters because synthesis can take 30-90s — flushing partial markdown
    // every ~200 chars or 1s lets the UI render the draft as it lands instead
    // of staring at a blank pane.
    if (this.deps.modelsRepo && this.deps.providersRepo) {
      try {
        const picked = await pickSynthesisModel(
          session,
          this.deps.modelsRepo,
          this.deps.providersRepo,
          this.deps.keystore ?? null,
          this.deps.memories ?? null,
        );
        if (picked) {
          const { model: chatModel } = createChatModel({
            provider: picked.provider,
            model: picked.model,
            apiKey: picked.apiKey,
          });
          const prompt = buildSynthesisPrompt(session, plan, sources);
          const accumulated = await this.streamSynthesisToDraft(session.id, chatModel, prompt);
          if (accumulated && accumulated.trim().length > 100) {
            this.deps.repo.update(session.id, { draft_markdown: accumulated.trim() });
            return;
          }
        }
      } catch (err) {
        this.deps.log?.warn?.({ err, sessionId: session.id }, 'research.llm_synthesis_failed');
      }
    }

    // Fallback: template-based draft
    const draft = buildDraft(session, plan, sources);
    this.deps.repo.update(session.id, { draft_markdown: draft });
  }

  /**
   * Stream synthesis output, flushing the rolling buffer to draft_markdown
   * every ~200 chars or 1 second. Returns the final accumulated text even if
   * the stream is interrupted mid-way (so partial drafts aren't lost).
   */
  private async streamSynthesisToDraft(
    sessionId: string,
    chatModel: ReturnType<typeof createChatModel>['model'],
    prompt: string,
  ): Promise<string> {
    let buf = '';
    let lastFlushLen = 0;
    let lastFlushAt = Date.now();
    try {
      const { textStream } = streamText({
        model: chatModel,
        prompt,
        maxTokens: 8192,
        abortSignal: AbortSignal.timeout(120_000),
      });
      for await (const chunk of textStream) {
        buf += chunk;
        const sizeDelta = buf.length - lastFlushLen;
        const timeDelta = Date.now() - lastFlushAt;
        if (sizeDelta >= 200 || timeDelta >= 1000) {
          this.deps.repo.update(sessionId, { draft_markdown: buf });
          lastFlushLen = buf.length;
          lastFlushAt = Date.now();
        }
      }
    } catch (err) {
      this.deps.log?.warn?.({ err, sessionId }, 'research.synthesis_stream_interrupted');
      // Fall through — return whatever we accumulated so the caller can
      // decide between using the partial draft and the template fallback.
    }
    if (buf.length > lastFlushLen) {
      this.deps.repo.update(sessionId, { draft_markdown: buf });
    }
    return buf;
  }

  private async runVerify(session: ResearchSession): Promise<void> {
    const plan = session.plan;
    if (!plan) return;
    const sources = this.deps.repo.listSources(session.id);
    const draft = (this.deps.repo.get(session.id)?.draft_markdown ?? session.draft_markdown ?? '').trim();

    // Prefer CitationAgent grounding when model deps + draft + sources exist.
    // Falls through to the legacy template-based summary only when CitationAgent
    // can't produce anything usable (no model, empty draft, or zero sources).
    if (this.deps.modelsRepo && this.deps.providersRepo && draft && sources.length > 0) {
      try {
        const result = await runCitationVerification(session, draft, sources, {
          modelsRepo: this.deps.modelsRepo,
          providersRepo: this.deps.providersRepo,
          keystore: this.deps.keystore ?? null,
          memories: this.deps.memories ?? null,
          log: this.deps.log,
          pickModel: () => pickSynthesisModel(
            session,
            this.deps.modelsRepo!,
            this.deps.providersRepo!,
            this.deps.keystore ?? null,
            this.deps.memories ?? null,
          ),
        });
        if (result.ok && result.claims.length > 0) {
          const verifiedAt = Date.now();
          const claims = result.claims.map<Omit<ResearchClaim, 'id' | 'research_session_id' | 'created_at' | 'updated_at'>>((c) => ({
            section_key: c.section_key,
            claim_text: c.claim_text,
            claim_kind: c.claim_kind,
            support_status: confidenceToSupportStatus(c.confidence, c.evidence_spans),
            citations: c.evidence_spans.map((span) => {
              const src = sources.find((s) => s.id === span.source_id);
              return {
                source_id: span.source_id,
                locator: src?.locator ?? null,
                note: span.span_text.slice(0, 240),
              };
            }),
            evidence_spans: c.evidence_spans,
            confidence: c.confidence,
            verified_at: verifiedAt,
          }));
          this.deps.repo.replaceClaims(session.id, claims);
          return;
        }
      } catch (err) {
        this.deps.log?.warn?.({ err, sessionId: session.id }, 'research.citation_agent_threw');
      }
    }

    // Fallback: legacy template-based section summaries. Kept so verify never
    // leaves the claims table empty when CitationAgent is unavailable.
    const sections = outputSections(plan.output_kind);
    const claims: Array<Omit<ResearchClaim, 'id' | 'research_session_id' | 'created_at' | 'updated_at'>> = [];
    for (let i = 0; i < sections.length; i += 1) {
      const section = sections[i] ?? `第 ${i + 1} 部分`;
      const question = pickQuestionForSection(plan, section, i);
      const matching = sources
        .filter((s) => matchesQuestion(s, question?.question ?? '', question?.id))
        .slice(0, 3);
      const support = pickSupport(matching);
      claims.push({
        section_key: section,
        claim_text: buildClaimText(section, question?.question ?? session.objective, matching),
        claim_kind: i === 0 ? 'recommendation' : 'fact',
        support_status: support,
        citations: matching.map((s) => ({ source_id: s.id, locator: s.locator, note: s.title })),
        evidence_spans: [],
        confidence: null,
        verified_at: null,
      });
    }
    this.deps.repo.replaceClaims(session.id, claims);
  }

  private bumpBudgetSpend(sessionId: string, actualUsd: number | undefined): void {
    if (typeof actualUsd !== 'number' || actualUsd <= 0) return;
    this.deps.repo.incrementBudgetSpent(sessionId, actualUsd);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── LLM synthesis helpers ────────────────────────────────────────────────────

async function pickSynthesisModel(
  session: ResearchSession,
  modelsRepo: ModelsRepo,
  providersRepo: ProvidersRepo,
  keystore: KeyStore | null,
  memories: MemoriesRepo | null,
): Promise<{ model: import('@taori/shared').Model; provider: import('@taori/shared').Provider; apiKey: string } | null> {
  // Priority chain: per-session synthesis override → per-session preferred chat model →
  // memories 'default_research_synthesis_model' → memories 'default_model_id' →
  // first available chat model. The synthesis-specific knobs let users pick a
  // beefier model (e.g. Opus) for research even when chat defaults to a cheaper
  // one.
  const synthesisOverride = session.synthesis_model_id
    ?? memories?.getEffective(session.conversation_id ?? null, 'default_research_synthesis_model')
    ?? null;
  const candidateIds = [
    synthesisOverride,
    session.preferred_model_id,
    memories?.getEffective(null, 'default_model_id') ?? null,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);

  let model: import('@taori/shared').Model | null = null;
  for (const id of candidateIds) {
    const candidate = modelsRepo.get(id);
    if (candidate?.enabled && candidate.provider_id) {
      model = candidate;
      break;
    }
  }
  if (!model?.enabled || !model.provider_id) {
    model = modelsRepo.defaultFor('chat') ?? modelsRepo.pickCheapestActive('chat', '__none__');
  }
  if (!model?.provider_id) return null;

  const provider = providersRepo.get(model.provider_id);
  if (!provider) return null;

  let apiKey = '';
  if (provider.api_key_ref && keystore) {
    try {
      apiKey = (await keystore.read(provider.api_key_ref)) ?? '';
    } catch {
      // key unavailable
    }
  }

  return { model, provider, apiKey };
}

function buildSynthesisPrompt(
  session: ResearchSession,
  plan: ResearchPlan,
  sources: ResearchSource[],
): string {
  const kindLabel: Record<string, string> = {
    report: '综合研究报告',
    brief: '简报（摘要 + 关键事实 + 风险 + 下一步行动）',
    comparison: '对比分析（各方案横向对比 + 建议）',
    decision: '决策建议（结论 + 依据 + 可选路径 + 执行建议）',
  };
  const structureGuide: Record<string, string> = {
    report: '## 执行摘要\n\n## 核心发现\n\n## 详细分析\n\n## 矛盾与争议\n\n## 不确定性与局限\n\n## 风险\n\n## 建议与后续步骤',
    brief: '## 摘要（3-5 句话）\n\n## 关键事实\n\n## 风险\n\n## 下一步行动',
    comparison: '## 结论（哪种方案更合适，一句话）\n\n## 关键维度对比表\n\n## 各方案深度分析\n\n## 矛盾与数据分歧\n\n## 风险与注意事项\n\n## 选择建议（按场景分类）',
    decision: '## 推荐结论（直接给出答案）\n\n## 决策依据\n\n## 可选路径对比\n\n## 矛盾与数据分歧\n\n## 风险与前提条件\n\n## 执行建议',
  };
  const kind = plan.output_kind ?? 'report';

  // Prefer both credibility and recency so"当前主流/当前定价"不容易被旧资料盖过去。
  const sortedSources = [...sources].sort((a, b) => sourceSortScore(b) - sourceSortScore(a));

  // Group sources by question for better LLM comprehension
  const sourcesByQuestion = new Map<string, ResearchSource[]>();
  const unassignedSources: ResearchSource[] = [];

  for (const source of sortedSources) {
    const qid = typeof source.metadata?.question_id === 'string' ? source.metadata.question_id : null;
    const qids = Array.isArray(source.metadata?.question_ids) ? source.metadata.question_ids as string[] : [];
    const allQids = new Set([...(qid ? [qid] : []), ...qids]);
    if (allQids.size === 0) {
      unassignedSources.push(source);
    } else {
      for (const id of allQids) {
        if (!sourcesByQuestion.has(id)) sourcesByQuestion.set(id, []);
        sourcesByQuestion.get(id)!.push(source);
      }
    }
  }

  let globalIndex = 1;
  const sourceIndexMap = new Map<string, number>();

  function credibilityTag(score: number | null | undefined): string {
    const s = score ?? 0.5;
    if (s >= 0.85) return '★高可信';
    if (s >= 0.7) return '★中等';
    return '';
  }

  const questionsText = plan.key_questions.map((q) => {
    const qSources = sourcesByQuestion.get(q.id) ?? [];
    const sourceLines = qSources.map((s) => {
      if (!sourceIndexMap.has(s.id)) sourceIndexMap.set(s.id, globalIndex++);
      const idx = sourceIndexMap.get(s.id)!;
      const title = (s.title ?? s.locator).slice(0, 200);
      const snippet = (s.snippet ?? '').slice(0, 1500).replace(/\s+/g, ' ');
      const tag = credibilityTag(s.credibility_score);
      const year = inferSourceYear(s);
      return `  [${idx}]${tag ? ` ${tag}` : ''}${year ? ` [年份:${year}]` : ''} 标题：${title}\n      来源：${s.locator}\n      内容：${snippet || '（无摘要）'}`;
    }).join('\n\n');
    return `【问题 ${q.id}：${q.question}（${q.reason}）】\n${sourceLines || '  （本问题未找到对应资料）'}`;
  }).join('\n\n---\n\n');

  // Any sources not linked to a specific question
  const unassignedText = unassignedSources.length > 0
    ? '\n\n【其他相关资料】\n' + unassignedSources.map((s) => {
        if (!sourceIndexMap.has(s.id)) sourceIndexMap.set(s.id, globalIndex++);
        const idx = sourceIndexMap.get(s.id)!;
        const title = (s.title ?? s.locator).slice(0, 200);
        const snippet = (s.snippet ?? '').slice(0, 800).replace(/\s+/g, ' ');
        const tag = credibilityTag(s.credibility_score);
        const year = inferSourceYear(s);
        return `  [${idx}]${tag ? ` ${tag}` : ''}${year ? ` [年份:${year}]` : ''} 标题：${title}\n      来源：${s.locator}\n      内容：${snippet || '（无摘要）'}`;
      }).join('\n\n')
    : '';

  const totalSources = sourceIndexMap.size + unassignedSources.filter(s => !sourceIndexMap.has(s.id)).length;

  const kindSpecificInstructions = kind === 'comparison'
    ? `对比分析报告要求：
- 必须用 Markdown 表格展示关键维度对比（列 = 各方案，行 = 各维度）
- 表格后逐方案深入分析，不只是表格总结
- 明确指出哪些数据来自官方、哪些是第三方评测
- 给出按不同使用场景的选型建议（不同团队规模/预算/需求）`
    : kind === 'decision'
    ? `决策建议报告要求：
- 开头直接给出"推荐使用 X"或"不建议现在做 Y"的明确结论
- 决策树或条件式建议：列出"如果你的情况是 A，则选 X；如果是 B，则选 Y"
- 明确列出推荐的前提条件和风险假设
- 对不推荐选项说明具体原因`
    : kind === 'brief'
    ? `简报要求：
- 摘要控制在 5 句话以内，高度精炼
- 关键事实用 bullet point 列出，每条一个独立可操作的信息点
- 风险按优先级排序`
    : `综合报告要求：
- 执行摘要要能让忙碌的决策者在 30 秒内理解全文结论
- 详细分析部分按证据强度分层：强证据 → 弱证据 → 推断
- 对有争议的点要平衡呈现多方观点`;

  return `你是一名顶级研究分析师，具备以下专业能力：多源信息综合、证据可信度评估、矛盾识别与调和、深度洞察提炼。

【研究主题】${session.title}
【研究目标】${session.objective}
【输出类型】${kindLabel[kind] ?? kindLabel.report}
【研究计划摘要】${plan.summary}

━━━ 收集到的研究资料（共 ${totalSources} 条来源，按可信度排序）━━━

${questionsText}${unassignedText}

━━━ 分析任务 ━━━

请完成以下三步分析，然后输出最终报告：

第一步（不要输出）：对每个研究问题，梳理已知事实、识别不同来源间的矛盾或分歧。
第二步（不要输出）：评估证据质量，标注哪些结论有强支撑，哪些是推断或待验证。
第三步：基于前两步，撰写完整的 Markdown 报告。

━━━ 最终报告格式 ━━━

# ${session.title}

${structureGuide[kind] ?? structureGuide.report}

## 参考来源

━━━ 撰写要求 ━━━

${kindSpecificInstructions}

通用要求：
- 每个重要论断用 [[序号]](URL) 格式内联引用来源，例如 [[1]](https://example.com)
- 当不同来源说法存在矛盾时，必须在"矛盾与数据分歧"或正文中明确指出，分析可能原因
- 信息不足之处说明"已知：X，尚不确定：Y"，不要回避或跳过
- ★高可信 标记的来源优先引用；多个来源一致时，说明"多来源一致"以增强说服力
- 如果问题强调"当前/主流/最新/近 12 个月"，优先采用年份更新、能代表当前产品状态的来源；引用旧型号、旧价格或旧能力时，必须明确年份并说明它是否仍是当前主推。
- 参考来源部分格式：[[序号]] 标题 — URL（每条一行）
- 内容必须基于提供的资料，禁止凭空发挥；资料不足之处明确标注，不要虚构数据`;
}

// ─── Reflect helpers ─────────────────────────────────────────────────────────

interface ReflectCoverageItem {
  question_id: string;
  level: 'good' | 'partial' | 'missing';
  what_we_know: string;
  what_is_missing: string;
}

interface ReflectFollowUp {
  topic: string;
  query: string;
}

interface ReflectResult {
  coverage: ReflectCoverageItem[];
  follow_up_searches: ReflectFollowUp[];
}

function buildReflectPrompt(
  session: ResearchSession,
  questions: Array<{ id: string; question: string; reason: string }>,
  sources: ResearchSource[],
): string {
  const questionLines = questions
    .map((q, i) => `${i + 1}. [${q.id}] ${q.question}（${q.reason}）`)
    .join('\n');

  // Group sources by question for the prompt
  const grouped = questions.map((q) => {
    const qSources = sources.filter((s) => {
      const qid = typeof s.metadata?.question_id === 'string' ? s.metadata.question_id : null;
      const qids = Array.isArray(s.metadata?.question_ids) ? s.metadata.question_ids as string[] : [];
      return qid === q.id || qids.includes(q.id);
    });
    if (qSources.length === 0) return `[${q.id}] ${q.question}\n  → 未找到相关资料`;
    const summaries = qSources.slice(0, 5).map((s) => {
      const title = (s.title ?? s.locator).slice(0, 120);
      const snippet = (s.snippet ?? '').slice(0, 400).replace(/\s+/g, ' ');
      return `  - ${title}: ${snippet || '（无摘要）'}`;
    }).join('\n');
    return `[${q.id}] ${q.question}\n${summaries}`;
  }).join('\n\n');

  return `你是一名专业研究分析师，正在评估一项深度研究的当前信息覆盖情况。

研究主题：${session.title}
研究目标：${session.objective}

关键研究问题：
${questionLines}

当前已收集的资料摘要（按问题分组）：
${grouped}

---

请评估每个问题的信息覆盖情况，并识别最重要的信息空白，以便进行补充检索。

严格按照以下 JSON 格式输出（不要包含任何其他文字）：
{
  "coverage": [
    {
      "question_id": "q1",
      "level": "good",
      "what_we_know": "已掌握的核心内容（30字以内）",
      "what_is_missing": "仍缺少什么信息（30字以内，good级别可写'覆盖充分'）"
    }
  ],
  "follow_up_searches": [
    {
      "topic": "具体缺少的信息描述",
      "query": "用于补充检索的搜索词（英文或中文，适合搜索引擎）"
    }
  ]
}

要求：
- coverage 包含所有问题的评估，level 为 good/partial/missing 之一
- follow_up_searches 只包含 level 为 partial 或 missing 的最重要补充，最多 3 条
- 如果覆盖已经充分，follow_up_searches 可以为空数组 []
- 搜索词要具体、可操作，适合直接输入搜索引擎
- 如果问题涉及"中国主流大模型 API"这类宽表对比，优先把补搜拆成具体厂商 + 指标（如 DeepSeek 定价、豆包 首token延迟），不要继续输出笼统的总表查询`;
}

function parseReflectResponse(text: string): ReflectResult | null {
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return null;
    const raw = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;

    const coverage: ReflectCoverageItem[] = [];
    if (Array.isArray(raw.coverage)) {
      for (const item of raw.coverage) {
        if (typeof item !== 'object' || item === null) continue;
        const c = item as Record<string, unknown>;
        if (typeof c.question_id !== 'string') continue;
        coverage.push({
          question_id: c.question_id,
          level: (c.level === 'good' || c.level === 'partial' || c.level === 'missing') ? c.level : 'partial',
          what_we_know: typeof c.what_we_know === 'string' ? c.what_we_know.slice(0, 200) : '',
          what_is_missing: typeof c.what_is_missing === 'string' ? c.what_is_missing.slice(0, 200) : '',
        });
      }
    }

    const followUps: ReflectFollowUp[] = [];
    if (Array.isArray(raw.follow_up_searches)) {
      for (const item of raw.follow_up_searches) {
        if (typeof item !== 'object' || item === null) continue;
        const f = item as Record<string, unknown>;
        if (typeof f.query !== 'string' || !f.query.trim()) continue;
        followUps.push({
          topic: typeof f.topic === 'string' ? f.topic.slice(0, 200) : f.query,
          query: f.query.trim().slice(0, 200),
        });
      }
    }

    return { coverage, follow_up_searches: followUps };
  } catch {
    return null;
  }
}

function scoreCredibility(url: string, sourceKind: SourceKind = classifySourceKind(url)): number {
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

function inferSourceYear(source: ResearchSource): number | null {
  const hay = `${source.title ?? ''} ${source.snippet ?? ''} ${source.locator}`;
  const years = Array.from(hay.matchAll(/\b(20\d{2})\b/g))
    .map((match) => Number(match[1]))
    .filter((year) => year >= 2020 && year <= 2100);
  return years.length > 0 ? Math.max(...years) : null;
}

function freshnessScore(source: ResearchSource): number {
  const year = inferSourceYear(source);
  if (!year) return 0;
  const currentYear = new Date().getFullYear();
  if (year >= currentYear) return 14;
  if (year === currentYear - 1) return 10;
  if (year === currentYear - 2) return 5;
  return 0;
}

function sourceSortScore(source: ResearchSource): number {
  return ((source.credibility_score ?? 0.5) * 100) + freshnessScore(source);
}

function uniqueSearchQueries(queries: string[]): string[] {
  return queries
    .map((query) => query.trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index);
}

function countUniqueHosts(sources: ResearchSource[]): number {
  const hosts = new Set<string>();
  for (const source of sources) {
    try {
      hosts.add(new URL(source.locator).hostname);
    } catch {
      hosts.add(source.locator);
    }
  }
  return hosts.size;
}

function collectSourcesForQuestion(
  sources: ResearchSource[],
  question: string,
  questionId?: string,
): ResearchSource[] {
  return sources.filter((source) => matchesQuestion(source, question, questionId));
}

function hasEnoughSearchCoverage(sources: ResearchSource[], budgetMode: ResearchSession['budget_mode']): boolean {
  const uniqueHosts = countUniqueHosts(sources);
  if (budgetMode === 'fast') return sources.length >= 2;
  if (budgetMode === 'balanced') return sources.length >= 3 && uniqueHosts >= 2;
  return sources.length >= 4 && uniqueHosts >= 2;
}

function inferSearchTrack(query: string): SourceKind {
  if (/(官方|官网|文档|公告|状态页|status|docs?|developer|api)/i.test(query)) return 'official';
  if (/(论坛|社区|博客|实战|经验|github|stackoverflow|reddit|hacker news|用户反馈)/i.test(query)) {
    return 'community';
  }
  return 'third_party';
}

function classifySourceKind(url: string, query = ''): SourceKind {
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

function mergeQuestionMetadata(
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

function outputSections(kind: ResearchPlan['output_kind']): string[] {
  if (kind === 'brief') return ['摘要', '关键事实', '风险', '下一步'];
  if (kind === 'comparison') return ['结论', '对比维度', '方案分析', '风险', '建议'];
  if (kind === 'decision') return ['结论', '判断依据', '可选路径', '风险与前提', '执行建议'];
  return ['结论', '证据', '风险', '建议', '待补充问题'];
}

function pickQuestionForSection(
  plan: ResearchPlan,
  section: string,
  index: number,
): ResearchPlan['key_questions'][number] | undefined {
  const priorities: Record<string, string[]> = {
    结论: ['现状判断', '方案差异', '推荐路径', '核心事实'],
    证据: ['问题拆解', '现状判断', '评估维度'],
    风险: ['风险争议'],
    建议: ['关键变量', '推荐路径', '方案差异'],
    待补充问题: ['问题拆解', '现状判断'],
    对比维度: ['评估维度'],
    方案分析: ['方案差异', '现状判断'],
    判断依据: ['决策条件', '现状判断'],
    可选路径: ['推荐路径', '方案差异'],
    风险与前提: ['风险争议', '决策条件'],
    执行建议: ['推荐路径', '关键变量'],
    摘要: ['核心事实', '现状判断'],
    关键事实: ['核心事实', '现状判断'],
    下一步: ['推荐路径', '关键变量'],
  };
  for (const reason of priorities[section] ?? []) {
    const found = plan.key_questions.find((question) => question.reason === reason);
    if (found) return found;
  }
  return plan.key_questions[index % Math.max(1, plan.key_questions.length)];
}

function pickSupport(matching: ResearchSource[]): 'supported' | 'weak' | 'unverified' {
  if (matching.length === 0) return 'unverified';
  if (matching.length === 1) return 'weak';
  return 'supported';
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

function buildClaimText(section: string, question: string, sources: ResearchSource[]): string {
  if (sources.length === 0) {
    return `「${section}」目前缺少证据，需要继续检索 / 提供资料以确认：${question}`.slice(0, 1_900);
  }
  const lead = sources[0]!;
  const summary = (lead.snippet ?? lead.title ?? lead.locator).slice(0, 160).replace(/\s+/g, ' ');
  return `「${section}」围绕「${question}」可参考：${summary}…（共 ${sources.length} 条证据）`.slice(0, 1_900);
}

function buildDraft(
  session: ResearchSession,
  plan: ResearchPlan,
  sources: ResearchSource[],
): string {
  const lines: string[] = [
    `# ${session.title}`,
    '',
    '## 研究目标',
    '',
    session.objective,
    '',
    '## 计划摘要',
    '',
    plan.summary,
  ];
  if (plan.key_questions.length > 0) {
    lines.push('', '## 关键问题与证据');
    for (const q of plan.key_questions) {
      lines.push('', `### ${q.question}`);
      const matching = sources.filter((s) => matchesQuestion(s, q.question, q.id)).slice(0, 5);
      if (matching.length === 0) {
        lines.push('', '_暂无匹配证据，建议扩大检索关键词或追加来源。_');
        continue;
      }
      for (const s of matching) {
        const title = (s.title ?? s.locator).slice(0, 120);
        const snippet = (s.snippet ?? '').slice(0, 220).replace(/\s+/g, ' ');
        lines.push('', `- [${title}](${s.locator})`);
        if (snippet) lines.push(`  - ${snippet}`);
      }
    }
  }
  lines.push('', '## 待人工确认的问题', '', '- 是否需要继续追加证据或重跑搜索');
  return `${lines.join('\n').trim()}\n`;
}
