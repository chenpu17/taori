import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { DiscoveredModel, Model, Provider, ProviderType } from '@taori/shared';
import { Icon } from './Icon';
import { useDialog } from './Dialog';
import { useToast } from './Toast';
import { AddModelWizard } from './AddModelWizard';
import {
  adminClearAllData,
  adminExportData,
  adminImportData,
  catalogSync,
  createModel,
  deleteProviderKey,
  deleteModel,
  deleteProvider,
  discoverProvider,
  health,
  listModelHealth,
  listProviderKeyStatus,
  patchModel,
  patchProvider,
  recommendModels,
  resetModelHealth,
  reorderModels,
  runSelfCheck,
  setModelDefault,
  testModel,
  testProvider,
  type DiscoveryResponse,
  type ModelHealthRow,
} from './api';

type Theme = 'light' | 'dark' | 'auto';
type Density = 'compact' | 'regular' | 'comfy';
const CHAT_DEFAULT_CAPABILITY = 'chat';

export type SettingsTab = 'model' | 'providers' | 'appearance' | 'general';

interface SettingsViewProps {
  providers: Provider[];
  models: Model[];
  loading: boolean;
  selectedModelId: string | null;
  onSelectDefault: (model: Model) => Promise<void>;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
  onToast: (message: string) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  density: Density;
  onDensityChange: (density: Density) => void;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
}

const PROVIDER_TYPE_LABEL: Partial<Record<ProviderType, string>> = {
  volcengine_ark: '火山方舟',
  huawei_maas: 'Huawei MaaS',
  packyapi: 'PackyAPI',
  siliconflow: 'SiliconFlow',
  sd_webui: 'SD WebUI',
};

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function modelGlyph(model: Model): string {
  const source = model.alias || model.display_name || model.model_name;
  return source.charAt(0).toUpperCase();
}

function modelLabel(model: Model): string {
  return model.alias ?? model.display_name ?? model.model_name;
}

function pricePerMillion(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value === 0) return '免费';
  if (value < 0.01) return '< $0.01';
  return `$${value.toFixed(2)}`;
}

function formatContext(context: number | null | undefined): string {
  if (!context) return '';
  if (context >= 1_000_000) return `${(context / 1_000_000).toFixed(1)}M`;
  if (context >= 1_000) return `${Math.round(context / 1000)}K`;
  return String(context);
}

function formatDurationFromNow(timestamp: number): string {
  const diff = Math.max(0, timestamp - Date.now());
  const minutes = Math.ceil(diff / 60_000);
  if (minutes <= 1) return '约 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.ceil(hours / 24)} 天`;
}

function formatTime(timestamp: number | null | undefined): string | null {
  if (!timestamp) return null;
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function failureLabel(classification: string | null | undefined): string {
  switch (classification) {
    case 'auth':
      return '鉴权失败';
    case 'quota':
      return '额度不足';
    case 'rate_limit':
      return '限流';
    case 'network':
      return '网络失败';
    case 'content_filter':
      return '内容过滤';
    case 'config_error':
      return '配置错误';
    case 'key_missing':
      return '缺少 Key';
    case 'unknown':
      return '未知失败';
    default:
      return classification ?? '无';
  }
}

function providerLabel(type: ProviderType): string {
  return PROVIDER_TYPE_LABEL[type] ?? type;
}

function isChatCapable(model: Model): boolean {
  return model.capability === 'chat' || model.capability === 'multimodal';
}

function isModelTemporarilyDisabled(model: Model, now = Date.now()): boolean {
  return model.disabled_until != null && model.disabled_until > now;
}

function isModelUsable(model: Model, provider: Provider | undefined, now = Date.now()): boolean {
  return (
    model.enabled &&
    provider?.enabled === true &&
    !model.demoted &&
    !isModelTemporarilyDisabled(model, now)
  );
}

function modelAvailability(model: Model, provider: Provider | undefined, now = Date.now()): {
  kind: 'available' | 'needs_action' | 'avoid' | 'off';
  label: string;
  detail: string;
} {
  if (!model.enabled) {
    return { kind: 'off', label: '已停用', detail: '不会被聊天、对比或备援自动选中。' };
  }
  if (provider?.enabled !== true) {
    return { kind: 'needs_action', label: '需要处理', detail: '服务商已停用，启用服务商后才能调用。' };
  }
  if (model.demoted) {
    return { kind: 'avoid', label: '暂时避开', detail: '近期失败较多，Taori 会降低它的优先级。' };
  }
  if (isModelTemporarilyDisabled(model, now)) {
    return { kind: 'avoid', label: '暂时避开', detail: `${formatDurationFromNow(model.disabled_until!)} 后自动恢复候选。` };
  }
  if (model.failure_count_24h > 0) {
    return { kind: 'needs_action', label: '需要处理', detail: `最近连续失败 ${model.failure_count_24h} 次，建议探测或恢复可用。` };
  }
  return { kind: 'available', label: '可用', detail: '可用于聊天、对比和备援。' };
}

function closeMenuAfterAction(event: MouseEvent<HTMLElement>): void {
  const details = event.currentTarget.closest('details');
  if (details) details.open = false;
}

const COLOR_PALETTE = ['#C26A4A', '#5A7BA8', '#7A8E6E', '#C58B3A', '#8B6BAE', '#6E6259'];

function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  }
  return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length]!;
}

export function SettingsView(props: SettingsViewProps): JSX.Element {
  return (
    <>
      <div className="topbar with-border">
        <div className="topbar-title">设置</div>
      </div>
      <div className="settings-shell">
        <nav className="settings-nav scroll">
          <div className="nav-h">偏好</div>
          <button
            type="button"
            className={props.tab === 'model' ? 'active' : ''}
            onClick={() => props.onTabChange('model')}
          >
            模型
          </button>
          <button
            type="button"
            className={props.tab === 'providers' ? 'active' : ''}
            onClick={() => props.onTabChange('providers')}
          >
            服务商
          </button>
          <button
            type="button"
            className={props.tab === 'appearance' ? 'active' : ''}
            onClick={() => props.onTabChange('appearance')}
          >
            外观
          </button>
          <button
            type="button"
            className={props.tab === 'general' ? 'active' : ''}
            onClick={() => props.onTabChange('general')}
          >
            通用
          </button>
        </nav>
        <div className="settings-body scroll">
          {props.tab === 'model' && <ModelSettings {...props} />}
          {props.tab === 'providers' && <ProviderSettings {...props} />}
          {props.tab === 'appearance' && (
            <AppearanceSettings
              theme={props.theme}
              onThemeChange={props.onThemeChange}
              density={props.density}
              onDensityChange={props.onDensityChange}
            />
          )}
          {props.tab === 'general' && <GeneralSettings />}
        </div>
      </div>
    </>
  );
}

function ModelSettings(props: SettingsViewProps): JSX.Element {
  const [editingAliasFor, setEditingAliasFor] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState('');
  const [healthRows, setHealthRows] = useState<ModelHealthRow[]>([]);
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [capabilityFilter, setCapabilityFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set());
  const dialog = useDialog();

  const providerById = useMemo(
    () => new Map(props.providers.map((provider) => [provider.id, provider])),
    [props.providers],
  );

  const chatModels = useMemo(
    () => props.models.filter(isChatCapable),
    [props.models],
  );
  const usableChatModels = useMemo(
    () => chatModels.filter((model) => isModelUsable(model, model.provider_id ? providerById.get(model.provider_id) : undefined)),
    [chatModels, providerById],
  );

  const noChatModels = usableChatModels.length === 0;
  const currentDefaultModel =
    usableChatModels.find((model) => model.id === props.selectedModelId) ??
    usableChatModels.find((model) => model.is_default_for === CHAT_DEFAULT_CAPABILITY) ??
    null;
  const currentDefaultProvider = currentDefaultModel
    ? currentDefaultModel.provider_id ? providerById.get(currentDefaultModel.provider_id) : undefined
    : null;
  const availabilityCounts = useMemo(() => {
    const counts = { available: 0, needs_action: 0, avoid: 0, off: 0 };
    for (const model of props.models) {
      const provider = model.provider_id ? providerById.get(model.provider_id) : undefined;
      counts[modelAvailability(model, provider).kind] += 1;
    }
    return counts;
  }, [props.models, providerById]);
  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    return props.models.filter((model) => {
      const provider = model.provider_id ? providerById.get(model.provider_id) : undefined;
      if (providerFilter !== 'all' && model.provider_id !== providerFilter) return false;
      if (capabilityFilter !== 'all' && model.capability !== capabilityFilter) return false;
      if (statusFilter === 'available' && !isModelUsable(model, provider)) return false;
      if (statusFilter === 'unavailable' && isModelUsable(model, provider)) return false;
      if (statusFilter === 'default' && model.is_default_for !== CHAT_DEFAULT_CAPABILITY) return false;
      if (!query) return true;
      return [
        model.alias,
        model.display_name,
        model.model_name,
        model.capability,
        provider?.name,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [capabilityFilter, modelQuery, props.models, providerById, providerFilter, statusFilter]);
  const healthByModel = useMemo(
    () => new Map(healthRows.map((row) => [row.model_id, row])),
    [healthRows],
  );
  const visibleModelIds = useMemo(
    () => new Set(filteredModels.map((model) => model.id)),
    [filteredModels],
  );
  const selectedVisibleCount = filteredModels.filter((model) => selectedModelIds.has(model.id)).length;
  const allVisibleSelected = filteredModels.length > 0 && selectedVisibleCount === filteredModels.length;

  useEffect(() => {
    setSelectedModelIds(new Set());
  }, [capabilityFilter, modelQuery, providerFilter, statusFilter]);

  async function refreshHealth(): Promise<void> {
    try {
      setHealthRows(await listModelHealth());
      props.onToast('模型健康已刷新。');
    } catch (error) {
      props.onError(describeError(error));
    }
  }

  async function recommendDefault(task: 'general' | 'fast' | 'cheap' | 'coding'): Promise<void> {
    try {
      const result = await recommendModels({
        capability: 'chat',
        task,
        current_model_id: props.selectedModelId ?? undefined,
        limit: 3,
      });
      const recommended = props.models.find((model) => model.id === result.recommended_model_id);
      if (!recommended) {
        props.onToast('没有可推荐的模型。');
        return;
      }
      await props.onSelectDefault(recommended);
    } catch (error) {
      props.onError(describeError(error));
    }
  }

  function toggleModelSelection(modelId: string): void {
    setSelectedModelIds((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }

  function toggleVisibleSelection(): void {
    setSelectedModelIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const id of visibleModelIds) next.delete(id);
      } else {
        for (const id of visibleModelIds) next.add(id);
      }
      return next;
    });
  }

  async function deleteSelectedModels(): Promise<void> {
    const selected = filteredModels.filter((model) => selectedModelIds.has(model.id));
    if (selected.length === 0) return;
    const ok = await dialog.confirm({
      title: `删除 ${selected.length} 个模型？`,
      description: '只是从这里移除这些模型项，服务商、API Key 和已聊过的会话不受影响。',
      tone: 'danger',
      okLabel: '删除',
    });
    if (!ok) return;
    try {
      for (const model of selected) {
        await deleteModel(model.id);
      }
      setSelectedModelIds(new Set());
      props.onToast(`已删除 ${selected.length} 个模型。`);
      await props.onRefresh();
    } catch (error) {
      props.onError(describeError(error));
      await props.onRefresh();
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">模型</h2>
          <p className="page-sub">管理模型可用性、默认聊天模型和备援顺序。</p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => setWizardOpen(true)}
            data-testid="model-add"
          >
            <Icon name="plus" size={12} /> 添加模型
          </button>
          <details className="menu-pop" data-testid="model-recommend-menu">
            <summary className="btn-quiet">
              推荐 <Icon name="chevronDown" size={10} />
            </summary>
            <div className="menu-pop-list" role="menu" onClick={closeMenuPopOnSelect}>
              <button type="button" role="menuitem" onClick={() => void recommendDefault('general')} data-testid="model-recommend-general">推荐默认 · 综合最佳</button>
              <button type="button" role="menuitem" onClick={() => void recommendDefault('fast')} data-testid="model-recommend-fast">推荐最快 · 低延迟</button>
              <button type="button" role="menuitem" onClick={() => void recommendDefault('cheap')} data-testid="model-recommend-cheap">推荐低成本 · 高性价比</button>
              <button type="button" role="menuitem" onClick={() => void recommendDefault('coding')}>推荐编码 · 写代码强</button>
              <div className="menu-pop-divider" />
              <button type="button" role="menuitem" onClick={() => void refreshHealth()} data-testid="model-health-refresh">刷新健康数据</button>
            </div>
          </details>
        </div>
      </div>

      {noChatModels && (
        <div className="cta-banner" data-testid="model-settings-cta">
          <div className="cta-glyph">+</div>
          <div className="cta-body">
            <div className="cta-title">还没添加任何模型</div>
            <div className="cta-sub">30 秒接入：选一个服务商（推荐 OpenRouter 或 DeepSeek）→ 填 Key → 一键发现。</div>
          </div>
          <button
            type="button"
            className="cta-action"
            onClick={() => setWizardOpen(true)}
            data-testid="empty-add-model-cta"
          >
            添加第一个模型 →
          </button>
        </div>
      )}

      {wizardOpen && (
        <AddModelWizard
          providers={props.providers}
          existingModels={props.models}
          onClose={() => setWizardOpen(false)}
          onDone={async () => {
            await props.onRefresh();
          }}
          onToast={props.onToast}
          onError={props.onError}
        />
      )}

      {!noChatModels && currentDefaultModel && (
        <section className="model-default-summary" data-testid="model-default-summary">
          <div
            className="glyph"
            style={{
              background: `color-mix(in oklab, ${colorFor(currentDefaultModel.id)} 14%, transparent)`,
              color: colorFor(currentDefaultModel.id),
            }}
          >
            {modelGlyph(currentDefaultModel)}
          </div>
          <div className="summary-main">
            <div className="eyebrow">当前默认聊天模型</div>
            <div className="summary-name">{modelLabel(currentDefaultModel)}</div>
            <div className="summary-meta">
              {currentDefaultProvider?.name ?? currentDefaultModel.provider_id}
              <span>·</span>
              {currentDefaultModel.model_name}
              {currentDefaultModel.context_length ? (
                <>
                  <span>·</span>
                  {formatContext(currentDefaultModel.context_length)}
                </>
              ) : null}
            </div>
          </div>
          <div className="summary-stats">
            <span>{usableChatModels.length}/{chatModels.length} 个聊天模型可用</span>
            <span>可用 {availabilityCounts.available} · 需处理 {availabilityCounts.needs_action}</span>
            {(availabilityCounts.avoid > 0 || availabilityCounts.off > 0) && (
              <span>暂时避开 {availabilityCounts.avoid} · 已停用 {availabilityCounts.off}</span>
            )}
          </div>
        </section>
      )}

      <div className="model-list-head">
        <div>
          <div className="section-h">模型清单</div>
          <div className="muted">
            {filteredModels.length}/{props.models.length} 个模型
          </div>
        </div>
        <div className="model-list-tools">
          <input
            value={modelQuery}
            onChange={(event) => setModelQuery(event.target.value)}
            placeholder="搜索模型、ID、服务商"
            aria-label="搜索模型"
            data-testid="model-search"
          />
          <select
            value={providerFilter}
            onChange={(event) => setProviderFilter(event.target.value)}
            aria-label="按服务商筛选"
            data-testid="model-provider-filter"
          >
            <option value="all">全部服务商</option>
            {props.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
          <select
            value={capabilityFilter}
            onChange={(event) => setCapabilityFilter(event.target.value)}
            aria-label="按能力筛选"
            data-testid="model-capability-filter"
          >
            <option value="all">全部能力</option>
            <option value="chat">聊天</option>
            <option value="multimodal">多模态</option>
            <option value="embedding">Embedding</option>
            <option value="image">图像</option>
            <option value="rerank">Rerank</option>
          </select>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            aria-label="按状态筛选"
            data-testid="model-status-filter"
          >
            <option value="all">全部状态</option>
            <option value="available">可用</option>
            <option value="unavailable">需处理</option>
            <option value="default">默认 chat</option>
          </select>
        </div>
      </div>
      <ModelGroups
        models={filteredModels}
        totalModelCount={props.models.length}
        providers={props.providers}
        selectedModelIds={selectedModelIds}
        selectedVisibleCount={selectedVisibleCount}
        allVisibleSelected={allVisibleSelected}
        onToggleSelect={toggleModelSelection}
        onToggleSelectAll={toggleVisibleSelection}
        onClearSelection={() => setSelectedModelIds(new Set())}
        onDeleteSelected={() => void deleteSelectedModels()}
        editingAliasFor={editingAliasFor}
        aliasDraft={aliasDraft}
        onStartEditAlias={(model) => {
          setEditingAliasFor(model.id);
          setAliasDraft(model.alias ?? '');
        }}
        onCancelEditAlias={() => {
          setEditingAliasFor(null);
          setAliasDraft('');
        }}
        onAliasDraftChange={setAliasDraft}
        onCommitAlias={async (model) => {
          const trimmed = aliasDraft.trim();
          const nextAlias = trimmed.length === 0 ? null : trimmed;
          if (nextAlias === (model.alias ?? null)) {
            setEditingAliasFor(null);
            setAliasDraft('');
            return;
          }
          try {
            await patchModel(model.id, { alias: nextAlias });
            props.onToast('已更新模型别名。');
            setEditingAliasFor(null);
            setAliasDraft('');
            await props.onRefresh();
          } catch (error) {
            props.onError(describeError(error));
          }
        }}
        onToggle={async (model) => {
          try {
            await patchModel(model.id, { enabled: !model.enabled });
            await props.onRefresh();
          } catch (error) {
            props.onError(describeError(error));
          }
        }}
        onEnable={async (model) => {
          try {
            await patchModel(model.id, { enabled: true });
            props.onToast(`${modelLabel(model)} 已启用。`);
            await props.onRefresh();
          } catch (error) {
            props.onError(describeError(error));
          }
        }}
        onDefault={async (model) => {
          try {
            await setModelDefault(model.id, CHAT_DEFAULT_CAPABILITY);
            props.onToast('已设为默认 chat。');
            await props.onRefresh();
          } catch (error) {
            props.onError(describeError(error));
          }
        }}
        onTest={async (model) => {
          setTestingModelId(model.id);
          try {
            const result = await testModel(model.id);
            props.onToast(
              result.ok
                ? `${modelLabel(model)} 可用 · ${result.latency_ms ?? 0}ms`
                : result.error?.message ?? '模型探测失败',
            );
            await refreshHealth();
          } catch (error) {
            props.onError(describeError(error));
          } finally {
            setTestingModelId(null);
          }
        }}
        onResetHealth={async (model) => {
          try {
            await resetModelHealth(model.id);
            await props.onRefresh();
            await refreshHealth();
            props.onToast(`${modelLabel(model)} 已恢复为可用候选。`);
          } catch (error) {
            props.onError(describeError(error));
          }
        }}
        onMove={async (model, direction) => {
          const current = props.models
            .filter((item) => item.capability === model.capability)
            .sort((a, b) => a.fallback_order - b.fallback_order);
          const index = current.findIndex((item) => item.id === model.id);
          const targetIndex = direction === 'up' ? index - 1 : index + 1;
          if (index < 0 || targetIndex < 0 || targetIndex >= current.length) return;
          const next = [...current];
          const [item] = next.splice(index, 1);
          if (!item) return;
          next.splice(targetIndex, 0, item);
          try {
            await reorderModels(model.capability, next.map((entry) => entry.id));
            await props.onRefresh();
            props.onToast('备援顺序已更新。');
          } catch (error) {
            props.onError(describeError(error));
          }
        }}
        healthByModel={healthByModel}
        testingModelId={testingModelId}
        onDelete={async (model) => {
          const ok = await dialog.confirm({
            title: `删除模型 ${modelLabel(model)}？`,
            description: '只是从这里移除该模型项，服务商和已聊过的会话不受影响。',
            tone: 'danger',
            okLabel: '删除',
          });
          if (!ok) return;
          try {
            await deleteModel(model.id);
            props.onToast('已删除。');
            await props.onRefresh();
          } catch (error) {
            props.onError(describeError(error));
          }
        }}
      />
    </>
  );
}

interface ModelTableProps {
  models: Model[];
  totalModelCount: number;
  providers: Provider[];
  selectedModelIds: Set<string>;
  selectedVisibleCount: number;
  allVisibleSelected: boolean;
  onToggleSelect: (modelId: string) => void;
  onToggleSelectAll: () => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
  editingAliasFor: string | null;
  aliasDraft: string;
  onStartEditAlias: (model: Model) => void;
  onCancelEditAlias: () => void;
  onAliasDraftChange: (value: string) => void;
  onCommitAlias: (model: Model) => Promise<void>;
  onToggle: (model: Model) => void;
  onEnable: (model: Model) => void;
  onDefault: (model: Model) => void;
  onTest: (model: Model) => void;
  onResetHealth: (model: Model) => void;
  onMove: (model: Model, direction: 'up' | 'down') => void;
  healthByModel: Map<string, ModelHealthRow>;
  testingModelId: string | null;
  onDelete: (model: Model) => void;
}

function ModelGroups(props: ModelTableProps): JSX.Element {
  const grouped = useMemo(() => {
    const map = new Map<string, Model[]>();
    for (const model of props.models) {
      const pid = model.provider_id;
      if (!pid) continue;
      const list = map.get(pid) ?? [];
      list.push(model);
      map.set(pid, list);
    }
    return map;
  }, [props.models]);

  if (props.totalModelCount === 0) {
    return <p className="muted">还没有任何模型。点上方「+ 添加模型」开始。</p>;
  }

  if (props.models.length === 0) {
    return <p className="model-list-empty">没有匹配的模型。换个搜索词或筛选条件试试。</p>;
  }

  return (
    <div className="model-table" data-testid="model-table">
      <div className="model-bulk-bar">
        <label className="model-select-all">
          <input
            type="checkbox"
            checked={props.allVisibleSelected}
            onChange={props.onToggleSelectAll}
            data-testid="model-select-all"
          />
          <span>{props.selectedVisibleCount > 0 ? `已选 ${props.selectedVisibleCount} 个` : '选择当前列表'}</span>
        </label>
        {props.selectedVisibleCount > 0 && (
          <>
            <button type="button" className="btn-quiet" onClick={props.onClearSelection}>
              取消选择
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={props.onDeleteSelected}
              data-testid="model-bulk-delete"
            >
              删除选中模型
            </button>
          </>
        )}
      </div>
      <div className="model-table-header" aria-hidden="true">
        <span className="model-col-main">模型</span>
        <span>服务商</span>
        <span>价格 / 健康</span>
        <span>操作</span>
      </div>
      {props.providers
        .filter((provider) => grouped.has(provider.id))
        .map((provider) => {
          const list = grouped.get(provider.id) ?? [];
          return (
            <section className="model-table-group" key={provider.id}>
              <header className="model-table-group-h">
                <span>
                  <span className={provider.enabled ? 'dot ok' : 'dot bad'} />
                  <strong>{provider.name}</strong>
                </span>
                <span className="muted">{list.length} 个 · {providerLabel(provider.type)}</span>
              </header>
              <div className="model-table-rows">
                {list.map((model) => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    provider={provider}
                    selected={props.selectedModelIds.has(model.id)}
                    editing={props.editingAliasFor === model.id}
                    aliasDraft={props.aliasDraft}
                    health={props.healthByModel.get(model.id)}
                    isTesting={props.testingModelId === model.id}
                    onStartEditAlias={() => props.onStartEditAlias(model)}
                    onToggleSelect={() => props.onToggleSelect(model.id)}
                    onCancelEditAlias={props.onCancelEditAlias}
                    onAliasDraftChange={props.onAliasDraftChange}
                    onCommitAlias={() => props.onCommitAlias(model)}
                    onToggle={() => props.onToggle(model)}
                    onEnable={() => props.onEnable(model)}
                    onDefault={() => props.onDefault(model)}
                    onTest={() => props.onTest(model)}
                    onResetHealth={() => props.onResetHealth(model)}
                    onMove={(direction) => props.onMove(model, direction)}
                    onDelete={() => props.onDelete(model)}
                  />
                ))}
              </div>
            </section>
          );
        })}
    </div>
  );
}

interface ModelRowProps {
  model: Model;
  provider: Provider;
  selected: boolean;
  editing: boolean;
  aliasDraft: string;
  health: ModelHealthRow | undefined;
  isTesting: boolean;
  onToggleSelect: () => void;
  onStartEditAlias: () => void;
  onCancelEditAlias: () => void;
  onAliasDraftChange: (value: string) => void;
  onCommitAlias: () => Promise<void>;
  onToggle: () => void;
  onEnable: () => void;
  onDefault: () => void;
  onTest: () => void;
  onResetHealth: () => void;
  onMove: (direction: 'up' | 'down') => void;
  onDelete: () => void;
}

/** Close the enclosing <details> menu after a menu item is chosen. */
function closeMenuPopOnSelect(event: MouseEvent<HTMLDivElement>): void {
  const target = event.target as HTMLElement;
  if (target.closest('button')) {
    event.currentTarget.closest('details')?.removeAttribute('open');
  }
}

function ModelRow(props: ModelRowProps): JSX.Element {
  const { model, editing } = props;
  const health = props.health;
  const isChat = isChatCapable(model);
  const isDefault = model.is_default_for === 'chat';
  const disabledActive = isModelTemporarilyDisabled(model);
  const providerDisabled = !props.provider.enabled;
  const unavailable = !isModelUsable(model, props.provider);
  const availability = modelAvailability(model, props.provider);
  const canResetHealth = model.demoted || disabledActive || model.failure_count_24h > 0;
  const canMakeDefault = isChat && !isDefault && !unavailable;
  const priceText = `输入 ${pricePerMillion(model.price_input_per_1m)}/1M · 输出 ${pricePerMillion(model.price_output_per_1m)}/1M`;
  const healthText = health
    ? `${health.calls_24h} 调用 · ${health.failures_24h} 失败`
    : '暂无调用记录';
  const lastFailureText = health?.last_failure_at
    ? `最近失败 ${failureLabel(health.last_failure_classification)} · ${formatTime(health.last_failure_at)}`
    : model.failure_count_24h > 0
      ? `连续失败 ${model.failure_count_24h} 次`
      : '最近无失败';

  return (
    <div
      className={`model-row-card ${isDefault ? 'is-default' : ''} ${unavailable ? 'is-unavailable' : ''}`}
      data-testid={`model-row-${model.id}`}
    >
      <div className="mr-main">
        <label className="model-row-select" aria-label={`选择 ${modelLabel(model)}`}>
          <input
            type="checkbox"
            checked={props.selected}
            onChange={props.onToggleSelect}
            data-testid={`model-select-${model.id}`}
          />
        </label>
        {editing ? (
          <input
            autoFocus
            className="alias-input"
            value={props.aliasDraft}
            placeholder={model.display_name || model.model_name}
            onBlur={() => {
              void props.onCommitAlias();
            }}
            onChange={(event) => props.onAliasDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                props.onCancelEditAlias();
              }
            }}
            data-testid={`model-alias-input-${model.id}`}
          />
        ) : (
          <div className="name">
            <strong>{modelLabel(model)}</strong>
            {model.alias && (
              <span className="model-name-raw">{model.model_name}</span>
            )}
          </div>
        )}
        <div className="mr-meta">
          <span className="tag">{model.capability}</span>
          {model.context_length ? <span className="muted">{formatContext(model.context_length)}</span> : null}
          {model.supports_vision && <span className="tag">视觉</span>}
          {model.supports_tools && <span className="tag">工具</span>}
        </div>
        <div className="model-state-chips" aria-label={`${modelLabel(model)} 状态`}>
          {isDefault && <span className="state-chip ok">默认 chat</span>}
          <span className={`state-chip primary ${availability.kind}`}>
            {availability.label}
          </span>
          {providerDisabled && <span className="state-chip off">服务商停用</span>}
          {model.demoted && <span className="state-chip warn">已降低优先级</span>}
          {disabledActive && <span className="state-chip warn">约 {formatDurationFromNow(model.disabled_until!)} 后恢复</span>}
          {model.failure_count_24h > 0 && (
            <span className="state-chip warn">连续失败 {model.failure_count_24h}</span>
          )}
        </div>
      </div>
      <div className="mr-provider">
        <strong>{props.provider.name}</strong>
        <span>{providerLabel(props.provider.type)}</span>
      </div>
      <div className="mr-health">
        <strong>{healthText}</strong>
        <span>{availability.detail}</span>
        <span>{lastFailureText}</span>
        <span>{priceText}</span>
      </div>
      <div className="mr-actions">
        {!model.enabled && !providerDisabled && (
          <button
            type="button"
            className="btn-quiet star"
            onClick={props.onEnable}
            title="启用该模型"
            data-testid={`model-enable-${model.id}`}
          >
            <Icon name="check" size={11} /> 启用
          </button>
        )}
        {model.enabled && canResetHealth && !providerDisabled && (
          <button
            type="button"
            className="btn-quiet star"
            onClick={props.onResetHealth}
            title="清除降级或临时停用状态"
            data-testid={`model-reset-health-inline-${model.id}`}
          >
            <Icon name="refresh" size={11} /> 恢复可用
          </button>
        )}
        {canMakeDefault && (
          <button
            type="button"
            className="btn-quiet star"
            onClick={props.onDefault}
            title="设为默认聊天模型"
            data-testid={`model-set-default-${model.id}`}
          >
            <Icon name="check" size={11} /> 设为默认
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          disabled={props.isTesting}
          onClick={props.onTest}
          title={props.isTesting ? '探测中…' : '探测连通性'}
          data-testid={`model-test-${model.id}`}
        >
          {props.isTesting ? '…' : <Icon name="bolt" size={13} />}
        </button>
        <details className="menu-pop right" data-testid={`model-actions-${model.id}`}>
          <summary className="icon-btn" title="更多操作">⋯</summary>
          <div className="menu-pop-list" role="menu" onClick={closeMenuPopOnSelect}>
            <button
              type="button"
              role="menuitem"
              onClick={(event) => {
                closeMenuAfterAction(event);
                props.onStartEditAlias();
              }}
              data-testid={`model-rename-${model.id}`}
            >
              重命名为别名
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={(event) => {
                closeMenuAfterAction(event);
                props.onMove('up');
              }}
              data-testid={`model-move-up-${model.id}`}
            >
              ↑ 上移备援顺序
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={(event) => {
                closeMenuAfterAction(event);
                props.onMove('down');
              }}
              data-testid={`model-move-down-${model.id}`}
            >
              ↓ 下移备援顺序
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={(event) => {
                closeMenuAfterAction(event);
                props.onToggle();
              }}
            >
              {model.enabled ? '停用' : '启用'}
            </button>
            {canResetHealth && (
              <button
                type="button"
                role="menuitem"
                onClick={(event) => {
                  closeMenuAfterAction(event);
                  props.onResetHealth();
                }}
                data-testid={`model-reset-health-${model.id}`}
              >
                恢复可用状态
              </button>
            )}
            <div className="menu-pop-divider" />
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={(event) => {
                closeMenuAfterAction(event);
                props.onDelete();
              }}
              data-testid={`model-delete-${model.id}`}
            >
              删除
            </button>
          </div>
        </details>
      </div>
    </div>
  );
}

function ProviderSettings(props: SettingsViewProps): JSX.Element {
  const dialog = useDialog();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [discoveryFor, setDiscoveryFor] = useState<{
    provider: Provider;
    response: DiscoveryResponse;
  } | null>(null);
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<Map<string, boolean>>(new Map());

  async function handleTest(provider: Provider): Promise<void> {
    try {
      const result = await testProvider(provider.id);
      props.onToast(
        result.ok
          ? `${provider.name} 连接正常${result.sample_count ? ` · ${result.sample_count} 个模型` : ''}`
          : result.error?.message ?? '测试失败',
      );
    } catch (error) {
      props.onError(describeError(error));
    }
  }

  async function handleDiscover(provider: Provider): Promise<void> {
    setDiscovering(provider.id);
    try {
      const result = await discoverProvider(provider.id);
      setDiscoveryFor({ provider, response: result });
    } catch (error) {
      props.onError(describeError(error));
    } finally {
      setDiscovering(null);
    }
  }

  async function handleSync(provider: Provider): Promise<void> {
    setSyncing(provider.id);
    try {
      await catalogSync(provider.id);
      props.onToast(`${provider.name} 价格目录已同步。`);
      await props.onRefresh();
    } catch (error) {
      props.onError(describeError(error));
    } finally {
      setSyncing(null);
    }
  }

  async function handleToggle(provider: Provider): Promise<void> {
    try {
      await patchProvider(provider.id, { enabled: !provider.enabled });
      await props.onRefresh();
    } catch (error) {
      props.onError(describeError(error));
    }
  }

  async function handleDelete(provider: Provider): Promise<void> {
    const ok = await dialog.confirm({
      title: `删除服务商 ${provider.name}？`,
      description: '将一并移除其下所有模型；已发生的对话不受影响。Key 也会从本机 Keystore 解绑。',
      tone: 'danger',
      okLabel: '删除',
    });
    if (!ok) return;
    try {
      await deleteProvider(provider.id);
      props.onToast('已删除。');
      await props.onRefresh();
    } catch (error) {
      props.onError(describeError(error));
    }
  }

  async function refreshKeyStatus(confirmKeychain = false): Promise<void> {
    try {
      const statuses = await listProviderKeyStatus(confirmKeychain);
      setKeyStatus(new Map(statuses.map((item) => [item.provider_id, item.key_available])));
      props.onToast('Key 状态已刷新。');
    } catch (error) {
      if (error instanceof Error && error.message.includes('confirm_keychain')) {
        const ok = await dialog.confirm({
          title: '读取 Key 状态需要访问系统 Keychain',
          description: '继续会让系统弹出 Keychain 授权框（首次访问时）。',
          okLabel: '继续',
        });
        if (ok) {
          await refreshKeyStatus(true);
          return;
        }
      }
      props.onError(describeError(error));
    }
  }

  async function revokeKey(provider: Provider): Promise<void> {
    const ok = await dialog.confirm({
      title: `撤销 ${provider.name} 的 API Key？`,
      description: '只解绑 Key，服务商和模型项会保留；之后用这家的模型会报"未配置 Key"。',
      tone: 'danger',
      okLabel: '撤销',
    });
    if (!ok) return;
    try {
      await deleteProviderKey(provider.id);
      await refreshKeyStatus();
      await props.onRefresh();
      props.onToast('Key 已撤销。');
    } catch (error) {
      props.onError(describeError(error));
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-title">服务商</h2>
          <p className="page-sub">配置上游服务和 API Key。Key 仅写入本机 Keystore，不留在前端。</p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => setWizardOpen(true)}
            data-testid="provider-add"
          >
            <Icon name="plus" size={12} /> 接入新服务商
          </button>
          <button
            type="button"
            className="btn-quiet"
            onClick={() => void refreshKeyStatus()}
            data-testid="provider-key-status-refresh"
          >
            检查 Key 状态
          </button>
        </div>
      </div>

      {props.providers.length === 0 ? (
        <div className="cta-banner" data-testid="provider-empty-cta">
          <div className="cta-glyph">+</div>
          <div className="cta-body">
            <div className="cta-title">还没接入任何服务商</div>
            <div className="cta-sub">从预设清单（OpenRouter / DeepSeek / 火山方舟 / 通义 / Kimi / 华为云 / 本地 Ollama / LM Studio）30 秒接入。</div>
          </div>
          <button
            type="button"
            className="cta-action"
            onClick={() => setWizardOpen(true)}
          >
            接入第一家 →
          </button>
        </div>
      ) : (
        <div className="provider-list">
          {props.providers.map((provider) => {
            const modelCount = props.models.filter((m) => m.provider_id === provider.id).length;
            const keyKnown = keyStatus.has(provider.id);
            const keyAvailable = keyStatus.get(provider.id);
            return (
              <article key={provider.id} className="provider-card provider-card-slim">
                <header>
                  <span className={provider.enabled ? 'dot ok' : 'dot bad'} />
                  <strong>{provider.name}</strong>
                  <span className="meta" style={{ marginLeft: 'auto' }}>
                    {providerLabel(provider.type)}
                  </span>
                </header>
                <div className="meta mono-tight">{provider.base_url}</div>
                <div className="meta">
                  {provider.api_key_ref ? (
                    keyKnown ? (
                      <span className={`key-chip ${keyAvailable ? 'ok' : 'bad'}`}>
                        {keyAvailable ? 'Key 可用' : 'Key 缺失'}
                      </span>
                    ) : (
                      <span className="key-chip ok">已绑定 Key</span>
                    )
                  ) : (
                    <span className="key-chip bad">未绑定 Key</span>
                  )}
                  <span style={{ marginLeft: 8 }}>· {modelCount} 个模型</span>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn-quiet primary-action"
                    disabled={discovering === provider.id}
                    onClick={() => void handleDiscover(provider)}
                    data-testid={`provider-discover-${provider.id}`}
                  >
                    {discovering === provider.id ? '发现中…' : '发现模型'}
                  </button>
                  <button
                    type="button"
                    className="btn-quiet"
                    onClick={() => void handleTest(provider)}
                    data-testid={`provider-test-${provider.id}`}
                  >
                    测试连接
                  </button>
                  <details className="menu-pop right" data-testid={`provider-actions-${provider.id}`}>
                    <summary className="icon-btn" title="更多操作">⋯</summary>
                    <div className="menu-pop-list" role="menu" onClick={closeMenuPopOnSelect}>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={(event) => {
                          closeMenuAfterAction(event);
                          setEditingProvider(provider);
                        }}
                        data-testid={`provider-edit-${provider.id}`}
                      >
                        编辑名称 / Base URL / Key
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={syncing === provider.id}
                        onClick={(event) => {
                          closeMenuAfterAction(event);
                          void handleSync(provider);
                        }}
                      >
                        {syncing === provider.id ? '同步中…' : '同步价格目录'}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={(event) => {
                          closeMenuAfterAction(event);
                          void handleToggle(provider);
                        }}
                      >
                        {provider.enabled ? '停用此服务商' : '启用此服务商'}
                      </button>
                      <div className="menu-pop-divider" />
                      <button
                        type="button"
                        role="menuitem"
                        disabled={!provider.api_key_ref}
                        onClick={(event) => {
                          closeMenuAfterAction(event);
                          void revokeKey(provider);
                        }}
                        data-testid={`provider-key-revoke-${provider.id}`}
                      >
                        撤销 API Key
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        onClick={(event) => {
                          closeMenuAfterAction(event);
                          void handleDelete(provider);
                        }}
                        data-testid={`provider-delete-${provider.id}`}
                      >
                        删除整个服务商
                      </button>
                    </div>
                  </details>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {wizardOpen && (
        <AddModelWizard
          providers={props.providers}
          existingModels={props.models}
          onClose={() => setWizardOpen(false)}
          onDone={async () => {
            await props.onRefresh();
          }}
          onToast={props.onToast}
          onError={props.onError}
        />
      )}

      {editingProvider && (
        <ProviderEditDialog
          provider={editingProvider}
          onClose={() => setEditingProvider(null)}
          onSave={async (patch) => {
            try {
              await patchProvider(editingProvider.id, patch);
              props.onToast('已保存。');
              setEditingProvider(null);
              await props.onRefresh();
            } catch (error) {
              props.onError(describeError(error));
            }
          }}
        />
      )}

      {discoveryFor && (
        <DiscoveryDialog
          provider={discoveryFor.provider}
          response={discoveryFor.response}
          existingModelNames={
            new Set(
              props.models
                .filter((m) => m.provider_id === discoveryFor.provider.id)
                .map((m) => m.model_name),
            )
          }
          onClose={() => setDiscoveryFor(null)}
          onAdd={async (selected) => {
            const failures: string[] = [];
            for (const item of selected) {
              try {
                await createModel({
                  provider_id: discoveryFor.provider.id,
                  model_name: item.model_name,
                  display_name: item.display_name,
                  capability: item.capability,
                  price_input_per_1m: item.price_input_per_1m,
                  price_output_per_1m: item.price_output_per_1m,
                  context_length: item.context_length,
                  supports_vision: item.supports_vision,
                  supports_tools: item.supports_tools,
                  modalities: item.modalities,
                });
              } catch (error) {
                failures.push(`${item.display_name}: ${describeError(error)}`);
              }
            }
            if (failures.length > 0) {
              props.onError(`${selected.length - failures.length}/${selected.length} 已添加，部分失败：${failures.join('; ')}`);
            } else {
              props.onToast(`已添加 ${selected.length} 个模型。`);
            }
            setDiscoveryFor(null);
            await props.onRefresh();
          }}
        />
      )}
    </>
  );
}

function ProviderEditDialog(props: {
  provider: Provider;
  onClose: () => void;
  onSave: (patch: { name?: string; base_url?: string; api_key?: string }) => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState(props.provider.name);
  const [baseUrl, setBaseUrl] = useState(props.provider.base_url);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props.onClose]);

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()} data-testid="provider-edit-dialog">
        <div className="modal-head">
          <div className="title">编辑 Provider</div>
          <span className="sub">{providerLabel(props.provider.type)}</span>
          <button type="button" className="icon-btn" onClick={props.onClose} title="关闭">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="modal-body">
          <div className="form-grid" style={{ gridTemplateColumns: '1fr', marginTop: 0 }}>
            <input
              placeholder="名称"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <input
              placeholder="Base URL"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <input
              type="password"
              placeholder={
                props.provider.api_key_ref
                  ? '保留原 Key（留空不变更）'
                  : '尚未绑定 Key — 输入即写入 Keystore'
              }
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
        </div>
        <div className="modal-foot">
          <span className="muted">Key 不会回传到前端，仅写入本机 Keystore。</span>
          <span className="spacer" />
          <button type="button" className="btn-quiet" onClick={props.onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={saving}
            onClick={async () => {
              const patch: { name?: string; base_url?: string; api_key?: string } = {};
              if (name.trim() && name.trim() !== props.provider.name) patch.name = name.trim();
              if (baseUrl.trim() && baseUrl.trim() !== props.provider.base_url) {
                patch.base_url = baseUrl.trim();
              }
              if (apiKey.trim()) patch.api_key = apiKey.trim();
              if (Object.keys(patch).length === 0) {
                props.onClose();
                return;
              }
              setSaving(true);
              try {
                await props.onSave(patch);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DiscoveryDialog(props: {
  provider: Provider;
  response: DiscoveryResponse;
  existingModelNames: Set<string>;
  onClose: () => void;
  onAdd: (selected: DiscoveredModel[]) => Promise<void>;
}): JSX.Element {
  const [filter, setFilter] = useState('');
  const [selectedNames, setSelectedNames] = useState<Set<string>>(() => {
    const next = new Set<string>();
    if (props.response.recommended.chat) {
      const rec = props.response.models.find(
        (m) => m.model_name === props.response.recommended.chat,
      );
      if (rec && !props.existingModelNames.has(rec.model_name)) {
        next.add(rec.model_name);
      }
    }
    return next;
  });
  const [adding, setAdding] = useState(false);
  const didMountFilter = useRef(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props.onClose]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return props.response.models;
    return props.response.models.filter(
      (m) =>
        m.model_name.toLowerCase().includes(q) ||
        m.display_name.toLowerCase().includes(q),
    );
  }, [filter, props.response.models]);

  useEffect(() => {
    if (!didMountFilter.current) {
      didMountFilter.current = true;
      return;
    }
    setSelectedNames(new Set());
  }, [filter]);

  function toggle(name: string): void {
    setSelectedNames((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const recommended = props.response.recommended.chat;

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()} data-testid="discovery-dialog">
        <div className="modal-head">
          <div className="title">从 {props.provider.name} 发现模型</div>
          <span className="sub">{props.response.models.length} 个可用</span>
          <button type="button" className="icon-btn" onClick={props.onClose} title="关闭">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="modal-body">
          <div className="discovery-toolbar">
            <input
              placeholder="按名称过滤…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              data-testid="discovery-filter"
            />
            <button
              type="button"
              className="btn-quiet"
              onClick={() => {
                const next = new Set<string>();
                for (const m of filtered) {
                  if (!props.existingModelNames.has(m.model_name)) next.add(m.model_name);
                }
                setSelectedNames(next);
              }}
            >
              全选当前列表
            </button>
            <button
              type="button"
              className="btn-quiet"
              onClick={() => setSelectedNames(new Set())}
            >
              清空已选
            </button>
          </div>

          {filtered.length === 0 ? (
            <div className="discovery-empty">
              {filter.trim() ? '没有匹配的模型。' : '该 Provider 当前没有返回任何模型。'}
            </div>
          ) : (
            <div className="discovery-list">
              {filtered.map((model) => {
                const exists = props.existingModelNames.has(model.model_name);
                const checked = selectedNames.has(model.model_name);
                const isRec = model.model_name === recommended;
                return (
                  <div
                    role="button"
                    tabIndex={0}
                    key={model.model_name}
                    className={`discovery-row ${checked ? 'checked' : ''}`}
                    onClick={() => {
                      if (!exists) toggle(model.model_name);
                    }}
                    onKeyDown={(event) => {
                      if ((event.key === 'Enter' || event.key === ' ') && !exists) {
                        event.preventDefault();
                        toggle(model.model_name);
                      }
                    }}
                    style={exists ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                    data-testid={`discovery-row-${model.model_name}`}
                  >
                    <span className="check-square">
                      {checked && <Icon name="check" size={11} stroke={2.6} />}
                    </span>
                    <div className="info">
                      <div className="name">
                        {model.display_name}
                        {isRec && <span className="badge-rec">推荐 chat</span>}
                        {exists && <span className="muted">（已添加）</span>}
                      </div>
                      <div className="meta">
                        {model.model_name}
                        {model.context_length ? ` · ${formatContext(model.context_length)}` : ''}
                        {model.supports_vision ? ' · 视觉' : ''}
                        {model.supports_tools ? ' · 工具' : ''}
                      </div>
                    </div>
                    <div className="price">
                      <div>输入 {pricePerMillion(model.price_input_per_1m)}/1M</div>
                      <div>输出 {pricePerMillion(model.price_output_per_1m)}/1M</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span className="muted">已选 {selectedNames.size} / 可见 {filtered.length}</span>
          <span className="spacer" />
          <button type="button" className="btn-quiet" onClick={props.onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={adding || selectedNames.size === 0}
            onClick={async () => {
              const selected = props.response.models.filter((m) => selectedNames.has(m.model_name));
              setAdding(true);
              try {
                await props.onAdd(selected);
              } finally {
                setAdding(false);
              }
            }}
            data-testid="discovery-confirm"
          >
            {adding ? '添加中…' : `添加 ${selectedNames.size} 个`}
          </button>
        </div>
      </div>
    </div>
  );
}

function AppearanceSettings(props: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  density: Density;
  onDensityChange: (density: Density) => void;
}): JSX.Element {
  const themes: Array<{ id: Theme; label: string; sub: string; bg: string }> = [
    { id: 'light', label: '温暖', sub: '纸感米白', bg: '#F6F2E9' },
    { id: 'dark', label: '夜色', sub: '墨黑暖灯', bg: '#15120E' },
    {
      id: 'auto',
      label: '跟随系统',
      sub: '随时间切换',
      bg: 'linear-gradient(135deg, #F6F2E9 50%, #15120E 50%)',
    },
  ];
  return (
    <>
      <h2 className="page-title">外观</h2>
      <p className="page-sub">让界面适应你的眼睛与心情。</p>

      <div className="section-h">主题</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        {themes.map((theme) => (
          <button
            type="button"
            key={theme.id}
            className={`model-card ${props.theme === theme.id ? 'active' : ''}`}
            onClick={() => props.onThemeChange(theme.id)}
            style={{ padding: 0, overflow: 'hidden' }}
            data-testid={`theme-${theme.id}`}
          >
            <span className="check">
              <Icon name="check" size={11} stroke={2.5} />
            </span>
            <div style={{ height: 88, background: theme.bg, position: 'relative' }}>
              <div
                style={{
                  position: 'absolute',
                  bottom: 10,
                  left: 12,
                  right: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span
                  style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--accent)' }}
                />
                <span
                  style={{
                    height: 4,
                    flex: 1,
                    background: 'rgba(128,118,100,0.4)',
                    borderRadius: 2,
                  }}
                />
              </div>
            </div>
            <div style={{ padding: '12px 14px' }}>
              <div className="m-name" style={{ marginBottom: 2 }}>
                {theme.label}
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-mute)' }}>{theme.sub}</div>
            </div>
          </button>
        ))}
      </div>

      <div className="section-h">密度</div>
      <div className="set-row">
        <div className="label-wrap">
          <div className="label">界面密度</div>
          <div className="sub">调整间距与字号的紧凑程度。</div>
        </div>
        <div className="tab-strip">
          {(['compact', 'regular', 'comfy'] as const).map((density) => (
            <button
              type="button"
              key={density}
              className={props.density === density ? 'active' : ''}
              onClick={() => props.onDensityChange(density)}
            >
              {density === 'compact' ? '紧凑' : density === 'comfy' ? '宽松' : '常规'}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function GeneralSettings(): JSX.Element {
  const toast = useToast();
  const dialog = useDialog();
  const [version, setVersion] = useState<string>('—');
  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  const [selfCheckBusy, setSelfCheckBusy] = useState(false);
  const [selfCheck, setSelfCheck] = useState<Array<{ name: string; ok: boolean; detail?: string }> | null>(null);
  // Friendly Chinese label per check id.
  const LABEL_BY_ID: Record<string, string> = {
    sidecar: 'Sidecar',
    keystore: 'Keychain',
    database: '数据库',
    default_model: '默认模型',
  };
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void health().then((response) => {
      setHealthOk(true);
      setVersion((response as { version?: string }).version ?? 'dev');
    }).catch(() => setHealthOk(false));
  }, []);

  async function doSelfCheck(): Promise<void> {
    setSelfCheckBusy(true);
    try {
      const result = await runSelfCheck();
      const checks = Array.isArray(result.checks)
        ? result.checks.map((item) => ({
            name: LABEL_BY_ID[item.id ?? ''] ?? item.name ?? item.id ?? 'check',
            ok: item.ok,
            detail: item.detail,
          }))
        : [];
      setSelfCheck(
        checks.length > 0
          ? checks
          : [{ name: 'overall', ok: result.ok === true, detail: result.overall ?? '无详情' }],
      );
      toast.success(`Self-check ${result.ok ? '通过' : '存在问题'}。`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSelfCheckBusy(false);
    }
  }

  async function doExport(): Promise<void> {
    setBusy('export');
    try {
      const body = await adminExportData();
      const blob = new Blob([body], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `taori-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success('备份已下载。');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function doImport(): Promise<void> {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      setBusy('import');
      try {
        const text = await file.text();
        await adminImportData(text);
        toast.success('备份已导入。');
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    };
    fileInput.click();
  }

  async function doClear(): Promise<void> {
    const confirmed = await dialog.confirm({
      title: '清空所有本地数据？',
      description: '会话、消息、模型、Provider、Key 绑定、成本、研究、记忆 — 全部清空且无法恢复。建议先导出备份。',
      tone: 'danger',
      okLabel: '我已备份，清空',
    });
    if (!confirmed) return;
    setBusy('clear');
    try {
      await adminClearAllData();
      toast.success('已清空。刷新页面后从零开始。');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h2 className="page-title">通用</h2>
      <p className="page-sub">本机状态、Self-check、数据管理与快捷键。</p>

      <div className="section-h">本机状态</div>
      <div className="set-row">
        <div className="label-wrap">
          <div className="label">Sidecar</div>
          <div className="sub">本机业务进程。版本 {version}。</div>
        </div>
        <span className={`status-chip ${healthOk ? 'complete' : healthOk === false ? 'failed' : ''}`}>
          {healthOk == null ? '检查中…' : healthOk ? '在线' : '离线'}
        </span>
      </div>
      <div className="set-row">
        <div className="label-wrap">
          <div className="label">Self-check</div>
          <div className="sub">检查 DB / Provider 健康 / 关键工具是否就绪。</div>
        </div>
        <button
          type="button"
          className="btn-quiet"
          onClick={() => void doSelfCheck()}
          disabled={selfCheckBusy}
          data-testid="settings-selfcheck"
        >
          {selfCheckBusy ? '检查中…' : '运行 Self-check'}
        </button>
      </div>
      {selfCheck && (
        <div className="selfcheck-result" data-testid="settings-selfcheck-result">
          {selfCheck.map((item, index) => (
            <div className={`selfcheck-row ${item.ok ? 'ok' : 'bad'}`} key={`${item.name}-${index}`}>
              <span className={`dot ${item.ok ? 'ok' : 'bad'}`} />
              <strong>{item.name}</strong>
              <span className="muted">{item.detail ?? (item.ok ? '通过' : '失败')}</span>
            </div>
          ))}
        </div>
      )}

      <div className="section-h">数据</div>
      <div className="set-row">
        <div className="label-wrap">
          <div className="label">导出全部</div>
          <div className="sub">JSON 备份：会话 / 消息 / Provider / 模型 / 成本 / 模板 / 人格 / 记忆。Key 不会被导出。</div>
        </div>
        <button
          type="button"
          className="btn-quiet"
          onClick={() => void doExport()}
          disabled={busy === 'export'}
          data-testid="settings-export"
        >
          {busy === 'export' ? '导出中…' : '导出'}
        </button>
      </div>
      <div className="set-row">
        <div className="label-wrap">
          <div className="label">导入备份</div>
          <div className="sub">从 JSON 文件恢复。已有数据会被合并；ID 冲突时以备份为准。</div>
        </div>
        <button
          type="button"
          className="btn-quiet"
          onClick={() => void doImport()}
          disabled={busy === 'import'}
          data-testid="settings-import"
        >
          {busy === 'import' ? '导入中…' : '导入'}
        </button>
      </div>
      <div className="set-row danger">
        <div className="label-wrap">
          <div className="label">清空所有本地数据</div>
          <div className="sub">谨慎使用。会话、模型、Provider、Key 绑定、成本记录全部抹除。</div>
        </div>
        <button
          type="button"
          className="btn-danger"
          onClick={() => void doClear()}
          disabled={busy === 'clear'}
          data-testid="settings-clear-all"
        >
          {busy === 'clear' ? '清空中…' : '清空'}
        </button>
      </div>

      <div className="section-h">快捷键</div>
      <div className="set-row">
        <div className="label-wrap">
          <div className="label">新对话</div>
        </div>
        <span>
          <span className="kbd-key">⌘</span> <span className="kbd-key">N</span>
        </span>
      </div>
      <div className="set-row">
        <div className="label-wrap">
          <div className="label">发送消息</div>
        </div>
        <span>
          <span className="kbd-key">Enter</span>
        </span>
      </div>
      <div className="set-row">
        <div className="label-wrap">
          <div className="label">换行</div>
        </div>
        <span>
          <span className="kbd-key">⇧</span> <span className="kbd-key">Enter</span>
        </span>
      </div>
    </>
  );
}
