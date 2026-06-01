import { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import type { Conversation } from './api';

type View = 'empty' | 'chat' | 'settings' | 'features';

interface SidebarProps {
  view: View;
  activeFeatureTab?: 'features' | 'tools' | 'cost';
  conversations: Conversation[];
  activeConversationId: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onRenameConversation: (conversation: Conversation) => void;
  onTogglePin: (conversation: Conversation) => void;
  onArchiveConversation: (conversation: Conversation) => void;
  onDeleteConversation: (conversation: Conversation) => void;
  onBulkDeleteConversations: (conversations: Conversation[]) => Promise<boolean>;
  onOpenFeatures: () => void;
  onOpenTools: () => void;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
  todayUsd?: number | null;
  onOpenCost?: () => void;
}

function formatUsd(value: number | null | undefined): string {
  if (value == null) return '';
  if (value === 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

interface Group {
  key: string;
  label: string;
  items: Conversation[];
}

function groupByRecency(conversations: Conversation[]): Group[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 24 * 60 * 60 * 1000;
  const weekStart = today - 7 * 24 * 60 * 60 * 1000;

  const groups: Record<string, Conversation[]> = { today: [], yesterday: [], week: [], earlier: [] };
  for (const c of conversations) {
    const ts = c.updated_at;
    if (ts >= today) groups.today!.push(c);
    else if (ts >= yesterday) groups.yesterday!.push(c);
    else if (ts >= weekStart) groups.week!.push(c);
    else groups.earlier!.push(c);
  }
  return [
    { key: 'today', label: '今天', items: groups.today! },
    { key: 'yesterday', label: '昨天', items: groups.yesterday! },
    { key: 'week', label: '本周', items: groups.week! },
    { key: 'earlier', label: '更早', items: groups.earlier! },
  ];
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [managingHistory, setManagingHistory] = useState(false);
  const [selectedConversationIds, setSelectedConversationIds] = useState<Set<string>>(() => new Set());
  const featuresActive = props.view === 'features' && props.activeFeatureTab !== 'tools';
  const toolsActive = props.view === 'features' && props.activeFeatureTab === 'tools';
  const groups = useMemo(() => {
    const filtered = query.trim()
      ? props.conversations.filter((c) =>
          (c.title ?? '未命名对话').toLowerCase().includes(query.toLowerCase()),
        )
      : props.conversations;
    return groupByRecency(filtered);
  }, [props.conversations, query]);

  const visibleGroups = groups.filter((g) => g.items.length > 0);
  const visibleConversations = useMemo(() => visibleGroups.flatMap((group) => group.items), [visibleGroups]);
  const selectedConversations = useMemo(
    () => props.conversations.filter((conversation) => selectedConversationIds.has(conversation.id)),
    [props.conversations, selectedConversationIds],
  );
  const allVisibleSelected =
    visibleConversations.length > 0 &&
    visibleConversations.every((conversation) => selectedConversationIds.has(conversation.id));

  useEffect(() => {
    setSelectedConversationIds((current) => {
      const validIds = new Set(props.conversations.map((conversation) => conversation.id));
      const next = new Set(Array.from(current).filter((id) => validIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [props.conversations]);

  function toggleConversationSelection(id: string): void {
    setSelectedConversationIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearHistorySelection(): void {
    setSelectedConversationIds(new Set());
  }

  function toggleAllVisible(): void {
    setSelectedConversationIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const conversation of visibleConversations) next.delete(conversation.id);
      } else {
        for (const conversation of visibleConversations) next.add(conversation.id);
      }
      return next;
    });
  }

  function closeManageMode(): void {
    setManagingHistory(false);
    clearHistorySelection();
  }

  async function bulkDeleteSelected(): Promise<void> {
    if (selectedConversations.length === 0) return;
    const deleted = await props.onBulkDeleteConversations(selectedConversations);
    if (deleted) closeManageMode();
  }

  const renderBulkToolbar = (): JSX.Element => (
    <div className={`history-bulk-bar ${managingHistory ? 'active' : ''}`}>
      {managingHistory ? (
        <>
          <span>已选 {selectedConversationIds.size} 个</span>
          <button type="button" className="history-bulk-btn" onClick={toggleAllVisible} disabled={visibleConversations.length === 0} data-testid="history-select-all">
            {allVisibleSelected ? '取消全选' : '全选'}
          </button>
          <button type="button" className="history-bulk-btn danger" onClick={() => void bulkDeleteSelected()} disabled={selectedConversations.length === 0} data-testid="history-bulk-delete">
            删除
          </button>
          <button type="button" className="history-bulk-btn" onClick={closeManageMode}>
            完成
          </button>
        </>
      ) : (
        <>
          <span>{query.trim() ? `${visibleConversations.length} 个匹配` : '历史对话'}</span>
          <button
            type="button"
            className="history-bulk-btn"
            onClick={() => setManagingHistory(true)}
            disabled={props.conversations.length === 0}
            data-testid="history-manage"
          >
            管理
          </button>
        </>
      )}
    </div>
  );

  const renderHistoryList = (mobile: boolean): JSX.Element => (
    <div className="history-scroll scroll">
      {visibleGroups.length === 0 && (
        <div className="history-empty">
          {query.trim() ? '没有匹配的对话' : '还没有对话。'}
          <span className="hint">
            {query.trim()
              ? '换个关键词试试，或先去开始一段。'
              : '开始一段吧 — 它会按时间归到这里。'}
          </span>
        </div>
      )}
      {visibleGroups.map((group) => (
        <div className="history-group" key={group.key}>
          <div className="history-label">{group.label}</div>
          {group.items.map((conversation) => (
            <div
              key={conversation.id}
              className={`chat-row-wrap ${managingHistory ? 'selecting' : ''} ${
                props.activeConversationId === conversation.id ? 'active' : ''
              }`}
            >
              {managingHistory && (
                <label className="history-select" aria-label={`选择 ${conversation.title || '未命名对话'}`}>
                  <input
                    type="checkbox"
                    checked={selectedConversationIds.has(conversation.id)}
                    onChange={() => toggleConversationSelection(conversation.id)}
                    data-testid={`conversation-select-${conversation.id}`}
                  />
                </label>
              )}
              <button
                type="button"
                className="chat-row"
                onClick={() => {
                  if (managingHistory) {
                    toggleConversationSelection(conversation.id);
                    return;
                  }
                  props.onSelectConversation(conversation.id);
                  if (mobile) setMobileHistoryOpen(false);
                }}
              >
                {conversation.pinned && (
                  <span className="pin" title="已固定">
                    <Icon name="pin" size={11} stroke={1.8} />
                  </span>
                )}
                <span className="title">{conversation.title || '未命名对话'}</span>
              </button>
              {!managingHistory && (
                <div className="chat-row-actions">
                <button
                  type="button"
                  title="重命名"
                  onClick={() => props.onRenameConversation(conversation)}
                  data-testid={mobile ? undefined : `conversation-rename-${conversation.id}`}
                >
                  <Icon name="edit" size={12} />
                </button>
                <button
                  type="button"
                  title={conversation.pinned ? '取消固定' : '固定'}
                  onClick={() => props.onTogglePin(conversation)}
                  data-testid={mobile ? undefined : `conversation-pin-${conversation.id}`}
                >
                  <Icon name="pin" size={12} />
                </button>
                <button
                  type="button"
                  title="归档"
                  onClick={() => props.onArchiveConversation(conversation)}
                  data-testid={mobile ? undefined : `conversation-archive-${conversation.id}`}
                >
                  <Icon name="archive" size={12} />
                </button>
                <button
                  type="button"
                  title="删除"
                  onClick={() => props.onDeleteConversation(conversation)}
                  data-testid={mobile ? undefined : `conversation-delete-${conversation.id}`}
                >
                  <Icon name="trash" size={12} />
                </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <div className="brand-mark" aria-label="Taori 织">织</div>
          {!props.collapsed && (
            <div style={{ lineHeight: 1.15 }}>
              <div className="brand-name">
                织 <span className="brand-wordmark">Taori</span>
              </div>
              <div className="brand-sub">多模型本地 AI 助手</div>
            </div>
          )}
        </div>
        {!props.collapsed && (
          <button
            type="button"
            className="icon-btn"
            onClick={props.onToggleCollapse}
            title="收起侧边栏"
          >
            <Icon name="sidebarL" size={16} />
          </button>
        )}
      </div>

      {props.collapsed && (
        <div className="sidebar-rail">
          <button type="button" className="icon-btn" onClick={props.onToggleCollapse} title="展开">
            <Icon name="sidebarL" />
          </button>
          <button type="button" className="icon-btn" onClick={props.onNewChat} title="新对话">
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className={`icon-btn ${featuresActive ? 'active' : ''}`}
            onClick={props.onOpenFeatures}
            title="能力中心"
            data-testid="sidebar-features"
          >
            <Icon name="bolt" />
          </button>
          <button
            type="button"
            className={`icon-btn ${toolsActive ? 'active' : ''}`}
            onClick={props.onOpenTools}
            title="工具管理"
            data-testid="sidebar-tools"
          >
            <Icon name="panel" />
          </button>
          <button
            type="button"
            className={`icon-btn ${props.view === 'settings' ? 'active' : ''}`}
            onClick={props.onOpenSettings}
            title="设置"
          >
            <Icon name="settings" />
          </button>
        </div>
      )}

      {!props.collapsed && (
        <div className="sidebar-rail sidebar-rail-mobile" aria-label="移动端导航">
          <button type="button" className="icon-btn" onClick={props.onNewChat} title="新对话" aria-label="新对话">
            <Icon name="plus" />
          </button>
          <button
            type="button"
            className={`icon-btn ${mobileHistoryOpen ? 'active' : ''}`}
            onClick={() => setMobileHistoryOpen(true)}
            title="历史对话"
            aria-label="历史对话"
            data-testid="mobile-history-open"
          >
            <Icon name="chat" />
          </button>
          <button
            type="button"
            className={`icon-btn ${featuresActive ? 'active' : ''}`}
            onClick={props.onOpenFeatures}
            title="能力中心"
            aria-label="能力中心"
          >
            <Icon name="bolt" />
          </button>
          <button
            type="button"
            className={`icon-btn ${toolsActive ? 'active' : ''}`}
            onClick={props.onOpenTools}
            title="工具管理"
            aria-label="工具管理"
            data-testid="mobile-tools"
          >
            <Icon name="panel" />
          </button>
          <button
            type="button"
            className={`icon-btn ${props.view === 'settings' ? 'active' : ''}`}
            onClick={props.onOpenSettings}
            title="设置"
            aria-label="设置"
          >
            <Icon name="settings" />
          </button>
        </div>
      )}

      {!props.collapsed && mobileHistoryOpen && (
        <>
          <button
            type="button"
            className="mobile-history-backdrop open"
            aria-label="关闭历史对话"
            onClick={() => setMobileHistoryOpen(false)}
          />
          <div className="mobile-history-drawer open" data-testid="mobile-history-drawer">
            <div className="mobile-history-head">
              <div>
                <div className="mobile-history-title">历史对话</div>
                <div className="mobile-history-sub">搜索并回到之前的上下文</div>
              </div>
              <button type="button" className="icon-btn" onClick={() => setMobileHistoryOpen(false)} title="关闭">
                <Icon name="close" />
              </button>
            </div>
            <div className="search-row mobile-history-search">
              <Icon name="search" size={14} />
              <input
                type="text"
                placeholder="搜索对话"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {renderBulkToolbar()}
            {renderHistoryList(true)}
          </div>
        </>
      )}

      {!props.collapsed && (
        <>
          <div className="sidebar-actions">
            <button type="button" className="new-chat-btn" onClick={props.onNewChat}>
              <Icon name="plus" size={15} />
              <span>新对话</span>
              <span className="kbd">⌘N</span>
            </button>
            <button
              type="button"
              className={`feature-nav-btn ${featuresActive ? 'active' : ''}`}
              onClick={props.onOpenFeatures}
              data-testid="sidebar-features"
            >
              <Icon name="bolt" size={15} />
              <span>能力中心</span>
            </button>
            <button
              type="button"
              className={`feature-nav-btn ${toolsActive ? 'active' : ''}`}
              onClick={props.onOpenTools}
              data-testid="sidebar-tools"
            >
              <Icon name="panel" size={15} />
              <span>工具管理</span>
            </button>
          </div>

          <div className="search-row">
            <Icon name="search" size={14} />
            <input
              type="text"
              placeholder="搜索对话"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button
              type="button"
              className="palette-hint"
              onClick={props.onOpenPalette}
              title="命令面板（切模型 · 跳对话 · 更多）"
              data-testid="sidebar-palette-hint"
            >
              ⌘K
            </button>
          </div>

          {renderBulkToolbar()}
          {renderHistoryList(false)}
        </>
      )}

      <div className="sidebar-foot">
        <div className="avatar">你</div>
        {!props.collapsed && (
          <>
            <div className="user-info">
              <div className="user-name">你</div>
              {props.onOpenCost ? (
                <button
                  type="button"
                  className="user-plan user-plan-cost"
                  onClick={props.onOpenCost}
                  title="查看成本明细"
                  data-testid="sidebar-today-cost"
                >
                  {props.todayUsd != null
                    ? `今天 ${formatUsd(props.todayUsd)} · 本地`
                    : '本地 · 数据不出端'}
                </button>
              ) : (
                <div className="user-plan">本地工作台</div>
              )}
            </div>
            <button
              type="button"
              className={`sidebar-settings-btn ${props.view === 'settings' ? 'active' : ''}`}
              onClick={props.onOpenSettings}
              title="设置"
              aria-label="设置"
              data-testid="sidebar-settings"
            >
              <Icon name="settings" size={15} />
              <span>设置</span>
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
