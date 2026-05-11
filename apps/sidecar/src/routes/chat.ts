/**
 * POST /v1/chat — streaming chat endpoint (M1.2).
 *
 * Wire format: AI SDK v4 data-stream protocol (header
 * `x-vercel-ai-data-stream: v1`, parts `0:` text, `8:[…]` annotations,
 * `e:{…}` step finish, `d:{…}` message finish).
 *
 * Resolution order for the model used to answer:
 *   1. Look up models[id] from the request body.
 *   2. If the model's provider has an api_key_ref AND the keystore can
 *      retrieve a key, we call the upstream Chat Completions endpoint via
 *      `@ai-sdk/openai` (works for OpenAI / OpenRouter / any compat API).
 *   3. Otherwise we fall back to a deterministic mock reply. This keeps the
 *      M0 path alive (Playwright + offline dev still work) without the
 *      Renderer needing to know about keys.
 *
 * Persistence (M1.2):
 *   - Conversations are upserted via ConversationsRepo (idempotent).
 *   - The incoming user turn is persisted with status='complete'.
 *   - The assistant turn is created up-front with status='streaming' so the
 *     id can be sent on the wire as a `8:[{type:'meta',message_id:…}]`
 *     annotation, then finalized with content+status='complete' on stop or
 *     status='incomplete' on client abort / status='failed' on error.
 *
 * Error classification: any thrown upstream error is mapped via
 * classifyProviderError so the Renderer can decide retry behavior.
 */

import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  ChatRequestSchema,
  ContinueRunRequestSchema,
  RecoverRunRequestSchema,
  TaoriError,
  makeId,
} from '@taori/shared';
import type { BuildServerArgs } from '../server.js';
import {
  ConversationsRepo,
  MessagesRepo,
  ModelsRepo,
  ProvidersRepo,
  CostsRepo,
  MemoriesRepo,
  FilesRepo,
  FileChunksRepo,
  PersonasRepo,
  RunEventsRepo,
  StructuredMemoriesRepo,
} from '../db/repos/index.js';
import {
  classifyProviderError,
  isToolPayloadUnsupportedError,
} from '../providers/registry.js';
import {
  prepareContinueRunAction,
  prepareRecoverRunAction,
} from '../chat/run-actions.js';
import {
  appendRunEvent,
} from '../chat/run-stream.js';
import {
  findRunAssistantMessageId,
  findRunModelId,
} from '../chat/recovery.js';
import { dispatchChatProducer, openDataStream } from '../chat/stream-dispatch.js';
import { requireRecoveryCostConfirmationIfNeeded } from '../chat/cost-confirmation.js';
import { buildProduceCtx } from '../chat/run-context.js';
import { prepareChatRequest } from '../chat/request-prep.js';
import { throwIfBudgetBlockedOrNeedsConfirmation } from '../cost/budget-guard.js';

const TEST_HOOKS_ENABLED = process.env.NODE_ENV !== 'production'
  && process.env.TAORI_DISABLE_TEST_HOOKS !== '1';
const FORCE_CLASSIFICATION_HEADER = 'x-test-force-classification';
const VALID_FORCED_CLASSIFICATIONS = new Set([
  'quota', 'network', 'rate_limit', 'content_filter', 'auth', 'unknown',
]);

function normalizeResumeMessageStatus(
  status: string | null,
): 'pending' | 'streaming' | 'complete' | 'completed' | 'incomplete' | 'failed' | null {
  if (
    status === 'pending' ||
    status === 'streaming' ||
    status === 'complete' ||
    status === 'completed' ||
    status === 'incomplete' ||
    status === 'failed'
  ) {
    return status;
  }
  return null;
}

export function registerChatRoute(
  app: FastifyInstance,
  deps: BuildServerArgs,
): void {
  const convRepo = new ConversationsRepo(deps.db);
  const msgRepo = new MessagesRepo(deps.db);
  const modelsRepo = new ModelsRepo(deps.db);
  const providersRepo = new ProvidersRepo(deps.db);
  const costsRepo = new CostsRepo(deps.db);
  const memoriesRepo = new MemoriesRepo(deps.db);
  const filesRepo = new FilesRepo(deps.db);
  const fileChunksRepo = new FileChunksRepo(deps.db);
  const personasRepo = new PersonasRepo(deps.db);
  const runEventsRepo = new RunEventsRepo(deps.db);
  const structuredMemoriesRepo = new StructuredMemoriesRepo(deps.db);

  app.post('/v1/chat', async (req, reply) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    const body = parsed.data;
    const model = modelsRepo.get(body.model_id);
    const provider = model?.provider_id ? providersRepo.get(model.provider_id) : null;
    const {
      conversation,
      attachments,
      lastUserMsg,
      resolvedPersona,
      intentRoute,
      sourceUserMessageId,
      assistantMsg,
    } = await prepareChatRequest({
      db: deps.db,
      body,
      model: model ?? null,
      convRepo,
      msgRepo,
      filesRepo,
      filesDir: path.join(path.dirname(deps.config.dbPath), 'files'),
      memoriesRepo,
      personasRepo,
    });

    // M2.4 explicit image-command path: emit capability_route annotation, end.
    if (intentRoute) {
      const dataStream = openDataStream(req.headers.origin, reply);
      const { stream } = dataStream;
      const runId = makeId('run');
      appendRunEvent(req.log, runEventsRepo, {
        run_id: runId,
        conversation_id: conversation.id,
        message_id: null,
        kind: 'turn.started',
        status: 'started',
        label: '用户回合开始',
        summary: lastUserMsg?.content?.slice(0, 120) ?? null,
        payload: { route: 'capability', capability: 'image' },
      });
      appendRunEvent(req.log, runEventsRepo, {
        run_id: runId,
        conversation_id: conversation.id,
        message_id: null,
        kind: 'capability.routed',
        status: 'completed',
        label: '路由到图像生成',
        summary: intentRoute.prompt.slice(0, 180),
        payload: {
          capability: 'image',
          user_message_id: intentRoute.user_message_id,
        },
      });
      stream.write(
        `8:${JSON.stringify([
          {
            type: 'meta',
            conversation_id: conversation.id,
            message_id: null,
            model_id: null,
            run_id: runId,
          },
        ])}\n`,
      );
      stream.write(
        `8:${JSON.stringify([
          {
            type: 'capability_route',
            capability: 'image',
            prompt: intentRoute.prompt,
            user_message_id: intentRoute.user_message_id,
            conversation_id: conversation.id,
          },
        ])}\n`,
      );
      stream.write(
        `d:${JSON.stringify({
          finishReason: 'stop',
          usage: { promptTokens: 0, completionTokens: 0 },
        })}\n`,
      );
      appendRunEvent(req.log, runEventsRepo, {
        run_id: runId,
        conversation_id: conversation.id,
        message_id: null,
        kind: 'turn.completed',
        status: 'completed',
        label: '用户回合完成',
        summary: '已等待用户选择图像生成模型',
      });
      stream.end();
      return;
    }

    if (model) {
      throwIfBudgetBlockedOrNeedsConfirmation({
        confirmed: body.confirmed_cost === true,
        conversationId: conversation.id,
        model,
        inputText: body.messages.map((message) => message.content).join('\n'),
        costsRepo,
        memoriesRepo,
        thresholdKey: '__chat_hard_budget_threshold_disabled',
        defaultThresholdUsd: Number.POSITIVE_INFINITY,
        softBudgetEnabled: false,
      });
    }

    const runId = makeId('run');
    const ctx = await buildProduceCtx({
      runId,
      conversationId: conversation.id,
      messageId: assistantMsg!.id,
      requestModelId: body.model_id,
      model: model ?? null,
      userText: lastUserMsg?.content ?? '',
      messages: body.messages,
      attachments,
      boundPersona: resolvedPersona,
      log: req.log,
      forcedClassification: TEST_HOOKS_ENABLED
        ? readForcedClassification(req.headers[FORCE_CLASSIFICATION_HEADER])
        : null,
      sourceUserMessageId,
      deps,
      modelsRepo,
      memoriesRepo,
      structuredMemoriesRepo,
      filesRepo,
      fileChunksRepo,
      runEventsRepo,
    });
    const dataStream = openDataStream(req.headers.origin, reply);
    const { stream, abortController } = dataStream;
    appendRunEvent(req.log, runEventsRepo, {
      run_id: runId,
      conversation_id: conversation.id,
      message_id: assistantMsg!.id,
      kind: 'turn.started',
      status: 'started',
      label: '用户回合开始',
      summary: lastUserMsg?.content?.slice(0, 120) ?? null,
      payload: {
        model_id: model?.id ?? body.model_id,
        source_user_message_id: sourceUserMessageId,
        attachment_count: attachments.length,
        persona: resolvedPersona?.name ?? null,
      },
    });

    await dispatchChatProducer({
      stream,
      abortSignal: abortController.signal,
      isAborted: dataStream.isAborted,
      ctx,
      model: model ?? null,
      provider: model ? provider : null,
      modelName: model?.model_name ?? body.model_id,
      keystore: deps.keystore,
      msgRepo,
      costsRepo,
      modelsRepo,
      providersRepo,
      memoriesRepo,
      structuredMemoriesRepo,
      setForceFinalize: dataStream.setForceFinalize,
      keyReadFailedLogName: 'chat.keystore_read_failed',
      unhandledLogName: 'chat.upstream_unhandled',
    });
  });

  app.post<{ Params: { id: string } }>('/v1/runs/:id/continue', async (req, reply) => {
    const parsed = ContinueRunRequestSchema.safeParse(req.body ?? undefined);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    const action = prepareContinueRunAction({
      runId: req.params.id,
      convRepo,
      msgRepo,
      modelsRepo,
      providersRepo,
      memoriesRepo,
      personasRepo,
      runEventsRepo,
    });
    const {
      originalAssistant,
      sourceUserMessageId,
      conversationId,
      model,
      provider,
      boundPersona,
      upstreamMessages,
    } = action;

    requireRecoveryCostConfirmationIfNeeded({
      confirmed: parsed.data?.confirmed_cost === true,
      conversationId,
      model,
      messages: upstreamMessages,
      costsRepo,
      memoriesRepo,
    });

    const assistantMsg = msgRepo.insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: '',
      model_id: model.id,
      parent_message_id: originalAssistant.id,
      status: 'streaming',
    });

    const dataStream = openDataStream(req.headers.origin, reply);
    const { stream, abortController } = dataStream;

    const runId = makeId('run');
    const ctx = await buildProduceCtx({
      runId,
      conversationId,
      messageId: assistantMsg.id,
      requestModelId: model.id,
      model,
      userText: '请继续上文',
      messages: upstreamMessages,
      boundPersona,
      log: req.log,
      forcedClassification: TEST_HOOKS_ENABLED
        ? readForcedClassification(req.headers[FORCE_CLASSIFICATION_HEADER])
        : null,
      sourceUserMessageId,
      deps,
      modelsRepo,
      memoriesRepo,
      structuredMemoriesRepo,
      filesRepo,
      fileChunksRepo,
      runEventsRepo,
    });

    appendRunEvent(req.log, runEventsRepo, {
      run_id: runId,
      conversation_id: conversationId,
      message_id: assistantMsg.id,
      kind: 'turn.started',
      status: 'started',
      label: '续写开始',
      summary: originalAssistant.content?.slice(0, 120) ?? null,
      payload: {
        run_kind: 'continue',
        parent_run_id: req.params.id,
        model_id: model.id,
        source_user_message_id: sourceUserMessageId,
        assistant_message_id: assistantMsg.id,
        continued_from_message_id: originalAssistant.id,
      },
    });

    await dispatchChatProducer({
      stream,
      abortSignal: abortController.signal,
      isAborted: dataStream.isAborted,
      ctx,
      model,
      provider,
      modelName: model.model_name,
      keystore: deps.keystore,
      msgRepo,
      costsRepo,
      modelsRepo,
      providersRepo,
      memoriesRepo,
      structuredMemoriesRepo,
      setForceFinalize: dataStream.setForceFinalize,
      keyReadFailedLogName: 'chat.continue_keystore_read_failed',
      unhandledLogName: 'chat.continue_upstream_unhandled',
    });
  });

  app.get<{ Params: { id: string } }>('/v1/runs/:id/resume-state', async (req) => {
    const events = runEventsRepo.listByRun(req.params.id);
    if (events.length === 0) {
      throw new TaoriError({
        code: 'not_found',
        message: `Run ${req.params.id} not found`,
      });
    }

    const assistantMessageId = findRunAssistantMessageId(events);
    const assistant = assistantMessageId ? msgRepo.get(assistantMessageId) : null;
    const conversationId =
      assistant?.conversation_id ??
      events.find((event) => event.conversation_id)?.conversation_id ??
      null;
    const messageStatus = normalizeResumeMessageStatus(assistant?.status ?? null);
    const modelId = findRunModelId(events) ?? assistant?.model_id ?? null;
    const model = modelId ? modelsRepo.get(modelId) : null;

    let canContinue = false;
    let recommendedAction: 'continue' | 'retry' | 'switch_model' | 'none' = 'none';
    let reason: string | null = null;

    if (!assistantMessageId || !assistant) {
      reason = 'assistant_message_missing';
    } else if (messageStatus === 'incomplete') {
      if (!model) {
        recommendedAction = 'switch_model';
        reason = 'model_unavailable';
      } else if (!model.enabled || (model.disabled_until != null && model.disabled_until > Date.now())) {
        recommendedAction = 'switch_model';
        reason = 'model_disabled';
      } else {
        canContinue = true;
        recommendedAction = 'continue';
      }
    } else if (messageStatus === 'streaming') {
      reason = 'still_streaming';
    } else if (messageStatus === 'failed') {
      recommendedAction = model ? 'retry' : 'switch_model';
      reason = 'message_failed';
    } else {
      reason = 'not_incomplete';
    }

    return {
      ok: true,
      data: {
        run_id: req.params.id,
        conversation_id: conversationId,
        assistant_message_id: assistantMessageId,
        message_status: messageStatus,
        can_continue: canContinue,
        recommended_action: recommendedAction,
        reason,
      },
    };
  });

  app.post<{ Params: { id: string } }>('/v1/runs/:id/recover', async (req, reply) => {
    const parsed = RecoverRunRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    const prepared = prepareRecoverRunAction({
      runId: req.params.id,
      request: parsed.data,
      convRepo,
      msgRepo,
      modelsRepo,
      providersRepo,
      memoriesRepo,
      personasRepo,
      runEventsRepo,
    });
    const {
      action,
      failedTool,
      skipToolName,
      originalAssistantId,
      sourceUserMessageId,
      sourceUser,
      conversationId,
      model,
      provider,
      boundPersona,
      compacted,
      recoveryMessages,
    } = prepared;

    requireRecoveryCostConfirmationIfNeeded({
      confirmed: parsed.data.confirmed_cost === true,
      conversationId,
      model,
      messages: recoveryMessages,
      costsRepo,
      memoriesRepo,
    });

    const assistantMsg = msgRepo.insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: '',
      model_id: model.id,
      parent_message_id: originalAssistantId,
      status: 'streaming',
    });

    const dataStream = openDataStream(req.headers.origin, reply);
    const { stream, abortController } = dataStream;

    const runId = makeId('run');
    const ctx = await buildProduceCtx({
      runId,
      conversationId,
      messageId: assistantMsg.id,
      requestModelId: model.id,
      model,
      userText: sourceUser.content ?? '',
      messages: recoveryMessages,
      boundPersona,
      skipToolName,
      log: req.log,
      forcedClassification: TEST_HOOKS_ENABLED
        ? readForcedClassification(req.headers[FORCE_CLASSIFICATION_HEADER])
        : null,
      sourceUserMessageId,
      deps,
      modelsRepo,
      memoriesRepo,
      structuredMemoriesRepo,
      filesRepo,
      fileChunksRepo,
      runEventsRepo,
    });

    appendRunEvent(req.log, runEventsRepo, {
      run_id: runId,
      conversation_id: conversationId,
      message_id: assistantMsg.id,
      kind: 'recovery.started',
      status: 'retrying',
      label: '恢复开始',
      summary:
        action === 'switch_model'
          ? `切换到 ${model.model_name}`
          : action === 'skip_tool'
            ? `跳过 ${failedTool?.label ?? skipToolName}`
            : action === 'compact_context'
            ? '压缩上下文后重试'
            : '重试当前模型',
      payload: {
        action,
        parent_run_id: req.params.id,
        model_id: model.id,
        source_user_message_id: sourceUserMessageId,
        assistant_message_id: assistantMsg.id,
        original_assistant_message_id: originalAssistantId,
        ...(skipToolName ? { skipped_tool_name: skipToolName, skipped_tool_label: failedTool?.label ?? skipToolName } : {}),
        ...(compacted
          ? {
              compacted_message_count: compacted.compacted_message_count,
              compacted_summary_chars: compacted.summary_chars,
            }
          : {}),
      },
    });
    appendRunEvent(req.log, runEventsRepo, {
      run_id: runId,
      conversation_id: conversationId,
      message_id: assistantMsg.id,
      kind: 'turn.started',
      status: 'started',
      label:
        action === 'switch_model'
          ? '切换模型重试开始'
          : action === 'skip_tool'
            ? '跳过工具重试开始'
            : action === 'compact_context'
            ? '压缩上下文重试开始'
            : '重试开始',
      summary: sourceUser.content?.slice(0, 120) ?? null,
      payload: {
        run_kind: 'retry',
        parent_run_id: req.params.id,
        recovery_policy: action,
        model_id: model.id,
        source_user_message_id: sourceUserMessageId,
        assistant_message_id: assistantMsg.id,
        ...(skipToolName ? { skipped_tool_name: skipToolName, skipped_tool_label: failedTool?.label ?? skipToolName } : {}),
        ...(compacted
          ? {
              compacted_message_count: compacted.compacted_message_count,
              compacted_summary_chars: compacted.summary_chars,
            }
          : {}),
      },
    });

    const recordRecoveryTerminal = (): void => {
      const latest = msgRepo.get(assistantMsg.id);
      if (!latest) return;
      if (latest.status === 'complete') {
        appendRunEvent(req.log, runEventsRepo, {
          run_id: runId,
          conversation_id: conversationId,
          message_id: assistantMsg.id,
          kind: 'recovery.completed',
          status: 'completed',
          label: '恢复完成',
          summary:
            action === 'switch_model'
              ? `已切换到 ${model.model_name}`
              : action === 'skip_tool'
                ? `已跳过 ${failedTool?.label ?? skipToolName}`
              : action === 'compact_context'
                ? '压缩上下文后重试完成'
                : '重试完成',
          payload: {
            action,
            parent_run_id: req.params.id,
            assistant_message_id: assistantMsg.id,
            ...(skipToolName ? { skipped_tool_name: skipToolName, skipped_tool_label: failedTool?.label ?? skipToolName } : {}),
          },
        });
      } else if (latest.status === 'failed') {
        appendRunEvent(req.log, runEventsRepo, {
          run_id: runId,
          conversation_id: conversationId,
          message_id: assistantMsg.id,
          kind: 'recovery.failed',
          status: 'failed',
          label: '恢复失败',
          summary: latest.error ?? latest.status,
          payload: {
            action,
            parent_run_id: req.params.id,
            assistant_message_id: assistantMsg.id,
            ...(skipToolName ? { skipped_tool_name: skipToolName, skipped_tool_label: failedTool?.label ?? skipToolName } : {}),
          },
        });
      }
    };

    await dispatchChatProducer({
      stream,
      abortSignal: abortController.signal,
      isAborted: dataStream.isAborted,
      ctx,
      model,
      provider,
      modelName: model.model_name,
      keystore: deps.keystore,
      msgRepo,
      costsRepo,
      modelsRepo,
      providersRepo,
      memoriesRepo,
      structuredMemoriesRepo,
      setForceFinalize: dataStream.setForceFinalize,
      onFinish: recordRecoveryTerminal,
      keyReadFailedLogName: 'chat.recover_keystore_read_failed',
      unhandledLogName: 'chat.recover_upstream_unhandled',
    });
  });
}

/**
 * Parse the dev-only `X-Test-Force-Classification` header. Returns null if
 * absent, malformed, or not in the allowlist. Even in dev a junk value is
 * silently ignored — no error to client — to avoid surprising production-ish
 * deployments that accidentally have NODE_ENV != production.
 */
function readForcedClassification(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return VALID_FORCED_CLASSIFICATIONS.has(v) ? v : null;
}
