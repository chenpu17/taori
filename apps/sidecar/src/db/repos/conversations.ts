import { eq, sql } from 'drizzle-orm';
import { type Db } from '../index.js';
import { conversations } from '../schema.js';
import { makeId } from '@taori/shared';

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
