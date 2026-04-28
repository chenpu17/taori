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
  price_currency TEXT NOT NULL DEFAULT 'USD',
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

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'chat',
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
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
`;

export type Db = BetterSQLite3Database<typeof schema>;

export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(DDL);
  // Idempotent additive migrations for columns added after initial release.
  // Older dev DBs created before §7.5.2 fault tracking lack `last_failure_at`.
  const cols = sqlite
    .prepare(`PRAGMA table_info(models)`)
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'last_failure_at')) {
    sqlite.exec(`ALTER TABLE models ADD COLUMN last_failure_at INTEGER`);
  }
  return drizzle(sqlite, { schema });
}
