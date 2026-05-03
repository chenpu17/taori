import { useEffect, useMemo, useState } from 'react';
import type { Model, Provider, Tool } from '@taori/shared';
import { formatUsd } from '@taori/shared';
import { api } from './api.js';
import { CostDashboard } from './CostDashboard.js';
import { ModelCenter } from './ModelCenter.js';
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
  onClose: () => void;
  onChanged: () => void;
  onModelsChanged: () => void;
  onReopenOnboarding: () => void;
}

const NAV_ITEMS: Array<{
  id: ControlCenterSection;
  label: string;
  description: string;
  icon: string;
  legacyTestId?: string;
}> = [
  {
    id: 'overview',
    label: '概览',
    description: '系统状态、最近调用、关键入口',
    icon: '⌁',
  },
  {
    id: 'models',
    label: '模型与供应商',
    description: 'Provider、模型、价格、健康',
    icon: '🧬',
  },
  {
    id: 'tools',
    label: '工具能力',
    description: '内置工具开关与能力说明',
    icon: '🛠',
    legacyTestId: 'settings-tab-tools',
  },
  {
    id: 'costs',
    label: '成本与调用',
    description: '预算、看板、真实出口日志',
    icon: '💸',
  },
  {
    id: 'prompts',
    label: '模板与 Persona',
    description: 'Prompt 模板、角色预设',
    icon: '✍',
    legacyTestId: 'settings-tab-prompts',
  },
  {
    id: 'general',
    label: '通用与数据',
    description: '预算、兜底、Onboarding、清理',
    icon: '⚙',
    legacyTestId: 'settings-tab-general',
  },
];

export function ControlCenter({
  initialSection,
  onClose,
  onChanged,
  onModelsChanged,
  onReopenOnboarding,
}: ControlCenterProps): JSX.Element {
  const [activeSection, setActiveSection] = useState<ControlCenterSection>(initialSection);

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
          <nav className="control-center__nav">
            {NAV_ITEMS.map((item) => (
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
          </nav>
        </aside>

        <section className="control-center__main">
          <header className="control-center__header">
            <div>
              <h2>{activeItem.label}</h2>
              <p className="hint">{activeItem.description}</p>
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
            {activeSection === 'costs' && <CostDashboard embedded onClose={onClose} />}
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
        const [providerRes, modelRes, toolRes, realtimeRes, callsRes] = await Promise.all([
          api.listProviders(),
          api.listModels(),
          api.listTools(),
          api.costsRealtime().catch(() => ({ data: { month_usd: null } })),
          api.costsCallLogs(5).catch(() => ({ data: { rows: [] } })),
        ]);
        if (cancelled) return;
        setProviders(providerRes.providers);
        setModels(modelRes.models);
        setTools(toolRes.data);
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
