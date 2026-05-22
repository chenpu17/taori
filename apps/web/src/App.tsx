import React, { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { BrandMark, Icon, MODELS, ThreadNode, type IconName, type ModelId } from './primitives';
import { AssistantMsg, CompareCard, ImageCard, ResearchDone, ResearchInProgress, RoundtableCard, UserMsg } from './cards';
import {
  Banner,
  CommandPalette,
  CostSessionPopup,
  CostTodayPopup,
  HealthPopup,
  ModeMenu,
  ModelPicker,
  ModelToolsDrawer,
  NoKeyCard,
  OverMenu,
  SettingsDrawer,
  shapeLiveModels,
  type DrawerId,
  type Theme,
} from './surfaces';
import { MODES, SCENARIOS, SIDEBAR_GROUPS, type Message, type ModeId, type ScenarioId } from './scenarios';
import { postChat, patchConversation, deleteConversation, type Conversation, type ConversationMessage } from './api';
import { useConversations, useFooterHealth, useMessages, useModels, useRealtimeCost, useTodayBreakdown } from './useLiveData';

// ── Markdown renderer ─────────────────────────────────────────
function CodeBlockWithCopy({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="md-codeblock">
      <div className="md-codeblock-head">
        <span>{lang || ''}</span>
        <button type="button" className="md-codeblock-copy" onClick={handleCopy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

function renderMarkdown(raw: string): ReactNode[] {
  try {
    return _renderMarkdownInner(raw);
  } catch {
    return [raw];
  }
}

function _renderMarkdownInner(raw: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = raw.split('\n');
  let i = 0;
  let key = 0;
  const nk = () => `md${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^(`{3,})(\w*)/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      nodes.push(<CodeBlockWithCopy key={nk()} code={codeLines.join('\n')} lang={lang} />);
      continue;
    }

    // Headers
    const hdrMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (hdrMatch) {
      const level = Math.min(hdrMatch[1].length + 1, 4);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      nodes.push(<Tag key={nk()}>{parseInline(hdrMatch[2], nk)}</Tag>);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        quoteLines.push(lines[i].replace(/^> ?/, ''));
        i++;
      }
      nodes.push(<blockquote key={nk()}>{renderMarkdown(quoteLines.join('\n'))}</blockquote>);
      continue;
    }

    // Unordered list
    if (line.match(/^\s*[-*]\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\s*[-*]\s+/)) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      nodes.push(<ul key={nk()}>{items.map((item, idx) => <li key={idx}>{parseInline(item, nk)}</li>)}</ul>);
      continue;
    }

    // Ordered list
    if (line.match(/^\s*\d+\.\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\s*\d+\.\s+/)) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      nodes.push(<ol key={nk()}>{items.map((item, idx) => <li key={idx}>{parseInline(item, nk)}</li>)}</ol>);
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph — collect consecutive non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].match(/^(`{3,})/) &&
      !lines[i].match(/^#{1,4}\s/) &&
      !lines[i].startsWith('> ') &&
      !lines[i].match(/^\s*[-*]\s+/) &&
      !lines[i].match(/^\s*\d+\.\s+/)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    nodes.push(<p key={nk()}>{parseInline(paraLines.join('\n'), nk)}</p>);
  }

  return nodes;
}

function parseInline(text: string, nk: () => string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Process inline elements using regex splitting
  // Order: inline code → bold → italic → links → remaining text
  const regex = /(`[^`\n]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Add plain text before this match
    if (match.index > lastIndex) {
      const plain = text.slice(lastIndex, match.index);
      nodes.push(...handleLineBreaks(plain));
    }

    const full = match[0];

    if (full.startsWith('`') && full.endsWith('`')) {
      // Inline code
      const code = full.slice(1, -1);
      nodes.push(<code key={nk()}>{code}</code>);
    } else if (full.startsWith('**') && full.endsWith('**')) {
      // Bold
      const content = full.slice(2, -2);
      nodes.push(<strong key={nk()}>{parseInline(content, nk)}</strong>);
    } else if (full.startsWith('*') && full.endsWith('*')) {
      // Italic
      const content = full.slice(1, -1);
      nodes.push(<em key={nk()}>{parseInline(content, nk)}</em>);
    } else if (full.startsWith('[') && full.includes('](')) {
      // Link
      const linkMatch = full.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        nodes.push(
          <a key={nk()} href={linkMatch[2]} target="_blank" rel="noopener noreferrer">
            {linkMatch[1]}
          </a>
        );
      } else {
        nodes.push(full);
      }
    }

    lastIndex = regex.lastIndex;
  }

  // Remaining text
  if (lastIndex < text.length) {
    const plain = text.slice(lastIndex);
    nodes.push(...handleLineBreaks(plain));
  }

  return nodes;
}

function handleLineBreaks(text: string): ReactNode[] {
  const parts = text.split('\n');
  const result: ReactNode[] = [];
  let k = 0;
  for (let j = 0; j < parts.length; j++) {
    if (parts[j]) result.push(parts[j]);
    if (j < parts.length - 1) result.push(<br key={`br${k++}`} />);
  }
  return result;
}

// ── Error Boundary ────────────────────────────────────────────
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: string }> {
  state = { hasError: false, error: '' };
  static getDerivedStateFromError(e: Error) { return { hasError: true, error: e.message }; }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>页面出了点问题</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16, maxWidth: 400, margin: '0 auto 16px' }}>{this.state.error}</div>
          <button style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', cursor: 'pointer' }} onClick={() => { this.setState({ hasError: false, error: '' }); window.location.reload(); }}>刷新页面</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Sidebar ──────────────────────────────────────────────────
function Sidebar({
  scenario,
  onSelect,
  conversations,
  loading,
  selectedConvId,
  onSelectConversation,
  onNewChat,
  open,
  onClose,
  onRename,
  onDelete,
}: {
  scenario: ScenarioId;
  onSelect: (id: ScenarioId) => void;
  conversations?: Conversation[];
  loading?: boolean;
  selectedConvId?: string | null;
  onSelectConversation?: (id: string) => void;
  onNewChat?: () => void;
  open?: boolean;
  onClose?: () => void;
  onRename?: (id: string, title: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}) {
  const isLive = conversations !== undefined;
  const kindIcon = (k: string): IconName | null =>
    k === 'roundtable' ? 'roundtable' : k === 'research' ? 'research' : k === 'image' ? 'image' : null;

  // Context menu state (live mode only)
  const [ctxMenu, setCtxMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!ctxMenu && !renaming && !confirmDel) return;
    const onMouseDown = () => { setCtxMenu(null); };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCtxMenu(null);
        if (renaming) setRenaming(null);
        setConfirmDel(null);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [ctxMenu, renaming, confirmDel]);

  // Focus rename input when it appears
  useEffect(() => {
    if (renaming) renameRef.current?.focus();
  }, [renaming]);

  const handleContextMenu = (e: MouseEvent<HTMLDivElement>, id: string) => {
    e.preventDefault();
    setCtxMenu({ id, x: e.clientX, y: e.clientY });
  };

  const startRename = () => {
    const conv = conversations?.find((c) => c.id === ctxMenu?.id);
    if (!conv) return;
    setRenameVal(conv.title);
    setRenaming(conv.id);
    setCtxMenu(null);
  };

  const commitRename = async () => {
    const trimmed = renameVal.trim();
    if (!trimmed || !renaming) { setRenaming(null); return; }
    await onRename?.(renaming, trimmed);
    setRenaming(null);
  };

  const startDelete = () => {
    if (!ctxMenu) return;
    setConfirmDel(ctxMenu.id);
    setCtxMenu(null);
  };

  const commitDelete = async () => {
    if (!confirmDel) return;
    await onDelete?.(confirmDel);
    setConfirmDel(null);
  };

  const grouped = useMemo(() => {
    if (!conversations || conversations.length === 0) return [];
    const filtered = search
      ? conversations.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()))
      : conversations;
    const nowMs = Date.now();
    const sod = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
    const todayMs = sod(nowMs);
    const groups: { label: string; list: Conversation[] }[] = [
      { label: '今天', list: [] },
      { label: '昨天', list: [] },
      { label: '本周', list: [] },
      { label: '更早', list: [] },
    ];
    for (const c of filtered) {
      const ts = c.updated_at > 1e12 ? c.updated_at : c.updated_at * 1000;
      if (ts >= todayMs) groups[0].list.push(c);
      else if (ts >= todayMs - 86400000) groups[1].list.push(c);
      else if (ts >= todayMs - 7 * 86400000) groups[2].list.push(c);
      else groups[3].list.push(c);
    }
    return groups.filter((g) => g.list.length > 0);
  }, [conversations, search]);

  return (
    <aside className={'side' + (open ? ' open' : '')}>
      <button className="side-newbtn" type="button" onClick={() => { onNewChat?.(); onClose?.(); }}>
        <Icon name="plus" size={14} className="ico" />
        <span>新对话</span>
        <span style={{ flex: 1 }} />
        <span className="composer-input-hint">⌘N</span>
      </button>
      <div className="side-search">
        <Icon name="search" size={13} className="ico" />
        <input placeholder="搜索对话" value={search} onChange={(e) => setSearch(e.target.value)} />
        {search && <button type="button" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }} onClick={() => setSearch('')}><Icon name="x" size={11} /></button>}
      </div>

      {/* Skeleton rows while live conversations are loading */}
      {loading && !conversations && Array.from({ length: 5 }, (_, i) => (
        <div key={`skel-${i}`} className="side-item" style={{ opacity: 0.6, flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <div className="skeleton" style={{ width: `${55 - i * 5}%`, height: 14 }} />
          <div className="skeleton" style={{ width: `${35 - i * 3}%`, height: 10 }} />
        </div>
      ))}

      {isLive ? (
        grouped.map((g) => (
          <div key={g.label}>
            <div className="side-section">{g.label}</div>
            {g.list.map((c) => {
              const ki = kindIcon(c.type);
              const isRenaming = renaming === c.id;
              const isDeleting = confirmDel === c.id;
              return (
                <div
                  key={c.id}
                  className={'side-item' + (selectedConvId === c.id ? ' active' : '')}
                  onClick={() => {
                    if (!isRenaming && !isDeleting) { onSelectConversation?.(c.id); onClose?.(); }
                  }}
                  onContextMenu={(e) => handleContextMenu(e, c.id)}
                >
                  {isRenaming ? (
                    <input
                      ref={renameRef}
                      className="side-item-input"
                      value={renameVal}
                      onChange={(e) => setRenameVal(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      onBlur={() => commitRename()}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="side-item-title">{c.title}</span>
                  )}
                  {ki && !isRenaming && !isDeleting && <span className="side-item-kind"><Icon name={ki} size={12} /></span>}
                  {!isRenaming && !isDeleting && (
                    <button
                      type="button"
                      className="side-item-menu"
                      onClick={(e) => {
                        e.stopPropagation();
                        const rect = e.currentTarget.getBoundingClientRect();
                        setCtxMenu({ id: c.id, x: rect.right, y: rect.top });
                      }}
                    >
                      <Icon name="more" size={14} />
                    </button>
                  )}
                  {isDeleting && (
                    <span className="side-item-confirm">
                      <span className="side-item-confirm-text">确定删除？</span>
                      <button type="button" className="side-item-confirm-btn danger" onClick={(e) => { e.stopPropagation(); commitDelete(); }}>删除</button>
                      <button type="button" className="side-item-confirm-btn" onClick={(e) => { e.stopPropagation(); setConfirmDel(null); }}>取消</button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))
      ) : (
        SIDEBAR_GROUPS.map((g) => (
          <div key={g.date}>
            <div className="side-section">{g.date}</div>
            {g.list.map((it) => {
              const ki = kindIcon(it.kind);
              const isScenario = (id: string): id is ScenarioId =>
                ['empty', 'nokey', 'pricing', 'research', 'researchDone', 'resume', 'opening', 'poster'].includes(id);
              const handleClick = () => {
                if (isScenario(it.id)) { onSelect(it.id); onClose?.(); }
              };
              return (
                <div
                  key={it.id}
                  className={'side-item' + (scenario === it.id ? ' active' : '')}
                  onClick={handleClick}
                >
                  <span className="side-item-title">{it.title}</span>
                  {ki && <span className="side-item-kind"><Icon name={ki} size={12} /></span>}
                </div>
              );
            })}
          </div>
        ))
      )}

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="side-ctx-menu"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="side-ctx-item" onClick={startRename}>
            <Icon name="edit" size={13} style={{ marginRight: 8 }} />
            重命名
          </div>
          <div className="side-ctx-item danger" onClick={startDelete}>
            <Icon name="x" size={13} style={{ marginRight: 8 }} />
            删除
          </div>
        </div>
      )}
    </aside>
  );
}

// ── Live message (from Sidecar) ──────────────────────────────
function LiveMessageItem({
  msg,
  modelLookup,
  isLastAssistant,
  onRetry,
}: {
  msg: ConversationMessage;
  modelLookup: Map<string, string>;
  isLastAssistant?: boolean;
  onRetry?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (msg.role === 'user') {
    return (
      <div className="msg" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        <UserMsg>{renderMarkdown(msg.content)}</UserMsg>
        {hovered && (
          <div className="msg-actions">
            <button type="button" className="msg-action" onClick={handleCopy} title="复制">
              <Icon name={copied ? 'check' : 'doc'} size={13} />
            </button>
          </div>
        )}
      </div>
    );
  }
  if (msg.role === 'system') return null;
  const ann = msg.annotations?.[0];
  const time = msg.created_at
    ? new Date(msg.created_at > 1e12 ? msg.created_at : msg.created_at * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '';
  const cost = ann?.actual_usd != null ? `$${ann.actual_usd.toFixed(4)}` : '';
  const tokensIn = ann?.input_tokens ?? undefined;
  const tokensOut = ann?.output_tokens ?? undefined;
  const modelLabel = (msg.model_id && modelLookup.get(msg.model_id)) ?? 'model';
  const hasExtra = !!(time || cost || (tokensIn != null && tokensOut != null));
  return (
    <div className="msg" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div className="msg-from taori">Taori</div>
      <div className="msg-body">
        {renderMarkdown(msg.content)}
        {msg.status === 'streaming' && <span className="streaming-cursor">▍</span>}
      </div>
      <div className="msg-meta">
        <span style={{ color: 'var(--accent)', fontSize: 12 }}>{modelLabel}</span>
        {time && <><span className="sep">·</span><span>{time}</span></>}
        {cost && <><span className="sep">·</span><span>{cost}</span></>}
        {tokensIn != null && tokensOut != null && (
          <><span className="sep">·</span><span style={{ color: 'var(--text-faint)' }}>{tokensIn}→{tokensOut} tok</span></>
        )}
        {!hasExtra && msg.status === 'streaming' && <><span className="sep">·</span><span style={{ color: 'var(--text-muted)' }}>思考中…</span></>}
        {!hasExtra && msg.status === 'error' && <><span className="sep">·</span><span style={{ color: 'var(--err)' }}>发送失败</span></>}
      </div>
      {hovered && (
        <div className="msg-actions">
          <button type="button" className="msg-action" onClick={handleCopy} title="复制">
            <Icon name={copied ? 'check' : 'doc'} size={13} />
          </button>
          {isLastAssistant && onRetry && (
            <button type="button" className="msg-action" onClick={onRetry} title="重新生成">
              <Icon name="refresh" size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────
function Header({ title, onOverflow, overflowOpen, onMenu }: { title?: string; onOverflow: (e: MouseEvent) => void; overflowOpen: boolean; onMenu?: () => void }) {
  return (
    <header className="hdr">
      <button className="hdr-hamburger" type="button" onClick={onMenu}>
        <Icon name="menu" size={18} />
      </button>
      <span className="hdr-brand">
        <span className="hdr-brand-mark" style={{ color: 'var(--accent)' }}>
          <BrandMark size={16} />
        </span>
        Taori
      </span>
      {title && (
        <>
          <span className="hdr-crumb-sep">/</span>
          <span className="hdr-crumb">{title}</span>
        </>
      )}
      <span className="hdr-spacer" />
      <button className="hdr-icon" type="button" onClick={onOverflow} data-active={overflowOpen}>
        <Icon name="more" size={16} />
      </button>
    </header>
  );
}

// ── Footer ───────────────────────────────────────────────────
type FootStatus = 'ok' | 'warn' | 'err' | 'off';
type FootPopupId = 'health' | 'today' | 'session' | null;

interface FooterProps {
  status: FootStatus;
  statusText: string;
  todayUsd: number | null;
  sessionUsd: number | null;
  budgetUsd: number;
  modelCount: number | null;
  providerCount: number | null;
  loading?: boolean;
  openPopup: FootPopupId;
  onHealth: (e: MouseEvent) => void;
  onCostToday: (e: MouseEvent) => void;
  onCostSession: (e: MouseEvent) => void;
}

function Footer({
  status,
  statusText,
  todayUsd,
  sessionUsd,
  budgetUsd,
  modelCount,
  providerCount,
  loading,
  openPopup,
  onHealth,
  onCostToday,
  onCostSession,
}: FooterProps) {
  const fmt = (v: number | null, fallback: string) => (v === null ? fallback : `$${v.toFixed(2)}`);
  return (
    <footer className="foot">
      {loading ? (
        <>
          <div className="foot-item">
            <span className="skeleton" style={{ width: 16, height: 16, borderRadius: '50%' }} />
            <span className="skeleton" style={{ width: 32, height: 12 }} />
          </div>
          <span style={{ color: 'var(--text-faint)' }}>·</span>
          <div className="foot-item">
            <span className="skeleton" style={{ width: 48, height: 12 }} />
            <span className="skeleton" style={{ width: 36, height: 12 }} />
          </div>
          <span style={{ color: 'var(--text-faint)' }}>·</span>
          <div className="foot-item">
            <span className="skeleton" style={{ width: 40, height: 12 }} />
            <span className="skeleton" style={{ width: 32, height: 12 }} />
          </div>
        </>
      ) : (
        <>
          <div className="foot-item" data-open={openPopup === 'health'} onClick={onHealth}>
            <span className={`dot ${status}`} />
            <span className="v">{statusText}</span>
          </div>
          <span style={{ color: 'var(--text-faint)' }}>·</span>
          <div className="foot-item" data-open={openPopup === 'today'} onClick={onCostToday}>
            <span className="k">今日</span>
            <span className="v">{fmt(todayUsd, '¥0.42')}</span>
            <span style={{ color: 'var(--text-faint)' }}>/ ${budgetUsd.toFixed(2)}</span>
          </div>
          <span style={{ color: 'var(--text-faint)' }}>·</span>
          <div className="foot-item" data-open={openPopup === 'session'} onClick={onCostSession}>
            <span className="k">本会话</span>
            <span className="v">{fmt(sessionUsd, '¥0.04')}</span>
          </div>
        </>
      )}
      <span className="foot-spacer" />
      <span className="foot-version">
        {!loading && modelCount !== null && providerCount !== null
          ? `${modelCount} 模型 · ${providerCount} provider · sidecar :7878`
          : loading
            ? ''
            : '12 模型 · 4 provider · sidecar :7878'}
      </span>
    </footer>
  );
}

// ── Composer ─────────────────────────────────────────────────
interface ComposerProps {
  mode: ModeId | null;
  onClearMode: () => void;
  model: ModelId;
  modelDisplay?: { color: string; label: string };
  attach: string[];
  onRemoveAttach: (i: number) => void;
  value: string;
  onChange: (v: string) => void;
  onPlus: (e: MouseEvent) => void;
  plusOpen: boolean;
  onModelClick: (e: MouseEvent) => void;
  modelOpen: boolean;
  disabled?: boolean;
  placeholder?: string;
  onSend?: () => void;
  streaming?: boolean;
}

function Composer({
  mode,
  onClearMode,
  model,
  modelDisplay,
  attach,
  onRemoveAttach,
  value,
  onChange,
  onPlus,
  plusOpen,
  onModelClick,
  modelOpen,
  disabled = false,
  placeholder,
  onSend,
  streaming = false,
}: ComposerProps) {
  const ph = placeholder ?? (mode ? `让 Taori ${MODES[mode].name}……` : '说点什么……  按 / 调用模式');

  return (
    <div className="composer-shell">
      {attach.length > 0 && (
        <div className="composer-attach-row">
          {attach.map((a, i) => (
            <span key={i} className="attach-chip">
              <Icon name="doc" size={11} style={{ color: 'var(--text-muted)' }} />
              {a}
              <span className="x" onClick={() => onRemoveAttach(i)}>
                <Icon name="x" size={11} />
              </span>
            </span>
          ))}
        </div>
      )}
      {mode && (
        <div style={{ display: 'flex' }}>
          <span className="composer-modechip">
            <Icon name={MODES[mode].icon} size={11} />
            {MODES[mode].name}：
            <span className="x" onClick={onClearMode}>
              <Icon name="x" size={10} />
            </span>
          </span>
        </div>
      )}

      <div className="composer">
        <button type="button" className={'composer-plus' + (plusOpen ? ' active' : '')} onClick={onPlus}>
          <Icon name="plus" size={16} />
        </button>
        <textarea
          className="composer-input"
          rows={1}
          placeholder={ph}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend?.();
            }
          }}
          disabled={disabled}
        />
        <button type="button" className="composer-model" onClick={onModelClick} data-open={modelOpen}>
          <span className="dot" style={{ background: modelDisplay?.color ?? MODELS[model].color }} />
          {modelDisplay?.label ?? MODELS[model].short}
          <Icon name="chevron-down" size={11} />
        </button>
        <button type="button" className={'composer-send' + (streaming || (!value && !mode) ? ' disabled' : '')} onClick={() => { if (!streaming && (value || mode)) onSend?.(); }}>
          <Icon name="arrow-up" size={15} />
        </button>
      </div>

      <div className="composer-meta">
        <span>↵ 发送 · ⇧↵ 换行 · / 模式 · ⌘K 命令</span>
        <span>{value ? `${value.length}/4000` : ''}</span>
      </div>
    </div>
  );
}

// ── Welcome ──────────────────────────────────────────────────
function Welcome({ onChip }: { onChip: (text: string) => void }) {
  const hour = new Date().getHours();
  const greeting = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  const chips = [
    { text: '写一封项目延期的邮件给客户，语气克制但保留诚意', icon: 'doc' as const, label: '写一封邮件' },
    { text: '帮我研究 2026 年 AI 编辑器市场', icon: 'research' as const, label: '帮我研究' },
    { text: '画一张赛博朋克咖啡店海报', icon: 'image' as const, label: '画一张图' },
    { text: '用三个模型一起讨论：', icon: 'roundtable' as const, label: '开个圆桌' },
  ];
  return (
    <div className="welcome">
      <div className="welcome-mark">
        <BrandMark size={28} />
      </div>
      <div className="welcome-title">
        {greeting}，<em>想聊</em>点什么？
      </div>
      <div className="welcome-hint">
        直接打字 · 或按 <kbd>/</kbd> 调用模式
      </div>
      <div className="welcome-chips">
        {chips.map((c, i) => (
          <span key={i} className="welcome-chip" onClick={() => onChip(c.text)}>
            <span className="ico"><Icon name={c.icon} size={12} /></span>
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Thread node helper ───────────────────────────────────────
function threadNodeFor(msg: Message): { color: string; knot?: boolean } {
  if (msg.kind === 'user') return { color: 'var(--text-faint)' };
  if (msg.kind === 'assistant') {
    return { color: MODELS[msg.model].color, knot: !!msg.fallback };
  }
  if (msg.kind === 'roundtable') return { color: 'var(--accent)' };
  if (msg.kind === 'research-progress') return { color: 'var(--accent)' };
  if (msg.kind === 'research-done') return { color: 'var(--ok)' };
  if (msg.kind === 'compare') return { color: 'var(--accent)' };
  if (msg.kind === 'image') return { color: MODELS[msg.model].color };
  return { color: 'var(--text-faint)' };
}

// ── Render a message ─────────────────────────────────────────
function MessageItem({ m }: { m: Message }) {
  switch (m.kind) {
    case 'user':
      return <UserMsg>{m.body}</UserMsg>;
    case 'assistant':
      return (
        <AssistantMsg
          model={m.model}
          time={m.time}
          cost={m.cost}
          tokensIn={m.tokensIn}
          tokensOut={m.tokensOut}
          fallback={m.fallback}
        >
          {m.body}
        </AssistantMsg>
      );
    case 'roundtable':
      return <RoundtableCard rows={m.rows} status={m.status} totalCost={m.totalCost} />;
    case 'research-progress':
      return (
        <ResearchInProgress
          progress={m.progress}
          iter={m.iter}
          sources={m.sources}
          papers={m.papers}
          cost={m.cost}
          now={m.now}
        />
      );
    case 'research-done':
      return <ResearchDone title={m.title} summary={m.summary} citations={m.citations} cost={m.cost} />;
    case 'compare':
      return <CompareCard cols={m.cols} picked={m.picked} />;
    case 'image':
      return <ImageCard model={m.model} cost={m.cost} />;
    default:
      return null;
  }
}

// ── App ──────────────────────────────────────────────────────
export function App() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>('pricing');
  const scenario = SCENARIOS[scenarioId];

  const [mode, setMode] = useState<ModeId | null>(null);
  const [model, setModel] = useState<ModelId>('sonnet');
  const [value, setValue] = useState('');
  const [attach, setAttach] = useState<string[]>([]);

  const [plusOpen, setPlusOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [footPopup, setFootPopup] = useState<FootPopupId>(null);
  const [drawer, setDrawer] = useState<DrawerId | null>(null);
  const [theme, setTheme] = useState<Theme>('dark');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);

  const chatRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const handleChatScroll = () => {
    const el = chatRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setShowScrollBtn(!atBottom);
  };

  const closeAllOverlays = () => {
    setPlusOpen(false);
    setModelPickerOpen(false);
    setOverflowOpen(false);
    setFootPopup(null);
    setCmdPaletteOpen(false);
  };

  // Reset composer when scenario changes
  useEffect(() => {
    setMode(null);
    setValue('');
    setAttach([]);
    closeAllOverlays();
  }, [scenarioId]);

  // Close drawer on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (cmdPaletteOpen) {
          setCmdPaletteOpen(false);
        } else if (drawer) {
          setDrawer(null);
        } else {
          closeAllOverlays();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [drawer, cmdPaletteOpen]);

  // ── Live data hooks ──────────────────────────────────────────
  // Footer status pill + provider rows feed off the same poller.
  const footerHealth = useFooterHealth();
  const realtimeCost = useRealtimeCost();
  const todayBreakdown = useTodayBreakdown(footPopup === 'today');
  const liveModels = useModels();
  const convList = useConversations();
  const isLive = convList.data !== null;
  const [convId, setConvId] = useState<string | null>(null);
  const convMsgs = useMessages(convId);

  // Global keyboard shortcuts: ⌘N (new chat), ⌘K (command palette)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip when typing in input/textarea
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      // ⌘N / Ctrl+N — new chat
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        if (isLive) { setConvId(null); setValue(''); setMode(null); setAttach([]); }
        else { setScenarioId('empty'); }
      }
      // ⌘K / Ctrl+K — command palette
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCmdPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isLive]);

  // Local message state for live mode (optimistic + streaming)
  const [liveMsgs, setLiveMsgs] = useState<ConversationMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!convId) {
      setLiveMsgs([]);
      return;
    }
    if (convMsgs.data?.messages && !isStreaming) {
      setLiveMsgs(convMsgs.data.messages);
    }
  }, [convMsgs.data, isStreaming, convId]);

  const messages = isLive ? [] : scenario.messages;
  const liveMessages = isLive ? liveMsgs : [];
  const isWelcome = isLive ? !convId : (scenario.welcome && messages.length === 0);
  const isNoKey = !isLive && !!scenario.noKey;
  const headerTitle = isLive
    ? (convList.data?.find(c => c.id === convId)?.title ?? undefined)
    : scenario.sidebarTitle;

  const liveEntries = useMemo(() => {
    if (!liveModels.data || !footerHealth.data?.providers) return [];
    return shapeLiveModels(liveModels.data, footerHealth.data.providers);
  }, [liveModels.data, footerHealth.data?.providers]);

  const modelLookup = useMemo(() => {
    const map = new Map<string, string>();
    if (liveModels.data) {
      for (const m of liveModels.data) map.set(m.id, m.display_name || m.alias || m.id);
    }
    for (const e of liveEntries) map.set(e.id, e.name || e.short);
    return map;
  }, [liveModels.data, liveEntries]);

  // Track the live model selection separately from the mock ModelId palette.
  const [liveModelId, setLiveModelId] = useState<string | null>(null);
  useEffect(() => {
    if (liveEntries.length > 0 && (!liveModelId || !liveEntries.some((e) => e.id === liveModelId))) {
      setLiveModelId(liveEntries[0].id);
    }
  }, [liveEntries, liveModelId]);

  // What the composer chip shows: prefer live model, fall back to mock.
  const composerModelDisplay = useMemo(() => {
    const liveEntry = liveEntries.find((e) => e.id === liveModelId);
    if (liveEntry) return { color: liveEntry.color, label: liveEntry.short };
    const m = MODELS[model];
    return { color: m.color, label: m.short };
  }, [liveEntries, liveModelId, model]);

  // Footer status — when nokey scenario is active the user is exploring the
  // empty-state mock so we keep that signal regardless of real sidecar health.
  const status: FootStatus = isNoKey ? 'off' : footerHealth.data?.status ?? 'ok';
  const statusText = isNoKey ? '未配置' : footerHealth.data?.statusText ?? '在线';

  const threadNodes: ReactNode = useMemo(() => {
    if (isWelcome) return null;
    if (isLive) return <div className="chat-thread" />;
    return (
      <>
        <div className="chat-thread" />
        {messages.map((m, i) => {
          const node = threadNodeFor(m);
          return <ThreadNode key={i} top={20 + i * 195} color={node.color} knot={node.knot} />;
        })}
      </>
    );
  }, [messages, isWelcome, isLive]);

  // ── Retry last assistant message ────────────────────────────
  const handleRetry = () => {
    if (isStreaming) return;
    // Find the last user message content
    let lastUserContent = '';
    for (let i = liveMsgs.length - 1; i >= 0; i--) {
      if (liveMsgs[i].role === 'user') {
        lastUserContent = liveMsgs[i].content;
        break;
      }
    }
    if (!lastUserContent) return;

    // Remove the last assistant message
    const lastIdx = liveMsgs.length - 1;
    if (lastIdx >= 0 && liveMsgs[lastIdx].role === 'assistant') {
      setLiveMsgs((prev) => prev.slice(0, -1));
    }

    // Re-send
    const convIdToUse = convId ?? '';
    setIsStreaming(true);

    const assistantMsg: ConversationMessage = {
      id: crypto.randomUUID(),
      conversation_id: convIdToUse,
      role: 'assistant',
      content: '',
      model_id: liveModelId ?? null,
      status: 'streaming',
      error: null,
      created_at: Date.now() / 1000,
      attachments_count: 0,
      image_attachments: [],
      annotations: [],
    };
    setLiveMsgs((prev) => [...prev, assistantMsg]);

    let accumulated = '';
    postChat(
      { conversation_id: convIdToUse, message: lastUserContent, model_id: liveModelId ?? undefined },
      (chunk) => {
        accumulated += chunk;
        const content = accumulated;
        setLiveMsgs((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { ...updated[updated.length - 1], content };
          return updated;
        });
      },
      () => {
        setLiveMsgs((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { ...updated[updated.length - 1], status: 'done' };
          return updated;
        });
        setIsStreaming(false);
      },
      (err) => {
        setLiveMsgs((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { ...updated[updated.length - 1], status: 'error', error: err.message };
          return updated;
        });
        setIsStreaming(false);
      },
    );
  };

  // ── Determine if last live message is the last assistant ─────
  const lastLiveMsg = liveMessages.length > 0 ? liveMessages[liveMessages.length - 1] : null;
  const lastLiveMsgId = lastLiveMsg?.id ?? null;
  const lastLiveIsDone = lastLiveMsg?.role === 'assistant' && lastLiveMsg?.status !== 'streaming';

  // ── Send message ─────────────────────────────────────────────
  const handleSend = async () => {
    const text = value.trim();
    if (!text || isStreaming) return;
    const convIdToUse = convId ?? crypto.randomUUID();
    if (!convId) setConvId(convIdToUse);
    setValue('');
    setIsStreaming(true);

    const userMsg: ConversationMessage = {
      id: crypto.randomUUID(),
      conversation_id: convIdToUse,
      role: 'user',
      content: text,
      model_id: null,
      status: 'sent',
      error: null,
      created_at: Date.now() / 1000,
      attachments_count: 0,
      image_attachments: [],
      annotations: [],
    };
    const assistantMsg: ConversationMessage = {
      id: crypto.randomUUID(),
      conversation_id: convIdToUse,
      role: 'assistant',
      content: '',
      model_id: liveModelId ?? null,
      status: 'streaming',
      error: null,
      created_at: Date.now() / 1000,
      attachments_count: 0,
      image_attachments: [],
      annotations: [],
    };
    setLiveMsgs((prev) => [...prev, userMsg, assistantMsg]);

    let accumulated = '';
    try {
      const abort = await postChat(
        { conversation_id: convIdToUse, message: text, model_id: liveModelId ?? undefined },
        (chunk) => {
          accumulated += chunk;
          const content = accumulated;
          setLiveMsgs((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { ...updated[updated.length - 1], content };
            return updated;
          });
        },
        () => {
          setLiveMsgs((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { ...updated[updated.length - 1], status: 'done' };
            return updated;
          });
          setIsStreaming(false);
          // Refetch conversation list so title / ordering updates
          convList.refetch?.();
        },
        (err) => {
          setLiveMsgs((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { ...updated[updated.length - 1], status: 'error', error: err.message };
            return updated;
          });
          setIsStreaming(false);
        },
      );
      abortRef.current = abort;
    } catch {
      setIsStreaming(false);
    }
  };

  const popupOffsetStyle = (left: number): CSSProperties => ({
    position: 'absolute',
    left,
    bottom: 'calc(var(--footer-h) + 8px)',
    zIndex: 80,
  });

  return (
    <div className="app">
      <Header
        title={headerTitle}
        onOverflow={(e) => {
          e.stopPropagation();
          setOverflowOpen((o) => !o);
        }}
        overflowOpen={overflowOpen}
        onMenu={() => setSidebarOpen((o) => !o)}
      />

      {sidebarOpen && <div className="side-backdrop" onClick={() => setSidebarOpen(false)} />}
      <Sidebar
        scenario={scenarioId}
        onSelect={setScenarioId}
        conversations={isLive ? convList.data ?? undefined : undefined}
        loading={convList.loading}
        selectedConvId={convId}
        onSelectConversation={setConvId}
        onNewChat={() => {
          if (isLive) {
            setConvId(null);
            setValue('');
            setMode(null);
            setAttach([]);
          } else {
            setScenarioId('empty');
          }
        }}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onRename={async (id, title) => {
          await patchConversation(id, { title });
          convList.refetch?.();
        }}
        onDelete={async (id) => {
          await deleteConversation(id);
          if (convId === id) setConvId(null);
          convList.refetch?.();
        }}
      />

      <div className="main" onClick={closeAllOverlays} ref={chatRef} onScroll={handleChatScroll}>
        <div className="chat" style={{ position: 'relative' }}>
          {threadNodes}
          {isWelcome && <Welcome onChip={(t) => setValue(t)} />}
          {isLive
            ? liveMessages.map((m) => (
              <LiveMessageItem
                key={m.id}
                msg={m}
                modelLookup={modelLookup}
                isLastAssistant={m.id === lastLiveMsgId && m.role === 'assistant' && lastLiveIsDone}
                onRetry={m.id === lastLiveMsgId && m.role === 'assistant' && lastLiveIsDone ? handleRetry : undefined}
              />
            ))
            : messages.map((m, i) => <MessageItem key={i} m={m} />)}
        </div>
        {showScrollBtn && (
          <button
            className="scroll-bottom-btn"
            type="button"
            onClick={() => chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' })}
          >
            <Icon name="chevron-right" size={16} style={{ transform: 'rotate(90deg)' }} />
          </button>
        )}

        {isNoKey && <NoKeyCard />}

        <Composer
          mode={mode}
          onClearMode={() => setMode(null)}
          model={model}
          modelDisplay={composerModelDisplay}
          attach={attach}
          onRemoveAttach={(i) => setAttach(attach.filter((_, k) => k !== i))}
          value={value}
          onChange={setValue}
          onPlus={(e) => {
            e.stopPropagation();
            setPlusOpen((o) => !o);
            setModelPickerOpen(false);
          }}
          plusOpen={plusOpen}
          onModelClick={(e) => {
            e.stopPropagation();
            setModelPickerOpen((o) => !o);
            setPlusOpen(false);
          }}
          modelOpen={modelPickerOpen}
          disabled={isNoKey || isStreaming}
          placeholder={isNoKey ? '先配一个 API Key 才能聊 — 看下面的卡片 ↓' : undefined}
          onSend={isLive ? handleSend : undefined}
          streaming={isStreaming}
        />

        {plusOpen && (
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', bottom: 100, left: 40, zIndex: 30 }}>
            <ModeMenu
              onPick={(id) => {
                setMode(id as ModeId);
                setPlusOpen(false);
              }}
            />
          </div>
        )}

        {modelPickerOpen && (
          <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', bottom: 70, right: 50, zIndex: 30 }}>
            <ModelPicker
              current={model}
              onPick={(id) => {
                setModel(id);
                setModelPickerOpen(false);
              }}
              liveEntries={liveEntries}
              liveCurrentId={liveModelId ?? undefined}
              onPickLive={(id) => {
                setLiveModelId(id);
                setModelPickerOpen(false);
              }}
              onOpenManager={() => {
                setModelPickerOpen(false);
                setDrawer('models');
              }}
            />
          </div>
        )}

        {footPopup === 'health' && (
          <div onClick={(e) => e.stopPropagation()} style={popupOffsetStyle(12)}>
            <HealthPopup
              providers={footerHealth.data?.providers}
              keyStatuses={footerHealth.data?.keyStatuses}
              onNavigate={() => { setFootPopup(null); setDrawer('settings'); }}
            />
          </div>
        )}
        {footPopup === 'today' && (
          <div onClick={(e) => e.stopPropagation()} style={popupOffsetStyle(100)}>
            <CostTodayPopup
              realtime={realtimeCost.data}
              breakdown={todayBreakdown.data}
              onNavigate={() => { setFootPopup(null); setDrawer('settings'); }}
            />
          </div>
        )}
        {footPopup === 'session' && (
          <div onClick={(e) => e.stopPropagation()} style={popupOffsetStyle(220)}>
            <CostSessionPopup
              onNavigate={() => { setFootPopup(null); setDrawer('settings'); }}
            />
          </div>
        )}

        {overflowOpen && (
          <div onClick={(e) => e.stopPropagation()}>
            <OverMenu
              theme={theme}
              onTheme={setTheme}
              onOpenDrawer={(id) => {
                setDrawer(id);
                setOverflowOpen(false);
              }}
              onHelp={() => { setOverflowOpen(false); setDrawer('settings'); }}
            />
          </div>
        )}

        {drawer === 'models' && <ModelToolsDrawer onClose={() => setDrawer(null)} />}
        {drawer === 'settings' && <SettingsDrawer onClose={() => setDrawer(null)} />}
      </div>

      {cmdPaletteOpen && (
        <CommandPalette
          models={liveEntries}
          conversations={convList.data ?? []}
          currentModelId={liveModelId}
          onSelectModel={(id) => { setLiveModelId(id); setCmdPaletteOpen(false); }}
          onSelectConversation={(id) => { setConvId(id); setCmdPaletteOpen(false); }}
          onSelectMode={(modeId) => { setMode(modeId as ModeId); setCmdPaletteOpen(false); }}
          onNewChat={() => {
            if (isLive) { setConvId(null); setValue(''); setMode(null); setAttach([]); }
            else { setScenarioId('empty'); }
            setCmdPaletteOpen(false);
          }}
          onOpenSettings={() => { setDrawer('settings'); setCmdPaletteOpen(false); }}
          onClose={() => setCmdPaletteOpen(false)}
        />
      )}

      <Footer
        status={status}
        statusText={statusText}
        todayUsd={realtimeCost.data?.today_usd ?? null}
        sessionUsd={realtimeCost.data?.current_conversation_usd ?? null}
        budgetUsd={5}
        modelCount={liveModels.data?.length ?? null}
        providerCount={footerHealth.data?.providers.length ?? null}
        loading={isLive && (footerHealth.loading || realtimeCost.loading)}
        openPopup={footPopup}
        onHealth={(e) => {
          e.stopPropagation();
          setFootPopup((p) => (p === 'health' ? null : 'health'));
        }}
        onCostToday={(e) => {
          e.stopPropagation();
          setFootPopup((p) => (p === 'today' ? null : 'today'));
        }}
        onCostSession={(e) => {
          e.stopPropagation();
          setFootPopup((p) => (p === 'session' ? null : 'session'));
        }}
      />
    </div>
  );
}

// Suppress unused-import warning for Banner (kept exported in surfaces for future use)
void Banner;
