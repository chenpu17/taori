import { useEffect, useRef, useState } from 'react';
import type { Model } from '@taori/shared';
import { Composer } from './Composer';
import { Icon } from './Icon';
import { useToast } from './Toast';
import type { ChatAttachment, ConversationMessage, MessageAnnotation } from './api';
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

const NEAR_BOTTOM_PX = 120;

export function ChatView(props: ChatViewProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  function scrollToBottom(behavior: ScrollBehavior = 'auto'): void {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    atBottomRef.current = true;
    setShowJump(false);
  }

  // Jump to the latest turn whenever the conversation changes.
  useEffect(() => {
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

      <div className="convo scroll" ref={scrollRef} onScroll={handleScroll} data-testid="convo">
        <div className="convo-inner">
          {props.messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              models={props.models}
              onEditUserMessage={props.onEditUserMessage}
              onBranchFromMessage={props.onBranchFromMessage}
              onRecover={props.onRecover}
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

function Message({
  message,
  models,
  onEditUserMessage,
  onBranchFromMessage,
  onRecover,
}: {
  message: ConversationMessage;
  models: Model[];
  onEditUserMessage: (message: ConversationMessage) => void;
  onBranchFromMessage: (message: ConversationMessage) => void;
  onRecover: (
    message: ConversationMessage,
    action: 'continue' | 'retry_same_model' | 'compact_context',
  ) => void;
}): JSX.Element {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

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
  const isStreaming = message.status === 'streaming';
  const isPending = isStreaming && message.content.length === 0;
  const isFailed = message.status === 'failed';
  const isIncomplete = message.status === 'incomplete';
  const lead = costLead(message, models);
  const details = costDetails(message, models);
  const liveMeta = streamingSummary(message);
  const traces = toolTraces(message);

  return (
    <div className="msg ai">
      <div className="avatar-mark">织</div>
      <div className="ai-body">
        {isPending ? (
          <p className="pending">正在思考…</p>
        ) : (
          <div className={isStreaming ? 'cursor-blink' : undefined}>
            {renderMarkdown(message.content)}
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
