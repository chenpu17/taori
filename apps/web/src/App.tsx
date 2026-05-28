import React, { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { BrandMark, Icon, MODELS, ThreadNode, type ModelId } from './primitives';
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
import { SCENARIOS, type Message, type ModeId, type ScenarioId } from './scenarios';
import {
  deleteConversation,
  patchConversation,
  patchConversationMessage,
  postChat,
  type ConversationMessage,
} from './api';
import { useConversations, useFooterHealth, useMessages, useModels, useRealtimeCost, useTodayBreakdown } from './useLiveData';
import { type PendingAttachment, toPendingAttachment } from './attachments';
import { applyStreamAnnotations, buildChatMessages } from './chatStream';
import { renderMarkdown } from './markdown';
import { Sidebar } from './Sidebar';
import { Composer } from './Composer';

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
  const [attach, setAttach] = useState<PendingAttachment[]>([]);

  const [plusOpen, setPlusOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [footPopup, setFootPopup] = useState<FootPopupId>(null);
  const [drawer, setDrawer] = useState<DrawerId | null>(null);
  const applyTheme = (t: Theme) => {
    setTheme(t);
    if (t === 'auto') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      document.documentElement.setAttribute('data-theme', t);
    }
    localStorage.setItem('taori-theme', t);
  };
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('taori-theme') as Theme | null;
    if (saved) {
      if (saved === 'auto') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
      } else {
        document.documentElement.setAttribute('data-theme', saved);
      }
      return saved;
    }
    return 'dark';
  });
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
  const [convId, setConvId] = useState<string | null>(null);
  const realtimeCost = useRealtimeCost(5000, convId);
  const todayBreakdown = useTodayBreakdown(footPopup === 'today');
  const liveModels = useModels();
  const convList = useConversations();
  const isLive = convList.data !== null;
  const convMsgs = useMessages(convId);

  // Global keyboard shortcuts: ⌘N (new chat), ⌘K (command palette)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘N / Ctrl+N — new chat (works everywhere, prevents browser new window)
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        if (isLive) { setConvId(null); setValue(''); setMode(null); setAttach([]); }
        else { setScenarioId('empty'); }
        return;
      }
      // ⌘K / Ctrl+K — command palette (works everywhere)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCmdPaletteOpen((v) => !v);
        return;
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

  const handleAttachFiles = async (files: File[]) => {
    const prepared = (await Promise.all(files.map((file) => toPendingAttachment(file))))
      .filter((item): item is PendingAttachment => item !== null);
    if (prepared.length === 0) return;
    setAttach((prev) => [...prev, ...prepared].slice(0, 8));
  };

  // ── Retry last assistant message ────────────────────────────
  const handleRetry = async () => {
    if (isStreaming) return;
    if (!convId || !liveModelId) return;
    const lastAssistantIndex = [...liveMsgs].reverse().findIndex((msg) => msg.role === 'assistant');
    if (lastAssistantIndex < 0) return;
    const assistantIndex = liveMsgs.length - 1 - lastAssistantIndex;
    const historyBeforeAssistant = liveMsgs.slice(0, assistantIndex);
    const lastUser = [...historyBeforeAssistant].reverse().find((msg) => msg.role === 'user');
    if (!lastUser?.content) return;

    try {
      await patchConversationMessage(convId, lastUser.id, { content: lastUser.content });
    } catch {
      return;
    }

    setIsStreaming(true);

    const assistantMsg: ConversationMessage = {
      id: crypto.randomUUID(),
      conversation_id: convId,
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
    setLiveMsgs([...historyBeforeAssistant, assistantMsg]);

    let accumulated = '';
    try {
      const abort = await postChat(
        {
          conversation_id: convId,
          model_id: liveModelId,
          messages: historyBeforeAssistant.map((msg) => ({ role: msg.role, content: msg.content })),
          skip_user_persist: true,
        },
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
          convMsgs.refetch?.();
        },
        (err) => {
          setLiveMsgs((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { ...updated[updated.length - 1], status: 'error', error: err.message };
            return updated;
          });
          setIsStreaming(false);
        },
        (items) => {
          setLiveMsgs((prev) => applyStreamAnnotations(prev, items));
        },
      );
      abortRef.current = abort;
    } catch {
      setIsStreaming(false);
    }
  };

  // ── Determine if last live message is the last assistant ─────
  const lastLiveMsg = liveMessages.length > 0 ? liveMessages[liveMessages.length - 1] : null;
  const lastLiveMsgId = lastLiveMsg?.id ?? null;
  const lastLiveIsDone = lastLiveMsg?.role === 'assistant' && lastLiveMsg?.status !== 'streaming';

  // ── Send message ─────────────────────────────────────────────
  const handleSend = async () => {
    const text = value.trim();
    if ((!text && attach.length === 0) || isStreaming || !liveModelId) return;
    const convIdToUse = convId ?? crypto.randomUUID();
    if (!convId) setConvId(convIdToUse);
    setValue('');
    setIsStreaming(true);
    const outgoingAttachments = attach;
    setAttach([]);

    const userMsg: ConversationMessage = {
      id: crypto.randomUUID(),
      conversation_id: convIdToUse,
      role: 'user',
      content: text,
      model_id: null,
      status: 'sent',
      error: null,
      created_at: Date.now() / 1000,
      attachments_count: outgoingAttachments.length,
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
    const requestMessages = buildChatMessages(liveMsgs, text);
    try {
      const abort = await postChat(
        {
          conversation_id: convIdToUse,
          model_id: liveModelId,
          messages: requestMessages,
          attachments: outgoingAttachments.map(({ kind, mime, data_b64, name }) => ({
            kind,
            mime,
            data_b64,
            name,
          })),
        },
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
          convMsgs.refetch?.();
        },
        (err) => {
          setLiveMsgs((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { ...updated[updated.length - 1], status: 'error', error: err.message };
            return updated;
          });
          setIsStreaming(false);
          setAttach(outgoingAttachments);
        },
        (items) => {
          setLiveMsgs((prev) => applyStreamAnnotations(prev, items));
        },
      );
      abortRef.current = abort;
    } catch {
      setIsStreaming(false);
      setAttach(outgoingAttachments);
    }
  };

  // ── Export conversation as Markdown ──────────────────────────
  const handleExportConversation = async (id: string) => {
    const conv = convList.data?.find((c) => c.id === id);
    if (!conv) return;
    let msgs: ConversationMessage[] = liveMsgs;
    if (id !== convId) {
      try {
        const { getMessages } = await import('./api');
        const res = await getMessages(id);
        msgs = res.messages;
      } catch { return; }
    }
    const lines: string[] = [
      `# ${conv.title}`,
      '',
      `> 导出时间: ${new Date().toLocaleString('zh-CN')}`,
      '',
      '---',
      '',
    ];
    for (const m of msgs) {
      if (m.role === 'system') continue;
      const time = m.created_at
        ? new Date(m.created_at > 1e12 ? m.created_at : m.created_at * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        : '';
      if (m.role === 'user') {
        lines.push(`## 👤 用户 ${time}`, '', m.content, '');
      } else {
        const model = (m.model_id && modelLookup.get(m.model_id)) ?? 'Taori';
        lines.push(`## 🤖 ${model} ${time}`, '', m.content, '');
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${conv.title}.md`;
    a.click();
    URL.revokeObjectURL(url);
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
        onPin={async (id, pinned) => {
          await patchConversation(id, { pinned });
          convList.refetch?.();
        }}
        onTag={async (id, tags) => {
          await patchConversation(id, { tags });
          convList.refetch?.();
        }}
        onExport={(id) => handleExportConversation(id)}
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
          onSetMode={setMode}
          model={model}
          modelDisplay={composerModelDisplay}
          attach={attach}
          onRemoveAttach={(i) => setAttach(attach.filter((_, k) => k !== i))}
          onAttach={(files) => { void handleAttachFiles(files); }}
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
          onStop={() => { abortRef.current?.(); setIsStreaming(false); }}
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
              keyStatuses={footerHealth.data?.keyStatuses ?? undefined}
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
              onTheme={applyTheme}
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
