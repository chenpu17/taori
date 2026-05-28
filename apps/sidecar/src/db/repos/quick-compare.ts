import { eq, desc, asc } from 'drizzle-orm';
import { type Db } from '../index.js';
import { quick_compare_runs, quick_compare_outputs } from '../schema.js';
import type {
  QuickCompareRun,
  QuickCompareOutput,
  QuickCompareStatus,
  QuickCompareOutputStatus,
} from '@taori/shared';
import { makeId } from '@taori/shared';
import { parseStringArray } from './mappers.js';
import { pickDefined } from './shared.js';

type QuickCompareRunRow = typeof quick_compare_runs.$inferSelect;
type QuickCompareOutputRow = typeof quick_compare_outputs.$inferSelect;

function toQuickCompareRun(row: QuickCompareRunRow): QuickCompareRun {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    source_user_message_id: row.source_user_message_id,
    run_id: row.run_id,
    status: row.status as QuickCompareStatus,
    model_ids: parseStringArray(row.model_ids),
    adopted_output_id: row.adopted_output_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toQuickCompareOutput(row: QuickCompareOutputRow): QuickCompareOutput {
  return {
    id: row.id,
    compare_id: row.compare_id,
    participant_index: row.participant_index,
    model_id: row.model_id,
    provider_id: row.provider_id,
    tool_names: parseStringArray(row.tool_names),
    content: row.content,
    status: row.status as QuickCompareOutputStatus,
    error_classification: row.error_classification as QuickCompareOutput['error_classification'],
    error_message: row.error_message,
    cost_record_id: row.cost_record_id,
    first_token_ms: row.first_token_ms,
    duration_ms: row.duration_ms,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface QuickCompareRunCreate {
  conversation_id: string;
  source_user_message_id?: string | null;
  run_id: string;
  model_ids: string[];
  status?: QuickCompareStatus;
}

export interface QuickCompareOutputCreate {
  compare_id: string;
  participant_index: number;
  model_id: string;
  provider_id?: string | null;
  tool_names?: string[];
  status?: QuickCompareOutputStatus;
}

export interface QuickCompareOutputPatch {
  tool_names?: string[];
  content?: string;
  status?: QuickCompareOutputStatus;
  error_classification?: QuickCompareOutput['error_classification'];
  error_message?: string | null;
  cost_record_id?: string | null;
  first_token_ms?: number | null;
  duration_ms?: number | null;
}

export class QuickCompareRepo {
  constructor(private db: Db) {}

  createRun(input: QuickCompareRunCreate): QuickCompareRun {
    const now = Date.now();
    const row = this.db
      .insert(quick_compare_runs)
      .values({
        id: makeId('quick_compare'),
        conversation_id: input.conversation_id,
        source_user_message_id: input.source_user_message_id ?? null,
        run_id: input.run_id,
        status: input.status ?? 'running',
        model_ids: JSON.stringify(input.model_ids),
        adopted_output_id: null,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toQuickCompareRun(row);
  }

  getRun(id: string): QuickCompareRun | null {
    const row = this.db
      .select()
      .from(quick_compare_runs)
      .where(eq(quick_compare_runs.id, id))
      .get();
    return row ? toQuickCompareRun(row) : null;
  }

  listRunsByConversation(conversationId: string, limit = 20): QuickCompareRun[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.db
      .select()
      .from(quick_compare_runs)
      .where(eq(quick_compare_runs.conversation_id, conversationId))
      .orderBy(desc(quick_compare_runs.updated_at))
      .limit(safeLimit)
      .all()
      .map(toQuickCompareRun);
  }

  updateRunStatus(id: string, status: QuickCompareStatus): QuickCompareRun | null {
    const row = this.db
      .update(quick_compare_runs)
      .set({ status, updated_at: Date.now() })
      .where(eq(quick_compare_runs.id, id))
      .returning()
      .get();
    return row ? toQuickCompareRun(row) : null;
  }

  markAdopted(compareId: string, outputId: string): QuickCompareRun | null {
    const row = this.db
      .update(quick_compare_runs)
      .set({ adopted_output_id: outputId, updated_at: Date.now() })
      .where(eq(quick_compare_runs.id, compareId))
      .returning()
      .get();
    return row ? toQuickCompareRun(row) : null;
  }

  createOutput(input: QuickCompareOutputCreate): QuickCompareOutput {
    const now = Date.now();
    const row = this.db
      .insert(quick_compare_outputs)
      .values({
        id: makeId('quick_compare_output'),
        compare_id: input.compare_id,
        participant_index: input.participant_index,
        model_id: input.model_id,
        provider_id: input.provider_id ?? null,
        tool_names: JSON.stringify(input.tool_names ?? []),
        content: '',
        status: input.status ?? 'pending',
        error_classification: null,
        error_message: null,
        cost_record_id: null,
        first_token_ms: null,
        duration_ms: null,
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toQuickCompareOutput(row);
  }

  getOutput(id: string): QuickCompareOutput | null {
    const row = this.db
      .select()
      .from(quick_compare_outputs)
      .where(eq(quick_compare_outputs.id, id))
      .get();
    return row ? toQuickCompareOutput(row) : null;
  }

  listOutputs(compareId: string): QuickCompareOutput[] {
    return this.db
      .select()
      .from(quick_compare_outputs)
      .where(eq(quick_compare_outputs.compare_id, compareId))
      .orderBy(asc(quick_compare_outputs.participant_index))
      .all()
      .map(toQuickCompareOutput);
  }

  patchOutput(id: string, patch: QuickCompareOutputPatch): QuickCompareOutput | null {
    const row = this.db
      .update(quick_compare_outputs)
      .set({
        ...(patch.tool_names !== undefined && { tool_names: JSON.stringify(patch.tool_names) }),
        ...pickDefined(patch, ['content', 'status', 'error_classification', 'error_message', 'cost_record_id', 'first_token_ms', 'duration_ms']),
        updated_at: Date.now(),
      })
      .where(eq(quick_compare_outputs.id, id))
      .returning()
      .get();
    return row ? toQuickCompareOutput(row) : null;
  }
}
