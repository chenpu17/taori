/**
 * Settings modal — slim form post-M2.5.
 *
 * After M2.5 the heavy "Model Config Center" (capability-grouped lists,
 * per-row reorder/test/delete, fallback ordering) was promoted to its own
 * top-level page (`ModelCenter.tsx`). Settings now only carries the
 * cross-cutting toggles that don't fit the per-model surface:
 *
 *   • Auto-fallback toggle (M2.1)
 *   • "Re-open onboarding" entry point
 *   • Danger zone (wipe SQLite + Keychain)
 *
 * Provider list / model matrix / connection test all live in Model Center.
 */

import { useEffect, useState } from 'react';
import { api } from './api.js';

interface SettingsProps {
  onClose: () => void;
  onChanged: () => void;
  onReopenOnboarding: () => void;
}

export function Settings({
  onClose,
  onChanged,
  onReopenOnboarding,
}: SettingsProps): JSX.Element {
  // Escape closes the modal — standard a11y expectation (WCAG 2.1.1).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="settings-overlay"
      data-testid="settings-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-modal" role="dialog" aria-label="设置">
        <header className="settings-header">
          <h2>设置</h2>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            data-testid="settings-close"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        <AutoFallbackSection />

        <section className="settings-section">
          <div className="settings-section-head">
            <h3>Provider 与模型</h3>
          </div>
          <p className="hint">
            模型与 Provider 的管理已迁移至独立的 <strong>模型中心</strong>（顶部 🧬 图标）。
            如需重新走一遍完整 Onboarding，可点击下方按钮。
          </p>
          <button
            type="button"
            onClick={onReopenOnboarding}
            data-testid="settings-add-provider"
          >
            重新打开 Onboarding
          </button>
        </section>

        <DangerZone
          onCleared={() => {
            onChanged();
            window.location.reload();
          }}
        />
      </div>
    </div>
  );
}

/**
 * Danger zone (M1 §6.2): wipes SQLite + Keychain. We require two confirms:
 * a checkbox to unlock the button (so a stray click can't fire it) and a
 * native window.confirm() with the explicit "无法恢复" wording. The endpoint
 * itself is destructive but idempotent — running it twice on an empty store
 * is a no-op.
 */
function DangerZone({ onCleared }: { onCleared: () => void }): JSX.Element {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function onClear(): Promise<void> {
    if (!armed || busy) return;
    if (!window.confirm('确定要清空所有数据吗？\n这会删除：所有会话、所有消息、所有模型与 Provider、所有 Keychain 中保存的 API Key。\n此操作无法恢复。')) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.clearAllData();
      const failures = res.data.keystore_failures.length;
      setMsg(
        failures > 0
          ? `已清空。Keychain 有 ${failures} 项删除失败，可手动到「钥匙串访问」清理。`
          : `已清空。Keychain 同步删除 ${res.data.keystore_entries_removed} 项。`,
      );
      onCleared();
    } catch (e) {
      setMsg(`清空失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }

  return (
    <section className="settings-section settings-danger" data-testid="settings-danger-zone">
      <div className="settings-section-head">
        <h3>危险区 / Danger zone</h3>
      </div>
      <p className="hint">清空所有数据：删除全部会话、模型、Provider 配置以及钥匙串内的 API Key。此操作无法恢复。</p>
      <label className="danger-arm">
        <input
          type="checkbox"
          checked={armed}
          onChange={(e) => setArmed(e.target.checked)}
          data-testid="settings-danger-arm"
        />
        我已知晓，确认要清空所有数据。
      </label>
      <button
        type="button"
        className="danger-btn"
        disabled={!armed || busy}
        onClick={() => void onClear()}
        data-testid="settings-clear-all"
      >
        {busy ? '清理中…' : '清空所有数据'}
      </button>
      {msg && <p className="hint" data-testid="settings-danger-msg">{msg}</p>}
    </section>
  );
}

// =====================================================================
// M2.1 — Auto-fallback toggle
// =====================================================================
//
// Persists the global `auto_fallback_enabled` flag via /v1/memories.
// The flag is read by the chat route per request and emitted in the
// `failure_decision` annotation; the renderer's auto-fallback effect
// in ChatPanel consumes it to fire a single-hop retry.
//
// We optimistically reflect the toggled value before the round-trip
// completes so users don't see a click-then-wait UX; on failure we
// revert and surface the error.
function AutoFallbackSection(): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getMemoryEffective('auto_fallback_enabled');
        if (cancelled) return;
        setEnabled(r.data.value === 'true');
      } catch (e) {
        if (!cancelled) setEnabled(false);
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggle = async (): Promise<void> => {
    if (enabled == null || busy) return;
    const next = !enabled;
    setBusy(true);
    setErr(null);
    setEnabled(next);
    try {
      await api.putMemory('global', 'auto_fallback_enabled', String(next));
    } catch (e) {
      setEnabled(!next);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" data-testid="settings-auto-fallback">
      <h3>失败处理</h3>
      <label className="auto-fallback-row">
        <input
          type="checkbox"
          checked={enabled === true}
          disabled={enabled == null || busy}
          onChange={() => void onToggle()}
          data-testid="auto-fallback-toggle"
        />
        <span className="auto-fallback-label">
          失败时自动切换到下一个备用模型重试（单次）
        </span>
      </label>
      <p className="hint">
        当上游返回额度/速率/网络类错误时，会按 fallback 顺序自动切换到下一个可用模型重试一次；
        内容策略错误（content_filter）始终不自动重试。
      </p>
      {err && <p className="err" data-testid="auto-fallback-err">{err}</p>}
    </section>
  );
}
