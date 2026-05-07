import type { ConversationExportIncludeTimeline, RunEvent } from '@taori/shared';
import type { ConversationRow, CostRecord, MessageRow } from '../db/repos/index.js';

interface AttachmentSummary {
  kind: string;
  name: string | null;
  mime: string | null;
  file_id: string | null;
  size_bytes: number | null;
}

export interface ConversationMarkdownInput {
  conversation: ConversationRow;
  messages: MessageRow[];
  runEvents: RunEvent[];
  costs: CostRecord[];
  modelLabels: Map<string, string>;
  includeTimeline: ConversationExportIncludeTimeline;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString();
}

function roleLabel(role: MessageRow['role']): string {
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Assistant';
  return 'System';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseAttachments(raw: string | null): AttachmentSummary[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecord).map((item) => ({
    kind: stringValue(item.kind) ?? 'file',
    name: stringValue(item.name),
    mime: stringValue(item.mime),
    file_id: stringValue(item.file_id),
    size_bytes: numberValue(item.size_bytes),
  }));
}

function formatMoney(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return `$${value.toFixed(6)}`;
}

function summarizeCost(costs: CostRecord[]): string[] {
  if (costs.length === 0) return ['- Cost: $0.000000', '- Calls: 0'];
  const total = costs.reduce((sum, row) => sum + (row.actual_cost_usd ?? 0), 0);
  const inputTokens = costs.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0);
  const outputTokens = costs.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0);
  return [
    `- Cost: ${formatMoney(total)}`,
    `- Calls: ${costs.length}`,
    `- Tokens: ${inputTokens} input / ${outputTokens} output`,
  ];
}

function summarizeEvent(event: RunEvent): string | null {
  const payload = event.payload ?? {};
  if (event.kind === 'cost.recorded') {
    const actual = numberValue(payload.actual_cost_usd);
    const estimated = numberValue(payload.estimated_cost_usd);
    const model = stringValue(payload.model_name) ?? stringValue(payload.model_id) ?? 'model';
    const inputTokens = numberValue(payload.input_tokens);
    const outputTokens = numberValue(payload.output_tokens);
    const cost = actual != null ? actual : estimated;
    return `- ${event.kind} · ${model} · ${formatMoney(cost)} · ${inputTokens ?? 0}/${outputTokens ?? 0} tokens`;
  }
  if (event.kind === 'memory.used' || event.kind === 'memory.extracted') {
    const count = numberValue(payload.count) ?? numberValue(payload.memory_count);
    return `- ${event.kind} · ${count ?? 'n/a'} 条 · ${event.summary ?? event.label}`;
  }
  if (event.kind === 'context.file_chunks') {
    const chunks = Array.isArray(payload.chunks) ? payload.chunks.filter(isRecord) : [];
    const detail = chunks
      .slice(0, 6)
      .map((chunk) => {
        const fileId = stringValue(chunk.file_id) ?? 'file';
        const index = numberValue(chunk.chunk_index);
        const score = numberValue(chunk.score);
        return `${fileId}${index != null ? `#${index}` : ''}${score != null ? `(${score.toFixed(3)})` : ''}`;
      })
      .join(', ');
    return `- ${event.kind} · ${chunks.length} 个片段${detail ? ` · ${detail}` : ''}`;
  }
  if (event.kind === 'context.compacted') {
    const mode = stringValue(payload.mode) ?? 'compact';
    const sourceCount = numberValue(payload.source_message_count);
    const ratio = numberValue(payload.compression_ratio);
    return `- ${event.kind} · ${mode}${sourceCount != null ? ` · ${sourceCount} messages` : ''}${ratio != null ? ` · ratio ${ratio.toFixed(2)}` : ''}`;
  }
  return null;
}

function renderAttachments(attachments: AttachmentSummary[]): string[] {
  if (attachments.length === 0) return [];
  return [
    '',
    'Attachments:',
    ...attachments.map((item) => {
      const parts = [
        item.name ?? item.file_id ?? 'file',
        item.kind,
        item.mime,
        item.size_bytes != null ? `${item.size_bytes} bytes` : null,
        item.file_id ? `file_id=${item.file_id}` : null,
      ].filter(Boolean);
      return `- ${parts.join(' · ')}`;
    }),
  ];
}

export function safeConversationExportFilename(conversation: ConversationRow): string {
  const base = (conversation.title ?? conversation.id)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `taori-chat-${base || conversation.id}.md`;
}

export function renderConversationMarkdown(input: ConversationMarkdownInput): string {
  const lines: string[] = [];
  const title = input.conversation.title ?? '未命名会话';
  const sortedMessages = [...input.messages].sort((a, b) => a.created_at - b.created_at);
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`- Conversation: \`${input.conversation.id}\``);
  lines.push(`- Exported at: ${formatDate(Date.now())}`);
  lines.push(`- Messages: ${sortedMessages.length}`);
  lines.push(...summarizeCost(input.costs));
  lines.push('');

  if (input.includeTimeline === 'summary') {
    const summaries = input.runEvents
      .map(summarizeEvent)
      .filter((line): line is string => Boolean(line));
    if (summaries.length > 0) {
      lines.push('## Timeline 摘要');
      lines.push('');
      lines.push(...summaries.slice(0, 80));
      lines.push('');
    }
  }

  lines.push('## Messages');
  for (const message of sortedMessages) {
    const modelLabel = message.model_id ? input.modelLabels.get(message.model_id) : null;
    lines.push('');
    lines.push(`### ${roleLabel(message.role)}${modelLabel ? ` · ${modelLabel}` : ''} · ${formatDate(message.created_at)}`);
    if (message.status !== 'complete') {
      lines.push('');
      lines.push(`_Status: ${message.status}_`);
    }
    if (message.error) {
      lines.push('');
      lines.push(`_Error: ${message.error}_`);
    }
    lines.push(...renderAttachments(parseAttachments(message.attachments)));
    lines.push('');
    lines.push(message.content?.trim() || '（空消息）');
  }
  lines.push('');
  return lines.join('\n');
}
