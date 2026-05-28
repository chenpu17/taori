import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Icon, type IconName } from './primitives';
import type { Conversation } from './api';
import { SIDEBAR_GROUPS, type ScenarioId } from './scenarios';

// ── Sidebar ──────────────────────────────────────────────────
export function Sidebar({
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
  onPin,
  onTag,
  onExport,
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
  onPin?: (id: string, pinned: boolean) => Promise<void>;
  onTag?: (id: string, tags: string[]) => Promise<void>;
  onExport?: (id: string) => void;
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
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [tagEditId, setTagEditId] = useState<string | null>(null);
  const [tagEditVal, setTagEditVal] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!ctxMenu && !renaming && !confirmDel && !tagEditId) return;
    const onMouseDown = () => { setCtxMenu(null); };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCtxMenu(null);
        if (renaming) setRenaming(null);
        setConfirmDel(null);
        setTagEditId(null);
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

  const togglePin = async () => {
    if (!ctxMenu) return;
    const conv = conversations?.find((c) => c.id === ctxMenu.id);
    if (!conv) return;
    await onPin?.(conv.id, !conv.pinned);
    setCtxMenu(null);
  };

  const startTagEdit = () => {
    if (!ctxMenu) return;
    const conv = conversations?.find((c) => c.id === ctxMenu.id);
    if (!conv) return;
    setTagEditVal((conv.tags ?? []).join(', '));
    setTagEditId(conv.id);
    setCtxMenu(null);
  };

  const commitTagEdit = async () => {
    if (!tagEditId) return;
    const tags = tagEditVal.split(/[,，]\s*/).map((t) => t.trim()).filter(Boolean);
    await onTag?.(tagEditId, tags);
    setTagEditId(null);
  };

  const handleExport = () => {
    if (!ctxMenu) return;
    onExport?.(ctxMenu.id);
    setCtxMenu(null);
  };

  // All unique tags across conversations
  const allTags = useMemo(() => {
    if (!conversations) return [];
    const set = new Set<string>();
    for (const c of conversations) c.tags?.forEach((t) => set.add(t));
    return Array.from(set).sort();
  }, [conversations]);

  const grouped = useMemo(() => {
    if (!conversations || conversations.length === 0) return [];
    let filtered = search
      ? conversations.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()))
      : conversations;
    if (tagFilter) {
      filtered = filtered.filter((c) => c.tags?.includes(tagFilter));
    }
    // Separate pinned conversations
    const pinned = filtered.filter((c) => c.pinned);
    const unpinned = filtered.filter((c) => !c.pinned);
    const nowMs = Date.now();
    const sod = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
    const todayMs = sod(nowMs);
    const timeGroup = (list: Conversation[]) => {
      const groups: { label: string; list: Conversation[] }[] = [
        { label: '今天', list: [] },
        { label: '昨天', list: [] },
        { label: '本周', list: [] },
        { label: '更早', list: [] },
      ];
      for (const c of list) {
        const ts = c.updated_at > 1e12 ? c.updated_at : c.updated_at * 1000;
        if (ts >= todayMs) groups[0].list.push(c);
        else if (ts >= todayMs - 86400000) groups[1].list.push(c);
        else if (ts >= todayMs - 7 * 86400000) groups[2].list.push(c);
        else groups[3].list.push(c);
      }
      return groups.filter((g) => g.list.length > 0);
    };
    const result: { label: string; list: Conversation[]; isPinned?: boolean }[] = [];
    if (pinned.length > 0) result.push({ label: '置顶', list: pinned, isPinned: true });
    result.push(...timeGroup(unpinned));
    return result;
  }, [conversations, search, tagFilter]);

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

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div className="side-tags-bar">
          <button type="button" className={'side-tag-filter' + (!tagFilter ? ' active' : '')} onClick={() => setTagFilter(null)}>全部</button>
          {allTags.map((t) => (
            <button key={t} type="button" className={'side-tag-filter' + (tagFilter === t ? ' active' : '')} onClick={() => setTagFilter(tagFilter === t ? null : t)}>{t}</button>
          ))}
        </div>
      )}

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
              const isTagEditing = tagEditId === c.id;
              return (
                <div
                  key={c.id}
                  className={'side-item' + (selectedConvId === c.id ? ' active' : '')}
                  onClick={() => {
                    if (!isRenaming && !isDeleting && !isTagEditing) { onSelectConversation?.(c.id); onClose?.(); }
                  }}
                  onContextMenu={(e) => handleContextMenu(e, c.id)}
                >
                  {c.pinned && !isRenaming && <span className="side-item-pin">📌</span>}
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
                  {!isRenaming && !isDeleting && !isTagEditing && c.tags && c.tags.length > 0 && (
                    <span className="side-item-tags">
                      {c.tags.map((t) => <span key={t} className="side-tag">{t}</span>)}
                    </span>
                  )}
                  {ki && !isRenaming && !isDeleting && !isTagEditing && <span className="side-item-kind"><Icon name={ki} size={12} /></span>}
                  {!isRenaming && !isDeleting && !isTagEditing && (
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
                  {isTagEditing && (
                    <input
                      className="side-item-input"
                      style={{ fontSize: 12 }}
                      value={tagEditVal}
                      placeholder="标签1, 标签2"
                      onChange={(e) => setTagEditVal(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') commitTagEdit();
                        if (e.key === 'Escape') setTagEditId(null);
                      }}
                      onBlur={() => commitTagEdit()}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
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
      {ctxMenu && (() => {
        const conv = conversations?.find((c) => c.id === ctxMenu.id);
        return (
          <div
            className="side-ctx-menu"
            style={{ top: ctxMenu.y, left: ctxMenu.x }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="side-ctx-item" onClick={startRename}>
              <Icon name="edit" size={13} style={{ marginRight: 8 }} />
              重命名
            </div>
            <div className="side-ctx-item" onClick={togglePin}>
              <span style={{ marginRight: 8, fontSize: 13 }}>📌</span>
              {conv?.pinned ? '取消置顶' : '置顶'}
            </div>
            <div className="side-ctx-item" onClick={startTagEdit}>
              <span style={{ marginRight: 8, fontSize: 13 }}>🏷️</span>
              编辑标签
            </div>
            <div className="side-ctx-item" onClick={handleExport}>
              <span style={{ marginRight: 8, fontSize: 13 }}>📋</span>
              导出 Markdown
            </div>
            <div className="side-ctx-sep" />
            <div className="side-ctx-item danger" onClick={startDelete}>
              <Icon name="x" size={13} style={{ marginRight: 8 }} />
              删除
            </div>
          </div>
        );
      })()}
    </aside>
  );
}
