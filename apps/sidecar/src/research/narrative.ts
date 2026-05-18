/**
 * Task narrative — one-sentence "what just happened" summary per task.
 *
 * Goal: close the black-box feel of the runner without going full
 * streaming-event-channel. Every time a task completes, the runner asks
 * this module for a single human-readable line ("I just searched X and
 * found Y mostly from official docs"), stores it in `task.output.narrative`,
 * and the frontend renders an ordered timeline of these lines.
 *
 * Why pure templates instead of an LLM pass:
 * - Every task triggers this; an LLM call per task would be 10-20x cost
 *   inflation with little incremental benefit (the facts come straight
 *   from the runner state)
 * - Deterministic = testable
 * - Falls back to legacy `taskDetail()` on the frontend when older tasks
 *   were saved before this feature shipped
 *
 * The runner is responsible for calling this; the module is otherwise
 * stateless and side-effect free.
 */

import type {
  ResearchClaim,
  ResearchSource,
  ResearchTask,
} from '@taori/shared';

export interface NarrativeContext {
  /** All sources currently linked to the session — used by summarize/verify. */
  sources?: ResearchSource[];
  /** All claims currently linked to the session — used by verify. */
  claims?: ResearchClaim[];
  /** Draft markdown length, when known (saves a string length op). */
  draftCharCount?: number;
}

/**
 * Generate a one-sentence narrative for a completed task.
 * Returns `null` when the task kind has nothing useful to say
 * (caller should not store an empty narrative).
 */
export function buildTaskNarrative(
  task: ResearchTask,
  ctx: NarrativeContext = {},
): string | null {
  if (task.kind === 'search') return narrativeForSearch(task);
  if (task.kind === 'reflect') return narrativeForReflect(task);
  if (task.kind === 'summarize') return narrativeForSummarize(task, ctx);
  if (task.kind === 'verify_citation') return narrativeForVerify(ctx);
  if (task.kind === 'fetch') return narrativeForFetch(task);
  // outline / read_file are essentially no-ops; no narrative.
  return null;
}

// ─── Search ──────────────────────────────────────────────────────────────────

function narrativeForSearch(task: ResearchTask): string | null {
  const output = task.output;
  if (!output || typeof output !== 'object') return null;
  const failureReason = typeof output.failure_reason === 'string' ? output.failure_reason : null;
  const coverageStatus = typeof output.coverage_status === 'string' ? output.coverage_status : null;
  const hits = typeof output.hits === 'number' ? output.hits : 0;
  const uniqueHosts = typeof output.unique_hosts === 'number' ? output.unique_hosts : 0;
  const rounds = Array.isArray(output.rounds) ? output.rounds.length : 0;
  const recoveryAttempted = Boolean(output.recovery_attempted);
  const recoverySuccess = Boolean(output.recovery_successful);
  const question = typeof task.input?.question === 'string' ? task.input.question : task.title;
  const subject = clipSubject(question);

  if (hits === 0 || coverageStatus === 'no_usable_sources') {
    if (recoveryAttempted) {
      return `「${subject}」试了 ${rounds || '多'} 轮都没拿到可用来源（${classifyFailureLabel(failureReason)}），已写入"待补证"，继续推进其他问题。`;
    }
    return `「${subject}」首轮检索零结果（${classifyFailureLabel(failureReason)}），暂未触发兜底搜索。`;
  }

  // Compute source-kind mix from rounds if present, otherwise infer from defaults.
  const trackCounts = countSearchTracks(output.rounds);
  const trackDescription = trackCounts ? describeTrackMix(trackCounts) : null;

  const recoveryNote = recoveryAttempted && recoverySuccess
    ? '；首轮空响应后自动改写 query 才补回来'
    : recoveryAttempted
      ? '；recovery 重写后才有结果'
      : '';

  return `「${subject}」搜到 ${hits} 条来源、覆盖 ${uniqueHosts} 个站点${trackDescription ? `（${trackDescription}）` : ''}${recoveryNote}。`;
}

interface TrackCounts {
  official: number;
  third_party: number;
  community: number;
}

function countSearchTracks(rounds: unknown): TrackCounts | null {
  if (!Array.isArray(rounds) || rounds.length === 0) return null;
  const counts: TrackCounts = { official: 0, third_party: 0, community: 0 };
  for (const round of rounds) {
    if (!round || typeof round !== 'object') continue;
    const track = (round as Record<string, unknown>).search_track;
    if (track === 'official' || track === 'third_party' || track === 'community') {
      counts[track] += 1;
    }
  }
  if (counts.official + counts.third_party + counts.community === 0) return null;
  return counts;
}

function describeTrackMix(counts: TrackCounts): string {
  const parts: string[] = [];
  if (counts.official > 0) parts.push(`${counts.official} 轮官方`);
  if (counts.third_party > 0) parts.push(`${counts.third_party} 轮第三方`);
  if (counts.community > 0) parts.push(`${counts.community} 轮社区`);
  return parts.join(' + ');
}

function classifyFailureLabel(reason: string | null): string {
  if (reason === 'needs_official_sources') return '官方源缺失';
  if (reason === 'needs_benchmark_sources') return 'benchmark 资料缺失';
  if (reason === 'query_too_narrow') return 'query 太窄';
  return '通用检索零命中';
}

// ─── Reflect ─────────────────────────────────────────────────────────────────

function narrativeForReflect(task: ResearchTask): string | null {
  const output = task.output;
  if (!output || typeof output !== 'object') return null;
  if (output.skipped) {
    const reason = typeof output.reason === 'string' ? output.reason : '';
    if (reason === 'no_gaps_identified') return '反思过一轮证据覆盖，没有发现明显空白，准备进入综合。';
    if (reason === 'no_sources') return '还没拿到来源，跳过反思。';
    if (reason === 'no_usable_model') return '没有可用的反思模型，跳过差距分析。';
    return '反思已跳过。';
  }
  const coverage = Array.isArray(output.coverage) ? output.coverage : [];
  const good = coverage.filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && (c as Record<string, unknown>).level === 'good').length;
  const missing = coverage.filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && ((c as Record<string, unknown>).level === 'missing' || (c as Record<string, unknown>).level === 'partial')).length;
  const added = Array.isArray(output.added_tasks) ? output.added_tasks.length : 0;
  const round = typeof output.reflect_round === 'number' ? output.reflect_round : 1;
  const next = output.next_round_scheduled ? '，已排第二轮深度反思' : '';
  if (added > 0) {
    return `第 ${round} 轮反思：${good} 个问题覆盖充分、${missing} 个仍有空白，已追加 ${added} 个补充检索任务${next}。`;
  }
  return `第 ${round} 轮反思：${good} 个问题覆盖充分、${missing} 个仍有空白，但未生成补充任务${next}。`;
}

// ─── Summarize ───────────────────────────────────────────────────────────────

function narrativeForSummarize(_task: ResearchTask, ctx: NarrativeContext): string | null {
  const sourceCount = ctx.sources?.length ?? 0;
  const draftLen = ctx.draftCharCount ?? 0;
  if (draftLen === 0) {
    return `综合完成，但草稿为空——可能模型流式中断，可手动重试。`;
  }
  return `已基于 ${sourceCount} 条来源完成综合，草稿 ${formatCharLen(draftLen)}。`;
}

// ─── Verify (CitationAgent) ──────────────────────────────────────────────────

function narrativeForVerify(ctx: NarrativeContext): string | null {
  const claims = ctx.claims ?? [];
  if (claims.length === 0) {
    return `引用核查未产出任何论断——可能 CitationAgent 不可用或来源池为空。`;
  }
  const grounded = claims.filter((c) => Array.isArray(c.evidence_spans) && c.evidence_spans.length > 0);
  if (grounded.length === 0) {
    return `引用核查使用兜底模板（章节级摘要），未做 span 级 grounding——可能综合模型不可用。`;
  }
  const high = grounded.filter((c) => c.confidence === 'high').length;
  const medium = grounded.filter((c) => c.confidence === 'medium').length;
  const low = grounded.filter((c) => c.confidence === 'low').length;
  const unverified = grounded.filter((c) => c.confidence === 'unverified').length;
  const parts: string[] = [];
  if (high > 0) parts.push(`${high} 强`);
  if (medium > 0) parts.push(`${medium} 中`);
  if (low > 0) parts.push(`${low} 弱`);
  if (unverified > 0) parts.push(`${unverified} 未验证`);
  return `CitationAgent 把 ${grounded.length} 条论断绑回原文 span（${parts.join(' · ')}）。`;
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

function narrativeForFetch(task: ResearchTask): string | null {
  const url = typeof task.input?.url === 'string' ? task.input.url : '';
  if (!url) return null;
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // keep original
  }
  return `抓取 ${host} 的页面正文。`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clipSubject(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 32) return trimmed;
  return `${trimmed.slice(0, 30)}…`;
}

function formatCharLen(len: number): string {
  if (len >= 1000) return `约 ${(len / 1000).toFixed(1)}k 字`;
  return `${len} 字`;
}
