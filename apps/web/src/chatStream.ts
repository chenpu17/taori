import type { ChatStreamAnnotation, ConversationMessage } from './api';

export function buildChatMessages(
  history: ConversationMessage[],
  nextUserContent: string,
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> {
  return [
    ...history
      .filter(
        (message) =>
          (message.role === 'user' || message.role === 'assistant' || message.role === 'system') &&
          message.content.trim().length > 0 &&
          message.status !== 'failed',
      )
      .map((message) => ({
        role: message.role,
        content: message.content,
      })),
    { role: 'user', content: nextUserContent },
  ];
}

export interface AppliedAnnotations {
  messages: ConversationMessage[];
  conversationId: string | null;
  runId: string | null;
  failure: string | null;
  targetMessageId: string | null;
}

const FAILURE_COPY: Record<string, string> = {
  auth: '这个服务商的密钥没通过验证',
  key_missing: '还没给这个模型配置 API Key',
  rate_limit: '服务商当前限流了，稍后或换个模型会更顺',
  quota: '这个服务商的额度用完了',
  network: '连接服务商时网络出了点问题',
  config_error: '这个模型的配置需要检查一下',
  content_filter: '内容被服务商的安全策略拦下了',
  unknown: '这条回复中途断了',
};

/** Turn a raw failure classification into a calm, human sentence. */
export function friendlyFailure(classification: string, detail?: string | null): string {
  const base = FAILURE_COPY[classification] ?? FAILURE_COPY.unknown;
  const trimmed = detail?.trim();
  return trimmed ? `${base}（${trimmed}）` : base;
}

export function applyChatAnnotations(
  messages: ConversationMessage[],
  annotations: ChatStreamAnnotation[],
  targetMessageId?: string | null,
): AppliedAnnotations {
  if (messages.length === 0 || annotations.length === 0) {
    return { messages, conversationId: null, runId: null, failure: null, targetMessageId: null };
  }
  const nextMessages = [...messages];
  const explicitIndex = targetMessageId
    ? nextMessages.findIndex((message) => message.id === targetMessageId)
    : -1;
  const reverseIndex = explicitIndex < 0
    ? [...nextMessages].reverse().findIndex((message) => message.role === 'assistant')
    : -1;
  if (explicitIndex < 0 && reverseIndex < 0) {
    return { messages, conversationId: null, runId: null, failure: null, targetMessageId: null };
  }
  const targetIndex = explicitIndex >= 0 ? explicitIndex : nextMessages.length - 1 - reverseIndex;
  let target = nextMessages[targetIndex];
  if (!target) return { messages, conversationId: null, runId: null, failure: null, targetMessageId: null };

  let conversationId: string | null = null;
  let runId: string | null = null;
  let failure: string | null = null;

  for (const annotation of annotations) {
    const type = typeof annotation.type === 'string' ? annotation.type : '';
    if (type === 'meta') {
      const meta = annotation as Extract<ChatStreamAnnotation, { type: 'meta' }>;
      conversationId = meta.conversation_id;
      runId = meta.run_id;
      target = {
        ...target,
        id: meta.message_id ?? target.id,
        conversation_id: meta.conversation_id,
        model_id: meta.model_id,
        annotations: [
          ...(target.annotations ?? []).filter((item) => item.type !== 'meta'),
          {
            type: 'meta',
            message_id: meta.message_id ?? undefined,
            run_id: meta.run_id,
          },
        ],
      };
    } else if (type === 'cost') {
      const cost = annotation as Extract<ChatStreamAnnotation, { type: 'cost' }>;
      target = {
        ...target,
        annotations: [
          ...(target.annotations ?? []).filter((item) => item.type !== 'cost'),
          {
            type: 'cost',
            message_id: cost.message_id,
            input_tokens: cost.input_tokens ?? null,
            cache_input_tokens: cost.cache_input_tokens ?? null,
            output_tokens: cost.output_tokens ?? null,
            actual_usd: cost.actual_usd ?? null,
            first_token_ms: cost.first_token_ms ?? null,
            duration_ms: cost.duration_ms ?? null,
          },
        ],
      };
    } else if (type === 'failure_decision') {
      const decision = annotation as Extract<ChatStreamAnnotation, { type: 'failure_decision' }>;
      failure = friendlyFailure(decision.classification, decision.detail);
    } else if (type === 'capability_route') {
      const route = annotation as Extract<ChatStreamAnnotation, { type: 'capability_route' }>;
      conversationId = route.conversation_id;
      target = {
        ...target,
        conversation_id: route.conversation_id,
        content: capabilityRouteText(route),
      };
    } else if (type === 'tool_trace') {
      const trace = annotation as Extract<ChatStreamAnnotation, { type: 'tool_trace' }>;
      target = {
        ...target,
        annotations: [
          ...(target.annotations ?? []).filter(
            (item) => !(item.type === 'tool_trace' && item.call_id === trace.call_id),
          ),
          {
            type: 'tool_trace',
            message_id: trace.message_id,
            event: trace.event,
            call_id: trace.call_id,
            tool: trace.tool,
            label: trace.label,
            input: trace.input ?? null,
            output: trace.output ?? null,
            ok: trace.ok ?? null,
            duration_ms: trace.duration_ms ?? null,
          },
        ],
      };
    } else if (type === 'orchestration') {
      const plan = annotation as Extract<ChatStreamAnnotation, { type: 'orchestration' }>;
      target = {
        ...target,
        annotations: [
          ...(target.annotations ?? []).filter((item) => item.type !== 'orchestration'),
          {
            type: 'orchestration',
            message_id: plan.message_id ?? target.id,
            run_id: plan.run_id ?? undefined,
            reason: plan.reason,
            external_info: plan.external_info,
            local_context: plan.local_context,
            search_tool_name: plan.search_tool_name,
            query_count: plan.query_count,
            fetch_top_k: plan.fetch_top_k,
            cite_required: plan.cite_required,
            allow_model_tool_use: plan.allow_model_tool_use,
          },
        ],
      };
    }
  }
  nextMessages[targetIndex] = target;
  return { messages: nextMessages, conversationId, runId, failure, targetMessageId: target.id };
}

function capabilityRouteText(
  route: Extract<ChatStreamAnnotation, { type: 'capability_route' }>,
): string {
  if (route.capability === 'image') {
    return [
      '已识别为图片生成请求。',
      '',
      `提示词：${route.prompt}`,
      '',
      '请在图像生成面板选择可用图像模型后继续生成。',
    ].join('\n');
  }
  return `已路由到 ${route.capability} 能力：${route.prompt}`;
}

export function makeLocalMessage(
  role: 'user' | 'assistant' | 'system',
  content: string,
  conversationId: string,
  status = 'completed',
): ConversationMessage {
  return {
    id: `local_${role}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    conversation_id: conversationId,
    role,
    content,
    model_id: null,
    status,
    error: null,
    created_at: Date.now(),
    attachments_count: 0,
    annotations: [],
  };
}
