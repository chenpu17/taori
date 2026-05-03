import { z } from 'zod';
import { ToolSchema } from './tools.js';

export const EffectiveToolSchema = ToolSchema.extend({
  session_enabled: z.boolean().nullable(),
  effective_enabled: z.boolean(),
});
export type EffectiveTool = z.infer<typeof EffectiveToolSchema>;

export const ContextSourceSchema = z.object({
  type: z.enum(['persona', 'attachment', 'tool_policy', 'memory', 'model']),
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

export const RunEventKindSchema = z.enum([
  'turn.started',
  'context.snapshot',
  'model.started',
  'model.completed',
  'model.failed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'cost.recorded',
  'capability.routed',
  'turn.completed',
  'turn.cancelled',
  'turn.failed',
]);
export type RunEventKind = z.infer<typeof RunEventKindSchema>;

export const RunEventStatusSchema = z.enum([
  'started',
  'progress',
  'completed',
  'failed',
  'cancelled',
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

export const RunTimelineResponseSchema = z.object({
  ok: z.boolean(),
  data: z.object({
    conversation_id: z.string(),
    events: z.array(RunEventSchema),
  }),
});
export type RunTimelineResponse = z.infer<typeof RunTimelineResponseSchema>;
