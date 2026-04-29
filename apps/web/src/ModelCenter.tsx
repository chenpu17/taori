/**
 * Model Center — M2.5 §F-MC.
 *
 * Top-level page for managing the entire model fleet:
 *   • Provider section (add / delete provider — Volcengine Ark, OpenRouter, …)
 *   • Capability tabs (chat / multimodal / image / video / asr / tts / embedding)
 *   • Per-tab matrix: alias × provider × price × default × enabled
 *   • Sync prices button (diff toast) — calls /v1/catalog/sync
 *   • "+ 导入模型" per tab — runs Provider.discover → user picks → createModel
 *
 * Replaces the old crude "Settings → Models" list. Settings now only carries
 * Auto-fallback, Provider deletion, and the Danger Zone.
 */

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { api } from './api.js';
import {
  formatUsd,
  type Model,
  type ModelCapability,
  type ModelDiscoveryResponse,
  type Provider,
} from '@taori/shared';

const CAPABILITY_TABS: { id: ModelCapability; label: string; hint: string }[] = [
  { id: 'chat', label: '💬 文本对话', hint: '纯文本聊天 / 长文本' },
  { id: 'multimodal', label: '🖼️ 多模态', hint: '可读图，亦可对话' },
  { id: 'image', label: '🎨 图像生成', hint: '文生图 / 图生图' },
  { id: 'video', label: '🎬 视频生成', hint: '文生视频 / 图生视频' },
  { id: 'asr', label: '🎙️ 语音识别', hint: 'Whisper / 实时转写' },
  { id: 'tts', label: '🔊 语音合成', hint: '文本转语音' },
  { id: 'embedding', label: '🧬 向量嵌入', hint: '检索 / 语义索引' },
];

interface SyncSummary {
  synced_at: number;
  total_providers: number;
  total_models: number;
  changed: number;
  newCount: number;
  errors: { provider_id: string; message: string }[];
  diffs: {
    provider_id: string;
    model_name: string;
    display_name?: string | null;
    change: 'new' | 'price_changed' | 'unchanged' | 'removed';
  }[];
}

export function ModelCenter({
  onClose,
  onReopenOnboarding,
}: {
  onClose: () => void;
  onReopenOnboarding: () => void;
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<ModelCapability>('chat');
  const [models, setModels] = useState<Model[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importDrawer, setImportDrawer] = useState<{
    capability: ModelCapability;
    providerId: string | null;
  } | null>(null);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try {
      const [{ providers: ps }, { models: ms }] = await Promise.all([
        api.listProviders(),
        api.listModels(),
      ]);
      setProviders(ps);
      setModels(ms);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Esc closes the page (a11y + matches Settings).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !importDrawer) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, importDrawer]);

  const providerById = useMemo(
    () => new Map(providers.map((p) => [p.id, p])),
    [providers],
  );

  const modelsByCap = useMemo(() => {
    const out = new Map<ModelCapability, Model[]>();
    for (const tab of CAPABILITY_TABS) out.set(tab.id, []);
    for (const m of models) {
      const arr = out.get(m.capability as ModelCapability);
      if (arr) arr.push(m);
    }
    // Multimodal models also serve text chat; show them under both tabs so a
    // single vision-capable import gives a usable chat default by itself.
    const mm = out.get('multimodal') ?? [];
    const chat = out.get('chat') ?? [];
    out.set('chat', [
      ...chat,
      ...mm.filter((m) => !chat.some((x) => x.id === m.id)),
    ]);
    return out;
  }, [models]);

  const onSync = async (): Promise<void> => {
    setSyncing(true);
    setError(null);
    try {
      const res = await api.catalogSync();
      const changed = res.diffs.filter((d) => d.change === 'price_changed').length;
      const newCount = res.diffs.filter((d) => d.change === 'new').length;
      setSyncSummary({
        synced_at: res.synced_at,
        total_providers: res.total_providers,
        total_models: res.total_models,
        changed,
        newCount,
        errors: res.errors,
        diffs: res.diffs.filter((d) => d.change !== 'unchanged').slice(0, 50),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  const onToggleEnabled = async (m: Model): Promise<void> => {
    try {
      await api.updateModel(m.id, { enabled: !m.enabled });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSetDefault = async (m: Model): Promise<void> => {
    try {
      await api.setDefaultModel(m.id, m.capability as ModelCapability);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onDelete = async (m: Model): Promise<void> => {
    if (!window.confirm(`删除模型 “${m.display_name}”？`)) return;
    try {
      await api.deleteModel(m.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onDeleteProvider = async (p: Provider): Promise<void> => {
    if (!window.confirm(`删除 Provider “${p.name}”？该 Provider 下的全部模型将一并删除。`)) return;
    try {
      await api.deleteProvider(p.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onMove = async (m: Model, dir: -1 | 1): Promise<void> => {
    const sameCap = (modelsByCap.get(m.capability as ModelCapability) ?? [])
      .filter((x) => x.capability === m.capability)
      .slice()
      .sort((a, b) => a.fallback_order - b.fallback_order);
    const idx = sameCap.findIndex((x) => x.id === m.id);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= sameCap.length) return;
    const next = sameCap.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    try {
      await api.reorderModels(m.capability as ModelCapability, next.map((x) => x.id));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const [editing, setEditing] = useState<Model | null>(null);

  const onSaveEdit = async (patch: import('@taori/shared').ModelUpdate): Promise<void> => {
    if (!editing) return;
    try {
      await api.updateModel(editing.id, patch);
      setEditing(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const [testResult, setTestResult] = useState<{
    providerId: string;
    ok: boolean;
    note?: string | null;
    classification?: string | null;
  } | null>(null);

  const onTestProvider = async (p: Provider): Promise<void> => {
    setTestResult(null);
    const firstModel = models.find((m) => m.provider_id === p.id);
    if (!firstModel) {
      setTestResult({
        providerId: p.id,
        ok: false,
        note: '请先为该 Provider 导入至少一个模型再测试',
      });
      return;
    }
    try {
      const res = await api.testModel(firstModel.id);
      setTestResult({
        providerId: p.id,
        ok: res.ok,
        note: res.note ?? null,
        classification: res.error?.classification ?? null,
      });
    } catch (e) {
      setTestResult({
        providerId: p.id,
        ok: false,
        note: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const visibleModels = (modelsByCap.get(activeTab) ?? [])
    .slice()
    .sort((a, b) => a.fallback_order - b.fallback_order);
  const tab = CAPABILITY_TABS.find((t) => t.id === activeTab)!;

  return (
    <div className="model-center" data-testid="model-center">
      <header className="model-center__header">
        <div>
          <h2>模型中心</h2>
          <p className="hint">按能力分组管理你的模型阵列；价格、默认、启用状态一目了然。</p>
        </div>
        <div className="model-center__header-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => void onSync()}
            disabled={syncing}
            data-testid="model-center-sync"
          >
            {syncing ? '同步中…' : '🔄 同步价格'}
          </button>
          <button type="button" onClick={onClose} data-testid="model-center-close">
            关闭
          </button>
        </div>
      </header>

      {error && <div className="model-center__error">{error}</div>}
      {syncSummary && (
        <SyncResult summary={syncSummary} providerById={providerById} />
      )}

      {/* Provider section — surfaces all configured providers and gives an
          "+ 添加 Provider" entry point that re-runs Onboarding (which has
          presets for OpenRouter, Volcengine Ark, OpenAI, Ollama, etc.). */}
      <section className="model-center__providers" data-testid="model-center-providers">
        <div className="model-center__providers-head">
          <h3>Providers</h3>
          <button
            type="button"
            className="btn-primary"
            onClick={onReopenOnboarding}
            data-testid="model-center-add-provider"
          >
            + 添加 Provider
          </button>
        </div>
        {providers.length === 0 ? (
          <p className="hint">尚未配置 Provider，点击上方“+ 添加 Provider”导入。</p>
        ) : (
          <ul className="provider-chips">
            {providers.map((p) => (
              <li
                key={p.id}
                className={`provider-chip ${p.enabled ? '' : 'is-off'}`}
                data-testid={`provider-chip-${p.id}`}
              >
                <span className="provider-chip__name">{p.name}</span>
                <span className="provider-chip__type">{p.type}</span>
                <button
                  type="button"
                  className="provider-chip__test"
                  onClick={() => void onTestProvider(p)}
                  data-testid={`provider-chip-test-${p.id}`}
                  title="测试连接"
                >
                  测试
                </button>
                <button
                  type="button"
                  className="provider-chip__del"
                  onClick={() => void onDeleteProvider(p)}
                  aria-label={`删除 ${p.name}`}
                  title="删除 Provider"
                >
                  ✕
                </button>
                {testResult && testResult.providerId === p.id && (
                  <span
                    className={`provider-chip__test-result ${testResult.ok ? 'ok' : 'err'}`}
                    data-testid={`provider-chip-test-result-${p.id}`}
                  >
                    {testResult.ok ? '✓' : '✗'}
                    {testResult.note ? ` ${testResult.note}` : ''}
                    {testResult.classification ? ` (${testResult.classification})` : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <nav className="model-center__tabs" role="tablist">
        {CAPABILITY_TABS.map((t) => {
          const count = (modelsByCap.get(t.id) ?? []).length;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={activeTab === t.id}
              className={activeTab === t.id ? 'tab tab--active' : 'tab'}
              onClick={() => setActiveTab(t.id)}
              data-testid={`model-center-tab-${t.id}`}
            >
              <span className="tab__label">{t.label}</span>
              <span className="tab__count">{count}</span>
            </button>
          );
        })}
      </nav>

      <section className="model-center__matrix">
        <div className="model-center__matrix-head">
          <div>
            <h3>{tab.label}</h3>
            <p className="hint">{tab.hint}</p>
          </div>
          <button
            type="button"
            onClick={() =>
              setImportDrawer({
                capability: activeTab,
                providerId: providers[0]?.id ?? null,
              })
            }
            disabled={providers.length === 0}
            data-testid="model-center-import"
            title={providers.length === 0 ? '请先添加 Provider' : '从 Provider 导入模型'}
          >
            + 导入模型
          </button>
        </div>
        {loading ? (
          <p className="hint">加载中…</p>
        ) : visibleModels.length === 0 ? (
          <p className="hint">
            尚无 <strong>{tab.label}</strong> 模型。点击右上 “+ 导入模型” 从 Provider 导入。
          </p>
        ) : (
          <table className="model-matrix" data-testid="model-matrix">
            <thead>
              <tr>
                <th>模型</th>
                <th>Provider</th>
                <th>价格（USD/1M tok 或单次）</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleModels.map((m) => {
                const prov = m.provider_id ? providerById.get(m.provider_id) : undefined;
                const isDefault = m.is_default_for === activeTab;
                const priceCell =
                  activeTab === 'image'
                    ? `每张 ${formatUsd(m.price_per_image)}`
                    : activeTab === 'video'
                      ? `每秒 ${formatUsd(m.price_per_video_second)}`
                      : `输入 ${formatUsd(m.price_input_per_1m)} · 输出 ${formatUsd(m.price_output_per_1m)}`;
                const sameCapList = visibleModels.filter(
                  (x) => x.capability === m.capability,
                );
                const idxInCap = sameCapList.findIndex((x) => x.id === m.id);
                const isFirstInCap = idxInCap === 0;
                const isLastInCap = idxInCap === sameCapList.length - 1;
                return (
                  <tr key={m.id} data-testid={`model-row-${m.id}`}>
                    <td>
                      <div className="model-cell-name">
                        <strong>{m.alias ?? m.display_name ?? m.model_name}</strong>
                        {isDefault && <span className="badge badge--default">默认</span>}
                        {m.demoted && (
                          <span
                            className="badge badge--demoted"
                            title="该模型被自动降级（连续失败）"
                            data-testid={`model-row-demoted-${m.id}`}
                          >
                            ⚠️ 降级
                          </span>
                        )}
                      </div>
                      <div className="model-cell-id">{m.model_name}</div>
                    </td>
                    <td>
                      {prov ? (
                        <span className="model-cell-provider">
                          {prov.name} · <em>{prov.type}</em>
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{priceCell}</td>
                    <td>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={m.enabled}
                          onChange={() => void onToggleEnabled(m)}
                          data-testid={`model-row-enabled-${m.id}`}
                        />
                        <span>{m.enabled ? '启用' : '禁用'}</span>
                      </label>
                    </td>
                    <td>
                      <div className="model-cell-actions">
                        <button
                          type="button"
                          onClick={() => void onMove(m, -1)}
                          disabled={isFirstInCap}
                          data-testid={`model-row-up-${m.id}`}
                          title="上移（兜底优先级 +1）"
                          aria-label="上移"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          onClick={() => void onMove(m, 1)}
                          disabled={isLastInCap}
                          data-testid={`model-row-down-${m.id}`}
                          title="下移（兜底优先级 -1）"
                          aria-label="下移"
                        >
                          ▼
                        </button>
                        <button
                          type="button"
                          onClick={() => void onSetDefault(m)}
                          disabled={isDefault}
                          data-testid={`model-row-default-${m.id}`}
                        >
                          {isDefault ? '已是默认' : '设为默认'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(m)}
                          data-testid={`model-edit-${m.id}`}
                          title="编辑模型（重命名 / 改价格 / 改能力）"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => void onDelete(m)}
                          data-testid={`model-row-delete-${m.id}`}
                          title="删除模型"
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {importDrawer && (
        <ImportDrawer
          providers={providers}
          existingModels={models}
          initialCapability={importDrawer.capability}
          initialProviderId={importDrawer.providerId}
          onClose={() => setImportDrawer(null)}
          onImported={async () => {
            setImportDrawer(null);
            await refresh();
          }}
        />
      )}
      {editing && (
        <EditModelDialog
          model={editing}
          onCancel={() => setEditing(null)}
          onSave={(patch) => void onSaveEdit(patch)}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Sync result panel — explicit feedback so users see "what changed"
// ----------------------------------------------------------------------------
function SyncResult({
  summary,
  providerById,
}: {
  summary: SyncSummary;
  providerById: Map<string, Provider>;
}): JSX.Element {
  return (
    <div className="model-center__sync-summary" data-testid="model-center-sync-summary">
      <div className="sync-summary__head">
        ✓ 已同步 {summary.total_providers} 个 Provider · 上游共 {summary.total_models} 个模型
        {summary.changed > 0 && <strong> · {summary.changed} 个价格更新</strong>}
        {summary.newCount > 0 && <strong> · {summary.newCount} 个新模型</strong>}
        {summary.errors.length > 0 && (
          <span className="model-center__sync-errors">
            {' '}· {summary.errors.length} 个 Provider 同步失败
          </span>
        )}
      </div>
      {summary.diffs.length > 0 && (
        <details className="sync-summary__diffs">
          <summary>查看变化（{summary.diffs.length}）</summary>
          <ul>
            {summary.diffs.map((d, i) => {
              const prov = providerById.get(d.provider_id);
              return (
                <li key={`${d.provider_id}-${d.model_name}-${i}`}>
                  <span className={`badge badge--${d.change}`}>
                    {d.change === 'new' ? '新' : '价'}
                  </span>{' '}
                  {prov?.name ?? d.provider_id} · {d.display_name ?? d.model_name}
                  <span className="hint"> ({d.model_name})</span>
                </li>
              );
            })}
          </ul>
        </details>
      )}
      {summary.errors.length > 0 && (
        <details className="sync-summary__errors">
          <summary>查看失败原因（{summary.errors.length}）</summary>
          <ul>
            {summary.errors.map((e, i) => {
              const prov = providerById.get(e.provider_id);
              return (
                <li key={`${e.provider_id}-${i}`}>
                  <strong>{prov?.name ?? e.provider_id}</strong>: {e.message}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Import drawer — discover models from a Provider and import the picked ones.
// ----------------------------------------------------------------------------
type DiscoveredModel = ModelDiscoveryResponse['models'][number];

function ImportDrawer({
  providers,
  existingModels,
  initialCapability,
  initialProviderId,
  onClose,
  onImported,
}: {
  providers: Provider[];
  existingModels: Model[];
  initialCapability: ModelCapability;
  initialProviderId: string | null;
  onClose: () => void;
  onImported: () => Promise<void>;
}): JSX.Element {
  const [providerId, setProviderId] = useState<string | null>(initialProviderId);
  const [capability, setCapability] = useState<ModelCapability>(initialCapability);
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
  const [filter, setFilter] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [importing, setImporting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  // Auto-discover when provider changes.
  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    setDiscovering(true);
    setErr(null);
    setPicked(new Set());
    setDiscovered([]);
    api
      .discoverModels(providerId)
      .then((r) => {
        if (cancelled) return;
        setDiscovered(r.models);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setDiscovering(false);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const existingKeys = useMemo(
    () =>
      new Set(
        existingModels
          .filter((m) => m.provider_id === providerId)
          .map((m) => m.model_name),
      ),
    [existingModels, providerId],
  );

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    // Filter by selected capability so e.g. "图像" tab only offers image models.
    // Multimodal also shows under chat to match the matrix view.
    const capMatch = (m: DiscoveredModel) => {
      if (capability === 'chat') return m.capability === 'chat' || m.capability === 'multimodal';
      return m.capability === capability;
    };
    return discovered
      .filter(capMatch)
      .filter((m) =>
        f === ''
          ? true
          : m.model_name.toLowerCase().includes(f) ||
            (m.display_name ?? '').toLowerCase().includes(f),
      );
  }, [discovered, filter, capability]);

  const toggle = (name: string): void => {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const onImport = async (): Promise<void> => {
    if (!providerId || picked.size === 0) return;
    setImporting(true);
    setErr(null);
    try {
      const toImport = discovered.filter((m) => picked.has(m.model_name));
      for (const m of toImport) {
        await api.createModel({
          provider_id: providerId,
          model_name: m.model_name,
          display_name: m.display_name ?? m.model_name,
          capability: m.capability,
          price_input_per_1m: m.price_input_per_1m ?? null,
          price_output_per_1m: m.price_output_per_1m ?? null,
          price_per_image: m.price_per_image ?? null,
          price_per_video_second: m.price_per_video_second ?? null,
          context_length: m.context_length ?? null,
          supports_vision: m.supports_vision ?? false,
          supports_tools: m.supports_tools ?? false,
          modalities: m.modalities ?? undefined,
        });
      }
      await onImported();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div
      className="import-drawer-overlay"
      role="dialog"
      aria-modal="true"
      data-testid="import-drawer"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="import-drawer">
        <header className="import-drawer__head">
          <h3>导入模型</h3>
          <button type="button" onClick={onClose} aria-label="关闭">✕</button>
        </header>

        <div className="import-drawer__filters">
          <label>
            Provider
            <select
              value={providerId ?? ''}
              onChange={(e) => setProviderId(e.target.value || null)}
              data-testid="import-drawer-provider"
            >
              {providers.length === 0 && <option value="">（无）</option>}
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.type}）
                </option>
              ))}
            </select>
          </label>
          <label>
            能力
            <select
              value={capability}
              onChange={(e) => setCapability(e.target.value as ModelCapability)}
              data-testid="import-drawer-capability"
            >
              {CAPABILITY_TABS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            搜索
            <input
              type="search"
              placeholder="model_name 或 display_name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              data-testid="import-drawer-filter"
            />
          </label>
        </div>

        {discovering ? (
          <p className="hint">发现中…（首次可能 2–5 秒）</p>
        ) : err ? (
          <p className="err" data-testid="import-drawer-err">{err}</p>
        ) : filtered.length === 0 ? (
          <p className="hint">
            该 Provider 在所选能力下没有可用模型；切换能力或搜索其它关键字试试。
          </p>
        ) : (
          <ul className="import-drawer__list" data-testid="import-drawer-list">
            {filtered.map((m) => {
              const isExisting = existingKeys.has(m.model_name);
              const isPicked = picked.has(m.model_name);
              return (
                <li
                  key={m.model_name}
                  className={isExisting ? 'is-existing' : ''}
                  data-testid={`import-drawer-row-${m.model_name}`}
                >
                  <label>
                    <input
                      type="checkbox"
                      disabled={isExisting}
                      checked={isPicked}
                      onChange={() => toggle(m.model_name)}
                    />
                    <span className="import-row__name">
                      {m.display_name ?? m.model_name}
                      {m.supports_vision && <span title="支持视觉"> 👁</span>}
                    </span>
                    <span className="import-row__id">{m.model_name}</span>
                    <span className="import-row__price">
                      {m.capability === 'image'
                        ? `每张 ${formatUsd(m.price_per_image ?? null)}`
                        : m.capability === 'video'
                          ? `每秒 ${formatUsd(m.price_per_video_second ?? null)}`
                          : `输入 ${formatUsd(m.price_input_per_1m ?? null)} · 输出 ${formatUsd(m.price_output_per_1m ?? null)}`}
                    </span>
                    {isExisting && <span className="badge">已导入</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <footer className="import-drawer__foot">
          <span className="hint">
            已选 {picked.size} 项 / 共 {filtered.length} 个候选
          </span>
          <button
            type="button"
            className="btn-primary"
            disabled={picked.size === 0 || importing}
            onClick={() => void onImport()}
            data-testid="import-drawer-confirm"
          >
            {importing ? '导入中…' : `导入 ${picked.size} 个模型`}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// EditModelDialog — manual edit for alias / capability / pricing.
//
// Pricing fields shown depend on the (possibly-changed) capability:
//   chat / multimodal / embedding → input + output per 1M tokens
//   image                          → per image
//   video                          → per second
//   asr / tts                      → per call (fallback)
// `price_per_call` is always editable as a "其他计费" fallback.
//
// When the user changes capability away from the original, we also clear
// `is_default_for` (because the existing default association no longer makes
// sense, e.g. a chat model relabelled as image must not stay the chat default).
// ----------------------------------------------------------------------------

function EditModelDialog(props: {
  model: Model;
  onCancel: () => void;
  onSave: (patch: import('@taori/shared').ModelUpdate) => void;
}): JSX.Element {
  const { model, onCancel, onSave } = props;
  const [alias, setAlias] = useState(model.alias ?? '');
  const [displayName, setDisplayName] = useState(model.display_name);
  const [capability, setCapability] = useState<ModelCapability>(
    model.capability as ModelCapability,
  );
  const [supportsVision, setSupportsVision] = useState(model.supports_vision);
  const [supportsTools, setSupportsTools] = useState(model.supports_tools);
  const [pIn, setPIn] = useState<string>(model.price_input_per_1m?.toString() ?? '');
  const [pOut, setPOut] = useState<string>(model.price_output_per_1m?.toString() ?? '');
  const [pImage, setPImage] = useState<string>(model.price_per_image?.toString() ?? '');
  const [pVideo, setPVideo] = useState<string>(
    model.price_per_video_second?.toString() ?? '',
  );
  const [pCall, setPCall] = useState<string>(model.price_per_call?.toString() ?? '');
  const [currency, setCurrency] = useState<string>(model.price_currency ?? 'USD');

  const parseNum = (s: string): number | null => {
    const t = s.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const patch: import('@taori/shared').ModelUpdate = {
      alias: alias.trim() || model.alias || model.display_name,
      display_name: displayName.trim() || model.display_name,
      capability,
      supports_vision: supportsVision,
      supports_tools: supportsTools,
      price_input_per_1m: parseNum(pIn),
      price_output_per_1m: parseNum(pOut),
      price_per_image: parseNum(pImage),
      price_per_video_second: parseNum(pVideo),
      price_per_call: parseNum(pCall),
      price_currency: currency.trim() || 'USD',
    };
    if (capability !== model.capability && model.is_default_for) {
      patch.is_default_for = null;
    }
    onSave(patch);
  };

  const isToken = capability === 'chat' || capability === 'multimodal' || capability === 'embedding';
  const isImage = capability === 'image';
  const isVideo = capability === 'video';

  return (
    <div className="modal-backdrop" onClick={onCancel} data-testid="model-editor-backdrop">
      <div
        className="modal-card model-editor"
        onClick={(e) => e.stopPropagation()}
        data-testid="model-editor"
        role="dialog"
        aria-modal="true"
        aria-label="编辑模型"
      >
        <header className="modal-card__head">
          <div>
            <h3>编辑模型</h3>
            <p className="hint">{model.model_name}</p>
          </div>
          <button type="button" onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </header>
        <form onSubmit={submit} className="model-editor__body">
          <label className="field">
            <span>别名（用于切换器显示）</span>
            <input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              data-testid="model-editor-alias"
            />
          </label>
          <label className="field">
            <span>展示名</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              data-testid="model-editor-display-name"
            />
          </label>
          <label className="field">
            <span>能力（修正错误识别的模型类型）</span>
            <select
              value={capability}
              onChange={(e) => setCapability(e.target.value as ModelCapability)}
              data-testid="model-editor-capability"
            >
              {CAPABILITY_TABS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {capability !== model.capability && model.is_default_for && (
            <p className="field-warn" data-testid="model-editor-cap-warn">
              ⚠ 能力已变更，原"默认 {model.is_default_for}"绑定将被解除。
            </p>
          )}
          <div className="field-row">
            <label className="field-inline">
              <input
                type="checkbox"
                checked={supportsVision}
                onChange={(e) => setSupportsVision(e.target.checked)}
                data-testid="model-editor-supports-vision"
              />
              <span>支持视觉</span>
            </label>
            <label className="field-inline">
              <input
                type="checkbox"
                checked={supportsTools}
                onChange={(e) => setSupportsTools(e.target.checked)}
                data-testid="model-editor-supports-tools"
              />
              <span>支持工具调用</span>
            </label>
          </div>

          <fieldset className="pricing">
            <legend>价格（留空表示未知，将不计入成本估算）</legend>
            {isToken && (
              <>
                <label className="field">
                  <span>输入 / 1M tokens</span>
                  <input
                    inputMode="decimal"
                    value={pIn}
                    onChange={(e) => setPIn(e.target.value)}
                    placeholder="例如 0.5"
                    data-testid="model-editor-price-input"
                  />
                </label>
                <label className="field">
                  <span>输出 / 1M tokens</span>
                  <input
                    inputMode="decimal"
                    value={pOut}
                    onChange={(e) => setPOut(e.target.value)}
                    placeholder="例如 1.5"
                    data-testid="model-editor-price-output"
                  />
                </label>
              </>
            )}
            {isImage && (
              <label className="field">
                <span>每张图价格</span>
                <input
                  inputMode="decimal"
                  value={pImage}
                  onChange={(e) => setPImage(e.target.value)}
                  placeholder="例如 0.04"
                  data-testid="model-editor-price-image"
                />
              </label>
            )}
            {isVideo && (
              <label className="field">
                <span>每秒视频价格</span>
                <input
                  inputMode="decimal"
                  value={pVideo}
                  onChange={(e) => setPVideo(e.target.value)}
                  placeholder="例如 0.10"
                  data-testid="model-editor-price-video"
                />
              </label>
            )}
            <label className="field">
              <span>每次调用价格（其他计费 / asr / tts 等）</span>
              <input
                inputMode="decimal"
                value={pCall}
                onChange={(e) => setPCall(e.target.value)}
                placeholder="例如 0.002"
                data-testid="model-editor-price-call"
              />
            </label>
            <label className="field">
              <span>币种</span>
              <input
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                placeholder="USD"
                data-testid="model-editor-currency"
                style={{ maxWidth: 120 }}
              />
            </label>
            <p className="hint">
              提示：分辨率分级 / 时长分级 等更复杂计费规则尚未支持，将在 v0.8 引入 pricing_meta。
            </p>
          </fieldset>

          <footer className="model-editor__foot">
            <button
              type="button"
              onClick={onCancel}
              data-testid="model-editor-cancel"
            >
              取消
            </button>
            <button
              type="submit"
              className="btn-primary"
              data-testid="model-editor-save"
            >
              保存
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
