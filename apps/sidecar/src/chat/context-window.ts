import { countMessageTokens, countMessagesTokens } from '@taori/shared';

export interface ContextWindowStats {
  original_message_count: number;
  sent_message_count: number;
  omitted_message_count: number;
  estimated_input_tokens: number;
  budget_tokens: number | null;
  model_context_length: number | null;
  strategy: 'full' | 'sliding_window';
}

function contextBudgetTokens(contextLength: number | null): number | null {
  if (!contextLength || contextLength <= 0) return null;
  return Math.max(512, Math.floor(contextLength * 0.82));
}

export function applyContextWindow(messages: any[], contextLength: number | null): {
  messages: any[];
  stats: ContextWindowStats;
} {
  const budget = contextBudgetTokens(contextLength);
  const originalTokens = countMessagesTokens(messages);
  if (!budget || originalTokens <= budget) {
    return {
      messages,
      stats: {
        original_message_count: messages.length,
        sent_message_count: messages.length,
        omitted_message_count: 0,
        estimated_input_tokens: originalTokens,
        budget_tokens: budget,
        model_context_length: contextLength,
        strategy: 'full',
      },
    };
  }

  const systemMessages = messages.filter((message) => message.role === 'system');
  const nonSystemMessages = messages.filter((message) => message.role !== 'system');
  const kept: any[] = [];
  let tokens = countMessagesTokens(systemMessages);
  for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
    const message = nonSystemMessages[i]!;
    const cost = countMessageTokens(message);
    if (kept.length > 0 && tokens + cost > budget) break;
    kept.unshift(message);
    tokens += cost;
  }

  if (kept.length === 0 && nonSystemMessages.length > 0) {
    const last = nonSystemMessages.at(-1)!;
    kept.push(last);
    tokens += countMessageTokens(last);
  }

  const windowed = [...systemMessages, ...kept];
  const omitted = Math.max(0, messages.length - windowed.length);
  if (omitted > 0) {
    const notice = {
      role: 'system',
      content: `上下文窗口管理：为避免超过模型上下文限制，已省略较早的 ${omitted} 条历史消息；请优先依据当前可见上下文回答。`,
    };
    const withNotice = [...systemMessages, notice, ...kept];
    return {
      messages: withNotice,
      stats: {
        original_message_count: messages.length,
        sent_message_count: withNotice.length,
        omitted_message_count: omitted,
        estimated_input_tokens: countMessagesTokens(withNotice),
        budget_tokens: budget,
        model_context_length: contextLength,
        strategy: 'sliding_window',
      },
    };
  }

  return {
    messages: windowed,
    stats: {
      original_message_count: messages.length,
      sent_message_count: windowed.length,
      omitted_message_count: omitted,
      estimated_input_tokens: tokens,
      budget_tokens: budget,
      model_context_length: contextLength,
      strategy: 'sliding_window',
    },
  };
}
