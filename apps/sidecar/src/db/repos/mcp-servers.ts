import { eq, asc } from 'drizzle-orm';
import { type Db } from '../index.js';
import { mcp_servers } from '../schema.js';
import type { McpServer, McpServerCreate, McpServerUpdate } from '@taori/shared';
import { makeId } from '@taori/shared';
import { parseStringArray } from './mappers.js';
import { pickDefined } from './shared.js';

type McpServerRow = typeof mcp_servers.$inferSelect;

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
        ...pickDefined(patch, ['name', 'command']),
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
        ...pickDefined(input, ['tools_count']),
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
