/**
 * M3.A.5 — Roundtable main panel.
 *
 * Replaces the chat composer/messages area when the active conversation has
 * an active or completed roundtable. Driven by `roundtable_id`.
 *
 * Lifecycle (spec §5.2.1):
 *   ready          → "开始 round 1" 按钮（status='analyzing' 完成后）
 *   running(round) → 列流式渲染 + 单列重试
 *   round_done(1)  → fast: 自动 summarize；deep: 三按钮（再来一轮 / 总结结束 / 取消）
 *   running(2)     → 列流式渲染
 *   round_done(2)  → 自动 summarize
 *   summarizing    → summary 区流式
 *   completed      → 结论卡 + 成本 + 导出
 *   failed         → 错误提示，建议重新启动
 *   cancelled      → 静态展示已生成内容
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { api } from './api.js';
import { authedFetch } from './sidecar.js';
import { streamRoundtableAnnotations } from './roundtableStream.js';
import type {
  Roundtable,
  RoundtableMessage,
  RoundtableAnnotation,
  RoundtableSummary,
} from '@taori/shared';

interface ColumnState {
  /** Per-round → finished/streaming content for this participant. */
  content: Map<number, string>;
  /** Per-round → status badge. */
  status: Map<number, 'pending' | 'streaming' | 'complete' | 'failed'>;
  /** Per-round → failure detail. */
  errors: Map<number, { classification: string; message: string } | null>;
  /** Round-1 retry attempts (UI-side counter; sidecar enforces hard limit). */
  retries: Map<number, number>;
}

function emptyColumn(): ColumnState {
  return {
    content: new Map(),
    status: new Map(),
    errors: new Map(),
    retries: new Map(),
  };
}

function applyMessages(
  participants: { length: number },
  messages: RoundtableMessage[],
): ColumnState[] {
  const cols: ColumnState[] = [];
  for (let i = 0; i < participants.length; i++) cols.push(emptyColumn());
  for (const m of messages) {
    const col = cols[m.participant_index];
    if (!col) continue;
    col.content.set(m.round, m.content);
    col.status.set(m.round, m.status);
    if (m.status === 'failed') {
      col.errors.set(m.round, {
        classification: m.classification ?? 'unknown',
        message: m.error_message ?? '',
      });
    } else {
      col.errors.set(m.round, null);
    }
  }
  return cols;
}

export interface RoundtablePanelProps {
  roundtableId: string;
  /** Called when user cancels / archives — parent should re-render the
   *  conversation surface (M3.A.5 just navigates away from the panel). */
  onExit: () => void;
  /** A2: user clicked "就这一点再来一轮" on a divergence item; parent
   *  should close this panel and open a fresh launch dialog with the
   *  divergence as the new topic. */
  onFollowUp?: (topic: string) => void;
  /** A4: user clicked "带回原对话继续聊天"; parent should switch active
   *  conversation to `conversationId` and refresh the sidebar. */
  onLoopback?: (conversationId: string) => void;
}

export function RoundtablePanel(props: RoundtablePanelProps): ReactElement {
  const { roundtableId, onExit, onFollowUp, onLoopback } = props;
  const [rt, setRt] = useState<Roundtable | null>(null);
  const [, setMessages] = useState<RoundtableMessage[]>([]);
  const [cols, setCols] = useState<ColumnState[]>([]);
  const [streamingRound, setStreamingRound] = useState<number | null>(null);
  const [summaryStreaming, setSummaryStreaming] = useState<string>('');
  const [summary, setSummary] = useState<RoundtableSummary | null>(null);
  const [summaryError, setSummaryError] = useState<{
    message: string;
    fallback_text: string;
  } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalCost, setTotalCost] = useState<number>(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const refresh = useCallback(async (): Promise<{
    rt: Roundtable;
    messages: RoundtableMessage[];
  } | null> => {
    try {
      const r = await api.getRoundtable(roundtableId);
      if (!mountedRef.current) return null;
      setRt(r.roundtable);
      setMessages(r.messages);
      setCols(applyMessages(r.roundtable.participants, r.messages));
      setTotalCost(r.total_cost_usd);
      const s = r.roundtable.summary;
      if (s && typeof s === 'object' && 'fallback' in s && s.fallback) {
        setSummary(null);
        setSummaryError({
          message: '总结失败，使用兜底文本',
          fallback_text: (s as { raw_text?: string }).raw_text ?? '',
        });
      } else if (s) {
        setSummary(s as RoundtableSummary);
        setSummaryError(null);
      }
      return { rt: r.roundtable, messages: r.messages };
    } catch (e) {
      if (!mountedRef.current) return null;
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [roundtableId]);

  useEffect(() => {
    void refresh();
  }, [roundtableId, refresh]);

  function handleAnnotation(ann: RoundtableAnnotation): void {
    if (ann.type === 'rt.round_start') {
      streamingRoundRef.current = ann.round;
      setStreamingRound(ann.round);
      setCols((prev) => {
        const next = prev.map((c) => ({
          content: new Map(c.content),
          status: new Map(c.status),
          errors: new Map(c.errors),
          retries: new Map(c.retries),
        }));
        for (let i = 0; i < ann.participants_total; i++) {
          if (!next[i]) continue;
          next[i].status.set(ann.round, 'pending');
          next[i].content.set(ann.round, '');
          next[i].errors.set(ann.round, null);
        }
        return next;
      });
    } else if (ann.type === 'rt.participant_delta') {
      const round = streamingRoundRef.current ?? rt?.current_round ?? 1;
      setCols((prev) => {
        const next = prev.slice();
        const c = next[ann.participant_index];
        if (!c) return prev;
        const cloned: ColumnState = {
          content: new Map(c.content),
          status: new Map(c.status),
          errors: new Map(c.errors),
          retries: new Map(c.retries),
        };
        cloned.content.set(
          round,
          (cloned.content.get(round) ?? '') + ann.text_chunk,
        );
        cloned.status.set(round, 'streaming');
        next[ann.participant_index] = cloned;
        return next;
      });
    } else if (ann.type === 'rt.participant_done') {
      const round = streamingRoundRef.current ?? rt?.current_round ?? 1;
      setCols((prev) => {
        const next = prev.slice();
        const c = next[ann.participant_index];
        if (!c) return prev;
        const cloned: ColumnState = {
          content: new Map(c.content),
          status: new Map(c.status),
          errors: new Map(c.errors),
          retries: new Map(c.retries),
        };
        cloned.content.set(round, ann.content);
        cloned.status.set(round, 'complete');
        cloned.errors.set(round, null);
        next[ann.participant_index] = cloned;
        return next;
      });
    } else if (ann.type === 'rt.participant_failed') {
      const round = streamingRoundRef.current ?? rt?.current_round ?? 1;
      setCols((prev) => {
        const next = prev.slice();
        const c = next[ann.participant_index];
        if (!c) return prev;
        const cloned: ColumnState = {
          content: new Map(c.content),
          status: new Map(c.status),
          errors: new Map(c.errors),
          retries: new Map(c.retries),
        };
        cloned.status.set(round, 'failed');
        cloned.errors.set(round, {
          classification: ann.classification,
          message: ann.message,
        });
        next[ann.participant_index] = cloned;
        return next;
      });
    } else if (ann.type === 'rt.round_done') {
      streamingRoundRef.current = null;
      setStreamingRound(null);
    } else if (ann.type === 'rt.summary_delta') {
      setSummaryStreaming((s) => s + ann.text_chunk);
    } else if (ann.type === 'rt.summary_done') {
      setSummary(ann.summary);
      setSummaryError(null);
      setSummaryStreaming('');
    } else if (ann.type === 'rt.summary_failed') {
      setSummaryError({
        message: ann.message,
        fallback_text: ann.fallback_text,
      });
      setSummaryStreaming('');
    }
  }

  // streamingRound stays in sync via ref to avoid stale closure inside SSE
  // dispatcher. (Annotations arrive faster than React re-renders.)
  const streamingRoundRef = useRef<number | null>(null);
  useEffect(() => {
    streamingRoundRef.current = streamingRound;
  }, [streamingRound]);

  async function runRound(): Promise<void> {
    if (!rt || actionBusy) return;
    setActionBusy(true);
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamRoundtableAnnotations({
        path: `/v1/roundtable/${rt.id}/round`,
        method: 'POST',
        signal: ctrl.signal,
        onAnnotation: handleAnnotation,
      });
      await refresh();
    } catch (e) {
      if (mountedRef.current && !ctrl.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (mountedRef.current) setActionBusy(false);
    }
  }

  async function runSummary(): Promise<void> {
    if (!rt || actionBusy) return;
    setActionBusy(true);
    setError(null);
    setSummaryStreaming('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamRoundtableAnnotations({
        path: `/v1/roundtable/${rt.id}/summarize`,
        method: 'POST',
        signal: ctrl.signal,
        onAnnotation: handleAnnotation,
      });
      await refresh();
    } catch (e) {
      if (mountedRef.current && !ctrl.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (mountedRef.current) setActionBusy(false);
    }
  }

  async function retryParticipant(
    round: number,
    index: number,
    modelOverrideId?: string,
  ): Promise<void> {
    if (!rt || actionBusy) return;
    setActionBusy(true);
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setCols((prev) => {
      const next = prev.slice();
      const c = next[index];
      if (!c) return prev;
      const cloned: ColumnState = {
        content: new Map(c.content),
        status: new Map(c.status),
        errors: new Map(c.errors),
        retries: new Map(c.retries),
      };
      cloned.retries.set(round, (cloned.retries.get(round) ?? 0) + 1);
      cloned.status.set(round, 'pending');
      cloned.content.set(round, '');
      cloned.errors.set(round, null);
      next[index] = cloned;
      return next;
    });
    try {
      streamingRoundRef.current = round;
      await streamRoundtableAnnotations({
        path: `/v1/roundtable/${rt.id}/round/${round}/participant/${index}/retry`,
        method: 'PUT',
        body: modelOverrideId ? { model_id: modelOverrideId } : undefined,
        signal: ctrl.signal,
        onAnnotation: handleAnnotation,
      });
      await refresh();
    } catch (e) {
      if (mountedRef.current && !ctrl.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (mountedRef.current) setActionBusy(false);
    }
  }

  async function cancelRoundtable(): Promise<void> {
    if (!rt) return;
    try {
      await authedFetch(`/v1/roundtable/${rt.id}/cancel`, { method: 'POST' });
    } catch {
      /* non-fatal: continue exiting even if cancel fails */
    }
    if (!mountedRef.current) return;
    onExit();
  }

  async function exportMarkdown(): Promise<void> {
    if (!rt) return;
    try {
      const res = await authedFetch(`/v1/roundtable/${rt.id}/export`);
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      if (!mountedRef.current) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `roundtable_${rt.id}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // After deep round 1 done in deep mode → wait for user. After fast round
  // 1 done OR deep round 2 done → auto-summarize. Sidecar already auto-chains
  // for fast mode (M3.A.3 review fix), but the renderer also issues the
  // /summarize call as a safety net for deep round 2 since summarize is a
  // separate request.
  const phase = useMemo(() => derivePhase(rt, streamingRound), [rt, streamingRound]);

  if (!rt) {
    return (
      <div className="roundtable-panel" data-testid="roundtable-panel">
        {error ? (
          <div className="roundtable-error" data-testid="roundtable-panel-error">
            {error}
          </div>
        ) : (
          <div className="roundtable-loading">加载圆桌…</div>
        )}
      </div>
    );
  }

  return (
    <div className="roundtable-panel" data-testid="roundtable-panel">
      <header className="roundtable-header">
        <div>
          <strong>话题：</strong>
          {rt.topic}
        </div>
        <div className="roundtable-header-meta">
          <span>模式：{rt.mode === 'fast' ? '🚀 快速' : '🔍 深度'}</span>
          <span data-testid="roundtable-total-cost">
            已花 ${totalCost.toFixed(4)}
          </span>
          <span>状态：{rt.status}</span>
        </div>
      </header>

      <div className="roundtable-grid" data-testid="roundtable-grid">
        {rt.participants.map((p, i) => (
          <ParticipantColumn
            key={`${p.model_id}-${i}`}
            participant={p}
            column={cols[i] ?? emptyColumn()}
            roundsToShow={[1, ...(rt.mode === 'deep' ? [2] : [])]}
            participantIndex={i}
            disableRetry={actionBusy}
            roundtableId={rt.id}
            onRetry={(round, modelId) =>
              void retryParticipant(round, i, modelId)
            }
          />
        ))}
      </div>

      <div className="roundtable-actions" data-testid="roundtable-actions">
        {phase === 'ready' ? (
          <button
            type="button"
            disabled={actionBusy}
            onClick={() => void runRound()}
            data-testid="roundtable-action-start-round"
          >
            开始第 1 轮
          </button>
        ) : null}
        {phase === 'deep_round1_done' ? (
          <>
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => void runSummary()}
              data-testid="roundtable-action-summarize-now"
            >
              📝 总结结束
            </button>
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => void runRound()}
              data-testid="roundtable-action-next-round"
            >
              ➕ 再来一轮
            </button>
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => void cancelRoundtable()}
              data-testid="roundtable-action-cancel"
            >
              取消
            </button>
          </>
        ) : null}
        {phase === 'deep_round2_done' ? (
          <button
            type="button"
            disabled={actionBusy}
            onClick={() => void runSummary()}
            data-testid="roundtable-action-summarize"
          >
            📝 总结
          </button>
        ) : null}
        {phase === 'streaming' ? (
          <span className="roundtable-streaming-hint">正在流式生成…</span>
        ) : null}
        {phase === 'completed' ? (
          <button
            type="button"
            onClick={() => void exportMarkdown()}
            data-testid="roundtable-action-export"
          >
            📋 导出 Markdown
          </button>
        ) : null}
      </div>

      {summaryStreaming ? (
        <pre
          className="roundtable-summary-streaming"
          data-testid="roundtable-summary-streaming"
        >
          {summaryStreaming}
        </pre>
      ) : null}

      {summary ? (
        <SummaryCard
          summary={summary}
          totalCost={totalCost}
          onFollowUp={onFollowUp}
          roundtableId={roundtableId}
          onLoopback={onLoopback}
        />
      ) : null}

      {summaryError ? (
        <div
          className="roundtable-summary-error"
          data-testid="roundtable-summary-error"
        >
          总结失败：{summaryError.message}
          <pre className="roundtable-summary-fallback">
            {summaryError.fallback_text}
          </pre>
          <button
            type="button"
            disabled={actionBusy}
            onClick={() => void runSummary()}
            data-testid="roundtable-summary-retry"
          >
            重试总结
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="roundtable-error" data-testid="roundtable-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}

type Phase =
  | 'ready'
  | 'streaming'
  | 'deep_round1_done'
  | 'deep_round2_done'
  | 'summarizing'
  | 'completed'
  | 'failed'
  | 'cancelled';

function derivePhase(
  rt: Roundtable | null,
  streamingRound: number | null,
): Phase {
  if (!rt) return 'ready';
  if (streamingRound !== null) return 'streaming';
  if (rt.status === 'completed') return 'completed';
  if (rt.status === 'failed') return 'failed';
  if (rt.status === 'cancelled') return 'cancelled';
  if (rt.status === 'summarizing') return 'summarizing';
  if (rt.status === 'analyzing' || rt.current_round === 0) return 'ready';
  if (rt.status === 'round1' && rt.mode === 'deep') return 'deep_round1_done';
  if (rt.status === 'round1' && rt.mode === 'fast') return 'deep_round2_done';
  if (rt.status === 'round2') return 'deep_round2_done';
  return 'ready';
}

function ParticipantColumn({
  participant,
  column,
  roundsToShow,
  participantIndex,
  disableRetry,
  roundtableId,
  onRetry,
}: {
  participant: { display_name: string; role_label: string };
  column: ColumnState;
  roundsToShow: number[];
  participantIndex: number;
  disableRetry: boolean;
  roundtableId: string;
  onRetry: (round: number, modelId?: string) => void;
}): ReactElement {
  const [optionsOpen, setOptionsOpen] = useState<number | null>(null);
  const [candidates, setCandidates] = useState<{
    state: 'idle' | 'loading' | 'done' | 'error';
    data?: Awaited<ReturnType<typeof api.getRoundtableRetryCandidates>>;
    error?: string;
  }>({ state: 'idle' });

  async function openOptions(round: number): Promise<void> {
    setOptionsOpen(round);
    if (candidates.state === 'done' || candidates.state === 'loading') return;
    setCandidates({ state: 'loading' });
    try {
      const data = await api.getRoundtableRetryCandidates(
        roundtableId,
        participantIndex,
      );
      setCandidates({ state: 'done', data });
    } catch (e) {
      setCandidates({
        state: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <div
      className="roundtable-column"
      data-testid={`roundtable-column-${participantIndex}`}
    >
      <div className="roundtable-column-head">
        <strong>{participant.role_label}</strong>
        <span className="hint">{participant.display_name}</span>
      </div>
      {roundsToShow.map((round) => {
        const status = column.status.get(round) ?? 'pending';
        const content = column.content.get(round) ?? '';
        const err = column.errors.get(round);
        const retries = column.retries.get(round) ?? 0;
        const showOptions = optionsOpen === round;
        return (
          <div
            key={round}
            className={`roundtable-cell roundtable-cell-${status}`}
            data-testid={`roundtable-cell-${participantIndex}-${round}`}
          >
            <div className="roundtable-cell-head">
              <span>R{round}</span>
              <span className={`badge badge-${status}`}>{status}</span>
            </div>
            {status === 'failed' && err ? (
              <div
                className="roundtable-cell-error"
                data-testid={`roundtable-cell-error-${participantIndex}-${round}`}
              >
                <span className="badge">{err.classification}</span>
                <span>{err.message}</span>
                <div className="roundtable-retry-actions">
                  <button
                    type="button"
                    disabled={disableRetry || retries >= 3}
                    onClick={() => onRetry(round)}
                    data-testid={`roundtable-retry-${participantIndex}-${round}`}
                  >
                    {retries >= 3 ? '建议重新启动圆桌' : '重试'}
                  </button>
                  <button
                    type="button"
                    className="roundtable-retry-options-btn"
                    disabled={disableRetry || retries >= 3}
                    onClick={() => {
                      if (showOptions) setOptionsOpen(null);
                      else void openOptions(round);
                    }}
                    aria-expanded={showOptions}
                    data-testid={`roundtable-retry-options-toggle-${participantIndex}-${round}`}
                    title="切换为其他模型重试"
                  >
                    {showOptions ? '收起' : '换模型 ▾'}
                  </button>
                </div>
                {showOptions ? (
                  <div
                    className="roundtable-retry-options"
                    data-testid={`roundtable-retry-options-${participantIndex}-${round}`}
                  >
                    {candidates.state === 'loading' ? (
                      <p className="hint">加载候选模型…</p>
                    ) : null}
                    {candidates.state === 'error' ? (
                      <p className="err">加载失败：{candidates.error}</p>
                    ) : null}
                    {candidates.state === 'done' && candidates.data ? (
                      <ul className="roundtable-retry-candidates">
                        {candidates.data.candidates.map((c) => {
                          const tag = c.is_current
                            ? '当前'
                            : c.recommended
                              ? '推荐'
                              : c.demoted
                                ? '降权'
                                : c.disabled
                                  ? '禁用'
                                  : '';
                          return (
                            <li
                              key={c.model_id}
                              data-testid={`roundtable-retry-candidate-${participantIndex}-${round}-${c.model_id}`}
                              data-recommended={c.recommended}
                              data-demoted={c.demoted}
                            >
                              <button
                                type="button"
                                disabled={
                                  disableRetry ||
                                  retries >= 3 ||
                                  c.disabled
                                }
                                onClick={() => {
                                  setOptionsOpen(null);
                                  onRetry(
                                    round,
                                    c.is_current ? undefined : c.model_id,
                                  );
                                }}
                                title={
                                  c.already_used_by_other_participant
                                    ? '其他参与者已使用此模型'
                                    : undefined
                                }
                              >
                                <span className="cand-name">
                                  {c.display_name}
                                </span>
                                {tag ? (
                                  <span
                                    className={`cand-tag cand-tag-${
                                      c.is_current
                                        ? 'current'
                                        : c.recommended
                                          ? 'recommended'
                                          : c.demoted
                                            ? 'demoted'
                                            : 'disabled'
                                    }`}
                                  >
                                    {tag}
                                  </span>
                                ) : null}
                                {c.already_used_by_other_participant ? (
                                  <span className="cand-tag cand-tag-dup">
                                    已用
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <pre className="roundtable-cell-body">{content}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SummaryCard({
  summary,
  totalCost,
  onFollowUp,
  roundtableId,
  onLoopback,
}: {
  summary: RoundtableSummary;
  totalCost: number;
  onFollowUp?: (topic: string) => void;
  roundtableId: string;
  onLoopback?: (conversationId: string) => void;
}): ReactElement {
  const [loopbackBusy, setLoopbackBusy] = useState(false);
  const [loopbackError, setLoopbackError] = useState<string | null>(null);
  const [loopbackDone, setLoopbackDone] = useState(false);
  async function handleLoopback(): Promise<void> {
    if (!onLoopback) return;
    setLoopbackBusy(true);
    setLoopbackError(null);
    try {
      const res = await api.postRoundtableLoopback(roundtableId);
      setLoopbackDone(true);
      onLoopback(res.conversation_id);
    } catch (err) {
      setLoopbackError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoopbackBusy(false);
    }
  }
  return (
    <div className="roundtable-summary" data-testid="roundtable-summary">
      <h4>结论</h4>
      {summary.consensus?.length ? (
        <section>
          <h5>✅ 共识</h5>
          <ul>
            {summary.consensus.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {summary.divergence?.length ? (
        <section>
          <h5>⚠️ 分歧</h5>
          <ul>
            {summary.divergence.map((d, i) => {
              const followUpTopic = (() => {
                const lines = [d.topic];
                if (d.positions?.length) {
                  for (const p of d.positions) {
                    lines.push(`- ${p.role}：${p.stance}`);
                  }
                }
                lines.push('请围绕以上分歧深入再讨论一轮，给出更具体的判断与依据。');
                return lines.join('\n');
              })();
              return (
                <li key={i} className="roundtable-divergence-item">
                  <div className="roundtable-divergence-head">
                    <strong>{d.topic}</strong>
                    {onFollowUp ? (
                      <button
                        type="button"
                        className="roundtable-divergence-followup"
                        data-testid={`roundtable-divergence-followup-${i}`}
                        title="就这一点再开一轮圆桌"
                        onClick={() => onFollowUp(followUpTopic)}
                      >
                        🔍 就这一点再来一轮
                      </button>
                    ) : null}
                  </div>
                  <ul>
                    {d.positions.map((p, j) => (
                      <li key={j}>
                        <em>{p.role}</em>：{p.stance}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {summary.risks?.length ? (
        <section>
          <h5>🚨 风险</h5>
          <ul>
            {summary.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {summary.recommended_decision ? (
        <section>
          <h5>🎯 推荐决策</h5>
          <p>{summary.recommended_decision}</p>
        </section>
      ) : null}
      {summary.next_steps?.length ? (
        <section>
          <h5>📋 下一步</h5>
          <ul>
            {summary.next_steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="roundtable-summary-cost">总成本：${totalCost.toFixed(4)}</div>
      {onLoopback ? (
        <div className="roundtable-summary-loopback">
          <button
            type="button"
            className="roundtable-loopback-btn"
            data-testid="roundtable-loopback"
            disabled={loopbackBusy || loopbackDone}
            onClick={() => void handleLoopback()}
            title="把这次圆桌的结论作为一条 assistant 消息写入原对话，继续聊"
          >
            {loopbackDone ? '✓ 已带回' : loopbackBusy ? '回填中…' : '↪ 带回原对话继续聊天'}
          </button>
          {loopbackError ? (
            <span
              className="roundtable-loopback-error"
              data-testid="roundtable-loopback-error"
            >
              {loopbackError}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
