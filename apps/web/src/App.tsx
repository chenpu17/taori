import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Model, Provider } from '@taori/shared';
import {
  ApiError,
  branchConversation,
  deleteConversation,
  editUserMessage,
  exportConversation,
  getCostsRealtime,
  health,
  listConversations,
  listModels,
  listProviders,
  getMessages,
  setModelDefault,
  streamChat,
  streamRunContinue,
  streamRunRecover,
  patchConversation,
  type ChatStreamAnnotation,
  type ChatAttachment,
  type Conversation,
  type ConversationMessage,
} from './api';
import {
  applyChatAnnotations,
  buildChatMessages,
  makeLocalMessage,
} from './chatStream';
import { Icon } from './Icon';
import { ChatView } from './ChatView';
import { CommandPalette } from './CommandPalette';
import { EmptyState } from './EmptyState';
import { FeatureHub } from './FeatureHub';
import { Sidebar } from './Sidebar';
import { SettingsView } from './SettingsView';
import { useDialog } from './Dialog';
import { useToast } from './Toast';

type View = 'empty' | 'chat' | 'settings' | 'features';
type Theme = 'light' | 'dark' | 'auto';
type Density = 'compact' | 'regular' | 'comfy';

const STORAGE_KEY = 'taori.web.prefs.v1';
const CHAT_DEFAULT_CAPABILITY = 'chat';

interface Prefs {
  theme: Theme;
  density: Density;
  selectedModelId: string | null;
  quickCompareModelIds: string[];
}

const DEFAULT_PREFS: Prefs = {
  theme: 'light',
  density: 'regular',
  selectedModelId: null,
  quickCompareModelIds: [],
};

function readPrefs(): Prefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      theme: parsed.theme === 'dark' || parsed.theme === 'auto' ? parsed.theme : 'light',
      density:
        parsed.density === 'compact' || parsed.density === 'comfy' ? parsed.density : 'regular',
      selectedModelId: parsed.selectedModelId ?? null,
      quickCompareModelIds: Array.isArray(parsed.quickCompareModelIds)
        ? parsed.quickCompareModelIds.filter((id): id is string => typeof id === 'string').slice(0, 3)
        : [],
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePrefs(prefs: Prefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const dark =
    theme === 'dark' ||
    (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

function applyDensity(density: Density): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-density', density);
}

const NETWORK_ERROR_PATTERN =
  /failed to fetch|load failed|networkerror|network request failed|connection appears to be offline|fetch failed|err_connection/i;

function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  const raw = error instanceof Error ? error.message : String(error);
  if (NETWORK_ERROR_PATTERN.test(raw)) {
    return '无法连接到本地服务，请确认 Taori 后台进程已启动后重试。';
  }
  return raw;
}

function modelLabel(model: Model | null): string {
  if (!model) return '未选择模型';
  return model.alias ?? model.display_name ?? model.model_name;
}

function providerLabelFor(model: Model | null, providers: Provider[]): string {
  if (!model) return '未知服务商';
  return providers.find((provider) => provider.id === model.provider_id)?.name ?? model.provider_id ?? '未知服务商';
}

function canUseForChat(model: Model, providers: Provider[]): boolean {
  if (!model.enabled) return false;
  if (!(model.capability === 'chat' || model.capability === 'multimodal')) return false;
  if (!model.provider_id) return false;
  if (model.demoted) return false;
  if (model.disabled_until != null && model.disabled_until > Date.now()) return false;
  const provider = providers.find((item) => item.id === model.provider_id);
  return provider?.enabled === true;
}

function messageRunId(message: ConversationMessage): string | null {
  return message.annotations.find((annotation) => annotation.type === 'meta')?.run_id ?? null;
}

export function App(): JSX.Element {
  const toast = useToast();
  const dialog = useDialog();
  const [view, setView] = useState<View>('empty');
  const [settingsTab, setSettingsTab] = useState<'model' | 'providers' | 'appearance' | 'general'>('model');
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(() => readPrefs());
  const [todayUsd, setTodayUsd] = useState<number | null>(null);
  const [featuresTab, setFeaturesTab] = useState<'compare' | 'cost'>('compare');

  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [composer, setComposer] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [skipNextUserPersist, setSkipNextUserPersist] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [bootstrap, setBootstrap] = useState<'loading' | 'ready' | 'offline'>('loading');
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const stopStreamRef = useRef<(() => void) | null>(null);
  const streamTokenRef = useRef(0);
  const activeConversationIdRef = useRef<string | null>(null);
  const latestConversationIdRef = useRef<string | null>(null);
  const latestRunIdRef = useRef<string | null>(null);

  function isCurrentConversation(conversationId: string, streamToken: number): boolean {
    return streamTokenRef.current === streamToken && activeConversationIdRef.current === conversationId;
  }

  useEffect(() => {
    applyTheme(prefs.theme);
    applyDensity(prefs.density);
    writePrefs(prefs);
  }, [prefs]);

  useEffect(() => {
    if (prefs.theme !== 'auto' || typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('auto');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [prefs.theme]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === 'k') {
        event.preventDefault();
        setModelPickerOpen(false);
        setPaletteOpen((open) => !open);
        return;
      }
      if (mod && key === 'n') {
        event.preventDefault();
        newChat();
        return;
      }
      if (mod && event.key === '\\') {
        event.preventDefault();
        setCollapsed((value) => !value);
        return;
      }
      if (event.key === 'Escape' && streaming && !paletteOpen && !modelPickerOpen) {
        event.preventDefault();
        stopStreaming();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [streaming, paletteOpen, modelPickerOpen]);

  const chatModels = useMemo(
    () =>
      models.filter((model) => canUseForChat(model, providers)),
    [models, providers],
  );

  const activeModel = useMemo(() => {
    if (prefs.selectedModelId) {
      const found = chatModels.find((model) => model.id === prefs.selectedModelId);
      if (found) return found;
    }
    return chatModels.find((model) => model.is_default_for === 'chat') ?? chatModels[0] ?? null;
  }, [chatModels, prefs.selectedModelId]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );

  const refreshCore = useCallback(async () => {
    const [providersResponse, modelsResponse, conversationsResponse] = await Promise.all([
      listProviders(),
      listModels(),
      listConversations(),
    ]);
    setProviders(providersResponse);
    setModels(modelsResponse);
    setConversations(conversationsResponse);
  }, []);

  const refreshCost = useCallback(async () => {
    try {
      const realtime = await getCostsRealtime();
      setTodayUsd(realtime.today_usd ?? null);
    } catch {
      /* cost indicator is best-effort; never block the UI */
    }
  }, []);

  const bootstrapAll = useCallback(async () => {
    setBootstrap('loading');
    setBootstrapError(null);
    try {
      await health();
      await refreshCore();
      void refreshCost();
      setBootstrap('ready');
    } catch (error) {
      setBootstrapError(describeError(error));
      setBootstrap('offline');
    }
  }, [refreshCore, refreshCost]);

  useEffect(() => {
    void bootstrapAll();
  }, [bootstrapAll]);

  async function openConversation(id: string): Promise<void> {
    try {
      streamTokenRef.current += 1;
      if (streaming) stopStreamRef.current?.();
      stopStreamRef.current = null;
      setStreaming(false);
      const result = await getMessages(id);
      latestConversationIdRef.current = id;
      activeConversationIdRef.current = id;
      latestRunIdRef.current = null;
      setActiveConversationId(id);
      setMessages(result.messages);
      setView('chat');
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function reloadConversation(id: string): Promise<void> {
    const result = await getMessages(id);
    latestConversationIdRef.current = id;
    activeConversationIdRef.current = id;
    latestRunIdRef.current = null;
    setActiveConversationId(id);
    setMessages(result.messages);
    setView('chat');
  }

  function newChat(): void {
    streamTokenRef.current += 1;
    if (streaming) stopStreamRef.current?.();
    stopStreamRef.current = null;
    setStreaming(false);
    setActiveConversationId(null);
    setMessages([]);
    setComposer('');
    setAttachments([]);
    setSkipNextUserPersist(false);
    latestConversationIdRef.current = null;
    activeConversationIdRef.current = null;
    latestRunIdRef.current = null;
    setView('empty');
  }

  function openSettings(): void {
    setSettingsTab('model');
    setView('settings');
  }

  function openModelPicker(): void {
    setModelPickerOpen(true);
  }

  function openFeatures(tab: 'compare' | 'cost' = 'compare'): void {
    setFeaturesTab(tab);
    setView('features');
  }

  async function selectDefaultModel(model: Model): Promise<void> {
    setPrefs((current) => ({ ...current, selectedModelId: model.id }));
    if (model.is_default_for !== 'chat') {
      try {
        await setModelDefault(model.id, CHAT_DEFAULT_CAPABILITY);
        await refreshCore();
        toast.success(`已设为默认：${modelLabel(model)}`);
      } catch (error) {
        toast.error(describeError(error));
      }
    }
  }

  function selectComposerModel(model: Model): void {
    setPrefs((current) => ({ ...current, selectedModelId: model.id }));
    setModelPickerOpen(false);
    toast.info(`下条消息将使用：${modelLabel(model)}`);
  }

  async function sendChat(): Promise<void> {
    const content = composer.trim() || (
      attachments.length > 0
        ? `请阅读附件：${attachments.map((attachment) => attachment.name ?? attachment.mime).join('、')}`
        : ''
    );
    if (!content || streaming) return;
    if (!activeModel) {
      toast.warn('请先在「设置 / 模型」选择一个聊天模型。');
      setView('settings');
      return;
    }
    const conversationId = activeConversationId ?? 'draft';
    const shouldSkipUserPersist = skipNextUserPersist && activeConversationId != null && attachments.length === 0;
    const userMessage = makeLocalMessage('user', content, conversationId);
    userMessage.attachments_count = attachments.length;
    const assistantMessage = makeLocalMessage('assistant', '', conversationId, 'streaming');
    const history = activeConversationId ? messages : [];
    latestConversationIdRef.current = activeConversationId;
    latestRunIdRef.current = null;
    setMessages(shouldSkipUserPersist ? [...history, assistantMessage] : [...history, userMessage, assistantMessage]);
    setComposer('');
    setSkipNextUserPersist(false);
    setStreaming(true);
    setView('chat');
    const streamToken = streamTokenRef.current + 1;
    streamTokenRef.current = streamToken;

    const stop = await streamChat(
      {
        conversation_id: activeConversationId ?? undefined,
        model_id: activeModel.id,
        messages: buildChatMessages(history, content),
        attachments: attachments.length > 0 ? attachments : undefined,
        skip_user_persist: shouldSkipUserPersist || undefined,
      },
      {
        onText: (chunk) => {
          if (streamTokenRef.current !== streamToken) return;
          setMessages((current) => {
            const next = [...current];
            const reverse = [...next].reverse().findIndex((m) => m.role === 'assistant');
            if (reverse < 0) return current;
            const targetIndex = next.length - 1 - reverse;
            const target = next[targetIndex];
            if (!target) return current;
            next[targetIndex] = { ...target, content: `${target.content}${chunk}` };
            return next;
          });
        },
        onAnnotation: (annotations: ChatStreamAnnotation[]) => {
          if (streamTokenRef.current !== streamToken) return;
          setMessages((current) => {
            const applied = applyChatAnnotations(current, annotations);
            if (applied.conversationId) {
              latestConversationIdRef.current = applied.conversationId;
              activeConversationIdRef.current = applied.conversationId;
              setActiveConversationId(applied.conversationId);
            }
            if (applied.runId) latestRunIdRef.current = applied.runId;
            if (applied.failure) toast.warn(applied.failure);
            return applied.messages;
          });
        },
        onDone: () => {
          if (streamTokenRef.current !== streamToken) return;
          stopStreamRef.current = null;
          setStreaming(false);
          setMessages((current) =>
            current.map((message) =>
              message.role === 'assistant' && message.status === 'streaming'
                ? { ...message, status: 'complete' }
                : message,
            ),
          );
          setAttachments([]);
          void listConversations().then(setConversations).catch(() => undefined);
          void refreshCost();
          const currentConversationId = latestConversationIdRef.current ?? activeConversationId;
          if (currentConversationId && currentConversationId !== 'draft') {
            if (latestRunIdRef.current) {
              void getMessages(currentConversationId).then((result) => {
                if (isCurrentConversation(currentConversationId, streamToken)) setMessages(result.messages);
              }).catch(() => undefined);
            }
          }
        },
        onError: (streamError) => {
          if (streamTokenRef.current !== streamToken) return;
          stopStreamRef.current = null;
          setStreaming(false);
          const detail = describeError(streamError);
          toast.error(detail);
          setMessages((current) =>
            current.map((message) =>
              message.role === 'assistant' && message.status === 'streaming'
                ? { ...message, status: 'failed', error: detail }
                : message,
            ),
          );
        },
      },
    );
    stopStreamRef.current = stop;
  }

  async function updateConversation(id: string, patch: Parameters<typeof patchConversation>[1]): Promise<void> {
    try {
      await patchConversation(id, patch);
      await refreshCore();
      if (id === activeConversationId) {
        await reloadConversation(id);
      }
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function removeConversation(id: string): Promise<void> {
    const target = conversations.find((c) => c.id === id);
    const confirmed = await dialog.confirm({
      title: `删除对话「${target?.title || '未命名对话'}」？`,
      description: '消息和工具调用记录一并删除，且不可恢复。',
      tone: 'danger',
      okLabel: '删除',
    });
    if (!confirmed) return;
    try {
      await deleteConversation(id);
      if (id === activeConversationId) newChat();
      await refreshCore();
      toast.success('已删除对话。');
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function exportActiveConversation(): Promise<void> {
    if (!activeConversationId) return;
    try {
      const markdown = await exportConversation(activeConversationId, true);
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${activeConversation?.title || 'taori-conversation'}.md`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success('已导出 Markdown。');
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function editUserMessageAndReload(message: ConversationMessage): Promise<void> {
    if (message.role !== 'user') return;
    const nextContent = await dialog.prompt({
      title: '编辑这条用户消息',
      description: '保存后会截断其后的回复，你可以重新发送以生成新的回复。',
      defaultValue: message.content,
      multiline: true,
      okLabel: '保存并截断',
    });
    if (!nextContent || nextContent.trim() === message.content.trim()) return;
    try {
      await editUserMessage(message.conversation_id, message.id, nextContent.trim());
      await reloadConversation(message.conversation_id);
      setComposer(nextContent.trim());
      setSkipNextUserPersist(true);
      toast.success('已编辑消息，可重新发送生成回复。');
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function branchFromMessage(message: ConversationMessage): Promise<void> {
    try {
      const result = await branchConversation(message.conversation_id, message.id);
      await refreshCore();
      await reloadConversation(result.conversation.id);
      toast.success('已创建分支对话。');
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function recoverAssistantMessage(
    message: ConversationMessage,
    action: 'continue' | 'retry_same_model' | 'compact_context',
  ): Promise<void> {
    const runId = messageRunId(message);
    if (!runId || streaming) return;
    const assistantMessage = { ...message, content: '', status: 'streaming', error: null };
    let targetMessageId = message.id;
    const streamToken = streamTokenRef.current + 1;
    streamTokenRef.current = streamToken;
    setMessages((current) => current.map((item) => (item.id === message.id ? assistantMessage : item)));
    setStreaming(true);

    const handlers = {
      onText: (chunk: string) => {
        if (streamTokenRef.current !== streamToken) return;
        setMessages((current) =>
          current.map((item) =>
            item.id === targetMessageId ? { ...item, content: `${item.content}${chunk}` } : item,
          ),
        );
      },
      onAnnotation: (annotations: ChatStreamAnnotation[]) => {
        if (streamTokenRef.current !== streamToken) return;
        setMessages((current) => {
          const applied = applyChatAnnotations(current, annotations, targetMessageId);
          if (applied.targetMessageId) targetMessageId = applied.targetMessageId;
          if (applied.conversationId) latestConversationIdRef.current = applied.conversationId;
          if (applied.conversationId) activeConversationIdRef.current = applied.conversationId;
          if (applied.runId) latestRunIdRef.current = applied.runId;
          if (applied.failure) toast.warn(applied.failure);
          return applied.messages;
        });
      },
      onDone: () => {
        if (streamTokenRef.current !== streamToken) return;
        stopStreamRef.current = null;
        setStreaming(false);
        setMessages((current) =>
          current.map((item) => (item.id === targetMessageId ? { ...item, status: 'complete' } : item)),
        );
        void refreshCost();
        void getMessages(message.conversation_id).then((result) => {
          if (isCurrentConversation(message.conversation_id, streamToken)) setMessages(result.messages);
        }).catch(() => undefined);
      },
      onError: (error: Error) => {
        if (streamTokenRef.current !== streamToken) return;
        stopStreamRef.current = null;
        setStreaming(false);
        const detail = describeError(error);
        setMessages((current) =>
          current.map((item) =>
            item.id === targetMessageId ? { ...item, status: 'failed', error: detail } : item,
          ),
        );
        toast.error(detail);
      },
    };

    const stop = action === 'continue'
      ? await streamRunContinue(runId, { confirmed_cost: true }, handlers)
      : await streamRunRecover(
          runId,
          { action, confirmed_cost: true },
          handlers,
        );
    stopStreamRef.current = stop;
  }

  async function attachFiles(files: FileList): Promise<void> {
    const next: ChatAttachment[] = [];
    for (const file of Array.from(files).slice(0, 8 - attachments.length)) {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('读取附件失败'));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
      });
      const [, data = ''] = dataUrl.split(',');
      const mime = file.type || 'application/octet-stream';
      const lowerName = file.name.toLowerCase();
      const kind: ChatAttachment['kind'] = mime.startsWith('image/')
        ? 'image'
        : mime === 'application/pdf' || lowerName.endsWith('.pdf')
          ? 'pdf'
          : 'text';
      next.push({ kind, mime, data_b64: data, name: file.name });
    }
    setAttachments((current) => [...current, ...next]);
  }

  function removeAttachment(index: number): void {
    setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function stopStreaming(): void {
    if (!streaming) return;
    streamTokenRef.current += 1;
    stopStreamRef.current?.();
    stopStreamRef.current = null;
    setStreaming(false);
    setMessages((current) =>
      current.map((message) =>
        message.role === 'assistant' && message.status === 'streaming'
          ? { ...message, status: 'incomplete' }
          : message,
      ),
    );
  }

  function renderMain(): JSX.Element {
    if (bootstrap === 'loading') {
      return (
        <div className="empty scroll">
          <div className="empty-inner">
            <div className="greeting-glyph">织</div>
            <p className="greeting-sub">正在连接 Sidecar…</p>
          </div>
        </div>
      );
    }
    if (bootstrap === 'offline') {
      return (
        <div className="empty scroll">
          <div className="empty-inner">
            <div className="greeting-glyph">!</div>
            <h1 className="greeting">本地服务未连接</h1>
            <p className="greeting-sub" style={{ whiteSpace: 'normal', maxWidth: 480 }}>
              {bootstrapError ?? '请确认 Taori 后台进程已启动，再点下方按钮重试。'}
            </p>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                void bootstrapAll();
              }}
            >
              重新连接
            </button>
          </div>
        </div>
      );
    }
    if (view === 'settings') {
      return (
        <SettingsView
          providers={providers}
          models={models}
          loading={false}
          selectedModelId={activeModel?.id ?? null}
          onSelectDefault={selectDefaultModel}
          onRefresh={refreshCore}
          onError={(message) => toast.error(message)}
          onToast={(message) => toast.success(message)}
          theme={prefs.theme}
          onThemeChange={(theme) => setPrefs((current) => ({ ...current, theme }))}
          density={prefs.density}
          onDensityChange={(density) => setPrefs((current) => ({ ...current, density }))}
          tab={settingsTab}
          onTabChange={setSettingsTab}
        />
      );
    }
    if (view === 'features') {
      return (
        <FeatureHub
          initialTab={featuresTab}
          providers={providers}
          models={models}
          conversations={conversations}
          activeConversationId={activeConversationId}
          onOpenConversation={(id) => {
            void openConversation(id);
          }}
          onToast={(message) => toast.success(message)}
          onError={(message) => toast.error(message)}
          quickCompareModelIds={prefs.quickCompareModelIds}
          onQuickCompareModelIdsChange={(quickCompareModelIds) => {
            setPrefs((current) => ({ ...current, quickCompareModelIds }));
          }}
          onInsertComposer={(text) => {
            setComposer((current) => (current.trim() ? `${current}\n\n${text}` : text));
            setView('empty');
            toast.info('已注入到 Composer，按 Enter 发送。');
          }}
        />
      );
    }
    if (view === 'chat') {
      return (
        <ChatView
          conversationId={activeConversationId}
          title={activeConversation?.title ?? '新对话'}
          messages={messages}
          models={models}
          streaming={streaming}
          composer={composer}
          onComposerChange={setComposer}
          onSubmit={() => {
            void sendChat();
          }}
          onStop={stopStreaming}
          modelLabel={modelLabel(activeModel)}
          onModelClick={openModelPicker}
          attachments={attachments}
          onAttach={(files) => {
            void attachFiles(files);
          }}
          onRemoveAttachment={removeAttachment}
          onRenameConversation={async () => {
            if (!activeConversationId) return;
            const next = await dialog.prompt({
              title: '重命名对话',
              defaultValue: activeConversation?.title ?? '',
              placeholder: '取个名字…',
              okLabel: '保存',
            });
            if (next) {
              void updateConversation(activeConversationId, { title: next });
            }
          }}
          onTogglePin={() => {
            if (activeConversationId && activeConversation) {
              void updateConversation(activeConversationId, { pinned: !activeConversation.pinned });
            }
          }}
          onArchive={() => {
            if (activeConversationId) void updateConversation(activeConversationId, { archived: true });
          }}
          onExport={exportActiveConversation}
          onEditUserMessage={(message) => {
            void editUserMessageAndReload(message);
          }}
          onBranchFromMessage={(message) => {
            void branchFromMessage(message);
          }}
          onRecover={(message, action) => {
            void recoverAssistantMessage(message, action);
          }}
        />
      );
    }
    return (
      <>
        <div className="topbar">
          <div className="topbar-title" style={{ color: 'var(--ink-mute)', fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: 14 }}>
            新对话
          </div>
          <div className="topbar-actions">
            <button type="button" className="model-pill" onClick={openModelPicker}>
              <span className="dot" />
              {modelLabel(activeModel)}
            </button>
          </div>
        </div>
        <EmptyState
          composer={composer}
          onComposerChange={setComposer}
          onSubmit={() => {
            void sendChat();
          }}
          onPick={(copy) => {
            setComposer(copy);
          }}
          streaming={streaming}
          disabled={!activeModel || streaming}
          modelLabel={modelLabel(activeModel)}
          onModelClick={openModelPicker}
          attachments={attachments}
          onAttach={(files) => {
            void attachFiles(files);
          }}
          onRemoveAttachment={removeAttachment}
          noModel={!activeModel && bootstrap === 'ready'}
          onConfigureProviders={openSettings}
          recentConversation={conversations[0] ?? null}
          onResumeConversation={() => {
            const recent = conversations[0];
            if (recent) void openConversation(recent.id);
          }}
        />
      </>
    );
  }

  return (
    <div className="app" data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
      <Sidebar
        view={view}
        conversations={conversations}
        activeConversationId={activeConversationId}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((current) => !current)}
        onNewChat={newChat}
        onSelectConversation={(id) => {
          void openConversation(id);
        }}
        onRenameConversation={async (conversation) => {
          const next = await dialog.prompt({
            title: '重命名对话',
            defaultValue: conversation.title ?? '',
            placeholder: '取个名字…',
            okLabel: '保存',
          });
          if (next) {
            void updateConversation(conversation.id, { title: next });
          }
        }}
        onTogglePin={(conversation) => {
          void updateConversation(conversation.id, { pinned: !conversation.pinned });
        }}
        onArchiveConversation={(conversation) => {
          void updateConversation(conversation.id, { archived: true });
        }}
        onDeleteConversation={(conversation) => {
          void removeConversation(conversation.id);
        }}
        onOpenFeatures={() => openFeatures()}
        onOpenSettings={openSettings}
        onOpenPalette={() => setPaletteOpen(true)}
        todayUsd={todayUsd}
        onOpenCost={() => openFeatures('cost')}
      />
      <main className="main">{renderMain()}</main>
      {modelPickerOpen && (
        <ComposerModelPicker
          models={chatModels}
          providers={providers}
          selectedModelId={activeModel?.id ?? null}
          onSelect={selectComposerModel}
          onManage={() => {
            setModelPickerOpen(false);
            openSettings();
          }}
          onClose={() => setModelPickerOpen(false)}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          models={chatModels}
          providers={providers}
          conversations={conversations}
          activeModelId={activeModel?.id ?? null}
          streaming={streaming}
          currentTheme={prefs.theme}
          onClose={() => setPaletteOpen(false)}
          onNewChat={newChat}
          onOpenConversation={(id) => {
            void openConversation(id);
          }}
          onSelectModel={selectComposerModel}
          onOpenFeatures={() => openFeatures()}
          onOpenSettings={openSettings}
          onToggleTheme={() =>
            setPrefs((current) => ({
              ...current,
              theme: current.theme === 'dark' ? 'light' : 'dark',
            }))
          }
          onStop={stopStreaming}
        />
      )}
    </div>
  );
}

function ComposerModelPicker(props: {
  models: Model[];
  providers: Provider[];
  selectedModelId: string | null;
  onSelect: (model: Model) => void;
  onManage: () => void;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props.onClose]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleModels = useMemo(
    () => props.models.filter((model) => {
      if (!normalizedQuery) return true;
      return [
        modelLabel(model),
        model.model_name,
        providerLabelFor(model, props.providers),
      ].join(' ').toLowerCase().includes(normalizedQuery);
    }),
    [normalizedQuery, props.models, props.providers],
  );

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="modal model-switcher"
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-model-picker-title"
        onMouseDown={(event) => event.stopPropagation()}
        data-testid="composer-model-picker"
      >
        <div className="modal-head">
          <div>
            <div className="title" id="composer-model-picker-title">切换对话模型</div>
            <div className="sub">只影响之后发送的消息，不会修改服务商或模型配置。</div>
          </div>
          <button type="button" className="icon-btn" onClick={props.onClose} title="关闭">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="modal-body model-switcher-body">
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="搜索模型或服务商"
            aria-label="搜索模型或服务商"
            data-testid="composer-model-search"
          />
          <div className="model-switcher-list">
            {visibleModels.map((model) => {
              const active = model.id === props.selectedModelId;
              return (
                <button
                  key={model.id}
                  type="button"
                  className={`model-switcher-option${active ? ' active' : ''}`}
                  onClick={() => props.onSelect(model)}
                  data-testid={`composer-model-option-${model.id}`}
                >
                  <span className="model-switcher-radio">
                    {active && <Icon name="check" size={12} />}
                  </span>
                  <span className="model-switcher-main">
                    <strong>{modelLabel(model)}</strong>
                    <span>{providerLabelFor(model, props.providers)} · {model.model_name}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-quiet" onClick={props.onManage} data-testid="composer-model-manage">
            管理模型
          </button>
          <span className="spacer" />
          <button type="button" className="btn-quiet" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
