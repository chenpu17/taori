/**
 * M3.A.4 — Roundtable launch dialog.
 *
 * Two-step flow:
 *   1. User edits topic/mode → "开始分析" → POST /v1/roundtable (analyzer
 *      runs server-side, returns participants + estimated cost range).
 *   2. Show analyzer preview + estimate. If cost-confirm gate is triggered
 *      (always=true OR estimate.low > threshold) and the conversation is not
 *      in `disabled_conversations`, ask the user one more time before
 *      handing the roundtable id back to the parent (M3.A.5 will render
 *      the actual panel).
 *
 * Roundtable cost-confirm uses dedicated memory keys (see spec §5.1.1):
 *   - `cost_confirm_roundtable_threshold_usd` (default 0.10)
 *   - `cost_confirm_roundtable_always` (default 'true')
 *   - `cost_confirm_disabled_conversations` (shared with M2 chat path)
 *
 * "本会话不再提醒" only writes `cost_confirm_disabled_conversations` (does
 * NOT pollute M2's per-model `disabled_models` list).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { api } from './api.js';
import { formatUsd, ROUNDTABLE_DEFAULTS, ROUNDTABLE_MEMORY_KEYS } from '@taori/shared';
import type { Participant, RoundtableMode } from '@taori/shared';

interface RoundtableLaunchResult {
  id: string;
  conversation_id: string;
  mode: 'fast' | 'deep';
}

export interface RoundtableLaunchDialogProps {
  initialTopic: string;
  /** When provided, the new roundtable joins this conversation (instead of
   *  creating a fresh roundtable conversation). */
  conversationId: string | null;
  onLaunched: (result: RoundtableLaunchResult) => void;
  onCancel: () => void;
}

type Step =
  | { kind: 'edit' }
  | { kind: 'analyzing' }
  | {
      kind: 'preview';
      analyzed: {
        id: string;
        conversation_id: string;
        mode: 'fast' | 'deep';
        participants: Participant[];
        analyzer_fallback: boolean;
        estimate: { low: number; high: number };
      };
      needsConfirm: boolean;
    }
  | { kind: 'error'; message: string };

interface ConfirmPrefs {
  threshold: number;
  always: boolean;
  disabledConvs: string[];
}

const DEFAULT_PREFS: ConfirmPrefs = {
  threshold: ROUNDTABLE_DEFAULTS.COST_THRESHOLD_USD,
  always: ROUNDTABLE_DEFAULTS.COST_ALWAYS === 'true',
  disabledConvs: [],
};

export function RoundtableLaunchDialog(
  props: RoundtableLaunchDialogProps,
): ReactElement {
  const { initialTopic, conversationId, onLaunched, onCancel } = props;

  const [topic, setTopic] = useState(initialTopic);
  const [mode, setMode] = useState<RoundtableMode>('auto');
  const [step, setStep] = useState<Step>({ kind: 'edit' });
  const [prefs, setPrefs] = useState<ConfirmPrefs>(DEFAULT_PREFS);
  const [skipConv, setSkipConv] = useState(false);
  // Tracks whether the component is still mounted; if a parent unmounts the
  // dialog during analysis (rare edge case), avoid setState-after-unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load roundtable cost-confirm prefs once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, always, dc] = await Promise.all([
          api.getMemoryEffective(
            ROUNDTABLE_MEMORY_KEYS.COST_THRESHOLD,
            conversationId,
          ),
          api.getMemoryEffective(
            ROUNDTABLE_MEMORY_KEYS.COST_ALWAYS,
            conversationId,
          ),
          api.getMemoryEffective(
            'cost_confirm_disabled_conversations',
            conversationId,
          ),
        ]);
        if (cancelled) return;
        const thr = (() => {
          const v = t.data.value;
          if (!v) return ROUNDTABLE_DEFAULTS.COST_THRESHOLD_USD;
          const n = parseFloat(v);
          return Number.isFinite(n) ? n : ROUNDTABLE_DEFAULTS.COST_THRESHOLD_USD;
        })();
        const alwaysFlag =
          always.data.value === 'false'
            ? false
            : (ROUNDTABLE_DEFAULTS.COST_ALWAYS === 'true');
        let arr: string[] = [];
        try {
          const j = JSON.parse(dc.data.value ?? '[]');
          if (Array.isArray(j)) arr = j.map(String);
        } catch {
          /* ignore */
        }
        setPrefs({ threshold: thr, always: alwaysFlag, disabledConvs: arr });
      } catch {
        /* keep defaults */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Esc dismisses the dialog (cancel path) — but NOT during analyzing,
  // because the server-side createRoundtable call is already in flight and
  // closing here would orphan that roundtable record (spec §5.1: 启动调用
  // 在用户点开始后才发出，分析期间应等待结果).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (step.kind === 'analyzing') return;
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, step.kind]);

  const trimmedTopic = useMemo(() => topic.trim(), [topic]);

  async function startAnalysis(): Promise<void> {
    if (!trimmedTopic) return;
    setStep({ kind: 'analyzing' });
    try {
      const created = await api.createRoundtable({
        topic: trimmedTopic,
        mode,
        ...(conversationId ? { conversation_id: conversationId } : {}),
      });
      if (!mountedRef.current) return;
      const low = created.estimated_cost_usd_low ?? 0;
      const high = created.estimated_cost_usd_high ?? 0;
      const inDisabled = prefs.disabledConvs.includes(created.conversation_id);
      const overThreshold = low > prefs.threshold;
      const needsConfirm = !inDisabled && (prefs.always || overThreshold);
      setStep({
        kind: 'preview',
        analyzed: {
          id: created.id,
          conversation_id: created.conversation_id,
          mode: created.mode,
          participants: created.participants,
          analyzer_fallback: created.analyzer_fallback,
          estimate: { low, high },
        },
        needsConfirm,
      });
    } catch (e) {
      if (!mountedRef.current) return;
      setStep({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function handleConfirm(): Promise<void> {
    if (step.kind !== 'preview') return;
    // Persist "本会话不再提醒" (only when user actually proceeds).
    if (skipConv) {
      try {
        const cur = await api.getMemoryEffective(
          'cost_confirm_disabled_conversations',
          null,
        );
        let arr: string[] = [];
        try {
          const j = JSON.parse(cur.data.value ?? '[]');
          if (Array.isArray(j)) arr = j.map(String);
        } catch {
          /* ignore */
        }
        if (!arr.includes(step.analyzed.conversation_id)) {
          arr.push(step.analyzed.conversation_id);
        }
        await api.putMemory(
          'global',
          'cost_confirm_disabled_conversations',
          JSON.stringify(arr),
        );
      } catch {
        /* non-fatal */
      }
    }
    onLaunched({
      id: step.analyzed.id,
      conversation_id: step.analyzed.conversation_id,
      mode: step.analyzed.mode,
    });
  }

  return (
    <div
      className="modal-backdrop"
      data-testid="roundtable-launch-dialog"
      role="dialog"
      aria-modal="true"
    >
      <div className="modal-card roundtable-launch">
        <h3>启动圆桌讨论</h3>
        {step.kind === 'edit' ? (
          <>
            <label className="roundtable-field">
              <span>话题</span>
              <textarea
                data-testid="roundtable-topic-input"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                rows={3}
                autoFocus
                placeholder="例如：是否在生产环境从 mysql 迁移到 postgres?"
              />
            </label>
            <label className="roundtable-field">
              <span>模式</span>
              <select
                data-testid="roundtable-mode-select"
                value={mode}
                onChange={(e) => setMode(e.target.value as RoundtableMode)}
              >
                <option value="auto">自动（让分析器决定）</option>
                <option value="fast">快速（仅 1 轮 + 总结）</option>
                <option value="deep">深度（2 轮互见 + 总结）</option>
              </select>
            </label>
            <div className="modal-actions">
              <button
                type="button"
                data-testid="roundtable-launch-start"
                autoFocus
                disabled={!trimmedTopic}
                onClick={() => void startAnalysis()}
              >
                开始分析
              </button>
              <button
                type="button"
                data-testid="roundtable-launch-cancel"
                onClick={onCancel}
              >
                取消
              </button>
            </div>
          </>
        ) : null}

        {step.kind === 'analyzing' ? (
          <div data-testid="roundtable-analyzing" className="roundtable-loading">
            <div className="hint">正在分析话题、挑选参与者、估算成本…</div>
          </div>
        ) : null}

        {step.kind === 'error' ? (
          <>
            <div
              data-testid="roundtable-launch-error"
              className="roundtable-error"
            >
              分析失败：{step.message}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => setStep({ kind: 'edit' })}
                autoFocus
              >
                返回编辑
              </button>
              <button type="button" onClick={onCancel}>
                关闭
              </button>
            </div>
          </>
        ) : null}

        {step.kind === 'preview' ? (
          <PreviewSection
            analyzed={step.analyzed}
            needsConfirm={step.needsConfirm}
            skipConv={skipConv}
            onSkipConvChange={setSkipConv}
            onContinue={() => void handleConfirm()}
            onCancel={onCancel}
          />
        ) : null}
      </div>
    </div>
  );
}

function PreviewSection({
  analyzed,
  needsConfirm,
  skipConv,
  onSkipConvChange,
  onContinue,
  onCancel,
}: {
  analyzed: {
    id: string;
    conversation_id: string;
    mode: 'fast' | 'deep';
    participants: Participant[];
    analyzer_fallback: boolean;
    estimate: { low: number; high: number };
  };
  needsConfirm: boolean;
  skipConv: boolean;
  onSkipConvChange: (v: boolean) => void;
  onContinue: () => void;
  onCancel: () => void;
}): ReactElement {
  const modeLabel = analyzed.mode === 'fast' ? '快速' : '深度';
  return (
    <div data-testid="roundtable-preview">
      <div className="roundtable-meta">
        <div>
          <strong>模式：</strong>
          {modeLabel}
        </div>
        <div data-testid="roundtable-estimate">
          <strong>预估成本：</strong>
          {formatUsd(analyzed.estimate.low)} – {formatUsd(analyzed.estimate.high)}
        </div>
      </div>
      {analyzed.analyzer_fallback ? (
        <div
          data-testid="roundtable-fallback-notice"
          className="hint roundtable-fallback"
        >
          ⚠️ 分析器调用失败，已使用默认 3 角色组合（综合 / 批判 / 实践）。
        </div>
      ) : null}
      <div className="roundtable-participants">
        <strong>参与者：</strong>
        <ol data-testid="roundtable-participants-list">
          {analyzed.participants.map((p, i) => (
            <li key={`${p.model_id}-${i}`}>
              <span className="role-badge">{p.role_label}</span>
              <span className="participant-name">{p.display_name}</span>
              <div className="participant-persona hint">{p.persona_prompt}</div>
            </li>
          ))}
        </ol>
      </div>
      <div className="modal-actions">
        <button
          type="button"
          data-testid="roundtable-launch-continue"
          autoFocus
          onClick={onContinue}
        >
          {needsConfirm ? '确认并开始（' + formatUsd(analyzed.estimate.low) + ' – ' + formatUsd(analyzed.estimate.high) + '）' : '开始'}
        </button>
        <button
          type="button"
          data-testid="roundtable-launch-back"
          onClick={onCancel}
        >
          取消
        </button>
      </div>
      {needsConfirm ? (
        <div className="modal-checks">
          <label>
            <input
              type="checkbox"
              data-testid="roundtable-skip-conv"
              checked={skipConv}
              onChange={(e) => onSkipConvChange(e.target.checked)}
            />
            该会话后续不再确认（仅本会话生效）
          </label>
        </div>
      ) : null}
    </div>
  );
}
