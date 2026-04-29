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
        preview: {
          topic_type:
            | 'business'
            | 'technical'
            | 'creative'
            | 'decision'
            | 'research'
            | 'other'
            | null;
          complexity: 'low' | 'medium' | 'high' | null;
          requested_mode: 'fast' | 'deep' | 'auto';
          analyzer_chose_mode_reason: string | null;
          estimated_calls: number;
          estimated_duration_sec_low: number;
          estimated_duration_sec_high: number;
          alt_mode: 'fast' | 'deep';
          alt_estimated_cost_usd_low: number | null;
          alt_estimated_cost_usd_high: number | null;
          alt_estimated_calls: number;
          alt_estimated_duration_sec_low: number;
          alt_estimated_duration_sec_high: number;
        };
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
          preview: created.preview,
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
    preview: {
      topic_type:
        | 'business'
        | 'technical'
        | 'creative'
        | 'decision'
        | 'research'
        | 'other'
        | null;
      complexity: 'low' | 'medium' | 'high' | null;
      requested_mode: 'fast' | 'deep' | 'auto';
      analyzer_chose_mode_reason: string | null;
      estimated_calls: number;
      estimated_duration_sec_low: number;
      estimated_duration_sec_high: number;
      alt_mode: 'fast' | 'deep';
      alt_estimated_cost_usd_low: number | null;
      alt_estimated_cost_usd_high: number | null;
      alt_estimated_calls: number;
      alt_estimated_duration_sec_low: number;
      alt_estimated_duration_sec_high: number;
    };
  };
  needsConfirm: boolean;
  skipConv: boolean;
  onSkipConvChange: (v: boolean) => void;
  onContinue: () => void;
  onCancel: () => void;
}): ReactElement {
  const chosenMode = analyzed.mode;
  const altMode = analyzed.preview.alt_mode;

  return (
    <div data-testid="roundtable-preview">
      {/* A5 — Why this mode panel. Only shown when analyzer succeeded. */}
      {analyzed.preview.analyzer_chose_mode_reason ? (
        <div
          className="roundtable-reason-panel"
          data-testid="roundtable-reason-panel"
        >
          <div className="roundtable-reason-icon" aria-hidden>💡</div>
          <div className="roundtable-reason-body">
            <div className="roundtable-reason-title">为什么是这个模式</div>
            <div
              className="roundtable-reason-text"
              data-testid="roundtable-reason-text"
            >
              {analyzed.preview.analyzer_chose_mode_reason}
            </div>
            <ReasonChips preview={analyzed.preview} />
          </div>
        </div>
      ) : (
        // On fallback we still render a thin chip strip so users can see at
        // least the requested-mode signal — keeps the launch UX consistent.
        <ReasonChips preview={analyzed.preview} />
      )}

      {analyzed.analyzer_fallback ? (
        <div
          data-testid="roundtable-fallback-notice"
          className="hint roundtable-fallback"
        >
          ⚠️ 分析器调用失败，已使用默认 3 角色组合（综合 / 批判 / 实践）。
        </div>
      ) : null}

      {/* A5 — Mode comparison: chosen mode highlighted, alternate side-by-side. */}
      <div className="roundtable-mode-compare" data-testid="roundtable-mode-compare">
        <ModeCard
          mode={chosenMode}
          chosen={true}
          calls={analyzed.preview.estimated_calls}
          costLow={analyzed.estimate.low}
          costHigh={analyzed.estimate.high}
          durLow={analyzed.preview.estimated_duration_sec_low}
          durHigh={analyzed.preview.estimated_duration_sec_high}
        />
        <ModeCard
          mode={altMode}
          chosen={false}
          calls={analyzed.preview.alt_estimated_calls}
          costLow={analyzed.preview.alt_estimated_cost_usd_low ?? 0}
          costHigh={analyzed.preview.alt_estimated_cost_usd_high ?? 0}
          durLow={analyzed.preview.alt_estimated_duration_sec_low}
          durHigh={analyzed.preview.alt_estimated_duration_sec_high}
        />
      </div>

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
          {needsConfirm
            ? '确认并开始（' +
              formatUsd(analyzed.estimate.low) +
              ' – ' +
              formatUsd(analyzed.estimate.high) +
              '）'
            : '开始'}
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

const TOPIC_TYPE_LABEL: Record<string, string> = {
  business: '商业决策',
  technical: '技术抉择',
  creative: '创意发散',
  decision: '决策类',
  research: '研究类',
  other: '一般话题',
};
const COMPLEXITY_LABEL: Record<string, string> = {
  low: '复杂度低',
  medium: '复杂度中',
  high: '复杂度高',
};

function ReasonChips({
  preview,
}: {
  preview: {
    topic_type: string | null;
    complexity: 'low' | 'medium' | 'high' | null;
    requested_mode: 'fast' | 'deep' | 'auto';
  };
}): ReactElement | null {
  const chips: { key: string; label: string }[] = [];
  if (preview.topic_type) {
    chips.push({
      key: 'topic',
      label: TOPIC_TYPE_LABEL[preview.topic_type] ?? preview.topic_type,
    });
  }
  if (preview.complexity) {
    chips.push({ key: 'cx', label: COMPLEXITY_LABEL[preview.complexity] });
  }
  chips.push({
    key: 'req',
    label:
      preview.requested_mode === 'auto'
        ? '由分析器决定模式'
        : `用户已指定 ${preview.requested_mode === 'fast' ? '快速' : '深度'}`,
  });
  if (chips.length === 0) return null;
  return (
    <div className="roundtable-reason-chips" data-testid="roundtable-reason-chips">
      {chips.map((c) => (
        <span
          key={c.key}
          className="roundtable-chip"
          data-testid={`roundtable-reason-chip-${c.key}`}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

function formatDuration(low: number, high: number): string {
  if (low === high) return `约 ${Math.round(low)} 秒`;
  return `约 ${Math.round(low)}–${Math.round(high)} 秒`;
}

function ModeCard({
  mode,
  chosen,
  calls,
  costLow,
  costHigh,
  durLow,
  durHigh,
}: {
  mode: 'fast' | 'deep';
  chosen: boolean;
  calls: number;
  costLow: number;
  costHigh: number;
  durLow: number;
  durHigh: number;
}): ReactElement {
  const label = mode === 'fast' ? '⚡ 快速' : '🔍 深度';
  const sub =
    mode === 'fast'
      ? '一轮独立观点 + 自动总结'
      : '盲审 → 互见反驳 → 总结（重要决策）';
  return (
    <div
      className={`roundtable-mode-card ${chosen ? 'chosen' : 'alt'}`}
      data-testid={`roundtable-mode-card-${mode}`}
      data-chosen={chosen ? 'true' : 'false'}
    >
      <div className="roundtable-mode-card-header">
        <span className="roundtable-mode-card-label">{label}</span>
        {chosen ? (
          <span
            className="roundtable-mode-card-badge"
            data-testid="roundtable-mode-card-chosen-badge"
          >
            本次使用
          </span>
        ) : (
          <span className="roundtable-mode-card-altbadge">备选</span>
        )}
      </div>
      <div className="roundtable-mode-card-sub">{sub}</div>
      <div className="roundtable-mode-card-grid">
        <div>
          <div className="roundtable-mode-card-key">调用次数</div>
          <div
            className="roundtable-mode-card-val"
            data-testid={`roundtable-mode-card-${mode}-calls`}
          >
            {calls}
          </div>
        </div>
        <div>
          <div className="roundtable-mode-card-key">预估成本</div>
          <div
            className="roundtable-mode-card-val"
            data-testid={`roundtable-mode-card-${mode}-cost`}
          >
            {formatUsd(costLow)} – {formatUsd(costHigh)}
          </div>
        </div>
        <div>
          <div className="roundtable-mode-card-key">预估耗时</div>
          <div
            className="roundtable-mode-card-val"
            data-testid={`roundtable-mode-card-${mode}-duration`}
          >
            {formatDuration(durLow, durHigh)}
          </div>
        </div>
      </div>
    </div>
  );
}
