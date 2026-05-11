import type { PassThrough } from 'node:stream';
import { calculateCostUsd, type Model, type Provider } from '@taori/shared';
import type { MemoriesRepo, ModelsRepo } from '../db/repos/index.js';
import { classifyProviderError } from '../providers/registry.js';
import { resolveThinkingConfig } from '../providers/chat-model.js';
import {
  buildFailureDecision,
  waitForTextDeltaOrImageToolGrace,
  IMAGE_TOOL_FINAL_TEXT,
  type EmitToolTrace,
} from './stream-producers.js';
import {
  buildUpstreamMessages,
  emitMetaAndContextSnapshot,
  recordRunEvent,
  type ProduceCtx,
} from './run-stream.js';
import {
  buildUpstreamToolCatalog,
  type UpstreamToolCatalog,
  withCapabilityToolInstruction,
} from './upstream-tools.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

type DeepSeekToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type DeepSeekMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      reasoning_content?: string;
      tool_calls?: DeepSeekToolCall[];
    }
  | {
      role: 'tool';
      tool_call_id: string;
      content: string;
    };

const MAX_DEEPSEEK_TOOL_STEPS = 8;
const DEEPSEEK_FINALIZE_SYSTEM_PROMPT =
  'Answer the user directly in natural language using only the prior tool results. Do not call any more tools. Do not emit DSML, XML, JSON, or tool markup.';

function toDeepSeekMessages(messages: any[]): DeepSeekMessage[] {
  return messages.map((message) => {
    if (message.role === 'user' && Array.isArray(message.content)) {
      const text = message.content
        .filter((part: { type?: string }) => part?.type === 'text')
        .map((part: { text?: string }) => part.text ?? '')
        .join('');
      return { role: 'user', content: text };
    }
    return {
      role: message.role,
      content: typeof message.content === 'string' ? message.content : '',
    } as DeepSeekMessage;
  });
}

function formatToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeAssistantContent(content: string | null | undefined): string {
  return typeof content === 'string' ? content : '';
}

function appendDeepSeekFinalizeInstruction(messages: DeepSeekMessage[]): DeepSeekMessage[] {
  return [
    ...messages,
    {
      role: 'system',
      content: DEEPSEEK_FINALIZE_SYSTEM_PROMPT,
    },
  ];
}

function buildDeepSeekToolSpec(definition: {
  aiName: string;
  description: string;
  inputSchema: any;
}) {
  return {
    type: 'function',
    function: {
      name: definition.aiName,
      description: definition.description,
      parameters: zodToJsonSchema(definition.inputSchema, {
        target: 'openAi',
        $refStrategy: 'none',
      }),
    },
  };
}

async function postDeepSeekJson(args: {
  baseURL: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<Response> {
  return fetch(`${args.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args.body),
    signal: args.signal,
  });
}

async function readJsonCompletion(args: {
  baseURL: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<{
  content: string | null;
  reasoningContent: string | null;
  toolCalls: DeepSeekToolCall[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  finishReason: string | null;
}> {
  const res = await postDeepSeekJson(args);
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const err = Object.assign(new Error(`DeepSeek returned ${res.status}`), {
      statusCode: res.status,
      responseBody: bodyText,
    });
    throw err;
  }
  const body = await res.json() as {
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string;
        tool_calls?: DeepSeekToolCall[];
      };
      finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = body.choices?.[0];
  return {
    content: choice?.message?.content ?? null,
    reasoningContent: choice?.message?.reasoning_content ?? null,
    toolCalls: choice?.message?.tool_calls ?? [],
    usage: body.usage,
    finishReason: choice?.finish_reason ?? null,
  };
}

export async function executeDeepSeekToolLoop(args: {
  signal: AbortSignal;
  cfg: { baseURL: string; apiKey: string; modelName: string };
  initialMessages: any[];
  toolCatalog: UpstreamToolCatalog;
  thinking: ReturnType<typeof resolveThinkingConfig>;
}): Promise<{
  text: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  finishReason?: string;
}> {
  const conversationMessages = toDeepSeekMessages(args.initialMessages);
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let finishReason: string | undefined;
  let finalText: string | null = null;

  if (args.toolCatalog.definitions.length > 0) {
    for (let step = 0; step < MAX_DEEPSEEK_TOOL_STEPS && !args.signal.aborted; step++) {
      const toolResponse = await readJsonCompletion({
        baseURL: args.cfg.baseURL,
        apiKey: args.cfg.apiKey,
        signal: args.signal,
        body: {
          model: args.cfg.modelName,
          stream: false,
          messages: conversationMessages,
          tools: args.toolCatalog.definitions.map(buildDeepSeekToolSpec),
          ...(args.thinking.strategy === 'deepseek'
            ? { thinking: { type: args.thinking.enabled ? 'enabled' : 'disabled' } }
            : {}),
        },
      });
      promptTokens = toolResponse.usage?.prompt_tokens ?? promptTokens;
      completionTokens = toolResponse.usage?.completion_tokens ?? completionTokens;
      finishReason = toolResponse.finishReason ?? finishReason;
      if (toolResponse.toolCalls.length === 0) {
        if (toolResponse.content != null) {
          finalText = toolResponse.content;
          conversationMessages.push({
            role: 'assistant',
            content: normalizeAssistantContent(toolResponse.content),
            ...(toolResponse.reasoningContent
              ? { reasoning_content: toolResponse.reasoningContent }
              : {}),
          });
        }
        break;
      }

      conversationMessages.push({
        role: 'assistant',
        content: normalizeAssistantContent(toolResponse.content),
        ...(toolResponse.reasoningContent
          ? { reasoning_content: toolResponse.reasoningContent }
          : {}),
        tool_calls: toolResponse.toolCalls,
      });
      for (const toolCall of toolResponse.toolCalls) {
        const definition = args.toolCatalog.definitions.find((item) => item.aiName === toolCall.function.name);
        if (!definition) {
          conversationMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ ok: false, error: `unknown tool: ${toolCall.function.name}` }),
          });
          continue;
        }
        let input: unknown = {};
        try {
          input = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
          input = {};
        }
        const output = await definition.execute(input);
        conversationMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: formatToolResult(output),
        });
      }
    }

    if (!args.signal.aborted && finishReason === 'tool_calls' && finalText == null) {
      const finalizeResponse = await readJsonCompletion({
        baseURL: args.cfg.baseURL,
        apiKey: args.cfg.apiKey,
        signal: args.signal,
        body: {
          model: args.cfg.modelName,
          stream: false,
          messages: appendDeepSeekFinalizeInstruction(conversationMessages),
          tools: args.toolCatalog.definitions.map(buildDeepSeekToolSpec),
          tool_choice: 'none',
          ...(args.thinking.strategy === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
        },
      });
      promptTokens = finalizeResponse.usage?.prompt_tokens ?? promptTokens;
      completionTokens = finalizeResponse.usage?.completion_tokens ?? completionTokens;
      finishReason = finalizeResponse.finishReason ?? finishReason;
      finalText = finalizeResponse.content;
    }
  } else {
    const response = await readJsonCompletion({
      baseURL: args.cfg.baseURL,
      apiKey: args.cfg.apiKey,
      signal: args.signal,
      body: {
        model: args.cfg.modelName,
        stream: false,
        messages: conversationMessages,
        ...(args.thinking.strategy === 'deepseek'
          ? { thinking: { type: args.thinking.enabled ? 'enabled' : 'disabled' } }
          : {}),
      },
    });
    promptTokens = response.usage?.prompt_tokens ?? promptTokens;
    completionTokens = response.usage?.completion_tokens ?? completionTokens;
    finishReason = response.finishReason ?? finishReason;
    finalText = response.content;
  }

  return {
    text: finalText,
    promptTokens,
    completionTokens,
    finishReason,
  };
}

export async function produceDeepSeekUpstreamStream(
  stream: PassThrough,
  signal: AbortSignal,
  ctx: ProduceCtx,
  cfg: { apiKey: string },
  providerRecord: Provider,
  modelRecord: Model,
  modelsRepo: ModelsRepo,
  memoriesRepo: MemoriesRepo,
): Promise<void> {
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let imageToolFinalizedWithoutModelText = false;
  const runtimeState: { imageGenerateCompleted?: boolean } = {};
  const write = (line: string): boolean => stream.write(line);
  const emitToolTrace: EmitToolTrace = (payload) => {
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

    const toolCatalog = buildUpstreamToolCatalog({ ...ctx, runtimeState }, write, emitToolTrace);
    const initialMessages = toolCatalog.definitions.length > 0
      ? withCapabilityToolInstruction(upstream.messages, toolCatalog.flags)
      : upstream.messages;
    const thinking = resolveThinkingConfig({
      model: modelRecord,
      provider: providerRecord,
      memoriesRepo,
      conversationId: ctx.conversationId,
    });
    const loopResult = await executeDeepSeekToolLoop({
      signal,
      cfg: {
        baseURL: providerRecord.base_url.replace(/\/$/, ''),
        apiKey: cfg.apiKey,
        modelName: modelRecord.model_name,
      },
      initialMessages,
      toolCatalog,
      thinking,
    });
    let promptTokens = loopResult.promptTokens;
    let completionTokens = loopResult.completionTokens;
    let finishReason = loopResult.finishReason;
    const finalText = loopResult.text;

    let chunks = 0;
    if (finalText != null && finalText.length > 0) {
      if (firstTokenAt == null) firstTokenAt = Date.now();
      write(`0:${JSON.stringify(finalText)}\n`);
      chunks++;
    } else {
      const imageOnlyResult = await waitForTextDeltaOrImageToolGrace(
        Promise.resolve({ done: true, value: undefined as string | undefined }),
        () => Boolean(runtimeState.imageGenerateCompleted && chunks === 0),
      );
      if (imageOnlyResult === 'image-tool-finalize') {
        imageToolFinalizedWithoutModelText = true;
        if (firstTokenAt == null) firstTokenAt = Date.now();
        write(`0:${JSON.stringify(IMAGE_TOOL_FINAL_TEXT)}\n`);
        chunks++;
      }
    }

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

    if (!signal.aborted && chunks === 0) {
      const detail = '模型本次调用已完成，但没有返回任何可显示文本。请重试，或切换到另一模型继续。';
      const decision = buildFailureDecision('unknown', ctx, modelsRepo, memoriesRepo, detail);
      write(`8:${JSON.stringify([decision])}\n`);
      write(`3:${JSON.stringify(`provider_error/unknown: ${detail}`)}\n`);
      write(
        `d:${JSON.stringify({
          finishReason: 'error',
          usage: { promptTokens: promptTokens ?? 0, completionTokens: completionTokens ?? 0 },
        })}\n`,
      );
      recordRunEvent(ctx, {
        kind: 'model.failed',
        status: 'failed',
        label: '模型调用失败',
        summary: '模型返回空响应',
        payload: {
          classification: 'unknown',
          finish_reason: finishReason ?? null,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          duration_ms: Date.now() - startedAt,
        },
      });
      return;
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
  } catch (e) {
    if (signal.aborted) {
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
      const msg = e instanceof Error ? e.message : String(e);
      recordRunEvent(ctx, {
        kind: 'model.failed',
        status: 'failed',
        label: '模型调用失败',
        summary: cls.message || msg,
        payload: {
          classification: cls.classification,
          status,
        },
      });
      const decision = buildFailureDecision(
        cls.classification,
        ctx,
        modelsRepo,
        memoriesRepo,
        cls.message || msg,
      );
      write(`8:${JSON.stringify([decision])}\n`);
      write(`3:${JSON.stringify(`provider_error/${cls.classification}: ${cls.message || msg}`)}\n`);
      write(
        `d:${JSON.stringify({ finishReason: 'error', usage: { promptTokens: 0, completionTokens: 0 } })}\n`,
      );
    }
  } finally {
    stream.end();
  }
}
