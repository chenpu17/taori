import { useState } from 'react';
import { MODELS, type ModelId } from './primitives';
import { patchModel } from './api';
import { useFooterHealth, useModels } from './useLiveData';
import { providerColor } from './providerDisplay';

export function DrawerModels() {
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
