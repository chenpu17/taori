import type { OrchestrationAnnotation } from '@taori/shared';
import type { OrchestrationPlan } from './context-router.js';

export function buildOrchestrationAnnotation(
  plan: OrchestrationPlan,
  ids: {
    messageId?: string | null;
    conversationId?: string | null;
    runId?: string | null;
  } = {},
): OrchestrationAnnotation {
  return {
    type: 'orchestration',
    message_id: ids.messageId ?? null,
    conversation_id: ids.conversationId ?? null,
    run_id: ids.runId ?? null,
    reason: plan.reason,
    external_info: plan.externalInfo,
    local_context: plan.localContext,
    search_tool_name: plan.searchToolName,
    query_count: plan.queries.length,
    fetch_top_k: plan.fetchTopK,
    cite_required: plan.citeRequired,
    allow_model_tool_use: plan.allowModelToolUse,
  };
}
