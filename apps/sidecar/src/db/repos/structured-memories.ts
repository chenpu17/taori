import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { type Db } from '../index.js';
import { structured_memories } from '../schema.js';
import { makeId } from '@taori/shared';

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
