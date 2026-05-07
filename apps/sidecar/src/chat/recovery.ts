import type { RunEvent } from '@taori/shared';
import type { MessageRow } from '../db/repos/index.js';

function runPayloadString(event: { payload: Record<string, unknown> | null }, key: string): string | null {
  const value = event.payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function findRunAssistantMessageId(events: RunEvent[]): string | null {
  for (const event of [...events].reverse()) {
    const fromPayload = runPayloadString(event, 'assistant_message_id');
    if (fromPayload) return fromPayload;
    if (event.message_id) return event.message_id;
  }
  return null;
}

export function findRunSourceUserMessageId(events: RunEvent[]): string | null {
  for (const event of [...events].reverse()) {
    const fromPayload = runPayloadString(event, 'source_user_message_id');
    if (fromPayload) return fromPayload;
  }
  return null;
}

export function findRunModelId(events: RunEvent[]): string | null {
  for (const event of [...events].reverse()) {
    const fromPayload = runPayloadString(event, 'model_id');
    if (fromPayload) return fromPayload;
  }
  return null;
}

export function findLastFailedTool(events: RunEvent[]): {
  name: string;
  label: string;
} | null {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'tool.failed') continue;
    const tool = runPayloadString(event, 'tool');
    if (!tool) continue;
    return {
      name: tool,
      label: event.label || tool,
    };
  }
  return null;
}

export function findPreviousUserMessageId(rows: MessageRow[], beforeMessageId: string): string | null {
  const idx = rows.findIndex((row) => row.id === beforeMessageId);
  const searchRows = idx >= 0 ? rows.slice(0, idx) : rows;
  return [...searchRows].reverse().find((row) => row.role === 'user')?.id ?? null;
}

function compactLine(row: MessageRow): string {
  const role = row.role === 'assistant' ? 'assistant' : row.role === 'system' ? 'system' : 'user';
  const text = (row.content ?? '').replace(/\s+/g, ' ').trim();
  return `${role}: ${text.slice(0, 260) || '（空内容）'}`;
}

export function buildCompactedRecoveryMessages(
  rowsForContext: MessageRow[],
  sourceUserMessageId: string,
): {
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
  compacted_message_count: number;
  summary_chars: number;
} {
  const sourceIdx = rowsForContext.findIndex((row) => row.id === sourceUserMessageId);
  const beforeSource = sourceIdx > 0 ? rowsForContext.slice(0, sourceIdx) : [];
  const sourceAndAfter = sourceIdx >= 0 ? rowsForContext.slice(sourceIdx) : rowsForContext.slice(-1);
  const compacted = beforeSource.filter(
    (row) => row.role === 'user' || row.role === 'assistant' || row.role === 'system',
  );
  const recent = sourceAndAfter
    .filter((row) => row.role === 'user' || row.role === 'assistant' || row.role === 'system')
    .map((row) => ({
      role: row.role as 'user' | 'assistant' | 'system',
      content: row.content ?? '',
    }));
  if (compacted.length === 0) {
    return {
      messages: recent,
      compacted_message_count: 0,
      summary_chars: 0,
    };
  }
  const lines = compacted.slice(-24).map(compactLine);
  const omittedOlder = Math.max(0, compacted.length - lines.length);
  const summary = [
    '上下文压缩摘要：以下是较早历史的确定性摘要，用于恢复失败请求；它不是新用户指令。',
    omittedOlder > 0 ? `更早还有 ${omittedOlder} 条消息已省略。` : null,
    ...lines,
  ].filter(Boolean).join('\n');
  return {
    messages: [
      {
        role: 'system',
        content: summary,
      },
      ...recent,
    ],
    compacted_message_count: compacted.length,
    summary_chars: summary.length,
  };
}
