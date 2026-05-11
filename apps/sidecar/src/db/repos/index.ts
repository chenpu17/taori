/**
 * Drizzle-backed repositories for providers + models.
 *
 * These wrap raw drizzle calls so route handlers stay readable and so the
 * row-shape ↔ Zod-shape mapping (booleans-as-int, defaults) lives in one
 * place. None of these methods touch the network or the keystore — those
 * concerns are layered on by the route handlers.
 */

import path from 'node:path';
import { eq, and, isNotNull, asc, desc, inArray, sql } from 'drizzle-orm';
import { type Db } from '../index.js';
import { isChatCapable } from '@taori/shared';
import {
  providers,
  models,
  conversations,
  messages,
  cost_records,
  mcp_servers,
  run_events,
  agent_runs,
  memories,
  structured_memories,
  prompt_templates,
  personas,
  workflow_recipes,
  research_sessions,
  research_tasks,
  research_sources,
  research_claims,
  files,
  file_chunks,
  roundtables,
  roundtable_messages,
  quick_compare_runs,
  quick_compare_outputs,
} from '../schema.js';
import type {
  ErrorClassification,
  ModelHealthRow,
  ToolErrorClassification,
  ToolHealthRow,
  Participant,
  RoundtableStoredMode,
  RoundtableStatus,
  SummaryStorage,
  RoundtableMessageStatus,
  RoundtableMessageClassification,
  PromptTemplate,
  PromptTemplateCreate,
  PromptTemplateUpdate,
  Persona,
  PersonaCreate,
  PersonaUpdate,
  WorkflowRecipe,
  WorkflowRecipeCreate,
  WorkflowRecipeUpdate,
  ResearchSession,
  ResearchSessionCreate,
  ResearchSessionDetail,
  ResearchSessionExport,
  ResearchSessionExportRequest,
  ResearchTask,
  ResearchTaskKind,
  ResearchTaskStatus,
  ResearchSource,
  ResearchSourceType,
  ResearchClaim,
  ResearchClaimKind,
  ResearchClaimSupportStatus,
  ResearchConstraints,
  ResearchPlan,
  ResearchStatus,
  ResearchStage,
  ResearchBudgetMode,
  ResearchOutputKind,
  AgentRun,
  RunEvent,
  RunEventKind,
  RunEventStatus,
  QuickCompareRun,
  QuickCompareOutput,
  QuickCompareStatus,
  QuickCompareOutputStatus,
  FileChunk,
  FileSearchResult,
} from '@taori/shared';
import {
  makeId,
  type Provider,
  type Model,
  type ProviderCreate,
  type ProviderUpdate,
  type ModelCreate,
  type ModelUpdate,
  type ModelCapability,
  type McpServer,
  type McpServerCreate,
  type McpServerUpdate,
  PricingMetaSchema,
  WorkflowRecipeSpecSchema,
  ResearchConstraintsSchema,
  ResearchPlanSchema,
} from '@taori/shared';

type ProviderRow = typeof providers.$inferSelect;
type ModelRow = typeof models.$inferSelect;
type PromptTemplateRow = typeof prompt_templates.$inferSelect;
type PersonaRow = typeof personas.$inferSelect;
type WorkflowRecipeRow = typeof workflow_recipes.$inferSelect;
type ResearchSessionRow = typeof research_sessions.$inferSelect;
type ResearchTaskRow = typeof research_tasks.$inferSelect;
type ResearchSourceRow = typeof research_sources.$inferSelect;
type ResearchClaimRow = typeof research_claims.$inferSelect;
type RunEventRow = typeof run_events.$inferSelect;
type AgentRunRow = typeof agent_runs.$inferSelect;
type McpServerRow = typeof mcp_servers.$inferSelect;
type QuickCompareRunRow = typeof quick_compare_runs.$inferSelect;
type QuickCompareOutputRow = typeof quick_compare_outputs.$inferSelect;
type FileChunkRow = typeof file_chunks.$inferSelect;

function toProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    type: row.type as Provider['type'],
    base_url: row.base_url,
    api_key_ref: row.api_key_ref,
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toModel(row: ModelRow): Model {
  let modalities: Model['modalities'] = ['text'];
  if (row.modalities) {
    try {
      const parsed = JSON.parse(row.modalities);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
        modalities = parsed as Model['modalities'];
      }
    } catch {
      // keep default
    }
  } else {
    // Backfill defaults based on capability for legacy rows.
    const cap = row.capability as ModelCapability;
    if (cap === 'image') modalities = ['image'];
    else if (cap === 'video') modalities = ['video'];
    else if (cap === 'multimodal') modalities = ['text', 'image'];
    else if (cap === 'asr') modalities = ['audio'];
    else if (cap === 'tts') modalities = ['audio'];
  }
  return {
    id: row.id,
    alias: row.alias,
    provider_id: row.provider_id,
    model_name: row.model_name,
    capability: row.capability as ModelCapability,
    display_name: row.display_name,
    price_input_per_1m: row.price_input_per_1m,
    price_output_per_1m: row.price_output_per_1m,
    price_per_call: row.price_per_call,
    price_per_image: row.price_per_image ?? null,
    price_per_video_second: row.price_per_video_second ?? null,
    price_currency: row.price_currency,
    pricing_meta: parsePricingMeta(row.pricing_meta),
    modalities,
    price_synced_at: row.price_synced_at ?? null,
    context_length: row.context_length,
    supports_vision: row.supports_vision,
    supports_tools: row.supports_tools,
    supports_json: row.supports_json,
    thinking_enabled: row.thinking_enabled ?? null,
    is_default_for: (row.is_default_for as ModelCapability | null) ?? null,
    enabled: row.enabled,
    fallback_order: row.fallback_order ?? 0,
    demoted: row.demoted ?? false,
    disabled_until: row.disabled_until ?? null,
    failure_count_24h: row.failure_count_24h ?? 0,
  };
}

function parsePricingMeta(raw: string | null): Model['pricing_meta'] {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = PricingMetaSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function stringifyPricingMeta(value: Model['pricing_meta'] | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return JSON.stringify(value);
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseConversationTags(raw: string | null): string[] {
  return Array.from(
    new Set(
      parseStringArray(raw)
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ).slice(0, 3);
}

function parseStringRecord(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function parseJsonRecord(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseResearchConstraints(raw: string | null): ResearchConstraints {
  try {
    return ResearchConstraintsSchema.parse(raw ? JSON.parse(raw) : {});
  } catch {
    return ResearchConstraintsSchema.parse({});
  }
}

function parseResearchPlan(raw: string | null): ResearchPlan | null {
  if (!raw) return null;
  try {
    return ResearchPlanSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseResearchCitations(raw: string | null): ResearchClaim['citations'] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is ResearchClaim['citations'][number] =>
          Boolean(item)
          && typeof item === 'object'
          && !Array.isArray(item)
          && typeof (item as { source_id?: unknown }).source_id === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

function toQuickCompareRun(row: QuickCompareRunRow): QuickCompareRun {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    source_user_message_id: row.source_user_message_id,
    run_id: row.run_id,
    status: row.status as QuickCompareStatus,
    model_ids: parseStringArray(row.model_ids),
    adopted_output_id: row.adopted_output_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toQuickCompareOutput(row: QuickCompareOutputRow): QuickCompareOutput {
  return {
    id: row.id,
    compare_id: row.compare_id,
    participant_index: row.participant_index,
    model_id: row.model_id,
    provider_id: row.provider_id,
    tool_names: parseStringArray(row.tool_names),
    content: row.content,
    status: row.status as QuickCompareOutputStatus,
    error_classification: row.error_classification as QuickCompareOutput['error_classification'],
    error_message: row.error_message,
    cost_record_id: row.cost_record_id,
    first_token_ms: row.first_token_ms,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toMcpServer(row: McpServerRow): McpServer {
  return {
    id: row.id,
    name: row.name,
    transport: 'stdio',
    command: row.command,
    args: parseStringArray(row.args),
    env: parseStringRecord(row.env),
    enabled: row.enabled,
    health_status: row.enabled ? (row.health_status as McpServer['health_status']) : 'disabled',
    last_error: row.last_error,
    tools_count: row.tools_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toPromptTemplate(row: PromptTemplateRow): PromptTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    content: row.content,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toPersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    prompt: row.prompt,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toWorkflowRecipe(row: WorkflowRecipeRow): WorkflowRecipe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.spec_json);
  } catch {
    throw new Error(`Invalid workflow recipe spec stored for ${row.id}`);
  }
  const spec = WorkflowRecipeSpecSchema.parse(parsed);
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    schema_version: 1,
    spec,
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toResearchSession(row: ResearchSessionRow): ResearchSession {
  return {
    id: row.id,
    conversation_id: row.conversation_id ?? null,
    title: row.title,
    objective: row.objective,
    output_kind: row.output_kind as ResearchOutputKind,
    status: row.status as ResearchStatus,
    stage: row.stage as ResearchStage,
    budget_mode: row.budget_mode as ResearchBudgetMode,
    budget_limit_usd: row.budget_limit_usd ?? null,
    budget_spent_usd: row.budget_spent_usd ?? 0,
    constraints: parseResearchConstraints(row.constraints_json),
    plan: parseResearchPlan(row.plan_json),
    draft_markdown: row.draft_markdown ?? null,
    final_markdown: row.final_markdown ?? null,
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toResearchTask(row: ResearchTaskRow): ResearchTask {
  return {
    id: row.id,
    research_session_id: row.research_session_id,
    parent_task_id: row.parent_task_id ?? null,
    kind: row.kind as ResearchTaskKind,
    status: row.status as ResearchTaskStatus,
    title: row.title,
    input: parseJsonRecord(row.input_json),
    output: row.output_json ? parseJsonRecord(row.output_json) : null,
    error: row.error_json ? parseJsonRecord(row.error_json) : null,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toResearchSource(row: ResearchSourceRow): ResearchSource {
  return {
    id: row.id,
    research_session_id: row.research_session_id,
    source_type: row.source_type as ResearchSourceType,
    title: row.title ?? null,
    locator: row.locator,
    snippet: row.snippet ?? null,
    credibility_score: row.credibility_score ?? null,
    included: row.included ?? true,
    metadata: parseJsonRecord(row.metadata_json),
    created_at: row.created_at,
  };
}

function toResearchClaim(row: ResearchClaimRow): ResearchClaim {
  return {
    id: row.id,
    research_session_id: row.research_session_id,
    section_key: row.section_key,
    claim_text: row.claim_text,
    claim_kind: row.claim_kind as ResearchClaimKind,
    support_status: row.support_status as ResearchClaimSupportStatus,
    citations: parseResearchCitations(row.citations_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toRunEvent(row: RunEventRow): RunEvent {
  let payload: Record<string, unknown> | null = null;
  if (row.payload) {
    try {
      const parsed = JSON.parse(row.payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = null;
    }
  }
  return {
    id: row.id,
    run_id: row.run_id,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    kind: row.kind as RunEventKind,
    status: row.status as RunEventStatus,
    label: row.label,
    summary: row.summary,
    payload,
    created_at: row.created_at,
  };
}

function payloadString(event: RunEvent, key: string): string | null {
  const value = event.payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function deriveRun(events: RunEvent[]): AgentRun {
  const sorted = [...events].sort((a, b) => a.created_at - b.created_at);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const started = sorted.find((event) => event.kind === 'turn.started') ?? first;
  const modelEvent = [...sorted]
    .reverse()
    .find((event) => event.kind.startsWith('model.') && payloadString(event, 'model_id'));
  const terminal = [...sorted]
    .reverse()
    .find((event) => event.kind.startsWith('turn.') || event.kind.startsWith('recovery.'));

  let status: AgentRun['status'] = 'created';
  if (terminal?.kind === 'turn.completed' || terminal?.kind === 'recovery.completed') {
    status = 'completed';
  } else if (terminal?.kind === 'turn.failed' || terminal?.kind === 'recovery.failed') {
    status = 'failed';
  } else if (terminal?.kind === 'turn.incomplete') {
    status = 'incomplete';
  } else if (terminal?.kind === 'turn.stopped' || terminal?.kind === 'turn.cancelled') {
    status = payloadString(terminal, 'message_status') === 'incomplete'
      ? 'incomplete'
      : 'stopped';
  } else if (terminal?.kind === 'recovery.started') {
    status = 'retrying';
  } else if (sorted.some((event) => event.kind === 'tool.started' && event.status !== 'completed')) {
    status = 'tool_calling';
  } else if (sorted.some((event) => event.kind === 'model.started')) {
    status = 'streaming';
  } else if (sorted.some((event) => event.kind === 'context.snapshot')) {
    status = 'context_ready';
  }

  const kind = payloadString(started, 'run_kind') as AgentRun['kind'] | null;
  return {
    id: first.run_id,
    conversation_id: first.conversation_id,
    parent_run_id: payloadString(started, 'parent_run_id'),
    user_message_id: payloadString(started, 'source_user_message_id'),
    assistant_message_id:
      first.message_id
      ?? payloadString(last, 'assistant_message_id')
      ?? payloadString(started, 'assistant_message_id'),
    kind: kind ?? 'chat',
    status,
    model_id:
      payloadString(modelEvent ?? started, 'model_id')
      ?? payloadString(started, 'model_id'),
    recovery_policy: payloadString(started, 'recovery_policy'),
    created_at: first.created_at,
    updated_at: last.created_at,
    event_count: sorted.length,
  };
}

function toAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    parent_run_id: row.parent_run_id,
    user_message_id: row.user_message_id,
    assistant_message_id: row.assistant_message_id,
    kind: row.kind as AgentRun['kind'],
    status: row.status as AgentRun['status'],
    model_id: row.model_id,
    recovery_policy: row.recovery_policy,
    created_at: row.created_at,
    updated_at: row.updated_at,
    event_count: row.event_count,
  };
}

export class ProvidersRepo {
  constructor(private db: Db) {}

  list(): Provider[] {
    return this.db.select().from(providers).all().map(toProvider);
  }

  get(id: string): Provider | null {
    const row = this.db
      .select()
      .from(providers)
      .where(eq(providers.id, id))
      .get();
    return row ? toProvider(row) : null;
  }

  create(input: ProviderCreate): Provider {
    const now = Date.now();
    const id = makeId('provider');
    const apiKeyRef = input.api_key ? `provider:${id}` : null;
    const row = this.db
      .insert(providers)
      .values({
        id,
        name: input.name,
        type: input.type,
        base_url: input.base_url,
        api_key_ref: apiKeyRef,
        enabled: true,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toProvider(row);
  }

  /**
   * Apply mutable fields. Returns the updated record or null if id missing.
   * If a new api_key is given, the api_key_ref is created/refreshed.
   * Caller is responsible for actually writing to the keystore.
   */
  update(
    id: string,
    patch: ProviderUpdate,
  ): { provider: Provider; api_key_ref_changed: boolean } | null {
    const existing = this.get(id);
    if (!existing) return null;
    const apiKeyRef =
      patch.api_key !== undefined && existing.api_key_ref == null
        ? `provider:${id}`
        : existing.api_key_ref;
    const next = this.db
      .update(providers)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.base_url !== undefined && { base_url: patch.base_url }),
        ...(patch.enabled !== undefined && { enabled: patch.enabled }),
        api_key_ref: apiKeyRef,
        updated_at: Date.now(),
      })
      .where(eq(providers.id, id))
      .returning()
      .get();
    return {
      provider: toProvider(next),
      api_key_ref_changed: patch.api_key !== undefined,
    };
  }

  delete(id: string): boolean {
    const res = this.db.delete(providers).where(eq(providers.id, id)).run();
    return res.changes > 0;
  }
}

export class ModelsRepo {
  constructor(private db: Db) {}

  list(): Model[] {
    return this.db
      .select()
      .from(models)
      .orderBy(asc(models.capability), asc(models.fallback_order))
      .all()
      .map(toModel);
  }

  listByProvider(providerId: string): Model[] {
    return this.db
      .select()
      .from(models)
      .where(eq(models.provider_id, providerId))
      .all()
      .map(toModel);
  }

  get(id: string): Model | null {
    const row = this.db.select().from(models).where(eq(models.id, id)).get();
    return row ? toModel(row) : null;
  }

  /**
   * Find the default model for a given capability among enabled models.
   * Used by /v1/chat in M1.2 to resolve "use default chat model".
   * Excludes demoted models and any whose `disabled_until` is still active —
   * the spec §7.5.2 requires automatic short-window suspension after repeated
   * `quota` / `rate_limit` failures.
   */
  defaultFor(capability: ModelCapability): Model | null {
    const now = Date.now();
    const row = this.db
      .select()
      .from(models)
      .where(
        and(
          eq(models.is_default_for, capability),
          eq(models.enabled, true),
          eq(models.demoted, false),
          isNotNull(models.provider_id),
          sql`(${models.disabled_until} IS NULL OR ${models.disabled_until} < ${now})`,
        ),
      )
      .get();
    return row ? toModel(row) : null;
  }

  /**
   * Pick the next eligible model in the same capability class, ordered by
   * `fallback_order` ascending. Excludes the calling model (so chat.ts can
   * use this after a primary failure) and respects demote/disable flags.
   */
  nextFallback(currentId: string, capability: ModelCapability): Model | null {
    const now = Date.now();
    const row = this.db
      .select()
      .from(models)
      .where(
        and(
          eq(models.capability, capability),
          eq(models.enabled, true),
          eq(models.demoted, false),
          isNotNull(models.provider_id),
          sql`${models.id} != ${currentId}`,
          sql`(${models.disabled_until} IS NULL OR ${models.disabled_until} < ${now})`,
        ),
      )
      .orderBy(asc(models.fallback_order))
      .get();
    return row ? toModel(row) : null;
  }

  /**
   * M2.2 §3.2 — pick the cheapest-active model for the given capability,
   * skipping `excludeId`. Ordering: COALESCE(price_per_call, price_input_per_1m, +Inf)
   * ascending, then `fallback_order` as a tie-breaker. Demoted, disabled
   * and providerless rows are excluded — same eligibility rules as
   * `nextFallback`. Returns null if no eligible model exists.
   *
   * NB: semantically distinct from `nextFallback` (which sorts by
   * `fallback_order` only). The two coexist; spec §3.2 calls this out.
   */
  pickCheapestActive(capability: ModelCapability, excludeId: string): Model | null {
    const now = Date.now();
    const row = this.db
      .select()
      .from(models)
      .where(
        and(
          eq(models.capability, capability),
          eq(models.enabled, true),
          eq(models.demoted, false),
          isNotNull(models.provider_id),
          sql`${models.id} != ${excludeId}`,
          sql`(${models.disabled_until} IS NULL OR ${models.disabled_until} < ${now})`,
        ),
      )
      .orderBy(
        // Treat NULL prices as +Inf so unpriced models sort to the bottom.
        sql`COALESCE(${models.price_per_call}, ${models.price_input_per_1m}, 1e18) ASC`,
        asc(models.fallback_order),
      )
      .get();
    return row ? toModel(row) : null;
  }

  create(input: ModelCreate): Model {
    const now = Date.now();
    const id = makeId('model');
    const row = this.db
      .insert(models)
      .values({
        id,
        alias: input.alias ?? null,
        provider_id: input.provider_id,
        model_name: input.model_name,
        capability: input.capability,
        display_name: input.display_name,
        price_input_per_1m: input.price_input_per_1m ?? null,
        price_output_per_1m: input.price_output_per_1m ?? null,
        price_per_call: input.price_per_call ?? null,
        price_per_image: input.price_per_image ?? null,
        price_per_video_second: input.price_per_video_second ?? null,
        price_currency: input.price_currency ?? 'USD',
        pricing_meta: stringifyPricingMeta(input.pricing_meta) ?? null,
        price_synced_at: null,
        modalities: input.modalities
          ? JSON.stringify(input.modalities)
          : null,
        context_length: input.context_length ?? null,
        supports_vision: input.supports_vision ?? false,
        supports_tools: input.supports_tools ?? isChatCapable(input.capability),
        supports_json: input.supports_json ?? false,
        thinking_enabled: input.thinking_enabled ?? null,
        is_default_for: input.enabled === false ? null : (input.is_default_for ?? null),
        fallback_order: 0,
        user_rating: null,
        failure_count_24h: 0,
        demoted: false,
        disabled_until: null,
        enabled: input.enabled ?? true,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toModel(row);
  }

  /**
   * M2.5 catalog-sync helper. Updates pricing/modalities for a model identified
   * by (provider_id, model_name) — does not touch user-set fields like alias,
   * display_name, fallback_order, enabled. Sets `price_synced_at` to now.
   */
  patchPricing(
    providerId: string,
    modelName: string,
    patch: {
      price_input_per_1m?: number | null;
      price_output_per_1m?: number | null;
      price_per_call?: number | null;
      price_per_image?: number | null;
      price_per_video_second?: number | null;
      modalities?: string[];
      capability?: ModelCapability;
      context_length?: number | null;
      supports_vision?: boolean;
      supports_tools?: boolean;
      pricing_meta?: Model['pricing_meta'];
    },
  ): Model | null {
    const now = Date.now();
    const row = this.db
      .update(models)
      .set({
        ...(patch.price_input_per_1m !== undefined && {
          price_input_per_1m: patch.price_input_per_1m,
        }),
        ...(patch.price_output_per_1m !== undefined && {
          price_output_per_1m: patch.price_output_per_1m,
        }),
        ...(patch.price_per_call !== undefined && {
          price_per_call: patch.price_per_call,
        }),
        ...(patch.price_per_image !== undefined && {
          price_per_image: patch.price_per_image,
        }),
        ...(patch.price_per_video_second !== undefined && {
          price_per_video_second: patch.price_per_video_second,
        }),
        ...(patch.pricing_meta !== undefined && {
          pricing_meta: stringifyPricingMeta(patch.pricing_meta) ?? null,
        }),
        ...(patch.modalities !== undefined && {
          modalities: JSON.stringify(patch.modalities),
        }),
        ...(patch.capability !== undefined && { capability: patch.capability }),
        ...(patch.context_length !== undefined && {
          context_length: patch.context_length,
        }),
        ...(patch.supports_vision !== undefined && {
          supports_vision: patch.supports_vision,
        }),
        ...(patch.supports_tools !== undefined && {
          supports_tools: patch.supports_tools,
        }),
        price_synced_at: now,
        updated_at: now,
      })
      .where(
        and(eq(models.provider_id, providerId), eq(models.model_name, modelName)),
      )
      .returning()
      .get();
    return row ? toModel(row) : null;
  }

  update(id: string, patch: ModelUpdate): Model | null {
    const existing = this.get(id);
    if (!existing) return null;
    const nextEnabled = patch.enabled ?? existing.enabled;
    const nextDefault =
      nextEnabled === false
        ? existing.is_default_for || patch.is_default_for !== undefined
          ? null
          : undefined
        : patch.is_default_for !== undefined
          ? patch.is_default_for
          : undefined;
    const row = this.db
      .update(models)
      .set({
        ...(patch.alias !== undefined && { alias: patch.alias }),
        ...(patch.display_name !== undefined && {
          display_name: patch.display_name,
        }),
        ...(patch.capability !== undefined && { capability: patch.capability }),
        ...(nextDefault !== undefined && { is_default_for: nextDefault }),
        ...(patch.enabled !== undefined && { enabled: patch.enabled }),
        ...(patch.fallback_order !== undefined && {
          fallback_order: patch.fallback_order,
        }),
        ...(patch.price_input_per_1m !== undefined && {
          price_input_per_1m: patch.price_input_per_1m,
        }),
        ...(patch.price_output_per_1m !== undefined && {
          price_output_per_1m: patch.price_output_per_1m,
        }),
        ...(patch.price_per_call !== undefined && {
          price_per_call: patch.price_per_call,
        }),
        ...(patch.price_per_image !== undefined && {
          price_per_image: patch.price_per_image,
        }),
        ...(patch.price_per_video_second !== undefined && {
          price_per_video_second: patch.price_per_video_second,
        }),
        ...(patch.price_currency !== undefined && {
          price_currency: patch.price_currency,
        }),
        ...(patch.pricing_meta !== undefined && {
          pricing_meta: stringifyPricingMeta(patch.pricing_meta) ?? null,
        }),
        ...(patch.modalities !== undefined && {
          modalities: JSON.stringify(patch.modalities),
        }),
        ...(patch.context_length !== undefined && {
          context_length: patch.context_length,
        }),
        ...(patch.supports_vision !== undefined && {
          supports_vision: patch.supports_vision,
        }),
        ...(patch.supports_tools !== undefined && {
          supports_tools: patch.supports_tools,
        }),
        ...(patch.supports_json !== undefined && {
          supports_json: patch.supports_json,
        }),
        ...(patch.thinking_enabled !== undefined && {
          thinking_enabled: patch.thinking_enabled,
        }),
        updated_at: Date.now(),
      })
      .where(eq(models.id, id))
      .returning()
      .get();
    return toModel(row);
  }

  /**
   * MC-3 — bulk reorder ALL models for a capability. Sets `fallback_order = i`
   * for each `orderedIds[i]`. Requires the caller to submit the FULL set of
   * model ids for the capability (no subset reorder) so we never leave gaps
   * or duplicate fallback_order values, both of which would break
   * `nextFallback()` ordering.
   *
   * Validation + writes happen inside a single SQLite transaction so concurrent
   * reorder requests for the same capability cannot interleave: better-sqlite3
   * serializes transactions on a single thread, so the second tx observes the
   * first's writes (or fails with set_mismatch if the membership shifted).
   *
   * Throws Error('not_found' | 'capability_mismatch' | 'duplicate_ids' |
   * 'set_mismatch') for the renderer to surface.
   */
  reorder(capability: ModelCapability, orderedIds: string[]): Model[] {
    const seen = new Set<string>();
    for (const id of orderedIds) {
      if (seen.has(id)) throw new Error('duplicate_ids');
      seen.add(id);
    }
    const now = Date.now();
    this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(models)
        .where(eq(models.capability, capability))
        .all();
      const existingIds = new Set(existing.map((r) => r.id));
      for (const id of orderedIds) {
        if (!existingIds.has(id)) {
          // Either the id doesn't exist at all OR it belongs to another
          // capability. Distinguish for a clearer renderer message.
          const any = tx.select().from(models).where(eq(models.id, id)).get();
          if (!any) throw new Error('not_found');
          throw new Error('capability_mismatch');
        }
      }
      if (existing.length !== orderedIds.length) {
        throw new Error('set_mismatch');
      }
      orderedIds.forEach((id, idx) => {
        tx
          .update(models)
          .set({ fallback_order: idx, updated_at: now })
          .where(eq(models.id, id))
          .run();
      });
    });
    return this.db
      .select()
      .from(models)
      .where(eq(models.capability, capability))
      .orderBy(asc(models.fallback_order))
      .all()
      .map(toModel);
  }

  /**
   * Record an upstream failure for a model and apply demote/disable per
   * docs/product/08-m1-spec.md §7.5.2:
   *   - 3 strikes within 24h → `demoted = true`
   *   - 5 strikes within 24h → `disabled_until = now + 24h`
   * Strike-counting set per docs/product/09-m2-spec.md §7.2 / §11.2:
   * `quota`, `rate_limit`, `network`, `auth`, and `unknown` all count as
   * strikes (a model that's repeatedly misconfigured or unreachable should
   * be demoted just like one that's rate-limited). `content_filter` is
   * excluded — that's a per-prompt user-side policy issue, not a model
   * health signal. Strikes age out: once the most recent failure is older
   * than 24h, the counter resets on the next call.
   */
  recordFailure(modelId: string, classification: string): Model | null {
    const STRIKE_KINDS = new Set([
      'quota',
      'rate_limit',
      'network',
      'auth',
      'unknown',
    ]);
    if (!STRIKE_KINDS.has(classification)) return this.get(modelId);
    const existing = this.get(modelId);
    if (!existing) return null;
    const row = this.db.select().from(models).where(eq(models.id, modelId)).get();
    if (!row) return null;
    const now = Date.now();
    const lastFailureAt = row.last_failure_at ?? null;
    const within24h = lastFailureAt != null && now - lastFailureAt < 86_400_000;
    const nextCount = within24h ? row.failure_count_24h + 1 : 1;
    const demoted = nextCount >= 3 || row.demoted;
    const disabledUntil =
      nextCount >= 5 ? now + 86_400_000 : row.disabled_until;
    const next = this.db
      .update(models)
      .set({
        failure_count_24h: nextCount,
        last_failure_at: now,
        demoted,
        disabled_until: disabledUntil,
        updated_at: now,
      })
      .where(eq(models.id, modelId))
      .returning()
      .get();
    return toModel(next);
  }

  /**
   * Reset failure counters after a successful call. Demoted/disabled flags
   * are NOT auto-cleared — operators must re-enable explicitly via PATCH —
   * but the rolling counter resets so the next strike starts from zero.
   */
  recordSuccess(modelId: string): void {
    this.db
      .update(models)
      .set({ failure_count_24h: 0, updated_at: Date.now() })
      .where(eq(models.id, modelId))
      .run();
  }

  /**
   * Promote a model to be THE default for a capability. Demotes any other
   * model currently flagged as default for that same capability. Idempotent.
   */
  setDefaultFor(modelId: string, capability: ModelCapability): Model | null {
    const target = this.get(modelId);
    if (!target) return null;
    if (!target.enabled) return null;
    this.db.transaction((tx) => {
      tx.update(models)
        .set({ is_default_for: null, updated_at: Date.now() })
        .where(eq(models.is_default_for, capability))
        .run();
      tx.update(models)
        .set({ is_default_for: capability, updated_at: Date.now() })
        .where(eq(models.id, modelId))
        .run();
    });
    return this.get(modelId);
  }

  delete(id: string): boolean {
    const res = this.db.delete(models).where(eq(models.id, id)).run();
    return res.changes > 0;
  }
}

export class McpServersRepo {
  constructor(private db: Db) {}

  list(): McpServer[] {
    return this.db
      .select()
      .from(mcp_servers)
      .orderBy(asc(mcp_servers.created_at))
      .all()
      .map(toMcpServer);
  }

  get(id: string): McpServer | null {
    const row = this.db
      .select()
      .from(mcp_servers)
      .where(eq(mcp_servers.id, id))
      .get();
    return row ? toMcpServer(row) : null;
  }

  create(input: McpServerCreate): McpServer {
    const now = Date.now();
    const row = this.db
      .insert(mcp_servers)
      .values({
        id: makeId('mcp_server'),
        name: input.name,
        transport: 'stdio',
        command: input.command,
        args: JSON.stringify(input.args ?? []),
        env: JSON.stringify(input.env ?? {}),
        enabled: input.enabled ?? true,
        health_status: input.enabled === false ? 'disabled' : 'unknown',
        last_error: null,
        tools_count: 0,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toMcpServer(row);
  }

  update(id: string, patch: McpServerUpdate): McpServer | null {
    const existing = this.get(id);
    if (!existing) return null;
    const nextEnabled = patch.enabled ?? existing.enabled;
    const row = this.db
      .update(mcp_servers)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.command !== undefined && { command: patch.command }),
        ...(patch.args !== undefined && { args: JSON.stringify(patch.args) }),
        ...(patch.env !== undefined && { env: JSON.stringify(patch.env) }),
        ...(patch.enabled !== undefined && {
          enabled: patch.enabled,
          health_status: patch.enabled ? 'unknown' : 'disabled',
          last_error: patch.enabled ? null : existing.last_error,
        }),
        ...(patch.command !== undefined || patch.args !== undefined || patch.env !== undefined
          ? { health_status: nextEnabled ? 'unknown' : 'disabled', last_error: null, tools_count: 0 }
          : {}),
        updated_at: Date.now(),
      })
      .where(eq(mcp_servers.id, id))
      .returning()
      .get();
    return row ? toMcpServer(row) : null;
  }

  setHealth(
    id: string,
    input: { health_status: McpServer['health_status']; last_error?: string | null; tools_count?: number },
  ): McpServer | null {
    const row = this.db
      .update(mcp_servers)
      .set({
        health_status: input.health_status,
        last_error: input.last_error ?? null,
        ...(input.tools_count !== undefined && { tools_count: input.tools_count }),
        updated_at: Date.now(),
      })
      .where(eq(mcp_servers.id, id))
      .returning()
      .get();
    return row ? toMcpServer(row) : null;
  }

  delete(id: string): boolean {
    const res = this.db.delete(mcp_servers).where(eq(mcp_servers.id, id)).run();
    return res.changes > 0;
  }
}

export class PromptTemplatesRepo {
  constructor(private db: Db) {}

  list(): PromptTemplate[] {
    return this.db
      .select()
      .from(prompt_templates)
      .orderBy(asc(prompt_templates.updated_at), asc(prompt_templates.created_at))
      .all()
      .reverse()
      .map(toPromptTemplate);
  }

  get(id: string): PromptTemplate | null {
    const row = this.db
      .select()
      .from(prompt_templates)
      .where(eq(prompt_templates.id, id))
      .get();
    return row ? toPromptTemplate(row) : null;
  }

  create(input: PromptTemplateCreate): PromptTemplate {
    const now = Date.now();
    const row = this.db
      .insert(prompt_templates)
      .values({
        id: makeId('prompt_template'),
        name: input.name,
        description: input.description ?? null,
        content: input.content,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toPromptTemplate(row);
  }

  update(id: string, patch: PromptTemplateUpdate): PromptTemplate | null {
    const row = this.db
      .update(prompt_templates)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.description !== undefined && {
          description: patch.description ?? null,
        }),
        ...(patch.content !== undefined && { content: patch.content }),
        updated_at: Date.now(),
      })
      .where(eq(prompt_templates.id, id))
      .returning()
      .get();
    return row ? toPromptTemplate(row) : null;
  }

  delete(id: string): boolean {
    const res = this.db
      .delete(prompt_templates)
      .where(eq(prompt_templates.id, id))
      .run();
    return res.changes > 0;
  }
}

export class PersonasRepo {
  constructor(private db: Db) {}

  list(): Persona[] {
    return this.db
      .select()
      .from(personas)
      .orderBy(asc(personas.updated_at), asc(personas.created_at))
      .all()
      .reverse()
      .map(toPersona);
  }

  get(id: string): Persona | null {
    const row = this.db.select().from(personas).where(eq(personas.id, id)).get();
    return row ? toPersona(row) : null;
  }

  create(input: PersonaCreate): Persona {
    const now = Date.now();
    const row = this.db
      .insert(personas)
      .values({
        id: makeId('persona'),
        name: input.name,
        description: input.description ?? null,
        prompt: input.prompt,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toPersona(row);
  }

  update(id: string, patch: PersonaUpdate): Persona | null {
    const row = this.db
      .update(personas)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.description !== undefined && {
          description: patch.description ?? null,
        }),
        ...(patch.prompt !== undefined && { prompt: patch.prompt }),
        updated_at: Date.now(),
      })
      .where(eq(personas.id, id))
      .returning()
      .get();
    return row ? toPersona(row) : null;
  }

  delete(id: string): boolean {
    const res = this.db.delete(personas).where(eq(personas.id, id)).run();
    return res.changes > 0;
  }
}

export class WorkflowRecipesRepo {
  constructor(private db: Db) {}

  list(opts: { enabledOnly?: boolean } = {}): WorkflowRecipe[] {
    const rows = this.db
      .select()
      .from(workflow_recipes)
      .where(opts.enabledOnly ? eq(workflow_recipes.enabled, true) : undefined)
      .orderBy(asc(workflow_recipes.updated_at), asc(workflow_recipes.created_at))
      .all()
      .reverse() as WorkflowRecipeRow[];
    return rows.map(toWorkflowRecipe);
  }

  get(id: string): WorkflowRecipe | null {
    const row = this.db
      .select()
      .from(workflow_recipes)
      .where(eq(workflow_recipes.id, id))
      .get() as WorkflowRecipeRow | undefined;
    return row ? toWorkflowRecipe(row) : null;
  }

  create(input: WorkflowRecipeCreate): WorkflowRecipe {
    const now = Date.now();
    const spec = WorkflowRecipeSpecSchema.parse({
      ...input.spec,
      name: input.spec.name || input.name,
      description: input.spec.description ?? input.description ?? null,
    });
    const row = this.db
      .insert(workflow_recipes)
      .values({
        id: makeId('workflow_recipe'),
        name: input.name,
        description: input.description ?? null,
        schema_version: 1,
        spec_json: JSON.stringify(spec),
        enabled: input.enabled ?? true,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get() as WorkflowRecipeRow;
    return toWorkflowRecipe(row);
  }

  update(id: string, patch: WorkflowRecipeUpdate): WorkflowRecipe | null {
    const current = this.get(id);
    if (!current) return null;
    const spec = patch.spec
      ? WorkflowRecipeSpecSchema.parse({
          ...patch.spec,
          name: patch.spec.name || patch.name || current.name,
          description: patch.spec.description ?? patch.description ?? current.description,
        })
      : undefined;
    const row = this.db
      .update(workflow_recipes)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.description !== undefined && { description: patch.description ?? null }),
        ...(spec !== undefined && { spec_json: JSON.stringify(spec) }),
        ...(patch.enabled !== undefined && { enabled: patch.enabled }),
        updated_at: Date.now(),
      })
      .where(eq(workflow_recipes.id, id))
      .returning()
      .get() as WorkflowRecipeRow | undefined;
    return row ? toWorkflowRecipe(row) : null;
  }

  delete(id: string): boolean {
    const res = this.db.delete(workflow_recipes).where(eq(workflow_recipes.id, id)).run();
    return res.changes > 0;
  }
}

export interface ResearchSessionPatch {
  conversation_id?: string | null;
  title?: string;
  objective?: string;
  output_kind?: ResearchOutputKind;
  status?: ResearchStatus;
  stage?: ResearchStage;
  budget_mode?: ResearchBudgetMode;
  budget_limit_usd?: number | null;
  budget_spent_usd?: number;
  constraints?: ResearchConstraints;
  plan?: ResearchPlan | null;
  draft_markdown?: string | null;
  final_markdown?: string | null;
  started_at?: number | null;
  completed_at?: number | null;
}

export interface ResearchTaskSeed {
  parent_task_id?: string | null;
  kind: ResearchTaskKind;
  status?: ResearchTaskStatus;
  title: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  started_at?: number | null;
  finished_at?: number | null;
}

export class ResearchRepo {
  constructor(private db: Db) {}

  list(limit = 50): ResearchSession[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.db
      .select()
      .from(research_sessions)
      .orderBy(desc(research_sessions.updated_at), desc(research_sessions.created_at))
      .limit(safeLimit)
      .all()
      .map(toResearchSession);
  }

  get(id: string): ResearchSession | null {
    const row = this.db
      .select()
      .from(research_sessions)
      .where(eq(research_sessions.id, id))
      .get();
    return row ? toResearchSession(row) : null;
  }

  getDetail(id: string): ResearchSessionDetail | null {
    const session = this.get(id);
    if (!session) return null;
    return {
      session,
      tasks: this.listTasks(id),
      sources: this.listSources(id),
      claims: this.listClaims(id),
    };
  }

  listTasks(sessionId: string): ResearchTask[] {
    return this.db
      .select()
      .from(research_tasks)
      .where(eq(research_tasks.research_session_id, sessionId))
      .orderBy(asc(research_tasks.created_at))
      .all()
      .map(toResearchTask);
  }

  listSources(sessionId: string): ResearchSource[] {
    return this.db
      .select()
      .from(research_sources)
      .where(eq(research_sources.research_session_id, sessionId))
      .orderBy(desc(research_sources.created_at))
      .all()
      .map(toResearchSource);
  }

  listClaims(sessionId: string): ResearchClaim[] {
    return this.db
      .select()
      .from(research_claims)
      .where(eq(research_claims.research_session_id, sessionId))
      .orderBy(desc(research_claims.updated_at))
      .all()
      .map(toResearchClaim);
  }

  create(input: ResearchSessionCreate): ResearchSession {
    const now = Date.now();
    const row = this.db
      .insert(research_sessions)
      .values({
        id: makeId('research_session'),
        conversation_id: input.conversation_id ?? null,
        title: input.title,
        objective: input.objective,
        output_kind: input.output_kind,
        status: 'draft',
        stage: 'scoping',
        budget_mode: input.budget_mode,
        budget_limit_usd: input.budget_limit_usd ?? null,
        budget_spent_usd: 0,
        constraints_json: JSON.stringify(ResearchConstraintsSchema.parse(input.constraints ?? {})),
        plan_json: null,
        draft_markdown: null,
        final_markdown: null,
        started_at: null,
        completed_at: null,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toResearchSession(row);
  }

  update(id: string, patch: ResearchSessionPatch): ResearchSession | null {
    const row = this.db
      .update(research_sessions)
      .set({
        ...(patch.conversation_id !== undefined && { conversation_id: patch.conversation_id }),
        ...(patch.title !== undefined && { title: patch.title }),
        ...(patch.objective !== undefined && { objective: patch.objective }),
        ...(patch.output_kind !== undefined && { output_kind: patch.output_kind }),
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.stage !== undefined && { stage: patch.stage }),
        ...(patch.budget_mode !== undefined && { budget_mode: patch.budget_mode }),
        ...(patch.budget_limit_usd !== undefined && { budget_limit_usd: patch.budget_limit_usd }),
        ...(patch.budget_spent_usd !== undefined && { budget_spent_usd: patch.budget_spent_usd }),
        ...(patch.constraints !== undefined && {
          constraints_json: JSON.stringify(ResearchConstraintsSchema.parse(patch.constraints)),
        }),
        ...(patch.plan !== undefined && {
          plan_json: patch.plan ? JSON.stringify(ResearchPlanSchema.parse(patch.plan)) : null,
        }),
        ...(patch.draft_markdown !== undefined && { draft_markdown: patch.draft_markdown }),
        ...(patch.final_markdown !== undefined && { final_markdown: patch.final_markdown }),
        ...(patch.started_at !== undefined && { started_at: patch.started_at }),
        ...(patch.completed_at !== undefined && { completed_at: patch.completed_at }),
        updated_at: Date.now(),
      })
      .where(eq(research_sessions.id, id))
      .returning()
      .get();
    return row ? toResearchSession(row) : null;
  }

  getTask(taskId: string): ResearchTask | null {
    const row = this.db
      .select()
      .from(research_tasks)
      .where(eq(research_tasks.id, taskId))
      .get() as ResearchTaskRow | undefined;
    return row ? toResearchTask(row) : null;
  }

  updateTask(
    taskId: string,
    patch: {
      status?: ResearchTaskStatus;
      output?: Record<string, unknown> | null;
      error?: Record<string, unknown> | null;
      started_at?: number | null;
      finished_at?: number | null;
    },
  ): ResearchTask | null {
    const row = this.db
      .update(research_tasks)
      .set({
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.output !== undefined && {
          output_json: patch.output ? JSON.stringify(patch.output) : null,
        }),
        ...(patch.error !== undefined && {
          error_json: patch.error ? JSON.stringify(patch.error) : null,
        }),
        ...(patch.started_at !== undefined && { started_at: patch.started_at }),
        ...(patch.finished_at !== undefined && { finished_at: patch.finished_at }),
        updated_at: Date.now(),
      })
      .where(eq(research_tasks.id, taskId))
      .returning()
      .get() as ResearchTaskRow | undefined;
    return row ? toResearchTask(row) : null;
  }

  appendSource(
    sessionId: string,
    source: Omit<ResearchSource, 'id' | 'research_session_id' | 'created_at'>,
  ): ResearchSource {
    const row = this.db
      .insert(research_sources)
      .values({
        id: makeId('research_source'),
        research_session_id: sessionId,
        source_type: source.source_type,
        title: source.title,
        locator: source.locator,
        snippet: source.snippet,
        credibility_score: source.credibility_score,
        included: source.included,
        metadata_json: JSON.stringify(source.metadata ?? {}),
        created_at: Date.now(),
      })
      .returning()
      .get() as ResearchSourceRow;
    return toResearchSource(row);
  }

  findSourceByLocator(sessionId: string, locator: string): ResearchSource | null {
    const row = this.db
      .select()
      .from(research_sources)
      .where(
        and(
          eq(research_sources.research_session_id, sessionId),
          eq(research_sources.locator, locator),
        ),
      )
      .get() as ResearchSourceRow | undefined;
    return row ? toResearchSource(row) : null;
  }

  updateSource(
    sourceId: string,
    patch: { title?: string | null; snippet?: string | null; credibility_score?: number | null; metadata?: Record<string, unknown> },
  ): ResearchSource | null {
    const row = this.db
      .update(research_sources)
      .set({
        ...(patch.title !== undefined && { title: patch.title }),
        ...(patch.snippet !== undefined && { snippet: patch.snippet }),
        ...(patch.credibility_score !== undefined && { credibility_score: patch.credibility_score }),
        ...(patch.metadata !== undefined && { metadata_json: JSON.stringify(patch.metadata) }),
      })
      .where(eq(research_sources.id, sourceId))
      .returning()
      .get() as ResearchSourceRow | undefined;
    return row ? toResearchSource(row) : null;
  }

  appendClaim(
    sessionId: string,
    claim: Omit<ResearchClaim, 'id' | 'research_session_id' | 'created_at' | 'updated_at'>,
  ): ResearchClaim {
    const now = Date.now();
    const row = this.db
      .insert(research_claims)
      .values({
        id: makeId('research_claim'),
        research_session_id: sessionId,
        section_key: claim.section_key,
        claim_text: claim.claim_text,
        claim_kind: claim.claim_kind,
        support_status: claim.support_status,
        citations_json: JSON.stringify(claim.citations ?? []),
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get() as ResearchClaimRow;
    return toResearchClaim(row);
  }

  replaceTasks(sessionId: string, tasks: ResearchTaskSeed[]): ResearchTask[] {
    return this.db.transaction((tx) => {
      tx.delete(research_tasks).where(eq(research_tasks.research_session_id, sessionId)).run();
      const now = Date.now();
      const rows: ResearchTaskRow[] = [];
      for (const task of tasks) {
        const row = tx
          .insert(research_tasks)
          .values({
            id: makeId('research_task'),
            research_session_id: sessionId,
            parent_task_id: task.parent_task_id ?? null,
            kind: task.kind,
            status: task.status ?? 'queued',
            title: task.title,
            input_json: JSON.stringify(task.input),
            output_json: task.output ? JSON.stringify(task.output) : null,
            error_json: task.error ? JSON.stringify(task.error) : null,
            started_at: task.started_at ?? null,
            finished_at: task.finished_at ?? null,
            created_at: now,
            updated_at: now,
          })
          .returning()
          .get() as ResearchTaskRow;
        rows.push(row);
      }
      return rows.map(toResearchTask);
    });
  }

  replaceSources(sessionId: string, sources: Array<Omit<ResearchSource, 'id' | 'research_session_id' | 'created_at'>>): ResearchSource[] {
    return this.db.transaction((tx) => {
      tx.delete(research_sources).where(eq(research_sources.research_session_id, sessionId)).run();
      const now = Date.now();
      const rows: ResearchSourceRow[] = [];
      for (const source of sources) {
        const row = tx
          .insert(research_sources)
          .values({
            id: makeId('research_source'),
            research_session_id: sessionId,
            source_type: source.source_type,
            title: source.title,
            locator: source.locator,
            snippet: source.snippet,
            credibility_score: source.credibility_score,
            included: source.included,
            metadata_json: JSON.stringify(source.metadata),
            created_at: now,
          })
          .returning()
          .get() as ResearchSourceRow;
        rows.push(row);
      }
      return rows.map(toResearchSource);
    });
  }

  replaceClaims(sessionId: string, claims: Array<Omit<ResearchClaim, 'id' | 'research_session_id' | 'created_at' | 'updated_at'>>): ResearchClaim[] {
    return this.db.transaction((tx) => {
      tx.delete(research_claims).where(eq(research_claims.research_session_id, sessionId)).run();
      const now = Date.now();
      const rows: ResearchClaimRow[] = [];
      for (const claim of claims) {
        const row = tx
          .insert(research_claims)
          .values({
            id: makeId('research_claim'),
            research_session_id: sessionId,
            section_key: claim.section_key,
            claim_text: claim.claim_text,
            claim_kind: claim.claim_kind,
            support_status: claim.support_status,
            citations_json: JSON.stringify(claim.citations),
            created_at: now,
            updated_at: now,
          })
          .returning()
          .get() as ResearchClaimRow;
        rows.push(row);
      }
      return rows.map(toResearchClaim);
    });
  }

  exportSession(id: string, req: ResearchSessionExportRequest): ResearchSessionExport | null {
    const detail = this.getDetail(id);
    if (!detail) return null;
    if (req.format === 'markdown') {
      const lines = [
        `# ${detail.session.title}`,
        '',
        `- 状态：${detail.session.status}`,
        `- 阶段：${detail.session.stage}`,
        `- 产出：${detail.session.output_kind}`,
        `- 预算：${detail.session.budget_mode}${detail.session.budget_limit_usd != null ? ` / ${detail.session.budget_limit_usd} USD` : ''}`,
        '',
        '## 研究目标',
        '',
        detail.session.objective,
      ];
      if (detail.session.plan) {
        lines.push(
          '',
          '## 研究计划',
          '',
          detail.session.plan.summary,
          '',
          '### 关键问题',
          '',
          ...detail.session.plan.key_questions.map((item: ResearchPlan['key_questions'][number]) => `- ${item.question}：${item.reason}`),
          '',
          '### 阶段',
          '',
          ...detail.session.plan.stages.map((item: ResearchPlan['stages'][number], index: number) => `${index + 1}. ${item.title} — ${item.objective}（产物：${item.deliverable}）`),
        );
      }
      if (detail.tasks.length > 0) {
        lines.push('', '## 待办任务', '', ...detail.tasks.map((task: ResearchTask) => `- [${task.status}] ${task.title}`));
      }
      lines.push(
        '',
        '## 当前草稿',
        '',
        detail.session.final_markdown ?? detail.session.draft_markdown ?? '（尚未生成草稿）',
      );
      return {
        filename: `taori-research-${detail.session.id}.md`,
        content_type: 'text/markdown; charset=utf-8',
        content: `${lines.join('\n').trim()}\n`,
      };
    }
    return {
      filename: `taori-research-${detail.session.id}.json`,
      content_type: 'application/json; charset=utf-8',
      content: JSON.stringify(detail, null, 2),
    };
  }
}

export interface ConversationRow {
  id: string;
  type: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  archived: boolean;
  pinned: boolean;
  tags: string | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string | null;
  model_id: string | null;
  parent_message_id: string | null;
  attachments: string | null;
  status: 'pending' | 'streaming' | 'complete' | 'incomplete' | 'failed';
  error: string | null;
  created_at: number;
}

export class ConversationsRepo {
  constructor(private db: Db) {}

  get(id: string): ConversationRow | null {
    const row = this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .get();
    return row ?? null;
  }

  /** List non-archived chats. Pinned conversations float to the top, then
   *  ordered by updated_at desc. Optional `q` filters by title (case-insensitive)
   *  and message content (LIKE on the messages table — best-effort, indexed
   *  on conversation_id only).
   */
  list(opts: { q?: string } = {}): ConversationRow[] {
    const q = opts.q?.trim();
    if (!q) {
      return this.db
        .select()
        .from(conversations)
        .where(eq(conversations.archived, false))
        .orderBy(sql`pinned DESC, updated_at DESC`)
        .all() as ConversationRow[];
    }
    // Two-stage: a) title LIKE; b) any message content LIKE → union by id.
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const rows = this.db
      .all(
        sql`SELECT c.* FROM conversations c
            WHERE c.archived = 0
              AND (
                COALESCE(c.title,'') LIKE ${like} ESCAPE '\\'
                OR EXISTS (
                  SELECT 1 FROM messages m
                  WHERE m.conversation_id = c.id
                    AND COALESCE(m.content,'') LIKE ${like} ESCAPE '\\'
                )
              )
            ORDER BY c.pinned DESC, c.updated_at DESC`,
      ) as ConversationRow[];
    return rows;
  }

  setPinned(id: string, pinned: boolean): ConversationRow | null {
    const row = this.db
      .update(conversations)
      .set({ pinned, updated_at: Date.now() })
      .where(eq(conversations.id, id))
      .returning()
      .get();
    return (row as ConversationRow | undefined) ?? null;
  }

  setTags(id: string, tags: string[]): ConversationRow | null {
    const cleaned = tags
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t.length <= 24)
      .slice(0, 3);
    const value = cleaned.length === 0 ? null : JSON.stringify(cleaned);
    const row = this.db
      .update(conversations)
      .set({ tags: value, updated_at: Date.now() })
      .where(eq(conversations.id, id))
      .returning()
      .get();
    return (row as ConversationRow | undefined) ?? null;
  }

  /** Update title (used by both auto-title and rename). Returns updated row or null. */
  rename(id: string, title: string | null): ConversationRow | null {
    const row = this.db
      .update(conversations)
      .set({ title, updated_at: Date.now() })
      .where(eq(conversations.id, id))
      .returning()
      .get();
    return (row as ConversationRow | undefined) ?? null;
  }

  setArchived(id: string, archived: boolean): ConversationRow | null {
    const row = this.db
      .update(conversations)
      .set({ archived, updated_at: Date.now() })
      .where(eq(conversations.id, id))
      .returning()
      .get();
    return (row as ConversationRow | undefined) ?? null;
  }

  /** Hard delete: drops messages + cost rows via FK cascades / app-level cleanup. */
  delete(id: string): boolean {
    const res = this.db.delete(conversations).where(eq(conversations.id, id)).run();
    return res.changes > 0;
  }

  /** Insert a fresh conversation; returns the row. */
  create(opts: { id?: string; title?: string | null; type?: 'chat' | 'roundtable' } = {}): ConversationRow {
    const now = Date.now();
    const id = opts.id ?? makeId('conversation');
    const row = this.db
      .insert(conversations)
      .values({
        id,
        type: opts.type ?? 'chat',
        title: opts.title ?? null,
        created_at: now,
        updated_at: now,
        archived: false,
      })
      .returning()
      .get();
    return row;
  }

  /** Idempotent: if id exists, returns it; otherwise creates a fresh row. */
  ensure(id: string | undefined, opts: { type?: 'chat' | 'roundtable' } = {}): ConversationRow {
    if (id) {
      const existing = this.get(id);
      if (existing) return existing;
      return this.create({ id, type: opts.type });
    }
    return this.create({ type: opts.type });
  }

  touch(id: string): void {
    this.db
      .update(conversations)
      .set({ updated_at: Date.now() })
      .where(eq(conversations.id, id))
      .run();
  }
}

export class MessagesRepo {
  constructor(private db: Db) {}

  listByConversation(conversationId: string): MessageRow[] {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversation_id, conversationId))
      .orderBy(asc(messages.created_at))
      .all() as MessageRow[];
  }

  get(id: string): MessageRow | null {
    const row = this.db
      .select()
      .from(messages)
      .where(eq(messages.id, id))
      .get();
    return row ? (row as MessageRow) : null;
  }

  insert(input: {
    id?: string;
    conversation_id: string;
    role: 'user' | 'assistant' | 'system';
    content: string | null;
    model_id?: string | null;
    parent_message_id?: string | null;
    status?: MessageRow['status'];
    attachments?: string | null;
  }): MessageRow {
    const id = input.id ?? makeId('message');
    const row = this.db
      .insert(messages)
      .values({
        id,
        conversation_id: input.conversation_id,
        role: input.role,
        content: input.content,
        model_id: input.model_id ?? null,
        parent_message_id: input.parent_message_id ?? null,
        attachments: input.attachments ?? null,
        status: input.status ?? 'pending',
        error: null,
        created_at: Date.now(),
      })
      .returning()
      .get();
    return row as MessageRow;
  }

  /** Update content + status atomically (used at end of streaming). */
  finalize(
    id: string,
    patch: { content: string; status: MessageRow['status']; error?: string | null },
  ): void {
    this.db
      .update(messages)
      .set({
        content: patch.content,
        status: patch.status,
        error: patch.error ?? null,
      })
      .where(eq(messages.id, id))
      .run();
  }

  updateAttachments(id: string, attachments: string | null): void {
    this.db
      .update(messages)
      .set({ attachments })
      .where(eq(messages.id, id))
      .run();
  }

  /** C1 — fetch a single message row by id (or null if missing). */
  getById(id: string): MessageRow | null {
    const row = this.db
      .select()
      .from(messages)
      .where(eq(messages.id, id))
      .get();
    return (row as MessageRow | undefined) ?? null;
  }

  /**
   * C1 — patch a user message's content and discard everything that came
   * after it in the same conversation. Returns the updated row, or null if
   * the id was not found.
   */
  editAndTruncate(id: string, content: string): MessageRow | null {
    const target = this.getById(id);
    if (!target) return null;
    this.db
      .delete(messages)
      .where(
        sql`${messages.conversation_id} = ${target.conversation_id} AND ${messages.created_at} > ${target.created_at}`,
      )
      .run();
    const updated = this.db
      .update(messages)
      .set({ content, status: 'complete', error: null })
      .where(eq(messages.id, id))
      .returning()
      .get();
    return (updated as MessageRow | undefined) ?? null;
  }

  /**
   * C1 — copy every message in the source conversation up to AND INCLUDING
   * the given message into a freshly minted target conversation. Used by
   * the "branch" action so the user can fork a conversation without
   * disturbing the original.
   */
  cloneUpTo(sourceMessageId: string, targetConversationId: string): number {
    const target = this.getById(sourceMessageId);
    if (!target) return 0;
    const rows = this.db
      .select()
      .from(messages)
      .where(
        sql`${messages.conversation_id} = ${target.conversation_id} AND ${messages.created_at} <= ${target.created_at}`,
      )
      .orderBy(asc(messages.created_at))
      .all() as MessageRow[];
    let count = 0;
    let now = Date.now();
    for (const r of rows) {
      this.db
        .insert(messages)
        .values({
          id: makeId('message'),
          conversation_id: targetConversationId,
          role: r.role,
          content: r.content,
          model_id: r.model_id,
          parent_message_id: null,
          attachments: r.attachments,
          status: r.status,
          error: r.error,
          created_at: now++,
        })
        .run();
      count += 1;
    }
    return count;
  }
}

export interface RunEventInsert {
  run_id: string;
  conversation_id?: string | null;
  message_id?: string | null;
  kind: RunEventKind;
  status: RunEventStatus;
  label: string;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface QuickCompareRunCreate {
  conversation_id: string;
  source_user_message_id?: string | null;
  run_id: string;
  model_ids: string[];
  status?: QuickCompareStatus;
}

export interface QuickCompareOutputCreate {
  compare_id: string;
  participant_index: number;
  model_id: string;
  provider_id?: string | null;
  tool_names?: string[];
  status?: QuickCompareOutputStatus;
}

export interface QuickCompareOutputPatch {
  tool_names?: string[];
  content?: string;
  status?: QuickCompareOutputStatus;
  error_classification?: QuickCompareOutput['error_classification'];
  error_message?: string | null;
  cost_record_id?: string | null;
  first_token_ms?: number | null;
  duration_ms?: number | null;
}

export class QuickCompareRepo {
  constructor(private db: Db) {}

  createRun(input: QuickCompareRunCreate): QuickCompareRun {
    const now = Date.now();
    const row = this.db
      .insert(quick_compare_runs)
      .values({
        id: makeId('quick_compare'),
        conversation_id: input.conversation_id,
        source_user_message_id: input.source_user_message_id ?? null,
        run_id: input.run_id,
        status: input.status ?? 'running',
        model_ids: JSON.stringify(input.model_ids),
        adopted_output_id: null,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toQuickCompareRun(row);
  }

  getRun(id: string): QuickCompareRun | null {
    const row = this.db
      .select()
      .from(quick_compare_runs)
      .where(eq(quick_compare_runs.id, id))
      .get();
    return row ? toQuickCompareRun(row) : null;
  }

  listRunsByConversation(conversationId: string, limit = 20): QuickCompareRun[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.db
      .select()
      .from(quick_compare_runs)
      .where(eq(quick_compare_runs.conversation_id, conversationId))
      .orderBy(desc(quick_compare_runs.updated_at))
      .limit(safeLimit)
      .all()
      .map(toQuickCompareRun);
  }

  updateRunStatus(id: string, status: QuickCompareStatus): QuickCompareRun | null {
    const row = this.db
      .update(quick_compare_runs)
      .set({ status, updated_at: Date.now() })
      .where(eq(quick_compare_runs.id, id))
      .returning()
      .get();
    return row ? toQuickCompareRun(row) : null;
  }

  markAdopted(compareId: string, outputId: string): QuickCompareRun | null {
    const row = this.db
      .update(quick_compare_runs)
      .set({ adopted_output_id: outputId, updated_at: Date.now() })
      .where(eq(quick_compare_runs.id, compareId))
      .returning()
      .get();
    return row ? toQuickCompareRun(row) : null;
  }

  createOutput(input: QuickCompareOutputCreate): QuickCompareOutput {
    const now = Date.now();
    const row = this.db
      .insert(quick_compare_outputs)
      .values({
        id: makeId('quick_compare_output'),
        compare_id: input.compare_id,
        participant_index: input.participant_index,
        model_id: input.model_id,
        provider_id: input.provider_id ?? null,
        tool_names: JSON.stringify(input.tool_names ?? []),
        content: '',
        status: input.status ?? 'pending',
        error_classification: null,
        error_message: null,
        cost_record_id: null,
        first_token_ms: null,
        duration_ms: null,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toQuickCompareOutput(row);
  }

  getOutput(id: string): QuickCompareOutput | null {
    const row = this.db
      .select()
      .from(quick_compare_outputs)
      .where(eq(quick_compare_outputs.id, id))
      .get();
    return row ? toQuickCompareOutput(row) : null;
  }

  listOutputs(compareId: string): QuickCompareOutput[] {
    return this.db
      .select()
      .from(quick_compare_outputs)
      .where(eq(quick_compare_outputs.compare_id, compareId))
      .orderBy(asc(quick_compare_outputs.participant_index))
      .all()
      .map(toQuickCompareOutput);
  }

  patchOutput(id: string, patch: QuickCompareOutputPatch): QuickCompareOutput | null {
    const row = this.db
      .update(quick_compare_outputs)
      .set({
        ...(patch.tool_names !== undefined && { tool_names: JSON.stringify(patch.tool_names) }),
        ...(patch.content !== undefined && { content: patch.content }),
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.error_classification !== undefined && {
          error_classification: patch.error_classification,
        }),
        ...(patch.error_message !== undefined && { error_message: patch.error_message }),
        ...(patch.cost_record_id !== undefined && { cost_record_id: patch.cost_record_id }),
        ...(patch.first_token_ms !== undefined && { first_token_ms: patch.first_token_ms }),
        ...(patch.duration_ms !== undefined && { duration_ms: patch.duration_ms }),
        updated_at: Date.now(),
      })
      .where(eq(quick_compare_outputs.id, id))
      .returning()
      .get();
    return row ? toQuickCompareOutput(row) : null;
  }
}

export class RunEventsRepo {
  constructor(private db: Db) {}

  append(input: RunEventInsert): RunEvent {
    return this.db.transaction((tx) => {
      const row = tx
        .insert(run_events)
        .values({
          id: makeId('run_event'),
          run_id: input.run_id,
          conversation_id: input.conversation_id ?? null,
          message_id: input.message_id ?? null,
          kind: input.kind,
          status: input.status,
          label: input.label,
          summary: input.summary ?? null,
          payload: input.payload ? JSON.stringify(input.payload) : null,
          created_at: Date.now(),
        })
        .returning()
        .get();
      const event = toRunEvent(row);
      this.refreshRunHeader(input.run_id, tx);
      return event;
    });
  }

  private refreshRunHeader(runId: string, db: Db = this.db): AgentRun | null {
    const events = db
      .select()
      .from(run_events)
      .where(eq(run_events.run_id, runId))
      .orderBy(asc(run_events.created_at))
      .all()
      .map(toRunEvent);
    if (events.length === 0) return null;
    const run = deriveRun(events);
    db.insert(agent_runs)
      .values({
        id: run.id,
        conversation_id: run.conversation_id,
        parent_run_id: run.parent_run_id,
        kind: run.kind,
        status: run.status,
        model_id: run.model_id,
        user_message_id: run.user_message_id,
        assistant_message_id: run.assistant_message_id,
        recovery_policy: run.recovery_policy,
        event_count: run.event_count,
        created_at: run.created_at,
        updated_at: run.updated_at,
      })
      .onConflictDoUpdate({
        target: agent_runs.id,
        set: {
          conversation_id: run.conversation_id,
          parent_run_id: run.parent_run_id,
          kind: run.kind,
          status: run.status,
          model_id: run.model_id,
          user_message_id: run.user_message_id,
          assistant_message_id: run.assistant_message_id,
          recovery_policy: run.recovery_policy,
          event_count: run.event_count,
          created_at: run.created_at,
          updated_at: run.updated_at,
        },
      })
      .run();
    return run;
  }

  listByConversation(conversationId: string, limit = 100): RunEvent[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return this.db
      .select()
      .from(run_events)
      .where(eq(run_events.conversation_id, conversationId))
      .orderBy(desc(run_events.created_at))
      .limit(safeLimit)
      .all()
      .reverse()
      .map(toRunEvent);
  }

  listRunsByConversation(conversationId: string, limit = 20): AgentRun[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const materialized = this.db
      .select()
      .from(agent_runs)
      .where(eq(agent_runs.conversation_id, conversationId))
      .orderBy(desc(agent_runs.updated_at))
      .limit(safeLimit)
      .all()
      .map(toAgentRun);
    if (materialized.length > 0) {
      return materialized;
    }
    const rows = this.db
      .select()
      .from(run_events)
      .where(eq(run_events.conversation_id, conversationId))
      .orderBy(desc(run_events.created_at))
      .limit(1000)
      .all()
      .reverse()
      .map(toRunEvent);
    const grouped = new Map<string, RunEvent[]>();
    for (const event of rows) {
      const list = grouped.get(event.run_id) ?? [];
      list.push(event);
      grouped.set(event.run_id, list);
    }
    return [...grouped.values()]
      .map(deriveRun)
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, safeLimit);
  }

  listByRun(runId: string): RunEvent[] {
    return this.db
      .select()
      .from(run_events)
      .where(eq(run_events.run_id, runId))
      .orderBy(asc(run_events.created_at))
      .all()
      .map(toRunEvent);
  }
}

export interface CostInsert {
  conversation_id: string | null;
  source_type: 'message' | 'roundtable_message' | 'topic_analyzer' | 'summarizer' | 'tool_call' | 'quick_compare_output';
  source_id: string | null;
  feature: 'chat' | 'roundtable' | 'image' | 'tool_call' | 'quick_compare';
  model_id: string | null;
  model_name_snapshot: string;
  input_tokens: number | null;
  cache_input_tokens?: number | null;
  output_tokens: number | null;
  call_count?: number;
  price_input_per_1m_snapshot: number | null;
  price_output_per_1m_snapshot: number | null;
  price_per_call_snapshot: number | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  success: boolean;
  classification?: ErrorClassification | ToolErrorClassification | null;
  first_token_ms?: number | null;
  duration_ms: number | null;
}

export interface CostRecord extends CostInsert {
  id: string;
  call_count: number;
  created_at: number;
}

export interface CostCallLogRow {
  id: string;
  created_at: number;
  conversation_id: string | null;
  conversation_title: string | null;
  source_type: CostInsert['source_type'];
  source_id: string | null;
  feature: CostInsert['feature'];
  model_id: string | null;
  model_name_snapshot: string;
  provider_id: string | null;
  provider_name: string | null;
  provider_type: string | null;
  input_tokens: number | null;
  cache_input_tokens: number | null;
  output_tokens: number | null;
  actual_cost_usd: number | null;
  success: boolean;
  classification: ErrorClassification | ToolErrorClassification | null;
  first_token_ms: number | null;
  duration_ms: number | null;
  run_id: string | null;
  run_event_id: string | null;
  run_event_kind: RunEventKind | null;
  run_event_label: string | null;
}

export class CostsRepo {
  constructor(private db: Db) {}

  private startOfToday(now = new Date()): number {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }

  private startOfWeek(now = new Date()): number {
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - diff,
    ).getTime();
  }

  private startOfMonth(now = new Date()): number {
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  }

  private scopeStart(scope: 'session' | 'today' | 'week' | 'month'): number | null {
    if (scope === 'today') return this.startOfToday();
    if (scope === 'week') return this.startOfWeek();
    if (scope === 'month') return this.startOfMonth();
    return null;
  }

  private listWindowRows(
    scope: 'session' | 'today' | 'week' | 'month',
    conversationId: string | null,
  ): Array<{
    model_id: string | null;
    model_name_snapshot: string | null;
    feature: string;
    sum_usd: number;
    success: boolean;
    created_at: number;
    conversation_id: string | null;
    conversation_title: string | null;
    conversation_tags: string[];
  }> {
    if (scope === 'session' && !conversationId) return [];
    const clauses = [];
    const start = this.scopeStart(scope);
    if (start != null) clauses.push(sql`${cost_records.created_at} >= ${start}`);
    if (scope === 'session' && conversationId) {
      clauses.push(eq(cost_records.conversation_id, conversationId));
    }
    const query = this.db
      .select({
        model_id: cost_records.model_id,
        model_name_snapshot: cost_records.model_name_snapshot,
        feature: cost_records.feature,
        sum_usd: sql<number>`COALESCE(${cost_records.actual_cost_usd}, 0)`,
        success: cost_records.success,
        created_at: cost_records.created_at,
        conversation_id: cost_records.conversation_id,
        conversation_title: conversations.title,
        conversation_tags: conversations.tags,
      })
      .from(cost_records)
      .leftJoin(conversations, eq(cost_records.conversation_id, conversations.id))
      .orderBy(asc(cost_records.created_at));
    const rows = (clauses.length > 0 ? query.where(and(...clauses)) : query).all() as Array<{
      model_id: string | null;
      model_name_snapshot: string | null;
      feature: string;
      sum_usd: number;
      success: boolean;
      created_at: number;
      conversation_id: string | null;
      conversation_title: string | null;
      conversation_tags: string | null;
    }>;
    return rows.map((row) => ({
      ...row,
      conversation_tags: parseConversationTags(row.conversation_tags),
    }));
  }

  private makeTrendBuckets(
    scope: 'session' | 'today' | 'week' | 'month',
    rows: Array<{ created_at: number }>,
  ): Array<{ start: number; label: string }> {
    if (scope === 'today') {
      const now = new Date();
      const start = this.startOfToday(now);
      const currentHour = now.getHours();
      return Array.from({ length: currentHour + 1 }, (_, hour) => ({
        start: start + hour * 60 * 60 * 1000,
        label: `${String(hour).padStart(2, '0')}:00`,
      }));
    }
    const byDay = (startMs: number, count: number, label: (date: Date) => string) =>
      Array.from({ length: count }, (_, i) => {
        const date = new Date(startMs + i * 24 * 60 * 60 * 1000);
        return { start: date.getTime(), label: label(date) };
      });
    if (scope === 'week') {
      const now = new Date();
      const start = this.startOfWeek(now);
      const days = Math.floor((this.startOfToday(now) - start) / (24 * 60 * 60 * 1000)) + 1;
      return byDay(start, days, (date) => `${date.getMonth() + 1}/${date.getDate()}`);
    }
    if (scope === 'month') {
      const now = new Date();
      const start = this.startOfMonth(now);
      return byDay(start, now.getDate(), (date) => `${date.getDate()}`);
    }
    if (rows.length === 0) {
      const today = this.startOfToday();
      return [{ start: today, label: '今天' }];
    }
    const first = new Date(rows[0]!.created_at);
    const last = new Date(rows[rows.length - 1]!.created_at);
    const start = new Date(first.getFullYear(), first.getMonth(), first.getDate()).getTime();
    const end = new Date(last.getFullYear(), last.getMonth(), last.getDate()).getTime();
    const days = Math.max(1, Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1);
    return byDay(start, days, (date) => `${date.getMonth() + 1}/${date.getDate()}`);
  }

  private bucketStartForScope(
    scope: 'session' | 'today' | 'week' | 'month',
    createdAt: number,
  ): number {
    const date = new Date(createdAt);
    if (scope === 'today') {
      return new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        date.getHours(),
      ).getTime();
    }
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }

  insert(input: CostInsert): CostRecord {
    const id = makeId('cost');
    const now = Date.now();
    const row = this.db
      .insert(cost_records)
      .values({
        id,
        conversation_id: input.conversation_id,
        source_type: input.source_type,
        source_id: input.source_id,
        feature: input.feature,
        model_id: input.model_id,
        model_name_snapshot: input.model_name_snapshot,
        input_tokens: input.input_tokens,
        cache_input_tokens: input.cache_input_tokens ?? null,
        output_tokens: input.output_tokens,
        call_count: input.call_count ?? 1,
        price_input_per_1m_snapshot: input.price_input_per_1m_snapshot,
        price_output_per_1m_snapshot: input.price_output_per_1m_snapshot,
        price_per_call_snapshot: input.price_per_call_snapshot,
        estimated_cost_usd: input.estimated_cost_usd,
        actual_cost_usd: input.actual_cost_usd,
        success: input.success,
        classification: input.classification ?? null,
        first_token_ms: input.first_token_ms ?? null,
        duration_ms: input.duration_ms,
        created_at: now,
      })
      .returning()
      .get();
    return row as CostRecord;
  }

  /** Sum actual_cost_usd in a window. Nulls treated as 0. */
  sumSince(opts: { since?: number; conversationId?: string }): {
    total_usd: number;
    calls: number;
  } {
    const since = opts.since ?? 0;
    const where = opts.conversationId
      ? sql`created_at >= ${since} AND conversation_id = ${opts.conversationId}`
      : sql`created_at >= ${since}`;
    const row = this.db
      .select({
        total: sql<number>`COALESCE(SUM(actual_cost_usd), 0)`,
        calls: sql<number>`COUNT(*)`,
      })
      .from(cost_records)
      .where(where)
      .get();
    return { total_usd: row?.total ?? 0, calls: row?.calls ?? 0 };
  }

  /** Snapshot for the bottom status bar. */
  realtime(currentConversationId: string | null): {
    current_conversation_usd: number;
    current_conversation_calls: number;
    today_usd: number;
    month_usd: number;
  } {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const today = this.sumSince({ since: todayStart });
    const month = this.sumSince({ since: monthStart });
    const conv = currentConversationId
      ? this.sumSince({ conversationId: currentConversationId })
      : { total_usd: 0, calls: 0 };
    return {
      current_conversation_usd: conv.total_usd,
      current_conversation_calls: conv.calls,
      today_usd: today.total_usd,
      month_usd: month.total_usd,
    };
  }

  listByConversation(conversationId: string): CostRecord[] {
    return this.db
      .select()
      .from(cost_records)
      .where(eq(cost_records.conversation_id, conversationId))
      .orderBy(asc(cost_records.created_at))
      .all() as CostRecord[];
  }

  callLogs(opts: { limit?: number; costRecordId?: string } | number = 100): CostCallLogRow[] {
    const limit = typeof opts === 'number' ? opts : opts.limit ?? 100;
    const costRecordId = typeof opts === 'number' ? undefined : opts.costRecordId;
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const query = this.db
      .select({
        id: cost_records.id,
        created_at: cost_records.created_at,
        conversation_id: cost_records.conversation_id,
        conversation_title: conversations.title,
        source_type: cost_records.source_type,
        source_id: cost_records.source_id,
        feature: cost_records.feature,
        model_id: cost_records.model_id,
        model_name_snapshot: cost_records.model_name_snapshot,
        provider_id: providers.id,
        provider_name: providers.name,
        provider_type: providers.type,
        input_tokens: cost_records.input_tokens,
        cache_input_tokens: cost_records.cache_input_tokens,
        output_tokens: cost_records.output_tokens,
        actual_cost_usd: cost_records.actual_cost_usd,
        success: cost_records.success,
        classification: cost_records.classification,
        first_token_ms: cost_records.first_token_ms,
        duration_ms: cost_records.duration_ms,
      })
      .from(cost_records)
      .leftJoin(models, eq(cost_records.model_id, models.id))
      .leftJoin(providers, eq(models.provider_id, providers.id))
      .leftJoin(conversations, eq(cost_records.conversation_id, conversations.id))
      .where(costRecordId ? eq(cost_records.id, costRecordId) : undefined)
      .orderBy(desc(cost_records.created_at))
      .limit(costRecordId ? 1 : safeLimit);
    const rows = query.all() as Array<Omit<CostCallLogRow, 'run_id' | 'run_event_id' | 'run_event_kind' | 'run_event_label'>>;
    if (rows.length === 0) return [];

    const eventRows = this.db
      .select()
      .from(run_events)
      .where(eq(run_events.kind, 'cost.recorded'))
      .orderBy(desc(run_events.created_at))
      .limit(1000)
      .all()
      .map(toRunEvent);
    const byCostId = new Map<string, RunEvent>();
    const bySource = new Map<string, RunEvent>();
    for (const event of eventRows) {
      const costRecordId = payloadString(event, 'cost_record_id');
      if (costRecordId && !byCostId.has(costRecordId)) byCostId.set(costRecordId, event);
      if (event.message_id && !bySource.has(`message:${event.message_id}`)) {
        bySource.set(`message:${event.message_id}`, event);
      }
      if (event.message_id && !bySource.has(`tool_call:${event.message_id}`)) {
        bySource.set(`tool_call:${event.message_id}`, event);
      }
      const roundtableMessageId = payloadString(event, 'roundtable_message_id');
      if (roundtableMessageId && !bySource.has(`roundtable_message:${roundtableMessageId}`)) {
        bySource.set(`roundtable_message:${roundtableMessageId}`, event);
      }
      for (const sourceId of [
        payloadString(event, 'assistant_message_id'),
        payloadString(event, 'message_id'),
      ].filter((value): value is string => Boolean(value))) {
        if (!bySource.has(`message:${sourceId}`)) bySource.set(`message:${sourceId}`, event);
        if (!bySource.has(`tool_call:${sourceId}`)) bySource.set(`tool_call:${sourceId}`, event);
      }
    }

    return rows.map((row) => {
      const event =
        byCostId.get(row.id)
        ?? (row.source_id ? bySource.get(`${row.source_type}:${row.source_id}`) : undefined)
        ?? undefined;
      return {
        ...row,
        run_id: event?.run_id ?? null,
        run_event_id: event?.id ?? null,
        run_event_kind: event?.kind ?? null,
        run_event_label: event?.label ?? null,
      };
    });
  }

  modelHealth24h(): Map<string, ModelHealthRow> {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const bucketSizeMs = 3 * 60 * 60 * 1000;
    const bucketCount = 8;
    const bucketBase = Math.floor(since / bucketSizeMs) * bucketSizeMs;
    const makeEmptyTrend = () =>
      Array.from({ length: bucketCount }, (_, index) => ({
        bucket_start: bucketBase + index * bucketSizeMs,
        label: new Date(bucketBase + index * bucketSizeMs).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
        failures: 0,
        classifications: [] as Array<{
          classification: ErrorClassification;
          failures: number;
        }>,
      }));
    const rows = this.db
      .select({
        model_id: cost_records.model_id,
        success: cost_records.success,
        classification: cost_records.classification,
        first_token_ms: cost_records.first_token_ms,
        duration_ms: cost_records.duration_ms,
        created_at: cost_records.created_at,
      })
      .from(cost_records)
      .where(
        and(
          isNotNull(cost_records.model_id),
          sql`${cost_records.created_at} >= ${since}`,
        ),
      )
      .all() as Array<{
      model_id: string | null;
      success: boolean;
      classification: ErrorClassification | null;
      first_token_ms: number | null;
      duration_ms: number | null;
      created_at: number;
    }>;

    const grouped = new Map<
      string,
      ModelHealthRow & {
        firstTokenTotal: number;
        firstTokenCount: number;
        durationTotal: number;
        durationCount: number;
        failureDistribution: Map<ErrorClassification, number>;
        failureTrendMaps: Array<Map<ErrorClassification, number>>;
      }
    >();

    for (const row of rows) {
      if (!row.model_id) continue;
      const current = grouped.get(row.model_id) ?? {
        model_id: row.model_id,
        calls_24h: 0,
        failures_24h: 0,
        avg_first_token_ms: null,
        avg_duration_ms: null,
        last_failure_at: null,
        last_failure_classification: null,
        failure_distribution_24h: [],
        failure_trend_24h: makeEmptyTrend(),
        firstTokenTotal: 0,
        firstTokenCount: 0,
        durationTotal: 0,
        durationCount: 0,
        failureDistribution: new Map<ErrorClassification, number>(),
        failureTrendMaps: Array.from({ length: bucketCount }, () => new Map<ErrorClassification, number>()),
      };
      current.calls_24h += 1;
      if (!row.success) {
        current.failures_24h += 1;
        if (current.last_failure_at == null || row.created_at >= current.last_failure_at) {
          current.last_failure_at = row.created_at;
          current.last_failure_classification = row.classification ?? null;
        }
        if (row.classification) {
          current.failureDistribution.set(
            row.classification,
            (current.failureDistribution.get(row.classification) ?? 0) + 1,
          );
          const rawBucketIndex = Math.floor((row.created_at - bucketBase) / bucketSizeMs);
          const bucketIndex = Math.min(
            bucketCount - 1,
            Math.max(0, rawBucketIndex),
          );
          const trendBucket = current.failureTrendMaps[bucketIndex]!;
          trendBucket.set(
            row.classification,
            (trendBucket.get(row.classification) ?? 0) + 1,
          );
        }
      }
      if (typeof row.first_token_ms === 'number') {
        current.firstTokenTotal += row.first_token_ms;
        current.firstTokenCount += 1;
      }
      if (typeof row.duration_ms === 'number') {
        current.durationTotal += row.duration_ms;
        current.durationCount += 1;
      }
      grouped.set(row.model_id, current);
    }

    const out = new Map<string, ModelHealthRow>();
    for (const [modelId, row] of grouped.entries()) {
      const failure_distribution_24h = Array.from(row.failureDistribution.entries())
        .map(([classification, failures]) => ({ classification, failures }))
        .sort((a, b) => b.failures - a.failures);
      const failure_trend_24h = row.failure_trend_24h.map((bucket, index) => {
        const classifications = Array.from(row.failureTrendMaps[index]!.entries())
          .map(([classification, failures]) => ({ classification, failures }))
          .sort((a, b) => b.failures - a.failures);
        return {
          ...bucket,
          failures: classifications.reduce((sum, item) => sum + item.failures, 0),
          classifications,
        };
      });
      out.set(modelId, {
        model_id: row.model_id,
        calls_24h: row.calls_24h,
        failures_24h: row.failures_24h,
        avg_first_token_ms:
          row.firstTokenCount > 0 ? row.firstTokenTotal / row.firstTokenCount : null,
        avg_duration_ms:
          row.durationCount > 0 ? row.durationTotal / row.durationCount : null,
        last_failure_at: row.last_failure_at,
        last_failure_classification: row.last_failure_classification,
        failure_distribution_24h,
        failure_trend_24h,
      });
    }
    return out;
  }

  toolHealth24h(toolNames: string[]): Map<string, ToolHealthRow> {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const imageToolName = toolNames.includes('builtin.image_generate')
      ? 'builtin.image_generate'
      : null;
    const toolNameSet = new Set(toolNames);
    const rows = this.db
      .select({
        feature: cost_records.feature,
        model_name_snapshot: cost_records.model_name_snapshot,
        success: cost_records.success,
        classification: cost_records.classification,
        duration_ms: cost_records.duration_ms,
        created_at: cost_records.created_at,
      })
      .from(cost_records)
      .where(
        and(
          sql`${cost_records.source_type} = 'tool_call'`,
          sql`${cost_records.created_at} >= ${since}`,
        ),
      )
      .all() as Array<{
      feature: CostInsert['feature'];
      model_name_snapshot: string;
      success: boolean;
      classification: ToolErrorClassification | null;
      duration_ms: number | null;
      created_at: number;
    }>;

    const grouped = new Map<
      string,
      ToolHealthRow & {
        durationTotal: number;
        durationCount: number;
      }
    >();

    for (const row of rows) {
      const toolName =
        row.feature === 'image' && imageToolName
          ? imageToolName
          : row.model_name_snapshot;
      if (!toolNameSet.has(toolName)) continue;
      const current = grouped.get(toolName) ?? {
        tool_name: toolName,
        calls_24h: 0,
        failures_24h: 0,
        avg_duration_ms: null,
        last_failure_at: null,
        last_failure_classification: null,
        durationTotal: 0,
        durationCount: 0,
      };
      current.calls_24h += 1;
      if (!row.success) {
        current.failures_24h += 1;
        if (current.last_failure_at == null || row.created_at >= current.last_failure_at) {
          current.last_failure_at = row.created_at;
          current.last_failure_classification = row.classification ?? null;
        }
      }
      if (typeof row.duration_ms === 'number') {
        current.durationTotal += row.duration_ms;
        current.durationCount += 1;
      }
      grouped.set(toolName, current);
    }

    const out = new Map<string, ToolHealthRow>();
    for (const [toolName, row] of grouped.entries()) {
      out.set(toolName, {
        tool_name: toolName,
        calls_24h: row.calls_24h,
        failures_24h: row.failures_24h,
        avg_duration_ms:
          row.durationCount > 0 ? row.durationTotal / row.durationCount : null,
        last_failure_at: row.last_failure_at,
        last_failure_classification: row.last_failure_classification,
      });
    }
    return out;
  }

  /** For per-message display. */
  forMessage(messageId: string): CostRecord | null {
    const row = this.db
      .select()
      .from(cost_records)
      .where(sql`source_type = 'message' AND source_id = ${messageId}`)
      .get();
    return (row as CostRecord | undefined) ?? null;
  }

  /**
   * M3.A.3 — list every cost record tied to a roundtable (analyzer + each
   * participant message + summarizer). Filters by conversation + feature so
   * we don't accidentally pull in unrelated chat records.
   */
  listForRoundtable(args: {
    conversationId: string;
    roundtableId: string;
    messageIds: string[];
  }): CostRecord[] {
    const ids = new Set<string>([args.roundtableId, ...args.messageIds]);
    if (ids.size === 0) return [];
    const rows = this.db
      .select()
      .from(cost_records)
      .where(
        sql`conversation_id = ${args.conversationId} AND feature = 'roundtable'`,
      )
      .orderBy(asc(cost_records.created_at))
      .all() as CostRecord[];
    return rows.filter((r) => r.source_id !== null && ids.has(r.source_id));
  }

  /**
   * Pre-send estimate input (M1 §5.1): rolling average output_tokens for a
   * given model id. Limits the sample to the most recent 50 successful calls
   * to keep estimates responsive after price/behaviour changes. Returns
   * `sample_count` so the renderer can render "区间" when sample < 5.
   *
   * Implementation note: SQLite doesn't preserve LIMIT-in-IN-subquery
   * semantics for the outer aggregate, so we wrap the limited rows in a
   * derived table and AVG over that.
   */
  avgOutputTokens(modelId: string): { avg_output_tokens: number; sample_count: number } {
    // Limit to the most recent 50 successful samples per model. SQLite would
    // ignore an `IN (… LIMIT 50)` filter at AVG time, so we wrap the limited
    // rows in a derived table and aggregate over that.
    const rows = this.db
      .select({ output_tokens: cost_records.output_tokens })
      .from(cost_records)
      .where(
        sql`model_id = ${modelId} AND success = 1 AND output_tokens IS NOT NULL AND output_tokens > 0`,
      )
      .orderBy(sql`created_at DESC`)
      .limit(50)
      .all() as Array<{ output_tokens: number | null }>;
    if (rows.length === 0) return { avg_output_tokens: 0, sample_count: 0 };
    const sum = rows.reduce((s, r) => s + (r.output_tokens ?? 0), 0);
    return {
      avg_output_tokens: Math.round(sum / rows.length),
      sample_count: rows.length,
    };
  }

  /**
   * M2.2 §3.3 — per-scope, per-(model, feature) cost breakdown for the
   * session-cost panel.
   *
   * `scope` selects the time/conversation window:
   *   - `'session'` requires `conversationId` and filters that conversation
   *     (any time)
   *   - `'today'` filters `created_at` to the current local-day window
   *     (UTC for now; renderer treats these as "today")
   *   - `'month'` filters `created_at` to the current month
   *
   * Returns rows shaped `{model_id, model_name_snapshot, feature, sum_usd,
   * count, success_count, billed_failure_count}`. Rows where the model has
   * been deleted retain the snapshot name. The caller renders model + feature
   * subtotals per spec §3.3.
   */
  breakdown(
    scope: 'session' | 'today' | 'week' | 'month',
    conversationId: string | null,
  ): Array<{
    model_id: string | null;
    model_name_snapshot: string | null;
    feature: string;
    sum_usd: number;
    count: number;
    success_count: number;
    billed_failure_count: number;
  }> {
    const grouped = new Map<
      string,
      {
        model_id: string | null;
        model_name_snapshot: string | null;
        feature: string;
        sum_usd: number;
        count: number;
        success_count: number;
        billed_failure_count: number;
      }
    >();
    for (const row of this.listWindowRows(scope, conversationId)) {
      const key = `${row.model_id ?? 'null'}::${row.feature}`;
      const current = grouped.get(key) ?? {
        model_id: row.model_id,
        model_name_snapshot: row.model_name_snapshot,
        feature: row.feature,
        sum_usd: 0,
        count: 0,
        success_count: 0,
        billed_failure_count: 0,
      };
      current.sum_usd += row.sum_usd;
      current.count += 1;
      current.success_count += row.success ? 1 : 0;
      current.billed_failure_count += !row.success && row.sum_usd > 0 ? 1 : 0;
      grouped.set(key, current);
    }
    return Array.from(grouped.values()).sort((a, b) => b.sum_usd - a.sum_usd);
  }

  breakdownBy(
    scope: 'session' | 'today' | 'week' | 'month',
    groupBy: 'model' | 'conversation' | 'feature' | 'tag',
    conversationId: string | null,
  ): Array<{
    key: string;
    label: string;
    model_id: string | null;
    model_name_snapshot: string | null;
    conversation_id: string | null;
    conversation_title: string | null;
    feature: string | null;
    sum_usd: number;
    count: number;
    success_count: number;
    billed_failure_count: number;
    trend: Array<{ bucket_start: number; label: string; sum_usd: number; count: number }>;
  }> {
    const rows = this.listWindowRows(scope, conversationId);
    const buckets = this.makeTrendBuckets(scope, rows);
    const bucketTemplate = buckets.map((bucket) => ({
      bucket_start: bucket.start,
      label: bucket.label,
      sum_usd: 0,
      count: 0,
    }));
    const grouped = new Map<
      string,
      {
        key: string;
        label: string;
        model_id: string | null;
        model_name_snapshot: string | null;
        conversation_id: string | null;
        conversation_title: string | null;
        feature: string | null;
        sum_usd: number;
        count: number;
        success_count: number;
        billed_failure_count: number;
        trend: Array<{ bucket_start: number; label: string; sum_usd: number; count: number }>;
      }
    >();
    const bucketIndex = new Map<number, number>();
    for (let i = 0; i < buckets.length; i++) bucketIndex.set(buckets[i]!.start, i);

    for (const row of rows) {
      const bucketStart = this.bucketStartForScope(scope, row.created_at);
      const segments =
        groupBy === 'tag'
          ? (row.conversation_tags.length > 0 ? row.conversation_tags : ['未归档项目']).map((tag) => ({
              key: `tag:${tag}`,
              label: tag,
              modelId: null,
              modelNameSnapshot: null,
              feature: null,
              conversationId: null,
              conversationTitle: null,
              weight: 1 / (row.conversation_tags.length > 0 ? row.conversation_tags.length : 1),
            }))
          : [(() => {
              if (groupBy === 'model') {
                return {
                  key: row.model_id ?? `snapshot:${row.model_name_snapshot ?? 'deleted'}`,
                  label: row.model_name_snapshot ?? '(已删除模型)',
                  modelId: row.model_id,
                  modelNameSnapshot: row.model_name_snapshot,
                  feature: null,
                  conversationId: null,
                  conversationTitle: null,
                  weight: 1,
                };
              }
              if (groupBy === 'conversation') {
                return {
                  key: row.conversation_id ?? 'no-conversation',
                  label: row.conversation_title ?? (row.conversation_id ? '未命名会话' : '无会话归属'),
                  modelId: null,
                  modelNameSnapshot: null,
                  feature: null,
                  conversationId: row.conversation_id,
                  conversationTitle: row.conversation_title,
                  weight: 1,
                };
              }
              return {
                key: row.feature,
                label: row.feature,
                modelId: null,
                modelNameSnapshot: null,
                feature: row.feature,
                conversationId: null,
                conversationTitle: null,
                weight: 1,
              };
            })()];

      for (const segment of segments) {
        const current = grouped.get(segment.key) ?? {
          key: segment.key,
          label: segment.label,
          model_id: segment.modelId,
          model_name_snapshot: segment.modelNameSnapshot,
          conversation_id: segment.conversationId,
          conversation_title: segment.conversationTitle,
          feature: segment.feature,
          sum_usd: 0,
          count: 0,
          success_count: 0,
          billed_failure_count: 0,
          trend: bucketTemplate.map((bucket) => ({ ...bucket })),
        };
        current.sum_usd += row.sum_usd * segment.weight;
        current.count += segment.weight;
        current.success_count += row.success ? segment.weight : 0;
        current.billed_failure_count += !row.success && row.sum_usd > 0 ? segment.weight : 0;
        const idx = bucketIndex.get(bucketStart);
        if (idx != null) {
          current.trend[idx]!.sum_usd += row.sum_usd * segment.weight;
          current.trend[idx]!.count += segment.weight;
        }
        grouped.set(segment.key, current);
      }
    }
    return Array.from(grouped.values()).sort((a, b) => b.sum_usd - a.sum_usd);
  }
}

/**
 * Three-tier preference KV store (M2 §5.2). Lookup order:
 *   `getEffective(conv_id, key)` → session(conv_id) > global > null.
 * Per-key JSON encoding is the caller's responsibility; this repo treats
 * `value` as opaque text.
 */
export class MemoriesRepo {
  constructor(private db: Db) {}

  get(scope: 'global' | 'session' | 'user', scopeId: string | null, key: string): string | null {
    const row = this.db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.scope, scope),
          scopeId == null
            ? sql`${memories.scope_id} IS NULL`
            : eq(memories.scope_id, scopeId),
          eq(memories.key, key),
        ),
      )
      .get();
    return row ? row.value : null;
  }

  /**
   * Three-tier resolution: session-scoped value wins; falls back to global.
   * `scope_id=null` is reserved for global. Returns null when neither is set.
   */
  getEffective(conversationId: string | null, key: string): string | null {
    if (conversationId) {
      const sessionVal = this.get('session', conversationId, key);
      if (sessionVal !== null) return sessionVal;
    }
    return this.get('global', null, key);
  }

  set(scope: 'global' | 'session' | 'user', scopeId: string | null, key: string, value: string): void {
    const now = Date.now();
    const existing = this.get(scope, scopeId, key);
    if (existing !== null) {
      this.db
        .update(memories)
        .set({ value, updated_at: now })
        .where(
          and(
            eq(memories.scope, scope),
            scopeId == null
              ? sql`${memories.scope_id} IS NULL`
              : eq(memories.scope_id, scopeId),
            eq(memories.key, key),
          ),
        )
        .run();
      return;
    }
    this.db
      .insert(memories)
      .values({
        id: makeId('memory'),
        scope,
        scope_id: scopeId,
        key,
        value,
        created_at: now,
        updated_at: now,
      })
      .run();
  }

  delete(scope: 'global' | 'session' | 'user', scopeId: string | null, key: string): void {
    this.db
      .delete(memories)
      .where(
        and(
          eq(memories.scope, scope),
          scopeId == null
            ? sql`${memories.scope_id} IS NULL`
            : eq(memories.scope_id, scopeId),
          eq(memories.key, key),
        ),
      )
      .run();
  }
}

export type StructuredMemoryScope = 'global' | 'session' | 'user';
export type StructuredMemoryType = 'preference' | 'project_fact' | 'profile' | 'other';

export interface StructuredMemoryInsert {
  scope: StructuredMemoryScope;
  scope_id?: string | null;
  type: StructuredMemoryType;
  content: string;
  source_conversation_id?: string | null;
  source_message_id?: string | null;
  enabled?: boolean;
}

export interface StructuredMemoryRow extends Required<Omit<StructuredMemoryInsert, 'scope_id' | 'source_conversation_id' | 'source_message_id' | 'enabled'>> {
  id: string;
  scope_id: string | null;
  source_conversation_id: string | null;
  source_message_id: string | null;
  enabled: boolean;
  deleted_at: number | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

export class StructuredMemoriesRepo {
  constructor(private db: Db) {}

  insert(input: StructuredMemoryInsert): StructuredMemoryRow {
    const now = Date.now();
    const row = this.db
      .insert(structured_memories)
      .values({
        id: makeId('memory'),
        scope: input.scope,
        scope_id: input.scope === 'global' ? null : input.scope_id ?? null,
        type: input.type,
        content: input.content,
        source_conversation_id: input.source_conversation_id ?? null,
        source_message_id: input.source_message_id ?? null,
        enabled: input.enabled ?? true,
        deleted_at: null,
        last_used_at: null,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return row as StructuredMemoryRow;
  }

  list(opts: {
    scope?: StructuredMemoryScope;
    scopeId?: string | null;
    includeDisabled?: boolean;
    includeDeleted?: boolean;
    limit?: number;
  } = {}): StructuredMemoryRow[] {
    const clauses = [];
    if (opts.scope) clauses.push(eq(structured_memories.scope, opts.scope));
    if (opts.scope && opts.scope !== 'global' && opts.scopeId !== undefined) {
      clauses.push(
        opts.scopeId == null
          ? sql`${structured_memories.scope_id} IS NULL`
          : eq(structured_memories.scope_id, opts.scopeId),
      );
    }
    if (opts.scope === 'global') clauses.push(sql`${structured_memories.scope_id} IS NULL`);
    if (!opts.includeDisabled) clauses.push(eq(structured_memories.enabled, true));
    if (!opts.includeDeleted) clauses.push(sql`${structured_memories.deleted_at} IS NULL`);
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 100)));
    const query = this.db
      .select()
      .from(structured_memories)
      .orderBy(desc(structured_memories.updated_at))
      .limit(limit);
    const rows = (clauses.length > 0 ? query.where(and(...clauses)) : query).all();
    return rows as StructuredMemoryRow[];
  }

  setEnabled(id: string, enabled: boolean): StructuredMemoryRow | null {
    const row = this.db
      .update(structured_memories)
      .set({ enabled, updated_at: Date.now() })
      .where(eq(structured_memories.id, id))
      .returning()
      .get();
    return row ? (row as StructuredMemoryRow) : null;
  }

  markUsed(ids: string[], now = Date.now()): void {
    if (ids.length === 0) return;
    this.db
      .update(structured_memories)
      .set({ last_used_at: now, updated_at: now })
      .where(inArray(structured_memories.id, ids))
      .run();
  }

  softDelete(id: string): StructuredMemoryRow | null {
    const now = Date.now();
    const row = this.db
      .update(structured_memories)
      .set({ enabled: false, deleted_at: now, updated_at: now })
      .where(eq(structured_memories.id, id))
      .returning()
      .get();
    return row ? (row as StructuredMemoryRow) : null;
  }
}

export interface FileInsert {
  conversation_id: string | null;
  message_id: string | null;
  original_path: string | null;
  mime_type: string;
  size_bytes: number;
  extracted_text?: string | null;
  preview_data?: string | null;
}

export interface FileRow {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  original_path: string | null;
  mime_type: string;
  size_bytes: number;
  extracted_text: string | null;
  preview_data: string | null;
  created_at: number;
}

export interface FileChunkInsert {
  id?: string;
  file_id: string;
  conversation_id: string | null;
  message_id: string | null;
  chunk_index: number;
  content: string;
  token_count: number | null;
  char_start: number;
  char_end: number;
  content_hash: string;
}

function toFileChunk(row: FileChunkRow): FileChunk {
  return {
    id: row.id,
    file_id: row.file_id,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    chunk_index: row.chunk_index,
    content: row.content,
    token_count: row.token_count,
    char_start: row.char_start,
    char_end: row.char_end,
    content_hash: row.content_hash,
    created_at: row.created_at,
  };
}

function ftsQuery(input: string): string {
  const tokens = input.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const cleaned = tokens.map((token) => token.replace(/"/g, '""')).filter(Boolean);
  if (cleaned.length === 0) return input.replace(/"/g, '""');
  return cleaned.map((token) => `"${token}"`).join(' OR ');
}

export class FilesRepo {
  constructor(private db: Db) {}

  insert(input: FileInsert): FileRow {
    const id = makeId('file');
    const row = this.db
      .insert(files)
      .values({
        id,
        conversation_id: input.conversation_id,
        message_id: input.message_id,
        original_path: input.original_path,
        mime_type: input.mime_type,
        size_bytes: input.size_bytes,
        extracted_text: input.extracted_text ?? null,
        preview_data: input.preview_data ?? null,
        created_at: Date.now(),
      })
      .returning()
      .get();
    return row as FileRow;
  }

  get(id: string): FileRow | null {
    const row = this.db.select().from(files).where(eq(files.id, id)).get();
    return (row as FileRow | undefined) ?? null;
  }

  listByConversation(conversationId: string): FileRow[] {
    return this.db
      .select()
      .from(files)
      .where(eq(files.conversation_id, conversationId))
      .orderBy(asc(files.created_at))
      .all() as FileRow[];
  }

  setExtractedText(id: string, text: string): void {
    this.db
      .update(files)
      .set({ extracted_text: text })
      .where(eq(files.id, id))
      .run();
  }

  delete(id: string): boolean {
    this.db.run(sql`DELETE FROM file_chunk_fts WHERE file_id = ${id}`);
    const res = this.db.delete(files).where(eq(files.id, id)).run();
    return res.changes > 0;
  }
}

export class FileChunksRepo {
  constructor(private db: Db) {}

  listByFile(fileId: string): FileChunk[] {
    return this.db
      .select()
      .from(file_chunks)
      .where(eq(file_chunks.file_id, fileId))
      .orderBy(asc(file_chunks.chunk_index))
      .all()
      .map((row) => toFileChunk(row as FileChunkRow));
  }

  replaceForFile(fileId: string, chunks: FileChunkInsert[]): FileChunk[] {
    return this.db.transaction((tx) => {
      tx.delete(file_chunks).where(eq(file_chunks.file_id, fileId)).run();
      tx.run(sql`DELETE FROM file_chunk_fts WHERE file_id = ${fileId}`);
      if (chunks.length === 0) return [];
      const now = Date.now();
      const rows = chunks.map((chunk) => ({
        id: chunk.id ?? makeId('file_chunk'),
        file_id: fileId,
        conversation_id: chunk.conversation_id,
        message_id: chunk.message_id,
        chunk_index: chunk.chunk_index,
        content: chunk.content,
        token_count: chunk.token_count,
        char_start: chunk.char_start,
        char_end: chunk.char_end,
        content_hash: chunk.content_hash,
        created_at: now,
      }));
      const inserted = tx.insert(file_chunks).values(rows).returning().all() as FileChunkRow[];
      for (const row of inserted) {
        tx.run(sql`
          INSERT INTO file_chunk_fts (content, chunk_id, file_id, conversation_id)
          VALUES (${row.content}, ${row.id}, ${row.file_id}, ${row.conversation_id})
        `);
      }
      return inserted.map(toFileChunk);
    });
  }

  deleteForFile(fileId: string): void {
    this.db.delete(file_chunks).where(eq(file_chunks.file_id, fileId)).run();
    this.db.run(sql`DELETE FROM file_chunk_fts WHERE file_id = ${fileId}`);
  }

  search(input: {
    query: string;
    conversation_id?: string | null;
    file_ids?: string[];
    limit?: number;
    include_content?: boolean;
  }): FileSearchResult[] {
    const limit = Math.max(1, Math.min(20, input.limit ?? 6));
    const match = ftsQuery(input.query);
    const rows = this.db.all(sql`
      SELECT
        fc.id AS chunk_id,
        fc.file_id AS file_id,
        f.original_path AS original_path,
        fc.conversation_id AS conversation_id,
        fc.message_id AS message_id,
        fc.chunk_index AS chunk_index,
        fc.content AS content,
        bm25(file_chunk_fts) AS score,
        fc.char_start AS char_start,
        fc.char_end AS char_end
      FROM file_chunk_fts
      JOIN file_chunks fc ON fc.id = file_chunk_fts.chunk_id
      JOIN files f ON f.id = fc.file_id
      WHERE file_chunk_fts MATCH ${match}
      ORDER BY bm25(file_chunk_fts) ASC
      LIMIT ${Math.max(limit * 4, limit)}
    `) as Array<{
      chunk_id: string;
      file_id: string;
      original_path: string | null;
      conversation_id: string | null;
      message_id: string | null;
      chunk_index: number;
      content: string;
      score: number;
      char_start: number;
      char_end: number;
    }>;
    const fileSet = input.file_ids?.length ? new Set(input.file_ids) : null;
    const perFile = new Map<string, number>();
    const out: FileSearchResult[] = [];
    for (const row of rows) {
      if (input.conversation_id && row.conversation_id !== input.conversation_id) continue;
      if (fileSet && !fileSet.has(row.file_id)) continue;
      const usedForFile = perFile.get(row.file_id) ?? 0;
      if (usedForFile >= 2) continue;
      perFile.set(row.file_id, usedForFile + 1);
      out.push({
        chunk_id: row.chunk_id,
        file_id: row.file_id,
        file_name: row.original_path ? path.basename(row.original_path) : null,
        conversation_id: row.conversation_id,
        message_id: row.message_id,
        chunk_index: row.chunk_index,
        content: input.include_content === false ? null : row.content,
        snippet: row.content.length > 600 ? `${row.content.slice(0, 600)}…` : row.content,
        score: row.conversation_id === input.conversation_id ? row.score - 0.1 : row.score,
        char_start: row.char_start,
        char_end: row.char_end,
      });
      if (out.length >= limit) break;
    }
    return out.sort((a, b) => a.score - b.score);
  }
}

// ===========================================================================
// M3.A — Roundtables / Roundtable messages
// ===========================================================================

export interface RoundtableInsert {
  id?: string;
  conversation_id: string;
  topic: string;
  mode: RoundtableStoredMode;
  participants: Participant[];
  summarizer_model_id: string | null;
  origin_conversation_id?: string | null;
  analyzer_fallback: boolean;
  status: RoundtableStatus;
  current_round?: number;
  estimated_cost_usd_low: number | null;
  estimated_cost_usd_high: number | null;
}

export interface RoundtableRow {
  id: string;
  conversation_id: string;
  topic: string;
  mode: RoundtableStoredMode;
  participants: Participant[];
  summarizer_model_id: string | null;
  origin_conversation_id: string | null;
  analyzer_fallback: boolean;
  status: RoundtableStatus;
  current_round: number;
  summary: SummaryStorage | null;
  estimated_cost_usd_low: number | null;
  estimated_cost_usd_high: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function decodeRoundtable(row: any): RoundtableRow {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    topic: row.topic,
    mode: row.mode as RoundtableStoredMode,
    participants: JSON.parse(row.participants) as Participant[],
    summarizer_model_id: row.summarizer_model_id,
    origin_conversation_id: row.origin_conversation_id ?? null,
    analyzer_fallback: !!row.analyzer_fallback,
    status: row.status as RoundtableStatus,
    current_round: row.current_round,
    summary: row.summary ? (JSON.parse(row.summary) as SummaryStorage) : null,
    estimated_cost_usd_low: row.estimated_cost_usd_low,
    estimated_cost_usd_high: row.estimated_cost_usd_high,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

export class RoundtablesRepo {
  constructor(private db: Db) {}

  insert(input: RoundtableInsert): RoundtableRow {
    const id = input.id ?? makeId('roundtable');
    const now = Date.now();
    const row = this.db
      .insert(roundtables)
      .values({
        id,
        conversation_id: input.conversation_id,
        topic: input.topic,
        mode: input.mode,
        participants: JSON.stringify(input.participants),
        summarizer_model_id: input.summarizer_model_id,
        origin_conversation_id: input.origin_conversation_id ?? null,
        analyzer_fallback: input.analyzer_fallback,
        status: input.status,
        current_round: input.current_round ?? 0,
        summary: null,
        estimated_cost_usd_low: input.estimated_cost_usd_low,
        estimated_cost_usd_high: input.estimated_cost_usd_high,
        created_at: now,
        updated_at: now,
        completed_at: null,
      })
      .returning()
      .get();
    return decodeRoundtable(row);
  }

  get(id: string): RoundtableRow | null {
    const row = this.db
      .select()
      .from(roundtables)
      .where(eq(roundtables.id, id))
      .get();
    return row ? decodeRoundtable(row) : null;
  }

  listByConversation(conversationId: string): RoundtableRow[] {
    const rows = this.db
      .select()
      .from(roundtables)
      .where(eq(roundtables.conversation_id, conversationId))
      .orderBy(asc(roundtables.created_at))
      .all();
    return rows.map(decodeRoundtable);
  }

  listByAssociatedConversation(conversationId: string): RoundtableRow[] {
    const rows = this.db
      .select()
      .from(roundtables)
      .where(
        sql`${roundtables.conversation_id} = ${conversationId} OR ${roundtables.origin_conversation_id} = ${conversationId}`,
      )
      .orderBy(asc(roundtables.created_at))
      .all();
    return rows.map(decodeRoundtable);
  }

  setOriginConversation(id: string, conversationId: string): void {
    this.db
      .update(roundtables)
      .set({ origin_conversation_id: conversationId, updated_at: Date.now() })
      .where(eq(roundtables.id, id))
      .run();
  }

  setStatus(id: string, status: RoundtableStatus): void {
    this.db
      .update(roundtables)
      .set({
        status,
        updated_at: Date.now(),
        completed_at:
          status === 'completed' ||
          status === 'failed' ||
          status === 'cancelled'
            ? Date.now()
            : null,
      })
      .where(eq(roundtables.id, id))
      .run();
  }

  setRound(id: string, round: number): void {
    this.db
      .update(roundtables)
      .set({ current_round: round, updated_at: Date.now() })
      .where(eq(roundtables.id, id))
      .run();
  }

  setSummary(id: string, summary: SummaryStorage): void {
    this.db
      .update(roundtables)
      .set({ summary: JSON.stringify(summary), updated_at: Date.now() })
      .where(eq(roundtables.id, id))
      .run();
  }

  /**
   * Update one participant's `model_id` in the JSON `participants` blob.
   * Used by the retry-with-fallback flow (A1) so subsequent rounds use the
   * newly chosen model. Returns the updated row, or null if the row or
   * participant index is not found.
   */
  setParticipantModel(
    id: string,
    index: number,
    modelId: string,
  ): RoundtableRow | null {
    const row = this.get(id);
    if (!row) return null;
    if (index < 0 || index >= row.participants.length) return null;
    const next = row.participants.map((p, i) =>
      i === index ? { ...p, model_id: modelId } : p,
    );
    this.db
      .update(roundtables)
      .set({
        participants: JSON.stringify(next),
        updated_at: Date.now(),
      })
      .where(eq(roundtables.id, id))
      .run();
    return this.get(id);
  }

  /**
   * A3 — replace the entire participants array. Caller is responsible for
   * validating count (2..4) and that no rounds have started yet.
   */
  setParticipants(id: string, participants: Participant[]): RoundtableRow | null {
    const row = this.get(id);
    if (!row) return null;
    this.db
      .update(roundtables)
      .set({
        participants: JSON.stringify(participants),
        updated_at: Date.now(),
      })
      .where(eq(roundtables.id, id))
      .run();
    return this.get(id);
  }

  setSummarizerModel(id: string, modelId: string | null): RoundtableRow | null {
    const row = this.get(id);
    if (!row) return null;
    this.db
      .update(roundtables)
      .set({
        summarizer_model_id: modelId,
        updated_at: Date.now(),
      })
      .where(eq(roundtables.id, id))
      .run();
    return this.get(id);
  }
}

export interface RoundtableMessageInsert {
  roundtable_id: string;
  round: number;
  participant_index: number;
  model_id: string | null;
  content?: string;
  status?: RoundtableMessageStatus;
  visible_to_others?: boolean;
}

export interface RoundtableMessageRow {
  id: string;
  roundtable_id: string;
  round: number;
  participant_index: number;
  model_id: string | null;
  content: string;
  status: RoundtableMessageStatus;
  classification: RoundtableMessageClassification | null;
  error_message: string | null;
  visible_to_others: boolean;
  created_at: number;
  updated_at: number;
}

function decodeRoundtableMessage(row: any): RoundtableMessageRow {
  return {
    id: row.id,
    roundtable_id: row.roundtable_id,
    round: row.round,
    participant_index: row.participant_index,
    model_id: row.model_id,
    content: row.content ?? '',
    status: row.status as RoundtableMessageStatus,
    classification: row.classification as RoundtableMessageClassification | null,
    error_message: row.error_message,
    visible_to_others: !!row.visible_to_others,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class RoundtableMessagesRepo {
  constructor(private db: Db) {}

  insert(input: RoundtableMessageInsert): RoundtableMessageRow {
    const id = makeId('roundtable_message');
    const now = Date.now();
    const row = this.db
      .insert(roundtable_messages)
      .values({
        id,
        roundtable_id: input.roundtable_id,
        round: input.round,
        participant_index: input.participant_index,
        model_id: input.model_id,
        content: input.content ?? '',
        status: input.status ?? 'pending',
        classification: null,
        error_message: null,
        visible_to_others: input.visible_to_others ?? true,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return decodeRoundtableMessage(row);
  }

  /** UPDATE the row in place — used during streaming and retry. */
  update(
    id: string,
    patch: Partial<{
      content: string;
      status: RoundtableMessageStatus;
      classification: RoundtableMessageClassification | null;
      error_message: string | null;
      model_id: string | null;
    }>,
  ): void {
    this.db
      .update(roundtable_messages)
      .set({ ...patch, updated_at: Date.now() })
      .where(eq(roundtable_messages.id, id))
      .run();
  }

  listByRoundtable(roundtableId: string): RoundtableMessageRow[] {
    const rows = this.db
      .select()
      .from(roundtable_messages)
      .where(eq(roundtable_messages.roundtable_id, roundtableId))
      .orderBy(
        asc(roundtable_messages.round),
        asc(roundtable_messages.participant_index),
      )
      .all();
    return rows.map(decodeRoundtableMessage);
  }

  findOne(
    roundtableId: string,
    round: number,
    participantIndex: number,
  ): RoundtableMessageRow | null {
    const row = this.db
      .select()
      .from(roundtable_messages)
      .where(
        and(
          eq(roundtable_messages.roundtable_id, roundtableId),
          eq(roundtable_messages.round, round),
          eq(roundtable_messages.participant_index, participantIndex),
        ),
      )
      .get();
    return row ? decodeRoundtableMessage(row) : null;
  }
}
