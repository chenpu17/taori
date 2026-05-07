import {
  type Model,
  type Provider,
  type RecoverRunRequest,
  TaoriError,
  isChatCapable,
} from '@taori/shared';
import type {
  ConversationsRepo,
  MemoriesRepo,
  MessagesRepo,
  ModelsRepo,
  PersonasRepo,
  ProvidersRepo,
  RunEventsRepo,
  MessageRow,
} from '../db/repos/index.js';
import {
  buildCompactedRecoveryMessages,
  findLastFailedTool,
  findPreviousUserMessageId,
  findRunAssistantMessageId,
  findRunModelId,
  findRunSourceUserMessageId,
} from './recovery.js';

export type ChatMessageForUpstream = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type BoundPersona = {
  id: string;
  name: string;
  prompt: string;
};

function getBoundPersonaForConversation(
  memoriesRepo: MemoriesRepo,
  personasRepo: PersonasRepo,
  conversationId: string,
): BoundPersona | null {
  const personaId = memoriesRepo.get('session', conversationId, 'active_persona_id');
  if (!personaId) return null;
  const persona = personasRepo.get(personaId);
  if (!persona) {
    memoriesRepo.delete('session', conversationId, 'active_persona_id');
    return null;
  }
  return { id: persona.id, name: persona.name, prompt: persona.prompt };
}

function rowsToUpstreamMessages(rows: MessageRow[]): ChatMessageForUpstream[] {
  return rows
    .filter((row) => row.role === 'user' || row.role === 'assistant' || row.role === 'system')
    .map((row) => ({
      role: row.role as 'user' | 'assistant' | 'system',
      content: row.content ?? '',
    }));
}

export interface ContinueRunActionInput {
  runId: string;
  convRepo: ConversationsRepo;
  msgRepo: MessagesRepo;
  modelsRepo: ModelsRepo;
  providersRepo: ProvidersRepo;
  memoriesRepo: MemoriesRepo;
  personasRepo: PersonasRepo;
  runEventsRepo: RunEventsRepo;
}

export interface ContinueRunAction {
  originalAssistant: MessageRow;
  sourceUserMessageId: string | null;
  conversationId: string;
  model: Model;
  provider: Provider | null;
  boundPersona: BoundPersona | null;
  upstreamMessages: ChatMessageForUpstream[];
}

export function prepareContinueRunAction(input: ContinueRunActionInput): ContinueRunAction {
  const originalEvents = input.runEventsRepo.listByRun(input.runId);
  if (originalEvents.length === 0) {
    throw new TaoriError({
      code: 'not_found',
      message: `Run ${input.runId} not found`,
    });
  }

  const originalAssistantId = findRunAssistantMessageId(originalEvents);
  if (!originalAssistantId) {
    throw new TaoriError({
      code: 'conflict',
      message: `Run ${input.runId} has no assistant message to continue`,
    });
  }
  const originalAssistant = input.msgRepo.get(originalAssistantId);
  if (!originalAssistant) {
    throw new TaoriError({
      code: 'not_found',
      message: `Assistant message ${originalAssistantId} not found`,
    });
  }
  if (originalAssistant.status !== 'incomplete') {
    throw new TaoriError({
      code: 'conflict',
      message: `Run ${input.runId} is not incomplete`,
      details: { message_status: originalAssistant.status },
    });
  }
  const conversation = input.convRepo.get(originalAssistant.conversation_id);
  if (!conversation) {
    throw new TaoriError({
      code: 'not_found',
      message: `Conversation ${originalAssistant.conversation_id} not found`,
    });
  }
  const model = originalAssistant.model_id ? input.modelsRepo.get(originalAssistant.model_id) : null;
  if (!model) {
    throw new TaoriError({
      code: 'conflict',
      message: 'Cannot continue because the original assistant model is unavailable',
      details: { model_id: originalAssistant.model_id },
    });
  }

  const rows = input.msgRepo.listByConversation(conversation.id);
  const originalIndex = rows.findIndex((row) => row.id === originalAssistant.id);
  const rowsForContext = originalIndex >= 0 ? rows.slice(0, originalIndex + 1) : rows;
  const upstreamMessages = rowsToUpstreamMessages(rowsForContext);
  upstreamMessages.push({
    role: 'user',
    content: '请从上一条助手消息被中断的位置继续写，不要重复已经写过的内容。',
  });

  return {
    originalAssistant,
    sourceUserMessageId: findPreviousUserMessageId(rowsForContext, originalAssistant.id),
    conversationId: conversation.id,
    model,
    provider: model.provider_id ? input.providersRepo.get(model.provider_id) : null,
    boundPersona: getBoundPersonaForConversation(input.memoriesRepo, input.personasRepo, conversation.id),
    upstreamMessages,
  };
}

export interface RecoverRunActionInput {
  runId: string;
  request: RecoverRunRequest;
  convRepo: ConversationsRepo;
  msgRepo: MessagesRepo;
  modelsRepo: ModelsRepo;
  providersRepo: ProvidersRepo;
  memoriesRepo: MemoriesRepo;
  personasRepo: PersonasRepo;
  runEventsRepo: RunEventsRepo;
}

export interface RecoverRunAction {
  action: Exclude<RecoverRunRequest['action'], 'continue'>;
  failedTool: ReturnType<typeof findLastFailedTool>;
  skipToolName: string | null;
  originalAssistantId: string | null;
  sourceUserMessageId: string;
  sourceUser: MessageRow;
  conversationId: string;
  model: Model;
  provider: Provider | null;
  boundPersona: BoundPersona | null;
  compacted: ReturnType<typeof buildCompactedRecoveryMessages> | null;
  recoveryMessages: ChatMessageForUpstream[];
}

export function prepareRecoverRunAction(input: RecoverRunActionInput): RecoverRunAction {
  const action = input.request.action;
  if (action === 'continue') {
    throw new TaoriError({
      code: 'conflict',
      message: 'Use POST /v1/runs/:id/continue for continue recovery',
    });
  }

  const originalEvents = input.runEventsRepo.listByRun(input.runId);
  if (originalEvents.length === 0) {
    throw new TaoriError({
      code: 'not_found',
      message: `Run ${input.runId} not found`,
    });
  }

  const failedTool = findLastFailedTool(originalEvents);
  const skipToolName = action === 'skip_tool'
    ? input.request.tool_name ?? failedTool?.name ?? null
    : null;
  if (action === 'skip_tool' && !skipToolName) {
    throw new TaoriError({
      code: 'conflict',
      message: `Run ${input.runId} has no failed tool to skip`,
      details: { action },
    });
  }

  const originalAssistantId = findRunAssistantMessageId(originalEvents);
  const originalAssistant = originalAssistantId ? input.msgRepo.get(originalAssistantId) : null;
  const sourceUserMessageId =
    findRunSourceUserMessageId(originalEvents) ??
    (originalAssistantId
      ? findPreviousUserMessageId(
          input.msgRepo.listByConversation(originalAssistant?.conversation_id ?? ''),
          originalAssistantId,
        )
      : null);
  if (!sourceUserMessageId) {
    throw new TaoriError({
      code: 'conflict',
      message: `Run ${input.runId} has no user message to recover from`,
    });
  }
  const sourceUser = input.msgRepo.get(sourceUserMessageId);
  if (!sourceUser || sourceUser.role !== 'user') {
    throw new TaoriError({
      code: 'not_found',
      message: `Source user message ${sourceUserMessageId} not found`,
    });
  }
  const conversation = input.convRepo.get(sourceUser.conversation_id);
  if (!conversation) {
    throw new TaoriError({
      code: 'not_found',
      message: `Conversation ${sourceUser.conversation_id} not found`,
    });
  }

  const originalModelId =
    findRunModelId(originalEvents) ??
    originalAssistant?.model_id ??
    null;
  let modelId = originalModelId;
  if (action === 'switch_model') {
    modelId = input.request.model_id ?? null;
    if (!modelId && originalModelId) {
      const originalModel = input.modelsRepo.get(originalModelId);
      if (originalModel) {
        modelId = input.modelsRepo.nextFallback(
          originalModel.id,
          originalModel.capability as 'chat' | 'image' | 'embedding',
        )?.id ?? null;
      }
    }
  }
  if (!modelId) {
    throw new TaoriError({
      code: 'conflict',
      message: `No model available for recovery action ${action}`,
    });
  }
  const model = input.modelsRepo.get(modelId);
  if (!model || !model.enabled) {
    throw new TaoriError({
      code: 'conflict',
      message: `Recovery model ${modelId} is unavailable`,
    });
  }
  if (!isChatCapable(model.capability)) {
    throw new TaoriError({
      code: 'validation_error',
      message: `Recovery model ${modelId} is not chat-capable`,
      details: { capability: model.capability },
    });
  }

  const rows = input.msgRepo.listByConversation(conversation.id);
  const sourceIdx = rows.findIndex((row) => row.id === sourceUser.id);
  const rowsForContext = sourceIdx >= 0 ? rows.slice(0, sourceIdx + 1) : rows;
  const baseUpstreamMessages = rowsToUpstreamMessages(rowsForContext);
  const compacted = action === 'compact_context'
    ? buildCompactedRecoveryMessages(rowsForContext, sourceUserMessageId)
    : null;
  const upstreamMessages = compacted?.messages ?? baseUpstreamMessages;
  const recoveryMessages = action === 'skip_tool' && skipToolName
    ? [
        {
          role: 'system' as const,
          content: [
            `恢复策略：上一次调用工具 ${failedTool?.label ?? skipToolName} 失败。本轮必须跳过该工具，不要再次调用它。`,
            '请基于已有上下文继续回答；如果缺少该工具结果，请明确说明该工具结果不可用，并给出不依赖该工具的下一步。',
          ].join('\n'),
        },
        ...upstreamMessages,
      ]
    : upstreamMessages;

  return {
    action,
    failedTool,
    skipToolName,
    originalAssistantId,
    sourceUserMessageId,
    sourceUser,
    conversationId: conversation.id,
    model,
    provider: model.provider_id ? input.providersRepo.get(model.provider_id) : null,
    boundPersona: getBoundPersonaForConversation(input.memoriesRepo, input.personasRepo, conversation.id),
    compacted,
    recoveryMessages,
  };
}
