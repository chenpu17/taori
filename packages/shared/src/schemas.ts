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
  api_key: z.string().min(1).max(2048).optional(),
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

export const PricingMetaTierSchema = z.object({
  label: z.string().min(1).max(120),
  unit: z
    .enum(['token', 'image', 'video_second', 'second', 'minute', 'call'])
    .optional(),
  match: z.record(z.unknown()).optional(),
  price_usd: z.number().nonnegative(),
});
export type PricingMetaTier = z.infer<typeof PricingMetaTierSchema>;

export const PricingMetaSchema = z
  .object({
    version: z.literal(1).default(1),
    unit: z.enum(['token', 'image', 'video_second', 'second', 'minute', 'call']),
    tiers: z.array(PricingMetaTierSchema).max(100).optional(),
    minimum_usd: z.number().nonnegative().optional(),
    notes: z.string().max(4_000).optional(),
    source_url: z.string().url().optional(),
    updated_at: z.number().int().optional(),
  })
  .strict();
export type PricingMeta = z.infer<typeof PricingMetaSchema>;

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
  pricing_meta: PricingMetaSchema.nullable(),
  // M2.5 — declared output modalities, e.g. ['text','image'] for a multimodal
  // model. Independent of `capability` bucket; defaults to ['text'] for chat.
  modalities: z.array(ModalitySchema),
  // ms-since-epoch of last automated price catalog refresh, or null if never.
  price_synced_at: z.number().int().nullable(),
  context_length: z.number().int().nullable(),
  supports_vision: z.boolean(),
  supports_tools: z.boolean(),
  supports_json: z.boolean(),
  thinking_enabled: z.boolean().nullable(),
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
  pricing_meta: PricingMetaSchema.nullable().optional(),
  modalities: z.array(ModalitySchema).optional(),
  context_length: z.number().int().positive().nullable().optional(),
  supports_vision: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_json: z.boolean().optional(),
  thinking_enabled: z.boolean().nullable().optional(),
  is_default_for: ModelCapabilitySchema.nullable().optional(),
  enabled: z.boolean().optional(),
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
  pricing_meta: PricingMetaSchema.nullable().optional(),
  modalities: z.array(ModalitySchema).optional(),
  context_length: z.number().int().positive().nullable().optional(),
  supports_vision: z.boolean().optional(),
  supports_tools: z.boolean().optional(),
  supports_json: z.boolean().optional(),
  thinking_enabled: z.boolean().nullable().optional(),
});
export type ModelUpdate = z.infer<typeof ModelUpdateSchema>;

/** MC-3 reorder — set fallback_order = index for each id within a capability. */
export const ModelReorderRequestSchema = z.object({
  capability: ModelCapabilitySchema,
  ordered_ids: z.array(z.string().min(1)).min(1).max(200),
});
export type ModelReorderRequest = z.infer<typeof ModelReorderRequestSchema>;

export const ModelHealthRowSchema = z.object({
  model_id: z.string(),
  calls_24h: z.number().int().nonnegative(),
  failures_24h: z.number().int().nonnegative(),
  avg_first_token_ms: z.number().nonnegative().nullable(),
  avg_duration_ms: z.number().nonnegative().nullable(),
  last_failure_at: z.number().int().nullable(),
  last_failure_classification: ErrorClassificationSchema.nullable(),
  failure_distribution_24h: z.array(
    z.object({
      classification: ErrorClassificationSchema,
      failures: z.number().int().nonnegative(),
    }),
  ),
  failure_trend_24h: z.array(
    z.object({
      bucket_start: z.number().int().nonnegative(),
      label: z.string(),
      failures: z.number().int().nonnegative(),
      classifications: z.array(
        z.object({
          classification: ErrorClassificationSchema,
          failures: z.number().int().nonnegative(),
        }),
      ),
    }),
  ),
});
export type ModelHealthRow = z.infer<typeof ModelHealthRowSchema>;

export const CostBreakdownGroupBySchema = z.enum([
  'model_feature',
  'model',
  'conversation',
  'feature',
  'tag',
]);
export type CostBreakdownGroupBy = z.infer<typeof CostBreakdownGroupBySchema>;

export const CostReportFormatSchema = z.enum(['csv', 'json']);
export type CostReportFormat = z.infer<typeof CostReportFormatSchema>;

export const ModelRecommendationTaskSchema = z.enum([
  'general',
  'coding',
  'fast',
  'cheap',
  'long_context',
  'vision',
]);
export type ModelRecommendationTask = z.infer<typeof ModelRecommendationTaskSchema>;

export const ModelRecommendationRequestSchema = z.object({
  capability: ModelCapabilitySchema.default('chat'),
  task: ModelRecommendationTaskSchema.default('general'),
  require_tools: z.boolean().optional(),
  require_vision: z.boolean().optional(),
  current_model_id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(10).default(5),
});
export type ModelRecommendationRequest = z.infer<typeof ModelRecommendationRequestSchema>;

export const ModelRecommendationSchema = z.object({
  model_id: z.string(),
  score: z.number(),
  confidence: z.enum(['low', 'medium', 'high']),
  reasons: z.array(z.string()),
  tradeoffs: z.array(z.string()),
  health: ModelHealthRowSchema,
});
export type ModelRecommendation = z.infer<typeof ModelRecommendationSchema>;

export const ModelRecommendationResponseSchema = z.object({
  task: ModelRecommendationTaskSchema,
  recommended_model_id: z.string().nullable(),
  recommendations: z.array(ModelRecommendationSchema),
});
export type ModelRecommendationResponse = z.infer<typeof ModelRecommendationResponseSchema>;

/** Discovered model from a provider's listing endpoint (e.g. OpenRouter). */
export const DiscoveredModelSchema = z.object({
  model_name: z.string(),
  display_name: z.string(),
  capability: ModelCapabilitySchema,
  price_input_per_1m: z.number().nullable(),
  price_output_per_1m: z.number().nullable(),
  price_per_image: z.number().nullable().optional(),
  price_per_video_second: z.number().nullable().optional(),
  pricing_meta: PricingMetaSchema.nullable().optional(),
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

export const McpTransportSchema = z.enum(['stdio']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpHealthStatusSchema = z.enum(['unknown', 'ok', 'error', 'disabled']);
export type McpHealthStatus = z.infer<typeof McpHealthStatusSchema>;

export const McpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  transport: McpTransportSchema,
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string()),
  enabled: z.boolean(),
  health_status: McpHealthStatusSchema,
  last_error: z.string().nullable(),
  tools_count: z.number().int().nonnegative(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

export const McpServerCreateSchema = z.object({
  name: z.string().min(1).max(100),
  transport: McpTransportSchema.default('stdio').optional(),
  command: z.string().min(1).max(1000),
  args: z.array(z.string().max(1000)).max(50).optional(),
  env: z.record(z.string().max(4000)).optional(),
  enabled: z.boolean().optional(),
});
export type McpServerCreate = z.infer<typeof McpServerCreateSchema>;

export const McpServerUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  command: z.string().min(1).max(1000).optional(),
  args: z.array(z.string().max(1000)).max(50).optional(),
  env: z.record(z.string().max(4000)).optional(),
  enabled: z.boolean().optional(),
});
export type McpServerUpdate = z.infer<typeof McpServerUpdateSchema>;

export const McpServerRefreshResponseSchema = z.object({
  ok: z.boolean(),
  server: McpServerSchema,
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
    }),
  ),
});
export type McpServerRefreshResponse = z.infer<typeof McpServerRefreshResponseSchema>;

export const McpServerLogEntrySchema = z.object({
  ts: z.number().int(),
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
});
export type McpServerLogEntry = z.infer<typeof McpServerLogEntrySchema>;

export const McpServerRuntimeResponseSchema = z.object({
  ok: z.literal(true),
  server: McpServerSchema,
  session_running: z.boolean(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
    }),
  ),
  logs: z.array(McpServerLogEntrySchema),
});
export type McpServerRuntimeResponse = z.infer<typeof McpServerRuntimeResponseSchema>;

export const PromptTemplateSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  description: z.string().max(280).nullable(),
  content: z.string().min(1).max(20_000),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type PromptTemplate = z.infer<typeof PromptTemplateSchema>;

export const PromptTemplateCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(280).nullable().optional(),
  content: z.string().min(1).max(20_000),
});
export type PromptTemplateCreate = z.infer<typeof PromptTemplateCreateSchema>;

export const PromptTemplateUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(280).nullable().optional(),
  content: z.string().min(1).max(20_000).optional(),
});
export type PromptTemplateUpdate = z.infer<typeof PromptTemplateUpdateSchema>;

export const PersonaSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  description: z.string().max(280).nullable(),
  prompt: z.string().min(8).max(4_000),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const PersonaCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(280).nullable().optional(),
  prompt: z.string().min(8).max(4_000),
});
export type PersonaCreate = z.infer<typeof PersonaCreateSchema>;

export const PersonaUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(280).nullable().optional(),
  prompt: z.string().min(8).max(4_000).optional(),
});
export type PersonaUpdate = z.infer<typeof PersonaUpdateSchema>;

export const WorkflowRecipeVariableSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[A-Za-z_][A-Za-z0-9_ -]*$/),
  label: z.string().min(1).max(80).optional(),
  required: z.boolean().default(true),
  default_value: z.string().max(2_000).optional(),
});
export type WorkflowRecipeVariable = z.infer<typeof WorkflowRecipeVariableSchema>;

export const WorkflowRecipePersonaSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('existing'), persona_id: z.string().min(1) }),
  z.object({ mode: z.literal('inline'), prompt: z.string().min(8).max(4_000) }),
]);
export type WorkflowRecipePersona = z.infer<typeof WorkflowRecipePersonaSchema>;

export const WorkflowRecipeToolsSchema = z.object({
  required: z.array(z.string().min(1).max(160)).max(20).default([]),
  optional: z.array(z.string().min(1).max(160)).max(20).default([]),
});
export type WorkflowRecipeTools = z.infer<typeof WorkflowRecipeToolsSchema>;

export const WorkflowRecipeOutputFormatSchema = z.object({
  kind: z.enum(['markdown', 'json', 'plain']).default('markdown'),
  sections: z.array(z.string().min(1).max(80)).max(20).default([]),
});
export type WorkflowRecipeOutputFormat = z.infer<typeof WorkflowRecipeOutputFormatSchema>;

export const WorkflowRecipeBudgetSchema = z.object({
  mode: z.enum(['none', 'soft_cap', 'hard_cap']).default('none'),
  max_estimated_usd: z.number().nonnegative().max(1_000).nullable().optional(),
});
export type WorkflowRecipeBudget = z.infer<typeof WorkflowRecipeBudgetSchema>;

export const WorkflowRecipeSpecSchema = z.object({
  schema_version: z.literal(1),
  name: z.string().min(1).max(120),
  description: z.string().max(280).nullable().optional(),
  prompt_template: z.string().min(1).max(20_000),
  variables: z.array(WorkflowRecipeVariableSchema).max(50).default([]),
  recommended_task: ModelRecommendationTaskSchema.default('general'),
  model_strategy: z.enum(['keep_current', 'recommend', 'prefer_cheap', 'prefer_fast']).default('recommend'),
  persona: WorkflowRecipePersonaSchema.default({ mode: 'none' }),
  tools: WorkflowRecipeToolsSchema.default({ required: [], optional: [] }),
  output_format: WorkflowRecipeOutputFormatSchema.default({ kind: 'markdown', sections: [] }),
  budget: WorkflowRecipeBudgetSchema.default({ mode: 'none' }),
  metadata: z.record(z.unknown()).default({}),
});
export type WorkflowRecipeSpec = z.infer<typeof WorkflowRecipeSpecSchema>;

export const WorkflowRecipeSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  description: z.string().max(280).nullable(),
  schema_version: z.literal(1),
  spec: WorkflowRecipeSpecSchema,
  enabled: z.boolean(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type WorkflowRecipe = z.infer<typeof WorkflowRecipeSchema>;

export const WorkflowRecipeCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(280).nullable().optional(),
  spec: WorkflowRecipeSpecSchema,
  enabled: z.boolean().optional(),
});
export type WorkflowRecipeCreate = z.infer<typeof WorkflowRecipeCreateSchema>;

export const WorkflowRecipeUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(280).nullable().optional(),
  spec: WorkflowRecipeSpecSchema.optional(),
  enabled: z.boolean().optional(),
});
export type WorkflowRecipeUpdate = z.infer<typeof WorkflowRecipeUpdateSchema>;

export const WorkflowRecipeImportSchema = z.object({
  spec: WorkflowRecipeSpecSchema,
  enabled: z.boolean().optional(),
});
export type WorkflowRecipeImport = z.infer<typeof WorkflowRecipeImportSchema>;

export const WorkflowRecipeApplyPreviewRequestSchema = z.object({
  variables: z.record(z.string().max(10_000)).default({}),
  conversation_id: z.string().nullable().optional(),
  current_model_id: z.string().nullable().optional(),
});
export type WorkflowRecipeApplyPreviewRequest = z.infer<typeof WorkflowRecipeApplyPreviewRequestSchema>;

export const WorkflowRecipeApplyPreviewSchema = z.object({
  recipe_id: z.string(),
  prompt: z.string(),
  missing_variables: z.array(z.string()),
  persona: WorkflowRecipePersonaSchema,
  tools: z.object({
    required: z.array(z.object({ name: z.string(), enabled: z.boolean(), available: z.boolean() })),
    optional: z.array(z.object({ name: z.string(), enabled: z.boolean(), available: z.boolean() })),
  }),
  recommended_task: ModelRecommendationTaskSchema,
  model_strategy: z.enum(['keep_current', 'recommend', 'prefer_cheap', 'prefer_fast']),
  budget: WorkflowRecipeBudgetSchema,
  output_format: WorkflowRecipeOutputFormatSchema,
});
export type WorkflowRecipeApplyPreview = z.infer<typeof WorkflowRecipeApplyPreviewSchema>;

export const BackupConflictStrategySchema = z.enum(['overwrite', 'skip', 'rename']);
export type BackupConflictStrategy = z.infer<typeof BackupConflictStrategySchema>;

export const BackupProviderRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: ProviderTypeSchema,
  base_url: z.string().url(),
  enabled: z.boolean(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  had_api_key: z.boolean(),
});
export type BackupProviderRecord = z.infer<typeof BackupProviderRecordSchema>;

export const BackupModelRecordSchema = z.object({
  id: z.string(),
  alias: z.string().nullable(),
  provider_id: z.string().nullable(),
  model_name: z.string(),
  capability: z.string(),
  display_name: z.string(),
  price_input_per_1m: z.number().nullable(),
  price_output_per_1m: z.number().nullable(),
  price_per_call: z.number().nullable(),
  price_per_image: z.number().nullable(),
  price_per_video_second: z.number().nullable(),
  price_currency: z.string(),
  pricing_meta: PricingMetaSchema.nullable().optional().default(null),
  price_synced_at: z.number().int().nullable(),
  modalities: z.string().nullable(),
  context_length: z.number().int().nullable(),
  supports_vision: z.boolean(),
  supports_tools: z.boolean(),
  supports_json: z.boolean(),
  thinking_enabled: z.boolean().nullable().optional().default(null),
  is_default_for: z.string().nullable(),
  fallback_order: z.number().int(),
  user_rating: z.number().int().nullable(),
  failure_count_24h: z.number().int(),
  last_failure_at: z.number().int().nullable(),
  demoted: z.boolean(),
  disabled_until: z.number().int().nullable(),
  enabled: z.boolean(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type BackupModelRecord = z.infer<typeof BackupModelRecordSchema>;

export const BackupConversationRecordSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  archived: z.boolean(),
  pinned: z.boolean(),
  tags: z.string().nullable(),
});
export type BackupConversationRecord = z.infer<typeof BackupConversationRecordSchema>;

export const BackupMessageRecordSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  role: z.string(),
  content: z.string().nullable(),
  model_id: z.string().nullable(),
  parent_message_id: z.string().nullable(),
  attachments: z.string().nullable(),
  status: z.string(),
  error: z.string().nullable(),
  created_at: z.number().int(),
});
export type BackupMessageRecord = z.infer<typeof BackupMessageRecordSchema>;

export const BackupFileRecordSchema = z.object({
  id: z.string(),
  conversation_id: z.string().nullable(),
  message_id: z.string().nullable(),
  original_path: z.string().nullable(),
  mime_type: z.string(),
  size_bytes: z.number().int(),
  extracted_text: z.string().nullable(),
  preview_data: z.string().nullable(),
  created_at: z.number().int(),
  data_b64: z.string().nullable(),
});
export type BackupFileRecord = z.infer<typeof BackupFileRecordSchema>;

export const BackupMemoryRecordSchema = z.object({
  id: z.string(),
  scope: z.string(),
  scope_id: z.string().nullable(),
  key: z.string(),
  value: z.string(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type BackupMemoryRecord = z.infer<typeof BackupMemoryRecordSchema>;

export const BackupPromptTemplateRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  content: z.string(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type BackupPromptTemplateRecord = z.infer<typeof BackupPromptTemplateRecordSchema>;

export const BackupPersonaRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  prompt: z.string(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type BackupPersonaRecord = z.infer<typeof BackupPersonaRecordSchema>;

export const BackupCostRecordSchema = z.object({
  id: z.string(),
  conversation_id: z.string().nullable(),
  source_type: z.string(),
  source_id: z.string().nullable(),
  feature: z.string(),
  model_id: z.string().nullable(),
  model_name_snapshot: z.string(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  call_count: z.number().int(),
  price_input_per_1m_snapshot: z.number().nullable(),
  price_output_per_1m_snapshot: z.number().nullable(),
  price_per_call_snapshot: z.number().nullable(),
  estimated_cost_usd: z.number().nullable(),
  actual_cost_usd: z.number().nullable(),
  success: z.boolean(),
  classification: z.string().nullable(),
  first_token_ms: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  created_at: z.number().int(),
});
export type BackupCostRecord = z.infer<typeof BackupCostRecordSchema>;

export const BackupRoundtableRecordSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  topic: z.string(),
  mode: z.string(),
  participants: z.string(),
  summarizer_model_id: z.string().nullable(),
  origin_conversation_id: z.string().nullable(),
  analyzer_fallback: z.boolean(),
  status: z.string(),
  current_round: z.number().int(),
  summary: z.string().nullable(),
  estimated_cost_usd_low: z.number().nullable(),
  estimated_cost_usd_high: z.number().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  completed_at: z.number().int().nullable(),
});
export type BackupRoundtableRecord = z.infer<typeof BackupRoundtableRecordSchema>;

export const BackupRoundtableMessageRecordSchema = z.object({
  id: z.string(),
  roundtable_id: z.string(),
  round: z.number().int(),
  participant_index: z.number().int(),
  model_id: z.string().nullable(),
  content: z.string(),
  status: z.string(),
  classification: z.string().nullable(),
  error_message: z.string().nullable(),
  visible_to_others: z.boolean(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type BackupRoundtableMessageRecord = z.infer<typeof BackupRoundtableMessageRecordSchema>;

export const BackupCountsSchema = z.object({
  providers: z.number().int().nonnegative(),
  models: z.number().int().nonnegative(),
  conversations: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  memories: z.number().int().nonnegative(),
  prompt_templates: z.number().int().nonnegative(),
  personas: z.number().int().nonnegative(),
  cost_records: z.number().int().nonnegative(),
  roundtables: z.number().int().nonnegative(),
  roundtable_messages: z.number().int().nonnegative(),
});
export type BackupCounts = z.infer<typeof BackupCountsSchema>;

export const BackupDataSchema = z.object({
  providers: z.array(BackupProviderRecordSchema),
  models: z.array(BackupModelRecordSchema),
  conversations: z.array(BackupConversationRecordSchema),
  messages: z.array(BackupMessageRecordSchema),
  files: z.array(BackupFileRecordSchema),
  memories: z.array(BackupMemoryRecordSchema),
  prompt_templates: z.array(BackupPromptTemplateRecordSchema),
  personas: z.array(BackupPersonaRecordSchema),
  cost_records: z.array(BackupCostRecordSchema),
  roundtables: z.array(BackupRoundtableRecordSchema),
  roundtable_messages: z.array(BackupRoundtableMessageRecordSchema),
});
export type BackupData = z.infer<typeof BackupDataSchema>;

export const BackupPackageSchema = z.object({
  format_version: z.literal('taori-backup-v1'),
  exported_at: z.number().int(),
  app_version: z.string(),
  counts: BackupCountsSchema,
  warnings: z.array(z.string()),
  data: BackupDataSchema,
});
export type BackupPackage = z.infer<typeof BackupPackageSchema>;

export const BackupImportRequestSchema = z.object({
  strategy: BackupConflictStrategySchema,
  backup: BackupPackageSchema,
});
export type BackupImportRequest = z.infer<typeof BackupImportRequestSchema>;

export const BackupImportResponseSchema = z.object({
  ok: z.boolean(),
  data: z.object({
    strategy: BackupConflictStrategySchema,
    imported: BackupCountsSchema,
    skipped: BackupCountsSchema,
    renamed: BackupCountsSchema,
    warnings: z.array(z.string()),
  }),
});
export type BackupImportResponse = z.infer<typeof BackupImportResponseSchema>;

export const BackupExportResponseSchema = z.object({
  ok: z.boolean(),
  backup: BackupPackageSchema,
});
export type BackupExportResponse = z.infer<typeof BackupExportResponseSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
});

export const ChatAttachmentSchema = z.object({
  // M1 §4 (FILE-1..3): images render inline for vision models; text/markdown
  // and PDFs are decoded sidecar-side and prepended to the user message as
  // fenced extracted text.
  kind: z.enum(['image', 'text', 'pdf']),
  mime: z.string(),
  // Cap each attachment at ~7.5MB decoded (~10MB base64). Defends the sidecar
  // (and the SQLite row that persists this) against accidental or malicious
  // multi-GB payloads.
  data_b64: z.string().max(10_000_000, '单个附件不能超过 10MB'),
  name: z.string().optional(),
  file_id: z.string().optional(),
});
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

export const ChatRequestSchema = z.object({
  conversation_id: z.string().optional(),
  model_id: z.string(),
  persona_id: z.string().optional(),
  messages: z.array(ChatMessageSchema).min(1),
  attachments: z.array(ChatAttachmentSchema).max(8, '最多同时上传 8 个附件').optional(),
  /**
   * C1 — when set, /v1/chat must NOT insert a new user-message row before
   * streaming the assistant. Used by edit-and-resend so editing an existing
   * user message does not duplicate it in the conversation history.
   */
  skip_user_persist: z.boolean().optional(),
  confirmed_cost: z.boolean().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ConversationExportFormatSchema = z.enum(['markdown']);
export type ConversationExportFormat = z.infer<typeof ConversationExportFormatSchema>;

export const ConversationExportIncludeTimelineSchema = z.enum(['none', 'summary']);
export type ConversationExportIncludeTimeline = z.infer<typeof ConversationExportIncludeTimelineSchema>;

export const ConversationExportQuerySchema = z.object({
  format: ConversationExportFormatSchema.default('markdown'),
  include_timeline: ConversationExportIncludeTimelineSchema.default('summary'),
});
export type ConversationExportQuery = z.infer<typeof ConversationExportQuerySchema>;

export const ErrorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  classification: ErrorClassificationSchema.optional(),
  can_retry: z.boolean().optional(),
  details: z.record(z.unknown()).optional(),
});
