import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ResearchBudgetMode,
  ResearchOutputKind,
  ResearchSession,
  ResearchSessionDetail,
  ResearchStatus,
  ResearchStage,
} from '@taori/shared';
import { api } from './api.js';
import { EmptyState } from './EmptyState.js';

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

function formatAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
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

export function ResearchCenter(): JSX.Element {
  const [sessions, setSessions] = useState<ResearchSession[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ResearchSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [outputKind, setOutputKind] = useState<ResearchOutputKind>('report');
  const [budgetMode, setBudgetMode] = useState<ResearchBudgetMode>('balanced');
  const [budgetLimitUsd, setBudgetLimitUsd] = useState('');
  const [timeRange, setTimeRange] = useState('');
  const [region, setRegion] = useState('');
  const [language, setLanguage] = useState('');
  const [mustCover, setMustCover] = useState('');
  const [minCitations, setMinCitations] = useState('');

  const loadSessions = useCallback(async (preferId?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listResearchSessions();
      setSessions(res.research_sessions);
      const nextSelected = preferId
        ?? (selectedId && res.research_sessions.some((item) => item.id === selectedId) ? selectedId : null)
        ?? res.research_sessions[0]?.id
        ?? null;
      setSelectedId(nextSelected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

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
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  // While the selected session is actively running, poll the detail every
  // 2s so newly-recorded sources, claims, and task transitions surface in
  // near-real-time. Stops automatically once the session leaves `running`.
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

  const createDisabled = title.trim().length === 0 || objective.trim().length === 0 || actionBusy === 'create';

  const refreshCurrent = useCallback(async (next: ResearchSessionDetail) => {
    setDetail(next);
    await loadSessions(next.session.id);
  }, [loadSessions]);

  const handleCreate = useCallback(async () => {
    if (createDisabled) return;
    setActionBusy('create');
    setError(null);
    try {
      const created = await api.createResearchSession({
        title: title.trim(),
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
      });
      setTitle('');
      setObjective('');
      setBudgetLimitUsd('');
      setTimeRange('');
      setRegion('');
      setLanguage('');
      setMustCover('');
      setMinCitations('');
      await loadSessions(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  }, [
    budgetLimitUsd,
    budgetMode,
    createDisabled,
    language,
    loadSessions,
    minCitations,
    mustCover,
    objective,
    outputKind,
    region,
    timeRange,
    title,
  ]);

  const runAction = useCallback(async (
    action: 'preview' | 'confirm' | 'pause' | 'resume' | 'cancel' | 'export-json' | 'export-markdown',
  ) => {
    if (!selectedId) return;
    setActionBusy(action);
    setError(null);
    try {
      if (action === 'preview') {
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
  }, [refreshCurrent, selectedId]);

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

  return (
    <div className="research-center" data-testid="research-center">
      <div className="research-center__layout">
        <aside className="research-center__sidebar">
          <section className="research-center__card">
            <div className="research-center__card-head">
              <div>
                <h3>新建研究任务</h3>
                <p className="hint">填写主题与目标，预览计划后即可启动自动检索。</p>
              </div>
            </div>
            <div className="research-center__form">
                <label>
                  <span>标题</span>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="如：2026 AI Coding 产品格局"
                    data-testid="research-input-title"
                  />
                </label>
                <label>
                  <span>研究目标</span>
                  <textarea
                    value={objective}
                    onChange={(e) => setObjective(e.target.value)}
                    rows={3}
                    placeholder="说明要解决的问题、期望产出和判断标准。"
                    data-testid="research-input-objective"
                  />
                </label>
                <div className="research-center__form-grid">
                  <label>
                    <span>产出</span>
                    <select
                      value={outputKind}
                      onChange={(e) => setOutputKind(e.target.value as ResearchOutputKind)}
                      data-testid="research-input-output-kind"
                    >
                      {Object.entries(OUTPUT_KIND_LABELS).map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>预算模式</span>
                    <select
                      value={budgetMode}
                      onChange={(e) => setBudgetMode(e.target.value as ResearchBudgetMode)}
                      data-testid="research-input-budget-mode"
                    >
                      {Object.entries(BUDGET_MODE_LABELS).map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </select>
                  </label>
              </div>
                <details className="research-center__advanced-opts">
                <summary>高级选项</summary>
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
              <button
                type="button"
                className="research-center__primary-btn"
                disabled={createDisabled}
                onClick={() => void handleCreate()}
                data-testid="research-create"
              >
                {actionBusy === 'create' ? '创建中…' : '创建研究任务'}
              </button>
            </div>
          </section>

          <section className="research-center__card">
            <div className="research-center__card-head">
              <div>
                <h3>研究队列</h3>
                <p className="hint">最近任务按更新时间排序。</p>
              </div>
              <button type="button" className="research-center__ghost-btn" onClick={() => void loadSessions(selectedId)}>
                刷新
              </button>
            </div>
            {loading ? (
              <p className="hint">正在加载研究任务…</p>
            ) : sessions && sessions.length > 0 ? (
              <div className="research-center__session-list" data-testid="research-session-list">
                {sessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className={`research-center__session-row ${session.id === selectedId ? 'active' : ''}`}
                    data-status={session.status}
                    onClick={() => setSelectedId(session.id)}
                    data-testid={`research-session-row-${session.id}`}
                  >
                    <strong>{session.title}</strong>
                    <span>{STATUS_LABELS[session.status]} · {STAGE_LABELS[session.stage]}</span>
                    <small>{OUTPUT_KIND_LABELS[session.output_kind]} · {formatAgo(session.updated_at)}</small>
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState
                title="还没有深度研究任务"
                hint="先创建一个研究主题，再生成计划预览。"
                icon="🔎"
                compact
                tone="muted"
              />
            )}
          </section>
        </aside>

        <section className="research-center__detail">
          {error ? (
            <div className="research-center__error" data-testid="research-error">{error}</div>
          ) : null}
          {!selectedSession ? (
            <EmptyState
              title="选择一个研究任务"
              hint="左侧创建后即可查看计划、待办和导出结果。"
              icon="🧠"
              tone="muted"
            />
          ) : detailLoading || !detail ? (
            <p className="hint">正在加载任务详情…</p>
          ) : (
            <div className="research-center__detail-stack">
              <section className="research-center__card">
                <div className="research-center__card-head">
                  <div>
                    <h3>{detail.session.title}</h3>
                    <p className="hint">{detail.session.objective}</p>
                  </div>
                  <div className="research-center__status-group">
                    <span className="research-center__pill">{STATUS_LABELS[detail.session.status]}</span>
                    <span className="research-center__pill">{STAGE_LABELS[detail.session.stage]}</span>
                    <span className="research-center__pill">{OUTPUT_KIND_LABELS[detail.session.output_kind]}</span>
                  </div>
                </div>
                <div className="research-center__meta-grid">
                  <span><small>预算</small><strong>{BUDGET_MODE_LABELS[detail.session.budget_mode]}{detail.session.budget_limit_usd != null ? ` / ${detail.session.budget_limit_usd} USD` : ''}</strong></span>
                  <span><small>已花费</small><strong>{detail.session.budget_spent_usd.toFixed(3)} USD</strong></span>
                  <span><small>任务</small><strong>{taskStats.completed}/{taskStats.total} 已完成</strong></span>
                  <span><small>引用目标</small><strong>{detail.session.constraints.min_citations ?? '未设'}</strong></span>
                </div>
                <div className="research-center__action-row">
                  <button
                    type="button"
                    className="research-center__primary-btn"
                    disabled={actionBusy != null}
                    onClick={() => void runAction('preview')}
                    data-testid="research-action-preview"
                  >
                    {actionBusy === 'preview' ? '生成中…' : '生成计划预览'}
                  </button>
                  <button
                    type="button"
                    className="research-center__confirm-btn"
                    disabled={
                      actionBusy != null ||
                      !detail.session.plan ||
                      (detail.session.status !== 'draft' && detail.session.status !== 'reviewing')
                    }
                    onClick={() => void runAction('confirm')}
                    data-testid="research-action-confirm"
                  >
                    {actionBusy === 'confirm' ? '启动中…' : '确认开始'}
                  </button>
                  <button
                    type="button"
                    className="research-center__ghost-btn"
                    disabled={actionBusy != null || detail.session.status !== 'running'}
                    onClick={() => void runAction('pause')}
                    data-testid="research-action-pause"
                  >
                    暂停
                  </button>
                  <button
                    type="button"
                    className="research-center__ghost-btn"
                    disabled={actionBusy != null || (detail.session.status !== 'paused' && detail.session.status !== 'reviewing')}
                    onClick={() => void runAction('resume')}
                    data-testid="research-action-resume"
                  >
                    恢复
                  </button>
                  <button
                    type="button"
                    className="research-center__danger-btn"
                    disabled={actionBusy != null || detail.session.status === 'cancelled'}
                    onClick={() => void runAction('cancel')}
                    data-testid="research-action-cancel"
                  >
                    取消
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
                </div>
              </section>

              <div className="research-center__detail-grid">
                <section className="research-center__card">
                  <div className="research-center__card-head">
                    <div>
                      <h3>研究计划</h3>
                      <p className="hint">先确定问题、阶段和停止条件，再继续接自动执行引擎。</p>
                    </div>
                  </div>
                  {detail.session.plan ? (
                    <div className="research-center__plan" data-testid="research-plan">
                      <p>{detail.session.plan.summary}</p>
                      <div>
                        <h4>关键问题</h4>
                        <ul>
                          {detail.session.plan.key_questions.map((item) => (
                            <li key={item.id}><strong>{item.reason}</strong>：{item.question}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <h4>阶段</h4>
                        <ol>
                          {detail.session.plan.stages.map((item) => (
                            <li key={item.id}><strong>{item.title}</strong>：{item.objective}（产物：{item.deliverable}）</li>
                          ))}
                        </ol>
                      </div>
                      <div>
                        <h4>停止条件</h4>
                        <ul>
                          {detail.session.plan.stop_conditions.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ) : (
                    <p className="hint" data-testid="research-plan-empty">还没有计划预览，先点“生成计划预览”。</p>
                  )}
                </section>

                <section className="research-center__card">
                  <div className="research-center__card-head">
                    <div>
                      <h3>执行面板</h3>
                      <p className="hint">
                        {detail.session.status === 'running'
                          ? `自动检索进行中（每 2 秒刷新一次）— 已完成 ${taskStats.completed}/${taskStats.total} 个任务`
                          : detail.session.status === 'completed'
                          ? `已完成全部 ${taskStats.total} 个任务`
                          : `任务清单 ${taskStats.completed}/${taskStats.total} 已完成`}
                      </p>
                    </div>
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
                  </div>
                  {detail.tasks.length > 0 ? (
                    <div className="research-center__task-list" data-testid="research-task-list">
                      {detail.tasks.map((task) => (
                        <div
                          key={task.id}
                          className={`research-center__task-row research-center__task-row--${task.status}`}
                          data-testid={`research-task-row-${task.id}`}
                        >
                          <strong>{task.title}</strong>
                          <span className={`research-center__task-status research-center__task-status--${task.status}`}>
                            {task.status === 'queued' ? '排队中' :
                             task.status === 'running' ? '⏳ 进行中' :
                             task.status === 'completed' ? '✓ 完成' :
                             task.status === 'failed' ? '✗ 失败' :
                             task.status === 'skipped' ? '已跳过' : task.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="hint">确认开始后会生成研究任务清单。</p>
                  )}
                  <div className="research-center__subsection">
                    <h4>来源 <span className="research-center__count">{detail.sources.length}</span></h4>
                    {detail.sources.length > 0 ? (
                      <ul className="research-center__source-list" data-testid="research-source-list">
                        {detail.sources.map((source) => (
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
                              <p className="research-center__source-snippet">{source.snippet.slice(0, 200)}</p>
                            ) : null}
                            <div className="research-center__source-meta">
                              <span>{new URL(source.locator).hostname}</span>
                              {source.credibility_score != null ? (
                                <span>可信度 {Math.round(source.credibility_score * 100)}%</span>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : detail.session.status === 'running' ? (
                      <p className="hint">正在检索证据，稍候即可看到来源…</p>
                    ) : (
                      <p className="hint">确认开始后，自动检索会在这里写入证据。</p>
                    )}
                  </div>
                  <div className="research-center__subsection">
                    <h4>主张 <span className="research-center__count">{detail.claims.length}</span></h4>
                    {detail.claims.length > 0 ? (
                      <ul className="research-center__claim-list" data-testid="research-claim-list">
                        {detail.claims.map((claim) => (
                          <li key={claim.id} className={`research-center__claim-item research-center__claim-item--${claim.support_status}`}>
                            <div className="research-center__claim-head">
                              <strong>{claim.section_key}</strong>
                              <span className={`research-center__claim-badge research-center__claim-badge--${claim.support_status}`}>
                                {claim.support_status === 'supported' ? '✓ 有据' :
                                 claim.support_status === 'weak' ? '△ 弱支持' :
                                 claim.support_status === 'conflicted' ? '⚠ 冲突' : '? 待核实'}
                              </span>
                            </div>
                            <p className="research-center__claim-text">{claim.claim_text}</p>
                            {claim.citations.length > 0 ? (
                              <div className="research-center__claim-cites">
                                引用 {claim.citations.length} 条
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : detail.session.status === 'running' ? (
                      <p className="hint">引用校验会在搜索完成后跑出主张…</p>
                    ) : (
                      <p className="hint">执行完成后，这里会列出每个章节的核心主张与可信度。</p>
                    )}
                  </div>
                </section>
              </div>

              <section className="research-center__card">
                <div className="research-center__card-head">
                  <div>
                    <h3>当前草稿</h3>
                    <p className="hint">确认开始后会生成一个可继续补充的研究骨架。</p>
                  </div>
                </div>
                <pre className="research-center__markdown" data-testid="research-draft">
                  {detail.session.final_markdown ?? detail.session.draft_markdown ?? '（尚未生成草稿）'}
                </pre>
              </section>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
