import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Model,
  ResearchBudgetMode,
  ResearchOutputKind,
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

function taskDetail(task: ResearchTask): string {
  if (task.status === 'failed') {
    if (task.kind === 'search') {
      const message = String(task.error?.message ?? '执行失败');
      if (message.includes('DuckDuckGo blocked the automated search')) {
        return 'DuckDuckGo 触发反爬限制，当前搜索源未返回可用结果。系统建议改用 Exa / 搏查，或稍后重试。';
      }
      if (message.includes('returned no usable results')) {
        return '当前检索没有拿到可用结果，可缩小范围、补充限定条件，或切换搜索源后重试。';
      }
      if (message.includes('搏查搜索缺少 API Key')) {
        return '搏查搜索缺少 API Key，请先在工具设置里补齐。';
      }
    }
    return String(task.error?.message ?? '执行失败');
  }
  if (task.kind === 'search') {
    const query =
      typeof task.input?.query === 'string'
        ? task.input.query
        : typeof task.input?.question === 'string'
          ? task.input.question
          : '';
    const engine =
      typeof task.output?.search_engine === 'string'
        ? searchEngineLabel(task.output.search_engine)
        : null;
    const fallback =
      typeof task.output?.search_fallback_from === 'string'
        ? searchEngineLabel(task.output.search_fallback_from)
        : null;
    const hits = typeof task.output?.hits === 'number' ? `命中 ${task.output.hits} 条` : null;
    const queryText = query ? compactTaskQuery(query) : null;
    return [
      engine ? (fallback ? `${engine}（从 ${fallback} 回退）` : engine) : null,
      hits,
      queryText,
    ].filter(Boolean).join(' · ');
  }
  if (task.kind === 'summarize') {
    return '已基于当前证据整理结构化草稿。';
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

  const isControlled = controlledSelectedId !== undefined;
  const selectedId = isControlled ? controlledSelectedId : internalSelectedId;

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
        const nextSelected =
          preferId ??
          (selectedId && res.research_sessions.some((item) => item.id === selectedId)
            ? selectedId
            : null) ??
          (isControlled ? null : (res.research_sessions[0]?.id ?? null));
        setSelectedId(nextSelected);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [isControlled, selectedId, setSelectedId],
  );

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setError(null);
    try {
      const res = await api.getResearchSessionDetail(id);
      setDetail(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
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
    if (detail?.session.status !== 'running') return;
    const handle = window.setInterval(() => {
      void loadDetail(selectedId);
    }, 2_000);
    return () => window.clearInterval(handle);
  }, [detail?.session.status, loadDetail, selectedId]);

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
    }),
    [budgetLimitUsd, budgetMode, language, minCitations, mustCover, objective, outputKind, preferredModelId, preferredSearchTool, region, timeRange],
  );

  const handleQuickStart = useCallback(async () => {
    if (startDisabled) return;
    setActionBusy('quick-start');
    setError(null);
    try {
      const created = await api.createResearchSession(createSessionInput());
      const prepared = await api.startResearchSession(created.id, { confirm: false });
      resetComposer();
      await refreshCurrent(prepared);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  }, [createSessionInput, refreshCurrent, resetComposer, startDisabled]);

  const runAction = useCallback(
    async (
      action:
        | 'prepare'
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
        if (action === 'prepare') {
          await refreshCurrent(await api.startResearchSession(selectedId, { confirm: false }));
        } else if (action === 'confirm') {
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
    if (detail.session.status === 'reviewing') return '计划已生成，等待你确认';
    if (detail.session.status === 'running') return `正在执行 · ${STAGE_LABELS[detail.session.stage]}`;
    if (detail.session.status === 'completed') return '研究已完成，可以直接阅读结果';
    if (detail.session.status === 'draft') return '先生成研究计划';
    return `${STATUS_LABELS[detail.session.status]} · ${STAGE_LABELS[detail.session.stage]}`;
  }, [detail]);

  const statusCopy = useMemo(() => {
    if (!detail) return '';
    if (detail.session.status === 'reviewing') {
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
  }, [detail, latestTask, taskStats.completed, taskStats.total]);
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
        label: '来源',
        value: String(detail.sources.length),
      },
      {
        label: '主张',
        value: String(detail.claims.length),
      },
    ];
  }, [detail]);

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

  const visibleSources = detail?.sources.slice(0, 4) ?? [];
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

  const renderComposerFooter = (buttonLabel: string) => (
    <div className="research-center__composer-footer">
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
        {detail.session.status === 'draft' ? (
          <button
            type="button"
            className="research-center__primary-btn"
            disabled={actionBusy != null}
            onClick={() => void runAction('prepare')}
            data-testid="research-action-prepare"
          >
            {actionBusy === 'prepare' ? '生成中…' : '生成计划'}
          </button>
        ) : null}
        {detail.session.status === 'reviewing' ? (
          <>
            <button
              type="button"
              className="research-center__ghost-btn"
              disabled={actionBusy != null}
              onClick={() => void runAction('prepare')}
            >
              更新计划
            </button>
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
            恢复
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
                </div>
              </div>

              <p className="research-center__research-summary">
                {researchSummary}
              </p>

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

              {renderSessionActions()}
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
                <div
                  className="research-center__markdown prose"
                  data-testid="research-draft"
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(reportContent) }}
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
                  {visibleSources.length > 0 ? (
                    <section className="research-center__glance-card">
                      <div className="research-center__glance-head">
                        <strong>来源</strong>
                        <span>{detail.sources.length}</span>
                      </div>
                      <ul className="research-center__source-list" data-testid="research-source-list">
                        {visibleSources.map((source) => (
                          <li key={source.id} className="research-center__source-item">
                            <a
                              href={source.locator}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="research-center__source-title"
                            >
                              {source.title ?? source.locator}
                            </a>
                            {source.snippet ? (
                              <p className="research-center__source-snippet">
                                {source.snippet.slice(0, 160)}
                              </p>
                            ) : null}
                            <div className="research-center__source-meta">
                              <span>{safeHostname(source.locator)}</span>
                            </div>
                          </li>
                        ))}
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
                </div>
              </details>
            ) : null}
          </div>

          <section className="research-center__composer-dock research-center__composer-dock--floating" data-testid="research-followup-dock">
            <div className="research-center__composer-quote">
              <span>继续基于“{detail.session.title}”展开</span>
              <button type="button" onClick={() => setSelectedId(null)}>
                返回起始页
              </button>
            </div>
            <div className="research-center__composer-input-shell">
              <textarea
                value={objective}
                onChange={(e) => setObjectiveValue(e.target.value)}
                rows={3}
                placeholder="继续追问，Taori 会基于当前结果生成一份新的研究计划…"
                data-testid="research-input-objective"
              />
            </div>
            {renderComposerFooter('生成新计划')}
            {renderAdvancedOptions()}
          </section>
        </div>
      )}
    </div>
  );
}
