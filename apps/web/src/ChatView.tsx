import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Model } from '@taori/shared';
import { Composer } from './Composer';
import { Icon } from './Icon';
import { useToast } from './Toast';
import { getConversationRunEvents, type ChatAttachment, type ConversationMessage, type MessageAnnotation, type RunEvent } from './api';
import { renderMarkdown } from './markdown';

interface ChatViewProps {
  conversationId: string | null;
  title: string;
  messages: ConversationMessage[];
  models: Model[];
  streaming: boolean;
  composer: string;
  onComposerChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  modelLabel: string;
  onModelClick: () => void;
  attachments?: ChatAttachment[];
  onAttach?: (files: FileList) => void;
  onRemoveAttachment?: (index: number) => void;
  onRenameConversation: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onExport: () => void;
  onEditUserMessage: (message: ConversationMessage) => void;
  onBranchFromMessage: (message: ConversationMessage) => void;
  onStartDeepResearch: (objective: string) => void;
  onRecover: (
    message: ConversationMessage,
    action: 'continue' | 'retry_same_model' | 'compact_context',
  ) => void;
}

function formatUsd(value: number | null | undefined): string {
  if (value == null) return '';
  if (value === 0) return '$0.00';
  if (value < 0.01) return `<$0.01`;
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function formatRate(value: number | null | undefined): string {
  if (value == null) return '';
  return `$${value.toFixed(value < 1 ? 3 : 2)}/1M`;
}

function formatMs(value: number | null | undefined): string {
  if (value == null) return '';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)}s`;
}

function estimateUsd(cost: MessageAnnotation, model: Model | undefined): number | null {
  if (!model || model.price_input_per_1m == null || model.price_output_per_1m == null) return null;
  return ((cost.input_tokens ?? 0) * model.price_input_per_1m + (cost.output_tokens ?? 0) * model.price_output_per_1m) / 1_000_000;
}

/** The calm one-liner shown by default: cost · time · output size. No jargon. */
function costLead(message: ConversationMessage, models: Model[]): string {
  const cost = message.annotations.find((annotation) => annotation.type === 'cost');
  if (!cost) return '';
  const model = models.find((item) => item.id === message.model_id);
  const parts: string[] = [];
  const actual = cost.actual_usd != null ? cost.actual_usd : estimateUsd(cost, model);
  if (actual != null) parts.push(`${cost.actual_usd != null ? '' : '约 '}${formatUsd(actual)}`);
  if (cost.duration_ms != null) parts.push(formatMs(cost.duration_ms));
  if (cost.output_tokens != null) parts.push(`${cost.output_tokens} tokens`);
  return parts.join(' · ');
}

/** The power-user breakdown, revealed only on demand. */
function costDetails(message: ConversationMessage, models: Model[]): string[] {
  const cost = message.annotations.find((annotation) => annotation.type === 'cost');
  if (!cost) return [];
  const model = models.find((item) => item.id === message.model_id);
  const parts: string[] = [];
  if (cost.input_tokens != null) parts.push(`输入 ${cost.input_tokens}`);
  if (cost.cache_input_tokens != null) parts.push(`缓存 ${cost.cache_input_tokens}`);
  if (cost.output_tokens != null) parts.push(`输出 ${cost.output_tokens}`);
  if (cost.first_token_ms != null) parts.push(`首字 ${formatMs(cost.first_token_ms)}`);
  if (
    cost.duration_ms != null &&
    cost.first_token_ms != null &&
    cost.output_tokens != null &&
    cost.output_tokens > 1 &&
    cost.duration_ms >= cost.first_token_ms
  ) {
    parts.push(`每字 ${formatMs((cost.duration_ms - cost.first_token_ms) / Math.max(1, cost.output_tokens - 1))}`);
  }
  if (model?.price_input_per_1m != null || model?.price_output_per_1m != null) {
    const rates = [formatRate(model.price_input_per_1m), formatRate(model.price_output_per_1m)].filter(Boolean);
    if (rates.length > 0) parts.push(`单价 ${rates.join(' / ')}`);
  }
  return parts;
}

function streamingSummary(message: ConversationMessage): string {
  if (message.status !== 'streaming') return '';
  const cost = message.annotations.find((annotation) => annotation.type === 'cost');
  if (cost?.first_token_ms != null) return `正在生成 · 首字 ${formatMs(cost.first_token_ms)}`;
  if (message.content.length > 0) return '正在流式输出';
  return '等待首字';
}

function toolTraces(message: ConversationMessage): MessageAnnotation[] {
  return message.annotations.filter((annotation) => annotation.type === 'tool_trace');
}

function orchestrationAnnotation(message: ConversationMessage): MessageAnnotation | null {
  return message.annotations.find((annotation) => annotation.type === 'orchestration') ?? null;
}

function orchestrationReasonText(reason: MessageAnnotation['reason']): string {
  switch (reason) {
    case 'explicit_search':
      return '你明确要求搜索，已自动联网';
    case 'freshness_required':
      return '问题依赖最新信息，已自动联网';
    case 'evidence_required':
      return '问题需要来源依据，已自动联网';
    case 'high_stakes_current':
      return '涉及报名、政策或高风险时效信息，已自动联网';
    case 'deep_research_candidate':
      return '问题适合深度研究，已先补充网页上下文';
    case 'local_context_available':
      return '已优先考虑本地上下文';
    default:
      return '按当前对话自动选择能力';
  }
}

function orchestrationDetailText(plan: MessageAnnotation): string {
  const details: string[] = [];
  if (plan.external_info === 'web_search_fetch') details.push('搜索并预读网页');
  else if (plan.external_info === 'web_search') details.push('搜索网页');
  else if (plan.external_info === 'deep_research_suggest') details.push('建议深度研究');
  if (plan.search_tool_name) details.push(plan.search_tool_name);
  if (plan.query_count != null && plan.query_count > 0) details.push(`${plan.query_count} 个查询`);
  if (plan.fetch_top_k != null && plan.fetch_top_k > 0) details.push(`预读 ${plan.fetch_top_k} 条`);
  if (plan.cite_required) details.push('要求引用来源');
  return details.join(' · ');
}

function orchestrationPlanDetailText(payload: Record<string, unknown> | null): string {
  if (!payload) return '';
  const details: string[] = [];
  const externalInfo = typeof payload.externalInfo === 'string' ? payload.externalInfo : null;
  if (externalInfo === 'web_search_fetch') details.push('搜索并预读网页');
  else if (externalInfo === 'web_search') details.push('搜索网页');
  else if (externalInfo === 'deep_research_suggest') details.push('建议深度研究');
  const localContext = typeof payload.localContext === 'string' ? payload.localContext : null;
  if (localContext === 'file_search') details.push('检索本地文件');
  const searchToolName = typeof payload.searchToolName === 'string' ? payload.searchToolName : null;
  if (searchToolName) details.push(searchToolName);
  const queries = Array.isArray(payload.queries) ? payload.queries.length : null;
  if (queries != null && queries > 0) details.push(`${queries} 个查询`);
  const fetchTopK = typeof payload.fetchTopK === 'number' ? payload.fetchTopK : null;
  if (fetchTopK != null && fetchTopK > 0) details.push(`预读 ${fetchTopK} 条`);
  if (payload.citeRequired === true) details.push('要求引用来源');
  return details.join(' · ');
}

function runEventPayload(event: RunEvent): Record<string, unknown> | null {
  return event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : null;
}

function eventStatusText(status: string): string {
  switch (status) {
    case 'completed':
    case 'complete':
      return '完成';
    case 'failed':
      return '失败';
    case 'started':
      return '开始';
    case 'cancelled':
      return '取消';
    case 'stopped':
      return '停止';
    case 'incomplete':
      return '未完成';
    default:
      return status;
  }
}

function eventSummaryText(event: RunEvent): string {
  if (event.kind === 'orchestration.plan') {
    const payload = runEventPayload(event);
    const reason = typeof payload?.reason === 'string' ? payload.reason as MessageAnnotation['reason'] : undefined;
    const reasonText = orchestrationReasonText(reason);
    const detail = orchestrationPlanDetailText(payload);
    return detail ? `${reasonText} · ${detail}` : reasonText;
  }
  return event.summary ?? '';
}

function groupRunEvents(events: RunEvent[]): Array<{ runId: string; events: RunEvent[] }> {
  const groups = new Map<string, RunEvent[]>();
  for (const event of events) {
    const bucket = groups.get(event.run_id) ?? [];
    bucket.push(event);
    groups.set(event.run_id, bucket);
  }
  return Array.from(groups.entries()).map(([runId, groupEvents]) => ({
    runId,
    events: groupEvents.sort((a, b) => b.created_at - a.created_at),
  }));
}

function sameMessageIdentity(prev: ConversationMessage, next: ConversationMessage): boolean {
  return (
    prev.id === next.id &&
    prev.content === next.content &&
    prev.status === next.status &&
    prev.error === next.error &&
    prev.model_id === next.model_id &&
    prev.attachments_count === next.attachments_count &&
    prev.annotations === next.annotations
  );
}

function toolStatus(trace: MessageAnnotation): { label: string; className: string } {
  if (trace.event === 'finish') {
    return trace.ok === false
      ? { label: '失败', className: 'bad' }
      : { label: '完成', className: 'ok' };
  }
  return { label: '进行中', className: 'running' };
}

function truncateTraceValue(value: string | null | undefined): string {
  if (!value) return '';
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function previousUserContent(messages: ConversationMessage[], messageId: string): string {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return '';
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate?.role === 'user' && candidate.content.trim()) return candidate.content.trim();
  }
  return '';
}

const NEAR_BOTTOM_PX = 120;
const INITIAL_MESSAGE_WINDOW_SIZE = 80;
const MESSAGE_WINDOW_STEP = 80;

export function ChatView(props: ChatViewProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const editMessageRef = useRef(props.onEditUserMessage);
  const branchMessageRef = useRef(props.onBranchFromMessage);
  const recoverMessageRef = useRef(props.onRecover);
  const startDeepResearchRef = useRef(props.onStartDeepResearch);
  const [showJump, setShowJump] = useState(false);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_MESSAGE_WINDOW_SIZE);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const visibleMessages = useMemo(
    () => props.messages.slice(-visibleMessageCount),
    [props.messages, visibleMessageCount],
  );
  const hiddenMessageCount = Math.max(0, props.messages.length - visibleMessages.length);
  const runGroups = useMemo(() => groupRunEvents(runEvents), [runEvents]);

  useEffect(() => {
    editMessageRef.current = props.onEditUserMessage;
    branchMessageRef.current = props.onBranchFromMessage;
    recoverMessageRef.current = props.onRecover;
    startDeepResearchRef.current = props.onStartDeepResearch;
  }, [props.onBranchFromMessage, props.onEditUserMessage, props.onRecover, props.onStartDeepResearch]);

  const handleEditUserMessage = useCallback((message: ConversationMessage) => {
    editMessageRef.current(message);
  }, []);
  const handleBranchFromMessage = useCallback((message: ConversationMessage) => {
    branchMessageRef.current(message);
  }, []);
  const handleRecover = useCallback((
    message: ConversationMessage,
    action: 'continue' | 'retry_same_model' | 'compact_context',
  ) => {
    recoverMessageRef.current(message, action);
  }, []);
  const handleStartDeepResearch = useCallback((objective: string) => {
    startDeepResearchRef.current(objective);
  }, []);

  function scrollToBottom(behavior: ScrollBehavior = 'auto'): void {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    atBottomRef.current = true;
    setShowJump(false);
  }

  // Jump to the latest turn whenever the conversation changes.
  useEffect(() => {
    setVisibleMessageCount(INITIAL_MESSAGE_WINDOW_SIZE);
    atBottomRef.current = true;
    scrollToBottom('auto');
  }, [props.conversationId]);

  // While streaming/appending, only follow the tail if the reader is already there.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (atBottomRef.current) {
      node.scrollTop = node.scrollHeight;
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [props.messages]);

  function handleScroll(): void {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    const atBottom = distance < NEAR_BOTTOM_PX;
    atBottomRef.current = atBottom;
    setShowJump(!atBottom);
  }

  function handleLoadEarlier(): void {
    const node = scrollRef.current;
    const previousHeight = node?.scrollHeight ?? 0;
    setVisibleMessageCount((count) => Math.min(props.messages.length, count + MESSAGE_WINDOW_STEP));
    window.requestAnimationFrame(() => {
      if (!node) return;
      node.scrollTop += node.scrollHeight - previousHeight;
    });
  }

  async function openRunTimeline(): Promise<void> {
    if (!props.conversationId) return;
    setTimelineOpen(true);
    setTimelineLoading(true);
    setTimelineError(null);
    try {
      const events = await getConversationRunEvents(props.conversationId, 120);
      setRunEvents(events);
    } catch (error) {
      setTimelineError(error instanceof Error ? error.message : String(error));
    } finally {
      setTimelineLoading(false);
    }
  }

  return (
    <>
      <div className="topbar with-border">
        <div className="topbar-title">{props.title || '新对话'}</div>
        <div className="topbar-actions">
          <button type="button" className="icon-btn" title="重命名" onClick={props.onRenameConversation}>
            <Icon name="edit" size={14} />
          </button>
          <button type="button" className="icon-btn" title="固定/取消固定" onClick={props.onTogglePin}>
            <Icon name="pin" size={14} />
          </button>
          <button type="button" className="icon-btn" title="归档" onClick={props.onArchive}>
            <Icon name="archive" size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="运行记录"
            onClick={() => {
              void openRunTimeline();
            }}
            data-testid="open-run-timeline"
          >
            <Icon name="bolt" size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="导出 Markdown"
            onClick={props.onExport}
            data-testid="conversation-export"
          >
            <Icon name="doc" size={14} />
          </button>
          <button type="button" className="model-pill" onClick={props.onModelClick}>
            <span className="dot" />
            {props.modelLabel}
            <Icon name="chevronDown" size={12} />
          </button>
        </div>
      </div>

      {timelineOpen && (
        <div className="run-timeline-panel" data-testid="run-timeline-panel" role="dialog" aria-label="运行记录">
          <div className="run-timeline-head">
            <div>
              <div className="run-timeline-kicker">运行记录</div>
              <div className="run-timeline-heading">模型、工具与能力编排</div>
            </div>
            <button
              type="button"
              className="icon-btn"
              title="关闭"
              onClick={() => setTimelineOpen(false)}
              data-testid="run-timeline-close"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          <div className="run-timeline-body">
            {timelineLoading && <div className="run-timeline-empty">正在读取运行记录…</div>}
            {timelineError && <div className="run-timeline-empty is-error">{timelineError}</div>}
            {!timelineLoading && !timelineError && runGroups.length === 0 && (
              <div className="run-timeline-empty">当前会话还没有运行记录</div>
            )}
            {!timelineLoading && !timelineError && runGroups.map((group) => (
              <div className="run-group" key={group.runId} data-testid="run-group">
                <div className="run-group-title">
                  <span>{group.runId}</span>
                  <span>{group.events.length} 条事件</span>
                </div>
                <div className="run-events">
                  {group.events.map((event) => {
                    const summary = eventSummaryText(event);
                    const isOrchestration = event.kind === 'orchestration.plan';
                    return (
                      <div
                        className={`run-event ${isOrchestration ? 'is-orchestration' : ''}`}
                        key={event.id ?? `${event.run_id}-${event.kind}-${event.created_at}`}
                        data-testid="run-event"
                        data-kind={event.kind}
                      >
                        <span className={`run-dot ${event.status}`} />
                        <span className="run-event-kind">{event.label ?? event.kind}</span>
                        <span className={`run-event-status ${event.status}`}>{eventStatusText(event.status)}</span>
                        {summary && <span className="run-summary">{summary}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="convo scroll" ref={scrollRef} onScroll={handleScroll} data-testid="convo">
        <div className="convo-inner">
          {hiddenMessageCount > 0 && (
            <div className="message-window-notice" data-testid="message-window-notice">
              <button type="button" onClick={handleLoadEarlier} data-testid="message-load-earlier">
                <Icon name="chevron" size={13} style={{ transform: 'rotate(-90deg)' }} />
                <span>加载更早 {Math.min(hiddenMessageCount, MESSAGE_WINDOW_STEP)} 条</span>
              </button>
              <span>已收起 {hiddenMessageCount} 条历史，降低长对话占用</span>
            </div>
          )}
          {visibleMessages.map((message) => (
            <MemoizedMessage
              key={message.id}
              message={message}
              models={props.models}
              deepResearchObjective={previousUserContent(props.messages, message.id)}
              onEditUserMessage={handleEditUserMessage}
              onBranchFromMessage={handleBranchFromMessage}
              onStartDeepResearch={handleStartDeepResearch}
              onRecover={handleRecover}
            />
          ))}
        </div>
      </div>

      {showJump && (
        <button
          type="button"
          className="jump-bottom"
          onClick={() => scrollToBottom('smooth')}
          title="回到最新"
          data-testid="jump-to-latest"
        >
          <Icon name="chevronDown" size={15} />
          <span>回到最新</span>
        </button>
      )}

      <div className="composer-dock">
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          <Composer
            value={props.composer}
            onChange={props.onComposerChange}
            onSubmit={props.onSubmit}
            onStop={props.onStop}
            streaming={props.streaming}
            disabled={false}
            modelLabel={props.modelLabel}
            onModelClick={props.onModelClick}
            attachments={props.attachments}
            onAttach={props.onAttach}
            onRemoveAttachment={props.onRemoveAttachment}
            placeholder="继续这段对话…"
          />
        </div>
      </div>
    </>
  );
}

const MemoizedMessage = memo(Message, (prev, next) =>
  sameMessageIdentity(prev.message, next.message) &&
  prev.models === next.models &&
  prev.deepResearchObjective === next.deepResearchObjective &&
  prev.onEditUserMessage === next.onEditUserMessage &&
  prev.onBranchFromMessage === next.onBranchFromMessage &&
  prev.onStartDeepResearch === next.onStartDeepResearch &&
  prev.onRecover === next.onRecover,
);

function Message({
  message,
  models,
  deepResearchObjective,
  onEditUserMessage,
  onBranchFromMessage,
  onStartDeepResearch,
  onRecover,
}: {
  message: ConversationMessage;
  models: Model[];
  deepResearchObjective: string;
  onEditUserMessage: (message: ConversationMessage) => void;
  onBranchFromMessage: (message: ConversationMessage) => void;
  onStartDeepResearch: (objective: string) => void;
  onRecover: (
    message: ConversationMessage,
    action: 'continue' | 'retry_same_model' | 'compact_context',
  ) => void;
}): JSX.Element {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const isStreaming = message.status === 'streaming';
  const isPending = isStreaming && message.content.length === 0;
  const isFailed = message.status === 'failed';
  const isIncomplete = message.status === 'incomplete';
  const lead = costLead(message, models);
  const details = costDetails(message, models);
  const liveMeta = streamingSummary(message);
  const traces = toolTraces(message);
  const orchestration = orchestrationAnnotation(message);
  const renderedMarkdown = useMemo(
    () => (message.role === 'assistant' && !isStreaming && !isPending ? renderMarkdown(message.content) : null),
    [isPending, isStreaming, message.content, message.role],
  );

  async function copyAssistantContent(): Promise<void> {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.warn('复制失败，请手动选择文本。');
    }
  }

  if (message.role === 'user') {
    return (
      <div className="msg user">
        <div>
        <div className="bubble">{message.content}</div>
        <div className="msg-actions">
            {message.attachments_count > 0 && (
              <span className="msg-meta" data-testid="message-attachment-count">
                {message.attachments_count} 个附件
              </span>
            )}
            <button
              type="button"
              className="msg-action"
              onClick={() => onEditUserMessage(message)}
              data-testid={`message-edit-${message.id}`}
            >
              编辑
            </button>
            <button
              type="button"
              className="msg-action"
              onClick={() => onBranchFromMessage(message)}
              data-testid={`message-branch-${message.id}`}
            >
              分支
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="msg ai">
      <div className="avatar-mark">织</div>
      <div className="ai-body">
        {isPending ? (
          <p className="pending">正在思考…</p>
        ) : isStreaming ? (
          <pre className="streaming-plain cursor-blink">{message.content}</pre>
        ) : (
          <div className={isStreaming ? 'cursor-blink' : undefined}>
            {renderedMarkdown}
          </div>
        )}
        {(isFailed || isIncomplete) && (
          <div
            className={`recovery-card${isFailed ? ' is-failed' : ''}`}
            data-testid={`recovery-card-${message.id}`}
          >
            <div className="recovery-head">
              <span className="recovery-icon">
                <Icon name={isFailed ? 'refresh' : 'stop'} size={13} />
              </span>
              <span className="recovery-title">
                {isFailed ? '这条回复没能完成' : '已停止生成'}
              </span>
            </div>
            <div className="recovery-reason">
              {isFailed
                ? message.error || '生成中途断开了，下面任选一种方式接着来。'
                : '已经写到这里 — 可以接着写下去，或重新来过。'}
            </div>
            <div className="recovery-actions">
              <button
                type="button"
                className="btn-primary recovery-primary"
                onClick={() => onRecover(message, 'continue')}
                data-testid={`recover-continue-${message.id}`}
              >
                继续生成
              </button>
              <button
                type="button"
                className="btn-quiet"
                onClick={() => onRecover(message, 'retry_same_model')}
                data-testid={`recover-retry-${message.id}`}
              >
                重试
              </button>
              <button
                type="button"
                className="btn-quiet"
                onClick={() => onRecover(message, 'compact_context')}
                data-testid={`recover-compact-${message.id}`}
                title="精简较早的上下文后重试，常用于上下文超长导致的失败"
              >
                精简上下文重试
              </button>
            </div>
          </div>
        )}
        {orchestration && (
          <OrchestrationNotice
            plan={orchestration}
            onStartDeepResearch={() => onStartDeepResearch(deepResearchObjective || message.content)}
          />
        )}
        {traces.length > 0 && <ToolTraceList traces={traces} />}
        {liveMeta && <div className="msg-meta">{liveMeta}</div>}
        {!isStreaming && lead && <MessageCost lead={lead} details={details} />}
        {!isStreaming && !isPending && message.status !== 'failed' && message.content && (
          <div className="msg-actions ai-actions">
            <button
              type="button"
              className="msg-action"
              onClick={() => void copyAssistantContent()}
              title="复制全部"
              data-testid={`assistant-copy-${message.id}`}
            >
              <Icon name="copy" size={12} />
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
            <button
              type="button"
              className="msg-action"
              onClick={() => onRecover(message, 'retry_same_model')}
              title="重新生成"
              data-testid={`assistant-regenerate-${message.id}`}
            >
              <Icon name="refresh" size={12} />
              <span>重新生成</span>
            </button>
            <button
              type="button"
              className="msg-action"
              onClick={() => onBranchFromMessage(message)}
              title="从这里分支"
              data-testid={`assistant-branch-${message.id}`}
            >
              <Icon name="panel" size={12} />
              <span>分支</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MessageCost({ lead, details }: { lead: string; details: string[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const hasDetails = details.length > 0;
  return (
    <div className="msg-cost" data-testid="message-cost">
      <button
        type="button"
        className={`msg-cost-lead${hasDetails ? '' : ' static'}`}
        onClick={() => hasDetails && setOpen((value) => !value)}
        title={hasDetails ? (open ? '收起明细' : '查看明细') : undefined}
        aria-expanded={hasDetails ? open : undefined}
        data-testid="message-cost-toggle"
      >
        <span>{lead}</span>
        {hasDetails && <Icon name="chevronDown" size={11} style={{ opacity: open ? 1 : 0.5 }} />}
      </button>
      {open && hasDetails && (
        <div className="msg-cost-details" data-testid="message-cost-details">
          {details.map((part) => (
            <span key={part}>{part}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function OrchestrationNotice({
  plan,
  onStartDeepResearch,
}: {
  plan: MessageAnnotation;
  onStartDeepResearch?: () => void;
}): JSX.Element {
  const detail = orchestrationDetailText(plan);
  return (
    <div className="orchestration-notice" data-testid="orchestration-notice">
      <Icon name="search" size={13} />
      <span>{orchestrationReasonText(plan.reason)}</span>
      {detail && <em>{detail}</em>}
      {plan.external_info === 'deep_research_suggest' && onStartDeepResearch && (
        <button type="button" className="orchestration-action" onClick={onStartDeepResearch}>
          转为深度研究
        </button>
      )}
    </div>
  );
}

function ToolTraceList({ traces }: { traces: MessageAnnotation[] }): JSX.Element {
  return (
    <div className="tool-traces" data-testid="tool-trace-list">
      {traces.map((trace) => {
        const status = toolStatus(trace);
        const input = truncateTraceValue(trace.input);
        const output = truncateTraceValue(trace.output);
        return (
          <div className="tool-trace" key={trace.call_id ?? `${trace.tool}-${trace.label}`}>
            <div className={`tool-trace-icon ${status.className}`}>
              <Icon name={trace.tool?.includes('image') ? 'image' : 'bolt'} size={14} />
            </div>
            <div className="tool-trace-body">
              <div className="tool-trace-head">
                <span className="tool-trace-name">{trace.label || trace.tool || '工具调用'}</span>
                <span className={`tool-trace-status ${status.className}`}>{status.label}</span>
              </div>
              {(input || output || trace.duration_ms != null) && (
                <div className="tool-trace-meta">
                  {input && <span>{input}</span>}
                  {output && <span>{output}</span>}
                  {trace.duration_ms != null && <span>{trace.duration_ms}ms</span>}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
