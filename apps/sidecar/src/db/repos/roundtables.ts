import { eq, asc, inArray, sql } from 'drizzle-orm';
import { type Db } from '../index.js';
import { roundtables } from '../schema.js';
import type {
  Participant,
  RoundtableStoredMode,
  RoundtableStatus,
  SummaryStorage,
} from '@taori/shared';
import { makeId } from '@taori/shared';

type RoundtableSelectRow = typeof roundtables.$inferSelect;

export interface RoundtableInsert {
  id?: string;
  conversation_id: string;
  topic: string;
  mode: RoundtableStoredMode;
  participants: Participant[];
  summarizer_model_id: string | null;
  origin_conversation_id?: string | null;
  analyzer_fallback: boolean;
  status: RoundtableStatus;
  current_round?: number;
  estimated_cost_usd_low: number | null;
  estimated_cost_usd_high: number | null;
}

export interface RoundtableRow {
  id: string;
  conversation_id: string;
  topic: string;
  mode: RoundtableStoredMode;
  participants: Participant[];
  summarizer_model_id: string | null;
  origin_conversation_id: string | null;
  analyzer_fallback: boolean;
  status: RoundtableStatus;
  current_round: number;
  summary: SummaryStorage | null;
  estimated_cost_usd_low: number | null;
  estimated_cost_usd_high: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function decodeRoundtable(row: RoundtableSelectRow): RoundtableRow {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    topic: row.topic,
    mode: row.mode as RoundtableStoredMode,
    participants: JSON.parse(row.participants) as Participant[],
    summarizer_model_id: row.summarizer_model_id,
    origin_conversation_id: row.origin_conversation_id ?? null,
    analyzer_fallback: !!row.analyzer_fallback,
    status: row.status as RoundtableStatus,
    current_round: row.current_round,
    summary: row.summary ? (JSON.parse(row.summary) as SummaryStorage) : null,
    estimated_cost_usd_low: row.estimated_cost_usd_low,
    estimated_cost_usd_high: row.estimated_cost_usd_high,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

export class RoundtablesRepo {
  constructor(private db: Db) {}

  insert(input: RoundtableInsert): RoundtableRow {
    const id = input.id ?? makeId('roundtable');
    const now = Date.now();
    const row = this.db
      .insert(roundtables)
      .values({
        id,
        conversation_id: input.conversation_id,
        topic: input.topic,
        mode: input.mode,
        participants: JSON.stringify(input.participants),
        summarizer_model_id: input.summarizer_model_id,
        origin_conversation_id: input.origin_conversation_id ?? null,
        analyzer_fallback: input.analyzer_fallback,
        status: input.status,
        current_round: input.current_round ?? 0,
        summary: null,
        estimated_cost_usd_low: input.estimated_cost_usd_low,
        estimated_cost_usd_high: input.estimated_cost_usd_high,
        created_at: now,
        updated_at: now,
        completed_at: null,
      })
      .returning()
      .get();
    return decodeRoundtable(row);
  }

  get(id: string): RoundtableRow | null {
    const row = this.db
      .select()
      .from(roundtables)
      .where(eq(roundtables.id, id))
      .get();
    return row ? decodeRoundtable(row) : null;
  }

  listByConversation(conversationId: string): RoundtableRow[] {
    const rows = this.db
      .select()
      .from(roundtables)
      .where(eq(roundtables.conversation_id, conversationId))
      .orderBy(asc(roundtables.created_at))
      .all();
    return rows.map(decodeRoundtable);
  }

  listByAssociatedConversation(conversationId: string): RoundtableRow[] {
    const rows = this.db
      .select()
      .from(roundtables)
      .where(
        sql`${roundtables.conversation_id} = ${conversationId} OR ${roundtables.origin_conversation_id} = ${conversationId}`,
      )
      .orderBy(asc(roundtables.created_at))
      .all();
    return rows.map(decodeRoundtable);
  }

  setOriginConversation(id: string, conversationId: string): void {
    this.db
      .update(roundtables)
      .set({ origin_conversation_id: conversationId, updated_at: Date.now() })
      .where(eq(roundtables.id, id))
      .run();
  }

  setStatus(id: string, status: RoundtableStatus): void {
    this.db
      .update(roundtables)
      .set({
        status,
        updated_at: Date.now(),
        completed_at:
          status === 'completed' ||
          status === 'failed' ||
          status === 'cancelled' ||
          status === 'interrupted'
            ? Date.now()
            : null,
      })
      .where(eq(roundtables.id, id))
      .run();
  }

  setRound(id: string, round: number): void {
    this.db
      .update(roundtables)
      .set({ current_round: round, updated_at: Date.now() })
      .where(eq(roundtables.id, id))
      .run();
  }

  setSummary(id: string, summary: SummaryStorage): void {
    this.db
      .update(roundtables)
      .set({ summary: JSON.stringify(summary), updated_at: Date.now() })
      .where(eq(roundtables.id, id))
      .run();
  }

  /**
   * Update one participant's `model_id` in the JSON `participants` blob.
   * Used by the retry-with-fallback flow (A1) so subsequent rounds use the
   * newly chosen model. Returns the updated row, or null if the row or
   * participant index is not found.
   */
  setParticipantModel(
    id: string,
    index: number,
    modelId: string,
  ): RoundtableRow | null {
    const row = this.get(id);
    if (!row) return null;
    if (index < 0 || index >= row.participants.length) return null;
    const next = row.participants.map((p, i) =>
      i === index ? { ...p, model_id: modelId } : p,
    );
    this.db
      .update(roundtables)
      .set({
        participants: JSON.stringify(next),
        updated_at: Date.now(),
      })
      .where(eq(roundtables.id, id))
      .run();
    return this.get(id);
  }

  /**
   * A3 — replace the entire participants array. Caller is responsible for
   * validating count (2..4) and that no rounds have started yet.
   */
  setParticipants(id: string, participants: Participant[]): RoundtableRow | null {
    const row = this.get(id);
    if (!row) return null;
    this.db
      .update(roundtables)
      .set({
        participants: JSON.stringify(participants),
        updated_at: Date.now(),
      })
      .where(eq(roundtables.id, id))
      .run();
    return this.get(id);
  }

  listByStatuses(statuses: RoundtableStatus[]): RoundtableRow[] {
    if (statuses.length === 0) return [];
    const rows = this.db
      .select()
      .from(roundtables)
      .where(inArray(roundtables.status, statuses))
      .orderBy(asc(roundtables.created_at))
      .all();
    return rows.map(decodeRoundtable);
  }

  setSummarizerModel(id: string, modelId: string | null): RoundtableRow | null {
    const row = this.get(id);
    if (!row) return null;
    this.db
      .update(roundtables)
      .set({
        summarizer_model_id: modelId,
        updated_at: Date.now(),
      })
      .where(eq(roundtables.id, id))
      .run();
    return this.get(id);
  }
}
