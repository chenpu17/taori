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

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { api } from './api.js';
import {
  formatUsd,
  type Model,
  type ModelHealthRow,
  type ModelCapability,
  type DiscoveredModel,
  type Provider,
  type ProviderUpdate,
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

type ImportCapabilityFilter = ModelCapability | 'all';

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

type ModelFeatureFilter = 'all' | 'tools' | 'vision' | 'default' | 'unknown_price';
type ModelSortKey = 'priority' | 'name' | 'price_low' | 'price_high' | 'context_desc';

interface ManagedModelDiff {
  model: Model;
  discovered: DiscoveredModel;
  changes: string[];
}

const FAILURE_LABELS: Record<string, string> = {
  rate_limit: '限流',
  quota: '额度耗尽',
  network: '网络失败',
  auth: '鉴权失败',
  content_filter: '内容拦截',
  unknown: '未知失败',
  key_missing: 'Key 缺失',
};

function priceChanged(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return false;
  if (a == null || b == null) return true;
  return Math.abs(a - b) > 0.0000001;
}

function primaryPrice(model: Pick<Model, 'price_input_per_1m' | 'price_output_per_1m' | 'price_per_image' | 'price_per_video_second' | 'price_per_call'>): number | null {
  const values = [
    model.price_input_per_1m,
    model.price_output_per_1m,
    model.price_per_image,
    model.price_per_video_second,
    model.price_per_call,
  ].filter((v): v is number => v != null && Number.isFinite(v));
  if (values.length === 0) return null;
  return Math.min(...values);
}

function discoveredPrice(discovered: DiscoveredModel): number | null {
  const values = [
    discovered.price_input_per_1m,
    discovered.price_output_per_1m,
    discovered.price_per_image ?? null,
    discovered.price_per_video_second ?? null,
  ].filter((v): v is number => v != null && Number.isFinite(v));
  if (values.length === 0) return null;
  return Math.min(...values);
}

function pricePairLabel(before: number | null | undefined, after: number | null | undefined): string {
  return `${formatUsd(before ?? null)} -> ${formatUsd(after ?? null)}`;
}

function managedDiff(existing: Model | undefined, discovered: DiscoveredModel): ManagedModelDiff | null {
  if (!existing) return null;
  const changes: string[] = [];
  if (priceChanged(existing.price_input_per_1m, discovered.price_input_per_1m)) {
    changes.push(`输入价 ${pricePairLabel(existing.price_input_per_1m, discovered.price_input_per_1m)}`);
  }
  if (priceChanged(existing.price_output_per_1m, discovered.price_output_per_1m)) {
    changes.push(`输出价 ${pricePairLabel(existing.price_output_per_1m, discovered.price_output_per_1m)}`);
  }
  if (priceChanged(existing.price_per_image, discovered.price_per_image)) {
    changes.push(`图片价 ${pricePairLabel(existing.price_per_image, discovered.price_per_image)}`);
  }
  if (priceChanged(existing.price_per_video_second, discovered.price_per_video_second)) {
    changes.push(`视频价 ${pricePairLabel(existing.price_per_video_second, discovered.price_per_video_second)}`);
  }
  if (existing.capability !== discovered.capability) {
    changes.push(`能力 ${existing.capability} -> ${discovered.capability}`);
  }
  if (existing.context_length !== discovered.context_length) {
    changes.push(`上下文 ${existing.context_length ?? '未知'} -> ${discovered.context_length ?? '未知'}`);
  }
  if (existing.supports_vision !== discovered.supports_vision) {
    changes.push(`视觉 ${existing.supports_vision ? '支持' : '不支持'} -> ${discovered.supports_vision ? '支持' : '不支持'}`);
  }
  if (discovered.supports_tools !== undefined && existing.supports_tools !== discovered.supports_tools) {
    changes.push(`工具 ${existing.supports_tools ? '支持' : '不支持'} -> ${discovered.supports_tools ? '支持' : '不支持'}`);
  }
  return changes.length > 0 ? { model: existing, discovered, changes } : null;
}

function formatMetricMs(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}ms`;
}

function formatAgo(ts: number | null): string {
  if (ts == null) return '—';
  const diff = Math.max(0, Date.now() - ts);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  return `${Math.floor(diff / hour)} 小时前`;
}

export function ModelCenter({
  onClose,
  onChanged,
  onReopenOnboarding,
  embedded = false,
}: {
  onClose: () => void;
  onChanged?: () => void;
  onReopenOnboarding: () => void;
  embedded?: boolean;
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<ModelCapability>('chat');
  const [models, setModels] = useState<Model[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [keyStatus, setKeyStatus] = useState<Map<string, boolean>>(new Map());
  const [loading, setLoading] = useState(true);
  const [syncingTarget, setSyncingTarget] = useState<string | 'all' | null>(null);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [healthRows, setHealthRows] = useState<Map<string, ModelHealthRow>>(new Map());
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  const [importDrawer, setImportDrawer] = useState<{
    capability: ImportCapabilityFilter;
    providerId: string | null;
  } | null>(null);
  const [modelQuery, setModelQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [featureFilter, setFeatureFilter] = useState<ModelFeatureFilter>('all');
  const [sortKey, setSortKey] = useState<ModelSortKey>('priority');
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set());
  const [providerMenuId, setProviderMenuId] = useState<string | null>(null);
  const syncing = syncingTarget !== null;

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try {
      const [{ providers: ps }, { models: ms }, keyStatusRes, healthRes] = await Promise.all([
        api.listProviders(),
        api.listModels(),
        api.providerKeyStatus().catch(() => ({ statuses: [] })),
        api.modelsHealth().catch(() => ({ rows: [] })),
      ]);
      setProviders(ps);
      setModels(ms);
      setHealthRows(new Map(healthRes.rows.map((row) => [row.model_id, row])));
      const ksMap = new Map<string, boolean>();
      for (const s of keyStatusRes.statuses) ksMap.set(s.provider_id, s.key_available);
      setKeyStatus(ksMap);
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
      if (!embedded && e.key === 'Escape' && !importDrawer) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, importDrawer, embedded]);

  const providerById = useMemo(
    () => new Map(providers.map((p) => [p.id, p])),
    [providers],
  );

  const providerStats = useMemo(() => {
    const stats = new Map<string, { total: number; enabled: number; disabled: number }>();
    for (const provider of providers) {
      stats.set(provider.id, { total: 0, enabled: 0, disabled: 0 });
    }
    for (const model of models) {
      if (!model.provider_id) continue;
      const row = stats.get(model.provider_id) ?? { total: 0, enabled: 0, disabled: 0 };
      row.total += 1;
      if (model.enabled) row.enabled += 1;
      else row.disabled += 1;
      stats.set(model.provider_id, row);
    }
    return stats;
  }, [models, providers]);

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

  const onSync = async (providerId?: string): Promise<void> => {
    setProviderMenuId(null);
    setSyncingTarget(providerId ?? 'all');
    setError(null);
    try {
      const res = await api.catalogSync(providerId);
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
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncingTarget(null);
    }
  };

  const onToggleEnabled = async (m: Model): Promise<void> => {
    try {
      await api.updateModel(m.id, { enabled: !m.enabled });
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSetDefault = async (m: Model): Promise<void> => {
    try {
      await api.setDefaultModel(m.id, m.capability as ModelCapability);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onDelete = async (m: Model): Promise<void> => {
    if (!window.confirm(`删除模型 “${m.display_name}”？`)) return;
    try {
      await api.deleteModel(m.id);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onDeleteProvider = async (p: Provider): Promise<void> => {
    setProviderMenuId(null);
    if (!window.confirm(`删除 Provider “${p.name}”？该 Provider 下的全部模型将一并删除。`)) return;
    try {
      await api.deleteProvider(p.id);
      await refresh();
      onChanged?.();
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
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const [editing, setEditing] = useState<Model | null>(null);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);

  const onSaveEdit = async (patch: import('@taori/shared').ModelUpdate): Promise<void> => {
    if (!editing) return;
    try {
      await api.updateModel(editing.id, patch);
      setEditing(null);
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSaveProviderEdit = async (patch: ProviderUpdate): Promise<void> => {
    if (!editingProvider) return;
    try {
      await api.updateProvider(editingProvider.id, patch);
      setEditingProvider(null);
      await refresh();
      onChanged?.();
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
  const [modelProbe, setModelProbe] = useState<{
    modelId: string;
    status: 'running' | 'done';
    ok?: boolean;
    note?: string;
  } | null>(null);

  const onTestProvider = async (p: Provider): Promise<void> => {
    setProviderMenuId(null);
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

  const onProbeModel = async (m: Model): Promise<void> => {
    setModelProbe({ modelId: m.id, status: 'running' });
    try {
      const res = await api.testModel(m.id);
      const probe = res.tools_probe;
      const note = probe
        ? probe.supported === true
          ? `Tools 支持已确认${probe.updated ? '，已自动开启' : ''}`
          : probe.supported === false
            ? `Tools 不支持已确认${probe.updated ? '，已自动关闭' : ''}`
            : `连通正常，但 Tools 探测不确定：${probe.message ?? probe.classification ?? '未知'}`
        : res.ok
          ? `连通正常：${res.latency_ms ?? 0}ms`
          : res.error?.message ?? res.note ?? '探测失败';
      setModelProbe({
        modelId: m.id,
        status: 'done',
        ok: res.ok && (probe?.supported !== false),
        note,
      });
      await refresh();
      onChanged?.();
    } catch (e) {
      setModelProbe({
        modelId: m.id,
        status: 'done',
        ok: false,
        note: e instanceof Error ? e.message : String(e),
      });
    }
  };

  useEffect(() => {
    setSelectedModelIds(new Set());
  }, [activeTab, modelQuery, providerFilter, statusFilter, featureFilter, sortKey]);

  const activeTabModels = (modelsByCap.get(activeTab) ?? [])
    .slice()
    .sort((a, b) => a.fallback_order - b.fallback_order);
  const query = modelQuery.trim().toLowerCase();
  const visibleModels = activeTabModels.filter((m) => {
    if (providerFilter !== 'all' && m.provider_id !== providerFilter) return false;
    if (statusFilter === 'enabled' && !m.enabled) return false;
    if (statusFilter === 'disabled' && m.enabled) return false;
    if (featureFilter === 'tools' && !m.supports_tools) return false;
    if (featureFilter === 'vision' && !m.supports_vision) return false;
    if (featureFilter === 'default' && m.is_default_for !== activeTab) return false;
    if (featureFilter === 'unknown_price' && primaryPrice(m) !== null) return false;
    if (!query) return true;
    const provider = m.provider_id ? providerById.get(m.provider_id) : null;
    const text = [
      m.alias,
      m.display_name,
      m.model_name,
      provider?.name,
      provider?.type,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return text.includes(query);
  }).slice().sort((a, b) => {
    if (sortKey === 'name') {
      return (a.alias ?? a.display_name ?? a.model_name).localeCompare(b.alias ?? b.display_name ?? b.model_name);
    }
    if (sortKey === 'price_low' || sortKey === 'price_high') {
      const ap = primaryPrice(a);
      const bp = primaryPrice(b);
      const an = ap == null ? Number.POSITIVE_INFINITY : ap;
      const bn = bp == null ? Number.POSITIVE_INFINITY : bp;
      return sortKey === 'price_low' ? an - bn : bn - an;
    }
    if (sortKey === 'context_desc') {
      return (b.context_length ?? -1) - (a.context_length ?? -1);
    }
    return a.fallback_order - b.fallback_order;
  });
  const tab = CAPABILITY_TABS.find((t) => t.id === activeTab)!;
  const activeEnabledCount = activeTabModels.filter((m) => m.enabled).length;
  const activeDisabledCount = activeTabModels.length - activeEnabledCount;
  const selectedVisibleIds = visibleModels
    .map((m) => m.id)
    .filter((id) => selectedModelIds.has(id));

  const toggleSelectModel = (id: string): void => {
    setSelectedModelIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = (): void => {
    setSelectedModelIds((current) => {
      const next = new Set(current);
      const allSelected = visibleModels.length > 0 && visibleModels.every((m) => next.has(m.id));
      for (const model of visibleModels) {
        if (allSelected) next.delete(model.id);
        else next.add(model.id);
      }
      return next;
    });
  };

  const onBulkEnabled = async (enabled: boolean): Promise<void> => {
    const ids = selectedVisibleIds;
    if (ids.length === 0) return;
    try {
      await Promise.all(ids.map((id) => api.updateModel(id, { enabled })));
      setSelectedModelIds(new Set());
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className={`model-center${editing ? ' is-editing' : ''}${embedded ? ' model-center--embedded' : ''}`}
      data-testid="model-center"
    >
      <header className="model-center__header">
        <div>
          <h2>模型中心</h2>
          <p className="hint">按 Provider 与能力管理模型库；先刷新供应商清单，再把常用模型导入并按需启停。</p>
        </div>
        <div className="model-center__header-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => void onSync()}
            disabled={syncing}
            data-testid="model-center-sync"
          >
            {syncingTarget === 'all' ? '同步中…' : '🔄 同步价格'}
          </button>
          {!embedded && (
            <button type="button" onClick={onClose} data-testid="model-center-close">
              关闭
            </button>
          )}
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
            {providers.map((p) => {
              const keyAvail = keyStatus.get(p.id);
              const keyMissing = p.api_key_ref && keyAvail === false;
              return (
              <li
                key={p.id}
                className={`provider-chip ${p.enabled ? '' : 'is-off'}`}
                data-testid={`provider-chip-${p.id}`}
              >
                <span className="provider-chip__name">{p.name}</span>
                <span className="provider-chip__type">{p.type}</span>
                {keyMissing && (
                  <span
                    className="provider-chip__key-warn"
                    title="API Key 不在 Keystore 中 — 请重新输入（开发模式重启后需要重新配置）"
                    data-testid={`provider-chip-key-warn-${p.id}`}
                  >
                    🔑
                  </span>
                )}
                <span
                  className="provider-chip__count"
                  data-testid={`provider-chip-count-${p.id}`}
                  title="已管理模型 / 启用 / 停用"
                >
                  {providerStats.get(p.id)?.total ?? 0} 个 · 开 {providerStats.get(p.id)?.enabled ?? 0} · 关 {providerStats.get(p.id)?.disabled ?? 0}
                </span>
                <button
                  type="button"
                  className="provider-chip__test"
                  onClick={() =>
                    setImportDrawer({
                      capability: 'all',
                      providerId: p.id,
                    })
                  }
                  data-testid={`provider-chip-library-${p.id}`}
                  title="打开供应商模型库并刷新候选清单"
                >
                  模型库
                </button>
                <div className="provider-chip__menu-wrap">
                  <button
                    type="button"
                    className="provider-chip__more"
                    onClick={() => setProviderMenuId((current) => (current === p.id ? null : p.id))}
                    data-testid={`provider-chip-more-${p.id}`}
                    aria-expanded={providerMenuId === p.id}
                    aria-haspopup="menu"
                    title="更多 Provider 操作"
                  >
                    更多
                  </button>
                  {providerMenuId === p.id && (
                    <div
                      className="provider-chip__menu"
                      role="menu"
                      data-testid={`provider-chip-menu-${p.id}`}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => void onSync(p.id)}
                        disabled={syncing}
                        data-testid={`provider-menu-sync-${p.id}`}
                        title="只同步该 Provider 的已管理模型价格与能力"
                      >
                        {syncingTarget === p.id ? '同步中' : '同步'}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setProviderMenuId(null);
                          setEditingProvider(p);
                        }}
                        data-testid={`provider-menu-edit-${p.id}`}
                        title="编辑 Provider 名称、Base URL、API Key 与启停状态"
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => void onTestProvider(p)}
                        data-testid={`provider-menu-test-${p.id}`}
                        title="测试连接"
                      >
                        测试
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="is-danger"
                        onClick={() => void onDeleteProvider(p)}
                        data-testid={`provider-menu-delete-${p.id}`}
                        aria-label={`删除 ${p.name}`}
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>
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
              );
            })}
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
            <p className="hint">
              {tab.hint} · 已管理 {activeTabModels.length} 个，启用 {activeEnabledCount} 个，停用 {activeDisabledCount} 个
            </p>
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
        <div className="model-center__filters" data-testid="model-center-filters">
          <label>
            搜索
            <input
              type="search"
              value={modelQuery}
              onChange={(e) => setModelQuery(e.target.value)}
              placeholder="模型名、别名、Provider…"
              data-testid="model-center-search"
            />
          </label>
          <label>
            Provider
            <select
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value)}
              data-testid="model-center-provider-filter"
            >
              <option value="all">全部 Provider</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            状态
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | 'enabled' | 'disabled')}
              data-testid="model-center-status-filter"
            >
              <option value="all">全部状态</option>
              <option value="enabled">只看启用</option>
              <option value="disabled">只看停用</option>
            </select>
          </label>
          <label>
            特性
            <select
              value={featureFilter}
              onChange={(e) => setFeatureFilter(e.target.value as ModelFeatureFilter)}
              data-testid="model-center-feature-filter"
            >
              <option value="all">全部特性</option>
              <option value="tools">支持工具调用</option>
              <option value="vision">支持视觉输入</option>
              <option value="default">当前默认模型</option>
              <option value="unknown_price">价格未知</option>
            </select>
          </label>
          <label>
            排序
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as ModelSortKey)}
              data-testid="model-center-sort"
            >
              <option value="priority">兜底优先级</option>
              <option value="name">模型名称</option>
              <option value="price_low">价格从低到高</option>
              <option value="price_high">价格从高到低</option>
              <option value="context_desc">上下文从大到小</option>
            </select>
          </label>
          <div className="model-center__bulk" data-testid="model-center-bulk-actions">
            <span>已选 {selectedVisibleIds.length} 个</span>
            <button
              type="button"
              disabled={selectedVisibleIds.length === 0}
              onClick={() => void onBulkEnabled(true)}
              data-testid="model-center-bulk-enable"
            >
              批量启用
            </button>
            <button
              type="button"
              disabled={selectedVisibleIds.length === 0}
              onClick={() => void onBulkEnabled(false)}
              data-testid="model-center-bulk-disable"
            >
              批量停用
            </button>
          </div>
        </div>
        {loading ? (
          <p className="hint">加载中…</p>
        ) : visibleModels.length === 0 ? (
          <p className="hint">
            当前筛选下没有 <strong>{tab.label}</strong> 模型。可以调整筛选，或点击右上“+ 导入模型”刷新供应商模型库。
          </p>
        ) : (
          <table className="model-matrix" data-testid="model-matrix">
            <thead>
              <tr>
                <th className="model-matrix__select">
                  <input
                    type="checkbox"
                    checked={visibleModels.length > 0 && visibleModels.every((m) => selectedModelIds.has(m.id))}
                    onChange={toggleSelectAllVisible}
                    aria-label="选择当前筛选下全部模型"
                    data-testid="model-center-select-all"
                  />
                </th>
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
                  <Fragment key={m.id}>
                    <tr data-testid={`model-row-${m.id}`}>
                      <td className="model-matrix__select">
                        <input
                          type="checkbox"
                          checked={selectedModelIds.has(m.id)}
                          onChange={() => toggleSelectModel(m.id)}
                          aria-label={`选择 ${m.display_name}`}
                          data-testid={`model-row-select-${m.id}`}
                        />
                      </td>
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
                            disabled={isDefault || !m.enabled}
                            data-testid={`model-row-default-${m.id}`}
                            title={!m.enabled ? '停用模型不能设为默认' : undefined}
                          >
                            {isDefault ? '已是默认' : m.enabled ? '设为默认' : '停用中'}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedModelId((current) => (current === m.id ? null : m.id))
                            }
                            data-testid={`model-health-toggle-${m.id}`}
                          >
                            {expandedModelId === m.id ? '收起健康' : '健康'}
                          </button>
                          {(m.capability === 'chat' || m.capability === 'multimodal') && (
                            <button
                              type="button"
                              onClick={() => void onProbeModel(m)}
                              disabled={modelProbe?.modelId === m.id && modelProbe.status === 'running'}
                              data-testid={`model-tools-probe-${m.id}`}
                              title="真实请求探测该模型是否接受 OpenAI tools 参数"
                            >
                              {modelProbe?.modelId === m.id && modelProbe.status === 'running'
                                ? '探测中'
                                : '探测Tools'}
                            </button>
                          )}
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
                    {modelProbe?.modelId === m.id && modelProbe.status === 'done' && (
                      <tr className="model-health-row" data-testid={`model-tools-probe-result-${m.id}`}>
                        <td colSpan={6}>
                          <div className={`model-probe-result ${modelProbe.ok ? 'ok' : 'bad'}`}>
                            {modelProbe.note}
                          </div>
                        </td>
                      </tr>
                    )}
                    {expandedModelId === m.id && (
                      <tr className="model-health-row" data-testid={`model-health-panel-${m.id}`}>
                        <td colSpan={6}>
                          <ModelHealthPanel health={healthRows.get(m.id) ?? null} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
            onChanged?.();
          }}
          onModelsChanged={async () => {
            await refresh();
            onChanged?.();
          }}
          onProviderSynced={async (providerId) => {
            await onSync(providerId);
          }}
        />
      )}
      {editingProvider && (
        <EditProviderDialog
          provider={editingProvider}
          onCancel={() => setEditingProvider(null)}
          onSave={(patch) => void onSaveProviderEdit(patch)}
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

function ModelHealthPanel({
  health,
}: {
  health: ModelHealthRow | null;
}): JSX.Element {
  const row = health ?? {
    model_id: '',
    calls_24h: 0,
    failures_24h: 0,
    avg_first_token_ms: null,
    avg_duration_ms: null,
    last_failure_at: null,
    last_failure_classification: null,
  };

  const lastFailureText = row.last_failure_classification
    ? `${FAILURE_LABELS[row.last_failure_classification] ?? row.last_failure_classification} · ${formatAgo(row.last_failure_at)}`
    : '—';

  return (
    <div className="model-health-panel">
      <div className="model-health-panel__cards">
        <article className="model-health-card">
          <span className="model-health-card__label">最近 24h 调用</span>
          <strong data-testid="model-health-calls">{row.calls_24h}</strong>
        </article>
        <article className="model-health-card">
          <span className="model-health-card__label">最近 24h 失败</span>
          <strong data-testid="model-health-failures">{row.failures_24h}</strong>
        </article>
        <article className="model-health-card">
          <span className="model-health-card__label">平均首字延迟</span>
          <strong data-testid="model-health-ttfb">{formatMetricMs(row.avg_first_token_ms)}</strong>
        </article>
        <article className="model-health-card">
          <span className="model-health-card__label">平均总耗时</span>
          <strong>{formatMetricMs(row.avg_duration_ms)}</strong>
        </article>
      </div>
      <div className="model-health-panel__footer">
        <span className="model-health-panel__footer-label">最近失败分类</span>
        <strong data-testid="model-health-last-failure">{lastFailureText}</strong>
      </div>
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
function ImportDrawer({
  providers,
  existingModels,
  initialCapability,
  initialProviderId,
  onClose,
  onImported,
  onModelsChanged,
  onProviderSynced,
}: {
  providers: Provider[];
  existingModels: Model[];
  initialCapability: ImportCapabilityFilter;
  initialProviderId: string | null;
  onClose: () => void;
  onImported: () => Promise<void>;
  onModelsChanged: () => Promise<void>;
  onProviderSynced: (providerId: string) => Promise<void>;
}): JSX.Element {
  const [providerId, setProviderId] = useState<string | null>(initialProviderId);
  const [capability, setCapability] = useState<ImportCapabilityFilter>(initialCapability);
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
  const [filter, setFilter] = useState('');
  const [libraryStatus, setLibraryStatus] = useState<'all' | 'unmanaged' | 'enabled' | 'disabled'>('all');
  const [discovering, setDiscovering] = useState(false);
  const [importing, setImporting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [importEnabled, setImportEnabled] = useState(true);
  const [syncingManaged, setSyncingManaged] = useState(false);

  const discover = async (): Promise<void> => {
    if (!providerId) return;
    setDiscovering(true);
    setErr(null);
    setPicked(new Set());
    setDiscovered([]);
    try {
      const res = await api.discoverModels(providerId);
      setDiscovered(res.models);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscovering(false);
    }
  };

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

  const existingByName = useMemo(
    () =>
      new Map(
        existingModels
          .filter((m) => m.provider_id === providerId)
          .map((m) => [m.model_name, m]),
      ),
    [existingModels, providerId],
  );

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    // Discovery is always provider-wide; this only filters the visible library.
    // Multimodal also shows under chat to match the matrix view.
    const capMatch = (m: DiscoveredModel) => {
      if (capability === 'all') return true;
      if (capability === 'chat') return m.capability === 'chat' || m.capability === 'multimodal';
      return m.capability === capability;
    };
    return discovered
      .filter(capMatch)
      .filter((m) => {
        const existing = existingByName.get(m.model_name);
        if (libraryStatus === 'unmanaged') return !existing;
        if (libraryStatus === 'enabled') return existing?.enabled === true;
        if (libraryStatus === 'disabled') return existing?.enabled === false;
        return true;
      })
      .filter((m) =>
        f === ''
          ? true
          : m.model_name.toLowerCase().includes(f) ||
            (m.display_name ?? '').toLowerCase().includes(f),
      );
  }, [discovered, filter, capability, existingByName, libraryStatus]);

  const managedDiffs = useMemo(
    () =>
      discovered
        .map((m) => managedDiff(existingByName.get(m.model_name), m))
        .filter((diff): diff is ManagedModelDiff => diff !== null),
    [discovered, existingByName],
  );
  const changedManagedCount = managedDiffs.length;

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
          enabled: importEnabled,
        });
      }
      await onImported();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const onToggleExisting = async (model: Model): Promise<void> => {
    setErr(null);
    try {
      await api.updateModel(model.id, { enabled: !model.enabled });
      await onModelsChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const onSyncManaged = async (): Promise<void> => {
    if (!providerId) return;
    setErr(null);
    setSyncingManaged(true);
    try {
      await onProviderSynced(providerId);
      await discover();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncingManaged(false);
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

        {changedManagedCount > 0 && (
          <div className="import-drawer__sync" data-testid="import-drawer-managed-sync">
            <div>
              <strong>发现 {changedManagedCount} 个已管理模型可同步</strong>
              <p className="hint">只更新价格、能力、上下文、视觉/工具支持，不会改别名、默认、启停和排序。</p>
              <details className="import-drawer__diff-preview" data-testid="import-drawer-diff-preview">
                <summary>查看变更预览</summary>
                <ul>
                  {managedDiffs.slice(0, 20).map((diff) => (
                    <li key={diff.model.id}>
                      <span>{diff.model.display_name ?? diff.model.model_name}</span>
                      <em>{diff.changes.join('；')}</em>
                    </li>
                  ))}
                </ul>
                {managedDiffs.length > 20 && (
                  <p className="hint">还有 {managedDiffs.length - 20} 个模型未展开显示。</p>
                )}
              </details>
            </div>
            <button
              type="button"
              onClick={() => void onSyncManaged()}
              disabled={!providerId || syncingManaged}
              data-testid="import-drawer-sync-managed"
            >
              {syncingManaged ? '同步中…' : '同步已管理模型'}
            </button>
          </div>
        )}

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
            展示能力
            <select
              value={capability}
              onChange={(e) => setCapability(e.target.value as ImportCapabilityFilter)}
              data-testid="import-drawer-capability"
            >
              <option value="all">全部能力</option>
              {CAPABILITY_TABS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            状态
            <select
              value={libraryStatus}
              onChange={(e) => setLibraryStatus(e.target.value as 'all' | 'unmanaged' | 'enabled' | 'disabled')}
              data-testid="import-drawer-status"
            >
              <option value="all">全部候选</option>
              <option value="unmanaged">只看未管理</option>
              <option value="enabled">只看已启用</option>
              <option value="disabled">只看已停用</option>
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
          <button
            type="button"
            onClick={() => void discover()}
            disabled={!providerId || discovering}
            data-testid="import-drawer-refresh"
          >
            {discovering ? '刷新中…' : '刷新全部清单'}
          </button>
        </div>

        <p className="hint" data-testid="import-drawer-counts">
          刷新会拉取该 Provider 的全部能力清单；当前展示 {filtered.length} / 已刷新 {discovered.length} 个候选。
        </p>

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
              const existing = existingByName.get(m.model_name);
              const isExisting = Boolean(existing);
              const isPicked = picked.has(m.model_name);
              const diff = managedDiff(existing, m);
              const hasManagedDiff = diff !== null;
              const priceHint = discoveredPrice(m);
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
                      data-testid={`import-drawer-pick-${m.model_name}`}
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
                      {priceHint == null ? ' · 价格未知' : ''}
                    </span>
                    {existing ? (
                      <>
                        <span className={`badge ${existing.enabled ? 'badge--default' : ''}`}>
                          {existing.enabled ? '已启用' : '已停用'}
                        </span>
                        {hasManagedDiff && (
                          <span
                            className="badge badge--price_changed"
                            data-testid={`import-drawer-diff-${existing.id}`}
                            title={diff.changes.join('；')}
                          >
                            可同步
                          </span>
                        )}
                        {diff && <span className="import-row__diff">{diff.changes[0]}</span>}
                        <button
                          type="button"
                          className="import-row__toggle"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void onToggleExisting(existing);
                          }}
                          data-testid={`import-drawer-toggle-${existing.id}`}
                        >
                          {existing.enabled ? '停用' : '启用'}
                        </button>
                      </>
                    ) : (
                      <span className="badge">未管理</span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <footer className="import-drawer__foot">
          <label className="field-inline">
            <input
              type="checkbox"
              checked={importEnabled}
              onChange={(e) => setImportEnabled(e.target.checked)}
              data-testid="import-drawer-import-enabled"
            />
            <span>导入后立即启用</span>
          </label>
          <span className="hint">
            已选 {picked.size} 项 / 当前展示 {filtered.length} 个候选
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
// EditProviderDialog — provider metadata, endpoint, key refresh and enablement.
// ----------------------------------------------------------------------------
function EditProviderDialog({
  provider,
  onCancel,
  onSave,
}: {
  provider: Provider;
  onCancel: () => void;
  onSave: (patch: ProviderUpdate) => void;
}): JSX.Element {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.base_url);
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(provider.enabled);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const patch: ProviderUpdate = {
      name: name.trim() || provider.name,
      base_url: baseUrl.trim() || provider.base_url,
      enabled,
    };
    if (apiKey.trim()) {
      patch.api_key = apiKey.trim();
    }
    onSave(patch);
  };

  return (
    <div className="modal-backdrop" onClick={onCancel} data-testid="provider-editor-backdrop">
      <div
        className="modal-card provider-editor"
        onClick={(e) => e.stopPropagation()}
        data-testid="provider-editor"
        role="dialog"
        aria-modal="true"
        aria-label="编辑 Provider"
      >
        <header className="modal-card__head">
          <div>
            <h3>编辑 Provider</h3>
            <p className="hint">{provider.type}</p>
          </div>
          <button type="button" onClick={onCancel} aria-label="关闭">
            ✕
          </button>
        </header>
        <form onSubmit={submit} className="model-editor__body">
          <label className="field">
            <span>名称</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="provider-editor-name"
            />
          </label>
          <label className="field">
            <span>Base URL</span>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              data-testid="provider-editor-base-url"
            />
          </label>
          <label className="field">
            <span>API Key（留空则保持当前 Key）</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider.api_key_ref ? '已配置，输入新 Key 可替换' : '未配置，请输入 Key'}
              data-testid="provider-editor-api-key"
            />
          </label>
          <label className="field-inline">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              data-testid="provider-editor-enabled"
            />
            <span>启用该 Provider（关闭后不参与全局价格同步，已导入模型仍可管理）</span>
          </label>
          <footer className="model-editor__foot">
            <button type="button" onClick={onCancel} data-testid="provider-editor-cancel">
              取消
            </button>
            <button type="submit" className="btn-primary" data-testid="provider-editor-save">
              保存
            </button>
          </footer>
        </form>
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
