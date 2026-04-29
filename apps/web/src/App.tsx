import { useChat } from '@ai-sdk/react';
import type { Message as AiMessage } from '@ai-sdk/react';
import { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import { getSidecarEndpoint, authedFetch } from './sidecar.js';
import { api } from './api.js';
import { Onboarding } from './Onboarding.js';
import { Settings } from './Settings.js';
import { ModelCenter } from './ModelCenter.js';
import { HelpCenter } from './HelpCenter.js';
import { CommandPalette } from './CommandPalette.js';
import { TaoriIcon } from './TaoriIcon.js';
import { RoundtableLaunchDialog } from './Roundtable.js';
import { RoundtablePanel } from './RoundtablePanel.js';
import { priceTier, PRICE_TIER_LABEL, formatUsd, estimateInputTokens, estimateCostUsd } from '@taori/shared';
import type { Model } from '@taori/shared';
import { renderMarkdown } from './markdown.js';

const STARTER_PROMPTS: Array<{ icon: string; title: string; desc: string; text: string }> = [
  {
    icon: '⚖️',
    title: '比较模型',
    desc: '让多个模型同时回答',
    text: '请用一段话比较 GPT-4o 和 Claude 3.5 Sonnet 在长文本写作上的差异。',
  },
  {
    icon: '✍️',
    title: '写作助手',
    desc: '草拟一份内容初稿',
    text: '帮我写一段产品发布的中文公告，强调多模型协作、成本透明与本地优先。',
  },
  {
    icon: '🐞',
    title: '调试代码',
    desc: '解释一段错误堆栈',
    text: '我贴一段 TypeScript 错误堆栈，请你逐行解释原因并给出修复建议：\n\n',
  },
  {
    icon: '💡',
    title: '头脑风暴',
    desc: '快速展开一个想法',
    text: '我想给一个桌面 AI 助手加“工作流模板”，请提出 10 个可行的模板方向，每条一句话。',
  },
];

interface HealthState {
  ok: boolean;
  control: 'connected' | 'disconnected' | 'unknown' | 'error';
  version?: string;
}

interface ConversationSummary {
  id: string;
  title: string | null;
  type: string;
  created_at: number;
  updated_at: number;
  archived: boolean;
  pinned: boolean;
  tags: string | null;
}

type BootState =
  | { kind: 'loading' }
  | { kind: 'onboarding' }
  | { kind: 'ready'; chatModels: Model[]; defaultChatModel: Model }
  | { kind: 'error'; error: string };

export function App(): JSX.Element {
  const [endpoint, setEndpoint] = useState<{ url: string; bearer: string } | null>(null);
  const [endpointError, setEndpointError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthState | null>(null);
  const [boot, setBoot] = useState<BootState>({ kind: 'loading' });
  // M1 §1.2: user can skip onboarding to browse the empty workspace.
  // We persist the choice so refreshing doesn't push them back to the wizard.
  const [browseOnly, setBrowseOnly] = useState<boolean>(() => {
    try {
      return localStorage.getItem('taori.browseOnly') === '1';
    } catch {
      return false;
    }
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelCenterOpen, setModelCenterOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [forceOnboarding, setForceOnboarding] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const ep = await getSidecarEndpoint();
        setEndpoint(ep);
      } catch (e) {
        setEndpointError(e instanceof Error ? e.message : String(e));
      }
    })().catch(() => {});
  }, []);

  useEffect(() => {
    if (!endpoint) return;
    authedFetch('/health')
      .then(async (r) => {
        if (!r.ok) {
          setHealth({ ok: false, control: 'error' });
          return;
        }
        const body = await r.json();
        setHealth({
          ok: body.ok === true,
          control: body.control_channel,
          version: body.version,
        });
      })
      .catch(() => setHealth({ ok: false, control: 'error' }));
  }, [endpoint]);

  const reload = useCallback(async (): Promise<void> => {
    setBoot({ kind: 'loading' });
    try {
      const [{ providers }, { models }] = await Promise.all([
        api.listProviders(),
        api.listModels(),
      ]);
      const enabled = providers.filter((p) => p.enabled);
      const chatModels = models.filter((m) => m.capability === 'chat' && m.enabled);
      const def = chatModels.find((m) => m.is_default_for === 'chat') ?? chatModels[0];
      if (enabled.length === 0 || !def) {
        setBoot({ kind: 'onboarding' });
      } else {
        setBoot({ kind: 'ready', chatModels, defaultChatModel: def });
      }
    } catch (e) {
      setBoot({
        kind: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    if (!endpoint || !health?.ok) return;
    void reload();
  }, [endpoint, health?.ok, reload]);

  const persistBrowseOnly = useCallback((v: boolean): void => {
    setBrowseOnly(v);
    try {
      if (v) localStorage.setItem('taori.browseOnly', '1');
      else localStorage.removeItem('taori.browseOnly');
    } catch {
      /* ignore */
    }
  }, []);

  const onSkipOnboarding = useCallback((): void => {
    persistBrowseOnly(true);
    setForceOnboarding(false);
  }, [persistBrowseOnly]);

  const onReopenOnboarding = useCallback((): void => {
    setSettingsOpen(false);
    setForceOnboarding(true);
    persistBrowseOnly(false);
  }, [persistBrowseOnly]);

  const onSettingsChanged = useCallback((): void => {
    void reload();
  }, [reload]);

  // When configuration becomes ready, drop the browse-only flag automatically.
  useEffect(() => {
    if (boot.kind === 'ready' && browseOnly) {
      persistBrowseOnly(false);
      setForceOnboarding(false);
    }
  }, [boot.kind, browseOnly, persistBrowseOnly]);

  const showOnboarding =
    forceOnboarding || (boot.kind === 'onboarding' && !browseOnly);
  const showBrowseOnly = boot.kind === 'onboarding' && browseOnly && !forceOnboarding;

  return (
    <div className="app">
      <header>
        <h1 className="brand">
          <TaoriIcon size={28} className="brand__icon" />
          <span className="brand__name">Taori</span>
        </h1>
        <span className="header-actions">
          <StatusBadge endpoint={endpoint} health={health} error={endpointError} />
          {endpoint && health?.ok && (
            <button
              type="button"
              className="settings-btn"
              onClick={() => setModelCenterOpen(true)}
              data-testid="open-model-center"
              aria-label="模型中心"
              title="模型中心"
            >
              🧬
            </button>
          )}
          {endpoint && health?.ok && (
            <button
              type="button"
              className="settings-btn"
              onClick={() => setHelpOpen(true)}
              data-testid="open-help"
              aria-label="使用帮助"
              title="使用帮助"
            >
              ？
            </button>
          )}
          {endpoint && health?.ok && (
            <button
              type="button"
              className="settings-btn"
              onClick={() => setSettingsOpen(true)}
              data-testid="open-settings"
              aria-label="设置"
              title="设置"
            >
              ⚙
            </button>
          )}
        </span>
      </header>
      {!endpoint ? (
        <div className="placeholder">
          {endpointError ? <pre className="err">{endpointError}</pre> : 'Connecting to sidecar…'}
        </div>
      ) : boot.kind === 'loading' ? (
        <div className="placeholder">加载中…</div>
      ) : boot.kind === 'error' ? (
        <div className="placeholder"><pre className="err">{boot.error}</pre></div>
      ) : showOnboarding ? (
        <Onboarding
          onDone={() => {
            setForceOnboarding(false);
            void reload();
          }}
          onSkip={onSkipOnboarding}
        />
      ) : showBrowseOnly ? (
        <BrowseOnlyWorkspace onConfigure={onReopenOnboarding} />
      ) : boot.kind === 'ready' ? (
        <Workspace
          endpoint={endpoint}
          chatModels={boot.chatModels}
          defaultModel={boot.defaultChatModel}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : null}
      {settingsOpen && (
        <Settings
          onClose={() => setSettingsOpen(false)}
          onChanged={onSettingsChanged}
          onReopenOnboarding={onReopenOnboarding}
        />
      )}
      {modelCenterOpen && (
        <div
          className="model-center-overlay"
          role="dialog"
          aria-modal="true"
          data-testid="model-center-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModelCenterOpen(false);
          }}
        >
          <ModelCenter
            onClose={() => setModelCenterOpen(false)}
            onReopenOnboarding={() => {
              setModelCenterOpen(false);
              onReopenOnboarding();
            }}
          />
        </div>
      )}
      {helpOpen && <HelpCenter onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

function BrowseOnlyWorkspace({
  onConfigure,
}: {
  onConfigure: () => void;
}): JSX.Element {
  return (
    <div className="placeholder browse-only" data-testid="browse-only">
      <h2>仅浏览模式</h2>
      <p className="hint">尚未配置任何模型，无法发起对话。</p>
      <button type="button" onClick={onConfigure} data-testid="browse-only-configure">
        配置模型
      </button>
    </div>
  );
}

function StatusBadge({
  endpoint,
  health,
  error,
}: {
  endpoint: { url: string; bearer: string } | null;
  health: HealthState | null;
  error: string | null;
}): JSX.Element {
  if (error) return <span className="badge bad" title="sidecar: error">●<span className="badge-label"> 故障</span></span>;
  if (!endpoint) return <span className="badge unknown" title="sidecar: connecting…">●<span className="badge-label"> 连接中</span></span>;
  if (!health) return <span className="badge unknown" title="sidecar: probing…">●<span className="badge-label"> 探测中</span></span>;
  const tip = `sidecar v${health.version ?? '?'} · control: ${health.control}`;
  return (
    <span className={`badge ${health.ok ? 'ok' : 'bad'}`} title={tip}>
      ●<span className="badge-label"> {health.ok ? '在线' : '离线'} v{health.version ?? '?'}</span>
    </span>
  );
}

/**
 * Workspace = sidebar (conversations) + main panel (chat).
 *
 * Owns the active conversation id and the active model id; ChatPanel mounts
 * fresh whenever either changes (via React `key`) so useChat starts from a
 * clean slate.
 */
function Workspace({
  endpoint,
  chatModels,
  defaultModel,
  onOpenSettings,
}: {
  endpoint: { url: string; bearer: string };
  chatModels: Model[];
  defaultModel: Model;
  onOpenSettings: () => void;
}): JSX.Element {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [activeModelId, setActiveModelId] = useState<string>(defaultModel.id);
  // Bumped when the user clicks "New chat" so ChatPanel remounts even if the
  // sidebar entry hasn't been created yet.
  const [chatKey, setChatKey] = useState(0);
  // C4 — sidebar search + batch select. searchQuery is passed to the sidecar
  // verbatim (debounced via effect). batchMode lets the user multi-select for
  // bulk delete.
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedQuery, setDebouncedQuery] = useState<string>('');
  const [batchMode, setBatchMode] = useState<boolean>(false);
  const [selectedConvIds, setSelectedConvIds] = useState<Set<string>>(new Set());
  // B1 — Command palette
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState<boolean>(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const refreshConversations = useCallback(async () => {
    try {
      const { conversations: list } = await api.listConversations(
        debouncedQuery || undefined,
      );
      setConversations(list);
    } catch {
      /* non-fatal */
    }
  }, [debouncedQuery]);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  // B1 — Global Cmd+K / Ctrl+K listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setCmdPaletteOpen(true);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const onNewChat = (): void => {
    setActiveConvId(null);
    setChatKey((n) => n + 1);
  };

  const onSelectConv = (id: string): void => {
    if (id === activeConvId) return;
    setActiveConvId(id);
    setChatKey((n) => n + 1);
  };

  const onDeleteConv = async (id: string): Promise<void> => {
    if (!window.confirm('确认删除该对话？此操作不可恢复。')) return;
    try {
      await api.deleteConversation(id);
      if (activeConvId === id) {
        setActiveConvId(null);
        setChatKey((n) => n + 1);
      }
      await refreshConversations();
    } catch (e) {
      window.alert(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onRenameConv = async (id: string, current: string | null): Promise<void> => {
    const next = window.prompt('重命名对话', current ?? '');
    if (next === null) return;
    const title = next.trim();
    if (!title) return;
    try {
      await api.renameConversation(id, title);
      await refreshConversations();
    } catch (e) {
      window.alert(`重命名失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // C4 — pin / tag / batch handlers.
  const onTogglePin = async (id: string, next: boolean): Promise<void> => {
    try {
      await api.setConversationPinned(id, next);
      await refreshConversations();
    } catch (e) {
      window.alert(`设置置顶失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const onSetTags = async (id: string, tags: string[]): Promise<void> => {
    try {
      await api.setConversationTags(id, tags);
      await refreshConversations();
    } catch (e) {
      window.alert(`保存标签失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const onToggleSelected = (id: string): void => {
    setSelectedConvIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const onEnterBatch = (): void => {
    setBatchMode(true);
    setSelectedConvIds(new Set());
  };
  const onExitBatch = (): void => {
    setBatchMode(false);
    setSelectedConvIds(new Set());
  };
  const onBatchDelete = async (): Promise<void> => {
    if (selectedConvIds.size === 0) return;
    if (
      !window.confirm(
        `确认批量删除 ${selectedConvIds.size} 条对话？此操作不可恢复。`,
      )
    )
      return;
    let activeWasDeleted = false;
    for (const id of selectedConvIds) {
      try {
        await api.deleteConversation(id);
        if (id === activeConvId) activeWasDeleted = true;
      } catch (e) {
        window.alert(
          `删除失败 (${id})：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (activeWasDeleted) {
      setActiveConvId(null);
      setChatKey((n) => n + 1);
    }
    setSelectedConvIds(new Set());
    setBatchMode(false);
    await refreshConversations();
  };

  const activeModel = useMemo(
    () => chatModels.find((m) => m.id === activeModelId) ?? defaultModel,
    [chatModels, activeModelId, defaultModel],
  );

  return (
    <div className="workspace">
      <Sidebar
        conversations={conversations}
        activeId={activeConvId}
        onNew={onNewChat}
        onSelect={onSelectConv}
        onDelete={(id) => void onDeleteConv(id)}
        onRename={(id, t) => void onRenameConv(id, t)}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onTogglePin={(id, v) => void onTogglePin(id, v)}
        onSetTags={(id, tags) => void onSetTags(id, tags)}
        batchMode={batchMode}
        selectedIds={selectedConvIds}
        onToggleSelected={onToggleSelected}
        onEnterBatch={onEnterBatch}
        onExitBatch={onExitBatch}
        onBatchDelete={() => void onBatchDelete()}
      />
      <main className="workspace-main">
        <ChatPanel
          key={chatKey}
          endpoint={endpoint}
          chatModels={chatModels}
          model={activeModel}
          onModelChange={setActiveModelId}
          conversationId={activeConvId}
          onConversationCreated={(id) => {
            setActiveConvId(id);
            void refreshConversations();
          }}
          onConversationUpdated={() => void refreshConversations()}
          onOpenSettings={onOpenSettings}
          onLoopbackToConversation={(id) => {
            setActiveConvId(id);
            void refreshConversations();
          }}
        />
      </main>
      <CommandPalette
        isOpen={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        onSelectConv={onSelectConv}
        onSelectModel={setActiveModelId}
        onNavigate={(path) => {
          if (path === '/settings') onOpenSettings();
          // TODO: other navigation paths
        }}
        conversations={conversations.map(c => ({ id: c.id, title: c.title, pinned: c.pinned, tags: c.tags }))}
        models={chatModels}
      />
    </div>
  );
}

function bucketLabel(updated: number, now: number): string {
  const day = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startMs = startOfToday.getTime();
  if (updated >= startMs) return '今天';
  if (updated >= startMs - day) return '昨天';
  if (updated >= startMs - 7 * day) return '本周';
  if (updated >= startMs - 30 * day) return '本月';
  return '更早';
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

interface ConvRowCallbacks {
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, current: string | null) => void;
  onTogglePin: (id: string, next: boolean) => void;
  onSetTags: (id: string, tags: string[]) => void;
  batchMode: boolean;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  // tag editor state lifted into Sidebar so only one row edits at a time.
  editingTagsForId: string | null;
  setEditingTagsForId: (id: string | null) => void;
  tagDraft: string;
  setTagDraft: (s: string) => void;
}

function renderConvRow(
  c: ConversationSummary,
  active: boolean,
  cb: ConvRowCallbacks,
): JSX.Element {
  const tags = parseTags(c.tags);
  const isEditingTags = cb.editingTagsForId === c.id;
  const checked = cb.selectedIds.has(c.id);
  return (
    <li
      key={c.id}
      className={`conv-item${active ? ' active' : ''}${c.pinned ? ' pinned' : ''}`}
      data-testid="conv-item"
      data-conv-id={c.id}
      data-conv-pinned={c.pinned ? 'true' : 'false'}
      aria-current={active ? 'true' : undefined}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.conv-actions, input, .conv-tags')) return;
        if (cb.batchMode) cb.onToggleSelected(c.id);
        else cb.onSelect(c.id);
      }}
    >
      {cb.batchMode && (
        <input
          type="checkbox"
          className="conv-select"
          data-testid="conv-select"
          checked={checked}
          onChange={() => cb.onToggleSelected(c.id)}
          aria-label="选择对话"
        />
      )}
      <span
        className="conv-title"
        title={c.title ?? '未命名对话'}
      >
        {c.pinned ? '📌 ' : ''}
        {c.title ?? '未命名对话'}
      </span>
      <span className="conv-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => cb.onTogglePin(c.id, !c.pinned)}
          aria-label={c.pinned ? 'unpin' : 'pin'}
          data-testid="conv-pin"
          title={c.pinned ? '取消置顶' : '置顶'}
        >
          {c.pinned ? '★' : '☆'}
        </button>
        <button
          type="button"
          onClick={() => {
            cb.setEditingTagsForId(c.id);
            cb.setTagDraft(tags.join(', '));
          }}
          aria-label="tags"
          data-testid="conv-tag-edit"
          title="编辑标签"
        >
          🏷
        </button>
        <button
          type="button"
          onClick={() => cb.onRename(c.id, c.title)}
          aria-label="rename"
          data-testid="conv-rename"
        >
          ✎
        </button>
        <button
          type="button"
          onClick={() => cb.onDelete(c.id)}
          aria-label="delete"
          data-testid="conv-delete"
        >
          🗑
        </button>
      </span>
      {(tags.length > 0 || isEditingTags) && (
        <div className="conv-tags" data-testid="conv-tags">
          {!isEditingTags &&
            tags.map((t) => (
              <span key={t} className="tag-chip" data-testid="conv-tag-chip">
                {t}
              </span>
            ))}
          {isEditingTags && (
            <span className="tag-editor">
              <input
                type="text"
                value={cb.tagDraft}
                onChange={(e) => cb.setTagDraft(e.target.value)}
                placeholder="逗号分隔，最多 3 个"
                data-testid="conv-tag-input"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const next = cb.tagDraft
                      .split(',')
                      .map((s) => s.trim())
                      .filter((s) => s.length > 0)
                      .slice(0, 3);
                    cb.onSetTags(c.id, next);
                    cb.setEditingTagsForId(null);
                  } else if (e.key === 'Escape') {
                    cb.setEditingTagsForId(null);
                  }
                }}
              />
              <button
                type="button"
                data-testid="conv-tag-save"
                onClick={() => {
                  const next = cb.tagDraft
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0)
                    .slice(0, 3);
                  cb.onSetTags(c.id, next);
                  cb.setEditingTagsForId(null);
                }}
              >
                保存
              </button>
              <button
                type="button"
                data-testid="conv-tag-cancel"
                onClick={() => cb.setEditingTagsForId(null)}
              >
                取消
              </button>
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function renderGroupedConversations(
  conversations: ConversationSummary[],
  activeId: string | null,
  cb: ConvRowCallbacks,
): JSX.Element[] {
  const out: JSX.Element[] = [];
  const pinned = conversations.filter((c) => c.pinned);
  const rest = conversations.filter((c) => !c.pinned);
  if (pinned.length > 0) {
    out.push(
      <li key="g:pinned" className="conv-group-head" aria-hidden="true">
        📌 已置顶
      </li>,
    );
    for (const c of pinned) out.push(renderConvRow(c, c.id === activeId, cb));
  }
  const now = Date.now();
  let curLabel: string | null = null;
  for (const c of rest) {
    const label = bucketLabel(c.updated_at, now);
    if (label !== curLabel) {
      curLabel = label;
      out.push(
        <li key={`g:${label}`} className="conv-group-head" aria-hidden="true">
          {label}
        </li>,
      );
    }
    out.push(renderConvRow(c, c.id === activeId, cb));
  }
  return out;
}

function Sidebar({
  conversations,
  activeId,
  onNew,
  onSelect,
  onDelete,
  onRename,
  searchQuery,
  onSearchQueryChange,
  onTogglePin,
  onSetTags,
  batchMode,
  selectedIds,
  onToggleSelected,
  onEnterBatch,
  onExitBatch,
  onBatchDelete,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, current: string | null) => void;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  onTogglePin: (id: string, next: boolean) => void;
  onSetTags: (id: string, tags: string[]) => void;
  batchMode: boolean;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onEnterBatch: () => void;
  onExitBatch: () => void;
  onBatchDelete: () => void;
}): JSX.Element {
  const [editingTagsForId, setEditingTagsForId] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState<string>('');
  const cb: ConvRowCallbacks = {
    onSelect,
    onDelete,
    onRename,
    onTogglePin,
    onSetTags,
    batchMode,
    selectedIds,
    onToggleSelected,
    editingTagsForId,
    setEditingTagsForId,
    tagDraft,
    setTagDraft,
  };
  return (
    <aside className="sidebar" data-testid="sidebar">
      <button type="button" className="new-chat" onClick={onNew} data-testid="sidebar-new">
        🆕 新对话
      </button>
      <div className="sidebar-search">
        <input
          type="search"
          className="conv-search"
          data-testid="conv-search"
          placeholder="搜索对话标题或内容…"
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
        />
      </div>
      <div className="sidebar-batch-bar">
        {batchMode ? (
          <>
            <span className="batch-count" data-testid="batch-count">
              已选 {selectedIds.size}
            </span>
            <button
              type="button"
              data-testid="batch-delete"
              onClick={onBatchDelete}
              disabled={selectedIds.size === 0}
            >
              批量删除
            </button>
            <button type="button" data-testid="batch-cancel" onClick={onExitBatch}>
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="batch-enter"
            className="batch-enter"
            onClick={onEnterBatch}
            disabled={conversations.length === 0}
            title="批量选择"
          >
            ☑ 批量
          </button>
        )}
      </div>
      <ul className="conv-list" data-testid="conv-list">
        {conversations.length === 0 ? (
          <li className="conv-empty">
            {searchQuery ? '没有匹配的对话' : '暂无对话'}
          </li>
        ) : (
          renderGroupedConversations(conversations, activeId, cb)
        )}
      </ul>
    </aside>
  );
}

function ChatPanel({
  endpoint,
  chatModels,
  model,
  onModelChange,
  conversationId,
  onConversationCreated,
  onConversationUpdated,
  onOpenSettings,
  onLoopbackToConversation,
}: {
  endpoint: { url: string; bearer: string };
  chatModels: Model[];
  model: Model;
  onModelChange: (id: string) => void;
  conversationId: string | null;
  onConversationCreated: (id: string) => void;
  onConversationUpdated: () => void;
  onOpenSettings: () => void;
  /** A4 — RoundtablePanel SummaryCard "↪ 带回原对话" callback. */
  onLoopbackToConversation: (id: string) => void;
}): JSX.Element {
  const conversationIdRef = useRef<string | null>(null);
  // Tracks which conversation_id we've already lifted into React state via
  // onConversationCreated. Distinct from conversationIdRef because the tee
  // reader updates conversationIdRef mid-stream (for auto-fallback's persist
  // call) but must NOT trigger a state lift during streaming — that would
  // re-render and break useChat's in-flight failure-decision flow (M2 §1.4).
  // onFinish then uses this ref to decide whether the parent still needs to
  // be notified.
  const announcedConvIdRef = useRef<string | null>(null);
  const [costByMsg, setCostByMsg] = useState<
    Record<string, { input_tokens: number; output_tokens: number; actual_usd: number | null }>
  >({});
  // M2.5 §F-CR — when the LLM calls the `image_generate` tool inside a chat
  // turn, the sidecar streams a `tool_image_result` annotation we use to
  // render the produced image inline beneath the assistant bubble.
  const [imagesByMsg, setImagesByMsg] = useState<
    Record<
      string,
      Array<{
        file_id: string;
        content_type: string;
        width: number;
        height: number;
        prompt?: string;
        data_b64?: string;
      }>
    >
  >({});
  const [realtime, setRealtime] = useState<{
    current_conversation_usd: number;
    current_conversation_calls: number;
    today_usd: number;
    month_usd: number;
  } | null>(null);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dropping, setDropping] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  // M2.1 — captures `failure_decision` annotations keyed by assistant
  // message id. We render a card below that message; we also use it to
  // drive the optional auto-fallback single-hop retry.
  const [failureByMsg, setFailureByMsg] = useState<Record<string, FailureDecision>>({});
  // Conversations that have already consumed their single auto-fallback
  // attempt — a second consecutive failure goes to the card (M2 §1.4).
  const autoFallbackUsedConvs = useRef<Set<string>>(new Set());
  // Track auto-fallback decisions we've already acted on to avoid re-firing
  // on every render. Keyed by message_id.
  const autoFallbackTriggeredMsgs = useRef<Set<string>>(new Set());
  // M2.1 — assistant message id of the most recent failure. useChat drops
  // the in-flight message on error (no `0:` text arrived), so we render a
  // synthetic placeholder + decision card keyed off this id.
  const [lastFailureMsgId, setLastFailureMsgId] = useState<string | null>(null);

  // M2.2 — L3 stream cost badge: live-tracked input/output token counts plus
  // an "expanded" toggle for the details panel. We update during streaming
  // by polling messages[last].content via setInterval throttled to 200ms.
  const [streamBadge, setStreamBadge] = useState<{
    inputTokens: number;
    outputTokens: number;
    estimateUsd: number;
  } | null>(null);
  const [streamBadgeOpen, setStreamBadgeOpen] = useState(false);

  // M2.2 — L4 pre-call confirmation memories. Loaded once per conversation
  // change. Keys: cost_confirm_threshold_usd, cost_confirm_image_always,
  // cost_confirm_disabled_models (json array), cost_confirm_disabled_conversations.
  const [confirmPrefs, setConfirmPrefs] = useState<{
    threshold: number;
    imageAlways: boolean;
    disabledModels: string[];
    disabledConvs: string[];
  }>({ threshold: 0.20, imageAlways: true, disabledModels: [], disabledConvs: [] });
  // Pending confirm modal state — when set, blocks submit until user resolves.
  const [pendingConfirm, setPendingConfirm] = useState<{
    estimate: number;
    reason: 'threshold' | 'image';
    model?: Model;
    onContinue: () => void;
    onCheaper: () => void;
    onCancel: () => void;
  } | null>(null);

  // M2.2 — session cost panel (right drawer). null = closed.
  const [costPanelScope, setCostPanelScope] = useState<'session' | 'today' | 'month' | null>(null);

  // M2.4 — image picker (capability_route trigger). When set, modal is open.
  // 'memory' is the chosen scope: once / session / global.
  const [imagePicker, setImagePicker] = useState<{
    prompt: string;
    user_message_id: string;
    selectedModelId: string | null;
    memory: 'once' | 'session' | 'global';
  } | null>(null);
  const [imagePickerError, setImagePickerError] = useState<string | null>(null);
  const [imagePickerSubmitting, setImagePickerSubmitting] = useState(false);
  const [imageModels, setImageModels] = useState<Model[]>([]);
  // M3.A.4 — roundtable launch dialog state. Open by clicking the "🔍 圆桌"
  // button next to send. After confirm, parent receives the roundtable id;
  // M3.A.5 will use it to swap chat-bubble view for the roundtable panel.
  const [roundtableDialog, setRoundtableDialog] = useState<{
    initialTopic: string;
  } | null>(null);
  const [activeRoundtableId, setActiveRoundtableId] = useState<string | null>(
    null,
  );
  // Wired up to openImagePicker after it's declared. Lets the failureFetch
  // tee reader fire the picker without needing the callback in scope.
  const capabilityRouteRef = useRef<
    ((route: {
      prompt: string;
      user_message_id: string;
      conversation_id: string | null;
    }) => Promise<void>) | null
  >(null);

  // M2.1 — custom fetch that tees the chat response stream so we can capture
  // the `8:[{type:"failure_decision",...}]` annotation reliably even when
  // useChat discards the in-flight assistant message on error.
  const failureFetch = useCallback<typeof fetch>(async (input, init) => {
    // Strip role='system' from outgoing /v1/chat payload — those are
    // renderer-side notes (e.g. auto-fallback notice) that should be
    // displayed in the timeline but NOT sent to the LLM (M2 §1.4).
    let nextInit = init;
    if (init && typeof init.body === 'string') {
      try {
        const parsed = JSON.parse(init.body) as { messages?: Array<{ role: string }> };
        if (Array.isArray(parsed.messages) && parsed.messages.some((m) => m.role === 'system')) {
          parsed.messages = parsed.messages.filter((m) => m.role !== 'system');
          nextInit = { ...init, body: JSON.stringify(parsed) };
        }
      } catch {
        // not JSON — leave alone
      }
    }
    const res = await fetch(input as RequestInfo, nextInit);
    if (!res.ok || !res.body) return res;
    // ReadableStream.tee() is browser-native; in jsdom-style envs it can be
    // missing. Fall through gracefully so chat keeps working — failure card
    // capture only ever runs in real browsers (E2E + production).
    if (typeof (res.body as ReadableStream).tee !== 'function') return res;
    const [a, b] = res.body.tee();
    void (async () => {
      const reader = b.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let pendingMsgId: string | null = null;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.startsWith('8:')) continue;
            try {
              const arr = JSON.parse(line.slice(2));
              if (!Array.isArray(arr)) continue;
              for (const ann of arr) {
                if (ann?.type === 'meta' && typeof ann.message_id === 'string') {
                  pendingMsgId = ann.message_id;
                }
                if (
                  ann?.type === 'meta' &&
                  typeof ann.conversation_id === 'string' &&
                  conversationIdRef.current !== ann.conversation_id
                ) {
                  // The forced-error path may finish before useChat's onFinish
                  // captures the conversation_id annotation, leaving the auto-
                  // fallback effect without a target convId for persistence.
                  // Mirror to the ref only — invoking onConversationCreated
                  // here would re-render mid-stream and break the
                  // failure-decision card flow (M2 §1.4).
                  conversationIdRef.current = ann.conversation_id;
                }
                if (ann?.type === 'failure_decision' && pendingMsgId) {
                  const decision: FailureDecision = {
                    classification: ann.classification as FailureClassification,
                    current_model_id: (ann.current_model_id as string | null) ?? null,
                    recommended_model_id: (ann.recommended_model_id as string | null) ?? null,
                    auto_fallback_enabled: ann.auto_fallback_enabled === true,
                  };
                  const id = pendingMsgId;
                  setFailureByMsg((prev) => (prev[id] ? prev : { ...prev, [id]: decision }));
                  setLastFailureMsgId(id);
                }
                // M2.4 — image-intent fast path. The sidecar emits NO text
                // (no `0:` frame) so useChat's onFinish handler may never
                // see annotations. The tee'd reader is the reliable channel.
                if (
                  ann?.type === 'capability_route' &&
                  ann.capability === 'image' &&
                  typeof ann.prompt === 'string' &&
                  typeof ann.user_message_id === 'string'
                ) {
                  const route = {
                    prompt: ann.prompt as string,
                    user_message_id: ann.user_message_id as string,
                    conversation_id:
                      typeof ann.conversation_id === 'string'
                        ? (ann.conversation_id as string)
                        : null,
                  };
                  // Defer to a microtask so the parent ChatView state setters
                  // see the most recent conversationIdRef.
                  queueMicrotask(() => void capabilityRouteRef.current?.(route));
                }
              }
            } catch {
              /* ignore parse errors */
            }
          }
        }
      } catch {
        /* stream cancelled */
      }
    })();
    return new Response(a, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }, []);

  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const {
    messages,
    input,
    setInput,
    handleInputChange,
    handleSubmit,
    isLoading,
    error,
    stop,
    setMessages,
    reload: regenerate,
    append,
  } = useChat({
    api: `${endpoint.url}/v1/chat`,
    streamProtocol: 'data',
    fetch: failureFetch,
    headers: { Authorization: `Bearer ${endpoint.bearer}` },
    body: { model_id: model.id, conversation_id: conversationId ?? undefined },
    onError: (e) => console.error('[useChat] onError:', e),
    onFinish: (msg, opts) => {
      // Vercel AI SDK attaches per-message annotations on msg.annotations;
      // older code paths used opts.annotations. Read both for safety
      // (M1 §1.2 — conversation_id propagation).
      const annotations =
        ((opts as { annotations?: unknown[] })?.annotations as unknown[])
        ?? ((msg as { annotations?: unknown[] })?.annotations as unknown[])
        ?? [];
      for (const a of annotations as Array<Record<string, unknown>>) {
        if (a?.type === 'meta' && typeof a.conversation_id === 'string') {
          if (conversationIdRef.current !== a.conversation_id) {
            conversationIdRef.current = a.conversation_id;
          }
          if (announcedConvIdRef.current !== a.conversation_id) {
            announcedConvIdRef.current = a.conversation_id;
            onConversationCreated(a.conversation_id);
          }
        }
        if (a && a.type === 'cost' && typeof a.message_id === 'string') {
          setCostByMsg((prev) => ({
            ...prev,
            [a.message_id as string]: {
              input_tokens: Number(a.input_tokens ?? 0),
              output_tokens: Number(a.output_tokens ?? 0),
              actual_usd:
                typeof a.actual_usd === 'number' ? (a.actual_usd as number) : null,
            },
          }));
        }
        // M2.5 §F-CR — LLM-tool image result; render inline under this msg.
        if (
          a?.type === 'tool_image_result' &&
          typeof a.file_id === 'string' &&
          typeof a.content_type === 'string'
        ) {
          const entry = {
            file_id: a.file_id as string,
            content_type: a.content_type as string,
            width: Number(a.width ?? 0),
            height: Number(a.height ?? 0),
            prompt: typeof a.prompt === 'string' ? (a.prompt as string) : undefined,
            data_b64:
              typeof a.data_b64 === 'string' ? (a.data_b64 as string) : undefined,
          };
          setImagesByMsg((prev) => {
            const list = prev[msg.id] ?? [];
            if (list.some((it) => it.file_id === entry.file_id)) return prev;
            return { ...prev, [msg.id]: [...list, entry] };
          });
        }
        // M2.4 — image-intent fast path. Sidecar emitted only meta+capability_route.
        // We open the picker; user-message row is already persisted server-side.
        if (
          a?.type === 'capability_route' &&
          a.capability === 'image' &&
          typeof a.prompt === 'string' &&
          typeof a.user_message_id === 'string'
        ) {
          void openImagePicker({
            prompt: a.prompt as string,
            user_message_id: a.user_message_id as string,
          });
        }
      }
      void refreshRealtime();
      window.setTimeout(() => void refreshRealtime(), 250);
      window.setTimeout(() => void refreshRealtime(), 1000);
      // Notify the sidebar so newly-created or renamed conversations show up.
      onConversationUpdated();
    },
  });

  useLayoutEffect(() => {
    const ta = composerRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [input]);

  // M2.4 — image picker & memory-tier resolution.
  // Lookup order: session > global > prompt user.
  // Forward ref to submitImagePicker so openImagePicker can auto-submit when
  // session memory is set (spec §7 step 7).
  const submitImagePickerRef = useRef<(() => void) | null>(null);

  const openImagePicker = useCallback(
    async (route: {
      prompt: string;
      user_message_id: string;
      conversation_id?: string | null;
    }) => {
      // M2.4 — fast-path emits the new conversation_id on the route annotation
      // because no `0:` text frames are streamed so onFinish never updates the
      // ref. Adopt it here so submitImagePicker can call invokeTool correctly.
      if (route.conversation_id && conversationIdRef.current !== route.conversation_id) {
        conversationIdRef.current = route.conversation_id;
      }
      if (route.conversation_id && announcedConvIdRef.current !== route.conversation_id) {
        announcedConvIdRef.current = route.conversation_id;
        onConversationCreated(route.conversation_id);
      }
      setImagePickerError(null);
      // 1. Load all image-capable enabled models (filtered + price-sorted).
      let imgModels: Model[] = [];
      try {
        const res = await api.listModels();
        imgModels = res.models
          .filter((m) => m.capability === 'image' && m.enabled)
          .sort(
            (a, b) =>
              (a.price_per_call ?? 0) - (b.price_per_call ?? 0) ||
              a.fallback_order - b.fallback_order,
          );
      } catch (e) {
        console.warn('[image picker] listModels failed', e);
      }
      setImageModels(imgModels);
      if (imgModels.length === 0) {
        setImagePickerError(
          '没有可用的图像模型。请到「设置 → 模型」启用一个 image 模型。',
        );
        setImagePicker({
          prompt: route.prompt,
          user_message_id: route.user_message_id,
          selectedModelId: null,
          memory: 'once',
        });
        return;
      }
      // 2. session > global memory (M2 §2.3 three-tier).
      const conv = conversationIdRef.current;
      let preferred: string | null = null;
      let sessionHit = false;
      try {
        const session = await api.getMemoryEffective('image_model', conv);
        if (session.data.value) {
          preferred = session.data.value;
          sessionHit = true;
        }
        if (!preferred) {
          const global = await api.getMemoryEffective('image_model_default', null);
          if (global.data.value) preferred = global.data.value;
        }
      } catch {
        /* memory read failures are non-fatal */
      }
      const pick =
        (preferred && imgModels.find((m) => m.id === preferred)?.id) ??
        imgModels[0].id;
      // Spec §7 step 7: when session memory is set, the picker is skipped and
      // we proceed directly through the cost-confirm gate. The picker is only
      // pre-mounted (memory='once', no submitting state) so submitImagePicker
      // has the prompt + selection to act on, then immediately fired.
      setImagePicker({
        prompt: route.prompt,
        user_message_id: route.user_message_id,
        selectedModelId: pick,
        memory: 'once',
      });
      if (sessionHit && imgModels.find((m) => m.id === pick)) {
        // Defer to next tick so React commits imagePicker before submit reads it.
        window.setTimeout(() => {
          submitImagePickerRef.current?.();
        }, 0);
      }
    },
    [onConversationCreated],
  );

  // Wire ref so the failureFetch tee reader (declared earlier) can fire it.
  useEffect(() => {
    capabilityRouteRef.current = openImagePicker;
  }, [openImagePicker]);

  // Fetch image data for messages that have image_attachments and populate imagesByMsg.
  // Used after history load and after direct tool invocations (image picker flow).
  const loadImagesForMessages = useCallback(async (
    messages: Array<{ id: string; role: string; image_attachments?: Array<{ file_id?: string; mime?: string; width?: number; height?: number }> }>,
  ) => {
    const assistantMsgsWithImages = messages.filter(
      (m) => m.role === 'assistant' && m.image_attachments && m.image_attachments.length > 0,
    );
    await Promise.all(
      assistantMsgsWithImages.map(async (m) => {
        const imgs = (m.image_attachments ?? []).filter((a) => a.file_id);
        await Promise.all(
          imgs.map(async (a) => {
            try {
              const fileData = await api.getFileData(a.file_id!);
              setImagesByMsg((prev) => {
                const list = prev[m.id] ?? [];
                if (list.some((it) => it.file_id === a.file_id)) return prev;
                return {
                  ...prev,
                  [m.id]: [
                    ...list,
                    {
                      file_id: a.file_id!,
                      content_type: fileData.content_type ?? a.mime ?? 'image/png',
                      width: a.width ?? 0,
                      height: a.height ?? 0,
                      data_b64: fileData.data_b64,
                    },
                  ],
                };
              });
            } catch (e) {
              console.warn('[images] failed to load file', a.file_id, e);
            }
          }),
        );
      }),
    );
  }, []);

  const runImageGenerate = useCallback(async (
    prompt: string,
    modelId: string,
    sourceMessageId: string | null,
  ) => {
    setImagePickerSubmitting(true);
    setImagePickerError(null);
    try {
      const res = await api.invokeTool(
        'builtin.image_generate',
        { prompt, model_id: modelId },
        {
          conversation_id: conversationIdRef.current,
          source_message_id: sourceMessageId,
        },
      );
      if (!res.data.ok) {
        setImagePickerError(
          res.data.error?.message ?? '图像生成失败，请稍后重试。',
        );
        setImagePickerSubmitting(false);
        return;
      }
      // Reload conversation messages so the assistant message inserted by
      // image_generate.execute appears in the UI.
      const conv = conversationIdRef.current;
      if (conv) {
        const r = await api.getConversationMessages(conv);
        const mapped: AiMessage[] = r.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content ?? '',
          }));
        setMessages(mapped);
        // Populate imagesByMsg for any assistant messages that have image attachments.
        await loadImagesForMessages(r.messages);
      }
      void refreshRealtime();
      setImagePicker(null);
    } catch (e) {
      setImagePickerError((e as Error).message ?? '请求失败');
    } finally {
      setImagePickerSubmitting(false);
    }
  }, [setMessages]); // refreshRealtime is hoisted via useCallback below.

  const submitImagePicker = useCallback(async () => {
    if (!imagePicker || !imagePicker.selectedModelId) return;
    const modelId = imagePicker.selectedModelId;
    const prompt = imagePicker.prompt;
    const sourceMessageId = imagePicker.user_message_id;
    // Persist memory (M2 §2.3 three-tier).
    if (imagePicker.memory === 'session' && conversationIdRef.current) {
      try {
        await api.putMemory(
          'session',
          'image_model',
          modelId,
          conversationIdRef.current,
        );
      } catch { /* ignore */ }
    } else if (imagePicker.memory === 'global') {
      try {
        await api.putMemory('global', 'image_model_default', modelId);
      } catch { /* ignore */ }
    }
    // M2 §3.2 + §7 step 6/7 — high-cost confirm gate for image generation.
    // disabled_models hit OR disabled_conversations hit OR image_always=false → skip.
    const skip = confirmPrefs.disabledModels.includes(modelId)
      || (conversationIdRef.current
        ? confirmPrefs.disabledConvs.includes(conversationIdRef.current)
        : false);
    if (!skip && confirmPrefs.imageAlways) {
      const im = imageModels.find((m) => m.id === modelId);
      const est = im?.price_per_call ?? 0;
      if (im) {
        // Close the picker so the confirm dialog renders on top + isolates UX.
        // Captured prompt/modelId/sourceMessageId in closure above.
        setImagePicker(null);
        setPendingConfirm({
          estimate: est,
          reason: 'image',
          model: im,
          onContinue: () => {
            setPendingConfirm(null);
            void runImageGenerate(prompt, modelId, sourceMessageId);
          },
          onCheaper: () => { setPendingConfirm(null); },
          onCancel: () => { setPendingConfirm(null); },
        });
        return;
      }
    }
    await runImageGenerate(prompt, modelId, sourceMessageId);
  }, [imagePicker, confirmPrefs, imageModels, runImageGenerate]);

  // Wire the forward-ref so openImagePicker can auto-fire submit when the
  // session-memory shortcut applies (spec §7 step 7).
  useEffect(() => {
    submitImagePickerRef.current = () => {
      void submitImagePicker();
    };
  }, [submitImagePicker]);

  const escapeImageIntent = useCallback(async () => {
    // 30 minutes session-scoped opt-out (M2 §2.2 step 4).
    if (conversationIdRef.current) {
      try {
        await api.putMemory(
          'session',
          'intent_route_disabled_until',
          String(Date.now() + 30 * 60 * 1000),
          conversationIdRef.current,
        );
      } catch (e) {
        console.warn('[image escape] memory write failed', e);
      }
    }
    setImagePicker(null);
  }, []);


  // Skip the load when this conversationId was just minted by our own
  // onFinish handler — otherwise the fresh in-memory streamed assistant
  // message would be overwritten by a (possibly empty / racy) DB read.
  useEffect(() => {
    if (!conversationId) return;
    if (conversationIdRef.current === conversationId) {
      announcedConvIdRef.current = conversationId;
      return;
    }
    conversationIdRef.current = conversationId;
    announcedConvIdRef.current = conversationId;
    let cancelled = false;
    setHistoryLoading(true);
    api
      .getConversationMessages(conversationId)
      .then((res) => {
        if (cancelled) return;
        const mapped: AiMessage[] = res.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
          .map((m) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant' | 'system',
            content: m.content ?? '',
          }));
        setMessages(mapped);
        // Also load image data for messages with image attachments.
        void loadImagesForMessages(res.messages);
      })
      .catch((e) => console.warn('[history] load failed:', e))
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, setMessages, loadImagesForMessages]);

  // M3.A.5 — when conversation switches, also detect whether this
  // conversation has an associated roundtable and restore the panel.
  useEffect(() => {
    if (!conversationId) {
      setActiveRoundtableId(null);
      return;
    }
    let cancelled = false;
    api
      .getActiveRoundtableForConversation(conversationId)
      .then((res) => {
        if (cancelled) return;
        setActiveRoundtableId(res.roundtable_id);
      })
      .catch((e) => console.warn('[roundtable] detect failed:', e));
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // M2.1 — when the user switches conversations, clear per-message
  // bookkeeping and the orphan-card binding so we don't accidentally render
  // an old failure card under the new conversation. We intentionally keep
  // `autoFallbackUsedConvs` populated: spec §1.4 line 103 says the
  // single-hop guard is **per conversation** and must survive switching
  // away and back, so a previously-consumed hop stays consumed.
  useEffect(() => {
    autoFallbackTriggeredMsgs.current.clear();
    setLastFailureMsgId(null);
  }, [conversationId]);

  // M2.2 — load cost-confirm prefs (effective scope) on mount + conv change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, img, dm, dc] = await Promise.all([
          api.getMemoryEffective('cost_confirm_threshold_usd', conversationId),
          api.getMemoryEffective('cost_confirm_image_always', conversationId),
          api.getMemoryEffective('cost_confirm_disabled_models', conversationId),
          api.getMemoryEffective('cost_confirm_disabled_conversations', conversationId),
        ]);
        if (cancelled) return;
        const num = (v: string | null, d: number) => {
          if (!v) return d;
          const n = parseFloat(v);
          return Number.isFinite(n) ? n : d;
        };
        const arr = (v: string | null): string[] => {
          if (!v) return [];
          try { const j = JSON.parse(v); return Array.isArray(j) ? j.map(String) : []; }
          catch { return []; }
        };
        setConfirmPrefs({
          threshold: num(t.data.value, 0.20),
          imageAlways: img.data.value === 'false' ? false : true,
          disabledModels: arr(dm.data.value),
          disabledConvs: arr(dc.data.value),
        });
      } catch {
        /* keep defaults */
      }
    })();
    return () => { cancelled = true; };
  }, [conversationId]);

  const refreshRealtime = useCallback(async (): Promise<void> => {
    try {
      const res = await api.costsRealtime(conversationIdRef.current);
      setRealtime(res.data);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshRealtime();
    const t = window.setInterval(() => void refreshRealtime(), 15000);
    return () => window.clearInterval(t);
  }, [refreshRealtime]);

  useEffect(() => {
    for (const m of messages) {
      const anns = (m as { annotations?: unknown[] }).annotations;
      if (!Array.isArray(anns)) continue;
      for (const a of anns as Array<Record<string, unknown>>) {
        if (a?.type === 'meta' && typeof a.conversation_id === 'string') {
          // Guard: when the parent prop has already moved on to a different
          // conversation (e.g. user branched / switched), stale streamed
          // messages must NOT re-lift the prior conv id back onto the parent.
          if (conversationId && conversationId !== a.conversation_id) continue;
          if (conversationIdRef.current !== a.conversation_id) {
            conversationIdRef.current = a.conversation_id;
          }
          if (announcedConvIdRef.current !== a.conversation_id) {
            announcedConvIdRef.current = a.conversation_id;
            onConversationCreated(a.conversation_id);
          }
        }
        if (a?.type === 'cost' && typeof a.message_id === 'string') {
          const id = a.message_id as string;
          setCostByMsg((prev) =>
            prev[id]
              ? prev
              : {
                  ...prev,
                  [id]: {
                    input_tokens: Number(a.input_tokens ?? 0),
                    output_tokens: Number(a.output_tokens ?? 0),
                    actual_usd:
                      typeof a.actual_usd === 'number' ? (a.actual_usd as number) : null,
                  },
                },
          );
        }
        // M2.5 §F-CR — capture tool_image_result during streaming so the
        // image lights up before the LLM finishes its closing prose.
        if (
          a?.type === 'tool_image_result' &&
          typeof a.file_id === 'string' &&
          typeof a.content_type === 'string'
        ) {
          const fid = a.file_id as string;
          setImagesByMsg((prev) => {
            const list = prev[m.id] ?? [];
            if (list.some((it) => it.file_id === fid)) return prev;
            return {
              ...prev,
              [m.id]: [
                ...list,
                {
                  file_id: fid,
                  content_type: a.content_type as string,
                  width: Number(a.width ?? 0),
                  height: Number(a.height ?? 0),
                  prompt:
                    typeof a.prompt === 'string' ? (a.prompt as string) : undefined,
                  data_b64:
                    typeof a.data_b64 === 'string'
                      ? (a.data_b64 as string)
                      : undefined,
                },
              ],
            };
          });
        }
        // M2.1 — failure_decision annotation arrives just before the `3:`
        // error frame. We bind it to the assistant message id so the card
        // sticks with the message even after subsequent retries land below.
        if (a?.type === 'failure_decision' && typeof a.classification === 'string') {
          const decision: FailureDecision = {
            classification: a.classification as FailureClassification,
            current_model_id: (a.current_model_id as string | null) ?? null,
            recommended_model_id: (a.recommended_model_id as string | null) ?? null,
            auto_fallback_enabled: a.auto_fallback_enabled === true,
          };
          setFailureByMsg((prev) =>
            prev[m.id] ? prev : { ...prev, [m.id]: decision },
          );
        }
      }
    }
  }, [messages, onConversationCreated]);

  // M2.1 — auto-fallback single-hop. When a fresh failure_decision indicates
  // the user has the toggle ON, the classification is recoverable, and a
  // fallback model exists, we automatically switch and regenerate ONCE per
  // conversation. A second consecutive failure surfaces the card normally.
  useEffect(() => {
    if (isLoading) return;
    if (!lastFailureMsgId) return;
    const decision = failureByMsg[lastFailureMsgId];
    if (!decision) return;
    if (autoFallbackTriggeredMsgs.current.has(lastFailureMsgId)) return;
    if (!decision.auto_fallback_enabled) return;
    if (decision.classification === 'content_filter') return;
    if (!decision.recommended_model_id) return;
    const conv = conversationIdRef.current ?? 'unknown';
    if (autoFallbackUsedConvs.current.has(conv)) return;
    const target = chatModels.find((m) => m.id === decision.recommended_model_id);
    if (!target) return;
    autoFallbackTriggeredMsgs.current.add(lastFailureMsgId);
    autoFallbackUsedConvs.current.add(conv);
    const note = `已自动切换到「${target.display_name}」并重试。`;
    // Inject a system note so the user sees what happened (M2 §1.4).
    setMessages((prev) => [
      ...prev,
      {
        id: `auto-fallback-${lastFailureMsgId}`,
        role: 'system',
        content: note,
      },
    ]);
    // Persist the note so it survives reload (spec 09-m2 §1.4). Best-effort
    // — we don't block the retry on it.
    if (conversationIdRef.current) {
      void api.appendSystemMessage(conversationIdRef.current, note).catch(() => {});
      // Lift the conversation_id to React state so the next regenerate's
      // useChat body carries it (failed streams skip onFinish, so this
      // is the only place that announces convId after a failure path).
      if (announcedConvIdRef.current !== conversationIdRef.current) {
        announcedConvIdRef.current = conversationIdRef.current;
        onConversationCreated(conversationIdRef.current);
      }
    }
    onModelChange(target.id);
    // Defer reload until the new model_id has propagated through useChat's
    // body. One macrotask is enough — useChat captures body on submit.
    window.setTimeout(() => {
      void regenerate();
    }, 50);
  }, [
    failureByMsg,
    lastFailureMsgId,
    isLoading,
    chatModels,
    onModelChange,
    regenerate,
    setMessages,
  ]);

  // M2.2 — L3 stream cost badge: update token estimate during streaming.
  // Throttled to 200ms; resets when streaming stops.
  useEffect(() => {
    if (!isLoading) {
      setStreamBadge(null);
      setStreamBadgeOpen(false);
      return;
    }
    const tick = () => {
      const last = messages[messages.length - 1];
      const partial = last && last.role === 'assistant' ? last.content : '';
      const historyText = messages.slice(0, -1).map((m) => m.content).join('\n');
      const inTok = estimateInputTokens(historyText + '\n' + input);
      const outTok = Math.max(1, Math.round((partial?.length ?? 0) / 4));
      const inUsd = (model.price_input_per_1m ?? 0) * inTok / 1_000_000;
      const outUsd = (model.price_output_per_1m ?? 0) * outTok / 1_000_000;
      const callUsd = model.price_per_call ?? 0;
      setStreamBadge({ inputTokens: inTok, outputTokens: outTok, estimateUsd: inUsd + outUsd + callUsd });
    };
    tick();
    const t = window.setInterval(tick, 200);
    return () => window.clearInterval(t);
  }, [isLoading, messages, input, model.price_input_per_1m, model.price_output_per_1m, model.price_per_call]);

  // M1 §5.1 pre-send estimate: fetch rolling avg output tokens for the active
  // model whenever the model changes, then derive the estimate locally from
  // the input + history. Uses a stale-while-revalidate pattern: we don't show
  // a spinner — we just show "—" until the first response arrives.
  const [avgOutput, setAvgOutput] = useState<{ avg: number; n: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setAvgOutput(null);
    (async () => {
      try {
        const res = await authedFetch(
          `/v1/costs/avg-output?model_id=${encodeURIComponent(model.id)}`,
        );
        if (!res.ok) return;
        const j = (await res.json()) as { ok: boolean; data?: { avg_output_tokens: number; sample_count: number } };
        if (cancelled || !j.ok || !j.data) return;
        setAvgOutput({ avg: j.data.avg_output_tokens, n: j.data.sample_count });
      } catch {
        /* keep null */
      }
    })();
    return () => { cancelled = true; };
  }, [endpoint.url, model.id]);

  const estimate = useMemo(() => {
    const historyText = messages.map((m) => m.content).join('\n');
    const inTok = estimateInputTokens(input + '\n' + historyText);
    return estimateCostUsd({
      inputTokens: inTok,
      avgOutputTokens: avgOutput?.avg ?? 0,
      sampleCount: avgOutput?.n ?? 0,
      priceInputPer1m: model.price_input_per_1m ?? null,
      priceOutputPer1m: model.price_output_per_1m ?? null,
      pricePerCall: model.price_per_call ?? null,
    });
  }, [input, messages, avgOutput, model.price_input_per_1m, model.price_output_per_1m, model.price_per_call]);

  // R4.2 — context-window warning. Surface a banner when the estimated input
  // tokens cross 85% of the model's context_length, with a hard "exceeded"
  // state at 100%. Uses the same crude estimator as the cost bar so the two
  // numbers stay consistent. Skipped when the model has no declared
  // context_length (e.g. the M0 mock provider).
  const contextStatus = useMemo<{
    state: 'ok' | 'warn' | 'exceed';
    used: number;
    limit: number;
    pct: number;
  } | null>(() => {
    const limit = model.context_length;
    if (!limit || limit <= 0) return null;
    const historyText = messages.map((m) => m.content).join('\n');
    let used = estimateInputTokens(input + '\n' + historyText);
    // Include pending text/PDF attachments — they end up inlined into the
    // upstream prompt so they consume the same context budget. Image tokens
    // are model-specific and ignored here. base64 inflates source by 4/3, so
    // decoded length ≈ b64.length * 0.75; estimateInputTokens is ~chars/4.
    for (const p of pending) {
      if (p.kind === 'text' || p.kind === 'pdf') {
        used += Math.round((p.data_b64.length * 0.75) / 4);
      }
    }
    const pct = used / limit;
    if (pct >= 1) return { state: 'exceed', used, limit, pct };
    if (pct >= 0.85) return { state: 'warn', used, limit, pct };
    return { state: 'ok', used, limit, pct };
  }, [input, messages, pending, model.context_length]);

  const tier = priceTier(model.price_input_per_1m);

  // C1 — message-level actions: edit-and-resend + branch.
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<string>('');
  const [editBusy, setEditBusy] = useState(false);
  const [branchBusy, setBranchBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // C2 — stop streaming + continue. wasStoppedRecently is set when the user
  // hits the composer "停止" button so the next assistant render can offer a
  // "续写" button. We reset it on conversation switch and when a new turn
  // starts (so a re-send hides the dangling continue affordance).
  const [wasStoppedRecently, setWasStoppedRecently] = useState(false);
  const [continueBusy, setContinueBusy] = useState(false);
  useEffect(() => {
    setWasStoppedRecently(false);
  }, [conversationId]);
  const onStopClick = useCallback((): void => {
    stop();
    setWasStoppedRecently(true);
  }, [stop]);
  const onContinueClick = useCallback(async (): Promise<void> => {
    if (continueBusy || isLoading) return;
    setContinueBusy(true);
    setWasStoppedRecently(false);
    try {
      await append({
        role: 'user',
        content: '请继续上文，不必重复已写过的内容。',
      });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '续写失败');
    } finally {
      setContinueBusy(false);
    }
  }, [append, continueBusy, isLoading]);

  const submitEdit = useCallback(
    async (messageId: string) => {
      if (!conversationId) return;
      const trimmed = editingDraft.trim();
      if (!trimmed) return;
      setEditBusy(true);
      setActionError(null);
      try {
        const localIdx = messages.findIndex((m) => m.id === messageId);
        if (localIdx < 0) throw new Error('找不到这条消息');
        // Resolve the persisted DB id by position — useChat uses internal
        // uuids for messages it streamed, which do not match the sidecar's
        // ids. The history endpoint orders by created_at so position is
        // stable across both views.
        const history = await api.getConversationMessages(conversationId);
        const dbMsg = history.messages[localIdx];
        if (!dbMsg) throw new Error('历史记录已变更，请刷新后重试');
        await api.editUserMessage(conversationId, dbMsg.id, trimmed);
        setMessages((prev) => {
          const next = prev.slice(0, localIdx + 1);
          next[localIdx] = { ...next[localIdx]!, content: trimmed };
          return next;
        });
        setEditingMsgId(null);
        setEditingDraft('');
        // Trigger regeneration so a fresh assistant message follows.
        // skip_user_persist tells the chat route NOT to insert another
        // user-message row — we already updated the existing one.
        window.setTimeout(
          () => void regenerate({ body: { skip_user_persist: true } }),
          50,
        );
      } catch (e) {
        setActionError(e instanceof Error ? e.message : '编辑失败');
      } finally {
        setEditBusy(false);
      }
    },
    [conversationId, editingDraft, messages, regenerate, setMessages],
  );

  const branchFromMessage = useCallback(
    async (messageId: string) => {
      if (!conversationId) return;
      setBranchBusy(messageId);
      setActionError(null);
      try {
        const localIdx = messages.findIndex((m) => m.id === messageId);
        if (localIdx < 0) throw new Error('找不到这条消息');
        const history = await api.getConversationMessages(conversationId);
        const dbMsg = history.messages[localIdx];
        if (!dbMsg) throw new Error('历史记录已变更，请刷新后重试');
        const { conversation } = await api.branchConversationAtMessage(
          conversationId,
          dbMsg.id,
        );
        onConversationCreated(conversation.id);
        onConversationUpdated();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : '创建分支失败');
      } finally {
        setBranchBusy(null);
      }
    },
    [conversationId, messages, onConversationCreated, onConversationUpdated],
  );

  return (
    <div className="chat" data-testid="chat-panel" data-active-conv={conversationId ?? ''}>
      <div className="chat-header">
        <ModelSelector
          models={chatModels}
          activeId={model.id}
          onChange={onModelChange}
        />
        {tier && (
          <span className={`price-badge tier-${tier}`} data-testid="price-tier">
            {PRICE_TIER_LABEL[tier]}
          </span>
        )}
        {model.supports_vision && (
          <span className="vision-pill" data-testid="vision-pill" title="支持视觉输入">
            👁
          </span>
        )}
      </div>
      {activeRoundtableId ? (
        <RoundtablePanel
          roundtableId={activeRoundtableId}
          onExit={() => setActiveRoundtableId(null)}
          onFollowUp={(topic) => {
            setActiveRoundtableId(null);
            setRoundtableDialog({ initialTopic: topic });
          }}
          onLoopback={(loopConvId) => {
            setActiveRoundtableId(null);
            onLoopbackToConversation(loopConvId);
          }}
        />
      ) : (
        <>
      <div className="messages" data-testid="messages">
        {historyLoading && (
          <div className="msg system" data-testid="history-loading">加载历史…</div>
        )}
        {!historyLoading && messages.length === 0 && (
          <div className="starter" data-testid="starter">
            <h2 className="starter-title">准备开始一段新对话</h2>
            <p className="starter-sub">挑一个起步提示，或直接在下方输入你的想法</p>
            <div className="starter-grid">
              {STARTER_PROMPTS.map((p, i) => (
                <button
                  key={p.title}
                  type="button"
                  className="starter-card"
                  data-testid={`starter-prompt-${i}`}
                  onClick={() => setInput(p.text)}
                >
                  <span className="starter-icon" aria-hidden="true">{p.icon}</span>
                  <span className="starter-card-title">{p.title}</span>
                  <span className="starter-card-desc">{p.desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => {
          const anns =
            ((m as { annotations?: Array<Record<string, unknown>> }).annotations ?? []);
          const annMessageId = anns.find((a) => a?.type === 'cost')?.message_id as
            | string
            | undefined;
          const cost = annMessageId ? costByMsg[annMessageId] : undefined;
          const isLastAssistant =
            m.role === 'assistant' && m === messages[messages.length - 1];
          return (
            <div key={m.id} className={`msg ${m.role}`} data-role={m.role} data-msg-id={m.id}>
              <div className="msg-role">{m.role}</div>
              {m.role === 'user' && editingMsgId === m.id ? (
                <div className="msg-content msg-edit-block">
                  <textarea
                    className="msg-edit-textarea"
                    data-testid="msg-edit-textarea"
                    value={editingDraft}
                    onChange={(e) => setEditingDraft(e.target.value)}
                    rows={Math.min(10, Math.max(2, editingDraft.split('\n').length))}
                  />
                  <div className="msg-edit-actions">
                    <button
                      type="button"
                      data-testid="msg-edit-save"
                      disabled={editBusy || !editingDraft.trim()}
                      onClick={() => void submitEdit(m.id)}
                    >
                      {editBusy ? '保存中…' : '保存并重新生成'}
                    </button>
                    <button
                      type="button"
                      data-testid="msg-edit-cancel"
                      disabled={editBusy}
                      onClick={() => { setEditingMsgId(null); setEditingDraft(''); }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : m.role === 'assistant' ? (
                <div
                  className="msg-content msg-md"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                />
              ) : (
                <div className="msg-content">{m.content}</div>
              )}
              {m.role === 'assistant' && imagesByMsg[m.id] && imagesByMsg[m.id]!.length > 0 && (
                <div className="msg-tool-images" data-testid="msg-tool-images">
                  {imagesByMsg[m.id]!.map((img) => (
                    <figure key={img.file_id} className="tool-image">
                      <img
                        src={
                          img.data_b64
                            ? `data:${img.content_type};base64,${img.data_b64}`
                            : ''
                        }
                        alt={img.prompt ?? 'generated image'}
                        loading="lazy"
                      />
                      {img.prompt && (
                        <figcaption>{img.prompt}</figcaption>
                      )}
                    </figure>
                  ))}
                </div>
              )}
              {m.role === 'assistant' && cost && (
                <div className="msg-cost" data-testid="msg-cost">
                  {cost.input_tokens} in · {cost.output_tokens} out ·{' '}
                  {cost.actual_usd != null ? formatUsd(cost.actual_usd) : '—'}
                </div>
              )}
              {!isLoading && m.content && editingMsgId !== m.id && (
                <div className="msg-actions" data-testid="msg-actions">
                  <button
                    type="button"
                    onClick={() => void copyToClipboard(m.content)}
                    data-testid="msg-copy"
                    title="复制"
                  >
                    ⧉ 复制
                  </button>
                  {m.role === 'user' && conversationId && (
                    <button
                      type="button"
                      data-testid="msg-edit"
                      title="编辑并重新生成"
                      onClick={() => {
                        setActionError(null);
                        setEditingMsgId(m.id);
                        setEditingDraft(m.content ?? '');
                      }}
                    >
                      ✎ 编辑重发
                    </button>
                  )}
                  {m.role === 'assistant' && isLastAssistant && (
                    <button
                      type="button"
                      onClick={() => regenerate()}
                      data-testid="msg-regenerate"
                      title="重新生成"
                    >
                      ↻ 重新生成
                    </button>
                  )}
                  {m.role === 'assistant' && isLastAssistant && wasStoppedRecently && (
                    <button
                      type="button"
                      onClick={() => void onContinueClick()}
                      data-testid="msg-continue"
                      title="继续上文"
                      disabled={continueBusy}
                    >
                      {continueBusy ? '续写中…' : '✏️ 续写'}
                    </button>
                  )}
                  {conversationId && (m.role === 'user' || m.role === 'assistant') && (
                    <button
                      type="button"
                      data-testid="msg-branch"
                      title="基于此消息创建分支会话"
                      disabled={branchBusy === m.id}
                      onClick={() => void branchFromMessage(m.id)}
                    >
                      {branchBusy === m.id ? '创建分支…' : '⎇ 分支'}
                    </button>
                  )}
                </div>
              )}
              {m.role === 'assistant' && failureByMsg[m.id] && (
                <FailureDecisionCard
                  decision={failureByMsg[m.id]!}
                  chatModels={chatModels}
                  onRetry={() => regenerate()}
                  onSwitch={(targetId) => {
                    onModelChange(targetId);
                    window.setTimeout(() => void regenerate(), 50);
                  }}
                  onOpenSettings={() => onOpenSettings()}
                />
              )}
            </div>
          );
        })}
        {actionError && (
          <div className="msg-action-error" data-testid="msg-action-error" role="alert">
            {actionError}
          </div>
        )}
        {isLoading && (
          <div className="msg assistant streaming" data-testid="streaming-indicator">
            <span className="streaming-dot">…</span>
            {streamBadge && (
              <button
                type="button"
                className="cost-stream-badge"
                data-testid="cost-stream-badge"
                onClick={() => setStreamBadgeOpen((v) => !v)}
                title="点击查看实时成本估算"
              >
                ≈ {formatUsd(streamBadge.estimateUsd)}
              </button>
            )}
            {streamBadge && streamBadgeOpen && (
              <div className="cost-stream-detail" data-testid="cost-stream-detail">
                <div>输入: {streamBadge.inputTokens} tok</div>
                <div>输出: {streamBadge.outputTokens} tok</div>
                <div>估算: {formatUsd(streamBadge.estimateUsd)}</div>
                <div className="hint">实时估算，最终以服务返回为准</div>
              </div>
            )}
          </div>
        )}
        {/*
          M2.1 — orphan failure card. When the upstream errors before any
          text arrived, useChat discards the in-flight assistant message,
          so the per-message branch above never matches. We render a
          standalone card keyed off `lastFailureMsgId` instead.
        */}
        {lastFailureMsgId
          && failureByMsg[lastFailureMsgId]
          && !messages.some((m) => m.id === lastFailureMsgId)
          && (
            <div className="msg assistant" data-role="assistant" data-failed="1">
              <FailureDecisionCard
                decision={failureByMsg[lastFailureMsgId]!}
                chatModels={chatModels}
                onRetry={() => regenerate()}
                onSwitch={(targetId) => {
                  onModelChange(targetId);
                  window.setTimeout(() => void regenerate(), 50);
                }}
                onOpenSettings={() => onOpenSettings()}
              />
            </div>
          )}
      </div>
      {error && <ChatErrorBanner error={error} />}
      <AttachmentBar
        attachments={pending}
        onRemove={(idx) => setPending((p) => p.filter((_, i) => i !== idx))}
        visionWarning={pending.some((p) => p.kind === 'image') && !model.supports_vision}
      />
      {dropError && (
        <div className="vision-warning" data-testid="drop-error" role="alert">{dropError}</div>
      )}
      <EstimateBar estimate={estimate} sampleCount={avgOutput?.n ?? 0} hasInput={input.trim().length > 0} />
      {contextStatus && contextStatus.state !== 'ok' && (
        <div
          className={`context-warning context-${contextStatus.state}`}
          data-testid="context-warning"
          data-state={contextStatus.state}
          role={contextStatus.state === 'exceed' ? 'alert' : 'status'}
        >
          {contextStatus.state === 'exceed'
            ? `已超出当前模型上下文（${contextStatus.used.toLocaleString()} / ${contextStatus.limit.toLocaleString()} tokens）。请精简输入或换更大上下文的模型。`
            : `输入接近上下文上限（${(contextStatus.pct * 100).toFixed(0)}%，${contextStatus.used.toLocaleString()} / ${contextStatus.limit.toLocaleString()} tokens）。继续可能被截断。`}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pending.some((p) => p.kind === 'image') && !model.supports_vision) return;
          const atts = pending.map(({ kind, mime, data_b64, name }) => ({ kind, mime, data_b64, name }));

          // M2.2 §3.2 — pre-call confirm modal. Skip if model or conversation
          // is in disabled list. Trigger when estimate > threshold OR when
          // capability=image AND image_always=true.
          const skip = confirmPrefs.disabledModels.includes(model.id)
            || (conversationId && confirmPrefs.disabledConvs.includes(conversationId));
          const isImage = model.capability === 'image';
          const exceedsThreshold = (estimate.point ?? 0) > confirmPrefs.threshold;
          const triggersImage = isImage && confirmPrefs.imageAlways;
          if (!skip && (exceedsThreshold || triggersImage)) {
            const fire = () => {
              setPending([]);
              handleSubmit(e, atts.length > 0 ? { body: { attachments: atts } } : undefined);
            };
            setPendingConfirm({
              estimate: estimate.point ?? 0,
              reason: triggersImage ? 'image' : 'threshold',
              onContinue: () => { setPendingConfirm(null); fire(); },
              onCheaper: () => {
                setPendingConfirm(null);
                // Pick a cheaper peer in the same capability via the local
                // chatModels list (cheapest by price_input_per_1m fallback to
                // price_per_call). The backend pickCheapestActive endpoint is
                // not yet exposed; this client-side pick mirrors its semantics.
                const candidates = chatModels
                  .filter((m) => m.capability === model.capability && !m.demoted && !(m.disabled_until && m.disabled_until > Date.now()) && m.id !== model.id)
                  .sort((a, b) => {
                    const ka = a.price_per_call ?? a.price_input_per_1m ?? Number.POSITIVE_INFINITY;
                    const kb = b.price_per_call ?? b.price_input_per_1m ?? Number.POSITIVE_INFINITY;
                    return ka - kb;
                  });
                const cheaper = candidates[0];
                if (cheaper) {
                  onModelChange(cheaper.id);
                  window.setTimeout(() => fire(), 50);
                } else {
                  fire();
                }
              },
              onCancel: () => { setPendingConfirm(null); },
            });
            return;
          }

          setPending([]);
          handleSubmit(e, atts.length > 0 ? { body: { attachments: atts } } : undefined);
        }}
        className="composer"
        onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
        onDragLeave={() => setDropping(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setDropping(false);
          const all = Array.from(e.dataTransfer.files);
          const classified = all.map(classifyDropFile);
          const accepted = classified.filter((c) => c.kind !== null);
          const rejected = classified.length - accepted.length;
          if (rejected > 0) {
            setDropError(`已忽略 ${rejected} 个不支持的文件（仅支持图片 / 文本 / Markdown / PDF）`);
          } else {
            setDropError(null);
          }
          if (accepted.length === 0) return;
          const next: PendingAttachment[] = [];
          for (const c of accepted) {
            try {
              const data_b64 = await fileToBase64(c.file);
              next.push({ kind: c.kind!, mime: c.file.type || 'application/octet-stream', name: c.file.name, data_b64 });
            } catch (err) {
              console.error(`[drop] read failed: ${c.file.name}`, err);
              setDropError(`读取 ${c.file.name} 失败`);
            }
          }
          if (next.length > 0) {
            setPending((p) => [...p, ...next]);
            // Spec §7 step 5: dropping an image onto a non-vision model should
            // auto-switch to a vision-capable peer (transparent UX) and only
            // fall back to the warning banner if no such model is configured.
            const hasImage = next.some((n) => n.kind === 'image');
            if (hasImage && !model.supports_vision) {
              const visionPick = chatModels.find(
                (m) => m.supports_vision && !m.demoted && !(m.disabled_until && m.disabled_until > Date.now()),
              );
              if (visionPick && visionPick.id !== model.id) {
                onModelChange(visionPick.id);
                setDropError(
                  `已自动切换至视觉模型：${visionPick.display_name}`,
                );
              }
            }
          }
        }}
        data-testid="composer-form"
        data-dropping={dropping ? '1' : '0'}
      >
        <textarea
          name="prompt"
          value={input}
          onChange={handleInputChange}
          placeholder="给 sidecar 发一条消息试试，或拖入图片…"
          autoFocus
          data-testid="composer-input"
          disabled={isLoading}
          rows={1}
          ref={composerRef}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const form = (e.currentTarget as HTMLTextAreaElement).form;
              if (form) form.requestSubmit();
            }
          }}
          onInput={(e) => {
            const ta = e.currentTarget as HTMLTextAreaElement;
            ta.style.height = 'auto';
            ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
          }}
        />
        {isLoading ? (
          <button
            type="button"
            onClick={onStopClick}
            className="abort-btn"
            data-testid="composer-stop"
          >
            ■ 停止
          </button>
        ) : (
          <>
            <button
              type="button"
              data-testid="composer-roundtable"
              className="roundtable-btn"
              title="🔍 圆桌讨论：让多个模型从不同视角围绕同一话题讨论"
              onClick={() =>
                setRoundtableDialog({ initialTopic: input })
              }
            >
              🔍 圆桌
            </button>
            <button
              type="submit"
              disabled={!input.trim() || (pending.some((p) => p.kind === 'image') && !model.supports_vision)}
              data-testid="composer-send"
            >
              发送
            </button>
          </>
        )}
      </form>
      <CostStatusBar
        realtime={realtime}
        onScopeClick={(scope) => setCostPanelScope(scope)}
      />
        </>
      )}
      {pendingConfirm && (
        <CostConfirmDialog
          estimate={pendingConfirm.estimate}
          reason={pendingConfirm.reason}
          model={pendingConfirm.model ?? model}
          conversationId={conversationId}
          hasCheaperPeer={chatModels.some(
            (m) => m.capability === (pendingConfirm.model ?? model).capability && !m.demoted && !(m.disabled_until && m.disabled_until > Date.now()) && m.id !== (pendingConfirm.model ?? model).id,
          )}
          onContinue={pendingConfirm.onContinue}
          onCheaper={pendingConfirm.onCheaper}
          onCancel={pendingConfirm.onCancel}
          onUpdatePrefs={(next) => setConfirmPrefs((p) => ({ ...p, ...next }))}
        />
      )}
      {costPanelScope && (
        <SessionCostPanel
          scope={costPanelScope}
          conversationId={conversationId}
          onClose={() => setCostPanelScope(null)}
          onScopeChange={setCostPanelScope}
        />
      )}
      {imagePicker && (
        <ImagePickerDialog
          prompt={imagePicker.prompt}
          imageModels={imageModels}
          selectedModelId={imagePicker.selectedModelId}
          memory={imagePicker.memory}
          submitting={imagePickerSubmitting}
          errorMsg={imagePickerError}
          onSelectModel={(id) =>
            setImagePicker((p) => (p ? { ...p, selectedModelId: id } : p))
          }
          onMemoryChange={(memory) =>
            setImagePicker((p) => (p ? { ...p, memory } : p))
          }
          onSubmit={() => void submitImagePicker()}
          onCancel={() => setImagePicker(null)}
          onEscapeIntent={() => void escapeImageIntent()}
        />
      )}
      {roundtableDialog && (
        <RoundtableLaunchDialog
          initialTopic={roundtableDialog.initialTopic}
          conversationId={conversationId}
          onCancel={() => setRoundtableDialog(null)}
          onLaunched={(result) => {
            setRoundtableDialog(null);
            setActiveRoundtableId(result.id);
            // Pull the new conversation into the sidebar list.
            onConversationUpdated();
          }}
        />
      )}
      {activeRoundtableId && null}
    </div>
  );
}

/**
 * M2.2 §3.2 — pre-call confirm modal. Three buttons: continue / cheaper /
 * cancel. Two checkboxes that persist via memories: "skip for this model"
 * and "skip for this conversation".
 */
function CostConfirmDialog({
  estimate,
  reason,
  model,
  conversationId,
  hasCheaperPeer,
  onContinue,
  onCheaper,
  onCancel,
  onUpdatePrefs,
}: {
  estimate: number;
  reason: 'threshold' | 'image';
  model: Model;
  conversationId: string | null;
  hasCheaperPeer: boolean;
  onContinue: () => void;
  onCheaper: () => void;
  onCancel: () => void;
  onUpdatePrefs: (next: Partial<{
    disabledModels: string[];
    disabledConvs: string[];
  }>) => void;
}): JSX.Element {
  const [skipModel, setSkipModel] = useState(false);
  const [skipConv, setSkipConv] = useState(false);

  const persist = useCallback(async () => {
    if (skipModel) {
      try {
        const cur = await api.getMemoryEffective('cost_confirm_disabled_models', null);
        let arr: string[] = [];
        try { const j = JSON.parse(cur.data.value ?? '[]'); if (Array.isArray(j)) arr = j.map(String); }
        catch { /* ignore */ }
        if (!arr.includes(model.id)) arr.push(model.id);
        await api.putMemory('global', 'cost_confirm_disabled_models', JSON.stringify(arr));
        onUpdatePrefs({ disabledModels: arr });
      } catch { /* ignore */ }
    }
    if (skipConv && conversationId) {
      try {
        const cur = await api.getMemoryEffective('cost_confirm_disabled_conversations', null);
        let arr: string[] = [];
        try { const j = JSON.parse(cur.data.value ?? '[]'); if (Array.isArray(j)) arr = j.map(String); }
        catch { /* ignore */ }
        if (!arr.includes(conversationId)) arr.push(conversationId);
        await api.putMemory('global', 'cost_confirm_disabled_conversations', JSON.stringify(arr));
        onUpdatePrefs({ disabledConvs: arr });
      } catch { /* ignore */ }
    }
  }, [skipModel, skipConv, model.id, conversationId, onUpdatePrefs]);

  // Esc closes the modal (cancel path). Skip-flags are NOT persisted on
  // cancel — they only commit when the user actually proceeds (review §5).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" data-testid="cost-confirm-dialog" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h3>本次调用预估 ≈ {formatUsd(estimate)}</h3>
        <p className="hint">
          {reason === 'image'
            ? `图像模型「${model.display_name}」每次调用都会按设置确认。`
            : `模型「${model.display_name}」此次预估超过阈值，请确认是否继续。`}
        </p>
        <div className="modal-actions">
          <button type="button" data-testid="cost-confirm-continue" autoFocus onClick={async () => { await persist(); onContinue(); }}>
            继续
          </button>
          <button
            type="button"
            data-testid="cost-confirm-cheaper"
            disabled={!hasCheaperPeer}
            title={hasCheaperPeer ? undefined : '没有更便宜的同能力模型可切换'}
            onClick={async () => { await persist(); onCheaper(); }}
          >
            改用低成本模型
          </button>
          <button type="button" data-testid="cost-confirm-cancel" onClick={() => { onCancel(); }}>
            取消
          </button>
        </div>
        <div className="modal-checks">
          <label>
            <input
              type="checkbox"
              data-testid="cost-confirm-skip-model"
              checked={skipModel}
              onChange={(e) => setSkipModel(e.target.checked)}
            />
            该模型后续不再确认
          </label>
          <label>
            <input
              type="checkbox"
              data-testid="cost-confirm-skip-conv"
              checked={skipConv}
              onChange={(e) => setSkipConv(e.target.checked)}
              disabled={!conversationId}
            />
            该会话后续不再确认
          </label>
        </div>
      </div>
    </div>
  );
}

/**
 * M2.2 §3.3 — session cost panel. Right drawer aside. Three scopes:
 * session / today / month. Fetches `/v1/costs/breakdown` and renders rows
 * grouped by (model, feature).
 */
function SessionCostPanel({
  scope,
  conversationId,
  onClose,
  onScopeChange,
}: {
  scope: 'session' | 'today' | 'month';
  conversationId: string | null;
  onClose: () => void;
  onScopeChange: (s: 'session' | 'today' | 'month') => void;
}): JSX.Element {
  const [rows, setRows] = useState<Array<{
    model_id: string | null;
    model_name_snapshot: string | null;
    feature: string;
    sum_usd: number;
    count: number;
    success_count: number;
    billed_failure_count: number;
  }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Esc closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    (async () => {
      try {
        const res = await api.costsBreakdown(scope, conversationId);
        if (cancelled) return;
        setRows(res.data.rows);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [scope, conversationId]);

  const total = (rows ?? []).reduce((sum, r) => sum + r.sum_usd, 0);

  return (
    <aside className="session-cost-panel" data-testid="session-cost-panel">
      <header>
        <div className="scope-tabs" data-testid="session-cost-scope-tabs">
          {(['session', 'today', 'month'] as const).map((s) => (
            <button
              key={s}
              type="button"
              data-testid={`scope-${s}`}
              data-active={scope === s ? '1' : '0'}
              onClick={() => onScopeChange(s)}
            >
              {s === 'session' ? '本会话' : s === 'today' ? '今日' : '本月'}
            </button>
          ))}
        </div>
        <button type="button" className="close" data-testid="session-cost-close" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="panel-body">
        {error && <div className="error">加载失败: {error}</div>}
        {!error && rows == null && <div className="hint">加载中…</div>}
        {!error && rows != null && rows.length === 0 && (
          <div className="hint" data-testid="session-cost-empty">暂无消费记录</div>
        )}
        {!error && rows != null && rows.length > 0 && (
          <>
            <div className="total" data-testid="session-cost-total">
              合计: {formatUsd(total)}
            </div>
            <ul className="breakdown-list">
              {rows.map((r, i) => (
                <li key={`${r.model_id}-${r.feature}-${i}`} data-testid="breakdown-row">
                  <div className="row-head">
                    <span className="model">{r.model_name_snapshot ?? '(已删除模型)'}</span>
                    <span className="feature">{r.feature}</span>
                    <span className="usd">{formatUsd(r.sum_usd)}</span>
                  </div>
                  <div className="row-meta">
                    <span>{r.count} 次</span>
                    {r.billed_failure_count > 0 && (
                      <span className="billed-failure" data-testid="billed-failure-badge">
                        含计费失败 {r.billed_failure_count} 次
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * M2.4 — image picker modal. Triggered by the sidecar `capability_route`
 * annotation. Lets the user pick an image-capable model + memory tier
 * (once / session / global) + escape ("我不是要画图，30 分钟内不要再问").
 */
function ImagePickerDialog({
  prompt,
  imageModels,
  selectedModelId,
  memory,
  submitting,
  errorMsg,
  onSelectModel,
  onMemoryChange,
  onSubmit,
  onCancel,
  onEscapeIntent,
}: {
  prompt: string;
  imageModels: Model[];
  selectedModelId: string | null;
  memory: 'once' | 'session' | 'global';
  submitting: boolean;
  errorMsg: string | null;
  onSelectModel: (id: string) => void;
  onMemoryChange: (m: 'once' | 'session' | 'global') => void;
  onSubmit: () => void;
  onCancel: () => void;
  onEscapeIntent: () => void;
}): JSX.Element {
  // Esc closes (cancel path).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const cheapest = imageModels[0]?.id ?? null;

  return (
    <div className="modal-backdrop" data-testid="image-picker-dialog" role="dialog" aria-modal="true">
      <div className="modal-card">
        <h3>选择图像生成模型</h3>
        <p className="hint" data-testid="image-picker-prompt">
          检测到画图意图：&ldquo;{prompt.slice(0, 120)}{prompt.length > 120 ? '…' : ''}&rdquo;
        </p>
        {imageModels.length === 0 ? (
          <div className="error" data-testid="image-picker-empty">
            没有可用的图像模型。请到「设置 → 模型」启用一个 image 模型。
          </div>
        ) : (
          <ul className="image-model-list" data-testid="image-model-list">
            {imageModels.map((m) => (
              <li key={m.id}>
                <label>
                  <input
                    type="radio"
                    name="image-model"
                    checked={selectedModelId === m.id}
                    onChange={() => onSelectModel(m.id)}
                    data-testid={`image-model-radio-${m.id}`}
                  />
                  <span className="image-model-name">{m.display_name}</span>
                  {m.price_per_call != null && (
                    <span className="image-model-price">≈ ${m.price_per_call.toFixed(3)}/次</span>
                  )}
                  {m.id === cheapest && <span className="badge">最便宜</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
        <fieldset className="memory-tier" data-testid="image-memory-tier">
          <legend>记忆选择</legend>
          <label>
            <input
              type="radio"
              checked={memory === 'once'}
              onChange={() => onMemoryChange('once')}
              data-testid="image-memory-once"
            />
            仅本次
          </label>
          <label>
            <input
              type="radio"
              checked={memory === 'session'}
              onChange={() => onMemoryChange('session')}
              data-testid="image-memory-session"
            />
            本会话默认
          </label>
          <label>
            <input
              type="radio"
              checked={memory === 'global'}
              onChange={() => onMemoryChange('global')}
              data-testid="image-memory-global"
            />
            全局默认
          </label>
        </fieldset>
        {errorMsg && (
          <div className="error" data-testid="image-picker-error">{errorMsg}</div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting || !selectedModelId || imageModels.length === 0}
            data-testid="image-picker-submit"
          >
            {submitting ? '生成中…' : '生成图像'}
          </button>
          <button
            type="button"
            onClick={onEscapeIntent}
            data-testid="image-picker-escape"
          >
            我不是要画图（30 分钟内不再询问）
          </button>
          <button
            type="button"
            onClick={onCancel}
            data-testid="image-picker-cancel"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

function ModelSelector({
  models,
  activeId,
  onChange,
}: {
  models: Model[];
  activeId: string;
  onChange: (id: string) => void;
}): JSX.Element {
  return (
    <select
      className="model-selector"
      value={activeId}
      onChange={(e) => onChange(e.target.value)}
      data-testid="active-model"
      aria-label="选择模型"
    >
      {models.map((m) => {
        const disabledNow = !!m.disabled_until && m.disabled_until > Date.now();
        // Per FR-4 in 08-m1-spec / 04-failure-resilience: demoted models stay
        // selectable but get ⚠️; disabled-until models render 🚫 and the
        // option is disabled outright (browser will block selection).
        const indicator = disabledNow ? ' 🚫' : m.demoted ? ' ⚠️' : '';
        return (
          <option key={m.id} value={m.id} disabled={disabledNow}>
            {m.display_name}
            {m.supports_vision ? ' 👁' : ''}
            {indicator}
          </option>
        );
      })}
    </select>
  );
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fall through */
  }
  // Fallback: hidden textarea + execCommand. Some test harnesses don't
  // expose clipboard at all; this keeps the DOM-level interaction visible.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
}

interface PendingAttachment {
  kind: 'image' | 'text' | 'pdf';
  mime: string;
  name: string;
  data_b64: string;
}

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

function AttachmentBar({
  attachments,
  onRemove,
  visionWarning,
}: {
  attachments: PendingAttachment[];
  onRemove: (i: number) => void;
  visionWarning: boolean;
}): JSX.Element | null {
  if (attachments.length === 0) return null;
  return (
    <div className="attachments" data-testid="attachments-bar">
      {attachments.map((a, i) => (
        <div className="attachment" key={`${a.name}-${i}`} data-testid="attachment-thumb" data-kind={a.kind}>
          {a.kind === 'image' ? (
            <img alt={a.name} src={`data:${a.mime};base64,${a.data_b64}`} />
          ) : (
            <span className="attachment-file" title={a.name}>
              {a.kind === 'pdf' ? '📕' : '📄'} <span className="attachment-name">{a.name}</span>
            </span>
          )}
          <button type="button" onClick={() => onRemove(i)} aria-label="remove">×</button>
        </div>
      ))}
      {visionWarning && (
        <div className="vision-warning" data-testid="vision-warning">
          当前模型不支持图片，请先切换到带 👁 的视觉模型。
        </div>
      )}
    </div>
  );
}

/**
 * Classify a dropped file into our schema's attachment kind. We accept:
 *   - image/*           → kind: 'image'
 *   - application/pdf, *.pdf → kind: 'pdf' (sidecar will reject with a typed
 *     "暂不支持 PDF" error; we still surface the file in UI so the user
 *     understands why their drop was acknowledged)
 *   - text/* + .md      → kind: 'text'
 * Anything else returns kind: null and is rejected at the drop boundary.
 */
function classifyDropFile(file: File): { file: File; kind: PendingAttachment['kind'] | null } {
  const t = file.type;
  const name = file.name.toLowerCase();
  if (/^image\//.test(t)) return { file, kind: 'image' };
  if (t === 'application/pdf' || name.endsWith('.pdf')) return { file, kind: 'pdf' };
  if (/^text\//.test(t) || name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt')) {
    return { file, kind: 'text' };
  }
  return { file, kind: null };
}

function CostStatusBar({
  realtime,
  onScopeClick,
}: {
  realtime: {
    current_conversation_usd: number;
    current_conversation_calls: number;
    today_usd: number;
    month_usd: number;
  } | null;
  onScopeClick?: (scope: 'session' | 'today' | 'month') => void;
}): JSX.Element {
  if (!realtime) {
    return (
      <div className="cost-bar" data-testid="cost-bar">
        <span>本会话: —</span>
        <span>今日: —</span>
        <span>本月: —</span>
      </div>
    );
  }
  return (
    <div className="cost-bar" data-testid="cost-bar">
      <button
        type="button"
        className="cost-bar-segment"
        data-testid="cost-conv"
        onClick={() => onScopeClick?.('session')}
      >
        本会话: {formatUsd(realtime.current_conversation_usd)} · {realtime.current_conversation_calls} 次
      </button>
      <button
        type="button"
        className="cost-bar-segment"
        data-testid="cost-today"
        onClick={() => onScopeClick?.('today')}
      >
        今日: {formatUsd(realtime.today_usd)}
      </button>
      <button
        type="button"
        className="cost-bar-segment"
        data-testid="cost-month"
        onClick={() => onScopeClick?.('month')}
      >
        本月: {formatUsd(realtime.month_usd)}
      </button>
    </div>
  );
}

/**
 * Pre-send estimate bar (M1 §5.1). Renders nothing when input is empty so it
 * doesn't clutter the composer at rest. Shows a range "$0.0001 – $0.0005"
 * when the model has fewer than 5 successful samples; otherwise a single
 * point estimate. "—" when price data isn't available.
 */
function EstimateBar({
  estimate,
  sampleCount,
  hasInput,
}: {
  estimate: { point: number | null; low: number | null; high: number | null };
  sampleCount: number;
  hasInput: boolean;
}): JSX.Element | null {
  if (!hasInput) return null;
  if (estimate.point == null) {
    return (
      <div className="estimate-bar" data-testid="estimate-bar">
        <span>预估: —</span>
        <span className="estimate-hint">（无价格数据）</span>
      </div>
    );
  }
  const isRange = sampleCount < 5 && estimate.low != null && estimate.high != null && estimate.low !== estimate.high;
  return (
    <div className="estimate-bar" data-testid="estimate-bar">
      <span data-testid="estimate-amount">
        预估: {isRange
          ? `${formatUsd(estimate.low)} – ${formatUsd(estimate.high)}`
          : `≈ ${formatUsd(estimate.point)}`}
      </span>
      {isRange && (
        <span className="estimate-hint" data-testid="estimate-hint">（样本 {sampleCount} &lt; 5，仅参考）</span>
      )}
    </div>
  );
}

const ERROR_LABELS: Record<string, string> = {
  'provider_error/quota': '已超出额度',
  'provider_error/rate_limit': '速率限制',
  'provider_error/network': '网络错误',
  'provider_error/content_filter': '上游内容拦截',
  'provider_error/auth': '鉴权失败',
  'provider_error/config_error': '模型配置有误',
  'provider_error/key_missing': 'API Key 未配置',
  'provider_error/unknown': '上游错误',
  unauthorized: '鉴权失败',
  validation_error: '请求参数有误',
  upstream_unavailable: '上游不可用',
  unknown: '未知错误',
};

function ChatErrorBanner({ error }: { error: Error }): JSX.Element {
  const raw = error.message ?? String(error);
  const m = raw.match(
    /^(provider_error\/(?:quota|rate_limit|network|content_filter|auth|config_error|key_missing|unknown)|unauthorized|validation_error|upstream_unavailable|unknown)\s*:\s*(.*)$/,
  );
  const klass = m?.[1] ?? 'unknown';
  const detail = m?.[2]?.trim() || raw;
  const label = ERROR_LABELS[klass] ?? '错误';
  return (
    <div className="error-banner" role="alert" data-testid="chat-error">
      <span className="error-label" data-testid="chat-error-label">{label}</span>
      <span className="error-class" data-testid="chat-error-class">{klass}</span>
      <span className="error-detail" data-testid="chat-error-detail">{detail || raw}</span>
    </div>
  );
}

// =====================================================================
// M2.1 — Failure Decision Card
// =====================================================================
//
// A `failure_decision` annotation is emitted by the sidecar right before
// the `3:` error frame whenever a chat upstream call fails. The Renderer
// turns that single payload into an in-message decision card so the user
// can act without scanning logs:
//
//   - retry the same model
//   - switch to the recommended fallback (hidden for content_filter —
//     content policy is not a model issue)
//   - jump to settings (toggle auto-fallback)
//
// Auto-fallback (when the toggle is on, classification is recoverable
// and a fallback exists) is handled in ChatPanel via useEffect, NOT
// inside the card; the card is purely declarative.

type FailureClassification =
  | 'quota'
  | 'rate_limit'
  | 'network'
  | 'content_filter'
  | 'auth'
  | 'config_error'
  | 'key_missing'
  | 'unknown';

interface FailureDecision {
  classification: FailureClassification;
  current_model_id: string | null;
  recommended_model_id: string | null;
  auto_fallback_enabled: boolean;
}

const FAILURE_CLASS_LABEL: Record<FailureClassification, string> = {
  quota: '已超出额度',
  rate_limit: '速率限制',
  network: '网络错误',
  content_filter: '内容被供应商安全策略拦截',
  auth: '鉴权失败',
  config_error: '模型配置有误',
  key_missing: 'API Key 未配置',
  unknown: '未知错误',
};

const FAILURE_CLASS_HINT: Record<FailureClassification, string> = {
  quota: '可切换到其他模型继续。',
  rate_limit: '可稍后重试，或切换到备用模型。',
  network: '请检查网络后重试。',
  content_filter: '内容策略问题，更换模型通常无效；建议改写后重试。',
  auth: '请到设置中检查 API Key。',
  config_error: '请在「模型中心」编辑模型，确认模型名称 / endpoint ID 正确。',
  key_missing: '请在「模型中心」→ Provider 旁边的 ⚙ 重新输入 API Key，或重启后重新配置。',
  unknown: '可重试或切换模型。',
};

function FailureDecisionCard({
  decision,
  chatModels,
  onRetry,
  onSwitch,
  onOpenSettings,
}: {
  decision: FailureDecision;
  chatModels: Model[];
  onRetry: () => void;
  onSwitch: (targetId: string) => void;
  onOpenSettings: () => void;
}): JSX.Element {
  const recommended = decision.recommended_model_id
    ? chatModels.find((m) => m.id === decision.recommended_model_id) ?? null
    : null;
  const showSwitch =
    decision.classification !== 'content_filter' && recommended != null;
  return (
    <div
      className={`failure-decision-card cls-${decision.classification}`}
      role="alert"
      data-testid="failure-decision-card"
      data-classification={decision.classification}
    >
      <div className="fdc-head">
        <span className="fdc-label" data-testid="fdc-label">
          {FAILURE_CLASS_LABEL[decision.classification]}
        </span>
        <span className="fdc-class" data-testid="fdc-class">
          {decision.classification}
        </span>
      </div>
      <div className="fdc-hint">{FAILURE_CLASS_HINT[decision.classification]}</div>
      {decision.auto_fallback_enabled && showSwitch && (
        <div className="fdc-auto" data-testid="fdc-auto-note">
          已开启「失败自动回退」，已自动切换到推荐模型重试。
        </div>
      )}
      <div className="fdc-actions" data-testid="fdc-actions">
        <button
          type="button"
          onClick={onRetry}
          data-testid="fdc-retry"
          title="使用当前模型重试"
        >
          ↻ 重试
        </button>
        {showSwitch && (
          <button
            type="button"
            onClick={() => onSwitch(recommended!.id)}
            data-testid="fdc-switch"
            title={`切换到 ${recommended!.display_name}`}
          >
            ⇄ 切换到「{recommended!.display_name}」并重试
          </button>
        )}
        <button
          type="button"
          onClick={onOpenSettings}
          data-testid="fdc-settings"
          title="打开设置"
        >
          ⚙ 设置
        </button>
      </div>
    </div>
  );
}
