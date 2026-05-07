import { useEffect, useMemo, useState } from 'react';
import type { Model, ModelHealthRow, Provider, Tool, ToolHealthRow } from '@taori/shared';
import { formatUsd } from '@taori/shared';
import { api } from './api.js';
import { CostDashboard } from './CostDashboard.js';
import { ModelCenter } from './ModelCenter.js';
import { EmptyState } from './EmptyState.js';
import { SettingsContent } from './Settings.js';

export type ControlCenterSection =
  | 'overview'
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
  costRecordId: string;
  runId: string | null;
  runEventId: string | null;
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
    icon: '⌁',
    keywords: ['总览', 'overview', '系统', '健康', '调用'],
  },
  {
    id: 'models',
    label: '模型与供应商',
    description: 'Provider、模型、价格、健康',
    icon: '🧬',
    keywords: ['provider', '供应商', '模型', '价格', '健康'],
  },
  {
    id: 'tools',
    label: '工具能力',
    description: '内置工具开关与能力说明',
    icon: '🛠',
    legacyTestId: 'settings-tab-tools',
    keywords: ['工具', 'mcp', '能力', 'tool'],
  },
  {
    id: 'costs',
    label: '成本与调用',
    description: '预算、看板、真实出口日志',
    icon: '💸',
    keywords: ['成本', '预算', '费用', '日志', '调用'],
  },
  {
    id: 'prompts',
    label: '模板与 Persona',
    description: 'Prompt 模板、角色预设',
    icon: '✍',
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
            <div className="control-center__close-actions">
              {activeSection === 'models' && (
                <button
                  type="button"
                  className="control-center__compat-close"
                  onClick={onClose}
                  data-testid="model-center-close"
                >
                  关闭模型中心
                </button>
              )}
              {activeSection === 'costs' && (
                <button
                  type="button"
                  className="control-center__compat-close"
                  onClick={onClose}
                  data-testid="cost-dashboard-close"
                >
                  关闭成本看板
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
                onOpenModels={() => setActiveSection('models')}
                onOpenTools={() => setActiveSection('tools')}
                onOpenCosts={() => setActiveSection('costs')}
              />
            )}
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
                focusTarget={costCallFocus}
                onFocusConsumed={onCostCallFocusConsumed}
                onClose={onClose}
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
  onOpenModels,
  onOpenTools,
  onOpenCosts,
}: {
  onOpenModels: () => void;
  onOpenTools: () => void;
  onOpenCosts: () => void;
}): JSX.Element {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [models, setModels] = useState<Model[] | null>(null);
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [modelHealthRows, setModelHealthRows] = useState<ModelHealthRow[] | null>(null);
  const [toolHealthRows, setToolHealthRows] = useState<ToolHealthRow[] | null>(null);
  const [monthUsd, setMonthUsd] = useState<number | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [
          providerRes,
          modelRes,
          toolRes,
          modelHealthRes,
          toolHealthRes,
          realtimeRes,
          callsRes,
        ] = await Promise.all([
          api.listProviders(),
          api.listModels(),
          api.listTools(),
          api.modelsHealth().catch(() => ({ rows: [] })),
          api.toolsHealth().catch(() => ({ rows: [] })),
          api.costsRealtime().catch(() => ({ data: { month_usd: null } })),
          api.costsCallLogs(5).catch(() => ({ data: { rows: [] } })),
        ]);
        if (cancelled) return;
        setProviders(providerRes.providers);
        setModels(modelRes.models);
        setTools(toolRes.data);
        setModelHealthRows(modelHealthRes.rows);
        setToolHealthRows(toolHealthRes.rows);
        setMonthUsd(
          typeof realtimeRes.data.month_usd === 'number' ? realtimeRes.data.month_usd : null,
        );
        setLastCalls(callsRes.data.rows ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
        <button type="button" onClick={onOpenTools} data-testid="control-center-open-tools">
          管理工具能力
        </button>
        <button type="button" onClick={onOpenCosts} data-testid="control-center-open-costs">
          查看成本与调用日志
        </button>
      </div>

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
