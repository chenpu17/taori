import { useChat } from '@ai-sdk/react';
import { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { getSidecarEndpoint, authedFetch } from './sidecar.js';
import { api, isCostConfirmationRequiredError } from './api.js';
import { Onboarding } from './Onboarding.js';
import { ControlCenter } from './ControlCenter.js';
import type { ControlCenterSection } from './ControlCenter.js';
import { HelpCenter } from './HelpCenter.js';
import { CommandPalette } from './CommandPalette.js';
import { DiscoverableTip, TIPS, shouldShowTip } from './DiscoverableTip.js';
import { EmptyState } from './EmptyState.js';
import { StatusNotice } from './StatusNotice.js';
import { TaoriIcon } from './TaoriIcon.js';
import { ThemeToggle } from './ThemeToggle.js';
import { RoundtableLaunchDialog } from './Roundtable.js';
import { RoundtablePanel } from './RoundtablePanel.js';
import { priceTier, PRICE_TIER_LABEL, formatUsd, estimateInputTokens, estimateCostUsd } from '@taori/shared';
import type {
  ContextSource,
  EffectiveTool,
  Model,
  ModelHealthRow,
  Persona,
  PromptTemplate,
  Provider,
  RecoverRunRequest,
  RunEvent,
  Tool,
  WorkflowRecipe,
} from '@taori/shared';
import { MarkdownView } from './MarkdownView.js';
import { modelBaseDisplayName, modelDisplayWithProvider } from './modelDisplay.js';
import {
  hasQuickCompareToolIntent,
  isQuickCompareEligibleModel,
  applyQuickCompareAnnotation,
  messageRoleLabel,
  parseChatMetaAnnotation,
  pickFastAlternativeModel,
  slowResponseThresholdMs,
  toChatMessage,
  type ChatMessage,
  type QuickCompareUiState,
} from './chatViewModel.js';

declare global {
  interface Window {
    __TAORI_AUTOMATION__?: {
      setActiveModel?: (id: string) => void;
    };
  }
}

interface CostRunFocusDetail {
  conversationId: string;
  runId: string;
  runEventId: string | null;
  costRecordId: string;
}

interface CostCallFocusDetail {
  costRecordId: string;
  runId: string | null;
  runEventId: string | null;
}

interface RunTimelineFocusTarget {
  runId: string;
  runEventId: string | null;
  costRecordId: string | null;
}

type MessageCost = {
  input_tokens: number | null;
  output_tokens: number | null;
  actual_usd: number | null;
};

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

const BUILTIN_WORKFLOW_TEMPLATES: Array<{
  id: string;
  name: string;
  description: string;
  content: string;
}> = [
  {
    id: 'workflow-web-research',
    name: '网页调研报告',
    description: '搜索/抓取资料后输出结构化结论',
    content:
      '请围绕 {{主题}} 做一次网页调研：先搜索公开资料，必要时抓取关键网页，再输出背景、关键发现、风险和下一步建议。',
  },
  {
    id: 'workflow-image-review',
    name: '图片生成并复核',
    description: '先生成视觉物料，再用视觉模型审稿',
    content:
      '请为 {{用途}} 生成一张视觉物料。生成后我会点击“理解这张图”进行复核，请最后给出设计修改建议。',
  },
  {
    id: 'workflow-decision-brief',
    name: '决策简报',
    description: '整理备选方案、分歧、风险和建议',
    content:
      '请针对 {{决策问题}} 输出一份决策简报：列出备选方案、评价标准、主要分歧、风险和推荐决策。',
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

const DISCOVERABLE_COST_TIP_THRESHOLD_USD = 0.01;
const ACTIVE_CHAT_MODEL_MEMORY_KEY = 'active_chat_model_id';
type MemoryScopeLabel = 'default' | 'global' | 'session';
type TemplateLike = Pick<PromptTemplate, 'name' | 'description' | 'content'>;
type WorkflowRecipeTemplateLike = TemplateLike & { recipe: WorkflowRecipe };

interface ToolTraceAnnotation {
  type: 'tool_trace';
  call_id?: string;
  tool?: string;
  label?: string;
  event?: 'start' | 'finish';
  input?: string;
  output?: string;
  ok?: boolean;
  duration_ms?: number;
}

interface ContextSnapshotAnnotation {
  type: 'context_snapshot';
  model_id?: string | null;
  context_sources?: ContextSource[];
  active_tool_names?: string[];
  disabled_tool_names?: string[];
  context_window?: {
    original_message_count: number;
    sent_message_count: number;
    omitted_message_count: number;
    estimated_input_tokens: number;
    budget_tokens: number | null;
    model_context_length: number | null;
    strategy: 'full' | 'sliding_window';
  } | null;
}

type ContextWindowStats = NonNullable<ContextSnapshotAnnotation['context_window']>;

interface ToolTraceStep {
  callId: string;
  tool: string;
  label: string;
  input: string | null;
  output: string | null;
  status: 'running' | 'ok' | 'error';
  durationMs: number | null;
}

interface GeneratedImage {
  file_id: string;
  content_type: string;
  width: number;
  height: number;
  prompt?: string;
  data_b64?: string;
}

function formatTokenCount(value: number | null): string {
  return value == null ? '—' : value.toLocaleString();
}

function imageDataUrl(img: Pick<GeneratedImage, 'content_type' | 'data_b64'>): string {
  return img.data_b64 ? `data:${img.content_type || 'image/png'};base64,${img.data_b64}` : '';
}

function generatedImageFilename(img: Pick<GeneratedImage, 'file_id' | 'prompt' | 'content_type'>): string {
  const raw = (img.prompt || img.file_id || 'generated-image')
    .slice(0, 48)
    .replace(/[\s/\\:*?"<>|]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const ext = img.content_type.includes('jpeg') ? 'jpg' : img.content_type.includes('webp') ? 'webp' : 'png';
  return `${raw || 'generated-image'}.${ext}`;
}

function formatLatencyMs(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 1_000) return `${Math.round(value)}ms`;
  return value < 10_000 ? `${(value / 1_000).toFixed(1)}s` : `${Math.round(value / 1_000)}s`;
}

function currentBudgetMonthKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function currentBudgetDayKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function extractTemplateVariables(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of content.matchAll(/{{\s*([A-Za-z0-9_\-.:\u4e00-\u9fa5]+)\s*}}/g)) {
    const key = match[1]?.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function fillTemplateContent(
  template: TemplateLike,
  answers: Record<string, string>,
): string {
  return template.content.replace(
    /{{\s*([A-Za-z0-9_\-.:\u4e00-\u9fa5]+)\s*}}/g,
    (_match: string, key: string) => answers[key.trim()] ?? '',
  );
}

function toolTraceStepsFromAnnotations(annotations: Array<Record<string, unknown>>): ToolTraceStep[] {
  const steps = new Map<string, ToolTraceStep>();
  for (const raw of annotations) {
    if (raw?.type !== 'tool_trace') continue;
    const ann = raw as unknown as ToolTraceAnnotation;
    const callId = ann.call_id || `${ann.tool ?? 'tool'}-${steps.size}`;
    const prev = steps.get(callId);
    const label = ann.label || ann.tool || '工具调用';
    const next: ToolTraceStep = prev ?? {
      callId,
      tool: ann.tool || 'tool',
      label,
      input: null,
      output: null,
      status: 'running',
      durationMs: null,
    };
    if (ann.tool) next.tool = ann.tool;
    if (ann.label) next.label = ann.label;
    if (typeof ann.input === 'string') next.input = ann.input;
    if (typeof ann.output === 'string') next.output = ann.output;
    if (ann.event === 'finish') next.status = ann.ok === false ? 'error' : 'ok';
    if (typeof ann.duration_ms === 'number' && Number.isFinite(ann.duration_ms)) {
      next.durationMs = ann.duration_ms;
    }
    steps.set(callId, next);
  }
  return [...steps.values()];
}

function isExpectedStopError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /aborted|aborterror|econnreset|network error/i.test(message);
}

function isExpectedUserStopError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return isExpectedStopError(error) || /provider_error\/unknown:\s*Unknown error/i.test(message);
}

const USER_STOP_PENDING_KEY = 'taori.stream.user_stop_pending';
const PENDING_PERSONA_DRAFT_KEY = 'taori.persona.pending';

function setUserStopPending(value: boolean): void {
  try {
    if (value) {
      sessionStorage.setItem(USER_STOP_PENDING_KEY, '1');
    } else {
      sessionStorage.removeItem(USER_STOP_PENDING_KEY);
    }
  } catch {
    /* ignore storage failures */
  }
}

function hasUserStopPending(): boolean {
  try {
    return sessionStorage.getItem(USER_STOP_PENDING_KEY) === '1';
  } catch {
    return false;
  }
}

function getPendingPersonaDraft(): string {
  try {
    return sessionStorage.getItem(PENDING_PERSONA_DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function setPendingPersonaDraft(value: string): void {
  try {
    if (value) {
      sessionStorage.setItem(PENDING_PERSONA_DRAFT_KEY, value);
    } else {
      sessionStorage.removeItem(PENDING_PERSONA_DRAFT_KEY);
    }
  } catch {
    /* ignore storage failures */
  }
}

function contextSnapshotFromAnnotations(
  annotations: Array<Record<string, unknown>>,
): ContextSnapshotAnnotation | null {
  const snapshot = annotations.find((raw) => raw?.type === 'context_snapshot');
  return snapshot ? (snapshot as unknown as ContextSnapshotAnnotation) : null;
}

function messageContextSummary(
  snapshot: ContextSnapshotAnnotation | null,
): string {
  const parts: string[] = [];
  if (snapshot?.model_id) parts.push('模型');
  const persona = snapshot?.context_sources?.find((source) => source.type === 'persona');
  if (persona?.active) parts.push(`Persona：${persona.label}`);
  const activeToolCount = snapshot?.active_tool_names?.length ?? 0;
  if (activeToolCount > 0) parts.push(`${activeToolCount} 个工具可见`);
  const omitted = snapshot?.context_window?.omitted_message_count ?? 0;
  if (omitted > 0) parts.push(`裁剪 ${omitted} 条`);
  return parts.length > 0 ? parts.join(' · ') : '上下文';
}

function comparableModelUnitPrice(model: Model): number | null {
  const value = model.price_per_call ?? model.price_input_per_1m ?? null;
  return value != null && Number.isFinite(value) ? value : null;
}

function isTemporarilyDisabledModel(model: Model, now = Date.now()): boolean {
  return model.disabled_until != null && model.disabled_until > now;
}

function pickPreferredChatModel(models: Model[], now = Date.now()): Model | null {
  const selectable = models.filter((model) => !isTemporarilyDisabledModel(model, now));
  return (
    selectable.find((model) => model.is_default_for === 'chat')
    ?? selectable[0]
    ?? models.find((model) => model.is_default_for === 'chat')
    ?? models[0]
    ?? null
  );
}

function findKnownCheaperPeer(models: Model[], current: Model): Model | null {
  const currentPrice = comparableModelUnitPrice(current);
  if (currentPrice == null) return null;
  return models
    .filter((m) => {
      if (m.id === current.id) return false;
      if (m.capability !== current.capability) return false;
      if (m.demoted) return false;
      if (m.disabled_until && m.disabled_until > Date.now()) return false;
      const price = comparableModelUnitPrice(m);
      return price != null && price < currentPrice;
    })
    .sort((a, b) => comparableModelUnitPrice(a)! - comparableModelUnitPrice(b)!)[0] ?? null;
}

type BootState =
  | { kind: 'loading' }
  | { kind: 'onboarding' }
  | { kind: 'ready'; providers: Provider[]; chatModels: Model[]; defaultChatModel: Model; tools: Tool[] }
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
  const [controlCenterSection, setControlCenterSection] =
    useState<ControlCenterSection | null>(null);
  const [costCallFocus, setCostCallFocus] = useState<CostCallFocusDetail | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const overlayReturnFocusRef = useRef<HTMLElement | null>(null);
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

  const reload = useCallback(async (opts?: { silent?: boolean }): Promise<void> => {
    if (!opts?.silent) setBoot({ kind: 'loading' });
    try {
      const [{ providers }, { models }, toolsRes] = await Promise.all([
        api.listProviders(),
        api.listModels(),
        api.listTools(),
      ]);
      const enabled = providers.filter((p) => p.enabled);
      const providerIds = new Set(providers.map((p) => p.id));
      const chatModels = models.filter(
        (m) =>
          (m.capability === 'chat' || m.capability === 'multimodal') &&
          m.enabled &&
          m.provider_id != null &&
          providerIds.has(m.provider_id),
      );
      const def = pickPreferredChatModel(chatModels);
      if (enabled.length === 0 || !def) {
        setBoot({ kind: 'onboarding' });
      } else {
        setBoot({ kind: 'ready', providers, chatModels, defaultChatModel: def, tools: toolsRes.data });
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

  const rememberOverlayTrigger = useCallback((target?: EventTarget | null): void => {
    const candidate =
      target instanceof HTMLElement
        ? target
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    overlayReturnFocusRef.current = candidate;
  }, []);

  const restoreOverlayFocus = useCallback((): void => {
    const target = overlayReturnFocusRef.current;
    overlayReturnFocusRef.current = null;
    if (!target?.isConnected) return;
    window.requestAnimationFrame(() => target.focus());
  }, []);

  const openControlCenter = useCallback((section: ControlCenterSection, target?: EventTarget | null): void => {
    rememberOverlayTrigger(target);
    setControlCenterSection(section);
  }, [rememberOverlayTrigger]);

  const closeControlCenter = useCallback((): void => {
    setControlCenterSection(null);
    restoreOverlayFocus();
  }, [restoreOverlayFocus]);

  const openHelp = useCallback((target?: EventTarget | null): void => {
    rememberOverlayTrigger(target);
    setHelpOpen(true);
  }, [rememberOverlayTrigger]);

  const closeHelp = useCallback((): void => {
    setHelpOpen(false);
    restoreOverlayFocus();
  }, [restoreOverlayFocus]);

  useEffect(() => {
    const onCloseControlCenter = (): void => closeControlCenter();
    window.addEventListener('taori:close-control-center', onCloseControlCenter);
    return () => window.removeEventListener('taori:close-control-center', onCloseControlCenter);
  }, [closeControlCenter]);

  useEffect(() => {
    const onFocusCostCall = (event: Event): void => {
      const detail = (event as CustomEvent<CostCallFocusDetail>).detail;
      if (!detail?.costRecordId) return;
      setCostCallFocus({
        costRecordId: detail.costRecordId,
        runId: detail.runId ?? null,
        runEventId: detail.runEventId ?? null,
      });
      openControlCenter('costs');
    };
    window.addEventListener('taori:focus-cost-call', onFocusCostCall);
    return () => window.removeEventListener('taori:focus-cost-call', onFocusCostCall);
  }, [openControlCenter]);

  const onReopenOnboarding = useCallback((): void => {
    setControlCenterSection(null);
    setForceOnboarding(true);
    persistBrowseOnly(false);
  }, [persistBrowseOnly]);

  const onSettingsChanged = useCallback((): void => {
    void reload({ silent: true });
    window.dispatchEvent(new Event('taori:data-changed'));
  }, [reload]);

  const onModelsChanged = useCallback((): void => {
    void reload({ silent: true });
    window.dispatchEvent(new Event('taori:models-changed'));
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
          <ThemeToggle />
          <StatusBadge endpoint={endpoint} health={health} error={endpointError} />
          {endpoint && health?.ok && (
            <button
              type="button"
              className="settings-btn"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                window.setTimeout(() => openControlCenter('costs', e.currentTarget), 0);
              }}
              data-testid="open-cost-dashboard"
              aria-label="成本看板"
              title="成本看板"
            >
              💸
            </button>
          )}
          {endpoint && health?.ok && (
            <button
              type="button"
              className="settings-btn"
              onClick={(e) => openControlCenter('models', e.currentTarget)}
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
              onClick={(e) => openHelp(e.currentTarget)}
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
              onClick={(e) => openControlCenter('general', e.currentTarget)}
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
          {endpointError ? (
            <StatusNotice
              tone="error"
              title="连接 sidecar 失败"
              detail={endpointError}
              testId="boot-endpoint-error"
            />
          ) : (
            <StatusNotice
              tone="loading"
              title="Connecting to sidecar…"
              detail="正在探测本地 sidecar 端点与授权状态。"
              testId="boot-endpoint-loading"
            />
          )}
        </div>
      ) : boot.kind === 'loading' ? (
        <div className="placeholder">
          <StatusNotice
            tone="loading"
            title="加载中…"
            detail="正在同步模型、工具和会话数据。"
            testId="boot-loading"
          />
        </div>
      ) : boot.kind === 'error' ? (
        <div className="placeholder">
          <StatusNotice
            tone="error"
            title="启动失败"
            detail={boot.error}
            testId="boot-error"
          />
        </div>
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
          providers={boot.providers}
          chatModels={boot.chatModels}
          defaultModel={boot.defaultChatModel}
          tools={boot.tools}
          onOpenSettings={() => openControlCenter('general')}
          onOpenCostDashboard={() => openControlCenter('costs')}
          onOpenModelCenter={() => openControlCenter('models')}
          onOpenTools={() => openControlCenter('tools')}
          onOpenHelp={() => openHelp()}
          externalOverlayOpen={controlCenterSection != null || helpOpen}
        />
      ) : null}
      {controlCenterSection && (
        <ControlCenter
          initialSection={controlCenterSection}
          costCallFocus={costCallFocus}
          onCostCallFocusConsumed={() => setCostCallFocus(null)}
          onClose={closeControlCenter}
          onChanged={onSettingsChanged}
          onModelsChanged={onModelsChanged}
          onReopenOnboarding={onReopenOnboarding}
        />
      )}
      {helpOpen && <HelpCenter onClose={closeHelp} />}
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
      <EmptyState
        title="仅浏览模式"
        hint="尚未配置任何模型，暂时无法发起对话。"
        icon="🧭"
        testId="browse-only-empty"
      >
        <button type="button" onClick={onConfigure} data-testid="browse-only-configure">
          配置模型
        </button>
      </EmptyState>
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
  providers,
  chatModels,
  defaultModel,
  tools,
  onOpenSettings,
  onOpenCostDashboard,
  onOpenModelCenter,
  onOpenTools,
  onOpenHelp,
  externalOverlayOpen,
}: {
  endpoint: { url: string; bearer: string };
  providers: Provider[];
  chatModels: Model[];
  defaultModel: Model;
  tools: Tool[];
  onOpenSettings: () => void;
  onOpenCostDashboard: () => void;
  onOpenModelCenter: () => void;
  onOpenTools: () => void;
  onOpenHelp: () => void;
  externalOverlayOpen: boolean;
}): JSX.Element {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [activeModelId, setActiveModelId] = useState<string>(defaultModel.id);
  const [activeModelMemoryScope, setActiveModelMemoryScope] =
    useState<MemoryScopeLabel>('default');
  const activeModelSelectionVersionRef = useRef(0);
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
  const [roundtableLaunchSeq, setRoundtableLaunchSeq] = useState(0);
  const [timelineFocus, setTimelineFocus] = useState<RunTimelineFocusTarget | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const normalizeChatModelId = useCallback(
    (id: string | null | undefined): string | null => {
      if (!id) return null;
      const found = chatModels.find(
        (m) => m.id === id && m.enabled && !(m.disabled_until && m.disabled_until > Date.now()),
      );
      return found?.id ?? null;
    },
    [chatModels],
  );

  const persistActiveModel = useCallback(
    (id: string): void => {
      activeModelSelectionVersionRef.current += 1;
      setActiveModelId(id);
      const scopeId = activeConvId;
      setActiveModelMemoryScope(scopeId ? 'session' : 'global');
      void api
        .putMemory(
          scopeId ? 'session' : 'global',
          ACTIVE_CHAT_MODEL_MEMORY_KEY,
          id,
          scopeId,
        )
        .catch(() => {});
    },
    [activeConvId],
  );

  useEffect(() => {
    let cancelled = false;
    const selectionVersionAtStart = activeModelSelectionVersionRef.current;
    (async () => {
      try {
        let rememberedRaw: string | null = null;
        let scope: MemoryScopeLabel = 'default';
        if (activeConvId) {
          const session = await api.getMemory(
            'session',
            ACTIVE_CHAT_MODEL_MEMORY_KEY,
            activeConvId,
          );
          if (session.data.value) {
            rememberedRaw = session.data.value;
            scope = 'session';
          } else {
            const global = await api.getMemory('global', ACTIVE_CHAT_MODEL_MEMORY_KEY);
            if (global.data.value) {
              rememberedRaw = global.data.value;
              scope = 'global';
            }
          }
        } else {
          const global = await api.getMemory('global', ACTIVE_CHAT_MODEL_MEMORY_KEY);
          if (global.data.value) {
            rememberedRaw = global.data.value;
            scope = 'global';
          }
        }
        if (
          cancelled ||
          selectionVersionAtStart !== activeModelSelectionVersionRef.current
        ) {
          return;
        }
        const remembered = normalizeChatModelId(rememberedRaw);
        setActiveModelId(remembered ?? defaultModel.id);
        setActiveModelMemoryScope(remembered ? scope : 'default');
      } catch {
        if (
          !cancelled &&
          selectionVersionAtStart === activeModelSelectionVersionRef.current
        ) {
          setActiveModelId(defaultModel.id);
          setActiveModelMemoryScope('default');
        }
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeConvId, defaultModel.id, normalizeChatModelId]);

  useEffect(() => {
    const normalized = normalizeChatModelId(activeModelId);
    if (normalized == null) {
      setActiveModelId(defaultModel.id);
      setActiveModelMemoryScope('default');
    }
  }, [activeModelId, defaultModel.id, normalizeChatModelId]);

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

  useEffect(() => {
    const onDataChanged = (): void => {
      void refreshConversations();
    };
    window.addEventListener('taori:data-changed', onDataChanged);
    return () => window.removeEventListener('taori:data-changed', onDataChanged);
  }, [refreshConversations]);

  useEffect(() => {
    if (cmdPaletteOpen) {
      void refreshConversations();
    }
  }, [cmdPaletteOpen, refreshConversations]);

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
    setTimelineFocus(null);
    setActiveConvId(id);
    setChatKey((n) => n + 1);
  };

  useEffect(() => {
    const onFocusRun = (event: Event): void => {
      const detail = (event as CustomEvent<CostRunFocusDetail>).detail;
      if (!detail?.conversationId || !detail.runId) return;
      setActiveConvId(detail.conversationId);
      setTimelineFocus({
        runId: detail.runId,
        runEventId: detail.runEventId,
        costRecordId: detail.costRecordId,
      });
      setChatKey((n) => n + 1);
      window.dispatchEvent(new Event('taori:close-control-center'));
    };
    window.addEventListener('taori:focus-run-event', onFocusRun);
    return () => window.removeEventListener('taori:focus-run-event', onFocusRun);
  }, []);

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
          providers={providers}
          chatModels={chatModels}
          model={activeModel}
          tools={tools}
          modelMemoryScope={activeModelMemoryScope}
          onModelChange={persistActiveModel}
          conversationId={activeConvId}
          conversationType={
            conversations.find((c) => c.id === activeConvId)?.type ?? null
          }
          onConversationCreated={(id) => {
            setActiveConvId(id);
            void refreshConversations();
          }}
          onConversationUpdated={() => void refreshConversations()}
          onOpenSettings={onOpenSettings}
          onOpenModelCenter={onOpenModelCenter}
          onOpenTools={onOpenTools}
          externalOverlayOpen={externalOverlayOpen}
          roundtableLaunchSeq={roundtableLaunchSeq}
          timelineFocus={timelineFocus}
          onTimelineFocusConsumed={() => setTimelineFocus(null)}
          onLoopbackToConversation={(id) => {
            setActiveConvId(id);
            setTimelineFocus(null);
            void refreshConversations();
          }}
        />
      </main>
      <CommandPalette
        isOpen={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        onSelectConv={onSelectConv}
        onSelectModel={persistActiveModel}
        onNavigate={(path) => {
          if (path === '/settings') onOpenSettings();
          if (path === '/costs') onOpenCostDashboard();
          if (path === '/models') onOpenModelCenter();
        }}
        onOpenHelp={onOpenHelp}
        onOpenRoundtable={() => setRoundtableLaunchSeq((n) => n + 1)}
        conversations={conversations.map(c => ({ id: c.id, title: c.title, pinned: c.pinned, tags: c.tags }))}
        models={chatModels}
        providers={providers}
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

function conversationTypeLabel(type: string): string {
  if (type === 'roundtable') return '圆桌';
  if (type === 'chat') return '对话';
  return type;
}

function conversationTimeLabel(updated: number, now = Date.now()): string {
  const diff = Math.max(0, now - updated);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return '昨天';
  return new Date(updated).toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  });
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHighlightedText(text: string, query: string): JSX.Element | string {
  const trimmed = query.trim();
  if (!trimmed) return text;
  const matcher = new RegExp(`(${escapeRegExp(trimmed)})`, 'ig');
  const parts = text.split(matcher);
  if (parts.length === 1) return text;
  const lower = trimmed.toLocaleLowerCase();
  return (
    <>
      {parts.map((part, index) =>
        part.toLocaleLowerCase() === lower ? <mark key={`${part}-${index}`}>{part}</mark> : part,
      )}
    </>
  );
}

function renderConvRow(
  c: ConversationSummary,
  active: boolean,
  searchQuery: string,
  cb: ConvRowCallbacks,
): JSX.Element {
  const tags = parseTags(c.tags);
  const isEditingTags = cb.editingTagsForId === c.id;
  const checked = cb.selectedIds.has(c.id);
  const title = c.title?.trim() || '未命名对话';
  const metaType = conversationTypeLabel(c.type);
  const metaTime = conversationTimeLabel(c.updated_at);
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
        title={title}
      >
        {c.pinned ? <span className="conv-title-prefix" aria-hidden="true">📌</span> : null}
        <span className={`conv-title-text${c.title?.trim() ? '' : ' is-placeholder'}`}>
          {renderHighlightedText(title, searchQuery)}
        </span>
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
      <div className="conv-meta" aria-hidden="true">
        <span className={`conv-meta-type${c.type === 'roundtable' ? ' is-roundtable' : ''}`}>{metaType}</span>
        <span className="conv-meta-sep">·</span>
        <span className="conv-meta-time">{metaTime}</span>
      </div>
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
  searchQuery: string,
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
    for (const c of pinned) out.push(renderConvRow(c, c.id === activeId, searchQuery, cb));
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
    out.push(renderConvRow(c, c.id === activeId, searchQuery, cb));
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
            {searchQuery ? (
              <EmptyState
                title="没有匹配的对话"
                hint="试试换个关键词，或清空搜索查看全部对话。"
                icon="⌕"
                compact
                tone="muted"
                testId="conv-empty-search"
              />
            ) : (
              <EmptyState
                title="暂无对话"
                hint="试试上方“新对话”开始第一轮交流。"
                icon="💬"
                compact
                testId="conv-empty-default"
              />
            )}
          </li>
        ) : (
          renderGroupedConversations(conversations, activeId, searchQuery, cb)
        )}
      </ul>
    </aside>
  );
}

function ChatPanel({
  endpoint,
  providers,
  chatModels,
  model,
  tools,
  modelMemoryScope,
  onModelChange,
  conversationId,
  conversationType,
  onConversationCreated,
  onConversationUpdated,
  onOpenSettings,
  onOpenModelCenter,
  onOpenTools,
  externalOverlayOpen,
  roundtableLaunchSeq,
  timelineFocus,
  onTimelineFocusConsumed,
  onLoopbackToConversation,
}: {
  endpoint: { url: string; bearer: string };
  providers: Provider[];
  chatModels: Model[];
  model: Model;
  tools: Tool[];
  modelMemoryScope: MemoryScopeLabel;
  onModelChange: (id: string) => void;
  conversationId: string | null;
  conversationType: string | null;
  onConversationCreated: (id: string) => void;
  onConversationUpdated: () => void;
  onOpenSettings: () => void;
  onOpenModelCenter: () => void;
  onOpenTools: () => void;
  externalOverlayOpen: boolean;
  roundtableLaunchSeq: number;
  timelineFocus: RunTimelineFocusTarget | null;
  onTimelineFocusConsumed: () => void;
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
    Record<string, MessageCost>
  >({});
  // M2.5 §F-CR — when the LLM calls the `image_generate` tool inside a chat
  // turn, the sidecar streams a `tool_image_result` annotation we use to
  // render the produced image inline beneath the assistant bubble.
  const [imagesByMsg, setImagesByMsg] = useState<
    Record<string, GeneratedImage[]>
  >({});
  const [imageViewer, setImageViewer] = useState<{
    img: GeneratedImage;
    zoom: number;
  } | null>(null);
  const [realtime, setRealtime] = useState<{
    current_conversation_usd: number;
    current_conversation_calls: number;
    today_usd: number;
    month_usd: number;
  } | null>(null);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dropping, setDropping] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const pendingHasImage = pending.some((p) => p.kind === 'image');
  const [historyLoading, setHistoryLoading] = useState(false);
  // M2.1 — captures `failure_decision` annotations keyed by assistant
  // message id. We render a card below that message; we also use it to
  // drive the optional auto-fallback single-hop retry.
  const [failureByMsg, setFailureByMsg] = useState<Record<string, FailureDecision>>({});
  // Conversations that have already consumed their single auto-fallback
  // attempt — a second consecutive failure goes to the card (M2 §1.4).
  const autoFallbackUsedConvs = useRef<Set<string>>(new Set());
  // Before the first failed stream announces a stable conversation_id, the
  // guard below may only see "unknown". Keep a component-level latch so the
  // same chat thread cannot auto-hop twice during that window.
  const autoFallbackUsedInThread = useRef(false);
  // Track auto-fallback decisions we've already acted on to avoid re-firing
  // on every render. Keyed by message_id.
  const autoFallbackTriggeredMsgs = useRef<Set<string>>(new Set());
  // M2.1 — assistant message id of the most recent failure. useChat drops
  // the in-flight message on error (no `0:` text arrived), so we render a
  // synthetic placeholder + decision card keyed off this id.
  const [lastFailureMsgId, setLastFailureMsgId] = useState<string | null>(null);
  const preserveFailureForConversationRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pendingHasImage && dropError?.startsWith('已自动切换至视觉模型')) {
      setDropError(null);
    }
  }, [dropError, pendingHasImage]);

  const clearFailureDecisionState = useCallback((): void => {
    setFailureByMsg({});
    setLastFailureMsgId(null);
  }, []);

  const changeModelAndClearFailure = useCallback(
    (id: string): void => {
      clearFailureDecisionState();
      setDropError(null);
      onModelChange(id);
    },
    [clearFailureDecisionState, onModelChange],
  );

  useEffect(() => {
    window.__TAORI_AUTOMATION__ = {
      ...(window.__TAORI_AUTOMATION__ ?? {}),
      setActiveModel: changeModelAndClearFailure,
    };
    return () => {
      if (window.__TAORI_AUTOMATION__?.setActiveModel === changeModelAndClearFailure) {
        delete window.__TAORI_AUTOMATION__.setActiveModel;
      }
    };
  }, [changeModelAndClearFailure]);

  // M2.2 — L3 stream cost badge: live-tracked input/output token counts plus
  // an "expanded" toggle for the details panel. We update during streaming
  // by polling messages[last].content via setInterval throttled to 200ms.
  const [streamBadge, setStreamBadge] = useState<{
    inputTokens: number;
    outputTokens: number;
    estimateUsd: number;
  } | null>(null);
  const [streamBadgeOpen, setStreamBadgeOpen] = useState(false);
  const [modelHealthRows, setModelHealthRows] = useState<Map<string, ModelHealthRow>>(new Map());
  const [slowResponseWarning, setSlowResponseWarning] = useState<{
    elapsedMs: number;
    thresholdMs: number;
    suggestedModelId: string | null;
  } | null>(null);
  const slowResponseDismissedRef = useRef(false);

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
    reason: 'threshold' | 'image' | 'budget';
    model?: Model;
    allowCheaper?: boolean;
    blocked?: boolean;
    budget?: {
      monthly_budget_usd: number;
      month_spent_usd: number;
      daily_budget_usd?: number;
      day_spent_usd?: number;
      period?: 'month' | 'day';
    };
    onContinue: () => void;
    onCheaper: () => void;
    onCancel: () => void;
  } | null>(null);
  const [streamAutoResumeEnabled, setStreamAutoResumeEnabled] = useState(false);
  const streamAutoResumeEnabledRef = useRef(false);
  const currentStreamingRunIdRef = useRef<string | null>(null);
  const [pendingInterruptedRunId, setPendingInterruptedRunId] = useState<string | null>(null);

  useEffect(() => {
    streamAutoResumeEnabledRef.current = streamAutoResumeEnabled;
  }, [streamAutoResumeEnabled]);

  useEffect(() => {
    let cancelled = false;
    api.modelsHealth()
      .then((res) => {
        if (!cancelled) setModelHealthRows(new Map(res.rows.map((row) => [row.model_id, row])));
      })
      .catch((e) => {
        console.warn('[model health] load failed:', e);
      });
    return () => { cancelled = true; };
  }, [chatModels.length]);

  useEffect(() => {
    let cancelled = false;
    const loadStreamRecoverySetting = async (): Promise<void> => {
      try {
        const res = await api.getMemoryEffective('stream_auto_resume_enabled', null);
        if (!cancelled) setStreamAutoResumeEnabled(res.data.value === 'true');
      } catch (e) {
        if (!cancelled) {
          setStreamAutoResumeEnabled(false);
          console.warn('[stream recovery] setting load failed:', e);
        }
      }
    };
    void loadStreamRecoverySetting();
    const onChanged = (): void => {
      void loadStreamRecoverySetting();
    };
    window.addEventListener('taori:stream-recovery-settings-changed', onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('taori:stream-recovery-settings-changed', onChanged);
    };
  }, []);

  // M2.2 — session cost panel (right drawer). null = closed.
  const [costPanelScope, setCostPanelScope] = useState<'session' | 'today' | 'month' | null>(null);
  const [monthlyBudgetUsd, setMonthlyBudgetUsd] = useState<number | null>(null);
  const [monthlyBudgetHardLimit, setMonthlyBudgetHardLimit] = useState(false);
  const [budgetAlertState, setBudgetAlertState] = useState<{
    month: string;
    seen: number[];
  }>({ month: currentBudgetMonthKey(), seen: [] });
  const [dailyBudgetUsd, setDailyBudgetUsd] = useState<number | null>(null);
  const [dailyBudgetHardLimit, setDailyBudgetHardLimit] = useState(false);
  const [dailyBudgetAlertState, setDailyBudgetAlertState] = useState<{
    day: string;
    seen: number[];
  }>({ day: currentBudgetDayKey(), seen: [] });
  const [budgetToast, setBudgetToast] = useState<{
    threshold: 50 | 80 | 100;
    period: 'month' | 'day';
    budgetUsd: number;
    spentUsd: number;
  } | null>(null);

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
  const [imageGenerationStatus, setImageGenerationStatus] = useState<{
    prompt: string;
    modelId: string;
  } | null>(null);
  const [imageModels, setImageModels] = useState<Model[]>([]);
  const [selectedImageModelId, setSelectedImageModelId] = useState<string | null>(null);
  const [imageModelMemoryScope, setImageModelMemoryScope] =
    useState<MemoryScopeLabel>('default');
  const [imageModelPreferenceBusy, setImageModelPreferenceBusy] = useState(false);
  const [imageModelPreferenceError, setImageModelPreferenceError] = useState<string | null>(null);
  const [effectiveTools, setEffectiveTools] = useState<EffectiveTool[]>(
    () => tools.map((t) => ({ ...t, session_enabled: null, effective_enabled: t.enabled })),
  );
  const imageToolEnabled =
    effectiveTools.find((t) => t.name === 'builtin.image_generate')?.effective_enabled
    ?? tools.find((t) => t.name === 'builtin.image_generate')?.enabled
    ?? true;
  // M3.A.4 — roundtable launch dialog state. Open by clicking the "🔍 圆桌"
  // button next to send. After confirm, parent receives the roundtable id;
  // M3.A.5 will use it to swap chat-bubble view for the roundtable panel.
  const [roundtableDialog, setRoundtableDialog] = useState<{
    initialTopic: string;
  } | null>(null);
  const [quickCompare, setQuickCompare] = useState<QuickCompareUiState | null>(null);
  const [quickCompareAdoptingId, setQuickCompareAdoptingId] = useState<string | null>(null);
  const [activeRoundtableId, setActiveRoundtableId] = useState<string | null>(
    null,
  );
  const [associatedRoundtableId, setAssociatedRoundtableId] = useState<
    string | null
  >(null);
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>([]);
  const [workflowRecipes, setWorkflowRecipes] = useState<WorkflowRecipe[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string>(() => getPendingPersonaDraft());
  const [quickComparePickerOpen, setQuickComparePickerOpen] = useState(false);
  const [promptAssetsLoaded, setPromptAssetsLoaded] = useState(false);
  const activePersona = useMemo(
    () => personas.find((p) => p.id === selectedPersonaId) ?? null,
    [personas, selectedPersonaId],
  );
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [templateVarDraft, setTemplateVarDraft] = useState<{
    template: TemplateLike;
    vars: string[];
    answers: Record<string, string>;
  } | null>(null);
  const [recipeVarDraft, setRecipeVarDraft] = useState<{
    template: WorkflowRecipeTemplateLike;
    vars: string[];
    answers: Record<string, string>;
  } | null>(null);
  const [promptAssetsError, setPromptAssetsError] = useState<string | null>(null);
  const [sessionToolBusy, setSessionToolBusy] = useState<string | null>(null);
  const [profileCost, setProfileCost] = useState<{
    current_conversation_usd: number;
    current_conversation_calls: number;
  } | null>(null);
  const [runTimelineOpen, setRunTimelineOpen] = useState(false);
  const [runTimelineFocus, setRunTimelineFocus] = useState<RunTimelineFocusTarget | null>(null);
  const [runEvents, setRunEvents] = useState<RunEvent[] | null>(null);
  const [runEventsError, setRunEventsError] = useState<string | null>(null);
  const [queuedTips, setQueuedTips] = useState<Array<keyof typeof TIPS>>([]);
  const [activeTipId, setActiveTipId] = useState<keyof typeof TIPS | null>(null);
  // Wired up to openImagePicker after it's declared. Lets the failureFetch
  // tee reader fire the picker without needing the callback in scope.
  const capabilityRouteRef = useRef<
    ((route: {
      prompt: string;
      user_message_id: string;
      conversation_id: string | null;
    }) => Promise<void>) | null
  >(null);
  const queuedTipIdsRef = useRef<Set<keyof typeof TIPS>>(new Set());
  const tipSessionPrefixRef = useRef('taori.tip.session_seen.');

  // M2.1 — custom fetch that tees the chat response stream so we can capture
  // the `8:[{type:"failure_decision",...}]` annotation reliably even when
  // useChat discards the in-flight assistant message on error.
  const failureFetch = useCallback<typeof fetch>(async (input, init) => {
    currentStreamingRunIdRef.current = null;
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
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let pendingMsgId: string | null = null;
    let observedConversationId: string | null = null;
    let finalized = false;

    const finalizeObservedConversation = (): void => {
      if (finalized) return;
      finalized = true;
      // If the user aborts a first-turn stream before useChat.onFinish runs,
      // the parent still needs the server-created conversation id so the
      // sidebar selection and subsequent actions point at the persisted row.
      if (
        observedConversationId &&
        announcedConvIdRef.current !== observedConversationId
      ) {
        preserveFailureForConversationRef.current = observedConversationId;
        announcedConvIdRef.current = observedConversationId;
        onConversationCreated(observedConversationId);
      }
    };

    const processAnnotationLine = (rawLine: string): void => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith('8:')) return;
      try {
        const arr = JSON.parse(line.slice(2));
        if (!Array.isArray(arr)) return;
        for (const ann of arr) {
          const meta = ann && typeof ann === 'object'
            ? parseChatMetaAnnotation(ann as Record<string, unknown>)
            : null;
          if (meta?.message_id) {
            pendingMsgId = meta.message_id;
          }
          if (meta?.run_id) {
            currentStreamingRunIdRef.current = meta.run_id;
          }
          if (
            meta &&
            conversationIdRef.current !== meta.conversation_id
          ) {
            // Mirror to the ref only — invoking onConversationCreated here can
            // re-render mid-stream and disrupt useChat's in-flight error flow.
            conversationIdRef.current = meta.conversation_id;
            observedConversationId = meta.conversation_id;
          }
          if (ann?.type === 'failure_decision' && pendingMsgId) {
            const decision: FailureDecision = {
              classification: ann.classification as FailureClassification,
              current_model_id: (ann.current_model_id as string | null) ?? null,
              recommended_model_id: (ann.recommended_model_id as string | null) ?? null,
              auto_fallback_enabled: ann.auto_fallback_enabled === true,
              detail: typeof ann.detail === 'string' ? (ann.detail as string) : undefined,
              can_compact_context: ann.can_compact_context === true,
              can_skip_tool: ann.can_skip_tool === true,
              tool_name: typeof ann.tool_name === 'string' ? ann.tool_name : null,
              tool_label: typeof ann.tool_label === 'string' ? ann.tool_label : null,
            };
            const id = pendingMsgId;
            setFailureByMsg((prev) => (prev[id] ? prev : { ...prev, [id]: decision }));
            setLastFailureMsgId(id);
          }
          // M2.4 — explicit image-command path. The sidecar emits NO text
          // (no `0:` frame) so useChat's onFinish handler may never see it.
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
            queueMicrotask(() => void capabilityRouteRef.current?.(route));
          }
        }
      } catch {
        /* ignore parse errors */
      }
    };

    const processChunk = (value: Uint8Array): void => {
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        processAnnotationLine(line);
      }
    };

    const tappedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            const tail = decoder.decode();
            if (tail) buf += tail;
            if (buf) {
              processAnnotationLine(buf);
              buf = '';
            }
            finalizeObservedConversation();
            controller.close();
            return;
          }
          if (value) {
            processChunk(value);
            controller.enqueue(value);
          }
        } catch (e) {
          finalizeObservedConversation();
          controller.error(e);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          finalizeObservedConversation();
        }
      },
    });

    return new Response(tappedBody, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }, [onConversationCreated]);

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composerComposingRef = useRef(false);
  const composerCompositionEndedAtRef = useRef(0);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const lastUserStopAtRef = useRef(0);

  const loadImageModels = useCallback(async (): Promise<Model[]> => {
    const res = await api.listModels();
    const imgModels = res.models
      .filter((m) => m.capability === 'image' && m.enabled && m.provider_id != null)
      .sort(
        (a, b) =>
          (a.price_per_call ?? a.price_per_image ?? 0) -
            (b.price_per_call ?? b.price_per_image ?? 0) ||
          a.fallback_order - b.fallback_order,
      );
    setImageModels(imgModels);
    return imgModels;
  }, []);

  const normalizeImageModelId = useCallback(
    (id: string | null | undefined): string | null => {
      if (!id) return null;
      return imageModels.find((m) => m.id === id)?.id ?? null;
    },
    [imageModels],
  );

  const selectedImageModel = useMemo(
    () =>
      (selectedImageModelId
        ? imageModels.find((m) => m.id === selectedImageModelId)
        : null) ??
      imageModels[0] ??
      null,
    [imageModels, selectedImageModelId],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (imageModels.length === 0) {
        setSelectedImageModelId(null);
        setImageModelMemoryScope('default');
        return;
      }
      try {
        let rememberedRaw: string | null = null;
        let scope: MemoryScopeLabel = 'default';
        if (conversationId) {
          const session = await api.getMemory('session', 'image_model', conversationId);
          if (session.data.value) {
            rememberedRaw = session.data.value;
            scope = 'session';
          }
        }
        if (!rememberedRaw) {
          const global = await api.getMemory('global', 'image_model_default');
          if (global.data.value) {
            rememberedRaw = global.data.value;
            scope = 'global';
          }
        }
        if (cancelled) return;
        const remembered = normalizeImageModelId(rememberedRaw);
        setSelectedImageModelId(remembered);
        setImageModelMemoryScope(remembered ? scope : 'default');
      } catch {
        if (!cancelled) {
          setSelectedImageModelId(null);
          setImageModelMemoryScope('default');
        }
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId, imageModels, normalizeImageModelId]);

  const persistImageModelPreference = useCallback(
    async (modelId: string): Promise<void> => {
      const normalized = normalizeImageModelId(modelId);
      if (!normalized) return;
      const conv = conversationIdRef.current ?? conversationId;
      const scope: MemoryScopeLabel = conv ? 'session' : 'global';
      setSelectedImageModelId(normalized);
      setImageModelMemoryScope(scope);
      setImageModelPreferenceError(null);
      setImageModelPreferenceBusy(true);
      try {
        if (conv) {
          await api.putMemory('session', 'image_model', normalized, conv);
        } else {
          await api.putMemory('global', 'image_model_default', normalized);
        }
      } catch (e) {
        setImageModelPreferenceError(e instanceof Error ? e.message : '图像模型偏好保存失败');
      } finally {
        setImageModelPreferenceBusy(false);
      }
    },
    [conversationId, normalizeImageModelId],
  );

  const clearImageModelPreference = useCallback(async (): Promise<void> => {
    const conv = conversationIdRef.current ?? conversationId;
    const scope = imageModelMemoryScope;
    if (scope === 'default') return;
    setImageModelPreferenceError(null);
    setImageModelPreferenceBusy(true);
    try {
      if (scope === 'session' && conv) {
        await api.deleteMemory('session', 'image_model', conv);
      } else {
        await api.deleteMemory('global', 'image_model_default');
      }
      setSelectedImageModelId(null);
      setImageModelMemoryScope('default');
    } catch (e) {
      setImageModelPreferenceError(e instanceof Error ? e.message : '图像模型偏好清除失败');
    } finally {
      setImageModelPreferenceBusy(false);
    }
  }, [conversationId, imageModelMemoryScope]);

  useEffect(() => {
    let cancelled = false;
    loadImageModels().catch((e) => {
      if (!cancelled) console.warn('[capability preflight] image models load failed', e);
    });
    const onChanged = (): void => {
      loadImageModels().catch((e) =>
        console.warn('[capability preflight] image models reload failed', e),
      );
    };
    window.addEventListener('taori:models-changed', onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('taori:models-changed', onChanged);
    };
  }, [loadImageModels]);

  const hasSeenTipThisSession = useCallback((tipId: keyof typeof TIPS): boolean => {
    try {
      return sessionStorage.getItem(`${tipSessionPrefixRef.current}${tipId}`) === '1';
    } catch {
      return false;
    }
  }, []);

  const markTipSeenThisSession = useCallback((tipId: keyof typeof TIPS): void => {
    try {
      sessionStorage.setItem(`${tipSessionPrefixRef.current}${tipId}`, '1');
    } catch {
      /* ignore */
    }
  }, []);

  const enqueueTip = useCallback((tipId: keyof typeof TIPS): void => {
    const tip = TIPS[tipId];
    if (!shouldShowTip(tip.storageKey) || hasSeenTipThisSession(tipId)) return;
    if (activeTipId === tipId || queuedTipIdsRef.current.has(tipId)) return;
    queuedTipIdsRef.current.add(tipId);
    setQueuedTips((prev) => [...prev, tipId]);
  }, [activeTipId, hasSeenTipThisSession]);

  useEffect(() => {
    const tipStorageKeyToId = new Map(
      Object.entries(TIPS).map(([tipId, tip]) => [tip.storageKey, tipId as keyof typeof TIPS]),
    );
    const onStorage = (event: StorageEvent): void => {
      if (event.storageArea !== localStorage || !event.key || !event.newValue) return;
      const tipId = tipStorageKeyToId.get(event.key);
      if (!tipId) return;
      queuedTipIdsRef.current.delete(tipId);
      setQueuedTips((prev) => prev.filter((queuedTipId) => queuedTipId !== tipId));
      setActiveTipId((prev) => (prev === tipId ? null : prev));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const loadPromptAssets = useCallback(async (): Promise<void> => {
    try {
      const [templatesRes, personasRes, recipesRes] = await Promise.all([
        api.listPromptTemplates(),
        api.listPersonas(),
        api.listWorkflowRecipes(),
      ]);
      setPromptTemplates(templatesRes.prompt_templates);
      setPersonas(personasRes.personas);
      setWorkflowRecipes(recipesRes.workflow_recipes.filter((recipe) => recipe.enabled));
      setPromptAssetsLoaded(true);
      setSelectedPersonaId((prev) => {
        if (!prev) return prev;
        if (personasRes.personas.some((persona) => persona.id === prev)) return prev;
        if (!conversationIdRef.current) setPendingPersonaDraft('');
        return '';
      });
      setPromptAssetsError(null);
    } catch (e) {
      setPromptAssetsError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadPromptAssets();
    const onChanged = (): void => {
      void loadPromptAssets();
    };
    window.addEventListener('taori:prompt-assets-changed', onChanged);
    return () => window.removeEventListener('taori:prompt-assets-changed', onChanged);
  }, [loadPromptAssets]);

  useEffect(() => {
    if (!promptAssetsLoaded || !selectedPersonaId || activePersona) return;
    setSelectedPersonaId('');
  }, [activePersona, promptAssetsLoaded, selectedPersonaId]);

  useEffect(() => {
    let cancelled = false;
    if (!conversationId) {
      setSelectedPersonaId(getPendingPersonaDraft());
      return;
    }
    setPendingPersonaDraft('');
    api
      .getMemoryEffective('active_persona_id', conversationId)
      .then((res) => {
        if (!cancelled) {
          setSelectedPersonaId(res.data.value ?? '');
        }
      })
      .catch(() => {
        if (!cancelled) setSelectedPersonaId('');
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const refreshEffectiveTools = useCallback(async (): Promise<void> => {
    try {
      const res = await api.listEffectiveTools(conversationId);
      setEffectiveTools(res.data);
    } catch {
      setEffectiveTools(
        tools.map((t) => ({
          ...t,
          session_enabled: null,
          effective_enabled: t.enabled,
        })),
      );
    }
  }, [conversationId, tools]);

  useEffect(() => {
    void refreshEffectiveTools();
  }, [refreshEffectiveTools]);

  const refreshRunTimeline = useCallback(async (): Promise<void> => {
    if (!conversationId) {
      setRunEvents(null);
      setRunEventsError(null);
      return;
    }
    try {
      const res = await api.getConversationRunEvents(conversationId);
      setRunEvents(res.data.events);
      setRunEventsError(null);
    } catch (e) {
      setRunEventsError(e instanceof Error ? e.message : String(e));
    }
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) {
      setRunTimelineOpen(false);
      setRunEvents(null);
      setRunEventsError(null);
      return;
    }
    void refreshRunTimeline();
  }, [conversationId, refreshRunTimeline]);

  useEffect(() => {
    let cancelled = false;
    if (!conversationId) {
      setProfileCost(null);
      return;
    }
    api.getConversationProfile(conversationId)
      .then((res) => {
        if (cancelled) return;
        setEffectiveTools(res.data.effective_tools);
        setProfileCost(res.data.cost);
      })
      .catch(() => {
        if (!cancelled) setProfileCost(null);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, selectedPersonaId]);

  const setSessionToolOverride = useCallback(
    async (name: string, enabled: boolean | null): Promise<void> => {
      if (!conversationId) return;
      setSessionToolBusy(name);
      try {
        const res = await api.setSessionToolEnabled(name, conversationId, enabled);
        setEffectiveTools((prev) =>
          prev.map((toolItem) => (toolItem.name === name ? res.data : toolItem)),
        );
      } finally {
        setSessionToolBusy(null);
      }
    },
    [conversationId],
  );

  const applyTemplate = useCallback(
    async (template: TemplateLike): Promise<void> => {
      const vars = extractTemplateVariables(template.content);
      if (vars.length > 0) {
        setTemplateVarDraft({ template, vars, answers: {} });
        setTemplatePickerOpen(false);
        return;
      }
      const next = fillTemplateContent(template, {});
      setInput((prev) => (prev.trim() ? `${prev}\n\n${next}` : next));
      setTemplatePickerOpen(false);
    },
    [],
  );

  const insertTemplateWithAnswers = useCallback(
    (template: TemplateLike, answers: Record<string, string>): void => {
      const next = fillTemplateContent(template, answers);
      setInput((prev) => (prev.trim() ? `${prev}\n\n${next}` : next));
      setTemplateVarDraft(null);
    },
    [],
  );

  const insertRecipeWithAnswers = useCallback(
    async (recipe: WorkflowRecipe, answers: Record<string, string>): Promise<void> => {
      setActionError(null);
      try {
        const preview = await api.applyWorkflowRecipePreview(recipe.id, {
          variables: answers,
          conversation_id: conversationId,
          current_model_id: model.id,
        });
        if (preview.missing_variables.length > 0) {
          setActionError(`Recipe 缺少变量：${preview.missing_variables.join('、')}`);
          return;
        }
        setInput((prev) => (prev.trim() ? `${prev}\n\n${preview.prompt}` : preview.prompt));
        setRecipeVarDraft(null);
        setTemplatePickerOpen(false);
      } catch (e) {
        setActionError(e instanceof Error ? e.message : '套用 Recipe 失败');
      }
    },
    [conversationId, model.id],
  );

  const applyRecipe = useCallback(
    (recipe: WorkflowRecipe): void => {
      const declared = recipe.spec.variables.map((variable) => variable.name);
      const extracted = extractTemplateVariables(recipe.spec.prompt_template);
      const vars = Array.from(new Set([...declared, ...extracted]));
      const template: WorkflowRecipeTemplateLike = {
        recipe,
        name: recipe.name,
        description: recipe.description,
        content: recipe.spec.prompt_template,
      };
      if (vars.length === 0) {
        void insertRecipeWithAnswers(recipe, {});
        return;
      }
      setRecipeVarDraft({
        template,
        vars,
        answers: Object.fromEntries(
          recipe.spec.variables
            .filter((variable) => variable.default_value)
            .map((variable) => [variable.name, variable.default_value ?? '']),
        ),
      });
      setTemplatePickerOpen(false);
    },
    [insertRecipeWithAnswers],
  );

  const onPersonaChange = useCallback(
    async (nextId: string): Promise<void> => {
      setSelectedPersonaId(nextId);
      setPromptAssetsError(null);
      if (!conversationId) {
        setPendingPersonaDraft(nextId);
        return;
      }
      setPendingPersonaDraft('');
      try {
        if (nextId) {
          await api.putMemory(
            'session',
            'active_persona_id',
            nextId,
            conversationId,
          );
        } else {
          await api.deleteMemory('session', 'active_persona_id', conversationId);
        }
      } catch (e) {
        setPromptAssetsError(e instanceof Error ? e.message : String(e));
      }
    },
    [conversationId],
  );

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
  } = useChat({
    api: `${endpoint.url}/v1/chat`,
    streamProtocol: 'data',
    fetch: failureFetch,
    headers: { Authorization: `Bearer ${endpoint.bearer}` },
    body: {
      model_id: model.id,
      conversation_id: conversationId ?? undefined,
      ...(activePersona ? { persona_id: activePersona.id } : {}),
    },
    onError: (e) => {
      if ((lastUserStopAtRef.current > 0 || hasUserStopPending()) && isExpectedUserStopError(e)) {
        lastUserStopAtRef.current = 0;
        setUserStopPending(false);
        currentStreamingRunIdRef.current = null;
        console.info('[useChat] stream stopped by user');
        return;
      }
      if (isExpectedStopError(e)) {
        const interruptedRunId = currentStreamingRunIdRef.current;
        if (interruptedRunId) {
          setPendingInterruptedRunId(interruptedRunId);
          currentStreamingRunIdRef.current = null;
        }
        console.warn('[useChat] recoverable stream interruption:', e);
        return;
      }
      console.error('[useChat] onError:', e);
    },
    onFinish: (msg, opts) => {
      currentStreamingRunIdRef.current = null;
      setPendingInterruptedRunId(null);
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
              input_tokens: typeof a.input_tokens === 'number' ? (a.input_tokens as number) : null,
              output_tokens: typeof a.output_tokens === 'number' ? (a.output_tokens as number) : null,
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
        // M2.4 — explicit image-command path. Sidecar emitted only meta+capability_route.
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
      void refreshRunTimeline();
      window.setTimeout(() => void refreshRealtime(), 250);
      window.setTimeout(() => void refreshRealtime(), 1000);
      window.setTimeout(() => void refreshRunTimeline(), 400);
      // Notify the sidebar so newly-created or renamed conversations show up.
      onConversationUpdated();
    },
  });

  useEffect(() => {
    if (!isLoading) {
      slowResponseDismissedRef.current = false;
      setSlowResponseWarning(null);
      return;
    }
    const hasAssistantText = messages.some(
      (message) => message.role === 'assistant' && message.content.trim().length > 0,
    );
    if (hasAssistantText) {
      slowResponseDismissedRef.current = true;
      setSlowResponseWarning(null);
      return;
    }
    const thresholdMs = slowResponseThresholdMs(modelHealthRows.get(model.id));
    const timer = window.setTimeout(() => {
      if (slowResponseDismissedRef.current) return;
      const suggested = pickFastAlternativeModel(model, chatModels, modelHealthRows);
      setSlowResponseWarning({
        elapsedMs: thresholdMs,
        thresholdMs,
        suggestedModelId: suggested?.id ?? null,
      });
    }, thresholdMs);
    return () => window.clearTimeout(timer);
  }, [chatModels, isLoading, messages, model, modelHealthRows]);

  const withCurrentConversation = useCallback(
    (body: Record<string, unknown> = {}): Record<string, unknown> => {
      const currentConversationId = conversationIdRef.current;
      return {
        ...body,
        ...(currentConversationId ? { conversation_id: currentConversationId } : {}),
      };
    },
    [],
  );

  const regenerateWithCurrentConversation = useCallback(
    (body: Record<string, unknown> = {}): void => {
      void regenerate({ body: withCurrentConversation(body) });
    },
    [regenerate, withCurrentConversation],
  );

  useEffect(() => {
    if (roundtableLaunchSeq <= 0) return;
    setRoundtableDialog({ initialTopic: input.trim() });
  }, [roundtableLaunchSeq, input]);

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
      if (!imageToolEnabled) {
        setImagePicker(null);
        setImagePickerError(null);
        setDropError('图像生成工具已关闭。请到「控制中心 → 工具能力」启用后再生成图片。');
        return;
      }
      setImagePickerError(null);
      setDropError(null);
      // 1. Load all image-capable enabled models (filtered + price-sorted).
      let imgModels: Model[] = [];
      try {
        imgModels = await loadImageModels();
      } catch (e) {
        console.warn('[image picker] listModels failed', e);
      }
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
        (selectedImageModelId && imgModels.find((m) => m.id === selectedImageModelId)?.id) ??
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
    [imageToolEnabled, loadImageModels, onConversationCreated, selectedImageModelId],
  );

  // Wire ref so the failureFetch tee reader (declared earlier) can fire it.
  useEffect(() => {
    capabilityRouteRef.current = openImagePicker;
  }, [openImagePicker]);

  const scrollMessagesToLatest = useCallback((): (() => void) => {
    const run = () => {
      const el = messagesRef.current;
      if (!el) return;
      // Direct assignment is more deterministic than scrollTo() here because
      // the container has CSS smooth scrolling and history restore can happen
      // while React is still committing/removing transient loading content.
      el.scrollTop = el.scrollHeight;
      const last = el.lastElementChild;
      if (last instanceof HTMLElement) {
        last.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' });
        el.scrollTop = el.scrollHeight;
      }
    };
    run();
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      run();
      raf2 = window.requestAnimationFrame(run);
    });
    const t1 = window.setTimeout(run, 50);
    const t2 = window.setTimeout(run, 150);
    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);

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
    setImageGenerationStatus({ prompt, modelId });
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
        const mapped: ChatMessage[] = r.messages
          .filter((m) => m.role !== 'system')
          .map(toChatMessage);
        setMessages(mapped);
        // Populate imagesByMsg for any assistant messages that have image attachments.
        await loadImagesForMessages(r.messages);
      }
      void refreshRealtime();
      void refreshRunTimeline();
      setImagePicker(null);
    } catch (e) {
      setImagePickerError((e as Error).message ?? '请求失败');
    } finally {
      setImagePickerSubmitting(false);
      setImageGenerationStatus(null);
    }
  }, [setMessages, refreshRunTimeline]); // refreshRealtime is hoisted via useCallback below.

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
    const imageOverBudget =
      monthlyBudgetUsd != null
      && monthlyBudgetUsd > 0
      && realtime != null
      && realtime.month_usd >= monthlyBudgetUsd;
    if (imageOverBudget) {
      const im = imageModels.find((m) => m.id === modelId);
      if (im && monthlyBudgetUsd != null && realtime) {
        setImagePicker(null);
        setPendingConfirm({
          estimate: im.price_per_call ?? 0,
          reason: 'budget',
          model: im,
          budget: {
            monthly_budget_usd: monthlyBudgetUsd,
            month_spent_usd: realtime.month_usd,
          },
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
  }, [imagePicker, confirmPrefs, imageModels, monthlyBudgetUsd, realtime, runImageGenerate]);

  const attachGeneratedImageForVision = useCallback((img: {
    file_id: string;
    content_type: string;
    prompt?: string;
    data_b64?: string;
  }) => {
    if (!img.data_b64) {
      setDropError('图片数据仍在加载，请稍后再试。');
      return;
    }
    setPending((p) => [
      ...p,
      {
        kind: 'image',
        mime: img.content_type || 'image/png',
        name: `${(img.prompt ?? 'generated-image').slice(0, 40) || 'generated-image'}.png`,
        data_b64: img.data_b64!,
      },
    ]);
    if (!model.supports_vision) {
      const visionPick = chatModels.find(
        (m) => m.supports_vision && !m.demoted && !(m.disabled_until && m.disabled_until > Date.now()),
      );
      if (visionPick && visionPick.id !== model.id) {
        onModelChange(visionPick.id);
        setDropError(`已自动切换至视觉模型：${modelDisplayWithProvider(visionPick, providers)}`);
      } else {
        setDropError('当前模型不支持图片输入；请先配置或切换到带 👁 的视觉模型。');
      }
    } else {
      setDropError(null);
    }
    setInput((prev) =>
      prev.trim()
        ? prev
        : '请理解这张图片，描述其中的主体、风格和可能的用途。',
    );
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, [chatModels, model, onModelChange, providers, setInput]);

  const saveGeneratedImage = useCallback((img: GeneratedImage): void => {
    if (!img.data_b64) {
      setDropError('图片数据仍在加载，请稍后再试。');
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = imageDataUrl(img);
    anchor.download = generatedImageFilename(img);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, []);

  useEffect(() => {
    if (!imageViewer) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setImageViewer(null);
      }
      if ((e.key === '+' || e.key === '=') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setImageViewer((current) =>
          current ? { ...current, zoom: Math.min(3, current.zoom + 0.25) } : current,
        );
      }
      if (e.key === '-' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setImageViewer((current) =>
          current ? { ...current, zoom: Math.max(0.5, current.zoom - 0.25) } : current,
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [imageViewer]);

  // Wire the forward-ref so openImagePicker can auto-fire submit when the
  // session-memory shortcut applies (spec §7 step 7).
  useEffect(() => {
    submitImagePickerRef.current = () => {
      void submitImagePicker();
    };
  }, [submitImagePicker]);

  const loadConversationMessages = useCallback(async (
    id: string,
    isCancelled?: () => boolean,
  ): Promise<void> => {
    const res = await api.getConversationMessages(id);
    if (isCancelled?.()) return;
    const mapped: ChatMessage[] = res.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
      .map(toChatMessage);
    setMessages(mapped);
    scrollMessagesToLatest();
    await loadImagesForMessages(res.messages);
  }, [setMessages, loadImagesForMessages, scrollMessagesToLatest]);


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
    loadConversationMessages(conversationId, () => cancelled)
      .catch((e) => console.warn('[history] load failed:', e))
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, loadConversationMessages]);

  useEffect(() => {
    if (!timelineFocus || !conversationId || timelineFocus.runId.length === 0) return;
    setRunTimelineFocus(timelineFocus);
    setRunTimelineOpen(true);
    void refreshRunTimeline();
    onTimelineFocusConsumed();
  }, [conversationId, onTimelineFocusConsumed, refreshRunTimeline, timelineFocus]);

  // M3.A.5/A4 — roundtable conversations restore the full panel. Chat
  // conversations with loopback content keep the message history visible and
  // expose an explicit "view process" entry instead.
  useEffect(() => {
    if (!conversationId) {
      setActiveRoundtableId(null);
      setAssociatedRoundtableId(null);
      return;
    }
    let cancelled = false;
    api
      .getActiveRoundtableForConversation(conversationId)
      .then((res) => {
        if (cancelled) return;
        setAssociatedRoundtableId(res.roundtable_id);
        if (conversationType === 'roundtable') {
          setActiveRoundtableId(res.roundtable_id);
        } else if (conversationType != null) {
          setActiveRoundtableId(null);
        }
      })
      .catch((e) => console.warn('[roundtable] detect failed:', e));
    return () => {
      cancelled = true;
    };
  }, [conversationId, conversationType]);

  // M2.1 — when the user switches conversations, clear per-message
  // bookkeeping and the orphan-card binding so we don't accidentally render
  // an old failure card under the new conversation. We intentionally keep
  // `autoFallbackUsedConvs` populated: spec §1.4 line 103 says the
  // single-hop guard is **per conversation** and must survive switching
  // away and back, so a previously-consumed hop stays consumed.
  useEffect(() => {
    if (preserveFailureForConversationRef.current === conversationId) {
      preserveFailureForConversationRef.current = null;
      return;
    }
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

  const loadBudgetPrefs = useCallback(async (): Promise<void> => {
    try {
      const [
        budgetRes,
        alertRes,
        hardRes,
        dailyBudgetRes,
        dailyAlertRes,
        dailyHardRes,
      ] = await Promise.all([
        api.getMemoryEffective('monthly_budget_usd', null),
        api.getMemoryEffective('monthly_budget_alert_state', null),
        api.getMemoryEffective('monthly_budget_hard_limit', null),
        api.getMemoryEffective('daily_budget_usd', null),
        api.getMemoryEffective('daily_budget_alert_state', null),
        api.getMemoryEffective('daily_budget_hard_limit', null),
      ]);
      const rawBudget = budgetRes.data.value;
      const parsedBudget = rawBudget == null ? Number.NaN : Number(rawBudget);
      setMonthlyBudgetUsd(Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : null);
      setMonthlyBudgetHardLimit(hardRes.data.value === 'true');
      const currentMonth = currentBudgetMonthKey();
      let nextState = { month: currentMonth, seen: [] as number[] };
      if (alertRes.data.value) {
        try {
          const parsed = JSON.parse(alertRes.data.value) as {
            month?: string;
            seen?: number[];
          };
          nextState = {
            month: typeof parsed.month === 'string' ? parsed.month : currentMonth,
            seen: Array.isArray(parsed.seen)
              ? parsed.seen
                  .map((value) => Number(value))
                  .filter((value) => value === 50 || value === 80 || value === 100)
              : [],
          };
        } catch {
          nextState = { month: currentMonth, seen: [] };
        }
      }
      setBudgetAlertState(nextState);

      const rawDaily = dailyBudgetRes.data.value;
      const parsedDaily = rawDaily == null ? Number.NaN : Number(rawDaily);
      setDailyBudgetUsd(Number.isFinite(parsedDaily) && parsedDaily > 0 ? parsedDaily : null);
      setDailyBudgetHardLimit(dailyHardRes.data.value === 'true');
      const currentDay = currentBudgetDayKey();
      let nextDailyState = { day: currentDay, seen: [] as number[] };
      if (dailyAlertRes.data.value) {
        try {
          const parsed = JSON.parse(dailyAlertRes.data.value) as {
            day?: string;
            seen?: number[];
          };
          nextDailyState = {
            day: typeof parsed.day === 'string' ? parsed.day : currentDay,
            seen: Array.isArray(parsed.seen)
              ? parsed.seen
                  .map((value) => Number(value))
                  .filter((value) => value === 50 || value === 80 || value === 100)
              : [],
          };
        } catch {
          nextDailyState = { day: currentDay, seen: [] };
        }
      }
      setDailyBudgetAlertState(nextDailyState);
    } catch {
      setMonthlyBudgetUsd(null);
      setBudgetAlertState({ month: currentBudgetMonthKey(), seen: [] });
      setDailyBudgetUsd(null);
      setDailyBudgetAlertState({ day: currentBudgetDayKey(), seen: [] });
    }
  }, []);

  useEffect(() => {
    void loadBudgetPrefs();
    const onBudgetChanged = (): void => {
      void loadBudgetPrefs();
    };
    window.addEventListener('taori:budget-settings-changed', onBudgetChanged);
    return () => window.removeEventListener('taori:budget-settings-changed', onBudgetChanged);
  }, [loadBudgetPrefs]);

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
    if (!realtime || monthlyBudgetUsd == null || monthlyBudgetUsd <= 0) return;
    const currentMonth = currentBudgetMonthKey();
    const normalizedState =
      budgetAlertState.month === currentMonth
        ? budgetAlertState
        : { month: currentMonth, seen: [] as number[] };
    const ratio = realtime.month_usd / monthlyBudgetUsd;
    const threshold = ([100, 80, 50] as const).find(
      (value) => ratio >= value / 100 && !normalizedState.seen.includes(value),
    );
    if (budgetAlertState.month !== normalizedState.month && normalizedState.seen.length === 0) {
      setBudgetAlertState(normalizedState);
    }
    if (!threshold) return;
    const reachedThresholds = ([50, 80, 100] as const).filter(
      (value) => ratio >= value / 100,
    );
    const nextState = {
      month: currentMonth,
      seen: Array.from(new Set([...normalizedState.seen, ...reachedThresholds])).sort((a, b) => a - b),
    };
    setBudgetAlertState(nextState);
    setBudgetToast({
      threshold,
      period: 'month',
      budgetUsd: monthlyBudgetUsd,
      spentUsd: realtime.month_usd,
    });
    void api
      .putMemory('global', 'monthly_budget_alert_state', JSON.stringify(nextState))
      .catch(() => {});
  }, [realtime, monthlyBudgetUsd, budgetAlertState]);

  useEffect(() => {
    if (!realtime || dailyBudgetUsd == null || dailyBudgetUsd <= 0) return;
    const currentDay = currentBudgetDayKey();
    const normalizedState =
      dailyBudgetAlertState.day === currentDay
        ? dailyBudgetAlertState
        : { day: currentDay, seen: [] as number[] };
    const ratio = realtime.today_usd / dailyBudgetUsd;
    const threshold = ([100, 80, 50] as const).find(
      (value) => ratio >= value / 100 && !normalizedState.seen.includes(value),
    );
    if (dailyBudgetAlertState.day !== normalizedState.day && normalizedState.seen.length === 0) {
      setDailyBudgetAlertState(normalizedState);
    }
    if (!threshold) return;
    const reachedThresholds = ([50, 80, 100] as const).filter(
      (value) => ratio >= value / 100,
    );
    const nextState = {
      day: currentDay,
      seen: Array.from(new Set([...normalizedState.seen, ...reachedThresholds])).sort((a, b) => a - b),
    };
    setDailyBudgetAlertState(nextState);
    setBudgetToast({
      threshold,
      period: 'day',
      budgetUsd: dailyBudgetUsd,
      spentUsd: realtime.today_usd,
    });
    void api
      .putMemory('global', 'daily_budget_alert_state', JSON.stringify(nextState))
      .catch(() => {});
  }, [realtime, dailyBudgetUsd, dailyBudgetAlertState]);

  useEffect(() => {
    if (!budgetToast) return;
    const timer = window.setTimeout(() => setBudgetToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [budgetToast]);

  const tipBlocked =
    activeRoundtableId != null
    || roundtableDialog != null
    || imagePicker != null
    || pendingConfirm != null
    || quickCompare != null
    || quickComparePickerOpen
    || externalOverlayOpen;

  useEffect(() => {
    if (activeTipId || tipBlocked || queuedTips.length === 0) return;
    const [next, ...rest] = queuedTips;
    if (!next) return;
    queuedTipIdsRef.current.delete(next);
    markTipSeenThisSession(next);
    setQueuedTips(rest);
    setActiveTipId(next);
  }, [activeTipId, markTipSeenThisSession, queuedTips, tipBlocked]);

  useEffect(() => {
    if (activeRoundtableId || roundtableDialog || hasSeenTipThisSession('roundtable')) {
      return;
    }
    const t = window.setTimeout(() => enqueueTip('roundtable'), 600);
    return () => window.clearTimeout(t);
  }, [
    activeRoundtableId,
    enqueueTip,
    hasSeenTipThisSession,
    roundtableDialog,
  ]);

  useEffect(() => {
    if (!pending.some((p) => p.kind === 'image')) return;
    enqueueTip('image');
  }, [enqueueTip, pending]);

  useEffect(() => {
    if (!lastFailureMsgId || !failureByMsg[lastFailureMsgId]) return;
    enqueueTip('fallback');
    return scrollMessagesToLatest();
  }, [enqueueTip, failureByMsg, lastFailureMsgId, scrollMessagesToLatest]);

  useEffect(() => {
    if (!realtime || realtime.month_usd < DISCOVERABLE_COST_TIP_THRESHOLD_USD) {
      return;
    }
    enqueueTip('cost');
  }, [enqueueTip, realtime]);

  useEffect(() => {
    for (const m of messages) {
      const anns = (m as { annotations?: unknown[] }).annotations;
      if (!Array.isArray(anns)) continue;
      for (const a of anns as Array<Record<string, unknown>>) {
        const meta = parseChatMetaAnnotation(a);
        if (meta) {
          // Guard: when the parent prop has already moved on to a different
          // conversation (e.g. user branched / switched), stale streamed
          // messages must NOT re-lift the prior conv id back onto the parent.
          if (conversationId && conversationId !== meta.conversation_id) continue;
          if (conversationIdRef.current !== meta.conversation_id) {
            conversationIdRef.current = meta.conversation_id;
          }
          if (announcedConvIdRef.current !== meta.conversation_id) {
            announcedConvIdRef.current = meta.conversation_id;
            onConversationCreated(meta.conversation_id);
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
                    input_tokens: typeof a.input_tokens === 'number' ? (a.input_tokens as number) : null,
                    output_tokens: typeof a.output_tokens === 'number' ? (a.output_tokens as number) : null,
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
            detail: typeof a.detail === 'string' ? (a.detail as string) : undefined,
            can_compact_context: a.can_compact_context === true,
            can_skip_tool: a.can_skip_tool === true,
            tool_name: typeof a.tool_name === 'string' ? a.tool_name : null,
            tool_label: typeof a.tool_label === 'string' ? a.tool_label : null,
          };
          setFailureByMsg((prev) =>
            prev[m.id] ? prev : { ...prev, [m.id]: decision },
          );
          setLastFailureMsgId(m.id);
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
    if (autoFallbackUsedInThread.current) return;
    if (autoFallbackUsedConvs.current.has(conv)) return;
    const target = chatModels.find((m) => m.id === decision.recommended_model_id);
    if (!target) return;
    autoFallbackTriggeredMsgs.current.add(lastFailureMsgId);
    autoFallbackUsedInThread.current = true;
    autoFallbackUsedConvs.current.add(conv);
    const note = `已自动切换到「${modelBaseDisplayName(target)}」并重试。`;
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
    void (async () => {
      if (conversationIdRef.current) {
        await api.appendSystemMessage(conversationIdRef.current, note).catch(() => {});
        // Lift the conversation_id to React state so the next regenerate's
        // useChat body carries it (failed streams skip onFinish, so this
        // is the only place that announces convId after a failure path).
        if (announcedConvIdRef.current !== conversationIdRef.current) {
          announcedConvIdRef.current = conversationIdRef.current;
          onConversationCreated(conversationIdRef.current);
        }
      }
      changeModelAndClearFailure(target.id);
      window.setTimeout(() => {
        regenerateWithCurrentConversation({ model_id: target.id });
      }, 0);
    })();
  }, [
    failureByMsg,
    lastFailureMsgId,
    isLoading,
    chatModels,
    changeModelAndClearFailure,
    regenerateWithCurrentConversation,
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
    // are model-specific and ignored here; text/PDF attachments are approximated
    // from decoded byte length until the sidecar prepares the final prompt.
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
  const budgetRatio =
    monthlyBudgetUsd != null && monthlyBudgetUsd > 0 && realtime
      ? realtime.month_usd / monthlyBudgetUsd
      : null;
  const budgetLevel: 'none' | 'half' | 'warn' | 'over' =
    budgetRatio == null
      ? 'none'
      : budgetRatio >= 1
        ? 'over'
        : budgetRatio >= 0.8
          ? 'warn'
          : budgetRatio >= 0.5
            ? 'half'
            : 'none';
  const overBudget =
    monthlyBudgetUsd != null
    && monthlyBudgetUsd > 0
    && realtime != null
    && realtime.month_usd >= monthlyBudgetUsd;
  const overDailyBudget =
    dailyBudgetUsd != null
    && dailyBudgetUsd > 0
    && realtime != null
    && realtime.today_usd >= dailyBudgetUsd;
  const failureDecisionCount = Object.keys(failureByMsg).length;
  const hasMessageBoundFailure = useMemo(
    () => messages.some((m) => m.role === 'assistant' && Boolean(failureByMsg[m.id])),
    [failureByMsg, messages],
  );

  useLayoutEffect(() => {
    if (activeRoundtableId) return;
    return scrollMessagesToLatest();
  }, [
    activeRoundtableId,
    conversationId,
    failureDecisionCount,
    historyLoading,
    isLoading,
    lastFailureMsgId,
    messages.length,
    scrollMessagesToLatest,
  ]);

  // C1 — message-level actions: edit-and-resend + branch.
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<string>('');
  const [editBusy, setEditBusy] = useState(false);
  const [branchBusy, setBranchBusy] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeMsgActionsId, setActiveMsgActionsId] = useState<string | null>(null);

  // C2 — stop streaming + continue. wasStoppedRecently is set when the user
  // hits the composer "停止" button so the next assistant render can offer a
  // "续写" button. We reset it on conversation switch and when a new turn
  // starts (so a re-send hides the dangling continue affordance).
  const [wasStoppedRecently, setWasStoppedRecently] = useState(false);
  const [continueBusy, setContinueBusy] = useState(false);
  const [recoverBusy, setRecoverBusy] = useState<string | null>(null);
  useEffect(() => {
    setWasStoppedRecently(false);
    setQuickComparePickerOpen(false);
  }, [conversationId]);
  const onStopClick = useCallback((): void => {
    lastUserStopAtRef.current = Date.now();
    setUserStopPending(true);
    stop();
    setWasStoppedRecently(true);
    const refreshStoppedConversation = (): void => {
      const conv = conversationIdRef.current;
      if (!conv) return;
      void loadConversationMessages(conv).catch((e) =>
        console.warn('[stop] history refresh failed:', e),
      );
      onConversationUpdated();
    };
    window.setTimeout(refreshStoppedConversation, 250);
    window.setTimeout(refreshStoppedConversation, 1000);
  }, [loadConversationMessages, onConversationUpdated, stop]);
  const onContinueClick = useCallback(async (assistantMessageId?: string): Promise<void> => {
    if (continueBusy || isLoading) return;
    const conv = conversationIdRef.current;
    if (!conv) return;
    const finish = async (): Promise<void> => {
      await loadConversationMessages(conv);
      await refreshRunTimeline();
      void refreshRealtime();
      onConversationUpdated();
    };
    const runConfirmed = async (runId: string): Promise<void> => {
      await api.continueRun(runId, { confirmed_cost: true });
      await finish();
    };
    const execute = async (confirmedCost = false): Promise<void> => {
      const runsRes = await api.getConversationRuns(conv, 20);
      const run = runsRes.data.runs.find((item) =>
        item.status === 'incomplete' &&
        (!assistantMessageId || item.assistant_message_id === assistantMessageId),
      ) ?? runsRes.data.runs.find((item) => item.status === 'incomplete');
      if (!run) {
        throw new Error('没有找到可续写的中断运行');
      }
      const resumeState = await api.getRunResumeState(run.id);
      if (!resumeState.data.can_continue) {
        const reasonText =
          resumeState.data.recommended_action === 'switch_model'
            ? '原模型当前不可用，请切换模型后重试。'
            : resumeState.data.reason === 'still_streaming'
              ? '这条回复仍在生成中，请稍后再试。'
              : resumeState.data.reason === 'message_failed'
                ? '这条回复已失败，请使用重新生成或恢复操作。'
                : '这条回复当前不可续写。';
        throw new Error(reasonText);
      }
      try {
        await api.continueRun(run.id, confirmedCost ? { confirmed_cost: true } : undefined);
        await finish();
      } catch (e) {
        if (!confirmedCost && isCostConfirmationRequiredError(e)) {
          const targetModel = chatModels.find((item) => item.id === e.details.model_id) ?? model;
          setPendingConfirm({
            estimate: e.details.estimate_usd,
            reason: e.details.reason,
            model: targetModel,
            allowCheaper: false,
            blocked: e.details.blocked === true,
            budget: e.details.reason === 'budget'
              ? {
                  monthly_budget_usd: e.details.monthly_budget_usd ?? 0,
                  month_spent_usd: e.details.month_spent_usd ?? 0,
                  daily_budget_usd: e.details.daily_budget_usd ?? undefined,
                  day_spent_usd: e.details.day_spent_usd ?? undefined,
                  period: e.details.period,
                }
              : undefined,
            onContinue: () => {
              setPendingConfirm(null);
              setContinueBusy(true);
              void runConfirmed(run.id)
                .catch((err) => setActionError(err instanceof Error ? err.message : '续写失败'))
                .finally(() => setContinueBusy(false));
            },
            onCheaper: () => { setPendingConfirm(null); },
            onCancel: () => {
              setPendingConfirm(null);
              setContinueBusy(false);
            },
          });
          return;
        }
        throw e;
      }
    };
    setContinueBusy(true);
    setWasStoppedRecently(false);
    try {
      await execute(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '续写失败');
    } finally {
      setContinueBusy(false);
    }
  }, [
    continueBusy,
    isLoading,
    loadConversationMessages,
    chatModels,
    model,
    onConversationUpdated,
    refreshRealtime,
    refreshRunTimeline,
  ]);

  useEffect(() => {
    if (!pendingInterruptedRunId || isLoading || continueBusy) return;
    let cancelled = false;
    const runId = pendingInterruptedRunId;
    const refreshInterruptedConversation = async (): Promise<void> => {
      const conv = conversationIdRef.current;
      if (!conv) return;
      await loadConversationMessages(conv);
      await refreshRunTimeline();
      void refreshRealtime();
      onConversationUpdated();
    };
    (async () => {
      let usedAutoContinue = false;
      try {
        const resumeState = await api.getRunResumeState(runId);
        if (cancelled || pendingInterruptedRunId !== runId) return;
        if (!resumeState.data.can_continue) {
          await refreshInterruptedConversation();
          return;
        }
        if (!streamAutoResumeEnabledRef.current) {
          await refreshInterruptedConversation();
          return;
        }
        setContinueBusy(true);
        usedAutoContinue = true;
        setActionError(null);
        await api.continueRun(runId);
        if (!cancelled) await refreshInterruptedConversation();
      } catch (e) {
        if (!cancelled) {
          setActionError(e instanceof Error ? e.message : '自动续接失败，请点击继续生成重试');
        }
      } finally {
        if (!cancelled) {
          if (usedAutoContinue) setContinueBusy(false);
          setPendingInterruptedRunId(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    continueBusy,
    isLoading,
    loadConversationMessages,
    onConversationUpdated,
    pendingInterruptedRunId,
    refreshRealtime,
    refreshRunTimeline,
  ]);

  const quickCompareEligibleModels = useMemo(
    () => chatModels.filter((item) => isQuickCompareEligibleModel(item)),
    [chatModels],
  );
  const quickCompareNeedsTools = hasQuickCompareToolIntent(input);

  const defaultQuickCompareModelIds = useMemo(() => {
    return quickCompareEligibleModels
      .slice()
      .sort((a, b) => {
        if (quickCompareNeedsTools) {
          const toolSupportDiff = Number(b.supports_tools) - Number(a.supports_tools);
          if (toolSupportDiff !== 0) return toolSupportDiff;
        }
        if (a.id === model.id) return -1;
        if (b.id === model.id) return 1;
        return a.fallback_order - b.fallback_order;
      })
      .map((item) => item.id)
      .slice(0, 3);
  }, [model.id, quickCompareEligibleModels, quickCompareNeedsTools]);
  const quickCompareDisabledReason = !input.trim()
    ? '先输入要比较的问题'
    : quickCompareEligibleModels.length < 2
      ? 'Quick Compare 至少需要 2 个可用聊天模型'
      : pendingHasImage && !model.supports_vision
        ? '当前模型不能处理待发送图片'
        : null;
  const quickCompareDisabled = quickCompareDisabledReason !== null;

  const runQuickCompare = useCallback(async (
    modelIds: string[] = defaultQuickCompareModelIds,
    confirmedCost = false,
  ): Promise<void> => {
    if (quickCompare?.running || isLoading) return;
    const prompt = input.trim();
    if (!prompt) return;
    const currentModelEligible = isQuickCompareEligibleModel(model);
    const candidateIds = [...new Set(modelIds)].slice(0, 3);
    if (candidateIds.length < 2) {
      setQuickCompare({
        compareId: null,
        running: false,
        error: currentModelEligible
          ? 'Quick Compare 至少需要 2 个可用聊天模型。'
          : '当前会话模型暂不可用于 Quick Compare，请切换到启用中的聊天或多模态模型后重试。',
        outputs: [],
      });
      return;
    }
    setQuickCompare({ compareId: null, running: true, error: null, outputs: [] });
    setActionError(null);
    try {
      const atts = pending.map(({ kind, mime, data_b64, name }) => ({ kind, mime, data_b64, name }));
      const requestMessages = [
        ...messages
          .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'system')
          .map((message) => ({ role: message.role as 'user' | 'assistant' | 'system', content: message.content })),
        { role: 'user' as const, content: prompt },
      ];
      await api.quickCompare({
          conversation_id: conversationIdRef.current ?? undefined,
          messages: requestMessages,
          model_ids: candidateIds,
          ...(atts.length > 0 ? { attachments: atts } : {}),
          ...(activePersona ? { persona_id: activePersona.id } : {}),
          ...(confirmedCost ? { confirmed_cost: true } : {}),
        },
        {
          onAnnotation: (annotation) => {
            setQuickCompare((current) =>
              applyQuickCompareAnnotation(
                current ?? { compareId: null, running: true, error: null, outputs: [] },
                annotation,
              ),
            );
          },
        },
      );
      setPending([]);
      setDropError(null);
      setInput('');
      const conv = conversationIdRef.current;
      if (conv) {
        await loadConversationMessages(conv);
        onConversationUpdated();
      }
    } catch (e) {
      if (!confirmedCost && isCostConfirmationRequiredError(e)) {
        const targetModel = chatModels.find((item) => item.id === e.details.model_id) ?? model;
        setPendingConfirm({
          estimate: e.details.estimate_usd,
          reason: e.details.reason,
          model: targetModel,
          allowCheaper: false,
          blocked: e.details.blocked === true,
          budget: e.details.reason === 'budget'
            ? {
                monthly_budget_usd: e.details.monthly_budget_usd ?? 0,
                month_spent_usd: e.details.month_spent_usd ?? 0,
                daily_budget_usd: e.details.daily_budget_usd ?? undefined,
                day_spent_usd: e.details.day_spent_usd ?? undefined,
                period: e.details.period,
              }
            : undefined,
          onContinue: () => {
            setPendingConfirm(null);
            void runQuickCompare(candidateIds, true);
          },
          onCheaper: () => { setPendingConfirm(null); },
          onCancel: () => {
            setPendingConfirm(null);
            setQuickCompare(null);
          },
        });
        return;
      }
      setQuickCompare({
        compareId: null,
        running: false,
        error: e instanceof Error ? e.message : 'Quick Compare 失败',
        outputs: [],
      });
    }
  }, [
    activePersona,
    defaultQuickCompareModelIds,
    input,
    isLoading,
    loadConversationMessages,
    messages,
    model,
    onConversationUpdated,
    pending,
    quickCompare?.running,
    setInput,
  ]);

  const adoptQuickCompareOutput = useCallback(async (outputId: string): Promise<void> => {
    if (!quickCompare?.compareId || quickCompareAdoptingId) return;
    setQuickCompareAdoptingId(outputId);
    setActionError(null);
    try {
      const res = await api.adoptQuickCompareOutput(quickCompare.compareId, outputId);
      await loadConversationMessages(res.data.conversation_id);
      onConversationCreated(res.data.conversation_id);
      onConversationUpdated();
      setQuickCompare(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '采纳失败');
    } finally {
      setQuickCompareAdoptingId(null);
    }
  }, [
    loadConversationMessages,
    onConversationCreated,
    onConversationUpdated,
    quickCompare?.compareId,
    quickCompareAdoptingId,
  ]);

  const onRecoverClick = useCallback(async (
    action: Extract<RecoverRunRequest['action'], 'retry_same_model' | 'switch_model' | 'compact_context' | 'skip_tool'>,
    assistantMessageId?: string,
    targetModelId?: string,
    toolName?: string | null,
  ): Promise<void> => {
    if (recoverBusy || isLoading) return;
    const conv = conversationIdRef.current;
    if (!conv) return;
    const busyKey = `${assistantMessageId ?? 'latest'}:${action}`;
    setRecoverBusy(busyKey);
    setActionError(null);
    const finish = async (): Promise<void> => {
      if (action === 'switch_model' && targetModelId) {
        onModelChange(targetModelId);
      }
      clearFailureDecisionState();
      await loadConversationMessages(conv);
      await refreshRunTimeline();
      void refreshRealtime();
      onConversationUpdated();
    };
    const buildBody = (confirmedCost = false): RecoverRunRequest => ({
      action,
      ...(targetModelId ? { model_id: targetModelId } : {}),
      ...(toolName ? { tool_name: toolName } : {}),
      ...(confirmedCost ? { confirmed_cost: true } : {}),
    });
    const runConfirmed = async (runId: string): Promise<void> => {
      await api.recoverRun(runId, buildBody(true));
      await finish();
    };
    try {
      const runsRes = await api.getConversationRuns(conv, 50);
      const run = runsRes.data.runs.find((item) =>
        item.status === 'failed' &&
        (!assistantMessageId || item.assistant_message_id === assistantMessageId),
      ) ?? runsRes.data.runs.find((item) => item.status === 'failed');
      if (!run) {
        throw new Error('没有找到可恢复的失败运行');
      }
      try {
        await api.recoverRun(run.id, buildBody(false));
        await finish();
      } catch (e) {
        if (isCostConfirmationRequiredError(e)) {
          const targetModel = chatModels.find((item) => item.id === e.details.model_id) ?? model;
          setPendingConfirm({
            estimate: e.details.estimate_usd,
            reason: e.details.reason,
            model: targetModel,
            allowCheaper: false,
            blocked: e.details.blocked === true,
            budget: e.details.reason === 'budget'
              ? {
                  monthly_budget_usd: e.details.monthly_budget_usd ?? 0,
                  month_spent_usd: e.details.month_spent_usd ?? 0,
                  daily_budget_usd: e.details.daily_budget_usd ?? undefined,
                  day_spent_usd: e.details.day_spent_usd ?? undefined,
                  period: e.details.period,
                }
              : undefined,
            onContinue: () => {
              setPendingConfirm(null);
              setRecoverBusy(busyKey);
              void runConfirmed(run.id)
                .catch((err) => setActionError(err instanceof Error ? err.message : '恢复失败'))
                .finally(() => setRecoverBusy(null));
            },
            onCheaper: () => { setPendingConfirm(null); },
            onCancel: () => {
              setPendingConfirm(null);
              setRecoverBusy(null);
            },
          });
          return;
        }
        throw e;
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '恢复失败');
    } finally {
      setRecoverBusy(null);
    }
  }, [
    clearFailureDecisionState,
    chatModels,
    isLoading,
    loadConversationMessages,
    model,
    onConversationUpdated,
    onModelChange,
    recoverBusy,
    refreshRealtime,
    refreshRunTimeline,
  ]);

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
        regenerateWithCurrentConversation({ skip_user_persist: true, model_id: model.id });
      } catch (e) {
        setActionError(e instanceof Error ? e.message : '编辑失败');
      } finally {
        setEditBusy(false);
      }
    },
    [conversationId, editingDraft, messages, model.id, regenerateWithCurrentConversation, setMessages],
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

  const exportConversation = useCallback(async (): Promise<void> => {
    if (!conversationId) return;
    setExportBusy(true);
    setActionError(null);
    try {
      const { blob, filename } = await api.exportConversationMarkdown(conversationId, {
        includeTimeline: 'summary',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '导出失败');
    } finally {
      setExportBusy(false);
    }
  }, [conversationId]);

  return (
    <div className="chat" data-testid="chat-panel" data-active-conv={conversationId ?? ''}>
      <div className="chat-header">
        <ModelSelector
          models={chatModels}
          providers={providers}
          activeId={model.id}
          memoryScope={modelMemoryScope}
          onChange={changeModelAndClearFailure}
        />
        <button
          type="button"
          className="header-chip-btn"
          data-testid="open-template-picker"
          onClick={() => setTemplatePickerOpen(true)}
        >
          模板
        </button>
        <label className="persona-select-wrap">
          <span className="persona-select-label">Persona</span>
          <select
            className="persona-select"
            value={activePersona ? selectedPersonaId : ''}
            onChange={(e) => void onPersonaChange(e.target.value)}
            data-testid="persona-select"
          >
            <option value="">无 Persona</option>
            {personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </select>
          <span
            className={`scope-chip scope-${activePersona ? (conversationId ? 'session' : 'pending') : 'none'}`}
            data-testid="persona-memory-scope"
            title={
              activePersona
                ? conversationId
                  ? '该 Persona 已作为当前会话的覆盖配置保存。'
                  : '新会话尚未创建；发送第一条消息后会绑定到该会话。'
                : '当前会话不附加 Persona。'
            }
          >
            {activePersona ? (conversationId ? '本会话' : '待绑定') : '未绑定'}
          </span>
        </label>
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
        {conversationType !== 'roundtable' && (
          <button
            type="button"
            className="header-chip-btn"
            data-testid="chat-export-markdown"
            disabled={!conversationId || exportBusy}
            onClick={() => void exportConversation()}
            title={conversationId ? '导出当前会话为 Markdown' : '发送第一条消息后可导出'}
          >
            {exportBusy ? '导出中…' : '导出'}
          </button>
        )}
      </div>
      {promptAssetsError && (
        <div className="prompt-assets-error" data-testid="prompt-assets-error" role="alert">
          {promptAssetsError}
        </div>
      )}
      <CapabilityPreflight
        model={model}
        chatModels={chatModels}
        tools={effectiveTools}
        cost={realtime ?? profileCost}
        busyToolName={sessionToolBusy}
        imageModels={imageModels}
        selectedImageModel={selectedImageModel}
        imageModelMemoryScope={imageModelMemoryScope}
        imageModelPreferenceBusy={imageModelPreferenceBusy}
        imageModelPreferenceError={imageModelPreferenceError}
        providers={providers}
        activePersona={activePersona}
        conversationId={conversationId}
        confirmPrefs={confirmPrefs}
        imageToolEnabled={imageToolEnabled}
        estimatePoint={estimate.point ?? null}
        monthlyBudgetUsd={monthlyBudgetUsd}
        monthSpentUsd={realtime?.month_usd ?? null}
        inputHasText={input.trim().length > 0}
        inputText={input}
        pendingHasImage={pendingHasImage}
        onSetToolOverride={(name, enabled) => void setSessionToolOverride(name, enabled)}
        onOpenModelCenter={onOpenModelCenter}
        onOpenTools={onOpenTools}
        onOpenRunTimeline={() => {
          setRunTimelineOpen(true);
          void refreshRunTimeline();
        }}
        onSelectModel={changeModelAndClearFailure}
        onSelectImageModel={(id) => void persistImageModelPreference(id)}
        onSelectImageAuto={() => void clearImageModelPreference()}
      />
      {activeRoundtableId ? (
        <RoundtablePanel
          roundtableId={activeRoundtableId}
          providers={providers}
          onExit={() => setActiveRoundtableId(null)}
          onFollowUp={(topic) => {
            setActiveRoundtableId(null);
            setRoundtableDialog({ initialTopic: topic });
          }}
          onLoopback={(loopConvId) => {
            const roundtableId = activeRoundtableId;
            conversationIdRef.current = loopConvId;
            announcedConvIdRef.current = loopConvId;
            setAssociatedRoundtableId(roundtableId);
            setActiveRoundtableId(null);
            onLoopbackToConversation(loopConvId);
            void loadConversationMessages(loopConvId).catch((e) =>
              console.warn('[roundtable] loopback history refresh failed:', e),
            );
          }}
        />
      ) : (
        <>
      {associatedRoundtableId ? (
        <div
          className="roundtable-banner"
          data-testid="roundtable-associated-banner"
        >
          <span>此对话包含圆桌结论，聊天记录已保留。</span>
          <button
            type="button"
            data-testid="roundtable-associated-open"
            onClick={() => setActiveRoundtableId(associatedRoundtableId)}
          >
            查看圆桌过程
          </button>
        </div>
      ) : null}
      <div className="messages" data-testid="messages" ref={messagesRef}>
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
          const msgMeta = m as ChatMessage;
          const anns =
            ((m as { annotations?: Array<Record<string, unknown>> }).annotations ?? []);
          const annMessageId = anns.find((a) => a?.type === 'cost')?.message_id as
            | string
            | undefined;
          const cost = annMessageId ? costByMsg[annMessageId] : undefined;
          const toolTraceSteps = m.role === 'assistant'
            ? toolTraceStepsFromAnnotations(anns)
            : [];
          const contextSnapshot = m.role === 'assistant'
            ? contextSnapshotFromAnnotations(anns)
            : null;
          const isLastAssistant =
            m.role === 'assistant' && m === messages[messages.length - 1];
          const canContinue =
            m.role === 'assistant' &&
            isLastAssistant &&
            (wasStoppedRecently || msgMeta.status === 'incomplete');
          return (
            <div
              key={m.id}
              className={`msg ${m.role}`}
              data-role={m.role}
              data-msg-id={m.id}
              onMouseEnter={() => setActiveMsgActionsId(m.id)}
              onFocusCapture={() => setActiveMsgActionsId(m.id)}
            >
              <div className="msg-role">{messageRoleLabel(msgMeta, chatModels, providers, model)}</div>
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
                <MarkdownView content={m.content} />
              ) : (
                <div className="msg-content">{m.content}</div>
              )}
              {m.role === 'assistant' && imagesByMsg[m.id] && imagesByMsg[m.id]!.length > 0 && (
                <div className="msg-tool-images" data-testid="msg-tool-images">
                  {imagesByMsg[m.id]!.map((img) => (
                    <figure key={img.file_id} className="tool-image">
                      <button
                        type="button"
                        className="tool-image-preview"
                        disabled={!img.data_b64}
                        onClick={() => setImageViewer({ img, zoom: 1 })}
                        data-testid="tool-image-open"
                        title="打开大图预览"
                      >
                        <img
                          src={imageDataUrl(img)}
                          alt={img.prompt ?? 'generated image'}
                          loading="lazy"
                        />
                        <span>点击放大</span>
                      </button>
                      {img.prompt && (
                        <figcaption>{img.prompt}</figcaption>
                      )}
                      <div className="tool-image-actions">
                        <button
                          type="button"
                          data-testid="tool-image-save"
                          disabled={!img.data_b64}
                          onClick={() => saveGeneratedImage(img)}
                        >
                          保存图片
                        </button>
                        <button
                          type="button"
                          data-testid="tool-image-understand"
                          disabled={!img.data_b64}
                          onClick={() => attachGeneratedImageForVision(img)}
                        >
                          理解这张图
                        </button>
                      </div>
                    </figure>
                  ))}
                </div>
              )}
              {m.role === 'assistant' && toolTraceSteps.length > 0 && (
                <ToolTraceTimeline steps={toolTraceSteps} />
              )}
              {m.role === 'assistant' && (contextSnapshot || cost) && (
                <MessageContextDetails
                  snapshot={contextSnapshot}
                  cost={cost}
                />
              )}
              {canContinue && msgMeta.status === 'incomplete' && (
                <div className="resume-banner" data-testid="resume-banner">
                  <div>
                    <strong>这条回复未完成</strong>
                    <span>Taori 已保留已生成内容，可以从中断处继续。</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void onContinueClick(m.id)}
                    disabled={continueBusy || isLoading}
                    data-testid="resume-continue"
                  >
                    {continueBusy ? '续写中…' : '继续生成'}
                  </button>
                </div>
              )}
              {!isLoading && m.content && editingMsgId !== m.id && (
                <div
                  className={`msg-actions${canContinue || activeMsgActionsId === m.id ? ' msg-actions--visible' : ''}`}
                  data-testid="msg-actions"
                >
                  <button
                    type="button"
                    onClick={() => void copyToClipboard(m.content)}
                    data-testid="msg-copy"
                    title="复制"
                    aria-label="复制"
                  >
                    ⧉
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
                      aria-label="编辑并重新生成"
                    >
                      ✎
                    </button>
                  )}
                  {m.role === 'assistant' && isLastAssistant && (
                    <button
                      type="button"
                      onClick={() => {
                        clearFailureDecisionState();
                        regenerateWithCurrentConversation({ model_id: model.id });
                      }}
                      data-testid="msg-regenerate"
                      title="重新生成"
                      aria-label="重新生成"
                    >
                      ↻
                    </button>
                  )}
                  {canContinue && (
                    <button
                      type="button"
                      onClick={() => void onContinueClick(m.id)}
                      data-testid="msg-continue"
                      title="继续上文"
                      disabled={continueBusy}
                      aria-label={continueBusy ? '续写中' : '继续上文'}
                    >
                      {continueBusy ? '…' : '✏️'}
                    </button>
                  )}
                  {conversationId && (m.role === 'user' || m.role === 'assistant') && (
                    <button
                      type="button"
                      data-testid="msg-branch"
                      title="基于此消息创建分支会话"
                      disabled={branchBusy === m.id}
                      onClick={() => void branchFromMessage(m.id)}
                      aria-label={branchBusy === m.id ? '创建分支中' : '基于此消息创建分支会话'}
                    >
                      {branchBusy === m.id ? '…' : '⎇'}
                    </button>
                  )}
                </div>
              )}
              {m.role === 'assistant' && failureByMsg[m.id] && (
                <FailureDecisionCard
                  decision={failureByMsg[m.id]!}
                  chatModels={chatModels}
                  providers={providers}
                  onRetry={() => void onRecoverClick('retry_same_model', m.id)}
                  onSwitch={(targetId) => void onRecoverClick('switch_model', m.id, targetId)}
                  onCompact={() => void onRecoverClick('compact_context', m.id)}
                  onSkipTool={(toolName) => void onRecoverClick('skip_tool', m.id, undefined, toolName)}
                  onOpenSettings={() => onOpenSettings()}
                  busy={recoverBusy != null}
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
            {slowResponseWarning && (
              <div className="slow-response-card" data-testid="slow-response-card">
                <strong>首 token 等待超过 {Math.round(slowResponseWarning.thresholdMs / 1000)} 秒</strong>
                <p className="hint">该模型这次响应偏慢，可以继续等、取消，或先切到历史更快的模型后重发。</p>
                <div className="slow-response-actions">
                  <button
                    type="button"
                    onClick={() => {
                      slowResponseDismissedRef.current = true;
                      setSlowResponseWarning(null);
                    }}
                    data-testid="slow-response-wait"
                  >
                    继续等
                  </button>
                  {slowResponseWarning.suggestedModelId && (
                    <button
                      type="button"
                      onClick={() => {
                        const next = chatModels.find((item) => item.id === slowResponseWarning.suggestedModelId);
                        if (!next) return;
                        stop();
                        changeModelAndClearFailure(next.id);
                        setDropError(`已切换到更快模型：${modelDisplayWithProvider(next, providers)}。可重新发送当前问题。`);
                        setSlowResponseWarning(null);
                      }}
                      data-testid="slow-response-switch"
                    >
                      切到更快模型
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      stop();
                      setSlowResponseWarning(null);
                    }}
                    data-testid="slow-response-cancel"
                  >
                    取消本次
                  </button>
                </div>
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
          && !hasMessageBoundFailure
          && (
            <div className="msg assistant" data-role="assistant" data-failed="1">
              <FailureDecisionCard
                decision={failureByMsg[lastFailureMsgId]!}
                chatModels={chatModels}
                providers={providers}
                onRetry={() => void onRecoverClick('retry_same_model', lastFailureMsgId)}
                onSwitch={(targetId) => void onRecoverClick('switch_model', lastFailureMsgId, targetId)}
                onCompact={() => void onRecoverClick('compact_context', lastFailureMsgId)}
                onSkipTool={(toolName) => void onRecoverClick('skip_tool', lastFailureMsgId, undefined, toolName)}
                onOpenSettings={() => onOpenSettings()}
                busy={recoverBusy != null}
              />
            </div>
          )}
      </div>
      {error && <ChatErrorBanner error={error} />}
      {quickCompare && (
        <section className="quick-compare-card" data-testid="quick-compare-card">
          <div className="quick-compare-head">
            <div>
              <strong>Quick Compare</strong>
              <span>一次对比多个模型回答，采纳后才写入正式上下文。</span>
            </div>
            <button type="button" onClick={() => setQuickCompare(null)} data-testid="quick-compare-close">
              关闭
            </button>
          </div>
          {quickCompare.running && <p className="hint">正在并行请求候选模型…</p>}
          {quickCompare.error && <p className="err" data-testid="quick-compare-error">{quickCompare.error}</p>}
          {quickCompare.outputs.length > 0 && (
            <div className="quick-compare-grid" data-testid="quick-compare-grid">
              {(() => {
                const completedWithFirstToken = quickCompare.outputs.filter(
                  (item) => item.status === 'complete' && item.firstTokenMs != null,
                );
                const completedWithDuration = quickCompare.outputs.filter(
                  (item) => item.status === 'complete' && item.durationMs != null,
                );
                const fastestFirstTokenMs = completedWithFirstToken.length > 1
                  ? Math.min(...completedWithFirstToken.map((item) => item.firstTokenMs ?? Number.POSITIVE_INFINITY))
                  : null;
                const fastestDurationMs = completedWithDuration.length > 1
                  ? Math.min(...completedWithDuration.map((item) => item.durationMs ?? Number.POSITIVE_INFINITY))
                  : null;
                return quickCompare.outputs.map((output) => {
                  const outputModel = chatModels.find((item) => item.id === output.modelId) ?? null;
                  const isFastestFirstToken =
                    fastestFirstTokenMs != null && output.firstTokenMs != null && output.firstTokenMs === fastestFirstTokenMs;
                  const isFastestDuration =
                    fastestDurationMs != null && output.durationMs != null && output.durationMs === fastestDurationMs;
                  return (
                    <article
                      className={`quick-compare-output quick-compare-${output.status}`}
                      key={output.outputId}
                      data-testid="quick-compare-output"
                    >
                      <header>
                        <div className="quick-compare-output-title">
                          <strong>{outputModel ? modelDisplayWithProvider(outputModel, providers) : output.modelId}</strong>
                          {(isFastestFirstToken || isFastestDuration) && (
                            <div className="quick-compare-speed-badges">
                              {isFastestFirstToken && <span className="quick-compare-speed-badge">首字最快</span>}
                              {isFastestDuration && <span className="quick-compare-speed-badge">完成最快</span>}
                            </div>
                          )}
                        </div>
                        <span>{output.status === 'failed' ? '失败' : output.status === 'complete' ? '完成' : '生成中'}</span>
                      </header>
                      {(output.firstTokenMs != null || output.durationMs != null || outputModel?.supports_tools) && (
                        <div className="quick-compare-metrics">
                          {output.firstTokenMs != null && <span>首字 {formatLatencyMs(output.firstTokenMs)}</span>}
                          {output.durationMs != null && <span>总耗时 {formatLatencyMs(output.durationMs)}</span>}
                          {outputModel?.supports_tools && <span>支持 Tools</span>}
                        </div>
                      )}
                      {output.toolTraces.length > 0 && (
                        <div className="quick-compare-tool-traces">
                          {output.toolTraces.map((trace) => (
                            <div
                              key={trace.callId}
                              className={`quick-compare-tool-trace quick-compare-tool-trace-${trace.status}`}
                            >
                              <span className="quick-compare-tool-trace-label">
                                {trace.label}
                                {trace.durationMs != null ? ` · ${formatLatencyMs(trace.durationMs)}` : ''}
                              </span>
                              <span className="quick-compare-tool-trace-status">
                                {trace.status === 'running' ? '调用中' : trace.status === 'ok' ? '已完成' : '失败'}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      {output.status === 'failed' ? (
                        <p className="err">{output.error ?? '候选生成失败'}</p>
                      ) : (
                        <MarkdownView
                          content={output.content || '（暂无内容）'}
                          className="quick-compare-content msg-md"
                        />
                      )}
                      <button
                        type="button"
                        className="quick-compare-adopt"
                        disabled={output.status !== 'complete' || quickCompareAdoptingId === output.outputId}
                        onClick={() => void adoptQuickCompareOutput(output.outputId)}
                        data-testid="quick-compare-adopt"
                      >
                        {quickCompareAdoptingId === output.outputId ? '采纳中…' : '采纳这版'}
                      </button>
                    </article>
                  );
                });
              })()}
            </div>
          )}
        </section>
      )}
      <AttachmentBar
        attachments={pending}
        onRemove={(idx) => setPending((p) => p.filter((_, i) => i !== idx))}
        visionWarning={pendingHasImage && !model.supports_vision}
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
          lastUserStopAtRef.current = 0;
          setUserStopPending(false);
          if (pendingHasImage && !model.supports_vision) return;
          const atts = pending.map(({ kind, mime, data_b64, name }) => ({ kind, mime, data_b64, name }));

          // M2.2 §3.2 — pre-call confirm modal. Skip if model or conversation
          // is in disabled list. Trigger when estimate > threshold OR when
          // capability=image AND image_always=true.
          const skip = confirmPrefs.disabledModels.includes(model.id)
            || (conversationId && confirmPrefs.disabledConvs.includes(conversationId));
          const isImage = model.capability === 'image';
          const exceedsThreshold = (estimate.point ?? 0) > confirmPrefs.threshold;
          const triggersImage = isImage && confirmPrefs.imageAlways;
          if ((overDailyBudget || overBudget) && realtime) {
            const isDailyBreach = overDailyBudget;
            const fire = (overrideModelId?: string) => {
              clearFailureDecisionState();
              setPending([]);
              setDropError(null);
              const body = withCurrentConversation({
                ...(atts.length > 0 ? { attachments: atts } : {}),
                ...(overrideModelId ? { model_id: overrideModelId } : {}),
              });
              handleSubmit(e, Object.keys(body).length > 0 ? { body } : undefined);
            };
            setPendingConfirm({
              estimate: estimate.point ?? 0,
              reason: 'budget',
              blocked: isDailyBreach ? dailyBudgetHardLimit : monthlyBudgetHardLimit,
              budget: {
                monthly_budget_usd: monthlyBudgetUsd ?? 0,
                month_spent_usd: realtime.month_usd,
                daily_budget_usd: dailyBudgetUsd ?? undefined,
                day_spent_usd: realtime.today_usd,
                period: isDailyBreach ? 'day' : 'month',
              },
              onContinue: () => { setPendingConfirm(null); fire(); },
              onCheaper: () => {
                setPendingConfirm(null);
                const cheaper = findKnownCheaperPeer(chatModels, model);
                if (cheaper) {
                  onModelChange(cheaper.id);
                  fire(cheaper.id);
                } else {
                  fire();
                }
              },
              onCancel: () => { setPendingConfirm(null); },
            });
            return;
          }
          if (!skip && (exceedsThreshold || triggersImage)) {
            const fire = (overrideModelId?: string) => {
              clearFailureDecisionState();
              setPending([]);
              setDropError(null);
              const body = withCurrentConversation({
                ...(atts.length > 0 ? { attachments: atts } : {}),
                ...(overrideModelId ? { model_id: overrideModelId } : {}),
              });
              handleSubmit(e, Object.keys(body).length > 0 ? { body } : undefined);
            };
            setPendingConfirm({
              estimate: estimate.point ?? 0,
              reason: triggersImage ? 'image' : 'threshold',
              onContinue: () => { setPendingConfirm(null); fire(); },
              onCheaper: () => {
                setPendingConfirm(null);
                const cheaper = findKnownCheaperPeer(chatModels, model);
                if (cheaper) {
                  onModelChange(cheaper.id);
                  fire(cheaper.id);
                } else {
                  fire();
                }
              },
              onCancel: () => { setPendingConfirm(null); },
            });
            return;
          }

          clearFailureDecisionState();
          setPending([]);
          setDropError(null);
          const body = withCurrentConversation(atts.length > 0 ? { attachments: atts } : {});
          handleSubmit(e, Object.keys(body).length > 0 ? { body } : undefined);
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
                  `已自动切换至视觉模型：${modelDisplayWithProvider(visionPick, providers)}`,
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
            const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
            const justEndedComposition = Date.now() - composerCompositionEndedAtRef.current < 120;
            const isImeComposing =
              composerComposingRef.current ||
              native.isComposing === true ||
              native.keyCode === 229 ||
              justEndedComposition;
            if (e.key === 'Enter' && !e.shiftKey && !isImeComposing) {
              e.preventDefault();
              const form = (e.currentTarget as HTMLTextAreaElement).form;
              if (form) form.requestSubmit();
            }
          }}
          onCompositionStart={() => {
            composerComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            composerComposingRef.current = false;
            composerCompositionEndedAtRef.current = Date.now();
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
              data-testid="composer-quick-compare"
              className="roundtable-btn quick-compare-btn"
              title={quickCompareDisabledReason ?? '一键并行对比 2-3 个模型回答'}
              disabled={quickCompareDisabled}
              onClick={() => setQuickComparePickerOpen(true)}
            >
              ⚡ 对比
            </button>
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
      {budgetToast && (
        <div
          className={`budget-toast budget-toast-${budgetToast.threshold === 100 ? 'over' : budgetToast.threshold >= 80 ? 'warn' : 'half'}`}
          data-testid="budget-toast"
          role="status"
        >
          {budgetToast.period === 'day' ? '今日预算' : '本月预算'}已用到 {budgetToast.threshold}%：
          {' '}
          {formatUsd(budgetToast.spentUsd)}
          {' / '}
          {formatUsd(budgetToast.budgetUsd)}
        </div>
      )}
      <CostStatusBar
        realtime={realtime}
        monthlyBudgetUsd={monthlyBudgetUsd}
        budgetLevel={budgetLevel}
        onScopeClick={(scope) => setCostPanelScope(scope)}
      />
        </>
      )}
      {pendingConfirm && (
        <CostConfirmDialog
          estimate={pendingConfirm.estimate}
          reason={pendingConfirm.reason}
          model={pendingConfirm.model ?? model}
          providers={providers}
          conversationId={conversationId}
          hasCheaperPeer={
            pendingConfirm.allowCheaper !== false &&
            findKnownCheaperPeer(chatModels, pendingConfirm.model ?? model) != null
          }
          budget={pendingConfirm.budget}
          blocked={pendingConfirm.blocked === true}
          onContinue={pendingConfirm.onContinue}
          onCheaper={pendingConfirm.onCheaper}
          onCancel={pendingConfirm.onCancel}
          onUpdatePrefs={(next) => setConfirmPrefs((p) => ({ ...p, ...next }))}
        />
      )}
      {imageGenerationStatus && !pendingConfirm && (
        <ImageGenerationProgress
          prompt={imageGenerationStatus.prompt}
          modelName={
            imageModels.find((m) => m.id === imageGenerationStatus.modelId)
              ? modelDisplayWithProvider(imageModels.find((m) => m.id === imageGenerationStatus.modelId)!, providers)
              : '图像模型'
          }
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
      {runTimelineOpen && (
        <RunTimelinePanel
          events={runEvents}
          error={runEventsError}
          focusTarget={runTimelineFocus}
          onRefresh={() => void refreshRunTimeline()}
          onClose={() => setRunTimelineOpen(false)}
        />
      )}
      {imagePicker && (
        <ImagePickerDialog
          prompt={imagePicker.prompt}
          imageModels={imageModels}
          providers={providers}
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
        />
      )}
      {imageViewer && (
        <ImageLightbox
          img={imageViewer.img}
          zoom={imageViewer.zoom}
          onZoom={(zoom) => setImageViewer((current) => (current ? { ...current, zoom } : current))}
          onSave={() => saveGeneratedImage(imageViewer.img)}
          onAttach={() => attachGeneratedImageForVision(imageViewer.img)}
          onClose={() => setImageViewer(null)}
        />
      )}
      {templatePickerOpen && (
        <TemplatePickerDialog
          templates={promptTemplates}
          recipes={workflowRecipes}
          onClose={() => setTemplatePickerOpen(false)}
          onApply={(template) => void applyTemplate(template)}
          onApplyRecipe={(recipe) => applyRecipe(recipe)}
        />
      )}
      {templateVarDraft && (
        <TemplateVariablesDialog
          template={templateVarDraft.template}
          vars={templateVarDraft.vars}
          answers={templateVarDraft.answers}
          onAnswersChange={(answers) =>
            setTemplateVarDraft((draft) => (draft ? { ...draft, answers } : draft))
          }
          onCancel={() => setTemplateVarDraft(null)}
          onSubmit={(answers) => insertTemplateWithAnswers(templateVarDraft.template, answers)}
        />
      )}
      {recipeVarDraft && (
        <TemplateVariablesDialog
          template={recipeVarDraft.template}
          vars={recipeVarDraft.vars}
          answers={recipeVarDraft.answers}
          onAnswersChange={(answers) =>
            setRecipeVarDraft((draft) => (draft ? { ...draft, answers } : draft))
          }
          onCancel={() => setRecipeVarDraft(null)}
          onSubmit={(answers) => insertRecipeWithAnswers(recipeVarDraft.template.recipe, answers)}
        />
      )}
      {quickComparePickerOpen && (
        <QuickCompareModelPickerDialog
          models={quickCompareEligibleModels}
          selectedIds={defaultQuickCompareModelIds}
          providers={providers}
          currentModelId={model.id}
          onCancel={() => setQuickComparePickerOpen(false)}
          onSubmit={(modelIds) => {
            setQuickComparePickerOpen(false);
            void runQuickCompare(modelIds, false);
          }}
        />
      )}
      {roundtableDialog && (
        <RoundtableLaunchDialog
          initialTopic={roundtableDialog.initialTopic}
          conversationId={conversationId}
          providers={providers}
          onCancel={() => setRoundtableDialog(null)}
          onLaunched={(result) => {
            setRoundtableDialog(null);
            onConversationCreated(result.conversation_id);
            setActiveRoundtableId(result.id);
            // Pull the new conversation into the sidebar list.
            onConversationUpdated();
          }}
        />
      )}
      {activeTipId && !tipBlocked && (
        <DiscoverableTip
          content={TIPS[activeTipId]}
          onDismiss={() => setActiveTipId(null)}
        />
      )}
      {activeRoundtableId && null}
    </div>
  );
}

function TemplatePickerDialog({
  templates,
  recipes,
  onClose,
  onApply,
  onApplyRecipe,
}: {
  templates: PromptTemplate[];
  recipes: WorkflowRecipe[];
  onClose: () => void;
  onApply: (template: TemplateLike) => void;
  onApplyRecipe: (recipe: WorkflowRecipe) => void;
}): JSX.Element {
  const hasTemplates = templates.length > 0;
  return (
    <div
      className="dialog-backdrop"
      data-testid="template-picker-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="picker-dialog" role="dialog" aria-label="选择 Prompt 模板">
        <div className="picker-dialog-head">
          <h3>选择 Prompt 模板</h3>
          <button type="button" className="settings-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="picker-dialog-list">
          <div className="picker-dialog-section-title">内置工作流</div>
          {BUILTIN_WORKFLOW_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className="picker-dialog-item workflow-template"
              data-testid="workflow-template-item"
              onClick={() => onApply(template)}
            >
              <strong>{template.name}</strong>
              <span>{template.description}</span>
              <code>{template.content.slice(0, 140)}</code>
            </button>
          ))}
          <div className="picker-dialog-section-title">Workflow Recipe</div>
          {recipes.length === 0 ? (
            <EmptyState
              title="还没有 Recipe"
              hint="可以在控制中心的模板与 Persona 里创建。"
              icon="🧪"
              compact
              tone="muted"
            />
          ) : (
            recipes.map((recipe) => (
              <button
                key={recipe.id}
                type="button"
                className="picker-dialog-item workflow-template"
                data-testid="workflow-recipe-item"
                onClick={() => onApplyRecipe(recipe)}
              >
                <strong>{recipe.name}</strong>
                {recipe.description && <span>{recipe.description}</span>}
                <code>{recipe.spec.prompt_template.slice(0, 140)}</code>
              </button>
            ))
          )}
          <div className="picker-dialog-section-title">我的模板</div>
          {!hasTemplates ? (
            <EmptyState
              title="还没有自定义模板"
              hint="可以先到设置里创建一个。"
              icon="🗂"
              compact
              tone="muted"
            />
          ) : (
            <>
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="picker-dialog-item"
                  data-testid="template-picker-item"
                  onClick={() => onApply(template)}
                >
                  <strong>{template.name}</strong>
                  {template.description && <span>{template.description}</span>}
                  <code>{template.content.slice(0, 140)}</code>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolTraceTimeline({ steps }: { steps: ToolTraceStep[] }): JSX.Element {
  return (
    <div className="tool-trace" data-testid="tool-trace-timeline">
      <div className="tool-trace-title">工具执行</div>
      <ol>
        {steps.map((step) => (
          <li
            key={step.callId}
            className={`tool-trace-step tool-trace-${step.status}`}
            data-testid="tool-trace-step"
            data-tool={step.tool}
            data-status={step.status}
          >
            <span className="tool-trace-dot" aria-hidden="true" />
            <div>
              <div className="tool-trace-head">
                <strong>{step.label}</strong>
                <span>
                  {step.status === 'running'
                    ? '执行中'
                    : step.status === 'ok'
                      ? '完成'
                      : '失败'}
                  {step.durationMs != null ? ` · ${step.durationMs}ms` : ''}
                </span>
              </div>
              {step.input && <p>输入：{step.input}</p>}
              {step.output && <p>结果：{step.output}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function MessageContextDetails({
  snapshot,
  cost,
}: {
  snapshot: ContextSnapshotAnnotation | null;
  cost?: MessageCost;
}): JSX.Element {
  const sources = Array.isArray(snapshot?.context_sources)
    ? snapshot.context_sources
    : [];
  const activeSources = sources.filter((source) => source.active);
  const inactiveSources = sources.filter((source) => !source.active);
  const visibleSources = activeSources.length > 0 ? activeSources : sources.slice(0, 2);
  const summaryText = messageContextSummary(snapshot);
  const tokenSummary = cost
    ? `${formatTokenCount(cost.input_tokens)} in · ${formatTokenCount(cost.output_tokens)} out`
    : 'Token 未返回';
  const costSummary = cost?.actual_usd != null ? formatUsd(cost.actual_usd) : '—';
  const summaryTitle = [
    summaryText !== '上下文' ? summaryText : null,
    cost ? `费用 ${costSummary}` : null,
    cost ? tokenSummary : null,
    cost && (cost.input_tokens == null || cost.output_tokens == null)
      ? '当前供应商没有返回 token usage，费用只能显示可用部分。'
      : null,
    '点击展开详情',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <details className="context-snapshot-card" data-testid="context-snapshot-card">
      <summary className="context-snapshot-title" title={summaryTitle}>
        {cost ? (
          <span className="msg-cost context-snapshot-cost" data-testid="msg-cost">
            <span aria-hidden="true">💰</span>
            <strong>{costSummary}</strong>
            <span className="sr-only">
              {` ${tokenSummary}`}
              {summaryText !== '上下文' ? ` ${summaryText}` : ''}
              {cost.input_tokens == null || cost.output_tokens == null ? ' token 未返回。' : ''}
            </span>
          </span>
        ) : (
          <span className="context-snapshot-label">详情</span>
        )}
        <span className="context-snapshot-info" aria-hidden="true">ⓘ</span>
        <span className="sr-only">查看本条消息的上下文详情。</span>
      </summary>
      {summaryText !== '上下文' && (
        <p className="context-detail-summary">{summaryText}</p>
      )}
      {visibleSources.length > 0 && (
        <div className="context-source-list compact">
          {visibleSources.map((source, index) => (
            <span
              key={`${source.type}-${index}`}
              className={`context-source-chip ${source.active ? 'active' : 'inactive'}`}
              data-testid="context-source-chip"
              title={`${source.scope} · ${source.type}`}
            >
              {source.label}
            </span>
          ))}
        </div>
      )}
      <div className="context-detail-grid">
        <span>
          <small>工具</small>
          <strong>{snapshot ? `${(snapshot.active_tool_names ?? []).length} 个可见` : '未记录'}</strong>
        </span>
        <span>
          <small>消息</small>
          <strong>
            {snapshot?.context_window
              ? `${snapshot.context_window.sent_message_count}/${snapshot.context_window.original_message_count}`
              : '未记录'}
          </strong>
        </span>
        <span>
          <small>费用</small>
          <strong>{cost?.actual_usd != null ? formatUsd(cost.actual_usd) : '—'}</strong>
        </span>
        <span>
          <small>Token</small>
          <strong>
            {cost
              ? `${formatTokenCount(cost.input_tokens)} in / ${formatTokenCount(cost.output_tokens)} out`
              : '未返回'}
          </strong>
        </span>
      </div>
      {inactiveSources.length > 0 && (
        <div className="context-source-list muted">
          {inactiveSources.map((source, index) => (
            <span
              key={`${source.type}-inactive-${index}`}
              className="context-source-chip inactive"
              title={`${source.scope} · ${source.type}`}
            >
              {source.label}
            </span>
          ))}
        </div>
      )}
      {sources.length > visibleSources.length && (
        <div className="context-source-list sr-only">
          {sources.map((source, index) => (
            <span
              key={`${source.type}-${index}`}
              className={`context-source-chip ${source.active ? 'active' : 'inactive'}`}
              title={`${source.scope} · ${source.type}`}
            >
            {source.label}
          </span>
          ))}
        </div>
      )}
    </details>
  );
}

function runEventStatusText(status: RunEvent['status']): string {
  if (status === 'started') return '开始';
  if (status === 'progress') return '进行中';
  if (status === 'completed') return '完成';
  if (status === 'cancelled') return '已停止';
  if (status === 'stopped') return '已停止';
  if (status === 'incomplete') return '可续写';
  if (status === 'retrying') return '恢复中';
  return '失败';
}

function runEventMeta(event: RunEvent): string {
  const payload = event.payload ?? {};
  if (event.kind === 'context.snapshot') {
    const activeTools = Array.isArray(payload.active_tool_names)
      ? `${payload.active_tool_names.length} 个工具可见`
      : null;
    const contextWindow = contextWindowFromPayload(payload);
    const strategy = contextWindow?.strategy === 'sliding_window' ? '滑动窗口' : '完整上下文';
    const omitted = contextWindow?.omitted_message_count
      ? `裁剪 ${contextWindow.omitted_message_count} 条`
      : null;
    return [activeTools, strategy, omitted].filter(Boolean).join(' · ');
  }
  if (event.kind === 'context.file_chunks') {
    const chunks = Array.isArray(payload.chunks) ? `${payload.chunks.length} 个片段` : null;
    const tokenEstimate = typeof payload.token_estimate === 'number'
      ? `${payload.token_estimate} tok`
      : null;
    return [chunks, tokenEstimate].filter(Boolean).join(' · ');
  }
  if (event.kind.startsWith('tool.')) {
    const tool = typeof payload.tool === 'string' ? payload.tool : null;
    const duration = typeof payload.duration_ms === 'number' ? `${payload.duration_ms}ms` : null;
    return [tool, duration].filter(Boolean).join(' · ');
  }
  if (event.kind === 'cost.recorded') {
    const input = typeof payload.input_tokens === 'number' ? `${payload.input_tokens} in` : null;
    const output = typeof payload.output_tokens === 'number' ? `${payload.output_tokens} out` : null;
    const actual =
      typeof payload.actual_usd === 'number'
        ? payload.actual_usd
        : typeof payload.actual_cost_usd === 'number'
          ? payload.actual_cost_usd
          : null;
    const usd = typeof actual === 'number' ? formatUsd(actual) : null;
    const costId = typeof payload.cost_record_id === 'string'
      ? `Cost ${payload.cost_record_id.slice(0, 10)}`
      : null;
    return [input, output, usd, costId].filter(Boolean).join(' · ');
  }
  if (event.kind.startsWith('memory.')) {
    const ids = Array.isArray(payload.memory_ids) ? `${payload.memory_ids.length} 条` : null;
    const memoryTypes = Array.isArray(payload.memory_types)
      ? payload.memory_types.filter((type): type is string => typeof type === 'string')
      : [];
    const types = memoryTypes.length > 0
      ? [...new Set(memoryTypes)]
          .map((type) => memoryEventTypeLabel(type))
          .join(' / ')
      : null;
    return [ids, types].filter(Boolean).join(' · ');
  }
  if (event.kind.startsWith('model.')) {
    const duration = typeof payload.duration_ms === 'number' ? `${payload.duration_ms}ms` : null;
    const modelName = typeof payload.model_name === 'string' ? payload.model_name : null;
    return [modelName, duration].filter(Boolean).join(' · ');
  }
  return event.kind;
}

function memoryEventTypeLabel(type: string): string {
  if (type === 'preference') return '偏好';
  if (type === 'project_fact') return '项目事实';
  if (type === 'profile') return '用户画像';
  return '其他';
}

function dispatchCostCallFocus(event: RunEvent): void {
  const costRecordId = event.payload?.cost_record_id;
  if (typeof costRecordId !== 'string') return;
  window.dispatchEvent(
    new CustomEvent<CostCallFocusDetail>('taori:focus-cost-call', {
      detail: {
        costRecordId,
        runId: event.run_id,
        runEventId: event.id,
      },
    }),
  );
}

function contextWindowFromPayload(payload: Record<string, unknown>): ContextWindowStats | null {
  const raw = payload.context_window;
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const original = value.original_message_count;
  const sent = value.sent_message_count;
  const omitted = value.omitted_message_count;
  const estimated = value.estimated_input_tokens;
  const strategy = value.strategy;
  if (
    typeof original !== 'number' ||
    typeof sent !== 'number' ||
    typeof omitted !== 'number' ||
    typeof estimated !== 'number' ||
    (strategy !== 'full' && strategy !== 'sliding_window')
  ) {
    return null;
  }
  return {
    original_message_count: original,
    sent_message_count: sent,
    omitted_message_count: omitted,
    estimated_input_tokens: estimated,
    budget_tokens: typeof value.budget_tokens === 'number' ? value.budget_tokens : null,
    model_context_length: typeof value.model_context_length === 'number' ? value.model_context_length : null,
    strategy,
  };
}

function RunEventContextWindow({
  event,
}: {
  event: RunEvent;
}): JSX.Element | null {
  if (event.kind !== 'context.snapshot') return null;
  const stats = contextWindowFromPayload(event.payload ?? {});
  if (!stats) return null;
  const strategyText = stats.strategy === 'sliding_window' ? '滑动窗口' : '完整上下文';
  return (
    <div className="run-event-context-window" data-testid="context-window-detail">
      <span>
        <small>策略</small>
        <strong>{strategyText}</strong>
      </span>
      <span>
        <small>消息</small>
        <strong>{stats.sent_message_count}/{stats.original_message_count}</strong>
      </span>
      <span>
        <small>裁剪</small>
        <strong>{stats.omitted_message_count} 条</strong>
      </span>
      <span>
        <small>估算</small>
        <strong>
          {stats.estimated_input_tokens}
          {stats.budget_tokens ? `/${stats.budget_tokens}` : ''}
        </strong>
      </span>
    </div>
  );
}

function RunEventFileChunks({
  event,
}: {
  event: RunEvent;
}): JSX.Element | null {
  if (event.kind !== 'context.file_chunks') return null;
  const chunks = Array.isArray(event.payload?.chunks)
    ? event.payload.chunks.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
  if (chunks.length === 0) return null;
  return (
    <div className="run-event-file-chunks" data-testid="run-event-file-chunks">
      {chunks.slice(0, 6).map((chunk, index) => {
        const fileId = typeof chunk.file_id === 'string' ? chunk.file_id : 'file';
        const chunkIndex = typeof chunk.chunk_index === 'number' ? chunk.chunk_index : index;
        const score = typeof chunk.score === 'number' ? chunk.score.toFixed(3) : null;
        return (
          <span key={`${fileId}-${chunkIndex}-${index}`} title={typeof chunk.chunk_id === 'string' ? chunk.chunk_id : undefined}>
            {fileId.slice(0, 10)} · chunk {chunkIndex}{score ? ` · ${score}` : ''}
          </span>
        );
      })}
    </div>
  );
}

function RunTimelinePanel({
  events,
  error,
  focusTarget,
  onRefresh,
  onClose,
}: {
  events: RunEvent[] | null;
  error: string | null;
  focusTarget: RunTimelineFocusTarget | null;
  onRefresh: () => void;
  onClose: () => void;
}): JSX.Element {
  const groups = useMemo(() => {
    const map = new Map<string, RunEvent[]>();
    for (const event of events ?? []) {
      const list = map.get(event.run_id) ?? [];
      list.push(event);
      map.set(event.run_id, list);
    }
    return [...map.entries()].reverse();
  }, [events]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!focusTarget) return;
    const target = focusTarget.runEventId
      ? document.querySelector(`[data-testid="run-event"][data-event-id="${focusTarget.runEventId}"]`)
      : document.querySelector(`[data-testid="run-group"][data-run-id="${focusTarget.runId}"]`);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [events, focusTarget]);

  return (
    <aside className="run-timeline-panel" data-testid="run-timeline-panel">
      <header>
        <div>
          <h3>运行过程</h3>
          <span>{events ? `${events.length} 条事件` : '加载中'}</span>
        </div>
        <div className="run-timeline-actions">
          <button type="button" data-testid="run-timeline-refresh" onClick={onRefresh}>
            刷新
          </button>
          <button type="button" className="close" data-testid="run-timeline-close" onClick={onClose}>
            ×
          </button>
        </div>
      </header>
      <div className="panel-body">
        {error && (
          <StatusNotice
            tone="error"
            title="加载运行事件失败"
            detail={error}
            compact
            testId="run-timeline-error"
          />
        )}
        {!error && events == null && (
          <StatusNotice
            tone="loading"
            title="加载中…"
            detail="正在读取本次运行的事件流。"
            compact
            testId="run-timeline-loading"
          />
        )}
        {!error && events != null && events.length === 0 && (
          <EmptyState
            title="暂无运行事件"
            hint="当模型开始调用工具或进入执行流后，这里会显示完整过程。"
            icon="🧵"
            compact
            tone="muted"
            testId="run-timeline-empty"
          />
        )}
        {!error && groups.length > 0 && (
          <div className="run-groups">
            {groups.map(([runId, list]) => (
              <section
                className={`run-group${focusTarget?.runId === runId ? ' run-group-focused' : ''}`}
                data-testid="run-group"
                data-run-id={runId}
                key={runId}
              >
                <div className="run-group-head">
                  <strong>{runId}</strong>
                  <span>{new Date(list[0]!.created_at).toLocaleTimeString()}</span>
                </div>
                <ol>
                  {list.map((event) => {
                    const focused = focusTarget?.runEventId
                      ? focusTarget.runEventId === event.id
                      : focusTarget?.runId === event.run_id &&
                        event.kind === 'cost.recorded' &&
                        typeof event.payload?.cost_record_id === 'string' &&
                        event.payload.cost_record_id === focusTarget.costRecordId;
                    return (
                    <li
                      key={event.id}
                      className={`run-event run-event-${event.status}${focused ? ' run-event-focused' : ''}`}
                      data-testid="run-event"
                      data-event-id={event.id}
                      data-kind={event.kind}
                      data-status={event.status}
                      data-focused={focused ? '1' : '0'}
                    >
                      <span className="run-event-dot" aria-hidden="true" />
                      <div className="run-event-body">
                        <div className="run-event-title">
                          <strong>{event.label}</strong>
                          <span>{runEventStatusText(event.status)}</span>
                        </div>
                        <div className="run-event-meta">
                          {runEventMeta(event)}
                          {event.kind === 'cost.recorded' &&
                            typeof event.payload?.cost_record_id === 'string' && (
                              <button
                                type="button"
                                className="run-event-cost-link"
                                data-testid="run-event-focus-cost"
                                onClick={() => {
                                  dispatchCostCallFocus(event);
                                  onClose();
                                }}
                              >
                                查看成本
                              </button>
                            )}
                        </div>
                        {event.summary && (
                          <p>{event.summary}</p>
                        )}
                        <RunEventContextWindow event={event} />
                        <RunEventFileChunks event={event} />
                      </div>
                    </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function TemplateVariablesDialog({
  template,
  vars,
  answers,
  onAnswersChange,
  onCancel,
  onSubmit,
}: {
  template: TemplateLike;
  vars: string[];
  answers: Record<string, string>;
  onAnswersChange: (answers: Record<string, string>) => void;
  onCancel: () => void;
  onSubmit: (answers: Record<string, string>) => void;
}): JSX.Element {
  const preview = fillTemplateContent(template, answers);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="dialog-backdrop"
      data-testid="template-vars-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        className="picker-dialog"
        role="dialog"
        aria-label="填写模板变量"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(answers);
        }}
      >
        <div className="picker-dialog-head">
          <h3>填写模板变量</h3>
          <button type="button" className="settings-close" onClick={onCancel}>
            ✕
          </button>
        </div>
        <div className="template-var-form">
          {vars.map((key, index) => (
            <label key={key} className="template-var-field">
              <span>{key}</span>
              <input
                data-testid={`template-var-input-${key}`}
                autoFocus={index === 0}
                value={answers[key] ?? ''}
                onChange={(e) => onAnswersChange({ ...answers, [key]: e.target.value })}
                placeholder={`填写 ${key}`}
              />
            </label>
          ))}
        </div>
        <div className="template-var-preview" data-testid="template-var-preview">
          <span className="hint">预览</span>
          <pre>{preview}</pre>
        </div>
        <div className="modal-actions">
          <button type="submit" data-testid="template-vars-apply">
            插入模板
          </button>
          <button type="button" onClick={onCancel}>
            取消
          </button>
        </div>
      </form>
    </div>
  );
}

function QuickCompareModelPickerDialog({
  models,
  selectedIds,
  providers,
  currentModelId,
  onCancel,
  onSubmit,
}: {
  models: Model[];
  selectedIds: string[];
  providers: Provider[];
  currentModelId: string;
  onCancel: () => void;
  onSubmit: (modelIds: string[]) => void;
}): JSX.Element {
  const [draftIds, setDraftIds] = useState<string[]>(() => selectedIds.slice(0, 3));
  const canSubmit = draftIds.length >= 2 && draftIds.length <= 3;
  const toggleModel = (modelId: string): void => {
    setDraftIds((prev) => {
      if (prev.includes(modelId)) return prev.filter((id) => id !== modelId);
      if (prev.length >= 3) return prev;
      return [...prev, modelId];
    });
  };
  return (
    <div
      className="dialog-backdrop"
      data-testid="quick-compare-picker"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        className="picker-dialog quick-compare-picker-dialog"
        role="dialog"
        aria-label="选择 Quick Compare 模型"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(draftIds);
        }}
      >
        <div className="picker-dialog-head">
          <div>
            <h3>选择对比模型</h3>
            <p className="hint">选择 2-3 个可用聊天模型。默认已按当前模型、低成本和能力候选预选。</p>
          </div>
          <button type="button" className="settings-close" onClick={onCancel}>
            ✕
          </button>
        </div>
        <div className="quick-compare-model-list">
          {models.map((candidate) => {
            const checked = draftIds.includes(candidate.id);
            const disabled = !checked && draftIds.length >= 3;
            const provider = providers.find((item) => item.id === candidate.provider_id);
            return (
              <label
                key={candidate.id}
                className={`quick-compare-model-option${checked ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}
                data-testid={`quick-compare-model-option-${candidate.id}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggleModel(candidate.id)}
                  data-testid={`quick-compare-model-check-${candidate.id}`}
                />
                <span className="quick-compare-model-main">
                  <strong>{modelDisplayWithProvider(candidate, providers)}</strong>
                  <small>
                    {candidate.id === currentModelId ? '当前模型' : '候选模型'}
                    {provider ? ` · ${provider.name}` : ''}
                  </small>
                </span>
                <span className="quick-compare-model-tags">
                  {candidate.supports_tools && <span>tools</span>}
                  {candidate.supports_vision && <span>vision</span>}
                  {candidate.context_length ? <span>{formatTokenCount(candidate.context_length)} ctx</span> : null}
                  {candidate.price_input_per_1m != null && (
                    <span>{formatUsd(candidate.price_input_per_1m)}/1M in</span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
        <div className="modal-actions">
          <span className="quick-compare-picker-count" data-testid="quick-compare-picker-count">
            已选 {draftIds.length}/3
          </span>
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button
            type="submit"
            data-testid="quick-compare-picker-submit"
            disabled={!canSubmit}
          >
            开始对比
          </button>
        </div>
      </form>
    </div>
  );
}

function CapabilityPreflight({
  model,
  chatModels,
  tools,
  cost,
  busyToolName,
  imageModels,
  selectedImageModel,
  imageModelMemoryScope,
  imageModelPreferenceBusy,
  imageModelPreferenceError,
  providers,
  activePersona,
  conversationId,
  confirmPrefs,
  imageToolEnabled,
  estimatePoint,
  monthlyBudgetUsd,
  monthSpentUsd,
  inputHasText,
  inputText,
  pendingHasImage,
  onSetToolOverride,
  onOpenModelCenter,
  onOpenTools,
  onOpenRunTimeline,
  onSelectModel,
  onSelectImageModel,
  onSelectImageAuto,
}: {
  model: Model;
  chatModels: Model[];
  tools: EffectiveTool[];
  cost: { current_conversation_usd?: number | null } | null;
  busyToolName: string | null;
  imageModels: Model[];
  selectedImageModel: Model | null;
  imageModelMemoryScope: MemoryScopeLabel;
  imageModelPreferenceBusy: boolean;
  imageModelPreferenceError: string | null;
  providers: Provider[];
  activePersona: Persona | null;
  conversationId: string | null;
  confirmPrefs: {
    threshold: number;
    imageAlways: boolean;
    disabledModels: string[];
    disabledConvs: string[];
  };
  imageToolEnabled: boolean;
  estimatePoint: number | null;
  monthlyBudgetUsd: number | null;
  monthSpentUsd: number | null;
  inputHasText: boolean;
  inputText: string;
  pendingHasImage: boolean;
  onSetToolOverride: (name: string, enabled: boolean | null) => void;
  onOpenModelCenter: () => void;
  onOpenTools: () => void;
  onOpenRunTimeline: () => void;
  onSelectModel: (modelId: string) => void;
  onSelectImageModel: (modelId: string) => void;
  onSelectImageAuto: () => void;
}): JSX.Element {
  const toolNames = ['builtin.web_search', 'builtin.web_fetch', 'builtin.image_generate'];
  const visibleTools = tools.filter((toolItem) => toolNames.includes(toolItem.name));
  const enabledCount = tools.filter((toolItem) => toolItem.effective_enabled).length;
  const hasImageModel = imageModels.length > 0;
  const visionPeer = chatModels.find(
    (m) =>
      m.id !== model.id &&
      m.supports_vision &&
      m.enabled &&
      !m.demoted &&
      !(m.disabled_until && m.disabled_until > Date.now()),
  );
  const hasVisionPeer = Boolean(visionPeer || model.supports_vision);
  const toolPeer = chatModels.find(
    (m) =>
      m.id !== model.id &&
      m.supports_tools &&
      m.enabled &&
      !m.demoted &&
      !(m.disabled_until && m.disabled_until > Date.now()),
  );
  const skipCostConfirm =
    confirmPrefs.disabledModels.includes(model.id) ||
    (conversationId != null && confirmPrefs.disabledConvs.includes(conversationId));
  const budgetOver =
    monthlyBudgetUsd != null &&
    monthlyBudgetUsd > 0 &&
    monthSpentUsd != null &&
    monthSpentUsd >= monthlyBudgetUsd;
  const thresholdWillConfirm =
    inputHasText &&
    !skipCostConfirm &&
    estimatePoint != null &&
    estimatePoint > confirmPrefs.threshold;

  const imageState = !imageToolEnabled
    ? hasImageModel
      ? 'warn'
      : 'off'
    : model.supports_tools
    ? hasImageModel
      ? 'ready'
      : 'warn'
    : hasImageModel
      ? 'warn'
      : 'off';
  const imageText = !imageToolEnabled
    ? hasImageModel
      ? '图片生成：工具已关闭'
      : '图片生成：工具已关闭，且未配置 image 模型'
    : model.supports_tools
    ? hasImageModel
      ? `图片生成：模型可自主调用工具（当前 ${selectedImageModel ? modelDisplayWithProvider(selectedImageModel, providers) : 'image model'}）`
      : '图片生成：聊天模型支持工具，但未配置 image 模型'
    : hasImageModel
      ? '图片生成：当前聊天模型不支持工具；图片请求会打开生成器'
      : '图片生成：未配置 image 模型';
  const imageLabel = !imageToolEnabled
    ? hasImageModel
      ? '生图：工具关'
      : '生图：未配置'
    : model.supports_tools
      ? hasImageModel
        ? '生图：自动'
        : '生图：缺模型'
      : hasImageModel
        ? '生图：生成器'
        : '生图：未配置';
  const visionState = model.supports_vision ? 'ready' : hasVisionPeer ? 'fallback' : 'off';
  const visionText = model.supports_vision
    ? '图片输入：当前模型可看图'
    : hasVisionPeer
      ? '图片输入：拖图时会自动切换视觉模型'
      : '图片输入：未配置视觉模型';
  const visionLabel = model.supports_vision
    ? '看图'
    : hasVisionPeer
      ? '看图'
      : '无看图';
  const imageSelectValue = selectedImageModel?.id ?? imageModels[0]?.id ?? '';
  const imageGeneratorLabel = selectedImageModel
    ? modelDisplayWithProvider(selectedImageModel, providers)
    : imageModels[0]
      ? modelDisplayWithProvider(imageModels[0], providers)
      : '未配置';
  const imageModeText = imageModelPreferenceBusy
    ? '保存中'
    : imageModelMemoryScope === 'session'
      ? '本会话'
      : imageModelMemoryScope === 'global'
        ? '固定'
        : '自动';
  const personaText = activePersona
    ? `Persona：${activePersona.name}${conversationId ? '（本会话）' : '（发送后绑定会话）'}`
    : 'Persona：未绑定';
  const personaLabel = activePersona ? `Persona：${activePersona.name}` : 'Persona：无';
  const costState = skipCostConfirm
    ? 'muted'
    : budgetOver
      ? 'warn'
      : thresholdWillConfirm
        ? 'warn'
        : 'ready';
  const costText = skipCostConfirm
    ? '成本确认：已按偏好跳过'
    : budgetOver
      ? `成本确认：本月预算已超 ${formatUsd(monthlyBudgetUsd)}`
      : thresholdWillConfirm
        ? `成本确认：预计超过阈值 ${formatUsd(confirmPrefs.threshold)}`
      : `成本确认：阈值 ${formatUsd(confirmPrefs.threshold)}`;
  const costLabel = skipCostConfirm
    ? '确认：跳过'
    : budgetOver
      ? '确认：超预算'
      : thresholdWillConfirm
        ? `确认：>${formatUsd(confirmPrefs.threshold)}`
        : `确认：${formatUsd(confirmPrefs.threshold)}`;
  const text = inputText.trim().toLowerCase();
  const wantsWeb =
    /https?:\/\//.test(text) ||
    /搜索|检索|查找|网页|抓取|读取网页|最新|search|fetch|browse|web/.test(text);
  const wantsImage =
    /\/image\b|生成.*(图片|图像|海报|插图)|画一张|绘制|generate.*(image|poster|picture)/i.test(inputText);
  const suggestion = pendingHasImage && !model.supports_vision && visionPeer
    ? {
        kind: 'vision',
        text: `这条消息带图片，建议切到视觉模型：${modelDisplayWithProvider(visionPeer, providers)}`,
        modelId: visionPeer.id,
      }
    : wantsWeb && !model.supports_tools && toolPeer
      ? {
          kind: 'tools',
          text: `这条消息像是需要搜索/抓网页，建议切到工具模型：${modelDisplayWithProvider(toolPeer, providers)}`,
          modelId: toolPeer.id,
        }
      : wantsImage && !imageToolEnabled
        ? {
            kind: 'image-tool-off',
            text: '这条消息像是要生成图片，但 image_generate 工具已关闭。',
            modelId: null,
          }
        : null;

  return (
    <div className="capability-preflight" data-testid="capability-preflight">
      <span className="preflight-inline-metric preflight-session-summary" data-testid="session-profile-strip">
        <span data-testid="session-profile-tools">工具 {enabledCount}/{tools.length}</span>
        <span data-testid="session-profile-cost">会话 {formatUsd(cost?.current_conversation_usd ?? 0)}</span>
        <span className="sr-only" data-testid="session-profile-model">
          模型：{modelBaseDisplayName(model)}
        </span>
        <span className="sr-only" data-testid="session-profile-persona">
          {personaLabel}
        </span>
      </span>
      <div
        className={`preflight-select-card preflight-${imageState}`}
        data-testid="preflight-image"
        data-state={imageState}
        title={
          !imageToolEnabled
            ? 'builtin.image_generate 已关闭；自然语言图片请求和 /image 命令都不会打开图像生成器。'
            : model.supports_tools
            ? '普通图片生成请求会交给模型判断是否调用 image_generate；/image 命令仍会直接打开选择器。'
            : '当前聊天模型不能自主调用 tools；明确的图片生成请求会直接打开图像生成器，/image 命令也可用。'
        }
      >
        <button
          type="button"
          className={`preflight-mode-toggle ${imageModelMemoryScope === 'default' ? 'active' : ''}`}
          disabled={imageModelPreferenceBusy || !imageToolEnabled || !hasImageModel || imageModelMemoryScope === 'default'}
          onClick={onSelectImageAuto}
          title={
            imageModelMemoryScope === 'default'
              ? `自动使用 ${imageGeneratorLabel}`
              : '恢复为自动选择图像模型'
          }
        >
          生图 · {imageModeText}
        </button>
        <select
          value={imageSelectValue}
          onChange={(e) => {
            onSelectImageModel(e.target.value);
          }}
          disabled={imageModelPreferenceBusy || !imageToolEnabled || !hasImageModel}
          data-testid="preflight-image-model-select"
          aria-label="选择图像生成模型"
        >
          {imageModels.map((m) => (
            <option key={m.id} value={m.id}>
              {modelDisplayWithProvider(m, providers)}
            </option>
          ))}
        </select>
        <span className="sr-only">
          {imageText}
          {' '}
          {imageLabel}
          {' '}
          自主调用工具
          {' '}
          不支持工具
          {' '}
          打开生成器
          {' '}
          工具已关闭
        </span>
        <span className="sr-only" data-testid="preflight-image-model-scope">
          {imageModelPreferenceBusy
            ? '保存中'
            : imageModelMemoryScope === 'session'
              ? '会话'
              : imageModelMemoryScope === 'global'
                ? '全局'
                : '自动'}
        </span>
      </div>
      {imageModelPreferenceError && (
        <span className="preflight-error" data-testid="preflight-image-model-error">
          {imageModelPreferenceError}
        </span>
      )}
      <span
        className={`preflight-chip preflight-${visionState}`}
        data-testid="preflight-vision"
        data-state={visionState}
        title={visionText}
        aria-label={visionText}
      >
        <span>{visionLabel}</span>
        <span className="sr-only">{visionText} 看图：可用 看图：自动 看图：未配置</span>
      </span>
      <span
        className={`preflight-chip preflight-persona-chip ${activePersona ? 'preflight-ready' : 'preflight-muted'}`}
        data-testid="preflight-persona"
        data-state={activePersona ? 'ready' : 'muted'}
        title={personaText}
      >
        <span>{personaLabel}</span>
        <span className="sr-only">{personaText}</span>
      </span>
      <span
        className={`preflight-chip preflight-${costState}`}
        data-testid="preflight-cost"
        data-state={costState}
        title={costText}
      >
        <span>{costLabel}</span>
        <span className="sr-only">{costText}</span>
      </span>
      {!hasImageModel || !imageToolEnabled || (!model.supports_tools && hasImageModel) ? (
        <button
          type="button"
          className="preflight-link"
          data-testid="preflight-open-model-center"
          onClick={onOpenModelCenter}
        >
          检查模型配置
        </button>
      ) : null}
      <div className="session-tool-policy" data-testid="session-tool-policy">
        {visibleTools.map((toolItem) => {
          const disabled = !conversationId || !toolItem.enabled || busyToolName === toolItem.name;
          const next = toolItem.session_enabled === false ? null : false;
          const label =
            toolItem.name === 'builtin.web_search'
              ? '搜索'
              : toolItem.name === 'builtin.web_fetch'
                ? '抓网页'
                : '生图';
          return (
            <button
              key={toolItem.name}
              type="button"
              className={`session-tool-chip ${toolItem.effective_enabled ? 'on' : 'off'}`}
              data-testid={`session-tool-policy-${toolItem.name}`}
              disabled={disabled}
              title={
                conversationId
                  ? toolItem.enabled
                    ? '只影响当前会话；再次点击恢复继承全局设置。'
                    : '该工具已在全局关闭，请到工具中心开启。'
                  : '发送第一条消息后可设置当前会话工具策略。'
              }
              onClick={() => onSetToolOverride(toolItem.name, next)}
            >
              {label} {toolItem.effective_enabled ? '开' : '关'}
            </button>
          );
        })}
        <button
          type="button"
          className="session-tool-chip"
          data-testid="session-tool-policy-open-tools"
          onClick={onOpenTools}
        >
          工具中心
        </button>
        <button
          type="button"
          className="session-tool-chip"
          data-testid="open-run-timeline"
          disabled={!conversationId}
          onClick={onOpenRunTimeline}
          title={conversationId ? '查看当前会话最近的运行过程' : '发送第一条消息后可查看运行过程'}
        >
          运行过程
        </button>
      </div>
      {suggestion && (
        <div
          className="preflight-suggestion"
          data-testid="capability-suggestion"
          data-kind={suggestion.kind}
        >
          <span>{suggestion.text}</span>
          {suggestion.modelId ? (
            <button
              type="button"
              data-testid="capability-suggestion-switch"
              onClick={() => onSelectModel(suggestion.modelId!)}
            >
              切换
            </button>
          ) : (
            <button
              type="button"
              data-testid="capability-suggestion-configure"
              onClick={onOpenTools}
            >
              检查工具
            </button>
          )}
        </div>
      )}
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
  providers,
  conversationId,
  hasCheaperPeer,
  budget,
  blocked = false,
  onContinue,
  onCheaper,
  onCancel,
  onUpdatePrefs,
}: {
  estimate: number;
  reason: 'threshold' | 'image' | 'budget';
  model: Model;
  providers: Provider[];
  conversationId: string | null;
  hasCheaperPeer: boolean;
  budget?: {
    monthly_budget_usd: number;
    month_spent_usd: number;
    daily_budget_usd?: number;
    day_spent_usd?: number;
    period?: 'month' | 'day';
  };
  blocked?: boolean;
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
  const isDaily = reason === 'budget' && budget?.period === 'day';
  const periodLabel = isDaily ? '今日' : '本月';
  const breachBudget = isDaily ? (budget?.daily_budget_usd ?? 0) : (budget?.monthly_budget_usd ?? 0);
  const breachSpent = isDaily ? (budget?.day_spent_usd ?? 0) : (budget?.month_spent_usd ?? 0);
  const reasonLabel =
    reason === 'image'
      ? '图像模型按次计费确认'
      : reason === 'budget'
        ? `${periodLabel}预算已达到或超过上限`
        : '预估费用超过确认阈值';
  const scopeLabel = conversationId ? '当前会话 + 全局偏好' : '新会话 + 全局偏好';
  const nextStepLabel = hasCheaperPeer
    ? '可以继续、取消，或切换到已知价格更低的同能力模型。'
    : '可以继续或取消；当前没有已知价格更低的同能力模型。';
  const effectiveNextStepLabel = blocked
    ? '硬预算模式已阻止本次调用。请先到设置里调高预算或关闭硬上限。'
    : nextStepLabel;
  const modelLabel = modelDisplayWithProvider(model, providers);

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
        <h3>
          {reason === 'budget'
              ? blocked
                ? `${periodLabel}硬预算上限已达 ${formatUsd(breachBudget)}`
                : `${periodLabel}预算已达 ${formatUsd(breachBudget)}`
            : `本次调用预估 ≈ ${formatUsd(estimate)}`}
        </h3>
        <p className="hint">
          {reason === 'image'
            ? `图像模型「${modelLabel}」每次调用都会按设置确认。`
            : reason === 'budget'
              ? blocked
                ? `${periodLabel}已消费 ${formatUsd(breachSpent)}。硬上限模式下不能继续确认绕过。`
                : `${periodLabel}已消费 ${formatUsd(breachSpent)}。继续使用模型「${modelLabel}」前请再次确认。`
              : `模型「${modelLabel}」此次预估超过阈值，请确认是否继续。`}
        </p>
        <div className="decision-rationale" data-testid="cost-confirm-rationale">
          <div><strong>触发原因</strong><span>{reasonLabel}</span></div>
          <div><strong>当前模型</strong><span>{modelLabel}</span></div>
          <div><strong>偏好范围</strong><span>{scopeLabel}</span></div>
          <div><strong>下一步</strong><span>{effectiveNextStepLabel}</span></div>
        </div>
        <div className="modal-actions">
          {!blocked && (
            <button type="button" data-testid="cost-confirm-continue" autoFocus onClick={async () => { await persist(); onContinue(); }}>
              继续
            </button>
          )}
          <button
            type="button"
            data-testid="cost-confirm-cheaper"
            disabled={blocked || !hasCheaperPeer}
            title={hasCheaperPeer ? undefined : '没有已知价格更低的同能力模型可切换'}
            onClick={async () => { await persist(); onCheaper(); }}
          >
            {blocked ? '已被硬上限阻止' : '改用低成本模型'}
          </button>
          <button type="button" data-testid="cost-confirm-cancel" onClick={() => { onCancel(); }}>
            取消
          </button>
        </div>
        {reason !== 'budget' && (
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
        )}
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
        {error && (
          <StatusNotice
            tone="error"
            title="加载消费记录失败"
            detail={error}
            compact
            testId="session-cost-error"
          />
        )}
        {!error && rows == null && (
          <StatusNotice
            tone="loading"
            title="加载中…"
            detail="正在汇总当前范围内的费用记录。"
            compact
            testId="session-cost-loading"
          />
        )}
        {!error && rows != null && rows.length === 0 && (
          <EmptyState
            title="暂无消费记录"
            hint="本会话或当前范围内还没有产生任何计费调用。"
            icon="💸"
            compact
            tone="muted"
            testId="session-cost-empty"
          />
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
 * M2.4 — image picker modal. Triggered by explicit image commands
 * (`/image`, `/draw`, `/img`). Lets the user pick an image-capable model +
 * memory tier (once / session / global).
 */
function ImagePickerDialog({
  prompt,
  imageModels,
  providers,
  selectedModelId,
  memory,
  submitting,
  errorMsg,
  onSelectModel,
  onMemoryChange,
  onSubmit,
  onCancel,
}: {
  prompt: string;
  imageModels: Model[];
  providers: Provider[];
  selectedModelId: string | null;
  memory: 'once' | 'session' | 'global';
  submitting: boolean;
  errorMsg: string | null;
  onSelectModel: (id: string) => void;
  onMemoryChange: (m: 'once' | 'session' | 'global') => void;
  onSubmit: () => void;
  onCancel: () => void;
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
          图像生成提示词：&ldquo;{prompt.slice(0, 120)}{prompt.length > 120 ? '…' : ''}&rdquo;
        </p>
        {imageModels.length === 0 ? (
          <EmptyState
            title="没有可用的图像模型"
            hint="请到“设置 → 模型”启用一个 image 模型后再试。"
            icon="🖼"
            compact
            tone="warn"
            testId="image-picker-empty"
          />
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
                  <span className="image-model-name">{modelDisplayWithProvider(m, providers)}</span>
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
        <p className="memory-tier-hint" data-testid="image-memory-hint">
          {memory === 'once'
            ? '仅本次不会写入偏好；下次画图仍会询问。'
            : memory === 'session'
              ? '本会话默认会保存到当前对话；同一会话下次画图将直接使用该模型。'
              : '全局默认会影响之后的新会话；已有会话的本会话默认仍优先。'}
        </p>
        {errorMsg && (
          <StatusNotice
            tone="error"
            title="图像模型请求失败"
            detail={errorMsg}
            compact
            testId="image-picker-error"
          />
        )}
        {submitting && (
          <div className="image-generation-progress" data-testid="image-picker-progress" aria-live="polite">
            <span className="image-generation-progress__spinner" aria-hidden="true" />
            <div>
              <strong>正在生成并保存到当前对话</strong>
              <span>请求已发送给图像模型，完成后会自动插入消息并支持大图预览。</span>
            </div>
          </div>
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

function ImageGenerationProgress({
  prompt,
  modelName,
}: {
  prompt: string;
  modelName: string;
}): JSX.Element {
  return (
    <div className="image-generation-float" data-testid="image-generation-progress" role="status" aria-live="polite">
      <span className="image-generation-progress__spinner" aria-hidden="true" />
      <div>
        <strong>正在生成图片</strong>
        <span>{modelName} · {prompt.slice(0, 72)}{prompt.length > 72 ? '…' : ''}</span>
      </div>
    </div>
  );
}

function ImageLightbox({
  img,
  zoom,
  onZoom,
  onSave,
  onAttach,
  onClose,
}: {
  img: GeneratedImage;
  zoom: number;
  onZoom: (zoom: number) => void;
  onSave: () => void;
  onAttach: () => void;
  onClose: () => void;
}): JSX.Element {
  const safeZoom = Math.max(0.5, Math.min(3, zoom));
  const zoomLabel = `${Math.round(safeZoom * 100)}%`;
  return (
    <div
      className="image-lightbox"
      data-testid="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="image-lightbox__chrome">
        <div className="image-lightbox__meta">
          <strong>生成图片</strong>
          <span>{img.width && img.height ? `${img.width} x ${img.height}` : img.content_type}</span>
        </div>
        <div className="image-lightbox__actions">
          <button
            type="button"
            onClick={() => onZoom(Math.max(0.5, safeZoom - 0.25))}
            data-testid="image-lightbox-zoom-out"
          >
            缩小
          </button>
          <button
            type="button"
            onClick={() => onZoom(1)}
            data-testid="image-lightbox-zoom-reset"
          >
            {zoomLabel}
          </button>
          <button
            type="button"
            onClick={() => onZoom(Math.min(3, safeZoom + 0.25))}
            data-testid="image-lightbox-zoom-in"
          >
            放大
          </button>
          <button type="button" onClick={onSave} data-testid="image-lightbox-save">
            保存图片
          </button>
          <button type="button" onClick={onAttach} data-testid="image-lightbox-understand">
            理解这张图
          </button>
          <button type="button" onClick={onClose} data-testid="image-lightbox-close" aria-label="关闭">
            关闭
          </button>
        </div>
      </div>
      <div className="image-lightbox__stage">
        <img
          src={imageDataUrl(img)}
          alt={img.prompt ?? 'generated image'}
          style={{ width: `${safeZoom * 100}%` }}
        />
      </div>
      {img.prompt && <p className="image-lightbox__caption">{img.prompt}</p>}
    </div>
  );
}

function ModelSelector({
  models,
  providers,
  activeId,
  memoryScope,
  onChange,
}: {
  models: Model[];
  providers: Provider[];
  activeId: string;
  memoryScope: MemoryScopeLabel;
  onChange: (id: string) => void;
}): JSX.Element {
  const scopeText =
    memoryScope === 'session'
      ? '本会话'
      : memoryScope === 'global'
        ? '全局'
        : '默认';
  const scopeTitle =
    memoryScope === 'session'
      ? '当前模型来自本会话覆盖；切换后只影响这个会话。'
      : memoryScope === 'global'
        ? '当前模型来自全局偏好；新会话会默认使用它。'
        : '当前模型来自模型中心默认配置；切换后会写入全局偏好。';
  return (
    <span className="model-selector-wrap">
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
              {modelDisplayWithProvider(m, providers)}
              {m.supports_vision ? ' 👁' : ''}
              {indicator}
            </option>
          );
        })}
      </select>
      <span
        className={`scope-chip scope-${memoryScope} model-scope-chip`}
        data-testid="model-memory-scope"
        title={scopeTitle}
        aria-label={scopeText}
      >
        {scopeText}
      </span>
    </span>
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
  monthlyBudgetUsd,
  budgetLevel,
  onScopeClick,
}: {
  realtime: {
    current_conversation_usd: number;
    current_conversation_calls: number;
    today_usd: number;
    month_usd: number;
  } | null;
  monthlyBudgetUsd: number | null;
  budgetLevel: 'none' | 'half' | 'warn' | 'over';
  onScopeClick?: (scope: 'session' | 'today' | 'month') => void;
}): JSX.Element {
  if (!realtime) {
    return (
      <div className={`cost-bar budget-${budgetLevel}`} data-testid="cost-bar" data-budget-level={budgetLevel}>
        <span>本会话: —</span>
        <span>今日: —</span>
        <span>本月: —</span>
      </div>
    );
  }
  const monthSuffix =
    monthlyBudgetUsd != null
      ? ` / 预算 ${formatUsd(monthlyBudgetUsd)}${realtime.month_usd > 0 ? ` (${Math.round((realtime.month_usd / monthlyBudgetUsd) * 100)}%)` : ''}`
      : '';
  return (
    <div className={`cost-bar budget-${budgetLevel}`} data-testid="cost-bar" data-budget-level={budgetLevel}>
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
        本月: {formatUsd(realtime.month_usd)}{monthSuffix}
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
  detail?: string;
  can_compact_context?: boolean;
  can_skip_tool?: boolean;
  tool_name?: string | null;
  tool_label?: string | null;
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
  config_error: '请在「模型中心」检查模型名、Base URL、接入点，以及该模型是否真的支持当前能力（如 Tools / 视觉）。',
  key_missing: '请在「模型中心」→ Provider 旁边的 ⚙ 重新输入 API Key，或重启后重新配置。',
  unknown: '可重试或切换模型。',
};

function FailureDecisionCard({
  decision,
  chatModels,
  providers,
  onRetry,
  onSwitch,
  onCompact,
  onSkipTool,
  onOpenSettings,
  busy = false,
}: {
  decision: FailureDecision;
  chatModels: Model[];
  providers: Provider[];
  onRetry: () => void;
  onSwitch: (targetId: string) => void;
  onCompact: () => void;
  onSkipTool: (toolName: string) => void;
  onOpenSettings: () => void;
  busy?: boolean;
}): JSX.Element {
  const current = decision.current_model_id
    ? chatModels.find((m) => m.id === decision.current_model_id) ?? null
    : null;
  const recommended = decision.recommended_model_id
    ? chatModels.find((m) => m.id === decision.recommended_model_id) ?? null
    : null;
  const showSwitch =
    decision.classification !== 'content_filter' && recommended != null;
  const currentLabel = current
    ? modelDisplayWithProvider(current, providers)
    : decision.current_model_id ?? '当前模型';
  const recommendedLabel = recommended
    ? modelDisplayWithProvider(recommended, providers)
    : null;
  const routeText = showSwitch
    ? `建议切换到「${recommendedLabel ?? recommended!.display_name}」后重试。`
    : decision.classification === 'content_filter'
      ? '这是内容策略问题，系统不会推荐换模型绕过。'
      : '当前没有可用推荐模型，先按分类提示处理。';
  const showCompact = decision.can_compact_context === true;
  const showSkipTool = decision.can_skip_tool === true && Boolean(decision.tool_name);
  const toolLabel = decision.tool_label ?? decision.tool_name ?? '失败工具';
  const [useMobilePortal, setUseMobilePortal] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(max-width: 760px)').matches,
  );
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setUseMobilePortal(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const target = cardRef.current?.querySelector('[data-testid="fdc-switch"]') ?? cardRef.current;
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' });
      const timer = window.setTimeout(() => {
        target.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' });
      }, 50);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [decision.classification, decision.current_model_id, decision.recommended_model_id]);
  const card = (
    <div
      ref={cardRef}
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
      <div className="fdc-hint">{decision.detail ?? FAILURE_CLASS_HINT[decision.classification]}</div>
      <div className="decision-rationale fdc-rationale" data-testid="fdc-rationale">
        <div>
          <strong>失败来源</strong>
          <span>{currentLabel}</span>
        </div>
        <div>
          <strong>系统判断</strong>
          <span>{FAILURE_CLASS_LABEL[decision.classification]}，分类码 {decision.classification}</span>
        </div>
        <div>
          <strong>处理策略</strong>
          <span>{routeText}</span>
        </div>
      </div>
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
          disabled={busy}
        >
          {busy ? '恢复中…' : '↻ 重试'}
        </button>
        {showSwitch && (
          <button
            type="button"
            onClick={() => onSwitch(recommended!.id)}
            data-testid="fdc-switch"
            title={`切换到 ${recommendedLabel ?? recommended!.display_name}`}
            disabled={busy}
          >
            {busy ? '恢复中…' : `⇄ 切换到「${recommendedLabel ?? recommended!.display_name}」并重试`}
          </button>
        )}
        {showCompact && (
          <button
            type="button"
            onClick={onCompact}
            data-testid="fdc-compact"
            title="压缩较早上下文后重试"
            disabled={busy}
          >
            {busy ? '恢复中…' : '压缩上下文后重试'}
          </button>
        )}
        {showSkipTool && (
          <button
            type="button"
            onClick={() => onSkipTool(decision.tool_name!)}
            data-testid="fdc-skip-tool"
            title={`跳过 ${toolLabel} 后继续`}
            disabled={busy}
          >
            {busy ? '恢复中…' : `跳过「${toolLabel}」继续`}
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
  return useMobilePortal ? createPortal(card, document.body) : card;
}
