import { eq, and, sql } from 'drizzle-orm';
import { type Db } from '../index.js';
import { memories } from '../schema.js';
import { makeId } from '@taori/shared';

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
