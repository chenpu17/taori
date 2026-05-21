import { useEffect, useMemo, useState } from 'react';
import type { Model, ModelHealthRow, Provider, Tool, ToolHealthRow } from '@taori/shared';
import { formatUsd } from '@taori/shared';
import { api, type RuntimeResourceSnapshot } from './api.js';
import { CostDashboard } from './CostDashboard.js';
import { ModelCenter } from './ModelCenter.js';
import { EmptyState } from './EmptyState.js';
import { SettingsContent } from './Settings.js';

export type ControlCenterSection =
  | 'overview'
  | 'monitor'
  | 'models'
  | 'tools'
  | 'costs'
  | 'prompts'
  | 'general';

interface ControlCenterProps {
  initialSection: ControlCenterSection;
  costCallFocus?: CostCallFocusTarget | null;
  onCostCallFocusConsumed?: () => void;
  onClose: () => void;
  onChanged: () => void;
  onModelsChanged: () => void;
  onReopenOnboarding: () => void;
}

interface CostCallFocusTarget {
  costRecordId: string | null;
  runId: string | null;
  runEventId: string | null;
  providerKey?: string | null;
  modelId?: string | null;
  preferredScope?: 'today' | 'week' | 'month';
}

const NAV_ITEMS: Array<{
  id: ControlCenterSection;
  label: string;
  description: string;
  icon: string;
  legacyTestId?: string;
  keywords?: string[];
}> = [
  {
    id: 'overview',
    label: '概览',
    description: '系统状态、最近调用、关键入口',
    icon: '◐',
    keywords: ['总览', 'overview', '系统', '健康', '调用'],
  },
  {
    id: 'monitor',
    label: '后端监控',
    description: 'Sidecar 进程 CPU、内存、运行态',
    icon: '◫',
    keywords: ['监控', '资源', 'cpu', 'memory', '进程', 'sidecar'],
  },
  {
    id: 'models',
    label: '模型与供应商',
    description: 'Provider、模型、价格、健康',
    icon: '◈',
    keywords: ['provider', '供应商', '模型', '价格', '健康'],
  },
  {
    id: 'tools',
    label: '工具能力',
    description: '内置工具开关与能力说明',
    icon: '◇',
    legacyTestId: 'settings-tab-tools',
    keywords: ['工具', 'mcp', '能力', 'tool'],
  },
  {
    id: 'costs',
    label: '成本与调用',
    description: '预算、看板、真实出口日志',
    icon: '$',
    keywords: ['成本', '预算', '费用', '日志', '调用'],
  },
  {
    id: 'prompts',
    label: '模板与 Persona',
    description: 'Prompt 模板、角色预设',
    icon: '¶',
    legacyTestId: 'settings-tab-prompts',
    keywords: ['prompt', 'template', 'persona', '模板', '角色'],
  },
  {
    id: 'general',
    label: '通用与数据',
    description: '预算、兜底、Onboarding、清理',
    icon: '⚙',
    legacyTestId: 'settings-tab-general',
    keywords: ['通用', '数据', '兜底', 'onboarding', 'general'],
  },
];

const MODEL_FAILURE_LABELS: Record<string, string> = {
  rate_limit: '限流',
  quota: '额度耗尽',
  network: '网络失败',
  auth: '鉴权失败',
  config_error: '配置错误',
  content_filter: '内容拦截',
  key_missing: 'Key 缺失',
  unknown: '未知失败',
};

const TOOL_FAILURE_LABELS: Record<string, string> = {
  validation_error: '参数错误',
  tool_timeout: '工具超时',
  mcp_crashed: 'MCP 崩溃',
  permission_denied: '权限限制',
  rate_limit: '限速',
  quota: '额度',
  network: '网络',
  unknown: '未知',
};

function formatAgo(ts: number | null): string {
  if (!ts) return '—';
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function formatCountdown(untilMs: number | null): string {
  if (!untilMs) return '—';
  const diff = untilMs - Date.now();
  if (diff <= 0) return '即将恢复';
  if (diff < 60_000) return `${Math.ceil(diff / 1000)} 秒后`;
  if (diff < 3_600_000) return `${Math.ceil(diff / 60_000)} 分钟后`;
  if (diff < 86_400_000) return `${Math.ceil(diff / 3_600_000)} 小时后`;
  return `${Math.ceil(diff / 86_400_000)} 天后`;
}

function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function parseMemoryNumber(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseMemoryBoolean(raw: string | null): boolean {
  return /^(1|true|yes|on)$/i.test(raw?.trim() ?? '');
}

function budgetUsageTone(spent: number | null, budget: number | null): 'healthy' | 'watch' | 'over' | 'idle' {
  if (spent == null || budget == null || budget <= 0) return 'idle';
  const ratio = spent / budget;
  if (ratio >= 1) return 'over';
  if (ratio >= 0.75) return 'watch';
  return 'healthy';
}

interface BudgetAlertItem {
  id: string;
  tone: 'watch' | 'over';
  title: string;
  detail: string;
  chips: string[];
}

interface ProviderRiskItem {
  id: string;
  providerKey: string;
  tone: 'watch' | 'over';
  title: string;
  detail: string;
  chips: string[];
  primaryLabel: string;
  primaryAction: 'models' | 'costs' | 'onboarding';
  secondaryLabel?: string;
  secondaryAction?: 'models' | 'costs' | 'onboarding';
}

export function ControlCenter({
  initialSection,
  costCallFocus = null,
  onCostCallFocusConsumed,
  onClose,
  onChanged,
  onModelsChanged,
  onReopenOnboarding,
}: ControlCenterProps): JSX.Element {
  const [activeSection, setActiveSection] = useState<ControlCenterSection>(initialSection);
  const [searchQuery, setSearchQuery] = useState('');
  const [localCostFocus, setLocalCostFocus] = useState<CostCallFocusTarget | null>(null);

  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const activeItem = NAV_ITEMS.find((item) => item.id === activeSection) ?? NAV_ITEMS[0]!;
  const effectiveCostFocus = localCostFocus ?? costCallFocus ?? null;
  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLocaleLowerCase();
    if (!q) return NAV_ITEMS;
    return NAV_ITEMS.filter((item) => {
      const haystack = [
        item.label,
        item.description,
        ...(item.keywords ?? []),
      ].join(' ').toLocaleLowerCase();
      return haystack.includes(q);
    });
  }, [searchQuery]);

  useEffect(() => {
    if (filteredItems.length === 0) return;
    if (!filteredItems.some((item) => item.id === activeSection)) {
      setActiveSection(filteredItems[0]!.id);
    }
  }, [activeSection, filteredItems]);

  const reopenOnboarding = (): void => {
    onClose();
    onReopenOnboarding();
  };

  return (
    <div
      className="settings-overlay"
      data-testid="settings-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="control-center settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="配置与可视化中心"
        data-testid="control-center"
      >
        <aside className="control-center__rail" aria-label="配置中心导航">
          <div className="control-center__brand">
            <span className="control-center__mark">Taori</span>
            <strong>控制中心</strong>
            <small>配置、工具、成本、调用透明化</small>
          </div>
          <label className="control-center__search">
            <span className="sr-only">搜索控制中心分区</span>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索分区、功能或关键词…"
              data-testid="control-center-search"
            />
          </label>
          <nav className="control-center__nav">
            {filteredItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={activeSection === item.id ? 'active' : ''}
                onClick={() => setActiveSection(item.id)}
                data-testid={item.legacyTestId ?? `control-center-nav-${item.id}`}
              >
                <span className="control-center__nav-icon">{item.icon}</span>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
              </button>
            ))}
            {filteredItems.length === 0 && (
              <div className="control-center__nav-empty" data-testid="control-center-search-empty">
                <EmptyState
                  title="没有匹配的分区"
                  hint="试试搜索模型、工具、成本、模板、通用等关键词。"
                  icon="⌕"
                  compact
                  tone="muted"
                />
              </div>
            )}
          </nav>
          <div className="control-center__rail-hint" aria-hidden="true">
            <span>Esc 关闭</span>
            <span>/ 搜索</span>
          </div>
        </aside>

        <section className="control-center__main">
          <header className="control-center__header">
            <div>
              <h2>{activeItem.label}</h2>
              <p className="hint">{activeItem.description}</p>
              {searchQuery.trim() ? (
                <p className="control-center__search-result">
                  搜索：<strong>{searchQuery.trim()}</strong> · {filteredItems.length} 个结果
                </p>
              ) : null}
            </div>
            <div className="control-center__close-actions" data-section={activeSection}>
              {activeSection === 'models' && (
                <button
                  type="button"
                  className="control-center__compat-close"
                  onClick={onClose}
                  data-testid="model-center-close"
                  aria-label="关闭模型中心"
                >
                  ✕
                </button>
              )}
              {activeSection === 'costs' && (
                <button
                  type="button"
                  className="control-center__compat-close"
                  onClick={onClose}
                  data-testid="cost-dashboard-close"
                  aria-label="关闭成本看板"
                >
                  ✕
                </button>
              )}
              <button
                type="button"
                className="settings-close"
                onClick={onClose}
                data-testid="settings-close"
                aria-label="关闭配置中心"
              >
                ✕
              </button>
            </div>
          </header>

          <div className="control-center__content">
            {activeSection === 'overview' && (
              <OverviewSection
                onOpenMonitor={() => setActiveSection('monitor')}
                onOpenModels={() => setActiveSection('models')}
                onOpenTools={() => setActiveSection('tools')}
                onOpenCosts={(focus) => {
                  setLocalCostFocus(focus ?? null);
                  setActiveSection('costs');
                }}
                onReopenOnboarding={reopenOnboarding}
              />
            )}
            {activeSection === 'monitor' && <RuntimeMonitorSection />}
            {activeSection === 'models' && (
              <ModelCenter
                embedded
                onClose={onClose}
                onChanged={onModelsChanged}
                onReopenOnboarding={reopenOnboarding}
              />
            )}
            {activeSection === 'tools' && (
              <SettingsContent
                fixedTab="tools"
                onChanged={onChanged}
                onReopenOnboarding={reopenOnboarding}
              />
            )}
            {activeSection === 'costs' && (
              <CostDashboard
                embedded
                focusTarget={effectiveCostFocus}
                onFocusConsumed={() => {
                  if (localCostFocus) {
                    setLocalCostFocus(null);
                    return;
                  }
                  onCostCallFocusConsumed?.();
                }}
                onClose={onClose}
                onOpenModels={() => setActiveSection('models')}
              />
            )}
            {activeSection === 'prompts' && (
              <SettingsContent
                fixedTab="prompts"
                onChanged={onChanged}
                onReopenOnboarding={reopenOnboarding}
              />
            )}
            {activeSection === 'general' && (
              <SettingsContent
                fixedTab="general"
                onChanged={onChanged}
                onReopenOnboarding={reopenOnboarding}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function OverviewSection({
  onOpenMonitor,
  onOpenModels,
  onOpenTools,
  onOpenCosts,
  onReopenOnboarding,
}: {
  onOpenMonitor: () => void;
  onOpenModels: () => void;
  onOpenTools: () => void;
  onOpenCosts: (focus?: CostCallFocusTarget | null) => void;
  onReopenOnboarding: () => void;
}): JSX.Element {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [models, setModels] = useState<Model[] | null>(null);
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [providerKeyStatus, setProviderKeyStatus] = useState<Map<string, boolean> | null>(null);
  const [modelHealthRows, setModelHealthRows] = useState<ModelHealthRow[] | null>(null);
  const [toolHealthRows, setToolHealthRows] = useState<ToolHealthRow[] | null>(null);
  const [todayUsd, setTodayUsd] = useState<number | null>(null);
  const [monthUsd, setMonthUsd] = useState<number | null>(null);
  const [dailyBudgetUsd, setDailyBudgetUsd] = useState<number | null>(null);
  const [monthlyBudgetUsd, setMonthlyBudgetUsd] = useState<number | null>(null);
  const [thresholdUsd, setThresholdUsd] = useState<number | null>(null);
  const [dailyHardLimit, setDailyHardLimit] = useState(false);
  const [monthlyHardLimit, setMonthlyHardLimit] = useState(false);
  const [topTagRows, setTopTagRows] = useState<Array<{ label: string; sum_usd: number; count: number }>>([]);
  const [runtime, setRuntime] = useState<RuntimeResourceSnapshot | null>(null);
  const [lastCalls, setLastCalls] = useState<
    Array<{
      id: string;
      model_name_snapshot: string;
      provider_name: string | null;
      feature: string;
      success: boolean;
      actual_cost_usd: number | null;
    }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const load = async (): Promise<void> => {
      try {
        const [
          providerRes,
          modelRes,
          toolRes,
          modelHealthRes,
          toolHealthRes,
          realtimeRes,
          callsRes,
          runtimeRes,
          tagBreakdownRes,
          providerKeyStatusRes,
          thresholdRes,
          monthlyBudgetRes,
          dailyBudgetRes,
          monthlyHardLimitRes,
          dailyHardLimitRes,
        ] = await Promise.all([
          api.listProviders(),
          api.listModels(),
          api.listTools(),
          api.modelsHealth().catch(() => ({ rows: [] })),
          api.toolsHealth().catch(() => ({ rows: [] })),
          api.costsRealtime().catch(() => ({ data: { today_usd: null, month_usd: null } })),
          api.costsCallLogs(5).catch(() => ({ data: { rows: [] } })),
          api.runtimeDiagnostics().catch(() => ({ ok: false, data: null as RuntimeResourceSnapshot | null })),
          api.costsDashboardBreakdown('month', 'tag').catch(() => ({ data: { rows: [] } })),
          api.providerKeyStatus().catch(() => ({ statuses: [] as { provider_id: string; key_available: boolean }[] })),
          api.getMemoryEffective('cost_confirm_threshold_usd').catch(() => ({ data: { value: null as string | null } })),
          api.getMemoryEffective('monthly_budget_usd').catch(() => ({ data: { value: null as string | null } })),
          api.getMemoryEffective('daily_budget_usd').catch(() => ({ data: { value: null as string | null } })),
          api.getMemoryEffective('monthly_budget_hard_limit').catch(() => ({ data: { value: null as string | null } })),
          api.getMemoryEffective('daily_budget_hard_limit').catch(() => ({ data: { value: null as string | null } })),
        ]);
        if (cancelled) return;
        setProviders(providerRes.providers);
        setModels(modelRes.models);
        setTools(toolRes.data);
        setProviderKeyStatus(new Map(providerKeyStatusRes.statuses.map((item) => [item.provider_id, item.key_available])));
        setModelHealthRows(modelHealthRes.rows);
        setToolHealthRows(toolHealthRes.rows);
        setTodayUsd(
          typeof realtimeRes.data.today_usd === 'number' ? realtimeRes.data.today_usd : null,
        );
        setMonthUsd(
          typeof realtimeRes.data.month_usd === 'number' ? realtimeRes.data.month_usd : null,
        );
        setThresholdUsd(parseMemoryNumber(thresholdRes.data.value));
        setMonthlyBudgetUsd(parseMemoryNumber(monthlyBudgetRes.data.value));
        setDailyBudgetUsd(parseMemoryNumber(dailyBudgetRes.data.value));
        setMonthlyHardLimit(parseMemoryBoolean(monthlyHardLimitRes.data.value));
        setDailyHardLimit(parseMemoryBoolean(dailyHardLimitRes.data.value));
        setTopTagRows(
          (tagBreakdownRes.data.rows ?? [])
            .slice(0, 4)
            .map((row) => ({
              label: row.label ?? '未打标签',
              sum_usd: typeof row.sum_usd === 'number' ? row.sum_usd : 0,
              count: typeof row.count === 'number' ? row.count : 0,
            })),
        );
        setLastCalls(callsRes.data.rows ?? []);
        setRuntime(runtimeRes.data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
      if (!cancelled) {
        timer = window.setTimeout(() => {
          void load();
        }, 5000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [refreshNonce]);

  const modelStats = useMemo(() => {
    const list = models ?? [];
    return {
      total: list.length,
      chat: list.filter((m) => m.capability === 'chat' || m.capability === 'multimodal').length,
      image: list.filter((m) => m.capability === 'image').length,
    };
  }, [models]);

  const healthStats = useMemo(() => {
    const modelRows = modelHealthRows ?? [];
    const toolRows = toolHealthRows ?? [];
    const latestModelFailure = modelRows
      .filter((row) => row.last_failure_at != null)
      .sort((a, b) => (b.last_failure_at ?? 0) - (a.last_failure_at ?? 0))[0] ?? null;
    const latestToolFailure = toolRows
      .filter((row) => row.last_failure_at != null)
      .sort((a, b) => (b.last_failure_at ?? 0) - (a.last_failure_at ?? 0))[0] ?? null;
    return {
      modelCalls: modelRows.reduce((sum, row) => sum + row.calls_24h, 0),
      modelFailures: modelRows.reduce((sum, row) => sum + row.failures_24h, 0),
      modelsWithFailures: modelRows.filter((row) => row.failures_24h > 0).length,
      toolCalls: toolRows.reduce((sum, row) => sum + row.calls_24h, 0),
      toolFailures: toolRows.reduce((sum, row) => sum + row.failures_24h, 0),
      toolsWithFailures: toolRows.filter((row) => row.failures_24h > 0).length,
      latestModelFailure,
      latestToolFailure,
    };
  }, [modelHealthRows, toolHealthRows]);

  const latestModelFailureText = healthStats.latestModelFailure?.last_failure_classification
    ? `${MODEL_FAILURE_LABELS[healthStats.latestModelFailure.last_failure_classification] ?? healthStats.latestModelFailure.last_failure_classification} · ${formatAgo(healthStats.latestModelFailure.last_failure_at)}`
    : '无';
  const latestToolFailureText = healthStats.latestToolFailure?.last_failure_classification
    ? `${TOOL_FAILURE_LABELS[healthStats.latestToolFailure.last_failure_classification] ?? healthStats.latestToolFailure.last_failure_classification} · ${formatAgo(healthStats.latestToolFailure.last_failure_at)}`
    : '无';
  const runtimeMemoryRatio =
    runtime && runtime.system_memory_bytes > 0
      ? Math.min(100, Math.round((runtime.rss_bytes / runtime.system_memory_bytes) * 1000) / 10)
      : null;
  const dailyBudgetTone = budgetUsageTone(todayUsd, dailyBudgetUsd);
  const monthlyBudgetTone = budgetUsageTone(monthUsd, monthlyBudgetUsd);
  const budgetAlerts = useMemo(() => {
    const items: BudgetAlertItem[] = [];
    const pushAlert = (
      id: string,
      periodLabel: string,
      spent: number | null,
      budget: number | null,
      hardLimit: boolean,
      extraChip?: string,
    ): void => {
      if (spent == null || budget == null || budget <= 0) return;
      const ratio = spent / budget;
      if (ratio < 0.8) return;
      const tone: BudgetAlertItem['tone'] = ratio >= 1 ? 'over' : 'watch';
      items.push({
        id,
        tone,
        title: tone === 'over' ? `${periodLabel}预算已超出` : `${periodLabel}预算接近上限`,
        detail:
          tone === 'over'
            ? `${periodLabel}已使用 ${Math.round(ratio * 100)}%。${hardLimit ? '后续高成本操作会直接阻断，建议先停用昂贵模型或改走低成本草稿流。' : '后续发送会继续触发确认，建议先用成本建议和模型中心检查可替代模型。'}`
            : `${periodLabel}已使用 ${Math.round(ratio * 100)}%。建议把探索型任务先切到低成本模型，再把高成本模型留给最终定稿或复核。`,
        chips: [
          `${formatUsd(spent)} / ${formatUsd(budget)}`,
          hardLimit ? '硬上限' : '软提醒',
          ...(extraChip ? [extraChip] : []),
        ],
      });
    };
    pushAlert(
      'day',
      '今日',
      todayUsd,
      dailyBudgetUsd,
      dailyHardLimit,
      thresholdUsd == null ? '单次阈值未设' : `单次阈值 ${formatUsd(thresholdUsd)}`,
    );
    pushAlert(
      'month',
      '本月',
      monthUsd,
      monthlyBudgetUsd,
      monthlyHardLimit,
      topTagRows[0] ? `最高项目 ${topTagRows[0].label}` : undefined,
    );
    return items;
  }, [
    dailyBudgetUsd,
    dailyHardLimit,
    monthUsd,
    monthlyBudgetUsd,
    monthlyHardLimit,
    thresholdUsd,
    todayUsd,
    topTagRows,
  ]);
  const providerRiskQueue = useMemo(() => {
    if (!providers || providers.length === 0) return [] as ProviderRiskItem[];
    const providerModels = new Map<string, Model[]>();
    for (const model of models ?? []) {
      if (!model.provider_id) continue;
      const list = providerModels.get(model.provider_id) ?? [];
      list.push(model);
      providerModels.set(model.provider_id, list);
    }
    const healthByModelId = new Map<string, ModelHealthRow>();
    for (const row of modelHealthRows ?? []) {
      healthByModelId.set(row.model_id, row);
    }
    const ranked: Array<{ priority: number; item: ProviderRiskItem }> = [];
    for (const provider of providers) {
      const relatedModels = providerModels.get(provider.id) ?? [];
      const healthRows = relatedModels
        .map((model) => healthByModelId.get(model.id))
        .filter((row): row is ModelHealthRow => row != null);
      const calls24h = healthRows.reduce((sum, row) => sum + row.calls_24h, 0);
      const failures24h = relatedModels.reduce((sum, model) => sum + model.failure_count_24h, 0);
      const failureRate = calls24h > 0 ? failures24h / calls24h : 0;
      const hasCooldown = relatedModels.some((model) => model.disabled_until != null && model.disabled_until > Date.now());
      const hasDemotion = relatedModels.some((model) => model.demoted);
      const keyAvailable = provider.type === 'ollama'
        ? true
        : (providerKeyStatus?.get(provider.id) ?? Boolean(provider.api_key_ref));
      const latestUpdateAt = Math.max(provider.updated_at, ...relatedModels.map((model) =>
        model.price_synced_at ?? model.pricing_meta?.updated_at ?? provider.updated_at,
      ));
      const hoursSinceUpdate = Math.round((Date.now() - latestUpdateAt) / 36e5);
      if (!keyAvailable) {
        ranked.push({
          priority: 0,
          item: {
            id: `${provider.id}-key-missing`,
            providerKey: provider.id,
            tone: 'over',
            title: `${provider.name} 缺少可用 Key`,
            detail: '该 Provider 当前没有可用 Key，后续测试、导入和自动选择都容易直接失败，建议先补 Key 再继续使用。',
            chips: [
              provider.type,
              provider.enabled ? '已启用' : '已停用',
              relatedModels.length > 0 ? `${relatedModels.length} 个模型` : '未导入模型',
            ],
            primaryLabel: '补 Provider Key',
            primaryAction: 'onboarding',
            secondaryLabel: '看成本影响',
            secondaryAction: 'costs',
          },
        });
      }
      if (!provider.enabled) {
        ranked.push({
          priority: 2,
          item: {
            id: `${provider.id}-disabled`,
            providerKey: provider.id,
            tone: 'watch',
            title: `${provider.name} 当前已停用`,
            detail: '该 Provider 处于停用状态，相关模型不会参与正常选择。若这是主力出口，建议检查是否为临时关闭。',
            chips: [
              provider.type,
              relatedModels.length > 0 ? `${relatedModels.length} 个模型已挂载` : '未导入模型',
            ],
            primaryLabel: '重新启用 / 编辑',
            primaryAction: 'models',
            secondaryLabel: '看成本影响',
            secondaryAction: 'costs',
          },
        });
      }
      if (relatedModels.length === 0) {
        ranked.push({
          priority: 3,
          item: {
            id: `${provider.id}-empty`,
            providerKey: provider.id,
            tone: 'watch',
            title: `${provider.name} 还没有模型`,
            detail: 'Provider 已接入但尚未导入模型，当前还不能承担真实聊天、图像或 fallback 出口。',
            chips: [provider.type, keyAvailable ? 'Key 可用' : 'Key 待补'],
            primaryLabel: '导入模型',
            primaryAction: 'models',
            secondaryLabel: keyAvailable ? '看成本影响' : '补 Provider Key',
            secondaryAction: keyAvailable ? 'costs' : 'onboarding',
          },
        });
      }
      if (failures24h > 0 && (failureRate >= 0.2 || hasCooldown || hasDemotion)) {
        ranked.push({
          priority: 1,
          item: {
            id: `${provider.id}-health`,
            providerKey: provider.id,
            tone: hasCooldown ? 'over' : 'watch',
            title: `${provider.name} 近期不稳定`,
            detail:
              hasCooldown
                ? '该 Provider 关联模型里已有冷却中的模型，建议尽快检查失败分类并准备 fallback。'
                : '该 Provider 关联模型最近 24h 失败偏多，建议先核对出口状态，再决定是否继续承接主任务。',
            chips: [
              `${failures24h} / ${calls24h} 失败`,
              hasCooldown ? '含冷却模型' : hasDemotion ? '含降级模型' : '失败率偏高',
            ],
            primaryLabel: hasCooldown ? '检查 fallback / 模型' : '检查 Provider / 模型',
            primaryAction: 'models',
            secondaryLabel: '看成本影响',
            secondaryAction: 'costs',
          },
        });
      }
      if (relatedModels.length > 0 && hoursSinceUpdate >= 72) {
        ranked.push({
          priority: 4,
          item: {
            id: `${provider.id}-stale`,
            providerKey: provider.id,
            tone: 'watch',
            title: `${provider.name} 最近较久未更新`,
            detail: '模型或 Provider 配置已经一段时间没动过。若它承担高频调用，建议顺手同步价格并确认模型集仍然可用。',
            chips: [`${hoursSinceUpdate}h 未更新`, provider.type],
            primaryLabel: '同步 / 检查模型',
            primaryAction: 'models',
            secondaryLabel: '看成本影响',
            secondaryAction: 'costs',
          },
        });
      }
    }
    return ranked
      .sort((left, right) => left.priority - right.priority)
      .slice(0, 4)
      .map((entry) => entry.item);
  }, [modelHealthRows, models, providerKeyStatus, providers]);
  const runOverviewAction = (action: 'models' | 'costs' | 'onboarding'): void => {
    if (action === 'models') {
      onOpenModels();
      return;
    }
    if (action === 'costs') {
      onOpenCosts();
      return;
    }
    onReopenOnboarding();
  };

  return (
    <div className="control-overview" data-testid="control-center-overview">
      {error && <div className="error">加载概览失败：{error}</div>}
      <div className="control-overview__grid">
        <article className="control-overview-card">
          <span>Providers</span>
          <strong>{providers?.length ?? '—'}</strong>
          <small>{providers?.filter((p) => p.enabled).length ?? '—'} 个已启用</small>
        </article>
        <article className="control-overview-card">
          <span>模型</span>
          <strong>{modelStats.total || '—'}</strong>
          <small>{modelStats.chat} 对话 · {modelStats.image} 图像</small>
        </article>
        <article className="control-overview-card">
          <span>工具</span>
          <strong>{tools?.filter((tool) => tool.enabled).length ?? '—'}</strong>
          <small>{tools?.length ?? '—'} 个内置/扩展工具</small>
        </article>
        <article className="control-overview-card">
          <span>本月消费</span>
          <strong>{monthUsd == null ? '—' : formatUsd(monthUsd)}</strong>
          <small>来自统一成本记录</small>
        </article>
      </div>

      <div className="control-overview__actions">
        <button type="button" onClick={onOpenModels} data-testid="control-center-open-models">
          检查模型与供应商
        </button>
        <button type="button" onClick={onOpenMonitor} data-testid="control-center-open-monitor">
          查看后端监控
        </button>
        <button type="button" onClick={onOpenTools} data-testid="control-center-open-tools">
          管理工具能力
        </button>
        <button type="button" onClick={() => onOpenCosts()} data-testid="control-center-open-costs">
          查看成本与调用日志
        </button>
      </div>

      {budgetAlerts.length > 0 && (
        <section className="control-budget-alerts" data-testid="control-budget-alerts">
          {budgetAlerts.map((alert) => (
            <article
              key={alert.id}
              className={`control-budget-alert control-budget-alert--${alert.tone}`}
            >
              <div className="control-budget-alert__content">
                <strong>{alert.title}</strong>
                <p>{alert.detail}</p>
                <div className="control-budget-alert__chips">
                  {alert.chips.map((chip) => (
                    <span key={chip}>{chip}</span>
                  ))}
                </div>
              </div>
              <div className="control-budget-alert__actions">
                <button type="button" onClick={() => onOpenCosts()}>看成本建议</button>
                <button type="button" onClick={onOpenModels}>看模型配置</button>
              </div>
            </article>
          ))}
        </section>
      )}

      {providerRiskQueue.length > 0 && (
        <section className="control-provider-risk-queue" data-testid="control-provider-risk-queue">
          <div className="control-overview__section-head">
            <div>
              <h3>Provider 风险队列</h3>
              <p className="hint">先看出口层问题，再决定是去模型中心修配置还是去成本看板看真实影响。</p>
            </div>
            <button type="button" onClick={onOpenModels} data-testid="control-provider-risk-open-models">
              去模型中心
            </button>
          </div>
          <div className="control-provider-risk-list">
            {providerRiskQueue.map((item) => (
              <article
                key={item.id}
                className={`control-provider-risk control-provider-risk--${item.tone}`}
              >
                <div className="control-provider-risk__content">
                  <strong>{item.title}</strong>
                  <p>{item.detail}</p>
                  <div className="control-provider-risk__chips">
                    {item.chips.map((chip) => (
                      <span key={chip}>{chip}</span>
                    ))}
                  </div>
                </div>
                <div className="control-provider-risk__actions">
                  <button type="button" onClick={() => runOverviewAction(item.primaryAction)}>
                    {item.primaryLabel}
                  </button>
                  {item.secondaryAction && item.secondaryLabel ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (!item.secondaryAction) return;
                        if (item.secondaryAction === 'costs') {
                          onOpenCosts({
                            costRecordId: null,
                            runId: null,
                            runEventId: null,
                            providerKey: item.providerKey,
                            preferredScope: 'month',
                          });
                          return;
                        }
                        runOverviewAction(item.secondaryAction);
                      }}
                    >
                      {item.secondaryLabel}
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="control-overview__budget-grid" data-testid="control-budget-overview">
        <article className={`control-budget-card control-budget-card--${dailyBudgetTone}`}>
          <div className="control-budget-card__head">
            <div>
              <h3>今日预算</h3>
              <p className="hint">把预算告警提前到概览，方便快速判断今天还能不能继续跑。</p>
            </div>
            <button type="button" onClick={() => onOpenCosts()}>进入成本</button>
          </div>
          <div className="control-budget-card__metrics">
            <span>
              <small>已花费</small>
              <strong>{todayUsd == null ? '—' : formatUsd(todayUsd)}</strong>
            </span>
            <span>
              <small>预算</small>
              <strong>{dailyBudgetUsd == null ? '未设置' : formatUsd(dailyBudgetUsd)}</strong>
            </span>
            <span>
              <small>模式</small>
              <strong>{dailyHardLimit ? '硬上限' : '软提醒'}</strong>
            </span>
          </div>
          <div className="control-budget-card__footer">
            <span>超出日预算时 {dailyHardLimit ? '将直接阻断' : '会触发确认弹窗'}</span>
            <strong>{thresholdUsd == null ? '阈值未设置' : `单次阈值 ${formatUsd(thresholdUsd)}`}</strong>
          </div>
        </article>

        <article className={`control-budget-card control-budget-card--${monthlyBudgetTone}`}>
          <div className="control-budget-card__head">
            <div>
              <h3>本月预算</h3>
              <p className="hint">结合模型健康看预算，更接近“该不该继续用这个模型”的真实判断。</p>
            </div>
            <button type="button" onClick={onOpenModels}>看模型</button>
          </div>
          <div className="control-budget-card__metrics">
            <span>
              <small>已花费</small>
              <strong>{monthUsd == null ? '—' : formatUsd(monthUsd)}</strong>
            </span>
            <span>
              <small>预算</small>
              <strong>{monthlyBudgetUsd == null ? '未设置' : formatUsd(monthlyBudgetUsd)}</strong>
            </span>
            <span>
              <small>状态</small>
              <strong>
                {monthlyBudgetTone === 'over'
                  ? '超预算'
                  : monthlyBudgetTone === 'watch'
                    ? '接近上限'
                    : monthlyBudgetTone === 'healthy'
                      ? '安全'
                      : '待配置'}
              </strong>
            </span>
          </div>
          <div className="control-budget-card__footer">
            <span>超出月预算时 {monthlyHardLimit ? '将直接阻断' : '会触发确认弹窗'}</span>
            <strong>{topTagRows[0] ? `当前最高项目：${topTagRows[0].label}` : '暂无项目归因'}</strong>
          </div>
        </article>
      </section>

      <section className="control-overview__health" data-testid="control-health-overview">
        <article className="control-health-card" data-testid="control-model-health-summary">
          <div className="control-health-card__header">
            <div>
              <h3>模型 24h 健康</h3>
              <p className="hint">来自模型调用与失败成本记录</p>
            </div>
            <button type="button" onClick={onOpenModels} data-testid="control-health-open-models">
              进入模型
            </button>
          </div>
          <div className="control-health-metrics">
            <span>
              <small>调用</small>
              <strong data-testid="control-model-health-calls">{healthStats.modelCalls}</strong>
            </span>
            <span>
              <small>失败</small>
              <strong data-testid="control-model-health-failures">{healthStats.modelFailures}</strong>
            </span>
            <span>
              <small>受影响模型</small>
              <strong data-testid="control-model-health-affected">{healthStats.modelsWithFailures}</strong>
            </span>
          </div>
          <div className="control-health-card__footer">
            <span>最近失败</span>
            <strong data-testid="control-model-health-last-failure">{latestModelFailureText}</strong>
          </div>
        </article>

        <article className="control-health-card" data-testid="control-tool-health-summary">
          <div className="control-health-card__header">
            <div>
              <h3>工具 24h 健康</h3>
              <p className="hint">覆盖内置工具与 MCP 工具</p>
            </div>
            <button type="button" onClick={onOpenTools} data-testid="control-health-open-tools">
              进入工具
            </button>
          </div>
          <div className="control-health-metrics">
            <span>
              <small>调用</small>
              <strong data-testid="control-tool-health-calls">{healthStats.toolCalls}</strong>
            </span>
            <span>
              <small>失败</small>
              <strong data-testid="control-tool-health-failures">{healthStats.toolFailures}</strong>
            </span>
            <span>
              <small>受影响工具</small>
              <strong data-testid="control-tool-health-affected">{healthStats.toolsWithFailures}</strong>
            </span>
          </div>
          <div className="control-health-card__footer">
            <span>最近失败</span>
            <strong data-testid="control-tool-health-last-failure">{latestToolFailureText}</strong>
          </div>
        </article>

        <article className="control-health-card" data-testid="control-runtime-health-summary">
          <div className="control-health-card__header">
            <div>
              <h3>后端进程资源</h3>
              <p className="hint">Sidecar 实时 CPU / 内存占用，自动每 5 秒刷新</p>
            </div>
            <button type="button" onClick={() => setRefreshNonce((value) => value + 1)} data-testid="control-runtime-refresh">
              刷新
            </button>
          </div>
          <div className="control-health-metrics">
            <span>
              <small>CPU</small>
              <strong data-testid="control-runtime-cpu">
                {runtime?.cpu_percent == null ? '采样中' : `${runtime.cpu_percent}%`}
              </strong>
            </span>
            <span>
              <small>RSS 内存</small>
              <strong data-testid="control-runtime-rss">{formatBytes(runtime?.rss_bytes)}</strong>
            </span>
            <span>
              <small>Heap 已用</small>
              <strong data-testid="control-runtime-heap">{formatBytes(runtime?.heap_used_bytes)}</strong>
            </span>
          </div>
          <div className="control-health-card__footer">
            <span>
              PID {runtime?.pid ?? '—'} · 运行 {formatDuration(runtime?.uptime_ms)}
              {runtimeMemoryRatio == null ? '' : ` · 内存占宿主 ${runtimeMemoryRatio}%`}
            </span>
            <strong data-testid="control-runtime-mode">
              {runtime?.control_mode === 'desktop'
                ? 'Desktop 托管'
                : runtime?.control_mode === 'standalone'
                  ? 'Standalone'
                  : '—'}
            </strong>
          </div>
        </article>
      </section>

      <ModelHealthWall
        models={models}
        rows={modelHealthRows}
        onOpenModels={onOpenModels}
        onOpenCosts={onOpenCosts}
      />

      <section className="control-overview__calls control-overview__attribution" data-testid="control-cost-attribution-overview">
        <div className="control-overview__section-head">
          <div>
            <h3>项目 / 标签成本归因</h3>
            <p className="hint">帮助你快速判断最近成本主要消耗在哪些任务流上。</p>
          </div>
          <button type="button" onClick={() => onOpenCosts()}>打开成本看板</button>
        </div>
        {topTagRows.length === 0 ? (
          <p className="hint">给会话打标签后，这里会显示月度成本最高的项目。</p>
        ) : (
          <div className="control-attribution-list">
            {topTagRows.map((row) => (
              <article key={row.label} className="control-attribution-row">
                <div>
                  <strong>{row.label}</strong>
                  <small>{formatCount(row.count)} 折算调用</small>
                </div>
                <span>{formatUsd(row.sum_usd)}</span>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="control-overview__calls">
        <h3>最近外部调用</h3>
        {lastCalls.length === 0 ? (
          <p className="hint">暂无调用记录。开始对话或调用工具后，这里会显示真实出口。</p>
        ) : (
          <div className="control-overview-call-list">
            {lastCalls.map((call) => (
              <article key={call.id} className="control-overview-call">
                <strong>
                  {call.model_name_snapshot}
                  {call.provider_name ? ` · ${call.provider_name}` : ''}
                </strong>
                <span>
                  {call.feature} · {call.success ? '成功' : '失败'} ·{' '}
                  {call.actual_cost_usd == null ? '费用未知' : formatUsd(call.actual_cost_usd)}
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

interface ModelHealthWallEntry {
  modelId: string;
  modelName: string;
  providerId: string | null;
  state: 'healthy' | 'demoted' | 'cooldown';
  demoted: boolean;
  disabledUntil: number | null;
  failureCount24h: number;
  calls24h: number;
  failures24h: number;
  failureRate: number;
  avgFirstTokenMs: number | null;
  lastFailureAt: number | null;
  lastFailureClassification: string | null;
}

interface ModelHealthAction {
  id: string;
  tone: 'watch' | 'over';
  title: string;
  detail: string;
  chips: string[];
  modelId: string | null;
}

function ModelHealthWall({
  models,
  rows,
  onOpenModels,
  onOpenCosts,
}: {
  models: Model[] | null;
  rows: ModelHealthRow[] | null;
  onOpenModels: () => void;
  onOpenCosts: (focus?: CostCallFocusTarget | null) => void;
}): JSX.Element {
  const entries = useMemo<ModelHealthWallEntry[]>(() => {
    if (!models) return [];
    const rowById = new Map<string, ModelHealthRow>();
    for (const row of rows ?? []) rowById.set(row.model_id, row);
    const list: ModelHealthWallEntry[] = models.map((m) => {
      const row = rowById.get(m.id);
      const calls = row?.calls_24h ?? 0;
      const fails = row?.failures_24h ?? 0;
      const cooldown = m.disabled_until != null && m.disabled_until > Date.now();
      const state: ModelHealthWallEntry['state'] = cooldown
        ? 'cooldown'
        : m.demoted
          ? 'demoted'
          : 'healthy';
      return {
        modelId: m.id,
        modelName: m.display_name ?? m.model_name,
        providerId: m.provider_id ?? null,
        state,
        demoted: m.demoted,
        disabledUntil: cooldown ? m.disabled_until ?? null : null,
        failureCount24h: m.failure_count_24h ?? 0,
        calls24h: calls,
        failures24h: fails,
        failureRate: calls > 0 ? fails / calls : 0,
        avgFirstTokenMs: row?.avg_first_token_ms ?? null,
        lastFailureAt: row?.last_failure_at ?? null,
        lastFailureClassification: row?.last_failure_classification ?? null,
      };
    });
    const stateOrder: Record<ModelHealthWallEntry['state'], number> = {
      cooldown: 0,
      demoted: 1,
      healthy: 2,
    };
    return list.sort((a, b) => {
      const sa = stateOrder[a.state];
      const sb = stateOrder[b.state];
      if (sa !== sb) return sa - sb;
      if (a.failureRate !== b.failureRate) return b.failureRate - a.failureRate;
      return b.calls24h - a.calls24h;
    });
  }, [models, rows]);

  const summary = useMemo(() => {
    let cooldown = 0;
    let demoted = 0;
    let healthy = 0;
    for (const entry of entries) {
      if (entry.state === 'cooldown') cooldown += 1;
      else if (entry.state === 'demoted') demoted += 1;
      else healthy += 1;
    }
    return { cooldown, demoted, healthy };
  }, [entries]);
  const actions = useMemo<ModelHealthAction[]>(() => {
    const list: ModelHealthAction[] = [];
    const cooldownModels = entries.filter((entry) => entry.state === 'cooldown');
    if (cooldownModels.length > 0) {
      const first = cooldownModels[0]!;
      list.push({
        id: 'cooldown',
        tone: 'over',
        title: `有 ${cooldownModels.length} 个模型正在冷却`,
        detail: `${first.modelName}${cooldownModels.length > 1 ? ' 等模型' : ''} 已被自动禁用。建议先把默认任务切到健康模型，再去模型中心检查 fallback 顺序。`,
        chips: [
          `${first.modelName}`,
          first.disabledUntil ? `恢复 ${formatCountdown(first.disabledUntil)}` : '恢复时间待定',
        ],
        modelId: first.modelId,
      });
    }
    const demotedModels = entries.filter((entry) => entry.state === 'demoted');
    if (demotedModels.length > 0) {
      const first = demotedModels[0]!;
      list.push({
        id: 'demoted',
        tone: 'watch',
        title: `有 ${demotedModels.length} 个模型已被降级`,
        detail: `${first.modelName}${demotedModels.length > 1 ? ' 等模型' : ''} 仍可手动选用，但已退出自动优先链。建议结合成本和错误类型决定是否恢复。`,
        chips: [
          `${first.modelName}`,
          first.lastFailureClassification
            ? MODEL_FAILURE_LABELS[first.lastFailureClassification] ?? first.lastFailureClassification
            : '错误待复核',
        ],
        modelId: first.modelId,
      });
    }
    const risky = entries
      .filter((entry) => entry.calls24h >= 2 && entry.failureRate >= 0.3)
      .sort((a, b) => b.failureRate - a.failureRate)[0] ?? null;
    if (risky) {
      list.push({
        id: 'risky',
        tone: 'watch',
        title: `${risky.modelName} 近期失败率偏高`,
        detail: `近 24h 失败率约 ${Math.round(risky.failureRate * 100)}%。如果它还承担高频任务，建议先去成本看板看支出，再决定是否降权或更换默认模型。`,
        chips: [
          `${risky.failures24h}/${risky.calls24h} 失败`,
          risky.avgFirstTokenMs == null ? '首字待采样' : `首字 ${Math.round(risky.avgFirstTokenMs)}ms`,
        ],
        modelId: risky.modelId,
      });
    }
    return list.slice(0, 3);
  }, [entries]);

  if (!models || models.length === 0) return <></>;

  return (
    <section className="control-overview__health-wall" data-testid="control-model-health-wall">
      <header className="control-overview__health-wall-head">
        <div>
          <h3>模型健康详情</h3>
          <p className="hint">
            红绿灯按模型聚合：冷却中（被自动禁用）/ 降级（仍可手动触发，但已退出自动选择）/ 健康。
          </p>
        </div>
        <div className="control-overview__health-wall-summary">
          <span data-tone="cooldown" data-testid="health-wall-cooldown">
            冷却 {summary.cooldown}
          </span>
          <span data-tone="demoted" data-testid="health-wall-demoted">
            降级 {summary.demoted}
          </span>
          <span data-tone="healthy" data-testid="health-wall-healthy">
            健康 {summary.healthy}
          </span>
          <button type="button" onClick={onOpenModels} data-testid="health-wall-open-models">
            管理模型
          </button>
        </div>
      </header>
      {actions.length > 0 && (
        <div className="control-health-wall-actions" data-testid="control-health-wall-actions">
          {actions.map((action) => (
            <article
              key={action.id}
              className={`control-health-wall-action control-health-wall-action--${action.tone}`}
              data-testid={`control-health-wall-action-${action.id}`}
            >
              <div className="control-health-wall-action__content">
                <strong>{action.title}</strong>
                <p>{action.detail}</p>
                <div className="control-health-wall-action__chips">
                  {action.chips.map((chip) => (
                    <span key={chip}>{chip}</span>
                  ))}
                </div>
              </div>
              <div className="control-health-wall-action__buttons">
                <button type="button" onClick={onOpenModels}>去模型中心</button>
                <button
                  type="button"
                  onClick={() =>
                    onOpenCosts(
                      action.modelId
                        ? {
                            costRecordId: null,
                            runId: null,
                            runEventId: null,
                            modelId: action.modelId,
                            preferredScope: 'month',
                          }
                        : null,
                    )}
                  data-testid={`control-health-wall-action-cost-${action.id}`}
                >
                  看该模型成本
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      <ul className="control-overview__health-wall-grid">
        {entries.map((entry) => {
          const tone = entry.state;
          const failureRatePct = entry.calls24h > 0 ? Math.round(entry.failureRate * 100) : null;
          const lastFailureLabel = entry.lastFailureClassification
            ? MODEL_FAILURE_LABELS[entry.lastFailureClassification] ?? entry.lastFailureClassification
            : null;
          return (
            <li
              key={entry.modelId}
              className={`control-health-wall-card control-health-wall-card--${tone}`}
              data-testid={`health-wall-row-${entry.modelId}`}
              data-state={tone}
            >
              <div className="control-health-wall-card__head">
                <span className={`control-health-wall-led control-health-wall-led--${tone}`} aria-hidden="true" />
                <strong>{entry.modelName}</strong>
                <span className="control-health-wall-card__state">
                  {tone === 'cooldown'
                    ? `冷却中 · ${formatCountdown(entry.disabledUntil)}`
                    : tone === 'demoted'
                      ? '已降级'
                      : '健康'}
                </span>
              </div>
              <div className="control-health-wall-card__metrics">
                <span>
                  <small>24h 调用</small>
                  <strong>{entry.calls24h}</strong>
                </span>
                <span>
                  <small>失败</small>
                  <strong>
                    {entry.failures24h}
                    {failureRatePct != null ? ` · ${failureRatePct}%` : ''}
                  </strong>
                </span>
                <span>
                  <small>首 token</small>
                  <strong>
                    {entry.avgFirstTokenMs == null
                      ? '—'
                      : entry.avgFirstTokenMs < 1000
                        ? `${Math.round(entry.avgFirstTokenMs)}ms`
                        : `${(entry.avgFirstTokenMs / 1000).toFixed(1)}s`}
                  </strong>
                </span>
              </div>
              <div className="control-health-wall-card__foot">
                {entry.lastFailureAt ? (
                  <span>
                    最近失败 {formatAgo(entry.lastFailureAt)}
                    {lastFailureLabel ? ` · ${lastFailureLabel}` : ''}
                  </span>
                ) : (
                  <span>近 24h 无失败</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RuntimeMonitorSection(): JSX.Element {
  const [runtime, setRuntime] = useState<RuntimeResourceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const load = async (): Promise<void> => {
      try {
        const runtimeRes = await api.runtimeDiagnostics();
        if (cancelled) return;
        setRuntime(runtimeRes.data);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
      if (!cancelled) {
        timer = window.setTimeout(() => {
          void load();
        }, 5000);
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [refreshNonce]);

  const memoryRatio =
    runtime && runtime.system_memory_bytes > 0
      ? Math.min(100, Math.round((runtime.rss_bytes / runtime.system_memory_bytes) * 1000) / 10)
      : null;

  return (
    <div className="control-runtime" data-testid="control-runtime-section">
      {error && <div className="error">加载运行监控失败：{error}</div>}
      <section className="control-health-card control-runtime__hero">
        <div className="control-health-card__header">
          <div>
            <h3>后端资源监控</h3>
            <p className="hint">每 5 秒自动刷新一次，观察 Sidecar 当前 CPU、内存与运行态。</p>
          </div>
          <button type="button" onClick={() => setRefreshNonce((value) => value + 1)} data-testid="control-runtime-manual-refresh">
            立即刷新
          </button>
        </div>
        <div className="control-health-metrics control-runtime__metrics">
          <span>
            <small>CPU</small>
            <strong data-testid="control-runtime-cpu-detail">
              {runtime?.cpu_percent == null ? '采样中' : `${runtime.cpu_percent}%`}
            </strong>
          </span>
          <span>
            <small>RSS</small>
            <strong data-testid="control-runtime-rss-detail">{formatBytes(runtime?.rss_bytes)}</strong>
          </span>
          <span>
            <small>Heap 已用</small>
            <strong data-testid="control-runtime-heap-detail">{formatBytes(runtime?.heap_used_bytes)}</strong>
          </span>
          <span>
            <small>Heap 总量</small>
            <strong>{formatBytes(runtime?.heap_total_bytes)}</strong>
          </span>
        </div>
        <div className="control-runtime__grid">
          <article className="control-overview-card">
            <span>运行模式</span>
            <strong data-testid="control-runtime-mode-detail">
              {runtime?.control_mode === 'desktop'
                ? 'Desktop 托管'
                : runtime?.control_mode === 'standalone'
                  ? 'Standalone'
                  : '—'}
            </strong>
            <small>PID {runtime?.pid ?? '—'}</small>
          </article>
          <article className="control-overview-card">
            <span>运行时长</span>
            <strong>{formatDuration(runtime?.uptime_ms)}</strong>
            <small>{runtime ? new Date(runtime.started_at).toLocaleString() : '—'}</small>
          </article>
          <article className="control-overview-card">
            <span>宿主内存占比</span>
            <strong>{memoryRatio == null ? '—' : `${memoryRatio}%`}</strong>
            <small>可用 {formatBytes(runtime?.system_free_memory_bytes)}</small>
          </article>
          <article className="control-overview-card">
            <span>并行度</span>
            <strong>{runtime?.available_parallelism ?? '—'}</strong>
            <small>DB: {runtime?.db_path ?? '—'}</small>
          </article>
        </div>
      </section>
    </div>
  );
}
