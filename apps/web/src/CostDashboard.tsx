import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatUsd } from '@taori/shared';
import { api } from './api.js';

type CostScope = 'today' | 'week' | 'month';
type CostGroupBy = 'model' | 'conversation' | 'feature';

interface CostDashboardProps {
  onClose: () => void;
  embedded?: boolean;
  focusTarget?: CostCallFocusTarget | null;
  onFocusConsumed?: () => void;
}

interface CostRunFocusDetail {
  conversationId: string;
  runId: string;
  runEventId: string | null;
  costRecordId: string;
}

interface CostCallFocusTarget {
  costRecordId: string;
  runId: string | null;
  runEventId: string | null;
}

interface DashboardRow {
  key: string;
  label: string;
  model_id: string | null;
  model_name_snapshot: string | null;
  conversation_id: string | null;
  conversation_title: string | null;
  feature: string | null;
  sum_usd: number;
  count: number;
  success_count: number;
  billed_failure_count: number;
  trend: Array<{
    bucket_start: number;
    label: string;
    sum_usd: number;
    count: number;
  }>;
}

interface DashboardApiRow {
  key?: string;
  label?: string;
  model_id?: string | null;
  model_name_snapshot?: string | null;
  conversation_id?: string | null;
  conversation_title?: string | null;
  feature?: string | null;
  sum_usd?: number;
  count?: number;
  success_count?: number;
  billed_failure_count?: number;
  trend?: Array<{
    bucket_start?: number;
    label?: string;
    sum_usd?: number;
    count?: number;
  }>;
}

interface CallLogRow {
  id: string;
  created_at: number;
  conversation_id: string | null;
  conversation_title: string | null;
  source_type: string;
  source_id: string | null;
  feature: string;
  model_id: string | null;
  model_name_snapshot: string;
  provider_name: string | null;
  provider_type: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  actual_cost_usd: number | null;
  success: boolean;
  classification: string | null;
  first_token_ms: number | null;
  duration_ms: number | null;
  run_id: string | null;
  run_event_id: string | null;
  run_event_kind: string | null;
  run_event_label: string | null;
}

const GROUP_LABELS: Record<CostGroupBy, string> = {
  model: '按模型',
  conversation: '按会话',
  feature: '按特性',
};

const SOURCE_LABELS: Record<string, string> = {
  message: '聊天',
  roundtable_message: '圆桌',
  topic_analyzer: '圆桌规划',
  summarizer: '圆桌总结',
  tool_call: '工具',
};

function dispatchCostRunFocus(detail: CostRunFocusDetail): void {
  window.dispatchEvent(new CustomEvent<CostRunFocusDetail>('taori:focus-run-event', { detail }));
}

function normalizeDashboardRow(row: DashboardApiRow, groupBy: CostGroupBy): DashboardRow {
  const modelId = typeof row.model_id === 'string' ? row.model_id : null;
  const modelNameSnapshot =
    typeof row.model_name_snapshot === 'string' ? row.model_name_snapshot : null;
  const conversationId =
    typeof row.conversation_id === 'string' ? row.conversation_id : null;
  const conversationTitle =
    typeof row.conversation_title === 'string' ? row.conversation_title : null;
  const feature = typeof row.feature === 'string' ? row.feature : null;
  const fallbackLabel =
    groupBy === 'model'
      ? modelNameSnapshot ?? '(已删除模型)'
      : groupBy === 'conversation'
        ? (conversationTitle ?? (conversationId ? '未命名会话' : '无会话归属'))
        : (feature ?? '未分类');

  return {
    key: typeof row.key === 'string' ? row.key : modelId ?? conversationId ?? feature ?? fallbackLabel,
    label: typeof row.label === 'string' ? row.label : fallbackLabel,
    model_id: modelId,
    model_name_snapshot: modelNameSnapshot,
    conversation_id: conversationId,
    conversation_title: conversationTitle,
    feature,
    sum_usd: typeof row.sum_usd === 'number' ? row.sum_usd : 0,
    count: typeof row.count === 'number' ? row.count : 0,
    success_count: typeof row.success_count === 'number' ? row.success_count : 0,
    billed_failure_count:
      typeof row.billed_failure_count === 'number' ? row.billed_failure_count : 0,
    trend: Array.isArray(row.trend)
      ? row.trend.map((point) => ({
          bucket_start: typeof point.bucket_start === 'number' ? point.bucket_start : 0,
          label: typeof point.label === 'string' ? point.label : '',
          sum_usd: typeof point.sum_usd === 'number' ? point.sum_usd : 0,
          count: typeof point.count === 'number' ? point.count : 0,
        }))
      : [],
  };
}

function sparklinePath(points: number[], width: number, height: number): string {
  if (points.length === 0) return '';
  const max = Math.max(...points, 0.000001);
  const stepX = points.length <= 1 ? width : width / (points.length - 1);
  return points
    .map((value, index) => {
      const x = Number((index * stepX).toFixed(2));
      const y = Number((height - (value / max) * (height - 2) - 1).toFixed(2));
      return `${index === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
}

function Sparkline({
  trend,
}: {
  trend: DashboardRow['trend'];
}): JSX.Element {
  const values = trend.map((point) => point.sum_usd);
  const path = sparklinePath(values, 96, 28);
  const hasValue = values.some((value) => value > 0);
  return (
    <svg
      className="cost-dashboard-sparkline"
      width="96"
      height="28"
      viewBox="0 0 96 28"
      fill="none"
      aria-hidden="true"
      data-testid="cost-dashboard-sparkline"
    >
      <path d="M0 27.5H96" stroke="currentColor" strokeOpacity="0.08" />
      {hasValue ? (
        <path
          d={path}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M0 18 L96 18"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeOpacity="0.35"
        />
      )}
    </svg>
  );
}

export function CostDashboard({
  onClose,
  embedded = false,
  focusTarget = null,
  onFocusConsumed,
}: CostDashboardProps): JSX.Element {
  const [scope, setScope] = useState<CostScope>('today');
  const [groupBy, setGroupBy] = useState<CostGroupBy>('model');
  const [rows, setRows] = useState<DashboardRow[] | null>(null);
  const [callLogs, setCallLogs] = useState<CallLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [focusedCostRecordId, setFocusedCostRecordId] = useState<string | null>(null);
  const refreshSeq = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!embedded && e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, embedded]);

  const refresh = useCallback(async (reset: boolean): Promise<void> => {
    const seq = ++refreshSeq.current;
    if (reset) setRows(null);
    if (reset) setCallLogs(null);
    setRefreshing(true);
    setError(null);
    try {
      const [res, logs] = await Promise.all([
        api.costsDashboardBreakdown(scope, groupBy),
        api.costsCallLogs(50),
      ]);
      if (seq !== refreshSeq.current) return;
      setRows((res.data.rows ?? []).map((row) => normalizeDashboardRow(row, groupBy)));
      setCallLogs(logs.data.rows ?? []);
      setLastUpdatedAt(Date.now());
    } catch (e) {
      if (seq !== refreshSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === refreshSeq.current) setRefreshing(false);
    }
  }, [scope, groupBy]);

  const refreshFocusedCall = useCallback(async (costRecordId: string): Promise<void> => {
    const seq = ++refreshSeq.current;
    setRefreshing(true);
    setError(null);
    try {
      const logs = await api.costsCallLogs(1, { costRecordId });
      if (seq !== refreshSeq.current) return;
      const focusedRows = logs.data.rows ?? [];
      setCallLogs((prev) => {
        const rest = (prev ?? []).filter((row) => row.id !== costRecordId);
        return [...focusedRows, ...rest].slice(0, 12);
      });
      setLastUpdatedAt(Date.now());
    } catch (e) {
      if (seq !== refreshSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === refreshSeq.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async (reset: boolean): Promise<void> => {
      if (cancelled) return;
      await refresh(reset);
    };
    void run(true);
    const timer = window.setInterval(() => void run(false), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!focusTarget?.costRecordId) return;
    setFocusedCostRecordId(focusTarget.costRecordId);
    void refreshFocusedCall(focusTarget.costRecordId);
  }, [focusTarget, refreshFocusedCall]);

  useEffect(() => {
    if (!focusedCostRecordId || callLogs == null) return;
    const target = document.querySelector(
      `[data-testid="cost-call-log-row"][data-cost-record-id="${focusedCostRecordId}"]`,
    );
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (target) onFocusConsumed?.();
  }, [callLogs, focusedCostRecordId, onFocusConsumed]);

  const topRows = useMemo(() => (rows ?? []).slice(0, 8), [rows]);
  const total = useMemo(
    () => (rows ?? []).reduce((sum, row) => sum + row.sum_usd, 0),
    [rows],
  );
  const totalCalls = useMemo(
    () => (rows ?? []).reduce((sum, row) => sum + row.count, 0),
    [rows],
  );

  return (
    <section
      className={`cost-dashboard${embedded ? ' cost-dashboard--embedded' : ''}`}
      data-testid="cost-dashboard-panel"
    >
      <header className="cost-dashboard__header">
        <div>
          <h2>成本看板</h2>
          <p className="hint">
            复盘最近消费结构，回答“钱花在哪了”。
            {lastUpdatedAt ? ` 上次刷新：${new Date(lastUpdatedAt).toLocaleTimeString()}` : ''}
          </p>
        </div>
        <div className="cost-dashboard__header-actions">
          <button
            type="button"
            onClick={() => void refresh(false)}
            disabled={refreshing}
            data-testid="cost-dashboard-refresh"
          >
            {refreshing ? '刷新中…' : '刷新'}
          </button>
          {!embedded && (
            <button
              type="button"
              className="settings-close"
              onClick={onClose}
              data-testid="cost-dashboard-close"
              aria-label="关闭成本看板"
            >
              ✕
            </button>
          )}
        </div>
      </header>

      <div className="cost-dashboard__controls">
        <div className="cost-dashboard__tabs" data-testid="cost-dashboard-scope-tabs">
          {([
            ['today', '今日'],
            ['week', '本周'],
            ['month', '本月'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              data-testid={`cost-dashboard-scope-${value}`}
              data-active={scope === value ? '1' : '0'}
              onClick={() => setScope(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="cost-dashboard__tabs" data-testid="cost-dashboard-group-tabs">
          {(['model', 'conversation', 'feature'] as const).map((value) => (
            <button
              key={value}
              type="button"
              data-testid={`cost-dashboard-group-${value}`}
              data-active={groupBy === value ? '1' : '0'}
              onClick={() => setGroupBy(value)}
            >
              {GROUP_LABELS[value]}
            </button>
          ))}
        </div>
      </div>

      <div className="cost-dashboard__summary">
        <article className="cost-dashboard__metric">
          <span>总消费</span>
          <strong data-testid="cost-dashboard-total">{formatUsd(total)}</strong>
        </article>
        <article className="cost-dashboard__metric">
          <span>分组数</span>
          <strong>{rows?.length ?? 0}</strong>
        </article>
        <article className="cost-dashboard__metric">
          <span>调用数</span>
          <strong>{totalCalls}</strong>
        </article>
      </div>

      <div className="cost-dashboard__body">
        {error && <div className="error">加载失败：{error}</div>}
        {!error && rows == null && <div className="hint">加载中…</div>}
        {!error && rows != null && rows.length === 0 && (
          <div className="hint" data-testid="cost-dashboard-empty">当前时间窗口还没有成本记录。</div>
        )}
        {!error && rows != null && rows.length > 0 && (
          <ol className="cost-dashboard__list">
            {topRows.map((row, index) => (
              <li
                key={`${row.key}-${index}`}
                className="cost-dashboard__row"
                data-testid="cost-dashboard-row"
              >
                <div className="cost-dashboard__row-rank">{index + 1}</div>
                <div className="cost-dashboard__row-main">
                  <div className="cost-dashboard__row-head">
                    <strong>{row.label}</strong>
                    <span className="cost-dashboard__row-amount">{formatUsd(row.sum_usd)}</span>
                  </div>
                  <div className="cost-dashboard__row-meta">
                    <span>{row.count} 次</span>
                    <span>{row.success_count} 成功</span>
                    {row.billed_failure_count > 0 && <span>计费失败 {row.billed_failure_count}</span>}
                    {row.trend.length > 0 && (
                      <span>{row.trend[0]!.label} → {row.trend[row.trend.length - 1]!.label}</span>
                    )}
                  </div>
                </div>
                <Sparkline trend={row.trend} />
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="cost-dashboard__calls" data-testid="cost-call-log">
        <div className="cost-dashboard__calls-head">
          <h3>最近模型 / 工具调用</h3>
          <span>按实际 Sidecar 出口记录，便于核对外部消费。</span>
        </div>
        {callLogs == null && <div className="hint">调用日志加载中…</div>}
        {callLogs != null && callLogs.length === 0 && (
          <div className="hint" data-testid="cost-call-log-empty">暂无调用日志。</div>
        )}
        {callLogs != null && callLogs.length > 0 && (
          <div className="cost-call-log-list">
            {callLogs.slice(0, 12).map((row) => (
              <article
                key={row.id}
                className="cost-call-log-row"
                data-testid="cost-call-log-row"
                data-cost-record-id={row.id}
                data-conversation-id={row.conversation_id ?? ''}
                data-source-id={row.source_id ?? ''}
                data-run-id={row.run_id ?? ''}
                data-run-event-id={row.run_event_id ?? ''}
                data-focused={focusedCostRecordId === row.id ? '1' : '0'}
              >
                <div className="cost-call-log-main">
                  <strong>
                    {row.model_name_snapshot || row.model_id || '未知模型 / 工具'}
                    {row.provider_name ? ` · ${row.provider_name}` : ''}
                  </strong>
                  <span>
                    {SOURCE_LABELS[row.source_type] ?? row.source_type} · {row.feature}
                    {row.conversation_title ? ` · ${row.conversation_title}` : ''}
                    {row.source_id ? ` · 来源 ${row.source_id.slice(0, 10)}` : ''}
                  </span>
                  <div className="cost-call-log-links">
                    <span data-testid="cost-call-source-id">Cost {row.id.slice(0, 10)}</span>
                    {row.run_id ? (
                      <span data-testid="cost-call-run-link">Run {row.run_id.slice(0, 10)}</span>
                    ) : null}
                    {row.run_event_id ? (
                      <span data-testid="cost-call-event-link">
                        {row.run_event_label ?? row.run_event_kind ?? '运行事件'} {row.run_event_id.slice(0, 10)}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="cost-call-log-meta">
                  <span className={row.success ? 'ok' : 'fail'}>
                    {row.success ? '成功' : `失败${row.classification ? `:${row.classification}` : ''}`}
                  </span>
                  <span>{row.actual_cost_usd == null ? '费用未知' : formatUsd(row.actual_cost_usd)}</span>
                  <span>{new Date(row.created_at).toLocaleTimeString()}</span>
                  {row.conversation_id && row.run_id ? (
                    <button
                      type="button"
                      className="cost-call-log-focus"
                      data-testid="cost-call-focus-run"
                      onClick={() =>
                        dispatchCostRunFocus({
                          conversationId: row.conversation_id!,
                          runId: row.run_id!,
                          runEventId: row.run_event_id,
                          costRecordId: row.id,
                        })
                      }
                    >
                      查看运行
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
