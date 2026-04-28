/**
 * Drizzle-backed repositories for providers + models.
 *
 * These wrap raw drizzle calls so route handlers stay readable and so the
 * row-shape ↔ Zod-shape mapping (booleans-as-int, defaults) lives in one
 * place. None of these methods touch the network or the keystore — those
 * concerns are layered on by the route handlers.
 */

import { eq, and, isNotNull, asc, sql } from 'drizzle-orm';
import { type Db } from '../index.js';
import {
  providers,
  models,
  conversations,
  messages,
  cost_records,
  memories,
  files,
  roundtables,
  roundtable_messages,
} from '../schema.js';
import type {
  Participant,
  RoundtableStoredMode,
  RoundtableStatus,
  SummaryStorage,
  RoundtableMessageStatus,
  RoundtableMessageClassification,
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
} from '@taori/shared';

type ProviderRow = typeof providers.$inferSelect;
type ModelRow = typeof models.$inferSelect;

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
    price_currency: row.price_currency,
    context_length: row.context_length,
    supports_vision: row.supports_vision,
    supports_tools: row.supports_tools,
    supports_json: row.supports_json,
    is_default_for: (row.is_default_for as ModelCapability | null) ?? null,
    enabled: row.enabled,
    fallback_order: row.fallback_order ?? 0,
    demoted: row.demoted ?? false,
    disabled_until: row.disabled_until ?? null,
    failure_count_24h: row.failure_count_24h ?? 0,
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
    return this.db.select().from(models).all().map(toModel);
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
        price_currency: input.price_currency ?? 'USD',
        context_length: input.context_length ?? null,
        supports_vision: input.supports_vision ?? false,
        supports_tools: input.supports_tools ?? false,
        supports_json: input.supports_json ?? false,
        is_default_for: input.is_default_for ?? null,
        fallback_order: 0,
        user_rating: null,
        failure_count_24h: 0,
        demoted: false,
        disabled_until: null,
        enabled: true,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toModel(row);
  }

  update(id: string, patch: ModelUpdate): Model | null {
    const existing = this.get(id);
    if (!existing) return null;
    const row = this.db
      .update(models)
      .set({
        ...(patch.alias !== undefined && { alias: patch.alias }),
        ...(patch.display_name !== undefined && {
          display_name: patch.display_name,
        }),
        ...(patch.is_default_for !== undefined && {
          is_default_for: patch.is_default_for,
        }),
        ...(patch.enabled !== undefined && { enabled: patch.enabled }),
        ...(patch.fallback_order !== undefined && {
          fallback_order: patch.fallback_order,
        }),
        updated_at: Date.now(),
      })
      .where(eq(models.id, id))
      .returning()
      .get();
    return toModel(row);
  }

  /**
   * Record an upstream failure for a model and apply demote/disable per
   * docs/product/08-m1-spec.md §7.5.2:
   *   - 3 strikes within 24h → `demoted = true`
   *   - 5 strikes within 24h → `disabled_until = now + 24h`
   * Only `quota`, `rate_limit`, and `network` count as strikes; `unknown`
   * and `content_filter` are excluded (auth issues / content policy belong
   * to the user, not the model). Strikes naturally age out — once the most
   * recent failure is older than 24h we reset the counter on the next call.
   */
  recordFailure(modelId: string, classification: string): Model | null {
    const STRIKE_KINDS = new Set(['quota', 'rate_limit', 'network']);
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

export interface ConversationRow {
  id: string;
  type: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  archived: boolean;
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

  /** List non-archived chats, newest first. */
  list(): ConversationRow[] {
    return this.db
      .select()
      .from(conversations)
      .where(eq(conversations.archived, false))
      .orderBy(sql`updated_at DESC`)
      .all() as ConversationRow[];
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

  /** Hard delete: drops messages + cost rows via FK cascades / app-level cleanup. */
  delete(id: string): boolean {
    const res = this.db.delete(conversations).where(eq(conversations.id, id)).run();
    return res.changes > 0;
  }

  /** Insert a fresh chat conversation; returns its id. */
  create(opts: { id?: string; title?: string | null } = {}): ConversationRow {
    const now = Date.now();
    const id = opts.id ?? makeId('conversation');
    const row = this.db
      .insert(conversations)
      .values({
        id,
        type: 'chat',
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
  ensure(id: string | undefined): ConversationRow {
    if (id) {
      const existing = this.get(id);
      if (existing) return existing;
      return this.create({ id });
    }
    return this.create();
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
}

export interface CostInsert {
  conversation_id: string | null;
  source_type: 'message' | 'roundtable_message' | 'topic_analyzer' | 'summarizer' | 'tool_call';
  source_id: string | null;
  feature: 'chat' | 'roundtable' | 'image' | 'tool_call';
  model_id: string | null;
  model_name_snapshot: string;
  input_tokens: number | null;
  output_tokens: number | null;
  call_count?: number;
  price_input_per_1m_snapshot: number | null;
  price_output_per_1m_snapshot: number | null;
  price_per_call_snapshot: number | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  success: boolean;
  duration_ms: number | null;
}

export interface CostRecord extends CostInsert {
  id: string;
  call_count: number;
  created_at: number;
}

export class CostsRepo {
  constructor(private db: Db) {}

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
        output_tokens: input.output_tokens,
        call_count: input.call_count ?? 1,
        price_input_per_1m_snapshot: input.price_input_per_1m_snapshot,
        price_output_per_1m_snapshot: input.price_output_per_1m_snapshot,
        price_per_call_snapshot: input.price_per_call_snapshot,
        estimated_cost_usd: input.estimated_cost_usd,
        actual_cost_usd: input.actual_cost_usd,
        success: input.success,
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
    scope: 'session' | 'today' | 'month',
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
    let timeWhere = sql`1=1`;
    if (scope === 'today') {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      timeWhere = sql`created_at >= ${start.getTime()}`;
    } else if (scope === 'month') {
      const start = new Date();
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      timeWhere = sql`created_at >= ${start.getTime()}`;
    }
    let convWhere = sql`1=1`;
    if (scope === 'session') {
      if (!conversationId) return [];
      convWhere = sql`conversation_id = ${conversationId}`;
    }
    const rows = this.db
      .select({
        model_id: cost_records.model_id,
        model_name_snapshot: cost_records.model_name_snapshot,
        feature: cost_records.feature,
        sum_usd: sql<number>`COALESCE(SUM(actual_cost_usd), 0)`,
        count: sql<number>`COUNT(*)`,
        success_count: sql<number>`SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END)`,
        billed_failure_count: sql<number>`SUM(CASE WHEN success = 0 AND actual_cost_usd > 0 THEN 1 ELSE 0 END)`,
      })
      .from(cost_records)
      .where(and(timeWhere, convWhere))
      .groupBy(cost_records.model_id, cost_records.feature)
      .all() as Array<{
        model_id: string | null;
        model_name_snapshot: string | null;
        feature: string;
        sum_usd: number;
        count: number;
        success_count: number;
        billed_failure_count: number;
      }>;
    return rows;
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

  setExtractedText(id: string, text: string): void {
    this.db
      .update(files)
      .set({ extracted_text: text })
      .where(eq(files.id, id))
      .run();
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

  setStatus(id: string, status: RoundtableStatus): void {
    this.db
      .update(roundtables)
      .set({
        status,
        updated_at: Date.now(),
        completed_at:
          status === 'completed' || status === 'failed' ? Date.now() : null,
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
