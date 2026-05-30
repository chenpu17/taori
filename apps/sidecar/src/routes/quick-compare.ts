import type { FastifyInstance } from 'fastify';
import type { PassThrough } from 'node:stream';
import { streamText } from 'ai';
import {
  QuickCompareRequestSchema,
  QuickCompareAdoptRequestSchema,
  QuickCompareRetryRequestSchema,
  TaoriError,
  calculateCostUsd,
  estimateInputTokens,
  makeId,
  type ChatAttachment,
  type Model,
  type Provider,
  type QuickCompareAnnotation,
  type QuickComparePreviewReason,
} from '@taori/shared';
import type { BuildServerArgs } from '../server.js';
import type { QuickCompareRepo, CostsRepo, ModelsRepo, MemoriesRepo, RunEventsRepo } from '../db/repos/index.js';
import {
  classifyProviderError, isToolPayloadUnsupportedError,
} from '../providers/registry.js';
import { throwIfBudgetBlockedOrNeedsConfirmation } from '../cost/budget-guard.js';
import { openDataStream } from '../chat/stream-dispatch.js';
import { appendRunEvent } from '../chat/run-stream.js';
import { writeAnnotationPart } from '../chat/protocol.js';
import { shouldUseDeepSeekToolLoop } from '../chat/deepseek-tool-loop-policy.js';
import { buildConversationToolPolicy } from '../chat/tool-policy.js';
import {
  buildUpstreamToolCatalog,
  buildUpstreamTools,
  withCapabilityToolInstruction,
  type ToolTracePayload,
  MAX_STEPS_DEFAULT,
  MAX_STEPS_WITH_WEB_TOOLS,
} from '../chat/upstream-tools.js';
import { executeDeepSeekToolLoop } from '../chat/deepseek-tools-loop.js';
import { pickQuickCompareModels } from '../quick-compare/model-picker.js';
import type { CapabilityBus } from '../bus/index.js';
import { createChatModel, resolveThinkingConfig } from '../providers/chat-model.js';
import { assertProviderRunnableForModel } from '../models/eligibility.js';

function writeAnnotation(stream: PassThrough, annotations: QuickCompareAnnotation[]): void {
  writeAnnotationPart(stream, annotations);
}

function validationError(message: string): TaoriError {
  return new TaoriError({ code: 'validation_error', message });
}

function lastUserText(messages: Array<{ role: string; content: string }>): string {
  return [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}

function attachmentNotice(attachments: ChatAttachment[] | undefined): string | null {
  if (!attachments || attachments.length === 0) return null;
  const names = attachments.map((item) => item.name ?? item.mime).join(', ');
  return `\n\n【附件提示】本次 Quick Compare 收到 ${attachments.length} 个附件：${names}。如果模型无法直接读取附件，请基于对话中已提取的信息回答。`;
}

function buildCompareMessages(args: {
  requestMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  personaPrompt: string | null;
  attachments?: ChatAttachment[];
}): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  const system = [
    args.personaPrompt,
    '你正在参加 Taori Quick Compare。请独立给出高质量回答，不要提及其他候选模型。回答要直接、可执行、避免空话。',
  ].filter(Boolean).join('\n\n');
  const messages = system
    ? [{ role: 'system' as const, content: system }, ...args.requestMessages]
    : [...args.requestMessages];
  const notice = attachmentNotice(args.attachments);
  if (!notice) return messages;
  const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user');
  if (lastUserIndex < 0) return messages;
  return messages.map((message, index) =>
    index === lastUserIndex
      ? { ...message, content: `${message.content}${notice}` }
      : message,
  );
}

function estimateCompareCostUsd(models: Model[], inputText: string): number {
  const inputTokens = estimateInputTokens(inputText);
  return models.reduce((sum, model) => {
    const cost = calculateCostUsd({
      inputTokens,
      outputTokens: 800,
      priceInputPer1m: model.price_input_per_1m,
      priceOutputPer1m: model.price_output_per_1m,
      pricePerCall: model.price_per_call,
    });
    return sum + (cost ?? 0);
  }, 0);
}

function enabledToolNames(toolPolicy: Record<string, boolean>): string[] {
  return Object.entries(toolPolicy)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}

function restrictToolPolicy(
  toolPolicy: Record<string, boolean>,
  allowedToolNames: string[],
): Record<string, boolean> {
  const allowed = new Set(allowedToolNames);
  return Object.fromEntries(
    Object.entries(toolPolicy).map(([name, enabled]) => [name, enabled && allowed.has(name)]),
  );
}

function resolveParticipantToolNames(args: {
  selectedModels: Model[];
  requestedConfigs?: Array<{ model_id: string; tool_names?: string[] }>;
  baseToolPolicy: Record<string, boolean>;
}): Map<string, string[]> {
  const defaultToolNames = enabledToolNames(args.baseToolPolicy);
  const allowedToolNames = new Set(defaultToolNames);
  const requestedByModelId = new Map(
    (args.requestedConfigs ?? []).map((item) => [item.model_id, item.tool_names]),
  );
  return new Map(args.selectedModels.map((model) => {
    if (!model.supports_tools) return [model.id, []];
    const requested = requestedByModelId.get(model.id);
    if (requested == null) return [model.id, defaultToolNames];
    return [
      model.id,
      [...new Set(requested.filter((name) => allowedToolNames.has(name)))],
    ];
  }));
}

async function runCompareParticipant(args: {
  stream: PassThrough;
  signal: AbortSignal;
  compareId: string;
  conversationId: string;
  runId: string;
  outputId: string;
  index: number;
  model: Model;
  provider: Provider | null;
  apiKey: string | null;
  previewReason: QuickComparePreviewReason | null;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  sourceUserMessageId: string | null;
  bus: CapabilityBus | null | undefined;
  toolPolicy: Record<string, boolean>;
  defaultSearchToolName?: string | null;
  toolNames: string[];
  qcRepo: QuickCompareRepo;
  costsRepo: CostsRepo;
  modelsRepo: ModelsRepo;
  memoriesRepo: MemoriesRepo;
  runEventsRepo: RunEventsRepo;
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): Promise<{ outputId: string; ok: boolean }> {
  const startedAt = Date.now();
  let firstTokenMs: number | null = null;
  let accumulated = '';
  let toolsWereSent = false;
  args.qcRepo.patchOutput(args.outputId, { status: 'streaming' });
  appendRunEvent(args.log, args.runEventsRepo, {
    run_id: args.runId,
    conversation_id: args.conversationId,
    message_id: null,
    kind: 'quick_compare.participant_started',
    status: 'started',
    label: `对比候选 ${args.index + 1} 开始`,
    summary: args.model.display_name,
    payload: {
      compare_id: args.compareId,
      output_id: args.outputId,
      participant_index: args.index,
      model_id: args.model.id,
    },
  });
  writeAnnotation(args.stream, [{
    type: 'qc.participant_start',
    output_id: args.outputId,
    index: args.index,
    model_id: args.model.id,
    provider_id: args.provider?.id ?? args.model.provider_id ?? null,
    execution_mode: args.provider && args.apiKey ? 'live' : 'local_preview',
    preview_reason: args.provider && args.apiKey ? null : args.previewReason,
    tool_names: args.toolNames,
  }]);

  try {
    if (args.provider && args.apiKey) {
      if (shouldUseDeepSeekToolLoop(args.provider, args.model.model_name, args.model.supports_tools)) {
        const emitToolTrace = (payload: ToolTracePayload): void => {
          writeAnnotation(args.stream, [{
            type: 'qc.tool_trace',
            output_id: args.outputId,
            index: args.index,
            model_id: args.model.id,
            ...payload,
          }]);
        };
        const toolCatalog = buildUpstreamToolCatalog(
          {
            messageId: args.outputId,
            conversationId: args.conversationId,
            sourceUserMessageId: args.sourceUserMessageId,
            supportsTools: args.model.supports_tools,
            toolPolicy: args.toolPolicy,
            bus: args.bus ?? null,
            imageModelId: null,
            filesRepo: null,
            log: args.log,
            defaultSearchToolName: args.defaultSearchToolName,
          },
          () => true,
          emitToolTrace,
        );
        toolsWereSent = toolCatalog.definitions.length > 0;
        const initialMessages = toolsWereSent
          ? withCapabilityToolInstruction(args.messages, toolCatalog.flags)
          : args.messages;
        const loopResult = await executeDeepSeekToolLoop({
          signal: args.signal,
          cfg: {
            baseURL: args.provider.base_url.replace(/\/$/, ''),
            apiKey: args.apiKey,
            modelName: args.model.model_name,
          },
          initialMessages,
          toolCatalog,
          thinking: resolveThinkingConfig({
            model: args.model,
            provider: args.provider,
            memoriesRepo: args.memoriesRepo,
            conversationId: args.conversationId,
          }),
        });
        const promptTokens = loopResult.promptTokens;
        const completionTokens = loopResult.completionTokens;
        if (typeof loopResult.text === 'string' && loopResult.text.length > 0) {
          if (firstTokenMs == null) firstTokenMs = Date.now() - startedAt;
          accumulated = loopResult.text;
          writeAnnotation(args.stream, [{
            type: 'qc.participant_delta',
            output_id: args.outputId,
            index: args.index,
            model_id: args.model.id,
            text_chunk: loopResult.text,
          }]);
        }
        if (!accumulated.trim()) {
          throw new TaoriError({
            code: 'provider_error',
            message: '模型本次调用已完成，但没有返回任何可显示文本。',
          });
        }
        const actualCost = calculateCostUsd({
          inputTokens: promptTokens ?? 0,
          outputTokens: completionTokens ?? 0,
          priceInputPer1m: args.model.price_input_per_1m,
          priceOutputPer1m: args.model.price_output_per_1m,
          pricePerCall: args.model.price_per_call,
        });
        const cost = args.costsRepo.insert({
          conversation_id: args.conversationId,
          source_type: 'quick_compare_output',
          source_id: args.outputId,
          feature: 'quick_compare',
          model_id: args.model.id,
          model_name_snapshot: args.model.model_name,
          input_tokens: promptTokens,
          output_tokens: completionTokens,
          call_count: 1,
          price_input_per_1m_snapshot: args.model.price_input_per_1m,
          price_output_per_1m_snapshot: args.model.price_output_per_1m,
          price_per_call_snapshot: args.model.price_per_call,
          estimated_cost_usd: null,
          actual_cost_usd: actualCost ?? null,
          success: true,
          duration_ms: Date.now() - startedAt,
        });
        args.qcRepo.patchOutput(args.outputId, {
          content: accumulated,
          status: 'complete',
          cost_record_id: cost.id,
          first_token_ms: firstTokenMs,
          duration_ms: Date.now() - startedAt,
        });
        args.modelsRepo.recordSuccess(args.model.id);
        appendRunEvent(args.log, args.runEventsRepo, {
          run_id: args.runId,
          conversation_id: args.conversationId,
          message_id: null,
          kind: 'quick_compare.participant_completed',
          status: 'completed',
          label: `对比候选 ${args.index + 1} 完成`,
          summary: actualCost == null ? null : `$${actualCost.toFixed(6)}`,
          payload: {
            compare_id: args.compareId,
            output_id: args.outputId,
            participant_index: args.index,
            model_id: args.model.id,
            cost_record_id: cost.id,
            first_token_ms: firstTokenMs,
            duration_ms: Date.now() - startedAt,
          },
        });
        writeAnnotation(args.stream, [{
          type: 'qc.participant_done',
          output_id: args.outputId,
          index: args.index,
          model_id: args.model.id,
          content: accumulated,
          cost_record_id: cost.id,
          first_token_ms: firstTokenMs,
          duration_ms: Date.now() - startedAt,
          execution_mode: 'live',
          preview_reason: null,
        }]);
        return { outputId: args.outputId, ok: true };
      }

      const { model: chatModel } = createChatModel({
        provider: args.provider,
        model: args.model,
        apiKey: args.apiKey,
        memoriesRepo: args.memoriesRepo,
        conversationId: args.conversationId,
      });
      const emitToolTrace = (payload: ToolTracePayload): void => {
        writeAnnotation(args.stream, [{
          type: 'qc.tool_trace',
          output_id: args.outputId,
          index: args.index,
          model_id: args.model.id,
          ...payload,
        }]);
      };
      const upstreamTools = buildUpstreamTools(
        {
          messageId: args.outputId,
          conversationId: args.conversationId,
          sourceUserMessageId: args.sourceUserMessageId,
          supportsTools: args.model.supports_tools,
          toolPolicy: args.toolPolicy,
          bus: args.bus ?? null,
          imageModelId: null,
          filesRepo: null,
          log: args.log,
        },
        (line) => args.stream.write(line),
        emitToolTrace,
      );
      toolsWereSent = upstreamTools.tools != null;
      const result = await streamText({
        model: chatModel,
        messages: upstreamTools.tools
          ? withCapabilityToolInstruction(args.messages, upstreamTools.flags)
          : args.messages,
        maxTokens: 1200,
        temperature: 0.6,
        maxRetries: 0,
        ...(upstreamTools.tools ? { tools: upstreamTools.tools, maxSteps: upstreamTools.flags.web ? MAX_STEPS_WITH_WEB_TOOLS : MAX_STEPS_DEFAULT } : {}),
        abortSignal: args.signal,
      });
      for await (const delta of result.textStream) {
        if (args.signal.aborted) break;
        if (firstTokenMs == null) firstTokenMs = Date.now() - startedAt;
        accumulated += delta;
        writeAnnotation(args.stream, [{
          type: 'qc.participant_delta',
          output_id: args.outputId,
          index: args.index,
          model_id: args.model.id,
          text_chunk: delta,
        }]);
      }
      const usage = await result.usage.catch(() => undefined);
      const promptTokens = usage?.promptTokens ?? null;
      const completionTokens = usage?.completionTokens ?? null;
      if (!accumulated.trim()) {
        throw new TaoriError({
          code: 'provider_error',
          message: '模型本次调用已完成，但没有返回任何可显示文本。',
        });
      }
      const actualCost = calculateCostUsd({
        inputTokens: promptTokens ?? 0,
        outputTokens: completionTokens ?? 0,
        priceInputPer1m: args.model.price_input_per_1m,
        priceOutputPer1m: args.model.price_output_per_1m,
        pricePerCall: args.model.price_per_call,
      });
      const cost = args.costsRepo.insert({
        conversation_id: args.conversationId,
        source_type: 'quick_compare_output',
        source_id: args.outputId,
        feature: 'quick_compare',
        model_id: args.model.id,
        model_name_snapshot: args.model.model_name,
        input_tokens: promptTokens,
        output_tokens: completionTokens,
        call_count: 1,
        price_input_per_1m_snapshot: args.model.price_input_per_1m,
        price_output_per_1m_snapshot: args.model.price_output_per_1m,
        price_per_call_snapshot: args.model.price_per_call,
        estimated_cost_usd: null,
        actual_cost_usd: actualCost ?? null,
        success: true,
        duration_ms: Date.now() - startedAt,
      });
      args.qcRepo.patchOutput(args.outputId, {
        content: accumulated,
        status: 'complete',
        cost_record_id: cost.id,
        first_token_ms: firstTokenMs,
        duration_ms: Date.now() - startedAt,
      });
      args.modelsRepo.recordSuccess(args.model.id);
      appendRunEvent(args.log, args.runEventsRepo, {
        run_id: args.runId,
        conversation_id: args.conversationId,
        message_id: null,
        kind: 'quick_compare.participant_completed',
        status: 'completed',
        label: `对比候选 ${args.index + 1} 完成`,
        summary: actualCost == null ? null : `$${actualCost.toFixed(6)}`,
        payload: {
          compare_id: args.compareId,
          output_id: args.outputId,
          participant_index: args.index,
          model_id: args.model.id,
          cost_record_id: cost.id,
          first_token_ms: firstTokenMs,
          duration_ms: Date.now() - startedAt,
        },
      });
      writeAnnotation(args.stream, [{
        type: 'qc.participant_done',
        output_id: args.outputId,
        index: args.index,
        model_id: args.model.id,
        content: accumulated,
        cost_record_id: cost.id,
        first_token_ms: firstTokenMs,
        duration_ms: Date.now() - startedAt,
        execution_mode: 'live',
        preview_reason: null,
      }]);
      return { outputId: args.outputId, ok: true };
    }

    accumulated = `【${args.model.display_name}】Quick Compare 本地预览：${lastUserText(args.messages).slice(0, 240)}`;
    args.qcRepo.patchOutput(args.outputId, {
      content: accumulated,
      status: 'complete',
      first_token_ms: 0,
      duration_ms: Date.now() - startedAt,
    });
    writeAnnotation(args.stream, [{
      type: 'qc.participant_delta',
      output_id: args.outputId,
      index: args.index,
      model_id: args.model.id,
      text_chunk: accumulated,
    }]);
    writeAnnotation(args.stream, [{
      type: 'qc.participant_done',
      output_id: args.outputId,
      index: args.index,
      model_id: args.model.id,
      content: accumulated,
      cost_record_id: null,
      first_token_ms: 0,
      duration_ms: Date.now() - startedAt,
      execution_mode: 'local_preview',
      preview_reason: args.previewReason,
    }]);
    return { outputId: args.outputId, ok: true };
  } catch (e) {
    const rejectedTools = toolsWereSent && isToolPayloadUnsupportedError(e);
    if (rejectedTools && args.model.supports_tools) {
      try {
        args.modelsRepo.update(args.model.id, { supports_tools: false });
        args.log.warn({ modelId: args.model.id }, 'quick_compare.tools_auto_disabled_after_provider_rejection');
      } catch (updateErr) {
        args.log.warn(
          { err: updateErr, modelId: args.model.id },
          'quick_compare.tools_auto_disable_failed',
        );
      }
    }
    const providerError = classifyProviderError({ err: e });
    const classification = providerError.classification;
    args.modelsRepo.recordFailure(args.model.id, classification);
    args.qcRepo.patchOutput(args.outputId, {
      status: 'failed',
      error_classification: classification,
      error_message: providerError.message,
      duration_ms: Date.now() - startedAt,
    });
    appendRunEvent(args.log, args.runEventsRepo, {
      run_id: args.runId,
      conversation_id: args.conversationId,
      message_id: null,
      kind: 'quick_compare.participant_failed',
      status: 'failed',
      label: `对比候选 ${args.index + 1} 失败`,
      summary: classification,
      payload: {
        compare_id: args.compareId,
        output_id: args.outputId,
        participant_index: args.index,
        model_id: args.model.id,
        classification,
        duration_ms: Date.now() - startedAt,
      },
    });
    writeAnnotation(args.stream, [{
      type: 'qc.participant_failed',
      output_id: args.outputId,
      index: args.index,
      model_id: args.model.id,
      classification,
      message: providerError.message,
    }]);
    return { outputId: args.outputId, ok: false };
  }
}

export function registerQuickCompareRoute(app: FastifyInstance, deps: BuildServerArgs): void {
  const { repos } = deps;
  const convRepo = repos.conversations;
  const msgRepo = repos.messages;
  const modelsRepo = repos.models;
  const providersRepo = repos.providers;
  const memoriesRepo = repos.memories;
  const personasRepo = repos.personas;
  const costsRepo = repos.costs;
  const runEventsRepo = repos.runEvents;
  const qcRepo = repos.quickCompare;

  app.post('/v1/quick-compare', async (req, reply) => {
    const parsed = QuickCompareRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw validationError(parsed.error.issues.map((issue) => issue.message).join('; '));
    }
    const body = parsed.data;
    const conversation = convRepo.ensure(body.conversation_id);
    const userMessage = [...body.messages].reverse().find((message) => message.role === 'user');
    if (!userMessage) throw validationError('Quick Compare 需要至少一条用户消息。');
    const sourceUserMessage = msgRepo.insert({
      conversation_id: conversation.id,
      role: 'user',
      content: userMessage.content,
      status: 'complete',
      attachments: body.attachments && body.attachments.length > 0
        ? JSON.stringify(body.attachments)
        : null,
    });
    const selected = pickQuickCompareModels({
      models: modelsRepo.list(),
      providers: providersRepo.list(),
      currentModelId: body.participant_configs?.[0]?.model_id ?? body.model_ids?.[0] ?? null,
      requestedModelIds: body.participant_configs?.map((item) => item.model_id) ?? body.model_ids,
    });
    const selectedModels = selected.map((item) => item.model);
    const estimatedCostUsd = estimateCompareCostUsd(
      selectedModels,
      body.messages.map((message) => message.content).join('\n\n'),
    );
    throwIfBudgetBlockedOrNeedsConfirmation({
      confirmed: body.confirmed_cost === true,
      conversationId: conversation.id,
      model: selectedModels[0]!,
      inputText: body.messages.map((message) => message.content).join('\n\n'),
      estimatedCostUsd,
      costsRepo,
      memoriesRepo,
      defaultThresholdUsd: 0.20,
    });

    const personaPrompt = body.persona_id
      ? personasRepo.get(body.persona_id)?.prompt ?? null
      : null;
    if (body.persona_id && !personaPrompt) {
      throw new TaoriError({
        code: 'not_found',
        message: `Persona ${body.persona_id} not found`,
      });
    }

    const runId = makeId('run');
    const compare = qcRepo.createRun({
      conversation_id: conversation.id,
      source_user_message_id: sourceUserMessage.id,
      run_id: runId,
      model_ids: selectedModels.map((model) => model.id),
    });
    const toolPolicy = buildConversationToolPolicy(deps.bus ?? null, memoriesRepo, conversation.id);
    const defaultSearchToolName = memoriesRepo.getEffective(conversation.id, 'default_search_tool');
    const participantToolNames = resolveParticipantToolNames({
      selectedModels,
      requestedConfigs: body.participant_configs,
      baseToolPolicy: toolPolicy,
    });
    const outputs = selectedModels.map((model, index) =>
      qcRepo.createOutput({
        compare_id: compare.id,
        participant_index: index,
        model_id: model.id,
        provider_id: model.provider_id,
        tool_names: participantToolNames.get(model.id) ?? [],
      }),
    );
    appendRunEvent(req.log, runEventsRepo, {
      run_id: runId,
      conversation_id: conversation.id,
      message_id: sourceUserMessage.id,
      kind: 'turn.started',
      status: 'started',
      label: 'Quick Compare 开始',
      summary: userMessage.content.slice(0, 120),
      payload: {
        run_kind: 'quick_compare',
        compare_id: compare.id,
        source_user_message_id: sourceUserMessage.id,
        model_ids: selectedModels.map((model) => model.id),
        candidate_roles: selected.map((item) => item.role),
      },
    });
    appendRunEvent(req.log, runEventsRepo, {
      run_id: runId,
      conversation_id: conversation.id,
      message_id: sourceUserMessage.id,
      kind: 'quick_compare.started',
      status: 'started',
      label: '三模型快速对比',
      summary: selected.map((item) => item.model.display_name).join(' / '),
      payload: {
        compare_id: compare.id,
        output_ids: outputs.map((output) => output.id),
        model_ids: selectedModels.map((model) => model.id),
        reasons: selected.map((item) => item.reason),
        estimated_cost_usd: estimatedCostUsd,
      },
    });

    const dataStream = openDataStream(req.headers.origin, reply);
    writeAnnotation(dataStream.stream, [{
      type: 'qc.meta',
      compare_id: compare.id,
      conversation_id: conversation.id,
      run_id: runId,
      model_ids: selectedModels.map((model) => model.id),
    }]);

    const messages = buildCompareMessages({
      requestMessages: body.messages,
      personaPrompt,
      attachments: body.attachments,
    });

    void (async () => {
      const providers = selectedModels.map((model) =>
        model.provider_id ? providersRepo.get(model.provider_id) : null,
      );
      const keyResults = await Promise.all(providers.map(async (provider): Promise<{
        apiKey: string | null;
        previewReason: QuickComparePreviewReason | null;
      }> => {
        if (!provider) return { apiKey: null, previewReason: 'provider_missing' };
        if (!provider.enabled) return { apiKey: null, previewReason: 'provider_missing' };
        if (provider.type === 'ollama') return { apiKey: 'ollama-local', previewReason: null };
        if (!provider.api_key_ref) return { apiKey: null, previewReason: 'api_key_missing' };
        try {
          const apiKey = await deps.keystore.read(provider.api_key_ref);
          return { apiKey, previewReason: apiKey ? null : 'api_key_missing' };
        } catch (e) {
          req.log.warn({ err: e, provider_id: provider.id }, 'quick_compare.keystore_read_failed');
          return { apiKey: null, previewReason: 'keystore_read_failed' };
        }
      }));
      const results = await Promise.all(outputs.map((output, index) =>
        runCompareParticipant({
          stream: dataStream.stream,
          signal: dataStream.abortController.signal,
          compareId: compare.id,
          conversationId: conversation.id,
          runId,
          outputId: output.id,
          index,
          model: selectedModels[index]!,
          provider: providers[index] ?? null,
          apiKey: keyResults[index]?.apiKey ?? null,
          previewReason: keyResults[index]?.previewReason ?? null,
          messages,
          sourceUserMessageId: sourceUserMessage.id,
          bus: deps.bus,
          toolPolicy: restrictToolPolicy(
            toolPolicy,
            participantToolNames.get(selectedModels[index]!.id) ?? [],
          ),
          defaultSearchToolName,
          toolNames: participantToolNames.get(selectedModels[index]!.id) ?? [],
          qcRepo,
          costsRepo,
          modelsRepo,
          memoriesRepo,
          runEventsRepo,
          log: req.log,
        }),
      ));
      const completed = results.filter((result) => result.ok).map((result) => result.outputId);
      const failed = results.filter((result) => !result.ok).map((result) => result.outputId);
      const status = completed.length === outputs.length
        ? 'completed'
        : completed.length > 0
          ? 'partial_failed'
          : 'failed';
      qcRepo.updateRunStatus(compare.id, status);
      appendRunEvent(req.log, runEventsRepo, {
        run_id: runId,
        conversation_id: conversation.id,
        message_id: sourceUserMessage.id,
        kind: 'quick_compare.completed',
        status: status === 'failed' ? 'failed' : 'completed',
        label: 'Quick Compare 完成',
        summary: `${completed.length} 个完成，${failed.length} 个失败`,
        payload: {
          compare_id: compare.id,
          completed_output_ids: completed,
          failed_output_ids: failed,
        },
      });
      appendRunEvent(req.log, runEventsRepo, {
        run_id: runId,
        conversation_id: conversation.id,
        message_id: sourceUserMessage.id,
        kind: status === 'failed' ? 'turn.failed' : 'turn.completed',
        status: status === 'failed' ? 'failed' : 'completed',
        label: status === 'failed' ? 'Quick Compare 失败' : 'Quick Compare 完成',
        summary: `${completed.length} 个候选完成`,
        payload: { compare_id: compare.id },
      });
      writeAnnotation(dataStream.stream, [{
        type: 'qc.done',
        compare_id: compare.id,
        completed_output_ids: completed,
        failed_output_ids: failed,
      }]);
      dataStream.stream.end();
    })().catch((e) => {
      req.log.error({ err: e }, 'quick_compare.unhandled');
      qcRepo.updateRunStatus(compare.id, 'failed');
      if (!dataStream.stream.writableEnded) dataStream.stream.end();
    });
  });

  app.get('/v1/quick-compare/:id', async (req) => {
    const params = req.params as { id: string };
    const compare = qcRepo.getRun(params.id);
    if (!compare) {
      throw new TaoriError({ code: 'not_found', message: 'Quick Compare not found' });
    }
    return {
      ok: true,
      data: {
        compare,
        outputs: qcRepo.listOutputs(compare.id),
      },
    };
  });

  app.post('/v1/quick-compare/:id/outputs/:outputId/adopt', async (req) => {
    const params = req.params as { id: string; outputId: string };
    const parsed = QuickCompareAdoptRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw validationError(parsed.error.issues.map((issue) => issue.message).join('; '));
    }
    const compare = qcRepo.getRun(params.id);
    const output = qcRepo.getOutput(params.outputId);
    if (!compare || !output || output.compare_id !== compare.id) {
      throw new TaoriError({ code: 'not_found', message: 'Quick Compare output not found' });
    }
    if (output.status !== 'complete' || !output.content.trim()) {
      throw validationError('只能采纳已完成且有内容的候选回答。');
    }
    const assistant = parsed.data.replace_message_id
      ? (() => {
          const existing = msgRepo.get(parsed.data.replace_message_id!);
          if (!existing || existing.conversation_id !== compare.conversation_id || existing.role !== 'assistant') {
            throw validationError('replace_message_id 不是当前会话中的 assistant 消息。');
          }
          msgRepo.finalize(existing.id, { content: output.content, status: 'complete' });
          return msgRepo.get(existing.id)!;
        })()
      : msgRepo.insert({
          conversation_id: compare.conversation_id,
          role: 'assistant',
          content: output.content,
          model_id: output.model_id,
          parent_message_id: compare.source_user_message_id,
          status: 'complete',
        });
    qcRepo.markAdopted(compare.id, output.id);
    appendRunEvent(req.log, runEventsRepo, {
      run_id: compare.run_id,
      conversation_id: compare.conversation_id,
      message_id: assistant.id,
      kind: 'quick_compare.adopted',
      status: 'completed',
      label: '采纳 Quick Compare 候选',
      summary: output.content.slice(0, 120),
      payload: {
        compare_id: compare.id,
        output_id: output.id,
        assistant_message_id: assistant.id,
        model_id: output.model_id,
      },
    });
    convRepo.touch(compare.conversation_id);
    return {
      ok: true,
      data: {
        compare_id: compare.id,
        output_id: output.id,
        conversation_id: compare.conversation_id,
        assistant_message_id: assistant.id,
      },
    };
  });

  app.post('/v1/quick-compare/:id/retry', async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = QuickCompareRetryRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw validationError(parsed.error.issues.map((issue) => issue.message).join('; '));
    }
    const compare = qcRepo.getRun(params.id);
    if (!compare) {
      throw new TaoriError({ code: 'not_found', message: 'Quick Compare not found' });
    }
    const outputs = qcRepo.listOutputs(compare.id);
    const target = parsed.data.output_id
      ? outputs.find((output) => output.id === parsed.data.output_id)
      : outputs.find((output) => output.status === 'failed') ?? outputs[0];
    if (!target) throw validationError('没有可重试的候选输出。');
    if (parsed.data.model_id && parsed.data.model_id !== target.model_id) {
      throw validationError('当前版本仅支持使用原模型重试该候选。');
    }
    const model = modelsRepo.get(target.model_id);
    if (!model) throw new TaoriError({ code: 'not_found', message: '模型不存在，无法重试。' });
    const provider = model.provider_id ? providersRepo.get(model.provider_id) : null;
    assertProviderRunnableForModel({
      model,
      provider,
      actionLabel: 'Quick Compare 重试',
    });
    const source = compare.source_user_message_id ? msgRepo.get(compare.source_user_message_id) : null;
    const prompt = source?.content ?? '请重新生成这个候选回答。';
    const estimatedCostUsd = estimateCompareCostUsd([model], prompt);
    throwIfBudgetBlockedOrNeedsConfirmation({
      confirmed: parsed.data.confirmed_cost === true,
      conversationId: compare.conversation_id,
      model,
      inputText: prompt,
      estimatedCostUsd,
      costsRepo,
      memoriesRepo,
      defaultThresholdUsd: 0.20,
    });
    qcRepo.patchOutput(target.id, {
      tool_names: target.tool_names,
      content: '',
      status: 'pending',
      error_classification: null,
      error_message: null,
      cost_record_id: null,
      first_token_ms: null,
      duration_ms: null,
    });
    qcRepo.updateRunStatus(compare.id, 'running');
    const toolPolicy = buildConversationToolPolicy(deps.bus ?? null, memoriesRepo, compare.conversation_id);
    const defaultSearchToolName = memoriesRepo.getEffective(compare.conversation_id, 'default_search_tool');
    const participantToolPolicy = restrictToolPolicy(toolPolicy, target.tool_names);
    const dataStream = openDataStream(req.headers.origin, reply);
    writeAnnotation(dataStream.stream, [{
      type: 'qc.meta',
      compare_id: compare.id,
      conversation_id: compare.conversation_id,
      run_id: compare.run_id,
      model_ids: compare.model_ids,
    }]);
    let apiKey: string | null = null;
    let previewReason: QuickComparePreviewReason | null = provider ? null : 'provider_missing';
    if (provider?.type === 'ollama') {
      apiKey = 'ollama-local';
    } else if (provider?.api_key_ref) {
      try {
        apiKey = await deps.keystore.read(provider.api_key_ref);
        previewReason = apiKey ? null : 'api_key_missing';
      } catch (e) {
        req.log.warn({ err: e, provider_id: provider.id }, 'quick_compare.retry_keystore_read_failed');
        previewReason = 'keystore_read_failed';
      }
    } else if (provider) {
      previewReason = 'api_key_missing';
    }
    void (async () => {
      const result = await runCompareParticipant({
        stream: dataStream.stream,
        signal: dataStream.abortController.signal,
        compareId: compare.id,
        conversationId: compare.conversation_id,
        runId: compare.run_id,
        outputId: target.id,
        index: target.participant_index,
        model,
        provider,
        apiKey,
        previewReason,
        messages: [{ role: 'user', content: prompt }],
        sourceUserMessageId: compare.source_user_message_id,
        bus: deps.bus,
        toolPolicy: participantToolPolicy,
        defaultSearchToolName,
        toolNames: target.tool_names,
        qcRepo,
        costsRepo,
        modelsRepo,
        memoriesRepo,
        runEventsRepo,
        log: req.log,
      });
      const nextOutputs = qcRepo.listOutputs(compare.id);
      const completed = nextOutputs.filter((output) => output.status === 'complete').map((output) => output.id);
      const failed = nextOutputs.filter((output) => output.status === 'failed').map((output) => output.id);
      qcRepo.updateRunStatus(
        compare.id,
        completed.length === nextOutputs.length
          ? 'completed'
          : completed.length > 0
            ? 'partial_failed'
            : result.ok
              ? 'completed'
              : 'failed',
      );
      writeAnnotation(dataStream.stream, [{
        type: 'qc.done',
        compare_id: compare.id,
        completed_output_ids: completed,
        failed_output_ids: failed,
      }]);
      dataStream.stream.end();
    })().catch((e) => {
      req.log.error({ err: e }, 'quick_compare.retry_unhandled');
      if (!dataStream.stream.writableEnded) dataStream.stream.end();
    });
  });
}
