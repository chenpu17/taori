import type { ChatStreamAnnotation, ConversationMessage } from './api';

export function buildChatMessages(
  history: ConversationMessage[],
  nextUserContent: string,
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  return [
    ...history
      .filter((msg) =>
        (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system')
        && msg.status !== 'error'
        && msg.content.trim().length > 0,
      )
      .map((msg) => ({ role: msg.role, content: msg.content })),
    { role: 'user', content: nextUserContent },
  ];
}

export function applyStreamAnnotations(
  messages: ConversationMessage[],
  items: ChatStreamAnnotation[],
): ConversationMessage[] {
  if (messages.length === 0 || items.length === 0) return messages;
  const updated = [...messages];
  const lastAssistantIndex = [...updated].reverse().findIndex((msg) => msg.role === 'assistant');
  if (lastAssistantIndex < 0) return messages;
  const targetIndex = updated.length - 1 - lastAssistantIndex;
  const target = updated[targetIndex];
  if (!target) return messages;

  let next = target;
  for (const item of items) {
    const itemType = typeof item.type === 'string' ? item.type : null;
    if (
      itemType === 'meta'
      && 'conversation_id' in item
      && 'model_id' in item
      && 'message_id' in item
    ) {
      next = {
        ...next,
        id: typeof item.message_id === 'string' && item.message_id ? item.message_id : next.id,
        conversation_id:
          typeof item.conversation_id === 'string' && item.conversation_id
            ? item.conversation_id
            : next.conversation_id,
        model_id: typeof item.model_id === 'string' || item.model_id === null
          ? item.model_id
          : next.model_id,
      };
      continue;
    }
    if (
      itemType === 'cost'
      && 'message_id' in item
      && typeof item.message_id === 'string'
    ) {
      const annotations = [
        ...(next.annotations ?? []).filter((annotation) => annotation.type !== 'cost'),
        {
          type: 'cost' as const,
          message_id: item.message_id,
          input_tokens:
            'input_tokens' in item && typeof item.input_tokens === 'number' ? item.input_tokens : null,
          cache_input_tokens:
            'cache_input_tokens' in item && typeof item.cache_input_tokens === 'number'
              ? item.cache_input_tokens
              : null,
          output_tokens:
            'output_tokens' in item && typeof item.output_tokens === 'number' ? item.output_tokens : null,
          actual_usd:
            'actual_usd' in item && typeof item.actual_usd === 'number' ? item.actual_usd : null,
        },
      ];
      next = { ...next, annotations };
    }
  }

  updated[targetIndex] = next;
  return updated;
}
