import { eq, asc, desc } from 'drizzle-orm';
import { type Db } from '../index.js';
import { run_events, agent_runs } from '../schema.js';
import type {
  AgentRun,
  RunEvent,
  RunEventKind,
  RunEventStatus,
} from '@taori/shared';
import { makeId } from '@taori/shared';
import { isForeignKeyConstraintError } from './shared.js';

type RunEventRow = typeof run_events.$inferSelect;
type AgentRunRow = typeof agent_runs.$inferSelect;

function toRunEvent(row: RunEventRow): RunEvent {
  let payload: Record<string, unknown> | null = null;
  if (row.payload) {
    try {
      const parsed = JSON.parse(row.payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = null;
    }
  }
  return {
    id: row.id,
    run_id: row.run_id,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    kind: row.kind as RunEventKind,
    status: row.status as RunEventStatus,
    label: row.label,
    summary: row.summary,
    payload,
    created_at: row.created_at,
  };
}

function payloadString(event: RunEvent, key: string): string | null {
  const value = event.payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function deriveRun(events: RunEvent[]): AgentRun {
  const sorted = [...events].sort((a, b) => a.created_at - b.created_at);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const started = sorted.find((event) => event.kind === 'turn.started') ?? first;
  const modelEvent = [...sorted]
    .reverse()
    .find((event) => event.kind.startsWith('model.') && payloadString(event, 'model_id'));
  const terminal = [...sorted]
    .reverse()
    .find((event) => event.kind.startsWith('turn.') || event.kind.startsWith('recovery.'));

  let status: AgentRun['status'] = 'created';
  if (terminal?.kind === 'turn.completed' || terminal?.kind === 'recovery.completed') {
    status = 'completed';
  } else if (terminal?.kind === 'turn.failed' || terminal?.kind === 'recovery.failed') {
    status = 'failed';
  } else if (terminal?.kind === 'turn.incomplete') {
    status = 'incomplete';
  } else if (terminal?.kind === 'turn.stopped' || terminal?.kind === 'turn.cancelled') {
    status = payloadString(terminal, 'message_status') === 'incomplete'
      ? 'incomplete'
      : 'stopped';
  } else if (terminal?.kind === 'recovery.started') {
    status = 'retrying';
  } else if (sorted.some((event) => event.kind === 'tool.started' && event.status !== 'completed')) {
    status = 'tool_calling';
  } else if (sorted.some((event) => event.kind === 'model.started')) {
    status = 'streaming';
  } else if (sorted.some((event) => event.kind === 'context.snapshot')) {
    status = 'context_ready';
  }

  const kind = payloadString(started, 'run_kind') as AgentRun['kind'] | null;
  return {
    id: first.run_id,
    conversation_id: first.conversation_id,
    parent_run_id: payloadString(started, 'parent_run_id'),
    user_message_id: payloadString(started, 'source_user_message_id'),
    assistant_message_id:
      first.message_id
      ?? payloadString(last, 'assistant_message_id')
      ?? payloadString(started, 'assistant_message_id'),
    kind: kind ?? 'chat',
    status,
    model_id:
      payloadString(modelEvent ?? started, 'model_id')
      ?? payloadString(started, 'model_id'),
    recovery_policy: payloadString(started, 'recovery_policy'),
    created_at: first.created_at,
    updated_at: last.created_at,
    event_count: sorted.length,
  };
}

function toAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    parent_run_id: row.parent_run_id,
    user_message_id: row.user_message_id,
    assistant_message_id: row.assistant_message_id,
    kind: row.kind as AgentRun['kind'],
    status: row.status as AgentRun['status'],
    model_id: row.model_id,
    recovery_policy: row.recovery_policy,
    created_at: row.created_at,
    updated_at: row.updated_at,
    event_count: row.event_count,
  };
}

export interface RunEventInsert {
  run_id: string;
  conversation_id?: string | null;
  message_id?: string | null;
  kind: RunEventKind;
  status: RunEventStatus;
  label: string;
  summary?: string | null;
  payload?: Record<string, unknown> | null;
}

export class RunEventsRepo {
  constructor(private db: Db) {}

  append(input: RunEventInsert): RunEvent {
    return this.db.transaction((tx) => {
      const row = tx
        .insert(run_events)
        .values({
          id: makeId('run_event'),
          run_id: input.run_id,
          conversation_id: input.conversation_id ?? null,
          message_id: input.message_id ?? null,
          kind: input.kind,
          status: input.status,
          label: input.label,
          summary: input.summary ?? null,
          payload: input.payload ? JSON.stringify(input.payload) : null,
          created_at: Date.now(),
        })
        .returning()
        .get();
      const event = toRunEvent(row);
      this.refreshRunHeader(input.run_id, tx);
      return event;
    });
  }

  appendSafe(
    input: RunEventInsert,
    log?: { warn: (...a: unknown[]) => void; error?: (...a: unknown[]) => void },
  ): RunEvent | null {
    const attempts: Array<{ data: RunEventInsert; label: string }> = [
      { data: input, label: 'original' },
      { data: { ...input, message_id: null }, label: 'without_message_id' },
      { data: { ...input, conversation_id: null, message_id: null }, label: 'without_ids' },
    ];
    for (const { data, label } of attempts) {
      try {
        return this.append(data);
      } catch (e) {
        if (isForeignKeyConstraintError(e)) {
          log?.error?.(
            { err: e, runId: input.run_id, kind: input.kind, attempt: label },
            'run_event.fk_fallback',
          );
          continue;
        }
        log?.warn?.({ err: e, runId: input.run_id, kind: input.kind }, 'run_event.write_failed');
        return null;
      }
    }
    log?.error?.(
      { runId: input.run_id, kind: input.kind },
      'run_event.all_fk_fallbacks_exhausted',
    );
    return null;
  }

  private refreshRunHeader(runId: string, db: Db = this.db): AgentRun | null {
    const events = db
      .select()
      .from(run_events)
      .where(eq(run_events.run_id, runId))
      .orderBy(asc(run_events.created_at))
      .all()
      .map(toRunEvent);
    if (events.length === 0) return null;
    const run = deriveRun(events);
    db.insert(agent_runs)
      .values({
        id: run.id,
        conversation_id: run.conversation_id,
        parent_run_id: run.parent_run_id,
        kind: run.kind,
        status: run.status,
        model_id: run.model_id,
        user_message_id: run.user_message_id,
        assistant_message_id: run.assistant_message_id,
        recovery_policy: run.recovery_policy,
        event_count: run.event_count,
        created_at: run.created_at,
        updated_at: run.updated_at,
      })
      .onConflictDoUpdate({
        target: agent_runs.id,
        set: {
          conversation_id: run.conversation_id,
          parent_run_id: run.parent_run_id,
          kind: run.kind,
          status: run.status,
          model_id: run.model_id,
          user_message_id: run.user_message_id,
          assistant_message_id: run.assistant_message_id,
          recovery_policy: run.recovery_policy,
          event_count: run.event_count,
          created_at: run.created_at,
          updated_at: run.updated_at,
        },
      })
      .run();
    return run;
  }

  listByConversation(conversationId: string, limit = 100): RunEvent[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    return this.db
      .select()
      .from(run_events)
      .where(eq(run_events.conversation_id, conversationId))
      .orderBy(desc(run_events.created_at))
      .limit(safeLimit)
      .all()
      .reverse()
      .map(toRunEvent);
  }

  listRunsByConversation(conversationId: string, limit = 20): AgentRun[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const materialized = this.db
      .select()
      .from(agent_runs)
      .where(eq(agent_runs.conversation_id, conversationId))
      .orderBy(desc(agent_runs.updated_at))
      .limit(safeLimit)
      .all()
      .map(toAgentRun);
    if (materialized.length > 0) {
      return materialized;
    }
    const rows = this.db
      .select()
      .from(run_events)
      .where(eq(run_events.conversation_id, conversationId))
      .orderBy(desc(run_events.created_at))
      .limit(1000)
      .all()
      .reverse()
      .map(toRunEvent);
    const grouped = new Map<string, RunEvent[]>();
    for (const event of rows) {
      const list = grouped.get(event.run_id) ?? [];
      list.push(event);
      grouped.set(event.run_id, list);
    }
    return [...grouped.values()]
      .map(deriveRun)
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, safeLimit);
  }

  listByRun(runId: string): RunEvent[] {
    return this.db
      .select()
      .from(run_events)
      .where(eq(run_events.run_id, runId))
      .orderBy(asc(run_events.created_at))
      .all()
      .map(toRunEvent);
  }
}
