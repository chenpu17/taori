import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BrandMark, Icon, ModelDot, MODELS, type IconName, type ModelId } from './primitives';
import type { Model, Provider } from '@taori/shared';
import type { Conversation, CostBreakdownResponse, ProviderKeyStatus, RealtimeCost } from './api';
import { patchModel, toggleTool, createProvider, patchProvider, deleteConversation, listConversations } from './api';
import type { ApiError } from './api';
import { useFooterHealth, useModels } from './useLiveData';
import { MODES } from './scenarios';

/** Palette for hashing unknown providers to distinct colors. */
const PROVIDER_COLORS = [
  'var(--m-sonnet)', 'var(--m-gpt)', 'var(--m-deepseek)', 'var(--m-gemini)',
  '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb923c',
];

/** Deterministic color from a string hash. */
function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return PROVIDER_COLORS[Math.abs(h) % PROVIDER_COLORS.length];
}

/** Map a provider type (and optionally name) to an identity color. */
function providerColor(type?: string | null, name?: string | null): string {
  switch (type) {
    case 'anthropic': return 'var(--m-sonnet)';
    case 'openai': return 'var(--m-gpt)';
    case 'openrouter': return 'var(--m-deepseek)';
    case 'google': return 'var(--m-gemini)';
    default: return name ? hashColor(name) : 'var(--m-taori)';
  }
}

// ── Mode menu (composer +) ───────────────────────────────────
const MODE_ITEMS = [
  { id: 'roundtable', icon: 'roundtable' as const, name: '圆桌', desc: '让 3 个模型一起讨论', kbd: '/roundtable' },
  { id: 'research', icon: 'research' as const, name: '研究', desc: '多轮搜索 + 综述', kbd: '/research' },
  { id: 'compare', icon: 'compare' as const, name: '对比', desc: '并排看 2-3 个模型回答', kbd: '/compare' },
  { id: 'image', icon: 'image' as const, name: '生图', desc: '调用图像模型', kbd: '/image' },
  { id: 'file', icon: 'attach' as const, name: '附件', desc: '也可以直接拖文件', kbd: '/file' },
];

export function ModeMenu({ onPick }: { onPick?: (id: string) => void }) {
  return (
    <div className="popup mode-menu">
      <div className="mode-menu-section">模式 · 按 / 直接调用</div>
      {MODE_ITEMS.map((it) => (
        <div key={it.id} className="mode-menu-item" onClick={() => onPick?.(it.id)}>
          <span className="ico"><Icon name={it.icon} size={14} /></span>
          <span className="col">
            <span className="name">{it.name}</span>
            <span className="desc">{it.desc}</span>
          </span>
          <span className="kbd">{it.kbd}</span>
        </div>
      ))}
    </div>
  );
}

// ── Model picker ─────────────────────────────────────────────
export interface LiveModelEntry {
  /** Display name (e.g. "Claude Sonnet 4"). */
  name: string;
  /** Short label (e.g. "Sonnet 4"). */
  short: string;
  /** Provider label (e.g. "Anthropic"). */
  provider: string;
  /** Identity color for the dot. */
  color: string;
  /** Stable id used by the parent (we fall back to mock ModelId when no live data). */
  id: string;
  /** Coarse price tier reused from the mock palette. */
  price: string;
}

export function shapeLiveModels(models: Model[], providers: Provider[]): LiveModelEntry[] {
  const byId = new Map(providers.map((p) => [p.id, p]));
  return models
    .filter((m) => m.enabled && m.capability !== 'image')
    .slice(0, 6)
    .map((m) => {
      const prov = m.provider_id ? byId.get(m.provider_id) : undefined;
      const inputUsd = m.price_input_per_1m ?? 0;
      const tier = inputUsd > 5 ? '$$$' : inputUsd > 1 ? '$$' : inputUsd > 0 ? '$' : '免费';
      return {
        id: m.id,
        name: m.display_name,
        short: m.alias || m.display_name,
        provider: prov?.name ?? '—',
        color: providerColor(prov?.type, prov?.name),
        price: tier,
      };
    });
}

interface ModelPickerProps {
  current?: ModelId;
  onPick?: (id: ModelId) => void;
  /** Live entries from /v1/models — when present, replaces the static "recent" list. */
  liveEntries?: LiveModelEntry[];
  /** Currently selected live id (only relevant when liveEntries is given). */
  liveCurrentId?: string;
  /** Callback when a live entry is picked. */
  onPickLive?: (id: string) => void;
  /** Callback when "管理所有模型" footer is clicked. */
  onOpenManager?: () => void;
}

export function ModelPicker({ current = 'sonnet', onPick, liveEntries, liveCurrentId, onPickLive, onOpenManager }: ModelPickerProps) {
  const useLive = (liveEntries?.length ?? 0) > 0;
  const [search, setSearch] = useState('');
  const q = search.toLowerCase();
  const filteredLive = useLive && liveEntries ? liveEntries.filter((m) => !q || m.name.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q)) : [];
  const filteredMock = !useLive ? (['sonnet', 'gpt4o', 'deepseek', 'gemini', 'dalle'] as ModelId[]).filter((id) => { const m = MODELS[id]; return !q || m.name.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q); }) : [];
  return (
    <div className="popup model-picker" role="listbox">
      <div className="model-picker-search">
        <Icon name="search" size={13} style={{ color: 'var(--text-muted)' }} />
        <input placeholder="搜模型 / Provider" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="kbd">/</span>
      </div>
      <div className="model-picker-section">{useLive ? '已启用' : '最近'}</div>
      {useLive
        ? filteredLive.map((m) => (
            <div
              key={m.id}
              className={'model-picker-item' + (liveCurrentId === m.id ? ' active' : '')}
              role="option"
              onClick={() => onPickLive?.(m.id)}
            >
              <span className="dot" style={{ background: m.color }} />
              <span className="name">{m.name}</span>
              <span className="price">{m.price}</span>
              <span className="provider">{m.provider}</span>
              {liveCurrentId === m.id && <Icon name="check" size={12} style={{ color: 'var(--accent)' }} />}
            </div>
          ))
        : filteredMock.map((id) => {
            const m = MODELS[id];
            return (
              <div key={id} className={'model-picker-item' + (current === id ? ' active' : '')} role="option" onClick={() => onPick?.(id)}>
                <ModelDot model={id} />
                <span className="name">{m.name}</span>
                <span className="price">{m.price}</span>
                <span className="provider">{m.provider}</span>
                {current === id && <Icon name="check" size={12} style={{ color: 'var(--accent)' }} />}
              </div>
            );
          })}
      <div className="model-picker-foot" onClick={() => onOpenManager?.()}>
        <Icon name="sliders" size={13} />
        管理所有模型
        <span style={{ flex: 1 }} />
        <Icon name="chevron-right" size={13} />
      </div>
    </div>
  );
}

// ── Footer popups ────────────────────────────────────────────
interface HealthPopupProps {
  /** When provided, renders real provider rows instead of mock ones. */
  providers?: Provider[];
  /** Per-provider key availability (matched on provider_id). */
  keyStatuses?: ProviderKeyStatus[];
  onNavigate?: () => void;
}

export function HealthPopup({ providers, keyStatuses, onNavigate }: HealthPopupProps = {}) {
  const live = providers && providers.length > 0;
  const dotBg: Record<'ok' | 'warn' | 'off', string> = {
    ok: 'var(--ok)',
    warn: 'var(--warn)',
    off: 'var(--text-faint)',
  };

  type Row = { id: string; name: string; meta: string; dot: 'ok' | 'warn' | 'off' };
  const rows: Row[] = live
    ? providers!.map((p) => {
        const k = keyStatuses?.find((s) => s.provider_id === p.id);
        const enabled = p.enabled;
        const hasKey = !!k?.key_available;
        const dot: Row['dot'] = !enabled ? 'off' : hasKey ? 'ok' : 'warn';
        const status = !enabled ? '已禁用' : hasKey ? '在线' : '未配置 Key';
        const url = (() => {
          try { return new URL(p.base_url).host; } catch { return p.base_url; }
        })();
        return { id: p.id, name: p.name, meta: `${status} · ${p.type} · ${url}`, dot };
      })
    : [
        { id: 'anthropic', name: 'Anthropic', meta: '正常 · 平均 0.9s · 错误率 0.0%', dot: 'ok' },
        { id: 'openai', name: 'OpenAI', meta: '部分限流 · 平均 1.4s · 错误率 4.2%', dot: 'warn' },
        { id: 'openrouter', name: 'OpenRouter', meta: '正常 · 平均 1.1s · 错误率 0.3%', dot: 'ok' },
        { id: 'google', name: 'Google', meta: '正常 · 平均 1.0s · 错误率 0.2%', dot: 'ok' },
        { id: 'ollama', name: 'Local Ollama', meta: '未连接', dot: 'off' },
      ];

  return (
    <div className="foot-popup">
      <div className="foot-popup-title">
        Provider {live ? '· 实时' : '健康度 · 最近 24h'}
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>
          还没有配置任何 Provider · 在「模型 & 工具」里添加
        </div>
      ) : (
        rows.map((p) => (
          <div key={p.id} className="foot-popup-row">
            <span className="k">
              <span
                className="dot"
                style={{
                  background: dotBg[p.dot],
                  boxShadow: p.dot === 'ok' ? '0 0 6px rgba(79,180,122,0.5)' : 'none',
                }}
              />
              {p.name}
            </span>
            <span className="v dim">{p.meta}</span>
          </div>
        ))
      )}
      <div className="foot-popup-footer">
        <span>{live ? `${rows.length} 个 Provider` : '2 次自动兜底切换'}</span>
        <span className="foot-popup-link" onClick={onNavigate}>完整诊断 →</span>
      </div>
    </div>
  );
}

interface CostTodayPopupProps {
  /** Live realtime snapshot — drives the title amount. */
  realtime?: RealtimeCost | null;
  /** Live `today` breakdown grouped by model — drives the per-model rows. */
  breakdown?: CostBreakdownResponse | null;
  /** Daily budget in USD. */
  budgetUsd?: number;
  onNavigate?: () => void;
}

export function CostTodayPopup({ realtime, breakdown, budgetUsd = 5, onNavigate }: CostTodayPopupProps = {}) {
  const live = !!realtime;
  const todayUsd = realtime?.today_usd ?? 0.42;
  const monthUsd = realtime?.month_usd ?? 9.4;
  const fmt = (v: number) => `$${v.toFixed(2)}`;
  const pct = budgetUsd > 0 ? Math.min(100, (todayUsd / budgetUsd) * 100) : 0;

  // Build per-row data: prefer real breakdown, fall back to mock palette.
  type Row = { key: string; label: string; total: number; calls: number; color: string };
  const palette = ['var(--m-sonnet)', 'var(--m-gpt)', 'var(--m-deepseek)', 'var(--m-gemini)', 'var(--m-dalle)'];
  const rows: Row[] = live && breakdown && breakdown.rows.length > 0
    ? breakdown.rows.slice(0, 5).map((r, i) => ({
        key: r.key,
        label: r.label || r.model_name_snapshot || r.key,
        total: r.sum_usd ?? 0,
        calls: r.count ?? 0,
        color: palette[i % palette.length],
      }))
    : [
        { key: 'sonnet', label: 'Sonnet', total: 0.16, calls: 14, color: 'var(--m-sonnet)' },
        { key: 'gpt4o', label: 'GPT-4o', total: 0.11, calls: 7, color: 'var(--m-gpt)' },
        { key: 'gemini', label: 'Gemini', total: 0.06, calls: 5, color: 'var(--m-gemini)' },
        { key: 'deepseek', label: 'DeepSeek', total: 0.05, calls: 12, color: 'var(--m-deepseek)' },
        { key: 'dalle', label: 'DALL·E 3', total: 0.04, calls: 1, color: 'var(--m-dalle)' },
      ];

  const totalForBars = rows.reduce((sum, r) => sum + r.total, 0) || 1;

  return (
    <div className="foot-popup">
      <div className="foot-popup-title">
        今日成本 · {fmt(todayUsd)} / {fmt(budgetUsd)} ({pct.toFixed(0)}%)
      </div>
      <div className="foot-popup-bar">
        {rows.map((r) => (
          <div key={r.key} style={{ width: `${(r.total / totalForBars) * 100}%`, background: r.color }} />
        ))}
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>
          今天还没有调用记录
        </div>
      ) : (
        rows.map((r) => (
          <div className="foot-popup-row" key={r.key}>
            <span className="k">
              <span className="dot" style={{ background: r.color }} />
              <span>{r.label}</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                · {r.calls} 次调用
              </span>
            </span>
            <span className="v">{fmt(r.total)}</span>
          </div>
        ))
      )}
      <div className="foot-popup-footer">
        <span>本月 {fmt(monthUsd)}</span>
        <span className="foot-popup-link" onClick={onNavigate}>看完整看板 →</span>
      </div>
    </div>
  );
}

export function CostSessionPopup({ onNavigate }: { onNavigate?: () => void } = {}) {
  const rows: { model: ModelId; v: string; sub: string }[] = [
    { model: 'sonnet', v: '¥0.020', sub: '142→580 tok · 1.2s' },
    { model: 'gpt4o', v: '¥0.012', sub: '142→412 tok · 0.9s' },
    { model: 'deepseek', v: '¥0.005', sub: '142→604 tok · 0.7s' },
    { model: 'taori', v: '¥0.003', sub: '综合 · sonnet · 0.4s' },
  ];
  return (
    <div className="foot-popup">
      <div className="foot-popup-title">本会话 · ¥0.04 · 4 次调用</div>
      {rows.map((r, i) => (
        <div className="foot-popup-row" key={i}>
          <span className="k">
            <ModelDot model={r.model} />
            <span>{MODELS[r.model].short}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>· {r.sub}</span>
          </span>
          <span className="v">{r.v}</span>
        </div>
      ))}
      <div className="foot-popup-footer">
        <span>预估 输入 12% · 输出 88%</span>
        <span className="foot-popup-link" onClick={onNavigate}>导出本会话 →</span>
      </div>
    </div>
  );
}

// ── Header overflow menu ─────────────────────────────────────
export type Theme = 'light' | 'dark' | 'auto';
export type DrawerId = 'models' | 'settings';

export function OverMenu({ onOpenDrawer, theme, onTheme, onHelp }: { onOpenDrawer: (id: DrawerId) => void; theme: Theme; onTheme: (t: Theme) => void; onHelp?: () => void }) {
  return (
    <div className="over-menu">
      <div className="over-menu-item" onClick={() => onOpenDrawer('models')}>
        <span className="ico"><Icon name="cube" size={15} /></span>
        模型 & 工具
        <span className="arrow"><Icon name="chevron-right" size={13} /></span>
      </div>
      <div className="over-menu-item" onClick={() => onOpenDrawer('settings')}>
        <span className="ico"><Icon name="settings" size={15} /></span>
        设置
        <span className="arrow"><Icon name="chevron-right" size={13} /></span>
      </div>
      <div className="over-menu-sep" />
      <div className="over-menu-theme">
        <span className="over-menu-theme-label">
          <span className="ico"><Icon name={theme === 'dark' ? 'moon' : 'sun'} size={15} /></span>
          外观
        </span>
        <div className="over-menu-theme-seg">
          <button type="button" className={theme === 'light' ? 'on' : ''} onClick={() => onTheme('light')}>浅</button>
          <button type="button" className={theme === 'dark' ? 'on' : ''} onClick={() => onTheme('dark')}>深</button>
          <button type="button" className={theme === 'auto' ? 'on' : ''} onClick={() => onTheme('auto')}>自动</button>
        </div>
      </div>
      <div className="over-menu-sep" />
      <div className="over-menu-item" onClick={() => onHelp?.()}>
        <span className="ico"><Icon name="help" size={15} /></span>
        帮助 & 快捷键
      </div>
    </div>
  );
}

// ── Drawer A — Model & Tools ─────────────────────────────────
const MODEL_TOOL_TABS = [
  { id: 'providers', name: 'Providers', icon: 'database' as const, badge: '4' },
  { id: 'models', name: '模型', icon: 'cube' as const, badge: '12' },
  { id: 'tools', name: '工具', icon: 'tool' as const, badge: '7' },
  { id: 'templates', name: '模板', icon: 'doc' as const, badge: '5' },
];

export function ModelToolsDrawer({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'providers' | 'models' | 'tools' | 'templates'>('models');
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <Icon name="cube" size={16} style={{ color: 'var(--text-secondary)' }} />
          <span className="title">模型 & 工具</span>
          <span className="spacer" />
          <span className="esc-hint">esc 关闭</span>
          <button className="close" type="button" aria-label="关闭" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="drawer-tabs">
          {MODEL_TOOL_TABS.map((t) => (
            <div key={t.id} className={'drawer-tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id as typeof tab)}>
              <Icon name={t.icon} size={14} />
              <span>{t.name}</span>
              <span className="badge">{t.badge}</span>
            </div>
          ))}
        </div>
        <div className="drawer-body">
          {tab === 'providers' && <DrawerProviders />}
          {tab === 'models' && <DrawerModels />}
          {tab === 'tools' && <DrawerTools />}
          {tab === 'templates' && <DrawerTemplates />}
        </div>
      </div>
    </>
  );
}

function DrawerProviders() {
  const footer = useFooterHealth();
  const liveProviders = footer.data?.providers;
  const keyStatuses = footer.data?.keyStatuses ?? [];
  const pillLabel: Record<string, string> = { ok: '正常', warn: '降级', off: '未连接' };

  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const selectedProvider = liveProviders?.find((p) => p.id === selected);

  const mockRows = [
    { id: 'mock-1', name: 'OpenRouter', sub: 'sk-or-v1-····2c8f · 1 个 Key', status: 'ok' as const },
    { id: 'mock-2', name: 'Anthropic', sub: 'sk-ant-····7a13 · 直连', status: 'ok' as const },
    { id: 'mock-3', name: 'OpenAI', sub: 'sk-····8e92 · 限流 4.2%', status: 'warn' as const },
    { id: 'mock-4', name: 'Google', sub: 'AIza····91FQ · Vertex', status: 'ok' as const },
    { id: 'mock-5', name: 'Local Ollama', sub: 'localhost:11434 · 未连接', status: 'off' as const },
  ];

  const rows = liveProviders && liveProviders.length > 0
    ? liveProviders.map((p) => {
        const k = keyStatuses.find((s) => s.provider_id === p.id);
        const status = !p.enabled || !k?.key_available ? 'off' : 'ok';
        return { id: p.id, name: p.name, sub: p.type + (k?.key_available ? ' · Key ✓' : ''), status: status as 'ok' | 'warn' | 'off' };
      })
    : mockRows;

  const fallbackNames = liveProviders && liveProviders.length > 0
    ? liveProviders.filter((p) => p.enabled).map((p) => p.name)
    : ['Anthropic', 'OpenRouter', 'OpenAI', 'Google'];

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const { authedFetch } = await import('./sidecar');
      const res = await authedFetch(`/v1/providers/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider_id: id }) });
      const data = await res.json();
      setToast(data.ok ? '连接成功 ✓' : `连接失败: ${data.error ?? '未知错误'}`);
    } catch (e) {
      setToast(`测试失败: ${(e as Error).message}`);
    }
    setTesting(null);
    setTimeout(() => setToast(null), 3000);
  };

  const handleDelete = async (id: string) => {
    try {
      const { authedFetch } = await import('./sidecar');
      await authedFetch(`/v1/providers/${id}`, { method: 'DELETE' });
      setSelected(null);
      setToast('已删除');
      footer.refetch?.();
    } catch {
      setToast('删除失败');
    }
    setTimeout(() => setToast(null), 3000);
  };

  const handleAdd = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      await createProvider({
        name: fd.get('name') as string,
        type: fd.get('type') as string,
        base_url: fd.get('base_url') as string,
        api_key: fd.get('api_key') as string || undefined,
      });
      setAdding(false);
      setToast('Provider 已添加');
      footer.refetch?.();
    } catch (e) {
      setToast(`添加失败: ${(e as ApiError).message}`);
    }
    setTimeout(() => setToast(null), 3000);
  };

  const handleEdit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedProvider) return;
    const fd = new FormData(e.currentTarget);
    try {
      await patchProvider(selectedProvider.id, {
        name: fd.get('name') as string,
        base_url: fd.get('base_url') as string,
        api_key: fd.get('api_key') as string || undefined,
      });
      setEditing(false);
      setToast('已更新');
      footer.refetch?.();
    } catch (e) {
      setToast(`更新失败: ${(e as ApiError).message}`);
    }
    setTimeout(() => setToast(null), 3000);
  };

  // ── Provider detail view ──
  if (selectedProvider) {
    const url = (() => { try { return new URL(selectedProvider.base_url).host; } catch { return selectedProvider.base_url; } })();
    return (
      <>
        <button className="rt-btn" type="button" onClick={() => { setSelected(null); setEditing(false); }} style={{ marginBottom: 12 }}>
          <Icon name="chevron-right" size={13} style={{ transform: 'rotate(180deg)' }} /> 返回列表
        </button>

        {editing ? (
          <>
            <div className="section-h">编辑 Provider</div>
            <form onSubmit={handleEdit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label className="field" style={{ margin: 0 }}>
                <div className="field-label">名称</div>
                <input className="field-input" name="name" defaultValue={selectedProvider.name} required />
              </label>
              <label className="field" style={{ margin: 0 }}>
                <div className="field-label">Base URL</div>
                <input className="field-input" name="base_url" defaultValue={selectedProvider.base_url} required />
              </label>
              <label className="field" style={{ margin: 0 }}>
                <div className="field-label">API Key</div>
                <input className="field-input" name="api_key" type="password" placeholder="留空则不修改" />
                <div className="field-hint">留空则保持原有 Key 不变</div>
              </label>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button className="rt-btn primary" type="submit" style={{ justifyContent: 'center', background: 'var(--accent)', borderColor: 'var(--accent)', color: '#0b0d14' }}>
                  保存
                </button>
                <button className="rt-btn" type="button" onClick={() => setEditing(false)} style={{ justifyContent: 'center' }}>
                  取消
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="section-h">{selectedProvider.name}</div>
            <div className="list-row" style={{ gridTemplateColumns: '100px 1fr' }}>
              <div className="sub">类型</div>
              <div className="name" style={{ fontSize: 13 }}>{selectedProvider.type}</div>
            </div>
            <div className="list-row" style={{ gridTemplateColumns: '100px 1fr' }}>
              <div className="sub">地址</div>
              <div className="name" style={{ fontSize: 13, fontFamily: 'var(--font-mono)' }}>{url}</div>
            </div>
            <div className="list-row" style={{ gridTemplateColumns: '100px 1fr' }}>
              <div className="sub">状态</div>
              <span className={'pill ' + (selectedProvider.enabled ? 'ok' : 'off')}>{selectedProvider.enabled ? '已启用' : '已禁用'}</span>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="rt-btn" type="button" onClick={() => setEditing(true)}>
                <Icon name="settings" size={12} /> 编辑
              </button>
              <button className="rt-btn" type="button" disabled={testing === selectedProvider.id} onClick={() => handleTest(selectedProvider.id)}>
                <Icon name="lightning" size={12} /> {testing === selectedProvider.id ? '测试中…' : '测试连接'}
              </button>
              <button className="rt-btn" type="button" onClick={() => { if (confirm('确定删除此 Provider？关联的模型也会被删除。')) handleDelete(selectedProvider.id); }} style={{ color: 'var(--err)' }}>
                <Icon name="x" size={12} /> 删除
              </button>
            </div>
          </>
        )}

        {toast && <div style={{ marginTop: 10, fontSize: 12.5, color: toast.includes('成功') || toast.includes('已') ? 'var(--ok)' : 'var(--err)' }}>{toast}</div>}
      </>
    );
  }

  // ── Add provider form ──
  if (adding) {
    return (
      <>
        <button className="rt-btn" type="button" onClick={() => setAdding(false)} style={{ marginBottom: 12 }}>
          <Icon name="x" size={13} /> 取消
        </button>
        <div className="section-h">添加 Provider</div>
        <form onSubmit={handleAdd} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label className="field" style={{ margin: 0 }}>
            <div className="field-label">名称</div>
            <input className="field-input" name="name" placeholder="My Provider" required />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <div className="field-label">类型</div>
            <select className="field-input" name="type" required>
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
              <option value="openrouter">OpenRouter</option>
              <option value="google">Google</option>
              <option value="ollama">Ollama</option>
              <option value="other">其他</option>
            </select>
          </label>
          <label className="field" style={{ margin: 0 }}>
            <div className="field-label">Base URL</div>
            <input className="field-input" name="base_url" placeholder="https://api.openai.com/v1" required />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <div className="field-label">API Key</div>
            <input className="field-input" name="api_key" type="password" placeholder="sk-····" />
            <div className="field-hint">Key 仅在本地加密保存</div>
          </label>
          <button className="rt-btn primary" type="submit" style={{ marginTop: 4, justifyContent: 'center', background: 'var(--accent)', borderColor: 'var(--accent)', color: '#0b0d14' }}>
            测试并保存
          </button>
        </form>
        {toast && <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--err)' }}>{toast}</div>}
      </>
    );
  }

  // ── Provider list (default view) ──
  return (
    <>
      <div className="section-h">已连接 ({rows.filter((r) => r.status !== 'off').length})</div>
      {rows.map((r) => (
        <div key={r.id} className="list-row" style={{ cursor: 'pointer' }} onClick={() => { if (liveProviders) setSelected(r.id); }}>
          <span className="ic"><Icon name="cube" size={16} /></span>
          <div>
            <div className="name">{r.name}</div>
            <div className="sub">{r.sub}</div>
          </div>
          <span className={'pill ' + r.status}>{pillLabel[r.status]}</span>
          <Icon name="chevron-right" size={14} style={{ color: 'var(--text-muted)' }} />
        </div>
      ))}
      <button className="rt-btn" type="button" style={{ marginTop: 8, width: '100%', justifyContent: 'center' }} onClick={() => setAdding(true)}>
        <Icon name="plus" size={12} />
        添加 Provider
      </button>

      <div className="section-h">备援顺序</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.55 }}>
        当首选模型挂掉或限流时，按以下顺序尝试切换。可拖拽调整。
      </div>
      <div className="fallback-chip-row">
        {fallbackNames.map((p, i) => (
          <span key={i} className="fallback-chip">
            <span className="idx">{i + 1}.</span>
            {p}
          </span>
        ))}
      </div>
      {toast && <div style={{ marginTop: 10, fontSize: 12.5, color: toast.includes('成功') || toast.includes('已') ? 'var(--ok)' : 'var(--err)' }}>{toast}</div>}
    </>
  );
}

function DrawerModels() {
  const liveResult = useModels();
  const footer = useFooterHealth();
  const liveModels = liveResult.data;
  const providers = footer.data?.providers ?? [];
  const [pendingToggles, setPendingToggles] = useState<Set<string>>(new Set());

  if (!liveModels || liveModels.length === 0) {
    return <DrawerModelsMock />;
  }

  const handleToggle = async (id: string, current: boolean) => {
    setPendingToggles((s) => new Set(s).add(id));
    try {
      await patchModel(id, { enabled: !current });
      liveResult.refetch?.();
    } catch { /* silent */ }
    setPendingToggles((s) => { const n = new Set(s); n.delete(id); return n; });
  };

  const provMap = new Map(providers.map((p) => [p.id, p]));
  const chatModels = liveModels.filter((m) => m.capability !== 'image');
  const imageModels = liveModels.filter((m) => m.capability === 'image');
  const groups = [
    { name: '聊天', models: chatModels },
    { name: '图像', models: imageModels },
  ].filter((g) => g.models.length > 0);

  return (
    <>
      {groups.map((g) => (
        <div key={g.name}>
          <div className="section-h">{g.name}</div>
          {g.models.map((m) => {
            const prov = m.provider_id ? provMap.get(m.provider_id) : undefined;
            const inputUsd = m.price_input_per_1m ?? 0;
            const tier = inputUsd > 5 ? '$$$' : inputUsd > 1 ? '$$' : inputUsd > 0 ? '$' : '免费';
            const ctx = m.context_length
              ? m.context_length >= 1_000_000
                ? `${m.context_length / 1_000_000}M`
                : `${Math.round(m.context_length / 1000)}k`
              : '';
            return (
              <div key={m.id} className="list-row">
                <span className="ic">
                  <span style={{ display: 'block', width: 8, height: 8, borderRadius: 4, background: providerColor(prov?.type, prov?.name) }} />
                </span>
                <div>
                  <div className="name">{m.display_name}</div>
                  <div className="sub">
                    {prov?.name ?? '—'} · {tier}
                    {ctx && ` · ctx ${ctx}`}
                  </div>
                </div>
                <span className="pill" style={{ color: 'var(--text-muted)' }}>{tier}</span>
                <div className={'switch' + (m.enabled ? ' on' : '') + (pendingToggles.has(m.id) ? ' pending' : '')} role="switch" aria-checked={m.enabled} tabIndex={0} onClick={() => handleToggle(m.id, m.enabled)} onKeyDown={e => e.key === 'Enter' && handleToggle(m.id, m.enabled)} />
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

function DrawerModelsMock() {
  const [groups, setGroups] = useState<{ name: string; models: { id: ModelId; provider: string; price: string; on: boolean; def: boolean; ctx: string }[] }[]>([
    {
      name: '聊天',
      models: [
        { id: 'sonnet', provider: 'Anthropic', price: '$$$', on: true, def: true, ctx: '200k' },
        { id: 'gpt4o', provider: 'OpenAI', price: '$$$', on: true, def: false, ctx: '128k' },
        { id: 'deepseek', provider: 'OpenRouter', price: '$', on: true, def: false, ctx: '64k' },
        { id: 'gemini', provider: 'Google', price: '$$', on: true, def: false, ctx: '1M' },
        { id: 'haiku', provider: 'Anthropic', price: '$', on: false, def: false, ctx: '200k' },
      ],
    },
    {
      name: '图像',
      models: [{ id: 'dalle', provider: 'OpenAI', price: '$$', on: true, def: true, ctx: '' }],
    },
  ]);
  const toggleModel = (gi: number, mi: number) => {
    setGroups((prev) => {
      const next = prev.map((g) => ({ ...g, models: [...g.models] }));
      next[gi].models[mi] = { ...next[gi].models[mi], on: !next[gi].models[mi].on };
      return next;
    });
  };
  return (
    <>
      {groups.map((g, gi) => (
        <div key={g.name}>
          <div className="section-h">{g.name}</div>
          {g.models.map((m, mi) => {
            const meta = MODELS[m.id];
            return (
              <div key={m.id} className="list-row">
                <span className="ic">
                  <span style={{ display: 'block', width: 8, height: 8, borderRadius: 4, background: meta.color }} />
                </span>
                <div>
                  <div className="name name-row">
                    {meta.name}
                    {m.def && <span className="pill default-tag">默认</span>}
                  </div>
                  <div className="sub">
                    {m.provider} · {m.price}
                    {m.ctx && ` · ctx ${m.ctx}`}
                  </div>
                </div>
                <span className="pill" style={{ color: 'var(--text-muted)' }}>{m.price}</span>
                <div className={'switch' + (m.on ? ' on' : '')} role="switch" aria-checked={m.on} tabIndex={0} onClick={() => toggleModel(gi, mi)} onKeyDown={e => e.key === 'Enter' && toggleModel(gi, mi)} />
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

function DrawerTools() {
  const [builtIn, setBuiltIn] = useState([
    { ic: 'globe' as const, name: 'web_search', sub: '允许模型搜索网页 · Brave Search', on: true },
    { ic: 'doc' as const, name: 'file_search', sub: '在已上传的文件中检索', on: true },
    { ic: 'flask' as const, name: 'code_interpreter', sub: '执行 Python 沙箱', on: false },
    { ic: 'image' as const, name: 'image_gen', sub: '调用 DALL·E 3 / SDXL', on: true },
  ]);
  const [mcp, setMcp] = useState([
    { name: 'Notion MCP', sub: 'notion-mcp · 12 工具', on: true },
    { name: 'GitHub MCP', sub: 'github-mcp · 8 工具', on: true },
    { name: 'Linear MCP', sub: 'linear-mcp · 未配置', on: false },
  ]);
  const toggleBuiltIn = (i: number) => {
    setBuiltIn((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], on: !next[i].on };
      toggleTool(next[i].name, next[i].on).catch(() => {});
      return next;
    });
  };
  const toggleMcp = (i: number) => {
    setMcp((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], on: !next[i].on };
      return next;
    });
  };
  return (
    <>
      <div className="section-h">内置工具</div>
      {builtIn.map((t, i) => (
        <div key={i} className="list-row">
          <span className="ic"><Icon name={t.ic} size={15} /></span>
          <div>
            <div className="name">{t.name}</div>
            <div className="sub">{t.sub}</div>
          </div>
          <span />
          <div className={'switch' + (t.on ? ' on' : '')} role="switch" aria-checked={t.on} tabIndex={0} onClick={() => toggleBuiltIn(i)} onKeyDown={e => e.key === 'Enter' && toggleBuiltIn(i)} />
        </div>
      ))}
      <div className="section-h">MCP 接入</div>
      {mcp.map((t, i) => (
        <div key={i} className="list-row">
          <span className="ic"><Icon name="tool" size={15} /></span>
          <div>
            <div className="name">{t.name}</div>
            <div className="sub">{t.sub}</div>
          </div>
          <span className={'pill ' + (t.on ? 'ok' : 'off')}>{t.on ? '已连' : '未配'}</span>
          <div className={'switch' + (t.on ? ' on' : '')} role="switch" aria-checked={t.on} tabIndex={0} onClick={() => toggleMcp(i)} onKeyDown={e => e.key === 'Enter' && toggleMcp(i)} />
        </div>
      ))}
    </>
  );
}

function DrawerTemplates() {
  const [view, setView] = useState<'list' | 'edit-prompt' | 'edit-persona' | 'new'>('list');
  const [editIdx, setEditIdx] = useState<number>(0);
  const [toast, setToast] = useState<string | null>(null);

  const prompts = [
    { name: '邮件改稿', sub: '商务/正式 · 12 次使用', system: '你是一位专业的商务邮件编辑助手。请将用户的草稿改写为正式、得体的商务邮件。', model: 'Sonnet 4' },
    { name: '代码 Review', sub: 'Sonnet · 默认 system prompt · 8 次使用', system: '你是一位资深代码审查员。请仔细检查代码的正确性、可读性、性能和安全性，给出具体的改进建议。', model: 'Sonnet 4' },
    { name: '会议纪要', sub: '中文摘要 + 行动项 · 3 次使用', system: '请将会议内容整理为结构化的会议纪要，包含：讨论要点、决策事项、行动项（含负责人和截止日期）。', model: 'GPT-4o' },
  ];
  const personas = [
    { name: '架构师 Aki', sub: '冷静 · 偏务实 · Sonnet 4', system: '你是一位经验丰富的软件架构师，性格冷静理性，偏好务实的技术方案。回答时会考虑可维护性、扩展性和工程成本。' },
    { name: '产品经理 Mio', sub: '提问驱动 · GPT-4o', system: '你是一位优秀的产品经理，善于通过提问来理清需求。你会关注用户价值、商业可行性和技术可行性的平衡。' },
  ];

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  // ── Edit prompt template ──
  if (view === 'edit-prompt') {
    const p = prompts[editIdx];
    return (
      <>
        <button className="rt-btn" type="button" onClick={() => setView('list')} style={{ marginBottom: 12 }}>
          <Icon name="chevron-right" size={13} style={{ transform: 'rotate(180deg)' }} /> 返回列表
        </button>
        <div className="section-h">编辑 Prompt 模板</div>
        <form onSubmit={(e) => { e.preventDefault(); showToast('模板已保存'); setView('list'); }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label className="field" style={{ margin: 0 }}>
            <div className="field-label">模板名称</div>
            <input className="field-input" name="name" defaultValue={p.name} required />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <div className="field-label">System Prompt</div>
            <textarea className="field-input" name="system" defaultValue={p.system} rows={5} required style={{ resize: 'vertical' }} />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <div className="field-label">默认模型</div>
            <input className="field-input" name="model" defaultValue={p.model} />
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="rt-btn primary" type="submit" style={{ justifyContent: 'center', background: 'var(--accent)', borderColor: 'var(--accent)', color: '#0b0d14' }}>
              保存
            </button>
            <button className="rt-btn" type="button" onClick={() => setView('list')} style={{ justifyContent: 'center' }}>
              取消
            </button>
          </div>
        </form>
        {toast && <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--ok)' }}>{toast}</div>}
      </>
    );
  }

  // ── Edit persona ──
  if (view === 'edit-persona') {
    const p = personas[editIdx];
    return (
      <>
        <button className="rt-btn" type="button" onClick={() => setView('list')} style={{ marginBottom: 12 }}>
          <Icon name="chevron-right" size={13} style={{ transform: 'rotate(180deg)' }} /> 返回列表
        </button>
        <div className="section-h">编辑 Persona</div>
        <form onSubmit={(e) => { e.preventDefault(); showToast('Persona 已保存'); setView('list'); }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label className="field" style={{ margin: 0 }}>
            <div className="field-label">名称</div>
            <input className="field-input" name="name" defaultValue={p.name} required />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <div className="field-label">System Prompt</div>
            <textarea className="field-input" name="system" defaultValue={p.system} rows={5} required style={{ resize: 'vertical' }} />
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="rt-btn primary" type="submit" style={{ justifyContent: 'center', background: 'var(--accent)', borderColor: 'var(--accent)', color: '#0b0d14' }}>
              保存
            </button>
            <button className="rt-btn" type="button" onClick={() => setView('list')} style={{ justifyContent: 'center' }}>
              取消
            </button>
          </div>
        </form>
        {toast && <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--ok)' }}>{toast}</div>}
      </>
    );
  }

  // ── New template / persona ──
  if (view === 'new') {
    return (
      <>
        <button className="rt-btn" type="button" onClick={() => setView('list')} style={{ marginBottom: 12 }}>
          <Icon name="chevron-right" size={13} style={{ transform: 'rotate(180deg)' }} /> 返回列表
        </button>
        <div className="section-h">新建模板 / Persona</div>
        <form onSubmit={(e) => { e.preventDefault(); showToast('已创建'); setView('list'); }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label className="field" style={{ margin: 0 }}>
            <div className="field-label">类型</div>
            <select className="field-input" name="type" defaultValue="prompt">
              <option value="prompt">Prompt 模板</option>
              <option value="persona">Persona</option>
            </select>
          </label>
          <label className="field" style={{ margin: 0 }}>
            <div className="field-label">名称</div>
            <input className="field-input" name="name" placeholder="输入名称" required />
          </label>
          <label className="field" style={{ margin: 0 }}>
            <div className="field-label">System Prompt</div>
            <textarea className="field-input" name="system" placeholder="输入 System Prompt" rows={5} required style={{ resize: 'vertical' }} />
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="rt-btn primary" type="submit" style={{ justifyContent: 'center', background: 'var(--accent)', borderColor: 'var(--accent)', color: '#0b0d14' }}>
              创建
            </button>
            <button className="rt-btn" type="button" onClick={() => setView('list')} style={{ justifyContent: 'center' }}>
              取消
            </button>
          </div>
        </form>
        {toast && <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--ok)' }}>{toast}</div>}
      </>
    );
  }

  // ── List view (default) ──
  return (
    <>
      <div className="section-h">Prompt 模板</div>
      {prompts.map((t, i) => (
        <div key={i} className="list-row">
          <span className="ic"><Icon name="doc" size={15} /></span>
          <div>
            <div className="name">{t.name}</div>
            <div className="sub">{t.sub}</div>
          </div>
          <span className="pill" style={{ cursor: 'pointer' }} onClick={() => { setEditIdx(i); setView('edit-prompt'); }}>编辑</span>
          <Icon name="chevron-right" size={14} style={{ color: 'var(--text-muted)' }} />
        </div>
      ))}
      <div className="section-h">Persona 预设</div>
      {personas.map((t, i) => (
        <div key={i} className="list-row">
          <span className="ic"><Icon name="lightning" size={15} /></span>
          <div>
            <div className="name">{t.name}</div>
            <div className="sub">{t.sub}</div>
          </div>
          <span className="pill" style={{ cursor: 'pointer' }} onClick={() => { setEditIdx(i); setView('edit-persona'); }}>编辑</span>
          <Icon name="chevron-right" size={14} style={{ color: 'var(--text-muted)' }} />
        </div>
      ))}
      <button className="rt-btn" type="button" style={{ marginTop: 12, width: '100%', justifyContent: 'center' }} onClick={() => setView('new')}>
        <Icon name="plus" size={12} />
        新建模板 / Persona
      </button>
      {toast && <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--ok)' }}>{toast}</div>}
    </>
  );
}

// ── Drawer B — Settings ──────────────────────────────────────
const SETTINGS_TABS = [
  { id: 'appearance', name: '外观', icon: 'sun' as const },
  { id: 'budget', name: '预算', icon: 'wallet' as const },
  { id: 'fallback', name: '兜底策略', icon: 'shield' as const },
  { id: 'data', name: '数据', icon: 'database' as const },
  { id: 'diag', name: '诊断', icon: 'flask' as const },
  { id: 'about', name: '关于', icon: 'info' as const },
];

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'appearance' | 'budget' | 'fallback' | 'data' | 'diag' | 'about'>('appearance');
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <Icon name="settings" size={16} style={{ color: 'var(--text-secondary)' }} />
          <span className="title">设置</span>
          <span className="spacer" />
          <button className="close" type="button" aria-label="关闭" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="drawer-tabs">
          {SETTINGS_TABS.map((t) => (
            <div key={t.id} className={'drawer-tab' + (tab === t.id ? ' active' : '')} onClick={() => setTab(t.id as typeof tab)}>
              <Icon name={t.icon} size={14} />
              <span>{t.name}</span>
            </div>
          ))}
        </div>
        <div className="drawer-body">
          {tab === 'appearance' && <SettingsAppearance />}
          {tab === 'budget' && <SettingsBudget />}
          {tab === 'fallback' && <SettingsFallback />}
          {tab === 'data' && <SettingsData />}
          {tab === 'diag' && <SettingsDiag />}
          {tab === 'about' && <SettingsAbout />}
        </div>
      </div>
    </>
  );
}

function SettingsAppearance() {
  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>('dark');

  const applyTheme = (t: 'dark' | 'light' | 'system') => {
    setTheme(t);
    if (t === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', t);
    }
    localStorage.setItem('taori-theme', t);
  };

  // Load saved theme on mount
  useEffect(() => {
    const saved = localStorage.getItem('taori-theme') as 'dark' | 'light' | 'system' | null;
    if (saved) applyTheme(saved);
  }, []);

  const options = [
    { id: 'dark' as const, name: '深色', sub: '默认深色主题' },
    { id: 'light' as const, name: '浅色', sub: '明亮的浅色主题' },
    { id: 'system' as const, name: '跟随系统', sub: '自动匹配系统设置' },
  ];

  return (
    <>
      <div className="section-h">主题</div>
      {options.map(o => (
        <div key={o.id} className="list-row" style={{ cursor: 'pointer' }} onClick={() => applyTheme(o.id)}>
          <span className="ic"><Icon name={o.id === 'dark' ? 'moon' : o.id === 'light' ? 'sun' : 'globe'} size={15} /></span>
          <div>
            <div className="name">{o.name}</div>
            <div className="sub">{o.sub}</div>
          </div>
          <span />
          <div className={'switch' + (theme === o.id ? ' on' : '')} role="switch" aria-checked={theme === o.id} tabIndex={0} onClick={(e) => { e.stopPropagation(); applyTheme(o.id); }} onKeyDown={(e) => e.key === 'Enter' && applyTheme(o.id)} />
        </div>
      ))}
    </>
  );
}

function SettingsBudget() {
  const [alerts, setAlerts] = useState([
    { name: '日预算用至 80% 时提示', on: true },
    { name: '月预算用至 80% 时提示', on: true },
    { name: '高成本调用前置确认', on: true },
  ]);
  return (
    <>
      <div className="section-h">预算上限</div>
      <div className="field">
        <div className="field-label">月度预算</div>
        <input className="field-input" defaultValue="¥ 50.00" />
        <div className="field-hint">本月已用 ¥9.40 (18.8%) · 重置日 1 号</div>
      </div>
      <div className="field">
        <div className="field-label">日预算</div>
        <input className="field-input" defaultValue="¥ 5.00" />
        <div className="field-hint">今日已用 ¥0.42 (8.4%)</div>
      </div>
      <div className="section-h">高成本确认</div>
      <div className="field">
        <div className="field-label">单次调用 ≥ ¥ 时弹出前置确认</div>
        <input className="field-input" defaultValue="¥ 0.50" />
        <div className="field-hint">研究模式、长上下文 GPT-4 类调用易超阈值</div>
      </div>
      <div className="section-h">告警</div>
      {alerts.map((r, i) => (
        <div key={i} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
          <div className="name" style={{ fontSize: 13 }}>{r.name}</div>
          <div className={'switch' + (r.on ? ' on' : '')} role="switch" aria-checked={r.on} tabIndex={0} onClick={() => setAlerts((p) => { const n = [...p]; n[i] = { ...n[i], on: !n[i].on }; return n; })} onKeyDown={e => e.key === 'Enter' && setAlerts((p) => { const n = [...p]; n[i] = { ...n[i], on: !n[i].on }; return n; })} />
        </div>
      ))}
    </>
  );
}

function SettingsFallback() {
  const [auto, setAuto] = useState([
    { name: '限流时自动切换备援模型', on: true, sub: '如 Sonnet 限流 → GPT-4o' },
    { name: 'Provider 离线时自动切换', on: true, sub: '5 秒无响应即视为离线' },
    { name: '高错误率时自动切换', on: false, sub: '过去 5 分钟错误率 > 20% 时' },
  ]);
  return (
    <>
      <div className="section-h">自动切换</div>
      {auto.map((r, i) => (
        <div key={i} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
          <div>
            <div className="name" style={{ fontSize: 13 }}>{r.name}</div>
            <div className="sub">{r.sub}</div>
          </div>
          <div className={'switch' + (r.on ? ' on' : '')} role="switch" aria-checked={r.on} tabIndex={0} onClick={() => setAuto((p) => { const n = [...p]; n[i] = { ...n[i], on: !n[i].on }; return n; })} onKeyDown={e => e.key === 'Enter' && setAuto((p) => { const n = [...p]; n[i] = { ...n[i], on: !n[i].on }; return n; })} />
        </div>
      ))}
      <div className="section-h">兜底优先级 · 聊天</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
        当首选模型不可用时依次尝试。可拖拽排序。
      </div>
      {['Sonnet 4', 'GPT-4o', 'Gemini 2.5', 'DeepSeek V3'].map((m, i) => (
        <div key={m} className="list-row">
          <span className="ic" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{i + 1}</span>
          <div className="name">{m}</div>
          <span />
          <Icon name="menu" size={14} style={{ color: 'var(--text-muted)' }} />
        </div>
      ))}
    </>
  );
}

function SettingsData() {
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleClearConversations = async () => {
    if (!confirm('确定清除所有本地对话历史？此操作不可撤销。')) return;
    try {
      const convs = await listConversations();
      await Promise.all(convs.map((c) => deleteConversation(c.id)));
      showToast('对话历史已清除');
    } catch (e) {
      showToast(`清除失败: ${(e as Error).message}`);
    }
  };

  const exports = [
    { ic: 'download' as const, n: '导出所有对话', s: 'Markdown · 共 24 个会话 · ~3.2 MB', action: () => showToast('导出功能开发中') },
    { ic: 'download' as const, n: '导出调用日志', s: 'JSON · 调用与成本明细 · 142 条', action: () => showToast('导出功能开发中') },
  ];
  const cleanups = [
    { n: '清除本地对话历史', s: '不会影响远端 API Key · 24 个会话将被删除', danger: true, action: handleClearConversations },
    { n: '清除缓存', s: '~ 18 MB', danger: false, action: () => showToast('缓存已清除') },
    { n: '重做 Onboarding', s: '下次打开会重新弹出 API Key 配置卡', danger: false, action: () => showToast('已重置，下次启动将显示配置向导') },
  ];
  return (
    <>
      <div className="section-h">导出</div>
      {exports.map((r, i) => (
        <div key={i} className="list-row" style={{ gridTemplateColumns: '24px 1fr auto' }}>
          <span className="ic"><Icon name={r.ic} size={15} /></span>
          <div>
            <div className="name">{r.n}</div>
            <div className="sub">{r.s}</div>
          </div>
          <button className="rt-btn" type="button" onClick={r.action}>导出</button>
        </div>
      ))}
      <div className="section-h">清理</div>
      {cleanups.map((r, i) => (
        <div key={i} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
          <div>
            <div className={'name' + (r.danger ? ' danger' : '')}>{r.n}</div>
            <div className="sub">{r.s}</div>
          </div>
          <button className="rt-btn" type="button" onClick={r.action}>{r.danger ? '删除' : '执行'}</button>
        </div>
      ))}
      {toast && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: toast.includes('失败') ? 'var(--err)' : 'var(--ok)' }}>
          {toast}
        </div>
      )}
    </>
  );
}

function SettingsDiag() {
  const errs = [
    { t: '2 分钟前', code: 429, msg: 'OpenAI rate_limit_exceeded · 已自动切换 GPT-4o → Sonnet' },
    { t: '14:42', code: 503, msg: 'Anthropic upstream 5xx · 重试 1 次后成功' },
    { t: '13:08', code: 408, msg: 'Gemini 请求超时 · 已切换至 Sonnet' },
  ];
  return (
    <>
      <div className="section-h">服务状态</div>
      <div className="list-row" style={{ gridTemplateColumns: '24px 1fr auto' }}>
        <span className="ic"><Icon name="database" size={15} /></span>
        <div>
          <div className="name">Sidecar</div>
          <div className="sub">在线 · :7878 · v0.6.2 · 内存 184 MB · 启动 2h 14m</div>
        </div>
        <span className="pill ok">在线</span>
      </div>
      <div className="list-row" style={{ gridTemplateColumns: '24px 1fr auto' }}>
        <span className="ic"><Icon name="cube" size={15} /></span>
        <div>
          <div className="name">WebUI</div>
          <div className="sub">v0.6.2 · build 20260518.142a · React 18</div>
        </div>
        <span className="pill ok">最新</span>
      </div>
      <div className="section-h">最近错误 (3)</div>
      {errs.map((e, i) => (
        <div key={i} className="diag-row">
          <span className="t">{e.t}</span>
          <span className="code">{e.code}</span>
          <span className="msg">{e.msg}</span>
        </div>
      ))}
    </>
  );
}

function SettingsAbout() {
  const links = [
    { n: '文档', s: 'taori.dev/docs', href: 'https://taori.dev/docs' },
    { n: '更新日志', s: '0.6.2 · 14 项改动', href: 'https://github.com/taori-ai/taori/releases' },
    { n: '反馈与 Issues', s: 'github.com/taori-ai/taori', href: 'https://github.com/taori-ai/taori/issues' },
    { n: '许可证', s: 'MIT · 第三方依赖 142 个' },
  ];
  return (
    <>
      <div className="section-h">关于</div>
      <div className="about-card">
        <div className="head">
          <div className="logo"><BrandMark size={20} /></div>
          <div>
            <div className="name">Taori</div>
            <div className="ver">v0.6.2 · 2026.05.18</div>
          </div>
        </div>
        <div className="quote-en">Taori weaves many models into one continuous flow.</div>
        <div className="quote-cn">把多个模型，织成一条不断的工作流。</div>
      </div>
      <div className="section-h">链接</div>
      {links.map((r, i) => {
        const inner = (
          <>
            <div>
              <div className="name">{r.n}</div>
              <div className="sub">{r.s}</div>
            </div>
            <Icon name="chevron-right" size={14} style={{ color: 'var(--text-muted)' }} />
          </>
        );
        return r.href ? (
          <a key={i} className="list-row" style={{ gridTemplateColumns: '1fr auto', cursor: 'pointer', textDecoration: 'none' }} href={r.href} target="_blank" rel="noopener noreferrer">
            {inner}
          </a>
        ) : (
          <div key={i} className="list-row" style={{ gridTemplateColumns: '1fr auto' }}>
            {inner}
          </div>
        );
      })}
    </>
  );
}

// ── Command Palette ──────────────────────────────────────────
export interface CommandPaletteProps {
  models: LiveModelEntry[];
  conversations: Conversation[];
  currentModelId: string | null;
  onSelectModel: (id: string) => void;
  onSelectConversation: (id: string) => void;
  onSelectMode: (mode: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

type PaletteItem = {
  id: string;
  icon: IconName;
  label: string;
  hint?: string;
  group: string;
  action: () => void;
};

export function CommandPalette({
  models,
  conversations,
  currentModelId,
  onSelectModel,
  onSelectConversation,
  onSelectMode,
  onNewChat,
  onOpenSettings,
  onClose,
}: CommandPaletteProps) {
  const [search, setSearch] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const q = search.toLowerCase();

  // Build flat item list grouped by category
  const items: PaletteItem[] = [];

  // Actions
  const actionItems: PaletteItem[] = [
    { id: 'action-new', icon: 'plus', label: '新对话', hint: '⌘N', group: '操作', action: onNewChat },
    { id: 'action-settings', icon: 'settings', label: '设置', group: '操作', action: onOpenSettings },
  ];
  items.push(...actionItems);

  // Models
  for (const m of models) {
    items.push({
      id: `model-${m.id}`,
      icon: 'cube',
      label: m.name,
      hint: m.id === currentModelId ? '当前' : m.provider,
      group: '模型',
      action: () => onSelectModel(m.id),
    });
  }

  // Conversations
  for (const c of conversations.slice(0, 15)) {
    items.push({
      id: `conv-${c.id}`,
      icon: 'doc',
      label: c.title,
      group: '对话',
      action: () => onSelectConversation(c.id),
    });
  }

  // Modes
  for (const [modeId, modeDef] of Object.entries(MODES)) {
    items.push({
      id: `mode-${modeId}`,
      icon: modeDef.icon === 'attach' ? 'attach' : (modeDef.icon as IconName),
      label: modeDef.name,
      hint: modeDef.kbd,
      group: '模式',
      action: () => onSelectMode(modeId),
    });
  }

  const filtered = q
    ? items.filter((it) => it.label.toLowerCase().includes(q) || (it.hint && it.hint.toLowerCase().includes(q)))
    : items;

  // Clamp highlight index when filtered list changes
  const clampedIndex = Math.min(highlightIndex, Math.max(0, filtered.length - 1));
  if (clampedIndex !== highlightIndex) setHighlightIndex(clampedIndex);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = filtered[clampedIndex];
      if (item) item.action();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  // Group filtered items for rendering
  const groups: { label: string; items: PaletteItem[] }[] = [];
  let lastGroup = '';
  for (const item of filtered) {
    if (item.group !== lastGroup) {
      groups.push({ label: item.group, items: [] });
      lastGroup = item.group;
    }
    groups[groups.length - 1].items.push(item);
  }

  let flatIndex = 0;

  return (
    <div className="cmd-palette" role="dialog" aria-label="命令面板" onClick={onClose}>
      <div className="cmd-palette-inner" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="cmd-palette-search">
          <Icon name="search" size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            placeholder="搜索命令、模型、对话…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setHighlightIndex(0); }}
            autoFocus
          />
        </div>
        <div className="cmd-palette-results">
          {groups.map((g) => (
            <div key={g.label}>
              <div className="cmd-palette-section">{g.label}</div>
              {g.items.map((item) => {
                const idx = flatIndex++;
                const isHighlighted = idx === clampedIndex;
                return (
                  <div
                    key={item.id}
                    className={'cmd-palette-item' + (isHighlighted ? ' active' : '')}
                    onMouseEnter={() => setHighlightIndex(idx)}
                    onClick={() => item.action()}
                  >
                    <span className="icon"><Icon name={item.icon} size={14} /></span>
                    <span className="label">{item.label}</span>
                    {item.hint && <span className="hint">{item.hint}</span>}
                  </div>
                );
              })}
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: '16px 12px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
              没有匹配结果
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Banner ───────────────────────────────────────────────────
export function Banner({ kind = 'warn', icon = 'warn', children, actions }: { kind?: 'warn' | 'err'; icon?: 'warn' | 'wallet'; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className={'banner ' + kind}>
      <Icon name={icon} size={14} className="icon" />
      <span>{children}</span>
      <span className="spacer" />
      {actions}
    </div>
  );
}

// ── No-Key inline configuration card ─────────────────────────
export function NoKeyCard({ onSkip }: { onSkip?: () => void }) {
  const [sel, setSel] = useState('openrouter');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const providers = [
    { id: 'openrouter', n: 'OpenRouter', badge: '推荐' },
    { id: 'openai', n: 'OpenAI', badge: '' },
    { id: 'anthropic', n: 'Anthropic', badge: '' },
  ];

  const BASE_URL_MAP: Record<string, string> = {
    openrouter: 'https://openrouter.ai/api/v1',
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
  };
  const NAME_MAP: Record<string, string> = {
    openrouter: 'OpenRouter',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      await createProvider({
        name: NAME_MAP[sel] ?? sel,
        type: sel,
        base_url: BASE_URL_MAP[sel] ?? '',
        api_key: apiKey.trim(),
      });
      showToast('API Key 已保存');
    } catch (e) {
      showToast((e as Error).message || '保存失败');
    }
    setSaving(false);
  };

  return (
    <div className="nokey-card">
      <div className="nokey-title">先配一个 API Key</div>
      <div className="nokey-sub">推荐 OpenRouter — 一个 Key 接入几乎所有模型，按量计费</div>

      <div className="nokey-providers">
        {providers.map((p) => (
          <div key={p.id} className={'nokey-provider' + (sel === p.id ? ' sel' : '')} onClick={() => setSel(p.id)}>
            {p.n}
            {p.badge && <div className="badge">{p.badge}</div>}
          </div>
        ))}
      </div>

      <input className="field-input" placeholder="sk-or-v1-····" style={{ width: '100%', marginBottom: 6 }} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      <div className="field-hint" style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>
        Key 只在本地加密保存，从不发到我们的服务器 · 没账号？
        <a href="https://openrouter.ai" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}> 去 openrouter.ai 注册 →</a>
      </div>

      <div className="nokey-actions">
        <button className="nokey-btn" type="button" onClick={() => onSkip?.()}>跳过浏览</button>
        <button className="nokey-btn primary" type="button" disabled={saving || !apiKey.trim()} onClick={handleSave}>
          {saving ? '保存中...' : '测试并保存'}
        </button>
      </div>

      {toast && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: toast.includes('已保存') ? 'var(--ok)' : 'var(--err)' }}>
          {toast}
        </div>
      )}
    </div>
  );
}
