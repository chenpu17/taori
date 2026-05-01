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

CREATE TABLE IF NOT EXISTS cost_records (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  feature TEXT NOT NULL DEFAULT 'chat',
  model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
  model_name_snapshot TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER,
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
    ['price_synced_at', 'INTEGER'],
    ['modalities', 'TEXT'],
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
  return drizzle(sqlite, { schema });
}
