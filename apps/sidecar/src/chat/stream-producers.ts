import type { PassThrough } from 'node:stream';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { calculateCostUsd } from '@taori/shared';
import type { MemoriesRepo, ModelsRepo } from '../db/repos/index.js';
import {
  classifyProviderError,
  isToolPayloadUnsupportedError,
} from '../providers/registry.js';
import { findLastFailedTool } from './recovery.js';
import {
  buildUpstreamMessages,
  captureContextWindowStats,
  emitMetaAndContextSnapshot,
  recordRunEvent,
  type ProduceCtx,
} from './run-stream.js';
import {
  buildUpstreamTools,
  withCapabilityToolInstruction,
} from './upstream-tools.js';

const IMAGE_TOOL_FINAL_TEXT = '图片已生成。';
const IMAGE_TOOL_FINAL_GRACE_MS = 1500;

function buildFailureDecision(
  classification: string,
  ctx: ProduceCtx,
  modelsRepo: ModelsRepo,
  memoriesRepo: MemoriesRepo,
  detail?: string,
  failedTool?: { name: string; label: string } | null,
): Record<string, unknown> {
  const effectiveFailedTool = failedTool ?? findLastFailedTool(ctx.runEventsRepo.listByRun(ctx.runId));
  let recommendedId: string | null = null;
  if (classification !== 'content_filter' && ctx.modelDbId) {
    try {
      const fb = modelsRepo.nextFallback(
        ctx.modelDbId,
        (ctx.capability as 'chat' | 'image' | 'embedding'),
      );
      recommendedId = fb?.id ?? null;
    } catch {
      recommendedId = null;
    }
  }
  let autoFallback = false;
  try {
    autoFallback = memoriesRepo.getEffective(ctx.conversationId, 'auto_fallback_enabled') === 'true';
  } catch {
    /* ignore */
  }
  return {
    type: 'failure_decision',
    classification,
    current_model_id: ctx.modelDbId,
    recommended_model_id: recommendedId,
    auto_fallback_enabled: autoFallback,
    can_compact_context:
      classification === 'unknown' ||
      classification === 'network' ||
      classification === 'rate_limit',
    can_skip_tool: Boolean(effectiveFailedTool?.name),
    tool_name: effectiveFailedTool?.name ?? null,
    tool_label: effectiveFailedTool?.label ?? null,
    ...(detail ? { detail } : {}),
  };
}

export async function produceUpstreamStream(
  stream: PassThrough,
  signal: AbortSignal,
  ctx: ProduceCtx,
  cfg: { baseURL: string; apiKey: string; modelName: string },
  modelsRepo: ModelsRepo,
  memoriesRepo: MemoriesRepo,
): Promise<void> {
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let toolsWereSent = false;
  let imageToolFinalizedWithoutModelText = false;
  const runtimeState: { imageGenerateCompleted?: boolean } = {};
  const write = (line: string): boolean => stream.write(line);
  const emitToolTrace = (
    payload: {
      event: 'start' | 'finish';
      call_id: string;
      tool: string;
      label: string;
      input?: string;
      ok?: boolean;
      output?: string;
      duration_ms?: number;
    },
  ): void => {
    write(
      `8:${JSON.stringify([
        {
          type: 'tool_trace',
          message_id: ctx.messageId,
          ...payload,
        },
      ])}\n`,
    );
    recordRunEvent(ctx, {
      kind:
        payload.event === 'start'
          ? 'tool.started'
          : payload.ok === false
            ? 'tool.failed'
            : 'tool.completed',
      status:
        payload.event === 'start'
          ? 'started'
          : payload.ok === false
            ? 'failed'
            : 'completed',
      label: payload.label,
      summary: payload.event === 'start' ? payload.input ?? null : payload.output ?? null,
      payload: {
        call_id: payload.call_id,
        tool: payload.tool,
        input: payload.input ?? null,
        output: payload.output ?? null,
        ok: payload.ok ?? null,
        duration_ms: payload.duration_ms ?? null,
      },
    });
  };

  const upstream = buildUpstreamMessages(ctx);
  ctx.contextWindowStats = upstream.stats;

  emitMetaAndContextSnapshot(stream, ctx);

  try {
    recordRunEvent(ctx, {
      kind: 'model.started',
      status: 'started',
      label: '模型调用开始',
      summary: ctx.modelNameSnapshot,
      payload: {
        model_id: ctx.modelDbId,
        model_name: ctx.modelNameSnapshot,
        supports_tools: ctx.supportsTools,
      },
    });
    if (ctx.forcedClassification) {
      const synthetic = new Error(`forced ${ctx.forcedClassification}`);
      (synthetic as { _forcedClassification?: string })._forcedClassification =
        ctx.forcedClassification;
      throw synthetic;
    }

    const provider = createOpenAI({
      baseURL: cfg.baseURL.replace(/\/$/, ''),
      apiKey: cfg.apiKey,
    });

    const upstreamTools = buildUpstreamTools({ ...ctx, runtimeState }, write, emitToolTrace);
    const tools = upstreamTools.tools;
    toolsWereSent = tools != null;

    const result = await streamText({
      model: provider.chat(cfg.modelName),
      messages: tools
        ? withCapabilityToolInstruction(upstream.messages, upstreamTools.flags)
        : upstream.messages,
      abortSignal: signal,
      ...(tools && { tools, maxSteps: 3 }),
    });

    let chunks = 0;
    const iterator = result.textStream[Symbol.asyncIterator]();
    try {
      while (!signal.aborted) {
        const next = await waitForTextDeltaOrImageToolGrace(iterator.next(), () =>
          Boolean(runtimeState.imageGenerateCompleted && chunks === 0),
        );
        if (next === 'image-tool-finalize') {
          imageToolFinalizedWithoutModelText = true;
          if (firstTokenAt == null) firstTokenAt = Date.now();
          write(`0:${JSON.stringify(IMAGE_TOOL_FINAL_TEXT)}\n`);
          chunks++;
          break;
        }
        if (next.done) break;
        const delta = next.value;
        if (firstTokenAt == null) firstTokenAt = Date.now();
        write(`0:${JSON.stringify(delta)}\n`);
        chunks++;
      }
    } finally {
      if (imageToolFinalizedWithoutModelText && 'return' in iterator && typeof iterator.return === 'function') {
        void iterator.return().catch(() => undefined);
      }
    }

    const usage = imageToolFinalizedWithoutModelText
      ? undefined
      : await result.usage.catch(() => undefined);
    const promptTokens = typeof usage?.promptTokens === 'number' ? usage.promptTokens : null;
    const completionTokens = typeof usage?.completionTokens === 'number' ? usage.completionTokens : null;
    let actualUsd: number | null = null;
    try {
      const c = calculateCostUsd({
        priceInputPer1m: ctx.priceInputPer1m,
        priceOutputPer1m: ctx.priceOutputPer1m,
        pricePerCall: ctx.pricePerCall,
        inputTokens: promptTokens ?? 0,
        outputTokens: completionTokens ?? 0,
      });
      actualUsd = c ?? null;
    } catch {
      actualUsd = null;
    }

    const finishReason = imageToolFinalizedWithoutModelText
      ? 'tool-calls'
      : await result.finishReason.catch(() => undefined);
    if (!signal.aborted && finishReason === 'content-filter') {
      const decision = buildFailureDecision('content_filter', ctx, modelsRepo, memoriesRepo);
      write(`8:${JSON.stringify([decision])}\n`);
      write(
        `3:${JSON.stringify(
          'provider_error/content_filter: 内容被供应商安全策略拦截',
        )}\n`,
      );
      write(
        `d:${JSON.stringify({
          finishReason: 'error',
          usage: { promptTokens: promptTokens ?? 0, completionTokens: completionTokens ?? 0 },
        })}\n`,
      );
      ctx.log.warn({ chunks }, 'chat.upstream_content_filter');
      recordRunEvent(ctx, {
        kind: 'model.failed',
        status: 'failed',
        label: '模型调用失败',
        summary: '内容被供应商安全策略拦截',
        payload: { classification: 'content_filter', finish_reason: finishReason },
      });
      return;
    }

    const failedTool = findLastFailedTool(ctx.runEventsRepo.listByRun(ctx.runId));
    if (!signal.aborted && failedTool) {
      const decision = buildFailureDecision(
        'unknown',
        ctx,
        modelsRepo,
        memoriesRepo,
        `工具「${failedTool.label}」执行失败，可跳过该工具后重试。`,
        failedTool,
      );
      write(`8:${JSON.stringify([decision])}\n`);
    }

    write(
      `8:${JSON.stringify([
        {
          type: 'cost',
          message_id: ctx.messageId,
          input_tokens: promptTokens,
          output_tokens: completionTokens,
          actual_usd: actualUsd,
          first_token_ms: firstTokenAt == null ? null : firstTokenAt - startedAt,
          duration_ms: Date.now() - startedAt,
        },
      ])}\n`,
    );
    recordRunEvent(ctx, {
      kind: 'model.completed',
      status: 'completed',
      label: '模型调用完成',
      summary: `${chunks} 个文本片段`,
      payload: {
        finish_reason: finishReason ?? null,
        image_tool_finalized_without_model_text: imageToolFinalizedWithoutModelText,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        first_token_ms: firstTokenAt == null ? null : firstTokenAt - startedAt,
        duration_ms: Date.now() - startedAt,
      },
    });

    write(
      `e:${JSON.stringify({
        finishReason: signal.aborted ? 'abort' : 'stop',
        usage: { promptTokens, completionTokens },
        isContinued: false,
      })}\n`,
    );
    write(
      `d:${JSON.stringify({
        finishReason: signal.aborted ? 'abort' : 'stop',
        usage: { promptTokens: promptTokens ?? 0, completionTokens: completionTokens ?? 0 },
      })}\n`,
    );
    ctx.log.info({ chunks, durationMs: Date.now() - startedAt }, 'chat.upstream_done');
  } catch (e) {
    if (signal.aborted) {
      ctx.log.warn('chat.upstream_aborted');
      recordRunEvent(ctx, {
        kind: 'model.failed',
        status: 'cancelled',
        label: '模型调用已停止',
        summary: '用户停止或连接中断',
      });
    } else {
      const status = (e as { statusCode?: number; status?: number })?.statusCode
        ?? (e as { status?: number })?.status;
      const forced = (e as { _forcedClassification?: string })?._forcedClassification;
      const cls = forced
        ? { classification: forced, message: `forced ${forced}` }
        : classifyProviderError({ status, err: e });
      const rejectedTools =
        !forced &&
        toolsWereSent &&
        isToolPayloadUnsupportedError(e);
      if (rejectedTools && ctx.modelDbId) {
        try {
          modelsRepo.update(ctx.modelDbId, { supports_tools: false });
          ctx.log.warn(
            { modelId: ctx.modelDbId },
            'chat.tools_auto_disabled_after_provider_rejection',
          );
        } catch (updateErr) {
          ctx.log.warn(
            { err: updateErr, modelId: ctx.modelDbId },
            'chat.tools_auto_disable_failed',
          );
        }
      }
      const msg = e instanceof Error ? e.message : String(e);
      const safeErr = {
        name: e instanceof Error ? e.name : typeof e,
        message: msg,
        status,
      };
      ctx.log.error(
        { err: safeErr, classification: cls },
        'chat.upstream_failed',
      );
      recordRunEvent(ctx, {
        kind: 'model.failed',
        status: 'failed',
        label: '模型调用失败',
        summary: cls.message || msg,
        payload: {
          classification: cls.classification,
          status,
          rejected_tools: rejectedTools,
        },
      });
      const detail = rejectedTools
        ? '该模型刚刚拒绝了 tools 请求，系统已自动关闭此模型的 Tools 能力。联网检索 / 图像生成请切换到明确支持 Tools 的聊天模型，或在模型中心确认后重新开启。'
        : cls.message || msg;
      const decision = buildFailureDecision(
        cls.classification,
        ctx,
        modelsRepo,
        memoriesRepo,
        detail,
      );
      write(`8:${JSON.stringify([decision])}\n`);
      write(
        `3:${JSON.stringify(`provider_error/${cls.classification}: ${cls.message || msg}`)}\n`,
      );
      write(
        `d:${JSON.stringify({ finishReason: 'error', usage: { promptTokens: 0, completionTokens: 0 } })}\n`,
      );
    }
  } finally {
    stream.end();
  }
}

async function waitForTextDeltaOrImageToolGrace(
  nextDelta: Promise<IteratorResult<string>>,
  shouldStartGrace: () => boolean,
): Promise<IteratorResult<string> | 'image-tool-finalize'> {
  let graceStartedAt: number | null = null;
  let interval: NodeJS.Timeout | null = null;
  const timeout = new Promise<'image-tool-finalize'>((resolve) => {
    interval = setInterval(() => {
      if (!shouldStartGrace()) return;
      if (graceStartedAt == null) {
        graceStartedAt = Date.now();
        return;
      }
      if (Date.now() - graceStartedAt >= IMAGE_TOOL_FINAL_GRACE_MS) {
        resolve('image-tool-finalize');
      }
    }, 100);
  });
  try {
    return await Promise.race([nextDelta, timeout]);
  } finally {
    if (interval) clearInterval(interval);
  }
}

export async function produceKeyMissingStream(
  stream: PassThrough,
  ctx: ProduceCtx,
  modelsRepo: ModelsRepo,
  memoriesRepo: MemoriesRepo,
): Promise<void> {
  const write = (line: string): boolean => stream.write(line);
  captureContextWindowStats(ctx);
  emitMetaAndContextSnapshot(stream, ctx);
  recordRunEvent(ctx, {
    kind: 'model.started',
    status: 'started',
    label: '模型调用开始',
    summary: ctx.modelNameSnapshot,
    payload: { model_id: ctx.modelDbId, model_name: ctx.modelNameSnapshot },
  });
  const decision = buildFailureDecision('key_missing', ctx, modelsRepo, memoriesRepo);
  write(`8:${JSON.stringify([decision])}\n`);
  recordRunEvent(ctx, {
    kind: 'model.failed',
    status: 'failed',
    label: '模型调用失败',
    summary: 'API key 已失效或未配置',
    payload: { classification: 'key_missing' },
  });
  write(
    `3:${JSON.stringify(
      'provider_error/key_missing: API key 已失效或未配置 — 请在「模型中心」重新输入 API Key',
    )}\n`,
  );
  write(
    `d:${JSON.stringify({ finishReason: 'error', usage: { promptTokens: 0, completionTokens: 0 } })}\n`,
  );
  stream.end();
}

export async function produceMockStream(
  stream: PassThrough,
  isAborted: () => boolean,
  ctx: ProduceCtx,
  modelsRepo: ModelsRepo,
  memoriesRepo: MemoriesRepo,
): Promise<void> {
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  const write = (line: string): boolean => stream.write(line);
  captureContextWindowStats(ctx);
  emitMetaAndContextSnapshot(stream, ctx);
  recordRunEvent(ctx, {
    kind: 'model.started',
    status: 'started',
    label: '模型调用开始',
    summary: ctx.modelNameSnapshot,
    payload: { model_id: ctx.modelDbId, model_name: ctx.modelNameSnapshot, mock: true },
  });

  if (ctx.forcedClassification) {
    const cls = (ctx.forcedClassification === 'quota'
      || ctx.forcedClassification === 'network'
      || ctx.forcedClassification === 'rate_limit'
      || ctx.forcedClassification === 'content_filter'
      || ctx.forcedClassification === 'auth'
      || ctx.forcedClassification === 'unknown')
      ? ctx.forcedClassification
      : 'unknown';
    const decision = buildFailureDecision(cls, ctx, modelsRepo, memoriesRepo);
    write(`8:${JSON.stringify([decision])}\n`);
    recordRunEvent(ctx, {
      kind: 'model.failed',
      status: 'failed',
      label: '模型调用失败',
      summary: `forced ${cls}`,
      payload: { classification: cls, mock: true },
    });
    write(`3:${JSON.stringify(`provider_error/${cls}: forced ${cls}`)}\n`);
    write(
      `d:${JSON.stringify({ finishReason: 'error', usage: { promptTokens: 0, completionTokens: 0 } })}\n`,
    );
    stream.end();
    return;
  }

  const text = mockReply(ctx.userText);
  let i = 0;
  for (const chunk of chunkText(text, 8)) {
    if (isAborted()) {
      ctx.log.warn({ chunks: i }, 'chat.client_aborted');
      stream.end();
      recordRunEvent(ctx, {
        kind: 'model.failed',
        status: 'cancelled',
        label: '模型调用已停止',
        summary: '用户停止或连接中断',
        payload: { chunks: i, mock: true },
      });
      return;
    }
    if (firstTokenAt == null) firstTokenAt = Date.now();
    write(`0:${JSON.stringify(chunk)}\n`);
    i++;
    await sleep(40);
  }

  write(
    `8:${JSON.stringify([
      {
        type: 'cost',
        message_id: ctx.messageId,
        input_tokens: 12,
        output_tokens: text.length,
        actual_usd: 0.00009,
        first_token_ms: firstTokenAt == null ? null : firstTokenAt - startedAt,
        duration_ms: Date.now() - startedAt,
      },
    ])}\n`,
  );
  recordRunEvent(ctx, {
    kind: 'model.completed',
    status: 'completed',
    label: '模型调用完成',
    summary: `${i} 个文本片段`,
    payload: {
      mock: true,
      prompt_tokens: 12,
      completion_tokens: text.length,
      first_token_ms: firstTokenAt == null ? null : firstTokenAt - startedAt,
      duration_ms: Date.now() - startedAt,
    },
  });

  const usage = { promptTokens: 12, completionTokens: text.length };
  write(`e:${JSON.stringify({ finishReason: 'stop', usage, isContinued: false })}\n`);
  write(`d:${JSON.stringify({ finishReason: 'stop', usage })}\n`);
  stream.end();
}

function mockReply(userText: string): string {
  if (!userText) return 'Hello from Taori M0 spike. The end-to-end stream works. ✅';
  return `[M0 mock] You said: "${userText.slice(0, 200)}". ` +
    `End-to-end Renderer→Sidecar streaming is working. ✅`;
}

function* chunkText(s: string, size: number): Generator<string> {
  for (let i = 0; i < s.length; i += size) yield s.slice(i, i + size);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
