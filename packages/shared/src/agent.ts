import { z } from 'zod';
import { ToolSchema } from './tools.js';

export const EffectiveToolSchema = ToolSchema.extend({
  session_enabled: z.boolean().nullable(),
  effective_enabled: z.boolean(),
});
export type EffectiveTool = z.infer<typeof EffectiveToolSchema>;

export const ContextSourceSchema = z.object({
  type: z.enum(['persona', 'attachment', 'tool_policy', 'memory', 'model', 'file_chunk']),
  label: z.string(),
  scope: z.enum(['request', 'session', 'global', 'default']),
  active: z.boolean(),
});
export type ContextSource = z.infer<typeof ContextSourceSchema>;

export const ContextSnapshotAnnotationSchema = z.object({
  type: z.literal('context_snapshot'),
  message_id: z.string(),
  conversation_id: z.string(),
  model_id: z.string().nullable(),
  active_tool_names: z.array(z.string()),
  disabled_tool_names: z.array(z.string()),
  context_sources: z.array(ContextSourceSchema),
  context_window: z.object({
    original_message_count: z.number().int().nonnegative(),
    sent_message_count: z.number().int().nonnegative(),
    omitted_message_count: z.number().int().nonnegative(),
    estimated_input_tokens: z.number().int().nonnegative(),
    budget_tokens: z.number().int().positive().nullable(),
    model_context_length: z.number().int().positive().nullable(),
    strategy: z.enum(['full', 'sliding_window']),
  }).nullable().optional(),
});
export type ContextSnapshotAnnotation = z.infer<typeof ContextSnapshotAnnotationSchema>;

export const ConversationProfileSchema = z.object({
  conversation_id: z.string(),
  title: z.string().nullable(),
  active_model_id: z.string().nullable(),
  active_model_label: z.string().nullable(),
  active_persona_id: z.string().nullable(),
  active_persona_name: z.string().nullable(),
  effective_tools: z.array(EffectiveToolSchema),
  context_sources: z.array(ContextSourceSchema),
  cost: z.object({
    current_conversation_usd: z.number(),
    current_conversation_calls: z.number(),
  }),
});
export type ConversationProfile = z.infer<typeof ConversationProfileSchema>;

export const AgentRunStatusSchema = z.enum([
  'created',
  'context_ready',
  'streaming',
  'tool_calling',
  'waiting_user_confirm',
  'stopped',
  'incomplete',
  'retrying',
  'failed',
  'completed',
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentRunKindSchema = z.enum([
  'chat',
  'continue',
  'retry',
  'tool_recovery',
  'roundtable',
  'quick_compare',
]);
export type AgentRunKind = z.infer<typeof AgentRunKindSchema>;

export const RunEventKindSchema = z.enum([
  'turn.started',
  'context.snapshot',
  'context.file_chunks',
  'context.compacted',
  'file.search',
  'model.started',
  'model.completed',
  'model.failed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'cost.recorded',
  'cost.failed',
  'memory.extracted',
  'memory.used',
  'capability.routed',
  'turn.stopped',
  'turn.incomplete',
  'turn.completed',
  'turn.cancelled',
  'turn.failed',
  'recovery.suggested',
  'recovery.started',
  'recovery.completed',
  'recovery.failed',
  'quick_compare.started',
  'quick_compare.participant_started',
  'quick_compare.participant_completed',
  'quick_compare.participant_failed',
  'quick_compare.adopted',
  'quick_compare.completed',
]);
export type RunEventKind = z.infer<typeof RunEventKindSchema>;

export const RunEventStatusSchema = z.enum([
  'started',
  'progress',
  'completed',
  'failed',
  'cancelled',
  'stopped',
  'incomplete',
  'retrying',
]);
export type RunEventStatus = z.infer<typeof RunEventStatusSchema>;

export const RunEventSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  conversation_id: z.string().nullable(),
  message_id: z.string().nullable(),
  kind: RunEventKindSchema,
  status: RunEventStatusSchema,
  label: z.string(),
  summary: z.string().nullable(),
  payload: z.record(z.unknown()).nullable(),
  created_at: z.number(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RecoveryActionSchema = z.object({
  type: z.enum([
    'continue',
    'retry_same_model',
    'switch_model',
    'skip_tool',
    'compact_context',
  ]),
  label: z.string(),
  summary: z.string().nullable().optional(),
  run_id: z.string(),
  conversation_id: z.string().nullable(),
  message_id: z.string().nullable(),
  recommended_model_id: z.string().nullable().optional(),
  tool_name: z.string().nullable().optional(),
  tool_label: z.string().nullable().optional(),
  estimated_cost_usd: z.number().nullable().optional(),
  requires_confirmation: z.boolean().default(true),
});
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

export const RecoverRunRequestSchema = z.object({
  action: z.enum([
    'continue',
    'retry_same_model',
    'switch_model',
    'skip_tool',
    'compact_context',
  ]),
  model_id: z.string().min(1).nullable().optional(),
  tool_name: z.string().min(1).nullable().optional(),
  confirmed_cost: z.boolean().optional(),
});
export type RecoverRunRequest = z.infer<typeof RecoverRunRequestSchema>;

export const ContinueRunRequestSchema = z.object({
  confirmed_cost: z.boolean().optional(),
}).optional();
export type ContinueRunRequest = z.infer<typeof ContinueRunRequestSchema>;

export const ChatMetaAnnotationSchema = z.object({
  type: z.literal('meta'),
  conversation_id: z.string(),
  message_id: z.string().nullable(),
  model_id: z.string().nullable(),
  run_id: z.string(),
});
export type ChatMetaAnnotation = z.infer<typeof ChatMetaAnnotationSchema>;

export const RunResumeMessageStatusSchema = z.enum([
  'pending',
  'streaming',
  'complete',
  'completed',
  'incomplete',
  'failed',
]);
export type RunResumeMessageStatus = z.infer<typeof RunResumeMessageStatusSchema>;

export const RunResumeStateSchema = z.object({
  run_id: z.string(),
  conversation_id: z.string().nullable(),
  assistant_message_id: z.string().nullable(),
  message_status: RunResumeMessageStatusSchema.nullable(),
  can_continue: z.boolean(),
  recommended_action: z.enum(['continue', 'retry', 'switch_model', 'none']),
  reason: z.string().nullable(),
});
export type RunResumeState = z.infer<typeof RunResumeStateSchema>;

export const RunResumeStateResponseSchema = z.object({
  ok: z.literal(true),
  data: RunResumeStateSchema,
});
export type RunResumeStateResponse = z.infer<typeof RunResumeStateResponseSchema>;

export const CostConfirmationRequiredDetailsSchema = z.object({
  reason: z.enum(['threshold', 'budget']),
  /**
   * For `reason === 'budget'` only: which period the breach is on.
   * - `'month'`: monthly_budget_usd would be exceeded
   * - `'day'`: daily_budget_usd would be exceeded
   * Older clients that don't read this field still get reason='budget'.
   */
  period: z.enum(['month', 'day']).optional(),
  estimate_usd: z.number(),
  model_id: z.string(),
  model_name: z.string(),
  conversation_id: z.string().nullable(),
  threshold_usd: z.number().nullable().optional(),
  monthly_budget_usd: z.number().nullable().optional(),
  month_spent_usd: z.number().nullable().optional(),
  daily_budget_usd: z.number().nullable().optional(),
  day_spent_usd: z.number().nullable().optional(),
  hard_limit: z.boolean().optional(),
  blocked: z.boolean().optional(),
});
export type CostConfirmationRequiredDetails = z.infer<
  typeof CostConfirmationRequiredDetailsSchema
>;

export const AgentRunSchema = z.object({
  id: z.string(),
  conversation_id: z.string().nullable(),
  parent_run_id: z.string().nullable(),
  user_message_id: z.string().nullable(),
  assistant_message_id: z.string().nullable(),
  kind: AgentRunKindSchema,
  status: AgentRunStatusSchema,
  model_id: z.string().nullable(),
  recovery_policy: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  event_count: z.number().int().nonnegative(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const RunTimelineResponseSchema = z.object({
  ok: z.boolean(),
  data: z.object({
    conversation_id: z.string(),
    events: z.array(RunEventSchema),
  }),
});
export type RunTimelineResponse = z.infer<typeof RunTimelineResponseSchema>;

export const AgentRunsResponseSchema = z.object({
  ok: z.boolean(),
  data: z.object({
    conversation_id: z.string(),
    runs: z.array(AgentRunSchema),
  }),
});
export type AgentRunsResponse = z.infer<typeof AgentRunsResponseSchema>;
