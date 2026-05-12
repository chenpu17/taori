/**
 * Deep Research execution engine.
 *
 * After a session is /start?confirm=true, the runner is responsible for
 * draining the queued task list:
 *
 *   outline      — pre-completed by planner (seed).
 *   search       — calls builtin.web_search; appends each result as a
 *                  research_source row (dedup by locator); top hits are also
 *                  hydrated with web_fetch snippets.
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

import type {
  ResearchClaim,
  ResearchPlan,
  ResearchSession,
  ResearchSource,
  ResearchTask,
} from '@taori/shared';
import type { CapabilityBus } from '../bus/index.js';
import type { MemoriesRepo } from '../db/repos/index.js';
import type { ResearchRepo } from '../db/repos/index.js';
import { pickPreferredSearchToolName } from '../search/tool-selection.js';

const SEARCH_RESULTS_PER_TASK = 5;
const FETCH_TOP_N = 2;
const FETCH_MAX_CHARS = 2500;
const TICK_DELAY_MS = 25;

export interface ResearchRunnerDeps {
  repo: ResearchRepo;
  bus: CapabilityBus;
  memories?: MemoriesRepo;
  log?: { info?: (msg: unknown, extra?: unknown) => void; warn?: (msg: unknown, extra?: unknown) => void; error?: (msg: unknown, extra?: unknown) => void };
}

interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
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
    const query = String(task.input?.query ?? task.input?.question ?? task.title ?? '').trim();
    if (!query) {
      this.deps.repo.updateTask(task.id, { output: { reason: 'empty_query' } });
      return;
    }
    const searchToolName = pickPreferredSearchToolName(
      this.deps.bus,
      session.preferred_search_tool ?? this.deps.memories?.getEffective(session.conversation_id ?? null, 'default_search_tool'),
      this.deps.bus.list().map((tool) => tool.name),
    ) ?? 'builtin.web_search';
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
        recorded.push(existing);
        continue;
      }
      const inserted = this.deps.repo.appendSource(session.id, {
        source_type: 'web_page',
        title: hit.title?.slice(0, 240) ?? null,
        locator: hit.url,
        snippet: hit.snippet?.slice(0, 3_900) ?? null,
        credibility_score: scoreCredibility(hit.url),
        included: true,
        metadata: {
          question_id: task.input?.question_id ?? null,
          query,
          search_tool: searchToolName,
          search_engine: output?.engine ?? null,
          search_fallback_from: output?.fallback_from ?? null,
        },
      });
      recorded.push(inserted);
    }
    // Hydrate top results with web_fetch for richer snippets (best effort).
    for (const source of recorded.slice(0, FETCH_TOP_N)) {
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
    }
    if (recorded.length === 0) {
      throw new Error(`web_search returned no usable results for query: ${query}`);
    }
    this.deps.repo.updateTask(task.id, {
      output: {
        hits: recorded.length,
        query,
        search_tool: searchToolName,
        search_engine: output?.engine ?? null,
        search_fallback_from: output?.fallback_from ?? null,
      },
    });
    // Snapshot session budget from cost_records sum is expensive; defer to
    // verify step which aggregates once.
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
