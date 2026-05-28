import { eq, asc, sql } from 'drizzle-orm';
import { type Db } from '../index.js';
import { messages } from '../schema.js';
import { makeId } from '@taori/shared';

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

  get(id: string): MessageRow | null {
    const row = this.db
      .select()
      .from(messages)
      .where(eq(messages.id, id))
      .get();
    return row ? (row as MessageRow) : null;
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

  updateAttachments(id: string, attachments: string | null): void {
    this.db
      .update(messages)
      .set({ attachments })
      .where(eq(messages.id, id))
      .run();
  }

  /** C1 — fetch a single message row by id (or null if missing). */
  getById(id: string): MessageRow | null {
    const row = this.db
      .select()
      .from(messages)
      .where(eq(messages.id, id))
      .get();
    return (row as MessageRow | undefined) ?? null;
  }

  /**
   * C1 — patch a user message's content and discard everything that came
   * after it in the same conversation. Returns the updated row, or null if
   * the id was not found.
   */
  editAndTruncate(id: string, content: string): MessageRow | null {
    const target = this.getById(id);
    if (!target) return null;
    this.db
      .delete(messages)
      .where(
        sql`${messages.conversation_id} = ${target.conversation_id} AND ${messages.created_at} > ${target.created_at}`,
      )
      .run();
    const updated = this.db
      .update(messages)
      .set({ content, status: 'complete', error: null })
      .where(eq(messages.id, id))
      .returning()
      .get();
    return (updated as MessageRow | undefined) ?? null;
  }

  /**
   * C1 — copy every message in the source conversation up to AND INCLUDING
   * the given message into a freshly minted target conversation. Used by
   * the "branch" action so the user can fork a conversation without
   * disturbing the original.
   */
  cloneUpTo(sourceMessageId: string, targetConversationId: string): number {
    const target = this.getById(sourceMessageId);
    if (!target) return 0;
    const rows = this.db
      .select()
      .from(messages)
      .where(
        sql`${messages.conversation_id} = ${target.conversation_id} AND ${messages.created_at} <= ${target.created_at}`,
      )
      .orderBy(asc(messages.created_at))
      .all() as MessageRow[];
    let count = 0;
    let now = Date.now();
    for (const r of rows) {
      this.db
        .insert(messages)
        .values({
          id: makeId('message'),
          conversation_id: targetConversationId,
          role: r.role,
          content: r.content,
          model_id: r.model_id,
          parent_message_id: null,
          attachments: r.attachments,
          status: r.status,
          error: r.error,
          created_at: now++,
        })
        .run();
      count += 1;
    }
    return count;
  }
}
