import { eq, and, asc } from 'drizzle-orm';
import { type Db } from '../index.js';
import { roundtable_messages } from '../schema.js';
import type {
  RoundtableMessageStatus,
  RoundtableMessageClassification,
} from '@taori/shared';
import { makeId } from '@taori/shared';

type RoundtableMessageSelectRow = typeof roundtable_messages.$inferSelect;

export interface RoundtableMessageInsert {
  roundtable_id: string;
  round: number;
  participant_index: number;
  model_id: string | null;
  content?: string;
  status?: RoundtableMessageStatus;
  visible_to_others?: boolean;
}

export interface RoundtableMessageRow {
  id: string;
  roundtable_id: string;
  round: number;
  participant_index: number;
  model_id: string | null;
  content: string;
  status: RoundtableMessageStatus;
  classification: RoundtableMessageClassification | null;
  error_message: string | null;
  visible_to_others: boolean;
  created_at: number;
  updated_at: number;
}

function decodeRoundtableMessage(row: RoundtableMessageSelectRow): RoundtableMessageRow {
  return {
    id: row.id,
    roundtable_id: row.roundtable_id,
    round: row.round,
    participant_index: row.participant_index,
    model_id: row.model_id,
    content: row.content ?? '',
    status: row.status as RoundtableMessageStatus,
    classification: row.classification as RoundtableMessageClassification | null,
    error_message: row.error_message,
    visible_to_others: !!row.visible_to_others,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class RoundtableMessagesRepo {
  constructor(private db: Db) {}

  insert(input: RoundtableMessageInsert): RoundtableMessageRow {
    const id = makeId('roundtable_message');
    const now = Date.now();
    const row = this.db
      .insert(roundtable_messages)
      .values({
        id,
        roundtable_id: input.roundtable_id,
        round: input.round,
        participant_index: input.participant_index,
        model_id: input.model_id,
        content: input.content ?? '',
        status: input.status ?? 'pending',
        classification: null,
        error_message: null,
        visible_to_others: input.visible_to_others ?? true,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return decodeRoundtableMessage(row);
  }

  /** UPDATE the row in place — used during streaming and retry. */
  update(
    id: string,
    patch: Partial<{
      content: string;
      status: RoundtableMessageStatus;
      classification: RoundtableMessageClassification | null;
      error_message: string | null;
      model_id: string | null;
    }>,
  ): void {
    this.db
      .update(roundtable_messages)
      .set({ ...patch, updated_at: Date.now() })
      .where(eq(roundtable_messages.id, id))
      .run();
  }

  listByRoundtable(roundtableId: string): RoundtableMessageRow[] {
    const rows = this.db
      .select()
      .from(roundtable_messages)
      .where(eq(roundtable_messages.roundtable_id, roundtableId))
      .orderBy(
        asc(roundtable_messages.round),
        asc(roundtable_messages.participant_index),
      )
      .all();
    return rows.map(decodeRoundtableMessage);
  }

  findOne(
    roundtableId: string,
    round: number,
    participantIndex: number,
  ): RoundtableMessageRow | null {
    const row = this.db
      .select()
      .from(roundtable_messages)
      .where(
        and(
          eq(roundtable_messages.roundtable_id, roundtableId),
          eq(roundtable_messages.round, round),
          eq(roundtable_messages.participant_index, participantIndex),
        ),
      )
      .get();
    return row ? decodeRoundtableMessage(row) : null;
  }
}
