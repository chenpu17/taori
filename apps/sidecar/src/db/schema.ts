/**
 * Drizzle schema for the sidecar SQLite database.
 *
 * NOTE: Concept types here are TypeScript / Drizzle. SQLite storage classes
 * map as: text -> TEXT, integer -> INTEGER, real -> REAL, boolean -> INTEGER.
 * See docs/architecture/04-data-and-storage.md for the canonical schema.
 *
 * M0 only seeds providers + models + conversations + messages tables to keep
 * the spike minimal. Remaining tables (files, roundtables, cost_records,
 * memories, roundtable_messages) are added in M1 phases.
 */

import {
  sql,
} from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  base_url: text('base_url').notNull(),
  api_key_ref: text('api_key_ref'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
});

export const models = sqliteTable(
  'models',
  {
    id: text('id').primaryKey(),
    alias: text('alias'),
    provider_id: text('provider_id').references(() => providers.id, {
      onDelete: 'set null',
    }),
    model_name: text('model_name').notNull(),
    capability: text('capability').notNull(),
    display_name: text('display_name').notNull(),
    price_input_per_1m: real('price_input_per_1m'),
    price_output_per_1m: real('price_output_per_1m'),
    price_per_call: real('price_per_call'),
    price_per_image: real('price_per_image'),
    price_per_video_second: real('price_per_video_second'),
    price_currency: text('price_currency').notNull().default('USD'),
    pricing_meta: text('pricing_meta'),
    price_synced_at: integer('price_synced_at'),
    /** JSON array of Modality strings ('text'|'image'|'audio'|'video'). */
    modalities: text('modalities'),
    context_length: integer('context_length'),
    supports_vision: integer('supports_vision', { mode: 'boolean' })
      .notNull()
      .default(false),
    supports_tools: integer('supports_tools', { mode: 'boolean' })
      .notNull()
      .default(false),
    supports_json: integer('supports_json', { mode: 'boolean' })
      .notNull()
      .default(false),
    thinking_enabled: integer('thinking_enabled', { mode: 'boolean' }),
    is_default_for: text('is_default_for'),
    fallback_order: integer('fallback_order').notNull().default(0),
    user_rating: integer('user_rating'),
    failure_count_24h: integer('failure_count_24h').notNull().default(0),
    last_failure_at: integer('last_failure_at'),
    demoted: integer('demoted', { mode: 'boolean' }).notNull().default(false),
    disabled_until: integer('disabled_until'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => ({
    aliasIdx: uniqueIndex('models_alias_uniq')
      .on(t.alias)
      .where(undefined as never),
    // UNIQUE(provider_id, model_name) — allow duplicates only when provider is NULL
    providerModelIdx: uniqueIndex('models_provider_model_uniq').on(
      t.provider_id,
      t.model_name,
    ),
    // MC-3 list() / nextFallback() both order by (capability, fallback_order).
    capabilityOrderIdx: index('models_capability_fallback_order_idx').on(
      t.capability,
      t.fallback_order,
    ),
  }),
);

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  type: text('type').notNull().default('chat'),
  title: text('title'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  // JSON-encoded array of strings (max 3 entries enforced at the route layer).
  tags: text('tags'),
});

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content'),
    model_id: text('model_id').references(() => models.id, {
      onDelete: 'set null',
    }),
    parent_message_id: text('parent_message_id'),
    attachments: text('attachments'),
    status: text('status').notNull().default('pending'),
    error: text('error'),
    created_at: integer('created_at').notNull(),
  },
  (t) => ({
    convIdx: index('messages_conv_idx').on(t.conversation_id, t.created_at),
  }),
);

export const files = sqliteTable(
  'files',
  {
    id: text('id').primaryKey(),
    conversation_id: text('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    message_id: text('message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    original_path: text('original_path'),
    mime_type: text('mime_type').notNull(),
    size_bytes: integer('size_bytes').notNull(),
    extracted_text: text('extracted_text'),
    preview_data: text('preview_data'),
    created_at: integer('created_at').notNull(),
  },
  (t) => ({
    convIdx: index('files_conv_idx').on(t.conversation_id),
  }),
);

export const file_chunks = sqliteTable(
  'file_chunks',
  {
    id: text('id').primaryKey(),
    file_id: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    conversation_id: text('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    message_id: text('message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    chunk_index: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    token_count: integer('token_count'),
    char_start: integer('char_start').notNull(),
    char_end: integer('char_end').notNull(),
    content_hash: text('content_hash').notNull(),
    created_at: integer('created_at').notNull(),
  },
  (t) => ({
    fileIndexUniq: uniqueIndex('file_chunks_file_index_uniq').on(t.file_id, t.chunk_index),
    convFileIdx: index('file_chunks_conv_file_idx').on(t.conversation_id, t.file_id),
    hashIdx: index('file_chunks_hash_idx').on(t.content_hash),
  }),
);

/**
 * Three-tier preference KV store. M2 §5.2 codified the namespace:
 *   - scope='global'  scope_id=null     → app-wide preferences
 *   - scope='session' scope_id=<conv>   → conversation-scoped overrides
 *   - scope='user'    scope_id=<user>   → reserved for future per-user split
 * Lookup order in repo: session > global > default.
 */
export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    scope_id: text('scope_id'),
    key: text('key').notNull(),
    value: text('value').notNull(),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => ({
    uniqIdx: uniqueIndex('memories_scope_key_uniq_v2').on(
      t.scope,
      sql`COALESCE(${t.scope_id}, '')`,
      t.key,
    ),
  }),
);

export const structured_memories = sqliteTable(
  'structured_memories',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    scope_id: text('scope_id'),
    type: text('type').notNull(),
    content: text('content').notNull(),
    source_conversation_id: text('source_conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    source_message_id: text('source_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    deleted_at: integer('deleted_at'),
    last_used_at: integer('last_used_at'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => ({
    scopeIdx: index('structured_memories_scope_idx').on(
      t.scope,
      t.scope_id,
      t.enabled,
      t.updated_at,
    ),
    sourceIdx: index('structured_memories_source_idx').on(
      t.source_conversation_id,
      t.source_message_id,
    ),
  }),
);

export const prompt_templates = sqliteTable('prompt_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  content: text('content').notNull(),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
});

export const personas = sqliteTable('personas', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  prompt: text('prompt').notNull(),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
});

export const workflow_recipes = sqliteTable(
  'workflow_recipes',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    schema_version: integer('schema_version').notNull().default(1),
    spec_json: text('spec_json').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => ({
    enabledIdx: index('workflow_recipes_enabled_idx').on(t.enabled, t.updated_at),
  }),
);

export const research_sessions = sqliteTable(
  'research_sessions',
  {
    id: text('id').primaryKey(),
    conversation_id: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    objective: text('objective').notNull(),
    output_kind: text('output_kind').notNull(),
    status: text('status').notNull(),
    stage: text('stage').notNull(),
    budget_mode: text('budget_mode').notNull(),
    budget_limit_usd: real('budget_limit_usd'),
    budget_spent_usd: real('budget_spent_usd').notNull().default(0),
    constraints_json: text('constraints_json').notNull().default('{}'),
    plan_json: text('plan_json'),
    draft_markdown: text('draft_markdown'),
    final_markdown: text('final_markdown'),
    started_at: integer('started_at'),
    completed_at: integer('completed_at'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => ({
    statusIdx: index('research_sessions_status_idx').on(t.status, t.updated_at),
    convIdx: index('research_sessions_conv_idx').on(t.conversation_id, t.updated_at),
  }),
);

export const research_tasks = sqliteTable(
  'research_tasks',
  {
    id: text('id').primaryKey(),
    research_session_id: text('research_session_id')
      .notNull()
      .references(() => research_sessions.id, { onDelete: 'cascade' }),
    parent_task_id: text('parent_task_id'),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    title: text('title').notNull(),
    input_json: text('input_json').notNull(),
    output_json: text('output_json'),
    error_json: text('error_json'),
    started_at: integer('started_at'),
    finished_at: integer('finished_at'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => ({
    sessionIdx: index('research_tasks_session_idx').on(t.research_session_id, t.created_at),
    statusIdx: index('research_tasks_status_idx').on(t.status, t.updated_at),
  }),
);

export const research_sources = sqliteTable(
  'research_sources',
  {
    id: text('id').primaryKey(),
    research_session_id: text('research_session_id')
      .notNull()
      .references(() => research_sessions.id, { onDelete: 'cascade' }),
    source_type: text('source_type').notNull(),
    title: text('title'),
    locator: text('locator').notNull(),
    snippet: text('snippet'),
    credibility_score: real('credibility_score'),
    included: integer('included', { mode: 'boolean' }).notNull().default(true),
    metadata_json: text('metadata_json').notNull().default('{}'),
    created_at: integer('created_at').notNull(),
  },
  (t) => ({
    sessionIdx: index('research_sources_session_idx').on(t.research_session_id, t.created_at),
    locatorIdx: index('research_sources_locator_idx').on(t.research_session_id, t.locator),
  }),
);

export const research_claims = sqliteTable(
  'research_claims',
  {
    id: text('id').primaryKey(),
    research_session_id: text('research_session_id')
      .notNull()
      .references(() => research_sessions.id, { onDelete: 'cascade' }),
    section_key: text('section_key').notNull(),
    claim_text: text('claim_text').notNull(),
    claim_kind: text('claim_kind').notNull(),
    support_status: text('support_status').notNull(),
    citations_json: text('citations_json').notNull().default('[]'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => ({
    sessionIdx: index('research_claims_session_idx').on(t.research_session_id, t.updated_at),
    supportIdx: index('research_claims_support_idx').on(t.support_status, t.updated_at),
  }),
);

export const cost_records = sqliteTable(
  'cost_records',
  {
    id: text('id').primaryKey(),
    conversation_id: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    source_type: text('source_type').notNull(),
    source_id: text('source_id'),
    feature: text('feature').notNull().default('chat'),
    model_id: text('model_id').references(() => models.id, {
      onDelete: 'set null',
    }),
    model_name_snapshot: text('model_name_snapshot').notNull().default(''),
    input_tokens: integer('input_tokens'),
    cache_input_tokens: integer('cache_input_tokens'),
    output_tokens: integer('output_tokens'),
    call_count: integer('call_count').notNull().default(1),
    price_input_per_1m_snapshot: real('price_input_per_1m_snapshot'),
    price_output_per_1m_snapshot: real('price_output_per_1m_snapshot'),
    price_per_call_snapshot: real('price_per_call_snapshot'),
    estimated_cost_usd: real('estimated_cost_usd'),
    actual_cost_usd: real('actual_cost_usd'),
    success: integer('success', { mode: 'boolean' }).notNull().default(true),
    classification: text('classification'),
    first_token_ms: integer('first_token_ms'),
    duration_ms: integer('duration_ms'),
    created_at: integer('created_at').notNull(),
  },
  (t) => ({
    convIdx: index('cost_records_conv_idx').on(t.conversation_id, t.created_at),
    modelIdx: index('cost_records_model_idx').on(t.model_id, t.created_at),
    sourceIdx: index('cost_records_source_idx').on(t.source_type, t.source_id),
  }),
);

export const mcp_servers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  transport: text('transport').notNull().default('stdio'),
  command: text('command').notNull(),
  args: text('args'),
  env: text('env'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  health_status: text('health_status').notNull().default('unknown'),
  last_error: text('last_error'),
  tools_count: integer('tools_count').notNull().default(0),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
});

export const run_events = sqliteTable(
  'run_events',
  {
    id: text('id').primaryKey(),
    run_id: text('run_id').notNull(),
    conversation_id: text('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    message_id: text('message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    label: text('label').notNull(),
    summary: text('summary'),
    payload: text('payload'),
    created_at: integer('created_at').notNull(),
  },
  (t) => ({
    convIdx: index('run_events_conv_idx').on(t.conversation_id, t.created_at),
    runIdx: index('run_events_run_idx').on(t.run_id, t.created_at),
    msgIdx: index('run_events_msg_idx').on(t.message_id, t.created_at),
  }),
);

export const agent_runs = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    conversation_id: text('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    parent_run_id: text('parent_run_id'),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    model_id: text('model_id'),
    user_message_id: text('user_message_id'),
    assistant_message_id: text('assistant_message_id'),
    recovery_policy: text('recovery_policy'),
    event_count: integer('event_count').notNull().default(0),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => ({
    convIdx: index('agent_runs_conv_idx').on(t.conversation_id, t.updated_at),
    parentIdx: index('agent_runs_parent_idx').on(t.parent_run_id),
    statusIdx: index('agent_runs_status_idx').on(t.status, t.updated_at),
  }),
);

/**
 * M3.A roundtable instance. participants/summary stored as JSON text columns
 * (Drizzle serialization left to repo). status/mode are constrained to a
 * small enum at the application layer (see RoundtableStatus / RoundtableMode
 * in @taori/shared).
 */
export const roundtables = sqliteTable(
  'roundtables',
  {
    id: text('id').primaryKey(),
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    topic: text('topic').notNull(),
    mode: text('mode').notNull(),
    participants: text('participants').notNull(),
    summarizer_model_id: text('summarizer_model_id').references(() => models.id, {
      onDelete: 'set null',
    }),
    /** A4 — original chat conversation the user was in when launching the
     *  roundtable. Lets the user 'send the conclusion back' as an assistant
     *  message. Nullable: roundtables created from a fresh state have no
     *  origin and the loopback handler will mint one on demand. */
    origin_conversation_id: text('origin_conversation_id').references(
      () => conversations.id,
      { onDelete: 'set null' },
    ),
    analyzer_fallback: integer('analyzer_fallback', { mode: 'boolean' })
      .notNull()
      .default(false),
    status: text('status').notNull(),
    current_round: integer('current_round').notNull().default(0),
    summary: text('summary'),
    estimated_cost_usd_low: real('estimated_cost_usd_low'),
    estimated_cost_usd_high: real('estimated_cost_usd_high'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    completed_at: integer('completed_at'),
  },
  (t) => ({
    convIdx: index('roundtables_conv_idx').on(t.conversation_id, t.created_at),
  }),
);

export const roundtable_messages = sqliteTable(
  'roundtable_messages',
  {
    id: text('id').primaryKey(),
    roundtable_id: text('roundtable_id')
      .notNull()
      .references(() => roundtables.id, { onDelete: 'cascade' }),
    round: integer('round').notNull(),
    participant_index: integer('participant_index').notNull(),
    model_id: text('model_id').references(() => models.id, {
      onDelete: 'set null',
    }),
    content: text('content').notNull().default(''),
    status: text('status').notNull().default('pending'),
    classification: text('classification'),
    error_message: text('error_message'),
    visible_to_others: integer('visible_to_others', { mode: 'boolean' })
      .notNull()
      .default(true),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => ({
    rtIdx: index('roundtable_messages_rt_idx').on(t.roundtable_id, t.round, t.participant_index),
    uniqIdx: uniqueIndex('roundtable_messages_uniq')
      .on(t.roundtable_id, t.round, t.participant_index),
  }),
);

export const quick_compare_runs = sqliteTable(
  'quick_compare_runs',
  {
    id: text('id').primaryKey(),
    conversation_id: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    source_user_message_id: text('source_user_message_id').references(
      () => messages.id,
      { onDelete: 'set null' },
    ),
    run_id: text('run_id').notNull(),
    status: text('status').notNull(),
    model_ids: text('model_ids').notNull(),
    adopted_output_id: text('adopted_output_id'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => ({
    convIdx: index('quick_compare_runs_conv_idx').on(t.conversation_id, t.updated_at),
    runIdx: index('quick_compare_runs_run_idx').on(t.run_id),
  }),
);

export const quick_compare_outputs = sqliteTable(
  'quick_compare_outputs',
  {
    id: text('id').primaryKey(),
    compare_id: text('compare_id')
      .notNull()
      .references(() => quick_compare_runs.id, { onDelete: 'cascade' }),
    participant_index: integer('participant_index').notNull(),
    model_id: text('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    provider_id: text('provider_id').references(() => providers.id, {
      onDelete: 'set null',
    }),
    tool_names: text('tool_names').notNull().default('[]'),
    content: text('content').notNull().default(''),
    status: text('status').notNull().default('pending'),
    error_classification: text('error_classification'),
    error_message: text('error_message'),
    cost_record_id: text('cost_record_id').references(() => cost_records.id, {
      onDelete: 'set null',
    }),
    first_token_ms: integer('first_token_ms'),
    duration_ms: integer('duration_ms'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (t) => ({
    compareIdx: index('quick_compare_outputs_compare_idx').on(t.compare_id, t.participant_index),
    uniqIdx: uniqueIndex('quick_compare_outputs_uniq').on(t.compare_id, t.participant_index),
  }),
);
