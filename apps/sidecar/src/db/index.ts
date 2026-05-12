/**
 * SQLite bootstrap. Creates tables on first run via raw DDL (drizzle-kit
 * migrations are added in a later phase; this gets us off the ground).
 */

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema.js';

const DDL = `
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  alias TEXT,
  provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
  model_name TEXT NOT NULL,
  capability TEXT NOT NULL,
  display_name TEXT NOT NULL,
  price_input_per_1m REAL,
  price_output_per_1m REAL,
  price_per_call REAL,
  price_per_image REAL,
  price_per_video_second REAL,
  price_currency TEXT NOT NULL DEFAULT 'USD',
  pricing_meta TEXT,
  price_synced_at INTEGER,
  modalities TEXT,
  context_length INTEGER,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  supports_tools INTEGER NOT NULL DEFAULT 0,
  supports_json INTEGER NOT NULL DEFAULT 0,
  is_default_for TEXT,
  fallback_order INTEGER NOT NULL DEFAULT 0,
  user_rating INTEGER,
  failure_count_24h INTEGER NOT NULL DEFAULT 0,
  last_failure_at INTEGER,
  demoted INTEGER NOT NULL DEFAULT 0,
  disabled_until INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS models_alias_uniq ON models(alias) WHERE alias IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS models_provider_model_uniq ON models(provider_id, model_name) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS models_capability_fallback_order_idx ON models(capability, fallback_order);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'chat',
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  tags TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT,
  model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
  parent_message_id TEXT,
  attachments TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  original_path TEXT,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  extracted_text TEXT,
  preview_data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_conv_idx ON files(conversation_id);

CREATE TABLE IF NOT EXISTS file_chunks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS file_chunks_file_index_uniq ON file_chunks(file_id, chunk_index);
CREATE INDEX IF NOT EXISTS file_chunks_conv_file_idx ON file_chunks(conversation_id, file_id);
CREATE INDEX IF NOT EXISTS file_chunks_hash_idx ON file_chunks(content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS file_chunk_fts USING fts5(
  content,
  chunk_id UNINDEXED,
  file_id UNINDEXED,
  conversation_id UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS cost_records (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  feature TEXT NOT NULL DEFAULT 'chat',
  model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
  model_name_snapshot TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER,
  cache_input_tokens INTEGER,
  output_tokens INTEGER,
  call_count INTEGER NOT NULL DEFAULT 1,
  price_input_per_1m_snapshot REAL,
  price_output_per_1m_snapshot REAL,
  price_per_call_snapshot REAL,
  estimated_cost_usd REAL,
  actual_cost_usd REAL,
  success INTEGER NOT NULL DEFAULT 1,
  classification TEXT,
  first_token_ms INTEGER,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cost_records_conv_idx ON cost_records(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS cost_records_model_idx ON cost_records(model_id, created_at);
CREATE INDEX IF NOT EXISTS cost_records_source_idx ON cost_records(source_type, source_id);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'stdio',
  command TEXT NOT NULL,
  args TEXT,
  env TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_error TEXT,
  tools_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  label TEXT NOT NULL,
  summary TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_conv_idx ON run_events(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS run_events_msg_idx ON run_events(message_id, created_at);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  parent_run_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  model_id TEXT,
  user_message_id TEXT,
  assistant_message_id TEXT,
  recovery_policy TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_runs_conv_idx ON agent_runs(conversation_id, updated_at);
CREATE INDEX IF NOT EXISTS agent_runs_parent_idx ON agent_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON agent_runs(status, updated_at);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS memories_scope_key_uniq ON memories(scope, scope_id, key);

CREATE TABLE IF NOT EXISTS structured_memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS structured_memories_scope_idx ON structured_memories(scope, scope_id, enabled, updated_at);
CREATE INDEX IF NOT EXISTS structured_memories_source_idx ON structured_memories(source_conversation_id, source_message_id);

CREATE TABLE IF NOT EXISTS prompt_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_recipes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  spec_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_recipes_enabled_idx ON workflow_recipes(enabled, updated_at);

CREATE TABLE IF NOT EXISTS research_sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  output_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  budget_mode TEXT NOT NULL,
  budget_limit_usd REAL,
  budget_spent_usd REAL NOT NULL DEFAULT 0,
  constraints_json TEXT NOT NULL DEFAULT '{}',
  plan_json TEXT,
  draft_markdown TEXT,
  final_markdown TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS research_sessions_status_idx ON research_sessions(status, updated_at);
CREATE INDEX IF NOT EXISTS research_sessions_conv_idx ON research_sessions(conversation_id, updated_at);

CREATE TABLE IF NOT EXISTS research_tasks (
  id TEXT PRIMARY KEY,
  research_session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  parent_task_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_json TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS research_tasks_session_idx ON research_tasks(research_session_id, created_at);
CREATE INDEX IF NOT EXISTS research_tasks_status_idx ON research_tasks(status, updated_at);

CREATE TABLE IF NOT EXISTS research_sources (
  id TEXT PRIMARY KEY,
  research_session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  title TEXT,
  locator TEXT NOT NULL,
  snippet TEXT,
  credibility_score REAL,
  included INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS research_sources_session_idx ON research_sources(research_session_id, created_at);
CREATE INDEX IF NOT EXISTS research_sources_locator_idx ON research_sources(research_session_id, locator);

CREATE TABLE IF NOT EXISTS research_claims (
  id TEXT PRIMARY KEY,
  research_session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  claim_text TEXT NOT NULL,
  claim_kind TEXT NOT NULL,
  support_status TEXT NOT NULL,
  citations_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS research_claims_session_idx ON research_claims(research_session_id, updated_at);
CREATE INDEX IF NOT EXISTS research_claims_support_idx ON research_claims(support_status, updated_at);

CREATE TABLE IF NOT EXISTS roundtables (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  mode TEXT NOT NULL,
  participants TEXT NOT NULL,
  summarizer_model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
  origin_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  analyzer_fallback INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  current_round INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  estimated_cost_usd_low REAL,
  estimated_cost_usd_high REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS roundtables_conv_idx ON roundtables(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS roundtable_messages (
  id TEXT PRIMARY KEY,
  roundtable_id TEXT NOT NULL REFERENCES roundtables(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  participant_index INTEGER NOT NULL,
  model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  classification TEXT,
  error_message TEXT,
  visible_to_others INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS roundtable_messages_rt_idx ON roundtable_messages(roundtable_id, round, participant_index);
CREATE UNIQUE INDEX IF NOT EXISTS roundtable_messages_uniq ON roundtable_messages(roundtable_id, round, participant_index);

CREATE TABLE IF NOT EXISTS quick_compare_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_user_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  model_ids TEXT NOT NULL,
  adopted_output_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS quick_compare_runs_conv_idx ON quick_compare_runs(conversation_id, updated_at);
CREATE INDEX IF NOT EXISTS quick_compare_runs_run_idx ON quick_compare_runs(run_id);

CREATE TABLE IF NOT EXISTS quick_compare_outputs (
  id TEXT PRIMARY KEY,
  compare_id TEXT NOT NULL REFERENCES quick_compare_runs(id) ON DELETE CASCADE,
  participant_index INTEGER NOT NULL,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
  tool_names TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  error_classification TEXT,
  error_message TEXT,
  cost_record_id TEXT REFERENCES cost_records(id) ON DELETE SET NULL,
  first_token_ms INTEGER,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS quick_compare_outputs_compare_idx ON quick_compare_outputs(compare_id, participant_index);
CREATE UNIQUE INDEX IF NOT EXISTS quick_compare_outputs_uniq ON quick_compare_outputs(compare_id, participant_index);
`;

export type Db = BetterSQLite3Database<typeof schema>;

export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(DDL);
  // SQLite UNIQUE indexes treat NULL values as distinct. Keep one logical row
  // per memory key before adding the NULL-safe expression index.
  sqlite.exec(`
DELETE FROM memories
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY scope, COALESCE(scope_id, ''), key
        ORDER BY updated_at DESC, created_at DESC, id DESC
      ) AS rn
    FROM memories
  )
  WHERE rn > 1
);
CREATE UNIQUE INDEX IF NOT EXISTS memories_scope_key_uniq_v2
  ON memories(scope, COALESCE(scope_id, ''), key);
`);
  // Idempotent additive migrations for columns added after initial release.
  // Older dev DBs created before §7.5.2 fault tracking lack `last_failure_at`.
  const cols = sqlite
    .prepare(`PRAGMA table_info(models)`)
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'last_failure_at')) {
    sqlite.exec(`ALTER TABLE models ADD COLUMN last_failure_at INTEGER`);
  }
  // M2.5 — additive columns for catalog sync, multi-modal pricing, and
  // declared output modalities. ALTER guarded against existing dev DBs.
  const additive: Array<[string, string]> = [
    ['price_per_image', 'REAL'],
    ['price_per_video_second', 'REAL'],
    ['pricing_meta', 'TEXT'],
    ['price_synced_at', 'INTEGER'],
    ['modalities', 'TEXT'],
    ['thinking_enabled', 'INTEGER'],
  ];
  for (const [name, type] of additive) {
    if (!cols.some((c) => c.name === name)) {
      sqlite.exec(`ALTER TABLE models ADD COLUMN ${name} ${type}`);
    }
  }
  // A4 — `origin_conversation_id` on roundtables (additive).
  const rtCols = sqlite
    .prepare(`PRAGMA table_info(roundtables)`)
    .all() as Array<{ name: string }>;
  if (!rtCols.some((c) => c.name === 'origin_conversation_id')) {
    sqlite.exec(
      `ALTER TABLE roundtables ADD COLUMN origin_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL`,
    );
  }
  // C4 — pinned + tags on conversations (additive).
  const convCols = sqlite
    .prepare(`PRAGMA table_info(conversations)`)
    .all() as Array<{ name: string }>;
  if (!convCols.some((c) => c.name === 'pinned')) {
    sqlite.exec(
      `ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!convCols.some((c) => c.name === 'tags')) {
    sqlite.exec(`ALTER TABLE conversations ADD COLUMN tags TEXT`);
  }
  // E1 — additive observability columns on cost_records.
  const costCols = sqlite
    .prepare(`PRAGMA table_info(cost_records)`)
    .all() as Array<{ name: string }>;
  if (!costCols.some((c) => c.name === 'classification')) {
    sqlite.exec(`ALTER TABLE cost_records ADD COLUMN classification TEXT`);
  }
  if (!costCols.some((c) => c.name === 'first_token_ms')) {
    sqlite.exec(`ALTER TABLE cost_records ADD COLUMN first_token_ms INTEGER`);
  }
  if (!costCols.some((c) => c.name === 'cache_input_tokens')) {
    sqlite.exec(`ALTER TABLE cost_records ADD COLUMN cache_input_tokens INTEGER`);
  }
  const qcOutputCols = sqlite
    .prepare(`PRAGMA table_info(quick_compare_outputs)`)
    .all() as Array<{ name: string }>;
  if (!qcOutputCols.some((c) => c.name === 'tool_names')) {
    sqlite.exec(`ALTER TABLE quick_compare_outputs ADD COLUMN tool_names TEXT NOT NULL DEFAULT '[]'`);
  }
  // R1 — preferred model and search tool columns on research_sessions (additive).
  const resCols = sqlite
    .prepare(`PRAGMA table_info(research_sessions)`)
    .all() as Array<{ name: string }>;
  if (!resCols.some((c) => c.name === 'preferred_model_id')) {
    sqlite.exec(`ALTER TABLE research_sessions ADD COLUMN preferred_model_id TEXT`);
  }
  if (!resCols.some((c) => c.name === 'preferred_search_tool')) {
    sqlite.exec(`ALTER TABLE research_sessions ADD COLUMN preferred_search_tool TEXT`);
  }
  return drizzle(sqlite, { schema });
}
