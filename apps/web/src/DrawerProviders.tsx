import { useState, type FormEvent } from 'react';
import { Icon } from './primitives';
import { createProvider, patchProvider, testProviderConnection } from './api';
import type { ApiError } from './api';
import { useFooterHealth } from './useLiveData';

function formatProviderTestFailure(error: { classification: string; message: string } | undefined): string {
  if (!error) return '连接失败: 未知错误';
  const labels: Record<string, string> = {
    auth: '认证失败',
    quota: '额度不足',
    rate_limit: '触发限流',
    network: '网络错误',
    config_error: '配置错误',
    key_missing: '缺少 API Key',
    content_filter: '安全策略拦截',
    unknown: '未知错误',
  };
  const prefix = labels[error.classification] ?? error.classification;
  return `连接失败: ${prefix} · ${error.message}`;
}

export function DrawerProviders() {
  const footer = useFooterHealth();
  const liveProviders = footer.data?.providers;
  const keyStatuses = footer.data?.keyStatuses;
  const keyStatusUnknown = keyStatuses === null;
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
        const k = keyStatuses?.find((s) => s.provider_id === p.id);
        const status = !p.enabled ? 'off' : keyStatusUnknown ? 'warn' : (!k?.key_available ? 'off' : 'ok');
        const keyLabel = keyStatusUnknown ? ' · Key 待确认' : (k?.key_available ? ' · Key ✓' : '');
        return { id: p.id, name: p.name, sub: p.type + keyLabel, status: status as 'ok' | 'warn' | 'off' };
      })
    : mockRows;

  const fallbackNames = liveProviders && liveProviders.length > 0
    ? liveProviders.filter((p) => p.enabled).map((p) => p.name)
    : ['Anthropic', 'OpenRouter', 'OpenAI', 'Google'];

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const data = await testProviderConnection({ provider_id: id });
      showToast(data.ok ? `连接成功 ✓${data.sample_count != null ? ` · 发现 ${data.sample_count} 个模型` : ''}` : formatProviderTestFailure(data.error));
    } catch (e) {
      showToast(`测试失败: ${(e as ApiError).message}`);
    }
    setTesting(null);
  };

  const handleDelete = async (id: string) => {
    try {
      const { authedFetch } = await import('./sidecar');
      await authedFetch(`/v1/providers/${id}`, { method: 'DELETE' });
      setSelected(null);
      showToast('已删除');
      footer.refetch?.();
    } catch {
      showToast('删除失败');
    }
  };

  const handleAdd = async (e: FormEvent<HTMLFormElement>) => {
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
      showToast('Provider 已添加');
      footer.refetch?.();
    } catch (e) {
      showToast(`添加失败: ${(e as ApiError).message}`);
    }
  };

  const handleEdit = async (e: FormEvent<HTMLFormElement>) => {
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
      showToast('已更新');
      footer.refetch?.();
    } catch (e) {
      showToast(`更新失败: ${(e as ApiError).message}`);
    }
  };

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
