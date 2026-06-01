import { z } from 'zod';
import {
  ChatAttachmentSchema,
  ChatMessageSchema,
  ErrorClassificationSchema,
} from './schemas.js';
import { OrchestrationAnnotationSchema } from './agent.js';

export const QuickCompareStatusSchema = z.enum([
  'running',
  'completed',
  'partial_failed',
  'failed',
  'cancelled',
]);
export type QuickCompareStatus = z.infer<typeof QuickCompareStatusSchema>;

export const QuickCompareOutputStatusSchema = z.enum([
  'pending',
  'streaming',
  'complete',
  'failed',
  'cancelled',
]);
export type QuickCompareOutputStatus = z.infer<typeof QuickCompareOutputStatusSchema>;

export const QuickCompareExecutionModeSchema = z.enum([
  'live',
  'local_preview',
]);
export type QuickCompareExecutionMode = z.infer<typeof QuickCompareExecutionModeSchema>;

export const QuickComparePreviewReasonSchema = z.enum([
  'provider_missing',
  'api_key_missing',
  'keystore_read_failed',
]);
export type QuickComparePreviewReason = z.infer<typeof QuickComparePreviewReasonSchema>;

export const QuickCompareRequestSchema = z.object({
  conversation_id: z.string().optional(),
  messages: z.array(ChatMessageSchema).min(1),
  model_ids: z.array(z.string().min(1)).min(2).max(3).optional(),
  participant_configs: z.array(
    z.object({
      model_id: z.string().min(1),
      tool_names: z.array(z.string().min(1)).max(64).optional(),
    }),
  ).min(2).max(3).optional(),
  attachments: z.array(ChatAttachmentSchema).max(8, '最多同时上传 8 个附件').optional(),
  persona_id: z.string().min(1).nullable().optional(),
  confirmed_cost: z.boolean().optional(),
});
export type QuickCompareRequest = z.infer<typeof QuickCompareRequestSchema>;

export const QuickCompareRunSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  source_user_message_id: z.string().nullable(),
  run_id: z.string(),
  status: QuickCompareStatusSchema,
  model_ids: z.array(z.string()),
  adopted_output_id: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type QuickCompareRun = z.infer<typeof QuickCompareRunSchema>;

export const QuickCompareOutputSchema = z.object({
  id: z.string(),
  compare_id: z.string(),
  participant_index: z.number().int().nonnegative(),
  model_id: z.string(),
  provider_id: z.string().nullable(),
  tool_names: z.array(z.string()),
  content: z.string(),
  status: QuickCompareOutputStatusSchema,
  error_classification: ErrorClassificationSchema.nullable(),
  error_message: z.string().nullable(),
  cost_record_id: z.string().nullable(),
  first_token_ms: z.number().int().nonnegative().nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type QuickCompareOutput = z.infer<typeof QuickCompareOutputSchema>;

export const QuickCompareAnnotationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('qc.meta'),
    compare_id: z.string(),
    conversation_id: z.string(),
    run_id: z.string(),
    model_ids: z.array(z.string()),
  }),
  OrchestrationAnnotationSchema.extend({
    type: z.literal('qc.orchestration'),
    compare_id: z.string(),
    output_id: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal('qc.participant_start'),
    output_id: z.string(),
    index: z.number().int().nonnegative(),
    model_id: z.string(),
    provider_id: z.string().nullable().optional(),
    execution_mode: QuickCompareExecutionModeSchema.optional(),
    preview_reason: QuickComparePreviewReasonSchema.nullable().optional(),
    tool_names: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('qc.participant_delta'),
    output_id: z.string(),
    index: z.number().int().nonnegative(),
    model_id: z.string(),
    text_chunk: z.string(),
  }),
  z.object({
    type: z.literal('qc.participant_done'),
    output_id: z.string(),
    index: z.number().int().nonnegative(),
    model_id: z.string(),
    content: z.string(),
    cost_record_id: z.string().nullable(),
    first_token_ms: z.number().int().nonnegative().nullable().optional(),
    duration_ms: z.number().int().nonnegative().nullable().optional(),
    execution_mode: QuickCompareExecutionModeSchema.optional(),
    preview_reason: QuickComparePreviewReasonSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal('qc.participant_failed'),
    output_id: z.string(),
    index: z.number().int().nonnegative(),
    model_id: z.string(),
    classification: ErrorClassificationSchema,
    message: z.string(),
  }),
  z.object({
    type: z.literal('qc.tool_trace'),
    output_id: z.string(),
    index: z.number().int().nonnegative(),
    model_id: z.string(),
    call_id: z.string(),
    tool: z.string(),
    label: z.string(),
    event: z.enum(['start', 'finish']),
    input: z.string().optional(),
    output: z.string().optional(),
    ok: z.boolean().optional(),
    duration_ms: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('qc.done'),
    compare_id: z.string(),
    completed_output_ids: z.array(z.string()),
    failed_output_ids: z.array(z.string()),
  }),
]);
export type QuickCompareAnnotation = z.infer<typeof QuickCompareAnnotationSchema>;

export const QuickCompareAdoptRequestSchema = z.object({
  replace_message_id: z.string().min(1).nullable().optional(),
});
export type QuickCompareAdoptRequest = z.infer<typeof QuickCompareAdoptRequestSchema>;

export const QuickCompareAdoptResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    compare_id: z.string(),
    output_id: z.string(),
    conversation_id: z.string(),
    assistant_message_id: z.string(),
  }),
});
export type QuickCompareAdoptResponse = z.infer<typeof QuickCompareAdoptResponseSchema>;

export const QuickCompareDetailResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    compare: QuickCompareRunSchema,
    outputs: z.array(QuickCompareOutputSchema),
  }),
});
export type QuickCompareDetailResponse = z.infer<typeof QuickCompareDetailResponseSchema>;

export const QuickCompareRetryRequestSchema = z.object({
  output_id: z.string().min(1).optional(),
  model_id: z.string().min(1).optional(),
  confirmed_cost: z.boolean().optional(),
});
export type QuickCompareRetryRequest = z.infer<typeof QuickCompareRetryRequestSchema>;
