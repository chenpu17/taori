/**
 * Settings modal — Model Config Center (M1 §2).
 *
 * Lists Providers + Models grouped by capability. Implements:
 *   MC-2 set default within capability
 *   MC-4 connection test (one-click ping)
 *   MC-5 disable/enable model
 *   MC-6 price tier badge
 *
 * Deferred (acknowledged gap, tracked for post-M1):
 *   MC-3 fallback order — needs `priority` field on models + drag UI.
 *
 * Plus a "重新打开 Onboarding" entry point so users can re-run the wizard
 * (M1 §1.2 acceptance criterion).
 */

import { useEffect, useState } from 'react';
import { priceTier, PRICE_TIER_LABEL, formatUsd } from '@taori/shared';
import type { Model, ModelCapability, Provider } from '@taori/shared';
import { api } from './api.js';

interface SettingsProps {
  onClose: () => void;
  onChanged: () => void;
  onReopenOnboarding: () => void;
}

interface TestResult {
  ok: boolean;
  latency_ms?: number;
  note?: string;
  error?: { classification: string; message: string } | string;
}

const TEST_NOTE_LABELS: Record<string, string> = {
  no_api_key_configured: '无 API Key，跳过实际请求',
};

export function Settings({
  onClose,
  onChanged,
  onReopenOnboarding,
}: SettingsProps): JSX.Element {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, TestResult>>({});

  const refresh = async (): Promise<void> => {
    setErr(null);
    try {
      const [{ providers: ps }, { models: ms }] = await Promise.all([
        api.listProviders(),
        api.listModels(),
      ]);
      setProviders(ps);
      setModels(ms);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Escape closes the modal — standard a11y expectation (WCAG 2.1.1).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const notifyParent = (): void => {
    onChanged();
  };

  const onToggleEnabled = async (m: Model): Promise<void> => {
    try {
      await api.updateModel(m.id, { enabled: !m.enabled });
      await refresh();
      notifyParent();
    } catch (e) {
      window.alert(`切换状态失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onSetDefault = async (m: Model): Promise<void> => {
    try {
      await api.setDefaultModel(m.id, m.capability);
      await refresh();
      notifyParent();
    } catch (e) {
      window.alert(`设置默认失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onDelete = async (m: Model): Promise<void> => {
    if (!window.confirm(`删除模型 “${m.display_name}”？`)) return;
    try {
      await api.deleteModel(m.id);
      await refresh();
      notifyParent();
    } catch (e) {
      window.alert(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onTest = async (m: Model): Promise<void> => {
    setTesting((s) => ({ ...s, [m.id]: true }));
    try {
      const r = await api.testModel(m.id);
      setResults((s) => ({ ...s, [m.id]: r }));
    } catch (e) {
      setResults((s) => ({
        ...s,
        [m.id]: { ok: false, error: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setTesting((s) => ({ ...s, [m.id]: false }));
    }
  };

  const onDeleteProvider = async (p: Provider): Promise<void> => {
    if (
      !window.confirm(
        `删除供应商 “${p.name}”？该供应商下的所有模型将一并删除。此操作不可恢复。`,
      )
    )
      return;
    try {
      await api.deleteProvider(p.id);
      await refresh();
      notifyParent();
    } catch (e) {
      window.alert(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * MC-3 — move a model up/down within its capability (changes fallback_order).
   * The model selector + auto-fallback retry both consume this ordering.
   */
  const onMove = async (m: Model, dir: -1 | 1): Promise<void> => {
    const peers = models
      .filter((x) => x.capability === m.capability)
      .sort((a, b) => a.fallback_order - b.fallback_order);
    const idx = peers.findIndex((x) => x.id === m.id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= peers.length) return;
    const next = peers.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    try {
      await api.reorderModels(
        m.capability,
        next.map((x) => x.id),
      );
      await refresh();
      notifyParent();
    } catch (e) {
      window.alert(`调整顺序失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Group models by capability for MC-2/MC-3 visualization.
  const grouped: Record<ModelCapability, Model[]> = {
    chat: [],
    image: [],
    video: [],
    embedding: [],
    asr: [],
    tts: [],
  };
  for (const m of models) (grouped[m.capability] ?? grouped.chat).push(m);
  // MC-3: render in fallback_order so the displayed order matches the order
  // used by chat fallback retry / model selector.
  for (const cap of Object.keys(grouped) as ModelCapability[]) {
    grouped[cap].sort((a, b) => a.fallback_order - b.fallback_order);
  }

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
          <h2>设置 / 模型</h2>
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

        {loading ? (
          <p className="hint">加载中…</p>
        ) : err ? (
          <p className="err">{err}</p>
        ) : (
          <>
            <AutoFallbackSection />

            <section className="settings-section">
              <div className="settings-section-head">
                <h3>Providers</h3>
                <button
                  type="button"
                  onClick={onReopenOnboarding}
                  data-testid="settings-add-provider"
                >
                  + 添加 Provider（重新打开 Onboarding）
                </button>
              </div>
              {providers.length === 0 ? (
                <p className="hint">尚未配置 Provider。</p>
              ) : (
                <ul className="settings-provider-list" data-testid="settings-provider-list">
                  {providers.map((p) => (
                    <li key={p.id} data-testid="settings-provider-item">
                      <span className="prov-name">{p.name}</span>
                      <span className="prov-type">{p.type}</span>
                      <span className={`prov-status ${p.enabled ? 'ok' : 'off'}`}>
                        {p.enabled ? '已启用' : '已禁用'}
                      </span>
                      <button
                        type="button"
                        onClick={() => void onDeleteProvider(p)}
                        data-testid="settings-provider-delete"
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="settings-section">
              <h3>Models</h3>
              {(Object.keys(grouped) as ModelCapability[]).map((cap) => {
                const list = grouped[cap];
                if (list.length === 0) return null;
                return (
                  <div key={cap} className="settings-cap-group" data-cap={cap}>
                    <h4>{capabilityLabel(cap)}</h4>
                    <ul className="settings-model-list">
                      {list.map((m, idx) => {
                        const tier = priceTier(m.price_input_per_1m);
                        const isDefault = m.is_default_for === cap;
                        const t = results[m.id];
                        const isFirst = idx === 0;
                        const isLast = idx === list.length - 1;
                        return (
                          <li
                            key={m.id}
                            data-testid="settings-model-item"
                            data-model-id={m.id}
                            className={!m.enabled ? 'disabled' : ''}
                          >
                            <span className="m-order" title="备援顺序">
                              {idx + 1}
                            </span>
                            <span className="m-name">
                              {isDefault && <span title="默认">⭐ </span>}
                              {m.display_name}
                              {m.supports_vision && <span title="支持视觉"> 👁</span>}
                            </span>
                            {tier && (
                              <span
                                className={`price-badge tier-${tier}`}
                                data-testid="settings-price-tier"
                                title={`输入价位：${PRICE_TIER_LABEL[tier]}`}
                              >
                                {PRICE_TIER_LABEL[tier]}
                              </span>
                            )}
                            {m.price_input_per_1m != null && (
                              <span className="m-price">
                                {formatUsd(m.price_input_per_1m)}/1M in
                              </span>
                            )}
                            <span className="m-actions">
                              <button
                                type="button"
                                onClick={() => void onMove(m, -1)}
                                disabled={isFirst}
                                data-testid="settings-move-up"
                                title="上移（提升备援优先级）"
                                aria-label={`上移 ${m.display_name}`}
                              >
                                ▲
                              </button>
                              <button
                                type="button"
                                onClick={() => void onMove(m, 1)}
                                disabled={isLast}
                                data-testid="settings-move-down"
                                title="下移（降低备援优先级）"
                                aria-label={`下移 ${m.display_name}`}
                              >
                                ▼
                              </button>
                              {!isDefault && m.enabled && (
                                <button
                                  type="button"
                                  onClick={() => void onSetDefault(m)}
                                  data-testid="settings-set-default"
                                  title="设为默认"
                                >
                                  设为默认
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => void onTest(m)}
                                disabled={!!testing[m.id]}
                                data-testid="settings-test"
                                title="测试连接"
                              >
                                {testing[m.id] ? '测试中…' : '测试'}
                              </button>
                              <button
                                type="button"
                                onClick={() => void onToggleEnabled(m)}
                                data-testid="settings-toggle-enabled"
                              >
                                {m.enabled ? '禁用' : '启用'}
                              </button>
                              <button
                                type="button"
                                onClick={() => void onDelete(m)}
                                data-testid="settings-delete"
                              >
                                删除
                              </button>
                            </span>
                            {t && (
                              <span
                                className={`test-result ${t.ok ? 'ok' : 'bad'}`}
                                data-testid="settings-test-result"
                              >
                                {t.ok
                                  ? `✓ ${t.note ? (TEST_NOTE_LABELS[t.note] ?? t.note) : ''}${t.latency_ms != null ? ` (${t.latency_ms}ms)` : ''}`
                                  : `✗ ${typeof t.error === 'string' ? t.error : (t.error?.message ?? '失败')}`}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </section>

            <DangerZone
              onCleared={() => {
                // After a wipe, fully reset to onboarding by reloading.
                // Settings just closes; App.tsx detects empty state and
                // routes to onboarding on next render.
                onChanged();
                window.location.reload();
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

function capabilityLabel(c: ModelCapability): string {
  switch (c) {
    case 'chat':
      return '💬 聊天';
    case 'image':
      return '🎨 图像（M1 仅可配置）';
    case 'video':
      return '🎬 视频';
    case 'embedding':
      return '🔍 向量';
    case 'asr':
      return '🎙 语音转文本';
    case 'tts':
      return '🔊 语音合成';
    default:
      return c;
  }
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
