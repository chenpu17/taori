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
  appendRunEvent,
} from '../chat/run-stream.js';
import {
  findRunAssistantMessageId,
  findRunModelId,
} from '../chat/recovery.js';
import { dispatchChatProducer, openDataStream } from '../chat/stream-dispatch.js';
import { buildProduceCtx } from '../chat/run-context.js';
import { prepareChatRequest } from '../chat/request-prep.js';
import { throwIfBudgetBlockedOrNeedsConfirmation } from '../cost/budget-guard.js';
import { continueRun } from '../services/chat/continue-run.js';
import { recoverRun } from '../services/chat/recover-run.js';
import { handleCapabilityRoute } from '../services/chat/handle-capability-route.js';
import { assertProviderRunnableForModel } from '../models/eligibility.js';

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
  const { repos } = deps;
  const convRepo = repos.conversations;
  const msgRepo = repos.messages;
  const modelsRepo = repos.models;
  const providersRepo = repos.providers;
  const costsRepo = repos.costs;
  const memoriesRepo = repos.memories;
  const filesRepo = repos.files;
  const fileChunksRepo = repos.fileChunks;
  const personasRepo = repos.personas;
  const runEventsRepo = repos.runEvents;
  const structuredMemoriesRepo = repos.structuredMemories;
  const forceClassificationEnabled = deps.config.testHooks.forceClassification;

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
    if (model) {
      assertProviderRunnableForModel({
        model,
        provider,
        actionLabel: '聊天调用',
      });
    }
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
      await handleCapabilityRoute(repos, {
        conversationId: conversation.id,
        capability: 'image',
        prompt: intentRoute.prompt,
        userMessageId: intentRoute.user_message_id,
        lastUserContent: lastUserMsg?.content?.slice?.(0, 120) ?? null,
        origin: req.headers.origin,
      }, reply, req.log);
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
    try {
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
        forcedClassification: forceClassificationEnabled
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
        convRepo,
        hermetic: deps.config.testHooks.hermeticWeb || deps.config.testHooks.automatedTest,
        setForceFinalize: dataStream.setForceFinalize,
        keyReadFailedLogName: 'chat.keystore_read_failed',
        unhandledLogName: 'chat.upstream_unhandled',
      });
    } catch (err) {
      // prepareChatRequest already created the assistant message with
      // status='streaming'. If anything after it throws, finalize the
      // message as 'failed' so it doesn't stay stuck in streaming forever.
      try {
        msgRepo.finalize(assistantMsg!.id, {
          content: '',
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      } catch (finalizeErr) {
        req.log.error({ err: finalizeErr, messageId: assistantMsg!.id }, 'chat.finalize_on_error_failed');
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/v1/runs/:id/continue', async (req, reply) => {
    const parsed = ContinueRunRequestSchema.safeParse(req.body ?? undefined);
    if (!parsed.success) {
      throw new TaoriError({
        code: 'validation_error',
        message: parsed.error.errors.map((e) => e.message).join('; '),
      });
    }
    await continueRun(
      { repos, keystore: deps.keystore, bus: deps.bus, config: deps.config, db: deps.db },
      {
        runId: req.params.id,
        confirmedCost: parsed.data?.confirmed_cost === true,
        forcedClassification: forceClassificationEnabled
          ? readForcedClassification(req.headers[FORCE_CLASSIFICATION_HEADER])
          : null,
        origin: req.headers.origin,
      },
      reply,
      req.log,
    );
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
    const provider = model?.provider_id ? providersRepo.get(model.provider_id) : null;

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
      } else if (!provider?.enabled) {
        recommendedAction = 'switch_model';
        reason = 'provider_disabled';
      } else {
        canContinue = true;
        recommendedAction = 'continue';
      }
    } else if (messageStatus === 'streaming') {
      reason = 'still_streaming';
    } else if (messageStatus === 'failed') {
      if (!model) {
        recommendedAction = 'switch_model';
        reason = 'model_unavailable';
      } else if (!model.enabled || (model.disabled_until != null && model.disabled_until > Date.now())) {
        recommendedAction = 'switch_model';
        reason = 'model_disabled';
      } else if (!provider?.enabled) {
        recommendedAction = 'switch_model';
        reason = 'provider_disabled';
      } else {
        recommendedAction = 'retry';
        reason = 'message_failed';
      }
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
    await recoverRun(
      { repos, keystore: deps.keystore, bus: deps.bus, config: deps.config, db: deps.db },
      {
        runId: req.params.id,
        request: parsed.data,
        forcedClassification: forceClassificationEnabled
          ? readForcedClassification(req.headers[FORCE_CLASSIFICATION_HEADER])
          : null,
        origin: req.headers.origin,
      },
      reply,
      req.log,
    );
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
