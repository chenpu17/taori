import type { PassThrough } from 'node:stream';
import {
  type ErrorClassification,
  type FileSearchResult,
} from '@taori/shared';
import type { CapabilityBus } from '../bus/index.js';
import {
  type ConversationsRepo,
  type CostsRepo,
  type FilesRepo,
  type MemoriesRepo,
  type MessageRow,
  type MessagesRepo,
  type ModelsRepo,
  type ProvidersRepo,
  type RunEventInsert,
  type RunEventsRepo,
  type StructuredMemoriesRepo,
} from '../db/repos/index.js';
import type { KeyStore } from '../keystore.js';
import { scheduleMemoryExtraction } from '../memory/extraction.js';
import { scheduleAutoTitle } from './auto-title.js';
import { applyContextWindow, type ContextWindowStats } from './context-window.js';
import { getVisibleToolNames } from './upstream-tools.js';
import type { StreamObserver } from './protocol.js';

export interface ProduceCtx {
  runId: string;
  conversationId: string;
  messageId: string;
  modelId: string;
  modelDbId: string | null;
  modelNameSnapshot: string;
  contextLength: number | null;
  priceInputPer1m: number | null;
  priceOutputPer1m: number | null;
  pricePerCall: number | null;
  userText: string;
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
  attachments: {
    kind: 'image' | 'text' | 'pdf';
    mime: string;
    data_b64: string;
    name?: string;
    file_id?: string;
  }[];
  personaName: string | null;
  toolPolicy: Record<string, boolean>;
  defaultSearchToolName?: string | null;
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  /** dev-only test hook: force classification on upstream call (M2 §6.1) */
  forcedClassification: string | null;
  /** capability of the model — used to pick fallback within same family */
  capability: string;
  /** Whether the selected chat model is expected to support tool calls. */
  supportsTools: boolean;
  /** Persisted user message that triggered this assistant turn. */
  sourceUserMessageId: string | null;
  /**
   * M2.5 §F-CR — capability-bus reference and the image model the LLM should
   * route image_generate calls to. Both null = no image tool offered. The
   * explicit command route runs BEFORE this and is mutually exclusive.
   */
  bus: CapabilityBus | null;
  imageModelId: string | null;
  filesRepo: FilesRepo | null;
  runEventsRepo: RunEventsRepo;
  fileContextSnippets?: FileSearchResult[];
  contextWindowStats?: ContextWindowStats;
}

export function appendRunEvent(
  log: ProduceCtx['log'],
  repo: RunEventsRepo,
  input: RunEventInsert,
): void {
  repo.appendSafe(input, log);
}

export function recordRunEvent(
  ctx: ProduceCtx,
  input: Omit<RunEventInsert, 'run_id' | 'conversation_id' | 'message_id'> & {
    message_id?: string | null;
  },
): void {
  appendRunEvent(ctx.log, ctx.runEventsRepo, {
    run_id: ctx.runId,
    conversation_id: ctx.conversationId,
    message_id: input.message_id ?? ctx.messageId,
    kind: input.kind,
    status: input.status,
    label: input.label,
    summary: input.summary,
    payload: input.payload,
  });
}

/**
 * Convert ChatRequest.messages + attachments into AI SDK CoreMessages.
 *
 * Attachments are bound to the LAST user turn — this matches OpenAI/OpenRouter
 * convention where user uploads sit alongside the prompt that referred to them.
 * Image attachments become content parts; everything else falls back to a
 * text-only message.
 */
export function buildUpstreamMessages(ctx: ProduceCtx): { messages: any[]; stats: ContextWindowStats } {
  let prepared: any[];
  if (!ctx.attachments || ctx.attachments.length === 0) {
    prepared = ctx.messages;
    return applyContextWindow(prepared, ctx.contextLength);
  }
  prepared = [];
  const out: any[] = [];
  let lastUserIdx = -1;
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    if (ctx.messages[i]!.role === 'user') { lastUserIdx = i; break; }
  }
  // Decode text attachments once and prepend them as a fenced block above the
  // user prompt. We cap each decoded attachment at ~200KB of text to avoid
  // blowing the context budget for tiny models — anything past the cap is
  // truncated with a clear marker so the user sees it happened.
  //
  // Two safety considerations:
  //   1. User-controlled content could break out of triple-backtick fences
  //      and inject prompts. We escape backtick fences (`\`\`\``) inside
  //      `decoded` to a zero-width-joiner-separated form so the model sees
  //      them as text but they no longer terminate the wrapper.
  //   2. Files misclassified as text/* may be binary; Buffer.toString('utf-8')
  //      silently inserts U+FFFD replacement chars. We count those and bail
  //      out (skip the attachment with a notice) when the ratio looks like
  //      binary garbage rather than UTF-8 text.
  const TEXT_CAP = 200_000;
  const textBlocks: string[] = [];
  const imageParts: any[] = [];
  for (const a of ctx.attachments) {
    if (a.kind === 'image') {
      imageParts.push({
        type: 'image',
        image: Buffer.from(a.data_b64, 'base64'),
        mimeType: a.mime,
      });
    } else if (a.kind === 'text' || a.kind === 'pdf') {
      if (a.file_id) {
        const fallbackName = a.kind === 'pdf' ? 'document.pdf' : 'attachment.txt';
        const name = a.name ?? fallbackName;
        const prefix = a.kind === 'pdf' ? '【附件 PDF】' : '【附件】';
        textBlocks.push(`${prefix}${name}（已建立索引，将按问题检索相关片段）`);
        continue;
      }
      let decoded = '';
      try {
        decoded = Buffer.from(a.data_b64, 'base64').toString('utf-8');
      } catch {
        decoded = '';
      }
      if (!decoded) continue;
      // Detect binary-misclassified-as-text: if more than 1% of the first
      // 4KB is U+FFFD (the UTF-8 replacement char), treat the file as
      // unreadable and surface a notice instead of garbage tokens.
      const sample = decoded.slice(0, 4096);
      const replCount = (sample.match(/\uFFFD/g) ?? []).length;
      if (sample.length > 0 && replCount / sample.length > 0.01) {
        textBlocks.push(`【附件：${a.name ?? 'attachment'}】（无法以 UTF-8 解码，已忽略内容）`);
        continue;
      }
      let truncatedNotice = '';
      if (decoded.length > TEXT_CAP) {
        decoded = decoded.slice(0, TEXT_CAP);
        truncatedNotice = `\n…（已截断，原始文件超过 ${Math.round(TEXT_CAP / 1024)}KB）`;
      }
      // Neutralise any embedded triple-backtick fences so user-supplied text
      // can't escape our wrapper and inject instructions. We insert a zero-
      // width space between each pair of backticks; the model still reads
      // them as backticks but the closing fence is no longer matchable.
      const safe = decoded.replace(/```/g, '`\u200b`\u200b`');
      const fallbackName = a.kind === 'pdf' ? 'document.pdf' : 'attachment.txt';
      const name = a.name ?? fallbackName;
      const lang = a.kind === 'pdf' ? '' : (name.endsWith('.md') ? 'markdown' : '');
      const labelPrefix = a.kind === 'pdf' ? '【附件 PDF（已解析为文本）：' : '【附件：';
      textBlocks.push(`${labelPrefix}${name}】\n\`\`\`${lang}\n${safe}${truncatedNotice}\n\`\`\``);
    }
  }
  for (let i = 0; i < ctx.messages.length; i++) {
    const m = ctx.messages[i]!;
    if (i === lastUserIdx) {
      const userText = textBlocks.length > 0
        ? `${textBlocks.join('\n\n')}\n\n${m.content}`
        : m.content;
      if (imageParts.length > 0) {
        out.push({
          role: 'user',
          content: [{ type: 'text', text: userText }, ...imageParts],
        });
      } else {
        out.push({ role: 'user', content: userText });
      }
    } else {
      out.push(m);
    }
  }
  prepared = out;
  return applyContextWindow(prepared, ctx.contextLength);
}

export function captureContextWindowStats(ctx: ProduceCtx): void {
  ctx.contextWindowStats = applyContextWindow(ctx.messages, ctx.contextLength).stats;
}

export function buildContextSnapshot(ctx: ProduceCtx): Record<string, unknown> {
  const activeToolNames = getVisibleToolNames(ctx);
  const activeToolNameSet = new Set(activeToolNames);
  const disabledToolNames = Object.keys(ctx.toolPolicy).filter((name) => !activeToolNameSet.has(name));
  const attachmentCount = ctx.attachments.length;
  return {
    type: 'context_snapshot',
    message_id: ctx.messageId,
    conversation_id: ctx.conversationId,
    model_id: ctx.modelDbId,
    active_tool_names: activeToolNames,
    disabled_tool_names: disabledToolNames,
    context_sources: [
      {
        type: 'model',
        label: ctx.modelNameSnapshot,
        scope: 'request',
        active: true,
      },
      {
        type: 'persona',
        label: ctx.personaName ?? '未绑定 Persona',
        scope: ctx.personaName ? 'session' : 'default',
        active: Boolean(ctx.personaName),
      },
      {
        type: 'attachment',
        label: attachmentCount > 0 ? `${attachmentCount} 个附件` : '无附件',
        scope: 'request',
        active: attachmentCount > 0,
      },
      {
        type: 'tool_policy',
        label: `${activeToolNames.length}/${activeToolNames.length + disabledToolNames.length} 个工具可用`,
        scope: 'session',
        active: activeToolNames.length > 0,
      },
      {
        type: 'memory',
        label: ctx.contextWindowStats?.omitted_message_count
          ? `已裁剪 ${ctx.contextWindowStats.omitted_message_count} 条较早消息`
          : '历史消息完整送入',
        scope: 'request',
        active: Boolean(ctx.contextWindowStats),
      },
      {
        type: 'file_chunk',
        label: ctx.fileContextSnippets?.length
          ? `已注入 ${ctx.fileContextSnippets.length} 个文件片段`
          : '未注入文件片段',
        scope: 'request',
        active: Boolean(ctx.fileContextSnippets?.length),
      },
    ],
    context_window: ctx.contextWindowStats ?? null,
  };
}

export function emitMetaAndContextSnapshot(
  stream: PassThrough,
  ctx: ProduceCtx,
): Record<string, unknown> {
  stream.write(
    `8:${JSON.stringify([
      {
        type: 'meta',
        conversation_id: ctx.conversationId,
        message_id: ctx.messageId,
        model_id: ctx.modelId,
        run_id: ctx.runId,
      },
    ])}\n`,
  );
  const contextSnapshot = buildContextSnapshot(ctx);
  stream.write(`8:${JSON.stringify([contextSnapshot])}\n`);
  recordRunEvent(ctx, {
    kind: 'context.snapshot',
    status: 'completed',
    label: '上下文快照',
    summary: `${Array.isArray(contextSnapshot.active_tool_names) ? contextSnapshot.active_tool_names.length : 0} 个工具可见`,
    payload: contextSnapshot,
  });
  return contextSnapshot;
}

export function finalizeOnEnd(
  stream: PassThrough,
  isAborted: () => boolean,
  ctx: ProduceCtx,
  msgRepo: MessagesRepo,
  costsRepo: CostsRepo,
  modelsRepo: ModelsRepo,
  providersRepo?: ProvidersRepo,
  memoriesRepo?: MemoriesRepo,
  structuredMemoriesRepo?: StructuredMemoriesRepo,
  keystore?: KeyStore,
  convRepo?: ConversationsRepo,
  autoTitleHermetic?: boolean,
): { finalize: () => void; observer: StreamObserver } {
  let collected = '';
  let usage: {
    input: number;
    cacheInput: number | null;
    output: number;
    durationMs: number;
    firstTokenMs: number | null;
    calls: number;
    /** Pre-computed cost from the stream producer, if available.
     *  Avoids recalculating and drifting from the value sent to the UI. */
    precomputedCostUsd: number | null;
  } = {
    input: 0,
    cacheInput: null,
    output: 0,
    durationMs: 0,
    firstTokenMs: null,
    calls: 1,
    precomputedCostUsd: null,
  };
  let upstreamErrored = false;
  let upstreamClassification: string | null = null;
  let upstreamErrorMessage: string | null = null;
  const observer: StreamObserver = {
    onText(text) { collected += text; },
    onAnnotation(anns) {
      for (const ann of anns) {
        if (ann?.type === 'cost') {
          usage.input = (ann.input_tokens as number) ?? usage.input;
          usage.cacheInput =
            typeof ann.cache_input_tokens === 'number'
              ? ann.cache_input_tokens as number
              : usage.cacheInput;
          usage.output = (ann.output_tokens as number) ?? usage.output;
          usage.durationMs = (ann.duration_ms as number) ?? usage.durationMs;
          usage.firstTokenMs = (ann.first_token_ms as number | null) ?? usage.firstTokenMs;
          // Capture the cost already computed by the stream producer so
          // writeCost uses the same value instead of recalculating.
          if (typeof ann.actual_usd === 'number') {
            usage.precomputedCostUsd = ann.actual_usd;
          }
        }
      }
    },
    onError(message) {
      upstreamErrored = true;
      const m = /^provider_error\/([a-z_]+)/.exec(message);
      if (m) upstreamClassification = m[1] ?? null;
      upstreamErrorMessage = message.replace(/^provider_error\/[a-z_]+:\s*/i, '') || message;
    },
  };
  const writeCost = (success: boolean): number | null => {
    // Use the cost already computed by the stream producer when available.
    // This guarantees the DB cost_record matches the cost annotation sent to UI.
    const actual = success ? usage.precomputedCostUsd : null;
    try {
      const costRow = costsRepo.insert({
        conversation_id: ctx.conversationId,
        source_type: 'message',
        source_id: ctx.messageId,
        feature: 'chat',
        model_id: ctx.modelDbId,
        model_name_snapshot: ctx.modelNameSnapshot,
        input_tokens: usage.input || null,
        cache_input_tokens: usage.cacheInput,
        output_tokens: usage.output || null,
        call_count: 1,
        price_input_per_1m_snapshot: ctx.priceInputPer1m,
        price_output_per_1m_snapshot: ctx.priceOutputPer1m,
        price_per_call_snapshot: ctx.pricePerCall,
        estimated_cost_usd: null,
        actual_cost_usd: actual,
        success,
        classification: success ? null : ((upstreamClassification as ErrorClassification | null) ?? null),
        first_token_ms: usage.firstTokenMs,
        duration_ms: usage.durationMs || null,
      });
      recordRunEvent(ctx, {
        kind: 'cost.recorded',
        status: 'completed',
        label: '成本记录',
        summary: actual != null ? `$${actual.toFixed(6)}` : '未配置价格',
        payload: {
          success,
          cost_record_id: costRow.id,
          input_tokens: usage.input || null,
          cache_input_tokens: usage.cacheInput,
          output_tokens: usage.output || null,
          actual_usd: actual,
          actual_cost_usd: actual,
          classification: success ? null : upstreamClassification,
          first_token_ms: usage.firstTokenMs,
          duration_ms: usage.durationMs || null,
        },
      });
    } catch (e) {
      // Cost tracking is non-critical observability — never let it crash
      // the request path or the stream-end handler. The message itself is
      // already persisted by the time we reach here.
      ctx.log.warn(
        { err: e, messageId: ctx.messageId, conversationId: ctx.conversationId },
        'cost.write_failed',
      );
    }
    return actual;
  };
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    const aborted = isAborted();
    const status: MessageRow['status'] = upstreamErrored
      ? 'failed'
      : aborted
        ? 'incomplete'
        : 'complete';
    const persistedContent =
      status === 'incomplete' && collected.trim().length === 0
        ? '（本次回答在生成完成前被中断，未收到可保存的内容。请重试或继续提问。）'
        : collected;
    msgRepo.finalize(ctx.messageId, {
      content: persistedContent,
      status,
      error: upstreamErrored ? upstreamErrorMessage : null,
    });
    writeCost(!aborted && !upstreamErrored);
    recordRunEvent(ctx, {
      kind: upstreamErrored
        ? 'turn.failed'
        : aborted
          ? 'turn.cancelled'
          : 'turn.completed',
      status: upstreamErrored ? 'failed' : aborted ? 'cancelled' : 'completed',
      label: upstreamErrored
        ? '用户回合失败'
        : aborted
          ? '用户回合已停止'
          : '用户回合完成',
      summary:
        status === 'complete'
          ? `${collected.length} 字符`
          : upstreamClassification ?? status,
      payload: {
        assistant_message_id: ctx.messageId,
        message_status: status,
        output_chars: collected.length,
      },
    });
    // Per spec §7.5.2: track quota/rate_limit/network as failures so models
    // demote (≥3) and disable (≥5). Successful runs reset the rolling
    // counter. content_filter / unknown (auth) do NOT count.
    if (ctx.modelDbId) {
      try {
        if (upstreamErrored && upstreamClassification) {
          modelsRepo.recordFailure(ctx.modelDbId, upstreamClassification);
        } else if (!upstreamErrored && !aborted) {
          modelsRepo.recordSuccess(ctx.modelDbId);
        }
      } catch (e) {
        ctx.log.warn({ err: e }, 'model.failure_track_failed');
      }
    }
    if (
      status === 'complete' &&
      providersRepo &&
      memoriesRepo &&
      structuredMemoriesRepo &&
      keystore
    ) {
      scheduleMemoryExtraction({
        conversationId: ctx.conversationId,
        sourceUserMessageId: ctx.sourceUserMessageId,
        assistantMessageId: ctx.messageId,
        userText: ctx.userText,
        assistantText: persistedContent,
        memoriesRepo,
        structuredMemoriesRepo,
        modelsRepo,
        providersRepo,
        runEventsRepo: ctx.runEventsRepo,
        keystore,
        log: ctx.log,
        runId: ctx.runId,
      });
    }
    if (
      status === 'complete' &&
      convRepo &&
      providersRepo &&
      memoriesRepo &&
      keystore
    ) {
      // Optional LLM title upgrade. The synchronous truncation remains the
      // default title; runAutoTitle requires auto_title_llm_enabled === 'true'
      // so hidden background provider calls stay off by default.
      scheduleAutoTitle({
        conversationId: ctx.conversationId,
        userText: ctx.userText,
        assistantText: persistedContent,
        convRepo,
        modelsRepo,
        providersRepo,
        memoriesRepo,
        keystore,
        hermetic: autoTitleHermetic ?? false,
        log: ctx.log,
      });
    }
  };
  // `finish` is the reliable signal for our persistence path: it fires when
  // the server-side writable stream ends, even if the HTTP client already
  // disconnected and the readable `end` event is no longer observed.
  stream.on('finish', finalize);
  stream.on('end', finalize);
  stream.on('error', (err) => {
    if (finalized) return;
    finalized = true;
    msgRepo.finalize(ctx.messageId, {
      content: collected,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    writeCost(false);
    recordRunEvent(ctx, {
      kind: 'turn.failed',
      status: 'failed',
      label: '用户回合失败',
      summary: err instanceof Error ? err.message : String(err),
      payload: {
        assistant_message_id: ctx.messageId,
        output_chars: collected.length,
      },
    });
  });
  return { finalize, observer };
}
