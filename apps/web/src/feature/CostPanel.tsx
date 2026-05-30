import { useEffect, useState } from 'react';
import { useToast } from '../Toast';
import {
  getCostsRealtime,
  getCostsBreakdown,
  listCostsCalls,
  type CostsBreakdownRow,
  type CostsBreakdownScope,
  type CostsCallLog,
  type CostsRealtime,
} from '../api';

function formatUsd(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.0001) return '<$0.0001';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return new Date(ts).toLocaleString('zh-CN');
}

function readableLabel(row: CostsBreakdownRow): string {
  if (typeof row.label === 'string' && row.label) return row.label;
  if (typeof row.model_id === 'string') return row.model_id;
  if (typeof row.feature === 'string') return row.feature;
  if (typeof row.conversation_title === 'string') return row.conversation_title;
  if (typeof row.conversation_id === 'string') return row.conversation_id;
  return '未分类';
}

interface CostPanelProps {
  panelId?: string;
}

export function CostPanel({ panelId }: CostPanelProps): JSX.Element {
  const toast = useToast();
  const [scope, setScope] = useState<CostsBreakdownScope>('week');
  const [groupBy, setGroupBy] = useState<'model' | 'feature' | 'conversation'>('model');
  const [realtime, setRealtime] = useState<CostsRealtime | null>(null);
  const [rows, setRows] = useState<CostsBreakdownRow[]>([]);
  const [calls, setCalls] = useState<CostsCallLog[]>([]);
  const [loading, setLoading] = useState(false);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const [rt, brk, recent] = await Promise.all([
        getCostsRealtime(),
        getCostsBreakdown(scope, groupBy),
        listCostsCalls(20),
      ]);
      setRealtime(rt);
      setRows(brk.rows);
      setCalls(recent);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, groupBy]);

  return (
    <section
      className="feature-panel"
      data-testid="cost-panel"
      id={panelId}
      role="tabpanel"
    >
      <div className="feature-header">
        <div>
          <h2>成本与用量</h2>
          <p>本机记录的真实成本，不上传任何数据。可按时间、模型、特性、会话拆分。</p>
        </div>
        <button
          type="button"
          className="btn-quiet"
          onClick={() => void refresh()}
          disabled={loading}
          data-testid="cost-refresh"
        >
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      <div className="cost-summary-grid">
        <div className="cost-summary-card">
          <div className="cost-summary-label">本月累计</div>
          <div className="cost-summary-value">{formatUsd(realtime?.month_usd)}</div>
        </div>
        <div className="cost-summary-card">
          <div className="cost-summary-label">今天</div>
          <div className="cost-summary-value">{formatUsd(realtime?.today_usd)}</div>
        </div>
        <div className="cost-summary-card">
          <div className="cost-summary-label">本会话</div>
          <div className="cost-summary-value">{formatUsd(realtime?.current_conversation_usd)}</div>
          <div className="cost-summary-sub">{realtime?.current_conversation_calls ?? 0} 次调用</div>
        </div>
      </div>

      <div className="cost-controls">
        <div className="segmented" role="group" aria-label="时间范围">
          {(['session', 'today', 'week', 'month'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={scope === item ? 'active' : ''}
              onClick={() => setScope(item)}
              data-testid={`cost-scope-${item}`}
            >
              {item === 'session' ? '本会话' : item === 'today' ? '今天' : item === 'week' ? '本周' : '本月'}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="分组维度">
          {(['model', 'feature', 'conversation'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={groupBy === item ? 'active' : ''}
              onClick={() => setGroupBy(item)}
              data-testid={`cost-group-${item}`}
            >
              {item === 'model' ? '按模型' : item === 'feature' ? '按特性' : '按会话'}
            </button>
          ))}
        </div>
      </div>

      <div className="feature-card">
        <h3>分布</h3>
        {rows.length === 0 ? (
          <p className="muted">这个范围内还没有产生成本。</p>
        ) : (
          <div className="cost-breakdown">
            {rows.slice(0, 12).map((row, index) => {
              const usd = Number((row.total_usd as number | undefined) ?? 0);
              const max = Math.max(
                ...rows.map((r) => Number((r.total_usd as number | undefined) ?? 0)),
              );
              const width = max > 0 ? Math.max(2, Math.round((usd / max) * 100)) : 0;
              return (
                <div className="cost-breakdown-row" key={`${index}-${readableLabel(row)}`}>
                  <span className="cost-breakdown-label">{readableLabel(row)}</span>
                  <span className="cost-breakdown-bar">
                    <span style={{ width: `${width}%` }} />
                  </span>
                  <span className="cost-breakdown-value">{formatUsd(usd)}</span>
                  <span className="cost-breakdown-meta">{Number(row.calls ?? 0)} 次</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="feature-card">
        <h3>最近调用</h3>
        {calls.length === 0 ? (
          <p className="muted">还没有调用记录。</p>
        ) : (
          <div className="cost-calls">
            {calls.map((call) => (
              <div className="cost-call-row" key={call.id} data-testid="cost-call-row">
                <div className="cost-call-head">
                  <strong>{call.model_name_snapshot ?? call.model_id ?? '未知模型'}</strong>
                  <span className="status-chip">{call.feature ?? call.source_type}</span>
                  <span className="muted">{relativeTime(call.created_at)}</span>
                </div>
                <div className="cost-call-meta">
                  {call.input_tokens != null && <span>in {call.input_tokens}</span>}
                  {call.cache_input_tokens != null && <span>cache {call.cache_input_tokens}</span>}
                  {call.output_tokens != null && <span>out {call.output_tokens}</span>}
                  {call.actual_cost_usd != null && <span>{formatUsd(call.actual_cost_usd)}</span>}
                  {call.duration_ms != null && <span>{call.duration_ms}ms</span>}
                  {call.classification && <span className="bad">{call.classification}</span>}
                  {call.conversation_title && <span className="muted">在「{call.conversation_title}」</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
