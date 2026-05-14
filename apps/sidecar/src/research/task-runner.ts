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

import { generateText } from 'ai';
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
import { buildSearchQueries } from './planner.js';
import { pickPreferredSearchToolName } from '../search/tool-selection.js';

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
  search_engine: string | null;
  search_fallback_from: string | null;
}

type TaskOutcome = 'completed' | 'failed' | 'skipped';

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
    const configured = buildSearchQueries({
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
    const searchToolName = pickPreferredSearchToolName(
      this.deps.bus,
      session.preferred_search_tool ?? this.deps.memories?.getEffective(session.conversation_id ?? null, 'default_search_tool'),
      this.deps.bus.list().map((tool) => tool.name),
    ) ?? 'builtin.web_search';
    const rounds: SearchRoundSummary[] = [];
    for (const query of queries) {
      const round = await this.executeSearchRound(session, task, searchToolName, query, questionId);
      const matchedSources = collectSourcesForQuestion(
        this.deps.repo.listSources(session.id),
        question,
        questionId,
      );
      rounds.push({
        query,
        hits: round.recorded.length,
        total_sources: matchedSources.length,
        unique_hosts: countUniqueHosts(matchedSources),
        search_engine: round.engine,
        search_fallback_from: round.fallbackFrom,
      });
      if (hasEnoughSearchCoverage(matchedSources, session.budget_mode)) break;
    }
    const matchedSources = collectSourcesForQuestion(
      this.deps.repo.listSources(session.id),
      question,
      questionId,
    );
    if (matchedSources.length === 0) {
      throw new Error(`web_search returned no usable results for query: ${queries[0]}`);
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
        search_engine: lastRound?.search_engine ?? null,
        search_fallback_from: rounds.find((round) => round.search_fallback_from)?.search_fallback_from ?? null,
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
  ): Promise<{ recorded: ResearchSource[]; engine: string | null; fallbackFrom: string | null }> {
    const res = await this.deps.bus.invoke(
      searchToolName,
      { query, num_results: SEARCH_RESULTS_PER_TASK },
      { conversationId: session.conversation_id ?? null },
    );
    if (!res.ok) {
      throw new Error(`${searchToolName} failed: ${res.error?.message ?? 'unknown'}`);
    }
    const output = res.output as { results?: WebSearchHit[]; engine?: string; fallback_from?: string };
    const hits = output?.results ?? [];
    const recorded: ResearchSource[] = [];
    for (const hit of hits.slice(0, SEARCH_RESULTS_PER_TASK)) {
      if (!hit?.url) continue;
      const existing = this.deps.repo.findSourceByLocator(session.id, hit.url);
      if (existing) {
        const nextMetadata = mergeQuestionMetadata(existing.metadata, questionId, {
          query,
          search_tool: searchToolName,
          search_engine: output?.engine ?? null,
          search_fallback_from: output?.fallback_from ?? null,
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
        credibility_score: scoreCredibility(hit.url),
        included: true,
        metadata: mergeQuestionMetadata({}, questionId, {
          query,
          search_tool: searchToolName,
          search_engine: output?.engine ?? null,
          search_fallback_from: output?.fallback_from ?? null,
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
    };
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
    const out = res.output as { title?: string | null; content?: string };
    const existing = this.deps.repo.findSourceByLocator(session.id, url);
    if (existing) {
      this.deps.repo.updateSource(existing.id, {
        title: out.title ?? existing.title,
        snippet: out.content?.slice(0, 3_900) ?? existing.snippet,
      });
    } else {
      this.deps.repo.appendSource(session.id, {
        source_type: 'web_page',
        title: out.title?.slice(0, 240) ?? null,
        locator: url,
        snippet: out.content?.slice(0, 3_900) ?? null,
        credibility_score: scoreCredibility(url),
        included: true,
        metadata: { fetched: true },
      });
    }
  }

  private async runSummarize(session: ResearchSession): Promise<void> {
    const plan = session.plan;
    if (!plan) return;
    const sources = this.deps.repo.listSources(session.id);

    // Attempt LLM synthesis when model deps are available
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
          const { text } = await generateText({
            model: chatModel,
            prompt,
            maxTokens: 8192,
          });
          if (text && text.trim().length > 100) {
            this.deps.repo.update(session.id, { draft_markdown: text.trim() });
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

  private async runVerify(session: ResearchSession): Promise<void> {
    const plan = session.plan;
    if (!plan) return;
    const sources = this.deps.repo.listSources(session.id);
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
      });
    }
    this.deps.repo.replaceClaims(session.id, claims);
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
  // Priority: per-session override → memories default → first available chat model
  const candidateId = session.preferred_model_id
    ?? (memories?.getEffective(null, 'default_model_id') ?? null);

  let model = candidateId ? modelsRepo.get(candidateId) : null;
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

  // Sort sources by credibility descending so the LLM sees the best sources first per question.
  const sortedSources = [...sources].sort((a, b) => (b.credibility_score ?? 0.5) - (a.credibility_score ?? 0.5));

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
      return `  [${idx}]${tag ? ` ${tag}` : ''} 标题：${title}\n      来源：${s.locator}\n      内容：${snippet || '（无摘要）'}`;
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
        return `  [${idx}]${tag ? ` ${tag}` : ''} 标题：${title}\n      来源：${s.locator}\n      内容：${snippet || '（无摘要）'}`;
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
- 搜索词要具体、可操作，适合直接输入搜索引擎`;
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

function scoreCredibility(url: string): number {
  try {
    const host = new URL(url).hostname;
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
  const tokens = question
    .toLowerCase()
    .split(/[\s,，。、？?!！:：;；()\[\]【】"'`]+/)
    .filter((t) => t.length > 1)
    .slice(0, 6);
  if (tokens.length === 0) return true;
  return tokens.some((t) => hay.includes(t));
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
