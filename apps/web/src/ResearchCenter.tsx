import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Model,
  PlanMessage,
  ResearchClaim,
  ResearchClaimConfidence,
  ResearchSource,
  ResearchBudgetMode,
  ResearchOutputKind,
  ResearchPlanOrigin,
  ResearchSession,
  ResearchSessionDetail,
  ResearchStage,
  ResearchStatus,
  ResearchTask,
  Tool,
} from '@taori/shared';
import { api } from './api.js';
import { renderMarkdown } from './markdown.js';

const OUTPUT_KIND_LABELS: Record<ResearchOutputKind, string> = {
  brief: '简报',
  report: '报告',
  comparison: '对比',
  decision: '决策',
};

const BUDGET_MODE_LABELS: Record<ResearchBudgetMode, string> = {
  fast: '快',
  balanced: '平衡',
  deep: '深入',
  custom: '自定义',
};

const STATUS_LABELS: Record<ResearchStatus, string> = {
  draft: '草稿',
  running: '进行中',
  paused: '已暂停',
  reviewing: '待确认',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const STAGE_LABELS: Record<ResearchStage, string> = {
  scoping: '选题澄清',
  planning: '研究计划',
  searching: '检索抓取',
  synthesizing: '证据整理',
  drafting: '草稿生成',
  verifying: '引用校验',
  finalized: '定稿',
};

const STAGE_DESCRIPTIONS: Record<ResearchStage, string> = {
  scoping: '明确范围、目标与必须覆盖的问题。',
  planning: '确认关键问题、检索顺序与停止条件。',
  searching: '分批搜索、抓取与筛选候选来源。',
  synthesizing: '归纳事实、组织章节并形成可验证主张。',
  drafting: '产出阶段草稿与结构化结论。',
  verifying: '检查主张证据充分性与冲突点。',
  finalized: '整理成可导出的研究稿。',
};

const STAGE_ORDER: ResearchStage[] = [
  'scoping',
  'planning',
  'searching',
  'synthesizing',
  'drafting',
  'verifying',
  'finalized',
];

const RESEARCH_SUGGESTIONS = [
  '分析 2026 年 AI Coding 市场格局与主要玩家差异',
  '对比中国主流大模型 API 的价格、速度与可用性',
  '梳理浏览器端 AI 助手的典型交互设计趋势',
];

interface ResearchCenterProps {
  selectedId?: string | null;
  onSelectedIdChange?: (id: string | null) => void;
  objectiveDraft?: string;
  onObjectiveDraftChange?: (value: string) => void;
  onSessionsChanged?: () => void | Promise<void>;
}

interface ChecklistItem {
  id: string;
  title: string;
  subtitle: string;
  status: ResearchTask['status'];
}

type SourceKind = 'official' | 'third_party' | 'community';
type CoverageLevel = 'good' | 'partial' | 'missing';

interface CoverageViewItem {
  id: string;
  question: string;
  reason: string;
  level: CoverageLevel;
  isEstimated: boolean;
  sources: number;
  hosts: number;
  whatWeKnow: string;
  whatIsMissing: string;
}

type StageRailState = 'completed' | 'current' | 'upcoming' | 'blocked';

interface StageRailItem {
  stage: ResearchStage;
  label: string;
  description: string;
  state: StageRailState;
}

interface ResearchInsight {
  label: string;
  value: string;
  detail: string;
  tone: 'neutral' | 'good' | 'warn' | 'danger';
}

interface ResearchReportOverview {
  readiness: {
    label: string;
    detail: string;
    tone: 'neutral' | 'good' | 'warn' | 'danger';
  };
  cards: Array<{
    label: string;
    value: string;
    detail: string;
  }>;
  risks: string[];
  nextSteps: string[];
}

function planScopeChip(scope: string | undefined): { label: string; cls: string; title: string } | null {
  // Wide → narrow scope chips. Older plans without scope show no chip
  // (graceful degradation); newer AI plans surface the ordering hint so
  // users can read the question list as "broad recon → drilldowns → fact check".
  if (scope === 'recon') return { label: '探查', cls: 'recon', title: '宽广探查：先把图景画清楚' };
  if (scope === 'comparative') return { label: '对比', cls: 'comparative', title: '横向对比：在主要对象之间比较关键维度' };
  if (scope === 'deep_dive') return { label: '深挖', cls: 'deep-dive', title: '纵深挖掘：针对具体对象/维度查证细节' };
  if (scope === 'verification') return { label: '核实', cls: 'verification', title: '事实核实：交叉验证关键数字与承诺' };
  return null;
}

function planOriginMeta(origin: ResearchPlanOrigin): {
  label: string;
  tone: 'neutral' | 'brand' | 'warning';
  description: string;
} {
  if (origin === 'ai') {
    return {
      label: 'AI 生成',
      tone: 'brand',
      description: '这版计划由 AI 根据你的目标和约束生成。',
    };
  }
  if (origin === 'fallback') {
    return {
      label: '历史兜底',
      tone: 'warning',
      description: '这是一份历史会话里留下的旧版兜底计划，不代表当前版本还会在 AI 规划失败时自动生成模板。',
    };
  }
  return {
    label: 'AI 规划中',
    tone: 'neutral',
    description: 'Taori 正在分析你的目标并生成个性化研究计划。',
  };
}

function deriveTitle(objective: string): string {
  const first = objective.trim().split(/[\n。.!?！？]/)[0].trim();
  if (!first) return '未命名研究';
  return first.length > 50 ? `${first.slice(0, 50)}…` : first;
}

function formatAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function taskStatusLabel(task: ResearchTask): string {
  if (task.status === 'queued') return '排队中';
  if (task.status === 'running') return '进行中';
  if (task.status === 'completed' && task.kind === 'search' && task.output?.coverage_status === 'no_usable_sources') return '未命中';
  if (task.status === 'completed') return '已完成';
  if (task.status === 'failed') return '失败';
  return '已跳过';
}

function searchEngineLabel(engine: string | null | undefined): string | null {
  if (engine === 'exa') return 'Exa';
  if (engine === 'bocha') return '搏查';
  if (engine === 'duckduckgo') return 'DuckDuckGo';
  return null;
}

function compactTaskQuery(query: string): string {
  const normalized = query.replace(/\s+/g, ' ').trim();
  return normalized.length > 92 ? `${normalized.slice(0, 92)}…` : normalized;
}

function formatEngineAttempts(attempts: string[]): string {
  const labels = attempts
    .map((engine) => searchEngineLabel(engine) ?? engine)
    .filter((value, index, arr) => Boolean(value) && arr.indexOf(value) === index);
  return labels.length > 0 ? `已尝试：${labels.join('、')}。` : '';
}

function searchFailureDetail(failureReason: string, recoveryRounds: number, engineAttempts: string[]): string {
  const retried = recoveryRounds > 0 ? `系统已自动放宽并改写 ${recoveryRounds} 轮，` : '';
  const attempted = formatEngineAttempts(engineAttempts);
  if (failureReason === 'needs_official_sources') {
    return `当前检索没有拿到可用结果；${retried}${attempted}这类问题更适合官方定价页、开发文档或状态页。建议进一步限定具体厂商后重试。`;
  }
  if (failureReason === 'needs_benchmark_sources') {
    return `当前检索没有拿到可用结果；${retried}${attempted}这类问题通常依赖第三方 benchmark / 实测资料，公开口径本身较稀缺。建议限定具体厂商、测试指标或时间范围后重试。`;
  }
  if (failureReason === 'query_too_narrow') {
    return `当前检索没有拿到可用结果；${retried}${attempted}更像是查询过窄或限定条件过多。可缩小范围、补充限定条件，或切换搜索源后重试。`;
  }
  return recoveryRounds > 0
    ? `当前检索没有拿到可用结果；系统已自动放宽并改写 ${recoveryRounds} 轮，但仍未命中可用来源。${attempted}可缩小范围、补充限定条件，或切换搜索源后重试。`
    : `当前检索没有拿到可用结果。${attempted}可缩小范围、补充限定条件，或切换搜索源后重试。`;
}

function taskDetail(task: ResearchTask): string {
  if (task.status === 'failed') {
    if (task.kind === 'search') {
      const message = String(task.error?.message ?? '执行失败');
      const failureReason = typeof task.output?.failure_reason === 'string' ? task.output.failure_reason : 'no_usable_results';
      const rounds = Array.isArray(task.output?.rounds)
        ? task.output.rounds.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        : [];
      const engineAttempts = Array.isArray(task.output?.engine_attempts)
        ? task.output.engine_attempts.filter((item): item is string => typeof item === 'string')
        : [];
      const recoveryRounds = rounds.filter((item) => item.phase === 'recovery').length;
      if (message.includes('DuckDuckGo blocked the automated search')) {
        return 'DuckDuckGo 触发反爬限制，当前搜索源未返回可用结果。系统建议改用 Exa / 搏查，或稍后重试。';
      }
      if (message.includes('returned no usable results')) {
        return searchFailureDetail(failureReason, recoveryRounds, engineAttempts);
      }
      if (message.includes('搏查搜索缺少 API Key')) {
        return '搏查搜索缺少 API Key，请先在工具设置里补齐。';
      }
    }
    return String(task.error?.message ?? '执行失败');
  }
  if (task.kind === 'search') {
    if (task.output?.coverage_status === 'no_usable_sources') {
      const failureReason = typeof task.output?.failure_reason === 'string' ? task.output.failure_reason : 'no_usable_results';
      const rounds = Array.isArray(task.output?.rounds)
        ? task.output.rounds.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        : [];
      const engineAttempts = Array.isArray(task.output?.engine_attempts)
        ? task.output.engine_attempts.filter((item): item is string => typeof item === 'string')
        : [];
      const recoveryRounds = rounds.filter((item) => item.phase === 'recovery').length;
      return searchFailureDetail(failureReason, recoveryRounds, engineAttempts);
    }
    const query =
      typeof task.input?.query === 'string'
        ? task.input.query
        : typeof task.input?.question === 'string'
          ? task.input.question
          : '';
    const rounds = Array.isArray(task.output?.rounds)
      ? task.output.rounds.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      : [];
    const engine =
      typeof task.output?.search_engine === 'string'
        ? searchEngineLabel(task.output.search_engine)
        : null;
    const fallback =
      typeof task.output?.search_fallback_from === 'string'
        ? searchEngineLabel(task.output.search_fallback_from)
        : null;
    const hits = typeof task.output?.hits === 'number' ? `命中 ${task.output.hits} 条` : null;
    const roundCount =
      typeof task.output?.rounds_completed === 'number'
        ? `${task.output.rounds_completed} 轮检索`
        : rounds.length > 1
          ? `${rounds.length} 轮检索`
          : null;
    const recovery =
      task.output?.recovery_successful || rounds.some((item) => item.phase === 'recovery' && typeof item.hits === 'number' && item.hits > 0)
        ? '自动改写补救'
        : null;
    const hostCount =
      typeof task.output?.unique_hosts === 'number' && task.output.unique_hosts > 0
        ? `${task.output.unique_hosts} 个站点`
        : null;
    const queryText = query ? compactTaskQuery(query) : null;
    // Surface the LLM-generated query strategy (wide → narrow narrative)
    // first when present — it explains *why* the agent searched the way it
    // did, which closes the black-box feel for search tasks. When the
    // recovery branch also ran via LLM, show its strategy too.
    const strategy = typeof task.output?.query_strategy === 'string'
      ? task.output.query_strategy.trim().slice(0, 90)
      : null;
    const recoveryStrategy = typeof task.output?.recovery_strategy === 'string'
      ? task.output.recovery_strategy.trim().slice(0, 90)
      : null;
    const facts = [
      engine ? (fallback ? `${engine}（从 ${fallback} 回退）` : engine) : null,
      roundCount,
      recovery,
      hostCount,
      hits,
      queryText,
    ].filter(Boolean).join(' · ');
    return [
      strategy ? `💡 ${strategy}` : null,
      recoveryStrategy && task.output?.recovery_attempted ? `↻ ${recoveryStrategy}` : null,
      facts,
    ].filter(Boolean).join('\n');
  }
  if (task.kind === 'summarize') {
    return '已基于当前证据整理结构化草稿。';
  }
  if (task.kind === 'reflect') {
    if (task.status === 'skipped' || task.output?.skipped) {
      const reason = String(task.output?.reason ?? '');
      if (reason === 'fast_mode') return '快速模式，跳过差距分析。';
      if (reason === 'no_sources') return '暂无来源，跳过差距分析。';
      if (reason === 'no_gaps_identified') return '证据覆盖充分，无需补充检索。';
      return '差距分析已跳过。';
    }
    const added = Array.isArray(task.output?.added_tasks) ? (task.output.added_tasks as unknown[]).length : 0;
    const coverage = Array.isArray(task.output?.coverage) ? task.output.coverage as Array<Record<string,unknown>> : [];
    const good = coverage.filter((c) => c.level === 'good').length;
    const partial = coverage.filter((c) => c.level === 'partial').length;
    const missing = coverage.filter((c) => c.level === 'missing').length;
    const round = typeof task.output?.reflect_round === 'number' ? `第${task.output.reflect_round}轮 · ` : '';
    const nextRound = task.output?.next_round_scheduled ? ' → 将继续第二轮深度反思' : '';
    if (added > 0) {
      const parts = [
        round,
        good > 0 ? `${good}个问题充分覆盖` : null,
        partial > 0 ? `${partial}个部分覆盖` : null,
        missing > 0 ? `${missing}个缺失` : null,
        `追加 ${added} 轮补充检索`,
      ].filter(Boolean);
      return parts.join(' · ') + nextRound;
    }
    if (coverage.length > 0) return `${round}${good}/${coverage.length} 个问题充分覆盖，证据已齐全。`;
    return '正在分析已有资料，识别信息空白…';
  }
  if (task.kind === 'verify_citation') {
    return '正在校验关键主张是否具备可回溯引用。';
  }
  if (task.kind === 'outline') {
    return '已确认研究目标、输出结构与关键问题。';
  }
  return typeof task.output?.reason === 'string' ? task.output.reason : '';
}

function safeHostname(locator: string): string {
  try {
    return new URL(locator).hostname;
  } catch {
    return locator;
  }
}

function sourceKindValue(source: ResearchSource): SourceKind {
  const raw = typeof source.metadata?.source_kind === 'string' ? source.metadata.source_kind : null;
  if (raw === 'official' || raw === 'community') return raw;
  return 'third_party';
}

function sourceKindMeta(kind: SourceKind): { label: string; cls: string } {
  if (kind === 'official') return { label: '官方', cls: 'official' };
  if (kind === 'community') return { label: '社区', cls: 'community' };
  return { label: '第三方', cls: 'third-party' };
}

function sourceMatchesQuestionId(source: ResearchSource, questionId: string): boolean {
  if (source.metadata?.question_id === questionId) return true;
  return Array.isArray(source.metadata?.question_ids) && source.metadata.question_ids.some((value) => value === questionId);
}

function coverageBadgeMeta(level: CoverageLevel): { label: string; cls: string } {
  if (level === 'good') return { label: '覆盖充分', cls: 'good' };
  if (level === 'missing') return { label: '缺口明显', cls: 'missing' };
  return { label: '仍需补证', cls: 'partial' };
}

function claimStatusMeta(status: string): { label: string; cls: string } {
  if (status === 'supported') return { label: '已验证', cls: 'supported' };
  if (status === 'conflicted') return { label: '有冲突', cls: 'conflicted' };
  if (status === 'weak') return { label: '证据偏弱', cls: 'weak' };
  return { label: '待验证', cls: 'unverified' };
}

function buildConstraintSummary(session: ResearchSession): string[] {
  const { constraints } = session;
  const items: string[] = [];
  if (constraints.time_range) items.push(`时间：${constraints.time_range}`);
  if (constraints.region) items.push(`区域：${constraints.region}`);
  if (constraints.language) items.push(`语言：${constraints.language}`);
  if (constraints.min_citations != null) items.push(`至少 ${constraints.min_citations} 条引用`);
  if ((constraints.must_cover ?? []).length > 0) {
    items.push(`必须覆盖：${constraints.must_cover.join('、')}`);
  }
  return items;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function downloadExport(filename: string, contentType: string, content: string): void {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function checklistFallbackStatus(
  stage: ResearchStage,
  currentStage: ResearchStage,
  sessionStatus: ResearchStatus,
): ResearchTask['status'] {
  const currentIndex = STAGE_ORDER.indexOf(currentStage);
  const index = STAGE_ORDER.indexOf(stage);
  if (sessionStatus === 'completed') return 'completed';
  if (sessionStatus === 'failed' && index >= currentIndex) return 'failed';
  if (sessionStatus === 'cancelled' && index >= currentIndex) return 'skipped';
  if (index < currentIndex) return 'completed';
  if (index === currentIndex && sessionStatus === 'running') return 'running';
  return 'queued';
}

function stageRailState(
  stage: ResearchStage,
  currentStage: ResearchStage,
  sessionStatus: ResearchStatus,
): StageRailState {
  if (sessionStatus === 'completed') return 'completed';
  const currentIndex = STAGE_ORDER.indexOf(currentStage);
  const index = STAGE_ORDER.indexOf(stage);
  if ((sessionStatus === 'failed' || sessionStatus === 'paused') && index === currentIndex) return 'blocked';
  if (index < currentIndex) return 'completed';
  if (index === currentIndex) return 'current';
  return 'upcoming';
}

function PlanningWaitIndicator(): JSX.Element {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    const handle = window.setInterval(() => setElapsed((prev) => prev + 1), 1_000);
    return () => window.clearInterval(handle);
  }, []);
  const dots = '.'.repeat(1 + (elapsed % 3));
  const hint = elapsed < 5
    ? '正在连接规划模型…'
    : elapsed < 15
      ? '正在分析研究目标…'
      : elapsed < 30
        ? '正在生成关键问题与停止条件…'
        : '即将完成，请稍候…';
  return (
    <div className="research-center__planning-waiting">
      <span className="research-center__spinner" aria-hidden />
      <p>Taori 正在分析你的研究目标，生成一份个性化的研究计划{dots}</p>
      <p className="research-center__planning-hint">
        {hint}（已等待 {elapsed}s，最多约 45s）
      </p>
    </div>
  );
}

function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function narrativeKindMeta(kind: ResearchTask['kind']): { label: string; cls: string } {
  if (kind === 'search') return { label: '检索', cls: 'search' };
  if (kind === 'reflect') return { label: '反思', cls: 'reflect' };
  if (kind === 'summarize') return { label: '综合', cls: 'summarize' };
  if (kind === 'verify_citation') return { label: '核验', cls: 'verify' };
  if (kind === 'fetch') return { label: '抓取', cls: 'fetch' };
  return { label: kind, cls: 'other' };
}

function NarrativeTimeline({
  tasks,
  sessionStatus,
}: {
  tasks: ResearchTask[];
  sessionStatus: ResearchStatus;
}): JSX.Element | null {
  // Build a chronological event stream from completed-or-failed tasks. Each
  // task carries a one-line `narrative` (written by the runner via
  // narrative.ts); when missing — for old tasks or read_file/outline — we
  // gracefully skip it rather than fall back to taskDetail() so the timeline
  // stays a tight "what happened" log instead of duplicating the task list.
  const entries = tasks
    .filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'skipped')
    .map((t) => {
      const narrative = typeof t.output?.narrative === 'string' ? t.output.narrative.trim() : '';
      return { task: t, narrative };
    })
    .filter((e) => e.narrative.length > 0)
    .sort((a, b) => (a.task.finished_at ?? a.task.created_at) - (b.task.finished_at ?? b.task.created_at));
  if (entries.length === 0) return null;
  const isRunning = sessionStatus === 'running';
  return (
    <details
      className="research-center__narrative-timeline"
      data-testid="research-narrative-timeline"
      open={isRunning || entries.length <= 8}
    >
      <summary>
        <span>研究叙事</span>
        <small>{entries.length} 条动态</small>
      </summary>
      <ol className="research-center__narrative-list">
        {entries.map(({ task, narrative }) => {
          const meta = narrativeKindMeta(task.kind);
          return (
            <li
              key={task.id}
              className={`research-center__narrative-item research-center__narrative-item--${meta.cls} research-center__narrative-item--status-${task.status}`}
              data-testid="research-narrative-entry"
            >
              <span className="research-center__narrative-time">{formatTimestamp(task.finished_at ?? task.created_at)}</span>
              <span className={`research-center__narrative-kind research-center__narrative-kind--${meta.cls}`}>{meta.label}</span>
              <span className="research-center__narrative-text">{narrative}</span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function confidenceMeta(confidence: ResearchClaimConfidence | null | undefined): { label: string; cls: string } {
  if (confidence === 'high') return { label: '强支撑', cls: 'high' };
  if (confidence === 'medium') return { label: '中支撑', cls: 'medium' };
  if (confidence === 'low') return { label: '弱支撑', cls: 'low' };
  return { label: '未验证', cls: 'unverified' };
}

function CitationVerificationPanel({
  claims,
  sources,
  sessionStatus,
}: {
  claims: ResearchClaim[];
  sources: ResearchSource[];
  sessionStatus: ResearchStatus;
}): JSX.Element | null {
  // Only show once CitationAgent has produced at least one grounded claim
  // (i.e. evidence_spans is populated). The legacy template fallback writes
  // claims without spans, and those should not light up this panel —
  // surfacing them would mislead users into trusting un-verified content.
  const grounded = claims.filter((c) => Array.isArray(c.evidence_spans) && c.evidence_spans.length > 0);
  if (claims.length === 0) {
    if (sessionStatus !== 'running') return null;
    return (
      <section className="research-center__citation-panel" data-testid="research-citation-panel" data-state="pending">
        <header><strong>引用核查</strong><small>研究完成后会逐条把论断绑回原文。</small></header>
      </section>
    );
  }
  if (grounded.length === 0) {
    return (
      <section className="research-center__citation-panel" data-testid="research-citation-panel" data-state="legacy">
        <header><strong>引用核查</strong><small>使用兜底校验（章节级），未生成原文片段。可能因为综合模型不可用或来源过少。</small></header>
      </section>
    );
  }
  const counts = grounded.reduce<Record<string, number>>((acc, c) => {
    const key = c.confidence ?? 'unverified';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const sourceById = new Map(sources.map((s) => [s.id, s] as const));
  return (
    <section className="research-center__citation-panel" data-testid="research-citation-panel" data-state="grounded">
      <header>
        <strong>引用核查</strong>
        <small>
          共 {grounded.length} 条论断 ·{' '}
          {counts.high ? `${counts.high} 强支撑` : ''}
          {counts.high && (counts.medium || counts.low || counts.unverified) ? ' · ' : ''}
          {counts.medium ? `${counts.medium} 中支撑` : ''}
          {counts.medium && (counts.low || counts.unverified) ? ' · ' : ''}
          {counts.low ? `${counts.low} 弱支撑` : ''}
          {counts.low && counts.unverified ? ' · ' : ''}
          {counts.unverified ? `${counts.unverified} 未验证` : ''}
        </small>
      </header>
      <ul className="research-center__citation-list">
        {grounded.map((claim, idx) => {
          const meta = confidenceMeta(claim.confidence);
          return (
            <li
              key={`${claim.id}-${idx}`}
              className={`research-center__citation-item research-center__citation-item--${meta.cls}`}
              data-testid={`research-citation-claim`}
              data-confidence={meta.cls}
            >
              <details>
                <summary>
                  <span className={`research-center__citation-pill research-center__citation-pill--${meta.cls}`}>{meta.label}</span>
                  <span className="research-center__citation-text">{claim.claim_text}</span>
                </summary>
                <ol className="research-center__citation-spans">
                  {claim.evidence_spans.map((span, spanIdx) => {
                    const src = sourceById.get(span.source_id);
                    const stanceLabel =
                      span.stance === 'contradicts' ? '反驳' : span.stance === 'partial' ? '部分支持' : '支持';
                    return (
                      <li key={`${span.source_id}-${spanIdx}`} data-testid="research-citation-span">
                        <div className="research-center__citation-source">
                          <span className={`research-center__citation-stance research-center__citation-stance--${span.stance}`}>{stanceLabel}</span>
                          {src ? (
                            <a href={src.locator} target="_blank" rel="noreferrer noopener">
                              {src.title ?? src.locator}
                            </a>
                          ) : (
                            <span>{span.source_id}</span>
                          )}
                        </div>
                        <blockquote>「{span.span_text}」</blockquote>
                      </li>
                    );
                  })}
                </ol>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ResearchCenter({
  selectedId: controlledSelectedId,
  onSelectedIdChange,
  objectiveDraft,
  onObjectiveDraftChange,
  onSessionsChanged,
}: ResearchCenterProps = {}): JSX.Element {
  const [sessions, setSessions] = useState<ResearchSession[] | null>(null);
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ResearchSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [availableSearchTools, setAvailableSearchTools] = useState<Tool[]>([]);

  const [objective, setObjective] = useState(objectiveDraft ?? '');
  const [outputKind, setOutputKind] = useState<ResearchOutputKind>('report');
  const [budgetMode, setBudgetMode] = useState<ResearchBudgetMode>('balanced');
  const [budgetLimitUsd, setBudgetLimitUsd] = useState('');
  const [timeRange, setTimeRange] = useState('');
  const [region, setRegion] = useState('');
  const [language, setLanguage] = useState('');
  const [mustCover, setMustCover] = useState('');
  const [minCitations, setMinCitations] = useState('');
  // '' means "use system default"
  const [preferredModelId, setPreferredModelId] = useState('');
  const [preferredSearchTool, setPreferredSearchTool] = useState('');
  // Synthesis model can differ from the chat default — e.g. use Opus for the
  // research-report write-up even when chat uses a cheaper Haiku.
  const [synthesisModelId, setSynthesisModelId] = useState('');
  const [planFeedback, setPlanFeedback] = useState('');
  const [planFeedbackBusy, setPlanFeedbackBusy] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('');

  const isControlled = controlledSelectedId !== undefined;
  const selectedId = isControlled ? controlledSelectedId : internalSelectedId;

  // Stable ref so loadSessions can read the current selectedId without capturing it in deps
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const setSelectedId = useCallback(
    (id: string | null) => {
      if (!isControlled) {
        setInternalSelectedId(id);
      }
      onSelectedIdChange?.(id);
    },
    [isControlled, onSelectedIdChange],
  );

  const setObjectiveValue = useCallback(
    (value: string) => {
      setObjective(value);
      onObjectiveDraftChange?.(value);
    },
    [onObjectiveDraftChange],
  );

  useEffect(() => {
    if (objectiveDraft !== undefined && objectiveDraft !== objective) {
      setObjective(objectiveDraft);
    }
  }, [objective, objectiveDraft]);

  const notifyResearchChanged = useCallback(async () => {
    window.dispatchEvent(new Event('taori:data-changed'));
    await onSessionsChanged?.();
  }, [onSessionsChanged]);

  const loadSessions = useCallback(
    async (preferId?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.listResearchSessions();
        setSessions(res.research_sessions);
        const currentId = selectedIdRef.current;
        const nextSelected =
          preferId ??
          (currentId && res.research_sessions.some((item) => item.id === currentId)
            ? currentId
            : null) ??
          (isControlled ? null : (res.research_sessions[0]?.id ?? null));
        setSelectedId(nextSelected);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [isControlled, setSelectedId],
  );

  const loadDetail = useCallback(async (id: string, silent = false) => {
    if (!silent) setDetailLoading(true);
    if (!silent) setError(null);
    try {
      const res = await api.getResearchSessionDetail(id);
      setDetail(res);
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!silent) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions(controlledSelectedId ?? undefined);
  }, [controlledSelectedId, loadSessions]);

  // Fetch available models + search tools for the pickers (best effort — do not block UI).
  useEffect(() => {
    void api.listModels().then((res) => {
      const chatModels = res.models.filter(
        (m) => m.enabled && !m.demoted && m.capability === 'chat' && m.provider_id,
      );
      setAvailableModels(chatModels);
    }).catch(() => {});
    void api.listTools().then((res) => {
      const searchable = res.data.filter(
        (t) => t.enabled && (t.name === 'builtin.web_search' || /search/i.test(t.name)),
      );
      setAvailableSearchTools(searchable);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    // Poll while running (tasks in progress) or while reviewing without a plan
    // yet (waiting for async AI planning to finish). Tighten the interval
    // during drafting/verifying so streaming synthesis chunks appear in
    // near-real-time instead of in 2s bursts.
    const isRunning = detail?.session.status === 'running';
    const isPlanningNoPlan =
      detail?.session.status === 'reviewing' &&
      !detail.session.plan &&
      detail.session.stage === 'planning';
    if (!isRunning && !isPlanningNoPlan) return;
    const isStreamingDraft =
      isRunning && (detail?.session.stage === 'drafting' || detail?.session.stage === 'verifying');
    const intervalMs = isStreamingDraft ? 1_000 : 2_000;
    const handle = window.setInterval(() => {
      void loadDetail(selectedId, true); // silent: no flicker or scroll reset
    }, intervalMs);
    return () => window.clearInterval(handle);
  }, [detail?.session.plan, detail?.session.stage, detail?.session.status, loadDetail, selectedId]);

  const selectedSession = useMemo(
    () => sessions?.find((item) => item.id === selectedId) ?? null,
    [selectedId, sessions],
  );

  const startDisabled = objective.trim().length === 0 || actionBusy != null;

  const resetComposer = useCallback(() => {
    setObjectiveValue('');
    setBudgetLimitUsd('');
    setTimeRange('');
    setRegion('');
    setLanguage('');
    setMustCover('');
    setMinCitations('');
  }, [setObjectiveValue]);

  const returnHome = useCallback(() => {
    resetComposer();
    setPlanFeedback('');
    setError(null);
    setSelectedId(null);
  }, [resetComposer, setSelectedId]);

  const refreshCurrent = useCallback(
    async (next: ResearchSessionDetail) => {
      setDetail(next);
      setSelectedId(next.session.id);
      await loadSessions(next.session.id);
      await notifyResearchChanged();
    },
    [loadSessions, notifyResearchChanged, setSelectedId],
  );

  const createSessionInput = useCallback(
    () => ({
      title: deriveTitle(objective),
      objective: objective.trim(),
      output_kind: outputKind,
      budget_mode: budgetMode,
      budget_limit_usd: budgetLimitUsd.trim() ? Number(budgetLimitUsd) : null,
      constraints: {
        time_range: timeRange.trim() || null,
        region: region.trim() || null,
        language: language.trim() || null,
        must_cover: mustCover
          .split(/[\n,]/)
          .map((item) => item.trim())
          .filter(Boolean),
        min_citations: minCitations.trim() ? Number(minCitations) : null,
      },
      preferred_model_id: preferredModelId.trim() || null,
      preferred_search_tool: preferredSearchTool.trim() || null,
      synthesis_model_id: synthesisModelId.trim() || null,
    }),
    [budgetLimitUsd, budgetMode, language, minCitations, mustCover, objective, outputKind, preferredModelId, preferredSearchTool, region, synthesisModelId, timeRange],
  );

  const handleQuickStart = useCallback(async () => {
    if (startDisabled) return;
    setActionBusy('quick-start');
    setError(null);
    try {
      const created = await api.createResearchSession(createSessionInput());
      resetComposer();
      // Session is created in 'reviewing' state; AI planning starts async
      await loadSessions(created.id);
      setSelectedId(created.id);
      await notifyResearchChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  }, [createSessionInput, loadSessions, notifyResearchChanged, resetComposer, setSelectedId, startDisabled]);

  const submitPlanFeedback = useCallback(async () => {
    if (!selectedId || !planFeedback.trim()) return;
    setPlanFeedbackBusy(true);
    setError(null);
    try {
      const updated = await api.reviseResearchPlan(selectedId, planFeedback.trim());
      setPlanFeedback('');
      await refreshCurrent(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanFeedbackBusy(false);
    }
  }, [planFeedback, refreshCurrent, selectedId]);

  const runAction = useCallback(
    async (
      action:
        | 'confirm'
        | 'pause'
        | 'resume'
        | 'cancel'
        | 'export-json'
        | 'export-markdown',
    ) => {
      if (!selectedId) return;
      setActionBusy(action);
      setError(null);
      try {
        if (action === 'confirm') {
          await refreshCurrent(await api.startResearchSession(selectedId, { confirm: true }));
        } else if (action === 'pause') {
          await refreshCurrent(await api.pauseResearchSession(selectedId));
        } else if (action === 'resume') {
          await refreshCurrent(await api.resumeResearchSession(selectedId));
        } else if (action === 'cancel') {
          await refreshCurrent(await api.cancelResearchSession(selectedId));
        } else {
          const exported = await api.exportResearchSession(selectedId, {
            format: action === 'export-markdown' ? 'markdown' : 'json',
          });
          downloadExport(exported.filename, exported.content_type, exported.content);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setActionBusy(null);
      }
    },
    [refreshCurrent, selectedId],
  );

  const taskStats = useMemo(() => {
    const tasks = detail?.tasks ?? [];
    return {
      total: tasks.length,
      queued: tasks.filter((task) => task.status === 'queued').length,
      running: tasks.filter((task) => task.status === 'running').length,
      completed: tasks.filter((task) => task.status === 'completed').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
    };
  }, [detail]);

  const progressPercent = useMemo(() => {
    if (taskStats.total === 0) return 0;
    return Math.round((taskStats.completed / taskStats.total) * 100);
  }, [taskStats]);

  const reportContent = detail?.session.final_markdown ?? detail?.session.draft_markdown ?? '（尚未生成草稿）';
  const reportReady = reportContent !== '（尚未生成草稿）';

  // Per-paragraph follow-up: hover any report paragraph → floating "🔍 追问"
  // button → modal → submit creates a child research session whose objective
  // embeds the parent title + paragraph excerpt + user question.
  const reportContainerRef = useRef<HTMLDivElement | null>(null);
  const [floatingFollowup, setFloatingFollowup] = useState<{ text: string; top: number } | null>(null);
  const [followupModal, setFollowupModal] = useState<{ excerpt: string } | null>(null);
  const [followupInput, setFollowupInput] = useState('');
  const [followupBusy, setFollowupBusy] = useState(false);

  const printResearchReport = useCallback(() => {
    // Browser print path with a body class so @media print can scope to the
    // report card only. Cheaper than wiring jsPDF / pdfkit and works in both
    // Tauri (Chromium WebView) and browser standalone mode. We also force-open
    // every <details> inside the report card (e.g. citation evidence spans)
    // because <details> content is invisible to the print dialog when closed,
    // then restore the user's prior state after printing finishes.
    document.body.classList.add('taori-printing-research');
    const reportCard = document.querySelector('.research-center__message--report');
    const detailsList = reportCard
      ? Array.from(reportCard.querySelectorAll('details')) as HTMLDetailsElement[]
      : [];
    const priorOpenState = new Map<HTMLDetailsElement, boolean>();
    for (const d of detailsList) {
      priorOpenState.set(d, d.open);
      d.open = true;
    }
    const cleanup = () => {
      document.body.classList.remove('taori-printing-research');
      for (const [d, wasOpen] of priorOpenState) {
        d.open = wasOpen;
      }
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    // Some browsers don't fire afterprint in headless print dialogs; auto-clean too.
    window.setTimeout(cleanup, 4_000);
    window.print();
  }, []);

  const openFollowupModal = useCallback((excerpt: string) => {
    setFloatingFollowup(null);
    setFollowupModal({ excerpt: excerpt.slice(0, 600) });
    setFollowupInput('');
  }, []);

  const closeFollowupModal = useCallback(() => {
    setFollowupModal(null);
    setFollowupInput('');
  }, []);

  const submitFollowup = useCallback(async () => {
    if (!followupModal || !detail) return;
    const question = followupInput.trim();
    if (!question) return;
    setFollowupBusy(true);
    setError(null);
    try {
      const excerpt = followupModal.excerpt.replace(/\s+/g, ' ').slice(0, 300);
      const objective = `基于「${detail.session.title}」研究中提到的"${excerpt}${followupModal.excerpt.length > 300 ? '…' : ''}"，进一步追问：${question}`;
      const created = await api.createResearchSession({
        title: deriveTitle(question),
        objective,
        output_kind: detail.session.output_kind,
        budget_mode: detail.session.budget_mode,
        budget_limit_usd: detail.session.budget_limit_usd ?? null,
        constraints: detail.session.constraints,
        preferred_model_id: detail.session.preferred_model_id ?? null,
        preferred_search_tool: detail.session.preferred_search_tool ?? null,
        synthesis_model_id: detail.session.synthesis_model_id ?? null,
      });
      closeFollowupModal();
      await loadSessions(created.id);
      setSelectedId(created.id);
      await notifyResearchChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFollowupBusy(false);
    }
  }, [closeFollowupModal, detail, followupInput, followupModal, loadSessions, notifyResearchChanged, setSelectedId]);

  // Event delegation: when the user hovers a paragraph/heading/list-item in
  // the rendered markdown, anchor a floating "追问" button next to it.
  // Cleared on mouseleave from the container.
  const handleReportMouseOver = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const container = reportContainerRef.current;
    if (!container) return;
    const target = (e.target as HTMLElement).closest('p, h2, h3, h4, li') as HTMLElement | null;
    if (!target || !container.contains(target)) return;
    const text = target.textContent?.trim() ?? '';
    if (text.length < 30) return; // skip tiny headings / numbering rows
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = targetRect.top - containerRect.top + container.scrollTop;
    setFloatingFollowup({ text, top: Math.max(0, top - 4) });
  }, []);

  const handleReportMouseLeave = useCallback(() => {
    setFloatingFollowup(null);
  }, []);
  const latestTask = useMemo(() => {
    if (!detail) return null;
    return (
      detail.tasks.find((task) => task.status === 'running') ??
      [...detail.tasks].reverse().find((task) => task.status === 'failed' || task.status === 'queued') ??
      detail.tasks.at(-1) ??
      null
    );
  }, [detail]);
  const constraintSummary = detail ? buildConstraintSummary(detail.session) : [];
  const planConversation = (detail?.session.plan_messages ?? []) as PlanMessage[];
  const planOrigin = detail?.session.plan_origin ?? 'pending';
  const planOriginInfo = useMemo(() => planOriginMeta(planOrigin), [planOrigin]);
  const isScopingReview =
    detail?.session.status === 'reviewing' &&
    !detail.session.plan &&
    detail.session.stage === 'scoping';
  const isPlanningFailure =
    detail?.session.status === 'failed' &&
    !detail.session.plan &&
    detail.session.stage === 'planning';
  const latestPlanAssistantMessage = useMemo(
    () => [...planConversation].reverse().find((msg) => msg.role === 'assistant')?.content ?? '',
    [planConversation],
  );
  const uniqueSourceHosts = useMemo(() => {
    if (!detail) return 0;
    return new Set(detail.sources.map((item) => safeHostname(item.locator))).size;
  }, [detail]);
  const verifiedClaims = useMemo(() => {
    if (!detail) return 0;
    return detail.claims.filter((claim) => claim.support_status === 'supported').length;
  }, [detail]);
  const latestReflectTask = useMemo(() => {
    if (!detail) return null;
    return [...detail.tasks]
      .reverse()
      .find((task) => task.kind === 'reflect' && (task.status === 'completed' || task.status === 'skipped')) ?? null;
  }, [detail]);
  const coverageItems = useMemo<CoverageViewItem[]>(() => {
    if (!detail?.session.plan || detail.sources.length === 0) return [];
    const rawCoverage = Array.isArray(latestReflectTask?.output?.coverage)
      ? latestReflectTask.output.coverage.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      : [];
    const coverageMap = new Map(
      rawCoverage
        .filter((item) => typeof item.question_id === 'string')
        .map((item) => [String(item.question_id), item] as const),
    );
    return detail.session.plan.key_questions.map((question) => {
      const mapped = coverageMap.get(question.id);
      const matchedSources = detail.sources.filter((source) => sourceMatchesQuestionId(source, question.id));
      const hostCount = new Set(matchedSources.map((source) => safeHostname(source.locator))).size;
      const fallbackLevel: CoverageLevel =
        matchedSources.length >= 3 && hostCount >= 2 ? 'good' : matchedSources.length > 0 ? 'partial' : 'missing';
      const hasLLMData = typeof mapped?.level === 'string' && (mapped.level === 'good' || mapped.level === 'missing' || mapped.level === 'partial');
      return {
        id: question.id,
        question: question.question,
        reason: question.reason,
        level: hasLLMData ? (mapped.level as CoverageLevel) : fallbackLevel,
        isEstimated: !hasLLMData,
        sources: matchedSources.length,
        hosts: hostCount,
        whatWeKnow:
          typeof mapped?.what_we_know === 'string' && mapped.what_we_know.trim()
            ? mapped.what_we_know
            : matchedSources.length > 0
                ? `已收集 ${matchedSources.length} 条来源，覆盖 ${hostCount} 个站点。`
              : '还没有拿到稳定证据。',
        whatIsMissing:
          typeof mapped?.what_is_missing === 'string' && mapped.what_is_missing.trim()
            ? mapped.what_is_missing
            : matchedSources.length >= 3 && hostCount >= 2
              ? '当前覆盖已较完整。'
              : matchedSources.length > 0
                ? '还需要补足更多独立来源或官方口径。'
                : '需要补第一批来源与基本事实。',
      };
    });
  }, [detail, latestReflectTask]);
  const sourceMix = useMemo(() => {
    if (!detail) return [];
    const counts: Record<SourceKind, number> = { official: 0, third_party: 0, community: 0 };
    for (const source of detail.sources) {
      counts[sourceKindValue(source)] += 1;
    }
    return (Object.entries(counts) as Array<[SourceKind, number]>)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => ({
        kind,
        count,
        ...sourceKindMeta(kind),
      }));
  }, [detail]);
  const claimSummary = useMemo(() => {
    if (!detail) return [];
    const counts = new Map<string, number>();
    for (const claim of detail.claims) {
      counts.set(claim.support_status, (counts.get(claim.support_status) ?? 0) + 1);
    }
    return ['supported', 'weak', 'conflicted', 'unverified']
      .map((status) => ({
        status,
        count: counts.get(status) ?? 0,
        ...claimStatusMeta(status),
      }))
      .filter((item) => item.count > 0);
  }, [detail]);
  const searchDepthStats = useMemo(() => {
    const tasks = detail?.tasks.filter((task) => task.kind === 'search') ?? [];
    let rounds = 0;
    let recoveryRounds = 0;
    const engineAttempts = new Set<string>();
    for (const task of tasks) {
      const taskRounds = Array.isArray(task.output?.rounds)
        ? task.output.rounds.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        : [];
      rounds += typeof task.output?.rounds_completed === 'number'
        ? task.output.rounds_completed
        : Math.max(taskRounds.length, task.status === 'completed' ? 1 : 0);
      recoveryRounds += taskRounds.filter((round) => round.phase === 'recovery').length;
      const attempts = Array.isArray(task.output?.engine_attempts)
        ? task.output.engine_attempts.filter((item): item is string => typeof item === 'string')
        : [];
      attempts.forEach((engine) => engineAttempts.add(engine));
      if (typeof task.output?.search_engine === 'string') engineAttempts.add(task.output.search_engine);
    }
    return {
      tasks: tasks.length,
      rounds,
      recoveryRounds,
      engines: Array.from(engineAttempts)
        .map((engine) => searchEngineLabel(engine) ?? engine)
        .filter((engine, index, arr) => Boolean(engine) && arr.indexOf(engine) === index),
    };
  }, [detail]);
  const stageRailItems = useMemo<StageRailItem[]>(() => {
    if (!detail) return [];
    return STAGE_ORDER.map((stage) => ({
      stage,
      label: STAGE_LABELS[stage],
      description: STAGE_DESCRIPTIONS[stage],
      state: stageRailState(stage, detail.session.stage, detail.session.status),
    }));
  }, [detail]);
  const researchInsights = useMemo<ResearchInsight[]>(() => {
    if (!detail) return [];
    const sourceTone: ResearchInsight['tone'] =
      detail.sources.length >= 8 && uniqueSourceHosts >= 3
        ? 'good'
        : detail.sources.length > 0
          ? 'warn'
          : 'neutral';
    const coverageGood = coverageItems.filter((item) => item.level === 'good').length;
    const coverageTone: ResearchInsight['tone'] =
      coverageItems.length === 0
        ? 'neutral'
        : coverageItems.some((item) => item.level === 'missing')
          ? 'danger'
          : coverageGood === coverageItems.length
            ? 'good'
            : 'warn';
    const claimTone: ResearchInsight['tone'] =
      detail.claims.length === 0
        ? 'neutral'
        : claimSummary.some((item) => item.status === 'conflicted' || item.status === 'weak')
          ? 'warn'
          : verifiedClaims === detail.claims.length
            ? 'good'
            : 'neutral';
    const searchTone: ResearchInsight['tone'] =
      searchDepthStats.recoveryRounds > 0
        ? 'warn'
        : searchDepthStats.rounds >= Math.max(2, searchDepthStats.tasks)
          ? 'good'
          : 'neutral';
    return [
      {
        label: '证据池',
        value: `${detail.sources.length} 条 / ${uniqueSourceHosts} 站点`,
        detail:
          detail.sources.length === 0
            ? '开始执行后会持续收集来源。'
            : sourceMix.length > 0
              ? sourceMix.map((item) => `${item.label} ${item.count}`).join(' · ')
              : '来源结构待分类。',
        tone: sourceTone,
      },
      {
        label: '覆盖度',
        value: coverageItems.length > 0 ? `${coverageGood}/${coverageItems.length} 充分` : '待评估',
        detail:
          coverageItems.length === 0
            ? '收集来源后会按关键问题评估覆盖情况。'
            : coverageItems.some((item) => item.isEstimated)
              ? '包含估算项；深入模式会用反思任务进一步评估。'
              : '已基于反思任务评估每个关键问题。',
        tone: coverageTone,
      },
      {
        label: '检索深度',
        value: searchDepthStats.rounds > 0 ? `${searchDepthStats.rounds} 轮` : '未开始',
        detail:
          searchDepthStats.engines.length > 0
            ? `${searchDepthStats.engines.join(' / ')}${searchDepthStats.recoveryRounds > 0 ? ` · ${searchDepthStats.recoveryRounds} 轮补救` : ''}`
            : '等待检索任务启动。',
        tone: searchTone,
      },
      {
        label: '主张校验',
        value: detail.claims.length > 0 ? `${verifiedClaims}/${detail.claims.length} 已验证` : '待生成',
        detail:
          claimSummary.length > 0
            ? claimSummary.map((item) => `${item.label} ${item.count}`).join(' · ')
            : '生成草稿后会抽取主张并绑定引用。',
        tone: claimTone,
      },
    ];
  }, [
    claimSummary,
    coverageItems,
    detail,
    searchDepthStats,
    sourceMix,
    uniqueSourceHosts,
    verifiedClaims,
  ]);
  const budgetStatus = useMemo(() => {
    if (!detail) return null;
    const spent = detail.session.budget_spent_usd;
    if (detail.session.budget_limit_usd != null && detail.session.budget_limit_usd > 0) {
      const limit = detail.session.budget_limit_usd;
      const ratio = spent / limit;
      return {
        ratio,
        percent: Math.round(ratio * 100),
        tone: ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warning' : 'ok',
        copy:
          ratio >= 1
            ? '已触达预算上限，建议先收口结论或提高预算。'
            : ratio >= 0.8
              ? '预算已接近上限，建议优先补关键缺口。'
              : `预算仍有余量，可继续深入当前重点。`,
      };
    }
    if (spent > 0) {
      return {
        ratio: 0,
        percent: 0,
        tone: 'ok' as const,
        copy: `已花费 ${spent.toFixed(3)} USD。`,
      };
    }
    return null;
  }, [detail]);
  const failedTaskSummary = useMemo(() => {
    if (!detail) return null;
    const failed = detail.tasks.filter((t) => t.status === 'failed');
    if (failed.length === 0) return null;
    const kinds = [...new Set(failed.map((t) => t.kind))];
    return { count: failed.length, kinds };
  }, [detail]);

  const nextStepItems = useMemo(() => {
    if (!detail) return [];
    const followUps = Array.isArray(latestReflectTask?.output?.follow_up_searches)
      ? latestReflectTask.output.follow_up_searches.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      : [];
    const items = followUps
      .map((item) =>
        typeof item.topic === 'string' && item.topic.trim()
          ? item.topic.trim()
          : typeof item.query === 'string'
            ? item.query.trim()
            : '',
      )
      .filter(Boolean)
      .slice(0, 3);
    if (items.length > 0) return items;
    if (coverageItems.some((item) => item.level === 'missing')) return ['先补第一手或高可信来源，避免直接生成长结论。'];
    if (claimSummary.some((item) => item.status === 'weak' || item.status === 'unverified')) {
      return ['针对弱证据结论补独立来源，再做一次引用校验。'];
    }
    if (detail.sources.length > 0 && sourceMix.every((item) => item.kind !== 'official')) {
      return ['补一轮官方文档 / 状态页 / 公告来源，提升可回溯性。'];
    }
    if (detail.session.status === 'completed') return ['建议导出结果，或返回起始页发起一项新的相关研究。'];
    return [];
  }, [claimSummary, coverageItems, detail, latestReflectTask, sourceMix]);

  const reportOverview = useMemo<ResearchReportOverview | null>(() => {
    if (!detail || !reportReady || detail.session.status === 'draft') return null;

    const coverageGood = coverageItems.filter((item) => item.level === 'good').length;
    const coverageMissing = coverageItems.filter((item) => item.level === 'missing').length;
    const coveragePartial = coverageItems.filter((item) => item.level === 'partial').length;
    const coverageRatio = coverageItems.length > 0 ? coverageGood / coverageItems.length : 0;
    const claimRatio = detail.claims.length > 0 ? verifiedClaims / detail.claims.length : 0;
    const officialSources = sourceMix.find((item) => item.kind === 'official')?.count ?? 0;
    const weakClaims = claimSummary
      .filter((item) => item.status === 'weak' || item.status === 'unverified')
      .reduce((sum, item) => sum + item.count, 0);
    const conflictedClaims = claimSummary.find((item) => item.status === 'conflicted')?.count ?? 0;

    let readiness: ResearchReportOverview['readiness'];
    if (detail.sources.length === 0) {
      readiness = {
        label: '等待证据',
        detail: '报告草稿已经生成，但还没有可回溯来源，不建议直接采纳。',
        tone: 'danger',
      };
    } else if (coverageMissing > 0 || conflictedClaims > 0) {
      readiness = {
        label: '谨慎采纳',
        detail: '仍存在未覆盖问题或冲突主张，适合先补证再定稿。',
        tone: 'warn',
      };
    } else if (coverageItems.length > 0 && coverageGood === coverageItems.length && weakClaims === 0 && verifiedClaims === detail.claims.length) {
      readiness = {
        label: '可以采纳',
        detail: '关键问题覆盖完整，主张均已获得引用支撑。',
        tone: 'good',
      };
    } else if (detail.sources.length >= 3 && (verifiedClaims > 0 || coverageGood > 0)) {
      readiness = {
        label: '可作初稿',
        detail: '已有可用证据，但部分结论仍需要补强或复核。',
        tone: 'neutral',
      };
    } else {
      readiness = {
        label: '证据偏弱',
        detail: '来源或主张校验不足，建议先补充检索。',
        tone: 'warn',
      };
    }

    const risks = [
      coverageMissing > 0 ? `${coverageMissing} 个关键问题还没有稳定证据。` : null,
      coveragePartial > 0 ? `${coveragePartial} 个关键问题仍需独立来源补强。` : null,
      weakClaims > 0 ? `${weakClaims} 条主张仍是弱证据或待验证。` : null,
      conflictedClaims > 0 ? `${conflictedClaims} 条主张存在来源冲突。` : null,
      detail.sources.length > 0 && officialSources === 0 ? '暂未纳入官方来源，结论可回溯性有限。' : null,
      searchDepthStats.recoveryRounds > 0 ? `检索过程经历 ${searchDepthStats.recoveryRounds} 轮补救，说明公开资料命中并不稳定。` : null,
    ].filter((item): item is string => Boolean(item));

    return {
      readiness,
      cards: [
        {
          label: '证据成熟度',
          value: detail.sources.length > 0 ? formatPercent((detail.sources.length >= 8 ? 0.55 : detail.sources.length / 14) + Math.min(uniqueSourceHosts, 4) * 0.08) : '0%',
          detail: `${detail.sources.length} 条来源，覆盖 ${uniqueSourceHosts} 个站点；官方来源 ${officialSources} 条。`,
        },
        {
          label: '覆盖成熟度',
          value: coverageItems.length > 0 ? formatPercent(coverageRatio) : '待评估',
          detail: coverageItems.length > 0 ? `${coverageGood}/${coverageItems.length} 个关键问题覆盖充分。` : '需要完成反思或检索后评估。',
        },
        {
          label: '主张可信度',
          value: detail.claims.length > 0 ? formatPercent(claimRatio) : '待抽取',
          detail: detail.claims.length > 0 ? `${verifiedClaims}/${detail.claims.length} 条主张已验证。` : '生成草稿后会抽取主张并校验引用。',
        },
      ],
      risks: risks.slice(0, 4),
      nextSteps: nextStepItems.slice(0, 3),
    };
  }, [
    claimSummary,
    coverageItems,
    detail,
    nextStepItems,
    reportReady,
    searchDepthStats.recoveryRounds,
    sourceMix,
    uniqueSourceHosts,
    verifiedClaims,
  ]);

  const checklistItems = useMemo<ChecklistItem[]>(() => {
    if (!detail) return [];
    if (detail.tasks.length > 0) {
      return detail.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        subtitle: taskDetail(task) || taskStatusLabel(task),
        status: task.status,
      }));
    }
    if (detail.session.plan) {
      return detail.session.plan.key_questions.map((item) => ({
        id: item.id,
        title: item.question,
        subtitle: item.reason,
        status: detail.session.status === 'completed' ? 'completed' : 'queued',
      }));
    }
    return STAGE_ORDER.map((stage) => ({
      id: stage,
      title: STAGE_LABELS[stage],
      subtitle: STAGE_DESCRIPTIONS[stage],
      status: checklistFallbackStatus(stage, detail.session.stage, detail.session.status),
    }));
  }, [detail]);

  const statusHeadline = useMemo(() => {
    if (!detail) return '';
    if (detail.session.status === 'reviewing' && !detail.session.plan && detail.session.stage === 'scoping') {
      return '先确认研究边界，再生成计划';
    }
    if (isPlanningFailure) return '研究计划生成失败';
    if (detail.session.status === 'reviewing' && !detail.session.plan) return 'AI 正在生成研究计划…';
    if (detail.session.status === 'reviewing' && detail.session.plan_origin === 'fallback') {
      return '检测到历史兜底计划';
    }
    if (detail.session.status === 'reviewing') return 'AI 计划已生成，等待你确认';
    if (detail.session.status === 'running') return `正在执行 · ${STAGE_LABELS[detail.session.stage]}`;
    if (detail.session.status === 'completed') return '研究已完成，可以直接阅读结果';
    if (detail.session.status === 'draft') return '先生成研究计划';
    return `${STATUS_LABELS[detail.session.status]} · ${STAGE_LABELS[detail.session.stage]}`;
  }, [detail]);

  const statusCopy = useMemo(() => {
    if (!detail) return '';
    if (detail.session.status === 'reviewing' && !detail.session.plan && detail.session.stage === 'scoping') {
      return '先把研究边界说清楚，后续检索和综合才会更深、更稳。';
    }
    if (isPlanningFailure) {
      return latestPlanAssistantMessage || '研究计划生成失败。你可以直接重试，或先检查模型 / Provider / API Key 配置。';
    }
    if (detail.session.status === 'reviewing') {
      if (detail.session.plan_origin === 'fallback') {
        return '这是旧版本遗留的兜底计划；当前版本在 AI 规划失败时会直接失败并提示重试。';
      }
      return '先过一遍关键问题与停止条件，确认后才会真正开始搜索、抓取与写作。';
    }
    if (detail.session.status === 'running') {
      return latestTask
        ? taskDetail(latestTask) || `已完成 ${taskStats.completed}/${taskStats.total} 个步骤。`
        : `已完成 ${taskStats.completed}/${taskStats.total} 个步骤。`;
    }
    if (detail.session.status === 'completed') {
      return `已纳入 ${detail.sources.length} 条来源，整理出 ${detail.claims.length} 条主张。`;
    }
    if (detail.session.status === 'draft') {
      return '输入目标后，Taori 会先生成一版研究计划供你确认。';
    }
    return latestTask?.status === 'failed'
      ? taskDetail(latestTask) || '研究中断，你可以恢复后继续。'
      : '你可以继续查看结果，或基于当前方向发起下一轮研究。';
  }, [detail, isPlanningFailure, latestPlanAssistantMessage, latestTask, taskStats.completed, taskStats.total]);
  const researchSummary = useMemo(() => {
    if (!detail) return '';
    if (detail.session.status === 'reviewing') {
      return detail.session.plan?.summary ?? statusCopy;
    }
    return statusCopy;
  }, [detail, statusCopy]);

  const summaryMetrics = useMemo(() => {
    if (!detail) return [];
    return [
      {
        label: '深度',
        value: detail.session.budget_limit_usd != null
          ? `${BUDGET_MODE_LABELS[detail.session.budget_mode]} · ${detail.session.budget_limit_usd} USD`
          : BUDGET_MODE_LABELS[detail.session.budget_mode],
      },
      {
        label: '花费',
        value: `${detail.session.budget_spent_usd.toFixed(3)} USD`,
      },
      {
        label: '来源 / 站点',
        value: `${detail.sources.length} / ${uniqueSourceHosts}`,
      },
      {
        label: '主张 / 已验证',
        value: `${detail.claims.length} / ${verifiedClaims}`,
      },
    ];
  }, [detail, uniqueSourceHosts, verifiedClaims]);

  const evidenceSummary = useMemo(() => {
    if (!detail) return '';
    if (detail.sources.length > 0) {
      return `已收集 ${detail.sources.length} 条来源，最近更新于 ${formatAgo(detail.session.updated_at)}。`;
    }
    if (detail.session.plan) {
      return `当前有 ${detail.session.plan.stop_conditions.length} 条停止条件待你确认。`;
    }
    return '研究线索会在执行中持续累积。';
  }, [detail]);

  const visibleSources = useMemo(() => {
    const all = detail?.sources ?? [];
    if (!sourceFilter.trim()) return all;
    const q = sourceFilter.trim().toLowerCase();
    return all.filter((s) =>
      (s.title ?? '').toLowerCase().includes(q)
      || s.locator.toLowerCase().includes(q)
      || (s.snippet ?? '').toLowerCase().includes(q),
    );
  }, [detail?.sources, sourceFilter]);
  const hasCollectedEvidence = (detail?.sources.length ?? 0) > 0;
  const showEvidencePanel =
    Boolean(detail?.session.plan) || visibleSources.length > 0;
  const showReportCard = Boolean(
    detail &&
      reportReady &&
      detail.session.status !== 'draft' &&
      (detail.session.status === 'completed' || hasCollectedEvidence),
  );

  const renderAdvancedOptions = () => (
    <details className="research-center__advanced-opts">
      <summary>高级约束</summary>
      <div className="research-center__form research-center__advanced-grid">
        <div className="research-center__form-grid">
          <label>
            <span>预算上限 USD</span>
            <input
              value={budgetLimitUsd}
              onChange={(e) => setBudgetLimitUsd(e.target.value)}
              placeholder="可留空"
              data-testid="research-input-budget-limit"
            />
          </label>
          <label>
            <span>最低引用数</span>
            <input
              value={minCitations}
              onChange={(e) => setMinCitations(e.target.value)}
              placeholder="可留空"
              data-testid="research-input-min-citations"
            />
          </label>
        </div>
        <div className="research-center__form-grid">
          <label>
            <span>时间范围</span>
            <input
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value)}
              placeholder="如：近 12 个月"
              data-testid="research-input-time-range"
            />
          </label>
          <label>
            <span>区域</span>
            <input
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="如：中国 / 全球"
              data-testid="research-input-region"
            />
          </label>
        </div>
        <div className="research-center__form-grid">
          <label>
            <span>语言</span>
            <input
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="如：中文 + 英文"
              data-testid="research-input-language"
            />
          </label>
          <label>
            <span>必须覆盖</span>
            <input
              value={mustCover}
              onChange={(e) => setMustCover(e.target.value)}
              placeholder="逗号分隔，如价格、速度、风险"
              data-testid="research-input-must-cover"
            />
          </label>
        </div>
      </div>
    </details>
  );

  const renderComposerControls = () => (
    <div className="research-center__composer-controls">
      <span className="research-center__pill research-center__pill--active">深度研究</span>
      <label className="research-center__inline-select">
        <span>产出</span>
        <select
          value={outputKind}
          onChange={(e) => setOutputKind(e.target.value as ResearchOutputKind)}
          data-testid="research-input-output-kind"
        >
          {Object.entries(OUTPUT_KIND_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="research-center__inline-select">
        <span>深度</span>
        <select
          value={budgetMode}
          onChange={(e) => setBudgetMode(e.target.value as ResearchBudgetMode)}
          data-testid="research-input-budget-mode"
        >
          {Object.entries(BUDGET_MODE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {availableModels.length > 0 ? (
        <label className="research-center__inline-select">
          <span>模型</span>
          <select
            value={preferredModelId}
            onChange={(e) => setPreferredModelId(e.target.value)}
            data-testid="research-input-model"
          >
            <option value="">系统默认</option>
            {availableModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {availableModels.length > 0 ? (
        <label className="research-center__inline-select" title="用于把检索到的资料综合成研究报告的模型，可独立于聊天默认模型。">
          <span>综合模型</span>
          <select
            value={synthesisModelId}
            onChange={(e) => setSynthesisModelId(e.target.value)}
            data-testid="research-input-synthesis-model"
          >
            <option value="">跟随上方模型</option>
            {availableModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {availableSearchTools.length > 1 ? (
        <label className="research-center__inline-select">
          <span>搜索</span>
          <select
            value={preferredSearchTool}
            onChange={(e) => setPreferredSearchTool(e.target.value)}
            data-testid="research-input-search-tool"
          >
            <option value="">系统默认</option>
            {availableSearchTools.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name.replace('builtin.', '').replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );

  const renderComposerFooter = (buttonLabel: string) => (
    <div className="research-center__composer-footer">
      {renderComposerControls()}
      <button
        type="button"
        className="research-center__primary-btn"
        disabled={startDisabled}
        onClick={() => void handleQuickStart()}
        data-testid="research-quick-start"
      >
        {actionBusy === 'quick-start' ? '生成中…' : buttonLabel}
      </button>
    </div>
  );

  const renderSessionActions = () => {
    if (!detail) return null;
    return (
      <div className="research-center__action-row research-center__action-row--compact">
        {detail.session.status === 'reviewing' && detail.session.plan ? (
          <>
            <button
              type="button"
              className="research-center__primary-btn"
              disabled={actionBusy != null}
              onClick={() => void runAction('confirm')}
              data-testid="research-action-confirm"
            >
              {actionBusy === 'confirm' ? '启动中…' : '开始执行'}
            </button>
          </>
        ) : null}
        {detail.session.status === 'reviewing' && !detail.session.plan ? (
          <span className="research-center__planning-indicator">
            <span className="research-center__spinner" aria-hidden /> AI 正在规划中…
          </span>
        ) : null}
        {detail.session.status === 'running' ? (
          <button
            type="button"
            className="research-center__ghost-btn"
            disabled={actionBusy != null}
            onClick={() => void runAction('pause')}
            data-testid="research-action-pause"
          >
            暂停
          </button>
        ) : null}
        {(detail.session.status === 'paused' || detail.session.status === 'failed') ? (
          <button
            type="button"
            className="research-center__primary-btn"
            disabled={actionBusy != null}
            onClick={() => void runAction('resume')}
            data-testid="research-action-resume"
          >
            {isPlanningFailure ? '重试生成计划' : '恢复'}
          </button>
        ) : null}
        {detail.session.status !== 'draft' &&
        detail.session.status !== 'cancelled' &&
        detail.session.status !== 'completed' ? (
          <button
            type="button"
            className="research-center__danger-btn"
            disabled={actionBusy != null}
            onClick={() => void runAction('cancel')}
            data-testid="research-action-cancel"
          >
            取消
          </button>
        ) : null}
        <button
          type="button"
          className="research-center__ghost-btn"
          disabled={actionBusy != null}
          onClick={() => returnHome()}
          data-testid="research-action-back-home"
        >
          返回起始页
        </button>
        <button
          type="button"
          className="research-center__ghost-btn"
          disabled={actionBusy != null}
          onClick={() => void runAction('export-markdown')}
          data-testid="research-action-export-markdown"
        >
          导出 Markdown
        </button>
        <button
          type="button"
          className="research-center__ghost-btn"
          disabled={actionBusy != null}
          onClick={() => void runAction('export-json')}
          data-testid="research-action-export-json"
        >
          导出 JSON
        </button>
        <button
          type="button"
          className="research-center__ghost-btn"
          disabled={actionBusy != null || !reportReady}
          onClick={() => printResearchReport()}
          data-testid="research-action-export-pdf"
          title={'使用浏览器打印对话框，选择"另存为 PDF"'}
        >
          导出 PDF
        </button>
        {detail.session.status === 'completed' ? (
          <button
            type="button"
            className="research-center__ghost-btn"
            disabled={actionBusy != null}
            onClick={() => {
              setObjectiveValue(`基于「${detail.session.title}」的后续研究：`);
              returnHome();
            }}
            data-testid="research-action-follow-up"
          >
            发起追问
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <div className="research-center research-center--embedded" data-testid="research-center">
      {error ? (
        <div className="research-center__error" data-testid="research-error">
          {error}
        </div>
      ) : null}

      {failedTaskSummary && selectedSession && detail ? (
        <div className="research-center__task-error-summary" data-testid="research-task-error-summary">
          {failedTaskSummary.count} 个任务失败（{failedTaskSummary.kinds.map((k) => k === 'search' ? '检索' : k === 'fetch' ? '抓取' : k === 'summarize' ? '总结' : k === 'reflect' ? '反思' : k).join('、')}）。可在下方任务列表查看详情，或尝试恢复继续。
        </div>
      ) : null}

      {!selectedSession ? (
        <div className="research-center__home">
          <div className="research-center__home-copy">
            <span className="research-center__eyebrow">深度研究</span>
            <h2>像发消息一样开始一项研究</h2>
            <p>先说目标，Taori 先给你计划；你确认后，再进入真正的检索、整理与写作。</p>
            {loading ? <span className="hint">正在同步最近研究记录…</span> : null}
          </div>

          <section className="research-center__composer-card research-center__composer-card--hero">
            <div className="research-center__composer-input-shell">
              <textarea
                value={objective}
                onChange={(e) => setObjectiveValue(e.target.value)}
                rows={4}
                placeholder="例如：分析 2026 年 AI Coding 产品的发展趋势、主要玩家和差异化策略"
                data-testid="research-input-objective"
              />
            </div>
            <div className="research-center__suggestions">
              {RESEARCH_SUGGESTIONS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="research-center__suggestion-chip"
                  onClick={() => setObjectiveValue(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            {renderComposerFooter('生成研究计划')}
            {renderAdvancedOptions()}
          </section>
        </div>
      ) : detailLoading || !detail ? (
        <p className="hint">正在加载研究详情…</p>
      ) : (
        <div className="research-center__conversation" data-status={detail.session.status}>
          <div className="research-center__thread-shell" data-testid="research-thread">
            <article className="research-center__message research-center__message--user" data-testid="research-user-message">
              <span className="research-center__message-label">你的研究请求</span>
              <p>{detail.session.objective}</p>
            </article>

            <article
              className="research-center__message research-center__message--assistant research-center__message--research"
              data-testid="research-plan-preview"
            >
              <div className="research-center__message-head">
                <div>
                  <span className="research-center__message-label">深度研究</span>
                  <h4>{detail.session.title}</h4>
                  <p className="research-center__message-status">{statusHeadline}</p>
                </div>
                <div className="research-center__status-group">
                  <span className="research-center__pill">{STATUS_LABELS[detail.session.status]}</span>
                  <span className="research-center__pill">{STAGE_LABELS[detail.session.stage]}</span>
                  <span className="research-center__pill">{OUTPUT_KIND_LABELS[detail.session.output_kind]}</span>
                  {detail.session.plan || (detail.session.status === 'reviewing' && !isScopingReview) ? (
                    <span
                      className={`research-center__pill research-center__pill--${planOriginInfo.tone}`}
                      data-testid="research-plan-origin-pill"
                    >
                      {planOriginInfo.label}
                    </span>
                  ) : null}
                </div>
              </div>

              {/* AI Planning phase: no plan yet */}
              {detail.session.status === 'reviewing' && !detail.session.plan ? (
                isScopingReview ? (
                  <div className="research-center__plan-review research-center__plan-review--scoping" data-testid="research-plan-scoping">
                    {planConversation.length > 0 ? (
                      <div className="research-center__plan-messages">
                        {planConversation.map((msg, i) => (
                          <div
                            key={i}
                            className={`research-center__plan-msg research-center__plan-msg--${msg.role}`}
                          >
                            <span className="research-center__plan-msg-role">
                              {msg.role === 'user' ? '你' : 'Taori'}
                            </span>
                            <p>{msg.content}</p>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    <div className="research-center__plan-summary-card research-center__plan-summary-card--scoping">
                      <p className="research-center__plan-summary-text">
                        回复后，Taori 会先把这些边界收束成计划，再进入真正的检索、抓取与写作。
                      </p>
                    </div>

                    <div className="research-center__plan-feedback-form">
                      <textarea
                        className="research-center__plan-feedback-input"
                        value={planFeedback}
                        onChange={(e) => setPlanFeedback(e.target.value)}
                        placeholder={'例如：聚焦中国市场，近 12 个月，优先价格、稳定性和 SLA，中英资料都可以。'}
                        rows={3}
                        disabled={planFeedbackBusy}
                        data-testid="research-plan-feedback"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && planFeedback.trim()) {
                            e.preventDefault();
                            void submitPlanFeedback();
                          }
                        }}
                      />
                      <div className="research-center__plan-feedback-actions">
                        <button
                          type="button"
                          className="research-center__primary-btn"
                          disabled={planFeedbackBusy || !planFeedback.trim()}
                          onClick={() => void submitPlanFeedback()}
                          data-testid="research-plan-feedback-submit"
                        >
                          {planFeedbackBusy ? '整理中…' : '补充信息，生成计划'}
                        </button>
                        <small className="research-center__shortcut-hint">⌘ Enter 发送</small>
                      </div>
                    </div>
                  </div>
                ) : (
                  <PlanningWaitIndicator />
                )
              ) : isPlanningFailure ? (
                <div className="research-center__plan-review research-center__plan-review--failed" data-testid="research-plan-failed">
                  {planConversation.length > 0 ? (
                    <div className="research-center__plan-messages">
                      {planConversation.map((msg, i) => (
                        <div
                          key={i}
                          className={`research-center__plan-msg research-center__plan-msg--${msg.role}`}
                        >
                          <span className="research-center__plan-msg-role">
                            {msg.role === 'user' ? '你' : 'Taori'}
                          </span>
                          <p>{msg.content}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <div className="research-center__plan-origin-note research-center__plan-origin-note--warning">
                    <strong>AI 规划失败</strong>
                    <p>{latestPlanAssistantMessage || '系统已重试多次，但研究计划仍未生成成功。'}</p>
                  </div>

                  <div className="research-center__plan-feedback-form">
                    <textarea
                      className="research-center__plan-feedback-input"
                      value={planFeedback}
                      onChange={(e) => setPlanFeedback(e.target.value)}
                      placeholder={'如果想缩小范围或补充限制条件，再试一次。'}
                      rows={2}
                      disabled={planFeedbackBusy}
                      data-testid="research-plan-feedback"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && planFeedback.trim()) {
                          e.preventDefault();
                          void submitPlanFeedback();
                        }
                      }}
                    />
                    <div className="research-center__plan-feedback-actions">
                      <button
                        type="button"
                        className="research-center__ghost-btn"
                        disabled={planFeedbackBusy || !planFeedback.trim()}
                        onClick={() => void submitPlanFeedback()}
                        data-testid="research-plan-feedback-submit"
                      >
                        {planFeedbackBusy ? '重试中…' : '补充条件后重试'}
                      </button>
                      <small className="research-center__shortcut-hint">⌘ Enter 发送</small>
                    </div>
                  </div>
                </div>
              ) : detail.session.status === 'reviewing' && detail.session.plan ? (
                /* AI Planning phase: plan ready for review */
                <div className="research-center__plan-review" data-testid="research-plan-review">
                  {/* Plan conversation history */}
                  {planConversation.length > 0 ? (
                    <div className="research-center__plan-messages">
                      {planConversation.map((msg, i) => (
                        <div
                          key={i}
                          className={`research-center__plan-msg research-center__plan-msg--${msg.role}`}
                        >
                          <span className="research-center__plan-msg-role">
                            {msg.role === 'user' ? '你' : 'Taori'}
                          </span>
                          <p>{msg.content}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {/* Plan summary */}
                  {detail.session.plan_origin === 'fallback' ? (
                    <div
                      className="research-center__plan-origin-note research-center__plan-origin-note--warning"
                      data-testid="research-plan-origin-note"
                    >
                      <strong>检测到历史兜底计划</strong>
                      <p>{planOriginInfo.description}</p>
                    </div>
                  ) : null}
                  <div className="research-center__plan-summary-card">
                    <p className="research-center__plan-summary-text">{detail.session.plan.summary}</p>
                  </div>

                  {/* Key questions — show wide→narrow scope chips when present */}
                  <div className="research-center__plan-questions">
                    <strong className="research-center__plan-section-label">关键研究问题</strong>
                    <ol data-testid="research-plan-questions">
                      {detail.session.plan.key_questions.map((q, i) => {
                        const scopeChip = planScopeChip(q.scope);
                        return (
                          <li key={q.id} className="research-center__plan-question">
                            <span className="research-center__plan-q-num">{i + 1}</span>
                            <div>
                              <p className="research-center__plan-q-text">
                                {scopeChip ? (
                                  <span
                                    className={`research-center__plan-q-scope research-center__plan-q-scope--${scopeChip.cls}`}
                                    title={scopeChip.title}
                                    data-testid="research-plan-question-scope"
                                  >
                                    {scopeChip.label}
                                  </span>
                                ) : null}
                                {q.question}
                              </p>
                              <small className="research-center__plan-q-reason">{q.reason}</small>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </div>

                  {/* Expected outline — report section preview (optional, new field) */}
                  {detail.session.plan.expected_outline && detail.session.plan.expected_outline.length > 0 ? (
                    <div className="research-center__plan-outline" data-testid="research-plan-outline">
                      <strong className="research-center__plan-section-label">预估章节大纲</strong>
                      <ol>
                        {detail.session.plan.expected_outline.map((heading, i) => (
                          <li key={`${i}-${heading}`}>{heading}</li>
                        ))}
                      </ol>
                    </div>
                  ) : null}

                  {/* Search strategy — one-paragraph narrative (optional, new field) */}
                  {detail.session.plan.search_strategy ? (
                    <div className="research-center__plan-strategy" data-testid="research-plan-strategy">
                      <strong className="research-center__plan-section-label">检索策略</strong>
                      <p>{detail.session.plan.search_strategy}</p>
                    </div>
                  ) : null}

                  {/* Stop conditions */}
                  {detail.session.plan.stop_conditions.length > 0 ? (
                    <div className="research-center__plan-stops">
                      <strong className="research-center__plan-section-label">停止条件</strong>
                      <ul>
                        {detail.session.plan.stop_conditions.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {/* Feedback form */}
                  <div className="research-center__plan-feedback-form">
                    <textarea
                      className="research-center__plan-feedback-input"
                      value={planFeedback}
                      onChange={(e) => setPlanFeedback(e.target.value)}
                      placeholder={'对计划有调整意见？告诉 Taori 你的想法，比如"多聚焦在国内市场"或"加入竞品对比"…'}
                      rows={2}
                      disabled={planFeedbackBusy}
                      data-testid="research-plan-feedback"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && planFeedback.trim()) {
                          e.preventDefault();
                          void submitPlanFeedback();
                        }
                      }}
                    />
                    <div className="research-center__plan-feedback-actions">
                      <button
                        type="button"
                        className="research-center__ghost-btn"
                        disabled={planFeedbackBusy || !planFeedback.trim()}
                        onClick={() => void submitPlanFeedback()}
                        data-testid="research-plan-feedback-submit"
                      >
                        {planFeedbackBusy ? '调整中…' : '调整计划'}
                      </button>
                      <small className="research-center__shortcut-hint">⌘ Enter 发送</small>
                      <button
                        type="button"
                        className="research-center__primary-btn"
                        disabled={actionBusy != null || planFeedbackBusy}
                        onClick={() => void runAction('confirm')}
                        data-testid="research-action-confirm"
                      >
                        {actionBusy === 'confirm' ? '启动中…' : '✓ 计划确认，开始执行'}
                      </button>
                    </div>
                  </div>

                  {/* Cancel */}
                  <div className="research-center__plan-cancel-row">
                    <button
                      type="button"
                      className="research-center__danger-btn"
                      disabled={actionBusy != null}
                      onClick={() => void runAction('cancel')}
                      data-testid="research-action-cancel"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                /* Running / completed / other statuses */
                <>
                  <p className="research-center__research-summary">
                    {researchSummary}
                  </p>

                  {taskStats.total > 0 ? (
                    <div className="research-center__progress" aria-label="任务进度">
                      <div className="research-center__progress-bar">
                        <div
                          className="research-center__progress-fill"
                          style={{ width: `${progressPercent}%` }}
                          data-testid="research-progress-fill"
                        />
                      </div>
                      <span className="research-center__progress-label">{progressPercent}%</span>
                    </div>
                  ) : null}

                  <div className="research-center__stage-rail" data-testid="research-stage-rail">
                    {stageRailItems.map((item) => (
                      <div
                        key={item.stage}
                        className={`research-center__stage-step research-center__stage-step--${item.state}`}
                        title={item.description}
                      >
                        <span aria-hidden />
                        <strong>{item.label}</strong>
                      </div>
                    ))}
                  </div>

                  <div className="research-center__insight-grid" data-testid="research-insight-grid">
                    {researchInsights.map((item) => (
                      <div
                        key={item.label}
                        className={`research-center__insight-card research-center__insight-card--${item.tone}`}
                      >
                        <small>{item.label}</small>
                        <strong>{item.value}</strong>
                        <span>{item.detail}</span>
                      </div>
                    ))}
                  </div>

                  <NarrativeTimeline tasks={detail.tasks} sessionStatus={detail.session.status} />

                  <details className="research-center__task-details" open={detail.session.status === 'running' || detail.session.status === 'paused'}>
                    <summary>
                      <span>执行步骤</span>
                      <small>{taskStats.completed}/{taskStats.total || checklistItems.length} 完成</small>
                    </summary>
                    <ol className="research-center__checklist" data-testid="research-task-list">
                      {checklistItems.map((item) => (
                        <li
                          key={item.id}
                          className={`research-center__checklist-item research-center__checklist-item--${item.status}`}
                          data-testid={`research-task-row-${item.id}`}
                        >
                          <span className="research-center__checklist-dot" aria-hidden />
                          <div className="research-center__checklist-copy">
                            <strong>{item.title}</strong>
                            <span>{item.subtitle}</span>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </details>

                  <div className="research-center__message-metrics">
                    {summaryMetrics.map((item) => (
                      <span key={item.label}>
                        <small>{item.label}</small>
                        <strong>{item.value}</strong>
                      </span>
                    ))}
                  </div>

                  {constraintSummary.length > 0 ? (
                    <div className="research-center__constraint-row">
                      {constraintSummary.map((item) => (
                        <span key={item} className="research-center__constraint-chip">
                          {item}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {budgetStatus ? (
                    <div
                      className={`research-center__budget-alert research-center__budget-alert--${budgetStatus.tone}`}
                      data-testid="research-budget-status"
                    >
                      {budgetStatus.percent > 0 ? <strong>预算使用 {budgetStatus.percent}%</strong> : null}
                      <span>{budgetStatus.copy}</span>
                    </div>
                  ) : null}

                  {renderSessionActions()}
                </>
              )}
            </article>

            {showReportCard ? (
              <article
                className="research-center__message research-center__message--assistant research-center__message--report"
                data-testid="research-reading-pane"
              >
                <div className="research-center__message-head">
                  <div>
                    <span className="research-center__message-label">研究稿</span>
                    <h4>{detail.session.status === 'completed' ? '最终结果' : '持续生成中的草稿'}</h4>
                  </div>
                  <span className="research-center__pill">{formatAgo(detail.session.updated_at)}</span>
                </div>
                {reportOverview ? (
                  <section
                    className={`research-center__report-overview research-center__report-overview--${reportOverview.readiness.tone}`}
                    data-testid="research-report-overview"
                  >
                    <div className="research-center__report-readiness">
                      <span>可采纳度</span>
                      <strong>{reportOverview.readiness.label}</strong>
                      <p>{reportOverview.readiness.detail}</p>
                    </div>
                    <div className="research-center__report-overview-grid">
                      {reportOverview.cards.map((card) => (
                        <div key={card.label} className="research-center__report-overview-card">
                          <small>{card.label}</small>
                          <strong>{card.value}</strong>
                          <span>{card.detail}</span>
                        </div>
                      ))}
                    </div>
                    {reportOverview.risks.length > 0 ? (
                      <div className="research-center__report-overview-list">
                        <span>仍需注意</span>
                        <ul>
                          {reportOverview.risks.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {reportOverview.nextSteps.length > 0 ? (
                      <div className="research-center__report-overview-list">
                        <span>建议下一步</span>
                        <ul>
                          {reportOverview.nextSteps.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </section>
                ) : null}
                <div
                  className="research-center__markdown-wrapper"
                  ref={reportContainerRef}
                  onMouseOver={reportReady ? handleReportMouseOver : undefined}
                  onMouseLeave={reportReady ? handleReportMouseLeave : undefined}
                >
                  <div
                    className="research-center__markdown prose"
                    data-testid="research-draft"
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(reportContent) }}
                  />
                  {reportReady && floatingFollowup ? (
                    <button
                      type="button"
                      className="research-center__paragraph-followup-btn"
                      style={{ top: floatingFollowup.top }}
                      onClick={(e) => {
                        e.stopPropagation();
                        openFollowupModal(floatingFollowup.text);
                      }}
                      data-testid="research-paragraph-followup"
                      title="基于此段落发起追问"
                    >
                      🔍 追问
                    </button>
                  ) : null}
                </div>
                <CitationVerificationPanel
                  claims={detail.claims}
                  sources={detail.sources}
                  sessionStatus={detail.session.status}
                />
              </article>
            ) : null}

            {showEvidencePanel ? (
              <details
                className="research-center__message research-center__message--assistant research-center__evidence-panel"
                data-testid="research-evidence-panel"
                open={detail.session.status !== 'reviewing'}
              >
                <summary className="research-center__details-summary">
                  <span>
                    <strong>研究线索</strong>
                    <small>{evidenceSummary}</small>
                  </span>
                  <span className="research-center__pill">展开查看</span>
                </summary>

                <div className="research-center__glance-grid">
                  {visibleSources.length > 0 || sourceFilter ? (
                    <section className="research-center__glance-card">
                      <div className="research-center__glance-head">
                        <strong>来源</strong>
                        <span>{detail.sources.length} 条{visibleSources.length !== detail.sources.length ? `（筛选 ${visibleSources.length}）` : ''}</span>
                      </div>
                      {detail.sources.length > 5 ? (
                        <input
                          type="search"
                          className="research-center__source-filter"
                          placeholder="搜索来源标题或域名…"
                          value={sourceFilter}
                          onChange={(e) => setSourceFilter(e.target.value)}
                          data-testid="research-source-filter"
                        />
                      ) : null}
                      <ul className="research-center__source-list" data-testid="research-source-list">
                        {visibleSources.map((source) => {
                          const score = source.credibility_score ?? 0.5;
                          const kind = sourceKindMeta(sourceKindValue(source));
                          const credTag = score >= 0.85 ? { label: '高可信', cls: 'high' }
                            : score >= 0.7 ? { label: '可信', cls: 'med' }
                            : null;
                          return (
                          <li key={source.id} className="research-center__source-item">
                            <a
                              href={source.locator}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="research-center__source-title"
                            >
                              {(source.title ?? source.locator).slice(0, 80)}
                            </a>
                            <div className="research-center__source-meta">
                              <span>{safeHostname(source.locator)}</span>
                              <span className={`research-center__kind-badge research-center__kind-badge--${kind.cls}`}>
                                {kind.label}
                              </span>
                              {credTag ? (
                                <span className={`research-center__cred-badge research-center__cred-badge--${credTag.cls}`}>
                                  {credTag.label}
                                </span>
                              ) : null}
                            </div>
                          </li>
                          );
                        })}
                      </ul>
                    </section>
                  ) : detail.session.plan ? (
                    <section className="research-center__glance-card">
                      <div className="research-center__glance-head">
                        <strong>研究方向</strong>
                        <span>{detail.session.plan.stop_conditions.length}</span>
                      </div>
                      <ul className="research-center__risk-list" data-testid="research-risk-list">
                        {detail.session.plan.stop_conditions.map((item) => (
                          <li key={item}>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {coverageItems.length > 0 ? (
                    <section className="research-center__glance-card">
                      <div className="research-center__glance-head">
                        <strong>覆盖度</strong>
                        <span>{coverageItems.filter((item) => item.level === 'good').length}/{coverageItems.length} 已充分</span>
                      </div>
                      <ul className="research-center__coverage-list" data-testid="research-coverage-list">
                        {coverageItems.map((item) => {
                          const badge = coverageBadgeMeta(item.level);
                          return (
                            <li key={item.id} className="research-center__coverage-item">
                              <div className="research-center__coverage-head">
                                <strong>{item.reason}</strong>
                                <span className={`research-center__coverage-badge research-center__coverage-badge--${badge.cls}`}>
                                  {badge.label}{item.isEstimated ? '（估算）' : ''}
                                </span>
                              </div>
                              <p className="research-center__coverage-question">{item.question}</p>
                              <div className="research-center__coverage-meta">
                                <span>{item.sources} 条来源</span>
                                <span>{item.hosts} 个站点</span>
                              </div>
                              <p className="research-center__coverage-copy">{item.whatWeKnow}</p>
                              <p className="research-center__coverage-missing">{item.whatIsMissing}</p>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ) : null}

                  {(sourceMix.length > 0 || claimSummary.length > 0 || nextStepItems.length > 0) ? (
                    <section className="research-center__glance-card">
                      <div className="research-center__glance-head">
                        <strong>研究判断</strong>
                        <span>{detail.claims.length} 条主张</span>
                      </div>
                      {sourceMix.length > 0 ? (
                        <div className="research-center__summary-block">
                          <span className="research-center__summary-label">来源结构</span>
                          <div className="research-center__mini-tags" data-testid="research-source-mix">
                            {sourceMix.map((item) => (
                              <span key={item.kind} className={`research-center__kind-badge research-center__kind-badge--${item.cls}`}>
                                {item.label} {item.count}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {claimSummary.length > 0 ? (
                        <div className="research-center__summary-block">
                          <span className="research-center__summary-label">主张状态</span>
                          <div className="research-center__mini-tags">
                            {claimSummary.map((item) => (
                              <span key={item.status} className={`research-center__claim-badge research-center__claim-badge--${item.cls}`}>
                                {item.label} {item.count}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {nextStepItems.length > 0 ? (
                        <div className="research-center__summary-block">
                          <span className="research-center__summary-label">建议下一步</span>
                          <ul className="research-center__risk-list" data-testid="research-next-steps">
                            {nextStepItems.map((item) => (
                              <li key={item}>
                                <span>{item}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </section>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>

        </div>
      )}
      {followupModal ? (
        <div
          className="research-center__followup-modal-backdrop"
          data-testid="research-followup-modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeFollowupModal();
          }}
        >
          <div className="research-center__followup-modal" role="dialog" aria-modal="true">
            <header>
              <strong>基于这段内容追问</strong>
              <button
                type="button"
                className="research-center__followup-modal-close"
                onClick={closeFollowupModal}
                aria-label="关闭"
              >
                ×
              </button>
            </header>
            <blockquote className="research-center__followup-excerpt">
              {followupModal.excerpt.length > 280
                ? `${followupModal.excerpt.slice(0, 280)}…`
                : followupModal.excerpt}
            </blockquote>
            <textarea
              className="research-center__followup-input"
              placeholder={'你想就这段进一步追问什么？例如"展开 GPT-5 在 SWE-bench 上的具体得分细节" 或 "对比一下 Claude 4.7 的官方数据"…'}
              value={followupInput}
              onChange={(e) => setFollowupInput(e.target.value)}
              rows={3}
              autoFocus
              disabled={followupBusy}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && followupInput.trim()) {
                  e.preventDefault();
                  void submitFollowup();
                }
              }}
              data-testid="research-followup-input"
            />
            <div className="research-center__followup-actions">
              <small>子研究会复用当前研究的输出形式、深度与约束。Cmd/Ctrl+Enter 快速提交。</small>
              <div>
                <button
                  type="button"
                  className="research-center__ghost-btn"
                  onClick={closeFollowupModal}
                  disabled={followupBusy}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="research-center__primary-btn"
                  disabled={followupBusy || !followupInput.trim()}
                  onClick={() => void submitFollowup()}
                  data-testid="research-followup-submit"
                >
                  {followupBusy ? '创建中…' : '发起追问'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
