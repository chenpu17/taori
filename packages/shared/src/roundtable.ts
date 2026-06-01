/**
 * Roundtable (M3.A) — shared types & Zod schemas.
 *
 * The data model intentionally lives in @taori/shared so renderer + sidecar
 * agree on participant/summary JSON shapes without dragging in drizzle.
 */

import { z } from 'zod';
import type { OrchestrationAnnotation } from './agent.js';
import { PromptTemplateSchema } from './schemas.js';

export const RoundtableModeSchema = z.enum(['fast', 'deep', 'auto']);
export type RoundtableMode = z.infer<typeof RoundtableModeSchema>;

export const RoundtableStoredModeSchema = z.enum(['fast', 'deep']);
export type RoundtableStoredMode = z.infer<typeof RoundtableStoredModeSchema>;

export const RoundtableStatusSchema = z.enum([
  'analyzing',
  'round1',
  'round2',
  'summarizing',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type RoundtableStatus = z.infer<typeof RoundtableStatusSchema>;

export const ParticipantSchema = z.object({
  model_id: z.string(),
  display_name: z.string(),
  role_label: z.string().min(1).max(40),
  persona_prompt: z.string().min(8).max(2000),
});
export type Participant = z.infer<typeof ParticipantSchema>;

/** Strict shape Topic Analyzer must return. */
export const AnalyzerOutputSchema = z.object({
  topic_type: z.enum([
    'business',
    'technical',
    'creative',
    'decision',
    'research',
    'other',
  ]),
  complexity: z.enum(['low', 'medium', 'high']),
  suggested_mode: RoundtableStoredModeSchema,
  participant_count: z.number().int().min(2).max(4),
  participants: z.array(ParticipantSchema).min(2).max(4),
  summarizer_model_id: z.string(),
});
export type AnalyzerOutput = z.infer<typeof AnalyzerOutputSchema>;

export const SummarySchema = z
  .object({
    consensus: z.array(z.string()),
    divergence: z.array(
      z.object({
        topic: z.string(),
        positions: z.array(
          z.object({ role: z.string(), stance: z.string() }),
        ),
      }),
    ),
    risks: z.array(z.string()),
    recommended_decision: z.string(),
    next_steps: z.array(z.string()),
  })
  .strict();
export type RoundtableSummary = z.infer<typeof SummarySchema>;

export const SummaryStorageSchema = z.union([
  SummarySchema,
  z.object({ fallback: z.literal(true), raw_text: z.string() }).strict(),
]);
export type SummaryStorage = z.infer<typeof SummaryStorageSchema>;

export const CreateRoundtableRequestSchema = z.object({
  conversation_id: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  /** A4 — chat conversation the user came from; the loopback handler writes
   *  the final summary back into this conversation. Optional: when omitted,
   *  loopback mints a fresh chat conversation on demand. */
  origin_conversation_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  topic: z.string().trim().min(1).max(2000),
  mode: RoundtableModeSchema.optional(),
  analyzer_model_id: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  summarizer_model_id: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
});
export type CreateRoundtableRequest = z.infer<
  typeof CreateRoundtableRequestSchema
>;

/**
 * A5 — fields surfaced to the launch dialog so users can:
 *   1. See *why* the analyzer chose this mode (topic_type + complexity)
 *   2. Compare fast vs deep cost ranges side-by-side
 *
 * `topic_type` / `complexity` may be null when analyzer fell back to fixed
 * personas (we don't have that signal). `analyzer_chose_mode_reason` is a
 * short human-readable Chinese sentence built server-side; renderer just
 * displays it.
 */
export const RoundtableTopicTypeSchema = z.enum([
  'business',
  'technical',
  'creative',
  'decision',
  'research',
  'other',
]);
export type RoundtableTopicType = z.infer<typeof RoundtableTopicTypeSchema>;

export const RoundtableComplexitySchema = z.enum(['low', 'medium', 'high']);
export type RoundtableComplexity = z.infer<typeof RoundtableComplexitySchema>;

export const RoundtableLaunchPreviewSchema = z.object({
  topic_type: RoundtableTopicTypeSchema.nullable(),
  complexity: RoundtableComplexitySchema.nullable(),
  /** What the user requested ('auto'/'fast'/'deep'). */
  requested_mode: RoundtableModeSchema,
  /** Human-readable reason in Chinese, built server-side. */
  analyzer_chose_mode_reason: z.string().nullable(),
  /** Estimated total calls for the chosen mode (analyzer + participants × rounds + summarizer). */
  estimated_calls: z.number().int().nonnegative(),
  /** Estimated wall-clock duration range in seconds for the chosen mode. */
  estimated_duration_sec_low: z.number().nonnegative(),
  estimated_duration_sec_high: z.number().nonnegative(),
  /** Cost & duration estimate for the OTHER mode (so renderer can show comparison). */
  alt_mode: RoundtableStoredModeSchema,
  alt_estimated_cost_usd_low: z.number().nullable(),
  alt_estimated_cost_usd_high: z.number().nullable(),
  alt_estimated_calls: z.number().int().nonnegative(),
  alt_estimated_duration_sec_low: z.number().nonnegative(),
  alt_estimated_duration_sec_high: z.number().nonnegative(),
});
export type RoundtableLaunchPreview = z.infer<
  typeof RoundtableLaunchPreviewSchema
>;

export const RoundtableSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  topic: z.string(),
  mode: RoundtableStoredModeSchema,
  participants: z.array(ParticipantSchema),
  summarizer_model_id: z.string().nullable(),
  analyzer_fallback: z.boolean(),
  status: RoundtableStatusSchema,
  current_round: z.number().int(),
  summary: SummaryStorageSchema.nullable(),
  estimated_cost_usd_low: z.number().nullable(),
  estimated_cost_usd_high: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  completed_at: z.number().nullable(),
});
export type Roundtable = z.infer<typeof RoundtableSchema>;

export const RoundtableHistoryEntrySchema = z.object({
  id: z.string(),
  topic: z.string(),
  mode: RoundtableStoredModeSchema,
  created_at: z.number().int(),
  recommended_decision: z.string().nullable(),
  consensus: z.array(z.string()),
  risks: z.array(z.string()),
  divergence_topics: z.array(z.string()),
});
export type RoundtableHistoryEntry = z.infer<typeof RoundtableHistoryEntrySchema>;

export const RoundtableHistoryResponseSchema = z.object({
  roundtable_id: z.string(),
  items: z.array(RoundtableHistoryEntrySchema),
});
export type RoundtableHistoryResponse = z.infer<typeof RoundtableHistoryResponseSchema>;

export const RoundtableSaveTemplateResponseSchema = z.object({
  ok: z.literal(true),
  template: PromptTemplateSchema,
});
export type RoundtableSaveTemplateResponse = z.infer<typeof RoundtableSaveTemplateResponseSchema>;

export const RoundtableMessageStatusSchema = z.enum([
  'pending',
  'streaming',
  'complete',
  'failed',
]);
export type RoundtableMessageStatus = z.infer<typeof RoundtableMessageStatusSchema>;

export type RoundtableMessageClassification =
  | 'auth'
  | 'rate_limit'
  | 'context_length'
  | 'content_filter'
  | 'network'
  | 'unknown';

export const RoundtableMessageSchema = z.object({
  id: z.string(),
  roundtable_id: z.string(),
  round: z.number().int(),
  participant_index: z.number().int(),
  model_id: z.string().nullable(),
  content: z.string(),
  status: RoundtableMessageStatusSchema,
  classification: z.string().nullable(),
  error_message: z.string().nullable(),
  visible_to_others: z.boolean(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type RoundtableMessage = z.infer<typeof RoundtableMessageSchema>;

/** Annotation payloads streamed via the data-stream `8:` frame. */
export type RoundtableAnnotation =
  | {
      type: 'rt.meta';
      roundtable_id: string;
      conversation_id: string;
      round: number;
      retry_index?: number;
    }
  | { type: 'rt.round_start'; round: number; participants_total: number }
  | (Omit<OrchestrationAnnotation, 'type'> & {
      type: 'rt.orchestration';
      roundtable_id: string;
      round: number;
      retry?: boolean;
    })
  | {
      type: 'rt.participant_delta';
      participant_index: number;
      model_id: string;
      text_chunk: string;
    }
  | {
      type: 'rt.participant_done';
      participant_index: number;
      model_id: string;
      content: string;
      cost_record_id: string;
    }
  | {
      type: 'rt.participant_failed';
      participant_index: number;
      model_id: string;
      classification: string;
      message: string;
    }
  | {
      type: 'rt.tool_trace';
      participant_index: number;
      round: number;
      call_id: string;
      tool: string;
      label: string;
      event: 'start' | 'finish';
      input?: string;
      output?: string;
      ok?: boolean;
      duration_ms?: number;
    }
  | {
      type: 'rt.round_done';
      round: number;
      completed_indices: number[];
      failed_indices: number[];
    }
  | { type: 'rt.summary_delta'; text_chunk: string }
  | {
      type: 'rt.summary_done';
      summary: RoundtableSummary;
      cost_record_id: string;
    }
  | {
      type: 'rt.summary_failed';
      classification: string;
      message: string;
      fallback_text: string;
      model_id?: string | null;
    };

/** Memory keys reserved for roundtable preferences. */
export const ROUNDTABLE_MEMORY_KEYS = {
  ANALYZER_MODEL: 'roundtable_analyzer_model',
  COST_THRESHOLD: 'cost_confirm_roundtable_threshold_usd',
  COST_ALWAYS: 'cost_confirm_roundtable_always',
} as const;

/** Default values shipped when no memory row exists. */
export const ROUNDTABLE_DEFAULTS = {
  COST_THRESHOLD_USD: 0.1,
  COST_ALWAYS: 'true' as const,
} as const;
