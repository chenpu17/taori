import type { CSSProperties, ReactNode, SVGProps } from 'react';

// ── Models — single source of truth for color + label ────────
export type ModelId = 'sonnet' | 'gpt4o' | 'deepseek' | 'gemini' | 'dalle' | 'taori' | 'haiku';

export interface ModelMeta {
  id: ModelId;
  name: string;
  provider: string;
  short: string;
  color: string;
  price: '' | '$' | '$$' | '$$$';
}

export const MODELS: Record<ModelId, ModelMeta> = {
  sonnet: { id: 'sonnet', name: 'Sonnet 4', provider: 'Anthropic', short: 'Sonnet', color: 'var(--m-sonnet)', price: '$$$' },
  gpt4o: { id: 'gpt4o', name: 'GPT-4o', provider: 'OpenAI', short: 'GPT-4o', color: 'var(--m-gpt)', price: '$$$' },
  deepseek: { id: 'deepseek', name: 'DeepSeek V3', provider: 'OpenRouter', short: 'DeepSeek', color: 'var(--m-deepseek)', price: '$' },
  gemini: { id: 'gemini', name: 'Gemini 2.5', provider: 'Google', short: 'Gemini', color: 'var(--m-gemini)', price: '$$' },
  dalle: { id: 'dalle', name: 'DALL·E 3', provider: 'OpenAI', short: 'DALL·E 3', color: 'var(--m-dalle)', price: '$$' },
  taori: { id: 'taori', name: 'Taori', provider: '—', short: 'Taori', color: 'var(--m-taori)', price: '' },
  haiku: { id: 'haiku', name: 'Haiku 4', provider: 'Anthropic', short: 'Haiku', color: 'var(--m-sonnet)', price: '$' },
};

// ── Brand mark — three woven threads converging on a node ────
export function BrandMark({ size = 16 }: { size?: number }) {
  const gid = 'bm-grad';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.45" />
          <stop offset="1" stopColor="currentColor" stopOpacity="1" />
        </linearGradient>
      </defs>
      <path d="M2 6 C 8 6, 10 12, 16 12 S 20 18, 22 18" stroke={`url(#${gid})`} strokeWidth="1.4" strokeLinecap="round" />
      <path d="M2 12 C 8 12, 10 6, 16 6 S 20 12, 22 12" stroke={`url(#${gid})`} strokeWidth="1.4" strokeLinecap="round" opacity="0.7" />
      <path d="M2 18 C 8 18, 10 12, 16 12 S 20 6, 22 6" stroke={`url(#${gid})`} strokeWidth="1.4" strokeLinecap="round" opacity="0.45" />
      <circle cx="22" cy="12" r="1.6" fill="currentColor" opacity="0.95" />
    </svg>
  );
}

// ── Icon set (24px viewBox, currentColor) ────────────────────
export type IconName =
  | 'plus' | 'send' | 'search' | 'chevron-down' | 'chevron-right'
  | 'more' | 'x' | 'roundtable' | 'research' | 'compare'
  | 'image' | 'attach' | 'refresh' | 'warn' | 'sliders'
  | 'settings' | 'help' | 'sun' | 'moon' | 'doc'
  | 'spark' | 'check' | 'pause' | 'download' | 'database'
  | 'shield' | 'wallet' | 'tool' | 'cube' | 'flask'
  | 'info' | 'menu' | 'arrow-up' | 'edit' | 'globe' | 'lightning';

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16, ...rest }: IconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...rest,
  };
  switch (name) {
    case 'plus':
      return <svg {...common}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
    case 'send':
      return <svg {...common}><path d="M5 12l14-7-5 14-2-6-7-1z" /></svg>;
    case 'search':
      return <svg {...common}><circle cx="11" cy="11" r="7" /><line x1="20" y1="20" x2="16.5" y2="16.5" /></svg>;
    case 'chevron-down':
      return <svg {...common}><polyline points="6 9 12 15 18 9" /></svg>;
    case 'chevron-right':
      return <svg {...common}><polyline points="9 6 15 12 9 18" /></svg>;
    case 'more':
      return <svg {...common}><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>;
    case 'x':
      return <svg {...common}><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>;
    case 'roundtable':
      return <svg {...common}><circle cx="12" cy="12" r="3" /><circle cx="5" cy="7" r="1.8" /><circle cx="19" cy="7" r="1.8" /><circle cx="12" cy="20" r="1.8" /><line x1="12" y1="12" x2="5" y2="7" /><line x1="12" y1="12" x2="19" y2="7" /><line x1="12" y1="12" x2="12" y2="20" /></svg>;
    case 'research':
      return <svg {...common}><circle cx="11" cy="11" r="6" /><line x1="20" y1="20" x2="16" y2="16" /><line x1="8" y1="11" x2="14" y2="11" /><line x1="11" y1="8" x2="11" y2="14" /></svg>;
    case 'compare':
      return <svg {...common}><rect x="3" y="5" width="7" height="14" rx="1" /><rect x="14" y="5" width="7" height="14" rx="1" /></svg>;
    case 'image':
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="1.5" /><circle cx="8.5" cy="10" r="1.5" /><path d="M5 17l4-4 4 4 3-3 4 3" /></svg>;
    case 'attach':
      return <svg {...common}><path d="M21 12l-8.5 8.5a4.5 4.5 0 11-6.4-6.4L14 5.6a3 3 0 014.2 4.2l-8.5 8.5a1.5 1.5 0 01-2.2-2.2L15.5 8.5" /></svg>;
    case 'refresh':
      return <svg {...common}><path d="M4 12a8 8 0 0114-5.3L20 9" /><path d="M20 4v5h-5" /><path d="M20 12a8 8 0 01-14 5.3L4 15" /><path d="M4 20v-5h5" /></svg>;
    case 'warn':
      return <svg {...common}><path d="M12 3l10 18H2z" /><line x1="12" y1="10" x2="12" y2="14" /><circle cx="12" cy="17.5" r="0.6" fill="currentColor" /></svg>;
    case 'sliders':
      return <svg {...common}><line x1="4" y1="6" x2="20" y2="6" /><circle cx="9" cy="6" r="2" /><line x1="4" y1="12" x2="20" y2="12" /><circle cx="15" cy="12" r="2" /><line x1="4" y1="18" x2="20" y2="18" /><circle cx="9" cy="18" r="2" /></svg>;
    case 'settings':
      return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 00-2-1.2L14 3h-4l-.6 2.6a7 7 0 00-2 1.2L5 6 3 9.4l2 1.4A7 7 0 005 12a7 7 0 00.1 1.2l-2 1.5L5 18.1l2.3-.9a7 7 0 002 1.2L10 21h4l.6-2.6a7 7 0 002-1.2l2.3.9 2-3.4-2-1.4A7 7 0 0019 12z" /></svg>;
    case 'help':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 015 0c0 1.7-2.5 2-2.5 4" /><circle cx="12" cy="17.5" r="0.6" fill="currentColor" /></svg>;
    case 'sun':
      return <svg {...common}><circle cx="12" cy="12" r="3.5" /><line x1="12" y1="3" x2="12" y2="5" /><line x1="12" y1="19" x2="12" y2="21" /><line x1="3" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="21" y2="12" /><line x1="5.5" y1="5.5" x2="6.8" y2="6.8" /><line x1="17.2" y1="17.2" x2="18.5" y2="18.5" /><line x1="5.5" y1="18.5" x2="6.8" y2="17.2" /><line x1="17.2" y1="6.8" x2="18.5" y2="5.5" /></svg>;
    case 'moon':
      return <svg {...common}><path d="M20 14a8 8 0 11-10-10 6 6 0 0010 10z" /></svg>;
    case 'doc':
      return <svg {...common}><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><polyline points="14 3 14 8 19 8" /></svg>;
    case 'spark':
      return <svg {...common}><path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" /></svg>;
    case 'check':
      return <svg {...common}><polyline points="5 12 10 17 19 7" /></svg>;
    case 'pause':
      return <svg {...common}><rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" /></svg>;
    case 'download':
      return <svg {...common}><line x1="12" y1="4" x2="12" y2="15" /><polyline points="7 10 12 15 17 10" /><line x1="4" y1="20" x2="20" y2="20" /></svg>;
    case 'database':
      return <svg {...common}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6a8 3 0 0016 0V5" /><path d="M4 11v6a8 3 0 0016 0v-6" /></svg>;
    case 'shield':
      return <svg {...common}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></svg>;
    case 'wallet':
      return <svg {...common}><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18" /><circle cx="17" cy="14.5" r="1" fill="currentColor" /></svg>;
    case 'tool':
      return <svg {...common}><path d="M14.7 6.3a3.5 3.5 0 00-4.9 4.9L3 18l3 3 6.8-6.8a3.5 3.5 0 004.9-4.9L15 12l-3-3z" /></svg>;
    case 'cube':
      return <svg {...common}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5" /><path d="M12 12L4 7.5" /><path d="M12 12v9" /></svg>;
    case 'flask':
      return <svg {...common}><path d="M9 3v6L4 19a2 2 0 002 3h12a2 2 0 002-3l-5-10V3" /><line x1="8" y1="3" x2="16" y2="3" /></svg>;
    case 'info':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><circle cx="12" cy="8" r="0.6" fill="currentColor" /></svg>;
    case 'menu':
      return <svg {...common}><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" /></svg>;
    case 'arrow-up':
      return <svg {...common}><line x1="12" y1="5" x2="12" y2="19" /><polyline points="6 11 12 5 18 11" /></svg>;
    case 'edit':
      return <svg {...common}><path d="M4 20h4l11-11-4-4-11 11z" /><line x1="14" y1="6" x2="18" y2="10" /></svg>;
    case 'globe':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><line x1="3" y1="12" x2="21" y2="12" /><path d="M12 3a14 14 0 010 18M12 3a14 14 0 000 18" /></svg>;
    case 'lightning':
      return <svg {...common}><polygon points="13 3 4 14 11 14 10 21 19 10 12 10" /></svg>;
    default:
      return null;
  }
}

// ── Thread node — colored bead on the conversation thread ────
export function ThreadNode({ top, color = 'var(--text-faint)', knot = false }: { top: number; color?: string; knot?: boolean }) {
  return <div className={'thread-node' + (knot ? ' knot' : '')} style={{ top, background: color, color }} />;
}

export function ModelDot({ model, size = 7 }: { model: ModelId; size?: number }) {
  const m = MODELS[model] ?? MODELS.taori;
  const style: CSSProperties = { background: m.color, width: size, height: size, display: 'inline-block', borderRadius: '50%' };
  return <span style={style} />;
}

export function ModelLabel({ model, withDot = true }: { model: ModelId; withDot?: boolean }) {
  const m = MODELS[model] ?? MODELS.taori;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {withDot && <ModelDot model={model} />}
      <span style={{ fontFamily: 'var(--font-mono)' }}>{m.short}</span>
    </span>
  );
}

// Helper for rendering optional inline content (used by message blocks)
export type InlineNode = ReactNode;
