/**
 * Service: continue an incomplete run.
 *
 * All business logic for POST /v1/runs/:id/continue lives here.
 * The route handler only does Zod validation, extracts HTTP-layer values
 * (forced classification, origin), and delegates to this function.
 */

import type { FastifyReply } from 'fastify';
import type { BuildServerArgs } from '../../server.js';
import type { Repos } from '../../db/repos/index.js';
import type { KeyStore } from '../../keystore.js';
import { makeId } from '@taori/shared';
import { prepareContinueRunAction } from '../../chat/run-actions.js';
import { buildProduceCtx } from '../../chat/run-context.js';
import { dispatchChatProducer, openDataStream } from '../../chat/stream-dispatch.js';
import { requireRecoveryCostConfirmationIfNeeded } from '../../chat/cost-confirmation.js';
import { appendTurnStartedEvent } from './run-events.js';

export interface ContinueRunInput {
  runId: string;
  confirmedCost: boolean;
  forcedClassification: string | null;
  origin: string | undefined;
}

export async function continueRun(
  deps: {
    repos: Repos;
    keystore: KeyStore;
    bus: BuildServerArgs['bus'];
    config: BuildServerArgs['config'];
    db: BuildServerArgs['db'];
  },
  input: ContinueRunInput,
  reply: FastifyReply,
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
): Promise<void> {
  const { repos } = deps;
  const convRepo = repos.conversations;
  const msgRepo = repos.messages;
  const modelsRepo = repos.models;
  const providersRepo = repos.providers;
  const memoriesRepo = repos.memories;
  const filesRepo = repos.files;
  const fileChunksRepo = repos.fileChunks;
  const personasRepo = repos.personas;
  const runEventsRepo = repos.runEvents;
  const structuredMemoriesRepo = repos.structuredMemories;
  const costsRepo = repos.costs;

  const action = prepareContinueRunAction({
    runId: input.runId,
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
    confirmed: input.confirmedCost,
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

  try {
    const dataStream = openDataStream(input.origin, reply);
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
      log,
      forcedClassification: input.forcedClassification,
      sourceUserMessageId,
      deps: { bus: deps.bus },
      modelsRepo,
      memoriesRepo,
      structuredMemoriesRepo,
      filesRepo,
      fileChunksRepo,
      runEventsRepo,
    });

    appendTurnStartedEvent(log, runEventsRepo, {
      run_id: runId,
      conversation_id: conversationId,
      message_id: assistantMsg.id,
      run_kind: 'continue',
      parent_run_id: input.runId,
      model_id: model.id,
      source_user_message_id: sourceUserMessageId,
      assistant_message_id: assistantMsg.id,
      label: '续写开始',
      summary: originalAssistant.content?.slice(0, 120) ?? null,
      extra_payload: {
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
  } catch (err) {
    try {
      msgRepo.finalize(assistantMsg.id, {
        content: '',
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    } catch (finalizeErr) {
      log.error({ err: finalizeErr, messageId: assistantMsg.id }, 'chat.continue_finalize_on_error_failed');
    }
    throw err;
  }
}
