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
    price_currency: text('price_currency').notNull().default('USD'),
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
  }),
);

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  type: text('type').notNull().default('chat'),
  title: text('title'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
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
    uniqIdx: uniqueIndex('memories_scope_key_uniq').on(
      t.scope,
      t.scope_id,
      t.key,
    ),
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
    output_tokens: integer('output_tokens'),
    call_count: integer('call_count').notNull().default(1),
    price_input_per_1m_snapshot: real('price_input_per_1m_snapshot'),
    price_output_per_1m_snapshot: real('price_output_per_1m_snapshot'),
    price_per_call_snapshot: real('price_per_call_snapshot'),
    estimated_cost_usd: real('estimated_cost_usd'),
    actual_cost_usd: real('actual_cost_usd'),
    success: integer('success', { mode: 'boolean' }).notNull().default(true),
    duration_ms: integer('duration_ms'),
    created_at: integer('created_at').notNull(),
  },
  (t) => ({
    convIdx: index('cost_records_conv_idx').on(t.conversation_id, t.created_at),
    modelIdx: index('cost_records_model_idx').on(t.model_id, t.created_at),
    sourceIdx: index('cost_records_source_idx').on(t.source_type, t.source_id),
  }),
);
