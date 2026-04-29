import { z } from 'zod';
import {
  PROVIDER_TYPES,
  MODEL_CAPABILITIES,
  MESSAGE_STATUSES,
  MODALITIES,
} from './constants.js';
import { ERROR_CODES, ERROR_CLASSIFICATIONS } from './errors.js';

/**
 * NOTE: These are the cross-process Zod schemas used both by the Sidecar HTTP
 * layer (fastify-type-provider-zod) and the Renderer (typed fetch / useChat).
 *
 * Database-internal Drizzle schemas live in apps/sidecar/src/db/schema.ts and
 * are intentionally not re-exported here.
 */

export const ProviderTypeSchema = z.enum(PROVIDER_TYPES);
export const ModelCapabilitySchema = z.enum(MODEL_CAPABILITIES);
export const ModalitySchema = z.enum(MODALITIES);
export const MessageStatusSchema = z.enum(MESSAGE_STATUSES);
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export const ErrorClassificationSchema = z.enum(ERROR_CLASSIFICATIONS);

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal('taori-sidecar'),
  version: z.string(),
  uptime_ms: z.number().int().nonnegative(),
  control_channel: z.enum(['connected', 'disconnected', 'unknown']),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ProviderSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  type: ProviderTypeSchema,
  base_url: z.string().url(),
  api_key_ref: z.string().nullable(),
  enabled: z.boolean(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Provider = z.infer<typeof ProviderSchema>;

export const ProviderCreateSchema = z.object({
  name: z.string().min(1).max(100),
  type: ProviderTypeSchema,
  base_url: z.string().url(),
  api_key: z.string().min(1).max(2048).optional(),
});
export type ProviderCreate = z.infer<typeof ProviderCreateSchema>;

export const ProviderUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  base_url: z.string().url().optional(),
  api_key: z.string().min(1).max(2048).optional(),
  enabled: z.boolean().optional(),
});
export type ProviderUpdate = z.infer<typeof ProviderUpdateSchema>;

export const ProviderTestRequestSchema = z.object({
  type: ProviderTypeSchema,
  base_url: z.string().url(),
  api_key: z.string().min(1).max(2048),
});
export type ProviderTestRequest = z.infer<typeof ProviderTestRequestSchema>;

export const ProviderTestResponseSchema = z.object({
  ok: z.boolean(),
  sample_count: z.number().int().nonnegative().optional(),
  error: z
    .object({
      classification: ErrorClassificationSchema,
      message: z.string(),
    })
    .optional(),
});
export type ProviderTestResponse = z.infer<typeof ProviderTestResponseSchema>;

export const ModelSchema = z.object({
  id: z.string(),
  alias: z.string().nullable(),
  provider_id: z.string().nullable(),
  model_name: z.string(),
  capability: ModelCapabilitySchema,
  display_name: z.string(),
  price_input_per_1m: z.number().nullable(),
  price_output_per_1m: z.number().nullable(),
  price_per_call: z.number().nullable(),
  // M2.5 — finer pricing for image/video models.
  price_per_image: z.number().nullable(),
  price_per_video_second: z.number().nullable(),
  price_currency: z.string(),
  // M2.5 — declared output modalities, e.g. ['text','image'] for a multimodal
  // model. Independent of `capability` bucket; defaults to ['text'] for chat.
  modalities: z.array(ModalitySchema),
  // ms-since-epoch of last automated price catalog refresh, or null if never.
  price_synced_at: z.number().int().nullable(),
  context_length: z.number().int().nullable(),
  supports_vision: z.boolean(),
  supports_tools: z.boolean(),
  supports_json: z.boolean(),
  is_default_for: ModelCapabilitySchema.nullable(),
  enabled: z.boolean(),
  fallback_order: z.number().int().nonnegative(),
  demoted: z.boolean(),
  disabled_until: z.number().int().nullable(),
  failure_count_24h: z.number().int().nonnegative(),
});
export type Model = z.infer<typeof ModelSchema>;

export const ModelCreateSchema = z.object({
  alias: z.string().min(1).max(80).nullable().optional(),
  provider_id: z.string().min(1),
  model_name: z.string().min(1).max(200),
  capability: ModelCapabilitySchema,
  display_name: z.string().min(1).max(200),
  price_input_per_1m: z.number().nonnegative().nullable().optional(),
  price_output_per_1m: z.number().nonnegative().nullable().optional(),
  price_per_call: z.number().nonnegative().nullable().optional(),
  price_per_image: z.number().nonnegative().nullable().optional(),
  price_per_video_second: z.number().nonnegative().nullable().optional(),
  price_currency: z.string().length(3).optional(),
  modalities: z.array(ModalitySchema).optional(),
  context_length: z.number().int().positive().nullable().optional(),
  supports_vision: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_json: z.boolean().optional(),
  is_default_for: ModelCapabilitySchema.nullable().optional(),
});
export type ModelCreate = z.infer<typeof ModelCreateSchema>;

export const ModelUpdateSchema = z.object({
  alias: z.string().min(1).max(80).nullable().optional(),
  display_name: z.string().min(1).max(200).optional(),
  capability: ModelCapabilitySchema.optional(),
  is_default_for: ModelCapabilitySchema.nullable().optional(),
  enabled: z.boolean().optional(),
  fallback_order: z.number().int().nonnegative().optional(),
  // Manual pricing edits (e.g. when catalog sync doesn't cover the model).
  price_input_per_1m: z.number().nonnegative().nullable().optional(),
  price_output_per_1m: z.number().nonnegative().nullable().optional(),
  price_per_call: z.number().nonnegative().nullable().optional(),
  price_per_image: z.number().nonnegative().nullable().optional(),
  price_per_video_second: z.number().nonnegative().nullable().optional(),
  price_currency: z.string().length(3).optional(),
  modalities: z.array(ModalitySchema).optional(),
  context_length: z.number().int().positive().nullable().optional(),
  supports_vision: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_json: z.boolean().optional(),
});
export type ModelUpdate = z.infer<typeof ModelUpdateSchema>;

/** MC-3 reorder — set fallback_order = index for each id within a capability. */
export const ModelReorderRequestSchema = z.object({
  capability: ModelCapabilitySchema,
  ordered_ids: z.array(z.string().min(1)).min(1).max(200),
});
export type ModelReorderRequest = z.infer<typeof ModelReorderRequestSchema>;

/** Discovered model from a provider's listing endpoint (e.g. OpenRouter). */
export const DiscoveredModelSchema = z.object({
  model_name: z.string(),
  display_name: z.string(),
  capability: ModelCapabilitySchema,
  price_input_per_1m: z.number().nullable(),
  price_output_per_1m: z.number().nullable(),
  price_per_image: z.number().nullable().optional(),
  price_per_video_second: z.number().nullable().optional(),
  modalities: z.array(ModalitySchema).optional(),
  context_length: z.number().int().nullable(),
  supports_vision: z.boolean(),
  supports_tools: z.boolean().optional(),
});
export type DiscoveredModel = z.infer<typeof DiscoveredModelSchema>;

export const ModelDiscoveryResponseSchema = z.object({
  provider_id: z.string(),
  models: z.array(DiscoveredModelSchema),
  recommended: z.object({
    chat: z.string().nullable(),
    vision: z.string().nullable(),
  }),
});
export type ModelDiscoveryResponse = z.infer<typeof ModelDiscoveryResponseSchema>;

/**
 * M2.5 — Catalog sync (F-PR). Re-fetches provider price lists, upserts into
 * the `models` table, and reports a diff for the UI banner.
 */
export const CatalogSyncRequestSchema = z.object({
  provider_id: z.string().optional(),
});
export type CatalogSyncRequest = z.infer<typeof CatalogSyncRequestSchema>;

export const CatalogModelDiffSchema = z.object({
  provider_id: z.string(),
  model_name: z.string(),
  display_name: z.string(),
  change: z.enum(['new', 'price_changed', 'unchanged', 'removed']),
  before: z
    .object({
      price_input_per_1m: z.number().nullable(),
      price_output_per_1m: z.number().nullable(),
      price_per_image: z.number().nullable().optional(),
    })
    .optional(),
  after: z
    .object({
      price_input_per_1m: z.number().nullable(),
      price_output_per_1m: z.number().nullable(),
      price_per_image: z.number().nullable().optional(),
    })
    .optional(),
});
export type CatalogModelDiff = z.infer<typeof CatalogModelDiffSchema>;

export const CatalogSyncResponseSchema = z.object({
  ok: z.boolean(),
  synced_at: z.number().int(),
  total_providers: z.number().int().nonnegative(),
  total_models: z.number().int().nonnegative(),
  diffs: z.array(CatalogModelDiffSchema),
  errors: z.array(
    z.object({
      provider_id: z.string(),
      message: z.string(),
    }),
  ),
});
export type CatalogSyncResponse = z.infer<typeof CatalogSyncResponseSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
});

export const ChatAttachmentSchema = z.object({
  // M1 §4 (FILE-1..3): images render inline for vision models; text/markdown
  // is decoded sidecar-side and prepended to the user message as fenced text.
  // PDF parsing is acknowledged as a deferred gap (FILE-2) — we accept the
  // 'pdf' kind in the schema so the renderer can emit it, but the sidecar
  // currently rejects it with a clear "暂不支持 PDF" error.
  kind: z.enum(['image', 'text', 'pdf']),
  mime: z.string(),
  // Cap each attachment at ~7.5MB decoded (~10MB base64). Defends the sidecar
  // (and the SQLite row that persists this) against accidental or malicious
  // multi-GB payloads.
  data_b64: z.string().max(10_000_000, '单个附件不能超过 10MB'),
  name: z.string().optional(),
});
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

export const ChatRequestSchema = z.object({
  conversation_id: z.string().optional(),
  model_id: z.string(),
  messages: z.array(ChatMessageSchema).min(1),
  attachments: z.array(ChatAttachmentSchema).max(8, '最多同时上传 8 个附件').optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ErrorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  classification: ErrorClassificationSchema.optional(),
  can_retry: z.boolean().optional(),
  details: z.record(z.unknown()).optional(),
});
