/**
 * Service: recover (retry / switch-model / skip-tool / compact-context) a run.
 *
 * All business logic for POST /v1/runs/:id/recover lives here.
 * The route handler only does Zod validation, extracts HTTP-layer values
 * (forced classification, origin), and delegates to this function.
 */

import type { FastifyReply } from 'fastify';
import type { BuildServerArgs } from '../../server.js';
import type { Repos } from '../../db/repos/index.js';
import type { KeyStore } from '../../keystore.js';
import type { RecoverRunRequest } from '@taori/shared';
import { makeId } from '@taori/shared';
import { prepareRecoverRunAction } from '../../chat/run-actions.js';
import { buildProduceCtx } from '../../chat/run-context.js';
import { dispatchChatProducer, openDataStream } from '../../chat/stream-dispatch.js';
import { requireRecoveryCostConfirmationIfNeeded } from '../../chat/cost-confirmation.js';
import { appendTurnStartedEvent, buildRecoveryPayloadAddons } from './run-events.js';

export interface RecoverRunInput {
  runId: string;
  request: RecoverRunRequest;
  forcedClassification: string | null;
  origin: string | undefined;
}

export async function recoverRun(
  deps: {
    repos: Repos;
    keystore: KeyStore;
    bus: BuildServerArgs['bus'];
    config: BuildServerArgs['config'];
    db: BuildServerArgs['db'];
  },
  input: RecoverRunInput,
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

  const prepared = prepareRecoverRunAction({
    runId: input.runId,
    request: input.request,
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
    confirmed: input.request.confirmed_cost === true,
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

  const runId = makeId('run');

  // Emit recovery.started before any fallible work so the event is always
  // available for diagnostics even if buildProduceCtx or dispatch throws.
  const recoveryStartedSummary =
    action === 'switch_model'
      ? `切换到 ${model.model_name}`
      : action === 'skip_tool'
        ? `跳过 ${failedTool?.label ?? skipToolName}`
        : action === 'compact_context'
          ? '压缩上下文后重试'
          : '重试当前模型';

  const recoveryStartedPayload = buildRecoveryPayloadAddons({
    action,
    parentRunId: input.runId,
    assistantMessageId: assistantMsg.id,
    originalAssistantMessageId: originalAssistantId ?? undefined,
    modelId: model.id,
    sourceUserMessageId,
    skipToolName,
    failedToolLabel: failedTool?.label,
    compacted,
  });

  runEventsRepo.appendSafe({
    run_id: runId,
    conversation_id: conversationId,
    message_id: assistantMsg.id,
    kind: 'recovery.started',
    status: 'retrying',
    label: '恢复开始',
    summary: recoveryStartedSummary,
    payload: recoveryStartedPayload,
  }, log);

  try {
    const dataStream = openDataStream(input.origin, reply);
    const { stream, abortController } = dataStream;

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

    // turn.started event
    const turnStartedLabel =
      action === 'switch_model'
        ? '切换模型重试开始'
        : action === 'skip_tool'
          ? '跳过工具重试开始'
        : action === 'compact_context'
          ? '压缩上下文重试开始'
          : '重试开始';

    const turnExtraPayload = buildRecoveryPayloadAddons({
      action,
      parentRunId: input.runId,
      assistantMessageId: assistantMsg.id,
      skipToolName,
      failedToolLabel: failedTool?.label,
      compacted,
      recoveryPolicy: action,
    });

    appendTurnStartedEvent(log, runEventsRepo, {
      run_id: runId,
      conversation_id: conversationId,
      message_id: assistantMsg.id,
      run_kind: 'retry',
      parent_run_id: input.runId,
      model_id: model.id,
      source_user_message_id: sourceUserMessageId,
      assistant_message_id: assistantMsg.id,
      label: turnStartedLabel,
      summary: sourceUser.content?.slice(0, 120) ?? null,
      extra_payload: turnExtraPayload,
    });

    // recovery terminal callback
    const recordRecoveryTerminal = (): void => {
      const latest = msgRepo.get(assistantMsg.id);
      if (!latest) return;
      const terminalBasePayload = buildRecoveryPayloadAddons({
        action,
        parentRunId: input.runId,
        assistantMessageId: assistantMsg.id,
        skipToolName,
        failedToolLabel: failedTool?.label,
      });

      if (latest.status === 'complete') {
        runEventsRepo.appendSafe({
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
          payload: terminalBasePayload,
        }, log);
      } else if (latest.status === 'failed') {
        runEventsRepo.appendSafe({
          run_id: runId,
          conversation_id: conversationId,
          message_id: assistantMsg.id,
          kind: 'recovery.failed',
          status: 'failed',
          label: '恢复失败',
          summary: latest.error ?? latest.status,
          payload: terminalBasePayload,
        }, log);
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
  } catch (err) {
    try {
      msgRepo.finalize(assistantMsg.id, {
        content: '',
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      runEventsRepo.appendSafe({
        run_id: runId,
        conversation_id: conversationId,
        message_id: assistantMsg.id,
        kind: 'recovery.failed',
        status: 'failed',
        label: '恢复失败',
        summary: err instanceof Error ? err.message : String(err),
        payload: buildRecoveryPayloadAddons({
          action,
          parentRunId: input.runId,
          assistantMessageId: assistantMsg.id,
          skipToolName,
          failedToolLabel: failedTool?.label,
        }),
      }, log);
    } catch (finalizeErr) {
      log.error({ err: finalizeErr, messageId: assistantMsg.id }, 'chat.recover_finalize_on_error_failed');
    }
    throw err;
  }
}
